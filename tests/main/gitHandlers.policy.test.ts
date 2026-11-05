import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false }, shell: {} }));

const { fetchGitPublicKeys, importFromGit } = vi.hoisted(() => ({
  fetchGitPublicKeys: vi.fn(async () => ({ success: true, keys: [] })),
  importFromGit: vi.fn(async () => ({ success: true })),
}));
vi.mock('../../src/main/git/GitKeyFetcher', () => ({ fetchGitPublicKeys }));
vi.mock('../../src/main/dotfiles/DotfileGitImporter', () => ({ DotfileGitImporter: { importFromGit } }));

import { registerGitHandlers, type GitHost } from '../../src/main/ipc/gitHandlers';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';
import type { PolicyDocument } from '../../src/shared/types/policy';

type Handler = (event: unknown, ...args: unknown[]) => Promise<any>;

function setup(features: PolicyDocument['features']) {
  const handlers = new Map<string, Handler>();
  registerGitHandlers({
    registerHandler: (channel: string, h: Handler) => void handlers.set(channel, h),
    policy: { policy: { settings: {}, features }, warnings: [] },
    scheduleAutoSync: vi.fn(),
    dotfilePoolStore: {},
  } as unknown as GitHost);
  return handlers;
}

describe('git handlers under policy', () => {
  beforeEach(() => vi.clearAllMocks());

  it('blocks key fetching and dotfile import when the policy disables them', async () => {
    const handlers = setup({ gitKeyFetch: false, dotfileGitImport: false });
    const keys = await handlers.get(IPC_CHANNELS.GIT_FETCH_PUBLIC_KEYS)!({}, { provider: 'github', username: 'x' });
    const dotfiles = await handlers.get(IPC_CHANNELS.DOTFILES_IMPORT_FROM_GIT)!({}, {});
    expect(keys).toEqual({ success: false, keys: [], error: 'Disabled by your administrator.' });
    expect(dotfiles).toEqual({ success: false, error: 'Disabled by your administrator.' });
    expect(fetchGitPublicKeys).not.toHaveBeenCalled();
    expect(importFromGit).not.toHaveBeenCalled();
  });

  it('allows them when the policy says nothing', async () => {
    const handlers = setup({});
    await handlers.get(IPC_CHANNELS.GIT_FETCH_PUBLIC_KEYS)!({}, { provider: 'github', username: 'x' });
    await handlers.get(IPC_CHANNELS.DOTFILES_IMPORT_FROM_GIT)!({}, {});
    expect(fetchGitPublicKeys).toHaveBeenCalledTimes(1);
    expect(importFromGit).toHaveBeenCalledTimes(1);
  });
});
