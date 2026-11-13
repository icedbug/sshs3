import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import { Readable, Writable, PassThrough } from 'node:stream';
import { LocalStorageProvider } from '../../src/main/storage/LocalStorageProvider';
import { defineTargetTouched } from '../../src/main/storage/targetTouched';
import {
  TransferPipeline,
  transferFile,
  transferDirectory,
  isRetryableTransferError,
  ByteMeter,
  PauseController,
  getBaseName,
  isDirectoryPath,
  joinPaths,
  dirName,
  pathExists,
  resolveNonConflictingPath,
} from '../../src/main/transfer/TransferPipeline';
import {
  TransferQueue,
  type TransferJob,
} from '../../src/main/transfer/TransferQueue';
import type {
  FileEntry,
  IStorageProvider,
  StorageType,
  TransferProgress,
  WriteStreamOptions,
} from '../../src/shared/types/storage';

/**
 * Helper to create an in-memory mock storage provider.
 */
class MemoryStorageProvider implements IStorageProvider {
  readonly id: string;
  readonly name: string;
  readonly type: StorageType = 'local';
  public files = new Map<string, Buffer>();
  public folders = new Set<string>();
  public readStreamError?: Error;
  public writeStreamError?: Error;

  constructor(id: string = 'memory', name: string = 'Memory Storage') {
    this.id = id;
    this.name = name;
  }

  async list(remotePath: string): Promise<FileEntry[]> {
    const norm = remotePath.replace(/\/+$/, '');
    const entries: FileEntry[] = [];
    for (const folder of this.folders) {
      if (folder !== norm && folder.startsWith(norm ? `${norm}/` : '')) {
        const rel = norm ? folder.slice(norm.length + 1) : folder;
        if (!rel.includes('/')) {
          entries.push({
            name: rel,
            path: folder,
            size: 0,
            isDirectory: true,
          });
        }
      }
    }
    for (const [filePath, content] of this.files) {
      if (filePath.startsWith(norm ? `${norm}/` : '')) {
        const rel = norm ? filePath.slice(norm.length + 1) : filePath;
        if (!rel.includes('/')) {
          entries.push({
            name: rel,
            path: filePath,
            size: content.length,
            isDirectory: false,
          });
        }
      }
    }
    return entries;
  }

  async stat(remotePath: string): Promise<FileEntry> {
    if (this.folders.has(remotePath)) {
      return {
        name: path.basename(remotePath),
        path: remotePath,
        size: 0,
        isDirectory: true,
      };
    }
    const content = this.files.get(remotePath);
    if (content !== undefined) {
      return {
        name: path.basename(remotePath),
        path: remotePath,
        size: content.length,
        isDirectory: false,
      };
    }
    throw new Error(`File not found: ${remotePath}`);
  }

  async getChecksum(remotePath: string, algorithm: 'sha256' | 'md5' = 'sha256'): Promise<string> {
    const content = this.files.get(remotePath);
    if (!content) throw new Error(`File not found: ${remotePath}`);
    return crypto.createHash(algorithm).update(content).digest('hex');
  }

  async createFolder(remotePath: string): Promise<void> {
    this.folders.add(remotePath);
  }

  async delete(remotePath: string, isDirectory: boolean): Promise<void> {
    if (isDirectory) {
      this.folders.delete(remotePath);
      for (const key of this.files.keys()) {
        if (key.startsWith(`${remotePath}/`)) this.files.delete(key);
      }
    } else {
      this.files.delete(remotePath);
    }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const content = this.files.get(oldPath);
    if (content !== undefined) {
      this.files.delete(oldPath);
      this.files.set(newPath, content);
    }
  }

  async createReadStream(remotePath: string): Promise<NodeJS.ReadableStream> {
    if (this.readStreamError) {
      const readErr = this.readStreamError;
      const errStream = new Readable({
        read() {
          this.destroy(readErr);
        },
      });
      return errStream;
    }
    const content = this.files.get(remotePath);
    if (content === undefined) {
      throw new Error(`File not found: ${remotePath}`);
    }
    return Readable.from([content]);
  }

  async createWriteStream(remotePath: string, _options?: WriteStreamOptions): Promise<NodeJS.WritableStream> {
    if (this.writeStreamError) {
      const writeErr = this.writeStreamError;
      const errStream = new Writable({
        write(_chunk, _encoding, callback) {
          callback(writeErr);
        },
      });
      return errStream;
    }
    const chunks: Buffer[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        callback();
      },
    });
    stream.on('finish', () => {
      this.files.set(remotePath, Buffer.concat(chunks));
    });
    return stream;
  }
}

describe('TransferPipeline', () => {
  let sourceDir: string;
  let targetDir: string;
  let sourceLocal: LocalStorageProvider;
  let targetLocal: LocalStorageProvider;

  beforeEach(async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'multissh-transfer-test-'));
    sourceDir = path.join(base, 'source');
    targetDir = path.join(base, 'target');
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.mkdir(targetDir, { recursive: true });
    sourceLocal = new LocalStorageProvider({ basePath: sourceDir });
    targetLocal = new LocalStorageProvider({ basePath: targetDir });
  });

  afterEach(async () => {
    if (sourceDir) {
      const base = path.dirname(sourceDir);
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  describe('Single file transfer', () => {
    it('should transfer a file directly from source to target using memory streams', async () => {
      const fileName = 'hello.txt';
      const fileContent = 'MultiSSH streaming transfer test data 12345';
      await fs.writeFile(path.join(sourceDir, fileName), fileContent, 'utf-8');

      const progressUpdates: TransferProgress[] = [];

      await transferFile({
        sourceProvider: sourceLocal,
        sourcePath: fileName,
        targetProvider: targetLocal,
        targetPath: fileName,
        onProgress: (p) => progressUpdates.push({ ...p }),
      });

      const written = await fs.readFile(path.join(targetDir, fileName), 'utf-8');
      expect(written).toBe(fileContent);

      expect(progressUpdates.length).toBeGreaterThanOrEqual(1);
      const lastProgress = progressUpdates[progressUpdates.length - 1];
      expect(lastProgress.status).toBe('completed');
      expect(lastProgress.transferredBytes).toBe(Buffer.byteLength(fileContent));
      expect(lastProgress.totalBytes).toBe(Buffer.byteLength(fileContent));
      expect(lastProgress.percentage).toBe(100);
    });

    it('should transfer empty file (0 bytes) successfully', async () => {
      const fileName = 'empty.txt';
      await fs.writeFile(path.join(sourceDir, fileName), '', 'utf-8');

      const progressUpdates: TransferProgress[] = [];
      await transferFile({
        sourceProvider: sourceLocal,
        sourcePath: fileName,
        targetProvider: targetLocal,
        targetPath: fileName,
        onProgress: (p) => progressUpdates.push({ ...p }),
      });

      const written = await fs.readFile(path.join(targetDir, fileName), 'utf-8');
      expect(written).toBe('');
      const last = progressUpdates[progressUpdates.length - 1];
      expect(last.transferredBytes).toBe(0);
      expect(last.totalBytes).toBe(0);
      expect(last.percentage).toBe(100);
      expect(last.status).toBe('completed');
    });

    it('should transfer between different provider instances', async () => {
      const memProvider = new MemoryStorageProvider();
      const content = Buffer.from('Cross-provider streaming transfer content');
      memProvider.files.set('remote-file.bin', content);

      await transferFile({
        sourceProvider: memProvider,
        sourcePath: 'remote-file.bin',
        targetProvider: targetLocal,
        targetPath: 'local-file.bin',
      });

      const written = await fs.readFile(path.join(targetDir, 'local-file.bin'));
      expect(written.equals(content)).toBe(true);
    });

    it('should resolve destination path when targetPath is an existing directory or ends with slash', async () => {
      const fileName = 'hello-target-dir.txt';
      const fileContent = 'resolving to existing directory';
      await fs.writeFile(path.join(sourceDir, fileName), fileContent, 'utf-8');

      // Create a subfolder in targetDir
      await fs.mkdir(path.join(targetDir, 'subfolder'), { recursive: true });

      // Transfer with targetPath set to the directory (without filename)
      await transferFile({
        sourceProvider: sourceLocal,
        sourcePath: fileName,
        targetProvider: targetLocal,
        targetPath: 'subfolder',
      });

      const written = await fs.readFile(path.join(targetDir, 'subfolder', fileName), 'utf-8');
      expect(written).toBe(fileContent);
    });

    it('should correctly extract baseName and detect directory paths', async () => {
      expect(getBaseName('/home/alun/secret')).toBe('secret');
      expect(getBaseName('C:\\Users\\alun\\secret.out')).toBe('secret.out');
      expect(getBaseName('/home/alun/folder/')).toBe('folder');
      expect(getBaseName('')).toBe('');

      expect(await isDirectoryPath(targetLocal, '')).toBe(true);
      expect(await isDirectoryPath(targetLocal, '/')).toBe(true);
      expect(await isDirectoryPath(targetLocal, 'nonexistent-folder/')).toBe(true);

      expect(joinPaths('sftp', '/home/alun', 'secret')).toBe('/home/alun/secret');
      expect(joinPaths('sftp', '/', 'secret')).toBe('/secret');
    });

    it('dirName follows provider path conventions', () => {
      expect(dirName('local', path.join('a', 'b', 'c.txt'))).toBe(path.join('a', 'b'));
      expect(dirName('sftp', '/home/alun/secret.txt')).toBe('/home/alun');
      expect(dirName('sftp', '/secret.txt')).toBe('/');
      expect(dirName('s3', 'bucket/key.txt')).toBe('bucket');
    });

    it('pathExists reflects whether a provider path resolves via stat()', async () => {
      const memory = new MemoryStorageProvider();
      memory.files.set('/dst/exists.txt', Buffer.from('hi'));

      expect(await pathExists(memory, '/dst/exists.txt')).toBe(true);
      expect(await pathExists(memory, '/dst/missing.txt')).toBe(false);
    });

    it('resolveNonConflictingPath finds the first free "(n)" suffix, preserving the extension', async () => {
      const memory = new MemoryStorageProvider();
      memory.files.set('/dst/report.pdf', Buffer.from('a'));
      memory.files.set('/dst/report (1).pdf', Buffer.from('b'));

      const resolved = await resolveNonConflictingPath(memory, 'sftp', '/dst/report.pdf');
      expect(resolved).toBe('/dst/report (2).pdf');
    });

    it('resolveNonConflictingPath returns the original path unchanged when there is no conflict', async () => {
      const memory = new MemoryStorageProvider();
      const resolved = await resolveNonConflictingPath(memory, 'sftp', '/dst/free.txt');
      expect(resolved).toBe('/dst/free.txt');
    });

    it('resolveNonConflictingPath handles extensionless files', async () => {
      const memory = new MemoryStorageProvider();
      memory.files.set('/dst/README', Buffer.from('a'));

      const resolved = await resolveNonConflictingPath(memory, 'sftp', '/dst/README');
      expect(resolved).toBe('/dst/README (1)');
    });

    it('should support TransferPipeline class static and instance methods', async () => {
      const fileName = 'class-method.txt';
      const fileContent = 'testing TransferPipeline class methods';
      await fs.writeFile(path.join(sourceDir, fileName), fileContent, 'utf-8');

      // Static method test
      await TransferPipeline.transferFile({
        sourceProvider: sourceLocal,
        sourcePath: fileName,
        targetProvider: targetLocal,
        targetPath: 'static-copy.txt',
      });
      const staticRead = await fs.readFile(path.join(targetDir, 'static-copy.txt'), 'utf-8');
      expect(staticRead).toBe(fileContent);

      // Instance method test
      const pipelineInstance = new TransferPipeline();
      await pipelineInstance.transferFile({
        sourceProvider: sourceLocal,
        sourcePath: fileName,
        targetProvider: targetLocal,
        targetPath: 'instance-copy.txt',
      });
      const instanceRead = await fs.readFile(path.join(targetDir, 'instance-copy.txt'), 'utf-8');
      expect(instanceRead).toBe(fileContent);
    });
  });

  describe('ByteMeter and progress reporting', () => {
    it('should accurately report transferred bytes, percentage, bytesPerSecond, and status', async () => {
      const totalSize = 1000;
      const chunks = [
        Buffer.alloc(250, 'a'),
        Buffer.alloc(250, 'b'),
        Buffer.alloc(250, 'c'),
        Buffer.alloc(250, 'd'),
      ];

      const progressHistory: TransferProgress[] = [];
      const meter = new ByteMeter({
        jobId: 'test-meter-job',
        fileName: 'data.bin',
        totalBytes: totalSize,
        throttleIntervalMs: 0, // no throttle for exact chunk verification
        onProgress: (p) => progressHistory.push({ ...p }),
      });

      const input = Readable.from(chunks);
      const output = new Writable({
        write(_chunk, _encoding, cb) {
          cb();
        },
      });

      await new Promise<void>((resolve, reject) => {
        input.pipe(meter).pipe(output);
        output.on('finish', () => resolve());
        output.on('error', reject);
      });

      expect(progressHistory.length).toBeGreaterThanOrEqual(4);
      const finalProgress = progressHistory[progressHistory.length - 1];
      expect(finalProgress.jobId).toBe('test-meter-job');
      expect(finalProgress.fileName).toBe('data.bin');
      expect(finalProgress.transferredBytes).toBe(totalSize);
      expect(finalProgress.totalBytes).toBe(totalSize);
      expect(finalProgress.percentage).toBe(100);
      expect(finalProgress.status).toBe('completed');
      expect(finalProgress.bytesPerSecond).toBeGreaterThanOrEqual(0);
    });

    it('should throttle progress updates when throttleIntervalMs is set', async () => {
      const chunks: Buffer[] = [];
      for (let i = 0; i < 50; i++) {
        chunks.push(Buffer.alloc(100, i));
      }

      const progressHistory: TransferProgress[] = [];
      const meter = new ByteMeter({
        jobId: 'throttle-job',
        fileName: 'throttle.bin',
        totalBytes: 5000,
        throttleIntervalMs: 150,
        onProgress: (p) => progressHistory.push({ ...p }),
      });

      const input = Readable.from(chunks);
      const output = new Writable({
        write(_chunk, _encoding, cb) {
          cb();
        },
      });

      await new Promise<void>((resolve, reject) => {
        input.pipe(meter).pipe(output);
        output.on('finish', () => resolve());
        output.on('error', reject);
      });

      // 50 chunks without throttle would be 50 calls; with 150ms throttle it should be significantly fewer (typically 1-5 calls)
      expect(progressHistory.length).toBeLessThan(20);
      expect(progressHistory[progressHistory.length - 1].status).toBe('completed');
    });
  });

  describe('Cancellation via AbortSignal', () => {
    it('should abort transfer when AbortSignal is triggered', async () => {
      const abortController = new AbortController();

      // Create a slow readable stream that yields asynchronously
      const slowReadable = new Readable({
        read() {
          setTimeout(() => {
            this.push(Buffer.alloc(1024, 'x'));
          }, 10);
        },
      });

      const memSource = new MemoryStorageProvider();
      memSource.createReadStream = vi.fn().mockResolvedValue(slowReadable);

      const memTarget = new MemoryStorageProvider();

      // Abort after a short tick
      setTimeout(() => {
        abortController.abort();
      }, 30);

      await expect(
        transferFile({
          sourceProvider: memSource,
          sourcePath: 'slow.bin',
          targetProvider: memTarget,
          targetPath: 'slow.bin',
          signal: abortController.signal,
        })
      ).rejects.toThrow();
    });

    it('should unblock and abort ByteMeter when aborted while paused', async () => {
      const pauseController = new PauseController();
      pauseController.pause();
      const abortController = new AbortController();

      const meter = new ByteMeter({
        pauseController,
        signal: abortController.signal,
      });

      const source = new PassThrough();
      const dest = new PassThrough();

      const pipelinePromise = new Promise<void>((resolve, reject) => {
        source.pipe(meter).pipe(dest);
        dest.on('finish', () => resolve());
        meter.on('error', reject);
      });

      source.write('chunk-while-paused');

      // Abort after a tick
      setTimeout(() => {
        abortController.abort();
      }, 20);

      await expect(pipelinePromise).rejects.toThrow();
    });
  });

  describe('Recursive directory transfer', () => {
    it('should recursively copy directory hierarchy and all nested files', async () => {
      // Setup source structure:
      // source/
      // ├── root.txt
      // ├── sub1/
      // │   └── file1.txt
      // └── sub2/
      //     ├── sub3/
      //     │   └── deep.txt
      //     └── file2.txt
      await fs.writeFile(path.join(sourceDir, 'root.txt'), 'root-content', 'utf-8');
      await fs.mkdir(path.join(sourceDir, 'sub1'), { recursive: true });
      await fs.writeFile(path.join(sourceDir, 'sub1', 'file1.txt'), 'file1-content', 'utf-8');
      await fs.mkdir(path.join(sourceDir, 'sub2', 'sub3'), { recursive: true });
      await fs.writeFile(path.join(sourceDir, 'sub2', 'sub3', 'deep.txt'), 'deep-content', 'utf-8');
      await fs.writeFile(path.join(sourceDir, 'sub2', 'file2.txt'), 'file2-content', 'utf-8');

      const progressList: TransferProgress[] = [];

      await transferDirectory({
        sourceProvider: sourceLocal,
        sourcePath: '',
        targetProvider: targetLocal,
        targetPath: '',
        onProgress: (p) => progressList.push({ ...p }),
      });

      // Verify files in targetDir
      const rootText = await fs.readFile(path.join(targetDir, 'root.txt'), 'utf-8');
      const file1Text = await fs.readFile(path.join(targetDir, 'sub1', 'file1.txt'), 'utf-8');
      const deepText = await fs.readFile(path.join(targetDir, 'sub2', 'sub3', 'deep.txt'), 'utf-8');
      const file2Text = await fs.readFile(path.join(targetDir, 'sub2', 'file2.txt'), 'utf-8');

      expect(rootText).toBe('root-content');
      expect(file1Text).toBe('file1-content');
      expect(deepText).toBe('deep-content');
      expect(file2Text).toBe('file2-content');

      expect(progressList.length).toBeGreaterThan(0);
      expect(progressList.some((p) => p.statusMessage?.includes('Scanning'))).toBe(true);
      expect(progressList.some((p) => p.statusMessage?.includes('Creating subdirectory'))).toBe(true);
      expect(progressList.some((p) => p.statusMessage?.includes('File'))).toBe(true);
      const last = progressList[progressList.length - 1];
      expect(last.status).toBe('completed');
    });

    it('should create empty subdirectories in target', async () => {
      await fs.mkdir(path.join(sourceDir, 'empty-sub'), { recursive: true });

      await transferDirectory({
        sourceProvider: sourceLocal,
        sourcePath: '',
        targetProvider: targetLocal,
        targetPath: '',
      });

      const stat = await fs.stat(path.join(targetDir, 'empty-sub'));
      expect(stat.isDirectory()).toBe(true);
    });

    it('should ignore . and .. entries preventing infinite recursion', async () => {
      const mockSource = new MemoryStorageProvider();
      mockSource.list = vi.fn().mockResolvedValue([
        { name: '.', path: '.', size: 0, isDirectory: true },
        { name: '..', path: '..', size: 0, isDirectory: true },
        { name: 'valid.txt', path: 'valid.txt', size: 4, isDirectory: false },
      ]);
      mockSource.files.set('valid.txt', Buffer.from('test'));

      const mockTarget = new MemoryStorageProvider();
      await transferDirectory({
        sourceProvider: mockSource,
        sourcePath: '',
        targetProvider: mockTarget,
        targetPath: '',
      });

      expect(mockTarget.files.has('valid.txt')).toBe(true);
      expect(mockTarget.folders.has('.')).toBe(false);
      expect(mockTarget.folders.has('..')).toBe(false);
    });

    // Regression test for the M9 finding (code review): a single failing
    // file used to abort the whole directory job immediately, leaving every
    // remaining file untried even though nothing about their own transfer
    // was broken.
    it('continues past a failing file, copies the rest, and reports a failure summary (M9)', async () => {
      await fs.writeFile(path.join(sourceDir, 'good1.txt'), 'good-1', 'utf-8');
      await fs.writeFile(path.join(sourceDir, 'bad.txt'), 'bad-content', 'utf-8');
      await fs.writeFile(path.join(sourceDir, 'good2.txt'), 'good-2', 'utf-8');

      const originalCreateReadStream = sourceLocal.createReadStream.bind(sourceLocal);
      vi.spyOn(sourceLocal, 'createReadStream').mockImplementation(async (p: string, ...rest: any[]) => {
        if (p === 'bad.txt') {
          throw new Error('permission denied');
        }
        return (originalCreateReadStream as any)(p, ...rest);
      });

      await expect(
        transferDirectory({
          sourceProvider: sourceLocal,
          sourcePath: '',
          targetProvider: targetLocal,
          targetPath: '',
        })
      ).rejects.toThrow(/1 of 3 file\(s\) failed to transfer.*bad\.txt.*permission denied/s);

      expect(await fs.readFile(path.join(targetDir, 'good1.txt'), 'utf-8')).toBe('good-1');
      expect(await fs.readFile(path.join(targetDir, 'good2.txt'), 'utf-8')).toBe('good-2');
      await expect(fs.stat(path.join(targetDir, 'bad.txt'))).rejects.toThrow();
    });

    it('still aborts the whole directory job immediately on cancellation, without treating it as a per-file failure', async () => {
      await fs.writeFile(path.join(sourceDir, 'a.txt'), 'a', 'utf-8');
      await fs.writeFile(path.join(sourceDir, 'b.txt'), 'b', 'utf-8');

      const controller = new AbortController();
      const originalCreateReadStream = sourceLocal.createReadStream.bind(sourceLocal);
      vi.spyOn(sourceLocal, 'createReadStream').mockImplementation(async (p: string, ...rest: any[]) => {
        if (p === 'a.txt') controller.abort();
        return (originalCreateReadStream as any)(p, ...rest);
      });

      await expect(
        transferDirectory({
          sourceProvider: sourceLocal,
          sourcePath: '',
          targetProvider: targetLocal,
          targetPath: '',
          signal: controller.signal,
        })
      ).rejects.toMatchObject({ name: 'AbortError' });
    });

    // Regression tests for the H6 finding (code review): scanDirectory used
    // to decide whether to recurse using isDirectory alone, which for a
    // symlinked directory comes from a followed stat() — indistinguishable
    // from a real directory. Recursing into it could copy files from
    // anywhere the process can read (scope escape outside the intended
    // source tree) or loop forever on a symlink cycle.
    it('never recurses into or copies a symlinked entry, even via isSymlink alone', async () => {
      const mockSource = new MemoryStorageProvider();
      mockSource.list = vi.fn().mockResolvedValue([
        { name: 'real.txt', path: 'real.txt', size: 4, isDirectory: false, isSymlink: false },
        { name: 'linked-dir', path: 'linked-dir', size: 0, isDirectory: true, isSymlink: true },
        { name: 'linked-file.txt', path: 'linked-file.txt', size: 4, isDirectory: false, isSymlink: true },
      ]);
      mockSource.files.set('real.txt', Buffer.from('test'));

      const mockTarget = new MemoryStorageProvider();
      await transferDirectory({
        sourceProvider: mockSource,
        sourcePath: '',
        targetProvider: mockTarget,
        targetPath: '',
      });

      expect(mockTarget.files.has('real.txt')).toBe(true);
      expect(mockTarget.folders.has('linked-dir')).toBe(false);
      expect(mockTarget.files.has('linked-file.txt')).toBe(false);
      // scanDirectory must never have called list() on the symlinked
      // directory's path at all (proof it didn't recurse into it).
      expect(mockSource.list).not.toHaveBeenCalledWith('linked-dir');
    });

    // M7 (code review 2026-11-03): reading a FIFO blocks until something writes to it, so a folder transfer
    // used to hang on one. Special files are skipped like symlinks.
    it('never copies a special file (FIFO, socket, device) found in a folder', async () => {
      const mockSource = new MemoryStorageProvider();
      mockSource.list = vi.fn().mockResolvedValue([
        { name: 'real.txt', path: 'real.txt', size: 4, isDirectory: false },
        { name: 'pipe', path: 'pipe', size: 0, isDirectory: false, isSpecial: true },
      ]);
      mockSource.files.set('real.txt', Buffer.from('test'));
      const readSpy = vi.spyOn(mockSource, 'createReadStream');
      const mockTarget = new MemoryStorageProvider();

      await transferDirectory({ sourceProvider: mockSource, sourcePath: '', targetProvider: mockTarget, targetPath: '' });

      expect(mockTarget.files.has('real.txt')).toBe(true);
      expect(mockTarget.files.has('pipe')).toBe(false);
      expect(readSpy).not.toHaveBeenCalledWith('pipe', expect.anything(), expect.anything());
      expect(readSpy.mock.calls.map((c) => c[0])).toEqual(['real.txt']);
    });

    it('refuses to transfer a single special file', async () => {
      const mockSource = new MemoryStorageProvider();
      mockSource.stat = vi.fn().mockResolvedValue({ name: 'pipe', path: 'pipe', size: 0, isDirectory: false, isSpecial: true });
      const readSpy = vi.spyOn(mockSource, 'createReadStream');
      const mockTarget = new MemoryStorageProvider();

      await expect(
        transferFile({ sourceProvider: mockSource, sourcePath: 'pipe', targetProvider: mockTarget, targetPath: 'pipe' })
      ).rejects.toThrow('Not a regular file');
      expect(readSpy).not.toHaveBeenCalled();
    });

    it.skipIf(process.platform === 'win32')(
      'end-to-end: a real symlinked directory inside the source tree is not copied to the target',
      async () => {
        const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sshs3-outside-'));
        try {
          await fs.writeFile(path.join(outsideDir, 'secret.txt'), 'should-not-be-copied', 'utf-8');
          await fs.writeFile(path.join(sourceDir, 'root.txt'), 'root-content', 'utf-8');
          await fs.symlink(outsideDir, path.join(sourceDir, 'escape-link'), 'dir');

          await transferDirectory({
            sourceProvider: sourceLocal,
            sourcePath: '',
            targetProvider: targetLocal,
            targetPath: '',
          });

          const rootText = await fs.readFile(path.join(targetDir, 'root.txt'), 'utf-8');
          expect(rootText).toBe('root-content');

          await expect(fs.access(path.join(targetDir, 'escape-link'))).rejects.toThrow();
          await expect(fs.access(path.join(targetDir, 'secret.txt'))).rejects.toThrow();
        } finally {
          await fs.rm(outsideDir, { recursive: true, force: true }).catch(() => {});
        }
      }
    );
  });

  describe('Error handling', () => {
    it('should reject when source read stream fails', async () => {
      const memSource = new MemoryStorageProvider();
      memSource.readStreamError = new Error('Disk read fault');

      const memTarget = new MemoryStorageProvider();

      await expect(
        transferFile({
          sourceProvider: memSource,
          sourcePath: 'broken.txt',
          targetProvider: memTarget,
          targetPath: 'broken.txt',
        })
      ).rejects.toThrow('Disk read fault');
    });

    it('should reject when target write stream fails', async () => {
      const memSource = new MemoryStorageProvider();
      memSource.files.set('data.txt', Buffer.from('data'));

      const memTarget = new MemoryStorageProvider();
      memTarget.writeStreamError = new Error('Disk full write error');

      await expect(
        transferFile({
          sourceProvider: memSource,
          sourcePath: 'data.txt',
          targetProvider: memTarget,
          targetPath: 'data.txt',
        })
      ).rejects.toThrow('Disk full write error');
    });

    it('should destroy readStream when target createWriteStream throws', async () => {
      const memSource = new MemoryStorageProvider();
      memSource.files.set('data.txt', Buffer.from('data'));
      const readStream = await memSource.createReadStream('data.txt');
      const destroySpy = vi.spyOn(readStream as any, 'destroy');
      memSource.createReadStream = vi.fn().mockResolvedValue(readStream);

      const memTarget = new MemoryStorageProvider();
      memTarget.createWriteStream = vi.fn().mockRejectedValue(new Error('Target init failure'));

      await expect(
        transferFile({
          sourceProvider: memSource,
          sourcePath: 'data.txt',
          targetProvider: memTarget,
          targetPath: 'data.txt',
        })
      ).rejects.toThrow('Target init failure');

      expect(destroySpy).toHaveBeenCalled();
    });

    // Regression test for the H7 finding (code review): readStream is
    // created, then `await createWriteStream(...)` runs before pipeline()
    // attaches its own 'error' listener. A stream that errors in that gap
    // previously had zero listeners — Node's default behavior for an
    // unhandled 'error' event is to throw, which crashes the whole Electron
    // main process (not just fail this one transfer). This must instead
    // reject the transfer normally.
    it('does not crash when the read stream errors in the gap before createWriteStream resolves', async () => {
      const memSource = new MemoryStorageProvider();
      memSource.files.set('data.txt', Buffer.from('data'));
      const realStream = await memSource.createReadStream('data.txt');
      memSource.createReadStream = vi.fn().mockImplementation(async () => {
        // setImmediate, not queueMicrotask: it must fire only after
        // transferFile's `await createReadStream(...)` continuation (where
        // the fix attaches its listener) has already run all its pending
        // microtasks, landing squarely in the real-world gap this finding
        // is about — not before the caller even gets the stream back.
        setImmediate(() => (realStream as any).emit('error', new Error('source vanished mid-transfer')));
        return realStream;
      });

      const memTarget = new MemoryStorageProvider();
      const originalCreateWriteStream = memTarget.createWriteStream.bind(memTarget);
      memTarget.createWriteStream = vi.fn().mockImplementation(async (...args: any[]) => {
        // A second, later setImmediate: registered only once createReadStream
        // (and the fix's listener attachment) has already completed, so it
        // always fires after the read-stream error above.
        await new Promise((resolve) => setImmediate(resolve));
        return originalCreateWriteStream(...(args as [string, WriteStreamOptions?]));
      });

      await expect(
        transferFile({
          sourceProvider: memSource,
          sourcePath: 'data.txt',
          targetProvider: memTarget,
          targetPath: 'data.txt',
        })
      ).rejects.toThrow('source vanished mid-transfer');
    });

    // M7 (code review): a failed transfer used to leave a truncated file at
    // exactly the final destination filename — indistinguishable from a
    // complete one. It should be removed instead, once some writing began.
    it('deletes the partial destination file when the transfer fails mid-write (M7)', async () => {
      const memSource = new MemoryStorageProvider();
      memSource.files.set('data.txt', Buffer.from('some file content'));

      const memTarget = new MemoryStorageProvider();
      const deleteSpy = vi.spyOn(memTarget, 'delete');
      memTarget.writeStreamError = new Error('Disk full write error');

      await expect(
        transferFile({
          sourceProvider: memSource,
          sourcePath: 'data.txt',
          targetProvider: memTarget,
          targetPath: 'data.txt',
        })
      ).rejects.toThrow('Disk full write error');

      expect(deleteSpy).toHaveBeenCalledWith('data.txt', false);
    });

    // H2 (code review 2026-11-03): the clean-up must not delete a target the provider never opened/replaced
    // (cancelled S3 overwrite, EACCES on open, SFTP open that never happened).
    it('does not delete an existing target when the write stream never touched it (H2)', async () => {
      const memSource = new MemoryStorageProvider();
      memSource.files.set('data.txt', Buffer.from('new content'));
      const memTarget = new MemoryStorageProvider();
      memTarget.files.set('data.txt', Buffer.from('original'));
      const deleteSpy = vi.spyOn(memTarget, 'delete');
      memTarget.createWriteStream = vi.fn().mockImplementation(async () =>
        defineTargetTouched(
          new Writable({
            write(_chunk, _enc, cb) {
              cb(new Error('open failed: EACCES'));
            },
          }),
          () => false
        )
      );

      await expect(
        transferFile({
          sourceProvider: memSource,
          sourcePath: 'data.txt',
          targetProvider: memTarget,
          targetPath: 'data.txt',
        })
      ).rejects.toThrow('open failed: EACCES');

      expect(deleteSpy).not.toHaveBeenCalled();
      expect(memTarget.files.get('data.txt')?.toString()).toBe('original');
    });

    it('still deletes the target when the write stream reports it was touched (H2)', async () => {
      const memSource = new MemoryStorageProvider();
      memSource.files.set('data.txt', Buffer.from('new content'));
      const memTarget = new MemoryStorageProvider();
      const deleteSpy = vi.spyOn(memTarget, 'delete');
      memTarget.createWriteStream = vi.fn().mockImplementation(async () =>
        defineTargetTouched(
          new Writable({
            write(_chunk, _enc, cb) {
              cb(new Error('disk full'));
            },
          }),
          () => true
        )
      );

      await expect(
        transferFile({
          sourceProvider: memSource,
          sourcePath: 'data.txt',
          targetProvider: memTarget,
          targetPath: 'data.txt',
        })
      ).rejects.toThrow('disk full');

      expect(deleteSpy).toHaveBeenCalledWith('data.txt', false);
    });

    it('does not attempt destination cleanup when createWriteStream itself never succeeded (M7)', async () => {
      const memSource = new MemoryStorageProvider();
      memSource.files.set('data.txt', Buffer.from('data'));
      const memTarget = new MemoryStorageProvider();
      const deleteSpy = vi.spyOn(memTarget, 'delete');
      memTarget.createWriteStream = vi.fn().mockRejectedValue(new Error('Target init failure'));

      await expect(
        transferFile({
          sourceProvider: memSource,
          sourcePath: 'data.txt',
          targetProvider: memTarget,
          targetPath: 'data.txt',
        })
      ).rejects.toThrow('Target init failure');

      expect(deleteSpy).not.toHaveBeenCalled();
    });

    // M8 (code review): the transferred byte count was only ever used for
    // the progress bar, never checked against the source's reported size,
    // so a stream that silently truncated could still finish as 'completed'.
    it('fails the transfer when fewer bytes were written than the source reported (M8)', async () => {
      const memSource = new MemoryStorageProvider();
      memSource.files.set('data.txt', Buffer.from('short'));
      const memTarget = new MemoryStorageProvider();

      await expect(
        transferFile({
          sourceProvider: memSource,
          sourcePath: 'data.txt',
          targetProvider: memTarget,
          targetPath: 'data.txt',
          totalBytes: 999, // deliberately wrong "expected" size
        })
      ).rejects.toThrow(/incomplete/i);

      // The (fully-flushed but size-mismatched) destination file must not
      // be left behind either (M7 kicking in for this M8-detected failure).
      expect(memTarget.files.has('data.txt')).toBe(false);
    });

    it('does not run the integrity check when the source size could not be determined', async () => {
      const memSource = new MemoryStorageProvider();
      memSource.files.set('data.txt', Buffer.from('content'));
      const memTarget = new MemoryStorageProvider();

      await expect(
        transferFile({
          sourceProvider: memSource,
          sourcePath: 'data.txt',
          targetProvider: memTarget,
          targetPath: 'data.txt',
          totalBytes: 0,
        })
      ).resolves.toBeUndefined();

      expect(memTarget.files.get('data.txt')?.toString()).toBe('content');
    });
  });

  describe('Post-transfer integrity and checksum verification (P1 #15)', () => {
    it('computes rolling sha256 and md5 digests in ByteMeter', async () => {
      const payload = Buffer.from('hello world verification payload');
      const expectedSha256 = crypto.createHash('sha256').update(payload).digest('hex');
      const expectedMd5 = crypto.createHash('md5').update(payload).digest('hex');

      const meter = new ByteMeter();
      const input = Readable.from([payload]);
      const output = new PassThrough();

      input.pipe(meter).pipe(output);
      await new Promise<void>((resolve, reject) => {
        output.on('finish', () => resolve());
        output.on('error', reject);
      });

      expect(meter.sha256).toBe(expectedSha256);
      expect(meter.md5).toBe(expectedMd5);
    });

    it('detects and cleans up when target file size does not match expected size', async () => {
      const memSource = new MemoryStorageProvider();
      memSource.files.set('sample.dat', Buffer.from('1234567890'));
      const memTarget = new MemoryStorageProvider();

      // Force target stat to return a truncated size
      const origStat = memTarget.stat.bind(memTarget);
      memTarget.stat = async (p: string) => {
        const res = await origStat(p);
        return { ...res, size: 5 }; // truncated to 5 bytes
      };

      await expect(
        transferFile({
          sourceProvider: memSource,
          sourcePath: 'sample.dat',
          targetProvider: memTarget,
          targetPath: 'sample.dat',
          totalBytes: 10,
        })
      ).rejects.toThrow(/Transfer integrity verification failed/i);

      expect(memTarget.files.has('sample.dat')).toBe(false);
    });

    it('verifies expectedChecksum when provided and matches', async () => {
      const data = Buffer.from('exact content to verify');
      const hash = crypto.createHash('sha256').update(data).digest('hex');

      const memSource = new MemoryStorageProvider();
      memSource.files.set('good.txt', data);
      const memTarget = new MemoryStorageProvider();

      await expect(
        transferFile({
          sourceProvider: memSource,
          sourcePath: 'good.txt',
          targetProvider: memTarget,
          targetPath: 'good.txt',
          totalBytes: data.length,
          expectedChecksum: hash,
        })
      ).resolves.toBeUndefined();

      expect(memTarget.files.has('good.txt')).toBe(true);
    });

    it('fails and removes target file when expectedChecksum mismatches', async () => {
      const data = Buffer.from('exact content to verify');

      const memSource = new MemoryStorageProvider();
      memSource.files.set('corrupt.txt', data);
      const memTarget = new MemoryStorageProvider();

      await expect(
        transferFile({
          sourceProvider: memSource,
          sourcePath: 'corrupt.txt',
          targetProvider: memTarget,
          targetPath: 'corrupt.txt',
          totalBytes: data.length,
          expectedChecksum: '0000000000000000000000000000000000000000000000000000000000000000',
        })
      ).rejects.toThrow(/Checksum verification failed/i);

      expect(memTarget.files.has('corrupt.txt')).toBe(false);
    });

    it('verifies target checksum against source using verifyChecksum: "sha256"', async () => {
      const data = Buffer.from('verified via target provider');
      const memSource = new MemoryStorageProvider();
      memSource.files.set('verified.txt', data);
      const memTarget = new MemoryStorageProvider();

      await expect(
        transferFile({
          sourceProvider: memSource,
          sourcePath: 'verified.txt',
          targetProvider: memTarget,
          targetPath: 'verified.txt',
          totalBytes: data.length,
          verifyChecksum: 'sha256',
        })
      ).resolves.toBeUndefined();

      expect(memTarget.files.has('verified.txt')).toBe(true);
    });

    it('fails transfer if target provider reports mismatched checksum', async () => {
      const data = Buffer.from('tampered content');
      const memSource = new MemoryStorageProvider();
      memSource.files.set('tampered.txt', data);
      const memTarget = new MemoryStorageProvider();

      memTarget.getChecksum = async () => 'badchecksumffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

      await expect(
        transferFile({
          sourceProvider: memSource,
          sourcePath: 'tampered.txt',
          targetProvider: memTarget,
          targetPath: 'tampered.txt',
          totalBytes: data.length,
          verifyChecksum: 'sha256',
        })
      ).rejects.toThrow(/Checksum verification failed/i);

      expect(memTarget.files.has('tampered.txt')).toBe(false);
    });

    it('allows skipping integrity checks when verifyIntegrity: false', async () => {
      const data = Buffer.from('data');
      const memSource = new MemoryStorageProvider();
      memSource.files.set('data.txt', data);
      const memTarget = new MemoryStorageProvider();

      // Corrupt target stat size
      memTarget.stat = async (p: string) => ({
        name: p,
        path: p,
        size: 99999,
        isDirectory: false,
      });

      await expect(
        transferFile({
          sourceProvider: memSource,
          sourcePath: 'data.txt',
          targetProvider: memTarget,
          targetPath: 'data.txt',
          totalBytes: data.length,
          verifyIntegrity: false,
        })
      ).resolves.toBeUndefined();
    });

    it('LocalStorageProvider.getChecksum computes sha256 and md5 on real filesystem', async () => {
      const tmpFile = path.join(sourceDir, 'checksum-test.txt');
      await fs.writeFile(tmpFile, 'local filesystem hash test content');
      const expectedSha256 = crypto
        .createHash('sha256')
        .update('local filesystem hash test content')
        .digest('hex');
      const expectedMd5 = crypto
        .createHash('md5')
        .update('local filesystem hash test content')
        .digest('hex');

      const localProvider = new LocalStorageProvider({ basePath: sourceDir });
      const sha256 = await localProvider.getChecksum('checksum-test.txt', 'sha256');
      const md5 = await localProvider.getChecksum('checksum-test.txt', 'md5');

      expect(sha256).toBe(expectedSha256);
      expect(md5).toBe(expectedMd5);
    });
  });
});

describe('TransferQueue', () => {
  let sourceProvider: MemoryStorageProvider;
  let targetProvider: MemoryStorageProvider;

  beforeEach(() => {
    sourceProvider = new MemoryStorageProvider('src-provider');
    targetProvider = new MemoryStorageProvider('dst-provider');
  });

  it('should initialize with default concurrency 3 and empty job list', () => {
    const queue = new TransferQueue();
    expect(queue.concurrency).toBe(3);
    expect(queue.getJobs()).toEqual([]);
  });

  it('should allow setting custom concurrency', () => {
    const queue = new TransferQueue({ concurrency: 5 });
    expect(queue.concurrency).toBe(5);

    queue.concurrency = 2;
    expect(queue.concurrency).toBe(2);
  });

  it('should add a job in pending status and run it to completion', async () => {
    sourceProvider.files.set('file1.txt', Buffer.from('content 1'));
    const queue = new TransferQueue();

    const job = queue.addJob({
      sourceProvider,
      sourcePath: 'file1.txt',
      targetProvider,
      targetPath: 'file1.txt',
    });

    expect(job.id).toBeDefined();
    expect(job.sourcePath).toBe('file1.txt');
    expect(queue.getJob(job.id)).toBe(job);

    await queue.waitForJob(job.id);

    expect(job.progress.status).toBe('completed');
    expect(targetProvider.files.get('file1.txt')?.toString()).toBe('content 1');
  });

  it('waitForJob resolves with the finished job after its context has been released', async () => {
    sourceProvider.files.set('file1.txt', Buffer.from('content 1'));
    const queue = new TransferQueue();
    const job = queue.addJob({
      sourceProvider,
      sourcePath: 'file1.txt',
      targetProvider,
      targetPath: 'file1.txt',
    });
    await queue.waitForJob(job.id);
    await expect(queue.waitForJob(job.id)).resolves.toBe(job);
    await expect(queue.waitForJob('missing')).rejects.toThrow(/Job not found/);
  });

  it('finishes a job that was cancelled while its transfer was already completing', async () => {
    let finishTransfer!: () => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const fakePipeline = {
      transferFile: () =>
        new Promise<void>((resolve) => {
          finishTransfer = resolve;
          signalStarted();
        }),
      transferDirectory: async () => {},
    };
    const queue = new TransferQueue({ pipeline: fakePipeline as never });
    const events: string[] = [];
    queue.on('completed', () => events.push('completed'));
    queue.on('cancelled', () => events.push('cancelled'));
    queue.on('progress', (p: { status: string }) => events.push(`progress:${p.status}`));

    const job = queue.addJob({ sourceProvider, sourcePath: 'f.txt', targetProvider, targetPath: 'f.txt' });
    await started;

    expect(queue.cancelJob(job.id)).toBe(true);
    finishTransfer(); // the copy finishes anyway: the verification step does not look at the abort signal

    const outcome = await Promise.race([
      queue.waitForJob(job.id).then(() => 'resolved'),
      new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 500)),
    ]);

    expect(outcome).toBe('resolved');
    expect(job.progress.status).toBe('cancelled');
    expect(events).toContain('cancelled');
    expect(events).not.toContain('completed');
    expect(events.filter((e) => e === 'cancelled')).toHaveLength(1);
    expect(queue.hasActiveTransfers()).toBe(false);
  });

  it('fails a job whose source is a special file without opening it (M7)', async () => {
    sourceProvider.stat = vi.fn().mockResolvedValue({ name: 'pipe', path: 'pipe', size: 0, isDirectory: false, isSpecial: true });
    const readSpy = vi.spyOn(sourceProvider, 'createReadStream');
    const queue = new TransferQueue();
    const job = queue.addJob({ sourceProvider, sourcePath: 'pipe', targetProvider, targetPath: 'pipe' });

    await queue.waitForJob(job.id);

    expect(job.progress.status).toBe('failed');
    expect(job.error).toBe('Not a regular file: pipe');
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('refuses to copy a file onto itself on the same provider and leaves it intact', async () => {
    sourceProvider.files.set('same.txt', Buffer.from('keep me'));
    const queue = new TransferQueue();
    const job = queue.addJob({
      sourceProvider,
      sourcePath: 'same.txt',
      targetProvider: sourceProvider,
      targetPath: 'same.txt',
    });

    await queue.waitForJob(job.id);

    expect(job.progress.status).toBe('failed');
    expect(job.error).toBe('Source and target are the same file');
    expect(sourceProvider.files.get('same.txt')?.toString()).toBe('keep me');
  });

  it('should reject duplicate job IDs in addJob', () => {
    const queue = new TransferQueue();
    queue.addJob({
      id: 'dup-1',
      sourceProvider,
      sourcePath: 'f.txt',
      targetProvider,
      targetPath: 'f.txt',
    });

    expect(() => {
      queue.addJob({
        id: 'dup-1',
        sourceProvider,
        sourcePath: 'f.txt',
        targetProvider,
        targetPath: 'f.txt',
      });
    }).toThrow('already exists');
  });

  it('should respect concurrency limit (run at most N concurrent jobs)', async () => {
    // Set concurrency to 2 and add 4 slow jobs
    const queue = new TransferQueue({ concurrency: 2 });
    let maxRunningAtOnce = 0;
    let currentlyRunning = 0;

    const createSlowStreamProvider = () => {
      const p = new MemoryStorageProvider();
      p.createReadStream = async () => {
        currentlyRunning++;
        if (currentlyRunning > maxRunningAtOnce) {
          maxRunningAtOnce = currentlyRunning;
        }
        const stream = new PassThrough();
        setTimeout(() => {
          stream.write('chunk');
          setTimeout(() => {
            currentlyRunning--;
            stream.end();
          }, 40);
        }, 10);
        return stream;
      };
      return p;
    };

    const slowSource = createSlowStreamProvider();

    const jobs: TransferJob[] = [];
    for (let i = 0; i < 4; i++) {
      jobs.push(
        queue.addJob({
          sourceProvider: slowSource,
          sourcePath: `slow${i}.txt`,
          targetProvider,
          targetPath: `slow${i}.txt`,
        })
      );
    }

    await queue.waitForAll();

    expect(maxRunningAtOnce).toBeLessThanOrEqual(2);
    for (const job of jobs) {
      expect(job.progress.status).toBe('completed');
    }
  });

  it('should pause and resume a pending job', async () => {
    sourceProvider.files.set('job-a.txt', Buffer.from('data-a'));
    sourceProvider.files.set('job-b.txt', Buffer.from('data-b'));

    // Concurrency 1 so job 2 is pending
    const queue = new TransferQueue({ concurrency: 1 });

    const job1 = queue.addJob({
      sourceProvider,
      sourcePath: 'job-a.txt',
      targetProvider,
      targetPath: 'job-a.txt',
    });

    const job2 = queue.addJob({
      sourceProvider,
      sourcePath: 'job-b.txt',
      targetProvider,
      targetPath: 'job-b.txt',
    });

    // Pause job2 while still pending
    queue.pauseJob(job2.id);
    expect(job2.progress.status).toBe('paused');

    await queue.waitForJob(job1.id);
    expect(job1.progress.status).toBe('completed');

    // job2 should still be paused, not running or completed
    expect(job2.progress.status).toBe('paused');

    // Resume job2
    queue.resumeJob(job2.id);
    expect(job2.progress.status).toBe('pending');

    await queue.waitForJob(job2.id);
    expect(job2.progress.status).toBe('completed');
  });

  it('should keep waitForAll waiting while jobs are paused', async () => {
    sourceProvider.files.set('pause-wait.txt', Buffer.from('data'));
    const queue = new TransferQueue({ concurrency: 1 });
    const job = queue.addJob({
      sourceProvider,
      sourcePath: 'pause-wait.txt',
      targetProvider,
      targetPath: 'pause-wait.txt',
    });
    queue.pauseJob(job.id);

    let finished = false;
    const waitPromise = queue.waitForAll().then(() => {
      finished = true;
    });

    await new Promise((r) => setTimeout(r, 30));
    expect(finished).toBe(false);

    queue.resumeJob(job.id);
    await waitPromise;
    expect(finished).toBe(true);
    expect(job.progress.status).toBe('completed');
  });

  it('should pause and resume a running job', async () => {
    // Readable that emits 2 chunks with pause in between
    const pSource = new MemoryStorageProvider();
    pSource.createReadStream = async () => {
      const stream = new PassThrough();
      stream.write('chunk-1');
      return stream;
    };

    const queue = new TransferQueue({ concurrency: 1 });
    const job = queue.addJob({
      sourceProvider: pSource,
      sourcePath: 'streaming.bin',
      targetProvider,
      targetPath: 'streaming.bin',
    });

    // Let job start
    await new Promise((r) => setTimeout(r, 20));
    expect(job.progress.status).toBe('running');

    queue.pauseJob(job.id);
    expect(job.progress.status).toBe('paused');

    // Wait a bit to ensure it stays paused
    await new Promise((r) => setTimeout(r, 40));
    expect(job.progress.status).toBe('paused');

    queue.resumeJob(job.id);
    expect(job.progress.status).toBe('running');
  });

  it('should cancel a running job via cancelJob()', async () => {
    const slowSource = new MemoryStorageProvider();
    slowSource.createReadStream = async () => {
      const stream = new PassThrough();
      // never ends unless destroyed
      stream.write('chunk-data');
      return stream;
    };

    const queue = new TransferQueue();
    const job = queue.addJob({
      sourceProvider: slowSource,
      sourcePath: 'infinite.bin',
      targetProvider,
      targetPath: 'infinite.bin',
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(job.progress.status).toBe('running');

    const cancelled = queue.cancelJob(job.id);
    expect(cancelled).toBe(true);
    expect(job.progress.status).toBe('cancelled');
  });

  it('should cancel a pending job before it starts', async () => {
    const queue = new TransferQueue({ concurrency: 0 }); // won't process anything

    const job = queue.addJob({
      sourceProvider,
      sourcePath: 'queued.txt',
      targetProvider,
      targetPath: 'queued.txt',
    });

    expect(job.progress.status).toBe('pending');
    queue.cancelJob(job.id);
    expect(job.progress.status).toBe('cancelled');
  });

  it('should clear completed jobs with clearCompleted()', async () => {
    sourceProvider.files.set('comp1.txt', Buffer.from('1'));
    sourceProvider.files.set('comp2.txt', Buffer.from('2'));

    const queue = new TransferQueue({ concurrency: 2 });
    queue.addJob({
      sourceProvider,
      sourcePath: 'comp1.txt',
      targetProvider,
      targetPath: 'comp1.txt',
    });
    queue.addJob({
      sourceProvider,
      sourcePath: 'comp2.txt',
      targetProvider,
      targetPath: 'comp2.txt',
    });

    await queue.waitForAll();
    expect(queue.getJobs().length).toBe(2);

    const cleared = queue.clearCompleted();
    expect(cleared.length).toBe(2);
    expect(queue.getJobs().length).toBe(0);
  });

  it('should emit progress and completed events on EventEmitter', async () => {
    sourceProvider.files.set('event.txt', Buffer.from('events testing'));
    const queue = new TransferQueue();

    const progressEvents: TransferProgress[] = [];
    const completedJobs: TransferJob[] = [];

    queue.on('progress', (p) => progressEvents.push({ ...p }));
    queue.on('completed', (j) => completedJobs.push(j));

    const job = queue.addJob({
      sourceProvider,
      sourcePath: 'event.txt',
      targetProvider,
      targetPath: 'event.txt',
    });

    await queue.waitForJob(job.id);

    expect(progressEvents.length).toBeGreaterThan(0);
    expect(completedJobs.length).toBe(1);
    expect(completedJobs[0].id).toBe(job.id);
  });

  it('should handle errors gracefully and mark job as failed without breaking the queue', async () => {
    const brokenSource = new MemoryStorageProvider();
    brokenSource.readStreamError = new Error('Disk unreadable');

    sourceProvider.files.set('valid.txt', Buffer.from('healthy'));

    const queue = new TransferQueue({ concurrency: 1 });
    const failedEvents: TransferJob[] = [];
    queue.on('failed', (job) => failedEvents.push(job));

    const failJob = queue.addJob({
      sourceProvider: brokenSource,
      sourcePath: 'bad.txt',
      targetProvider,
      targetPath: 'bad.txt',
    });

    const goodJob = queue.addJob({
      sourceProvider,
      sourcePath: 'valid.txt',
      targetProvider,
      targetPath: 'valid.txt',
    });

    await queue.waitForAll();

    expect(failJob.progress.status).toBe('failed');
    expect(failJob.error).toContain('Disk unreadable');
    expect(failedEvents.length).toBe(1);
    expect(failedEvents[0].id).toBe(failJob.id);

    // Verify subsequent job still ran and succeeded!
    expect(goodJob.progress.status).toBe('completed');
    expect(targetProvider.files.get('valid.txt')?.toString()).toBe('healthy');
  });

  it('should track active transfers count and allow cancelling all', async () => {
    // Large payload to keep it running
    sourceProvider.files.set('large1.bin', Buffer.alloc(1024 * 1024));
    sourceProvider.files.set('large2.bin', Buffer.alloc(1024 * 1024));

    const queue = new TransferQueue({ concurrency: 1 });
    expect(queue.hasActiveTransfers()).toBe(false);
    expect(queue.getActiveTransferCount()).toBe(0);

    const job1 = queue.addJob({
      sourceProvider,
      sourcePath: 'large1.bin',
      targetProvider,
      targetPath: 'large1.bin',
    });
    const job2 = queue.addJob({
      sourceProvider,
      sourcePath: 'large2.bin',
      targetProvider,
      targetPath: 'large2.bin',
    });

    expect(queue.hasActiveTransfers()).toBe(true);
    expect(queue.getActiveTransferCount()).toBe(2);

    queue.cancelAll();

    expect(job1.progress.status === 'cancelled' || job2.progress.status === 'cancelled').toBe(true);
    await queue.waitForAll().catch(() => {});
    expect(queue.getActiveTransferCount()).toBe(0);
    expect(queue.hasActiveTransfers()).toBe(false);
  });

  it('should not double-nest path when targetPath already matches baseName and exists', async () => {
    // Target already has 'folder'
    await targetProvider.createFolder('folder');
    sourceProvider.files.set('folder/file.txt', Buffer.from('hello'));
    await sourceProvider.createFolder('folder');

    const queue = new TransferQueue();
    const job = queue.addJob({
      sourceProvider,
      sourcePath: 'folder',
      targetProvider,
      targetPath: 'folder', // Already resolved to 'folder'
      isDirectory: true,
    });

    await queue.waitForJob(job.id);
    expect(job.progress.status).toBe('completed');
    // Target should have 'folder/file.txt', not 'folder/folder/file.txt'
    const expectedFilePath = joinPaths(targetProvider.type, 'folder', 'file.txt');
    expect(targetProvider.files.has(expectedFilePath) || targetProvider.files.has('folder/file.txt')).toBe(true);
    const doubleNestedFolder = joinPaths(targetProvider.type, 'folder', 'folder');
    expect(targetProvider.folders.has(doubleNestedFolder) || targetProvider.folders.has('folder/folder')).toBe(false);
  });

  describe('Transient error detection and retry resilience', () => {
    it('correctly classifies retryable vs non-retryable errors', () => {
      expect(isRetryableTransferError(new Error('Connection lost'))).toBe(true);
      expect(isRetryableTransferError({ code: 'ECONNRESET', message: 'read ECONNRESET' })).toBe(true);
      expect(isRetryableTransferError({ code: 'ETIMEDOUT', message: 'connection timed out' })).toBe(true);
      expect(isRetryableTransferError(new Error('socket hung up'))).toBe(true);
      expect(isRetryableTransferError(new Error('Channel closed'))).toBe(true);

      const abortErr = new Error('Transfer aborted');
      abortErr.name = 'AbortError';
      expect(isRetryableTransferError(abortErr)).toBe(false);
      expect(isRetryableTransferError(new Error('Transfer cancelled'))).toBe(false);
      expect(isRetryableTransferError(new Error('Incomplete transfer'))).toBe(false);
      expect(isRetryableTransferError(new Error('ENOENT: no such file or directory'))).toBe(false);
      expect(isRetryableTransferError(null)).toBe(false);
    });

    it('retries transient failures and succeeds on subsequent attempt', async () => {
      sourceProvider.files.set('transient.txt', Buffer.from('hello retry'));
      let readAttempts = 0;
      const originalReadStream = sourceProvider.createReadStream.bind(sourceProvider);

      vi.spyOn(sourceProvider, 'createReadStream').mockImplementation(async (filePath: string) => {
        readAttempts++;
        if (readAttempts === 1) {
          const errStream = new PassThrough();
          process.nextTick(() => {
            const err = new Error('read ECONNRESET');
            (err as any).code = 'ECONNRESET';
            errStream.emit('error', err);
          });
          return errStream;
        }
        return originalReadStream(filePath);
      });

      await transferFile({
        sourceProvider,
        targetProvider,
        sourcePath: 'transient.txt',
        targetPath: 'transient_out.txt',
        maxRetries: 2,
      });

      expect(readAttempts).toBe(2);
      expect(targetProvider.files.get('transient_out.txt')?.toString()).toBe('hello retry');
    });
  });

  describe('transferDirectory concurrency', () => {
    // The in-memory mock providers key files by POSIX path; transferDirectory builds target paths with native path.join (backslashes on Windows)
    it.skipIf(process.platform === 'win32')('transfers all files across concurrent workers with progress', async () => {
      await sourceProvider.createFolder('srcdir');
      for (let i = 1; i <= 6; i++) {
        sourceProvider.files.set(`srcdir/file${i}.txt`, Buffer.from(`content-${i}`));
      }

      const progressUpdates: any[] = [];
      await transferDirectory({
        sourceProvider,
        targetProvider,
        sourcePath: 'srcdir',
        targetPath: 'dstdir',
        concurrency: 3,
        onProgress: (p) => {
          progressUpdates.push(p);
        },
      });

      for (let i = 1; i <= 6; i++) {
        expect(targetProvider.files.get(`dstdir/file${i}.txt`)?.toString()).toBe(`content-${i}`);
      }
      expect(progressUpdates.length).toBeGreaterThan(0);
      const lastProgress = progressUpdates[progressUpdates.length - 1];
      expect(lastProgress.percentage).toBe(100);
    });
  });
});

// The deferred clean-up for an open that answered after the failed transfer stopped waiting for it.
describe('late open after a failed transfer', () => {
  function slowOpenStream(touchedAfter: { value: boolean }, settle: Promise<void>) {
    const stream = defineTargetTouched(
      new Writable({
        write(_c, _e, cb) {
          cb(new Error('source failed'));
        },
      }),
      () => touchedAfter.value
    );
    (stream as unknown as { targetSettled: () => Promise<void> }).targetSettled = () => settle;
    return stream;
  }

  async function run(
    targetContent: string | undefined,
    resolveOpen: (t: { value: boolean }, at: { target: MemoryStorageProvider; path: string }) => void,
  ) {
    const memSource = new MemoryStorageProvider();
    memSource.files.set('data.txt', Buffer.from('new content'));
    const memTarget = new MemoryStorageProvider();
    if (targetContent !== undefined) memTarget.files.set('data.txt', Buffer.from(targetContent));
    const touched = { value: false };
    let release!: () => void;
    let lateRuns = 0;
    const settle = new Promise<void>((r) => { release = r; }).then(() => { lateRuns++; });
    let openedPath = '';
    memTarget.createWriteStream = vi.fn().mockImplementation(async (p: string) => {
      openedPath = p;
      return slowOpenStream(touched, settle);
    });
    const deleteSpy = vi.spyOn(memTarget, 'delete');
    await expect(
      transferFile({ sourceProvider: memSource, sourcePath: 'data.txt', targetProvider: memTarget, targetPath: 'data.txt', targetSettleTimeoutMs: 20 })
    ).rejects.toThrow('source failed');
    expect(deleteSpy).not.toHaveBeenCalled(); // nothing is deleted while the open is unanswered
    resolveOpen(touched, { target: memTarget, path: openedPath });
    release();
    await new Promise((r) => setTimeout(r, 0));
    await vi.waitFor(() => expect(lateRuns).toBeGreaterThan(0), { timeout: 2000 });
    await new Promise((r) => setTimeout(r, 20)); // let the stat and delete after the settle finish
    return { memTarget, deleteSpy };
  }

  it('removes the empty file the late open left behind', async () => {
    const { memTarget, deleteSpy } = await run(undefined, (t, at) => {
      t.value = true;
      at.target.files.set(at.path, Buffer.alloc(0));
    });
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(memTarget.files.has('data.txt')).toBe(false);
  });

  it('never deletes an existing file it was going to replace: the copy went to a temporary file', async () => {
    const { memTarget } = await run('', (t, at) => {
      t.value = true;
      at.target.files.set(at.path, Buffer.alloc(0));
    });
    expect(memTarget.files.get('data.txt')?.toString()).toBe('');
    expect([...memTarget.files.keys()].filter((k) => k.includes('sshs3-part'))).toEqual([]);
  });

  it('leaves a file alone that a newer transfer has written since', async () => {
    const { memTarget, deleteSpy } = await run('written by a newer transfer', (t) => { t.value = true; });
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(memTarget.files.get('data.txt')?.toString()).toBe('written by a newer transfer');
  });

  it('does nothing when the late open turns out not to have touched the target', async () => {
    const { deleteSpy } = await run('original', () => {});
    expect(deleteSpy).not.toHaveBeenCalled();
  });
});
