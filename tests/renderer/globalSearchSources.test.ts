import { describe, it, expect, vi } from 'vitest';
import { loadSearchSources, type SearchSourcesApi } from '../../src/renderer/src/lib/globalSearchSources';

const ssh = (id: string) => ({ id, name: id, host: `${id}.example.com`, username: 'u', authType: 'password' }) as never;
const s3 = (id: string) => ({ id, name: id, region: 'r' }) as never;

function makeApi(over: Partial<SearchSourcesApi> = {}): SearchSourcesApi {
  return {
    profilesGet: vi.fn().mockResolvedValue({ ssh: [ssh('p1')], s3: [s3('b1')] }),
    teamVaultList: vi.fn().mockResolvedValue([]),
    teamVaultGetPayload: vi.fn().mockResolvedValue(null),
    settingsGet: vi.fn().mockResolvedValue({}),
    ...over,
  };
}

const vault = (vaultId: string, over: Record<string, unknown> = {}) => ({
  exists: true,
  vaultId,
  vaultName: `Team ${vaultId}`,
  unlocked: true,
  ...over,
});

describe('loadSearchSources', () => {
  it('returns the personal profiles as the first source', async () => {
    const { sources, locked } = await loadSearchSources(makeApi());
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ source: 'personal' });
    expect(sources[0].ssh).toHaveLength(1);
    expect(sources[0].s3).toHaveLength(1);
    expect(locked).toEqual([]);
  });

  it('adds each unlocked Team Vault with its name, and tags every profile with its vault reference', async () => {
    const api = makeApi({
      teamVaultList: vi.fn().mockResolvedValue([vault('v1')]),
      teamVaultGetPayload: vi.fn().mockResolvedValue({ ssh: [ssh('t1')], s3: [s3('t2')] }),
    });
    const { sources } = await loadSearchSources(api);
    expect(sources.map((s) => [s.source, s.label])).toEqual([
      ['personal', undefined],
      ['v1', 'Team v1'],
    ]);
    expect(sources[1].ssh[0]).toMatchObject({ id: 't1', teamVaultProfileRef: { vaultId: 'v1', profileId: 't1' } });
    expect(sources[1].s3[0]).toMatchObject({ id: 't2', teamVaultProfileRef: { vaultId: 'v1', profileId: 't2' } });
  });

  it('reports locked vaults instead of reading their payload', async () => {
    const getPayload = vi.fn();
    const api = makeApi({
      teamVaultList: vi.fn().mockResolvedValue([vault('v1', { unlocked: false })]),
      teamVaultGetPayload: getPayload,
    });
    const { sources, locked } = await loadSearchSources(api);
    expect(sources).toHaveLength(1);
    expect(locked).toEqual([{ vaultId: 'v1', name: 'Team v1' }]);
    expect(getPayload).not.toHaveBeenCalled();
  });

  it('skips vaults the user has hidden in Connection Manager, locked or not', async () => {
    const getPayload = vi.fn().mockResolvedValue({ ssh: [ssh('t1')], s3: [] });
    const api = makeApi({
      teamVaultList: vi.fn().mockResolvedValue([vault('v1'), vault('v2'), vault('v3', { unlocked: false })]),
      teamVaultGetPayload: getPayload,
      settingsGet: vi.fn().mockResolvedValue({ connectionManagerVisibleTeamVaults: { v1: false, v3: false } }),
    });
    const { sources, locked } = await loadSearchSources(api);
    expect(sources.map((s) => s.source)).toEqual(['personal', 'v2']);
    expect(locked).toEqual([]);
    expect(getPayload).toHaveBeenCalledTimes(1);
    expect(getPayload).toHaveBeenCalledWith('v2');
  });

  it('ignores a vault that does not exist or has no id', async () => {
    const api = makeApi({ teamVaultList: vi.fn().mockResolvedValue([{ exists: false, unlocked: false }, { exists: true, unlocked: true }]) });
    const { sources, locked } = await loadSearchSources(api);
    expect(sources).toHaveLength(1);
    expect(locked).toEqual([]);
  });

  it('keeps going when one vault cannot be read, and when its payload is unavailable', async () => {
    const api = makeApi({
      teamVaultList: vi.fn().mockResolvedValue([vault('v1'), vault('v2'), vault('v3')]),
      teamVaultGetPayload: vi
        .fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ssh: [ssh('t3')], s3: [] }),
    });
    const { sources } = await loadSearchSources(api);
    expect(sources.map((s) => s.source)).toEqual(['personal', 'v3']);
  });

  it('still returns the personal profiles when the Team Vault list or the settings cannot be read', async () => {
    const api = makeApi({
      teamVaultList: vi.fn().mockRejectedValue(new Error('no vaults')),
      settingsGet: vi.fn().mockRejectedValue(new Error('no settings')),
    });
    const { sources } = await loadSearchSources(api);
    expect(sources.map((s) => s.source)).toEqual(['personal']);
  });

  it('treats a missing or synchronously throwing API call, and empty settings, like a failed read', async () => {
    const api = makeApi({
      teamVaultList: (() => {
        throw new Error('not wired');
      }) as never,
      settingsGet: vi.fn().mockResolvedValue(undefined),
    });
    const { sources, locked } = await loadSearchSources(api);
    expect(sources.map((s) => s.source)).toEqual(['personal']);
    expect(locked).toEqual([]);
    const missing = await loadSearchSources({ ...makeApi(), teamVaultList: undefined as never, teamVaultGetPayload: undefined as never });
    expect(missing.sources).toHaveLength(1);
  });

  it('survives profiles that come back without lists', async () => {
    const api = makeApi({ profilesGet: vi.fn().mockResolvedValue({}) });
    const { sources } = await loadSearchSources(api);
    expect(sources[0]).toMatchObject({ source: 'personal', ssh: [], s3: [] });
  });

  it('returns no personal profiles rather than failing when they cannot be read', async () => {
    const api = makeApi({ profilesGet: vi.fn().mockRejectedValue(new Error('disk')) });
    const { sources } = await loadSearchSources(api);
    expect(sources[0]).toMatchObject({ source: 'personal', ssh: [], s3: [] });
  });
});
