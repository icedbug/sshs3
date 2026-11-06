import { afterEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => {
  const mockObj = {
    ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
    app: { getPath: () => path.join(os.tmpdir(), 'sshs3-demo-sync-unused-user-data') },
    safeStorage: {
      isEncryptionAvailable: vi.fn().mockReturnValue(false),
      encryptString: vi.fn(),
      decryptString: vi.fn(),
    },
    shell: { openPath: vi.fn().mockResolvedValue(''), openExternal: vi.fn() },
    Notification: { isSupported: () => false },
    powerMonitor: { on: vi.fn(), removeListener: vi.fn() },
  };
  return { ...mockObj, default: mockObj };
});

import { setDemoModeForTesting } from '../../src/main/demo/demoMode';
import { IpcBridge } from '../../src/main/IpcBridge';
import { registerSyncHandlers } from '../../src/main/ipc/syncHandlers';
import { IPC_CHANNELS, type StorageConnectConfig } from '../../src/shared/types/ipc';
import type { IStorageProvider } from '../../src/shared/types/storage';

/**
 * The background and explicit entry points of the two syncs IpcBridge drives, run once outside and once
 * inside demo mode: the Team Vault auto-push after a shared profile changes and its periodic auto-poll, and
 * remote profile sync's debounced auto-push, periodic auto-pull and its Push/Pull/Compare requests. The
 * storage registry (which opens the remote target) and the sync services (which talk to it) are spies.
 * Outside demo mode every entry point opens the target and runs; in demo mode none even schedules work.
 */

const PROFILE_SYNC_DISABLED = /Remote profile sync is disabled in demo mode/;
const VAULT_ID = 'vlt_team-ops';
const PROFILE_TARGET: StorageConnectConfig = {
  id: 'sshs3-remote-profile-sync',
  name: 'Profile sync bucket',
  type: 's3',
  s3Config: {
    id: 'sshs3-remote-profile-sync',
    name: 'Profile sync bucket',
    region: 'eu-north-1',
    accessKeyId: 'AKIASYNC',
    secretAccessKey: 'sync-secret', // pragma: allowlist secret
  },
};
const VAULT_TARGET: StorageConnectConfig = {
  id: 'team-vault-target',
  name: 'Team Vault bucket',
  type: 's3',
  s3Config: {
    id: 'team-vault-target',
    name: 'Team Vault bucket',
    region: 'eu-north-1',
    accessKeyId: 'AKIAVAULT',
    secretAccessKey: 'vault-secret', // pragma: allowlist secret
  },
};

afterEach(() => {
  vi.useRealTimers();
  setDemoModeForTesting(undefined);
});

/** Fakes only the timers, so promises keep running for real. */
function useFakeTimers(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
}

class MockIpcMain {
  handlers = new Map<string, (...args: any[]) => any>();
  handle(channel: string, listener: (...args: any[]) => any) {
    this.handlers.set(channel, listener);
  }
  removeHandler(channel: string) {
    this.handlers.delete(channel);
  }
  async invoke(channel: string, ...args: any[]): Promise<any> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`No handler registered for channel "${channel}"`);
    return await handler({} as any, ...args);
  }
}

function makeBridge() {
  // What the registry hands out for a target. The sync services are spies, so nothing is done with it.
  const remote = { id: 'remote-target', name: 'Remote target', type: 's3' } as unknown as IStorageProvider;
  const storageRegistry = {
    getOrCreate: vi.fn().mockResolvedValue(remote),
    has: vi.fn().mockReturnValue(false),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
  // Remote profile sync is set up, unlocked and on auto-sync; a team vault is unlocked with a target.
  const syncConfigStore = {
    getConfig: vi.fn().mockResolvedValue({ target: PROFILE_TARGET, remoteBasePath: 'profile-sync', autoSync: true }),
    setLastSyncAt: vi.fn().mockResolvedValue(undefined),
    setSalts: vi.fn().mockResolvedValue(undefined),
  };
  const syncCryptoService = {
    isUnlocked: vi.fn().mockReturnValue(true),
    getSalt: vi.fn().mockReturnValue(undefined),
  };
  const profileSyncService = {
    pushToRemote: vi.fn().mockResolvedValue(undefined),
    pullFromRemote: vi.fn().mockResolvedValue({ sshNativeConflicts: [] }),
    compareWithRemote: vi.fn().mockResolvedValue({ state: 'in_sync', aheadCount: 0, behindCount: 0 }),
    getLastComparison: vi.fn().mockReturnValue(null),
  };
  const teamVaultService = {
    isUnlocked: vi.fn().mockReturnValue(true),
    pushToRemote: vi.fn().mockResolvedValue(undefined),
    pullFromRemote: vi.fn().mockResolvedValue(undefined),
    mergeWithRemote: vi.fn().mockResolvedValue(true),
    hasRemoteChangedSinceLastSync: vi.fn().mockResolvedValue(true),
    hasUnpushedLocalChanges: vi.fn().mockResolvedValue(false),
  };
  const teamVaultConfigStore = {
    getConfig: vi.fn().mockResolvedValue({ target: VAULT_TARGET, remoteBasePath: 'team-vault' }),
    setLastSyncAt: vi.fn().mockResolvedValue(undefined),
  };
  const ipc = new MockIpcMain();
  const bridge = new IpcBridge({
    ipcMain: ipc as any,
    storageRegistry: storageRegistry as any,
    syncConfigStore: syncConfigStore as any,
    syncCryptoService: syncCryptoService as any,
    profileSyncService: profileSyncService as any,
    teamVaultService: teamVaultService as any,
    teamVaultConfigStore: teamVaultConfigStore as any,
  });
  registerSyncHandlers(bridge);
  return {
    bridge,
    ipc,
    remote,
    storageRegistry,
    syncConfigStore,
    profileSyncService,
    teamVaultService,
    teamVaultConfigStore,
  };
}

type Harness = ReturnType<typeof makeBridge>;

/** Nothing opened a remote target, or asked a sync service to talk to one. */
function expectNoRemoteAccess(h: Harness): void {
  expect(h.storageRegistry.getOrCreate).not.toHaveBeenCalled();
  expect(h.profileSyncService.pushToRemote).not.toHaveBeenCalled();
  expect(h.profileSyncService.pullFromRemote).not.toHaveBeenCalled();
  expect(h.profileSyncService.compareWithRemote).not.toHaveBeenCalled();
  expect(h.teamVaultService.pushToRemote).not.toHaveBeenCalled();
  expect(h.teamVaultService.pullFromRemote).not.toHaveBeenCalled();
  expect(h.teamVaultService.mergeWithRemote).not.toHaveBeenCalled();
  expect(h.teamVaultService.hasRemoteChangedSinceLastSync).not.toHaveBeenCalled();
}

describe('Team Vault background sync: outside demo mode against demo mode', () => {
  it('normal mode: a change to a shared profile is pushed to the team target after the debounce', async () => {
    setDemoModeForTesting(false);
    const h = makeBridge();
    useFakeTimers();

    h.bridge.scheduleTeamVaultAutoPush(VAULT_ID);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersToNextTimerAsync();

    expect(h.teamVaultConfigStore.getConfig).toHaveBeenCalledWith(VAULT_ID);
    expect(h.storageRegistry.getOrCreate).toHaveBeenCalledWith(VAULT_TARGET);
    expect(h.teamVaultService.pushToRemote).toHaveBeenCalledWith(VAULT_ID, h.remote, 'team-vault');
    expect(h.teamVaultConfigStore.setLastSyncAt).toHaveBeenCalledWith(VAULT_ID, expect.any(String));
  });

  it('demo mode: no push is scheduled, so the team target is never opened', async () => {
    setDemoModeForTesting(true);
    const h = makeBridge();
    useFakeTimers();

    h.bridge.scheduleTeamVaultAutoPush(VAULT_ID);
    h.bridge.scheduleTeamVaultAutoPush(VAULT_ID, 0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(h.teamVaultConfigStore.getConfig).not.toHaveBeenCalled();
    expectNoRemoteAccess(h);
  });

  it('normal mode: each tick of the auto-poll checks the team target and pulls what changed there', async () => {
    setDemoModeForTesting(false);
    const h = makeBridge();
    useFakeTimers();

    h.bridge.startTeamVaultAutoPollTimer(VAULT_ID);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersToNextTimerAsync();

    expect(h.storageRegistry.getOrCreate).toHaveBeenCalledWith(VAULT_TARGET);
    expect(h.teamVaultService.hasRemoteChangedSinceLastSync).toHaveBeenCalledWith(VAULT_ID, h.remote, 'team-vault');
    expect(h.teamVaultService.pullFromRemote).toHaveBeenCalledWith(VAULT_ID, h.remote, 'team-vault');

    h.bridge.stopTeamVaultAutoPollTimer(VAULT_ID);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('demo mode: no auto-poll is started', async () => {
    setDemoModeForTesting(true);
    const h = makeBridge();
    useFakeTimers();

    h.bridge.startTeamVaultAutoPollTimer(VAULT_ID);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(h.teamVaultConfigStore.getConfig).not.toHaveBeenCalled();
    expectNoRemoteAccess(h);
  });
});

describe('remote profile sync: outside demo mode against demo mode', () => {
  it('normal mode: auto-sync pushes the profiles to the sync target after the debounce', async () => {
    setDemoModeForTesting(false);
    const h = makeBridge();
    useFakeTimers();

    h.bridge.scheduleAutoSync();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersToNextTimerAsync();

    expect(h.storageRegistry.getOrCreate).toHaveBeenCalledWith(PROFILE_TARGET);
    expect(h.profileSyncService.pushToRemote).toHaveBeenCalledWith(h.remote, 'profile-sync');
    expect(h.syncConfigStore.setLastSyncAt).toHaveBeenCalledWith(expect.any(String));
  });

  it('demo mode: auto-sync schedules no push', async () => {
    setDemoModeForTesting(true);
    const h = makeBridge();
    useFakeTimers();

    h.bridge.scheduleAutoSync();
    h.bridge.scheduleAutoSync(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(h.syncConfigStore.getConfig).not.toHaveBeenCalled();
    expectNoRemoteAccess(h);
  });

  it('normal mode: each tick of the auto-pull pulls from the sync target', async () => {
    setDemoModeForTesting(false);
    const h = makeBridge();
    useFakeTimers();

    h.bridge.startAutoPullTimer();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersToNextTimerAsync();

    expect(h.storageRegistry.getOrCreate).toHaveBeenCalledWith(PROFILE_TARGET);
    expect(h.profileSyncService.pullFromRemote).toHaveBeenCalledWith(h.remote, 'profile-sync');

    h.bridge.stopAutoPullTimer();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('demo mode: no auto-pull is started', async () => {
    setDemoModeForTesting(true);
    const h = makeBridge();
    useFakeTimers();

    h.bridge.startAutoPullTimer();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(h.syncConfigStore.getConfig).not.toHaveBeenCalled();
    expectNoRemoteAccess(h);
  });

  it('normal mode: Push, Pull and Compare open the sync target and run against it', async () => {
    setDemoModeForTesting(false);
    const h = makeBridge();

    await h.ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_PUSH);
    await h.ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_PULL);
    await expect(h.ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_COMPARE)).resolves.toMatchObject({ state: 'in_sync' });

    expect(h.storageRegistry.getOrCreate).toHaveBeenCalledTimes(3);
    expect(h.storageRegistry.getOrCreate).toHaveBeenCalledWith(PROFILE_TARGET);
    expect(h.profileSyncService.pushToRemote).toHaveBeenCalledWith(h.remote, 'profile-sync');
    expect(h.profileSyncService.pullFromRemote).toHaveBeenCalledWith(h.remote, 'profile-sync', expect.anything());
    expect(h.profileSyncService.compareWithRemote).toHaveBeenCalledWith(h.remote, 'profile-sync');
    await expect(h.bridge.getSyncProvider(PROFILE_TARGET)).resolves.toBe(h.remote);
  });

  it('demo mode: Push, Pull and Compare are refused with the reason before the sync target is opened', async () => {
    setDemoModeForTesting(true);
    const h = makeBridge();

    for (const channel of [IPC_CHANNELS.PROFILE_SYNC_PUSH, IPC_CHANNELS.PROFILE_SYNC_PULL, IPC_CHANNELS.PROFILE_SYNC_COMPARE]) {
      await expect(h.ipc.invoke(channel), channel).rejects.toThrow(PROFILE_SYNC_DISABLED);
    }
    await expect(h.bridge.getSyncProvider(PROFILE_TARGET)).rejects.toThrow(PROFILE_SYNC_DISABLED);

    expectNoRemoteAccess(h);
  });
});
