import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';
import { registerFileEditorHandlers, type FileEditorHost } from '../../src/main/ipc/fileEditorHandlers';

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

describe('FileEditor IPC handlers', () => {
  const handlers = new Map<string, Handler>();

  const storageRegistry = {
    has: vi.fn(),
    getOrCreate: vi.fn(),
  };

  const fileEditorService = {
    readFile: vi.fn(),
    readBytes: vi.fn(),
    saveFile: vi.fn(),
    openInExternalEditor: vi.fn(),
    closeExternalEditor: vi.fn(),
  };

  const fileTailService = {
    startTail: vi.fn(),
    stopTail: vi.fn(),
  };

  const host: FileEditorHost = {
    fileEditorService: fileEditorService as any,
    fileTailService: fileTailService as any,
    storageRegistry: storageRegistry as any,
    sendToSender: () => false,
    registerHandler: (channel: string, handler: Handler) => {
      handlers.set(channel, handler);
    },
  };

  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    registerFileEditorHandlers(host);
  });

  it('registers all expected IPC handlers', () => {
    expect(handlers.has(IPC_CHANNELS.FILE_READ)).toBe(true);
    expect(handlers.has(IPC_CHANNELS.CERTIFICATE_PREVIEW)).toBe(true);
    expect(handlers.has(IPC_CHANNELS.FILE_SAVE)).toBe(true);
    expect(handlers.has(IPC_CHANNELS.FILE_OPEN_EXTERNAL)).toBe(true);
    expect(handlers.has(IPC_CHANNELS.FILE_CLOSE_EXTERNAL)).toBe(true);
    expect(handlers.has(IPC_CHANNELS.FILE_TAIL_START)).toBe(true);
    expect(handlers.has(IPC_CHANNELS.FILE_TAIL_STOP)).toBe(true);
  });

  it('auto-connects local provider when providerId is "local" and not registered', async () => {
    storageRegistry.has.mockReturnValue(false);
    fileEditorService.readFile.mockResolvedValue({ content: 'hello', size: 5, isBinary: false });

    const readHandler = handlers.get(IPC_CHANNELS.FILE_READ)!;
    const res = await readHandler({}, 'local', '/etc/hosts');

    expect(storageRegistry.getOrCreate).toHaveBeenCalledWith({
      id: 'local',
      name: 'Local Disk',
      type: 'local',
    });
    expect(fileEditorService.readFile).toHaveBeenCalledWith(
      storageRegistry,
      'local',
      '/etc/hosts',
      undefined
    );
    expect(res).toEqual({ content: 'hello', size: 5, isBinary: false });
  });

  it('does not auto-connect remote providers directly (relies on proper connectStorage)', async () => {
    storageRegistry.has.mockReturnValue(false);
    fileEditorService.readFile.mockResolvedValue({ content: 'server-data', size: 11, isBinary: false });

    const readHandler = handlers.get(IPC_CHANNELS.FILE_READ)!;
    await readHandler({}, 'sftp-srv1', '/var/log/syslog', 1024);

    expect(storageRegistry.getOrCreate).not.toHaveBeenCalled();
    expect(fileEditorService.readFile).toHaveBeenCalledWith(
      storageRegistry,
      'sftp-srv1',
      '/var/log/syslog',
      1024
    );
  });

  it('does not re-register local provider if already present in storageRegistry', async () => {
    storageRegistry.has.mockReturnValue(true);

    const readHandler = handlers.get(IPC_CHANNELS.FILE_READ)!;
    await readHandler({}, 'local', '/etc/hosts');

    expect(storageRegistry.getOrCreate).not.toHaveBeenCalled();
  });

  it('delegates saveFile, openInExternalEditor and closeExternalEditor', async () => {
    storageRegistry.has.mockReturnValue(true);
    const saveHandler = handlers.get(IPC_CHANNELS.FILE_SAVE)!;
    await saveHandler({}, 'local', '/tmp/test.txt', 'new-content');
    expect(fileEditorService.saveFile).toHaveBeenCalledWith(storageRegistry, 'local', '/tmp/test.txt', 'new-content');

    const openHandler = handlers.get(IPC_CHANNELS.FILE_OPEN_EXTERNAL)!;
    fileEditorService.openInExternalEditor.mockResolvedValue({ sessionToken: 'tok-123' });
    const openRes = await openHandler({}, 'local', '/tmp/test.txt');
    expect(openRes).toEqual({ sessionToken: 'tok-123' });

    const closeHandler = handlers.get(IPC_CHANNELS.FILE_CLOSE_EXTERNAL)!;
    await closeHandler({}, 'tok-123');
    expect(fileEditorService.closeExternalEditor).toHaveBeenCalledWith('tok-123');
  });

  it('delegates startTail and stopTail', async () => {
    storageRegistry.has.mockReturnValue(true);
    fileTailService.startTail.mockResolvedValue({ tailId: 'tail-99' });

    const tailStartHandler = handlers.get(IPC_CHANNELS.FILE_TAIL_START)!;
    const tailRes = await tailStartHandler({}, 'local', '/var/log/app.log');
    expect(tailRes).toEqual({ tailId: 'tail-99' });

    const tailStopHandler = handlers.get(IPC_CHANNELS.FILE_TAIL_STOP)!;
    await tailStopHandler({}, 'tail-99');
    expect(fileTailService.stopTail).toHaveBeenCalledWith('tail-99');
  });
  describe('certificate preview', () => {
    const certPem = readFileSync(path.join(__dirname, 'fixtures', 'certs', 'leaf.pem'));

    it('returns parsed facts only, never file text', async () => {
      storageRegistry.has.mockReturnValue(true);
      // Built from parts so secret scanners do not mistake the synthetic test block for a real key.
      const keyBlock = `-----BEGIN ${'PRIVATE'} KEY-----\nU0VDUkVU\n-----END ${'PRIVATE'} KEY-----\n`;
      fileEditorService.readBytes.mockResolvedValue({
        buffer: Buffer.concat([Buffer.from(keyBlock), certPem]),
        truncated: false,
      });

      const res = (await handlers.get(IPC_CHANNELS.CERTIFICATE_PREVIEW)!({}, 'p1', '/etc/ssl/site.pem')) as any;

      expect(fileEditorService.readBytes).toHaveBeenCalledWith(storageRegistry, 'p1', '/etc/ssl/site.pem', 64 * 1024);
      expect(res.certs).toHaveLength(1);
      expect(JSON.stringify(res)).not.toMatch(/PRIVATE|U0VDUkVU/);
    });

    it('checks the given host name', async () => {
      storageRegistry.has.mockReturnValue(true);
      fileEditorService.readBytes.mockResolvedValue({ buffer: certPem, truncated: false });
      const handler = handlers.get(IPC_CHANNELS.CERTIFICATE_PREVIEW)!;
      expect(((await handler({}, 'p1', '/a.crt', 'www.example.test')) as any).certs[0].hostMatch).toBe(true);
      expect(((await handler({}, 'p1', '/a.crt', 'other.test')) as any).certs[0].hostMatch).toBe(false);
      expect(((await handler({}, 'p1', '/a.crt', 'bad host')) as any).certs[0].hostMatch).toBeUndefined();
    });

    it('rejects invalid arguments', async () => {
      const handler = handlers.get(IPC_CHANNELS.CERTIFICATE_PREVIEW)!;
      await expect(handler({}, '', '/a.pem')).rejects.toThrow('Invalid argument: providerId');
      await expect(handler({}, 'p1', 42)).rejects.toThrow('Invalid argument: remotePath');
    });

    it('does not read files that are not named like certificates', async () => {
      const res = await handlers.get(IPC_CHANNELS.CERTIFICATE_PREVIEW)!({}, 'p1', '/etc/passwd');
      expect(res).toEqual({ certs: [], moreCerts: 0, error: 'none' });
      expect(fileEditorService.readBytes).not.toHaveBeenCalled();
    });

    it('reports a truncated read as too large, a directory as none, and a failed read without its message', async () => {
      storageRegistry.has.mockReturnValue(true);
      const handler = handlers.get(IPC_CHANNELS.CERTIFICATE_PREVIEW)!;

      fileEditorService.readBytes.mockResolvedValueOnce({ buffer: certPem, truncated: true });
      expect(await handler({}, 'p1', '/big.crt')).toEqual({ certs: [], moreCerts: 0, error: 'too-large' });

      fileEditorService.readBytes.mockResolvedValueOnce({ isDirectory: true });
      expect(await handler({}, 'p1', '/dir.crt')).toEqual({ certs: [], moreCerts: 0, error: 'none' });

      fileEditorService.readBytes.mockRejectedValueOnce(new Error('EACCES /secret/host'));
      expect(await handler({}, 'p1', '/x.crt')).toEqual({ certs: [], moreCerts: 0, error: 'unreadable' });
    });

    it('auto-connects the local provider', async () => {
      storageRegistry.has.mockReturnValue(false);
      fileEditorService.readBytes.mockResolvedValue({ buffer: certPem, truncated: false });
      await handlers.get(IPC_CHANNELS.CERTIFICATE_PREVIEW)!({}, 'local', '/tmp/a.crt');
      expect(storageRegistry.getOrCreate).toHaveBeenCalledWith({ id: 'local', name: 'Local Disk', type: 'local' });
    });
  });
});
