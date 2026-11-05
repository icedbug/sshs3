import type { TeamVaultFile, TeamVaultPayload } from '../../shared/types/teamVault';
import type { TeamVaultCryptoService } from './TeamVaultCryptoService';

// Format versions, the errors that go with them, the upgrade chain and the payload helpers of the Team Vault.
// Kept apart from `TeamVaultService` (which is far past the size limit in CLAUDE.md) so a new format is one more row here.

/** The format new vaults are written in, and the one `upgradeFormatIfNeeded` brings older vaults to. */
export const CURRENT_FORMAT_VERSION = 2 as const;
/** Oldest format this app still reads. v1 files carry a header-only MAC (no payload coverage), see `computeFileMac`. */
export const SUPPORTED_FORMAT_VERSIONS: readonly number[] = [1, 2];

/** A vault file written by a NEWER version of sshs3 than this one understands. Distinct from a malformed file so that
 * the user is told to update the app rather than that the vault is broken. */
export class TeamVaultUnsupportedFormatError extends Error {
  constructor(formatVersion: unknown) {
    super(
      `This Team Vault uses format version ${String(formatVersion)}, which is newer than this version of sshs3 understands. Update sshs3 to open it.`
    );
    this.name = 'TeamVaultUnsupportedFormatError';
  }
}

/** A vault file is in an OLDER format than the remote has already been seen in (or than the remote now is, on push). A legitimate
 * older-format file cannot appear after that (older versions cannot write over a newer vault), so on pull this is a replay of a
 * pre-upgrade file, whose MAC does not cover the payload; on push it would overwrite a newer-format vault with an older one. */
export class TeamVaultFormatDowngradeError extends Error {
  constructor(direction: 'pull' | 'push') {
    super(
      direction === 'pull'
        ? 'The remote Team Vault is in an older format than the one already seen on it — refusing to accept it (possible replay of an old file by whoever has S3 write access).'
        : 'The remote Team Vault is in a newer format than this machine\'s copy — pull first, then push again.'
    );
    this.name = 'TeamVaultFormatDowngradeError';
  }
}

const KNOWN_PAYLOAD_KEYS = ['ssh', 's3', 'folders', 'folderIcons', 'k8s', 'unknownKeys'] as const;

/** Top-level payload keys this version does not know, or undefined when there are none. */
export function unknownPayloadKeys(parsed: unknown): Record<string, unknown> | undefined {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const extra = Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).filter(([key]) => !(KNOWN_PAYLOAD_KEYS as readonly string[]).includes(key))
  );
  return Object.keys(extra).length > 0 ? extra : undefined;
}

/** The JSON that is encrypted: the known fields plus any unknown keys carried along. Known fields win, and `unknownKeys` itself is
 * never written (it is only how the keys travel in memory). */
export function serializePayload(payload: TeamVaultPayload): string {
  const { unknownKeys, ...known } = payload;
  return JSON.stringify({ ...unknownKeys, ...known });
}

/**
 * One step of a format upgrade. `requires` says what the unlocked session needs for it: a migration that only re-encrypts and re-signs with
 * the Vault Key (every member has it) can run on any unlock, so nobody has to click anything; one that needed an admin's signature would
 * only run when an admin unlocks. A later format is one more entry here and one more row in `TeamVaultCryptoService`'s `FORMAT_SPECS`.
 */
export interface FormatMigration {
  requires: 'vaultKey' | 'admin';
  /** The file as it is after this step, minus the MAC, which is recomputed once at the end of the chain. */
  apply(file: TeamVaultFile, vaultKey: Buffer, crypto: TeamVaultCryptoService): TeamVaultFile;
}

export const FORMAT_MIGRATIONS: Record<number, FormatMigration> = {
  // v1 -> v2: the payload is re-encrypted with the v2 AAD (which names the format). Revision, updatedAt and updatedBy are left alone:
  // this is not an edit, and a bumped revision would make every member's own upgrade look like an unpushed change.
  1: {
    requires: 'vaultKey',
    apply: (file, vaultKey, crypto) => ({
      ...file,
      formatVersion: 2,
      encryptedPayload: crypto.encryptPayload(
        vaultKey,
        file.vaultId,
        2,
        crypto.decryptPayload(vaultKey, file.vaultId, file.formatVersion, file.encryptedPayload)
      ),
    }),
  },
};

/**
 * Runs the migration chain from `file`'s format up to `CURRENT_FORMAT_VERSION`. Returns the migrated file (its MAC is stale and must be
 * recomputed by the caller), or null when a step is missing or needs an admin and the session is not one.
 */
export function migrateToCurrentFormat(
  file: TeamVaultFile,
  vaultKey: Buffer,
  isAdmin: boolean,
  crypto: TeamVaultCryptoService
): TeamVaultFile | null {
  let migrated = file;
  while (migrated.formatVersion < CURRENT_FORMAT_VERSION) {
    const step = FORMAT_MIGRATIONS[migrated.formatVersion];
    if (!step || (step.requires === 'admin' && !isAdmin)) return null;
    migrated = step.apply(migrated, vaultKey, crypto);
  }
  return migrated;
}
