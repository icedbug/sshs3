import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compressEntries, extractArchive } from '../../src/main/archive/ArchiveService';
import { LocalStorageProvider } from '../../src/main/storage/LocalStorageProvider';

// Real tar/zip/unzip against a temp dir; skipped on hosts without the zip tools (e.g. a bare Linux CI image).
const hasTools = ['tar', 'zip', 'unzip'].every((bin) =>
  (process.env.PATH ?? '').split(path.delimiter).some((dir) => fs.existsSync(path.join(dir, bin)))
);

describe.skipIf(!hasTools || process.platform === 'win32')('ArchiveService (local)', () => {
  let dir: string;
  let provider: LocalStorageProvider;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshs3-archive-'));
    fs.mkdirSync(path.join(dir, 'docs'));
    fs.writeFileSync(path.join(dir, 'docs', 'a.txt'), 'alpha');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'beta');
    provider = new LocalStorageProvider({ id: 'local' });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each(['tar.gz', 'zip'] as const)('round-trips a folder and a file as %s', async (format) => {
    const archive = await compressEntries(provider, dir, ['docs', 'b.txt'], format);
    expect(archive).toBe(`archive.${format}`);

    fs.rmSync(path.join(dir, 'docs'), { recursive: true });
    fs.rmSync(path.join(dir, 'b.txt'));

    const folder = await extractArchive(provider, path.join(dir, archive));
    expect(folder).toBe('archive');
    expect(fs.readFileSync(path.join(dir, 'archive', 'docs', 'a.txt'), 'utf8')).toBe('alpha');
    expect(fs.readFileSync(path.join(dir, 'archive', 'b.txt'), 'utf8')).toBe('beta');
  });

  it('names a single entry after itself and never overwrites an existing archive', async () => {
    expect(await compressEntries(provider, dir, ['docs'], 'tar.gz')).toBe('docs.tar.gz');
    expect(await compressEntries(provider, dir, ['docs'], 'tar.gz')).toBe('docs (1).tar.gz');
  });

  it('extracts into a fresh folder when the name is taken', async () => {
    // b.txt.zip unpacks into "b.txt", which is the original file's name.
    const archive = await compressEntries(provider, dir, ['b.txt'], 'zip');
    expect(await extractArchive(provider, path.join(dir, archive))).toBe('b.txt (1)');
    expect(await extractArchive(provider, path.join(dir, archive))).toBe('b.txt (2)');
  });

  it('removes the empty folder and the partial archive when a command fails', async () => {
    fs.writeFileSync(path.join(dir, 'bad.tar.gz'), 'not an archive');
    await expect(extractArchive(provider, path.join(dir, 'bad.tar.gz'))).rejects.toThrow();
    expect(fs.existsSync(path.join(dir, 'bad'))).toBe(false);

    const locked = path.join(dir, 'locked.txt');
    fs.writeFileSync(locked, 'secret');
    fs.chmodSync(locked, 0o000);
    try {
      // Running as root can read it anyway, in which case there is nothing to clean up.
      await compressEntries(provider, dir, ['locked.txt'], 'tar.gz').then(
        () => undefined,
        () => expect(fs.existsSync(path.join(dir, 'locked.txt.tar.gz'))).toBe(false)
      );
    } finally {
      fs.chmodSync(locked, 0o600);
    }
  });

  it('rejects names that escape the directory and files that are not archives', async () => {
    await expect(compressEntries(provider, dir, ['../x'], 'zip')).rejects.toThrow('Invalid file names');
    await expect(compressEntries(provider, dir, ['a\\b'], 'zip')).rejects.toThrow('Invalid file names');
    await expect(extractArchive(provider, path.join(dir, 'b.txt'))).rejects.toThrow('Not a supported archive');
  });
});
