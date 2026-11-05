import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const { mockEncryptString, mockDecryptString, mockIsEncryptionAvailable } = vi.hoisted(() => {
  return {
    mockEncryptString: vi.fn((value: string) => Buffer.from(`cipher:${value}`, 'utf-8')),
    mockDecryptString: vi.fn((buf: Buffer) => buf.toString('utf-8').replace(/^cipher:/, '')),
    mockIsEncryptionAvailable: vi.fn().mockReturnValue(true),
  };
});

vi.mock('electron', () => {
  const mockObj = {
    app: { getPath: vi.fn().mockReturnValue('/tmp/user-data') },
    safeStorage: {
      isEncryptionAvailable: mockIsEncryptionAvailable,
      encryptString: mockEncryptString,
      decryptString: mockDecryptString,
    },
  };
  return { ...mockObj, default: mockObj };
});

import { TeamVaultConfigStore } from '../../src/main/services/TeamVaultConfigStore';
import type { StorageConnectConfig } from '../../src/shared/types/ipc';
import { TEAM_VAULT_PENDING_VAULT_ID } from '../../src/shared/types/teamVault';
import { setLogSinks } from '../../src/main/log/Logger';

const VAULT_ID = 'vlt_test-vault';
const OTHER_VAULT_ID = 'vlt_other-vault';

describe('TeamVaultConfigStore', () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(async () => {
    mockIsEncryptionAvailable.mockReturnValue(true);
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sshs3-team-vault-config-test-'));
    storePath = path.join(tempDir, 'team-vault-sync-config.json');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('returns an empty config when no file exists yet', async () => {
    const store = new TeamVaultConfigStore(storePath);
    expect(await store.getConfig(VAULT_ID)).toEqual({});
    expect(await store.getAllConfigs()).toEqual({});
  });

  it('logs a warning (but still returns an empty config) when the file is corrupted, unlike the silent ENOENT case', async () => {
    const lines: string[] = [];
    setLogSinks([{ write: (line) => lines.push(line) }]);
    try {
      await fs.writeFile(storePath, 'not valid json{{{');
      const store = new TeamVaultConfigStore(storePath);
      expect(await store.getConfig(VAULT_ID)).toEqual({});
      expect(lines.some((l) => l.includes('WARN') && l.includes('Failed to read Team Vault config'))).toBe(true);
    } finally {
      setLogSinks([]);
    }
  });

  it('encrypts the S3 target credentials at rest and decrypts them on read', async () => {
    const store = new TeamVaultConfigStore(storePath);
    const target: StorageConnectConfig = {
      id: 'team-vault-target',
      name: 'Team Vault Bucket',
      type: 's3',
      s3Config: {
        id: 'team-vault-target',
        name: 'Team Vault Bucket',
        region: 'us-east-1',
        accessKeyId: 'AKIA',
        secretAccessKey: 'top-secret', // pragma: allowlist secret
      },
    };
    await store.setTarget(VAULT_ID, target, 'team-bucket/prefix');

    const raw = await fs.readFile(storePath, 'utf-8');
    expect(raw).not.toContain('top-secret');

    const config = await store.getConfig(VAULT_ID);
    expect(config.target?.s3Config?.secretAccessKey).toBe('top-secret');
    expect(config.target?.s3Config?.accessKeyId).toBe('AKIA');
    expect(config.remoteBasePath).toBe('team-bucket/prefix');
  });

  it('does not re-encrypt an untouched vault\'s secret when a different vault is written (regression: compounding double-encryption)', async () => {
    const store = new TeamVaultConfigStore(storePath);
    const target: StorageConnectConfig = {
      id: 'team-vault-target',
      name: 'Team Vault Bucket',
      type: 's3',
      s3Config: {
        id: 'team-vault-target',
        name: 'Team Vault Bucket',
        region: 'us-east-1',
        accessKeyId: 'AKIA',
        secretAccessKey: 'top-secret', // pragma: allowlist secret
      },
    };
    await store.setTarget(VAULT_ID, target, 'team-bucket/prefix');

    // Simulate another team's unrelated writes (e.g. its own auto-sync's setLastSyncAt), which
    // must not touch VAULT_ID's already-encrypted target at all.
    await store.setLastSyncAt(OTHER_VAULT_ID, '2026-01-01T00:00:00.000Z');
    await store.setSelfIdentity(OTHER_VAULT_ID, 'bob@piv:yubikey-2', '/some/other/path.txt');
    await store.setLastSyncAt(OTHER_VAULT_ID, '2026-01-02T00:00:00.000Z');

    // A single decrypt pass must still recover the real secret, not a still-encrypted value.
    const config = await store.getConfig(VAULT_ID);
    expect(config.target?.s3Config?.secretAccessKey).toBe('top-secret');
  });

  // M1: the highest format the remote file has had, so that a lower one (a replayed pre-upgrade file) is refused later.
  it('remembers the highest remote format seen, never lowers it, and forgets it with the rest of the sync state', async () => {
    const store = new TeamVaultConfigStore(storePath);
    await store.setLastKnownRemoteEntry('vlt_a', { name: 'vault.json', path: 'p', size: 1, isDirectory: false } as any, 3, 2);
    expect((await store.getConfig('vlt_a')).remoteFormatVersion).toBe(2);

    await store.setLastKnownRemoteEntry('vlt_a', null, 4, 1); // a lower format never lowers the mark
    expect((await store.getConfig('vlt_a')).remoteFormatVersion).toBe(2);

    await store.setLastKnownRemoteEntry('vlt_a', null, 5); // omitting it leaves the mark alone
    expect((await store.getConfig('vlt_a')).remoteFormatVersion).toBe(2);

    await store.clearSyncState('vlt_a');
    expect((await store.getConfig('vlt_a')).remoteFormatVersion).toBeUndefined();
  });

  it('records the last successful sync timestamp', async () => {
    const store = new TeamVaultConfigStore(storePath);
    await store.setLastSyncAt(VAULT_ID, '2026-01-01T00:00:00.000Z');
    expect((await store.getConfig(VAULT_ID)).lastSyncAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('remembers this machine\'s own recipient id and identity file path for unlock-form prefill', async () => {
    const store = new TeamVaultConfigStore(storePath);
    await store.setSelfIdentity(VAULT_ID, 'alice@piv:yubikey-1', '/home/alice/.config/sshs3/team-vault-identities/abc.txt');
    const config = await store.getConfig(VAULT_ID);
    expect(config.selfRecipientId).toBe('alice@piv:yubikey-1');
    expect(config.selfIdentityFilePath).toBe('/home/alice/.config/sshs3/team-vault-identities/abc.txt');
  });

  it('setSelfIdentity can update just the identity file path, keeping a previously saved recipient id', async () => {
    const store = new TeamVaultConfigStore(storePath);
    await store.setSelfIdentity(VAULT_ID, 'alice@piv:yubikey-1', '/old/path.txt');
    await store.setSelfIdentity(VAULT_ID, undefined, '/new/path.txt');
    const config = await store.getConfig(VAULT_ID);
    expect(config.selfRecipientId).toBe('alice@piv:yubikey-1');
    expect(config.selfIdentityFilePath).toBe('/new/path.txt');
  });

  it('clearSelfIdentity explicitly nulls out both remembered fields, unlike setSelfIdentity(vaultId, undefined, undefined) which is a no-op', async () => {
    const store = new TeamVaultConfigStore(storePath);
    await store.setSelfIdentity(VAULT_ID, 'alice@piv:yubikey-1', '/some/path.txt');

    await store.setSelfIdentity(VAULT_ID, undefined, undefined);
    expect((await store.getConfig(VAULT_ID)).selfRecipientId).toBe('alice@piv:yubikey-1');

    await store.clearSelfIdentity(VAULT_ID);
    const config = await store.getConfig(VAULT_ID);
    expect(config.selfRecipientId).toBeUndefined();
    expect(config.selfIdentityFilePath).toBeUndefined();
  });

  it('clear() resets the target and every other field for that vault only', async () => {
    const store = new TeamVaultConfigStore(storePath);
    await store.setTarget(VAULT_ID, {
      id: 'team-vault-target',
      name: 'Team Vault Bucket',
      type: 's3',
      s3Config: {
        id: 'team-vault-target',
        name: 'Team Vault Bucket',
        region: 'us-east-1',
        accessKeyId: 'AKIA',
        secretAccessKey: 'top-secret', // pragma: allowlist secret
      },
    });
    await store.setLastSyncAt(VAULT_ID, '2026-01-01T00:00:00.000Z');
    await store.setSelfIdentity(VAULT_ID, 'alice@piv:yubikey-1', '/some/path.txt');
    await store.setLastSyncAt(OTHER_VAULT_ID, '2026-02-02T00:00:00.000Z');

    await store.clear(VAULT_ID);

    expect(await store.getConfig(VAULT_ID)).toEqual({});
    expect((await store.getConfig(OTHER_VAULT_ID)).lastSyncAt).toBe('2026-02-02T00:00:00.000Z');
  });

  it('getAllConfigs returns every known vault in one round trip, each decrypted', async () => {
    const store = new TeamVaultConfigStore(storePath);
    await store.setLastSyncAt(VAULT_ID, '2026-01-01T00:00:00.000Z');
    await store.setTarget(OTHER_VAULT_ID, {
      id: 'other-target',
      name: 'Other Bucket',
      type: 's3',
      s3Config: {
        id: 'other-target',
        name: 'Other Bucket',
        region: 'us-east-1',
        accessKeyId: 'AKIA2',
        secretAccessKey: 'other-secret', // pragma: allowlist secret
      },
    });

    const all = await store.getAllConfigs();
    expect(Object.keys(all).sort()).toEqual([OTHER_VAULT_ID, VAULT_ID].sort());
    expect(all[VAULT_ID].lastSyncAt).toBe('2026-01-01T00:00:00.000Z');
    expect(all[OTHER_VAULT_ID].target?.s3Config?.secretAccessKey).toBe('other-secret');
  });

  it('wraps a legacy (pre-multi-team) single-entry file under the pending sentinel on read', async () => {
    // Simulate an on-disk file written by a pre-multi-team app version: a flat entry with no
    // `byVaultId` wrapper.
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify({ lastSyncAt: '2025-06-01T00:00:00.000Z', selfRecipientId: 'legacy@piv:abc' }),
      'utf-8'
    );
    const store = new TeamVaultConfigStore(storePath);
    const pending = await store.getConfig(TEAM_VAULT_PENDING_VAULT_ID);
    expect(pending.lastSyncAt).toBe('2025-06-01T00:00:00.000Z');
    expect(pending.selfRecipientId).toBe('legacy@piv:abc');
  });

  it('promotePendingConfig moves the pending entry to the real vaultId once learned, and is a no-op without one', async () => {
    const store = new TeamVaultConfigStore(storePath);
    await store.setTarget(TEAM_VAULT_PENDING_VAULT_ID, {
      id: 'pending-target',
      name: 'Pending Bucket',
      type: 's3',
      s3Config: {
        id: 'pending-target',
        name: 'Pending Bucket',
        region: 'us-east-1',
        accessKeyId: 'AKIA3',
        secretAccessKey: '', // pragma: allowlist secret
      },
    });

    await store.promotePendingConfig(VAULT_ID);

    expect(await store.getConfig(TEAM_VAULT_PENDING_VAULT_ID)).toEqual({});
    expect((await store.getConfig(VAULT_ID)).target?.s3Config?.accessKeyId).toBe('AKIA3');

    // No-op the second time around: nothing pending left to promote.
    await store.promotePendingConfig(VAULT_ID);
    expect((await store.getConfig(VAULT_ID)).target?.s3Config?.accessKeyId).toBe('AKIA3');
  });
});
