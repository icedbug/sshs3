import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable, Writable, PassThrough } from 'node:stream';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { FileEditorService, toSafeLocalFileName, isBlockedExecutableType } from '../../src/main/editor/FileEditorService';
import { StorageRegistry } from '../../src/main/storage/StorageRegistry';
import { LocalStorageProvider } from '../../src/main/storage/LocalStorageProvider';

describe('FileEditorService', () => {
  let tempBaseDir: string;
  let mockShell: any;
  let service: FileEditorService;
  let storageRegistry: StorageRegistry;

  beforeEach(async () => {
    tempBaseDir = path.join(os.tmpdir(), `fe-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fsp.mkdir(tempBaseDir, { recursive: true });

    mockShell = {
      openPath: vi.fn().mockResolvedValue(''),
    };

    service = new FileEditorService({
      shell: mockShell,
      baseTempDir: tempBaseDir,
    });

    storageRegistry = new StorageRegistry();
  });

  afterEach(async () => {
    await service.dispose();
    try {
      await fsp.rm(tempBaseDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe('readFile', () => {
    it('throws if provider is not found', async () => {
      await expect(
        service.readFile(storageRegistry, 'non-existent', '/some/file.txt')
      ).rejects.toThrow('Storage provider not found: non-existent');
    });

    it('reads a text file successfully', async () => {
      const mockProvider = {
        id: 'mock-p1',
        name: 'Mock',
        type: 'local' as const,
        createReadStream: vi.fn().mockImplementation(() => {
          return Readable.from([Buffer.from('Hello world\nSecond line', 'utf-8')]);
        }),
      };
      storageRegistry.register(mockProvider as any);

      const res = await service.readFile(storageRegistry, 'mock-p1', '/test.txt');
      expect(res.content).toBe('Hello world\nSecond line');
      expect(res.size).toBe(Buffer.byteLength('Hello world\nSecond line'));
      expect(res.isBinary).toBe(false);
      expect(res.truncated).toBe(false);
    });

    it('flags non-UTF-8 text so the editor can refuse to save it back', async () => {
      const latin1 = Buffer.from('f\xf6rsta raden', 'latin1');
      storageRegistry.register({
        id: 'mock-latin1',
        name: 'Mock',
        type: 'sftp' as const,
        createReadStream: vi.fn().mockImplementation(() => Readable.from([latin1])),
      } as any);

      const res = await service.readFile(storageRegistry, 'mock-latin1', '/latin1.txt');
      expect(res.isBinary).toBe(false);
      expect(res.notUtf8).toBe(true);
    });

    it('does not flag valid UTF-8 (including multi-byte characters) as non-UTF-8', async () => {
      storageRegistry.register({
        id: 'mock-utf8',
        name: 'Mock',
        type: 'sftp' as const,
        createReadStream: vi.fn().mockImplementation(() => Readable.from([Buffer.from('första åäö', 'utf-8')])),
      } as any);

      const res = await service.readFile(storageRegistry, 'mock-utf8', '/utf8.txt');
      expect(res.notUtf8).toBe(false);
    });

    it('detects binary file with null bytes and returns isBinary: true', async () => {
      const binaryData = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x01, 0x00]);
      const mockProvider = {
        id: 'mock-bin',
        name: 'Mock Bin',
        type: 'sftp' as const,
        createReadStream: vi.fn().mockImplementation(() => {
          return Readable.from([binaryData]);
        }),
      };
      storageRegistry.register(mockProvider as any);

      const res = await service.readFile(storageRegistry, 'mock-bin', '/app.bin');
      expect(res.isBinary).toBe(true);
      expect(res.content).toBe('');
      expect(res.size).toBe(binaryData.length);
      expect(res.truncated).toBe(false);
    });

    it('truncates content when exceeding maxBytes', async () => {
      const largeData = Buffer.from('a'.repeat(200), 'utf-8');
      const mockProvider = {
        id: 'mock-large',
        name: 'Mock Large',
        type: 's3' as const,
        createReadStream: vi.fn().mockImplementation(() => {
          return Readable.from([largeData]);
        }),
      };
      storageRegistry.register(mockProvider as any);

      const res = await service.readFile(storageRegistry, 'mock-large', '/large.log', 50);
      expect(res.truncated).toBe(true);
      expect(res.size).toBe(50);
      expect(res.content).toBe('a'.repeat(50));
    });

    it('safely clamps invalid or excessive maxBytes', async () => {
      const data = Buffer.from('b'.repeat(100), 'utf-8');
      const mockProvider = {
        id: 'mock-clamp',
        name: 'Mock Clamp',
        type: 's3' as const,
        createReadStream: vi.fn().mockImplementation(() => Readable.from([data])),
      };
      storageRegistry.register(mockProvider as any);

      // NaN defaults safely to 5MB (not truncated for 100 bytes)
      const resNan = await service.readFile(storageRegistry, 'mock-clamp', '/test.txt', NaN as any);
      expect(resNan.content).toBe('b'.repeat(100));
      expect(resNan.truncated).toBe(false);

      // Negative number defaults safely to 5MB
      const resNeg = await service.readFile(storageRegistry, 'mock-clamp', '/test.txt', -10);
      expect(resNeg.content).toBe('b'.repeat(100));
      expect(resNeg.truncated).toBe(false);
    });

    it('returns base64 and mimeType for binary media like PNG images', async () => {
      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]);
      const mockProvider = {
        id: 'mock-png',
        name: 'Mock PNG',
        type: 'local' as const,
        createReadStream: vi.fn().mockImplementation(() => Readable.from([pngHeader])),
      };
      storageRegistry.register(mockProvider as any);

      const res = await service.readFile(storageRegistry, 'mock-png', '/assets/logo.png');
      expect(res.isBinary).toBe(true);
      expect(res.mimeType).toBe('image/png');
      expect(res.base64).toBe(pngHeader.toString('base64'));
    });

    it('returns isDirectory: true when provider.stat reports directory', async () => {
      const mockProvider = {
        id: 'mock-dir-stat',
        name: 'Mock Dir Stat',
        type: 'sftp' as const,
        stat: vi.fn().mockResolvedValue({
          name: 'my_folder',
          path: '/var/my_folder',
          size: 4096,
          isDirectory: true,
        }),
        createReadStream: vi.fn(),
      };
      storageRegistry.register(mockProvider as any);

      const res = await service.readFile(storageRegistry, 'mock-dir-stat', '/var/my_folder');
      expect(res.isDirectory).toBe(true);
      expect(res.content).toBe('');
      expect(res.size).toBe(4096);
      expect(mockProvider.createReadStream).not.toHaveBeenCalled();
    });

    it('refuses non-regular files such as FIFOs without opening a stream', async () => {
      const mockProvider = {
        id: 'mock-fifo',
        name: 'Mock FIFO',
        type: 'local' as const,
        stat: vi.fn().mockResolvedValue({ name: 'pipe', path: '/tmp/pipe', size: 0, isDirectory: false, isSpecial: true }),
        createReadStream: vi.fn(),
      };
      storageRegistry.register(mockProvider as any);

      await expect(service.readFile(storageRegistry, 'mock-fifo', '/tmp/pipe')).rejects.toThrow('Not a regular file');
      expect(mockProvider.createReadStream).not.toHaveBeenCalled();
    });

    it('gives up on a stream that never produces data', async () => {
      vi.useFakeTimers();
      try {
        const stalled = new PassThrough();
        const mockProvider = {
          id: 'mock-stalled',
          name: 'Mock Stalled',
          type: 'sftp' as const,
          stat: vi.fn().mockRejectedValue(new Error('no stat')),
          createReadStream: vi.fn().mockResolvedValue(stalled),
        };
        storageRegistry.register(mockProvider as any);

        const pending = service.readFile(storageRegistry, 'mock-stalled', '/hang');
        const assertion = expect(pending).rejects.toThrow('Timed out');
        await vi.advanceTimersByTimeAsync(31_000);
        await assertion;
        expect(stalled.destroyed).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('returns isDirectory: true when createReadStream throws EISDIR or SftpError failure', async () => {
      const sftpFailure = new Error('Failure');
      (sftpFailure as any).statusCode = 4;
      (sftpFailure as any).name = 'SftpError';

      const mockProvider = {
        id: 'mock-dir-create-err',
        name: 'Mock Dir Create Err',
        type: 'sftp' as const,
        stat: vi.fn().mockRejectedValue(new Error('stat not supported')),
        createReadStream: vi.fn().mockRejectedValue(sftpFailure),
      };
      storageRegistry.register(mockProvider as any);

      const res = await service.readFile(storageRegistry, 'mock-dir-create-err', '/var/my_folder');
      expect(res.isDirectory).toBe(true);
      expect(res.content).toBe('');
      expect(res.size).toBe(0);
    });

    it('returns isDirectory: true when stream emits EISDIR or SftpError failure', async () => {
      const sftpFailure = new Error('Failure');
      (sftpFailure as any).statusCode = 4;
      (sftpFailure as any).name = 'SftpError';

      const stream = new PassThrough();
      const mockProvider = {
        id: 'mock-dir-stream-err',
        name: 'Mock Dir Stream Err',
        type: 'sftp' as const,
        createReadStream: vi.fn().mockResolvedValue(stream),
      };
      storageRegistry.register(mockProvider as any);

      process.nextTick(() => {
        stream.emit('error', sftpFailure);
      });

      const res = await service.readFile(storageRegistry, 'mock-dir-stream-err', '/var/my_folder');
      expect(res.isDirectory).toBe(true);
      expect(res.content).toBe('');
    });
  });

  describe('saveFile', () => {
    it('throws if provider is not found', async () => {
      await expect(
        service.saveFile(storageRegistry, 'non-existent', '/test.txt', 'new data')
      ).rejects.toThrow('Storage provider not found: non-existent');
    });

    it('writes utf-8 buffer to provider write stream', async () => {
      const chunks: Buffer[] = [];
      const mockWriteStream = new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(chunk);
          callback();
        },
      });

      const mockProvider = {
        id: 'mock-write',
        name: 'Mock Write',
        type: 'sftp' as const,
        createWriteStream: vi.fn().mockResolvedValue(mockWriteStream),
      };
      storageRegistry.register(mockProvider as any);

      await service.saveFile(storageRegistry, 'mock-write', '/path/to/save.txt', 'Updated content!');

      const written = Buffer.concat(chunks).toString('utf-8');
      expect(written).toBe('Updated content!');
      expect(mockProvider.createWriteStream).toHaveBeenCalledWith('/path/to/save.txt');
    });
  });

  describe('openInExternalEditor', () => {
    it('opens local file directly with shell.openPath', async () => {
      const localProvider = new LocalStorageProvider({
        id: 'local-test',
        basePath: tempBaseDir,
      });
      storageRegistry.register(localProvider);

      const testFile = path.join(tempBaseDir, 'local.txt');
      await fsp.writeFile(testFile, 'local content');

      const result = await service.openInExternalEditor(storageRegistry, 'local-test', 'local.txt');

      expect(mockShell.openPath).toHaveBeenCalledWith(testFile);
      expect(result.localPath).toBe(testFile);
      expect(typeof result.sessionToken).toBe('string');
    });

    it('throws if shell.openPath returns an error string', async () => {
      mockShell.openPath.mockResolvedValue('No default application');
      const localProvider = new LocalStorageProvider({
        id: 'local-err',
        basePath: tempBaseDir,
      });
      storageRegistry.register(localProvider);

      await expect(
        service.openInExternalEditor(storageRegistry, 'local-err', 'local.txt')
      ).rejects.toThrow('No default application');
    });

    it('downloads remote file to temp folder, opens it, and tracks session', async () => {
      const fileData = 'Remote config content\nport=8080\n';
      const mockProvider = {
        id: 'sftp-test',
        name: 'SFTP Test',
        type: 'sftp' as const,
        createReadStream: vi.fn().mockImplementation(() => {
          return Readable.from([Buffer.from(fileData, 'utf-8')]);
        }),
        createWriteStream: vi.fn().mockImplementation(() => {
          return new PassThrough();
        }),
      };
      storageRegistry.register(mockProvider as any);

      const result = await service.openInExternalEditor(storageRegistry, 'sftp-test', '/etc/config.ini');

      expect(result.sessionToken).toBeDefined();
      expect(result.localPath).toContain('config.ini');
      expect(mockShell.openPath).toHaveBeenCalledWith(result.localPath);

      // Verify temp file was downloaded
      const downloaded = await fsp.readFile(result.localPath, 'utf-8');
      expect(downloaded).toBe(fileData);

      const session = service.getSession(result.sessionToken);
      expect(session).toBeDefined();
      expect(session?.remotePath).toBe('/etc/config.ini');

      // Close session
      await service.closeExternalEditor(result.sessionToken);
      expect(service.getSession(result.sessionToken)).toBeUndefined();
    });
  });

  describe('external editor status events (M11)', () => {
    it('says which storage an auto-upload belongs to, not only the path', async () => {
      const mockProvider = {
        id: 'sftp-evt',
        name: 'SFTP Evt',
        type: 'sftp' as const,
        createReadStream: vi.fn().mockImplementation(() => Readable.from([Buffer.from('v1', 'utf-8')])),
        createWriteStream: vi.fn().mockImplementation(() => new PassThrough()),
      };
      storageRegistry.register(mockProvider as any);
      const events: Array<Record<string, unknown>> = [];

      const { localPath, sessionToken } = await service.openInExternalEditor(storageRegistry, 'sftp-evt', '/etc/app/config.ini', (e) => events.push(e as any));
      await new Promise((resolve) => setTimeout(resolve, 50));
      await fsp.writeFile(localPath, 'v2 saved in the external editor');

      await vi.waitFor(() => expect(events.length).toBeGreaterThan(0), { timeout: 4000 });
      expect(events[0]).toMatchObject({ providerId: 'sftp-evt', remotePath: '/etc/app/config.ini', status: 'uploaded', sessionToken });
      await service.closeExternalEditor(sessionToken);
    });
  });

  // M9 (code review 2026-11-03): uploads could overlap (two writers truncating the same remote file), an editor
  // that saves by renaming a temp file over the original killed the file watch, and a change still waiting out
  // the debounce was lost when the session was closed.
  describe('external editor auto-upload (M9)', () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    function remoteProvider(uploadMs = 0) {
      const state = { open: 0, maxOpen: 0, uploads: [] as string[] };
      const provider = {
        id: 'sftp-up',
        name: 'SFTP Up',
        type: 'sftp' as const,
        createReadStream: vi.fn().mockImplementation(() => Readable.from([Buffer.from('v0', 'utf-8')])),
        createWriteStream: vi.fn().mockImplementation(async () => {
          state.open++;
          state.maxOpen = Math.max(state.maxOpen, state.open);
          const chunks: Buffer[] = [];
          return new Writable({
            write(chunk, _enc, cb) {
              chunks.push(chunk as Buffer);
              cb();
            },
            final(cb) {
              setTimeout(() => {
                state.uploads.push(Buffer.concat(chunks).toString('utf-8'));
                state.open--;
                cb();
              }, uploadMs);
            },
          });
        }),
      };
      storageRegistry.register(provider as any);
      return { provider, state };
    }

    function fastService() {
      const s = new FileEditorService({ shell: mockShell, baseTempDir: tempBaseDir, uploadDebounceMs: 30 });
      return s;
    }

    it('never has two uploads of the same file open at once, and ends with the latest content', async () => {
      const fast = fastService();
      const { state } = remoteProvider(200);
      const events: Array<{ status: string }> = [];
      const { localPath, sessionToken } = await fast.openInExternalEditor(storageRegistry, 'sftp-up', '/etc/a.ini', (e) => events.push(e));
      await sleep(40);

      await fsp.writeFile(localPath, 'first save');
      await sleep(120); // the first upload is running (takes 200 ms)
      await fsp.writeFile(localPath, 'second save, longer');
      await sleep(120);
      await fsp.writeFile(localPath, 'third save, even longer than that');

      await vi.waitFor(() => expect(state.uploads.at(-1)).toBe('third save, even longer than that'), { timeout: 4000 });
      expect(state.maxOpen).toBe(1);
      expect(events.every((e) => e.status === 'uploaded')).toBe(true);
      await fast.closeExternalEditor(sessionToken);
      await fast.dispose();
    });

    it.skipIf(process.platform === 'win32')('keeps uploading after an editor saved by renaming a temp file over the original', async () => {
      const fast = fastService();
      const { state } = remoteProvider();
      const { localPath, sessionToken } = await fast.openInExternalEditor(storageRegistry, 'sftp-up', '/etc/b.ini', () => {});
      await sleep(40);

      // vim, JetBrains IDEs and others: write a new file, then rename it over the old one.
      await fsp.writeFile(`${localPath}.swp-new`, 'saved via rename');
      await fsp.rename(`${localPath}.swp-new`, localPath);
      await vi.waitFor(() => expect(state.uploads).toContain('saved via rename'), { timeout: 4000 });

      await sleep(200); // the watch has to be re-established on the new file
      await fsp.writeFile(localPath, 'plain save after the rename, longer');
      await vi.waitFor(() => expect(state.uploads).toContain('plain save after the rename, longer'), { timeout: 4000 });
      await fast.closeExternalEditor(sessionToken);
      await fast.dispose();
    });

    // Code review of the unpushed commits: a close while the re-attach is waiting must not leave a new watcher behind.
    it.skipIf(process.platform === 'win32')('does not attach a new file watch when the session is closed during a re-attach', async () => {
      const fast = fastService();
      remoteProvider();
      const { localPath, sessionToken } = await fast.openInExternalEditor(storageRegistry, 'sftp-up', '/etc/e.ini', () => {});
      await sleep(40);
      const realAccess = fsp.access.bind(fsp);
      const accessSpy = vi.spyOn(fsp, 'access').mockImplementation(async (...args: Parameters<typeof fsp.access>) => {
        await sleep(150);
        return realAccess(...args).catch(() => undefined); // resolves even though the temp dir is gone by now
      });
      const watchSpy = vi.spyOn(fs, 'watch');
      try {
        await fsp.writeFile(`${localPath}.new`, 'saved via rename');
        await fsp.rename(`${localPath}.new`, localPath); // 'rename' event: the re-attach starts and waits in access()
        await sleep(40);
        await fast.closeExternalEditor(sessionToken);
        watchSpy.mockClear();
        await sleep(400);
        expect(watchSpy).not.toHaveBeenCalled();
      } finally {
        accessSpy.mockRestore();
        watchSpy.mockRestore();
        await fast.dispose();
      }
    });

    it('uploads a change that is still waiting out the debounce when the session is closed', async () => {
      const slowDebounce = new FileEditorService({ shell: mockShell, baseTempDir: tempBaseDir, uploadDebounceMs: 5000 });
      const { state } = remoteProvider();
      const { localPath, sessionToken } = await slowDebounce.openInExternalEditor(storageRegistry, 'sftp-up', '/etc/c.ini', () => {});
      await sleep(40);

      await fsp.writeFile(localPath, 'saved just before closing');
      await sleep(50); // seen by the watcher, but nowhere near uploaded (5 s debounce)
      await slowDebounce.closeExternalEditor(sessionToken);

      expect(state.uploads).toEqual(['saved just before closing']);
      await slowDebounce.dispose();
    });

    it('uploads a pending save when the session is disposed, without reporting an error', async () => {
      const slowDebounce = new FileEditorService({ shell: mockShell, baseTempDir: tempBaseDir, uploadDebounceMs: 100 });
      remoteProvider();
      const events: Array<{ status: string }> = [];
      const { localPath } = await slowDebounce.openInExternalEditor(storageRegistry, 'sftp-up', '/etc/d.ini', (e) => events.push(e));
      await sleep(40);
      await fsp.writeFile(localPath, 'changed');
      await sleep(30);
      await slowDebounce.dispose();
      await sleep(250);

      expect(events.filter((e) => e.status === 'error')).toEqual([]);
    });
  });

  describe('dispose', () => {
    it('cleans up all active sessions without errors', async () => {
      const mockProvider = {
        id: 's3-test',
        name: 'S3 Test',
        type: 's3' as const,
        createReadStream: vi.fn().mockImplementation(() => {
          return Readable.from([Buffer.from('s3 data')]);
        }),
        createWriteStream: vi.fn().mockImplementation(() => new PassThrough()),
      };
      storageRegistry.register(mockProvider as any);

      await service.openInExternalEditor(storageRegistry, 's3-test', '/bucket/file.json');
      expect(service.getActiveSessions().length).toBe(1);

      await service.dispose();
      expect(service.getActiveSessions().length).toBe(0);
    });
  });

  describe('remote file name hardening', () => {
    it('reduces hostile remote names to a single safe file name', () => {
      expect(toSafeLocalFileName('/srv/x/..\\..\\Startup\\evil.bat')).toBe('evil.bat');
      expect(toSafeLocalFileName('/a/b/..')).toBe('file.txt');
      expect(toSafeLocalFileName('/a/b/')).toBe('file.txt');
      expect(toSafeLocalFileName('/a/CON.txt')).toBe('_CON.txt');
      expect(toSafeLocalFileName('/a/rep:ort?.txt')).toBe('rep_ort_.txt');
      expect(toSafeLocalFileName('/a/name. . ')).toBe('name');
    });

    it('flags executable types, with script types blocked on Windows only', () => {
      expect(isBlockedExecutableType('setup.EXE', 'linux')).toBe(true);
      expect(isBlockedExecutableType('run.bat', 'win32')).toBe(true);
      expect(isBlockedExecutableType('run.bat', 'linux')).toBe(false);
      expect(isBlockedExecutableType('notes.txt', 'win32')).toBe(false);
    });

    it('refuses to open a downloaded remote executable and leaves no temp dir behind', async () => {
      storageRegistry.register({
        id: 'sftp-exe',
        name: 'SFTP',
        type: 'sftp' as const,
        createReadStream: vi.fn(),
      } as any);

      await expect(
        service.openInExternalEditor(storageRegistry, 'sftp-exe', '/tmp/payload.exe')
      ).rejects.toThrow(/Refusing to open/);
      expect(mockShell.openPath).not.toHaveBeenCalled();
    });
  });
});
