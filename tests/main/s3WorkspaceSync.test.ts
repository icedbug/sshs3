import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable, Writable } from 'stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decodeS3WorkspaceInvite,
  encodeS3WorkspaceInvite,
  mergeS3WorkspacePayload,
  S3WorkspaceSyncService,
  sanitizeServerForS3,
  type S3WorkspaceRemotePayload,
} from '../../src/main/ai/hub/S3WorkspaceSyncService';
import type { FileEntry, IStorageProvider } from '../../src/shared/types/storage';
import type {
  MemoryEntry,
  WorkspaceActivityEvent,
  WorkspaceServerSummary,
} from '../../src/shared/types/aiHub';

class InMemoryS3BucketProvider implements IStorageProvider {
  readonly type = 's3' as const;

  constructor(private readonly objects: Map<string, { content: Buffer; mtime: string }>) {}

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}

  private normalize(p: string): string {
    return p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  }

  async list(dirPath: string): Promise<FileEntry[]> {
    const prefix = this.normalize(dirPath);
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

  async mkdir(): Promise<void> {}

  async delete(targetPath: string): Promise<void> {
    this.objects.delete(this.normalize(targetPath));
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

describe('S3WorkspaceSyncService & CRDT Merge', () => {
  let tmpDirA: string;
  let tmpDirB: string;

  beforeEach(() => {
    tmpDirA = fs.mkdtempSync(path.join(os.tmpdir(), 'sshs3-friend-a-'));
    tmpDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'sshs3-friend-b-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDirA, { recursive: true, force: true });
    fs.rmSync(tmpDirB, { recursive: true, force: true });
  });

  it('encodes and decodes sshs3-s3:// invite codes losslessly', () => {
    const invite = encodeS3WorkspaceInvite({
      enabled: true,
      bucket: 'team-infra-bucket',
      region: 'eu-north-1',
      endpoint: 'https://s3.eu-north-1.amazonaws.com',
      prefix: 'sshs3-team',
      accessKeyId: 'AKIAEXAMPLE123',
      secretAccessKey: 'super-secret-s3-key',
    });

    expect(invite.startsWith('sshs3-s3://')).toBe(true);
    const decoded = decodeS3WorkspaceInvite(invite);
    expect(decoded).toEqual({
      enabled: true,
      bucket: 'team-infra-bucket',
      region: 'eu-north-1',
      endpoint: 'https://s3.eu-north-1.amazonaws.com',
      prefix: 'sshs3-team',
      accessKeyId: 'AKIAEXAMPLE123',
      secretAccessKey: 'super-secret-s3-key',
      forcePathStyle: true,
    });
  });

  it('strips all local SSH overrides and secrets when sanitizing a server for S3', () => {
    const rawServer = {
      id: 'srv-1',
      name: 'k8s-master-01',
      host: '10.0.10.11',
      port: 22,
      username: 'ubuntu',
      cluster: 'k8s-prod',
      nodeRole: 'control-plane',
      role: 'k8s',
      description: 'Primary control plane',
      tags: ['k8s', 'prod'],
      shared: true,
      localUsername: 'jacob-local',
      localPrivateKeyPath: '~/.ssh/id_ed25519_jacob',
      localAuthType: 'privateKey' as const,
      password: 'never-upload-password',
      privateKey: 'never-upload-private-key',
    } as WorkspaceServerSummary & { password?: string; privateKey?: string };

    const sanitized = sanitizeServerForS3(rawServer);
    expect(sanitized.id).toBe('srv-1');
    expect(sanitized.host).toBe('10.0.10.11');
    expect(sanitized.username).toBe('ubuntu');
    expect(sanitized.localUsername).toBeUndefined();
    expect(sanitized.localPrivateKeyPath).toBeUndefined();
    expect(sanitized.localAuthType).toBeUndefined();
    expect((sanitized as Record<string, unknown>).password).toBeUndefined();
    expect((sanitized as Record<string, unknown>).privateKey).toBeUndefined();
  });

  it('merges concurrent server additions, edits, and deletion tombstones deterministically', () => {
    const remote: S3WorkspaceRemotePayload = {
      version: 1,
      updatedAt: 1000,
      servers: [
        {
          id: 'srv-1',
          name: 'db-primary',
          host: '10.0.0.10',
          port: 22,
          username: 'postgres',
          description: 'Old description',
          shared: true,
          updatedAt: '2026-10-28T10:00:00.000Z',
          updatedBy: 'jacob',
        },
        {
          id: 'srv-to-delete',
          name: 'old-staging',
          host: '10.0.0.99',
          port: 22,
          username: 'ubuntu',
          shared: true,
          updatedAt: '2026-10-28T09:00:00.000Z',
          updatedBy: 'jacob',
        },
      ],
      deletedServerIds: {},
      memories: [
        {
          id: 'mem-1',
          title: 'Deploy Runbook',
          text: 'Run docker compose up -d',
          scope: 'workspace',
          kind: 'skill',
          updatedAt: 900,
        },
      ],
      deletedMemoryIds: {},
      activityLog: [
        {
          id: 'act-1',
          at: 950,
          actor: 'jacob',
          targetLabel: 'db-primary',
          kind: 'note',
          summary: 'Added db-primary',
        },
      ],
    };

    const local: S3WorkspaceRemotePayload = {
      version: 1,
      updatedAt: 2000,
      servers: [
        {
          id: 'srv-1',
          name: 'db-primary',
          host: '10.0.0.10',
          port: 22,
          username: 'postgres',
          description: 'Updated by Erik with replica info',
          shared: true,
          updatedAt: '2026-10-28T12:00:00.000Z',
          updatedBy: 'erik',
        },
        {
          id: 'srv-2',
          name: 'redis-cache',
          host: '10.0.0.20',
          port: 22,
          username: 'ubuntu',
          shared: true,
          updatedAt: '2026-10-28T13:00:00.000Z',
          updatedBy: 'erik',
        },
      ],
      deletedServerIds: {
        'srv-to-delete': '2026-10-28T11:00:00.000Z',
      },
      memories: [],
      deletedMemoryIds: {},
      activityLog: [
        {
          id: 'act-2',
          at: 1850,
          actor: 'erik',
          targetLabel: 'redis-cache',
          kind: 'note',
          summary: 'Added redis-cache',
        },
      ],
    };

    const { merged, activeServers } = mergeS3WorkspacePayload(local, remote);

    // srv-to-delete was tombstoned at 11:00 (> 09:00), so it must be excluded from activeServers
    expect(activeServers.map((s) => s.id).sort()).toEqual(['srv-1', 'srv-2']);
    // srv-1 has Erik's newer description (12:00 > 10:00)
    expect(activeServers.find((s) => s.id === 'srv-1')?.description).toBe(
      'Updated by Erik with replica info'
    );
    // mem-1 from Jacob is preserved
    expect(merged.memories).toHaveLength(1);
    expect(merged.memories[0]?.title).toBe('Deploy Runbook');
    // Both activity events are merged
    expect(merged.activityLog.map((a) => a.id)).toEqual(['act-1', 'act-2']);
  });

  it('syncs shared VMs, AI memories, deletions, and live presence between two friends via S3 bucket', async () => {
    const sharedBucketObjects = new Map<string, { content: Buffer; mtime: string }>();
    const providerFactory = () => new InMemoryS3BucketProvider(sharedBucketObjects);

    let jacobServers: WorkspaceServerSummary[] = [
      {
        id: 'node-k8s-1',
        name: 'k8s-worker-01',
        host: '10.20.1.10',
        port: 22,
        username: 'ubuntu',
        cluster: 'k8s-eu-north-1',
        nodeRole: 'worker-node',
        role: 'k8s',
        description: 'GPU worker node',
        tags: ['k8s', 'gpu-node'],
        shared: true,
        updatedAt: '2026-10-28T10:00:00.000Z',
        updatedBy: 'jacob',
      },
    ];
    let jacobMemories: MemoryEntry[] = [
      {
        id: 'mem-shared-1',
        title: 'K8s GPU Node Info',
        text: 'NVIDIA drivers are managed via daemonset on k8s-eu-north-1',
        scope: 'workspace',
        kind: 'memory',
        updatedAt: 1000,
      },
    ];
    let jacobActivity: WorkspaceActivityEvent[] = [];
    let jacobDeletedServers: Record<string, string> = {};
    let jacobDeletedMemories: Record<string, number> = {};

    let erikServers: WorkspaceServerSummary[] = [];
    let erikMemories: MemoryEntry[] = [];
    let erikActivity: WorkspaceActivityEvent[] = [];
    let erikDeletedServers: Record<string, string> = {};
    let erikDeletedMemories: Record<string, number> = {};

    const syncJacob = new S3WorkspaceSyncService(
      path.join(tmpDirA, 's3-workspace.json'),
      {
        getLocalState: async () => ({
          actor: 'jacob',
          servers: jacobServers,
          memories: jacobMemories,
          activityLog: jacobActivity,
          deletedServerIds: jacobDeletedServers,
          deletedMemoryIds: jacobDeletedMemories,
          activeTerminals: [
            {
              profileId: 'node-k8s-1',
              targetLabel: 'k8s-worker-01',
              state: 'ai-working',
              since: 1000,
            },
          ],
        }),
        applyMergedState: async (state) => {
          jacobServers = state.activeServers;
          jacobMemories = state.memories;
          jacobActivity = state.activityLog;
          jacobDeletedServers = state.deletedServerIds;
          jacobDeletedMemories = state.deletedMemoryIds;
        },
        onStateChanged: () => {},
      },
      { providerFactory }
    );

    // Jacob configures the S3 bucket
    await syncJacob.configure({
      enabled: true,
      bucket: 'sshs3-friends',
      region: 'eu-north-1',
      prefix: 'team-alpha',
      accessKeyId: 'AKIAJACOB',
      secretAccessKey: 'SECRETJACOB',
    });

    const jacobStatus = syncJacob.getStatus();
    expect(jacobStatus.configured).toBe(true);
    expect(jacobStatus.inviteCode?.startsWith('sshs3-s3://')).toBe(true);

    // Erik joins using Jacob's 1-click invite code!
    const syncErik = new S3WorkspaceSyncService(
      path.join(tmpDirB, 's3-workspace.json'),
      {
        getLocalState: async () => ({
          actor: 'erik',
          servers: erikServers,
          memories: erikMemories,
          activityLog: erikActivity,
          deletedServerIds: erikDeletedServers,
          deletedMemoryIds: erikDeletedMemories,
          activeTerminals: [
            {
              profileId: 'node-k8s-1',
              targetLabel: 'k8s-worker-01',
              state: 'connected',
              since: 1100,
            },
          ],
        }),
        applyMergedState: async (state) => {
          erikServers = state.activeServers;
          erikMemories = state.memories;
          erikActivity = state.activityLog;
          erikDeletedServers = state.deletedServerIds;
          erikDeletedMemories = state.deletedMemoryIds;
        },
        onStateChanged: () => {},
      },
      { providerFactory }
    );

    await syncErik.configure(undefined, jacobStatus.inviteCode!);
    const erikStatus = syncErik.getStatus();
    expect(erikStatus.configured).toBe(true);
    expect(erikStatus.error).toBeUndefined();

    // Erik immediately received Jacob's shared VM and shared AI memory!
    expect(erikServers).toHaveLength(1);
    expect(erikServers[0]?.name).toBe('k8s-worker-01');
    expect(erikServers[0]?.cluster).toBe('k8s-eu-north-1');
    expect(erikMemories.find((m) => m.id === 'mem-shared-1')?.title).toBe(
      'K8s GPU Node Info'
    );

    // Erik also sees Jacob's live presence on node-k8s-1!
    const erikPresence = syncErik.getPresence();
    expect(erikPresence.some((p) => p.actor === 'jacob')).toBe(true);
    expect(
      erikPresence.find((p) => p.actor === 'jacob')?.activeTerminals[0]?.state
    ).toBe('ai-working');

    await syncJacob.dispose();
    await syncErik.dispose();
  });
});
