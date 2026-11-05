import { describe, it, expect } from 'vitest';
import { normalizeK8sList, removeK8sProfile, toTeamK8sProfile, upsertK8sProfile } from '../../src/main/services/teamVaultK8s';

const base = { id: 'k1', name: 'Prod', server: 'https://api.example.com:6443' };

describe('teamVaultK8s', () => {
  it('reduces a profile to a shareable template', () => {
    expect(
      toTeamK8sProfile({
        ...base,
        namespace: 'team-a',
        insecureSkipTlsVerify: true,
        contextName: 'ctx',
        lastUsedAt: '2026-01-01T00:00:00.000Z',
        deletedAt: '2026-01-01T00:00:00.000Z',
        token: 'x',
      })
    ).toEqual({ ...base, namespace: 'team-a', insecureSkipTlsVerify: true });
  });

  it('treats an absent or malformed field as an empty list and drops invalid entries and duplicates', () => {
    expect(normalizeK8sList(undefined)).toEqual([]);
    expect(normalizeK8sList('x')).toEqual([]);
    expect(normalizeK8sList([base, { id: '../x', name: 'n', server: 'https://a.example.com' }, { ...base, name: 'Prod 2' }])).toEqual([
      { ...base, name: 'Prod 2' },
    ]);
  });

  it('upserts by id with a fresh timestamp and removes by id', () => {
    const now = '2026-03-01T00:00:00.000Z';
    const added = upsertK8sProfile([], base, now);
    expect(added).toEqual([{ ...base, updatedAt: now }]);
    const renamed = upsertK8sProfile(added, { ...base, name: 'Renamed' }, '2026-04-01T00:00:00.000Z');
    expect(renamed).toEqual([{ ...base, name: 'Renamed', updatedAt: '2026-04-01T00:00:00.000Z' }]);
    expect(removeK8sProfile(renamed, 'k1')).toEqual([]);
    expect(removeK8sProfile(renamed, 'other')).toHaveLength(1);
  });
});
