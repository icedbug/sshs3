import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => {
  const mockObj = {
    ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
    app: { getPath: vi.fn().mockReturnValue('/tmp/user-data-unused') },
    safeStorage: {
      isEncryptionAvailable: vi.fn().mockReturnValue(false),
      encryptString: vi.fn(),
      decryptString: vi.fn(),
    },
    shell: { openPath: vi.fn().mockResolvedValue('') },
  };
  return { ...mockObj, default: mockObj };
});

import { IpcBridge } from '../../src/main/IpcBridge';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';
import { TeamVaultConfigStore } from '../../src/main/services/TeamVaultConfigStore';

/** Resolves only when `.resolve()` is called — lets a test hold a push/pull "in flight" for as
 * long as it needs, to deliberately create the overlap `beginTeamVaultSync`/`endTeamVaultSync`
 * exist to handle correctly. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('IpcBridge — Team Vault sync status (TEAM_VAULT_SYNC_STATUS reference counting)', () => {
  const VAULT_ID = 'vlt_concurrent';

  function makeBridge() {
    const pushGate = deferred<void>();
    const pullGate = deferred<void>();

    const teamVaultService = {
      isUnlocked: vi.fn().mockReturnValue(true),
      hasRemoteChangedSinceLastSync: vi.fn().mockResolvedValue(true),
      hasUnpushedLocalChanges: vi.fn().mockResolvedValue(false),
      pushToRemote: vi.fn().mockImplementation(() => pushGate.promise),
      pullFromRemote: vi.fn().mockImplementation(() => pullGate.promise),
    };
    const teamVaultConfigStore = {
      getConfig: vi.fn().mockResolvedValue({ target: { id: 't', name: 'n', type: 's3' }, remoteBasePath: 'b' }),
      setLastSyncAt: vi.fn().mockResolvedValue(undefined),
    };
    const storageRegistry = {
      getOrCreate: vi.fn().mockResolvedValue({}),
    };

    const bridge = new IpcBridge({
      teamVaultService: teamVaultService as any,
      teamVaultConfigStore: teamVaultConfigStore as any,
      storageRegistry: storageRegistry as any,
    });

    const sentEvents: Array<{ vaultId: string; syncing: boolean }> = [];
    const fakeWebContents = {
      isDestroyed: () => false,
      send: (channel: string, payload: { vaultId: string; syncing: boolean }) => {
        if (channel === IPC_CHANNELS.TEAM_VAULT_SYNC_STATUS) {
          sentEvents.push(payload);
        }
      },
    };
    bridge.getWebContents = () => fakeWebContents as any;

    return { bridge, teamVaultService, teamVaultConfigStore, storageRegistry, sentEvents, pushGate, pullGate };
  }

  it('turns the sync dot on once and off once for a single push (sanity check)', async () => {
    const { bridge, sentEvents, pushGate } = makeBridge();

    bridge.scheduleTeamVaultAutoPush(VAULT_ID, 0);
    await vi.waitFor(() => expect(sentEvents).toEqual([{ vaultId: VAULT_ID, syncing: true }]));

    pushGate.resolve();
    await vi.waitFor(() =>
      expect(sentEvents).toEqual([
        { vaultId: VAULT_ID, syncing: true },
        { vaultId: VAULT_ID, syncing: false },
      ])
    );
  });

  it('does not turn the sync dot off when a concurrent push finishes while a pull for the same vaultId is still in flight (reference counting)', async () => {
    const { bridge, sentEvents, pushGate, pullGate } = makeBridge();

    // Start a background push (debounced via setTimeout(..., 0)) and, overlapping it, a direct
    // poll-triggered pull for the SAME vaultId — exactly the race item 3 describes: without
    // reference counting, whichever of these finishes first would send `syncing: false` and turn
    // the per-team-tab dot off while the other is still genuinely running.
    bridge.scheduleTeamVaultAutoPush(VAULT_ID, 0);
    await vi.waitFor(() => expect(sentEvents).toEqual([{ vaultId: VAULT_ID, syncing: true }]));

    const pullPromise = (bridge as any).runTeamVaultAutoPoll(VAULT_ID);
    // The pull's own `syncing: true` must be a no-op (count going 1 -> 2), not a second event —
    // asserted by this still being the only entry in sentEvents after it starts.
    await Promise.resolve();
    await Promise.resolve();
    expect(sentEvents).toEqual([{ vaultId: VAULT_ID, syncing: true }]);

    // Finish the push FIRST while the pull is still pending — this must NOT emit `syncing: false`.
    pushGate.resolve();
    // Give the push's own .then chain (inside the setTimeout callback) a tick to run.
    await new Promise((r) => setTimeout(r, 10));
    expect(sentEvents).toEqual([{ vaultId: VAULT_ID, syncing: true }]);

    // Now finish the pull too — only now should `syncing: false` fire, exactly once.
    pullGate.resolve();
    await pullPromise;
    await vi.waitFor(() =>
      expect(sentEvents).toEqual([
        { vaultId: VAULT_ID, syncing: true },
        { vaultId: VAULT_ID, syncing: false },
      ])
    );
  });

  // M1: a refused downgrade must be visible to the user, not just a log line in a background poll.
  it('tells the renderer when the poll finds a remote file in an older format than the one already seen', async () => {
    const { bridge, teamVaultService } = makeBridge();
    teamVaultService.pullFromRemote.mockImplementation(() =>
      Promise.reject(Object.assign(new Error('older format'), { name: 'TeamVaultFormatDowngradeError' }))
    );
    const channels: string[] = [];
    bridge.getWebContents = (() => ({ isDestroyed: () => false, send: (channel: string) => channels.push(channel) })) as any;

    await (bridge as any).runTeamVaultAutoPoll(VAULT_ID);

    expect(channels).toContain(IPC_CHANNELS.TEAM_VAULT_REMOTE_CHANGED);
  });

  // Security review of M1: the adapter that hands the config store to TeamVaultService forwarded only (vaultId, entry), so
  // lastSyncedRevision and the highest-format mark were never persisted and clearSyncState was never wired. Goes through
  // the REAL adapter and the REAL store, not a fake one.
  it('persists the synced revision and the highest remote format through the real config-store adapter, and clears them', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sshs3-tv-adapter-'));
    try {
      const store = new TeamVaultConfigStore(path.join(dir, 'team-vault-sync-config.json'));
      const bridge = new IpcBridge({ teamVaultConfigStore: store } as any);
      const adapter = (bridge.teamVaultService as any).configStore;

      await adapter.setLastKnownRemoteEntry('vlt_x', null, 7, 2);
      expect(await store.getConfig('vlt_x')).toMatchObject({ lastSyncedRevision: 7, remoteFormatVersion: 2 });

      await adapter.clearSyncState('vlt_x');
      const cleared = await store.getConfig('vlt_x');
      expect(cleared.lastSyncedRevision).toBeUndefined();
      expect(cleared.remoteFormatVersion).toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
