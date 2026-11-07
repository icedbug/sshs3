import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';

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
import { getDemoWorkspaces } from '../../src/main/ai/hub/demoWorkspace';
import {
  decodeS3WorkspaceInvite,
  encodeS3WorkspaceInvite,
  type S3WorkspaceRemotePayload,
} from '../../src/main/ai/hub/S3WorkspaceSyncService';
import { HubService } from '../../src/main/ai/hub/HubService';
import type {
  ConnectedWorkspaceSummary,
  MemoryEntry,
  S3WorkspaceConfig,
  WorkspaceActivityEvent,
  WorkspaceServerSummary,
} from '../../src/shared/types/aiHub';
import type { FileEntry, IStorageProvider } from '../../src/shared/types/storage';

class InMemoryS3Provider implements IStorageProvider {
  readonly id = 'mem-s3-multi';
  readonly name = 'InMemory Multi-Workspace S3';
  readonly type = 's3' as const;

  constructor(
    private readonly objects: Map<string, { content: Buffer; mtime: string }>,
    private readonly callLog: string[] = []
  ) {}

  async connect(): Promise<void> {
    this.callLog.push('connect');
  }
  async disconnect(): Promise<void> {
    this.callLog.push('disconnect');
  }
  async createFolder(): Promise<void> {}
  async mkdir(): Promise<void> {}

  private normalize(p: string): string {
    return p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  }

  async list(dirPath: string): Promise<FileEntry[]> {
    const prefix = this.normalize(dirPath);
    this.callLog.push(`list ${prefix}`);
    const results: FileEntry[] = [];
    for (const [key, obj] of this.objects.entries()) {
      if (key.startsWith(`${prefix}/`)) {
        const rest = key.slice(prefix.length + 1);
        if (!rest.includes('/')) {
          results.push({
            name: rest,
            path: key,
            isDirectory: false,
            size: obj.content.length,
            mtime: obj.mtime,
          });
        }
      }
    }
    return results;
  }

  async stat(filePath: string): Promise<FileEntry> {
    const key = this.normalize(filePath);
    this.callLog.push(`stat ${key}`);
    const obj = this.objects.get(key);
    if (!obj) {
      const err = new Error(`NoSuchKey: ${key}`) as Error & { code?: string };
      err.code = 'NoSuchKey';
      throw err;
    }
    return {
      name: path.posix.basename(key),
      path: key,
      isDirectory: false,
      size: obj.content.length,
      mtime: obj.mtime,
    };
  }

  async delete(targetPath: string): Promise<void> {
    const key = this.normalize(targetPath);
    this.callLog.push(`delete ${key}`);
    this.objects.delete(key);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const oldKey = this.normalize(oldPath);
    const newKey = this.normalize(newPath);
    const obj = this.objects.get(oldKey);
    if (obj) {
      this.objects.set(newKey, obj);
      this.objects.delete(oldKey);
    }
  }

  async readFile(filePath: string): Promise<Buffer> {
    const key = this.normalize(filePath);
    this.callLog.push(`readFile ${key}`);
    const obj = this.objects.get(key);
    if (!obj) {
      const err = new Error(`NoSuchKey: ${key}`) as Error & { code?: string };
      err.code = 'NoSuchKey';
      throw err;
    }
    return Buffer.from(obj.content);
  }

  async writeFile(filePath: string, data: Buffer): Promise<void> {
    const key = this.normalize(filePath);
    this.callLog.push(`writeFile ${key}`);
    this.objects.set(key, {
      content: Buffer.from(data),
      mtime: new Date(Date.now() + this.objects.size).toISOString(),
    });
  }

  async createReadStream(filePath: string): Promise<Readable> {
    const buf = await this.readFile(filePath);
    return Readable.from(buf);
  }

  async createWriteStream(filePath: string): Promise<Writable> {
    const chunks: Buffer[] = [];
    return new Writable({
      write: (chunk, _enc, cb) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        cb();
      },
      final: (cb) => {
        void this.writeFile(filePath, Buffer.concat(chunks)).then(() => cb(), cb);
      },
    });
  }
}

function seedRemoteWorkspacePayload(
  objects: Map<string, { content: Buffer; mtime: string }>,
  bucket: string,
  prefix: string,
  payload: S3WorkspaceRemotePayload,
  presenceActor?: string
): void {
  const mtimeIso = new Date(payload.updatedAt).toISOString();
  const wsKey = `${bucket}/${prefix}/workspace.json`;
  objects.set(wsKey, {
    content: Buffer.from(JSON.stringify(payload, null, 2)),
    mtime: mtimeIso,
  });
  if (presenceActor) {
    const pKey = `${bucket}/${prefix}/presence/${presenceActor}.json`;
    objects.set(pKey, {
      content: Buffer.from(
        JSON.stringify({
          actor: presenceActor,
          updatedAt: Date.now(),
          activeTerminals: [],
        })
      ),
      mtime: mtimeIso,
    });
  }
}

describe('Multi-Workspace Simultaneous Connectivity — Backend Tiers 1 & 2 (F13, F16)', () => {
  const disposals: Array<() => Promise<unknown> | unknown> = [];
  let tmpDir: string;

  beforeEach(async () => {
    setDemoModeForTesting(false);
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sshs3-multi-ws-test-'));
    electronPaths.userData = tmpDir;
    disposals.push(() => fs.rm(tmpDir, { recursive: true, force: true }));
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const dispose of disposals.splice(0).reverse()) {
      await dispose();
    }
    setDemoModeForTesting(undefined);
    electronPaths.userData = '';
  });

  async function createTestHub(options?: {
    objects?: Map<string, { content: Buffer; mtime: string }>;
    callLog?: string[];
    teamVaultWorkspaces?: ConnectedWorkspaceSummary[];
    teamVaultServers?: WorkspaceServerSummary[];
    teamVaultMemories?: MemoryEntry[];
    teamVaultActivity?: WorkspaceActivityEvent[];
  }) {
    const objects = options?.objects ?? new Map<string, { content: Buffer; mtime: string }>();
    const callLog = options?.callLog ?? [];
    const s3ProviderFactory = vi.fn(
      (_cfg: S3WorkspaceConfig) => new InMemoryS3Provider(objects, callLog)
    );
    const s3ConfigFilePath = path.join(tmpDir, 'ai-hub', 's3-workspace.json');

    const hub = new HubService(
      {
        changed: () => {},
        inventoryTargets: async () => [],
        backgroundChanged: async () => {},
        openSchedule: async () => 'sched-1',
        show: () => {},
        aiConfigFilePath: path.join(tmpDir, 'ai-config.json'),
        workspaceServers: async () => options?.teamVaultServers ?? [],
        teamVaultWorkspaces: async () => options?.teamVaultWorkspaces ?? [],
        getTeamWorkspaceData: async () => ({
          memories: options?.teamVaultMemories ?? [],
          activityLog: options?.teamVaultActivity ?? [],
        }),
        defaultActorName: 'jacob-sre',
        s3ConfigFilePath,
        s3ProviderFactory,
      },
      path.join(tmpDir, 'ai-hub')
    );
    disposals.push(() => hub.dispose());
    await hub.initialize();
    return { hub, objects, callLog, s3ProviderFactory, s3ConfigFilePath };
  }

  describe('Tier 1 — Simultaneous Multi-Workspace Registry & Sync (F13)', () => {
    it('F13.1: connects 3 S3 workspaces simultaneously via direct config and sshs3-s3:// invite code (mode: "add") while maintaining the 2-timer invariant', async () => {
      const objects = new Map<string, { content: Buffer; mtime: string }>();
      const { hub } = await createTestHub({ objects });

      // 1. Connect ws-prod via direct configuration
      await hub.request({
        action: 'workspace-s3-configure',
        workspaceId: 'ws-prod',
        mode: 'add',
        config: {
          id: 'ws-prod',
          name: 'Prod Storage North',
          enabled: true,
          bucket: 'prod-bucket-north',
          region: 'eu-north-1',
          prefix: 'prod-team',
          accessKeyId: 'AKIAPROD111',
          secretAccessKey: 'prod-secret-111', // pragma: allowlist secret
        },
      });

      // 2. Connect ws-staging via direct configuration (mode: 'add')
      await hub.request({
        action: 'workspace-s3-configure',
        workspaceId: 'ws-staging',
        mode: 'add',
        config: {
          id: 'ws-staging',
          name: 'Staging Grid Central',
          enabled: true,
          bucket: 'staging-bucket-central',
          region: 'eu-central-1',
          prefix: 'staging-team',
          accessKeyId: 'AKIASTAGE222',
          secretAccessKey: 'staging-secret-222', // pragma: allowlist secret
        },
      });

      // 3. Connect ws-dr via an sshs3-s3:// invite code (mode: 'add')
      const drInvite = encodeS3WorkspaceInvite({
        name: 'DR Vault Frankfurt',
        enabled: true,
        bucket: 'dr-bucket-fra',
        region: 'eu-central-1',
        endpoint: 'https://s3.eu-central-1.amazonaws.com',
        prefix: 'dr-team',
        accessKeyId: 'AKIADR333',
        secretAccessKey: 'dr-secret-333', // pragma: allowlist secret
      });
      expect(decodeS3WorkspaceInvite(drInvite)?.name).toBe('DR Vault Frankfurt');

      const snap = await hub.request({
        action: 'workspace-s3-configure',
        workspaceId: 'ws-dr',
        mode: 'add',
        inviteCode: drInvite,
        config: {
          id: 'ws-dr',
          name: 'DR Vault Frankfurt',
        },
      });

      // Verify s3Workspace.getWorkspacesStatus() has all 3 connected simultaneously
      const statuses = hub.s3Workspace.getWorkspacesStatus();
      expect(statuses).toHaveLength(3);
      expect(statuses.map((s) => s.id)).toEqual(['ws-prod', 'ws-staging', 'ws-dr']);
      expect(statuses.every((s) => s.connected && s.configured)).toBe(true);

      // Verify hub.snapshot().workspaces contains all 3 connected S3 workspaces
      const s3Summaries = (snap.workspaces ?? []).filter((w) => w.kind === 's3');
      expect(s3Summaries).toHaveLength(3);
      expect(s3Summaries.map((w) => ({ id: w.id, name: w.name, connected: w.connected }))).toEqual([
        { id: 'ws-prod', name: 'Prod Storage North', connected: true },
        { id: 'ws-staging', name: 'Staging Grid Central', connected: true },
        { id: 'ws-dr', name: 'DR Vault Frankfurt', connected: true },
      ]);

      // Verify startTimers() keeps the 2-timer invariant even with 3 connected workspaces
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      hub.s3Workspace.startTimers();
      expect(vi.getTimerCount()).toBe(2);
      hub.s3Workspace.stopTimers();
    });

    it('F13.2: tags and merges workspaceServers, memories, activityLog, and presence with workspaceId and workspaceName across all 3 connected workspaces without overwriting', async () => {
      const objects = new Map<string, { content: Buffer; mtime: string }>();
      const baseMs = Date.now() - 120_000;
      const t1Iso = new Date(baseMs).toISOString();
      const t2Iso = new Date(baseMs + 30_000).toISOString();
      const t3Iso = new Date(baseMs + 60_000).toISOString();

      seedRemoteWorkspacePayload(
        objects,
        'prod-bucket',
        'prod',
        {
          version: 1,
          updatedAt: baseMs,
          servers: [
            {
              id: 'srv-prod-01',
              name: 'ontap-prod-01',
              host: '10.10.1.11',
              port: 22,
              username: 'admin',
              cluster: 'Prod-MetroCluster',
              shared: true,
              updatedAt: t1Iso,
            },
          ],
          memories: [
            {
              id: 'mem-prod-01',
              kind: 'memory',
              tier: 'core',
              scope: 'workspace',
              title: 'Prod Failover Policy',
              text: 'Never reboot ontap-prod-01 during backup window.',
              updatedAt: baseMs,
            },
          ],
          activityLog: [
            {
              id: 'act-prod-01',
              at: baseMs,
              actor: 'alice-ops',
              profileId: 'srv-prod-01',
              targetLabel: 'ontap-prod-01',
              kind: 'deploy',
              summary: 'Verified aggregate mirror health on ontap-prod-01',
            },
          ],
          deletedServerIds: {},
          deletedMemoryIds: {},
        },
        'alice-ops'
      );

      seedRemoteWorkspacePayload(
        objects,
        'staging-bucket',
        'staging',
        {
          version: 1,
          updatedAt: baseMs + 30_000,
          servers: [
            {
              id: 'srv-staging-01',
              name: 'sg-staging-01',
              host: '10.20.2.21',
              port: 22,
              username: 'root',
              cluster: 'Staging-StorageGRID',
              shared: true,
              updatedAt: t2Iso,
            },
          ],
          memories: [
            {
              id: 'mem-staging-01',
              kind: 'memory',
              tier: 'core',
              scope: 'workspace',
              title: 'Staging ILM Rule',
              text: 'Staging bucket uses 2-copy replication.',
              updatedAt: baseMs + 30_000,
            },
          ],
          activityLog: [
            {
              id: 'act-staging-01',
              at: baseMs + 30_000,
              actor: 'bob-sre',
              profileId: 'srv-staging-01',
              targetLabel: 'sg-staging-01',
              kind: 'command',
              summary: 'Updated ILM policy on sg-staging-01',
            },
          ],
          deletedServerIds: {},
          deletedMemoryIds: {},
        },
        'bob-sre'
      );

      seedRemoteWorkspacePayload(
        objects,
        'dr-bucket',
        'dr',
        {
          version: 1,
          updatedAt: baseMs + 60_000,
          servers: [
            {
              id: 'srv-dr-01',
              name: 'ceph-dr-01',
              host: '10.30.3.31',
              port: 22,
              username: 'ubuntu',
              cluster: 'DR-Ceph-Frankfurt',
              shared: true,
              updatedAt: t3Iso,
            },
          ],
          memories: [
            {
              id: 'mem-dr-01',
              kind: 'memory',
              tier: 'core',
              scope: 'workspace',
              title: 'DR RPO Target',
              text: 'Frankfurt Ceph RGW target RPO is 15m.',
              updatedAt: baseMs + 60_000,
            },
          ],
          activityLog: [
            {
              id: 'act-dr-01',
              at: baseMs + 60_000,
              actor: 'carol-dr',
              profileId: 'srv-dr-01',
              targetLabel: 'ceph-dr-01',
              kind: 'note',
              summary: 'Completed DR drill on ceph-dr-01',
            },
          ],
          deletedServerIds: {},
          deletedMemoryIds: {},
        },
        'carol-dr'
      );

      const { hub } = await createTestHub({ objects });

      await hub.request({
        action: 'workspace-s3-configure',
        workspaceId: 'ws-prod',
        mode: 'add',
        config: {
          id: 'ws-prod',
          name: 'Prod Storage',
          enabled: true,
          bucket: 'prod-bucket',
          region: 'eu-north-1',
          prefix: 'prod',
          accessKeyId: 'AKIAPROD',
          secretAccessKey: 'sec-prod', // pragma: allowlist secret
        },
      });
      await hub.request({
        action: 'workspace-s3-configure',
        workspaceId: 'ws-staging',
        mode: 'add',
        config: {
          id: 'ws-staging',
          name: 'Staging Storage',
          enabled: true,
          bucket: 'staging-bucket',
          region: 'eu-central-1',
          prefix: 'staging',
          accessKeyId: 'AKIASTAGING',
          secretAccessKey: 'sec-staging', // pragma: allowlist secret
        },
      });
      const snap = await hub.request({
        action: 'workspace-s3-configure',
        workspaceId: 'ws-dr',
        mode: 'add',
        config: {
          id: 'ws-dr',
          name: 'DR Storage',
          enabled: true,
          bucket: 'dr-bucket',
          region: 'eu-central-1',
          prefix: 'dr',
          accessKeyId: 'AKIADR',
          secretAccessKey: 'sec-dr', // pragma: allowlist secret
        },
      });

      // Verify servers from all 3 workspaces are present and tagged with workspaceId & workspaceName
      const prodSrv = snap.workspaceServers?.find((s) => s.id === 'srv-prod-01');
      const stagingSrv = snap.workspaceServers?.find((s) => s.id === 'srv-staging-01');
      const drSrv = snap.workspaceServers?.find((s) => s.id === 'srv-dr-01');

      expect(prodSrv).toMatchObject({
        id: 'srv-prod-01',
        workspaceId: 'ws-prod',
        workspaceName: 'Prod Storage',
      });
      expect(stagingSrv).toMatchObject({
        id: 'srv-staging-01',
        workspaceId: 'ws-staging',
        workspaceName: 'Staging Storage',
      });
      expect(drSrv).toMatchObject({
        id: 'srv-dr-01',
        workspaceId: 'ws-dr',
        workspaceName: 'DR Storage',
      });

      // Verify memories from all 3 workspaces are tagged and merged
      const prodMem = snap.memories.find((m) => m.id === 'mem-prod-01');
      const stagingMem = snap.memories.find((m) => m.id === 'mem-staging-01');
      const drMem = snap.memories.find((m) => m.id === 'mem-dr-01');
      expect(prodMem).toMatchObject({ workspaceId: 'ws-prod', workspaceName: 'Prod Storage' });
      expect(stagingMem).toMatchObject({
        workspaceId: 'ws-staging',
        workspaceName: 'Staging Storage',
      });
      expect(drMem).toMatchObject({ workspaceId: 'ws-dr', workspaceName: 'DR Storage' });

      // Verify activityLog events from all 3 workspaces are tagged and merged
      const prodAct = snap.activityLog?.find((a) => a.id === 'act-prod-01');
      const stagingAct = snap.activityLog?.find((a) => a.id === 'act-staging-01');
      const drAct = snap.activityLog?.find((a) => a.id === 'act-dr-01');
      expect(prodAct).toMatchObject({ workspaceId: 'ws-prod', workspaceName: 'Prod Storage' });
      expect(stagingAct).toMatchObject({
        workspaceId: 'ws-staging',
        workspaceName: 'Staging Storage',
      });
      expect(drAct).toMatchObject({ workspaceId: 'ws-dr', workspaceName: 'DR Storage' });

      // Verify presence entries are tagged per workspace
      const prodPresence = hub.s3Workspace.getPresence('ws-prod');
      const stagingPresence = hub.s3Workspace.getPresence('ws-staging');
      const drPresence = hub.s3Workspace.getPresence('ws-dr');
      expect(prodPresence.some((p) => p.actor === 'alice-ops' && p.workspaceId === 'ws-prod')).toBe(
        true
      );
      expect(
        stagingPresence.some((p) => p.actor === 'bob-sre' && p.workspaceId === 'ws-staging')
      ).toBe(true);
      expect(drPresence.some((p) => p.actor === 'carol-dr' && p.workspaceId === 'ws-dr')).toBe(
        true
      );
    });

    it('F13.3: switches activeWorkspaceId via workspace-select ("ALL" vs specific workspace ID) and persists across snapshot() calls', async () => {
      const { hub } = await createTestHub();

      await hub.request({
        action: 'workspace-s3-configure',
        workspaceId: 'ws-prod',
        mode: 'add',
        config: {
          id: 'ws-prod',
          name: 'Prod Storage',
          enabled: true,
          bucket: 'prod-bucket',
          region: 'eu-north-1',
          prefix: 'prod',
          accessKeyId: 'AKIAPROD',
          secretAccessKey: 'sec-prod', // pragma: allowlist secret
        },
      });
      await hub.request({
        action: 'workspace-s3-configure',
        workspaceId: 'ws-staging',
        mode: 'add',
        config: {
          id: 'ws-staging',
          name: 'Staging Storage',
          enabled: true,
          bucket: 'staging-bucket',
          region: 'eu-central-1',
          prefix: 'staging',
          accessKeyId: 'AKIASTAGING',
          secretAccessKey: 'sec-staging', // pragma: allowlist secret
        },
      });

      const snapProd = await hub.request({
        action: 'workspace-select',
        workspaceId: 'ws-prod',
      });
      expect(snapProd.activeWorkspaceId).toBe('ws-prod');
      expect(snapProd.s3Workspace?.id).toBe('ws-prod');
      expect((await hub.snapshot()).activeWorkspaceId).toBe('ws-prod');

      const snapStaging = await hub.request({
        action: 'workspace-select',
        workspaceId: 'ws-staging',
      });
      expect(snapStaging.activeWorkspaceId).toBe('ws-staging');
      expect(snapStaging.s3Workspace?.id).toBe('ws-staging');
      expect((await hub.snapshot()).activeWorkspaceId).toBe('ws-staging');

      const snapAll = await hub.request({
        action: 'workspace-select',
        workspaceId: 'ALL',
      });
      expect(snapAll.activeWorkspaceId).toBe('ALL');
      expect((await hub.snapshot()).activeWorkspaceId).toBe('ALL');
    });

    it('F13.4: aggregates unlocked Team Vault workspaces (with teamVaultProfileRef) alongside connected S3 workspaces', async () => {
      const { hub } = await createTestHub({
        teamVaultWorkspaces: [
          {
            id: 'vault:vlt-core-sec',
            name: 'Core Security Vault',
            kind: 'team-vault',
            connected: true,
            badge: 'Team Vault · Unlocked',
            serverCount: 1,
            memoryCount: 1,
            presenceCount: 1,
          },
        ],
        teamVaultServers: [
          {
            id: 'vault-srv-1',
            name: 'sec-bastion-01',
            host: '10.99.0.10',
            port: 22,
            username: 'secadmin',
            shared: true,
            workspaceId: 'vault:vlt-core-sec',
            workspaceName: 'Core Security Vault',
            teamVaultProfileRef: { vaultId: 'vlt-core-sec', profileId: 'prof-bastion-1' },
          },
        ],
      });

      await hub.request({
        action: 'workspace-s3-configure',
        workspaceId: 'ws-prod',
        mode: 'add',
        config: {
          id: 'ws-prod',
          name: 'Prod S3 Workspace',
          enabled: true,
          bucket: 'prod-bucket',
          region: 'eu-north-1',
          prefix: 'prod',
          accessKeyId: 'AKIAPROD',
          secretAccessKey: 'sec-prod', // pragma: allowlist secret
        },
      });

      const snap = await hub.snapshot();
      expect(snap.workspaces?.map((w) => w.id)).toEqual(
        expect.arrayContaining(['ws-prod', 'vault:vlt-core-sec'])
      );
      const vaultSrv = snap.workspaceServers?.find((s) => s.id === 'vault-srv-1');
      expect(vaultSrv?.teamVaultProfileRef).toEqual({
        vaultId: 'vlt-core-sec',
        profileId: 'prof-bastion-1',
      });
    });
  });

  describe('Tier 2 — Boundary, Isolation & Demo Mode (F13, F16)', () => {
    it('F13.5: disconnecting ws-staging with remove: true removes only ws-staging from connected workspaces while ws-prod and ws-dr remain connected with their servers intact', async () => {
      const objects = new Map<string, { content: Buffer; mtime: string }>();
      const nowMs = Date.now() - 30_000;
      const nowIso = new Date(nowMs).toISOString();

      seedRemoteWorkspacePayload(objects, 'prod-bkt', 'prod', {
        version: 1,
        updatedAt: nowMs,
        servers: [
          {
            id: 'srv-prod-keep',
            name: 'prod-node-keep',
            host: '10.1.1.1',
            port: 22,
            username: 'root',
            shared: true,
            updatedAt: nowIso,
          },
        ],
        memories: [],
        activityLog: [],
        deletedServerIds: {},
        deletedMemoryIds: {},
      });

      seedRemoteWorkspacePayload(objects, 'staging-bkt', 'staging', {
        version: 1,
        updatedAt: nowMs,
        servers: [
          {
            id: 'srv-staging-remove',
            name: 'staging-node-remove',
            host: '10.2.2.2',
            port: 22,
            username: 'root',
            shared: true,
            updatedAt: nowIso,
          },
        ],
        memories: [],
        activityLog: [],
        deletedServerIds: {},
        deletedMemoryIds: {},
      });

      seedRemoteWorkspacePayload(objects, 'dr-bkt', 'dr', {
        version: 1,
        updatedAt: nowMs,
        servers: [
          {
            id: 'srv-dr-keep',
            name: 'dr-node-keep',
            host: '10.3.3.3',
            port: 22,
            username: 'root',
            shared: true,
            updatedAt: nowIso,
          },
        ],
        memories: [],
        activityLog: [],
        deletedServerIds: {},
        deletedMemoryIds: {},
      });

      const { hub } = await createTestHub({ objects });

      await hub.request({
        action: 'workspace-s3-configure',
        workspaceId: 'ws-prod',
        mode: 'add',
        config: {
          id: 'ws-prod',
          name: 'Prod Workspace',
          enabled: true,
          bucket: 'prod-bkt',
          region: 'eu-north-1',
          prefix: 'prod',
          accessKeyId: 'AKIA1',
          secretAccessKey: 'sec1', // pragma: allowlist secret
        },
      });
      await hub.request({
        action: 'workspace-s3-configure',
        workspaceId: 'ws-staging',
        mode: 'add',
        config: {
          id: 'ws-staging',
          name: 'Staging Workspace',
          enabled: true,
          bucket: 'staging-bkt',
          region: 'eu-central-1',
          prefix: 'staging',
          accessKeyId: 'AKIA2',
          secretAccessKey: 'sec2', // pragma: allowlist secret
        },
      });
      await hub.request({
        action: 'workspace-s3-configure',
        workspaceId: 'ws-dr',
        mode: 'add',
        config: {
          id: 'ws-dr',
          name: 'DR Workspace',
          enabled: true,
          bucket: 'dr-bkt',
          region: 'eu-central-1',
          prefix: 'dr',
          accessKeyId: 'AKIA3',
          secretAccessKey: 'sec3', // pragma: allowlist secret
        },
      });

      // Select ws-staging, then disconnect it with remove: true
      await hub.request({ action: 'workspace-select', workspaceId: 'ws-staging' });
      const afterDisconnect = await hub.request({
        action: 'workspace-s3-disconnect',
        workspaceId: 'ws-staging',
        remove: true,
      });

      expect(hub.s3Workspace.getWorkspacesStatus().map((w) => w.id)).toEqual([
        'ws-prod',
        'ws-dr',
      ]);
      const remainingIds = (afterDisconnect.workspaces ?? [])
        .filter((w) => w.kind === 's3')
        .map((w) => w.id);
      expect(remainingIds).toEqual(['ws-prod', 'ws-dr']);

      // Active workspace automatically falls back from disconnected ws-staging to a connected workspace
      expect(afterDisconnect.activeWorkspaceId).not.toBe('ws-staging');

      // All workspaceServers in the snapshot contain only ws-prod and ws-dr servers (srv-staging-remove is evicted)
      const allServerIds = (afterDisconnect.workspaceServers ?? []).map((s) => s.id);
      expect(allServerIds).toContain('srv-prod-keep');
      expect(allServerIds).toContain('srv-dr-keep');
      expect(allServerIds).not.toContain('srv-staging-remove');
    });

    it('F13.6: upserting a server or memory targeted at a specific workspaceId routes and tags it exclusively to that workspace even when sharedWorkspacePath is active', async () => {
      const profileStoreServers: WorkspaceServerSummary[] = [];
      const { hub } = await createTestHub({
        teamVaultServers: profileStoreServers,
      });

      // Configure sharedWorkspacePath to simulate WebTenantManager / shared file workspace
      hub.store.data.preferences.sharedWorkspacePath = path.join(
        tmpDir,
        'shared-workspace.json'
      );

      await hub.request({
        action: 'workspace-s3-configure',
        workspaceId: 'ws-prod',
        mode: 'add',
        config: {
          id: 'ws-prod',
          name: 'Prod Storage',
          enabled: true,
          bucket: 'prod-bkt',
          region: 'eu-north-1',
          prefix: 'prod',
          accessKeyId: 'AKIA1',
          secretAccessKey: 'sec1', // pragma: allowlist secret
        },
      });
      await hub.request({
        action: 'workspace-s3-configure',
        workspaceId: 'ws-dr',
        mode: 'add',
        config: {
          id: 'ws-dr',
          name: 'DR Storage',
          enabled: true,
          bucket: 'dr-bkt',
          region: 'eu-central-1',
          prefix: 'dr',
          accessKeyId: 'AKIA3',
          secretAccessKey: 'sec3', // pragma: allowlist secret
        },
      });

      // Simulate profileStore returning the saved SSH profile without workspaceId
      profileStoreServers.push({
        id: 'srv-targeted-prod',
        name: 'targeted-prod-01',
        host: '10.55.1.10',
        port: 22,
        username: 'admin',
        cluster: 'Prod-Cluster',
        shared: true,
        updatedAt: new Date().toISOString(),
      });

      // Upsert a server explicitly targeting ws-prod while activeWorkspaceId is ws-dr and sharedWorkspacePath is active
      await hub.request({
        action: 'server-upsert',
        workspaceId: 'ws-prod',
        workspaceName: 'Prod Storage',
        server: {
          id: 'srv-targeted-prod',
          name: 'targeted-prod-01',
          host: '10.55.1.10',
          port: 22,
          username: 'admin',
          cluster: 'Prod-Cluster',
          shared: true,
        },
      });

      // Save a memory explicitly targeting ws-dr
      const afterMem = await hub.request({
        action: 'memory-save',
        workspaceId: 'ws-dr',
        workspaceName: 'DR Storage',
        entry: {
          kind: 'memory',
          scope: 'workspace',
          title: 'DR Switchover Checklist',
          text: 'Verify Ceph peering before DNS cutover.',
        },
      });

      const targetedSrv = afterMem.workspaceServers?.find((s) => s.id === 'srv-targeted-prod');
      expect(targetedSrv).toMatchObject({
        id: 'srv-targeted-prod',
        workspaceId: 'ws-prod',
        workspaceName: 'Prod Storage',
      });

      const targetedMem = afterMem.memories.find((m) => m.title === 'DR Switchover Checklist');
      expect(targetedMem).toMatchObject({
        workspaceId: 'ws-dr',
        workspaceName: 'DR Storage',
      });
    });

    it('F13.7: demo mode seeds 3 connected demo workspaces, workspace-connect-demo adds a 4th connected demo workspace, disconnecting it removes its nodes, and outward S3 sync remains strictly blocked', async () => {
      setDemoModeForTesting(true);
      const callLog: string[] = [];
      const { hub, s3ProviderFactory } = await createTestHub({ callLog });

      // Verify getDemoWorkspaces() seeds 3 connected demo workspaces
      const builtinDemo = getDemoWorkspaces();
      expect(builtinDemo.map((w) => w.id)).toEqual([
        'ws-demo-ontap',
        'ws-demo-s3-grid',
        'ws-demo-k8s-ceph',
      ]);
      expect(builtinDemo.every((w) => w.connected && w.kind === 'demo')).toBe(true);

      const initialSnap = await hub.snapshot();
      expect(initialSnap.workspaces?.map((w) => w.id)).toEqual(
        expect.arrayContaining(['ws-demo-ontap', 'ws-demo-s3-grid', 'ws-demo-k8s-ceph'])
      );

      // Connect a 4th demo workspace via workspace-connect-demo
      const afterFourth = await hub.request({
        action: 'workspace-connect-demo',
        name: 'DR Vault Frankfurt',
        cluster: 'Frankfurt-Metro-DR',
      });

      const connectedDemoIds = (afterFourth.workspaces ?? [])
        .filter((w) => w.kind === 'demo' && w.connected)
        .map((w) => w.id);
      expect(connectedDemoIds).toEqual(
        expect.arrayContaining([
          'ws-demo-ontap',
          'ws-demo-s3-grid',
          'ws-demo-k8s-ceph',
          'ws-demo-dr-vault-frankfurt',
        ])
      );
      expect(
        (afterFourth.workspaceServers ?? []).some(
          (s) => s.workspaceId === 'ws-demo-dr-vault-frankfurt'
        )
      ).toBe(true);

      // Disconnect the 4th demo workspace with remove: true and verify it & its nodes are removed
      const afterDemoDisconnect = await hub.request({
        action: 'workspace-s3-disconnect',
        workspaceId: 'ws-demo-dr-vault-frankfurt',
        remove: true,
      });
      expect((afterDemoDisconnect.workspaces ?? []).map((w) => w.id)).not.toContain(
        'ws-demo-dr-vault-frankfurt'
      );
      expect(
        (afterDemoDisconnect.workspaceServers ?? []).some(
          (s) => s.workspaceId === 'ws-demo-dr-vault-frankfurt'
        )
      ).toBe(false);

      // Outward S3 sync remains strictly blocked in demo mode
      await expect(
        hub.request({
          action: 'workspace-s3-configure',
          workspaceId: 'ws-blocked',
          mode: 'add',
          config: {
            enabled: true,
            bucket: 'external-bucket',
            region: 'eu-north-1',
            prefix: 'team',
            accessKeyId: 'AKIAEXT',
            secretAccessKey: 'sec-ext', // pragma: allowlist secret
          },
        })
      ).rejects.toThrow(/S3 team workspace sync is disabled in demo mode/);

      await expect(
        hub.request({ action: 'workspace-s3-sync-now', workspaceId: 'ws-demo-ontap' })
      ).rejects.toThrow(/S3 team workspace sync is disabled in demo mode/);

      expect(s3ProviderFactory).not.toHaveBeenCalled();
      expect(callLog).toEqual([]);
      expect(hub.s3Workspace.getStatus().syncDisabledReason).toMatch(
        /S3 team workspace sync is disabled in demo mode/
      );
    });
  });
});
