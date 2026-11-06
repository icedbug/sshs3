import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Every store an IpcBridge creates by default lives under app.getPath('userData'): a fresh temp dir per test.
const electronPaths = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => {
  const mockObj = {
    ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
    app: { getPath: () => electronPaths.userData || os.tmpdir() },
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
import { outwardSyncDisabledReason } from '../../src/main/demo/outwardSync';
import { S3WorkspaceSyncService, type S3WorkspaceSyncCallbacks } from '../../src/main/ai/hub/S3WorkspaceSyncService';
import { HubService, type HubHost } from '../../src/main/ai/hub/HubService';
import { IpcBridge } from '../../src/main/IpcBridge';
import { registerSyncHandlers } from '../../src/main/ipc/syncHandlers';
import { registerTeamVaultHandlers } from '../../src/main/ipc/teamVaultHandlers';
import { ProfileStore } from '../../src/main/profile/ProfileStore';
import { DotfilePoolStore } from '../../src/main/dotfiles/DotfilePoolStore';
import { SettingsStore } from '../../src/main/settings/SettingsStore';
import { SyncConfigStore } from '../../src/main/services/SyncConfigStore';
import { SyncCryptoService } from '../../src/main/services/SyncCryptoService';
import { ProfileSyncService } from '../../src/main/services/ProfileSyncService';
import { TeamVaultService } from '../../src/main/services/TeamVaultService';
import { TeamVaultConfigStore } from '../../src/main/services/TeamVaultConfigStore';
import { IPC_CHANNELS, type StorageConnectConfig } from '../../src/shared/types/ipc';
import type { IStorageProvider } from '../../src/shared/types/storage';

const S3_DISABLED = /S3 team workspace sync is disabled in demo mode/;
const VAULT_DISABLED = /Team Vault sync is disabled in demo mode/;
const PROFILE_SYNC_DISABLED = /Remote profile sync is disabled in demo mode/;

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
  setDemoModeForTesting(undefined);
  electronPaths.userData = '';
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  disposals.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A remote target that records every call made on it (and fails it): none may happen in demo mode. */
function recordingRemote(): { provider: IStorageProvider; calls: string[] } {
  const calls: string[] = [];
  const touched = (name: string) => async (): Promise<never> => {
    calls.push(name);
    throw new Error(`the remote was contacted (${name})`);
  };
  const provider: IStorageProvider = {
    id: 'team-remote',
    name: 'Team remote',
    type: 's3',
    list: touched('list'),
    stat: touched('stat'),
    createFolder: touched('createFolder'),
    delete: touched('delete'),
    rename: touched('rename'),
    createReadStream: touched('createReadStream'),
    createWriteStream: touched('createWriteStream'),
    readFile: touched('readFile'),
    writeFile: touched('writeFile'),
  };
  return { provider, calls };
}

/** A team bucket as a user would have connected it before (S3WorkspaceSyncService's stored format). */
async function writeConfiguredS3Workspace(file: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    JSON.stringify({
      enabled: true,
      region: 'eu-north-1',
      bucket: 'team-bucket',
      prefix: 'team',
      accessKeyId: 'AKIATEAM',
      // No OS keyring under test, so secrets are stored (and read back) as plaintext.
      secretAccessKeyEncrypted: 'team-secret',
      forcePathStyle: true,
    })
  );
}

const S3_TARGET: StorageConnectConfig = {
  id: 'team-target',
  name: 'Team bucket',
  type: 's3',
  s3Config: {
    id: 'team-target',
    name: 'Team bucket',
    region: 'eu-north-1',
    accessKeyId: 'AKIATEAM',
    secretAccessKey: 'team-secret',
  },
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

describe('outwardSyncDisabledReason', () => {
  it('names the sync and demo mode, and is absent outside demo mode', () => {
    setDemoModeForTesting(true);
    expect(outwardSyncDisabledReason('Team Vault sync')).toMatch(VAULT_DISABLED);
    setDemoModeForTesting(false);
    expect(outwardSyncDisabledReason('Team Vault sync')).toBeUndefined();
  });
});

describe('S3 team workspace sync in demo mode', () => {
  function createService(file: string) {
    const remote = recordingRemote();
    const providerFactory = vi.fn(() => remote.provider);
    const getLocalState = vi.fn<S3WorkspaceSyncCallbacks['getLocalState']>(async () => ({
      actor: 'demo-user',
      servers: [],
      memories: [],
      activityLog: [],
      deletedServerIds: {},
      deletedMemoryIds: {},
      activeTerminals: [],
    }));
    const service = new S3WorkspaceSyncService(
      file,
      { getLocalState, applyMergedState: async () => {}, onStateChanged: () => {} },
      { providerFactory, pushDebounceMs: 0, pollIntervalMs: 5, presenceIntervalMs: 5 }
    );
    disposals.push(() => service.dispose());
    return { service, providerFactory, getLocalState, remote };
  }

  it('never contacts a configured bucket and reports why', async () => {
    const dir = await tempDir('sshs3-demo-s3-');
    const file = path.join(dir, 's3-workspace.json');
    await writeConfiguredS3Workspace(file);
    setDemoModeForTesting(true);
    const { service, providerFactory, getLocalState, remote } = createService(file);

    await service.start();
    service.startTimers();
    service.schedulePush(0);
    service.schedulePresenceUpdate();
    await service.pollOnce();
    await service.publishAndRefreshPresence();
    await service.reloadFromDisk();
    await settle();

    await expect(service.syncNow({ forcePush: true })).rejects.toThrow(S3_DISABLED);
    expect(providerFactory).not.toHaveBeenCalled();
    expect(getLocalState).not.toHaveBeenCalled();
    expect(remote.calls).toEqual([]);

    const status = service.getStatus();
    expect(status.configured).toBe(true);
    expect(status.connected).toBe(false);
    expect(status.syncing).toBe(false);
    expect(status.error).toMatch(S3_DISABLED);
    expect(status.syncDisabledReason).toMatch(S3_DISABLED);
  });

  it('refuses to connect a team bucket, and saves nothing', async () => {
    const dir = await tempDir('sshs3-demo-s3-');
    const file = path.join(dir, 's3-workspace.json');
    setDemoModeForTesting(true);
    const { service, providerFactory } = createService(file);
    await service.start();

    await expect(
      service.configure({
        enabled: true,
        bucket: 'team-bucket',
        region: 'eu-north-1',
        prefix: 'team',
        accessKeyId: 'AKIATEAM',
        secretAccessKey: 'team-secret',
      })
    ).rejects.toThrow(S3_DISABLED);
    await expect(fs.access(file)).rejects.toThrow();
    // An explicit "sync now" says why rather than quietly doing nothing.
    await expect(service.syncNow()).rejects.toThrow(S3_DISABLED);
    expect(providerFactory).not.toHaveBeenCalled();

    // Nothing connected: the status says so, without an error banner for a bucket that is not there.
    const status = service.getStatus();
    expect(status.configured).toBe(false);
    expect(status.error).toBeUndefined();
    expect(status.syncDisabledReason).toMatch(S3_DISABLED);
  });

  it('stays local when another tenant connects a bucket on disk (web)', async () => {
    const dir = await tempDir('sshs3-demo-s3-');
    const file = path.join(dir, 's3-workspace.json');
    setDemoModeForTesting(true);
    const { service, providerFactory } = createService(file);
    await service.start();

    await writeConfiguredS3Workspace(file);
    await service.reloadFromDisk();
    await settle();

    expect(service.getStatus().configured).toBe(true);
    expect(service.getStatus().connected).toBe(false);
    expect(providerFactory).not.toHaveBeenCalled();
  });

  it('can still be disconnected (a local change)', async () => {
    const dir = await tempDir('sshs3-demo-s3-');
    const file = path.join(dir, 's3-workspace.json');
    await writeConfiguredS3Workspace(file);
    setDemoModeForTesting(true);
    const { service } = createService(file);
    await service.start();

    await service.disconnect();
    expect(service.getStatus().configured).toBe(false);
    expect(service.getStatus().enabled).toBe(false);
  });

  it('reports nothing outside demo mode', async () => {
    const dir = await tempDir('sshs3-demo-s3-');
    setDemoModeForTesting(false);
    const { service } = createService(path.join(dir, 's3-workspace.json'));
    await service.start();
    expect('syncDisabledReason' in service.getStatus()).toBe(false);
    await expect(service.syncNow()).resolves.toBeUndefined();
  });
});

describe('HubService in demo mode', () => {
  async function createHub(dir: string, host: Partial<HubHost> = {}) {
    const hub = new HubService(
      {
        changed: () => {},
        inventoryTargets: async () => [],
        backgroundChanged: async () => {},
        openSchedule: async () => 's1',
        show: () => {},
        aiConfigFilePath: path.join(dir, 'ai-config.json'),
        workspaceServers: async () => [],
        ...host,
      },
      path.join(dir, 'ai-hub')
    );
    disposals.push(() => hub.dispose());
    await hub.initialize();
    return hub;
  }

  it('never syncs the team S3 workspace, from requests, activity or start-up', async () => {
    const dir = await tempDir('sshs3-demo-hub-');
    const s3ConfigFilePath = path.join(dir, 'ai-hub', 's3-workspace.json');
    await writeConfiguredS3Workspace(s3ConfigFilePath);
    setDemoModeForTesting(true);
    const remote = recordingRemote();
    const s3ProviderFactory = vi.fn(() => remote.provider);
    const hub = await createHub(dir, { s3ConfigFilePath, s3ProviderFactory });

    await hub.request({
      action: 'activity-record',
      event: { actor: 'demo-user', targetLabel: 'netapp-aff-a800-01a', kind: 'note', summary: 'Checked the cluster' },
    });
    await expect(hub.request({ action: 'workspace-s3-sync-now' })).rejects.toThrow(S3_DISABLED);
    await expect(
      hub.request({
        action: 'workspace-s3-configure',
        config: { enabled: true, bucket: 'other-bucket', accessKeyId: 'AKIAOTHER', secretAccessKey: 'other-secret' },
      })
    ).rejects.toThrow(S3_DISABLED);
    await settle();

    const snap = await hub.snapshot();
    expect(snap.s3Workspace?.configured).toBe(true);
    expect(snap.s3Workspace?.bucket).toBe('team-bucket');
    expect(snap.s3Workspace?.connected).toBe(false);
    expect(snap.s3Workspace?.error).toMatch(S3_DISABLED);
    expect(snap.s3Workspace?.syncDisabledReason).toMatch(S3_DISABLED);
    expect(s3ProviderFactory).not.toHaveBeenCalled();
    expect(remote.calls).toEqual([]);
  });

  /** A shared workspace file (e.g. on a team share) holding one teammate's server. */
  async function writeSharedWorkspaceFile(file: string, serverId: string): Promise<string> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const content = JSON.stringify({
      version: 1,
      updatedAt: Date.now(),
      servers: [
        {
          id: serverId,
          name: `${serverId}-name`,
          host: '192.0.2.10',
          port: 22,
          username: 'ops',
          shared: true,
          updatedAt: new Date().toISOString(),
        },
      ],
      memories: [],
      activityLog: [],
      deletedServerIds: {},
      deletedMemoryIds: {},
    });
    await fs.writeFile(file, content);
    return content;
  }

  it('leaves a team share named by the preference or SSHS3_SHARED_WORKSPACE_FILE alone', async () => {
    const dir = await tempDir('sshs3-demo-hub-');
    electronPaths.userData = path.join(dir, 'profile', 'demo-workspace');
    const teamFile = path.join(dir, 'team-share', 'sshs3-workspace.json');
    const original = await writeSharedWorkspaceFile(teamFile, 'srv-team-1');
    setDemoModeForTesting(true);
    const hub = await createHub(electronPaths.userData);

    hub.store.data.preferences.sharedWorkspacePath = teamFile;
    let snap = await hub.snapshot();
    expect((snap.workspaceServers ?? []).some((s) => s.id === 'srv-team-1')).toBe(false);

    delete hub.store.data.preferences.sharedWorkspacePath;
    const previous = process.env.SSHS3_SHARED_WORKSPACE_FILE;
    process.env.SSHS3_SHARED_WORKSPACE_FILE = teamFile;
    try {
      snap = await hub.snapshot();
      await hub.recordServerSaved('srv-demo-local');
      await hub.recordServerDeleted('srv-demo-local');
    } finally {
      if (previous === undefined) delete process.env.SSHS3_SHARED_WORKSPACE_FILE;
      else process.env.SSHS3_SHARED_WORKSPACE_FILE = previous;
    }
    expect((snap.workspaceServers ?? []).some((s) => s.id === 'srv-team-1')).toBe(false);
    // Neither read into the demo workspace nor written with it.
    expect(await fs.readFile(teamFile, 'utf8')).toBe(original);
  });

  it('still shares through a file inside its own demo data directory (the web demo server)', async () => {
    const dir = await tempDir('sshs3-demo-hub-');
    electronPaths.userData = path.join(dir, 'demo-workspace');
    const serverFile = path.join(electronPaths.userData, 'shared-workspace', 'shared-workspace.json');
    await writeSharedWorkspaceFile(serverFile, 'srv-demo-peer');
    setDemoModeForTesting(true);
    const hub = await createHub(path.join(electronPaths.userData, 'users', 'u1'));

    hub.store.data.preferences.sharedWorkspacePath = serverFile;
    const snap = await hub.snapshot();
    expect((snap.workspaceServers ?? []).some((s) => s.id === 'srv-demo-peer')).toBe(true);
  });

  it('uses a team share outside demo mode', async () => {
    const dir = await tempDir('sshs3-demo-hub-');
    electronPaths.userData = path.join(dir, 'profile');
    const teamFile = path.join(dir, 'team-share', 'sshs3-workspace.json');
    await writeSharedWorkspaceFile(teamFile, 'srv-team-1');
    setDemoModeForTesting(false);
    const hub = await createHub(electronPaths.userData);

    hub.store.data.preferences.sharedWorkspacePath = teamFile;
    const snap = await hub.snapshot();
    expect((snap.workspaceServers ?? []).some((s) => s.id === 'srv-team-1')).toBe(true);
  });
});

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

describe('Team Vault and remote profile sync in demo mode', () => {
  const VAULT_ID = 'vlt_demo-team';

  async function createBridge() {
    const dir = await tempDir('sshs3-demo-bridge-');
    electronPaths.userData = dir;
    const remote = recordingRemote();
    const storageRegistry = {
      getOrCreate: vi.fn(async () => remote.provider),
      has: vi.fn().mockReturnValue(false),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const profileStore = new ProfileStore(path.join(dir, 'profiles.json'));
    const dotfilePoolStore = new DotfilePoolStore(path.join(dir, 'dotfile-pools.json'));
    const settingsStore = new SettingsStore(path.join(dir, 'settings.json'));
    const syncConfigStore = new SyncConfigStore(path.join(dir, 'sync-config.json'));
    const syncCryptoService = new SyncCryptoService();
    const profileSyncService = new ProfileSyncService(profileStore, dotfilePoolStore, settingsStore, syncCryptoService, {
      sshConfigPath: path.join(dir, 'ssh_config'),
      knownHostsPath: path.join(dir, 'known_hosts'),
    });
    const teamVaultService = new TeamVaultService({ baseDir: dir });
    const teamVaultConfigStore = new TeamVaultConfigStore(path.join(dir, 'team-vault-config.json'));

    // Both syncs are set up as a user would have: a remote target, and profile auto-sync switched on.
    await syncConfigStore.setTarget(S3_TARGET, 'team-bucket');
    await syncConfigStore.setAutoSync(true);
    await teamVaultConfigStore.setTarget(VAULT_ID, S3_TARGET, 'team-bucket');

    const ipc = new MockIpcMain();
    const bridge = new IpcBridge({
      ipcMain: ipc as any,
      storageRegistry: storageRegistry as any,
      profileStore,
      dotfilePoolStore,
      settingsStore,
      syncConfigStore,
      syncCryptoService,
      profileSyncService,
      teamVaultService,
      teamVaultConfigStore,
    });
    const events: string[] = [];
    bridge.getWebContents = () => ({ isDestroyed: () => false, send: (channel: string) => events.push(channel) }) as any;
    registerSyncHandlers(bridge);
    registerTeamVaultHandlers(bridge);
    return { bridge, ipc, remote, storageRegistry, events, syncCryptoService, teamVaultService, profileSyncService };
  }

  beforeEach(() => {
    setDemoModeForTesting(true);
  });

  it('runs no background push, pull or poll', async () => {
    const { bridge, remote, storageRegistry, events } = await createBridge();

    bridge.scheduleAutoSync(0);
    bridge.startAutoPullTimer();
    bridge.scheduleTeamVaultAutoPush(VAULT_ID, 0);
    bridge.startTeamVaultAutoPollTimer(VAULT_ID);
    await settle();

    const internals = bridge as any;
    expect(internals.autoSyncTimer).toBeNull();
    expect(internals.autoPullTimer).toBeNull();
    expect(internals.teamVaultAutoPushTimers.size).toBe(0);
    expect(internals.teamVaultAutoPollTimers.size).toBe(0);
    expect(storageRegistry.getOrCreate).not.toHaveBeenCalled();
    expect(remote.calls).toEqual([]);
    // No "syncing" dot either.
    expect(events).not.toContain(IPC_CHANNELS.TEAM_VAULT_SYNC_STATUS);
  });

  it('refuses every remote profile-sync request before connecting, and says why in the status', async () => {
    const { ipc, remote, storageRegistry, syncCryptoService } = await createBridge();

    await expect(ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_PUSH)).rejects.toThrow(PROFILE_SYNC_DISABLED);
    await expect(ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_PULL)).rejects.toThrow(PROFILE_SYNC_DISABLED);
    await expect(ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_COMPARE)).rejects.toThrow(PROFILE_SYNC_DISABLED);
    await expect(
      ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_ENABLE, { topologyPassword: 'topology', credentialsPassword: 'credentials' })
    ).rejects.toThrow(PROFILE_SYNC_DISABLED);
    await expect(ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_UNLOCK_SMARTCARD)).rejects.toThrow(PROFILE_SYNC_DISABLED);
    expect(syncCryptoService.isUnlocked('topology')).toBe(false);

    const status = await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_SET_AUTO_SYNC, true);
    expect(status.configured).toBe(true);
    expect(status.syncDisabledReason).toMatch(PROFILE_SYNC_DISABLED);
    expect((await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_STATUS)).syncDisabledReason).toMatch(PROFILE_SYNC_DISABLED);

    // Resetting sync clears this (demo) machine's own setup and leaves the remote untouched.
    const wiped = await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_WIPE);
    expect(wiped.configured).toBe(false);
    expect(wiped.remoteWipeErrors.join('\n')).toMatch(PROFILE_SYNC_DISABLED);

    await settle();
    expect(storageRegistry.getOrCreate).not.toHaveBeenCalled();
    expect(remote.calls).toEqual([]);
  });

  it('refuses every Team Vault remote request without touching the target, and says why in the status', async () => {
    const { ipc, remote } = await createBridge();

    await expect(ipc.invoke(IPC_CHANNELS.TEAM_VAULT_PUSH, VAULT_ID)).rejects.toThrow(VAULT_DISABLED);
    await expect(ipc.invoke(IPC_CHANNELS.TEAM_VAULT_PULL, VAULT_ID)).rejects.toThrow(VAULT_DISABLED);
    // Refused, not "no vault there": the join flow would otherwise tell the user the target is empty.
    await expect(ipc.invoke(IPC_CHANNELS.TEAM_VAULT_HAS_REMOTE_VAULT, VAULT_ID)).rejects.toThrow(VAULT_DISABLED);
    expect(await ipc.invoke(IPC_CHANNELS.TEAM_VAULT_GET_SYNC_PREVIEW, VAULT_ID)).toEqual({
      hasUnpushedLocalChanges: false,
      remoteChanged: false,
    });

    const status = await ipc.invoke(IPC_CHANNELS.TEAM_VAULT_GET_STATUS, VAULT_ID);
    expect(status.remoteConfigured).toBe(true);
    expect(status.syncDisabledReason).toMatch(VAULT_DISABLED);
    expect(remote.calls).toEqual([]);
  });

  it('keeps the sync services themselves from reaching a remote', async () => {
    const { teamVaultService, profileSyncService, remote } = await createBridge();

    await expect(teamVaultService.pushToRemote(VAULT_ID, remote.provider, 'team-bucket')).rejects.toThrow(VAULT_DISABLED);
    await expect(teamVaultService.pullFromRemote(VAULT_ID, remote.provider, 'team-bucket')).rejects.toThrow(VAULT_DISABLED);
    await expect(teamVaultService.mergeWithRemote(VAULT_ID, remote.provider, 'team-bucket')).rejects.toThrow(VAULT_DISABLED);
    await expect(teamVaultService.hasRemoteVault(VAULT_ID, remote.provider, 'team-bucket')).rejects.toThrow(VAULT_DISABLED);
    await expect(
      teamVaultService.hasRemoteChangedSinceLastSync(VAULT_ID, remote.provider, 'team-bucket')
    ).rejects.toThrow(VAULT_DISABLED);
    await expect(teamVaultService.getSyncPreview(VAULT_ID, remote.provider, 'team-bucket')).rejects.toThrow(VAULT_DISABLED);

    await expect(profileSyncService.pushToRemote(remote.provider, 'team-bucket')).rejects.toThrow(PROFILE_SYNC_DISABLED);
    await expect(profileSyncService.pullFromRemote(remote.provider, 'team-bucket')).rejects.toThrow(PROFILE_SYNC_DISABLED);
    await expect(profileSyncService.compareWithRemote(remote.provider, 'team-bucket')).rejects.toThrow(PROFILE_SYNC_DISABLED);
    await expect(profileSyncService.wipeRemote(remote.provider, 'team-bucket')).rejects.toThrow(PROFILE_SYNC_DISABLED);
    await expect(profileSyncService.hasRemoteData(remote.provider, 'team-bucket')).rejects.toThrow(PROFILE_SYNC_DISABLED);

    expect(remote.calls).toEqual([]);
  });

  it('reports nothing outside demo mode', async () => {
    const { bridge } = await createBridge();
    setDemoModeForTesting(false);
    expect('syncDisabledReason' in (await bridge.buildSyncStatus())).toBe(false);
    expect('syncDisabledReason' in (await bridge.buildTeamVaultStatus(VAULT_ID))).toBe(false);
  });
});
