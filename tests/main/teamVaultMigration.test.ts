import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { migrateLegacyTeamVaultLayout, relocateMigratedIdentityPath } from '../../src/main/services/teamVaultMigration';

describe('migrateLegacyTeamVaultLayout', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sshs3-team-vault-migration-test-'));
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true }).catch(() => {});
  });

  it('is a no-op on a brand-new install (no legacy file), but still creates the team-vaults directory', () => {
    const result = migrateLegacyTeamVaultLayout(baseDir);
    expect(result).toBeUndefined();
    expect(existsSync(path.join(baseDir, 'team-vaults'))).toBe(true);
  });

  it('migrates a legacy single-vault installation: new file written, old file renamed (not deleted), content preserved byte-for-byte', async () => {
    const legacyFile = {
      formatVersion: 1,
      vaultId: 'vlt_legacy-123',
      vaultName: 'Acme Infra Team',
      revision: 3,
      updatedAt: '2025-01-01T00:00:00.000Z',
      updatedBy: 'alice@piv:abc',
      accessHeader: [
        {
          recipientId: 'alice@piv:abc',
          role: 'admin',
          method: 'piv-rsa-oaep',
          ageRecipient: 'age1yubikey1alice',
          wrappedVaultKey: 'wrapped-alice',
          addedAt: '2025-01-01T00:00:00.000Z',
          addedBy: 'alice@piv:abc',
        },
        {
          recipientId: 'bob@piv:def',
          role: 'member',
          method: 'piv-rsa-oaep',
          ageRecipient: 'age1yubikey1bob',
          wrappedVaultKey: 'wrapped-bob',
          addedAt: '2025-01-02T00:00:00.000Z',
          addedBy: 'alice@piv:abc',
        },
      ],
      recovery: { recipientId: 'recovery-key-1', ageRecipient: 'age1fakerecovery', wrappedVaultKey: 'wrapped-recovery' },
      encryptedPayload: 'ciphertext-blob',
      accessHeaderMac: 'mac-value',
    };
    const legacyRaw = JSON.stringify(legacyFile, null, 2);
    const legacyFilePath = path.join(baseDir, 'team-vault.json');
    await fs.writeFile(legacyFilePath, legacyRaw, 'utf-8');

    const legacyIdentitiesDir = path.join(baseDir, 'team-vault-identities');
    await fs.mkdir(legacyIdentitiesDir, { recursive: true });
    await fs.writeFile(path.join(legacyIdentitiesDir, 'alice-identity.txt'), 'AGE-PLUGIN-YUBIKEY-stuff', 'utf-8');
    await fs.writeFile(path.join(legacyIdentitiesDir, 'bob-identity.txt'), 'AGE-PLUGIN-YUBIKEY-other-stuff', 'utf-8');

    const result = migrateLegacyTeamVaultLayout(baseDir);
    expect(result).toBe('vlt_legacy-123');

    // Old file preserved as a backup, never deleted.
    const migratedBackup = await fs.readFile(`${legacyFilePath}.migrated`, 'utf-8');
    expect(migratedBackup).toBe(legacyRaw);
    await expect(fs.readFile(legacyFilePath, 'utf-8')).rejects.toThrow();

    // New per-vault file holds byte-for-byte identical content — accessHeader/roles/config
    // preserved exactly.
    const newFilePath = path.join(baseDir, 'team-vaults', 'vlt_legacy-123.json');
    const newRaw = await fs.readFile(newFilePath, 'utf-8');
    expect(newRaw).toBe(legacyRaw);
    expect(JSON.parse(newRaw)).toEqual(legacyFile);

    // Identity files moved into a vaultId-named subdirectory, preserved exactly.
    const newIdentitiesDir = path.join(legacyIdentitiesDir, 'vlt_legacy-123');
    expect(await fs.readFile(path.join(newIdentitiesDir, 'alice-identity.txt'), 'utf-8')).toBe(
      'AGE-PLUGIN-YUBIKEY-stuff'
    );
    expect(await fs.readFile(path.join(newIdentitiesDir, 'bob-identity.txt'), 'utf-8')).toBe(
      'AGE-PLUGIN-YUBIKEY-other-stuff'
    );
    // The old flat files are gone from the identities directory root (moved, not copied).
    await expect(fs.readFile(path.join(legacyIdentitiesDir, 'alice-identity.txt'), 'utf-8')).rejects.toThrow();
  });

  it('is idempotent — running it twice on an already-migrated install is a safe no-op the second time', async () => {
    const legacyFile = {
      formatVersion: 1,
      vaultId: 'vlt_idempotent-456',
      revision: 1,
      updatedAt: '2025-01-01T00:00:00.000Z',
      updatedBy: 'alice@piv:abc',
      accessHeader: [],
      recovery: { recipientId: 'recovery-key-1', ageRecipient: 'age1fakerecovery', wrappedVaultKey: 'w' },
      encryptedPayload: '',
      accessHeaderMac: 'mac',
    };
    await fs.writeFile(path.join(baseDir, 'team-vault.json'), JSON.stringify(legacyFile), 'utf-8');

    const firstResult = migrateLegacyTeamVaultLayout(baseDir);
    expect(firstResult).toBe('vlt_idempotent-456');

    const secondResult = migrateLegacyTeamVaultLayout(baseDir);
    expect(secondResult).toBe('vlt_idempotent-456');

    // Still exactly one migrated backup file, not a second one overwriting or duplicating it.
    const migratedRaw = await fs.readFile(path.join(baseDir, 'team-vault.json.migrated'), 'utf-8');
    expect(JSON.parse(migratedRaw)).toEqual(legacyFile);
  });

  it('leaves an abandoned/interrupted migration\'s legacy file in place rather than guessing', async () => {
    // A legacy file with no vaultId at all isn't something this app itself would ever write —
    // left untouched rather than migrated under a guessed name.
    await fs.writeFile(path.join(baseDir, 'team-vault.json'), JSON.stringify({ formatVersion: 1 }), 'utf-8');

    const result = migrateLegacyTeamVaultLayout(baseDir);
    expect(result).toBeUndefined();
    await expect(fs.readFile(path.join(baseDir, 'team-vault.json'), 'utf-8')).resolves.toBeTruthy();
  });

  it('refuses to migrate a legacy file whose vaultId is malformed (defense in depth against path traversal)', async () => {
    const legacyFilePath = path.join(baseDir, 'team-vault.json');
    await fs.writeFile(
      legacyFilePath,
      JSON.stringify({ formatVersion: 1, vaultId: '../../../etc/evil' }),
      'utf-8'
    );

    const result = migrateLegacyTeamVaultLayout(baseDir);
    expect(result).toBeUndefined();
    // Left in place, not migrated under the malicious id — no team-vaults/ entry was ever
    // created for it, and nothing escaped baseDir.
    await expect(fs.readFile(legacyFilePath, 'utf-8')).resolves.toBeTruthy();
    expect(existsSync(path.join(baseDir, 'etc', 'evil.json'))).toBe(false);
  });

  it('does not re-migrate once multiple vaults already exist (post-migration, multi-team in use)', async () => {
    const vaultsDir = path.join(baseDir, 'team-vaults');
    await fs.mkdir(vaultsDir, { recursive: true });
    await fs.writeFile(path.join(vaultsDir, 'vlt_a.json'), '{}', 'utf-8');
    await fs.writeFile(path.join(vaultsDir, 'vlt_b.json'), '{}', 'utf-8');

    const result = migrateLegacyTeamVaultLayout(baseDir);
    // Ambiguous (more than one vault) — correctly reports "no single answer" rather than
    // guessing one of them.
    expect(result).toBeUndefined();
  });
});

describe('relocateMigratedIdentityPath', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sshs3-team-vault-relocate-test-'));
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true }).catch(() => {});
  });

  it('relocates a pre-migration flat identity path to its vaultId subdirectory when the moved file is there', async () => {
    const vaultId = 'vlt_abc';
    const newDir = path.join(baseDir, vaultId);
    await fs.mkdir(newDir, { recursive: true });
    await fs.writeFile(path.join(newDir, 'alice-identity.txt'), 'AGE-PLUGIN-YUBIKEY-stuff', 'utf-8');

    const stalePath = path.join(baseDir, 'alice-identity.txt');
    const result = relocateMigratedIdentityPath(stalePath, vaultId);
    expect(result).toBe(path.join(newDir, 'alice-identity.txt'));
  });

  it('returns undefined when the moved file does not exist at the expected relocated path', () => {
    const stalePath = path.join(baseDir, 'alice-identity.txt');
    expect(relocateMigratedIdentityPath(stalePath, 'vlt_abc')).toBeUndefined();
  });

  it('returns undefined for a path already under a vaultId subdirectory (nothing to relocate)', async () => {
    const vaultId = 'vlt_abc';
    const dir = path.join(baseDir, vaultId);
    await fs.mkdir(dir, { recursive: true });
    const alreadyCorrect = path.join(dir, 'alice-identity.txt');
    await fs.writeFile(alreadyCorrect, 'AGE-PLUGIN-YUBIKEY-stuff', 'utf-8');
    expect(relocateMigratedIdentityPath(alreadyCorrect, vaultId)).toBeUndefined();
  });
});
