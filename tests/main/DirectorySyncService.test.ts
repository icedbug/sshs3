import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';

const { transferFileMock } = vi.hoisted(() => ({ transferFileMock: vi.fn() }));
// Only the copy itself is replaced; joinPaths and getBaseName stay real, since they decide where things land.
vi.mock('../../src/main/transfer/TransferPipeline', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/transfer/TransferPipeline')>()),
  transferFile: transferFileMock,
}));

import { apply, buildTree, computeDiff } from '../../src/main/dirsync/DirectorySyncService';
import type { FileEntry, StorageType } from '../../src/shared/types/storage';
import type { DirectoryDiffEntry } from '../../src/shared/types/dirsync';

type Node = FileEntry[] | Error;

/** A fake provider whose directory listings are given as path -> entries (or an Error to throw). */
function fakeProvider(tree: Record<string, Node>) {
  return {
    type: 'local',
    list: async (p: string) => {
      const node = tree[p];
      if (node instanceof Error) throw node;
      if (!node) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      return node;
    },
  } as any;
}

const file = (dir: string, name: string): FileEntry =>
  ({ name, path: `${dir}/${name}`, isDirectory: false, size: 1, modifiedTime: 1 }) as any;
const dir = (parent: string, name: string, extra: Partial<FileEntry> = {}): FileEntry =>
  ({ name, path: `${parent}/${name}`, isDirectory: true, size: 0, modifiedTime: 1, ...extra }) as any;

describe('DirectorySyncService', () => {
  it('treats a missing root as empty', async () => {
    const tree = await buildTree(fakeProvider({}), '/missing');
    expect(tree.size).toBe(0);
  });

  it('treats an SFTP "no such file" status on the root as empty', async () => {
    const err = Object.assign(new Error('No such file'), { name: 'SftpError', statusCode: 2 });
    const tree = await buildTree(fakeProvider({ '/new': err }), '/new');
    expect(tree.size).toBe(0);
  });

  it('still rethrows other SFTP statuses on the root', async () => {
    const err = Object.assign(new Error('Permission denied'), { name: 'SftpError', statusCode: 3 });
    await expect(buildTree(fakeProvider({ '/src': err }), '/src')).rejects.toThrow('Permission denied');
  });

  it('rethrows a non-"not found" failure listing the root instead of treating it as empty', async () => {
    const provider = fakeProvider({ '/src': new Error('Connection lost') });
    await expect(buildTree(provider, '/src')).rejects.toThrow('Connection lost');
  });

  it('leaves special files (FIFOs, sockets, devices) out of the tree, so they are never offered for copying (M7)', async () => {
    const provider = fakeProvider({
      '/src': [file('/src', 'a.txt'), { ...file('/src', 'pipe'), isSpecial: true } as FileEntry],
    });
    const tree = await buildTree(provider, '/src');
    expect([...tree.keys()]).toEqual(['a.txt']);
  });

  it('does not follow symlinked directories', async () => {
    const provider = fakeProvider({
      '/src': [dir('/src', 'loop', { isSymlink: true }), file('/src', 'a.txt')],
      '/src/loop': [file('/src/loop', 'inner.txt')],
    });
    const symlinks: string[] = [];
    const tree = await buildTree(provider, '/src', undefined, { count: 0 }, [], symlinks);
    expect([...tree.keys()].sort()).toEqual(['a.txt']);
    expect(symlinks).toEqual(['loop']);
  });

  it('reports a symlinked directory as skipped so nothing below it is copied or deleted', async () => {
    const source = fakeProvider({
      '/src': [dir('/src', 'link', { isSymlink: true })],
    });
    const target = fakeProvider({
      '/dst': [dir('/dst', 'link')],
      '/dst/link': [file('/dst/link', 'keep.txt')],
    });

    const diff = await computeDiff(source, '/src', target, '/dst');

    // A link is not "unreadable": it is left out on purpose and reported separately.
    expect(diff.skippedPaths.source).toEqual([]);
    expect(diff.skippedSymlinks.source).toEqual(['link']);
    expect(diff.entries.filter((e) => e.status === 'only-target')).toEqual([]);
  });

  // Decided with the user: like transfers, directory sync skips every symlink, on both sides. A link on the target
  // used to be written through (overwriting a file outside the target folder), and an SFTP link to a folder was
  // listed as a file and failed to copy.
  describe('symbolic links (decided with the user: skipped on both sides)', () => {
    const link = (parent: string, name: string): FileEntry =>
      ({ name, path: `${parent}/${name}`, isDirectory: false, isSymlink: true, size: 7, modifiedTime: 1 }) as any;

    it('does not offer a symlinked file on the source as new, and reports it', async () => {
      const source = fakeProvider({ '/src': [link('/src', 'current.log'), file('/src', 'real.txt')] });
      const target = fakeProvider({ '/dst': [] });

      const result = await computeDiff(source, '/src', target, '/dst');

      expect(result.entries.map((e) => e.relativePath)).toEqual(['real.txt']);
      expect(result.skippedSymlinks).toEqual({ source: ['current.log'], target: [] });
    });

    it('never writes through a symlink on the target: a real source folder of that name is not copied into it', async () => {
      const source = fakeProvider({
        '/src': [dir('/src', 'data')],
        '/src/data': [file('/src/data', 'a.txt')],
      });
      const target = fakeProvider({ '/dst': [{ ...dir('/dst', 'data'), isSymlink: true } as FileEntry] });

      const result = await computeDiff(source, '/src', target, '/dst');

      expect(result.entries).toEqual([]); // neither "data" nor "data/a.txt" is new
      expect(result.skippedSymlinks.target).toEqual(['data']);
    });

    it('does not mark a symlink that exists only on the target as extraneous', async () => {
      const source = fakeProvider({ '/src': [] });
      const target = fakeProvider({ '/dst': [link('/dst', 'shortcut')] });

      const result = await computeDiff(source, '/src', target, '/dst');

      expect(result.entries).toEqual([]);
      expect(result.counts.onlyTarget).toBe(0);
    });
  });

  it('does not report source entries below an unreadable target folder as new', async () => {
    const source = fakeProvider({
      '/src': [dir('/src', 'locked')],
      '/src/locked': [file('/src/locked', 'a.txt')],
    });
    const target = fakeProvider({
      '/dst': [dir('/dst', 'locked')],
      '/dst/locked': new Error('EACCES: permission denied'),
    });

    const diff = await computeDiff(source, '/src', target, '/dst');

    expect(diff.skippedPaths.target).toEqual(['locked']);
    expect(diff.entries.filter((e) => e.status === 'new')).toEqual([]);
  });

  it('does not report target entries below an unreadable source folder as only-target', async () => {
    const source = fakeProvider({
      '/src': [dir('/src', 'locked'), file('/src', 'a.txt')],
      '/src/locked': new Error('EACCES: permission denied'),
    });
    const target = fakeProvider({
      '/dst': [dir('/dst', 'locked'), file('/dst', 'a.txt'), file('/dst', 'extra.txt')],
      '/dst/locked': [file('/dst/locked', 'keep.txt')],
    });

    const diff = await computeDiff(source, '/src', target, '/dst');

    expect(diff.skippedPaths.source).toEqual(['locked']);
    const onlyTarget = diff.entries.filter((e) => e.status === 'only-target').map((e) => e.relativePath);
    expect(onlyTarget).toEqual(['extra.txt']);
  });
});

describe('buildTree with names chosen by a hostile server', () => {
  it('never lets a listed name leave the tree: the key is the last path segment, and . / .. are skipped', async () => {
    // A real provider normalises `path` (path.posix.join) but passes the server's `name` through untouched.
    const provider = fakeProvider({
      '/root': [
        file('/root', '../../evil.txt'),
        file('/root', 'a\\b\\win.txt'),
        file('/root', '..'),
        file('/root', '.'),
        file('/root', 'fine.txt'),
        dir('/root', 'nested/../sneaky', { path: '/root/sneaky' }),
      ],
      '/root/sneaky': [file('/root/sneaky', '../../../up.txt')],
    });

    const tree = await buildTree(provider, '/root');

    expect([...tree.keys()].sort()).toEqual(['evil.txt', 'fine.txt', 'sneaky', 'sneaky/up.txt', 'win.txt']);
    for (const key of tree.keys()) {
      expect(key.split('/')).not.toContain('..');
      expect(key.startsWith('/')).toBe(false);
    }
  });
});

describe('computeDiff: a file and a folder with the same name (H6)', () => {
  it('reports a source file against a target folder as a conflict, not as identical, and keeps the folder contents out of only-target', async () => {
    const source = fakeProvider({ '/src': [file('/src', 'build')] });
    const target = fakeProvider({
      '/dst': [dir('/dst', 'build')],
      '/dst/build': [file('/dst/build', 'x.txt')],
    });

    const result = await computeDiff(source, '/src', target, '/dst');

    expect(result.entries.map((e) => [e.relativePath, e.status])).toEqual([['build', 'conflict']]);
    expect(result.entries[0].sourceEntry?.isDirectory).toBe(false);
    expect(result.entries[0].targetEntry?.isDirectory).toBe(true);
    expect(result.counts).toEqual({ new: 0, changed: 0, onlyTarget: 0, same: 0, conflict: 1 });
  });

  it('reports a source folder against a target file as a conflict and does not offer its contents as new', async () => {
    const source = fakeProvider({
      '/src': [dir('/src', 'data')],
      '/src/data': [file('/src/data', 'y.txt')],
    });
    const target = fakeProvider({ '/dst': [file('/dst', 'data')] });

    const result = await computeDiff(source, '/src', target, '/dst');

    expect(result.entries.map((e) => [e.relativePath, e.status])).toEqual([['data', 'conflict']]);
    expect(result.counts.new).toBe(0);
  });

  it('still counts two folders with the same name as identical', async () => {
    const source = fakeProvider({ '/src': [dir('/src', 'same')], '/src/same': [] });
    const target = fakeProvider({ '/dst': [dir('/dst', 'same')], '/dst/same': [] });

    const result = await computeDiff(source, '/src', target, '/dst');

    expect(result.entries).toEqual([]);
    expect(result.counts).toMatchObject({ same: 1, conflict: 0 });
  });

  it('never copies or deletes anything for a conflict, even in mirror mode', async () => {
    transferFileMock.mockReset();
    const calls: string[] = [];
    const target = {
      type: 'sftp',
      createFolder: async (p: string) => void calls.push(`mkdir ${p}`),
      delete: async (p: string) => void calls.push(`rm ${p}`),
      setModifiedTime: async () => {},
    };
    const conflict: DirectoryDiffEntry = {
      relativePath: 'build',
      isDirectory: false,
      status: 'conflict',
      sourceEntry: { name: 'build', path: '/src/build', isDirectory: false, size: 1 } as FileEntry,
      targetEntry: { name: 'build', path: '/dst/build', isDirectory: true, size: 0 } as FileEntry,
    };

    const result = await apply([conflict], {} as never, target as never, '/dst', { deleteExtraneous: true });

    expect(result).toEqual({ copied: 0, deleted: 0, failed: 0, errors: [] });
    expect(transferFileMock).not.toHaveBeenCalled();
    expect(calls).toEqual(['mkdir /dst']);
  });
});

describe('apply', () => {
  const sourceTime = Date.UTC(2026, 9, 1, 12, 0, 0);

  /** A provider that records what apply() does to it. `fail` makes an operation on a path throw. */
  function recording(type: StorageType, fail: Partial<Record<'createFolder' | 'delete' | 'setModifiedTime', string[]>> = {}) {
    const calls = {
      createFolder: [] as string[],
      delete: [] as Array<{ path: string; isDirectory: boolean }>,
      setModifiedTime: [] as Array<{ path: string; mtimeMs: number }>,
    };
    const guard = (op: keyof typeof fail, target: string) => {
      if (fail[op]?.includes(target)) throw new Error(`${op} failed: ${target}`);
    };
    const provider = {
      type,
      calls,
      createFolder: async (p: string) => {
        calls.createFolder.push(p);
        guard('createFolder', p);
      },
      delete: async (p: string, isDirectory: boolean) => {
        calls.delete.push({ path: p, isDirectory });
        guard('delete', p);
      },
      setModifiedTime: async (p: string, mtimeMs: number) => {
        calls.setModifiedTime.push({ path: p, mtimeMs });
        guard('setModifiedTime', p);
      },
    };
    return provider;
  }
  const diff = (relativePath: string, status: DirectoryDiffEntry['status'], isDirectory = false, extra: Partial<DirectoryDiffEntry> = {}): DirectoryDiffEntry => ({
    relativePath,
    isDirectory,
    status,
    ...extra,
  });
  const srcEntry = (p: string, extra: Partial<FileEntry> = {}): FileEntry =>
    ({ name: path.posix.basename(p), path: p, isDirectory: false, size: 10, mtimeMs: sourceTime, ...extra }) as FileEntry;

  beforeEach(() => {
    transferFileMock.mockReset();
    transferFileMock.mockResolvedValue(undefined);
  });

  it('creates the sync root first and carries on when it already exists', async () => {
    const target = recording('sftp', { createFolder: ['/backup/proj'] });

    const result = await apply([], recording('sftp') as never, target as never, '/backup/proj', { deleteExtraneous: false });

    expect(target.calls.createFolder).toEqual(['/backup/proj']);
    expect(result).toEqual({ copied: 0, deleted: 0, failed: 0, errors: [] });
  });

  it('creates new folders shallowest first, before any file is copied into them', async () => {
    const target = recording('sftp');
    const order: string[] = [];
    target.createFolder = async (p: string) => {
      order.push(`mkdir ${p}`);
    };
    transferFileMock.mockImplementation(async (o: { targetPath: string }) => {
      order.push(`copy ${o.targetPath}`);
    });

    await apply(
      [
        diff('a/b/c.txt', 'new', false, { sourceEntry: srcEntry('/src/a/b/c.txt') }),
        diff('a/b', 'new', true),
        diff('a', 'new', true),
      ],
      recording('local') as never,
      target as never,
      '/dst',
      { deleteExtraneous: false }
    );

    expect(order).toEqual(['mkdir /dst', 'mkdir /dst/a', 'mkdir /dst/a/b', 'copy /dst/a/b/c.txt']);
  });

  it('copies new and changed files from the source entry path to target/relativePath and counts them', async () => {
    const onProgress = vi.fn();
    const source = recording('local');
    const target = recording('sftp');

    const result = await apply(
      [
        diff('new.txt', 'new', false, { sourceEntry: srcEntry('/src/new.txt', { size: 5 }) }),
        diff('sub/changed.txt', 'changed', false, { sourceEntry: srcEntry('/src/sub/changed.txt', { size: 9 }) }),
      ],
      source as never,
      target as never,
      '/dst',
      { deleteExtraneous: false },
      onProgress
    );

    expect(result).toMatchObject({ copied: 2, failed: 0, deleted: 0 });
    expect(transferFileMock).toHaveBeenCalledTimes(2);
    expect(transferFileMock.mock.calls[0][0]).toMatchObject({
      jobId: 'dirsync-apply',
      sourceProvider: source,
      sourcePath: '/src/new.txt',
      targetProvider: target,
      targetPath: '/dst/new.txt',
      totalBytes: 5,
      onProgress,
    });
    expect(transferFileMock.mock.calls[1][0]).toMatchObject({ sourcePath: '/src/sub/changed.txt', targetPath: '/dst/sub/changed.txt', totalBytes: 9 });
  });

  it('builds a local target path with the platform separator and an SFTP one with slashes', async () => {
    await apply([diff('x/y.txt', 'new', false, { sourceEntry: srcEntry('/src/x/y.txt') })], recording('sftp') as never, recording('local') as never, '/tmp/out', { deleteExtraneous: false });
    expect(transferFileMock.mock.calls[0][0].targetPath).toBe(path.join('/tmp/out', 'x/y.txt'));
  });

  it('keeps the source modification time on the target, so the next diff does not see every file as changed', async () => {
    const target = recording('sftp');

    await apply([diff('a.txt', 'new', false, { sourceEntry: srcEntry('/src/a.txt') })], recording('local') as never, target as never, '/dst', { deleteExtraneous: false });

    expect(target.calls.setModifiedTime).toEqual([{ path: '/dst/a.txt', mtimeMs: sourceTime }]);
  });

  it('does not count a copy as failed when the modification time cannot be set, or when there is none to set', async () => {
    const target = recording('s3', { setModifiedTime: ['/dst/a.txt'] });

    const result = await apply(
      [
        diff('a.txt', 'new', false, { sourceEntry: srcEntry('/src/a.txt') }),
        diff('b.txt', 'new', false, { sourceEntry: srcEntry('/src/b.txt', { mtimeMs: undefined }) }),
      ],
      recording('local') as never,
      target as never,
      '/dst',
      { deleteExtraneous: false }
    );

    expect(result).toMatchObject({ copied: 2, failed: 0 });
    expect(target.calls.setModifiedTime.map((c) => c.path)).toEqual(['/dst/a.txt']); // b.txt has no time
  });

  it('records a failed copy and a failed folder, and keeps going with the rest', async () => {
    const target = recording('sftp', { createFolder: ['/dst/bad-dir'] });
    transferFileMock.mockImplementation(async (o: { sourcePath: string }) => {
      if (o.sourcePath === '/src/boom.txt') throw new Error('disk full');
    });

    const result = await apply(
      [
        diff('bad-dir', 'new', true),
        diff('boom.txt', 'new', false, { sourceEntry: srcEntry('/src/boom.txt') }),
        diff('ok.txt', 'new', false, { sourceEntry: srcEntry('/src/ok.txt') }),
      ],
      recording('local') as never,
      target as never,
      '/dst',
      { deleteExtraneous: false }
    );

    expect(result.copied).toBe(1);
    expect(result.failed).toBe(2);
    expect(result.errors).toEqual([
      { path: 'bad-dir', error: expect.stringContaining('createFolder failed') },
      { path: 'boom.txt', error: 'disk full' },
    ]);
    expect(target.calls.setModifiedTime.map((c) => c.path)).toEqual(['/dst/ok.txt']); // not for the one that failed
  });

  it('falls back to a path built from the relative path when the entry has no source path', async () => {
    await apply([diff('c.txt', 'new', false)], recording('local') as never, recording('sftp') as never, '/dst', { deleteExtraneous: false });
    expect(transferFileMock.mock.calls[0][0]).toMatchObject({ sourcePath: 'c.txt', targetPath: '/dst/c.txt' });
  });

  describe('deleting what only the target has', () => {
    const extraneous = [
      diff('old', 'only-target', true, { targetEntry: srcEntry('/dst/old', { isDirectory: true }) }),
      diff('old/deep/file.txt', 'only-target', false, { targetEntry: srcEntry('/dst/old/deep/file.txt') }),
      diff('old/deep', 'only-target', true, { targetEntry: srcEntry('/dst/old/deep', { isDirectory: true }) }),
    ];

    it('never deletes anything unless asked to', async () => {
      const target = recording('sftp');

      const result = await apply(extraneous, recording('local') as never, target as never, '/dst', { deleteExtraneous: false });

      expect(target.calls.delete).toEqual([]);
      expect(result.deleted).toBe(0);
    });

    it('deletes deepest paths first, so a folder is emptied before it is removed, and tells folders from files', async () => {
      const target = recording('sftp');

      const result = await apply(extraneous, recording('local') as never, target as never, '/dst', { deleteExtraneous: true });

      expect(target.calls.delete).toEqual([
        { path: '/dst/old/deep/file.txt', isDirectory: false },
        { path: '/dst/old/deep', isDirectory: true },
        { path: '/dst/old', isDirectory: true },
      ]);
      expect(result.deleted).toBe(3);
    });

    it('does not delete when the entries are only new or changed, and copies are not affected by the flag', async () => {
      const target = recording('sftp');
      await apply([diff('a.txt', 'new', false, { sourceEntry: srcEntry('/src/a.txt') })], recording('local') as never, target as never, '/dst', { deleteExtraneous: true });
      expect(target.calls.delete).toEqual([]);
      expect(transferFileMock).toHaveBeenCalledTimes(1);
    });

    it('records a failed delete and carries on with the others', async () => {
      const target = recording('sftp', { delete: ['/dst/old/deep'] });

      const result = await apply(extraneous, recording('local') as never, target as never, '/dst', { deleteExtraneous: true });

      expect(result.deleted).toBe(2);
      expect(result.failed).toBe(1);
      expect(result.errors).toEqual([{ path: 'old/deep', error: expect.stringContaining('delete failed') }]);
    });

    it('builds the path to delete from the relative path when the entry has no target path', async () => {
      const target = recording('sftp');
      await apply([diff('gone.txt', 'only-target')], recording('local') as never, target as never, '/dst', { deleteExtraneous: true });
      expect(target.calls.delete).toEqual([{ path: '/dst/gone.txt', isDirectory: false }]);
    });
  });

  it('touches only the entries it is given: a filtered-out difference is left alone', async () => {
    const target = recording('sftp');
    const all = [
      diff('keep-this.txt', 'new', false, { sourceEntry: srcEntry('/src/keep-this.txt') }),
      diff('skip-this.txt', 'new', false, { sourceEntry: srcEntry('/src/skip-this.txt') }),
      diff('delete-this', 'only-target', false),
    ];

    await apply(all.filter((e) => e.relativePath === 'keep-this.txt'), recording('local') as never, target as never, '/dst', { deleteExtraneous: true });

    expect(transferFileMock).toHaveBeenCalledTimes(1);
    expect(target.calls.delete).toEqual([]);
  });
});

