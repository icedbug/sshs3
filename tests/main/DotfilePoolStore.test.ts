import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DotfilePoolStore } from '../../src/main/dotfiles/DotfilePoolStore';
import type { DotfilePool } from '../../src/shared/types/dotfiles';

describe('DotfilePoolStore with Master Files', () => {
  let tempDir: string;
  let storeFile: string;
  let store: DotfilePoolStore;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dotfile-store-test-'));
    storeFile = path.join(tempDir, 'dotfile-pools.json');
    store = new DotfilePoolStore(storeFile);
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('saves pools and writes physical master files to disk in dotfiles/<poolId>/', async () => {
    const pool: DotfilePool = {
      id: 'pool-test-1',
      name: 'Server Configs',
      files: [
        {
          id: 'file-1',
          remotePath: '~/.bashrc',
          content: 'export FOO=BAR\nalias ll="ls -la"',
          mode: '644',
        },
        {
          id: 'file-2',
          remotePath: '~/.config/nvim/init.vim',
          content: 'set number\nset relativenumber',
          mode: '600',
        },
      ],
    };

    await store.savePool(pool);

    // Verify pools JSON is written
    const pools = await store.getPools();
    expect(pools).toHaveLength(1);
    expect(pools[0].name).toBe('Server Configs');
    expect(pools[0].updatedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);

    // Verify physical master files exist on disk
    const poolDir = store.getPoolDirectory('pool-test-1');
    const bashrcPath = path.join(poolDir, '.bashrc');
    const nvimPath = path.join(poolDir, '.config', 'nvim', 'init.vim');

    const bashrcContent = await fs.readFile(bashrcPath, 'utf-8');
    expect(bashrcContent).toBe('export FOO=BAR\nalias ll="ls -la"');

    const nvimContent = await fs.readFile(nvimPath, 'utf-8');
    expect(nvimContent).toBe('set number\nset relativenumber');

    // Verify master file properties in returned pool
    expect(pools[0].files[0].masterFileName).toBe('.bashrc');
    expect(pools[0].files[0].masterFilePath).toBe(bashrcPath);
    expect(pools[0].files[0].updatedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('automatically syncs modifications made directly to master files on disk', async () => {
    const pool: DotfilePool = {
      id: 'pool-test-sync',
      name: 'Sync Test',
      files: [
        {
          id: 'f-1',
          remotePath: '~/.zshrc',
          content: 'PROMPT="%m %~ %# "',
        },
      ],
    };

    await store.savePool(pool);

    // Edit master file on disk externally
    const masterPath = store.getMasterFilePath('pool-test-sync', '~/.zshrc');
    await fs.writeFile(masterPath, 'PROMPT="MODIFIED BY EXTERNAL EDITOR"', 'utf-8');

    // getPool should read disk content
    const reloaded = await store.getPool('pool-test-sync');
    expect(reloaded).toBeDefined();
    expect(reloaded!.files[0].content).toBe('PROMPT="MODIFIED BY EXTERNAL EDITOR"');
  });

  it('imports local files and reads their content and mode', async () => {
    const testFile1 = path.join(tempDir, 'test-bashrc');
    const testFile2 = path.join(tempDir, 'test-vimrc');

    await fs.writeFile(testFile1, '# Bash config\nexport PATH=$PATH:~/bin', 'utf-8');
    await fs.writeFile(testFile2, '" Vim config\nsyntax on', 'utf-8');

    const imported = await store.importLocalFiles([testFile1, testFile2]);
    expect(imported).toHaveLength(2);
    expect(imported[0].name).toBe('test-bashrc');
    expect(imported[0].content).toBe('# Bash config\nexport PATH=$PATH:~/bin');
    expect(imported[1].name).toBe('test-vimrc');
    expect(imported[1].content).toBe('" Vim config\nsyntax on');
  });

  it('skips binary, missing and relative paths and suggests a home-relative remote path', async () => {
    const text = path.join(tempDir, 'config');
    const bin = path.join(tempDir, 'blob');
    await fs.writeFile(text, 'apiVersion: v1', 'utf-8');
    await fs.writeFile(bin, Buffer.from([1, 0, 2]));

    const imported = await store.importLocalFiles([text, bin, path.join(tempDir, 'nope'), 'relative/path']);
    expect(imported).toHaveLength(1);
    expect(imported[0].size).toBe(14);
    expect(imported[0].suggestedRemotePath).toBe('~/.config');
  });

  it('stores sourcePath when adding a file to a pool', async () => {
    const updated = await store.addFileToPool('pool-src', {
      remotePath: '~/.kube/config',
      content: 'x',
      sourcePath: '/home/u/.kube/config',
    });
    expect(updated.files[0].sourcePath).toBe('/home/u/.kube/config');
  });

  it('adds files to an existing pool or creates one with addFileToPool', async () => {
    const updated = await store.addFileToPool('pool-quick', {
      remotePath: '~/.tmux.conf',
      content: 'set -g mouse on',
      mode: '644',
    });

    expect(updated.id).toBe('pool-quick');
    expect(updated.files).toHaveLength(1);
    expect(updated.files[0].remotePath).toBe('~/.tmux.conf');
    expect(updated.files[0].content).toBe('set -g mouse on');

    const poolDir = store.getPoolDirectory('pool-quick');
    const diskContent = await fs.readFile(path.join(poolDir, '.tmux.conf'), 'utf-8');
    expect(diskContent).toBe('set -g mouse on');

    // Adding same remotePath should update the existing file
    await store.addFileToPool('pool-quick', {
      remotePath: '~/.tmux.conf',
      content: 'set -g mouse on\nbind r source-file ~/.tmux.conf',
    });

    const poolAfterUpdate = await store.getPool('pool-quick');
    expect(poolAfterUpdate!.files).toHaveLength(1);
    expect(poolAfterUpdate!.files[0].content).toBe('set -g mouse on\nbind r source-file ~/.tmux.conf');
  });

  it('keeps stored file tombstones when the pool is saved back from the (tombstone-free) getPools() list', async () => {
    await store.savePool({
      id: 'p',
      name: 'P',
      files: [
        { id: 'f1', remotePath: '~/.a', content: 'a', deletedAt: '2026-10-01 10:00' },
        { id: 'f2', remotePath: '~/.b', content: 'b' },
      ],
    });

    // The pool editor loads via getPools() (tombstones hidden) and saves that list back.
    const visible = (await store.getPools())[0];
    expect(visible.files.map((f) => f.id)).toEqual(['f2']);
    await store.savePool(visible);

    const raw = (await store.getPoolsIncludingTombstones())[0];
    expect(raw.files.find((f) => f.id === 'f1')?.deletedAt).toBe('2026-10-01 10:00');
    // The caller's object is not polluted with the tombstone.
    expect(visible.files.map((f) => f.id)).toEqual(['f2']);
  });

  it('does not delete the master file of an active file that shares a path with a tombstone', async () => {
    await store.savePool({
      id: 'p',
      name: 'P',
      files: [
        { id: 'new', remotePath: '~/.bashrc', content: 'fresh' },
        { id: 'old', remotePath: '~/.bashrc', content: 'stale', deletedAt: '2026-10-01 10:00' },
      ],
    });

    const active = (await store.getPools())[0].files[0];
    expect(active.id).toBe('new');
    expect(await fs.readFile(active.masterFilePath!, 'utf-8')).toBe('fresh');
  });

  it('serializes concurrent addFileToPool calls instead of losing files', async () => {
    await Promise.all([
      store.addFileToPool('p', { remotePath: '~/.one', content: '1' }),
      store.addFileToPool('p', { remotePath: '~/.two', content: '2' }),
      store.addFileToPool('p', { remotePath: '~/.three', content: '3' }),
    ]);
    const paths = (await store.getPools())[0].files.map((f) => f.remotePath).sort();
    expect(paths).toEqual(['~/.one', '~/.three', '~/.two']);
  });

  it('deletes pool and removes master file directory from disk', async () => {
    const pool: DotfilePool = {
      id: 'pool-to-delete',
      name: 'To Delete',
      files: [{ id: 'f-del', remotePath: '~/.profile', content: '# profile' }],
    };

    await store.savePool(pool);
    const poolDir = store.getPoolDirectory('pool-to-delete');
    expect(await fs.stat(poolDir).then(() => true, () => false)).toBe(true);

    await store.deletePool('pool-to-delete');
    const remaining = await store.getPools();
    expect(remaining).toHaveLength(0);

    const dirExists = await fs.stat(poolDir).then(() => true, () => false);
    expect(dirExists).toBe(false);
  });

  it('rejects path traversal attempts in pool IDs', async () => {
    expect(() => store.getPoolDirectory('../evil')).toThrow(/Invalid pool ID/);
    expect(() => store.getPoolDirectory('..')).toThrow(/Invalid pool ID/);
    expect(() => store.getPoolDirectory('pool/sub')).toThrow(/Invalid pool ID/);
    expect(() => store.getPoolDirectory('pool\\sub')).toThrow(/Invalid pool ID/);

    await expect(
      store.savePool({
        id: '../escape',
        name: 'Evil',
        files: [],
      })
    ).rejects.toThrow();
  });
});
