import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { LocalStorageProvider } from '../../src/main/storage/LocalStorageProvider';
import type { IStorageProvider } from '../../src/shared/types/storage';

describe('LocalStorageProvider', () => {
  let testDir: string;
  let provider: LocalStorageProvider;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'multissh-local-storage-test-'));
    provider = new LocalStorageProvider();
  });

  afterEach(async () => {
    if (testDir) {
      await fs.rm(testDir, { recursive: true, force: true });
    }
  });

  it('should implement IStorageProvider with default and custom metadata', () => {
    const defaultProvider: IStorageProvider = new LocalStorageProvider();
    expect(defaultProvider.type).toBe('local');
    expect(defaultProvider.id).toBe('local');
    expect(defaultProvider.name).toBe('Local Storage');

    const customProvider = new LocalStorageProvider({
      id: 'custom-local',
      name: 'My Computer',
      basePath: testDir,
    });
    expect(customProvider.type).toBe('local');
    expect(customProvider.id).toBe('custom-local');
    expect(customProvider.name).toBe('My Computer');
  });

  describe('list: special files (M7)', () => {
    it.skipIf(process.platform === 'win32')('flags a FIFO as isSpecial, and a regular file, folder and symlink as not', async () => {
      const { execFileSync } = await import('node:child_process');
      await fs.writeFile(path.join(testDir, 'plain.txt'), 'x');
      await fs.mkdir(path.join(testDir, 'folder'));
      await fs.symlink(path.join(testDir, 'plain.txt'), path.join(testDir, 'link'));
      execFileSync('mkfifo', [path.join(testDir, 'pipe')]);

      const byName = new Map((await provider.list(testDir)).map((e) => [e.name, e]));

      expect(byName.get('pipe')?.isSpecial).toBe(true);
      expect(byName.get('plain.txt')?.isSpecial).toBeFalsy();
      expect(byName.get('folder')?.isSpecial).toBeFalsy();
      expect(byName.get('link')?.isSpecial).toBeFalsy();
    });
  });

  describe('createFolder', () => {
    it('should create a single directory', async () => {
      const folderPath = path.join(testDir, 'test-folder');
      await provider.createFolder(folderPath);

      const stat = await fs.stat(folderPath);
      expect(stat.isDirectory()).toBe(true);
    });

    it('should create recursive nested directories', async () => {
      const nestedPath = path.join(testDir, 'level1', 'level2', 'level3');
      await provider.createFolder(nestedPath);

      const stat = await fs.stat(nestedPath);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  describe('createWriteStream', () => {
    it('should write data to a file via stream', async () => {
      const filePath = path.join(testDir, 'written-file.txt');
      const writeStream = await provider.createWriteStream(filePath);

      await new Promise<void>((resolve, reject) => {
        writeStream.on('finish', () => resolve());
        writeStream.on('error', (err) => reject(err));
        writeStream.write('Hello, MultiSSH Storage Engine!');
        writeStream.end();
      });

      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toBe('Hello, MultiSSH Storage Engine!');
    });

    it('reports the target as touched only once the file has been opened (H2)', async () => {
      const filePath = path.join(testDir, 'touched.txt');
      const writeStream = (await provider.createWriteStream(filePath)) as NodeJS.WritableStream & { targetTouched: boolean };

      await new Promise<void>((resolve, reject) => {
        writeStream.on('finish', () => resolve());
        writeStream.on('error', reject);
        writeStream.end('x');
      });
      expect(writeStream.targetTouched).toBe(true);
    });

    it('leaves the target untouched when it cannot be opened (H2)', async () => {
      // A directory cannot be opened for writing (EISDIR), on every platform.
      const dirPath = path.join(testDir, 'a-directory');
      await fs.mkdir(dirPath);
      const writeStream = (await provider.createWriteStream(dirPath)) as NodeJS.WritableStream & { targetTouched: boolean; targetSettled(): Promise<void> };
      writeStream.on('error', () => {});
      writeStream.end('x');
      await writeStream.targetSettled();
      expect(writeStream.targetTouched).toBe(false);
    });

    // Code review of the unpushed commits: the open is already under way when the stream is returned.
    it('says the file was truncated once targetSettled resolves, even if the stream is destroyed straight away', async () => {
      const filePath = path.join(testDir, 'existing.txt');
      await fs.writeFile(filePath, 'original content');
      const writeStream = (await provider.createWriteStream(filePath)) as NodeJS.WritableStream & { targetTouched: boolean; targetSettled(): Promise<void> };
      (writeStream as unknown as { destroy(): void }).destroy();
      await writeStream.targetSettled();
      expect(writeStream.targetTouched).toBe(true);
      expect(await fs.readFile(filePath, 'utf-8')).toBe('');
    });

    it('should automatically create parent directories when writing a file', async () => {
      const filePath = path.join(testDir, 'nested', 'deeply', 'output.txt');
      const writeStream = await provider.createWriteStream(filePath);

      await new Promise<void>((resolve, reject) => {
        writeStream.on('finish', () => resolve());
        writeStream.on('error', (err) => reject(err));
        writeStream.write('Parent dirs created automatically');
        writeStream.end();
      });

      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toBe('Parent dirs created automatically');
    });
  });

  describe('writeFile', () => {
    it('replaces existing content by default and refuses to when exclusive', async () => {
      const file = path.join(testDir, 'w.txt');
      await provider.writeFile(file, Buffer.from('one'));
      await provider.writeFile(file, Buffer.from('two'));
      expect(await fs.readFile(file, 'utf8')).toBe('two');

      await expect(provider.writeFile(file, Buffer.from('three'), { exclusive: true })).rejects.toMatchObject({
        code: 'EEXIST',
      });
      expect(await fs.readFile(file, 'utf8')).toBe('two');
    });
  });

  describe('createReadStream', () => {
    it('should read file content via stream', async () => {
      const filePath = path.join(testDir, 'sample.txt');
      const expectedContent = 'Streaming content test data';
      await fs.writeFile(filePath, expectedContent, 'utf-8');

      const readStream = await provider.createReadStream(filePath);
      const chunks: Buffer[] = [];

      await new Promise<void>((resolve, reject) => {
        readStream.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        readStream.on('end', () => resolve());
        readStream.on('error', (err) => reject(err));
      });

      const readContent = Buffer.concat(chunks).toString('utf-8');
      expect(readContent).toBe(expectedContent);
    });

    it('should read a specific byte range with start and end offsets', async () => {
      const filePath = path.join(testDir, 'range.txt');
      await fs.writeFile(filePath, '0123456789abcdef', 'utf-8');

      // Byte range 2 to 7 (inclusive in Node.js fs.createReadStream)
      const readStream = await provider.createReadStream(filePath, 2, 7);
      const chunks: Buffer[] = [];

      await new Promise<void>((resolve, reject) => {
        readStream.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        readStream.on('end', () => resolve());
        readStream.on('error', (err) => reject(err));
      });

      const readContent = Buffer.concat(chunks).toString('utf-8');
      expect(readContent).toBe('234567');
    });
  });

  describe('stat', () => {
    it('should return stat metadata for a file', async () => {
      const filePath = path.join(testDir, 'info.json');
      const payload = JSON.stringify({ hello: 'world' });
      await fs.writeFile(filePath, payload, 'utf-8');

      const entry = await provider.stat(filePath);
      expect(entry.name).toBe('info.json');
      expect(entry.path).toBe(filePath);
      expect(entry.size).toBe(Buffer.byteLength(payload));
      expect(entry.isDirectory).toBe(false);
      expect(entry.mimeType).toBe('application/json');
      expect(entry.mtime).toBeDefined();
      expect(typeof entry.mtime).toBe('string');
      // Format should follow yyyy-mm-dd HH:mm
      expect(entry.mtime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
      expect(entry.permissions).toBeDefined();
    });

    it('should return stat metadata for a directory', async () => {
      const folderPath = path.join(testDir, 'test-dir');
      await fs.mkdir(folderPath);

      const entry = await provider.stat(folderPath);
      expect(entry.name).toBe('test-dir');
      expect(entry.path).toBe(folderPath);
      expect(entry.isDirectory).toBe(true);
      expect(entry.mimeType).toBeUndefined();
      expect(entry.mtime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    });

    it('should leave mimeType as undefined for files with unknown extension', async () => {
      const filePath = path.join(testDir, 'unknown.somecustomext');
      await fs.writeFile(filePath, 'custom data', 'utf-8');

      const entry = await provider.stat(filePath);
      expect(entry.mimeType).toBeUndefined();
    });
  });

  describe('list', () => {
    it('should list files and subdirectories with complete metadata', async () => {
      const subDir = path.join(testDir, 'subfolder');
      await fs.mkdir(subDir);
      const file1 = path.join(testDir, 'file1.txt');
      await fs.writeFile(file1, 'content 1', 'utf-8');
      const file2 = path.join(testDir, 'file2.md');
      await fs.writeFile(file2, '# Markdown content', 'utf-8');

      const entries = await provider.list(testDir);

      expect(entries).toHaveLength(3);

      // Verify directory entry
      const dirEntry = entries.find((e) => e.name === 'subfolder');
      expect(dirEntry).toBeDefined();
      expect(dirEntry?.isDirectory).toBe(true);
      expect(dirEntry?.path).toBe(subDir);
      expect(dirEntry?.mtime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);

      // Verify file entries
      const f1Entry = entries.find((e) => e.name === 'file1.txt');
      expect(f1Entry).toBeDefined();
      expect(f1Entry?.isDirectory).toBe(false);
      expect(f1Entry?.size).toBe(Buffer.byteLength('content 1'));
      expect(f1Entry?.mimeType).toBe('text/plain');
      expect(f1Entry?.path).toBe(file1);
      expect(f1Entry?.mtime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);

      const f2Entry = entries.find((e) => e.name === 'file2.md');
      expect(f2Entry).toBeDefined();
      expect(f2Entry?.isDirectory).toBe(false);
      expect(f2Entry?.size).toBe(Buffer.byteLength('# Markdown content'));
      expect(f2Entry?.mimeType).toBe('text/markdown');
      expect(f2Entry?.path).toBe(file2);

      // Directories should appear before files in sorted list
      expect(entries[0].isDirectory).toBe(true);
    });

    it('should return empty array for an empty directory', async () => {
      const emptyDir = path.join(testDir, 'empty');
      await fs.mkdir(emptyDir);

      const entries = await provider.list(emptyDir);
      expect(entries).toEqual([]);
    });

    it('keeps metadata and directories-first ordering when listing more entries than the stat concurrency limit', async () => {
      const count = 200;
      // Written in parallel: 200 sequential writes took over the 5 s default on a Windows CI runner (Defender scans each one).
      await Promise.all(
        Array.from({ length: count }, (_, i) =>
          fs.writeFile(path.join(testDir, `file-${String(i).padStart(3, '0')}.txt`), 'x'.repeat(i))
        )
      );
      await fs.mkdir(path.join(testDir, 'zdir'));

      const entries = await provider.list(testDir);

      expect(entries).toHaveLength(count + 1);
      expect(entries[0]).toMatchObject({ name: 'zdir', isDirectory: true });
      expect(entries.slice(1).map((e) => e.name)).toEqual(
        Array.from({ length: count }, (_, i) => `file-${String(i).padStart(3, '0')}.txt`)
      );
      for (const entry of entries.slice(1)) {
        expect(entry.size).toBe(Number(entry.name.slice(5, 8)));
        expect(entry.mtimeMs).toBeGreaterThan(0);
      }
    }, 30_000);

    // Regression tests for the H6 finding (code review): TransferPipeline's
    // directory scan decides whether to recurse using isDirectory, which
    // comes from a followed stat() — indistinguishable from a real
    // directory unless isSymlink is also reported. Without it, a symlinked
    // directory inside a source tree gets recursed into like a real one,
    // which can escape the intended source tree or spin forever on a cycle.
    it.skipIf(process.platform === 'win32')(
      'flags a symlinked directory as isDirectory + isSymlink, not a plain directory',
      async () => {
        const realDir = path.join(testDir, 'real-dir');
        await fs.mkdir(realDir);
        const linkPath = path.join(testDir, 'link-to-dir');
        await fs.symlink(realDir, linkPath, 'dir');

        const entries = await provider.list(testDir);
        const linkEntry = entries.find((e) => e.name === 'link-to-dir');

        expect(linkEntry).toBeDefined();
        expect(linkEntry?.isDirectory).toBe(true);
        expect(linkEntry?.isSymlink).toBe(true);
      }
    );

    it.skipIf(process.platform === 'win32')(
      'flags a symlinked file as isSymlink, and a regular file as isSymlink: false',
      async () => {
        const realFile = path.join(testDir, 'real-file.txt');
        await fs.writeFile(realFile, 'content', 'utf-8');
        const linkPath = path.join(testDir, 'link-to-file.txt');
        await fs.symlink(realFile, linkPath, 'file');

        const entries = await provider.list(testDir);
        const linkEntry = entries.find((e) => e.name === 'link-to-file.txt');
        const realEntry = entries.find((e) => e.name === 'real-file.txt');

        expect(linkEntry?.isSymlink).toBe(true);
        expect(realEntry?.isSymlink).toBe(false);
      }
    );
  });

  describe('rename', () => {
    it('should rename an existing file', async () => {
      const oldFile = path.join(testDir, 'old-name.txt');
      const newFile = path.join(testDir, 'new-name.txt');
      await fs.writeFile(oldFile, 'rename me', 'utf-8');

      await provider.rename(oldFile, newFile);

      await expect(fs.access(oldFile)).rejects.toThrow();
      const content = await fs.readFile(newFile, 'utf-8');
      expect(content).toBe('rename me');
    });

    it('should move/rename a directory', async () => {
      const oldDir = path.join(testDir, 'old-dir');
      const newDir = path.join(testDir, 'new-dir');
      await fs.mkdir(oldDir);
      await fs.writeFile(path.join(oldDir, 'inner.txt'), 'inside dir', 'utf-8');

      await provider.rename(oldDir, newDir);

      await expect(fs.access(oldDir)).rejects.toThrow();
      const content = await fs.readFile(path.join(newDir, 'inner.txt'), 'utf-8');
      expect(content).toBe('inside dir');
    });
  });

  describe('delete', () => {
    it('should delete a file when isDirectory is false', async () => {
      const filePath = path.join(testDir, 'to-delete.txt');
      await fs.writeFile(filePath, 'delete this', 'utf-8');

      await provider.delete(filePath, false);

      await expect(fs.access(filePath)).rejects.toThrow();
    });

    it('should delete a directory and its contents when isDirectory is true', async () => {
      const folderPath = path.join(testDir, 'folder-to-delete');
      await fs.mkdir(folderPath);
      await fs.writeFile(path.join(folderPath, 'file.txt'), 'nested file', 'utf-8');

      await provider.delete(folderPath, true);

      await expect(fs.access(folderPath)).rejects.toThrow();
    });

    it('should delete a broken symlink with isDirectory=false', async () => {
      const targetPath = path.join(testDir, 'non-existent-target.txt');
      const symlinkPath = path.join(testDir, 'broken-symlink.txt');
      await fs.symlink(targetPath, symlinkPath);

      // Verify symlink was created and target is missing
      const lstatBefore = await fs.lstat(symlinkPath);
      expect(lstatBefore.isSymbolicLink()).toBe(true);
      await expect(fs.stat(symlinkPath)).rejects.toThrow();

      // Deleting should succeed using lstat
      await provider.delete(symlinkPath, false);
      await expect(fs.lstat(symlinkPath)).rejects.toThrow();
    });

    it('should prevent deleting root directory or basePath', async () => {
      const rootDir = path.parse(testDir).root;
      await expect(provider.delete(rootDir, true)).rejects.toThrow(/Cannot delete root directory/);

      const scopedProvider = new LocalStorageProvider({ basePath: testDir });
      await expect(scopedProvider.delete(testDir, true)).rejects.toThrow(/Cannot delete root directory/);
      await expect(scopedProvider.delete('', true)).rejects.toThrow(/Cannot delete root directory/);
    });
  });

  // Regression tests for the H2 finding (code review): resolvePath() used to
  // honor an absolute path or a "../"-walked relative path unconditionally,
  // ignoring basePath entirely once resolution completed. Every read/write/
  // list/delete method goes through resolvePath(), so this is the one place
  // that must actually enforce basePath as a sandbox boundary, not just a
  // default prefix for relative input.
  describe('sandboxing to basePath (H2)', () => {
    it('rejects a relative path whose ".." segments walk outside basePath', () => {
      const scoped = new LocalStorageProvider({ basePath: testDir });
      expect(() => scoped.resolvePath('../../../etc/passwd')).toThrow(/outside the allowed base directory/);
    });

    it('rejects an absolute path elsewhere on disk when basePath is set', () => {
      const scoped = new LocalStorageProvider({ basePath: testDir });
      const elsewhere = path.join(os.tmpdir(), 'definitely-outside');
      expect(() => scoped.resolvePath(elsewhere)).toThrow(/outside the allowed base directory/);
    });

    it('still resolves a legitimate relative path inside basePath', () => {
      const scoped = new LocalStorageProvider({ basePath: testDir });
      expect(scoped.resolvePath('sub/file.txt')).toBe(path.join(testDir, 'sub', 'file.txt'));
    });

    it('does not sandbox when no basePath is configured (default "browse this computer" mode)', () => {
      const unscoped = new LocalStorageProvider();
      const elsewhere = path.join(os.tmpdir(), 'anywhere-is-fine');
      expect(unscoped.resolvePath(elsewhere)).toBe(path.normalize(elsewhere));
    });

    it('propagates the sandbox violation through delete/list/stat, not just resolvePath directly', async () => {
      const scoped = new LocalStorageProvider({ basePath: testDir });
      await expect(scoped.delete('../outside.txt', false)).rejects.toThrow(/outside the allowed base directory/);
      await expect(scoped.list('../')).rejects.toThrow(/outside the allowed base directory/);
      await expect(scoped.stat('../../etc/passwd')).rejects.toThrow(/outside the allowed base directory/);
    });
  });

  describe('error handling', () => {
    it('should throw error when calling stat on non-existent file', async () => {
      const nonExistent = path.join(testDir, 'ghost-file.txt');
      await expect(provider.stat(nonExistent)).rejects.toThrow();
    });

    it('should throw error when listing non-existent directory', async () => {
      const nonExistent = path.join(testDir, 'ghost-dir');
      await expect(provider.list(nonExistent)).rejects.toThrow();
    });

    it('should throw error when listing a regular file instead of directory', async () => {
      const filePath = path.join(testDir, 'not-a-dir.txt');
      await fs.writeFile(filePath, 'text', 'utf-8');
      await expect(provider.list(filePath)).rejects.toThrow();
    });

    it('should throw error when reading non-existent file', async () => {
      const nonExistent = path.join(testDir, 'ghost-read.txt');
      await expect(provider.createReadStream(nonExistent)).rejects.toThrow();
    });

    it('should throw error when reading a directory as stream', async () => {
      const dirPath = path.join(testDir, 'read-dir');
      await fs.mkdir(dirPath);
      await expect(provider.createReadStream(dirPath)).rejects.toThrow();
    });

    it('should throw error when deleting non-existent path', async () => {
      const nonExistent = path.join(testDir, 'ghost-delete.txt');
      await expect(provider.delete(nonExistent, false)).rejects.toThrow();
      await expect(provider.delete(nonExistent, true)).rejects.toThrow();
    });

    it('should throw error when deleting directory with isDirectory=false', async () => {
      const dirPath = path.join(testDir, 'dir-as-file');
      await fs.mkdir(dirPath);
      await expect(provider.delete(dirPath, false)).rejects.toThrow();
    });

    it('should throw error when deleting file with isDirectory=true', async () => {
      const filePath = path.join(testDir, 'file-as-dir.txt');
      await fs.writeFile(filePath, 'not a dir', 'utf-8');
      await expect(provider.delete(filePath, true)).rejects.toThrow();
    });

    it('should throw error when renaming non-existent source', async () => {
      const nonExistent = path.join(testDir, 'ghost-rename.txt');
      const destination = path.join(testDir, 'dest.txt');
      await expect(provider.rename(nonExistent, destination)).rejects.toThrow();
    });
  });

  describe('chmod', () => {
    it.skipIf(process.platform === 'win32')('should change mode on existing file', async () => {
      const filePath = path.join(testDir, 'chmod-test.txt');
      await fs.writeFile(filePath, 'hello');
      await provider.chmod(filePath, '600');

      const stat = await fs.stat(filePath);
      expect((stat.mode & 0o777).toString(8)).toBe('600');
    });

    it.skipIf(process.platform === 'win32')('should change mode on directory', async () => {
      const dirPath = path.join(testDir, 'chmod-dir');
      await fs.mkdir(dirPath);
      await provider.chmod(dirPath, 0o700);

      const stat = await fs.stat(dirPath);
      expect((stat.mode & 0o777).toString(8)).toBe('700');
    });

    it('should reject invalid mode string', async () => {
      const filePath = path.join(testDir, 'test.txt');
      await fs.writeFile(filePath, 'test');
      await expect(provider.chmod(filePath, 'invalid')).rejects.toThrow(/Invalid chmod mode/);
    });
  });

  describe('getHomeDir', () => {
    it('returns os.homedir()', async () => {
      expect(await provider.getHomeDir()).toBe(os.homedir());
    });
  });

  describe('disk space', () => {
    it('getSpace reports total and free bytes for a directory', async () => {
      const space = await provider.getSpace(testDir);
      expect(space).toBeDefined();
      expect(space!.totalBytes).toBeGreaterThan(0);
      expect(space!.freeBytes).toBeGreaterThanOrEqual(0);
      expect(space!.freeBytes).toBeLessThanOrEqual(space!.totalBytes);
    });

    it('getSpace returns undefined for a missing path', async () => {
      expect(await provider.getSpace(path.join(testDir, 'nope'))).toBeUndefined();
    });

    it('listVolumes returns at least one volume with sane numbers', async () => {
      const volumes = await provider.listVolumes();
      expect(volumes.length).toBeGreaterThan(0);
      for (const v of volumes) {
        expect(v.path).toBeTruthy();
        expect(v.totalBytes).toBeGreaterThan(0);
        expect(v.freeBytes).toBeLessThanOrEqual(v.totalBytes);
      }
      if (process.platform === 'win32') {
        expect(volumes.every((v) => /^[A-Z]:\\$/.test(v.path))).toBe(true);
      } else {
        expect(volumes.some((v) => v.path === '/')).toBe(true);
      }
    });
  });

  describe('disconnect', () => {
    it('should gracefully resolve disconnect', async () => {
      await expect(provider.disconnect()).resolves.toBeUndefined();
    });
  });
});
