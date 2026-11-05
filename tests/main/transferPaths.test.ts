import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { isSamePathOnProvider, isSameFileOnProvider } from '../../src/main/transfer/transferPaths';

describe('isSamePathOnProvider', () => {
  it('detects the same posix path despite trailing slash, dot segments and doubled slashes', () => {
    expect(isSamePathOnProvider('sftp', '/data/a.txt', '/data/a.txt')).toBe(true);
    expect(isSamePathOnProvider('sftp', '/data/a.txt', '/data//./a.txt')).toBe(true);
    expect(isSamePathOnProvider('sftp', '/data/dir', '/data/dir/')).toBe(true);
    expect(isSamePathOnProvider('s3', 'bucket/key.txt', 'bucket/key.txt')).toBe(true);
  });

  it('treats different names, parents and case on posix providers as different', () => {
    expect(isSamePathOnProvider('sftp', '/data/a.txt', '/data/b.txt')).toBe(false);
    expect(isSamePathOnProvider('sftp', '/data/a.txt', '/other/a.txt')).toBe(false);
    expect(isSamePathOnProvider('s3', 'bucket/Key.txt', 'bucket/key.txt')).toBe(false);
  });

  it('resolves local paths', () => {
    expect(isSamePathOnProvider('local', '/tmp/x/../a.txt', '/tmp/a.txt')).toBe(true);
    expect(isSamePathOnProvider('local', '/tmp/a.txt', '/tmp/b.txt')).toBe(false);
  });
});

// Code review of the unpushed commits: a string comparison cannot see a hard link, a symlink or (on macOS) a differently-cased name.
describe('isSameFileOnProvider', () => {
  async function withTemp(fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'samefile-'));
    try {
      await fn(dir);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  }

  it('recognises a hard link to the source as the same file', async () => {
    await withTemp(async (dir) => {
      await fsp.writeFile(path.join(dir, 'a.txt'), 'x');
      await fsp.link(path.join(dir, 'a.txt'), path.join(dir, 'b.txt'));
      expect(isSamePathOnProvider('local', path.join(dir, 'a.txt'), path.join(dir, 'b.txt'))).toBe(false); // the string check misses it
      expect(await isSameFileOnProvider('local', path.join(dir, 'a.txt'), path.join(dir, 'b.txt'))).toBe(true);
    });
  });

  it.skipIf(process.platform === 'win32')('recognises a symlink to the source as the same file', async () => {
    await withTemp(async (dir) => {
      await fsp.writeFile(path.join(dir, 'a.txt'), 'x');
      await fsp.symlink(path.join(dir, 'a.txt'), path.join(dir, 'link.txt'));
      expect(await isSameFileOnProvider('local', path.join(dir, 'a.txt'), path.join(dir, 'link.txt'))).toBe(true);
    });
  });

  it('treats different files, and a target that does not exist yet, as different', async () => {
    await withTemp(async (dir) => {
      await fsp.writeFile(path.join(dir, 'a.txt'), 'x');
      await fsp.writeFile(path.join(dir, 'b.txt'), 'x');
      expect(await isSameFileOnProvider('local', path.join(dir, 'a.txt'), path.join(dir, 'b.txt'))).toBe(false);
      expect(await isSameFileOnProvider('local', path.join(dir, 'a.txt'), path.join(dir, 'new.txt'))).toBe(false);
    });
  });

  // Code review: a provider with a base path resolves relative paths against it, not against the process's cwd.
  it('uses the resolver to find the real files', async () => {
    await withTemp(async (dir) => {
      await fsp.writeFile(path.join(dir, 'a.txt'), 'x');
      await fsp.link(path.join(dir, 'a.txt'), path.join(dir, 'b.txt'));
      const resolve = (p: string): string => path.join(dir, p);
      expect(await isSameFileOnProvider('local', 'a.txt', 'b.txt')).toBe(false); // relative to cwd: nothing there
      expect(await isSameFileOnProvider('local', 'a.txt', 'b.txt', resolve)).toBe(true);
    });
  });

  it('keeps the string rules for remote providers', async () => {
    expect(await isSameFileOnProvider('sftp', '/data/a.txt', '/data//a.txt')).toBe(true);
    expect(await isSameFileOnProvider('s3', 'bucket/Key.txt', 'bucket/key.txt')).toBe(false);
  });
});
