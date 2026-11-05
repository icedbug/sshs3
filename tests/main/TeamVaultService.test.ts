import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({
  app: { getPath: vi.fn().mockReturnValue('/tmp/unused-user-data') },
}));

import {
  TeamVaultService,
  TeamVaultSyncConflictError,
  TeamVaultForeignVaultError,
  TeamVaultRollbackError,
  TeamVaultTamperedEntryError,
  TeamVaultHeaderIntegrityError,
  TeamVaultUnpushedChangesError,
  TeamVaultLockedForPullError,
  TeamVaultRotationProofError,
} from '../../src/main/services/TeamVaultService';
import type { TeamVaultCryptoService } from '../../src/main/services/TeamVaultCryptoService';
import type { FileEntry, IStorageProvider, S3Config } from '../../src/shared/types/storage';
import type { SSHConnectionConfig } from '../../src/shared/types/ssh';

/** A minimal in-memory S3-like provider — only `stat`/`writeFile`/`readFile` are exercised by
 * TeamVaultService's push/pull, same subset `ProfileSyncService` relies on. */
function fakeProvider(): IStorageProvider {
  const files = new Map<string, { data: Buffer; mtime: string }>();
  let tick = 0;
  return {
    id: 'fake-s3',
    name: 'Fake S3',
    type: 's3',
    list: async () => [],
    stat: async (remotePath: string): Promise<FileEntry> => {
      const entry = files.get(remotePath);
      if (!entry) {
        const err: any = new Error('NoSuchKey');
        err.name = 'NoSuchKey';
        throw err;
      }
      return { name: remotePath, path: remotePath, size: entry.data.length, isDirectory: false, mtime: entry.mtime };
    },
    createFolder: async () => {},
    delete: async () => {
      files.clear();
    },
    rename: async () => {},
    createReadStream: async () => {
      throw new Error('not implemented in fake provider');
    },
    createWriteStream: async () => {
      throw new Error('not implemented in fake provider');
    },
    writeFile: async (remotePath: string, data: Buffer | Uint8Array) => {
      tick += 1;
      files.set(remotePath, { data: Buffer.from(data), mtime: `2026-01-01T00:00:${String(tick).padStart(2, '0')}Z` });
    },
    readFile: async (remotePath: string) => {
      const entry = files.get(remotePath);
      if (!entry) {
        const err: any = new Error('NoSuchKey');
        err.name = 'NoSuchKey';
        throw err;
      }
      return entry.data;
    },
  } as unknown as IStorageProvider;
}

/** A deterministic, in-memory stand-in for the real `age`-backed crypto service, so these tests
 * exercise TeamVaultService's own orchestration (re-keying, unlock gating, file persistence)
 * without shelling out to any binary. */
function fakeCrypto(): TeamVaultCryptoService {
  return {
    generateVaultKey: () => crypto.randomBytes(32),
    encryptPayload: (key: Buffer, vaultId: string, v: number, plaintext: string) =>
      `${key.toString('hex')}|${vaultId}|${v}|${plaintext}`,
    decryptPayload: (key: Buffer, vaultId: string, v: number, encrypted: string) => {
      const [keyHex, evId, ev, ...rest] = encrypted.split('|');
      if (keyHex !== key.toString('hex') || evId !== vaultId || Number(ev) !== v) {
        throw new Error('decrypt failed: wrong key/vaultId/version');
      }
      return rest.join('|');
    },
    wrapVaultKeyForRecipient: async (key: Buffer, recipient: string) => `wrapped:${recipient}:${key.toString('hex')}`,
    unwrapVaultKey: async (wrapped: string) => {
      const m = wrapped.match(/^wrapped:[^:]+:([0-9a-f]+)$/);
      if (!m) throw new Error('bad wrap');
      return Buffer.from(m[1], 'hex');
    },
    // Deterministic stand-in for the real age-backed encrypt/decrypt (TeamVaultService.buildInvite
    // / decodeInvite) — embeds the recipient so a test can assert the right one was used, without
    // actually tying decryption to a specific identity file (these tests fake identity-mismatch
    // failures by having decryptWithIdentity reject outright instead, same as `age` would).
    encryptForRecipient: async (plaintext: string, ageRecipient: string) =>
      `enc:${ageRecipient}:${Buffer.from(plaintext, 'utf8').toString('base64')}`,
    decryptWithIdentity: async (armoredCiphertext: string) => {
      // Tolerates an optional real age armor envelope around the fake `enc:...` payload — lets
      // tests exercise extractInviteCiphertext's primary BEGIN/END-marker extraction path (not
      // just its legacy header-line fallback) without needing the real `age` binary.
      const unwrapped = armoredCiphertext
        .replace(/^-----BEGIN AGE ENCRYPTED FILE-----\n?/, '')
        .replace(/\n?-----END AGE ENCRYPTED FILE-----$/, '');
      const m = unwrapped.match(/^enc:[^:]+:(.+)$/s);
      if (!m) throw new Error('age: error: failed to parse ciphertext');
      return Buffer.from(m[1], 'base64').toString('utf8');
    },
    enrollOwnPivRecipient: async () => ({
      recipient: 'age1yubikey1fakeadmin',
      identityFilePath: '/tmp/fake-admin-identity.txt',
    }),
    unwrapVaultKeyWithRecoveryIdentity: async (wrapped: string, identityText: string) => {
      if (!identityText.includes('AGE-SECRET-KEY-1')) {
        throw new Error('This does not look like a Team Vault recovery key (no AGE-SECRET-KEY-1... line found)');
      }
      const m = wrapped.match(/^wrapped:[^:]+:([0-9a-f]+)$/);
      if (!m) throw new Error('bad wrap');
      return Buffer.from(m[1], 'hex');
    },
    generateRecoveryIdentity: async () => ({
      identity: 'AGE-SECRET-KEY-FAKE\n# public key: age1fakerecovery',
      recipient: 'age1fakerecovery',
    }),
    // Simplified but real, deterministic HMAC keyed by the Vault Key — doesn't need to match the
    // production algorithm's exact canonicalization/HKDF, only to be internally consistent (same
    // inputs -> same tag) across every TeamVaultService instance under test.
    computeAccessHeaderMac: (
      vaultKey: Buffer,
      vaultId: string,
      revision: number,
      vaultName: string,
      accessHeader: unknown,
      recovery: unknown
    ) =>
      crypto
        .createHmac('sha256', vaultKey)
        .update(JSON.stringify({ vaultId, revision, vaultName, accessHeader, recovery }))
        .digest('base64'),
    // Format-aware stand-ins used by TeamVaultService itself. v1 reproduces the header-only coverage above; v2 also
    // covers the payload ciphertext, updatedAt/updatedBy and the description, like the real implementation, and a
    // different label per version so a v1 tag never equals a v2 tag.
    computeFileMac: (vaultKey: Buffer, file: any) =>
      crypto
        .createHmac('sha256', vaultKey)
        .update(
          JSON.stringify(
            file.formatVersion === 1
              ? { vaultId: file.vaultId, revision: file.revision, vaultName: file.vaultName ?? '', accessHeader: file.accessHeader, recovery: file.recovery }
              : {
                  label: 'file-mac-v2',
                  formatVersion: file.formatVersion,
                  vaultId: file.vaultId,
                  revision: file.revision,
                  updatedAt: file.updatedAt,
                  updatedBy: file.updatedBy,
                  vaultName: file.vaultName ?? '',
                  vaultDescription: file.vaultDescription ?? '',
                  accessHeader: file.accessHeader,
                  recovery: file.recovery,
                  encryptedPayload: file.encryptedPayload,
                }
          )
        )
        .digest('base64'),
    computeFileRotationProof: (oldVaultKey: Buffer, file: any) =>
      crypto
        .createHmac('sha256', oldVaultKey)
        .update(
          JSON.stringify({
            label: file.formatVersion === 1 ? 'rotation-proof' : 'rotation-proof-v2',
            vaultId: file.vaultId,
            revision: file.revision,
            updatedAt: file.formatVersion === 1 ? undefined : file.updatedAt,
            updatedBy: file.formatVersion === 1 ? undefined : file.updatedBy,
            vaultName: file.vaultName ?? '',
            accessHeader: file.accessHeader,
            recovery: file.recovery,
            encryptedPayload: file.formatVersion === 1 ? undefined : file.encryptedPayload,
          })
        )
        .digest('base64'),
    // Same shape as computeAccessHeaderMac above, but under a distinct fixed label so a rotation
    // proof (keyed by the OLD Vault Key) can never collide with a header MAC (keyed by the NEW
    // one) even when both happen to cover the exact same fields — mirrors the real
    // implementation's separate HKDF info strings.
    computeRotationProof: (
      oldVaultKey: Buffer,
      vaultId: string,
      revision: number,
      vaultName: string,
      accessHeader: unknown,
      recovery: unknown
    ) =>
      crypto
        .createHmac('sha256', oldVaultKey)
        .update(JSON.stringify({ label: 'rotation-proof', vaultId, revision, vaultName, accessHeader, recovery }))
        .digest('base64'),
  } as unknown as TeamVaultCryptoService;
}

/** A structurally valid, unrelated vault file — used to simulate "someone else's content is
 * already sitting at this S3 path" without needing a second real TeamVaultService instance. */
function foreignVaultFileJson(
  vaultId: string,
  revision = 1,
  recoveryAgeRecipient = 'age1yubikey1foreignrecovery',
  accessHeader: unknown[] = []
): string {
  return JSON.stringify({
    formatVersion: 2,
    vaultId,
    revision,
    updatedAt: '2026-01-01T00:00:00Z',
    updatedBy: 'someone@piv:else',
    accessHeader,
    recovery: { recipientId: 'recovery-key-1', ageRecipient: recoveryAgeRecipient, wrappedVaultKey: 'w' },
    encryptedPayload: '',
    accessHeaderMac: 'placeholder-mac',
  });
}

describe('TeamVaultService', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sshs3-team-vault-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  function makeService(): TeamVaultService {
    return new TeamVaultService({ cryptoService: fakeCrypto(), baseDir: tempDir });
  }

  describe('getStatus', () => {
    it('reports exists:false when no vault file exists yet', async () => {
      const service = makeService();
      const vaultId = 'vlt_nonexistent';
      expect(await service.getStatus(vaultId)).toEqual({
        exists: false,
        unlocked: false,
        filePath: service.getFilePath(vaultId),
      });
    });
  });

  describe('createVault', () => {
    it('creates a vault with the creating admin as the sole member, unlocked in this session', async () => {
      const service = makeService();
      const { vaultId, recoveryIdentity } = await service.createVault('alice@piv:abc', 'age1yubikey1alice');

      expect(recoveryIdentity).toContain('AGE-SECRET-KEY-FAKE');
      expect(service.isUnlocked(vaultId)).toBe(true);

      const status = await service.getStatus(vaultId);
      expect(status.exists).toBe(true);
      expect(status.members).toEqual([{ recipientId: 'alice@piv:abc', role: 'admin', addedAt: expect.any(String) }]);
      expect(status.adminCount).toBe(1);
    });

    it('creating a second vault succeeds independently with its own vaultId — multi-team is supported, not a single-vault-per-machine restriction', async () => {
      const service = makeService();
      const first = await service.createVault('alice@piv:abc', 'age1yubikey1alice');
      const second = await service.createVault('bob@piv:def', 'age1yubikey1bob');

      expect(second.vaultId).not.toBe(first.vaultId);
      expect((await service.getStatus(first.vaultId)).exists).toBe(true);
      expect((await service.getStatus(second.vaultId)).exists).toBe(true);
      expect((await service.listVaultIds()).sort()).toEqual([first.vaultId, second.vaultId].sort());
    });
  });

  describe('addMember', () => {
    it('requires the vault to be unlocked first', async () => {
      const service = makeService();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      service.lock(vaultId);

      await expect(service.addMember(vaultId, 'bob@piv:def', 'age1yubikey1bob', 'member')).rejects.toThrow(
        'Unlock the Team Vault'
      );
    });

    it('adds a member without re-keying (same wrapped key material for existing members)', async () => {
      const service = makeService();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      const beforeStatus = await service.getStatus(vaultId);

      await service.addMember(vaultId, 'bob@piv:def', 'age1yubikey1bob', 'member');

      const status = await service.getStatus(vaultId);
      expect(status.members).toHaveLength(2);
      expect(status.adminCount).toBe(1);
      expect(status.members).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ recipientId: 'alice@piv:abc', role: 'admin' }),
          expect.objectContaining({ recipientId: 'bob@piv:def', role: 'member' }),
        ])
      );
      expect(beforeStatus.members).toHaveLength(1);
    });

    it('rejects adding a recipientId that is already a member', async () => {
      const service = makeService();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await expect(service.addMember(vaultId, 'alice@piv:abc', 'age1yubikey1alice', 'member')).rejects.toThrow(
        'already a member'
      );
    });

    it('rejects a plain member trying to add someone — only an admin may mutate membership', async () => {
      const first = makeService();
      const vaultId = (await first.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await first.addMember(vaultId, 'bob@piv:def', 'age1yubikey1bob', 'member');

      const asBob = new TeamVaultService({ cryptoService: fakeCrypto(), baseDir: tempDir });
      await asBob.unlock(vaultId, 'bob@piv:def', '/tmp/fake-bob-identity.txt');

      await expect(asBob.addMember(vaultId, 'carol@piv:ghi', 'age1yubikey1carol', 'member')).rejects.toThrow(
        'Only a Team Vault admin'
      );
    });

    it('attributes addedBy/updatedBy to whoever actually unlocked the vault, never a caller-supplied value', async () => {
      // There is no `addedBy` parameter on addMember at all — this is the whole point of the fix:
      // the audit trail can't be spoofed by whatever string a (potentially compromised) renderer
      // happens to send, only by who really unlocked the session.
      const service = makeService();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await service.addMember(vaultId, 'bob@piv:def', 'age1yubikey1bob', 'member');

      const raw = JSON.parse(await fs.readFile(path.join(tempDir, "team-vaults", `${vaultId}.json`), 'utf-8'));
      const bobEntry = raw.accessHeader.find((e: any) => e.recipientId === 'bob@piv:def');
      expect(bobEntry.addedBy).toBe('alice@piv:abc');
      expect(raw.updatedBy).toBe('alice@piv:abc');
    });
  });

  describe('removeMember', () => {
    it('re-keys: the removed member loses access, remaining members keep access under a new key', async () => {
      const service = makeService();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await service.addMember(vaultId, 'bob@piv:def', 'age1yubikey1bob', 'member');

      const { remainingAdmins } = await service.removeMember(vaultId, 'bob@piv:def');
      expect(remainingAdmins).toBe(1);

      const status = await service.getStatus(vaultId);
      expect(status.members).toEqual([expect.objectContaining({ recipientId: 'alice@piv:abc' })]);

      // A fresh service instance pointed at the same file, unlocking as alice, must still work —
      // proving alice's entry was genuinely re-wrapped for the new Vault Key, not left stale.
      const second = new TeamVaultService({ cryptoService: fakeCrypto(), baseDir: tempDir });
      await second.unlock(vaultId, 'alice@piv:abc', '/tmp/fake-admin-identity.txt');
      expect(second.isUnlocked(vaultId)).toBe(true);
    });

    it('requires the vault to be unlocked first', async () => {
      const service = makeService();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      service.lock(vaultId);
      await expect(service.removeMember(vaultId, 'alice@piv:abc')).rejects.toThrow('Unlock the Team Vault');
    });

    it('rejects removing a recipientId that is not a member', async () => {
      const service = makeService();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await expect(service.removeMember(vaultId, 'ghost@piv:xyz')).rejects.toThrow('is not a member');
    });

    it('rejects a plain member trying to remove someone — only an admin may mutate membership', async () => {
      const first = makeService();
      const vaultId = (await first.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await first.addMember(vaultId, 'bob@piv:def', 'age1yubikey1bob', 'member');

      const asBob = new TeamVaultService({ cryptoService: fakeCrypto(), baseDir: tempDir });
      await asBob.unlock(vaultId, 'bob@piv:def', '/tmp/fake-bob-identity.txt');

      await expect(asBob.removeMember(vaultId, 'alice@piv:abc')).rejects.toThrow('Only a Team Vault admin');
    });
  });

  describe('setRole', () => {
    it('changes a member role (requires the vault to be unlocked, to attribute the change)', async () => {
      const service = makeService();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await service.addMember(vaultId, 'bob@piv:def', 'age1yubikey1bob', 'member');

      await service.setRole(vaultId, 'bob@piv:def', 'admin');

      const status = await service.getStatus(vaultId);
      expect(status.members).toEqual(
        expect.arrayContaining([expect.objectContaining({ recipientId: 'bob@piv:def', role: 'admin' })])
      );
      expect(status.adminCount).toBe(2);
    });

    it('requires the vault to be unlocked first (so the change is attributed to a real identity)', async () => {
      const service = makeService();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await service.addMember(vaultId, 'bob@piv:def', 'age1yubikey1bob', 'member');
      service.lock(vaultId);

      await expect(service.setRole(vaultId, 'bob@piv:def', 'admin')).rejects.toThrow('Unlock the Team Vault');
    });

    it('rejects a plain member promoting themselves — only an admin may change roles', async () => {
      const first = makeService();
      const vaultId = (await first.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await first.addMember(vaultId, 'bob@piv:def', 'age1yubikey1bob', 'member');

      const asBob = new TeamVaultService({ cryptoService: fakeCrypto(), baseDir: tempDir });
      await asBob.unlock(vaultId, 'bob@piv:def', '/tmp/fake-bob-identity.txt');

      await expect(asBob.setRole(vaultId, 'bob@piv:def', 'admin')).rejects.toThrow('Only a Team Vault admin');
    });

    it('allows the recovery identity to act as an admin', async () => {
      const first = makeService();
      const vaultId = (await first.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await first.addMember(vaultId, 'bob@piv:def', 'age1yubikey1bob', 'member');

      const asRecovery = new TeamVaultService({ cryptoService: fakeCrypto(), baseDir: tempDir });
      await asRecovery.unlock(vaultId, 'recovery-key-1', '/tmp/recovery-identity.txt');

      await asRecovery.setRole(vaultId, 'bob@piv:def', 'admin');
      const status = await asRecovery.getStatus(vaultId);
      expect(status.members).toEqual(
        expect.arrayContaining([expect.objectContaining({ recipientId: 'bob@piv:def', role: 'admin' })])
      );
    });
  });

  describe('renameVault', () => {
    it('sets a descriptive name, surfaced via getStatus', async () => {
      const service = makeService();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;

      await service.renameVault(vaultId, 'Acme Infra Team');

      const status = await service.getStatus(vaultId);
      expect(status.vaultName).toBe('Acme Infra Team');
    });

    it('trims the name and clears it back to undefined when blank', async () => {
      const service = makeService();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice', 'Original Name')).vaultId;

      await service.renameVault(vaultId, '   ');

      const status = await service.getStatus(vaultId);
      expect(status.vaultName).toBeUndefined();
    });

    it('rejects a plain member renaming the vault — only an admin may', async () => {
      const first = makeService();
      const vaultId = (await first.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await first.addMember(vaultId, 'bob@piv:def', 'age1yubikey1bob', 'member');

      const asBob = new TeamVaultService({ cryptoService: fakeCrypto(), baseDir: tempDir });
      await asBob.unlock(vaultId, 'bob@piv:def', '/tmp/fake-bob-identity.txt');

      await expect(asBob.renameVault(vaultId, 'Hijacked Name')).rejects.toThrow('Only a Team Vault admin');
    });
  });

  describe('deleteVault', () => {
    it('removes the local vault file and locks the session, admin only', async () => {
      const service = makeService();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      expect(await fs.readFile(path.join(tempDir, "team-vaults", `${vaultId}.json`), 'utf-8').then(() => true, () => false)).toBe(true);

      await service.deleteVault(vaultId);

      expect(service.isUnlocked(vaultId)).toBe(false);
      await expect(fs.readFile(path.join(tempDir, "team-vaults", `${vaultId}.json`), 'utf-8')).rejects.toThrow();
      expect((await service.getStatus(vaultId)).exists).toBe(false);
    });

    it('rejects a plain member trying to delete the vault', async () => {
      const first = makeService();
      const vaultId = (await first.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await first.addMember(vaultId, 'bob@piv:def', 'age1yubikey1bob', 'member');

      const asBob = new TeamVaultService({ cryptoService: fakeCrypto(), baseDir: tempDir });
      await asBob.unlock(vaultId, 'bob@piv:def', '/tmp/fake-bob-identity.txt');

      await expect(asBob.deleteVault(vaultId)).rejects.toThrow('Only a Team Vault admin');
      await expect(fs.readFile(path.join(tempDir, "team-vaults", `${vaultId}.json`), 'utf-8')).resolves.toBeTruthy();
    });

    it('requires the vault to be unlocked first', async () => {
      const service = makeService();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      service.lock(vaultId);
      await expect(service.deleteVault(vaultId)).rejects.toThrow('Unlock the Team Vault');
    });

    it('rejects if no local vault file exists at all', async () => {
      const service = makeService();
      await expect(service.deleteVault('vlt_nonexistent')).rejects.toThrow();
    });
  });

  describe('unlock / lock', () => {
    it('unlocks using a recipient wrap and lock() clears it again', async () => {
      const first = makeService();
      const vaultId = (await first.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;

      const second = new TeamVaultService({ cryptoService: fakeCrypto(), baseDir: tempDir });
      expect(second.isUnlocked(vaultId)).toBe(false);
      await second.unlock(vaultId, 'alice@piv:abc', '/tmp/fake-admin-identity.txt');
      expect(second.isUnlocked(vaultId)).toBe(true);

      second.lock(vaultId);
      expect(second.isUnlocked(vaultId)).toBe(false);
    });

    it('rejects unlocking as a recipient that does not exist in the vault', async () => {
      const first = makeService();
      const vaultId = (await first.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;

      const second = new TeamVaultService({ cryptoService: fakeCrypto(), baseDir: tempDir });
      await expect(second.unlock(vaultId, 'ghost@piv:xyz', '/tmp/whatever.txt')).rejects.toThrow(
        'is not a recipient of this vault'
      );
    });

    it('can unlock using the recovery recipientId', async () => {
      const first = makeService();
      const vaultId = (await first.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;

      const second = new TeamVaultService({ cryptoService: fakeCrypto(), baseDir: tempDir });
      await second.unlock(vaultId, 'recovery-key-1', '/tmp/recovery-identity.txt');
      expect(second.isUnlocked(vaultId)).toBe(true);
    });

    it('refuses to unlock a local file whose accessHeaderMac is inconsistent with the unwrapped key (defense in depth)', async () => {
      // Not the primary control — pullFromRemote is what keeps a forged file out of local
      // storage (see TeamVaultRotationProofError's doc comment) — but a corrupted/inconsistent
      // local file must not be trusted blindly either, on the small chance something upstream
      // let it through.
      const first = makeService();
      const vaultId = (await first.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      const onDisk = JSON.parse(await fs.readFile(path.join(tempDir, "team-vaults", `${vaultId}.json`), 'utf-8'));
      onDisk.accessHeaderMac = 'corrupted-mac';
      await fs.writeFile(path.join(tempDir, "team-vaults", `${vaultId}.json`), JSON.stringify(onDisk));

      const second = new TeamVaultService({ cryptoService: fakeCrypto(), baseDir: tempDir });
      await expect(second.unlock(vaultId, 'alice@piv:abc', '/tmp/fake-admin-identity.txt')).rejects.toThrow(
        TeamVaultHeaderIntegrityError
      );
      expect(second.isUnlocked(vaultId)).toBe(false);
    });
  });

  describe('unlockWithRecoveryText', () => {
    it('writes the pasted text via the crypto service and unlocks as the recovery recipient', async () => {
      const first = makeService();
      const vaultId = (await first.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;

      const second = new TeamVaultService({ cryptoService: fakeCrypto(), baseDir: tempDir });
      await second.unlockWithRecoveryText(vaultId, '# public key: age1fakerecovery\nAGE-SECRET-KEY-1FAKERECOVERYTEXT\n');
      expect(second.isUnlocked(vaultId)).toBe(true);
    });

    it('rejects text that is not a recognizable recovery identity', async () => {
      const first = makeService();
      const vaultId = (await first.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;

      const second = new TeamVaultService({ cryptoService: fakeCrypto(), baseDir: tempDir });
      await expect(second.unlockWithRecoveryText(vaultId, 'not a key at all')).rejects.toThrow(
        'does not look like a Team Vault recovery key'
      );
      expect(second.isUnlocked(vaultId)).toBe(false);
    });
  });

  describe('enrollOwnPivRecipient', () => {
    it('delegates to the crypto service with the configured identity directory', async () => {
      const service = makeService();
      const result = await service.enrollOwnPivRecipient();
      expect(result.recipient).toBe('age1yubikey1fakeadmin');
    });
  });

  // unlock()/enrollOwnPivRecipient() must give TeamVaultCryptoService a way to reach the app's
  // existing PIN modal (IpcBridge.promptForPinDirect) and touch-banner (makePresenceNotifier) —
  // see docs/team-vault-plan.md's hardware verification notes. A narrow `pinPrompter` option
  // keeps the dependency to just those two methods rather than the whole IpcBridge.
  describe('PIN/touch prompt wiring (pinPrompter)', () => {
    function fakeCryptoThatPrompts(): TeamVaultCryptoService {
      const base = fakeCrypto();
      return {
        ...base,
        unwrapVaultKey: async (wrapped: string, _identityFilePath: string, callbacks: any) => {
          callbacks.onTouchRequested();
          const pin = await callbacks.requestPin('Enter PIN for YubiKey');
          expect(pin).toBe('999999');
          callbacks.onTouchCleared();
          return (base as any).unwrapVaultKey(wrapped);
        },
        enrollOwnPivRecipient: async (_identityOutDir: string, callbacks: any) => {
          await callbacks.requestPin('Enter PIN for YubiKey');
          return (base as any).enrollOwnPivRecipient();
        },
      } as unknown as TeamVaultCryptoService;
    }

    function fakePinPrompter() {
      const touchRequested = vi.fn();
      const touchCleared = vi.fn();
      return {
        promptForPinDirect: vi.fn(async (_prompt?: string, _kind?: string) => '999999'),
        makePresenceNotifier: vi.fn(() => ({ onPresenceRequested: touchRequested, onPresenceCleared: touchCleared })),
        touchRequested,
        touchCleared,
      };
    }

    it('unlock() routes PIN requests through pinPrompter.promptForPinDirect with kind "smartcard"', async () => {
      const first = new TeamVaultService({ cryptoService: fakeCrypto(), baseDir: tempDir });
      const vaultId = (await first.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;

      const prompter = fakePinPrompter();
      const second = new TeamVaultService({
        cryptoService: fakeCryptoThatPrompts(),
        baseDir: tempDir,
        pinPrompter: prompter,
      });
      await second.unlock(vaultId, 'alice@piv:abc', '/tmp/fake-admin-identity.txt');

      expect(prompter.promptForPinDirect).toHaveBeenCalledWith(
        'Enter PIN for YubiKey',
        'smartcard',
        `Team Vault: ${vaultId}`,
        undefined
      );
      expect(prompter.touchRequested).toHaveBeenCalledTimes(1);
      expect(prompter.touchCleared).toHaveBeenCalledTimes(1);
      expect(second.isUnlocked(vaultId)).toBe(true);
    });

    it('unlock() waits for the card before touching the crypto layer, and stops if that is dismissed', async () => {
      const first = new TeamVaultService({ cryptoService: fakeCrypto(), baseDir: tempDir });
      const vaultId = (await first.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;

      const unwrap = vi.fn();
      const prompter = {
        ...fakePinPrompter(),
        ensurePivPresent: vi.fn().mockRejectedValue(new Error('No smartcard inserted')),
      };
      const second = new TeamVaultService({
        cryptoService: { ...fakeCrypto(), unwrapVaultKey: unwrap } as unknown as TeamVaultCryptoService,
        baseDir: tempDir,
        pinPrompter: prompter,
      });

      await expect(second.unlock(vaultId, 'alice@piv:abc', '/tmp/id.txt')).rejects.toThrow('No smartcard inserted');
      expect(prompter.ensurePivPresent).toHaveBeenCalledWith(`Team Vault: ${vaultId}`);
      expect(unwrap).not.toHaveBeenCalled();
    });

    it('enrollOwnPivRecipient() routes PIN requests through pinPrompter too', async () => {
      const prompter = fakePinPrompter();
      const service = new TeamVaultService({
        cryptoService: fakeCryptoThatPrompts(),
        baseDir: tempDir,
        pinPrompter: prompter,
      });
      await service.enrollOwnPivRecipient();
      expect(prompter.promptForPinDirect).toHaveBeenCalledWith(
        'Enter PIN for YubiKey',
        'smartcard',
        'Team Vault: new identity',
        undefined
      );
    });

    it('fails clearly, instead of silently hanging, when no pinPrompter is configured but the crypto layer needs one', async () => {
      const first = new TeamVaultService({ cryptoService: fakeCrypto(), baseDir: tempDir });
      const vaultId = (await first.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;

      const second = new TeamVaultService({ cryptoService: fakeCryptoThatPrompts(), baseDir: tempDir });
      await expect(second.unlock(vaultId, 'alice@piv:abc', '/tmp/fake-admin-identity.txt')).rejects.toThrow(
        'not wired up'
      );
    });
  });

  describe('hasRemoteVault / pushToRemote / pullFromRemote (Fas 3)', () => {
    it('hasRemoteVault is false against an empty remote and true after a push', async () => {
      const service = makeService();
      const provider = fakeProvider();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;

      expect(await service.hasRemoteVault(vaultId, provider)).toBe(false);
      await service.pushToRemote(vaultId, provider);
      expect(await service.hasRemoteVault(vaultId, provider)).toBe(true);
    });

    it('pushes without a conflict check on the very first push (nothing exists remotely yet)', async () => {
      const service = makeService();
      const provider = fakeProvider();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;

      await expect(service.pushToRemote(vaultId, provider)).resolves.toBeUndefined();
    });

    it('refuses to push over a different, unrelated vault already at the target — even on the very first push', async () => {
      // This is the fail-open gap: an in-memory "never observed" cache must not be treated as
      // "nothing to check" the first time a freshly created local vault is pushed.
      const service = makeService();
      const provider = fakeProvider();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await provider.writeFile!(`team-vault/${vaultId}/vault.json`, Buffer.from(foreignVaultFileJson('vlt_someone_elses')));

      await expect(service.pushToRemote(vaultId, provider)).rejects.toThrow(TeamVaultForeignVaultError);
    });

    it('rejects a second push if the remote changed since this instance last observed it', async () => {
      const service = makeService();
      const provider = fakeProvider();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await service.pushToRemote(vaultId, provider);

      // Someone else pushed a change this instance never saw (same vault, so the identity check
      // passes — this test is specifically about the freshness check).
      await provider.writeFile!(`team-vault/${vaultId}/vault.json`, Buffer.from(foreignVaultFileJson(vaultId, 2)));

      await expect(service.pushToRemote(vaultId, provider)).rejects.toThrow(TeamVaultSyncConflictError);
    });

    it('allows pushing again after a pull refreshes the known remote state', async () => {
      // Needs a header MAC that actually verifies (unlike the other foreignVaultFileJson-based
      // tests above/below, which all stay at the local header's EXISTING length — so the MAC
      // check here is real, not skipped) — a fixed, known Vault Key lets this test compute one.
      const fixedKey = Buffer.alloc(32, 7);
      const crypto2 = fakeCrypto();
      crypto2.generateVaultKey = () => fixedKey;
      const service = new TeamVaultService({ cryptoService: crypto2, baseDir: tempDir });
      const provider = fakeProvider();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await service.pushToRemote(vaultId, provider);
      const localRaw = JSON.parse(await fs.readFile(path.join(tempDir, "team-vaults", `${vaultId}.json`), 'utf-8'));

      // A newer revision of the *same* vault (e.g. pushed from another machine) — not a vault
      // switch, which pullFromRemote now refuses whenever a local vault already exists. Keeps
      // the same single alice entry and the same recovery ageRecipient (no rotation, so no
      // shrink, and nothing for the tamper check to flag) and recomputes a real MAC under the
      // still-valid Vault Key, rather than relying on a placeholder that only slipped past
      // verification before this test's own fix (see TeamVaultRotationProofError's doc comment).
      const newRevision = localRaw.revision + 1;
      const unsigned1 = {
        ...localRaw,
        revision: newRevision,
      };
      const remoteFile = {
        ...unsigned1,
        accessHeaderMac: await crypto2.computeFileMac(fixedKey, unsigned1 as never),
      };
      await provider.writeFile!(`team-vault/${vaultId}/vault.json`, Buffer.from(JSON.stringify(remoteFile)));

      await service.pullFromRemote(vaultId, provider);
      // The MAC verified against our held key (no rotation happened), so the session stays
      // unlocked — proving the pull replaced local state is now via the bumped revision, not a
      // forced lock (see this test's comment above on why the old lock-based proof no longer
      // applies once the same-length MAC path is exercised for real instead of skipped).
      expect(service.isUnlocked(vaultId)).toBe(true);
      expect((await service.getStatus(vaultId)).exists).toBe(true);
      const afterPull = JSON.parse(await fs.readFile(path.join(tempDir, "team-vaults", `${vaultId}.json`), 'utf-8'));
      expect(afterPull.revision).toBe(newRevision);
      await expect(service.pushToRemote(vaultId, provider)).resolves.toBeUndefined();
    });

    it('rejects a pull that would roll the local vault back to an older revision', async () => {
      const service = makeService();
      const provider = fakeProvider();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await service.addMember(vaultId, 'bob@piv:def', 'age1yubikey1bob', 'member'); // local revision is now 2

      // An older revision of the *same* vault somehow ends up at the remote (e.g. a bucket-write-
      // access holder who isn't actually a recipient restoring a stale copy).
      await provider.writeFile!(`team-vault/${vaultId}/vault.json`, Buffer.from(foreignVaultFileJson(vaultId, 1)));

      await expect(service.pullFromRemote(vaultId, provider)).rejects.toThrow(TeamVaultRollbackError);
    });

    it('refuses to pull a substituted, unrelated vault over an existing local one — even with a higher revision', async () => {
      // The real attack the revision check alone can't stop: forging a *different* vault
      // (vaultId) with a revision number higher than ours sails straight past a bare "is this
      // newer" check. The identity check must run first and reject this outright.
      const service = makeService();
      const provider = fakeProvider();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;

      await provider.writeFile!(`team-vault/${vaultId}/vault.json`, Buffer.from(foreignVaultFileJson('vlt_attacker', 999)));

      await expect(service.pullFromRemote(vaultId, provider)).rejects.toThrow(TeamVaultForeignVaultError);
    });

    it('rejects a pull that keeps the same vaultId/revision bump but swaps an existing recipient\'s public key', async () => {
      // The two-step attack the vaultId/revision checks alone don't stop: same vault, a
      // plausible-looking higher revision, but an existing member's ageRecipient silently
      // replaced with the attacker's own. On its own this is inert (the attacker has no way to
      // forge a valid wrappedVaultKey) — but a later, routine removeMember would re-wrap a fresh
      // Vault Key for every remaining entry's ageRecipient, including the tampered one, handing
      // the attacker real access the moment that happens.
      const service = makeService();
      const provider = fakeProvider();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await service.addMember(vaultId, 'bob@piv:def', 'age1yubikey1bob', 'member');

      await provider.writeFile!(
        `team-vault/${vaultId}/vault.json`,
        Buffer.from(
          JSON.stringify({
            formatVersion: 1,
            vaultId,
            revision: 99,
            updatedAt: '2026-01-01T00:00:00Z',
            updatedBy: 'alice@piv:abc',
            accessHeader: [
              {
                recipientId: 'alice@piv:abc',
                role: 'admin',
                method: 'piv-rsa-oaep',
                ageRecipient: 'age1yubikey1alice',
                wrappedVaultKey: 'wrapped:age1yubikey1alice:aa',
                addedAt: 'x',
                addedBy: 'alice@piv:abc',
              },
              {
                // bob's recipientId kept, but his public key swapped for the attacker's.
                recipientId: 'bob@piv:def',
                role: 'member',
                method: 'piv-rsa-oaep',
                ageRecipient: 'age1yubikey1attacker',
                wrappedVaultKey: 'wrapped:age1yubikey1bob:bb', // stale on purpose — inert until reactivated
                addedAt: 'x',
                addedBy: 'alice@piv:abc',
              },
            ],
            recovery: { recipientId: 'recovery-key-1', ageRecipient: 'age1fakerecovery', wrappedVaultKey: 'w' },
            encryptedPayload: '',
            accessHeaderMac: 'placeholder-mac',
          })
        )
      );

      await expect(service.pullFromRemote(vaultId, provider)).rejects.toThrow(TeamVaultTamperedEntryError);
    });

    it('accepts a legitimate single-step addMember pulled from another machine (header MAC recomputed correctly)', async () => {
      // addMember never rotates the Vault Key — a real addMember pushed from elsewhere
      // recomputes accessHeaderMac correctly for the new content, using the same (still-valid)
      // Vault Key this instance already holds.
      const fixedKey = Buffer.alloc(32, 7);
      const crypto2 = fakeCrypto();
      crypto2.generateVaultKey = () => fixedKey;
      const service = new TeamVaultService({ cryptoService: crypto2, baseDir: tempDir });
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      const localRaw = JSON.parse(await fs.readFile(path.join(tempDir, "team-vaults", `${vaultId}.json`), 'utf-8'));

      const provider = fakeProvider();
      const newRevision = localRaw.revision + 1;
      const newAccessHeader = [
        ...localRaw.accessHeader,
        {
          recipientId: 'bob@piv:def',
          role: 'member',
          method: 'piv-rsa-oaep',
          ageRecipient: 'age1yubikey1bob',
          wrappedVaultKey: 'wrapped:age1yubikey1bob:cc',
          addedAt: 'x',
          addedBy: 'alice@piv:abc',
        },
      ];
      const unsigned2 = {
        ...localRaw,
        revision: newRevision,
        accessHeader: newAccessHeader,
      };
      const remoteFile = {
        ...unsigned2,
        accessHeaderMac: await crypto2.computeFileMac(fixedKey, unsigned2 as never),
      };
      await provider.writeFile!(`team-vault/${vaultId}/vault.json`, Buffer.from(JSON.stringify(remoteFile)));

      await expect(service.pullFromRemote(vaultId, provider)).resolves.toBeUndefined();
    });

    it('rejects a single-step pull that adds a new entry whose header MAC does not match the Vault Key already held', async () => {
      // The gap the ageRecipient-continuity check alone doesn't close: a wholly NEW entry (no
      // existing recipientId to collide with) is indistinguishable from a real addMember at the
      // field level. But computing a valid accessHeaderMac requires the real Vault Key — the
      // attacker doesn't have it, so whatever stale/guessed value they attach can never match
      // what we recompute with the key we already hold, regardless of which field they tampered
      // with or what revision number they chose.
      const fixedKey = Buffer.alloc(32, 7);
      const crypto2 = fakeCrypto();
      crypto2.generateVaultKey = () => fixedKey;
      const service = new TeamVaultService({ cryptoService: crypto2, baseDir: tempDir });
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      const localRaw = JSON.parse(await fs.readFile(path.join(tempDir, "team-vaults", `${vaultId}.json`), 'utf-8'));

      const provider = fakeProvider();
      const remoteFile = {
        ...localRaw, // keeps the OLD accessHeaderMac, now stale against the content below
        revision: localRaw.revision + 1,
        accessHeader: [
          ...localRaw.accessHeader,
          {
            recipientId: 'attacker@piv:fake',
            role: 'admin',
            method: 'piv-rsa-oaep',
            ageRecipient: 'age1yubikey1attacker',
            wrappedVaultKey: 'bogus',
            addedAt: 'x',
            addedBy: 'attacker@piv:fake',
          },
        ],
      };
      await provider.writeFile!(`team-vault/${vaultId}/vault.json`, Buffer.from(JSON.stringify(remoteFile)));

      await expect(service.pullFromRemote(vaultId, provider)).rejects.toThrow(TeamVaultHeaderIntegrityError);
    });

    it('rejects a pull where the revision was bumped specifically to dodge a narrower, revision-gated check', async () => {
      // This is the exact bypass a reviewer found in an earlier version of this check (which only
      // verified when `revision === localFile.revision + 1`): picking a different delta skipped
      // verification entirely. The header MAC has no such hole — it's checked regardless of the
      // revision gap, since validity never depends on which specific delta is claimed.
      const fixedKey = Buffer.alloc(32, 7);
      const crypto2 = fakeCrypto();
      crypto2.generateVaultKey = () => fixedKey;
      const service = new TeamVaultService({ cryptoService: crypto2, baseDir: tempDir });
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      const localRaw = JSON.parse(await fs.readFile(path.join(tempDir, "team-vaults", `${vaultId}.json`), 'utf-8'));

      const provider = fakeProvider();
      const remoteFile = {
        ...localRaw,
        revision: localRaw.revision + 7, // an arbitrary, non-"+1" delta
        accessHeader: [
          ...localRaw.accessHeader,
          {
            recipientId: 'attacker@piv:fake',
            role: 'admin',
            method: 'piv-rsa-oaep',
            ageRecipient: 'age1yubikey1attacker',
            wrappedVaultKey: 'bogus',
            addedAt: 'x',
            addedBy: 'attacker@piv:fake',
          },
        ],
      };
      await provider.writeFile!(`team-vault/${vaultId}/vault.json`, Buffer.from(JSON.stringify(remoteFile)));

      await expect(service.pullFromRemote(vaultId, provider)).rejects.toThrow(TeamVaultHeaderIntegrityError);
    });

    it('refuses to pull over an existing local vault while locked, since the header MAC cannot be verified without the Vault Key', async () => {
      const first = makeService();
      const vaultId = (await first.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      first.lock(vaultId);

      const provider = fakeProvider();
      await first.pushToRemote(vaultId, provider); // pushToRemote needs requireFile() only, not unlock

      await expect(first.pullFromRemote(vaultId, provider)).rejects.toThrow(TeamVaultLockedForPullError);
    });

    it('allows pulling a brand-new join (no local file yet) while locked, since nothing exists to verify against', async () => {
      const first = makeService();
      const vaultId = (await first.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      const provider = fakeProvider();
      await first.pushToRemote(vaultId, provider);

      // A separate baseDir simulates a different machine joining for the first time — sharing
      // `tempDir` with `first` would make this "second" instance see `first`'s own local file for
      // this exact vaultId, defeating the point of this test (nothing local to verify against yet).
      const secondBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sshs3-team-vault-test-second-'));
      const second = new TeamVaultService({ cryptoService: fakeCrypto(), baseDir: secondBaseDir });
      expect(second.isUnlocked(vaultId)).toBe(false);
      await expect(second.pullFromRemote(vaultId, provider)).resolves.toBeUndefined();
      await fs.rm(secondBaseDir, { recursive: true, force: true }).catch(() => {});
    });

    it('rejects a remote vault file larger than the size cap via the cheap stat() precheck, without ever downloading it', async () => {
      // The fast, common-case path: an honestly reported oversized object is rejected before any
      // download is even attempted — the deeper, download-time cap (tested below) exists for the
      // adversarial case where stat() can't be trusted, not to replace this cheaper check.
      const service = makeService();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      const provider = fakeProvider();
      const hugeStatOnly: IStorageProvider = {
        ...provider,
        stat: async () => ({ name: 'vault.json', path: `team-vault/${vaultId}/vault.json`, size: 51 * 1024 * 1024, isDirectory: false, mtime: 'x' }),
        readFile: async () => {
          throw new Error('must not download a file that already failed the cheap size check');
        },
      };
      await expect(service.pullFromRemote(vaultId, hugeStatOnly)).rejects.toThrow('too large');
    });

    it('rejects a remote vault file larger than the size cap, enforced against the actual downloaded bytes (not just stat())', async () => {
      // Deliberately a mismatched stat() vs. readFile() size — this is the TOCTOU shape the cap
      // must survive: whoever controls the remote object could serve a small stat() and a huge
      // body moments later, so the cap has to be checked against what was actually downloaded,
      // not trusted from a preceding stat() call.
      const service = makeService();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      const provider = fakeProvider();
      const hugeBody = Buffer.alloc(51 * 1024 * 1024, 'x');
      const mismatchedProvider: IStorageProvider = {
        ...provider,
        stat: async () => ({ name: 'vault.json', path: `team-vault/${vaultId}/vault.json`, size: 10, isDirectory: false, mtime: 'x' }),
        readFile: async () => hugeBody,
      };
      await expect(service.pullFromRemote(vaultId, mismatchedProvider)).rejects.toThrow('too large');
    });

    it('aborts an oversized download mid-stream on a provider without a readFile() convenience method', async () => {
      const service = makeService();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      const { Readable } = await import('node:stream');
      const streamingProvider: IStorageProvider = {
        ...fakeProvider(),
        readFile: undefined,
        stat: async () => ({ name: 'vault.json', path: `team-vault/${vaultId}/vault.json`, size: 10, isDirectory: false, mtime: 'x' }),
        createReadStream: async () => {
          const stream = new Readable({
            read() {
              this.push(Buffer.alloc(1024 * 1024, 'x'));
            },
          });
          return stream as any;
        },
      };
      await expect(service.pullFromRemote(vaultId, streamingProvider)).rejects.toThrow('too large');
    });

    it('rejects a remote file with a duplicate recipient id (shadowing a real member or the recovery slot)', async () => {
      const service = makeService();
      const provider = fakeProvider();
      const vaultId = 'vlt_dup';
      await provider.writeFile!(
        `team-vault/${vaultId}/vault.json`,
        Buffer.from(
          JSON.stringify({
            formatVersion: 1,
            vaultId,
            revision: 1,
            updatedAt: '2026-01-01T00:00:00Z',
            updatedBy: 'x',
            accessHeader: [
              {
                recipientId: 'recovery-key-1', // collides with the recovery entry's own id
                role: 'admin',
                ageRecipient: 'age1yubikey1attacker',
                wrappedVaultKey: 'w',
                addedAt: 'x',
                addedBy: 'x',
              },
            ],
            recovery: { recipientId: 'recovery-key-1', ageRecipient: 'age1y', wrappedVaultKey: 'w' },
            encryptedPayload: '',
          })
        )
      );

      await expect(service.pullFromRemote(vaultId, provider)).rejects.toThrow('not a recognizable vault');
    });

    it('pulling an existing remote vault lets a new member join without creating their own', async () => {
      const admin = makeService();
      const adminProvider = fakeProvider();
      const vaultId = (await admin.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await admin.pushToRemote(vaultId, adminProvider);

      // A separate baseDir simulates the new member's own machine, which has no local file for
      // this vaultId yet — sharing `tempDir` with `admin` would make them see admin's own file.
      const newMemberBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sshs3-team-vault-test-newmember-'));
      const newMember = new TeamVaultService({ cryptoService: fakeCrypto(), baseDir: newMemberBaseDir });

      expect(await newMember.hasRemoteVault(vaultId, adminProvider)).toBe(true);
      await newMember.pullFromRemote(vaultId, adminProvider);

      const status = await newMember.getStatus(vaultId);
      expect(status.exists).toBe(true);
      expect(status.vaultId).toBe((await admin.getStatus(vaultId)).vaultId);
      await fs.rm(newMemberBaseDir, { recursive: true, force: true }).catch(() => {});
    });

    it('rejects a pull whose remote file is not a recognizable vault', async () => {
      const service = makeService();
      const provider = fakeProvider();
      const vaultId = 'vlt_unrecognizable';
      await provider.writeFile!(`team-vault/${vaultId}/vault.json`, Buffer.from('{"not":"a vault"}'));

      await expect(service.pullFromRemote(vaultId, provider)).rejects.toThrow('not a recognizable vault');
    });

    it('rejects a remote file with a malformed access entry (e.g. missing ageRecipient)', async () => {
      const service = makeService();
      const provider = fakeProvider();
      const vaultId = 'vlt_malformed';
      await provider.writeFile!(
        `team-vault/${vaultId}/vault.json`,
        Buffer.from(
          JSON.stringify({
            formatVersion: 1,
            vaultId,
            revision: 1,
            updatedAt: '2026-01-01T00:00:00Z',
            updatedBy: 'x',
            accessHeader: [{ recipientId: 'a', role: 'admin', wrappedVaultKey: 'w', addedAt: 'x', addedBy: 'x' }],
            recovery: { recipientId: 'recovery-key-1', ageRecipient: 'age1y', wrappedVaultKey: 'w' },
            encryptedPayload: '',
          })
        )
      );

      await expect(service.pullFromRemote(vaultId, provider)).rejects.toThrow('not a recognizable vault');
    });

    it('rejects a remote file whose access entry has an invalid method', async () => {
      const service = makeService();
      const provider = fakeProvider();
      const vaultId = 'vlt_badmethod';
      await provider.writeFile!(
        `team-vault/${vaultId}/vault.json`,
        Buffer.from(
          JSON.stringify({
            formatVersion: 1,
            vaultId,
            revision: 1,
            updatedAt: '2026-01-01T00:00:00Z',
            updatedBy: 'x',
            accessHeader: [
              {
                recipientId: 'a',
                role: 'admin',
                method: 'something-else',
                ageRecipient: 'age1yubikey1alice',
                wrappedVaultKey: 'w',
                addedAt: 'x',
                addedBy: 'x',
              },
            ],
            recovery: { recipientId: 'recovery-key-1', ageRecipient: 'age1fakerecovery', wrappedVaultKey: 'w' },
            encryptedPayload: '',
          })
        )
      );

      await expect(service.pullFromRemote(vaultId, provider)).rejects.toThrow('not a recognizable vault');
    });

    it('rejects a remote file whose access entry has a malformed (non-age1...) ageRecipient', async () => {
      const service = makeService();
      const provider = fakeProvider();
      const vaultId = 'vlt_badrecipient';
      await provider.writeFile!(
        `team-vault/${vaultId}/vault.json`,
        Buffer.from(
          JSON.stringify({
            formatVersion: 1,
            vaultId,
            revision: 1,
            updatedAt: '2026-01-01T00:00:00Z',
            updatedBy: 'x',
            accessHeader: [
              {
                recipientId: 'a',
                role: 'admin',
                method: 'piv-rsa-oaep',
                ageRecipient: '-not-a-real-recipient',
                wrappedVaultKey: 'w',
                addedAt: 'x',
                addedBy: 'x',
              },
            ],
            recovery: { recipientId: 'recovery-key-1', ageRecipient: 'age1fakerecovery', wrappedVaultKey: 'w' },
            encryptedPayload: '',
          })
        )
      );

      await expect(service.pullFromRemote(vaultId, provider)).rejects.toThrow('not a recognizable vault');
    });

    it('does not force a re-unlock after pulling in a plain profile edit from elsewhere (no re-key happened)', async () => {
      // Regression guard for the background auto-poll (IpcBridge.runTeamVaultAutoPoll): a plain
      // profile/payload edit elsewhere never rotates the Vault Key, so the key this instance
      // already holds still correctly decrypts the pulled file — forcing a lock (and therefore a
      // PIN/touch re-unlock) on every such pull would make the poll useless in practice.
      const fixedKey = Buffer.alloc(32, 7);
      const crypto2 = fakeCrypto();
      crypto2.generateVaultKey = () => fixedKey;
      const service = new TeamVaultService({ cryptoService: crypto2, baseDir: tempDir });
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      const localRaw = JSON.parse(await fs.readFile(path.join(tempDir, "team-vaults", `${vaultId}.json`), 'utf-8'));

      const provider = fakeProvider();
      const newRevision = localRaw.revision + 1;
      const unsigned3 = {
        ...localRaw,
        revision: newRevision,
        encryptedPayload: 'new-payload-content',
      };
      const remoteFile = {
        ...unsigned3,
        accessHeaderMac: await crypto2.computeFileMac(fixedKey, unsigned3 as never),
      };
      await provider.writeFile!(`team-vault/${vaultId}/vault.json`, Buffer.from(JSON.stringify(remoteFile)));

      await service.pullFromRemote(vaultId, provider);
      expect(service.isUnlocked(vaultId)).toBe(true);
    });

    it('locks after a pull with a valid rotation proof (a real removeMember re-key happened)', async () => {
      // Contrast with the test above: this is the removeMember-elsewhere case the lock exists
      // for in the first place — `accessHeader.length` dropping means `accessHeaderMac` can no
      // longer be checked directly against our now-stale old key (it's keyed by the NEW one).
      // `prevKeyProof`, computed under the OLD key, is what proves this specific rotation is
      // legitimate rather than an S3-write-access-only forgery (TeamVaultRotationProofError).
      const oldKey = Buffer.alloc(32, 7);
      const newKey = Buffer.alloc(32, 9);
      const crypto2 = fakeCrypto();
      crypto2.generateVaultKey = () => oldKey;
      const service = new TeamVaultService({ cryptoService: crypto2, baseDir: tempDir });
      const provider = fakeProvider();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await service.addMember(vaultId, 'bob@piv:def', 'age1yubikey1bob', 'member');
      await service.pushToRemote(vaultId, provider);
      const localRaw = JSON.parse(await fs.readFile(path.join(tempDir, "team-vaults", `${vaultId}.json`), 'utf-8'));

      // Simulate removeMember(bob) happening elsewhere: header shrinks back to just alice,
      // re-wrapped for a fresh key, with a proof computed under the OLD key (`oldKey`) this
      // instance is still holding.
      const aliceEntry = localRaw.accessHeader.find((e: { recipientId: string }) => e.recipientId === 'alice@piv:abc');
      const newAccessHeader = [{ ...aliceEntry, wrappedVaultKey: `wrapped:age1yubikey1alice:${newKey.toString('hex')}` }];
      const newRecovery = { ...localRaw.recovery, wrappedVaultKey: `wrapped:${localRaw.recovery.ageRecipient}:${newKey.toString('hex')}` };
      const newRevision = localRaw.revision + 1;
      const unsigned4 = {
        ...localRaw,
        revision: newRevision,
        accessHeader: newAccessHeader,
        recovery: newRecovery,
      };
      const remoteFile = {
        ...unsigned4,
        accessHeaderMac: await crypto2.computeFileMac(newKey, unsigned4 as never),
        prevKeyProof: await crypto2.computeFileRotationProof(oldKey, unsigned4 as never),
      };
      await provider.writeFile!(`team-vault/${vaultId}/vault.json`, Buffer.from(JSON.stringify(remoteFile)));

      await service.pullFromRemote(vaultId, provider);
      expect(service.isUnlocked(vaultId)).toBe(false);
    });

    it('rejects a pull with a shrunk header and no valid rotation proof (bucket-write-access-only forgery)', async () => {
      // The vulnerability this whole mechanism closes: mere S3 write access — no member key, no
      // card — dropping one entry to skip straight past `accessHeaderMac` verification (which
      // only used to run when the entry count didn't decrease) and have an attacker-generated
      // Vault Key accepted as a legitimate rotation. `prevKeyProof` must be present and must
      // verify under the key we're still holding, or the pull must be rejected outright.
      const service = makeService();
      const provider = fakeProvider();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await service.addMember(vaultId, 'bob@piv:def', 'age1yubikey1bob', 'member');
      await service.pushToRemote(vaultId, provider);

      // Attacker has no member key — just drops bob and uploads a shrunk header with no
      // (or a garbage) prevKeyProof, and even a real-looking accessHeaderMac computed under
      // their own fresh, attacker-chosen key.
      await provider.writeFile!(
        `team-vault/${vaultId}/vault.json`,
        Buffer.from(foreignVaultFileJson(vaultId, 2, 'age1fakerecovery'))
      );

      await expect(service.pullFromRemote(vaultId, provider)).rejects.toThrow(TeamVaultRotationProofError);
    });
  });

  describe('lastSyncedRevision / TeamVaultUnpushedChangesError (concurrency guard)', () => {
    it('refuses to pull over local changes that were never pushed', async () => {
      const service = makeService();
      const provider = fakeProvider();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await service.pushToRemote(vaultId, provider); // lastSyncedRevision is now 1
      await service.addMember(vaultId, 'bob@piv:def', 'age1yubikey1bob', 'member'); // local revision is now 2, never pushed

      // Someone else also pushed a change meanwhile (same vault, higher revision — a legitimate
      // update, not an attack) — but pulling it now would silently discard bob's never-pushed add.
      await provider.writeFile!(
        `team-vault/${vaultId}/vault.json`,
        Buffer.from(foreignVaultFileJson(vaultId, 3, 'age1fakerecovery'))
      );

      await expect(service.pullFromRemote(vaultId, provider)).rejects.toThrow(TeamVaultUnpushedChangesError);
    });

    it('allows the pull anyway when force is set, discarding the unpushed local changes', async () => {
      // Not a rotation (header stays the same length, just a newer revision from elsewhere), so
      // a real MAC under a known fixed key is needed for the pull to verify — see the "allows
      // pushing again after a pull refreshes the known remote state" test above for why.
      const fixedKey = Buffer.alloc(32, 7);
      const crypto2 = fakeCrypto();
      crypto2.generateVaultKey = () => fixedKey;
      const service = new TeamVaultService({ cryptoService: crypto2, baseDir: tempDir });
      const provider = fakeProvider();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await service.pushToRemote(vaultId, provider);
      await service.addMember(vaultId, 'bob@piv:def', 'age1yubikey1bob', 'member');
      const localRaw = JSON.parse(await fs.readFile(path.join(tempDir, "team-vaults", `${vaultId}.json`), 'utf-8'));
      const unsigned5 = {
        ...localRaw,
        revision: 3,
      };
      const remoteFile = {
        ...unsigned5,
        accessHeaderMac: await crypto2.computeFileMac(fixedKey, unsigned5 as never),
      };
      await provider.writeFile!(`team-vault/${vaultId}/vault.json`, Buffer.from(JSON.stringify(remoteFile)));

      await expect(service.pullFromRemote(vaultId, provider, '', { force: true })).resolves.toBeUndefined();
    });

    it('does not block the pull when nothing was ever pushed from this instance (lastSyncedRevision still undefined)', async () => {
      const fixedKey = Buffer.alloc(32, 7);
      const crypto2 = fakeCrypto();
      crypto2.generateVaultKey = () => fixedKey;
      const service = new TeamVaultService({ cryptoService: crypto2, baseDir: tempDir });
      const provider = fakeProvider();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await service.addMember(vaultId, 'bob@piv:def', 'age1yubikey1bob', 'member');
      const localRaw = JSON.parse(await fs.readFile(path.join(tempDir, "team-vaults", `${vaultId}.json`), 'utf-8'));
      const unsigned6 = {
        ...localRaw,
        revision: 3,
      };
      const remoteFile = {
        ...unsigned6,
        accessHeaderMac: await crypto2.computeFileMac(fixedKey, unsigned6 as never),
      };
      await provider.writeFile!(`team-vault/${vaultId}/vault.json`, Buffer.from(JSON.stringify(remoteFile)));

      await expect(service.pullFromRemote(vaultId, provider)).resolves.toBeUndefined();
    });

    it('does not block the pull when the local revision still matches the last sync (no local-only edits)', async () => {
      const fixedKey = Buffer.alloc(32, 7);
      const crypto2 = fakeCrypto();
      crypto2.generateVaultKey = () => fixedKey;
      const service = new TeamVaultService({ cryptoService: crypto2, baseDir: tempDir });
      const provider = fakeProvider();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await service.pushToRemote(vaultId, provider);
      const localRaw = JSON.parse(await fs.readFile(path.join(tempDir, "team-vaults", `${vaultId}.json`), 'utf-8'));
      const unsigned7 = {
        ...localRaw,
        revision: 2,
      };
      const remoteFile = {
        ...unsigned7,
        accessHeaderMac: await crypto2.computeFileMac(fixedKey, unsigned7 as never),
      };
      await provider.writeFile!(`team-vault/${vaultId}/vault.json`, Buffer.from(JSON.stringify(remoteFile)));

      await expect(service.pullFromRemote(vaultId, provider)).resolves.toBeUndefined();
    });
  });

  describe('hasRemoteChangedSinceLastSync / hasUnpushedLocalChanges (background poll helpers)', () => {
    it('hasRemoteChangedSinceLastSync is false right after a push, true once something else pushes', async () => {
      const service = makeService();
      const provider = fakeProvider();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await service.pushToRemote(vaultId, provider);

      expect(await service.hasRemoteChangedSinceLastSync(vaultId, provider)).toBe(false);
      await provider.writeFile!(
        `team-vault/${vaultId}/vault.json`,
        Buffer.from(foreignVaultFileJson(vaultId, 2, 'age1fakerecovery'))
      );
      expect(await service.hasRemoteChangedSinceLastSync(vaultId, provider)).toBe(true);
    });

    it('hasRemoteChangedSinceLastSync is true the first time this instance ever observes a non-empty remote', async () => {
      const service = makeService();
      const provider = fakeProvider();
      const vaultId = 'vlt_other';
      await provider.writeFile!(`team-vault/${vaultId}/vault.json`, Buffer.from(foreignVaultFileJson(vaultId)));

      expect(await service.hasRemoteChangedSinceLastSync(vaultId, provider)).toBe(true);
    });

    it('hasUnpushedLocalChanges is false before any sync has happened', async () => {
      const service = makeService();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      expect(await service.hasUnpushedLocalChanges(vaultId)).toBe(false);
    });

    it('hasUnpushedLocalChanges is true after a local mutation following a push, false again after pushing it', async () => {
      const service = makeService();
      const provider = fakeProvider();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await service.pushToRemote(vaultId, provider);
      expect(await service.hasUnpushedLocalChanges(vaultId)).toBe(false);

      await service.addMember(vaultId, 'bob@piv:def', 'age1yubikey1bob', 'member');
      expect(await service.hasUnpushedLocalChanges(vaultId)).toBe(true);

      await service.pushToRemote(vaultId, provider);
      expect(await service.hasUnpushedLocalChanges(vaultId)).toBe(false);
    });
  });

  describe('getSyncPreview (§14: what Push/Pull would do, before either is pressed)', () => {
    it('reports up to date right after a push', async () => {
      const service = makeService();
      const provider = fakeProvider();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await service.pushToRemote(vaultId, provider);

      expect(await service.getSyncPreview(vaultId, provider)).toEqual({
        hasUnpushedLocalChanges: false,
        remoteChanged: false,
      });
    });

    it('reports unpushed local changes after a local mutation', async () => {
      const service = makeService();
      const provider = fakeProvider();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await service.pushToRemote(vaultId, provider);
      await service.addMember(vaultId, 'bob@piv:def', 'age1yubikey1bob', 'member');

      expect(await service.getSyncPreview(vaultId, provider)).toEqual({
        hasUnpushedLocalChanges: true,
        remoteChanged: false,
      });
    });

    it('reports a changed remote once something else pushes', async () => {
      const service = makeService();
      const provider = fakeProvider();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await service.pushToRemote(vaultId, provider);
      await provider.writeFile!(
        `team-vault/${vaultId}/vault.json`,
        Buffer.from(foreignVaultFileJson(vaultId, 2, 'age1fakerecovery'))
      );

      expect(await service.getSyncPreview(vaultId, provider)).toEqual({
        hasUnpushedLocalChanges: false,
        remoteChanged: true,
      });
    });

    it('still reports up to date for a fresh service instance backed by the same configStore (regression: restart must not forget the last known remote state)', async () => {
      // A bare in-memory stand-in for TeamVaultConfigStore's own persistence — enough to prove
      // TeamVaultService actually reads/writes through the injected configStore, without pulling
      // in the real encrypted-at-rest store.
      const persisted = new Map<string, { lastKnownRemoteEntry?: import('../../src/shared/types/storage').FileEntry | null }>();
      const configStore = {
        getConfig: async (vaultId: string) => persisted.get(vaultId) ?? {},
        setLastKnownRemoteEntry: async (vaultId: string, entry: import('../../src/shared/types/storage').FileEntry | null) => {
          persisted.set(vaultId, { ...persisted.get(vaultId), lastKnownRemoteEntry: entry });
        },
      };
      const provider = fakeProvider();

      const first = new TeamVaultService({ cryptoService: fakeCrypto(), baseDir: tempDir, configStore });
      const vaultId = (await first.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await first.pushToRemote(vaultId, provider);

      // Simulate an app restart: a brand-new TeamVaultService, same on-disk vault file and same
      // (persisted) configStore, but an empty in-memory `states` map — nothing in this instance
      // has ever called pushToRemote/pullFromRemote/hydratedState for this vaultId yet.
      const second = new TeamVaultService({ cryptoService: fakeCrypto(), baseDir: tempDir, configStore });
      expect(await second.getSyncPreview(vaultId, provider)).toEqual({
        hasUnpushedLocalChanges: false,
        remoteChanged: false,
      });
    });
  });

  it('resetRemoteState waits until the persisted sync state is cleared, so a status refresh cannot restore the old target\'s values', async () => {
    type Entry = import('../../src/shared/types/storage').FileEntry | null;
    const persisted = new Map<string, { lastKnownRemoteEntry?: Entry; lastSyncedRevision?: number }>();
    const configStore = {
      getConfig: async (vaultId: string) => persisted.get(vaultId) ?? {},
      setLastKnownRemoteEntry: async (vaultId: string, entry: Entry, lastSyncedRevision?: number) => {
        persisted.set(vaultId, { lastKnownRemoteEntry: entry, ...(lastSyncedRevision !== undefined ? { lastSyncedRevision } : {}) });
      },
      clearSyncState: async (vaultId: string) => {
        await new Promise((r) => setTimeout(r, 15)); // a slow write
        persisted.set(vaultId, {});
      },
    };
    const provider = fakeProvider();
    const service = new TeamVaultService({ cryptoService: fakeCrypto(), baseDir: tempDir, configStore });
    const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
    await service.pushToRemote(vaultId, provider);
    expect(persisted.get(vaultId)?.lastSyncedRevision).toBeDefined();

    await service.resetRemoteState(vaultId);

    // Already cleared on disk when the call returns; nothing is left for hydratedState to restore.
    expect(persisted.get(vaultId)).toEqual({});
    expect((await service.getSyncPreview(vaultId, provider)).hasUnpushedLocalChanges).toBe(false);
  });

  it('still refuses to pull over unpushed local changes after a restart (regression: lastSyncedRevision must survive it)', async () => {
    type Entry = import('../../src/shared/types/storage').FileEntry | null;
    const persisted = new Map<string, { lastKnownRemoteEntry?: Entry; lastSyncedRevision?: number }>();
    const configStore = {
      getConfig: async (vaultId: string) => persisted.get(vaultId) ?? {},
      setLastKnownRemoteEntry: async (vaultId: string, entry: Entry, lastSyncedRevision?: number) => {
        persisted.set(vaultId, {
          ...persisted.get(vaultId),
          lastKnownRemoteEntry: entry,
          ...(lastSyncedRevision !== undefined ? { lastSyncedRevision } : {}),
        });
      },
    };
    const provider = fakeProvider();

    const first = new TeamVaultService({ cryptoService: fakeCrypto(), baseDir: tempDir, configStore });
    const vaultId = (await first.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
    await first.pushToRemote(vaultId, provider);
    await first.addMember(vaultId, 'bob@piv:def', 'age1yubikey1bob', 'member'); // local revision 2, never pushed

    await provider.writeFile!(
      `team-vault/${vaultId}/vault.json`,
      Buffer.from(foreignVaultFileJson(vaultId, 3, 'age1fakerecovery'))
    );

    // App restart: new instance, empty in-memory state, same on-disk vault file and config store.
    const second = new TeamVaultService({ cryptoService: fakeCrypto(), baseDir: tempDir, configStore });
    await second.unlock(vaultId, 'alice@piv:abc', '/tmp/fake-admin-identity.txt');
    expect((await second.getSyncPreview(vaultId, provider)).hasUnpushedLocalChanges).toBe(true);
    await expect(second.pullFromRemote(vaultId, provider)).rejects.toThrow(TeamVaultUnpushedChangesError);
  });

  describe('shared SSH/S3 profiles (getPayload / save*Profile / delete*Profile)', () => {
    function sshProfile(id: string, name = 'web-1'): SSHConnectionConfig {
      return { id, name, host: 'example.com', username: 'root', authType: 'password', password: 'secret' }; // pragma: allowlist secret
    }
    function s3Profile(id: string, name = 'backups'): S3Config {
      return { id, name, region: 'us-east-1', accessKeyId: 'AKIA', secretAccessKey: 'shh' }; // pragma: allowlist secret
    }

    it('getPayload returns an empty payload for a freshly created vault (still the original {})', async () => {
      const service = makeService();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await expect(service.getPayload(vaultId)).resolves.toEqual({ ssh: [], s3: [], folders: [], folderIcons: {}, k8s: [] });
    });

    it('requires the vault unlocked', async () => {
      const first = makeService();
      const vaultId = (await first.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      const second = new TeamVaultService({ cryptoService: fakeCrypto(), baseDir: tempDir });
      await expect(second.getPayload(vaultId)).rejects.toThrow('Unlock the Team Vault');
      await expect(second.saveSSHProfile(vaultId, sshProfile('p1'))).rejects.toThrow('Unlock the Team Vault');
    });

    it('rejects an SSH profile with no id', async () => {
      const service = makeService();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await expect(service.saveSSHProfile(vaultId, {} as SSHConnectionConfig)).rejects.toThrow('Profile ID is required');
    });

    it('saves and reads back a shared SSH profile, stamped with updatedAt', async () => {
      const service = makeService();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await service.saveSSHProfile(vaultId, sshProfile('p1'));

      const payload = await service.getPayload(vaultId);
      expect(payload.ssh).toHaveLength(1);
      expect(payload.ssh[0]).toMatchObject({ id: 'p1', host: 'example.com', password: 'secret' }); // pragma: allowlist secret
      expect(payload.ssh[0].updatedAt).toBeTruthy();
      expect(payload.s3).toEqual([]);
    });

    it('upserts by id rather than duplicating on a second save', async () => {
      const service = makeService();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await service.saveSSHProfile(vaultId, sshProfile('p1', 'web-1'));
      await service.saveSSHProfile(vaultId, sshProfile('p1', 'web-1-renamed'));

      const payload = await service.getPayload(vaultId);
      expect(payload.ssh).toHaveLength(1);
      expect(payload.ssh[0].name).toBe('web-1-renamed');
    });

    it('deletes an SSH profile by id, leaving others untouched', async () => {
      const service = makeService();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await service.saveSSHProfile(vaultId, sshProfile('p1'));
      await service.saveSSHProfile(vaultId, sshProfile('p2', 'web-2'));
      await service.deleteSSHProfile(vaultId, 'p1');

      const payload = await service.getPayload(vaultId);
      expect(payload.ssh.map((p) => p.id)).toEqual(['p2']);
    });

    it('saves, upserts, and deletes a shared S3 profile independently of the SSH list', async () => {
      const service = makeService();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await service.saveSSHProfile(vaultId, sshProfile('p1'));
      await service.saveS3Profile(vaultId, s3Profile('s1'));

      let payload = await service.getPayload(vaultId);
      expect(payload.ssh).toHaveLength(1);
      expect(payload.s3).toHaveLength(1);
      expect(payload.s3[0]).toMatchObject({ id: 's1', secretAccessKey: 'shh' }); // pragma: allowlist secret

      await service.deleteS3Profile(vaultId, 's1');
      payload = await service.getPayload(vaultId);
      expect(payload.ssh).toHaveLength(1);
      expect(payload.s3).toEqual([]);
    });

    it('bumps revision and recomputes accessHeaderMac on every profile mutation, even though the header itself is unchanged', async () => {
      const service = makeService();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      const before = JSON.parse(await fs.readFile(path.join(tempDir, "team-vaults", `${vaultId}.json`), 'utf-8'));

      await service.saveSSHProfile(vaultId, sshProfile('p1'));

      const after = JSON.parse(await fs.readFile(path.join(tempDir, "team-vaults", `${vaultId}.json`), 'utf-8'));
      expect(after.revision).toBe(before.revision + 1);
      expect(after.accessHeader).toEqual(before.accessHeader);
      expect(after.accessHeaderMac).not.toBe(before.accessHeaderMac);
    });

    it('any unlocked member — not just an admin — can save a shared profile (without setting its password)', async () => {
      const admin = makeService();
      const vaultId = (await admin.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await admin.addMember(vaultId, 'bob@piv:def', 'age1yubikey1bob', 'member');
      const bobsIdentityFile = path.join(tempDir, 'bob-identity.txt');
      await fs.writeFile(bobsIdentityFile, 'unused-by-fake-crypto');

      const asBob = new TeamVaultService({ cryptoService: fakeCrypto(), baseDir: tempDir });
      await asBob.unlock(vaultId, 'bob@piv:def', bobsIdentityFile);

      await expect(asBob.saveSSHProfile(vaultId, { ...sshProfile('p1'), password: undefined })).resolves.toBeUndefined();
    });

    describe('only an admin may set or change a shared profile\'s password/secret', () => {
      async function makeAdminAndBob() {
        const admin = makeService();
        const vaultId = (await admin.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
        await admin.addMember(vaultId, 'bob@piv:def', 'age1yubikey1bob', 'member');
        const bobsIdentityFile = path.join(tempDir, 'bob-identity.txt');
        await fs.writeFile(bobsIdentityFile, 'unused-by-fake-crypto');
        const asBob = new TeamVaultService({ cryptoService: fakeCrypto(), baseDir: tempDir });
        await asBob.unlock(vaultId, 'bob@piv:def', bobsIdentityFile);
        return { admin, asBob, vaultId };
      }

      it('rejects a member creating a new SSH profile with a password', async () => {
        const { asBob, vaultId } = await makeAdminAndBob();
        await expect(asBob.saveSSHProfile(vaultId, sshProfile('p1'))).rejects.toThrow('Only a Team Vault admin');
      });

      it('rejects a member changing the password of an existing SSH profile', async () => {
        const { admin, asBob, vaultId } = await makeAdminAndBob();
        await admin.saveSSHProfile(vaultId, sshProfile('p1'));
        await expect(
          asBob.saveSSHProfile(vaultId, { ...sshProfile('p1'), password: 'different' }) // pragma: allowlist secret
        ).rejects.toThrow('Only a Team Vault admin');
      });

      it('lets a member edit a non-routing field (name) on a profile with a password, keeping the password and host intact', async () => {
        const { admin, asBob, vaultId } = await makeAdminAndBob();
        await admin.saveSSHProfile(vaultId, sshProfile('p1'));
        await expect(
          asBob.saveSSHProfile(vaultId, { ...sshProfile('p1'), name: 'renamed', password: undefined })
        ).resolves.toBeUndefined();

        const payload = await admin.getPayload(vaultId);
        expect(payload.ssh[0]).toMatchObject({ name: 'renamed', host: 'example.com', password: 'secret' }); // pragma: allowlist secret
      });

      it('lets an admin set and change a profile password as before', async () => {
        const { admin, vaultId } = await makeAdminAndBob();
        await admin.saveSSHProfile(vaultId, sshProfile('p1'));
        await admin.saveSSHProfile(vaultId, { ...sshProfile('p1'), password: 'new-secret' }); // pragma: allowlist secret
        const payload = await admin.getPayload(vaultId);
        expect(payload.ssh[0].password).toBe('new-secret'); // pragma: allowlist secret
      });

      it('rejects a member creating a new S3 profile with a secret key', async () => {
        const { asBob, vaultId } = await makeAdminAndBob();
        await expect(asBob.saveS3Profile(vaultId, s3Profile('s1'))).rejects.toThrow('Only a Team Vault admin');
      });

      it('lets a member edit a non-routing field (name) on an S3 profile, keeping the secret key and region intact', async () => {
        const { admin, asBob, vaultId } = await makeAdminAndBob();
        await admin.saveS3Profile(vaultId, s3Profile('s1'));
        await expect(
          asBob.saveS3Profile(vaultId, { ...s3Profile('s1'), name: 'renamed', secretAccessKey: '' })
        ).resolves.toBeUndefined();

        const payload = await admin.getPayload(vaultId);
        expect(payload.s3[0]).toMatchObject({ name: 'renamed', region: 'us-east-1', secretAccessKey: 'shh' }); // pragma: allowlist secret
      });

      it('lets a member edit the tags of a profile with a stored secret, and shows them to every member', async () => {
        const { admin, asBob, vaultId } = await makeAdminAndBob();
        await admin.saveSSHProfile(vaultId, sshProfile('p1'));
        await admin.saveS3Profile(vaultId, s3Profile('s1'));

        await expect(
          asBob.saveSSHProfile(vaultId, { ...sshProfile('p1'), tags: ['prod', 'web'], password: undefined })
        ).resolves.toBeUndefined();
        await expect(
          asBob.saveS3Profile(vaultId, { ...s3Profile('s1'), tags: ['assets'], secretAccessKey: '' })
        ).resolves.toBeUndefined();

        const adminPayload = await admin.getPayload(vaultId);
        expect(adminPayload.ssh[0].tags).toEqual(['prod', 'web']);
        expect(adminPayload.ssh[0].password).toBe('secret'); // pragma: allowlist secret
        expect(adminPayload.s3[0].tags).toEqual(['assets']);

        const memberPayload = await asBob.getPayloadForRenderer(vaultId);
        expect(memberPayload.ssh[0].tags).toEqual(['prod', 'web']);
        expect(memberPayload.s3[0].tags).toEqual(['assets']);
      });

      it('lets a member put a profile with a stored secret into a system, and keeps it when the profile is saved for another reason', async () => {
        const { admin, asBob, vaultId } = await makeAdminAndBob();
        await admin.saveSSHProfile(vaultId, sshProfile('p1'));

        await expect(
          asBob.saveSSHProfile(vaultId, { ...sshProfile('p1'), system: { name: 'shop', startDirectory: '/srv' }, password: undefined })
        ).resolves.toBeUndefined();
        await asBob.saveSSHProfile(vaultId, { ...sshProfile('p1'), system: { name: 'shop', startDirectory: '/srv' }, group: 'Prod', password: undefined });

        const adminPayload = await admin.getPayload(vaultId);
        expect(adminPayload.ssh[0].system).toEqual({ name: 'shop', startDirectory: '/srv' });
        expect(adminPayload.ssh[0].group).toBe('Prod');
        expect(adminPayload.ssh[0].password).toBe('secret'); // pragma: allowlist secret

        const memberPayload = await asBob.getPayloadForRenderer(vaultId);
        expect(memberPayload.ssh[0].system).toEqual({ name: 'shop', startDirectory: '/srv' });
        expect(memberPayload.ssh[0].password).toBeUndefined();
      });

      it('keeps the system of a profile when its folder is renamed', async () => {
        const { admin, vaultId } = await makeAdminAndBob();
        await admin.saveTeamFolder(vaultId, 'Prod');
        await admin.saveSSHProfile(vaultId, { ...sshProfile('p1'), group: 'Prod', system: { name: 'shop' } });
        await admin.renameTeamFolder(vaultId, 'Prod', 'Production');
        const payload = await admin.getPayload(vaultId);
        expect(payload.ssh[0]).toMatchObject({ group: 'Production', system: { name: 'shop' } });
      });

      it('getPayloadForRenderer strips secrets for a member but not for an admin', async () => {
        const { admin, asBob, vaultId } = await makeAdminAndBob();
        await admin.saveSSHProfile(vaultId, sshProfile('p1'));
        await admin.saveS3Profile(vaultId, s3Profile('s1'));

        const memberPayload = await asBob.getPayloadForRenderer(vaultId);
        expect(memberPayload.ssh[0].password).toBeUndefined();
        expect(memberPayload.ssh[0].hasPassword).toBe(true);
        expect(memberPayload.s3[0].secretAccessKey).toBe('');
        expect(memberPayload.s3[0].hasSecretAccessKey).toBe(true);

        const adminPayload = await admin.getPayloadForRenderer(vaultId);
        expect(adminPayload.ssh[0].password).toBe('secret'); // pragma: allowlist secret
        expect(adminPayload.s3[0].secretAccessKey).toBe('shh'); // pragma: allowlist secret
      });

      it('resolveProfileForConnect returns the real secret even for a member, for actually connecting', async () => {
        const { admin, asBob, vaultId } = await makeAdminAndBob();
        await admin.saveSSHProfile(vaultId, sshProfile('p1'));

        const resolved = await asBob.resolveProfileForConnect(vaultId, 'ssh', 'p1');
        expect((resolved as SSHConnectionConfig).password).toBe('secret'); // pragma: allowlist secret
      });

      it('rejects a member repointing the host of a profile that has a stored password (would exfiltrate it on next connect)', async () => {
        const { admin, asBob, vaultId } = await makeAdminAndBob();
        await admin.saveSSHProfile(vaultId, sshProfile('p1'));
        await expect(
          asBob.saveSSHProfile(vaultId, { ...sshProfile('p1'), host: 'attacker.example.com', password: undefined })
        ).rejects.toThrow('Only a Team Vault admin');
      });

      it('lets a member change the host of a profile that has no password', async () => {
        const { admin, asBob, vaultId } = await makeAdminAndBob();
        await admin.saveSSHProfile(vaultId, { ...sshProfile('p1'), password: undefined });
        await expect(
          asBob.saveSSHProfile(vaultId, { ...sshProfile('p1'), host: 'new-host.example.com', password: undefined })
        ).resolves.toBeUndefined();
      });

      it('rejects a member repointing the S3 endpoint of a profile that has a stored secret key', async () => {
        const { admin, asBob, vaultId } = await makeAdminAndBob();
        await admin.saveS3Profile(vaultId, s3Profile('s1'));
        await expect(
          asBob.saveS3Profile(vaultId, { ...s3Profile('s1'), endpoint: 'https://attacker.example.com', secretAccessKey: '' })
        ).rejects.toThrow('Only a Team Vault admin');
      });

      it('rejects a member disabling TLS validation (rejectUnauthorized) on a profile that has a stored secret key, even with the endpoint unchanged', async () => {
        const { admin, asBob, vaultId } = await makeAdminAndBob();
        await admin.saveS3Profile(vaultId, s3Profile('s1'));
        await expect(
          asBob.saveS3Profile(vaultId, { ...s3Profile('s1'), rejectUnauthorized: false, secretAccessKey: '' })
        ).rejects.toThrow('Only a Team Vault admin');
      });

      it('rejects a member substituting a custom CA on a profile that has a stored secret key', async () => {
        const { admin, asBob, vaultId } = await makeAdminAndBob();
        await admin.saveS3Profile(vaultId, s3Profile('s1'));
        await expect(
          asBob.saveS3Profile(vaultId, { ...s3Profile('s1'), customCaPath: '/tmp/attacker-ca.pem', secretAccessKey: '' })
        ).rejects.toThrow('Only a Team Vault admin');
      });

      it('redacts and guards an S3 profile\'s proxy.password the same as its secretAccessKey', async () => {
        const { admin, asBob, vaultId } = await makeAdminAndBob();
        await admin.saveS3Profile(vaultId, {
          ...s3Profile('s1'),
          proxy: { enabled: true, type: 'http', host: 'proxy.example.com', port: 8080, password: 'proxy-secret' }, // pragma: allowlist secret
        });

        const memberPayload = await asBob.getPayloadForRenderer(vaultId);
        expect(memberPayload.s3[0].proxy?.password).toBeUndefined();
        expect(memberPayload.s3[0].proxy?.hasPassword).toBe(true);

        await expect(
          asBob.saveS3Profile(vaultId, {
            ...s3Profile('s1'),
            secretAccessKey: '',
            proxy: { enabled: true, type: 'http', host: 'proxy.example.com', port: 8080, password: 'different' }, // pragma: allowlist secret
          })
        ).rejects.toThrow('Only a Team Vault admin');
      });
    });

    it('shares privateKeyPath/pkcs11LibPath/agentPath/agentIdentityFiles as plain data — none of them execute anything on their own', async () => {
      // Corrected from an earlier, too-aggressive fix: these fields are a personal environment
      // setting (which PKCS#11 driver, which agent socket), not a security boundary — they either
      // resolve on a given member's machine or silently don't, same risk as a wrong hostname. Only
      // `pin` is special-cased (see withoutPin — never written to disk anywhere in this app).
      const service = makeService();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await service.saveSSHProfile(vaultId, {
        ...sshProfile('p1'),
        authType: 'smartcard',
        privateKeyPath: '/home/alice/.ssh/id_ed25519',
        pkcs11LibPath: '/usr/lib/opensc-pkcs11.so',
        agentPath: '/tmp/agent.sock',
        agentIdentityFiles: ['/tmp/a.pub'],
        pin: '123456', // pragma: allowlist secret
      });

      const payload = await service.getPayload(vaultId);
      expect(payload.ssh[0]).toMatchObject({
        id: 'p1',
        host: 'example.com',
        password: 'secret', // pragma: allowlist secret
        privateKeyPath: '/home/alice/.ssh/id_ed25519',
        pkcs11LibPath: '/usr/lib/opensc-pkcs11.so',
        agentPath: '/tmp/agent.sock',
        agentIdentityFiles: ['/tmp/a.pub'],
      });
      expect(payload.ssh[0]).not.toHaveProperty('pin');
    });

    it('shares an S3 customCaPath as plain data too', async () => {
      const service = makeService();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await service.saveS3Profile(vaultId, { ...s3Profile('s1'), customCaPath: '/etc/ssl/custom-ca.pem' });

      const payload = await service.getPayload(vaultId);
      expect(payload.s3[0]).toMatchObject({ customCaPath: '/etc/ssl/custom-ca.pem' });
    });

    it('strips a pin on read too, covering an entry stored before this rule existed', async () => {
      // Defense in depth: simulates a pulled vault file whose encryptedPayload already contains
      // a `pin` field (e.g. written by an older app version) — getPayload must still never
      // surface it, matching `ProfileStore`'s identical rule for local profiles.
      const fixedKey = Buffer.alloc(32, 7);
      const crypto2 = fakeCrypto();
      crypto2.generateVaultKey = () => fixedKey;
      const service = new TeamVaultService({ cryptoService: crypto2, baseDir: tempDir });
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      const localRaw = JSON.parse(await fs.readFile(path.join(tempDir, "team-vaults", `${vaultId}.json`), 'utf-8'));

      const plantedPayload = JSON.stringify({
        ssh: [{ ...sshProfile('p1'), pin: '123456' }], // pragma: allowlist secret
        s3: [],
      });
      const tampered = {
        ...localRaw,
        encryptedPayload: crypto2.encryptPayload(fixedKey, localRaw.vaultId, localRaw.formatVersion, plantedPayload),
      };
      await fs.writeFile(path.join(tempDir, "team-vaults", `${vaultId}.json`), JSON.stringify(tampered));

      const payload = await service.getPayload(vaultId);
      expect(payload.ssh[0]).not.toHaveProperty('pin');
    });
  });

  describe('shared K8s cluster templates (saveK8sProfile / deleteK8sProfile)', () => {
    const k8s = (id: string, name = 'Prod') => ({
      id,
      name,
      server: 'https://api.example.com:6443',
      namespace: 'team-a',
    });

    it('saves, upserts and deletes a template, stamping updatedAt', async () => {
      const service = makeService();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;

      await service.saveK8sProfile(vaultId, k8s('k1'));
      await service.saveK8sProfile(vaultId, k8s('k2', 'Staging'));
      await service.saveK8sProfile(vaultId, k8s('k1', 'Prod renamed'));

      let payload = await service.getPayload(vaultId);
      expect(payload.k8s?.map((p) => [p.id, p.name])).toEqual([
        ['k1', 'Prod renamed'],
        ['k2', 'Staging'],
      ]);
      expect(payload.k8s?.[0].updatedAt).toBeTruthy();

      await service.deleteK8sProfile(vaultId, 'k1');
      payload = await service.getPayload(vaultId);
      expect(payload.k8s?.map((p) => p.id)).toEqual(['k2']);
    });

    it('never stores a kubeconfig context, a tombstone or unknown fields such as a token', async () => {
      const service = makeService();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await service.saveK8sProfile(vaultId, {
        ...k8s('k1'),
        contextName: 'team-a/api/alice',
        lastUsedAt: '2026-01-01T00:00:00.000Z',
        deletedAt: '2026-01-01T00:00:00.000Z',
        token: 'sha256~secret',
      } as never);

      const stored = (await service.getPayload(vaultId)).k8s?.[0];
      expect(stored).toEqual({ ...k8s('k1'), updatedAt: expect.any(String) });
    });

    it('rejects an invalid template and requires the vault unlocked', async () => {
      const first = makeService();
      const vaultId = (await first.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await expect(first.saveK8sProfile(vaultId, { ...k8s('k1'), id: '../x' })).rejects.toThrow('profile id');
      const second = new TeamVaultService({ cryptoService: fakeCrypto(), baseDir: tempDir });
      await expect(second.saveK8sProfile(vaultId, k8s('k1'))).rejects.toThrow('Unlock the Team Vault');
    });

    it('is not touched by SSH/S3 saves, nor lost when a folder is renamed or deleted', async () => {
      const service = makeService();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await service.saveK8sProfile(vaultId, k8s('k1'));
      await service.saveTeamFolder(vaultId, 'Acme');
      await service.saveSSHProfile(vaultId, {
        id: 's1',
        name: 'web',
        host: 'example.com',
        username: 'root',
        authType: 'password',
        group: 'Acme',
      });

      await service.renameTeamFolder(vaultId, 'Acme', 'Acme Co');
      expect((await service.getPayload(vaultId)).k8s?.map((p) => p.id)).toEqual(['k1']);

      await service.deleteTeamFolder(vaultId, 'Acme Co', true);
      const payload = await service.getPayload(vaultId);
      expect(payload.ssh).toEqual([]);
      expect(payload.k8s?.map((p) => p.id)).toEqual(['k1']);

      await service.setTeamFolderIcon(vaultId, 'Other', 'folder');
      expect((await service.getPayload(vaultId)).k8s?.map((p) => p.id)).toEqual(['k1']);
    });

    it('still returns a plain member the templates (they hold no secret to redact)', async () => {
      const service = makeService();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await service.saveK8sProfile(vaultId, k8s('k1'));
      const forRenderer = await service.getPayloadForRenderer(vaultId);
      expect(forRenderer.k8s?.map((p) => p.id)).toEqual(['k1']);
    });
  });

  describe('team folders (saveTeamFolder / renameTeamFolder / deleteTeamFolder)', () => {
    function sshProfile(id: string, group?: string): SSHConnectionConfig {
      return { id, name: id, host: 'example.com', username: 'root', authType: 'password', password: 'secret', group }; // pragma: allowlist secret
    }

    it('creates an empty folder, visible via getPayload', async () => {
      const service = makeService();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;

      await service.saveTeamFolder(vaultId, 'Acme Infra/Cluster A');

      const payload = await service.getPayload(vaultId);
      expect(payload.folders).toEqual(['Acme Infra/Cluster A']);
    });

    it('trims segments and ignores a duplicate save', async () => {
      const service = makeService();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;

      await service.saveTeamFolder(vaultId, '  Acme Infra / Cluster A  ');
      await service.saveTeamFolder(vaultId, 'Acme Infra/Cluster A');

      const payload = await service.getPayload(vaultId);
      expect(payload.folders).toEqual(['Acme Infra/Cluster A']);
    });

    it('rejects an empty folder path', async () => {
      const service = makeService();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await expect(service.saveTeamFolder(vaultId, '   ')).rejects.toThrow('Folder name is required');
    });

    it('renameTeamFolder moves the folder entry and every descendant folder/profile along with it', async () => {
      const service = makeService();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await service.saveTeamFolder(vaultId, 'Acme Infra');
      await service.saveTeamFolder(vaultId, 'Acme Infra/Cluster A');
      await service.saveSSHProfile(vaultId, sshProfile('p1', 'Acme Infra'));
      await service.saveSSHProfile(vaultId, sshProfile('p2', 'Acme Infra/Cluster A'));
      await service.saveSSHProfile(vaultId, sshProfile('p3', 'Unrelated'));

      await service.renameTeamFolder(vaultId, 'Acme Infra', 'Acme Co');

      const payload = await service.getPayload(vaultId);
      expect(payload.folders).toEqual(expect.arrayContaining(['Acme Co', 'Acme Co/Cluster A']));
      expect(payload.folders).not.toEqual(expect.arrayContaining(['Acme Infra', 'Acme Infra/Cluster A']));
      expect(payload.ssh.find((p) => p.id === 'p1')?.group).toBe('Acme Co');
      expect(payload.ssh.find((p) => p.id === 'p2')?.group).toBe('Acme Co/Cluster A');
      expect(payload.ssh.find((p) => p.id === 'p3')?.group).toBe('Unrelated');
    });

    it('deleteTeamFolder without deleteProfiles ungroups affected profiles (self and descendants)', async () => {
      const service = makeService();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await service.saveTeamFolder(vaultId, 'Acme Infra');
      await service.saveTeamFolder(vaultId, 'Acme Infra/Cluster A');
      await service.saveSSHProfile(vaultId, sshProfile('p1', 'Acme Infra'));
      await service.saveSSHProfile(vaultId, sshProfile('p2', 'Acme Infra/Cluster A'));
      await service.saveSSHProfile(vaultId, sshProfile('p3', 'Unrelated'));

      await service.deleteTeamFolder(vaultId, 'Acme Infra');

      const payload = await service.getPayload(vaultId);
      expect(payload.folders).toEqual([]);
      expect(payload.ssh.find((p) => p.id === 'p1')?.group).toBeUndefined();
      expect(payload.ssh.find((p) => p.id === 'p2')?.group).toBeUndefined();
      expect(payload.ssh.find((p) => p.id === 'p3')?.group).toBe('Unrelated');
    });

    it('deleteTeamFolder with deleteProfiles removes affected profiles outright', async () => {
      const service = makeService();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await service.saveTeamFolder(vaultId, 'Acme Infra');
      await service.saveSSHProfile(vaultId, sshProfile('p1', 'Acme Infra'));
      await service.saveSSHProfile(vaultId, sshProfile('p3', 'Unrelated'));

      await service.deleteTeamFolder(vaultId, 'Acme Infra', true);

      const payload = await service.getPayload(vaultId);
      expect(payload.ssh.map((p) => p.id)).toEqual(['p3']);
    });

    describe('setTeamFolderIcon', () => {
      it('sets and clears a folder icon', async () => {
        const service = makeService();
        const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
        await service.saveTeamFolder(vaultId, 'Acme Infra');

        await service.setTeamFolderIcon(vaultId, 'Acme Infra', 'server');
        expect((await service.getPayload(vaultId)).folderIcons).toEqual({ 'Acme Infra': 'server' });

        await service.setTeamFolderIcon(vaultId, 'Acme Infra', undefined);
        expect((await service.getPayload(vaultId)).folderIcons).toEqual({});
      });

      it('rejects an empty folder path', async () => {
        const service = makeService();
        const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
        await expect(service.setTeamFolderIcon(vaultId, '   ', 'server')).rejects.toThrow('Folder name is required');
      });
    });

    it('renameTeamFolder remaps the icon of the renamed folder and every descendant', async () => {
      const service = makeService();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await service.saveTeamFolder(vaultId, 'Acme Infra');
      await service.saveTeamFolder(vaultId, 'Acme Infra/Cluster A');
      await service.setTeamFolderIcon(vaultId, 'Acme Infra', 'server');
      await service.setTeamFolderIcon(vaultId, 'Acme Infra/Cluster A', 'database');

      await service.renameTeamFolder(vaultId, 'Acme Infra', 'Acme Co');

      const payload = await service.getPayload(vaultId);
      expect(payload.folderIcons).toEqual({ 'Acme Co': 'server', 'Acme Co/Cluster A': 'database' });
    });

    it('deleteTeamFolder removes the icon of the deleted folder and every descendant', async () => {
      const service = makeService();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      await service.saveTeamFolder(vaultId, 'Acme Infra');
      await service.saveTeamFolder(vaultId, 'Acme Infra/Cluster A');
      await service.saveTeamFolder(vaultId, 'Unrelated');
      await service.setTeamFolderIcon(vaultId, 'Acme Infra', 'server');
      await service.setTeamFolderIcon(vaultId, 'Acme Infra/Cluster A', 'database');
      await service.setTeamFolderIcon(vaultId, 'Unrelated', 'cloud');

      await service.deleteTeamFolder(vaultId, 'Acme Infra');

      const payload = await service.getPayload(vaultId);
      expect(payload.folderIcons).toEqual({ Unrelated: 'cloud' });
    });
  });

  // The critical property the Map-per-vaultId design (docs/team-vault-plan.md's multi-team plan
  // §3) exists to uphold: an operation against one team's vault must never unlock, read, or
  // leak state for another's, even when both share the same TeamVaultService instance AND the
  // same on-disk baseDir.
  describe('multi-vault isolation', () => {
    it('unlocking vault A never unlocks vault B, even from the same service instance', async () => {
      const service = makeService();
      const { vaultId: vaultIdA } = await service.createVault('alice@piv:abc', 'age1yubikey1alice');
      service.lock(vaultIdA);
      const { vaultId: vaultIdB } = await service.createVault('carol@piv:ghi', 'age1yubikey1carol');

      expect(service.isUnlocked(vaultIdA)).toBe(false);
      expect(service.isUnlocked(vaultIdB)).toBe(true);

      await service.unlock(vaultIdA, 'alice@piv:abc', '/tmp/fake-admin-identity.txt');

      expect(service.isUnlocked(vaultIdA)).toBe(true);
      expect(service.isUnlocked(vaultIdB)).toBe(true);

      service.lock(vaultIdA);
      expect(service.isUnlocked(vaultIdA)).toBe(false);
      expect(service.isUnlocked(vaultIdB)).toBe(true);
    });

    it('pushing vault A never touches vault B\'s sync state (lastKnownRemoteEntry/lastSyncedRevision)', async () => {
      const service = makeService();
      const providerA = fakeProvider();
      const providerB = fakeProvider();
      const { vaultId: vaultIdA } = await service.createVault('alice@piv:abc', 'age1yubikey1alice');
      const { vaultId: vaultIdB } = await service.createVault('carol@piv:ghi', 'age1yubikey1carol');

      // Something external shows up on B's remote BEFORE B ever syncs — B has never observed
      // anything yet, so this correctly reads as "changed" (there's something to pull).
      await providerB.writeFile!(`team-vault/${vaultIdB}/vault.json`, Buffer.from(foreignVaultFileJson(vaultIdB)));
      expect(await service.hasRemoteChangedSinceLastSync(vaultIdB, providerB)).toBe(true);

      await service.pushToRemote(vaultIdA, providerA);

      // A's own push must not make B look synced — B's remote content (and this instance's
      // tracking of it) is completely untouched by anything that happened to A.
      expect(await service.hasRemoteChangedSinceLastSync(vaultIdB, providerB)).toBe(true);
      // A, having just pushed, correctly sees itself as unchanged against its own target.
      expect(await service.hasRemoteChangedSinceLastSync(vaultIdA, providerA)).toBe(false);

      // Pushing B now must not be rejected by anything A observed (proves no shared/leaked
      // cross-vault conflict-check state) — B's own existing remote content legitimately shares
      // its vaultId, so this is accepted as B's own continuation, not a foreign-vault conflict.
      await expect(service.pushToRemote(vaultIdB, providerB)).resolves.toBeUndefined();
    });

    it('two vaults sharing the same S3 target+remoteBasePath never collide on the same remote object', async () => {
      const service = makeService();
      const sharedProvider = fakeProvider();
      const sharedRemoteBasePath = 'shared-bucket/prefix';
      const { vaultId: vaultIdA } = await service.createVault('alice@piv:abc', 'age1yubikey1alice');
      const { vaultId: vaultIdB } = await service.createVault('carol@piv:ghi', 'age1yubikey1carol');

      await service.pushToRemote(vaultIdA, sharedProvider, sharedRemoteBasePath);
      // If this collided with A's object, pushToRemote would throw TeamVaultForeignVaultError
      // (identity check: "something else is already at this path") instead of resolving.
      await expect(service.pushToRemote(vaultIdB, sharedProvider, sharedRemoteBasePath)).resolves.toBeUndefined();

      const remotePathFor = (vid: string) => `${sharedRemoteBasePath}/team-vault/${vid}/vault.json`;
      expect(await sharedProvider.readFile!(remotePathFor(vaultIdA))).toBeTruthy();
      expect(await sharedProvider.readFile!(remotePathFor(vaultIdB))).toBeTruthy();

      const fileA = JSON.parse((await sharedProvider.readFile!(remotePathFor(vaultIdA))).toString('utf-8'));
      const fileB = JSON.parse((await sharedProvider.readFile!(remotePathFor(vaultIdB))).toString('utf-8'));
      expect(fileA.vaultId).toBe(vaultIdA);
      expect(fileB.vaultId).toBe(vaultIdB);

      // A fresh pull of each, through the same shared target, must come back as itself — not the
      // other vault's content.
      await expect(service.pullFromRemote(vaultIdA, sharedProvider, sharedRemoteBasePath)).resolves.toBeUndefined();
      await expect(service.pullFromRemote(vaultIdB, sharedProvider, sharedRemoteBasePath)).resolves.toBeUndefined();
    });

    it('listVaultIds/listStatuses enumerate every locally known vault independently', async () => {
      const service = makeService();
      const { vaultId: vaultIdA } = await service.createVault('alice@piv:abc', 'age1yubikey1alice');
      const { vaultId: vaultIdB } = await service.createVault('carol@piv:ghi', 'age1yubikey1carol');

      expect((await service.listVaultIds()).sort()).toEqual([vaultIdA, vaultIdB].sort());

      const statuses = await service.listStatuses();
      expect(statuses).toHaveLength(2);
      const byId = new Map(statuses.map((s) => [s.vaultId, s]));
      expect(byId.get(vaultIdA)?.members).toEqual([
        expect.objectContaining({ recipientId: 'alice@piv:abc' }),
      ]);
      expect(byId.get(vaultIdB)?.members).toEqual([
        expect.objectContaining({ recipientId: 'carol@piv:ghi' }),
      ]);
    });
  });

  describe('buildInvite / decodeInvite (age-encrypted invite blob, §A of the join-flow plan)', () => {
    const fakeTarget = { id: 'target-1', name: 'Team Bucket', type: 's3' as const };

    function makeServiceWithConfig(remoteBasePath = 'team-bucket/prefix'): TeamVaultService {
      return new TeamVaultService({
        cryptoService: fakeCrypto(),
        baseDir: tempDir,
        configStore: {
          getConfig: async () => ({ target: fakeTarget, remoteBasePath }),
          setLastKnownRemoteEntry: async () => {},
        },
      });
    }

    it("builds an invite using the member's own ageRecipient from the access header, and decodes it back to the configured target", async () => {
      const service = makeServiceWithConfig();
      const { vaultId } = await service.createVault('alice@piv:abc', 'age1yubikey1alice');
      await service.addMember(vaultId, 'bob@piv:def', 'age1yubikey1bob', 'member');

      const invite = await service.buildInvite(vaultId, 'bob@piv:def');
      expect(invite).toMatch(/^sshs3 Team Vault invite for bob@piv:def\n/);
      expect(invite).toContain('age1yubikey1bob');

      const decoded = await service.decodeInvite(invite, '/tmp/bob-identity.txt');
      expect(decoded).toEqual({ vaultId, target: fakeTarget, remoteBasePath: 'team-bucket/prefix' });
    });

    it('is admin-gated: a plain member cannot build an invite for another member', async () => {
      const service = makeServiceWithConfig();
      const { vaultId } = await service.createVault('alice@piv:abc', 'age1yubikey1alice');
      await service.addMember(vaultId, 'bob@piv:def', 'age1yubikey1bob', 'member');
      await service.addMember(vaultId, 'carol@piv:ghi', 'age1yubikey1carol', 'member');

      // Unlock as bob (a plain member), not alice (the admin).
      service.lock(vaultId);
      await service.unlock(vaultId, 'bob@piv:def', '/tmp/bob-identity.txt');

      await expect(service.buildInvite(vaultId, 'carol@piv:ghi')).rejects.toThrow('Only a Team Vault admin can do this');
    });

    it('rejects building an invite for a recipientId that is not a member', async () => {
      const service = makeServiceWithConfig();
      const { vaultId } = await service.createVault('alice@piv:abc', 'age1yubikey1alice');

      await expect(service.buildInvite(vaultId, 'nobody@piv:xyz')).rejects.toThrow('is not a member of this vault');
    });

    it('fails clearly when no configStore is wired up', async () => {
      const service = new TeamVaultService({ cryptoService: fakeCrypto(), baseDir: tempDir });
      const { vaultId } = await service.createVault('alice@piv:abc', 'age1yubikey1alice');
      await expect(service.buildInvite(vaultId, 'alice@piv:abc')).rejects.toThrow('missing configStore');
    });

    it('decodeInvite surfaces a clear, user-facing error for a truncated/garbled paste', async () => {
      const service = makeServiceWithConfig();
      await expect(
        service.decodeInvite('sshs3 Team Vault invite for bob@piv:def\nnot-a-real-blob', '/tmp/bob-identity.txt')
      ).rejects.toThrow('Could not read this invite');
    });

    it('decodeInvite rejects a decrypted blob that is not a recognizable invite shape', async () => {
      const service = makeServiceWithConfig();
      const bogusEncrypted = `enc:age1yubikey1bob:${Buffer.from(JSON.stringify({ not: 'an invite' }), 'utf8').toString('base64')}`;
      await expect(service.decodeInvite(bogusEncrypted, '/tmp/bob-identity.txt')).rejects.toThrow(
        'not a recognizable Team Vault invite'
      );
    });

    it('decodeInvite tolerates a paste of just the ciphertext, without the human-readable header line', async () => {
      const service = makeServiceWithConfig();
      const { vaultId } = await service.createVault('alice@piv:abc', 'age1yubikey1alice');
      await service.addMember(vaultId, 'bob@piv:def', 'age1yubikey1bob', 'member');
      const invite = await service.buildInvite(vaultId, 'bob@piv:def');
      const ciphertextOnly = invite.split('\n').slice(1).join('\n');

      const decoded = await service.decodeInvite(ciphertextOnly, '/tmp/bob-identity.txt');
      expect(decoded.vaultId).toBe(vaultId);
    });

    it('decodeInvite tolerates a chat/email client quoting every line with "> ", including the header line itself', async () => {
      const service = makeServiceWithConfig();
      const { vaultId } = await service.createVault('alice@piv:abc', 'age1yubikey1alice');
      await service.addMember(vaultId, 'bob@piv:def', 'age1yubikey1bob', 'member');
      const invite = await service.buildInvite(vaultId, 'bob@piv:def');
      // Simulates a reply-quoted paste — every line, including the header line that a prior
      // version of this code required to be the exact, unquoted first line, prefixed with the
      // chat/email client's own "> " quote marker.
      const quoted = invite
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');

      const decoded = await service.decodeInvite(quoted, '/tmp/bob-identity.txt');
      expect(decoded.vaultId).toBe(vaultId);
    });

    it('decodeInvite extracts the ciphertext from a real age ASCII-armor envelope anywhere in the pasted text, ignoring surrounding commentary and quote markers', async () => {
      const service = makeServiceWithConfig();
      const { vaultId } = await service.createVault('alice@piv:abc', 'age1yubikey1alice');
      await service.addMember(vaultId, 'bob@piv:def', 'age1yubikey1bob', 'member');
      const rawInvite = await service.buildInvite(vaultId, 'bob@piv:def');
      const rawCiphertext = rawInvite.split('\n').slice(1).join('\n');
      // A real age -a envelope around the fake ciphertext, buried in unrelated chat text on both
      // sides and quoted — the BEGIN/END markers are what extractInviteCiphertext should find and
      // extract, regardless of anything else surrounding them.
      const messy = [
        '> Hey, here is the invite you asked for:',
        '> -----BEGIN AGE ENCRYPTED FILE-----',
        `> ${rawCiphertext}`,
        '> -----END AGE ENCRYPTED FILE-----',
        '> let me know once you are in!',
      ].join('\n');

      const decoded = await service.decodeInvite(messy, '/tmp/bob-identity.txt');
      expect(decoded.vaultId).toBe(vaultId);
    });
  });

  describe('setDescription (free-text vault description, §D of the join-flow plan)', () => {
    it('is admin-gated, trims, and clears back to undefined on an empty string', async () => {
      const service = makeService();
      const { vaultId } = await service.createVault('alice@piv:abc', 'age1yubikey1alice');

      await service.setDescription(vaultId, '  Acme Infra — prod SSH/S3 access  ');
      expect((await service.getStatus(vaultId)).vaultDescription).toBe('Acme Infra — prod SSH/S3 access');

      await service.setDescription(vaultId, '   ');
      expect((await service.getStatus(vaultId)).vaultDescription).toBeUndefined();
    });

    it('rejects a non-admin setting the description', async () => {
      const service = makeService();
      const { vaultId } = await service.createVault('alice@piv:abc', 'age1yubikey1alice');
      await service.addMember(vaultId, 'bob@piv:def', 'age1yubikey1bob', 'member');

      service.lock(vaultId);
      await service.unlock(vaultId, 'bob@piv:def', '/tmp/bob-identity.txt');

      await expect(service.setDescription(vaultId, 'Hijacked description')).rejects.toThrow(
        'Only a Team Vault admin can do this'
      );
    });

    it('keeps the access header verifiable after a description change — unlock still succeeds', async () => {
      const service = makeService();
      const { vaultId } = await service.createVault('alice@piv:abc', 'age1yubikey1alice');
      await service.setDescription(vaultId, 'Acme Infra team');

      service.lock(vaultId);
      await expect(service.unlock(vaultId, 'alice@piv:abc', '/tmp/fake-admin-identity.txt')).resolves.toBeUndefined();
    });
  });

  // M1 (code review 2026-11-03): the header MAC did not cover the payload, so an older payload (same Vault Key) could be
  // put under a current header with a valid MAC and revision. Format v2 covers the payload ciphertext.
  describe('format v2: the payload is bound to the header (M1)', () => {
    const fixedKey = Buffer.alloc(32, 7);
    const profile = (id: string) =>
      ({ id, name: id, host: `${id}.example.com`, port: 22, username: 'u', authType: 'agent' }) as unknown as SSHConnectionConfig;
    const readLocal = async (vaultId: string) =>
      JSON.parse(await fs.readFile(path.join(tempDir, 'team-vaults', `${vaultId}.json`), 'utf-8'));

    async function newVault() {
      const crypto2 = fakeCrypto();
      crypto2.generateVaultKey = () => fixedKey;
      const service = new TeamVaultService({ cryptoService: crypto2, baseDir: tempDir });
      const provider = fakeProvider();
      const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
      return { service, crypto2, provider, vaultId };
    }

    it('writes new vaults in format 2', async () => {
      const { vaultId } = await newVault();
      expect((await readLocal(vaultId)).formatVersion).toBe(2);
    });

    it('refuses a pull whose payload was taken from an older revision, and writes nothing locally', async () => {
      const { service, provider, vaultId } = await newVault();
      await service.saveSSHProfile(vaultId, profile('p1'));
      const olderPayload = (await readLocal(vaultId)).encryptedPayload;
      await service.saveSSHProfile(vaultId, profile('p2'));
      const current = await readLocal(vaultId);
      await service.pushToRemote(vaultId, provider);

      // The attacker keeps the current header (valid MAC, current revision) and swaps in the older payload.
      const spliced = { ...current, encryptedPayload: olderPayload };
      await provider.writeFile!(`team-vault/${vaultId}/vault.json`, Buffer.from(JSON.stringify(spliced)));

      await expect(service.pullFromRemote(vaultId, provider, '', { force: true })).rejects.toThrow(/integrity check/);
      expect((await readLocal(vaultId)).encryptedPayload).toBe(current.encryptedPayload);
    });

    it('refuses to unlock a local file whose payload was swapped', async () => {
      const { service, vaultId } = await newVault();
      await service.saveSSHProfile(vaultId, profile('p1'));
      const olderPayload = (await readLocal(vaultId)).encryptedPayload;
      await service.saveSSHProfile(vaultId, profile('p2'));
      const current = await readLocal(vaultId);
      await fs.writeFile(path.join(tempDir, 'team-vaults', `${vaultId}.json`), JSON.stringify({ ...current, encryptedPayload: olderPayload }));
      service.lock(vaultId);

      await expect(service.unlock(vaultId, 'alice@piv:abc', '/tmp/fake-admin-identity.txt')).rejects.toThrow(/integrity check/);
    });

    it('refuses a pull with a forged "last written by" (updatedBy is authenticated in v2)', async () => {
      const { service, provider, vaultId } = await newVault();
      await service.saveSSHProfile(vaultId, profile('p1'));
      await service.pushToRemote(vaultId, provider);
      const current = await readLocal(vaultId);
      await provider.writeFile!(`team-vault/${vaultId}/vault.json`, Buffer.from(JSON.stringify({ ...current, updatedBy: 'mallory' })));

      await expect(service.pullFromRemote(vaultId, provider, '', { force: true })).rejects.toThrow(/integrity check/);
    });

    it('still accepts an honest pull of a newer revision', async () => {
      const { service, provider, vaultId } = await newVault();
      await service.pushToRemote(vaultId, provider);
      await service.saveSSHProfile(vaultId, profile('p1'));
      await service.pushToRemote(vaultId, provider);
      await expect(service.pullFromRemote(vaultId, provider)).resolves.toBeUndefined();
    });

    it('rejects a file in a format newer than this version understands, with a message that says to update', async () => {
      const { service, provider, vaultId } = await newVault();
      await service.pushToRemote(vaultId, provider);
      const current = await readLocal(vaultId);
      await provider.writeFile!(`team-vault/${vaultId}/vault.json`, Buffer.from(JSON.stringify({ ...current, formatVersion: 3 })));

      await expect(service.pullFromRemote(vaultId, provider)).rejects.toThrow(/Update sshs3 to open it/);
      await expect(service.pushToRemote(vaultId, provider)).rejects.toThrow(/Update sshs3 to open it/);
    });

    it('refuses to unlock a local file in an unknown newer format', async () => {
      const { service, vaultId } = await newVault();
      const current = await readLocal(vaultId);
      await fs.writeFile(path.join(tempDir, 'team-vaults', `${vaultId}.json`), JSON.stringify({ ...current, formatVersion: 3 }));
      service.lock(vaultId);
      await expect(service.unlock(vaultId, 'alice@piv:abc', '/tmp/fake-admin-identity.txt')).rejects.toThrow(/Update sshs3 to open it/);
    });

    it('keeps reading a v1 vault: unlock verifies it with the v1 MAC', async () => {
      const { service, crypto2, vaultId } = await newVault();
      const v2 = await readLocal(vaultId);
      const v1Unsigned = { ...v2, formatVersion: 1, encryptedPayload: crypto2.encryptPayload(fixedKey, vaultId, 1, '{}') };
      const v1 = { ...v1Unsigned, accessHeaderMac: crypto2.computeFileMac(fixedKey, v1Unsigned as never) };
      await fs.writeFile(path.join(tempDir, 'team-vaults', `${vaultId}.json`), JSON.stringify(v1));
      service.lock(vaultId);

      await expect(service.unlock(vaultId, 'alice@piv:abc', '/tmp/fake-admin-identity.txt')).resolves.toBeUndefined();
      expect(await service.getPayload(vaultId)).toMatchObject({ ssh: [], s3: [] });
    });

    it('a v1 header MAC does not verify on a file that claims to be v2', async () => {
      const { service, crypto2, vaultId } = await newVault();
      const v2 = await readLocal(vaultId);
      const v1Mac = crypto2.computeFileMac(fixedKey, { ...v2, formatVersion: 1 } as never);
      await fs.writeFile(path.join(tempDir, 'team-vaults', `${vaultId}.json`), JSON.stringify({ ...v2, accessHeaderMac: v1Mac }));
      service.lock(vaultId);
      await expect(service.unlock(vaultId, 'alice@piv:abc', '/tmp/fake-admin-identity.txt')).rejects.toThrow(/integrity check/);
    });

    // Without a revision bump on upgrade, a replayed pre-upgrade v1 file can carry the SAME revision as the v2 file. Its v1 MAC
    // does not cover the payload, so it must be refused once the remote has been seen in v2 (and would otherwise be re-signed as
    // a valid v2 by the next automatic upgrade).
    describe('downgrade barrier (highest remote format seen)', () => {
      async function v1Variant(crypto2: TeamVaultCryptoService, vaultId: string, revision?: number) {
        const v2 = await readLocal(vaultId);
        const unsigned = {
          ...v2,
          formatVersion: 1,
          revision: revision ?? v2.revision,
          encryptedPayload: crypto2.encryptPayload(fixedKey, vaultId, 1, '{}'),
        };
        return { ...unsigned, accessHeaderMac: crypto2.computeFileMac(fixedKey, unsigned as never) };
      }

      it('refuses a v1 file once the remote has been seen as v2, even with the same revision and even with force', async () => {
        const { service, crypto2, provider, vaultId } = await newVault();
        await service.pushToRemote(vaultId, provider); // the remote is now v2
        await provider.writeFile!(`team-vault/${vaultId}/vault.json`, Buffer.from(JSON.stringify(await v1Variant(crypto2, vaultId))));

        await expect(service.pullFromRemote(vaultId, provider)).rejects.toThrow(/older format/);
        await expect(service.pullFromRemote(vaultId, provider, '', { force: true })).rejects.toThrow(/older format/);
      });

      it('accepts a v1 file while the remote has never been seen as v2 (a mixed team that has not upgraded yet)', async () => {
        const { service, crypto2, provider, vaultId } = await newVault();
        const v1 = await v1Variant(crypto2, vaultId);
        await fs.writeFile(path.join(tempDir, 'team-vaults', `${vaultId}.json`), JSON.stringify(v1)); // local v1 too
        await provider.writeFile!(`team-vault/${vaultId}/vault.json`, Buffer.from(JSON.stringify(v1)));

        await expect(service.pullFromRemote(vaultId, provider)).resolves.toBeUndefined();
      });

      // Security audit of M1: a first join has no key, so the pulled file's header is not authenticated yet.
      it('does not let a file nobody has authenticated set the mark, but does once a verified pull has seen it', async () => {
        const { service, crypto2, provider, vaultId } = await newVault();
        await service.pushToRemote(vaultId, provider);
        const marks: Array<number | undefined> = [];
        const configStore = {
          getConfig: async () => ({}),
          setLastKnownRemoteEntry: async (_id: string, _entry: unknown, _rev?: number, fmt?: number) => {
            marks.push(fmt);
          },
          clearSyncState: async () => {},
        };
        const otherDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sshs3-team-vault-test-join-'));
        try {
          const joiner = new TeamVaultService({ cryptoService: crypto2, baseDir: otherDir, configStore });
          await joiner.pullFromRemote(vaultId, provider); // first join: locked, nothing to verify against
          expect(marks).toEqual([undefined]);

          await joiner.unlock(vaultId, 'alice@piv:abc', '/tmp/fake-admin-identity.txt');
          await joiner.pullFromRemote(vaultId, provider); // now the header is checked against the held key
          expect(marks.at(-1)).toBe(2);
        } finally {
          await fs.rm(otherDir, { recursive: true, force: true }).catch(() => {});
        }
      });

      it('remembers the mark across a restart (persisted in the config store) and forgets it when the target changes', async () => {
        const persisted: Record<string, any> = {};
        const configStore = {
          getConfig: async (id: string) => ({ ...(persisted[id] ?? {}) }),
          setLastKnownRemoteEntry: async (id: string, entry: unknown, rev?: number, fmt?: number) => {
            persisted[id] = {
              ...(persisted[id] ?? {}),
              lastKnownRemoteEntry: entry,
              ...(rev !== undefined ? { lastSyncedRevision: rev } : {}),
              ...(fmt !== undefined ? { remoteFormatVersion: Math.max(fmt, persisted[id]?.remoteFormatVersion ?? 0) } : {}),
            };
          },
          clearSyncState: async (id: string) => {
            const { remoteFormatVersion: _f, lastSyncedRevision: _r, lastKnownRemoteEntry: _e, ...rest } = persisted[id] ?? {};
            persisted[id] = rest;
          },
        };
        const crypto2 = fakeCrypto();
        crypto2.generateVaultKey = () => fixedKey;
        const first = new TeamVaultService({ cryptoService: crypto2, baseDir: tempDir, configStore });
        const provider = fakeProvider();
        const vaultId = (await first.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
        await first.pushToRemote(vaultId, provider);
        expect(persisted[vaultId].remoteFormatVersion).toBe(2);
        await provider.writeFile!(`team-vault/${vaultId}/vault.json`, Buffer.from(JSON.stringify(await v1Variant(crypto2, vaultId))));

        const restarted = new TeamVaultService({ cryptoService: crypto2, baseDir: tempDir, configStore });
        await restarted.unlock(vaultId, 'alice@piv:abc', '/tmp/fake-admin-identity.txt');
        await expect(restarted.pullFromRemote(vaultId, provider)).rejects.toThrow(/older format/);

        await restarted.resetRemoteState(vaultId); // a new target is a new trust boundary
        expect(persisted[vaultId].remoteFormatVersion).toBeUndefined();
        // The mark is gone, but this machine's own v2 copy is still a floor: a replay at the same revision stays refused ...
        await expect(restarted.pullFromRemote(vaultId, provider, '', { force: true })).rejects.toThrow(/older format/);
        // ... while an older-format file with a strictly higher revision (only a Vault Key holder can make one) is accepted.
        await provider.writeFile!(`team-vault/${vaultId}/vault.json`, Buffer.from(JSON.stringify(await v1Variant(crypto2, vaultId, 2))));
        await expect(restarted.pullFromRemote(vaultId, provider, '', { force: true })).resolves.toBeUndefined();
      });

      it('refuses to push a local v1 file over a remote that is already v2', async () => {
        const { service, crypto2, provider, vaultId } = await newVault();
        await service.pushToRemote(vaultId, provider);
        const v1 = await v1Variant(crypto2, vaultId);
        await fs.writeFile(path.join(tempDir, 'team-vaults', `${vaultId}.json`), JSON.stringify(v1));

        await expect(service.pushToRemote(vaultId, provider)).rejects.toThrow(/newer format.*pull first/i);
      });
    });

    // Automatic upgrade of a v1 vault, done by whoever unlocks it first with this version (any role): no admin action.
    describe('automatic upgrade of a v1 vault', () => {
      const identity = '/tmp/fake-admin-identity.txt';

      /** Rewrites the vault on disk as a genuine v1 file (v1 MAC, payload encrypted with the v1 AAD) and locks it. */
      async function downgradeToV1(service: TeamVaultService, crypto2: TeamVaultCryptoService, vaultId: string, payload = '{}') {
        const v2 = await readLocal(vaultId);
        const unsigned = { ...v2, formatVersion: 1, encryptedPayload: crypto2.encryptPayload(fixedKey, vaultId, 1, payload) };
        const v1 = { ...unsigned, accessHeaderMac: crypto2.computeFileMac(fixedKey, unsigned as never) };
        await fs.writeFile(path.join(tempDir, 'team-vaults', `${vaultId}.json`), JSON.stringify(v1));
        service.lock(vaultId);
        return v1;
      }

      it('upgrades on unlock to v2 without touching revision, updatedAt or updatedBy, and tells the app to push it', async () => {
        const upgraded: string[] = [];
        const crypto2 = fakeCrypto();
        crypto2.generateVaultKey = () => fixedKey;
        const service = new TeamVaultService({ cryptoService: crypto2, baseDir: tempDir, onFormatUpgraded: (id) => upgraded.push(id) });
        const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
        await service.saveSSHProfile(vaultId, profile('p1'));
        const v1 = await downgradeToV1(service, crypto2, vaultId, JSON.stringify({ ssh: [profile('p1')], s3: [] }));

        await service.unlock(vaultId, 'alice@piv:abc', identity);

        const after = await readLocal(vaultId);
        expect(after.formatVersion).toBe(2);
        expect([after.revision, after.updatedAt, after.updatedBy]).toEqual([v1.revision, v1.updatedAt, v1.updatedBy]);
        expect((await service.getPayload(vaultId)).ssh.map((p) => p.id)).toEqual(['p1']);
        expect(upgraded).toEqual([vaultId]);

        // The upgraded file verifies on its own, and a second unlock does not upgrade again.
        service.lock(vaultId);
        await service.unlock(vaultId, 'alice@piv:abc', identity);
        expect(upgraded).toEqual([vaultId]);
      });

      it('lets a plain member upgrade (it needs the Vault Key only), and so does the recovery identity', async () => {
        const crypto2 = fakeCrypto();
        crypto2.generateVaultKey = () => fixedKey;
        const service = new TeamVaultService({ cryptoService: crypto2, baseDir: tempDir });
        const vaultId = (await service.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
        await service.addMember(vaultId, 'bob@piv:def', 'age1yubikey1bob', 'member');

        await downgradeToV1(service, crypto2, vaultId);
        await service.unlock(vaultId, 'bob@piv:def', identity);
        expect((await readLocal(vaultId)).formatVersion).toBe(2);

        await downgradeToV1(service, crypto2, vaultId);
        await service.unlockWithRecoveryText(vaultId, 'AGE-SECRET-KEY-1TEST');
        expect((await readLocal(vaultId)).formatVersion).toBe(2);
      });

      it('does not upgrade a locked vault', async () => {
        const { service, crypto2, vaultId } = await newVault();
        await downgradeToV1(service, crypto2, vaultId);
        expect(await service.upgradeFormatIfNeeded(vaultId)).toBe(false);
        expect((await readLocal(vaultId)).formatVersion).toBe(1);
      });

      it('never lets a failing upgrade (e.g. a payload that cannot be decrypted) block the unlock; the vault stays v1', async () => {
        const { service, crypto2, vaultId } = await newVault();
        const v1Unsigned = { ...(await readLocal(vaultId)), formatVersion: 1, encryptedPayload: 'not-decryptable' };
        const v1 = { ...v1Unsigned, accessHeaderMac: crypto2.computeFileMac(fixedKey, v1Unsigned as never) };
        await fs.writeFile(path.join(tempDir, 'team-vaults', `${vaultId}.json`), JSON.stringify(v1));
        service.lock(vaultId);

        await expect(service.unlock(vaultId, 'alice@piv:abc', identity)).resolves.toBeUndefined();
        expect((await readLocal(vaultId)).formatVersion).toBe(1);
      });

      it('re-verifies the v1 MAC before re-signing, so a file changed on disk after unlock is not blessed', async () => {
        const { service, crypto2, vaultId } = await newVault();
        const v1 = await downgradeToV1(service, crypto2, vaultId);
        await service.unlock(vaultId, 'alice@piv:abc', identity).then(async () => {
          // unlock already upgraded it; put the v1 file back and tamper with it while the session is open
          await fs.writeFile(
            path.join(tempDir, 'team-vaults', `${vaultId}.json`),
            JSON.stringify({ ...v1, accessHeader: [{ ...v1.accessHeader[0], role: 'member' }] })
          );
        });

        expect(await service.upgradeFormatIfNeeded(vaultId)).toBe(false);
        expect((await readLocal(vaultId)).formatVersion).toBe(1);
      });

      it('converges without anyone clicking: the second member to upgrade pulls the first one\'s file as a plain pull', async () => {
        // Machine A and machine B hold the same v1 vault and have both synced it (remote is v1, revision N).
        const dirB = await fs.mkdtemp(path.join(os.tmpdir(), 'sshs3-team-vault-test-b-'));
        try {
          const cryptoA = fakeCrypto();
          cryptoA.generateVaultKey = () => fixedKey;
          const a = new TeamVaultService({ cryptoService: cryptoA, baseDir: tempDir });
          const provider = fakeProvider();
          const vaultId = (await a.createVault('alice@piv:abc', 'age1yubikey1alice')).vaultId;
          const v1 = await downgradeToV1(a, cryptoA, vaultId);
          await fs.mkdir(path.join(dirB, 'team-vaults'), { recursive: true });
          await fs.writeFile(path.join(dirB, 'team-vaults', `${vaultId}.json`), JSON.stringify(v1));
          const b = new TeamVaultService({ cryptoService: cryptoA, baseDir: dirB });
          await provider.writeFile!(`team-vault/${vaultId}/vault.json`, Buffer.from(JSON.stringify(v1)));
          await b.pushToRemote(vaultId, provider); // B has observed the v1 remote: lastSyncedRevision = N

          // A unlocks (upgrades) and pushes v2.
          await a.unlock(vaultId, 'alice@piv:abc', identity);
          await a.pushToRemote(vaultId, provider);

          // B unlocks later with the new version: its own upgrade is NOT an unpushed change.
          await b.unlock(vaultId, 'alice@piv:abc', identity);
          expect(await b.hasUnpushedLocalChanges(vaultId)).toBe(false);
          expect(await b.hasRemoteChangedSinceLastSync(vaultId, provider)).toBe(true);
          await expect(b.pushToRemote(vaultId, provider)).rejects.toThrow(/changed since|newer version|conflict/i); // quiet conflict
          await expect(b.pullFromRemote(vaultId, provider)).resolves.toBeUndefined(); // no force, no click
          expect(JSON.parse(await fs.readFile(path.join(dirB, 'team-vaults', `${vaultId}.json`), 'utf-8')).formatVersion).toBe(2);
        } finally {
          await fs.rm(dirB, { recursive: true, force: true }).catch(() => {});
        }
      });

      it('upgrades after a pull that brought in a v1 file written by an older client (a mixed team that had not upgraded yet)', async () => {
        const { service, crypto2, provider, vaultId } = await newVault();
        const v1 = await downgradeToV1(service, crypto2, vaultId);
        await service.unlock(vaultId, 'alice@piv:abc', identity); // upgrades locally to v2, revision N, not pushed
        // An older client wrote to the (never v2) remote meanwhile: revision N + 1, still v1.
        const unsigned = { ...v1, revision: v1.revision + 1, encryptedPayload: crypto2.encryptPayload(fixedKey, vaultId, 1, '{}') };
        const older = { ...unsigned, accessHeaderMac: crypto2.computeFileMac(fixedKey, unsigned as never) };
        await provider.writeFile!(`team-vault/${vaultId}/vault.json`, Buffer.from(JSON.stringify(older)));

        await service.pullFromRemote(vaultId, provider, '', { force: true });

        const after = await readLocal(vaultId);
        expect([after.formatVersion, after.revision]).toEqual([2, v1.revision + 1]); // pulled, then upgraded again
      });

      // Code review of M1: a remote that was only ever seen as v1 sets the mark (1), which must not make a newer v1 revision unpullable.
      it('still accepts a strictly newer v1 revision from an older client when the mark only says "seen as v1"', async () => {
        const { service, crypto2, provider, vaultId } = await newVault();
        const v1 = await downgradeToV1(service, crypto2, vaultId);
        await provider.writeFile!(`team-vault/${vaultId}/vault.json`, Buffer.from(JSON.stringify(v1)));
        await service.pushToRemote(vaultId, provider); // mark = 1
        await service.unlock(vaultId, 'alice@piv:abc', identity); // local is v2 at the same revision
        const unsigned = { ...v1, revision: v1.revision + 1, encryptedPayload: crypto2.encryptPayload(fixedKey, vaultId, 1, '{}') };
        const newer = { ...unsigned, accessHeaderMac: crypto2.computeFileMac(fixedKey, unsigned as never) };
        await provider.writeFile!(`team-vault/${vaultId}/vault.json`, Buffer.from(JSON.stringify(newer)));

        await expect(service.pullFromRemote(vaultId, provider, '')).resolves.toBeUndefined();
        expect((await readLocal(vaultId)).revision).toBe(v1.revision + 1);
      });

      // Security review of M1: the mark can be unset (never pushed since the upgrade, or lost) while the local copy is already v2.
      it('treats the local copy\'s own format as a floor, so a replayed pre-upgrade file at the same revision is refused even with no mark', async () => {
        const { service, crypto2, provider, vaultId } = await newVault();
        const v1 = await downgradeToV1(service, crypto2, vaultId);
        await service.unlock(vaultId, 'alice@piv:abc', identity); // local is now v2, nothing pushed: no mark
        await provider.writeFile!(`team-vault/${vaultId}/vault.json`, Buffer.from(JSON.stringify(v1))); // the pre-upgrade file

        await expect(service.pullFromRemote(vaultId, provider, '', { force: true })).rejects.toThrow(/older format/);
        expect((await readLocal(vaultId)).formatVersion).toBe(2);
      });
    });

    // Payload keys this version does not know are kept when the payload is written, and never reach the renderer.
    describe('unknown payload keys', () => {
      async function vaultWithFutureKey() {
        const { service, crypto2, vaultId } = await newVault();
        const payload = JSON.stringify({ ssh: [], s3: [], futureFeature: { secret: 'shh' } }); // pragma: allowlist secret
        const base = await readLocal(vaultId);
        const unsigned = { ...base, encryptedPayload: crypto2.encryptPayload(fixedKey, vaultId, 2, payload) };
        await fs.writeFile(
          path.join(tempDir, 'team-vaults', `${vaultId}.json`),
          JSON.stringify({ ...unsigned, accessHeaderMac: crypto2.computeFileMac(fixedKey, unsigned as never) })
        );
        const rawPayload = async () => JSON.parse(crypto2.decryptPayload(fixedKey, vaultId, 2, (await readLocal(vaultId)).encryptedPayload));
        return { service, vaultId, rawPayload };
      }

      it('survives a profile save and a member removal, without a stray "unknownKeys" key', async () => {
        const { service, vaultId, rawPayload } = await vaultWithFutureKey();
        await service.saveSSHProfile(vaultId, profile('p1'));
        expect(await rawPayload()).toMatchObject({ futureFeature: { secret: 'shh' } }); // pragma: allowlist secret
        expect(await rawPayload()).not.toHaveProperty('unknownKeys');

        await service.addMember(vaultId, 'bob@piv:def', 'age1yubikey1bob', 'member');
        await service.removeMember(vaultId, 'bob@piv:def');
        expect(await rawPayload()).toMatchObject({ futureFeature: { secret: 'shh' } }); // pragma: allowlist secret
      });

      it('is never returned to the renderer, for an admin or a member', async () => {
        const { service, vaultId } = await vaultWithFutureKey();
        expect(await service.getPayloadForRenderer(vaultId)).not.toHaveProperty('futureFeature');
        expect(await service.getPayloadForRenderer(vaultId)).not.toHaveProperty('unknownKeys');
        await service.addMember(vaultId, 'bob@piv:def', 'age1yubikey1bob', 'member');
        service.lock(vaultId);
        await service.unlock(vaultId, 'bob@piv:def', '/tmp/fake-admin-identity.txt');
        expect(await service.getPayloadForRenderer(vaultId)).not.toHaveProperty('futureFeature');
      });

      it('writes a payload with no unknown keys exactly as before', async () => {
        const { service, crypto2, vaultId } = await newVault();
        await service.saveSSHProfile(vaultId, profile('p1'));
        const raw = JSON.parse(crypto2.decryptPayload(fixedKey, vaultId, 2, (await readLocal(vaultId)).encryptedPayload));
        expect(Object.keys(raw).sort()).toEqual(['folderIcons', 'folders', 'k8s', 's3', 'ssh']);
      });
    });

    it('removeMember on a v2 vault leaves a file the remaining member can verify and unlock', async () => {
      const { service, vaultId } = await newVault();
      await service.addMember(vaultId, 'bob@piv:def', 'age1yubikey1bob', 'member');
      await service.removeMember(vaultId, 'bob@piv:def');
      const after = await readLocal(vaultId);
      expect(after.formatVersion).toBe(2);
      expect(after.prevKeyProof).toBeTruthy();
      service.lock(vaultId);
      await expect(service.unlock(vaultId, 'alice@piv:abc', '/tmp/fake-admin-identity.txt')).resolves.toBeUndefined();
    });
  });
});
