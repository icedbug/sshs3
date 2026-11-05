import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Readable, Writable } from 'node:stream';
import type { IStorageProvider, FileEntry, StorageType, WriteStreamOptions } from '../../src/shared/types/storage';
import { ProfileStore } from '../../src/main/profile/ProfileStore';
import { DotfilePoolStore } from '../../src/main/dotfiles/DotfilePoolStore';
import { SettingsStore } from '../../src/main/settings/SettingsStore';
import { DirectorySyncProfileStore } from '../../src/main/dirsync/DirectorySyncProfileStore';
import { K8sProfileStore } from '../../src/main/profile/K8sProfileStore';
import { SyncCryptoService, generateSalt, type ScryptParams } from '../../src/main/services/SyncCryptoService';
import {
  ProfileSyncService,
  SyncConflictError,
  SyncInProgressError,
  mergeRecords,
  mergePools,
  stripDeviceLocalPoolFields,
  getComparisonState,
  compareRecords,
  compareDotfilePools,
} from '../../src/main/services/ProfileSyncService';
import type { SSHConnectionConfig } from '../../src/shared/types/ssh';
import type { DotfilePool } from '../../src/shared/types/dotfiles';
import type { PolicyDocument } from '../../src/shared/types/policy';

const FAST_PARAMS: ScryptParams = { N: 16, r: 1, p: 1, maxmem: 4 * 1024 * 1024 };

/** In-memory IStorageProvider test double: enough of S3/SFTP semantics (stat/rename/streams) to exercise ProfileSyncService without a real backend. */
class FakeStorageProvider implements IStorageProvider {
  readonly id = 'fake';
  readonly name = 'fake';
  readonly type: StorageType;
  private files = new Map<string, { buffer: Buffer; mtime: string }>();
  private clock = 0;

  constructor(type: StorageType = 'sftp') {
    this.type = type;
  }

  async list(): Promise<FileEntry[]> {
    return [];
  }

  async stat(remotePath: string): Promise<FileEntry> {
    const entry = this.files.get(remotePath);
    if (!entry) {
      const err: any = new Error(`not found: ${remotePath}`);
      err.code = 'ENOENT';
      throw err;
    }
    return { name: path.basename(remotePath), path: remotePath, size: entry.buffer.length, isDirectory: false, mtime: entry.mtime };
  }

  async createFolder(): Promise<void> {}

  async delete(remotePath: string): Promise<void> {
    this.files.delete(remotePath);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const entry = this.files.get(oldPath);
    if (!entry) throw new Error(`rename source missing: ${oldPath}`);
    this.files.delete(oldPath);
    this.files.set(newPath, entry);
  }

  async createReadStream(remotePath: string): Promise<NodeJS.ReadableStream> {
    const entry = this.files.get(remotePath);
    if (!entry) {
      const err: any = new Error(`not found: ${remotePath}`);
      err.code = 'ENOENT';
      throw err;
    }
    return Readable.from([entry.buffer]);
  }

  async createWriteStream(remotePath: string, _options?: WriteStreamOptions): Promise<NodeJS.WritableStream> {
    const chunks: Buffer[] = [];
    return new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk as Buffer);
        cb();
      },
      final: (cb) => {
        this.clock += 1;
        this.files.set(remotePath, { buffer: Buffer.concat(chunks), mtime: String(this.clock) });
        cb();
      },
    });
  }

  /** Test-only escape hatch to simulate a write made by a different machine/process. */
  simulateExternalWrite(remotePath: string, buffer: Buffer): void {
    this.clock += 1;
    this.files.set(remotePath, { buffer, mtime: String(this.clock) });
  }

  hasFile(remotePath: string): boolean {
    return this.files.has(remotePath);
  }

  getRawBuffer(remotePath: string): Buffer | undefined {
    return this.files.get(remotePath)?.buffer;
  }
}

/**
 * In reality every machine in one sync setup shares the same salt per key
 * group (generated once, at "enable", and embedded in every uploaded file)
 * — only the first machine picks it; every other machine learns it either
 * by bootstrapping via pullFromRemote(password) or, as here, by already
 * having joined. Tests simulating multiple already-synced machines must
 * pass the SAME salts to every harness(), or their independently-cached
 * keys won't agree even with the same password.
 */
function makeCrypto(topologySalt: Buffer, credentialsSalt: Buffer): SyncCryptoService {
  const crypto = new SyncCryptoService(FAST_PARAMS);
  crypto.unlock('topology', 'topology-master-password', topologySalt);
  crypto.unlock('credentials', 'credentials-master-password', credentialsSalt);
  return crypto;
}

interface Harness {
  profileStore: ProfileStore;
  dotfilePoolStore: DotfilePoolStore;
  settingsStore: SettingsStore;
  dirSyncStore: DirectorySyncProfileStore;
  k8sStore: K8sProfileStore;
  sync: ProfileSyncService;
  dir: string;
  sshConfigPath: string;
  knownHostsPath: string;
}

async function makeHarness(topologySalt: Buffer, credentialsSalt: Buffer, policy?: PolicyDocument): Promise<Harness> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sshs3-sync-test-'));
  const sshConfigPath = path.join(dir, 'ssh_config');
  const knownHostsPath = path.join(dir, 'known_hosts');
  const profileStore = new ProfileStore(path.join(dir, 'profiles.json'));
  const dotfilePoolStore = new DotfilePoolStore(path.join(dir, 'dotfile-pools.json'));
  const settingsStore = new SettingsStore(path.join(dir, 'settings.json'), policy);
  const dirSyncStore = new DirectorySyncProfileStore(path.join(dir, 'directory-sync-profiles.json'));
  const k8sStore = new K8sProfileStore(path.join(dir, 'k8s-profiles.json'));
  const sync = new ProfileSyncService(profileStore, dotfilePoolStore, settingsStore, makeCrypto(topologySalt, credentialsSalt), {
    sshConfigPath,
    knownHostsPath,
    directorySyncProfileStore: dirSyncStore,
    k8sProfileStore: k8sStore,
  });
  return { profileStore, dotfilePoolStore, settingsStore, dirSyncStore, k8sStore, sync, dir, sshConfigPath, knownHostsPath };
}

describe('ProfileSyncService', () => {
  let provider: FakeStorageProvider;
  let dirs: string[] = [];

  beforeEach(() => {
    provider = new FakeStorageProvider();
    dirs = [];
  });

  afterEach(async () => {
    for (const dir of dirs) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  let sharedTopologySalt: Buffer;
  let sharedCredentialsSalt: Buffer;

  beforeEach(() => {
    sharedTopologySalt = generateSalt();
    sharedCredentialsSalt = generateSalt();
  });

  /** A "machine" already joined to the same sync setup as every other harness() call within one test. */
  async function harness(policy?: PolicyDocument): Promise<Harness> {
    const h = await makeHarness(sharedTopologySalt, sharedCredentialsSalt, policy);
    dirs.push(h.dir);
    return h;
  }

  const dirSyncProfile = (id: string, name: string) => ({
    id,
    name,
    source: { providerConfigRef: 'local', path: '/data' },
    target: { providerConfigRef: 'sftp-ssh-1', path: '/backup' },
    deleteExtraneous: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  it('round-trips saved directory-sync profiles between two machines', async () => {
    const machineA = await harness();
    await machineA.dirSyncStore.save(dirSyncProfile('ds-1', 'Nightly backup'));
    await machineA.sync.pushToRemote(provider);
    expect(provider.getRawBuffer('~/.sshs3/dirsync-profiles.enc')).toBeDefined();

    const machineB = await harness();
    const result = await machineB.sync.pullFromRemote(provider);

    expect(result.changedCategories).toContain('dirsync-profiles');
    const profiles = await machineB.dirSyncStore.list();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({ id: 'ds-1', name: 'Nightly backup', target: { providerConfigRef: 'sftp-ssh-1', path: '/backup' } });
  });

  it('propagates the deletion of a directory-sync profile', async () => {
    const machineA = await harness();
    await machineA.dirSyncStore.save(dirSyncProfile('ds-1', 'Nightly backup'));
    await machineA.sync.pushToRemote(provider);

    const machineB = await harness();
    await machineB.sync.pullFromRemote(provider);
    expect(await machineB.dirSyncStore.list()).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await machineA.dirSyncStore.delete('ds-1');
    await machineA.sync.pushToRemote(provider);
    await machineB.sync.pullFromRemote(provider);

    expect(await machineB.dirSyncStore.list()).toHaveLength(0);
  });

  it('reports directory-sync profile differences in compareWithRemote', async () => {
    const machineA = await harness();
    await machineA.sync.pushToRemote(provider);
    await machineA.dirSyncStore.save(dirSyncProfile('ds-1', 'Nightly backup'));

    const comparison = await machineA.sync.compareWithRemote(provider);
    const category = comparison.categories.find((c) => c.category === 'dirsync-profiles');
    expect(category).toMatchObject({ state: 'ahead', ahead: 1, behind: 0 });
  });

  it('pulls fine from a remote pushed before directory-sync profiles were synced', async () => {
    const machineA = await harness();
    await machineA.sync.pushToRemote(provider);
    await provider.delete('~/.sshs3/dirsync-profiles.enc');

    const machineB = await harness();
    await machineB.dirSyncStore.save(dirSyncProfile('ds-local', 'Local only'));
    const result = await machineB.sync.pullFromRemote(provider);

    expect(result.changedCategories).not.toContain('dirsync-profiles');
    expect(await machineB.dirSyncStore.list()).toHaveLength(1);
  });

  const k8sProfile = (id: string, name: string, over: Record<string, unknown> = {}) => ({
    id,
    name,
    server: 'https://api.example.com:6443',
    namespace: 'team-a',
    ...over,
  });

  it('round-trips saved K8s profiles but never the machine-local kubeconfig context', async () => {
    const machineA = await harness();
    await machineA.k8sStore.save(k8sProfile('k-1', 'Prod', { contextName: 'team-a/api/alice', insecureSkipTlsVerify: true }));
    await machineA.sync.pushToRemote(provider);
    expect(provider.getRawBuffer('~/.sshs3/k8s-profiles.enc')).toBeDefined();

    const machineB = await harness();
    const result = await machineB.sync.pullFromRemote(provider);

    expect(result.changedCategories).toContain('k8s-profiles');
    const profiles = await machineB.k8sStore.list();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({ id: 'k-1', name: 'Prod', namespace: 'team-a', insecureSkipTlsVerify: true });
    expect(profiles[0].contextName).toBeUndefined();
  });

  it('keeps this machine\'s own context name when a newer remote copy wins', async () => {
    const machineA = await harness();
    await machineA.k8sStore.save(k8sProfile('k-1', 'Prod'));
    await machineA.sync.pushToRemote(provider);
    const machineB = await harness();
    await machineB.sync.pullFromRemote(provider);
    await machineB.k8sStore.save({ ...(await machineB.k8sStore.list())[0], contextName: 'local-context' });

    await new Promise((resolve) => setTimeout(resolve, 5));
    await machineA.k8sStore.save(k8sProfile('k-1', 'Prod renamed'));
    await machineA.sync.pushToRemote(provider);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await machineB.sync.pullFromRemote(provider);

    expect((await machineB.k8sStore.list())[0]).toMatchObject({ name: 'Prod renamed', contextName: 'local-context' });
  });

  it('propagates the deletion of a K8s profile', async () => {
    const machineA = await harness();
    await machineA.k8sStore.save(k8sProfile('k-1', 'Prod'));
    await machineA.sync.pushToRemote(provider);
    const machineB = await harness();
    await machineB.sync.pullFromRemote(provider);
    expect(await machineB.k8sStore.list()).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await machineA.k8sStore.delete('k-1');
    await machineA.sync.pushToRemote(provider);
    await machineB.sync.pullFromRemote(provider);

    expect(await machineB.k8sStore.list()).toHaveLength(0);
  });

  it('reports K8s profile differences in compareWithRemote', async () => {
    const machineA = await harness();
    await machineA.sync.pushToRemote(provider);
    await machineA.k8sStore.save(k8sProfile('k-1', 'Prod'));

    const comparison = await machineA.sync.compareWithRemote(provider);
    expect(comparison.categories.find((c) => c.category === 'k8s-profiles')).toMatchObject({
      state: 'ahead',
      ahead: 1,
      behind: 0,
    });
  });

  it('pulls fine from a remote pushed before K8s profiles were synced', async () => {
    const machineA = await harness();
    await machineA.sync.pushToRemote(provider);
    await provider.delete('~/.sshs3/k8s-profiles.enc');

    const machineB = await harness();
    await machineB.k8sStore.save(k8sProfile('k-local', 'Local only'));
    const result = await machineB.sync.pullFromRemote(provider);

    expect(result.changedCategories).not.toContain('k8s-profiles');
    expect(await machineB.k8sStore.list()).toHaveLength(1);
  });

  it('keeps local folders when a pull changes profiles', async () => {
    const machineA = await harness();
    await machineA.profileStore.saveSSH({
      id: 'ssh-1',
      name: 'Prod',
      host: 'prod.example.com',
      username: 'admin',
      authType: 'password',
      password: 'pw', // pragma: allowlist secret
    });
    await machineA.sync.pushToRemote(provider);

    const machineB = await harness();
    await machineB.profileStore.saveFolder('Staging');
    const result = await machineB.sync.pullFromRemote(provider);

    expect(result.changedCategories).toContain('topology');
    expect((await machineB.profileStore.getProfiles()).folders).toEqual(['Staging']);
  });

  // M6 (code review 2026-11-03): the pull read the local profiles outside the store's write queue and wrote the
  // merged result back afterwards, so a profile saved in between was dropped.
  it('does not lose a profile saved while a pull is merging', async () => {
    const machineA = await harness();
    await machineA.profileStore.saveSSH({ id: 'ssh-remote', name: 'Remote', host: 'r.example.com', username: 'a', authType: 'password', password: 'pw' }); // pragma: allowlist secret
    await machineA.sync.pushToRemote(provider);

    const machineB = await harness();
    const store = machineB.profileStore;
    const read = store.getProfilesIncludingTombstones.bind(store);
    let racingSave: Promise<void> | undefined;
    vi.spyOn(store, 'getProfilesIncludingTombstones').mockImplementationOnce(async () => {
      const snapshot = await read();
      // A save arrives right after the pull took its snapshot, and gets time to run.
      racingSave = store.saveSSH({ id: 'ssh-local', name: 'Local', host: 'l.example.com', username: 'b', authType: 'password', password: 'pw' }); // pragma: allowlist secret
      await new Promise((resolve) => setTimeout(resolve, 50));
      return snapshot;
    });

    await machineB.sync.pullFromRemote(provider);
    await racingSave;

    const ids = (await store.getProfiles()).ssh.map((p) => p.id).sort();
    expect(ids).toEqual(['ssh-local', 'ssh-remote']);
  });

  it('round-trips an SSH profile between two machines, splitting secrets into credentials.enc', async () => {
    const machineA = await harness();
    await machineA.profileStore.saveSSH({
      id: 'ssh-1',
      name: 'Prod',
      host: 'prod.example.com',
      username: 'admin',
      authType: 'password',
      password: 'super-secret',
    });

    await machineA.sync.pushToRemote(provider);

    // topology.enc must not contain the plaintext password or username.
    // (SFTP targets are anchored to the home directory — see resolveEffectiveBasePath.)
    const topologyRaw = provider.getRawBuffer('~/.sshs3/topology.enc')!.toString('utf-8');
    expect(topologyRaw).not.toContain('super-secret');
    expect(topologyRaw).not.toContain('admin');

    const machineB = await harness();
    const result = await machineB.sync.pullFromRemote(provider);

    expect(result.changedCategories).toEqual(expect.arrayContaining(['topology', 'credentials']));
    const profiles = await machineB.profileStore.getProfiles();
    expect(profiles.ssh).toHaveLength(1);
    expect(profiles.ssh[0]).toMatchObject({
      id: 'ssh-1',
      name: 'Prod',
      host: 'prod.example.com',
      username: 'admin',
      password: 'super-secret',
    });
  });

  it('preserves a local-only excluded field (privateKeyPath) across a pull that updates other fields', async () => {
    const machineA = await harness();
    await machineA.profileStore.saveSSH({
      id: 'ssh-1',
      name: 'Prod v1',
      host: 'prod.example.com',
      username: 'admin',
      authType: 'privateKey',
    });
    await machineA.sync.pushToRemote(provider);

    const machineB = await harness();
    await machineB.profileStore.saveSSH({
      id: 'ssh-1',
      name: 'Prod v1',
      host: 'prod.example.com',
      username: 'admin',
      authType: 'privateKey',
      privateKeyPath: 'C:\\Users\\bob\\.ssh\\id_ed25519',
    });
    await machineB.sync.pullFromRemote(provider); // nothing new yet, just establishes baseline

    // Now edit on machine A and push again.
    await new Promise((r) => setTimeout(r, 2));
    await machineA.profileStore.saveSSH({
      id: 'ssh-1',
      name: 'Prod v2 renamed',
      host: 'prod.example.com',
      username: 'admin',
      authType: 'privateKey',
    });
    await machineA.sync.pushToRemote(provider);

    await machineB.sync.pullFromRemote(provider);
    const profiles = await machineB.profileStore.getProfiles();
    expect(profiles.ssh[0].name).toBe('Prod v2 renamed');
    expect(profiles.ssh[0].privateKeyPath).toBe('C:\\Users\\bob\\.ssh\\id_ed25519');
  });

  it('clears an optional field on a pull when it was cleared on the other machine, and then reports in sync', async () => {
    const base = { id: 'ssh-1', name: 'Prod', host: 'h', username: 'u', authType: 'password' as const };
    const machineA = await harness();
    await machineA.profileStore.saveSSH({ ...base, group: 'OldFolder', proxyJump: 'bastion' });
    await machineA.sync.pushToRemote(provider);

    const machineB = await harness();
    await machineB.sync.pullFromRemote(provider);
    expect((await machineB.profileStore.getProfiles()).ssh[0]).toMatchObject({ group: 'OldFolder', proxyJump: 'bastion' });

    await new Promise((r) => setTimeout(r, 2));
    await machineA.profileStore.saveSSH(base); // folder and jump host removed
    await machineA.sync.pushToRemote(provider);

    await machineB.sync.pullFromRemote(provider);
    const pulled = (await machineB.profileStore.getProfiles()).ssh[0];
    expect(pulled.group).toBeUndefined();
    expect(pulled.proxyJump).toBeUndefined();
    const comparison = await machineB.sync.compareWithRemote(provider);
    expect(comparison.state).toBe('in_sync');
  });

  it('carries tags on SSH and S3 profiles to the other machine, normalized, and then reports in sync', async () => {
    const machineA = await harness();
    await machineA.profileStore.saveSSH({
      id: 'ssh-1',
      name: 'Prod',
      host: 'h',
      username: 'u',
      authType: 'password',
      tags: ['web', '#Prod'],
    });
    await machineA.profileStore.saveS3({
      id: 's3-1',
      name: 'Assets',
      region: 'eu-north-1',
      accessKeyId: 'AKIA',
      secretAccessKey: 'secret', // pragma: allowlist secret
      tags: ['b', 'A'],
    });
    await machineA.sync.pushToRemote(provider);

    const machineB = await harness();
    await machineB.sync.pullFromRemote(provider);
    const pulled = await machineB.profileStore.getProfiles();
    expect(pulled.ssh[0].tags).toEqual(['Prod', 'web']);
    expect(pulled.s3[0].tags).toEqual(['A', 'b']);
    expect((await machineB.sync.compareWithRemote(provider)).state).toBe('in_sync');
  });

  it('removes tags on a pull when they were cleared on the other machine, and then reports in sync', async () => {
    const base = { id: 'ssh-1', name: 'Prod', host: 'h', username: 'u', authType: 'password' as const };
    const machineA = await harness();
    await machineA.profileStore.saveSSH({ ...base, tags: ['prod'] });
    await machineA.sync.pushToRemote(provider);

    const machineB = await harness();
    await machineB.sync.pullFromRemote(provider);
    expect((await machineB.profileStore.getProfiles()).ssh[0].tags).toEqual(['prod']);

    await new Promise((r) => setTimeout(r, 2));
    await machineA.profileStore.saveSSH(base);
    await machineA.sync.pushToRemote(provider);

    await machineB.sync.pullFromRemote(provider);
    expect((await machineB.profileStore.getProfiles()).ssh[0].tags).toBeUndefined();
    expect((await machineB.sync.compareWithRemote(provider)).state).toBe('in_sync');
  });

  it('carries the system membership of each server to the other machine, and removes it again when it is taken away', async () => {
    const machineA = await harness();
    const base = { host: 'h', username: 'u', authType: 'password' as const };
    await machineA.profileStore.saveSSH({
      ...base,
      id: 'ssh-1',
      name: 'Web',
      tunnels: [{ id: 't1', name: 'db', type: 'local', localPort: 5432, remoteHost: 'localhost', remotePort: 5432 }],
      system: { name: 'shop', startDirectory: '/srv/web', tunnelIds: ['t1'] },
    });
    await machineA.profileStore.saveSSH({ ...base, id: 'ssh-2', name: 'Db', system: { name: 'shop', shell: false } });
    await machineA.sync.pushToRemote(provider);

    const machineB = await harness();
    await machineB.sync.pullFromRemote(provider);
    const pulled = (await machineB.profileStore.getProfiles()).ssh;
    expect(pulled.find((p) => p.id === 'ssh-1')?.system).toEqual({ name: 'shop', startDirectory: '/srv/web', tunnelIds: ['t1'] });
    expect(pulled.find((p) => p.id === 'ssh-2')?.system).toEqual({ name: 'shop', shell: false });
    expect((await machineB.sync.compareWithRemote(provider)).state).toBe('in_sync');

    await new Promise((r) => setTimeout(r, 2));
    await machineA.profileStore.saveSSH({ ...base, id: 'ssh-2', name: 'Db' });
    await machineA.sync.pushToRemote(provider);
    await machineB.sync.pullFromRemote(provider);
    const after = (await machineB.profileStore.getProfiles()).ssh;
    expect(after.find((p) => p.id === 'ssh-2')?.system).toBeUndefined();
    expect(after.find((p) => p.id === 'ssh-1')?.system?.name).toBe('shop');
    expect((await machineB.sync.compareWithRemote(provider)).state).toBe('in_sync');
  });

  it('keeps when this device last opened a profile when a newer remote edit does not carry it, and takes a later remote value', async () => {
    const base = { id: 'ssh-1', name: 'Prod', host: 'h', username: 'u', authType: 'password' as const };
    const machineA = await harness();
    await machineA.profileStore.saveSSH(base);
    await machineA.sync.pushToRemote(provider);

    const machineB = await harness();
    await machineB.sync.pullFromRemote(provider);
    // B opens the profile (and this is saved on the profile); A has never opened it.
    await new Promise((r) => setTimeout(r, 2));
    await machineB.profileStore.saveSSH({ ...base, lastUsedAt: '2026-10-20T10:00:00.000Z' });

    // A edits the profile afterwards: its record is newer and has no lastUsedAt at all.
    await new Promise((r) => setTimeout(r, 2));
    await machineA.profileStore.saveSSH({ ...base, name: 'Prod renamed' });
    await machineA.sync.pushToRemote(provider);
    await machineB.sync.pullFromRemote(provider);

    let pulled = (await machineB.profileStore.getProfiles()).ssh[0];
    expect(pulled.name).toBe('Prod renamed');
    expect(pulled.lastUsedAt).toBe('2026-10-20T10:00:00.000Z');

    // A then opens it later than B did: that later time wins.
    await new Promise((r) => setTimeout(r, 2));
    await machineA.profileStore.saveSSH({ ...base, name: 'Prod renamed', lastUsedAt: '2026-10-25T08:30:00.000Z' });
    await machineA.sync.pushToRemote(provider);
    await machineB.sync.pullFromRemote(provider);
    pulled = (await machineB.profileStore.getProfiles()).ssh[0];
    expect(pulled.lastUsedAt).toBe('2026-10-25T08:30:00.000Z');
  });

  it('keeps the local credentials when the remote has no credentials half to offer', async () => {
    const machineB = await harness();
    await machineB.profileStore.saveSSH({ id: 'ssh-1', name: 'Local', host: 'h', username: 'local-user', authType: 'password', password: 'local-pw' }); // pragma: allowlist secret

    await new Promise((r) => setTimeout(r, 2));
    const machineA = await harness();
    await machineA.profileStore.saveSSH({ id: 'ssh-1', name: 'Renamed', host: 'h', username: 'remote-user', authType: 'password', password: 'remote-pw' }); // pragma: allowlist secret
    await machineA.sync.pushToRemote(provider);
    await provider.delete('~/.sshs3/credentials.enc');

    await machineB.sync.pullFromRemote(provider);

    const pulled = (await machineB.profileStore.getProfiles()).ssh[0];
    expect(pulled.name).toBe('Renamed');
    expect(pulled.username).toBe('local-user');
    expect(pulled.password).toBe('local-pw'); // pragma: allowlist secret
  });

  it('still regenerates the local ssh block from the pulled profiles when applying the remote block fails', async () => {
    const machineA = await harness();
    await machineA.profileStore.saveSSH({ id: 'ssh-1', name: 'Prod', host: 'h', username: 'u', authType: 'password' });
    await machineA.sync.pushToRemote(provider);

    const machineB = await harness();
    vi.spyOn(machineB.sync as any, 'applySshNativePayload').mockRejectedValue(new Error('cannot apply'));
    const regenerate = vi.spyOn(machineB.sync, 'autoSyncLocalSshConfig').mockResolvedValue();

    await expect(machineB.sync.pullFromRemote(provider)).rejects.toThrow('cannot apply');

    expect((await machineB.profileStore.getProfiles()).ssh).toHaveLength(1); // already replaced
    expect(regenerate).toHaveBeenCalledTimes(1);
  });

  it('runs a push and a pull started together one after the other instead of tripping over each other', async () => {
    const machineA = await harness();
    await machineA.profileStore.saveSSH({ id: 'ssh-1', name: 'Prod', host: 'h', username: 'u', authType: 'password' });
    await machineA.sync.pushToRemote(provider);
    await new Promise((r) => setTimeout(r, 2));
    await machineA.profileStore.saveSSH({ id: 'ssh-1', name: 'Prod 2', host: 'h', username: 'u', authType: 'password' });

    // A slow remote lets the operations overlap; unserialised, the pull would see the push's own
    // in-progress marker and throw SyncInProgressError.
    const realStat = provider.stat.bind(provider);
    provider.stat = async (remotePath: string) => {
      await new Promise((r) => setTimeout(r, 3));
      return realStat(remotePath);
    };
    const results = await Promise.allSettled([
      machineA.sync.pushToRemote(provider),
      machineA.sync.pullFromRemote(provider),
      machineA.sync.compareWithRemote(provider),
      machineA.sync.pushToRemote(provider),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled']);
  });

  it('does not let an older remote copy overwrite a newer local edit', async () => {
    const machineA = await harness();
    await machineA.profileStore.saveSSH({ id: 'ssh-1', name: 'Old name', host: 'h', username: 'u', authType: 'password' });
    await machineA.sync.pushToRemote(provider);

    const machineB = await harness();
    await machineB.sync.pullFromRemote(provider);
    await new Promise((r) => setTimeout(r, 2));
    await machineB.profileStore.saveSSH({ id: 'ssh-1', name: 'New name from B', host: 'h', username: 'u', authType: 'password' });

    // B pulls again — nothing new remotely, B's own newer edit must survive.
    await machineB.sync.pullFromRemote(provider);
    const profiles = await machineB.profileStore.getProfiles();
    expect(profiles.ssh[0].name).toBe('New name from B');
  });

  it('propagates a deletion (tombstone) from one machine to another', async () => {
    const machineA = await harness();
    await machineA.profileStore.saveSSH({ id: 'ssh-1', name: 'Will be deleted', host: 'h', username: 'u', authType: 'password' });
    await machineA.sync.pushToRemote(provider);

    const machineB = await harness();
    await machineB.sync.pullFromRemote(provider);
    expect((await machineB.profileStore.getProfiles()).ssh).toHaveLength(1);

    await new Promise((r) => setTimeout(r, 2));
    await machineA.profileStore.deleteSSH('ssh-1');
    await machineA.sync.pushToRemote(provider);

    await machineB.sync.pullFromRemote(provider);
    expect((await machineB.profileStore.getProfiles()).ssh).toHaveLength(0);
  });

  it('bootstraps a fresh machine using explicit passwords instead of a pre-established unlock', async () => {
    const machineA = await harness();
    await machineA.profileStore.saveS3({
      id: 's3-1',
      name: 'Backup',
      region: 'us-east-1',
      accessKeyId: 'AKIA123',
      secretAccessKey: 'shh-its-a-secret',
    });
    await machineA.sync.pushToRemote(provider);

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sshs3-sync-test-'));
    dirs.push(dir);
    const freshProfileStore = new ProfileStore(path.join(dir, 'profiles.json'));
    const freshDotfilePoolStore = new DotfilePoolStore(path.join(dir, 'dotfile-pools.json'));
    const freshSettingsStore = new SettingsStore(path.join(dir, 'settings.json'));
    const freshCrypto = new SyncCryptoService(FAST_PARAMS); // nothing unlocked yet
    const freshSync = new ProfileSyncService(freshProfileStore, freshDotfilePoolStore, freshSettingsStore, freshCrypto, {
      sshConfigPath: path.join(dir, 'ssh_config'),
      knownHostsPath: path.join(dir, 'known_hosts'),
    });

    await freshSync.pullFromRemote(provider, '', {
      topology: 'topology-master-password',
      credentials: 'credentials-master-password',
    });

    const profiles = await freshProfileStore.getProfiles();
    expect(profiles.s3[0]).toMatchObject({ id: 's3-1', accessKeyId: 'AKIA123', secretAccessKey: 'shh-its-a-secret' });
  });

  it('merges dotfile pool files edited independently on two machines without losing either edit', async () => {
    // Dotfile pool timestamps have minute resolution (they're shown to the
    // user as "Last saved: yyyy-mm-dd HH:mm"), so this test sets them
    // explicitly via preserveTimestamps rather than relying on wall-clock
    // delays between edits, which a fast test run could easily land within
    // the same minute.
    const machineA = await harness();
    await machineA.dotfilePoolStore.savePool(
      {
        id: 'pool-1',
        name: 'Shell',
        updatedAt: '2026-01-01 00:00',
        files: [
          { id: 'file-bashrc', remotePath: '~/.bashrc', content: 'echo A', updatedAt: '2026-01-01 00:00' },
          { id: 'file-vimrc', remotePath: '~/.vimrc', content: 'set number', updatedAt: '2026-01-01 00:00' },
        ],
      },
      { preserveTimestamps: true }
    );
    await machineA.sync.pushToRemote(provider);

    const machineB = await harness();
    await machineB.sync.pullFromRemote(provider);

    // Edit different files on each machine, at distinctly later (and different) minutes.
    const poolOnA = await machineA.dotfilePoolStore.getPool('pool-1');
    await machineA.dotfilePoolStore.savePool(
      {
        ...poolOnA!,
        updatedAt: '2026-01-01 00:05',
        files: poolOnA!.files.map((f) =>
          f.id === 'file-bashrc' ? { ...f, content: 'echo A edited on A', updatedAt: '2026-01-01 00:05' } : f
        ),
      },
      { preserveTimestamps: true }
    );
    await machineA.sync.pushToRemote(provider);

    const poolOnB = await machineB.dotfilePoolStore.getPool('pool-1');
    await machineB.dotfilePoolStore.savePool(
      {
        ...poolOnB!,
        updatedAt: '2026-01-01 00:10',
        files: poolOnB!.files.map((f) =>
          f.id === 'file-vimrc' ? { ...f, content: 'set number edited on B', updatedAt: '2026-01-01 00:10' } : f
        ),
      },
      { preserveTimestamps: true }
    );

    // B pulls A's change; both edits must survive.
    await machineB.sync.pullFromRemote(provider);
    const finalPool = await machineB.dotfilePoolStore.getPool('pool-1');
    const bashrc = finalPool!.files.find((f) => f.id === 'file-bashrc');
    const vimrc = finalPool!.files.find((f) => f.id === 'file-vimrc');
    expect(bashrc?.content).toBe('echo A edited on A');
    expect(vimrc?.content).toBe('set number edited on B');
  });

  it('merges known_hosts additively and surfaces a host-key conflict without applying it', async () => {
    const machineA = await harness();
    await fs.writeFile(machineA.knownHostsPath, 'shared-host.example.com ssh-ed25519 AAAAconflictA\n', 'utf-8');
    await machineA.sync.pushToRemote(provider);

    const machineB = await harness();
    await fs.writeFile(machineB.knownHostsPath, 'shared-host.example.com ssh-ed25519 AAAAconflictB\nother-host.example.com ssh-ed25519 AAAAother\n', 'utf-8');

    const result = await machineB.sync.pullFromRemote(provider);
    expect(result.sshNativeConflicts).toHaveLength(1);
    expect(result.sshNativeConflicts[0].hostPatternField).toBe('shared-host.example.com');

    const merged = await fs.readFile(machineB.knownHostsPath, 'utf-8');
    expect(merged).toContain('AAAAconflictB'); // local entry untouched
    expect(merged).toContain('other-host.example.com');
  });

  // Low finding (code review 2026-11-03): known_hosts was read, merged and written without checking that ssh had not
  // appended a host key in between; that key was lost when the merged text replaced the file.
  it('keeps a host key that ssh appended to known_hosts while the pull was merging', async () => {
    const machineA = await harness();
    await fs.writeFile(machineA.knownHostsPath, 'from-remote.example.com ssh-ed25519 AAAAremote\n', 'utf-8');
    await machineA.sync.pushToRemote(provider);

    const machineB = await harness();
    await fs.writeFile(machineB.knownHostsPath, 'already-here.example.com ssh-ed25519 AAAAlocal\n', 'utf-8');
    const service = machineB.sync as any;
    const realRead = service.readLocalFile.bind(service);
    let appended = false;
    vi.spyOn(service, 'readLocalFile').mockImplementation(async (...args: unknown[]) => {
      const filePath = args[0] as string;
      const content = await realRead(filePath);
      if (filePath === machineB.knownHostsPath && !appended) {
        appended = true;
        // ssh connects to a new host right now and appends its key.
        await fs.appendFile(machineB.knownHostsPath, 'just-connected.example.com ssh-ed25519 AAAAappended\n', 'utf-8');
      }
      return content;
    });

    await machineB.sync.pullFromRemote(provider);

    const merged = await fs.readFile(machineB.knownHostsPath, 'utf-8');
    expect(merged).toContain('from-remote.example.com');
    expect(merged).toContain('already-here.example.com');
    expect(merged).toContain('just-connected.example.com');
  });

  // Code review of the unpushed commits: after five "file moved" rounds the merge used to give up without a word.
  it('fails the pull, instead of reporting success, when known_hosts keeps changing under the merge', async () => {
    const machineA = await harness();
    await fs.writeFile(machineA.knownHostsPath, 'from-remote.example.com ssh-ed25519 AAAAremote\n', 'utf-8');
    await machineA.sync.pushToRemote(provider);

    const machineB = await harness();
    await fs.writeFile(machineB.knownHostsPath, 'already-here.example.com ssh-ed25519 AAAAlocal\n', 'utf-8');
    const service = machineB.sync as any;
    const realRead = service.readLocalFile.bind(service);
    let n = 0;
    vi.spyOn(service, 'readLocalFile').mockImplementation(async (...args: unknown[]) => {
      const filePath = args[0] as string;
      const content = await realRead(filePath);
      if (filePath === machineB.knownHostsPath && n % 2 === 0) {
        // ssh keeps appending between our read and the re-read
        await fs.appendFile(machineB.knownHostsPath, `host${n}.example.com ssh-ed25519 AAAA${n}\n`, 'utf-8');
      }
      if (filePath === machineB.knownHostsPath) n++;
      return content;
    });

    await expect(machineB.sync.pullFromRemote(provider)).rejects.toThrow(/known_hosts kept changing/);
    expect(await fs.readFile(machineB.knownHostsPath, 'utf-8')).not.toContain('from-remote.example.com'); // nothing half-applied
  });

  it('generates a managed ~/.ssh/config block from SSH profiles on push, so native ssh sees the same host', async () => {
    const machineA = await harness();
    await machineA.profileStore.saveSSH({
      id: 'ssh-1',
      name: 'prod',
      host: 'prod.example.com',
      username: 'deploy',
      authType: 'privateKey',
      privateKeyPath: '/home/user/.ssh/id_prod',
    });

    await machineA.sync.pushToRemote(provider);

    const localConfig = await fs.readFile(machineA.sshConfigPath, 'utf-8');
    expect(localConfig).toContain('Host prod');
    expect(localConfig).toContain('HostName prod.example.com');
    expect(localConfig).toContain('IdentityFile /home/user/.ssh/id_prod');

    // A second machine that pulls should get the same managed block without
    // ever having the SSH profile's ~/.ssh/config generated locally itself.
    const machineB = await harness();
    await machineB.sync.pullFromRemote(provider);
    const pulledConfig = await fs.readFile(machineB.sshConfigPath, 'utf-8');
    expect(pulledConfig).toContain('Host prod');
    expect(pulledConfig).toContain('HostName prod.example.com');
  });

  it('does not create a ~/.ssh/config managed block when there are no SSH profiles', async () => {
    const machineA = await harness();

    await machineA.sync.pushToRemote(provider);

    await expect(fs.readFile(machineA.sshConfigPath, 'utf-8')).rejects.toThrow(/ENOENT/);
  });

  it('clears the ~/.ssh/config managed block once the last SSH profile is deleted', async () => {
    const machineA = await harness();
    await machineA.profileStore.saveSSH({ id: 'ssh-1', name: 'prod', host: 'prod.example.com', username: 'deploy', authType: 'password' });
    await machineA.sync.pushToRemote(provider);
    expect(await fs.readFile(machineA.sshConfigPath, 'utf-8')).toContain('Host prod');

    await machineA.profileStore.deleteSSH('ssh-1');
    await machineA.sync.pushToRemote(provider);

    const finalConfig = await fs.readFile(machineA.sshConfigPath, 'utf-8');
    expect(finalConfig).not.toContain('Host prod');
    expect(finalConfig).toContain('BEGIN sshs3-managed');
  });

  it('rejects a push when the remote file changed since it was last observed (optimistic concurrency)', async () => {
    const machineA = await harness();
    await machineA.profileStore.saveSSH({ id: 'ssh-1', name: 'A', host: 'h', username: 'u', authType: 'password' });
    await machineA.sync.pushToRemote(provider);

    // Simulate a third machine pushing a newer topology.enc that machineA never saw.
    provider.simulateExternalWrite('~/.sshs3/topology.enc', Buffer.from('not a real sync file'));

    await machineA.profileStore.saveSSH({ id: 'ssh-1', name: 'A edited again', host: 'h', username: 'u', authType: 'password' });
    await expect(machineA.sync.pushToRemote(provider)).rejects.toThrow(SyncConflictError);
  });

  it('resetRemoteState() clears stale concurrency state left over from a previously configured target', async () => {
    // The real ProfileSyncService instance lives for the app's whole lifetime (see
    // IpcBridge), reused across however many times the user reconfigures Settings >
    // Synchronization's target. Without resetRemoteState(), a stat recorded against
    // target A leaks into the concurrency check for an unrelated target B.
    const machineA = await harness();
    await machineA.profileStore.saveSSH({ id: 'ssh-1', name: 'A', host: 'h', username: 'u', authType: 'password' });
    await machineA.sync.pushToRemote(provider); // Populates lastKnownRemoteState from `provider`.

    const otherTarget = new FakeStorageProvider(); // A brand-new, unrelated remote target.
    await expect(machineA.sync.pushToRemote(otherTarget)).rejects.toThrow(SyncConflictError);

    machineA.sync.resetRemoteState();
    await expect(machineA.sync.pushToRemote(otherTarget)).resolves.toBeUndefined();
  });

  // M4 (code review): the 5 category uploads in a push are sequential, not
  // an all-or-nothing transaction, so a failure partway through leaves a
  // mix of new and stale category files. A "push in progress" marker
  // brackets the upload sequence so a later pull/compare can detect and
  // refuse to merge that inconsistent state instead of silently trusting it.
  it('clears the push-in-progress marker once a push completes successfully', async () => {
    const machineA = await harness();
    await machineA.profileStore.saveSSH({ id: 'ssh-1', name: 'A', host: 'h', username: 'u', authType: 'password' });

    await machineA.sync.pushToRemote(provider);

    expect(provider.hasFile('~/.sshs3/.push-in-progress')).toBe(false);
  });

  it('leaves the push-in-progress marker in place when a push fails partway through, and refuses to pull or compare against it', async () => {
    const machineA = await harness();
    await machineA.profileStore.saveSSH({ id: 'ssh-1', name: 'A', host: 'h', username: 'u', authType: 'password' });
    await machineA.sync.pushToRemote(provider); // Establishes lastKnownRemoteState for every category.

    // A third machine changes settings.enc without machineA knowing, so
    // machineA's next push conflicts partway through the sequence: topology,
    // credentials, and dotfile-pools all succeed before the settings check throws.
    provider.simulateExternalWrite('~/.sshs3/settings.enc', Buffer.from('not a real sync file'));
    await machineA.profileStore.saveSSH({ id: 'ssh-1', name: 'A edited', host: 'h', username: 'u', authType: 'password' });

    await expect(machineA.sync.pushToRemote(provider)).rejects.toThrow(SyncConflictError);
    expect(provider.hasFile('~/.sshs3/.push-in-progress')).toBe(true);

    const machineB = await harness();
    await expect(machineB.sync.pullFromRemote(provider)).rejects.toThrow(SyncInProgressError);
    await expect(machineB.sync.compareWithRemote(provider)).rejects.toThrow(SyncInProgressError);
  });

  it('wipeRemote deletes every category file for the "delete all sync data" action', async () => {
    const machineA = await harness();
    await machineA.profileStore.saveSSH({ id: 'ssh-1', name: 'A', host: 'h', username: 'u', authType: 'password' });
    await machineA.sync.pushToRemote(provider);

    expect(provider.hasFile('~/.sshs3/topology.enc')).toBe(true);

    const result = await machineA.sync.wipeRemote(provider);

    expect(result.errors).toEqual([]);
    expect(result.deletedCount).toBe(7);
    for (const file of [
      'topology.enc',
      'credentials.enc',
      'dotfile-pools.enc',
      'settings.enc',
      'ssh-native.enc',
      'dirsync-profiles.enc',
      'k8s-profiles.enc',
    ]) {
      expect(provider.hasFile(`~/.sshs3/${file}`)).toBe(false);
    }
  });

  it('wipeRemote is a safe no-op when nothing was ever pushed to this target', async () => {
    const machineA = await harness();
    const result = await machineA.sync.wipeRemote(provider);
    expect(result).toEqual({ deletedCount: 0, errors: [] });
  });

  it('wipeRemote clears the concurrency cache, so a fresh push to the same target afterwards does not conflict', async () => {
    const machineA = await harness();
    await machineA.profileStore.saveSSH({ id: 'ssh-1', name: 'A', host: 'h', username: 'u', authType: 'password' });
    await machineA.sync.pushToRemote(provider);

    await machineA.sync.wipeRemote(provider);

    await expect(machineA.sync.pushToRemote(provider)).resolves.toBeUndefined();
  });

  it('ignores local-only profile fields planted in a remote topology file', async () => {
    const planted = {
      ssh: [
        {
          id: 'ssh-evil',
          name: 'Planted',
          host: 'h.example.com',
          username: 'u',
          authType: 'smartcard',
          pkcs11LibPath: '/tmp/evil.so',
          agentPath: '/tmp/evil.sock',
          privateKeyPath: '/tmp/evil_key',
          agentIdentityFiles: ['/tmp/evil.pub'],
          pin: '123456',
          updatedAt: '2030-01-01T00:00:00.000Z',
        },
      ],
      s3: [],
    };
    const crypto = makeCrypto(sharedTopologySalt, sharedCredentialsSalt);
    provider.simulateExternalWrite('~/.sshs3/topology.enc', crypto.encrypt('topology', JSON.stringify(planted)));

    const machine = await harness();
    await machine.sync.pullFromRemote(provider);

    const saved = (await machine.profileStore.getProfiles()).ssh.find((p) => p.id === 'ssh-evil');
    expect(saved).toBeDefined();
    expect(saved).toMatchObject({ host: 'h.example.com' });
    expect(saved).not.toHaveProperty('pkcs11LibPath');
    expect(saved).not.toHaveProperty('agentPath');
    expect(saved).not.toHaveProperty('privateKeyPath');
    expect(saved).not.toHaveProperty('agentIdentityFiles');
    expect(saved).not.toHaveProperty('pin');
  });

  it('never pushes or applies settings that name a local executable or library', async () => {
    const machineB = await harness();
    await machineB.settingsStore.saveSettings({ theme: 'dark', x11ServerPath: '/usr/bin/Xorg' });
    await new Promise((resolve) => setTimeout(resolve, 5));

    // A's settings are newer, so they win for everything except the local-only fields.
    const machineA = await harness();
    await machineA.settingsStore.saveSettings({
      theme: 'light',
      x11ServerPath: '/tmp/evil-x',
      x11ServerArgs: '-evil',
      smartcardLibPath: '/tmp/evil.so',
    });
    await machineA.sync.pushToRemote(provider);
    await machineB.sync.pullFromRemote(provider);

    const settings = await machineB.settingsStore.getSettings();
    expect(settings.theme).toBe('light');
    expect(settings.x11ServerPath).toBe('/usr/bin/Xorg');
    expect(settings.x11ServerArgs).toBeUndefined();
    expect(settings.smartcardLibPath).toBeUndefined();
  });

  describe('with a machine policy', () => {
    const policy: PolicyDocument = { settings: { x11ServerMode: 'always' }, features: {} };

    it('pushes the user\'s stored value, never the policy value, so unmanaged machines are unaffected', async () => {
      const managed = await harness(policy);
      await fs.writeFile(
        path.join(managed.dir, 'settings.json'),
        JSON.stringify({ x11ServerMode: 'manual', updatedAt: new Date().toISOString() })
      );
      expect((await managed.settingsStore.getSettings()).x11ServerMode).toBe('always');
      await managed.sync.pushToRemote(provider);

      const other = await harness();
      await other.sync.pullFromRemote(provider);
      expect((await other.settingsStore.getSettings()).x11ServerMode).toBe('manual');
    });

    it('keeps a pulled value for a managed setting underneath the policy value', async () => {
      const managed = await harness(policy);
      await managed.settingsStore.saveSettings({ theme: 'dark' });
      await new Promise((resolve) => setTimeout(resolve, 5));

      const other = await harness();
      await other.settingsStore.saveSettings({ theme: 'light', x11ServerMode: 'manual' });
      await other.sync.pushToRemote(provider);
      await managed.sync.pullFromRemote(provider);

      expect((await managed.settingsStore.getSettings()).theme).toBe('light');
      expect((await managed.settingsStore.getSettings()).x11ServerMode).toBe('always');
      // The synced value is kept underneath, so this machine's next push cannot revert it on the others.
      expect((await managed.settingsStore.getStoredSettings()).x11ServerMode).toBe('manual');
    });
  });

  it('keeps the whole settings object with the newer updatedAt (last-write-wins)', async () => {
    const machineA = await harness();
    await machineA.settingsStore.saveSettings({ theme: 'light' });
    await machineA.sync.pushToRemote(provider);

    const machineB = await harness();
    await new Promise((r) => setTimeout(r, 2));
    await machineB.settingsStore.saveSettings({ theme: 'dark', terminalFontSize: 20 });

    await machineB.sync.pullFromRemote(provider);
    const settings = await machineB.settingsStore.getSettings();
    // B's own edit is newer than A's push, so it must survive untouched.
    expect(settings.theme).toBe('dark');
    expect(settings.terminalFontSize).toBe(20);
  });

  it('prefixes remote paths with the given base path (e.g. an S3 bucket, which is not part of S3Config itself)', async () => {
    // Uses a dedicated S3-typed provider: an SFTP-typed one would anchor an
    // empty/relative base path to the home directory (see
    // resolveEffectiveBasePath), which doesn't apply to S3's bucket/key paths.
    const s3Provider = new FakeStorageProvider('s3');
    const machineA = await harness();
    await machineA.profileStore.saveSSH({ id: 'ssh-1', name: 'A', host: 'h', username: 'u', authType: 'password' });
    await machineA.sync.pushToRemote(s3Provider, 'my-bucket/some-prefix');

    expect(s3Provider.hasFile('my-bucket/some-prefix/.sshs3/topology.enc')).toBe(true);
    expect(s3Provider.hasFile('.sshs3/topology.enc')).toBe(false);

    const machineB = await harness();
    await machineB.sync.pullFromRemote(s3Provider, 'my-bucket/some-prefix');
    expect((await machineB.profileStore.getProfiles()).ssh[0].name).toBe('A');
  });

  it('anchors an SFTP target with no remote directory to the home directory, not a bare relative path', async () => {
    const machineA = await harness();
    await machineA.profileStore.saveSSH({ id: 'ssh-1', name: 'A', host: 'h', username: 'u', authType: 'password' });
    await machineA.sync.pushToRemote(provider); // provider.type === 'sftp', remoteBasePath defaults to ''

    expect(provider.hasFile('~/.sshs3/topology.enc')).toBe(true);
    expect(provider.hasFile('.sshs3/topology.enc')).toBe(false);
  });
});

describe('mergeRecords', () => {
  it('adds records only present on the remote side', () => {
    const local: SSHConnectionConfig[] = [];
    const remote: SSHConnectionConfig[] = [
      { id: '1', name: 'A', host: 'h', username: 'u', authType: 'password', updatedAt: '2026-01-01T00:00:00.000Z' },
    ];
    const { merged, changed } = mergeRecords(local, remote);
    expect(changed).toBe(true);
    expect(merged).toHaveLength(1);
  });

  it('keeps the local record when local is newer or equal', () => {
    const local: SSHConnectionConfig[] = [
      { id: '1', name: 'Local', host: 'h', username: 'u', authType: 'password', updatedAt: '2026-02-01T00:00:00.000Z' },
    ];
    const remote: SSHConnectionConfig[] = [
      { id: '1', name: 'Remote', host: 'h', username: 'u', authType: 'password', updatedAt: '2026-01-01T00:00:00.000Z' },
    ];
    const { merged, changed } = mergeRecords(local, remote);
    expect(changed).toBe(false);
    expect(merged[0].name).toBe('Local');
  });
});

describe('mergePools', () => {
  it('propagates a newer pool-level tombstone as a whole-pool deletion', () => {
    const local: DotfilePool[] = [{ id: 'p1', name: 'Pool', files: [{ id: 'f1', remotePath: '~/.bashrc', content: 'x', updatedAt: '2026-01-01T00:00' }], updatedAt: '2026-01-01T00:00' }];
    const remote: DotfilePool[] = [{ id: 'p1', name: 'Pool', files: [], updatedAt: '2026-02-01T00:00', deletedAt: '2026-02-01T00:00' }];

    const { merged, changedIds } = mergePools(local, remote);
    expect(changedIds.has('p1')).toBe(true);
    expect(merged[0].deletedAt).toBeTruthy();
  });

  it('keeps this device\'s sourcePath and ignores the remote one', () => {
    const local: DotfilePool[] = [{ id: 'p1', name: 'Pool', files: [{ id: 'f1', remotePath: '~/.kube/config', content: 'x', sourcePath: '/home/a/.kube/config', updatedAt: '2026-01-01T00:00' }], updatedAt: '2026-01-01T00:00' }];
    const remote: DotfilePool[] = [{ id: 'p1', name: 'Pool', files: [{ id: 'f1', remotePath: '~/.kube/config', content: 'y', sourcePath: 'C:\\Users\\b\\.kube\\config', updatedAt: '2026-02-01T00:00' }], updatedAt: '2026-02-01T00:00' }];

    const { merged } = mergePools(local, remote);
    expect(merged[0].files[0].content).toBe('y');
    expect(merged[0].files[0].sourcePath).toBe('/home/a/.kube/config');
  });

  it('drops a sourcePath carried by a remote pool that is new on this device', () => {
    const remote: DotfilePool[] = [{ id: 'p2', name: 'New', files: [{ id: 'f9', remotePath: '~/.x', content: 'x', sourcePath: '/home/a/.ssh/id_ed25519' }], updatedAt: '2026-02-01T00:00' }];
    const { merged } = mergePools([], remote);
    expect(merged[0].files[0]).not.toHaveProperty('sourcePath');
  });

  it('strips sourcePath before a pool is pushed', () => {
    const pool: DotfilePool = { id: 'p1', name: 'Pool', files: [{ id: 'f1', remotePath: '~/.a', content: 'x', sourcePath: '/home/a/.a' }] };
    expect(stripDeviceLocalPoolFields(pool).files[0]).not.toHaveProperty('sourcePath');
  });
});

describe('getComparisonState', () => {
  it('correctly maps ahead/behind counts to sync states', () => {
    expect(getComparisonState(0, 0)).toBe('in_sync');
    expect(getComparisonState(2, 0)).toBe('ahead');
    expect(getComparisonState(0, 3)).toBe('behind');
    expect(getComparisonState(1, 1)).toBe('diverged');
  });
});

describe('compareRecords', () => {
  it('detects locally added and modified records as ahead', () => {
    const local = [
      { id: '1', name: 'Server 1', updatedAt: '2026-09-18 10:00' },
      { id: '2', name: 'Server 2', updatedAt: '2026-09-18 12:00' },
    ];
    const remote = [
      { id: '1', name: 'Server 1', updatedAt: '2026-09-18 10:00' },
    ];

    const result = compareRecords(local, remote, 'Profile');
    expect(result.ahead).toBe(1);
    expect(result.behind).toBe(0);
    expect(result.details[0]).toContain('created locally');
  });

  it('detects remote added records as behind', () => {
    const local = [
      { id: '1', name: 'Server 1', updatedAt: '2026-09-18 10:00' },
    ];
    const remote = [
      { id: '1', name: 'Server 1', updatedAt: '2026-09-18 10:00' },
      { id: '2', name: 'Server 2', updatedAt: '2026-09-18 12:00' },
    ];

    const result = compareRecords(local, remote, 'Profile');
    expect(result.ahead).toBe(0);
    expect(result.behind).toBe(1);
    expect(result.details[0]).toContain('added on remote');
  });

  it('detects diverged edits', () => {
    const local = [
      { id: '1', name: 'Server 1 Local', updatedAt: '2026-09-18 14:00' },
    ];
    const remote = [
      { id: '1', name: 'Server 1 Remote', updatedAt: '2026-09-18 12:00' },
      { id: '2', name: 'Server 2', updatedAt: '2026-09-18 13:00' },
    ];

    const result = compareRecords(local, remote, 'Profile');
    expect(result.ahead).toBe(1);
    expect(result.behind).toBe(1);
  });
});

describe('compareDotfilePools', () => {
  it('detects changes in pool files', () => {
    const local: DotfilePool[] = [
      {
        id: 'p1',
        name: 'Pool 1',
        files: [{ id: 'f1', remotePath: '~/.bashrc', content: 'local', updatedAt: '2026-09-18 20:00' }],
        updatedAt: '2026-09-18 19:00',
      },
    ];
    const remote: DotfilePool[] = [
      {
        id: 'p1',
        name: 'Pool 1',
        files: [{ id: 'f1', remotePath: '~/.bashrc', content: 'remote', updatedAt: '2026-09-18 19:00' }],
        updatedAt: '2026-09-18 19:00',
      },
    ];
    const res = compareDotfilePools(local, remote);
    expect(res.ahead).toBe(1);
    expect(res.behind).toBe(0);
  });
});

describe('compareWithRemote', () => {
  let tmpDir: string;
  let provider: FakeStorageProvider;
  let service: ProfileSyncService;
  let profileStore: ProfileStore;
  let dotfilePoolStore: DotfilePoolStore;
  let settingsStore: SettingsStore;
  let crypto: SyncCryptoService;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-compare-test-'));
    provider = new FakeStorageProvider();
    profileStore = new ProfileStore(path.join(tmpDir, 'profiles.json'));
    dotfilePoolStore = new DotfilePoolStore(path.join(tmpDir, 'dotfiles.json'));
    settingsStore = new SettingsStore(path.join(tmpDir, 'settings.json'));
    crypto = new SyncCryptoService(FAST_PARAMS);
    service = new ProfileSyncService(profileStore, dotfilePoolStore, settingsStore, crypto, {
      sshConfigPath: path.join(tmpDir, 'ssh_config'),
      knownHostsPath: path.join(tmpDir, 'known_hosts'),
    });

    crypto.unlock('topology', 'top-secret', generateSalt());
    crypto.unlock('credentials', 'cred-secret', generateSalt());
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('reports not_initialized when remote has no sync files', async () => {
    await profileStore.saveSSH({
      id: 'ssh-1',
      name: 'Server 1',
      host: '1.2.3.4',
      port: 22,
      username: 'root',
      authType: 'password',
    });

    const comparison = await service.compareWithRemote(provider);
    expect(comparison.state).toBe('not_initialized');
    expect(comparison.aheadCount).toBeGreaterThan(0);
    expect(comparison.behindCount).toBe(0);
  });

  it('reports in_sync after pushing to remote', async () => {
    await profileStore.saveSSH({
      id: 'ssh-1',
      name: 'Server 1',
      host: '1.2.3.4',
      port: 22,
      username: 'root',
      authType: 'password',
    });

    await service.pushToRemote(provider);

    const comparison = await service.compareWithRemote(provider);
    expect(comparison.state).toBe('in_sync');
    expect(comparison.aheadCount).toBe(0);
    expect(comparison.behindCount).toBe(0);
  });

  it('reports ahead when local profile is modified after push', async () => {
    await profileStore.saveSSH({
      id: 'ssh-1',
      name: 'Server 1',
      host: '1.2.3.4',
      port: 22,
      username: 'root',
      authType: 'password',
    });

    await service.pushToRemote(provider);

    // Modify local profile with newer timestamp
    await profileStore.saveSSH({
      id: 'ssh-1',
      name: 'Server 1 Renamed',
      host: '1.2.3.4',
      port: 22,
      username: 'root',
      authType: 'password',
      updatedAt: '2026-09-18 21:00',
    });

    const comparison = await service.compareWithRemote(provider);
    expect(comparison.state).toBe('ahead');
    // 2, not 1: the rename also changes the generated ~/.ssh/config Host
    // alias for this profile, so both the 'topology' and 'ssh-native'
    // categories are legitimately ahead.
    expect(comparison.aheadCount).toBe(2);
    expect(comparison.behindCount).toBe(0);
  });

  it('reports behind when remote has newer changes pushed from another machine', async () => {
    const saltTop = generateSalt();
    const saltCred = generateSalt();
    const machineA = await makeHarness(saltTop, saltCred);
    const machineB = await makeHarness(saltTop, saltCred);

    try {
      await machineA.profileStore.saveSSH({
        id: 'ssh-1',
        name: 'Server on A',
        host: '1.2.3.4',
        username: 'root',
        authType: 'password',
      });
      await machineA.sync.pushToRemote(provider);

      // machineB has not pulled yet
      const comparisonB = await machineB.sync.compareWithRemote(provider);
      expect(comparisonB.state).toBe('behind');
      // 2, not 1: the new SSH profile is behind in both 'topology' and
      // 'ssh-native' (machineA's push also generated and uploaded a
      // ~/.ssh/config managed block for it, which B doesn't have yet).
      expect(comparisonB.behindCount).toBe(2);
      expect(comparisonB.aheadCount).toBe(0);
    } finally {
      await fs.rm(machineA.dir, { recursive: true, force: true });
      await fs.rm(machineB.dir, { recursive: true, force: true });
    }
  });

  it('reports diverged when both local and remote have independent changes', async () => {
    const saltTop = generateSalt();
    const saltCred = generateSalt();
    const machineA = await makeHarness(saltTop, saltCred);
    const machineB = await makeHarness(saltTop, saltCred);

    try {
      // Both start synced
      await machineA.profileStore.saveSSH({
        id: 'ssh-1',
        name: 'Initial Server',
        host: '1.1.1.1',
        username: 'root',
        authType: 'password',
      });
      await machineA.sync.pushToRemote(provider);
      await machineB.sync.pullFromRemote(provider);

      // machineA pushes a new profile
      await machineA.profileStore.saveSSH({
        id: 'ssh-from-A',
        name: 'Server from A',
        host: '2.2.2.2',
        username: 'root',
        authType: 'password',
      });
      await machineA.sync.pushToRemote(provider);

      // machineB adds a local profile without pulling first
      await machineB.profileStore.saveSSH({
        id: 'ssh-from-B',
        name: 'Server from B',
        host: '3.3.3.3',
        username: 'root',
        authType: 'password',
      });

      const comparisonB = await machineB.sync.compareWithRemote(provider);
      expect(comparisonB.state).toBe('diverged');
      expect(comparisonB.aheadCount).toBeGreaterThan(0);
      expect(comparisonB.behindCount).toBeGreaterThan(0);
    } finally {
      await fs.rm(machineA.dir, { recursive: true, force: true });
      await fs.rm(machineB.dir, { recursive: true, force: true });
    }
  });

  it('syncProfilesToLocalSshConfig writes managed block to local ~/.ssh/config', async () => {
    const saltTop = generateSalt();
    const saltCred = generateSalt();
    const harness = await makeHarness(saltTop, saltCred);

    try {
      await harness.profileStore.saveSSH({
        id: 'ssh-test-sync',
        name: 'My Production Host',
        host: 'prod.example.com',
        username: 'ubuntu',
        port: 2202,
        authType: 'password',
      });

      const res = await harness.sync.syncProfilesToLocalSshConfig();
      expect(res.changed).toBe(true);
      expect(res.count).toBe(1);

      const content = await fs.readFile(res.path, 'utf8');
      expect(content).toContain('Host My-Production-Host');
      expect(content).toContain('HostName prod.example.com');
      expect(content).toContain('User ubuntu');
      expect(content).toContain('Port 2202');

      // Calling again without changes returns changed: false
      const res2 = await harness.sync.syncProfilesToLocalSshConfig();
      expect(res2.changed).toBe(false);
    } finally {
      await fs.rm(harness.dir, { recursive: true, force: true });
    }
  });

  it('autoSyncLocalSshConfig honors the autoSyncLocalSshConfig setting', async () => {
    const harness = await makeHarness(generateSalt(), generateSalt());
    try {
      await harness.profileStore.saveSSH({ id: 'ssh-auto', name: 'auto', host: 'a.example.com', username: 'u', authType: 'password' });

      await harness.settingsStore.saveSettings({ autoSyncLocalSshConfig: false });
      await harness.sync.autoSyncLocalSshConfig();
      await expect(fs.readFile(harness.sshConfigPath, 'utf8')).rejects.toThrow();

      await harness.settingsStore.saveSettings({ autoSyncLocalSshConfig: true });
      await harness.sync.autoSyncLocalSshConfig();
      expect(await fs.readFile(harness.sshConfigPath, 'utf8')).toContain('Host auto');
    } finally {
      await fs.rm(harness.dir, { recursive: true, force: true });
    }
  });

  it('serializes concurrent syncProfilesToLocalSshConfig calls', async () => {
    const harness = await makeHarness(generateSalt(), generateSalt());
    try {
      await harness.profileStore.saveSSH({ id: 'ssh-c', name: 'conc', host: 'c.example.com', username: 'u', authType: 'password' });
      const results = await Promise.all([
        harness.sync.syncProfilesToLocalSshConfig(),
        harness.sync.syncProfilesToLocalSshConfig(),
        harness.sync.syncProfilesToLocalSshConfig(),
      ]);
      expect(results.filter((r) => r.changed)).toHaveLength(1);
      const content = await fs.readFile(harness.sshConfigPath, 'utf8');
      expect(content.match(/Host conc/g)).toHaveLength(1);
    } finally {
      await fs.rm(harness.dir, { recursive: true, force: true });
    }
  });

  it('syncAgentBlockToLocalSshConfig adds, updates and removes the local agent block without touching the managed block', async () => {
    const harness = await makeHarness(generateSalt(), generateSalt());
    try {
      await harness.profileStore.saveSSH({ id: 'sc', name: 'card', host: 'c.example.com', username: 'u', authType: 'smartcard' });
      await harness.sync.syncProfilesToLocalSshConfig();
      const managedBefore = (await fs.readFile(harness.sshConfigPath, 'utf8')).split('# BEGIN sshs3-managed')[1];

      const entry = { alias: 'card', agentSocket: '/run/user/1000/sshs3/agent.sock', identityFiles: ['/run/user/1000/sshs3/keys/a.pub'] };
      await harness.sync.syncAgentBlockToLocalSshConfig([entry]);
      const withAgent = await fs.readFile(harness.sshConfigPath, 'utf8');
      expect(withAgent).toContain('IdentityAgent /run/user/1000/sshs3/agent.sock');
      expect(withAgent.indexOf('BEGIN sshs3-agent')).toBeLessThan(withAgent.indexOf('BEGIN sshs3-managed'));
      expect(withAgent.split('# BEGIN sshs3-managed')[1]).toBe(managedBefore);

      // Idempotent, and a managed-block rewrite keeps the agent block.
      await harness.sync.syncAgentBlockToLocalSshConfig([entry]);
      expect(await fs.readFile(harness.sshConfigPath, 'utf8')).toBe(withAgent);

      await harness.sync.syncAgentBlockToLocalSshConfig(null);
      expect(await fs.readFile(harness.sshConfigPath, 'utf8')).not.toContain('sshs3-agent');
    } finally {
      await fs.rm(harness.dir, { recursive: true, force: true });
    }
  });

  it('syncAgentBlockToLocalSshConfig removes the block when auto-sync of ~/.ssh/config is turned off', async () => {
    const harness = await makeHarness(generateSalt(), generateSalt());
    try {
      await harness.profileStore.saveSSH({ id: 'sc', name: 'card', host: 'c.example.com', username: 'u', authType: 'smartcard' });
      await harness.sync.syncProfilesToLocalSshConfig();
      const entry = { alias: 'card', agentSocket: '/s.sock', identityFiles: ['/k.pub'] };
      await harness.sync.syncAgentBlockToLocalSshConfig([entry]);
      expect(await fs.readFile(harness.sshConfigPath, 'utf8')).toContain('sshs3-agent');

      await harness.settingsStore.saveSettings({ autoSyncLocalSshConfig: false });
      await harness.sync.syncAgentBlockToLocalSshConfig([entry]);
      expect(await fs.readFile(harness.sshConfigPath, 'utf8')).not.toContain('sshs3-agent');
    } finally {
      await fs.rm(harness.dir, { recursive: true, force: true });
    }
  });

  it('autoSyncLocalSshConfig notifies onLocalSshConfigSynced after the managed block is written, and when the setting is off', async () => {
    const harness = await makeHarness(generateSalt(), generateSalt());
    try {
      await harness.profileStore.saveSSH({ id: 'p', name: 'p', host: 'p.example.com', username: 'u', authType: 'password' });
      const seen: boolean[] = [];
      harness.sync.onLocalSshConfigSynced = () => {
        seen.push(fsSync.existsSync(harness.sshConfigPath));
      };
      await harness.sync.autoSyncLocalSshConfig();
      expect(seen).toEqual([true]); // the managed block already existed when the callback ran

      await harness.settingsStore.saveSettings({ autoSyncLocalSshConfig: false });
      await harness.sync.autoSyncLocalSshConfig();
      expect(seen).toHaveLength(2);
    } finally {
      await fs.rm(harness.dir, { recursive: true, force: true });
    }
  });
});
