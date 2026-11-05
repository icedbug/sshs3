import { describe, it, expect, vi } from 'vitest';
import { buildAdHocConfig, prepareConnect, shouldTouchLastUsed } from '../../src/renderer/src/lib/openProfile';

describe('buildAdHocConfig', () => {
  it('builds an unsaved password profile named after the target', () => {
    const config = buildAdHocConfig({ username: 'alice', host: 'web1', port: 2222 });
    expect(config).toMatchObject({ name: 'alice@web1', host: 'web1', port: 2222, username: 'alice', authType: 'password' });
  });

  it('gives each connection its own id, so two one-off connections never share state', () => {
    const a = buildAdHocConfig({ username: 'u', host: 'h' });
    const b = buildAdHocConfig({ username: 'u', host: 'h' });
    expect(a.id).not.toBe(b.id);
    expect(a.id.length).toBeGreaterThan(8);
  });

  it('falls back to the bare host when there is no user', () => {
    expect(buildAdHocConfig({ username: '', host: 'h' })).toMatchObject({ name: 'h', username: '' });
  });
});

describe('prepareConnect', () => {
  const profile = { id: 'p1', name: 'Web' } as { id: string; name: string; lastUsedAt?: string };

  it('stamps and saves the last-used time of a personal profile, and returns the stamped copy', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const result = await prepareConnect(profile, 'personal', save, new Date(2026, 9, 30, 16, 5));
    expect(result).toEqual({ id: 'p1', name: 'Web', lastUsedAt: '2026-10-30 16:05' });
    expect(save).toHaveBeenCalledWith(result);
    expect(profile.lastUsedAt).toBeUndefined();
  });

  it('leaves a Team Vault profile alone and never saves it', async () => {
    const save = vi.fn();
    const result = await prepareConnect(profile, 'vault-1', save);
    expect(result).toBe(profile);
    expect(save).not.toHaveBeenCalled();
  });

  it('still connects with the stamped profile when saving fails', async () => {
    const save = vi.fn().mockRejectedValue(new Error('disk full'));
    const result = await prepareConnect(profile, 'personal', save, new Date(2026, 0, 2, 3, 4));
    expect(result.lastUsedAt).toBe('2026-01-02 03:04');
  });
});

describe('shouldTouchLastUsed', () => {
  it('writes the last-used time for personal profiles', () => {
    expect(shouldTouchLastUsed('personal')).toBe(true);
  });

  it('never writes it for a Team Vault profile: that would bump the vault revision for every member', () => {
    expect(shouldTouchLastUsed('vault-123')).toBe(false);
    expect(shouldTouchLastUsed('')).toBe(false);
  });
});
