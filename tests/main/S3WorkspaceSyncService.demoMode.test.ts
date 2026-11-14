import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// HubService resolves a few paths under app.getPath('userData'): a temp dir of the test's own.
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
import {
  encodeS3WorkspaceInvite,
  S3WorkspaceSyncService,
  type S3WorkspaceSyncCallbacks,
} from '../../src/main/ai/hub/S3WorkspaceSyncService';
import { HubService } from '../../src/main/ai/hub/HubService';
import type { HubRequest, S3WorkspaceConfig } from '../../src/shared/types/aiHub';
import type { FileEntry, IStorageProvider } from '../../src/shared/types/storage';

/**
 * Every entry point of the S3 team workspace sync (start-up, the poll and presence timers, the debounced
 * push after a local change, the presence update after a terminal change, "Sync now", connecting a bucket,
 * picking up a bucket connected elsewhere), run once outside and once inside demo mode against a bucket
 * that records every call. Outside demo mode each reaches the bucket; in demo mode none does.
 */

const S3_DISABLED = /S3 team workspace sync is disabled in demo mode/;
const BUCKET = 'team-bucket';
const WORKSPACE_OBJECT = 'team-bucket/team/workspace.json';
const PRESENCE_DIR = 'team-bucket/team/presence';
const OWN_PRESENCE = 'team-bucket/team/presence/tester.json';
const TEAM_BUCKET: S3WorkspaceConfig = {
  enabled: true,
  region: 'eu-north-1',
  bucket: BUCKET,
  prefix: 'team',
  accessKeyId: 'AKIATEAM',
  secretAccessKey: 'team-secret', // pragma: allowlist secret
};

/** Fakes only the timers, so file I/O and promises keep running for real. */
function useFakeTimers(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
}

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const dispose of disposals.splice(0).reverse()) await dispose();
  setDemoModeForTesting(undefined);
  electronPaths.userData = '';
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  disposals.push(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
}

const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

/** A team bucket in memory that records every call made on it, as "<method> <path>". */
function recordingBucket() {
  const objects = new Map<string, { data: Buffer; mtime: string }>();
  const log: string[] = [];
  let writes = 0;
  const missing = (key: string) => Object.assign(new Error(`NoSuchKey: ${key}`), { name: 'NoSuchKey' });
  const entryOf = (key: string, object: { data: Buffer; mtime: string }): FileEntry => ({
    name: path.posix.basename(key),
    path: key,
    size: object.data.length,
    isDirectory: false,
    mtime: object.mtime,
  });
  const provider: IStorageProvider & { connect(): Promise<void> } = {
    id: 's3-workspace-sync',
    name: 'Team bucket',
    type: 's3',
    connect: async () => {
      log.push('connect');
    },
    disconnect: async () => {
      log.push('disconnect');
    },
    stat: async (key) => {
      log.push(`stat ${key}`);
      const object = objects.get(key);
      if (!object) throw missing(key);
      return entryOf(key, object);
    },
    readFile: async (key) => {
      log.push(`readFile ${key}`);
      const object = objects.get(key);
      if (!object) throw missing(key);
      return Buffer.from(object.data);
    },
    writeFile: async (key, data) => {
      log.push(`writeFile ${key}`);
      writes += 1;
      objects.set(key, { data: Buffer.from(data), mtime: new Date(Date.UTC(2026, 0, 1, 0, 0, writes)).toISOString() });
    },
    list: async (dir) => {
      log.push(`list ${dir}`);
      return [...objects]
        .filter(([key]) => key.startsWith(`${dir}/`) && !key.slice(dir.length + 1).includes('/'))
        .map(([key, object]) => entryOf(key, object));
    },
    createFolder: async (dir) => {
      log.push(`createFolder ${dir}`);
    },
    delete: async (key) => {
      log.push(`delete ${key}`);
      objects.delete(key);
    },
    rename: async (from) => {
      log.push(`rename ${from}`);
    },
    createReadStream: async (key) => {
      log.push(`createReadStream ${key}`);
      throw new Error('the workspace sync reads whole objects');
    },
    createWriteStream: async (key) => {
      log.push(`createWriteStream ${key}`);
      throw new Error('the workspace sync writes whole objects');
    },
  };
  return { provider, log };
}

const writesOf = (log: string[], key: string): number => log.filter((line) => line === `writeFile ${key}`).length;

/** A team bucket as a user connected it earlier (no OS keyring under test, so the secret is stored as is). */
async function writeConnectedBucket(file: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    JSON.stringify({
      enabled: true,
      region: 'eu-north-1',
      bucket: BUCKET,
      prefix: 'team',
      accessKeyId: 'AKIATEAM',
      secretAccessKeyEncrypted: 'team-secret', // pragma: allowlist secret
      forcePathStyle: true,
    })
  );
}

async function createService(options: { connected?: boolean; pollIntervalMs?: number; presenceIntervalMs?: number } = {}) {
  const dir = await tempDir('sshs3-s3-sync-mode-');
  const file = path.join(dir, 's3-workspace.json');
  if (options.connected ?? true) await writeConnectedBucket(file);
  const bucket = recordingBucket();
  const providerFactory = vi.fn((_config: S3WorkspaceConfig) => bucket.provider);
  const getLocalState = vi.fn<S3WorkspaceSyncCallbacks['getLocalState']>(async () => ({
    actor: 'tester',
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
    {
      providerFactory,
      pollIntervalMs: options.pollIntervalMs ?? 60_000,
      presenceIntervalMs: options.presenceIntervalMs ?? 60_000,
      pushDebounceMs: 0,
    }
  );
  disposals.push(() => service.dispose());
  return { service, file, bucket, providerFactory, getLocalState };
}

/** Until the sync under way has finished (its last step saves the config file). */
async function waitUntilSynced(service: S3WorkspaceSyncService): Promise<void> {
  await vi.waitFor(
    () => {
      const status = service.getStatus();
      expect(status.connected).toBe(true);
      expect(status.syncing).toBe(false);
    },
    { timeout: 5_000 }
  );
}

describe('S3 team workspace sync: outside demo mode against demo mode', () => {
  it('normal mode: start-up syncs with the connected bucket', async () => {
    setDemoModeForTesting(false);
    const { service, bucket, providerFactory, getLocalState } = await createService();

    await service.start();
    await waitUntilSynced(service);

    expect(providerFactory).toHaveBeenCalledTimes(1);
    expect(providerFactory).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: BUCKET, prefix: 'team', accessKeyId: 'AKIATEAM' })
    );
    expect(getLocalState).toHaveBeenCalled();
    expect(bucket.log).toEqual(
      expect.arrayContaining([
        'connect',
        `stat ${WORKSPACE_OBJECT}`,
        `writeFile ${WORKSPACE_OBJECT}`,
        `writeFile ${OWN_PRESENCE}`,
        `list ${PRESENCE_DIR}`,
      ])
    );
    const status = service.getStatus();
    expect(status.error).toBeUndefined();
    expect('syncDisabledReason' in status).toBe(false);
  });

  it('demo mode: start-up leaves the connected bucket alone, and no timer reaches it later', async () => {
    setDemoModeForTesting(true);
    const { service, bucket, providerFactory, getLocalState } = await createService({
      pollIntervalMs: 5,
      presenceIntervalMs: 5,
    });

    await service.start();
    await settle();

    expect(providerFactory).not.toHaveBeenCalled();
    expect(getLocalState).not.toHaveBeenCalled();
    expect(bucket.log).toEqual([]);
    const status = service.getStatus();
    expect(status).toMatchObject({ configured: true, connected: false, syncing: false });
    expect(status.syncDisabledReason).toMatch(S3_DISABLED);
  });

  it('normal mode: every tick of the poll and presence timers reaches the bucket', async () => {
    setDemoModeForTesting(false);
    const { service, bucket } = await createService({ pollIntervalMs: 1_000, presenceIntervalMs: 1_000 });
    await service.load();

    useFakeTimers();
    try {
      service.startTimers();
      expect(vi.getTimerCount()).toBe(2);
      await vi.advanceTimersByTimeAsync(1_000);
      // The poll looks at the workspace object, the heartbeat publishes this user's presence.
      expect(bucket.log).toContain(`stat ${WORKSPACE_OBJECT}`);
      expect(bucket.log).toContain(`writeFile ${OWN_PRESENCE}`);
    } finally {
      service.stopTimers();
      vi.useRealTimers();
    }
  });

  it('demo mode: no poll or presence timer is started', async () => {
    setDemoModeForTesting(true);
    const { service, bucket, providerFactory } = await createService({ pollIntervalMs: 1_000, presenceIntervalMs: 1_000 });
    await service.load();

    useFakeTimers();
    try {
      service.startTimers();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(10_000);
    } finally {
      service.stopTimers();
      vi.useRealTimers();
    }
    expect(providerFactory).not.toHaveBeenCalled();
    expect(bucket.log).toEqual([]);
  });

  it('normal mode: a terminal change publishes presence, and a local change is pushed', async () => {
    setDemoModeForTesting(false);
    const { service, bucket } = await createService();
    await service.load();

    service.schedulePresenceUpdate();
    await vi.waitFor(() => expect(bucket.log).toContain(`writeFile ${OWN_PRESENCE}`), { timeout: 5_000 });
    await vi.waitFor(() => expect(service.getPresence().map((entry) => entry.actor)).toContain('tester'), {
      timeout: 5_000,
    });

    service.schedulePush(10);
    await vi.waitFor(() => expect(bucket.log).toContain(`writeFile ${WORKSPACE_OBJECT}`), { timeout: 5_000 });
    await waitUntilSynced(service);
  });

  it('demo mode: neither a terminal change nor a local change reaches the bucket', async () => {
    setDemoModeForTesting(true);
    const { service, bucket, providerFactory, getLocalState } = await createService();
    await service.load();

    service.schedulePresenceUpdate();
    service.schedulePush(10);
    await settle();

    expect(providerFactory).not.toHaveBeenCalled();
    expect(getLocalState).not.toHaveBeenCalled();
    expect(bucket.log).toEqual([]);
    expect(service.getPresence()).toEqual([]);
  });

  it('normal mode: "Sync now" writes the workspace to the bucket', async () => {
    setDemoModeForTesting(false);
    const { service, bucket } = await createService();
    await service.load();

    await service.syncNow({ forcePush: true });

    expect(bucket.log).toEqual(expect.arrayContaining([`stat ${WORKSPACE_OBJECT}`, `writeFile ${WORKSPACE_OBJECT}`]));
    expect(service.getStatus().connected).toBe(true);
  });

  it('demo mode: "Sync now" is refused with the reason, before the bucket is reached', async () => {
    setDemoModeForTesting(true);
    const { service, bucket, providerFactory, getLocalState } = await createService();
    await service.load();

    await expect(service.syncNow({ forcePush: true })).rejects.toThrow(S3_DISABLED);

    expect(providerFactory).not.toHaveBeenCalled();
    expect(getLocalState).not.toHaveBeenCalled();
    expect(bucket.log).toEqual([]);
  });

  it('normal mode: connecting a team bucket saves it and syncs straight away', async () => {
    setDemoModeForTesting(false);
    const { service, file, bucket } = await createService({ connected: false });
    await service.start();
    expect(bucket.log).toEqual([]);

    await service.configure(TEAM_BUCKET);

    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toMatchObject({ enabled: true, bucket: BUCKET, prefix: 'team' });
    expect(bucket.log).toContain(`writeFile ${WORKSPACE_OBJECT}`);
    expect(service.getStatus()).toMatchObject({ configured: true, connected: true });
  });

  it('demo mode: connecting a team bucket, by its settings or an invite code, is refused and saves nothing', async () => {
    setDemoModeForTesting(true);
    const { service, file, bucket, providerFactory } = await createService({ connected: false });
    await service.start();

    await expect(service.configure(TEAM_BUCKET)).rejects.toThrow(S3_DISABLED);
    await expect(service.configure(undefined, encodeS3WorkspaceInvite(TEAM_BUCKET))).rejects.toThrow(S3_DISABLED);

    await expect(fs.access(file)).rejects.toThrow();
    expect(providerFactory).not.toHaveBeenCalled();
    expect(bucket.log).toEqual([]);
    expect(service.getStatus().configured).toBe(false);
  });

  it('normal mode: a bucket connected on disk by another window or tenant is picked up and synced', async () => {
    setDemoModeForTesting(false);
    const { service, file, bucket } = await createService({ connected: false });
    await service.start();

    await writeConnectedBucket(file);
    await service.reloadFromDisk();

    expect(bucket.log).toContain(`writeFile ${WORKSPACE_OBJECT}`);
    expect(service.getStatus()).toMatchObject({ configured: true, connected: true });
  });

  it('demo mode: a bucket connected on disk by someone else stays unconnected', async () => {
    setDemoModeForTesting(true);
    const { service, file, bucket, providerFactory } = await createService({ connected: false });
    await service.start();

    await writeConnectedBucket(file);
    await service.reloadFromDisk();
    await settle();

    expect(service.getStatus()).toMatchObject({ configured: true, connected: false });
    expect(providerFactory).not.toHaveBeenCalled();
    expect(bucket.log).toEqual([]);
  });
});

describe('HubService and the S3 team workspace: outside demo mode against demo mode', () => {
  async function createHub() {
    const dir = await tempDir('sshs3-s3-sync-hub-');
    electronPaths.userData = dir;
    const s3ConfigFilePath = path.join(dir, 'ai-hub', 's3-workspace.json');
    await writeConnectedBucket(s3ConfigFilePath);
    const bucket = recordingBucket();
    const s3ProviderFactory = vi.fn((_config: S3WorkspaceConfig) => bucket.provider);
    const hub = new HubService(
      {
        changed: () => {},
        inventoryTargets: async () => [],
        backgroundChanged: async () => {},
        openSchedule: async () => 's1',
        show: () => {},
        aiConfigFilePath: path.join(dir, 'ai-config.json'),
        workspaceServers: async () => [],
        defaultActorName: 'tester',
        s3ConfigFilePath,
        s3ProviderFactory,
      },
      path.join(dir, 'ai-hub')
    );
    disposals.push(() => hub.dispose());
    await hub.initialize();
    return { hub, bucket, s3ProviderFactory };
  }

  const activity: HubRequest = {
    action: 'activity-record',
    event: { actor: 'tester', targetLabel: 'web-01', kind: 'note', summary: 'Checked the web server' },
  };

  it('normal mode: the hub syncs the team bucket at start-up, after recorded activity and on "Sync now"', async () => {
    setDemoModeForTesting(false);
    const { hub, bucket, s3ProviderFactory } = await createHub();

    await waitUntilSynced(hub.s3Workspace);
    expect(s3ProviderFactory).toHaveBeenCalledTimes(1);
    expect(writesOf(bucket.log, WORKSPACE_OBJECT)).toBe(1);

    await hub.request(activity);
    await vi.waitFor(() => expect(writesOf(bucket.log, WORKSPACE_OBJECT)).toBe(2), { timeout: 5_000 });
    await waitUntilSynced(hub.s3Workspace);

    // "Sync now" reads the bucket; with nothing changed it has nothing to write.
    const reads = bucket.log.filter((l) => l === `readFile ${WORKSPACE_OBJECT}`).length;
    await hub.request({ action: 'workspace-s3-sync-now' });
    expect(bucket.log.filter((l) => l === `readFile ${WORKSPACE_OBJECT}`).length).toBe(reads + 1);
    expect(writesOf(bucket.log, WORKSPACE_OBJECT)).toBe(2);
  });

  it('demo mode: the hub never reaches the team bucket, at start-up, after recorded activity or on "Sync now"', async () => {
    setDemoModeForTesting(true);
    const { hub, bucket, s3ProviderFactory } = await createHub();

    await hub.request(activity);
    await expect(hub.request({ action: 'workspace-s3-sync-now' })).rejects.toThrow(S3_DISABLED);
    // Longer than the 400 ms push debounce that follows recorded activity.
    await settle(500);

    expect(s3ProviderFactory).not.toHaveBeenCalled();
    expect(bucket.log).toEqual([]);
    expect(hub.s3Workspace.getStatus().syncDisabledReason).toMatch(S3_DISABLED);
  });
});
