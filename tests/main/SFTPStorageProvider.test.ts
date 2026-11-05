import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Readable, Writable } from 'node:stream';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import type { SFTPConfig } from '../../src/shared/types/storage';
import { formatDate } from '../../src/main/storage/StorageProvider';
import { SFTPStorageProvider } from '../../src/main/storage/SFTPStorageProvider';

// Mock state for the OpenSSH SFTP client adapter using vi.hoisted
const {
  mockConnect,
  mockList,
  mockStat,
  mockMkdir,
  mockRmdir,
  mockDelete,
  mockRename,
  mockPosixRename,
  mockCreateReadStream,
  mockCreateWriteStream,
  mockChmod,
  mockRealPath,
  mockEnd,
  getEventHandlers,
  resetEventHandlers,
} = vi.hoisted(() => {
  let handlers: Record<string, ((...args: any[]) => void)[]> = {};
  return {
    mockConnect: vi.fn(),
    mockList: vi.fn(),
    mockStat: vi.fn(),
    mockMkdir: vi.fn(),
    mockRmdir: vi.fn(),
    mockDelete: vi.fn(),
    mockRename: vi.fn(),
    mockPosixRename: vi.fn(),
    mockCreateReadStream: vi.fn(),
    mockCreateWriteStream: vi.fn(),
    mockChmod: vi.fn().mockResolvedValue(undefined),
    mockRealPath: vi.fn(),
    mockEnd: vi.fn(),
    getEventHandlers: () => handlers,
    resetEventHandlers: () => {
      handlers = {};
    },
  };
});

function emitClientEvent(event: string, ...args: any[]) {
  const handlers = getEventHandlers()[event] || [];
  for (const handler of handlers) {
    handler(...args);
  }
}

vi.mock('../../src/main/storage/sftp/OpenSshSftpClientAdapter', () => {
  class MockOpenSshSftpClientAdapter {
    public connect = mockConnect;
    public list = mockList;
    public stat = mockStat;
    public mkdir = mockMkdir;
    public rmdir = mockRmdir;
    public delete = mockDelete;
    public rename = mockRename;
    public posixRename = mockPosixRename;
    public createReadStream = mockCreateReadStream;
    public createWriteStream = mockCreateWriteStream;
    public chmod = mockChmod;
    public realPath = mockRealPath;
    public end = mockEnd;
    public on = vi.fn((event: string, handler: (...args: any[]) => void) => {
      const handlers = getEventHandlers();
      if (!handlers[event]) {
        handlers[event] = [];
      }
      handlers[event].push(handler);
      return this;
    });
    public removeListener = vi.fn((event: string, handler: (...args: any[]) => void) => {
      const handlers = getEventHandlers();
      if (handlers[event]) {
        handlers[event] = handlers[event].filter((h) => h !== handler);
      }
      return this;
    });
  }

  return {
    OpenSshSftpClientAdapter: MockOpenSshSftpClientAdapter,
  };
});

describe('SFTPStorageProvider', () => {
  let tempDir: string;
  let testKeyPath: string;

  const baseConfig: SFTPConfig = {
    host: 'sftp.example.com',
    port: 2222,
    username: 'testuser',
    authType: 'password',
    password: 'secretpassword',
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    resetEventHandlers();
    mockConnect.mockResolvedValue(undefined);
    mockEnd.mockResolvedValue(true);
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sftp-test-'));
    testKeyPath = path.join(tempDir, 'id_rsa');
    await fs.writeFile(testKeyPath, 'FAKE_RSA_PRIVATE_KEY', 'utf8');
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  describe('initialization and metadata', () => {
    it('should initialize with default id and name when omitted', () => {
      const provider = new SFTPStorageProvider(baseConfig);
      expect(provider.type).toBe('sftp');
      expect(provider.id).toBe('testuser@sftp.example.com:2222');
      expect(provider.name).toBe('testuser@sftp.example.com');
    });

    it('should initialize with custom id and name when provided', () => {
      const provider = new SFTPStorageProvider({
        ...baseConfig,
        id: 'custom-sftp-id',
        name: 'My Remote SFTP',
      });
      expect(provider.type).toBe('sftp');
      expect(provider.id).toBe('custom-sftp-id');
      expect(provider.name).toBe('My Remote SFTP');
    });
  });

  describe('authentication types', () => {
    it('should throw a friendly error when all authentication methods fail', async () => {
      mockConnect.mockRejectedValueOnce(new Error('getConnection: All configured authentication methods failed'));
      const provider = new SFTPStorageProvider({
        ...baseConfig,
        authType: 'password',
        password: 'wrongpassword',
      });

      await expect(provider.ensureConnected()).rejects.toThrow(
        /Authentication failed: The server rejected the login/
      );
    });

    it('delegates authentication to OpenSSH: connect() takes no ssh2 options', async () => {
      const provider = new SFTPStorageProvider({ ...baseConfig, authType: 'fido2' });

      await provider.ensureConnected();

      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockConnect).toHaveBeenCalledWith();
    });

    it('maps OpenSSH "Permission denied" to a friendly authentication error', async () => {
      mockConnect.mockRejectedValueOnce(
        new Error('OpenSSH process terminated: bob@host: Permission denied (publickey,password).')
      );
      const provider = new SFTPStorageProvider(baseConfig);

      await expect(provider.ensureConnected()).rejects.toThrow(/Authentication failed/);
    });

    it('maps OpenSSH "Permission denied" to an agent-specific error for agent profiles', async () => {
      mockConnect.mockRejectedValueOnce(new Error('OpenSSH process terminated: Permission denied (publickey).'));
      const provider = new SFTPStorageProvider({ ...baseConfig, authType: 'agent' });

      await expect(provider.ensureConnected()).rejects.toThrow(/SSH agent authentication failed/);
    });
  });

  describe('automatic connection lifecycle', () => {
    it('should automatically connect on first operation if not already connected', async () => {
      mockList.mockResolvedValue([]);
      const provider = new SFTPStorageProvider(baseConfig);

      expect(mockConnect).not.toHaveBeenCalled();

      await provider.list('/home/testuser');

      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockList).toHaveBeenCalledTimes(1);
    });

    it('should reuse existing connection for subsequent operations without reconnecting', async () => {
      mockList.mockResolvedValue([]);
      mockStat.mockResolvedValue({
        mode: 0o644,
        size: 100,
        modifyTime: Date.now(),
        isDirectory: false,
      });

      const provider = new SFTPStorageProvider(baseConfig);

      await provider.list('/home/testuser');
      await provider.stat('/home/testuser/file.txt');

      expect(mockConnect).toHaveBeenCalledTimes(1);
    });

    it('should deduplicate concurrent connection attempts', async () => {
      mockList.mockResolvedValue([]);
      const provider = new SFTPStorageProvider(baseConfig);

      await Promise.all([
        provider.list('/dir1'),
        provider.list('/dir2'),
        provider.ensureConnected(),
      ]);

      expect(mockConnect).toHaveBeenCalledTimes(1);
    });
  });

  describe('list(remotePath)', () => {
    it('should map directories (isDirectory: true) and files (isDirectory: false)', async () => {
      const date1 = new Date(2026, 8, 14, 10, 30);
      const date2 = new Date(2026, 8, 14, 11, 45);

      mockList.mockResolvedValue([
        {
          name: 'docs',
          type: 'd',
          size: 4096,
          modifyTime: date1.getTime(),
          rights: { user: 'rwx', group: 'rx', other: 'rx' },
        },
        {
          name: 'report.pdf',
          type: '-',
          size: 1048576,
          modifyTime: date2.getTime(),
          rights: { user: 'rw', group: 'r', other: 'r' },
        },
      ]);

      const provider = new SFTPStorageProvider(baseConfig);
      const entries = await provider.list('/remote/data');

      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual({
        name: 'docs',
        path: '/remote/data/docs',
        size: 4096,
        isDirectory: true,
        isSymlink: false,
        mtime: formatDate(date1),
        mtimeMs: date1.getTime(),
        mimeType: undefined,
        permissions: '755',
      });
      expect(entries[1]).toEqual({
        name: 'report.pdf',
        path: '/remote/data/report.pdf',
        size: 1048576,
        isDirectory: false,
        isSymlink: false,
        mtime: formatDate(date2),
        mtimeMs: date2.getTime(),
        mimeType: 'application/pdf',
        permissions: '644',
      });
    });

    // Regression test for the H6 finding (code review): a symlinked
    // directory must be flagged isSymlink so TransferPipeline's scanDirectory
    // skips it instead of recursing through it (potential scope escape or
    // infinite loop on a symlink cycle).
    it('flags a symlink entry (type "l") as isSymlink, not as a directory', async () => {
      const now = Date.now();
      mockList.mockResolvedValue([
        { name: 'link-to-elsewhere', type: 'l', size: 0, modifyTime: now },
      ]);

      const provider = new SFTPStorageProvider(baseConfig);
      const entries = await provider.list('/folder');

      expect(entries).toHaveLength(1);
      expect(entries[0].isSymlink).toBe(true);
      expect(entries[0].isDirectory).toBe(false);
    });

    // M7 (code review 2026-11-03): a FIFO or device on the server must be flagged so transfers skip it
    // (opening it over SFTP blocks until something writes to it).
    it('flags a special file (FIFO, socket, device) as isSpecial, but not a regular file', async () => {
      mockList.mockResolvedValue([
        { name: 'pipe', type: '-', size: 0, isSpecial: true },
        { name: 'plain.txt', type: '-', size: 3 },
      ]);

      const entries = await new SFTPStorageProvider(baseConfig).list('/folder');

      expect(entries.find((e) => e.name === 'pipe')?.isSpecial).toBe(true);
      expect(entries.find((e) => e.name === 'plain.txt')?.isSpecial).toBeFalsy();
    });

    it('should sort directories first, then files alphabetically', async () => {
      const now = Date.now();
      mockList.mockResolvedValue([
        { name: 'zebra.txt', type: '-', size: 10, modifyTime: now },
        { name: 'alpha.txt', type: '-', size: 20, modifyTime: now },
        { name: 'zoo', type: 'd', size: 4096, modifyTime: now },
        { name: 'admin', type: 'd', size: 4096, modifyTime: now },
        { name: 'middle.txt', type: '-', size: 30, modifyTime: now },
      ]);

      const provider = new SFTPStorageProvider(baseConfig);
      const entries = await provider.list('/folder');

      expect(entries.map((e) => e.name)).toEqual([
        'admin',
        'zoo',
        'alpha.txt',
        'middle.txt',
        'zebra.txt',
      ]);
      expect(entries.map((e) => e.isDirectory)).toEqual([
        true,
        true,
        false,
        false,
        false,
      ]);
    });

    it('should format date with formatDate as yyyy-mm-dd HH:mm (24h)', async () => {
      const testDate = new Date('2026-09-14T20:45:00');
      mockList.mockResolvedValue([
        {
          name: 'notes.txt',
          type: '-',
          size: 500,
          modifyTime: testDate.getTime(),
        },
      ]);

      const provider = new SFTPStorageProvider(baseConfig);
      const [entry] = await provider.list('/notes');

      expect(entry.mtime).toBe(formatDate(testDate));
      expect(entry.mtime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    });

    it('should extract permissions from octal mode, attrs.mode, or rights object', async () => {
      mockList.mockResolvedValue([
        {
          name: 'file1.txt',
          type: '-',
          size: 10,
          modifyTime: Date.now(),
          mode: 0o755,
        },
        {
          name: 'file2.txt',
          type: '-',
          size: 10,
          modifyTime: Date.now(),
          attrs: { mode: 0o600 },
        },
        {
          name: 'file3.txt',
          type: '-',
          size: 10,
          modifyTime: Date.now(),
          rights: { user: 'rw', group: 'r', other: '' },
        },
      ]);

      const provider = new SFTPStorageProvider(baseConfig);
      const entries = await provider.list('/files');

      expect(entries[0].permissions).toBe('755');
      expect(entries[1].permissions).toBe('600');
      expect(entries[2].permissions).toBe('640');
    });

    it('should correctly build root relative paths without double slashes', async () => {
      mockList.mockResolvedValue([
        {
          name: 'var',
          type: 'd',
          size: 4096,
          modifyTime: Date.now(),
        },
      ]);

      const provider = new SFTPStorageProvider(baseConfig);
      const entries = await provider.list('/');

      expect(entries[0].path).toBe('/var');
    });

    it('should extract mime type using getMimeType and omit mimeType for directories', async () => {
      mockList.mockResolvedValue([
        { name: 'photo.jpg', type: '-', size: 100, modifyTime: Date.now() },
        { name: 'script.sh', type: '-', size: 100, modifyTime: Date.now() },
        { name: 'subfolder', type: 'd', size: 4096, modifyTime: Date.now() },
        { name: 'unknown.xyz123', type: '-', size: 100, modifyTime: Date.now() },
      ]);

      const provider = new SFTPStorageProvider(baseConfig);
      const entries = await provider.list('/items');

      const photo = entries.find((e) => e.name === 'photo.jpg')!;
      const script = entries.find((e) => e.name === 'script.sh')!;
      const folder = entries.find((e) => e.name === 'subfolder')!;
      const unknown = entries.find((e) => e.name === 'unknown.xyz123')!;

      expect(photo.mimeType).toBe('image/jpeg');
      expect(script.mimeType).toBe('application/x-sh');
      expect(folder.mimeType).toBeUndefined();
      expect(unknown.mimeType).toBeUndefined();
    });
  });

  describe('stat(remotePath)', () => {
    it('should return FileEntry for a file with correct metadata and yyyy-mm-dd HH:mm date', async () => {
      const mtimeDate = new Date(2026, 8, 14, 18, 15);
      mockStat.mockResolvedValue({
        size: 54321,
        isDirectory: false,
        modifyTime: mtimeDate.getTime(),
        mode: 0o644,
      });

      const provider = new SFTPStorageProvider(baseConfig);
      const entry = await provider.stat('/data/file.txt');

      expect(mockStat).toHaveBeenCalledWith('/data/file.txt');
      expect(entry).toEqual({
        name: 'file.txt',
        path: '/data/file.txt',
        size: 54321,
        isDirectory: false,
        isSymlink: false,
        mtime: formatDate(mtimeDate),
        mtimeMs: mtimeDate.getTime(),
        mimeType: 'text/plain',
        permissions: '644',
      });
      expect(entry.mtime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    });

    it('should return FileEntry for a directory with mimeType undefined', async () => {
      const mtimeDate = new Date(2026, 8, 14, 12, 0);
      mockStat.mockResolvedValue({
        size: 4096,
        isDirectory: true,
        modifyTime: mtimeDate.getTime(),
        mode: 0o755,
      });

      const provider = new SFTPStorageProvider(baseConfig);
      const entry = await provider.stat('/var/log');

      expect(mockStat).toHaveBeenCalledWith('/var/log');
      expect(entry).toEqual({
        name: 'log',
        path: '/var/log',
        size: 4096,
        isDirectory: true,
        isSymlink: false,
        mtime: formatDate(mtimeDate),
        mtimeMs: mtimeDate.getTime(),
        mimeType: undefined,
        permissions: '755',
      });
    });
  });

  describe('createFolder(remotePath)', () => {
    it('should call client.mkdir(remotePath, true) for recursive creation', async () => {
      mockMkdir.mockResolvedValue('/remote/path/newfolder');
      const provider = new SFTPStorageProvider(baseConfig);

      await provider.createFolder('/remote/path/newfolder');

      expect(mockMkdir).toHaveBeenCalledTimes(1);
      expect(mockMkdir).toHaveBeenCalledWith('/remote/path/newfolder', true);
    });
  });

  describe('delete(remotePath, isDirectory)', () => {
    it('should call rmdir(remotePath, true) when isDirectory is true', async () => {
      mockRmdir.mockResolvedValue('Successfully removed directory');
      const provider = new SFTPStorageProvider(baseConfig);

      await provider.delete('/remote/some-dir', true);

      expect(mockRmdir).toHaveBeenCalledTimes(1);
      expect(mockRmdir).toHaveBeenCalledWith('/remote/some-dir', true);
      expect(mockDelete).not.toHaveBeenCalled();
    });

    it('should call delete(remotePath) when isDirectory is false', async () => {
      mockDelete.mockResolvedValue('Successfully deleted file');
      const provider = new SFTPStorageProvider(baseConfig);

      await provider.delete('/remote/some-file.txt', false);

      expect(mockDelete).toHaveBeenCalledTimes(1);
      expect(mockDelete).toHaveBeenCalledWith('/remote/some-file.txt');
      expect(mockRmdir).not.toHaveBeenCalled();
    });

    it('should protect against deleting root directory /', async () => {
      const provider = new SFTPStorageProvider(baseConfig);

      await expect(provider.delete('/', true)).rejects.toThrow(
        /cannot delete root/i,
      );
      await expect(provider.delete('/', false)).rejects.toThrow(
        /cannot delete root/i,
      );
      await expect(provider.delete('//', true)).rejects.toThrow(
        /cannot delete root/i,
      );

      expect(mockRmdir).not.toHaveBeenCalled();
      expect(mockDelete).not.toHaveBeenCalled();
    });

    it('should protect against deleting parent directory ..', async () => {
      const provider = new SFTPStorageProvider(baseConfig);

      await expect(provider.delete('..', true)).rejects.toThrow(
        /cannot delete root/i,
      );
      await expect(provider.delete('..', false)).rejects.toThrow(
        /cannot delete root/i,
      );

      expect(mockRmdir).not.toHaveBeenCalled();
      expect(mockDelete).not.toHaveBeenCalled();
    });
  });

  describe('rename(oldPath, newPath)', () => {
    it('should use posixRename if available', async () => {
      mockPosixRename.mockResolvedValue('Successful POSIX rename');
      const provider = new SFTPStorageProvider(baseConfig);

      await provider.rename('/remote/old.txt', '/remote/new.txt');

      expect(mockPosixRename).toHaveBeenCalledWith('/remote/old.txt', '/remote/new.txt');
    });

    it('should fallback to client.rename when posixRename fails', async () => {
      mockPosixRename.mockRejectedValue(new Error('Extension not supported'));
      mockRename.mockResolvedValue('Successfully renamed');
      const provider = new SFTPStorageProvider(baseConfig);

      await provider.rename('/remote/old.txt', '/remote/new.txt');

      expect(mockPosixRename).toHaveBeenCalledWith('/remote/old.txt', '/remote/new.txt');
      expect(mockRename).toHaveBeenCalledWith('/remote/old.txt', '/remote/new.txt');
    });

    it('should move the destination aside, retry the rename, then delete the backup', async () => {
      mockPosixRename.mockRejectedValue(new Error('Extension not supported'));
      mockRename
        .mockRejectedValueOnce(new Error('Failure')) // old -> new (destination exists)
        .mockResolvedValueOnce('moved aside') // new -> backup
        .mockResolvedValueOnce('Successfully renamed'); // old -> new
      mockDelete.mockResolvedValue('Successfully deleted');
      mockStat.mockResolvedValue({ isDirectory: false, size: 1 });
      const provider = new SFTPStorageProvider(baseConfig);

      await provider.rename('/remote/old.txt', '/remote/new.txt');

      const backup = mockRename.mock.calls[1][1] as string;
      expect(mockRename.mock.calls[1][0]).toBe('/remote/new.txt');
      expect(backup).toMatch(/^\/remote\/new\.txt\.sshs3-rename-/);
      expect(mockRename).toHaveBeenNthCalledWith(3, '/remote/old.txt', '/remote/new.txt');
      expect(mockDelete).toHaveBeenCalledWith(backup);
    });

    it('should not replace a destination directory without posix-rename', async () => {
      mockPosixRename.mockRejectedValue(new Error('Extension not supported'));
      mockRename.mockRejectedValueOnce(new Error('Failure'));
      mockStat.mockResolvedValue({ isDirectory: true, size: 0 });
      const provider = new SFTPStorageProvider(baseConfig);

      await expect(provider.rename('/remote/old.txt', '/remote/dir')).rejects.toThrow('Failure');

      expect(mockRename).toHaveBeenCalledTimes(1);
      expect(mockDelete).not.toHaveBeenCalled();
    });

    it('should restore the destination when the retried rename also fails', async () => {
      mockPosixRename.mockRejectedValue(new Error('Extension not supported'));
      mockRename
        .mockRejectedValueOnce(new Error('Failure'))
        .mockResolvedValueOnce('moved aside')
        .mockRejectedValueOnce(new Error('No such file'))
        .mockResolvedValueOnce('restored');
      mockDelete.mockResolvedValue('Successfully deleted');
      mockStat.mockResolvedValue({ isDirectory: false, size: 1 });
      const provider = new SFTPStorageProvider(baseConfig);

      await expect(provider.rename('/remote/old.txt', '/remote/new.txt')).rejects.toThrow('No such file');

      const backup = mockRename.mock.calls[1][1] as string;
      expect(mockRename).toHaveBeenNthCalledWith(4, backup, '/remote/new.txt');
      expect(mockDelete).not.toHaveBeenCalled();
    });
  });

  describe('createReadStream(remotePath, start?, end?)', () => {
    it('should return a readable stream without range options', async () => {
      const mockStream = new Readable({ read() {} });
      mockCreateReadStream.mockReturnValue(mockStream);

      const provider = new SFTPStorageProvider(baseConfig);
      const stream = await provider.createReadStream('/remote/large.dat');

      expect(mockCreateReadStream).toHaveBeenCalledWith('/remote/large.dat', {
        chunkSize: 128 * 1024,
        autoClose: true,
      });
      expect(stream).toBe(mockStream);
    });

    it('should pass start and end range options when specified', async () => {
      const mockStream = new Readable({ read() {} });
      mockCreateReadStream.mockReturnValue(mockStream);

      const provider = new SFTPStorageProvider(baseConfig);
      const stream = await provider.createReadStream('/remote/large.dat', 100, 500);

      expect(mockCreateReadStream).toHaveBeenCalledWith('/remote/large.dat', {
        chunkSize: 128 * 1024,
        autoClose: true,
        start: 100,
        end: 500,
      });
      expect(stream).toBe(mockStream);
    });
  });

  describe('createWriteStream(remotePath, options?)', () => {
    it('should return a writable stream without options', async () => {
      const mockStream = new Writable({ write() {} });
      mockCreateWriteStream.mockReturnValue(mockStream);

      const provider = new SFTPStorageProvider(baseConfig);
      const stream = await provider.createWriteStream('/remote/upload.bin');

      expect(mockCreateWriteStream).toHaveBeenCalledWith('/remote/upload.bin', {
        chunkSize: 128 * 1024,
        autoClose: true,
      });
      expect(stream).toBe(mockStream);
    });

    it('should pass options when provided', async () => {
      const mockStream = new Writable({ write() {} });
      mockCreateWriteStream.mockReturnValue(mockStream);

      const provider = new SFTPStorageProvider(baseConfig);
      const stream = await provider.createWriteStream('/remote/upload.bin', {
        size: 1024,
      });

      expect(mockCreateWriteStream).toHaveBeenCalledWith('/remote/upload.bin', {
        chunkSize: 128 * 1024,
        autoClose: true,
        size: 1024,
      });
      expect(stream).toBe(mockStream);
    });
  });

  describe('disconnect()', () => {
    it('should close the SFTP client using end()', async () => {
      const provider = new SFTPStorageProvider(baseConfig);
      await provider.ensureConnected();

      await provider.disconnect();

      expect(mockEnd).toHaveBeenCalledTimes(1);
    });

    it('should reconnect on next operation after disconnect', async () => {
      mockList.mockResolvedValue([]);
      const provider = new SFTPStorageProvider(baseConfig);

      await provider.list('/first');
      expect(mockConnect).toHaveBeenCalledTimes(1);

      await provider.disconnect();
      expect(mockEnd).toHaveBeenCalledTimes(1);

      await provider.list('/second');
      expect(mockConnect).toHaveBeenCalledTimes(2);
    });

    it('should await in-flight connection before closing client during disconnect', async () => {
      let resolveConnect: () => void;
      mockConnect.mockReturnValue(
        new Promise<void>((resolve) => {
          resolveConnect = resolve;
        }),
      );

      const provider = new SFTPStorageProvider(baseConfig);
      const connectPromise = provider.ensureConnected();

      const disconnectPromise = provider.disconnect();

      // Resolve in-flight connection
      resolveConnect!();

      await Promise.all([connectPromise, disconnectPromise]);

      expect(mockEnd).toHaveBeenCalledTimes(1);

      // Subsequent operation should reconnect
      mockList.mockResolvedValue([]);
      await provider.list('/after-disconnect');
      expect(mockConnect).toHaveBeenCalledTimes(2);
    });
  });

  describe('error handling and reconnection', () => {
    it('does not reopen a connection that was closed on purpose while a call was in flight', async () => {
      const provider = new SFTPStorageProvider(baseConfig);
      mockList.mockResolvedValueOnce([]);
      await provider.list('/warm-up'); // connected
      expect(mockConnect).toHaveBeenCalledTimes(1);

      // The call is running when the user disconnects; the engine then fails it with "stream closed".
      mockList.mockImplementationOnce(async () => {
        await provider.disconnect();
        throw new Error('SFTP stream closed');
      });

      await expect(provider.list('/in-flight')).rejects.toThrow('SFTP stream closed');
      expect(mockConnect).toHaveBeenCalledTimes(1); // no new ssh process
    });

    it('does not run the call again when a disconnect() comes during the reconnect of a retry', async () => {
      const provider = new SFTPStorageProvider(baseConfig);
      mockList.mockResolvedValueOnce([]);
      await provider.list('/warm-up');
      mockList.mockRejectedValueOnce(new Error('SFTP stream closed'));
      // The reconnect the retry starts is where the user disconnects.
      mockConnect.mockImplementationOnce(async () => {
        await provider.disconnect();
      });

      await expect(provider.list('/racy')).rejects.toThrow('SFTP stream closed');
      expect(mockList).toHaveBeenCalledTimes(2); // the warm-up and the failed call, not a third
    });

    it.each(['SFTP stream closed', 'SFTP connection is closed'])(
      'retries the call that was in flight when the ssh process went away ("%s")',
      async (message) => {
        mockList.mockRejectedValueOnce(new Error(message));
        mockList.mockResolvedValueOnce([]);
        const provider = new SFTPStorageProvider(baseConfig);

        await expect(provider.list('/data')).resolves.toEqual([]);

        expect(mockList).toHaveBeenCalledTimes(2);
        expect(mockConnect).toHaveBeenCalledTimes(2); // reconnected once in between
      }
    );

    it('should reject when connect fails and allow subsequent connection attempt', async () => {
      mockConnect.mockRejectedValueOnce(new Error('Connection refused'));
      mockConnect.mockResolvedValueOnce(undefined);
      mockList.mockResolvedValue([]);

      const provider = new SFTPStorageProvider(baseConfig);

      await expect(provider.list('/test')).rejects.toThrow('Connection refused');
      expect(mockConnect).toHaveBeenCalledTimes(1);

      // Next call should retry connecting and succeed
      const entries = await provider.list('/test');
      expect(mockConnect).toHaveBeenCalledTimes(2);
      expect(entries).toEqual([]);
    });

    it('should reconnect if connection is closed via client close event', async () => {
      mockList.mockResolvedValue([]);
      const provider = new SFTPStorageProvider(baseConfig);

      await provider.list('/dir1');
      expect(mockConnect).toHaveBeenCalledTimes(1);

      // Simulate connection close event from server
      emitClientEvent('close');

      await provider.list('/dir2');
      expect(mockConnect).toHaveBeenCalledTimes(2);
    });

    it('should reconnect if connection is closed via client end event', async () => {
      mockList.mockResolvedValue([]);
      const provider = new SFTPStorageProvider(baseConfig);

      await provider.list('/dir1');
      expect(mockConnect).toHaveBeenCalledTimes(1);

      // Simulate connection end event
      emitClientEvent('end');

      await provider.list('/dir2');
      expect(mockConnect).toHaveBeenCalledTimes(2);
    });

    it('should mark disconnected on client error event', async () => {
      mockList.mockResolvedValue([]);
      const provider = new SFTPStorageProvider(baseConfig);

      await provider.list('/dir1');
      expect(mockConnect).toHaveBeenCalledTimes(1);

      // Simulate error event
      emitClientEvent('error', new Error('Network timeout'));

      await provider.list('/dir2');
      expect(mockConnect).toHaveBeenCalledTimes(2);
    });
  });

  describe('chmod', () => {
    it('should call sftp.chmod with parsed octal mode', async () => {
      mockChmod.mockResolvedValue('Successfully change file mode');
      const provider = new SFTPStorageProvider(baseConfig);
      await provider.chmod('/test/file.txt', '755');

      expect(mockChmod).toHaveBeenCalledWith('/test/file.txt', 0o755);
    });

    it('should support numeric mode', async () => {
      mockChmod.mockResolvedValue('Successfully change file mode');
      const provider = new SFTPStorageProvider(baseConfig);
      await provider.chmod('/test/dir', 0o700);

      expect(mockChmod).toHaveBeenCalledWith('/test/dir', 0o700);
    });

    it('should throw for invalid mode string', async () => {
      const provider = new SFTPStorageProvider(baseConfig);
      await expect(provider.chmod('/test/dir', 'invalid')).rejects.toThrow(/Invalid chmod mode/);
    });
  });

  describe('getHomeDir', () => {
    it('returns remote realPath when available', async () => {
      mockRealPath.mockResolvedValue('/home/customuser');
      const provider = new SFTPStorageProvider(baseConfig);
      const home = await provider.getHomeDir();
      expect(home).toBe('/home/customuser');
      expect(mockRealPath).toHaveBeenCalledWith('.');
    });

    it('falls back to /home/<username> when realPath fails', async () => {
      mockRealPath.mockRejectedValue(new Error('realPath not supported'));
      const provider = new SFTPStorageProvider(baseConfig);
      const home = await provider.getHomeDir();
      expect(home).toBe('/home/testuser');
    });

    it('falls back to /root when username is root and realPath fails', async () => {
      mockRealPath.mockRejectedValue(new Error('realPath not supported'));
      const provider = new SFTPStorageProvider({ ...baseConfig, username: 'root' });
      const home = await provider.getHomeDir();
      expect(home).toBe('/root');
    });

    it('falls back to /home/user when username is empty and realPath fails', async () => {
      mockRealPath.mockRejectedValue(new Error('realPath not supported'));
      const provider = new SFTPStorageProvider({ ...baseConfig, username: '' });
      const home = await provider.getHomeDir();
      expect(home).toBe('/home/user');
    });

    it('falls back to /home/<username> when realPath returns "/" for non-root', async () => {
      mockRealPath.mockResolvedValue('/');
      const provider = new SFTPStorageProvider(baseConfig);
      const home = await provider.getHomeDir();
      expect(home).toBe('/home/testuser');
    });
  });
});
