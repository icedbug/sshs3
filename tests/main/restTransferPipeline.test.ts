import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { Readable } from 'node:stream';
import { LocalStorageProvider } from '../../src/main/storage/LocalStorageProvider';
import { transferFile, transferDirectory, tempSiblingPath } from '../../src/main/transfer/TransferPipeline';
import type { IStorageProvider, TransferProgress } from '../../src/shared/types/storage';

let base: string;
let srcDir: string;
let dstDir: string;
let src: LocalStorageProvider;
let dst: LocalStorageProvider;

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'rest-transfer-'));
  srcDir = path.join(base, 'src');
  dstDir = path.join(base, 'dst');
  await fs.mkdir(srcDir);
  await fs.mkdir(dstDir);
  src = new LocalStorageProvider({ basePath: srcDir });
  dst = new LocalStorageProvider({ basePath: dstDir });
});

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

/** A source whose stream sends some bytes and then fails, like a dropped connection. */
function failingSource(declaredSize: number): IStorageProvider {
  return {
    id: 'failing',
    name: 'Failing',
    type: 'sftp',
    stat: vi.fn().mockResolvedValue({ name: 'data.txt', path: '/data.txt', size: declaredSize, isDirectory: false }),
    createReadStream: vi.fn().mockImplementation(async () => {
      let sent = false;
      return new Readable({
        read() {
          if (!sent) {
            sent = true;
            this.push(Buffer.from('partial new'));
          } else {
            this.destroy(Object.assign(new Error('Permission denied by server'), { code: 'EACCES' }));
          }
        },
      });
    }),
  } as unknown as IStorageProvider;
}

async function leftovers(): Promise<string[]> {
  return (await fs.readdir(dstDir)).filter((n) => n.includes('.sshs3-part-'));
}

describe('overwrite keeps the original file when the transfer fails', () => {
  it('leaves the existing target untouched when the source fails mid-copy', async () => {
    await fs.writeFile(path.join(dstDir, 'data.txt'), 'original content');

    await expect(
      transferFile({ sourceProvider: failingSource(1000), sourcePath: '/data.txt', targetProvider: dst, targetPath: 'data.txt', maxRetries: 0 })
    ).rejects.toThrow('Permission denied by server');

    expect(await fs.readFile(path.join(dstDir, 'data.txt'), 'utf8')).toBe('original content');
    expect(await leftovers()).toEqual([]);
  });

  it('leaves the existing target untouched when the copy fails its integrity check', async () => {
    await fs.writeFile(path.join(dstDir, 'data.txt'), 'original content');
    await fs.writeFile(path.join(srcDir, 'data.txt'), 'new');

    await expect(
      // A declared size that does not match what arrives: the copy is incomplete.
      transferFile({ sourceProvider: src, sourcePath: 'data.txt', targetProvider: dst, targetPath: 'data.txt', totalBytes: 50 })
    ).rejects.toThrow(/incomplete/);

    expect(await fs.readFile(path.join(dstDir, 'data.txt'), 'utf8')).toBe('original content');
    expect(await leftovers()).toEqual([]);
  });

  it('replaces the target on success, keeps its permissions and leaves no temporary file', async () => {
    const target = path.join(dstDir, 'run.sh');
    await fs.writeFile(target, 'old');
    await fs.chmod(target, 0o750);
    await fs.writeFile(path.join(srcDir, 'run.sh'), 'new script body');

    await transferFile({ sourceProvider: src, sourcePath: 'run.sh', targetProvider: dst, targetPath: 'run.sh', verifyChecksum: true });

    expect(await fs.readFile(target, 'utf8')).toBe('new script body');
    if (process.platform !== 'win32') expect((await fs.stat(target)).mode & 0o777).toBe(0o750);
    expect(await leftovers()).toEqual([]);
  });

  it('writes a new file straight to its final name', async () => {
    await fs.writeFile(path.join(srcDir, 'fresh.txt'), 'hello');
    const spy = vi.spyOn(dst, 'createWriteStream');
    await transferFile({ sourceProvider: src, sourcePath: 'fresh.txt', targetProvider: dst, targetPath: 'fresh.txt' });
    expect(spy).toHaveBeenCalledWith('fresh.txt', expect.anything());
    expect(await fs.readFile(path.join(dstDir, 'fresh.txt'), 'utf8')).toBe('hello');
  });

  it('keeps writing S3 objects directly (an S3 upload only replaces the object when it completes)', async () => {
    await fs.writeFile(path.join(srcDir, 'obj.txt'), 'body');
    const written: string[] = [];
    const s3: IStorageProvider = {
      id: 's3',
      name: 'S3',
      type: 's3',
      stat: vi.fn().mockResolvedValue({ name: 'obj.txt', path: '/b/obj.txt', size: 4, isDirectory: false }),
      rename: vi.fn(),
      createWriteStream: vi.fn().mockImplementation(async (p: string) => {
        written.push(p);
        const { PassThrough } = await import('node:stream');
        const s = new PassThrough();
        s.resume();
        return s;
      }),
    } as unknown as IStorageProvider;

    await transferFile({ sourceProvider: src, sourcePath: 'obj.txt', targetProvider: s3, targetPath: '/b/obj.txt' });
    expect(written).toEqual(['/b/obj.txt']);
    expect(s3.rename).not.toHaveBeenCalled();
  });

  it('names the temporary file as a hidden sibling in the same folder', () => {
    expect(tempSiblingPath('sftp', '/home/u/report.pdf')).toMatch(/^\/home\/u\/\.report\.pdf\.sshs3-part-[0-9a-f]{12}$/);
    expect(tempSiblingPath('sftp', 'report.pdf')).toMatch(/^\.report\.pdf\.sshs3-part-[0-9a-f]{12}$/);
  });
});

describe.skipIf(process.platform === 'win32')('folder transfers and symbolic links', () => {
  it('copies links to files, skips links to folders and broken links, and says how many were skipped', async () => {
    const outside = path.join(base, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'secret-dir-file.txt'), 'must not be copied');
    await fs.writeFile(path.join(base, 'linked-target.txt'), 'linked file content');

    const tree = path.join(srcDir, 'tree');
    await fs.mkdir(tree);
    await fs.writeFile(path.join(tree, 'real.txt'), 'real');
    await fs.symlink(path.join(base, 'linked-target.txt'), path.join(tree, 'file-link.txt'));
    await fs.symlink(outside, path.join(tree, 'dir-link'));
    await fs.symlink(path.join(base, 'missing.txt'), path.join(tree, 'broken-link.txt'));

    const events: TransferProgress[] = [];
    await transferDirectory({
      sourceProvider: src,
      sourcePath: 'tree',
      targetProvider: dst,
      targetPath: 'tree',
      onProgress: (p) => events.push(p),
    });

    const out = path.join(dstDir, 'tree');
    expect(await fs.readFile(path.join(out, 'real.txt'), 'utf8')).toBe('real');
    expect(await fs.readFile(path.join(out, 'file-link.txt'), 'utf8')).toBe('linked file content');
    expect((await fs.lstat(path.join(out, 'file-link.txt'))).isSymbolicLink()).toBe(false);
    await expect(fs.lstat(path.join(out, 'dir-link'))).rejects.toThrow();
    await expect(fs.lstat(path.join(out, 'broken-link.txt'))).rejects.toThrow();

    const last = events.at(-1)!;
    expect(last.status).toBe('completed');
    expect(last.statusMessage).toMatch(/^Done — 2 symbolic links skipped/);
  });

  it('still says plain "Done" when nothing was skipped', async () => {
    await fs.mkdir(path.join(srcDir, 'plain'));
    await fs.writeFile(path.join(srcDir, 'plain', 'a.txt'), 'a');
    const events: TransferProgress[] = [];
    await transferDirectory({ sourceProvider: src, sourcePath: 'plain', targetProvider: dst, targetPath: 'plain', onProgress: (p) => events.push(p) });
    expect(events.at(-1)!.statusMessage).toBe('Done');
  });
});
