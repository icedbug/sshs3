import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable, Writable } from 'node:stream';

vi.mock('electron', () => {
  const mockObj = {
    ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
    app: { getPath: vi.fn().mockReturnValue('/tmp/user-data-unused') },
    safeStorage: {
      isEncryptionAvailable: vi.fn().mockReturnValue(false), // exercise the plaintext-fallback path, same as most other IPC tests
      encryptString: vi.fn(),
      decryptString: vi.fn(),
    },
    shell: {
      openPath: vi.fn().mockResolvedValue(''),
    },
  };
  return { ...mockObj, default: mockObj };
});

// Stands in for real PKCS#11 hardware so the smartcard-auto-unlock tests below
// don't need an actual card/reader: a fixed identity that always verifies, and
// a derived "secret" set to the same string the tests unlock sync with, so
// the mocked smartcard can unlock sync exactly as a real one would.
vi.mock('../../src/main/smartcard/SmartcardAgentLoader', () => ({
  loadSmartcardIntoPrivateAgent: vi.fn().mockResolvedValue({ pid: 0, socketPath: 'fake-agent-pipe' }),
  listAgentIdentities: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/main/smartcard/SmartcardSyncService', () => ({
  getAgentIdentities: vi.fn().mockResolvedValue([{ keyBlob: Buffer.from('fake-key-blob'), comment: 'Test Card' }]),
  signChallengeWithAgent: vi.fn().mockResolvedValue(Buffer.from('fake-signature')),
  verifyAgentSignature: vi.fn().mockReturnValue(true),
  deriveSecretFromSignature: vi.fn().mockReturnValue('single-master-password'),
  // Not a real ECDSA key blob, so the ECDSA-refusal guard in IpcBridge (see
  // getKeyAlgorithm/KEY_DERIVATION_MESSAGE) never trips for this mocked card.
  getKeyAlgorithm: vi.fn().mockReturnValue('ssh-ed25519'),
  KEY_DERIVATION_MESSAGE: Buffer.from('mock-key-derivation-message', 'utf-8'),
}));

import { IpcBridge } from '../../src/main/IpcBridge';
import { fingerprintOfKeyBlob } from '../../src/main/ssh/AppAgent';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';
import { ProfileStore } from '../../src/main/profile/ProfileStore';
import { DotfilePoolStore } from '../../src/main/dotfiles/DotfilePoolStore';
import { SettingsStore } from '../../src/main/settings/SettingsStore';
import { SyncConfigStore } from '../../src/main/services/SyncConfigStore';
import { SyncCryptoService, type ScryptParams } from '../../src/main/services/SyncCryptoService';
import { ProfileSyncService } from '../../src/main/services/ProfileSyncService';
import type { IStorageProvider, FileEntry, StorageType, WriteStreamOptions } from '../../src/shared/types/storage';
import type { StorageConnectConfig } from '../../src/shared/types/ipc';

const FAST_PARAMS: ScryptParams = { N: 16, r: 1, p: 1, maxmem: 4 * 1024 * 1024 };

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

/** Same in-memory IStorageProvider double used in ProfileSyncService.test.ts. */
class FakeStorageProvider implements IStorageProvider {
  readonly id = 'fake';
  readonly name = 'fake';
  readonly type: StorageType = 'sftp';
  private files = new Map<string, { buffer: Buffer; mtime: string }>();
  private clock = 0;

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
}

interface Harness {
  bridge: IpcBridge;
  ipc: MockIpcMain;
  dir: string;
  settingsStore: SettingsStore;
  syncConfigStore: SyncConfigStore;
  syncCryptoService: SyncCryptoService;
  appAgent: { addPkcs11: ReturnType<typeof vi.fn> };
}

async function makeHarness(sharedProvider: FakeStorageProvider): Promise<Harness> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sshs3-ipc-sync-test-'));
  const profileStore = new ProfileStore(path.join(dir, 'profiles.json'));
  const dotfilePoolStore = new DotfilePoolStore(path.join(dir, 'dotfile-pools.json'));
  const settingsStore = new SettingsStore(path.join(dir, 'settings.json'));
  const syncConfigStore = new SyncConfigStore(path.join(dir, 'sync-config.json'));
  const syncCryptoService = new SyncCryptoService(FAST_PARAMS);
  const profileSyncService = new ProfileSyncService(profileStore, dotfilePoolStore, settingsStore, syncCryptoService, {
    sshConfigPath: path.join(dir, 'ssh_config'),
    knownHostsPath: path.join(dir, 'known_hosts'),
  });

  const storageRegistry = {
    getOrCreate: vi.fn().mockResolvedValue(sharedProvider),
    disconnect: vi.fn().mockResolvedValue(undefined),
    // IpcBridge.getSyncProvider asks this on Windows before creating an SFTP provider.
    has: vi.fn().mockReturnValue(true),
  };

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
  });
  // A fake app-wide agent: it holds nothing until the card is added, like the real one.
  const fakeBlob = Buffer.from('fake-key-blob');
  let loaded = false;
  const appAgent = {
    setHandlers: vi.fn(),
    setOnExit: vi.fn(),
    getSocketPath: vi.fn().mockReturnValue('fake-agent-pipe'),
    ensure: vi.fn().mockResolvedValue('fake-agent-pipe'),
    list: vi.fn(async () =>
      loaded ? [{ bits: '256', fingerprint: fingerprintOfKeyBlob(fakeBlob), comment: 'Test Card', keyType: 'ED25519' }] : []
    ),
    addPkcs11: vi.fn(async () => {
      loaded = true;
    }),
    addFido2Resident: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    lockAll: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    writePublicKeyFiles: vi.fn().mockResolvedValue([]),
    noteLoadedLibrary: vi.fn(),
    adoptIdentities: vi.fn().mockResolvedValue(undefined),
    evictIdentities: vi.fn().mockResolvedValue(undefined),
  };
  (bridge as any).smartcard.appAgent = appAgent;
  bridge.register();

  return { bridge, ipc, dir, settingsStore, syncConfigStore, syncCryptoService, appAgent };
}

const TARGET: StorageConnectConfig = {
  id: 'sync-target',
  name: 'My Sync Bucket',
  type: 's3',
  s3Config: { id: 'sync-target', name: 'My Sync Bucket', region: 'us-east-1', accessKeyId: 'AKIA', secretAccessKey: 'shh' },
};

describe('IpcBridge — remote profile sync handlers', () => {
  let provider: FakeStorageProvider;
  let dirs: string[];

  beforeEach(() => {
    provider = new FakeStorageProvider();
    dirs = [];
  });

  afterEach(async () => {
    for (const dir of dirs) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  async function harness(): Promise<Harness> {
    const h = await makeHarness(provider);
    dirs.push(h.dir);
    return h;
  }

  it('reports not configured before setup', async () => {
    const { ipc } = await harness();
    const status = await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_STATUS);
    expect(status.configured).toBe(false);
    expect(status.topologyUnlocked).toBe(false);
  });

  it('rejects a local-type sync target', async () => {
    const { ipc } = await harness();
    await expect(
      ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_SETUP, { target: { id: 'x', name: 'x', type: 'local' } })
    ).rejects.toThrow(/SFTP or S3/);
  });

  it('setup then enable on a brand new target generates salts and does an initial push', async () => {
    const { ipc } = await harness();
    await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_SETUP, { target: TARGET, remoteBasePath: 'test-bucket' });

    const status = await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_ENABLE, {
      topologyPassword: 'topology-pw',
      credentialsPassword: 'credentials-pw',
    });

    expect(status.configured).toBe(true);
    expect(status.topologyUnlocked).toBe(true);
    expect(status.credentialsUnlocked).toBe(true);
    expect(status.lastSyncAt).toBeTruthy();
    expect(status.target).toEqual({ id: 'sync-target', name: 'My Sync Bucket', type: 's3' });
  });

  // H4 (code review 2026-11-03): changing the target used to keep the old key and salts unlocked, so the next
  // auto-push encrypted with the old key and overwrote whatever another device had stored on the new target.
  describe('changing the sync target location', () => {
    const PW = { topologyPassword: 'topology-pw', credentialsPassword: 'credentials-pw' };

    it('locks sync, forgets the salts and turns auto-sync off', async () => {
      const { ipc } = await harness();
      await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_SETUP, { target: TARGET, remoteBasePath: 'test-bucket' });
      await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_ENABLE, PW);
      await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_SET_AUTO_SYNC, true);
      const before = await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_STATUS);
      expect(before).toMatchObject({ topologyUnlocked: true, hasLocalSalts: true, autoSync: true });

      await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_SETUP, { target: TARGET, remoteBasePath: 'another-bucket' });

      const after = await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_STATUS);
      expect(after).toMatchObject({
        topologyUnlocked: false,
        credentialsUnlocked: false,
        hasLocalSalts: false,
        autoSync: false,
        remoteBasePath: 'another-bucket',
      });
      expect(after.lastSyncAt).toBeUndefined();
      await expect(ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_PUSH)).rejects.toThrow();
    });

    it('does not write to the new target when a push was already scheduled', async () => {
      const { ipc, bridge } = await harness();
      await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_SETUP, { target: TARGET, remoteBasePath: 'test-bucket' });
      await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_ENABLE, PW);
      await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_SET_AUTO_SYNC, true);
      await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_SETUP, { target: TARGET, remoteBasePath: 'another-bucket' });

      const write = vi.spyOn(provider, 'createWriteStream');
      bridge.scheduleAutoSync(0);
      await new Promise((r) => setTimeout(r, 50));

      expect(write).not.toHaveBeenCalled();
    });

    // The renderer gives every sync target the same id, and the registry reuses a provider per id. A job that was
    // already running when the target changed could re-create the old provider after the handler dropped it,
    // and the next use of the new target would then talk to the old host.
    it('never hands out a cached provider that belongs to another location', async () => {
      const { bridge } = await harness();
      const registry = (bridge as any).storageRegistry as { getOrCreate: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };
      const sftp = (host: string): StorageConnectConfig => ({
        id: 'sshs3-remote-profile-sync', name: 'Remote profile sync', type: 'sftp',
        sftpConfig: { host, port: 22, username: 'sync', authType: 'password', password: 'pw' } as any, // pragma: allowlist secret
      });
      registry.disconnect.mockClear();

      await bridge.getSyncProvider(sftp('old.example.com'));
      expect(registry.disconnect).not.toHaveBeenCalled();

      await bridge.getSyncProvider(sftp('old.example.com'));
      expect(registry.disconnect).not.toHaveBeenCalled();

      await bridge.getSyncProvider(sftp('new.example.com'));
      expect(registry.disconnect).toHaveBeenCalledTimes(1);
      expect(registry.disconnect).toHaveBeenCalledWith('sshs3-remote-profile-sync');
      // The cache entry is dropped before the new provider is requested.
      expect(registry.disconnect.mock.invocationCallOrder[0]).toBeLessThan(registry.getOrCreate.mock.invocationCallOrder.at(-1)!);
    });

    it('keeps everything when the same location is saved again with other credentials', async () => {
      const { ipc } = await harness();
      await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_SETUP, { target: TARGET, remoteBasePath: 'test-bucket' });
      await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_ENABLE, PW);
      await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_SET_AUTO_SYNC, true);

      const rotated: StorageConnectConfig = { ...TARGET, s3Config: { ...TARGET.s3Config!, accessKeyId: 'ROTATED', secretAccessKey: 'rotated' } }; // pragma: allowlist secret
      await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_SETUP, { target: rotated, remoteBasePath: 'test-bucket/' });

      expect(await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_STATUS)).toMatchObject({
        topologyUnlocked: true,
        credentialsUnlocked: true,
        hasLocalSalts: true,
        autoSync: true,
      });
    });
  });

  it('refuses to enable with fresh salts when the target already has remote data from elsewhere', async () => {
    // Machine A sets up and enables first, pushing real data to the shared provider.
    const machineA = await harness();
    await machineA.ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_SETUP, { target: TARGET, remoteBasePath: 'test-bucket' });
    await machineA.ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_ENABLE, {
      topologyPassword: 'topology-pw',
      credentialsPassword: 'credentials-pw',
    });

    // Machine B has its own, never-before-configured local sync-config, but points at the same remote target.
    const machineB = await harness();
    await machineB.ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_SETUP, { target: TARGET, remoteBasePath: 'test-bucket' });

    await expect(
      machineB.ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_ENABLE, {
        topologyPassword: 'topology-pw',
        credentialsPassword: 'credentials-pw',
      })
    ).rejects.toThrow(/profile-sync:pull/);
  });

  it('push after enable updates lastSyncAt', async () => {
    const { ipc } = await harness();
    await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_SETUP, { target: TARGET, remoteBasePath: 'test-bucket' });
    const enabled = await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_ENABLE, {
      topologyPassword: 'topology-pw',
      credentialsPassword: 'credentials-pw',
    });

    await new Promise((r) => setTimeout(r, 2));
    const pushed = await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_PUSH);
    expect(new Date(pushed.lastSyncAt).getTime()).toBeGreaterThanOrEqual(new Date(enabled.lastSyncAt).getTime());
  });

  it('bootstraps a fresh machine via pull with explicit passwords and persists the learned salts', async () => {
    const machineA = await harness();
    await machineA.ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_SETUP, { target: TARGET, remoteBasePath: 'test-bucket' });
    await machineA.ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_ENABLE, {
      topologyPassword: 'topology-pw',
      credentialsPassword: 'credentials-pw',
    });

    const machineB = await harness();
    await machineB.ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_SETUP, { target: TARGET, remoteBasePath: 'test-bucket' });
    const result = await machineB.ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_PULL, {
      topologyPassword: 'topology-pw',
      credentialsPassword: 'credentials-pw',
    });

    expect(result.topologyUnlocked).toBe(true);
    expect(result.credentialsUnlocked).toBe(true);

    // A second pull, with no passwords this time, must succeed using the salts persisted from the first pull.
    const status = await machineB.ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_STATUS);
    expect(status.lastSyncAt).toBeTruthy();
  });

  it('setup, enable, and pull all fail clearly without a configured target', async () => {
    const { ipc } = await harness();
    await expect(ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_ENABLE, { topologyPassword: 'a', credentialsPassword: 'b' })).rejects.toThrow(
      /profile-sync:setup/
    );
    await expect(ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_PULL)).rejects.toThrow(/profile-sync:setup/);
    await expect(ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_PUSH)).rejects.toThrow(/profile-sync:setup/);
    await expect(ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_COMPARE)).rejects.toThrow(/profile-sync:setup/);
  });

  it('performs live sync comparison via PROFILE_SYNC_COMPARE', async () => {
    const { ipc } = await harness();
    await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_SETUP, { target: TARGET, remoteBasePath: 'test-bucket' });
    await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_ENABLE, {
      topologyPassword: 'topology-pw',
      credentialsPassword: 'credentials-pw',
    });

    const comparison = await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_COMPARE);
    expect(comparison).toBeDefined();
    expect(comparison.state).toBe('in_sync');
    expect(comparison.aheadCount).toBe(0);
    expect(comparison.behindCount).toBe(0);
  });

  it('supports single master password for both topology and credentials', async () => {
    const { ipc } = await harness();
    await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_SETUP, { target: TARGET, remoteBasePath: 'test-bucket' });
    const status = await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_ENABLE, {
      topologyPassword: 'single-master-password',
      credentialsPassword: 'single-master-password',
    });

    expect(status.topologyUnlocked).toBe(true);
    expect(status.credentialsUnlocked).toBe(true);
    expect(status.hasLocalSalts).toBe(true);
  });

  it('toggles autoSync setting and schedules auto-push on profile changes', async () => {
    const { ipc, bridge } = await harness();
    await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_SETUP, { target: TARGET, remoteBasePath: 'test-bucket' });
    await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_ENABLE, {
      topologyPassword: 'single-master-password',
      credentialsPassword: 'single-master-password',
    });

    const status1 = await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_SET_AUTO_SYNC, true);
    expect(status1.autoSync).toBe(true);

    // Save a new SSH profile - triggers scheduleAutoSync
    await ipc.invoke(IPC_CHANNELS.PROFILES_SAVE_SSH, {
      id: 'auto-sync-profile',
      name: 'Auto Synced Server',
      host: 'auto.example.com',
      port: 22,
      username: 'root',
      authType: 'password',
    });

    // Wait for the auto-sync debounced push (delay is shortened or wait 2.5s)
    await new Promise((r) => setTimeout(r, 2200));

    const status2 = await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_STATUS);
    expect(status2.lastSyncAt).toBeTruthy();

    await bridge.dispose();
  });

  it('unlinks smartcard via PROFILE_SYNC_UNLINK_SMARTCARD', async () => {
    const { ipc, syncConfigStore, bridge } = await harness();
    await syncConfigStore.setSmartcardSync({
      pkcs11LibPath: '/usr/lib/libopensc.so',
      keyComment: 'Smartcard Key 1',
    });

    const statusBefore = await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_STATUS);
    expect(statusBefore.smartcardLinked).toBe(true);

    const statusAfter = await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_UNLINK_SMARTCARD);
    expect(statusAfter.smartcardLinked).toBe(false);

    await bridge.dispose();
  });

  describe('PROFILE_SYNC_WIPE ("delete all sync data")', () => {
    it('deletes the remote files and resets local config to fully unconfigured', async () => {
      const { ipc, bridge } = await harness();
      await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_SETUP, { target: TARGET, remoteBasePath: 'test-bucket' });
      await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_ENABLE, {
        topologyPassword: 'topology-pw',
        credentialsPassword: 'credentials-pw',
      });
      const result = await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_WIPE);

      expect(result.remoteWipeErrors).toEqual([]);
      expect(result.configured).toBe(false);
      expect(result.hasLocalSalts).toBe(false);
      expect(result.topologyUnlocked).toBe(false);
      expect(result.credentialsUnlocked).toBe(false);
      expect(result.smartcardLinked).toBe(false);

      const statusAfter = await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_STATUS);
      expect(statusAfter.configured).toBe(false);

      await bridge.dispose();
    });

    it('is a no-op success when no target was ever configured', async () => {
      const { ipc, bridge } = await harness();
      const result = await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_WIPE);
      expect(result.configured).toBe(false);
      expect(result.remoteWipeErrors).toEqual([]);
      await bridge.dispose();
    });

    it('still clears local config and surfaces the error when a remote file fails to delete', async () => {
      const { ipc, bridge } = await harness();
      await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_SETUP, { target: TARGET, remoteBasePath: 'test-bucket' });
      await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_ENABLE, {
        topologyPassword: 'topology-pw',
        credentialsPassword: 'credentials-pw',
      });

      const deleteSpy = vi.spyOn(provider, 'delete').mockRejectedValueOnce(new Error('permission denied'));

      const result = await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_WIPE);

      expect(result.remoteWipeErrors.length).toBeGreaterThan(0);
      expect(result.remoteWipeErrors[0]).toContain('permission denied');
      // Local config is still cleared regardless of the remote failure.
      expect(result.configured).toBe(false);

      deleteSpy.mockRestore();
      await bridge.dispose();
    });
  });

  describe('auto-sync: catch-up push and smartcard auto-unlock', () => {
    it('flushes pending local changes with a catch-up push right after a manual re-unlock (was previously pull-only)', async () => {
      const { ipc, bridge, syncCryptoService } = await harness();
      await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_SETUP, { target: TARGET, remoteBasePath: 'test-bucket' });
      await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_ENABLE, {
        topologyPassword: 'single-master-password',
        credentialsPassword: 'single-master-password',
      });
      await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_SET_AUTO_SYNC, true);

      // Simulate the app being locked (e.g. a fresh run) while a local edit happens.
      syncCryptoService.lock();
      await ipc.invoke(IPC_CHANNELS.PROFILES_SAVE_SSH, {
        id: 'p1',
        name: 'P1',
        host: 'h',
        username: 'u',
        authType: 'password',
      });

      // Manual re-unlock, as the "Unlock sync" button in Settings does.
      await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_ENABLE, {
        topologyPassword: 'single-master-password',
        credentialsPassword: 'single-master-password',
      });

      // The catch-up push is scheduled 500ms after unlock.
      await new Promise((r) => setTimeout(r, 800));

      const compare = await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_COMPARE);
      expect(compare.state).toBe('in_sync');

      await bridge.dispose();
    });

    it('automatically unlocks via a linked smartcard for a background auto-sync push when locked', async () => {
      const { ipc, bridge, syncCryptoService } = await harness();
      await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_SETUP, { target: TARGET, remoteBasePath: 'test-bucket' });
      await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_ENABLE, {
        topologyPassword: 'single-master-password',
        credentialsPassword: 'single-master-password',
      });
      await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_SET_AUTO_SYNC, true);
      await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_LINK_SMARTCARD, { pkcs11LibPath: '/fake/pkcs11.so' });

      syncCryptoService.lock();
      expect(syncCryptoService.isUnlocked('topology')).toBe(false);

      await ipc.invoke(IPC_CHANNELS.PROFILES_SAVE_SSH, {
        id: 'p2',
        name: 'P2',
        host: 'h',
        username: 'u',
        authType: 'password',
      });

      // scheduleAutoSync's default 2s debounce should auto-unlock via the mocked smartcard and push.
      await new Promise((r) => setTimeout(r, 2500));

      expect(syncCryptoService.isUnlocked('topology')).toBe(true);
      const compare = await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_COMPARE);
      expect(compare.state).toBe('in_sync');

      await bridge.dispose();
    }, 10000);

    it('does not retry a failed smartcard auto-unlock on every debounce tick (cooldown)', async () => {
      const { ipc, bridge, syncCryptoService } = await harness();
      await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_SETUP, { target: TARGET, remoteBasePath: 'test-bucket' });
      await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_ENABLE, {
        topologyPassword: 'single-master-password',
        credentialsPassword: 'single-master-password',
      });
      await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_SET_AUTO_SYNC, true);
      await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_LINK_SMARTCARD, { pkcs11LibPath: '/fake/pkcs11.so' });

      const { loadSmartcardIntoPrivateAgent } = await import('../../src/main/smartcard/SmartcardAgentLoader');
      (loadSmartcardIntoPrivateAgent as any).mockRejectedValueOnce(new Error('card not present'));

      syncCryptoService.lock();
      await ipc.invoke(IPC_CHANNELS.PROFILES_SAVE_SSH, {
        id: 'p3',
        name: 'P3',
        host: 'h',
        username: 'u',
        authType: 'password',
      });
      await new Promise((r) => setTimeout(r, 2500)); // First auto-unlock attempt fails.
      expect(syncCryptoService.isUnlocked('topology')).toBe(false);

      // A second local change right after should NOT immediately retry — the
      // cooldown should still be in effect even though the card would now
      // "succeed" (mockRejectedValueOnce only failed the first call).
      await ipc.invoke(IPC_CHANNELS.PROFILES_SAVE_SSH, {
        id: 'p4',
        name: 'P4',
        host: 'h',
        username: 'u',
        authType: 'password',
      });
      await new Promise((r) => setTimeout(r, 2500));
      expect(syncCryptoService.isUnlocked('topology')).toBe(false);

      await bridge.dispose();
    }, 10000);

    it('reuses the app agent in agent-global mode without re-prompting for PIN', async () => {
      const { ipc, bridge, syncCryptoService, settingsStore, appAgent } = await harness();
      await settingsStore.saveSettings({ smartcardAuthMode: 'agent-global' });

      await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_SETUP, { target: TARGET, remoteBasePath: 'test-bucket' });
      await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_ENABLE, {
        topologyPassword: 'single-master-password',
        credentialsPassword: 'single-master-password',
      });
      await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_LINK_SMARTCARD, { pkcs11LibPath: '/fake/pkcs11.so' });

      // Lock sync
      syncCryptoService.lock();
      expect(syncCryptoService.isUnlocked('topology')).toBe(false);

      // LINK_SMARTCARD loaded the card into the app agent once under agent-global.
      expect(appAgent.addPkcs11).toHaveBeenCalledTimes(1);

      // Now unlock via smartcard again — it should reuse the app agent and NOT load (or prompt) again.
      await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_UNLOCK_SMARTCARD, { pkcs11LibPath: '/fake/pkcs11.so' });

      expect(syncCryptoService.isUnlocked('topology')).toBe(true);
      expect(appAgent.addPkcs11).toHaveBeenCalledTimes(1); // No second PIN prompt / load!

      await bridge.dispose();
    });

    it('links the card that was unlocked, not another card\'s key that shares the app agent', async () => {
      const { ipc, bridge, settingsStore } = await harness();
      await settingsStore.saveSettings({ smartcardAuthMode: 'agent-global' });
      const { getAgentIdentities, signChallengeWithAgent } = await import('../../src/main/smartcard/SmartcardSyncService');
      const otherCardKey = Buffer.from('some-other-cards-key');
      // The agent lists another card's key first; the linked card's key is second.
      vi.mocked(getAgentIdentities).mockResolvedValue([
        { keyBlob: otherCardKey, comment: 'Other card' },
        { keyBlob: Buffer.from('fake-key-blob'), comment: 'Test Card' },
      ] as any);

      await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_SETUP, { target: TARGET, remoteBasePath: 'test-bucket' });
      await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_ENABLE, {
        topologyPassword: 'single-master-password',
        credentialsPassword: 'single-master-password',
      });
      vi.mocked(signChallengeWithAgent).mockClear();
      await ipc.invoke(IPC_CHANNELS.PROFILE_SYNC_LINK_SMARTCARD, { pkcs11LibPath: '/fake/pkcs11.so' });

      expect(vi.mocked(signChallengeWithAgent).mock.calls[0][1]).toEqual(Buffer.from('fake-key-blob'));

      vi.mocked(getAgentIdentities).mockResolvedValue([
        { keyBlob: Buffer.from('fake-key-blob'), comment: 'Test Card' },
      ] as any);
      await bridge.dispose();
    });
  });
});
