import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { app } from 'electron';
import type { StorageConnectConfig } from '../../shared/types/ipc';
import type { FileEntry, S3Config } from '../../shared/types/storage';
import { TEAM_VAULT_PENDING_VAULT_ID } from '../../shared/types/teamVault';
import { encryptSecretValue, decryptSecretValue, transformEntrySecrets } from '../crypto/SecretFieldCrypto';
import { createLogger } from '../log/Logger';
import { backupCorruptFile, writeFileAtomic } from '../storage/atomicFile';

const teamVaultConfigLog = createLogger('team-vault-config');

const S3_SECRET_FIELDS: Array<keyof S3Config> = ['secretAccessKey', 'sessionToken'];

/** One team's worth of Team Vault sync configuration — see `TeamVaultConfigData.byVaultId`. */
export interface TeamVaultConfigEntry {
  /** Where the vault file is read from / written to — S3/MinIO only (docs/team-vault-plan.md
   * Fas 3 is scoped to S3; SFTP is intentionally out of scope). */
  target?: StorageConnectConfig;
  /** `bucket[/prefix]` the vault file is written under — same convention as `SyncConfigStore`'s
   * `remoteBasePath`, see its doc comment. */
  remoteBasePath?: string;
  lastSyncAt?: string;
  /** This machine's own recipient id and PIV identity file, remembered purely so the UI can
   * prefill the unlock form instead of making the admin retype/relocate them every session —
   * neither value is a secret (the identity file holds a public `AGE-PLUGIN-YUBIKEY-...` stanza,
   * not a key; see `TeamVaultCryptoService.enrollOwnPivRecipient`'s doc comment). */
  selfRecipientId?: string;
  selfIdentityFilePath?: string;
  /** The remote vault file's size+mtime as of the last successful push/pull — `TeamVaultService`'s
   * optimistic-concurrency check (`pushToRemote`) and sync preview (`hasRemoteChangedSinceLastSync`)
   * hydrate their in-memory `VaultRuntimeState.lastKnownRemoteEntry` from this on first use after a
   * restart, instead of starting blank every time: not a secret, and not involved in either
   * push/pull's actual trust-boundary checks (those always re-verify vaultId/revision against the
   * remote fresh, regardless of this value — see docs/team-vault-plan.md's 2026-10-08 security
   * review) — this only drives the "remote changed" UI hint and a softer overwrite-conflict check,
   * both previously defaulting to "always assume changed"/"skip the check" on every fresh process. */
  lastKnownRemoteEntry?: FileEntry | null;
  /** The local vault file's `revision` as of the last successful push/pull. Persisted so that local
   * edits made before a restart are still recognised as unpushed afterwards (otherwise the first
   * pull after a restart would silently overwrite them). Absent == never synced from this device. */
  lastSyncedRevision?: number;
  /** The highest `formatVersion` the remote vault file has had when this device last pushed or pulled it. Once the remote
   * has been seen in format N, a pulled file in a lower format is refused (`TeamVaultFormatDowngradeError`): a legitimate
   * older-format file can no longer appear after that, so one that does is a replay. Never lowered; cleared with the rest of
   * the sync state when the target changes. Absent == never seen. */
  remoteFormatVersion?: number;
}

/** On-disk shape, keyed by `vaultId` — one entry per team this device knows about (multi-team
 * Team Vault). Entries configured before the real `vaultId` is known (first-time join: a target
 * must be configured to pull from, but `vaultId` isn't known until that pull succeeds) are parked
 * under `TEAM_VAULT_PENDING_VAULT_ID` and promoted once the real id is learned — see
 * `promotePendingConfig`. */
export interface TeamVaultConfigData {
  byVaultId: Record<string, TeamVaultConfigEntry>;
}

function emptyEntry(): TeamVaultConfigEntry {
  return {};
}

function encryptTarget(target: StorageConnectConfig): StorageConnectConfig {
  const result: StorageConnectConfig = { ...target };
  if (result.s3Config) {
    result.s3Config = transformEntrySecrets(result.s3Config, S3_SECRET_FIELDS, encryptSecretValue);
  }
  return result;
}

function decryptTarget(target: StorageConnectConfig): StorageConnectConfig {
  const result: StorageConnectConfig = { ...target };
  if (result.s3Config) {
    result.s3Config = transformEntrySecrets(result.s3Config, S3_SECRET_FIELDS, decryptSecretValue);
  }
  return result;
}

/** True for the pre-multi-team on-disk shape: a flat `TeamVaultConfigEntry`-shaped object with no
 * `byVaultId` wrapper — i.e. anything this store itself never wrote after this field was
 * introduced. Used by `readRaw` to wrap a legacy file into the new shape on first read. */
function isLegacyShape(data: unknown): data is TeamVaultConfigEntry {
  return !!data && typeof data === 'object' && !('byVaultId' in (data as Record<string, unknown>));
}

/**
 * Persists the Team Vault's own S3/MinIO sync target(s) — a deliberately separate file from
 * `SyncConfigStore` (docs/team-vault-plan.md: the Team Vault is a separate trust model from
 * Remote Profile Sync, never sharing infrastructure with it). One entry per team the device
 * knows about (`byVaultId`), since a user may belong to several teams, each with its own S3
 * target. Credentials are at-rest encrypted the same way `SyncConfigStore` encrypts its own
 * target, via `SecretFieldCrypto`.
 */
export class TeamVaultConfigStore {
  private filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(customPath?: string) {
    if (customPath) {
      this.filePath = customPath;
    } else {
      let baseDir: string;
      try {
        baseDir = app.getPath('userData');
      } catch {
        baseDir = path.join(os.homedir(), '.sshs3');
      }
      this.filePath = path.join(baseDir, 'team-vault-sync-config.json');
    }
  }

  public getFilePath(): string {
    return this.filePath;
  }

  /** Reads and decrypts the whole on-disk map, wrapping a legacy (pre-multi-team, single-entry)
   * file into `{ byVaultId: { [TEAM_VAULT_PENDING_VAULT_ID]: entry } }` on the fly — the legacy
   * file predates multi-team support, so it never had a real `vaultId` to key itself by; parking
   * it under the pending sentinel keeps it discoverable without guessing. */
  private async readRaw(): Promise<TeamVaultConfigData> {
    let data: unknown;
    let raw: string | undefined;
    try {
      raw = await fs.readFile(this.filePath, 'utf-8');
      data = JSON.parse(raw);
    } catch (err: any) {
      if (err?.code === 'ENOENT') return { byVaultId: {} };
      if (raw !== undefined && err instanceof SyntaxError) await backupCorruptFile(this.filePath, raw);
      // Anything else (corrupted JSON, an OS-keychain/decrypt failure after e.g. a machine
      // migration, a truncated secret field) was previously indistinguishable from "never
      // configured" — same empty result, zero diagnostic signal. Logged (not thrown): every
      // caller already treats a missing config as "no target configured yet" and handles that
      // gracefully, so surfacing a hard error here would be a bigger behavior change than this
      // fix intends; the log line is what actually closes the observability gap.
      teamVaultConfigLog.warn('Failed to read Team Vault config (treating as not configured):', err);
      return { byVaultId: {} };
    }

    if (isLegacyShape(data)) {
      return { byVaultId: { [TEAM_VAULT_PENDING_VAULT_ID]: data } };
    }
    const byVaultId = (data as TeamVaultConfigData)?.byVaultId;
    return { byVaultId: byVaultId && typeof byVaultId === 'object' ? byVaultId : {} };
  }

  private decryptEntry(entry: TeamVaultConfigEntry): TeamVaultConfigEntry {
    return { ...entry, target: entry.target ? decryptTarget(entry.target) : undefined };
  }

  /** `readRaw()` plus decrypting every entry's target — `persistAll()` always encrypts its input
   * fresh, so anything that rebuilds the full map before writing it back (`persistEntry`,
   * `clear`, `promotePendingConfig`) must start from decrypted data, not raw `readRaw()`: feeding
   * `persistAll()` an already-encrypted target for an untouched vault would double-encrypt it on
   * every unrelated write (e.g. every `setLastSyncAt` from another team's auto-sync), compounding
   * with each call until no number of decrypt passes recovers the original secret. */
  private async readDecrypted(): Promise<TeamVaultConfigData> {
    const data = await this.readRaw();
    return {
      byVaultId: Object.fromEntries(
        Object.entries(data.byVaultId).map(([vaultId, entry]) => [vaultId, this.decryptEntry(entry)])
      ),
    };
  }

  public async getConfig(vaultId: string): Promise<TeamVaultConfigEntry> {
    const data = await this.readRaw();
    const entry = data.byVaultId[vaultId];
    return entry ? this.decryptEntry(entry) : emptyEntry();
  }

  /** Every known team's config in one round trip — drives the renderer's team list
   * (`IpcBridge.buildAllTeamVaultStatuses`) without an N-call fan-out. */
  public async getAllConfigs(): Promise<Record<string, TeamVaultConfigEntry>> {
    const data = await this.readDecrypted();
    return data.byVaultId;
  }

  public async setTarget(vaultId: string, target: StorageConnectConfig, remoteBasePath = ''): Promise<void> {
    return this.queueMutation(async () => {
      const current = await this.getConfig(vaultId);
      await this.persistEntry(vaultId, { ...current, target, remoteBasePath });
    });
  }

  public async setLastSyncAt(vaultId: string, timestamp: string): Promise<void> {
    return this.queueMutation(async () => {
      const current = await this.getConfig(vaultId);
      await this.persistEntry(vaultId, { ...current, lastSyncAt: timestamp });
    });
  }

  public async setLastKnownRemoteEntry(
    vaultId: string,
    entry: FileEntry | null,
    lastSyncedRevision?: number,
    remoteFormatVersion?: number
  ): Promise<void> {
    return this.queueMutation(async () => {
      const current = await this.getConfig(vaultId);
      await this.persistEntry(vaultId, {
        ...current,
        lastKnownRemoteEntry: entry,
        ...(lastSyncedRevision !== undefined ? { lastSyncedRevision } : {}),
        ...(remoteFormatVersion !== undefined
          ? { remoteFormatVersion: Math.max(remoteFormatVersion, current.remoteFormatVersion ?? 0) }
          : {}),
      });
    });
  }

  /** Forgets the remembered remote state and synced revision, e.g. when the sync target changes. */
  public async clearSyncState(vaultId: string): Promise<void> {
    return this.queueMutation(async () => {
      const {
        lastKnownRemoteEntry: _entry,
        lastSyncedRevision: _revision,
        remoteFormatVersion: _format,
        ...rest
      } = await this.getConfig(vaultId);
      await this.persistEntry(vaultId, rest);
    });
  }

  /** Either argument may be omitted to update just the other field (e.g. a fresh
   * `enrollOwnPivRecipient()` call only knows the identity file path — the recipient id, a
   * user-chosen label, isn't known until `createVault`/`unlock` confirms it). */
  public async setSelfIdentity(
    vaultId: string,
    recipientId: string | undefined,
    identityFilePath: string | undefined
  ): Promise<void> {
    return this.queueMutation(async () => {
      const current = await this.getConfig(vaultId);
      await this.persistEntry(vaultId, {
        ...current,
        selfRecipientId: recipientId ?? current.selfRecipientId,
        selfIdentityFilePath: identityFilePath ?? current.selfIdentityFilePath,
      });
    });
  }

  /** Explicitly nulls out both remembered self-identity fields (e.g. on `deleteVault()`) — unlike
   * `setSelfIdentity(vaultId, undefined, undefined)`, which is a no-op by design (lets a caller
   * that only knows one field update just that one without clobbering the other). */
  public async clearSelfIdentity(vaultId: string): Promise<void> {
    return this.queueMutation(async () => {
      const current = await this.getConfig(vaultId);
      await this.persistEntry(vaultId, { ...current, selfRecipientId: undefined, selfIdentityFilePath: undefined });
    });
  }

  /** Clears one team's entry entirely — only local configuration, never the remote vault file
   * itself, and never any OTHER team's entry. */
  public async clear(vaultId: string): Promise<void> {
    return this.queueMutation(async () => {
      const data = await this.readDecrypted();
      delete data.byVaultId[vaultId];
      await this.persistAll(data);
    });
  }

  /** Moves a pending (vaultId-less) entry to its real `vaultId` once a first successful pull
   * reveals it — see `TEAM_VAULT_PENDING_VAULT_ID`'s doc comment. A no-op if there's no pending
   * entry (the common case: every pull after the first). Never overwrites an existing entry
   * already at `vaultId` (shouldn't happen in practice — a vault is only ever pending before its
   * first pull — but preferring the already-resolved entry over a stale pending one is the safer
   * default if it somehow does). */
  public async promotePendingConfig(vaultId: string): Promise<void> {
    return this.queueMutation(async () => {
      const data = await this.readDecrypted();
      const pending = data.byVaultId[TEAM_VAULT_PENDING_VAULT_ID];
      if (!pending) return;
      delete data.byVaultId[TEAM_VAULT_PENDING_VAULT_ID];
      if (!data.byVaultId[vaultId]) {
        data.byVaultId[vaultId] = pending;
      }
      await this.persistAll(data);
    });
  }

  private queueMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const resultPromise = this.writeQueue.then(mutation, mutation);
    this.writeQueue = resultPromise.then(
      () => {},
      () => {}
    );
    return resultPromise;
  }

  private async persistEntry(vaultId: string, entry: TeamVaultConfigEntry): Promise<void> {
    const data = await this.readDecrypted();
    data.byVaultId[vaultId] = entry;
    await this.persistAll(data);
  }

  private async persistAll(data: TeamVaultConfigData): Promise<void> {
    const onDisk: TeamVaultConfigData = {
      byVaultId: Object.fromEntries(
        Object.entries(data.byVaultId).map(([vaultId, entry]) => [
          vaultId,
          { ...entry, target: entry.target ? encryptTarget(entry.target) : undefined },
        ])
      ),
    };
    await writeFileAtomic(this.filePath, JSON.stringify(onDisk, null, 2), { mode: 0o600 });
  }
}
