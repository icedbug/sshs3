import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { backupCorruptFile, writeFileAtomic } from '../../src/main/storage/atomicFile';

describe('writeFileAtomic', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-file-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('creates the file and its parent folders and leaves no temp file behind', async () => {
    const file = path.join(dir, 'a', 'b', 'config.json');
    await writeFileAtomic(file, '{"x":1}');
    expect(await fs.readFile(file, 'utf-8')).toBe('{"x":1}');
    expect(await fs.readdir(path.dirname(file))).toEqual(['config.json']);
  });

  it('replaces existing content', async () => {
    const file = path.join(dir, 'config.json');
    await fs.writeFile(file, 'old old old old');
    await writeFileAtomic(file, 'new');
    expect(await fs.readFile(file, 'utf-8')).toBe('new');
  });

  it.skipIf(process.platform === 'win32')('uses mode 0600 for a new file, an explicit mode when given, and keeps an existing mode otherwise', async () => {
    const fresh = path.join(dir, 'fresh');
    await writeFileAtomic(fresh, 'x');
    expect((await fs.stat(fresh)).mode & 0o777).toBe(0o600);

    const explicit = path.join(dir, 'explicit');
    await writeFileAtomic(explicit, 'x', { mode: 0o640 });
    expect((await fs.stat(explicit)).mode & 0o777).toBe(0o640);

    const kept = path.join(dir, 'kept');
    await fs.writeFile(kept, 'old', { mode: 0o644 });
    await fs.chmod(kept, 0o644);
    await writeFileAtomic(kept, 'new');
    expect((await fs.stat(kept)).mode & 0o777).toBe(0o644);
  });

  it.skipIf(process.platform === 'win32')('writes through a symlink and leaves the link in place', async () => {
    const real = path.join(dir, 'dotfiles-repo-config');
    const link = path.join(dir, 'config');
    await fs.writeFile(real, 'old');
    await fs.symlink(real, link);

    await writeFileAtomic(link, 'new');

    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(real, 'utf-8')).toBe('new');
  });

  it('keeps the old file and removes the temp file when the rename fails', async () => {
    // A non-empty folder at the target path cannot be replaced by a file.
    const target = path.join(dir, 'target');
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'keep.txt'), 'keep');

    await expect(writeFileAtomic(target, 'data')).rejects.toThrow();

    expect(await fs.readFile(path.join(target, 'keep.txt'), 'utf-8')).toBe('keep');
    expect((await fs.readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('replaces the file by rename instead of rewriting it in place', async () => {
    // A reader that already has the old file open must keep seeing the complete old content. An in-place
    // rewrite (plain writeFile) truncates that same file first, which is how readers saw half-written config.
    const file = path.join(dir, 'config.json');
    await fs.writeFile(file, 'old content that is long enough');
    const openOld = await fs.open(file, 'r');
    try {
      await writeFileAtomic(file, 'new');
      expect(await openOld.readFile('utf-8')).toBe('old content that is long enough');
      expect(await fs.readFile(file, 'utf-8')).toBe('new');
    } finally {
      await openOld.close();
    }
  });

  it('never lets a reader see a truncated or mixed file while many writers run', async () => {
    const file = path.join(dir, 'busy.json');
    const payload = (n: number) => JSON.stringify({ n, pad: 'x'.repeat(1_000_000) });
    await writeFileAtomic(file, payload(0));

    let stop = false;
    const bad: string[] = [];
    const reader = (async () => {
      while (!stop) {
        let text: string;
        try {
          text = await fs.readFile(file, 'utf-8');
        } catch (err) {
          // Windows replaces a file in two steps, so a read can land in the gap; POSIX rename never shows a missing file.
          if (process.platform === 'win32' && (err as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw err;
        }
        try {
          JSON.parse(text);
        } catch {
          bad.push(text.slice(0, 40));
        }
      }
    })();

    if (process.platform === 'win32') {
      // Windows refuses a rename onto a file another rename is replacing (EPERM). The app's stores serialise their writes, so
      // concurrent writers to one file do not happen there; the reader still runs against each write.
      for (let i = 0; i < 40; i++) await writeFileAtomic(file, payload(i + 1));
    } else {
      await Promise.all(Array.from({ length: 40 }, (_, i) => writeFileAtomic(file, payload(i + 1))));
    }
    stop = true;
    await reader;

    expect(bad).toEqual([]);
    expect(JSON.parse(await fs.readFile(file, 'utf-8')).n).toBeGreaterThan(0);
  });
});

describe('backupCorruptFile', () => {
  it('keeps the unparsable text next to the file and never throws', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-file-'));
    try {
      const file = path.join(dir, 'settings.json');
      await backupCorruptFile(file, '{"half": ');
      expect(await fs.readFile(`${file}.corrupt`, 'utf-8')).toBe('{"half": ');
      await expect(backupCorruptFile(path.join(dir, 'no', 'such', 'x'), 'y')).resolves.toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
