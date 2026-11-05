import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));

import { fromRemotePayload, replaceKeepingContext, toSyncPayload } from '../../src/main/services/k8sProfileSync';
import { mergeRecords } from '../../src/main/services/ProfileSyncService';
import type { K8sProfile } from '../../src/shared/types/kubernetes';

const profile = (over: Partial<K8sProfile> = {}): K8sProfile => ({
  id: 'p1',
  name: 'Prod',
  server: 'https://api.example.com:6443',
  ...over,
});

describe('k8sProfileSync', () => {
  it('leaves the machine-local context name out of the payload', () => {
    const payload = toSyncPayload([profile({ contextName: 'ns/cluster/user', namespace: 'team-a' })]);
    expect(payload.profiles).toEqual([{ id: 'p1', name: 'Prod', server: 'https://api.example.com:6443', namespace: 'team-a' }]);
  });

  it('drops invalid remote entries and never accepts a context name or unknown fields', () => {
    const profiles = fromRemotePayload({
      profiles: [
        { ...profile(), contextName: 'planted', token: 'sha256~x', updatedAt: '2026-01-01T00:00:00.000Z' },
        { id: '../bad', name: 'x', server: 'https://a.example.com' },
        { id: 'p3', name: '', server: 'https://a.example.com' },
        'not an object',
      ],
    });
    expect(profiles).toEqual([{ ...profile(), updatedAt: '2026-01-01T00:00:00.000Z' }]);
  });

  it('keeps tombstones so deletions can propagate', () => {
    const stamp = '2026-02-01T00:00:00.000Z';
    expect(fromRemotePayload({ profiles: [{ ...profile(), updatedAt: stamp, deletedAt: stamp }] })[0].deletedAt).toBe(stamp);
  });

  it('tolerates a malformed payload', () => {
    expect(fromRemotePayload(null)).toEqual([]);
    expect(fromRemotePayload({ profiles: 'x' })).toEqual([]);
  });

  it('a newer remote record merges onto the local one and keeps its context name', () => {
    const local = [profile({ contextName: 'local-ctx', updatedAt: '2026-01-01T00:00:00.000Z' })];
    const remote = fromRemotePayload({ profiles: [{ ...profile({ name: 'Renamed' }), updatedAt: '2026-02-01T00:00:00.000Z' }] });
    const { merged, changed } = mergeRecords(local, remote, { onRemoteWins: replaceKeepingContext });
    expect(changed).toBe(true);
    expect(merged[0]).toMatchObject({ name: 'Renamed', contextName: 'local-ctx' });
  });

  it('a field cleared on the other machine is cleared here too', () => {
    const local = [profile({ namespace: 'team-a', contextName: 'local-ctx', updatedAt: '2026-01-01T00:00:00.000Z' })];
    const remote = fromRemotePayload({ profiles: [{ ...profile(), updatedAt: '2026-02-01T00:00:00.000Z' }] });
    const { merged } = mergeRecords(local, remote, { onRemoteWins: replaceKeepingContext });
    expect(merged[0].namespace).toBeUndefined();
    expect(merged[0].contextName).toBe('local-ctx');
  });

  it('a remote tombstone replaces the local record and a restored record drops the tombstone', () => {
    const tombstone = fromRemotePayload({
      profiles: [{ ...profile(), updatedAt: '2026-02-01T00:00:00.000Z', deletedAt: '2026-02-01T00:00:00.000Z' }],
    });
    const deleted = mergeRecords([profile({ updatedAt: '2026-01-01T00:00:00.000Z' })], tombstone, {
      onRemoteWins: replaceKeepingContext,
    }).merged;
    expect(deleted[0].deletedAt).toBe('2026-02-01T00:00:00.000Z');

    const restored = fromRemotePayload({ profiles: [{ ...profile(), updatedAt: '2026-03-01T00:00:00.000Z' }] });
    expect(mergeRecords(deleted, restored, { onRemoteWins: replaceKeepingContext }).merged[0].deletedAt).toBeUndefined();
  });

  it('an older or equal remote record does not replace the local one', () => {
    const local = [profile({ namespace: 'team-a', updatedAt: '2026-02-01T00:00:00.000Z' })];
    const remote = fromRemotePayload({ profiles: [{ ...profile(), updatedAt: '2026-01-01T00:00:00.000Z' }] });
    const result = mergeRecords(local, remote, { onRemoteWins: replaceKeepingContext });
    expect(result.changed).toBe(false);
    expect(result.merged[0].namespace).toBe('team-a');
  });
});
