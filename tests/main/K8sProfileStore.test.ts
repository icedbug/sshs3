import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));

import { K8sProfileStore } from '../../src/main/profile/K8sProfileStore';

describe('K8sProfileStore', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'k8s-profiles-test-'));
    file = path.join(dir, 'nested', 'k8s-profiles.json');
  });
  afterEach(() => fs.rm(dir, { recursive: true, force: true }));

  const base = { id: 'p1', name: 'Prod', server: 'https://api.example.com:6443' };

  it('returns an empty list when the file does not exist', async () => {
    expect(await new K8sProfileStore(file).list()).toEqual([]);
  });

  it('saves, updates and deletes profiles, stamping updatedAt', async () => {
    const store = new K8sProfileStore(file);
    const saved = await store.save({ ...base, namespace: 'team-a', contextName: 'team-a/api/alice' });
    expect(saved.updatedAt).toBeTruthy();

    await store.save({ ...base, name: 'Production' });
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'p1', name: 'Production' });
    expect(list[0].namespace).toBeUndefined();

    await store.delete('p1');
    expect(await store.list()).toEqual([]);
  });

  it('keeps a deleted profile as a tombstone for sync, and revives it on save', async () => {
    const store = new K8sProfileStore(file);
    await store.save(base);
    await store.delete('p1');

    const all = await store.listIncludingTombstones();
    expect(all).toHaveLength(1);
    expect(all[0].deletedAt).toBeTruthy();
    expect(all[0].updatedAt).toBe(all[0].deletedAt);

    await store.save(base);
    expect((await store.list()).map((p) => p.id)).toEqual(['p1']);
    expect((await store.listIncludingTombstones())[0].deletedAt).toBeUndefined();
  });

  it('replaceAll stores the set verbatim, timestamps and tombstones included', async () => {
    const store = new K8sProfileStore(file);
    const stamp = '2026-01-01T00:00:00.000Z';
    await store.replaceAll([
      { ...base, updatedAt: stamp },
      { ...base, id: 'p2', updatedAt: stamp, deletedAt: stamp },
    ]);
    expect(await store.listIncludingTombstones()).toEqual([
      { ...base, updatedAt: stamp },
      { ...base, id: 'p2', updatedAt: stamp, deletedAt: stamp },
    ]);
    expect((await store.list()).map((p) => p.id)).toEqual(['p1']);
  });

  it('writes the file readable by the owner only and never stores unknown fields', async () => {
    const store = new K8sProfileStore(file);
    await store.save({ ...base, token: 'sha256~secret' } as never);
    const raw = await fs.readFile(file, 'utf-8');
    expect(raw).not.toContain('secret');
    if (process.platform !== 'win32') {
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    }
  });

  it('rejects invalid profiles', async () => {
    const store = new K8sProfileStore(file);
    await expect(store.save({ ...base, id: '../x' })).rejects.toThrow(/id/);
    await expect(store.save({ ...base, name: '  ' })).rejects.toThrow(/name/);
    await expect(store.save({ ...base, namespace: 'bad namespace!' })).rejects.toThrow(/namespace/);
    expect(await store.list()).toEqual([]);
  });

  it('keeps every concurrent save', async () => {
    const store = new K8sProfileStore(file);
    await Promise.all(['a', 'b', 'c', 'd'].map((id) => store.save({ ...base, id })));
    expect((await store.list()).map((p) => p.id).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('copies an unparsable file aside and starts empty', async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{ not json');
    const store = new K8sProfileStore(file);
    expect(await store.list()).toEqual([]);
    expect(await fs.readFile(`${file}.corrupt`, 'utf-8')).toBe('{ not json');
  });

  it('skips an entry that no longer validates instead of failing the list', async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ profiles: [base, { id: '', name: 'x' }] }));
    expect((await new K8sProfileStore(file).list()).map((p) => p.id)).toEqual(['p1']);
  });
});
