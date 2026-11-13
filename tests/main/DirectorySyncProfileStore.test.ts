import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DirectorySyncProfileStore } from '../../src/main/dirsync/DirectorySyncProfileStore';
import type { DirectorySyncProfile } from '../../src/shared/types/dirsync';

const profile = (id: string): DirectorySyncProfile => ({
  id,
  name: `Profile ${id}`,
  source: { providerConfigRef: 'local', path: '/a' },
  target: { providerConfigRef: 's3-x', path: 'bucket/b' },
  deleteExtraneous: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

describe('DirectorySyncProfileStore', () => {
  let dir: string;
  let store: DirectorySyncProfileStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sshs3-dirsync-store-'));
    store = new DirectorySyncProfileStore(path.join(dir, 'p.json'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('soft-deletes: hidden from list() but kept as a tombstone', async () => {
    await store.save(profile('1'));
    await store.delete('1');

    expect(await store.list()).toHaveLength(0);
    const all = await store.listIncludingTombstones();
    expect(all).toHaveLength(1);
    expect(all[0].deletedAt).toBeTruthy();
    expect(all[0].updatedAt).toBe(all[0].deletedAt);
  });

  it('saving a deleted id again revives it', async () => {
    await store.save(profile('1'));
    await store.delete('1');
    await store.save(profile('1'));

    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0].deletedAt).toBeUndefined();
  });

  it('replaceAll stores the given set verbatim, tombstones included', async () => {
    await store.replaceAll([{ ...profile('1'), deletedAt: '2026-02-01T00:00:00.000Z' }, profile('2')]);

    expect((await store.list()).map((p) => p.id)).toEqual(['2']);
    expect(await store.listIncludingTombstones()).toHaveLength(2);
  });
});
