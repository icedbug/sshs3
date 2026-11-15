import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';

const electronPaths = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => {
  const mockObj = {
    ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
    app: { getPath: () => electronPaths.userData || os.tmpdir() },
    safeStorage: {
      isEncryptionAvailable: vi.fn().mockReturnValue(false),
      encryptString: vi.fn((s: string) => Buffer.from(s)),
      decryptString: vi.fn((b: Buffer) => b.toString('utf8')),
    },
    shell: { openPath: vi.fn().mockResolvedValue(''), openExternal: vi.fn() },
    Notification: { isSupported: () => false },
    powerMonitor: { on: vi.fn(), removeListener: vi.fn() },
  };
  return { ...mockObj, default: mockObj };
});

import { S3StorageProvider } from '../../src/main/storage/S3StorageProvider';
import {
  decodeS3WorkspaceInvite,
  encodeS3WorkspaceInvite,
  encodeS3WorkspaceInviteToken,
  S3WorkspaceSyncService,
  validateS3WorkspaceInvite,
  type S3WorkspaceSyncCallbacks,
} from '../../src/main/ai/hub/S3WorkspaceSyncService';
import { WorkSync, type ConditionalQueueStore } from '../../src/main/ai/hub/WorkSync';
import {
  compareVersion,
  mergeTicketCopies,
  nextForHeartbeat,
  sortAlertsByUpstream,
  sortTicketsByPriority,
  type MergeableTicket,
} from '../../src/main/ai/hub/WorkBoard';
import {
  dispatchTargets,
  parseStructuredSpecialistOutput,
  planTargetDispatch,
  resolveTargetSelector,
  RunScratchpad,
  runWorkforce,
  validateStructuredSpecialistOutput,
  type TargetCandidate,
} from '../../src/main/ai/hub/WorkforceRunner';
import type {
  CorrelatedAlertRef,
  InfraGraphEdge,
  MissionAgent,
  S3WorkspaceConfig,
  WorkTicket,
} from '../../src/shared/types/aiHub';
import type { FileEntry, IStorageProvider, WriteStreamOptions } from '../../src/shared/types/storage';

const disposals: Array<() => Promise<unknown> | unknown> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dispose of disposals.splice(0).reverse()) {
    await dispose();
  }
  electronPaths.userData = '';
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  disposals.push(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
}

describe('S3StorageProvider conditional & signal options', () => {
  it('passes IfMatch, IfNoneMatch, and abortSignal on writeFile and readFile while keeping streams timeout-free', async () => {
    const provider = new S3StorageProvider({
      id: 's3-overhaul-test',
      name: 'Overhaul S3',
      region: 'us-east-1',
      accessKeyId: 'AKIA',
      secretAccessKey: 'secret', // pragma: allowlist secret
    });

    const sentCalls: Array<{ cmd: unknown; opts?: { abortSignal?: AbortSignal } }> = [];
    const mockClient = {
      send: vi.fn(async (cmd: unknown, opts?: { abortSignal?: AbortSignal }) => {
        sentCalls.push({ cmd, opts });
        if (cmd instanceof HeadObjectCommand) {
          return { ContentLength: 5, LastModified: new Date('2026-01-01T00:00:00Z'), ETag: '"etag-head"' };
        }
        if (cmd instanceof GetObjectCommand) {
          return {
            Body: {
              async transformToByteArray() {
                return Uint8Array.from(Buffer.from('hello'));
              },
              async *[Symbol.asyncIterator]() {
                yield Buffer.from('hello');
              },
            },
          };
        }
        return {};
      }),
    };
    (provider as unknown as { client: unknown }).client = mockClient;

    const controller = new AbortController();
    await provider.writeFile('/my-bucket/team/state.json', Buffer.from('{}'), {
      ifMatch: '"etag-1"',
      ifNoneMatch: '*',
      signal: controller.signal,
    });

    const putCall = sentCalls.find((c) => c.cmd instanceof PutObjectCommand);
    expect(putCall).toBeDefined();
    expect((putCall!.cmd as PutObjectCommand).input).toMatchObject({
      Bucket: 'my-bucket',
      Key: 'team/state.json',
      IfMatch: '"etag-1"',
      IfNoneMatch: '*',
    });
    expect(putCall!.opts?.abortSignal).toBe(controller.signal);

    const readBuf = await provider.readFile('/my-bucket/team/state.json', {
      ifMatch: '"etag-1"',
      ifNoneMatch: '"etag-old"',
      signal: controller.signal,
    });
    expect(readBuf.toString('utf8')).toBe('hello');
    const getCall = sentCalls.find((c) => c.cmd instanceof GetObjectCommand);
    expect(getCall).toBeDefined();
    expect((getCall!.cmd as GetObjectCommand).input).toMatchObject({
      Bucket: 'my-bucket',
      Key: 'team/state.json',
      IfMatch: '"etag-1"',
      IfNoneMatch: '"etag-old"',
    });
    expect(getCall!.opts?.abortSignal).toBe(controller.signal);

    // Bulk streaming keeps working without forcing a short abortSignal onto the GetObjectCommand call.
    sentCalls.length = 0;
    const stream = await provider.createReadStream('/my-bucket/big.bin');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).toString('utf8')).toBe('hello');
    const streamGet = sentCalls.find((c) => c.cmd instanceof GetObjectCommand);
    expect(streamGet?.opts).toBeUndefined();
  });
});

function createCasMemoryBucket() {
  let seq = 0;
  const objects = new Map<string, { data: Buffer; mtime: string; etag: string }>();
  const preconditionsFailed = () =>
    Object.assign(new Error('PreconditionFailed: ETag mismatch'), {
      name: 'PreconditionFailed',
      $metadata: { httpStatusCode: 412 },
    });
  const missing = (key: string) => Object.assign(new Error(`NoSuchKey: ${key}`), { name: 'NoSuchKey' });

  const writeFileFn = async (
    key: string,
    data: Buffer | Uint8Array,
    options?: WriteStreamOptions & { ifMatch?: string; ifNoneMatch?: string; signal?: AbortSignal },
  ) => {
    const existing = objects.get(key);
    if (options?.ifNoneMatch === '*' && existing) {
      provider.preconditionFailures += 1;
      throw preconditionsFailed();
    }
    if (options?.ifMatch && (!existing || existing.etag !== options.ifMatch)) {
      provider.preconditionFailures += 1;
      throw preconditionsFailed();
    }
    provider.writeCount += 1;
    seq += 1;
    objects.set(key, {
      data: Buffer.from(data),
      mtime: new Date(Date.UTC(2026, 5, 1, 0, 0, seq)).toISOString(),
      etag: `"etag-${seq}"`,
    });
  };

  const provider: IStorageProvider & {
    connect(): Promise<void>;
    writeCount: number;
    preconditionFailures: number;
    hangReads: boolean;
    failPolls: boolean;
  } = {
    id: 's3-cas-memory',
    name: 'CAS Memory Bucket',
    type: 's3',
    writeCount: 0,
    preconditionFailures: 0,
    hangReads: false,
    failPolls: false,
    connect: async () => {},
    disconnect: async () => {},
    stat: async (key): Promise<FileEntry> => {
      if (provider.failPolls) throw new Error('Transient S3 503');
      const obj = objects.get(key);
      if (!obj) throw missing(key);
      return {
        name: path.posix.basename(key),
        path: key,
        size: obj.data.length,
        isDirectory: false,
        mtime: obj.mtime,
        etag: obj.etag,
      };
    },
    readFile: async (key, options?: { signal?: AbortSignal }) => {
      if (provider.hangReads) {
        return await new Promise<Buffer>((_resolve, reject) => {
          const onAbort = () => reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' }));
          if (options?.signal?.aborted) {
            onAbort();
            return;
          }
          options?.signal?.addEventListener('abort', onAbort, { once: true });
        });
      }
      const obj = objects.get(key);
      if (!obj) throw missing(key);
      return Buffer.from(obj.data);
    },
    writeFile: writeFileFn as IStorageProvider['writeFile'],
    list: async (dir) => {
      return [...objects.entries()]
        .filter(([k]) => k.startsWith(`${dir}/`) && !k.slice(dir.length + 1).includes('/'))
        .map(([k, obj]) => ({
          name: path.posix.basename(k),
          path: k,
          size: obj.data.length,
          isDirectory: false,
          mtime: obj.mtime,
          etag: obj.etag,
        }));
    },
    createFolder: async () => {},
    delete: async (key) => {
      objects.delete(key);
    },
    rename: async () => {},
    createReadStream: async () => {
      throw new Error('use readFile');
    },
    createWriteStream: async () => {
      throw new Error('use writeFile');
    },
  };

  return { provider, objects };
}

async function writeTeamConfig(filePath: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    JSON.stringify({
      enabled: true,
      region: 'eu-north-1',
      bucket: 'team-bucket',
      prefix: 'team',
      accessKeyId: 'AKIATEAM',
      secretAccessKeyEncrypted: 'team-secret', // pragma: allowlist secret
      forcePathStyle: true,
    }),
  );
}

describe('S3WorkspaceSyncService resilience, CAS, presence, and invite tokens', () => {
  it('never wedges syncQueue/syncing on hung S3 socket and resets cleanly after timeout', async () => {
    const dir = await makeTempDir('sshs3-hang-');
    const cfgPath = path.join(dir, 's3.json');
    await writeTeamConfig(cfgPath);
    const { provider, objects } = createCasMemoryBucket();
    // Seed remote workspace so syncNow attempts readFile (which hangs).
    objects.set('team-bucket/team/workspace.json', {
      data: Buffer.from(JSON.stringify({ version: 1, updatedAt: 100, updatedBy: 'peer', servers: [], memories: [] })),
      mtime: new Date(1000).toISOString(),
      etag: '"etag-seed"',
    });
    provider.hangReads = true;

    const service = new S3WorkspaceSyncService(
      cfgPath,
      {
        getLocalState: async () => ({
          actor: 'alice',
          clientId: 'macbook',
          servers: [],
          memories: [],
          activityLog: [],
          deletedServerIds: {},
          deletedMemoryIds: {},
          activeTerminals: [],
        }),
        applyMergedState: async () => {},
        onStateChanged: () => {},
      },
      {
        providerFactory: () => provider,
        requestTimeoutMs: 40,
        pollIntervalMs: 60_000,
        presenceIntervalMs: 60_000,
      },
    );
    disposals.push(() => service.dispose());

    await service.load();
    await expect(service.syncNow()).rejects.toThrow(/timed out|aborted/i);
    expect(service.getStatus().syncing).toBe(false);

    // Recover once socket is healthy again: syncQueue was not wedged.
    provider.hangReads = false;
    await expect(service.syncNow()).resolves.toBeUndefined();
    expect(service.getStatus().syncing).toBe(false);
    expect(service.getStatus().error).toBeUndefined();
  });

  it('applies exponential backoff on pollOnce errors and clears backoff on recovery', async () => {
    const dir = await makeTempDir('sshs3-backoff-');
    const cfgPath = path.join(dir, 's3.json');
    await writeTeamConfig(cfgPath);
    const { provider } = createCasMemoryBucket();

    const service = new S3WorkspaceSyncService(
      cfgPath,
      {
        getLocalState: async () => ({
          actor: 'alice',
          clientId: 'linux-ws',
          servers: [],
          memories: [],
          activityLog: [],
          deletedServerIds: {},
          deletedMemoryIds: {},
          activeTerminals: [],
        }),
        applyMergedState: async () => {},
        onStateChanged: () => {},
      },
      {
        providerFactory: () => provider,
        pollIntervalMs: 1_000,
        maxPollBackoffMs: 16_000,
      },
    );
    disposals.push(() => service.dispose());
    await service.load();
    await service.syncNow();

    provider.failPolls = true;
    await service.pollOnce();
    const state1 = service.getPollBackoffState();
    expect(state1.consecutiveErrors).toBe(1);
    expect(state1.nextPollAllowedAt).toBeGreaterThan(Date.now() - 50);

    // Calling pollOnce immediately during backoff skips hitting S3.
    const statSpy = vi.spyOn(provider, 'stat');
    await service.pollOnce();
    expect(statSpy).not.toHaveBeenCalled();

    // Syncing successfully clears backoff state.
    provider.failPolls = false;
    await service.syncNow();
    expect(service.getPollBackoffState()).toEqual({ consecutiveErrors: 0, nextPollAllowedAt: 0 });
  });

  it('retries and merges cleanly on ETag If-Match 412 conflict without losing concurrent edits', async () => {
    const dir = await makeTempDir('sshs3-cas-');
    const cfgPath = path.join(dir, 's3.json');
    await writeTeamConfig(cfgPath);
    const { provider, objects } = createCasMemoryBucket();
    const key = 'team-bucket/team/workspace.json';
    objects.set(key, {
      data: Buffer.from(
        JSON.stringify({
          version: 1,
          updatedAt: 100,
          updatedBy: 'bob',
          servers: [{ id: 'srv-bob', name: 'Bob DB', host: '10.0.0.2', port: 22, username: 'ops', authType: 'agent', shared: true, updatedAt: new Date(100).toISOString() }],
          memories: [],
        }),
      ),
      mtime: new Date(1000).toISOString(),
      etag: '"etag-v1"',
    });

    // Simulate a teammate sneaking a write in right after our initial read so our first CAS write gets 412.
    let injectedRace = false;
    const origWrite = provider.writeFile!;
    provider.writeFile = (async (
      remotePath: string,
      data: Buffer | Uint8Array,
      opts?: WriteStreamOptions,
    ) => {
      if (!injectedRace && remotePath === key) {
        injectedRace = true;
        objects.set(key, {
          data: Buffer.from(
            JSON.stringify({
              version: 1,
              updatedAt: 200,
              updatedBy: 'carol',
              servers: [
                { id: 'srv-bob', name: 'Bob DB', host: '10.0.0.2', port: 22, username: 'ops', authType: 'agent', shared: true, updatedAt: new Date(100).toISOString() },
                { id: 'srv-carol', name: 'Carol Cache', host: '10.0.0.3', port: 22, username: 'ops', authType: 'agent', shared: true, updatedAt: new Date(200).toISOString() },
              ],
              memories: [],
            }),
          ),
          mtime: new Date(2000).toISOString(),
          etag: '"etag-carol"',
        });
      }
      return origWrite(remotePath, data, opts);
    }) as IStorageProvider['writeFile'];

    let mergedApplied: { activeServers: Array<{ id: string }> } | undefined;
    const service = new S3WorkspaceSyncService(
      cfgPath,
      {
        getLocalState: async () => ({
          actor: 'alice',
          clientId: 'dev-1',
          servers: [{ id: 'srv-alice', name: 'Alice App', host: '10.0.0.1', port: 22, username: 'ops', authType: 'agent' as const, shared: true, updatedAt: new Date(150).toISOString() }],
          memories: [],
          activityLog: [],
          deletedServerIds: {},
          deletedMemoryIds: {},
          activeTerminals: [],
        }),
        applyMergedState: async (merged) => {
          mergedApplied = { activeServers: merged.activeServers };
        },
        onStateChanged: () => {},
      },
      { providerFactory: () => provider },
    );
    disposals.push(() => service.dispose());
    await service.load();
    await service.syncNow();

    expect(provider.preconditionFailures).toBe(1);
    const ids = (mergedApplied?.activeServers ?? []).map((s) => s.id).sort();
    expect(ids).toEqual(['srv-alice', 'srv-bob', 'srv-carol']);
  });

  it('keys presence files by actor + clientId so two machines for one actor do not overwrite each other', async () => {
    const dirA = await makeTempDir('sshs3-pres-a-');
    const dirB = await makeTempDir('sshs3-pres-b-');
    const cfgA = path.join(dirA, 's3.json');
    const cfgB = path.join(dirB, 's3.json');
    await writeTeamConfig(cfgA);
    await writeTeamConfig(cfgB);
    const { provider, objects } = createCasMemoryBucket();

    const makeCallbacks = (clientId: string, host: string): S3WorkspaceSyncCallbacks => ({
      getLocalState: async () => ({
        actor: 'alice',
        clientId,
        servers: [],
        memories: [],
        activityLog: [],
        deletedServerIds: {},
        deletedMemoryIds: {},
        activeTerminals: [{ targetLabel: host, state: 'connected', since: 1000 }],
      }),
      applyMergedState: async () => {},
      onStateChanged: () => {},
    });

    const svcA = new S3WorkspaceSyncService(cfgA, makeCallbacks('laptop-1', '10.0.0.1'), {
      providerFactory: () => provider,
      clientId: 'laptop-1',
    });
    const svcB = new S3WorkspaceSyncService(cfgB, makeCallbacks('desktop-2', '10.0.0.2'), {
      providerFactory: () => provider,
      clientId: 'desktop-2',
    });
    disposals.push(() => svcA.dispose(), () => svcB.dispose());

    await svcA.load();
    await svcB.load();
    await svcA.syncNow();
    await svcB.syncNow();

    expect(objects.has('team-bucket/team/presence/alice--laptop-1.json')).toBe(true);
    expect(objects.has('team-bucket/team/presence/alice--desktop-2.json')).toBe(true);
    expect(svcB.getPresence().map((p) => p.clientId).sort()).toEqual(['desktop-2', 'laptop-1']);

    // A file nobody has refreshed for a day (an installation that is gone) is taken away at the next
    // sync; one that is merely not shown any more (older than the 45 s window) stays.
    const stale = (updatedAt: number) => ({
      data: Buffer.from(JSON.stringify({ actor: 'alice', clientId: 'old', updatedAt, activeTerminals: [] })),
      mtime: new Date(updatedAt).toISOString(),
      etag: '"old"',
    });
    objects.set('team-bucket/team/presence/alice--gone.json', stale(Date.now() - 25 * 60 * 60_000));
    objects.set('team-bucket/team/presence/alice--away.json', stale(Date.now() - 10 * 60_000));
    await svcA.publishAndRefreshPresence();
    expect(objects.has('team-bucket/team/presence/alice--gone.json')).toBe(false);
    expect(objects.has('team-bucket/team/presence/alice--away.json')).toBe(true);
    expect(objects.has('team-bucket/team/presence/alice--laptop-1.json')).toBe(true);
  });

  it('supports tokenized short-lived revocable v2 invites, warns on raw secretAccessKey, and keeps v1 decode compatible', () => {
    const baseCfg: S3WorkspaceConfig = {
      enabled: true,
      region: 'eu-west-1',
      bucket: 'team-bkt',
      prefix: 'ws',
      accessKeyId: 'AKIAPUBLIC',
      secretAccessKey: 'super-raw-secret-value', // pragma: allowlist secret
    };

    const tokenInvite = encodeS3WorkspaceInviteToken(baseCfg, {
      token: 'tok_short_lived_abc',
      tokenId: 'tid-1',
      ttlMs: 60_000,
    });
    const parsedToken = validateS3WorkspaceInvite(tokenInvite, { now: Date.now() + 1_000 });
    expect(parsedToken.valid).toBe(true);
    expect(parsedToken.version).toBe(2);
    expect(parsedToken.hasRawSecret).toBe(false);
    expect(parsedToken.inviteToken).toBe('tok_short_lived_abc');
    expect(parsedToken.config?.secretAccessKey).toBeUndefined();

    // Expired token is rejected.
    const expiredCheck = validateS3WorkspaceInvite(tokenInvite, { now: Date.now() + 120_000 });
    expect(expiredCheck.valid).toBe(false);
    expect(expiredCheck.expired).toBe(true);

    // Revoked token is rejected cleanly.
    const revokedCheck = validateS3WorkspaceInvite(tokenInvite, {
      revokedTokenIds: new Set(['tid-1']),
    });
    expect(revokedCheck.valid).toBe(false);
    expect(revokedCheck.revoked).toBe(true);
    expect(() => decodeS3WorkspaceInvite(tokenInvite, { revokedTokenIds: new Set(['tid-1']) })).toThrow(/revoked/i);

    // Legacy v1 invite carries raw secret warning in validation while remaining backward-compatible.
    const v1Invite = encodeS3WorkspaceInvite(baseCfg);
    const validatedV1 = validateS3WorkspaceInvite(v1Invite);
    expect(validatedV1.valid).toBe(true);
    expect(validatedV1.hasRawSecret).toBe(true);
    expect(validatedV1.warning).toMatch(/raw secretAccessKey/i);
    const decodedV1 = decodeS3WorkspaceInvite(v1Invite);
    expect(decodedV1.secretAccessKey).toBe('super-raw-secret-value');
  });
});

describe('WorkSync CAS conditional claim & markOnce', () => {
  function createCasQueueStore(): {
    store: ConditionalQueueStore;
    files: Map<string, { buffer: Buffer; etag: string }>;
    writeCalls: Array<{ path: string; ifMatch?: string; ifNoneMatch?: string }>;
  } {
    let ver = 0;
    const files = new Map<string, { buffer: Buffer; etag: string }>();
    const writeCalls: Array<{ path: string; ifMatch?: string; ifNoneMatch?: string }> = [];
    const store: ConditionalQueueStore = {
      supportsConditionalWrite: true,
      list: async (prefix) => [...files.keys()].filter((k) => k.startsWith(prefix)),
      read: async (p) => files.get(p)?.buffer,
      readWithMeta: async (p) => files.get(p),
      write: async (p, content, options) => {
        writeCalls.push({ path: p, ifMatch: options?.ifMatch, ifNoneMatch: options?.ifNoneMatch });
        const cur = files.get(p);
        if (options?.ifNoneMatch === '*' && cur) {
          throw Object.assign(new Error('412 PreconditionFailed'), {
            name: 'PreconditionFailed',
            $metadata: { httpStatusCode: 412 },
          });
        }
        if (options?.ifMatch && (!cur || cur.etag !== options.ifMatch)) {
          throw Object.assign(new Error('412 PreconditionFailed'), {
            name: 'PreconditionFailed',
            $metadata: { httpStatusCode: 412 },
          });
        }
        ver += 1;
        files.set(p, { buffer: Buffer.from(content), etag: `"q-${ver}"` });
      },
      remove: async (p) => {
        files.delete(p);
      },
    };
    return { store, files, writeCalls };
  }

  it('uses If-None-Match: "*" in markOnce and claim on CAS-capable stores without settle race', async () => {
    const { store, writeCalls } = createCasQueueStore();
    const syncA = new WorkSync(store);
    const syncB = new WorkSync(store);
    const settleSpy = vi.fn(async () => {});

    const [firstMark, secondMark] = await Promise.all([
      syncA.markOnce('alert:1', 'client-a', settleSpy, 1_000),
      syncB.markOnce('alert:1', 'client-b', settleSpy, 1_000),
    ]);
    expect([firstMark, secondMark].sort()).toEqual([false, true]);
    expect(settleSpy).not.toHaveBeenCalled();
    expect(writeCalls.some((c) => c.ifNoneMatch === '*')).toBe(true);

    const [claimA, claimB] = await Promise.all([
      syncA.claim('t-1', { by: 'agent-a', client: 'client-a' }, 2_000, { settle: settleSpy }),
      syncB.claim('t-1', { by: 'agent-b', client: 'client-b' }, 2_000, { settle: settleSpy }),
    ]);
    expect(claimA.client).toBe(claimB.client);
    expect(['client-a', 'client-b']).toContain(claimA.client);
    expect(settleSpy).not.toHaveBeenCalled();

    const winner = claimA.client;
    const loser = winner === 'client-a' ? 'client-b' : 'client-a';
    expect(await syncA.refresh('t-1', winner, 3_000)).toBe(true);
    expect(await syncB.refresh('t-1', loser, 3_000)).toBe(false);
  });

  it('falls back to settle() on plain QueueStore mocks without conditional support', async () => {
    const files = new Map<string, Buffer>();
    const plainStore: ConditionalQueueStore = {
      list: async (p) => [...files.keys()].filter((k) => k.startsWith(p)),
      read: async (p) => files.get(p),
      write: async (p, content) => {
        files.set(p, Buffer.from(content));
      },
      remove: async (p) => {
        files.delete(p);
      },
    };
    const sync = new WorkSync(plainStore);
    const settleSpy = vi.fn(async () => {});
    const res = await sync.claim('t-legacy', { by: 'agent-1', client: 'c-1' }, 1_000, { settle: settleSpy });
    expect(res.client).toBe('c-1');
    expect(settleSpy).toHaveBeenCalledTimes(1);
  });
});

describe('WorkBoard HLC tie-breaking, hypothesis/correlatedAlert sync, and upstream dependency sorting', () => {
  it('breaks equal timestamp ties deterministically with Hybrid Logical Clocks', () => {
    // Equal updatedAt falls back to HLC comparison.
    expect(
      compareVersion(
        { updatedAt: 1_000, hlc: { ts: 1_000, counter: 1, clientId: 'a' } },
        { updatedAt: 1_000, hlc: { ts: 1_000, counter: 1, clientId: 'b' } },
      ),
    ).toBeLessThan(0);
  });

  it('merges ticket hypotheses and correlatedAlerts commutatively in mergeTicketCopies', () => {
    const baseAlert: CorrelatedAlertRef = { fingerprint: 'disk:/var', summary: 'disk 90% on s1', at: 100, severity: 'warning' };
    const extraAlert: CorrelatedAlertRef = { fingerprint: 'oom:worker', summary: 'oom killed on s2', at: 200, severity: 'critical' };

    const makeTicket = (partial: Partial<MergeableTicket>): MergeableTicket => ({
      id: 't1',
      title: 'Investigate outage',
      description: 'Investigate service outage',
      goalId: 'g1',
      status: 'in_progress',
      createdBy: 'ops',
      createdAt: 50,
      updatedAt: 100,
      comments: [],
      ...partial,
    });

    const local = makeTicket({
      updatedAt: 120,
      hypotheses: [
        {
          id: 'h1',
          text: 'Log rotation stalled',
          status: 'open',
          evidence: [{ supports: true, text: 'df -h' }],
        },
      ],
      correlatedAlerts: [baseAlert],
    });
    const remote = makeTicket({
      updatedAt: 130,
      hypotheses: [
        {
          id: 'h1',
          text: 'Log rotation stalled',
          status: 'confirmed',
          evidence: [{ supports: true, text: 'journalctl full' }],
        },
        { id: 'h2', text: 'Memory leak in worker', status: 'open', evidence: [] },
      ],
      correlatedAlerts: [extraAlert],
    });

    const ab = mergeTicketCopies(local, remote) as MergeableTicket;
    const ba = mergeTicketCopies(remote, local) as MergeableTicket;

    expect(ab.hypotheses?.map((h) => h.id)).toEqual(['h1', 'h2']);
    expect(ab.hypotheses?.find((h) => h.id === 'h1')?.status).toBe('confirmed');
    expect(ab.hypotheses?.find((h) => h.id === 'h1')?.evidence).toEqual([
      { supports: true, text: 'df -h' },
      { supports: true, text: 'journalctl full' },
    ]);
    expect(ab.correlatedAlerts?.map((a) => a.fingerprint)).toEqual(['disk:/var', 'oom:worker']);

    expect(ba.hypotheses).toEqual(ab.hypotheses);
    expect(ba.correlatedAlerts).toEqual(ab.correlatedAlerts);
  });

  it('prioritizes upstream infraEdges dependencies in sortTicketsByPriority, sortAlertsByUpstream, and nextForHeartbeat', () => {
    const edges: InfraGraphEdge[] = [
      { id: 'e1', from: 'api-node', to: 'pg-primary', relation: 'depends_on', updatedAt: 1 },
      { id: 'e2', from: 'web-edge', to: 'api-node', relation: 'routes_to', updatedAt: 1 },
      // Proposed edges must not alter deterministic ordering until accepted.
      { id: 'e3', from: 'pg-primary', to: 'web-edge', relation: 'depends_on', updatedAt: 1, proposed: true },
    ];

    const tWeb: WorkTicket = {
      id: 't-web',
      title: 'Web 502',
      description: 'Web tier 502',
      goalId: 'g1',
      status: 'todo',
      target: 'web-edge',
      assigneeAgentId: 'agent-ops',
      createdBy: 'ops',
      createdAt: 10,
      updatedAt: 10,
      comments: [],
    };
    const tApi: WorkTicket = {
      id: 't-api',
      title: 'API timeouts',
      description: 'API tier timeouts',
      goalId: 'g1',
      status: 'todo',
      target: 'api-node',
      assigneeAgentId: 'agent-ops',
      createdBy: 'ops',
      createdAt: 20,
      updatedAt: 20,
      comments: [],
    };
    const tDb: WorkTicket = {
      id: 't-db',
      title: 'Postgres WAL stalled',
      description: 'Primary DB WAL stalled',
      goalId: 'g1',
      status: 'todo',
      target: 'pg-primary',
      assigneeAgentId: 'agent-ops',
      createdBy: 'ops',
      createdAt: 30,
      updatedAt: 30,
      comments: [],
    };

    const sortedTickets = sortTicketsByPriority([tWeb, tApi, tDb], edges);
    expect(sortedTickets.map((t) => t.id)).toEqual(['t-db', 't-api', 't-web']);

    const sortedAlerts = sortAlertsByUpstream(
      [
        { target: 'web-edge', id: 'a-web', severity: 'critical', at: 10 },
        { target: 'pg-primary', id: 'a-db', severity: 'critical', at: 20 },
      ],
      edges,
    );
    expect(sortedAlerts.map((a) => a.id)).toEqual(['a-db', 'a-web']);

    const opsAgent: MissionAgent = {
      id: 'agent-ops',
      name: 'Ops',
      role: 'sre',
      icon: '🔧',
      mission: 'Triage infra alerts',
      systemPrompt: '',
      defaultMode: 'advice',
      updatedAt: 1,
    };
    const picked = nextForHeartbeat({
      tickets: [tWeb, tApi, tDb],
      agents: [opsAgent],
      client: 'c-1',
      infraEdges: edges,
      now: 1_000,
    });
    expect(picked?.id).toBe('t-db');
  });
});

describe('WorkforceRunner RunScratchpad, structured specialist outputs, and TargetSelector dispatch', () => {
  it('shares RunScratchpad across specialists and parses/enforces structured specialist outputs', async () => {
    const scratchpad = new RunScratchpad('run-overhaul');
    scratchpad.addFact({ text: 'Node 2 is draining', evidence: 'kubectl get nodes', addedBy: 'Coordinator' });
    expect(scratchpad.snapshot().confirmedFacts).toHaveLength(1);

    const invalid = validateStructuredSpecialistOutput('Just some unstructured prose without findings');
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.missing).toEqual(['findings', 'unchecked', 'recommendedCommands']);
    }

    const parsed = parseStructuredSpecialistOutput(
      JSON.stringify({
        findings: ['Disk /var/log at 98%'],
        unchecked: ['Inode usage on /tmp'],
        recommendedCommands: ['du -sh /var/log/*'],
        confirmedFacts: [{ text: '/var/log/syslog is 42GB', evidence: 'ls -lh /var/log', target: 'app-1' }],
        checkedTargets: ['app-1'],
        hypotheses: [{ text: 'logrotate timer stopped', status: 'confirmed' }],
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.findings).toEqual(['Disk /var/log at 98%']);

    const storageAgent: MissionAgent = {
      id: 'a-storage',
      name: 'Storage',
      role: 'Storage',
      icon: '💾',
      mission: 'Inspect disks',
      systemPrompt: '',
      defaultMode: 'advice',
      updatedAt: 1,
    };
    const systemdAgent: MissionAgent = {
      id: 'a-systemd',
      name: 'Systemd',
      role: 'Systemd',
      icon: '⚙️',
      mission: 'Inspect timers',
      systemPrompt: '',
      defaultMode: 'advice',
      updatedAt: 1,
    };

    const promptsSeen: string[] = [];
    let synthesisScratchpad: RunScratchpad | undefined;
    const run = await runWorkforce(
      {
        prompt: 'Find what fills /var/log',
        concurrency: 2,
        requireStructuredOutput: true,
        agents: [storageAgent, systemdAgent],
      },
      {
        onProgress: () => {},
        runSpecialist: async ({ agent, agentName, prompt, scratchpad: sp }) => {
          promptsSeen.push(prompt);
          if (!agent) {
            // Synthesis lead call receives the shared RunScratchpad populated by completed specialists.
            synthesisScratchpad = sp;
            expect(sp?.hasCheckedTarget('app-1')).toBe(true);
            return { status: 'completed', text: 'Combined diagnosis complete.' };
          }
          expect(sp).toBeDefined();
          if (agentName === 'Storage') {
            return {
              status: 'completed',
              text: JSON.stringify({
                findings: ['Disk full on /var/log'],
                unchecked: ['Journald vacuum'],
                recommendedCommands: ['journalctl --disk-usage'],
                confirmedFacts: [{ text: '/var/log at 98%', evidence: 'df -h', target: 'app-1' }],
                checkedTargets: ['app-1'],
              }),
            };
          }
          // Non-structured output when requireStructuredOutput is true must mark the step failed.
          return {
            status: 'completed',
            text: 'Unstructured output that fails schema',
          };
        },
      },
    );

    expect(run.status).toBe('completed');
    expect(run.steps[0].status).toBe('completed');
    expect(run.steps[0].recommendedCommands).toEqual(['journalctl --disk-usage']);
    expect(run.steps[0].findings).toContain('Disk full on /var/log');
    expect(run.steps[1].status).toBe('failed');
    expect(run.steps[1].error).toMatch(/missing required structured fields/i);
    expect(synthesisScratchpad?.hasCheckedTarget('app-1')).toBe(true);
    expect(promptsSeen[promptsSeen.length - 1]).toContain('Shared run scratchpad');
  });

  it('plans and dispatches canary_then_rolling waves with concurrency and stopOnFailure circuit breaker', async () => {
    const candidates: TargetCandidate[] = [
      { id: 's1', name: 'web-1', host: '10.0.1.1', tags: ['prod', 'web'] },
      { id: 's2', name: 'web-canary', host: '10.0.1.2', tags: ['prod', 'canary', 'web'] },
      { id: 's3', name: 'web-3', host: '10.0.1.3', tags: ['prod', 'web'] },
      { id: 's4', name: 'db-1', host: '10.0.2.1', tags: ['prod', 'db'] },
    ];

    const selected = resolveTargetSelector(candidates, { tags: ['prod', 'web'] });
    expect(selected.map((c) => c.id)).toEqual(['s1', 's2', 's3']);

    const plan = planTargetDispatch(selected, {
      strategy: 'canary_then_rolling',
      canaryCount: 1,
      concurrency: 2,
      stopOnFailure: true,
      isCanary: (t) => t.tags?.includes('canary') ?? false,
    });
    expect(plan.canary.map((c) => c.id)).toEqual(['s2']);
    expect(plan.waves.map((w) => w.map((c) => c.id))).toEqual([['s2'], ['s1', 's3']]);

    // When canary fails and stopOnFailure=true, remaining rolling wave targets are skipped.
    const reportFail = await dispatchTargets(
      selected,
      async (target) => {
        if (target.id === 's2') throw new Error('canary healthcheck failed');
        return 'ok';
      },
      {
        strategy: 'canary_then_rolling',
        canaryCount: 1,
        concurrency: 2,
        stopOnFailure: true,
        isCanary: (t) => t.tags?.includes('canary') ?? false,
      },
    );
    expect(reportFail.haltedOnFailure).toBe(true);
    expect(reportFail.results).toHaveLength(1);
    expect(reportFail.results[0].ok).toBe(false);
    expect(reportFail.skipped.map((t) => t.id)).toEqual(['s1', 's3']);

    // When canary passes, all rolling wave targets run within bounded concurrency.
    let active = 0;
    let peak = 0;
    const reportOk = await dispatchTargets(
      selected,
      async (target) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active -= 1;
        return `checked:${target.id}`;
      },
      {
        strategy: 'canary_then_rolling',
        canaryCount: 1,
        concurrency: 2,
        stopOnFailure: true,
        isCanary: (t) => t.tags?.includes('canary') ?? false,
      },
    );
    expect(reportOk.haltedOnFailure).toBe(false);
    expect(reportOk.skipped).toHaveLength(0);
    expect(reportOk.results.filter((r) => r.ok)).toHaveLength(3);
    expect(peak).toBeLessThanOrEqual(2);
  });
});
