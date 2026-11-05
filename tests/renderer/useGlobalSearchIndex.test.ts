// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useGlobalSearchIndex } from '../../src/renderer/src/lib/useGlobalSearchIndex';
import type { AppTab } from '../../src/renderer/src/lib/tabs';

const sshProfile = (id: string) => ({ id, name: id, host: `${id}.example.com`, username: 'u', authType: 'password' });
const tab = (id: string, title: string) => ({ id, type: 'terminal', title }) as AppTab;

describe('useGlobalSearchIndex', () => {
  beforeEach(() => {
    (window as unknown as { multissh: unknown }).multissh = {
      profilesGet: vi.fn().mockResolvedValue({ ssh: [sshProfile('web')], s3: [{ id: 'b', name: 'bucket', region: 'r' }] }),
      teamVaultList: vi.fn().mockResolvedValue([{ exists: true, vaultId: 'v1', vaultName: 'Team', unlocked: true, filePath: '' }]),
      teamVaultGetPayload: vi.fn().mockResolvedValue({ ssh: [sshProfile('shared')], s3: [] }),
      settingsGet: vi.fn().mockResolvedValue({}),
    };
  });
  afterEach(() => {
    delete (window as unknown as { multissh?: unknown }).multissh;
  });

  it('is loading until the profiles have been read, then lists profiles and open tabs', async () => {
    const { result } = renderHook(() => useGlobalSearchIndex([tab('t1', 'Terminal 1')]));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.entries.map((e) => e.id)).toEqual([
      'ssh:personal:web',
      's3:personal:b',
      'ssh:v1:shared',
      'tab:t1',
    ]);
  });

  it('resolves a system entry to its servers, by name, within its own source', async () => {
    (window.multissh.profilesGet as ReturnType<typeof vi.fn>).mockResolvedValue({
      ssh: [{ ...sshProfile('web'), system: { name: 'Shop' } }, { ...sshProfile('db'), system: { name: 'shop' } }, sshProfile('blog')],
      s3: [],
    });
    (window.multissh.teamVaultGetPayload as ReturnType<typeof vi.fn>).mockResolvedValue({
      ssh: [{ ...sshProfile('other'), system: { name: 'Shop' } }],
      s3: [],
    });
    const { result } = renderHook(() => useGlobalSearchIndex([]));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const personal = result.current.entries.find((e) => e.id === 'system:personal:shop')!;
    expect(result.current.getProfile(personal).members?.map((m) => m.id)).toEqual(['db', 'web']);
    const shared = result.current.entries.find((e) => e.id === 'system:v1:shop')!;
    expect(result.current.getProfile(shared).members?.map((m) => m.id)).toEqual(['other']);
    expect(result.current.getProfile({ ...personal, source: 'gone' })).toEqual({});
  });

  it('follows the open tabs without reading the profiles again', async () => {
    const { result, rerender } = renderHook(({ tabs }) => useGlobalSearchIndex(tabs), {
      initialProps: { tabs: [tab('t1', 'One')] },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    rerender({ tabs: [tab('t1', 'One'), tab('t2', 'Two')] });
    expect(result.current.entries.filter((e) => e.kind === 'tab').map((e) => e.ref)).toEqual(['t1', 't2']);
    expect(window.multissh.profilesGet).toHaveBeenCalledTimes(1);
  });

  it('resolves an entry back to the full profile, with the Team Vault reference on a shared one', async () => {
    const { result } = renderHook(() => useGlobalSearchIndex([]));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const personal = result.current.entries.find((e) => e.id === 'ssh:personal:web')!;
    const shared = result.current.entries.find((e) => e.id === 'ssh:v1:shared')!;
    expect(result.current.getProfile(personal)).toMatchObject({ ssh: { id: 'web', host: 'web.example.com' } });
    expect(result.current.getProfile(shared)).toMatchObject({
      ssh: { id: 'shared', teamVaultProfileRef: { vaultId: 'v1', profileId: 'shared' } },
    });
    expect(result.current.getProfile(result.current.entries.find((e) => e.id === 's3:personal:b')!)).toMatchObject({
      s3: { id: 'b' },
    });
  });

  it('returns nothing for an entry that has no profile behind it (a tab, or one that has gone)', async () => {
    const { result } = renderHook(() => useGlobalSearchIndex([tab('t1', 'One')]));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.getProfile(result.current.entries.find((e) => e.kind === 'tab')!)).toEqual({});
    expect(result.current.getProfile({ id: 'ssh:personal:gone', kind: 'ssh', source: 'personal', ref: 'gone' } as never)).toEqual({});
  });

  it('lists a locked Team Vault', async () => {
    (window.multissh.teamVaultList as ReturnType<typeof vi.fn>).mockResolvedValue([
      { exists: true, vaultId: 'v2', vaultName: 'Locked team', unlocked: false, filePath: '' },
    ]);
    const { result } = renderHook(() => useGlobalSearchIndex([]));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.locked).toEqual([{ vaultId: 'v2', name: 'Locked team' }]);
  });

  it('does not set state after it has been unmounted', async () => {
    const { result, unmount } = renderHook(() => useGlobalSearchIndex([]));
    unmount();
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current.loading).toBe(true);
  });
});
