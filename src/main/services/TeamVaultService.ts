import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import type {
  TeamVaultAccessEntry,
  TeamVaultFile,
  TeamVaultMemberSummary,
  TeamVaultPayload,
  TeamVaultRole,
  TeamVaultStatus,
  WorkspaceActivityEvent,
  WorkspaceMemoryEntry,
} from '../../shared/types/teamVault';
import type { SSHConnectionConfig } from '../../shared/types/ssh';
import type { FileEntry, IStorageProvider, S3Config } from '../../shared/types/storage';
import type { AskpassPromptKind } from '../../shared/types/ipc';
import type { AskpassPromptRetryContext } from '../smartcard/AskpassServer';
import { joinPaths } from '../transfer/TransferPipeline';
import { TeamVaultCryptoService, type AgePtyPromptCallbacks } from './TeamVaultCryptoService';

const FORMAT_VERSION = 1 as const;
const REMOTE_VAULT_FILENAME = 'team-vault/vault.json';
/** A real vault file (JSON, base64-wrapped keys, every shared SSH/S3 profile) stays well under
 * this even for a large team — see `readRemoteVaultFile`'s doc comment for why it exists. */
const MAX_REMOTE_VAULT_FILE_SIZE = 50 * 1024 * 1024;

export class TeamVaultSyncConflictError extends Error {
  constructor() {
    super('Remote Team Vault changed since it was last read here. Pull the latest changes before pushing again.');
    this.name = 'TeamVaultSyncConflictError';
  }
}

/** A remote write-access holder is not necessarily a vault recipient (bucket IAM vs. vault
 * membership are different trust domains) — thrown by `pushToRemote` (don't silently overwrite
 * unrelated/malicious content at the target) and by `pullFromRemote` (don't silently adopt
 * unrelated/malicious content as this machine's vault) alike, whenever a vault with a different
 * `vaultId` than expected is encountered. */
export class TeamVaultForeignVaultError extends Error {
  constructor() {
    super(
      'A different Team Vault than the one expected here was found. If you mean to switch which ' +
        'vault this machine follows, delete the local vault file first; otherwise point this vault ' +
        'at a different bucket/prefix.'
    );
    this.name = 'TeamVaultForeignVaultError';
  }
}

export class TeamVaultRollbackError extends Error {
  constructor() {
    super(
      'The remote Team Vault is older than what is already stored locally — refusing to roll back (possible tampering or a stale remote copy).'
    );
    this.name = 'TeamVaultRollbackError';
  }
}

/** `pullFromRemote` found that the local vault file has local mutations (shared-profile edits,
 * membership changes, ...) that were never pushed — overwriting them with the pulled file would
 * silently discard them. Thrown instead of pulling; the caller must either push first or pass
 * `{ force: true }` to discard the local changes and pull anyway (see `lastSyncedRevision`'s doc
 * comment for how this is detected). */
export class TeamVaultUnpushedChangesError extends Error {
  constructor() {
    super(
      'This machine has local Team Vault changes that have not been pushed yet. Push them first, or pull anyway to discard them.'
    );
    this.name = 'TeamVaultUnpushedChangesError';
  }
}

/** A recipient's `ageRecipient` (their public key) never legitimately changes once added —
 * `addMember` refuses a `recipientId` that's already a member, and nothing else ever rewrites
 * this field. A pulled file that disagrees, for a recipient this machine already knows, despite
 * matching `vaultId`/`revision`, means someone with mere S3 write access (not necessarily a real
 * recipient) substituted their own public key into an existing entry. That substitution is inert
 * on its own — its stale `wrappedVaultKey` can't be unwrapped without the real Vault Key — but a
 * later, routine `removeMember` would re-wrap a *fresh* Vault Key for every remaining entry's
 * `ageRecipient`, including the tampered one, handing the attacker real access. Reject outright. */
export class TeamVaultTamperedEntryError extends Error {
  constructor(recipientId: string) {
    super(
      `The remote Team Vault's public key for "${recipientId}" does not match what was previously known — refusing to accept it (possible tampering by whoever has S3 write access to this path).`
    );
    this.name = 'TeamVaultTamperedEntryError';
  }
}

/** The access header's own authenticity tag (`accessHeaderMac`) didn't match what the Vault Key
 * we hold computes for it — thrown regardless of which field was tampered with, or which
 * `revision` the tamperer attached to their forgery, since computing a valid tag requires the
 * real Vault Key. See `TeamVaultCryptoService.computeAccessHeaderMac`'s doc comment. */
/** `pullFromRemote` cannot verify the pulled access header's `accessHeaderMac` without the Vault
 * Key, which only exists while unlocked. Thrown instead of silently accepting the pulled file
 * over an EXISTING local vault whenever the session is locked — otherwise a bucket-write-access
 * holder (not necessarily a real recipient) could plant a wholly new, forged access-header entry
 * while the victim happens to be locked, bypassing `accessHeaderMac` verification entirely rather
 * than needing the much more conspicuous "remove a real member" trick `TeamVaultHeaderIntegrityError`'s
 * doc comment already treats as the accepted residual gap. Does not apply when there's no local
 * file yet (a brand-new join has nothing to verify against either way). */
export class TeamVaultLockedForPullError extends Error {
  constructor() {
    super(
      'Unlock the Team Vault before pulling updates to it, so the pulled file\'s integrity can be verified.'
    );
    this.name = 'TeamVaultLockedForPullError';
  }
}

export class TeamVaultHeaderIntegrityError extends Error {
  constructor() {
    super(
      "The remote Team Vault's access header failed its integrity check against the Vault Key already held — refusing to accept it (possible tampering by whoever has S3 write access to this path)."
    );
    this.name = 'TeamVaultHeaderIntegrityError';
  }
}

/** Thrown when a pulled file's `accessHeader` is shorter than our local copy's (a claimed
 * `removeMember` rotation) but `prevKeyProof` doesn't verify against the Vault Key already held.
 * Closes the gap `TeamVaultHeaderIntegrityError`'s doc comment used to call an accepted residual
 * limit: without this check, mere S3 write access — no member key, no card, nobody real removed —
 * was enough to drop one entry from the header, which skipped `accessHeaderMac` verification
 * entirely (it only ran when the entry count didn't decrease) and let an attacker-generated Vault
 * Key, wrapped to the remaining members' already-public recipients, be accepted as the real
 * rotation. `prevKeyProof` is an HMAC over the new header keyed by a subkey derived from the Vault
 * Key being rotated AWAY from — only whoever actually held that real previous key could produce
 * it, so a bucket-write-access-only attacker generating their own fresh key cannot forge it.
 *
 * Also fires on a legitimate but multi-step rotation this client missed entirely (two
 * `removeMember`s while offline): `prevKeyProof` only links one step back, to the key
 * *immediately* preceding the pulled file, which an offline client several rotations behind
 * never held. Deliberately conservative — rejecting a rare legitimate multi-step catch-up is far
 * safer than accepting an unprovable one. Recovery is the same as for a brand-new join: delete
 * the local file and pull fresh (nothing to verify against then either), after confirming the
 * new member list out of band. */
export class TeamVaultRotationProofError extends Error {
  constructor() {
    super(
      "The remote Team Vault's access header is shorter than the local copy's, but the Vault Key rotation isn't provably linked to the Vault Key already held — refusing to accept it. If a real member was removed while this machine was offline through more than one rotation, delete the local vault file and pull fresh after confirming the member list with an admin."
    );
    this.name = 'TeamVaultRotationProofError';
  }
}

/** A smartcard/FIDO2 PIN is never written to disk anywhere in this app (see
 * `ProfileStore.persist()`'s identical rule for local profiles) — dropped unconditionally on
 * every save, regardless of who's calling. Every other field on a shared profile (including
 * `pkcs11LibPath`/`agentPath`/`privateKeyPath`/`customCaPath`) is just a string that either
 * resolves on a given member's machine or silently doesn't — none of them execute anything on
 * their own, so there's nothing else to strip here. */
function withoutPin(profile: SSHConnectionConfig): SSHConnectionConfig {
  if (!('pin' in profile)) return profile;
  const { pin: _pin, ...rest } = profile;
  return rest as SSHConnectionConfig;
}

/** Strips an SSH profile's secret fields for a non-admin reader, replacing them with booleans
 * the UI can use to show "a password is set" without ever seeing it — see
 * `TeamVaultService.getPayloadForRenderer`. */
function redactSshSecrets(profile: SSHConnectionConfig): SSHConnectionConfig {
  const { password, passphrase, proxy, ...rest } = profile;
  return {
    ...rest,
    hasPassword: Boolean(password) || Boolean(passphrase),
    ...(proxy ? { proxy: { ...proxy, password: undefined, hasPassword: Boolean(proxy.password) } } : {}),
  };
}

/** Strips an S3 profile's secret fields for a non-admin reader — see `redactSshSecrets`.
 * Includes `proxy.password` (the S3 traffic proxy's credential, same shape as the SSH one) —
 * easy to miss since it lives one level down from the fields this is named after. */
function redactS3Secrets(profile: S3Config): S3Config {
  const { secretAccessKey, sessionToken, proxy, ...rest } = profile;
  return {
    ...rest,
    secretAccessKey: '',
    hasSecretAccessKey: Boolean(secretAccessKey) || Boolean(sessionToken),
    ...(proxy ? { proxy: { ...proxy, password: undefined, hasPassword: Boolean(proxy.password) } } : {}),
  };
}

/** True when `incoming` is a non-empty value that differs from `existing` — i.e. a genuine
 * attempt to set/change a secret, as opposed to a redacted/untouched field round-tripping back
 * unchanged (always falsy or identical, since a non-admin never receives the real value in the
 * first place — see `getPayloadForRenderer`). */
function isSecretChangeAttempt(incoming: string | undefined, existing: string | undefined): boolean {
  return Boolean(incoming) && incoming !== existing;
}

/** Whether an SSH profile currently has any secret worth protecting. */
function hasSshSecret(profile: SSHConnectionConfig | undefined): boolean {
  return Boolean(profile?.password || profile?.passphrase || profile?.proxy?.password);
}

/** Whether `incoming` changes where a connection actually goes relative to `existing` — the
 * host/port/username/auth-type it connects as, or the proxy/jump host it routes through. A
 * non-admin allowed to edit these on a profile with no secret must NOT also be allowed to edit
 * them on one that has a secret: otherwise they could repoint an admin-set password at a server
 * of their own choosing and have it delivered there on the next connect (by themselves via
 * `resolveProfileForConnect`, or by anyone else who later connects using the edited profile) —
 * `guardSshSecretWrite` rejects such a change outright instead of silently keeping the old
 * routing (the user asked for host/port to stay member-editable, which this still allows on
 * secret-less profiles and for every other field regardless). */
function sshRoutingChanged(incoming: SSHConnectionConfig, existing: SSHConnectionConfig): boolean {
  return (
    incoming.host !== existing.host ||
    (incoming.port ?? 22) !== (existing.port ?? 22) ||
    incoming.username !== existing.username ||
    incoming.authType !== existing.authType ||
    incoming.proxyJump !== existing.proxyJump ||
    incoming.proxyJumpProfileId !== existing.proxyJumpProfileId ||
    Boolean(incoming.proxy?.enabled) !== Boolean(existing.proxy?.enabled) ||
    (incoming.proxy?.host ?? '') !== (existing.proxy?.host ?? '') ||
    (incoming.proxy?.port ?? 0) !== (existing.proxy?.port ?? 0) ||
    (incoming.proxy?.type ?? '') !== (existing.proxy?.type ?? '') ||
    (incoming.proxy?.username ?? '') !== (existing.proxy?.username ?? '')
  );
}

/** Enforces that only an admin may set or change an SSH profile's secret fields
 * (`password`/`passphrase`/`proxy.password`) — see `TeamVaultService.saveSSHProfile`. Throws if
 * a non-admin's incoming value for any of these is a genuine change attempt, or if a non-admin
 * tries to change where a profile with a stored secret actually connects (see
 * `sshRoutingChanged`'s doc comment — that's an exfiltration path, not a harmless edit).
 * Otherwise the previously stored secret value (if any) is kept, discarding whatever
 * blank/redacted value the non-admin's own copy of the field held. */
function guardSshSecretWrite(incoming: SSHConnectionConfig, existing: SSHConnectionConfig | undefined): SSHConnectionConfig {
  if (
    isSecretChangeAttempt(incoming.password, existing?.password) ||
    isSecretChangeAttempt(incoming.passphrase, existing?.passphrase) ||
    isSecretChangeAttempt(incoming.proxy?.password, existing?.proxy?.password) ||
    (hasSshSecret(existing) && existing && sshRoutingChanged(incoming, existing))
  ) {
    throw new Error('Only a Team Vault admin can set or change a profile password, or where it connects');
  }
  return {
    ...incoming,
    password: existing?.password,
    passphrase: existing?.passphrase,
    ...(incoming.proxy ? { proxy: { ...incoming.proxy, password: existing?.proxy?.password } } : {}),
  };
}

/** Whether `incoming` changes where an S3 profile's credentials actually get sent, or how safely
 * they get there, relative to `existing` — same reasoning as `sshRoutingChanged`, applied to
 * `endpoint`/`region`/`forcePathStyle` (a custom endpoint is how S3Config picks a non-AWS host),
 * `accessKeyId` (pairing a different key id with the stored secret is the same kind of tamper,
 * even though it can't change the request's destination on its own), and `rejectUnauthorized`/
 * `customCaPath` — both feed straight into `S3StorageProvider`'s TLS config, so a non-admin
 * could otherwise leave the endpoint untouched but disable certificate validation or substitute
 * a CA they control, exposing the secret (and all transferred data) to a network MITM without
 * ever touching a field this guard was already watching. */
function s3RoutingChanged(incoming: S3Config, existing: S3Config): boolean {
  return (
    (incoming.endpoint ?? '') !== (existing.endpoint ?? '') ||
    incoming.region !== existing.region ||
    Boolean(incoming.forcePathStyle) !== Boolean(existing.forcePathStyle) ||
    incoming.accessKeyId !== existing.accessKeyId ||
    // Not Boolean()-coerced: `undefined` (default, validates) and `false` (explicitly disabled)
    // are different states here, unlike the other boolean fields in this function.
    incoming.rejectUnauthorized !== existing.rejectUnauthorized ||
    (incoming.customCaPath ?? '') !== (existing.customCaPath ?? '') ||
    Boolean(incoming.proxy?.enabled) !== Boolean(existing.proxy?.enabled) ||
    (incoming.proxy?.host ?? '') !== (existing.proxy?.host ?? '') ||
    (incoming.proxy?.port ?? 0) !== (existing.proxy?.port ?? 0)
  );
}

/** Same as `guardSshSecretWrite`, for an S3 profile's `secretAccessKey`/`sessionToken`/
 * `proxy.password` and `s3RoutingChanged`. */
function guardS3SecretWrite(incoming: S3Config, existing: S3Config | undefined): S3Config {
  const existingHasSecret = Boolean(existing?.secretAccessKey || existing?.sessionToken || existing?.proxy?.password);
  if (
    isSecretChangeAttempt(incoming.secretAccessKey, existing?.secretAccessKey) ||
    isSecretChangeAttempt(incoming.sessionToken, existing?.sessionToken) ||
    isSecretChangeAttempt(incoming.proxy?.password, existing?.proxy?.password) ||
    (existingHasSecret && existing && s3RoutingChanged(incoming, existing))
  ) {
    throw new Error('Only a Team Vault admin can set or change a profile secret key, or where it connects');
  }
  return {
    ...incoming,
    secretAccessKey: existing?.secretAccessKey ?? '',
    sessionToken: existing?.sessionToken,
    ...(incoming.proxy ? { proxy: { ...incoming.proxy, password: existing?.proxy?.password } } : {}),
  };
}

/** Trims a `/`-separated folder path and each of its segments, collapsing away any empty segment
 * (a leading/trailing/doubled slash) — e.g. `" Acme Infra / Cluster A /"` -> `"Acme Infra/Cluster A"`.
 * Returns `''` for a path with no real segments at all. */
function normalizeFolderPath(folderPath: string): string {
  if (typeof folderPath !== 'string') return '';
  return folderPath
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join('/');
}

/** Whether `path` is exactly `ancestor` or nested under it (`ancestor + '/' + anything`). */
function isSelfOrDescendant(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}/`);
}

/** Rewrites `path` from under `oldPrefix` to the same relative position under `newPrefix` —
 * `path` itself if it isn't `oldPrefix` or a descendant of it. Used by `renameTeamFolder` to move
 * a folder's descendants (and every profile grouped under it) along with it. */
function remapFolderPath(path: string, oldPrefix: string, newPrefix: string): string {
  if (path === oldPrefix) return newPrefix;
  if (path.startsWith(`${oldPrefix}/`)) return newPrefix + path.slice(oldPrefix.length);
  return path;
}

// Same bech32-ish shape the interactive addMember path already enforces
// (teamVaultHandlers.ts's AGE_RECIPIENT_PATTERN) — applied here too so a pulled/forged remote
// file can't carry a malformed ageRecipient that only fails later, cryptically, when `age -r
// <value>` actually runs during a subsequent removeMember re-wrap.
const AGE_RECIPIENT_SHAPE = /^age1[a-z0-9]{5,}$/;

function isValidAccessEntry(e: any): e is TeamVaultAccessEntry {
  return (
    e &&
    typeof e.recipientId === 'string' &&
    e.recipientId.length > 0 &&
    (e.role === 'admin' || e.role === 'member') &&
    // 'piv-rsa-oaep' is the only value this format version defines (TeamVaultAccessEntry.method's
    // doc comment) — kept in lockstep with what canonicalAccessHeaderString actually MACs, so the
    // shape validator and the MAC's field list can't silently drift apart again.
    e.method === 'piv-rsa-oaep' &&
    typeof e.ageRecipient === 'string' &&
    AGE_RECIPIENT_SHAPE.test(e.ageRecipient) &&
    typeof e.wrappedVaultKey === 'string' &&
    e.wrappedVaultKey.length > 0 &&
    typeof e.addedAt === 'string' &&
    typeof e.addedBy === 'string'
  );
}

/** Full-shape validation for a vault file pulled from a remote we don't control the writer of —
 * a shallow "has the right top-level keys" check isn't enough, since a malformed entry (e.g.
 * missing `ageRecipient`) would otherwise only fail later, deep inside `removeMember`'s re-wrap
 * loop, with a confusing error. */
function assertValidVaultFile(file: any): asserts file is TeamVaultFile {
  if (
    !file ||
    file.formatVersion !== FORMAT_VERSION ||
    typeof file.vaultId !== 'string' ||
    !file.vaultId ||
    (file.vaultName !== undefined && typeof file.vaultName !== 'string') ||
    typeof file.revision !== 'number' ||
    !Number.isInteger(file.revision) ||
    file.revision < 1 ||
    !Array.isArray(file.accessHeader) ||
    !file.accessHeader.every(isValidAccessEntry) ||
    !file.recovery ||
    typeof file.recovery.recipientId !== 'string' ||
    typeof file.recovery.ageRecipient !== 'string' ||
    !AGE_RECIPIENT_SHAPE.test(file.recovery.ageRecipient) ||
    typeof file.recovery.wrappedVaultKey !== 'string' ||
    typeof file.encryptedPayload !== 'string' ||
    typeof file.accessHeaderMac !== 'string' ||
    !file.accessHeaderMac
  ) {
    throw new Error('Team Vault file is not a recognizable vault (unexpected format)');
  }

  // Every recipientId (including the recovery one) must be unique. A duplicate is never a
  // legitimate state this app itself would write — addMember already rejects an existing
  // recipientId — so one showing up in pulled content is either corruption or someone with mere
  // S3 write access trying to shadow a real recipient's entry with one of their own. `unlock()`'s
  // `.find()` would otherwise silently resolve to whichever entry happens to come first.
  const allIds = [...file.accessHeader.map((e: TeamVaultAccessEntry) => e.recipientId), file.recovery.recipientId];
  if (new Set(allIds).size !== allIds.length) {
    throw new Error('Team Vault file is not a recognizable vault (duplicate recipient id)');
  }
}

/** The narrow slice of `IpcBridge` that `unlock()`/`enrollOwnPivRecipient()` need to relay
 * PIN/touch prompts to the renderer — injected rather than taking the whole `IpcBridge` to keep
 * the dependency explicit (mirrors `TeamVaultHost`'s narrow pick-list in `teamVaultHandlers.ts`). */
export interface TeamVaultPinPrompter {
  promptForPinDirect(
    prompt?: string,
    kind?: AskpassPromptKind,
    context?: string,
    retry?: AskpassPromptRetryContext
  ): Promise<string>;
  makePresenceNotifier(
    sessionId: string | undefined,
    message: string
  ): { onPresenceRequested: () => void; onPresenceCleared: () => void };
}

export interface TeamVaultServiceOptions {
  cryptoService?: TeamVaultCryptoService;
  /** Overrides the vault file path — tests only; production always uses userData. */
  filePath?: string;
  /** Overrides where generated PIV identity files are written — tests only. */
  identityDir?: string;
  /** Required in production for `unlock()`/`enrollOwnPivRecipient()` to actually prompt for a
   * PIN/touch (see docs/team-vault-plan.md's hardware verification notes) — omitted in most
   * tests, whose fake crypto service never needs to prompt for anything. */
  pinPrompter?: TeamVaultPinPrompter;
}

/**
 * Owns the local Team Vault file (`<userData>/team-vault.json`, same directory convention as
 * `SyncConfigStore`) and the in-memory, never-persisted Vault Key once unlocked — exactly the
 * `SyncCryptoService`/§4.2 pattern: unlocked fresh every app session (or after an explicit
 * `lock()`), never cached to disk or the OS keyring.
 *
 * This is Fas 2 (docs/team-vault-plan.md): a single local vault, no S3 sync yet (Fas 3 adds
 * read/write against a remote target on top of this same file format and API).
 *
 * PIN-prompt wiring (docs/team-vault-plan.md's hardware verification notes): `unlock()`/
 * `enrollOwnPivRecipient()` relay PIN/touch prompts through an injected `TeamVaultPinPrompter`
 * (see `buildPtyCallbacks()`), which in production is `IpcBridge.promptForPinDirect`/
 * `makePresenceNotifier` — the same Askpass modal and touch banner every other PIV/FIDO2 flow in
 * the app already uses.
 */
export class TeamVaultService {
  private readonly cryptoService: TeamVaultCryptoService;
  private readonly filePath: string;
  private readonly identityDir: string;
  private writeQueue: Promise<void> = Promise.resolve();
  private unlockedVaultKey: Buffer | null = null;
  /** The recipientId that produced `unlockedVaultKey` (via `createVault` or `unlock`) — the
   * authoritative identity for `addedBy`/`removedBy`/`updatedBy` audit fields. Deliberately NOT a
   * caller-supplied parameter on `addMember`/`removeMember`/`setRole`: a renderer asserting an
   * arbitrary "I am X" string for an audit trail that's shared with the whole team (§2.3:
   * `updated_by` exists so a member can tell "who made the last change" without asking S3) would
   * make that field purely decorative instead of authoritative. */
  private unlockedAsRecipientId: string | null = null;
  /** Last observed remote `FileEntry` for the vault file, used for optimistic concurrency on
   * push (see `pushToRemote`) — `undefined` means never observed from this instance (no check
   * to do yet), `null` means observed as "doesn't exist yet". Same pattern as
   * `ProfileSyncService.lastKnownRemoteState`/`checkNotChangedRemotely`, which the real S3
   * provider has no `If-Match`-style primitive to replace (verified against the code; see
   * docs/team-vault-plan.md Fas 3). */
  private lastKnownRemoteEntry: FileEntry | null | undefined = undefined;
  /** The local file's `revision` as of the last successful push OR pull — i.e. "this revision is
   * known to match what's on the remote". `undefined` means never synced from this instance.
   * `pullFromRemote` compares this against the local file's *current* `revision` before
   * overwriting it: a mismatch means local mutations (shared-profile edits, membership changes)
   * happened since the last sync and were never pushed — pulling now would silently discard them
   * (see `TeamVaultUnpushedChangesError`). Distinct from `lastKnownRemoteEntry`, which tracks the
   * *remote* side for push's conflict check. */
  private lastSyncedRevision: number | undefined = undefined;
  private readonly pinPrompter?: TeamVaultPinPrompter;

  constructor(options: TeamVaultServiceOptions = {}) {
    this.cryptoService = options.cryptoService ?? new TeamVaultCryptoService();
    this.pinPrompter = options.pinPrompter;

    let baseDir: string;
    try {
      baseDir = app.getPath('userData');
    } catch {
      baseDir = path.join(os.homedir(), '.sshs3');
    }
    this.filePath = options.filePath ?? path.join(baseDir, 'team-vault.json');
    this.identityDir = options.identityDir ?? path.join(baseDir, 'team-vault-identities');
  }

  getFilePath(): string {
    return this.filePath;
  }

  isUnlocked(): boolean {
    return this.unlockedVaultKey !== null;
  }

  /** Clears the Vault Key from memory — call on app lock/quit, same as `SyncCryptoService.lock()`. */
  lock(): void {
    this.unlockedVaultKey = null;
    this.unlockedAsRecipientId = null;
  }

  /** Derived entirely from the plaintext `accessHeader` (§2.3) — never requires unlocking. */
  async getStatus(): Promise<TeamVaultStatus> {
    const file = await this.readFile();
    if (!file) {
      return { exists: false, unlocked: this.isUnlocked(), filePath: this.filePath };
    }
    const members: TeamVaultMemberSummary[] = file.accessHeader.map((e) => ({
      recipientId: e.recipientId,
      role: e.role,
      addedAt: e.addedAt,
    }));
    return {
      exists: true,
      vaultId: file.vaultId,
      vaultName: file.vaultName,
      members,
      adminCount: members.filter((m) => m.role === 'admin').length,
      unlocked: this.isUnlocked(),
      filePath: this.filePath,
    };
  }

  /** Builds the PIN/touch callback bundle `TeamVaultCryptoService` needs for a pty-backed
   * `age-plugin-yubikey` call, routed through `pinPrompter` (the app's existing Askpass modal
   * and touch banner — see `TeamVaultPinPrompter`). Without a configured `pinPrompter` (most
   * tests, whose fake crypto service never actually prompts), `requestPin` fails loudly instead
   * of hanging forever waiting for a UI that doesn't exist. */
  private buildPtyCallbacks(sessionId?: string): AgePtyPromptCallbacks {
    const prompter = this.pinPrompter;
    if (!prompter) {
      return {
        requestPin: async () => {
          throw new Error('Team Vault PIN prompting is not wired up (missing pinPrompter)');
        },
        onTouchRequested: () => {},
        onTouchCleared: () => {},
      };
    }
    const { onPresenceRequested, onPresenceCleared } = prompter.makePresenceNotifier(
      sessionId,
      'Touch your security key now to confirm'
    );
    return {
      requestPin: (promptText, retry) => prompter.promptForPinDirect(promptText, 'smartcard', undefined, retry),
      onTouchRequested: onPresenceRequested,
      onTouchCleared: onPresenceCleared,
    };
  }

  /** Generates a fresh recipient from the caller's own PIV card — used both by the admin
   * enrolling themselves at vault creation and by any later member joining (§4.3). */
  async enrollOwnPivRecipient(): Promise<{ recipient: string; identityFilePath: string }> {
    return this.cryptoService.enrollOwnPivRecipient(this.identityDir, this.buildPtyCallbacks());
  }

  /**
   * Initiates the vault (§4.1): generates the Vault Key, wraps it for the creating admin and for
   * a freshly generated recovery identity, writes the file. The recovery identity's plaintext is
   * returned exactly once — the caller must show it to the admin for printing and never persist
   * it anywhere in the app.
   */
  async createVault(
    selfRecipientId: string,
    selfAgeRecipient: string,
    vaultName = ''
  ): Promise<{ recoveryIdentity: string }> {
    return this.queueMutation(async () => {
      if (await this.readFile()) {
        throw new Error('A Team Vault already exists on this machine');
      }

      const vaultKey = this.cryptoService.generateVaultKey();
      const vaultId = `vlt_${crypto.randomUUID()}`;
      const now = new Date().toISOString();
      const trimmedName = vaultName.trim();

      const selfEntry: TeamVaultAccessEntry = {
        recipientId: selfRecipientId,
        role: 'admin',
        method: 'piv-rsa-oaep',
        ageRecipient: selfAgeRecipient,
        wrappedVaultKey: await this.cryptoService.wrapVaultKeyForRecipient(vaultKey, selfAgeRecipient),
        addedAt: now,
        addedBy: selfRecipientId,
      };

      const { identity: recoveryIdentity, recipient: recoveryRecipient } =
        await this.cryptoService.generateRecoveryIdentity();

      const recovery = {
        recipientId: 'recovery-key-1',
        ageRecipient: recoveryRecipient,
        wrappedVaultKey: await this.cryptoService.wrapVaultKeyForRecipient(vaultKey, recoveryRecipient),
      };
      const accessHeader = [selfEntry];
      const file: TeamVaultFile = {
        formatVersion: FORMAT_VERSION,
        vaultId,
        vaultName: trimmedName || undefined,
        revision: 1,
        updatedAt: now,
        updatedBy: selfRecipientId,
        accessHeader,
        recovery,
        encryptedPayload: this.cryptoService.encryptPayload(vaultKey, vaultId, FORMAT_VERSION, '{}'),
        accessHeaderMac: this.cryptoService.computeAccessHeaderMac(
          vaultKey,
          vaultId,
          1,
          trimmedName,
          accessHeader,
          recovery
        ),
      };

      await this.writeFile(file);
      this.unlockedVaultKey = vaultKey;
      this.unlockedAsRecipientId = selfRecipientId;

      return { recoveryIdentity };
    });
  }

  /** Pure public-key wrap, no card/PIN involved on either side (§4.3) — requires the Vault Key
   * already unlocked in this session (e.g. right after `createVault`, or via `unlock()`) AND the
   * acting identity to be an admin (`requireUnlockedAsAdmin`). The audit `addedBy` is always the
   * recipient that actually unlocked this session, never a caller-supplied value (see
   * `unlockedAsRecipientId`'s doc comment). */
  async addMember(recipientId: string, ageRecipient: string, role: TeamVaultRole): Promise<void> {
    return this.queueMutation(async () => {
      const file = await this.requireFile();
      const vaultKey = this.requireUnlocked();
      const addedBy = this.requireUnlockedAsAdmin(file);
      if (file.accessHeader.some((e) => e.recipientId === recipientId)) {
        throw new Error(`"${recipientId}" is already a member of this vault`);
      }

      file.accessHeader.push({
        recipientId,
        role,
        method: 'piv-rsa-oaep',
        ageRecipient,
        wrappedVaultKey: await this.cryptoService.wrapVaultKeyForRecipient(vaultKey, ageRecipient),
        addedAt: new Date().toISOString(),
        addedBy,
      });
      await this.commitHeaderMutation(file, vaultKey, addedBy);
    });
  }

  /** Shared tail of every admin mutation that only touches the plaintext header (`addMember`,
   * `setRole`, `renameVault` — NOT `removeMember`, which also re-keys and re-encrypts the
   * payload, a materially different operation): bump `revision`, stamp `updatedAt`/`updatedBy`,
   * recompute `accessHeaderMac`, persist. Pulled out after a reviewer noted that four
   * independently hand-written copies of this exact sequence is exactly the kind of duplication
   * that caused several of this file's own prior fix commits — a future admin mutation written by
   * copy-pasting one of these can no longer accidentally omit the revision bump or the MAC
   * recompute, since there's only one place that does either. */
  private async commitHeaderMutation(file: TeamVaultFile, vaultKey: Buffer, updatedBy: string): Promise<void> {
    file.revision += 1;
    file.updatedAt = new Date().toISOString();
    file.updatedBy = updatedBy;
    file.accessHeaderMac = this.cryptoService.computeAccessHeaderMac(
      vaultKey,
      file.vaultId,
      file.revision,
      file.vaultName ?? '',
      file.accessHeader,
      file.recovery
    );
    await this.writeFile(file);
  }

  /**
   * Offboarding (§4.3): a fresh Vault Key, the payload re-encrypted under it, and every
   * *remaining* recipient (plus the recovery key) re-wrapped for it — the removed recipient's old
   * wrap still exists in any S3 version history (Fas 3), so they keep whatever they already
   * synced but lose all future updates. Returns the remaining admin count so the caller can warn,
   * not block, when it drops below 2 (§4.3's multi-admin rule is advisory). Requires the acting
   * identity to be an admin (`requireUnlockedAsAdmin`), not merely unlocked.
   */
  async removeMember(recipientId: string): Promise<{ remainingAdmins: number }> {
    return this.queueMutation(async () => {
      const file = await this.requireFile();
      const vaultKey = this.requireUnlocked();
      const removedBy = this.requireUnlockedAsAdmin(file);
      if (!file.accessHeader.some((e) => e.recipientId === recipientId)) {
        throw new Error(`"${recipientId}" is not a member of this vault`);
      }

      const plaintext = this.cryptoService.decryptPayload(
        vaultKey,
        file.vaultId,
        file.formatVersion,
        file.encryptedPayload
      );

      const remaining = file.accessHeader.filter((e) => e.recipientId !== recipientId);
      const newVaultKey = this.cryptoService.generateVaultKey();
      const now = new Date().toISOString();

      const rewrapped: TeamVaultAccessEntry[] = [];
      for (const entry of remaining) {
        rewrapped.push({
          ...entry,
          wrappedVaultKey: await this.cryptoService.wrapVaultKeyForRecipient(newVaultKey, entry.ageRecipient),
        });
      }

      const newRevision = file.revision + 1;
      const newRecovery = {
        ...file.recovery,
        wrappedVaultKey: await this.cryptoService.wrapVaultKeyForRecipient(newVaultKey, file.recovery.ageRecipient),
      };

      const updated: TeamVaultFile = {
        ...file,
        revision: newRevision,
        updatedAt: now,
        updatedBy: removedBy,
        accessHeader: rewrapped,
        recovery: newRecovery,
        encryptedPayload: this.cryptoService.encryptPayload(newVaultKey, file.vaultId, file.formatVersion, plaintext),
        accessHeaderMac: this.cryptoService.computeAccessHeaderMac(
          newVaultKey,
          file.vaultId,
          newRevision,
          file.vaultName ?? '',
          rewrapped,
          newRecovery
        ),
        // Proves to anyone still holding the OLD key (`vaultKey`, about to be replaced below)
        // that THIS specific rotation is the real one — see `TeamVaultRotationProofError`'s doc
        // comment and `computeRotationProof`'s.
        prevKeyProof: this.cryptoService.computeRotationProof(
          vaultKey,
          file.vaultId,
          newRevision,
          file.vaultName ?? '',
          rewrapped,
          newRecovery
        ),
      };

      await this.writeFile(updated);
      this.unlockedVaultKey = newVaultKey;

      return { remainingAdmins: rewrapped.filter((e) => e.role === 'admin').length };
    });
  }

  /** Role is UI-only — every member already shares the same Vault Key by design, so changing it
   * never needs re-keying (§4.3). Requires the acting identity to actually be an admin
   * (`requireUnlockedAsAdmin`) — a plain member being merely unlocked isn't enough, otherwise any
   * member could promote themselves. Needs the Vault Key itself too (not just the identity),
   * since the access header's MAC must be recomputed. */
  async setRole(recipientId: string, role: TeamVaultRole): Promise<void> {
    return this.queueMutation(async () => {
      const file = await this.requireFile();
      const vaultKey = this.requireUnlocked();
      const updatedBy = this.requireUnlockedAsAdmin(file);
      const entry = file.accessHeader.find((e) => e.recipientId === recipientId);
      if (!entry) {
        throw new Error(`"${recipientId}" is not a member of this vault`);
      }
      entry.role = role;
      await this.commitHeaderMutation(file, vaultKey, updatedBy);
    });
  }

  /** Cosmetic-only rename (not a security boundary — same reasoning as the rest of the shared
   * metadata), but kept admin-gated like `setRole` for coherence with the rest of membership/vault
   * management, and tamper-evident via the recomputed `accessHeaderMac` so a bucket-write-access
   * holder can't silently rename the vault without the real Vault Key. */
  async renameVault(vaultName: string): Promise<void> {
    return this.queueMutation(async () => {
      const file = await this.requireFile();
      const vaultKey = this.requireUnlocked();
      const updatedBy = this.requireUnlockedAsAdmin(file);
      const trimmed = vaultName.trim();
      file.vaultName = trimmed || undefined;
      await this.commitHeaderMutation(file, vaultKey, updatedBy);
    });
  }

  /** Decrypts the current payload (shared SSH/S3 profiles, docs/team-vault-plan.md §3) — requires
   * the vault unlocked. Returns an empty payload (not an error) if the vault was created before
   * this feature existed and still holds the original `'{}'`. */
  async getPayload(): Promise<TeamVaultPayload> {
    const file = await this.requireFile();
    const vaultKey = this.requireUnlocked();
    return this.decryptPayload(file, vaultKey);
  }

  /** Same as `getPayload()`, but strips the password/secret fields of every shared profile when
   * the caller is a plain member (not admin, not the recovery identity) — the renderer calls
   * this, never `getPayload()` directly, so a member's secret never crosses the IPC boundary.
   * `hasPassword`/`hasSecretAccessKey` are set so the UI can still show "a secret is set" without
   * revealing it. Connecting to a profile does NOT go through this method — see
   * `resolveProfileForConnect`, which main-process-only callers use to get the real secret back. */
  async getPayloadForRenderer(): Promise<TeamVaultPayload> {
    const file = await this.requireFile();
    const vaultKey = this.requireUnlocked();
    const recipientId = this.requireUnlockedRecipientId();
    const payload = await this.decryptPayload(file, vaultKey);
    if (this.isSelfAdmin(file, recipientId)) {
      return payload;
    }
    return {
      ...payload,
      ssh: payload.ssh.map((p) => redactSshSecrets(p)),
      s3: payload.s3.map((p) => redactS3Secrets(p)),
    };
  }

  /** Main-process-only: resolves a shared profile's full config, including its secret fields,
   * for establishing an actual connection. Any unlocked member may connect (same as
   * `requireUnlocked` alone guarantees) — unlike `getPayloadForRenderer`, this must never be
   * wired to an IPC handler that echoes its return value back to the renderer as-is, or a
   * member's secret would leak the same way redaction is meant to prevent. */
  async resolveProfileForConnect(
    profileType: 'ssh' | 's3',
    profileId: string
  ): Promise<SSHConnectionConfig | S3Config> {
    const file = await this.requireFile();
    const vaultKey = this.requireUnlocked();
    const payload = await this.decryptPayload(file, vaultKey);
    const list = profileType === 'ssh' ? payload.ssh : payload.s3;
    const profile = list.find((p) => p.id === profileId);
    if (!profile) {
      throw new Error(`Team Vault ${profileType} profile not found: ${profileId}`);
    }
    return profile;
  }

  /** Any unlocked member (not just an admin — unlike membership mutations) may add or edit a
   * shared profile: profiles aren't a trust boundary the way membership is, and requiring admin
   * here would make the feature far less useful day-to-day. The password/passphrase/proxy
   * password fields are the one exception (see `guardSshSecretWrite`): only an admin may set or
   * change those, and a non-admin's write always keeps whatever secret was already stored, since
   * a member never actually holds the real value to round-trip in the first place. Upserts by
   * `id`. */
  async saveSSHProfile(profile: SSHConnectionConfig): Promise<void> {
    if (!profile?.id) {
      throw new Error('Profile ID is required');
    }
    return this.queueMutation(async () => {
      const file = await this.requireFile();
      const vaultKey = this.requireUnlocked();
      const recipientId = this.requireUnlockedRecipientId();
      const isAdmin = this.isSelfAdmin(file, recipientId);
      const payload = await this.decryptPayload(file, vaultKey);
      const index = payload.ssh.findIndex((p) => p.id === profile.id);
      const existing = index >= 0 ? payload.ssh[index] : undefined;
      const incoming = withoutPin(profile);
      const stamped: SSHConnectionConfig = {
        ...(isAdmin ? incoming : guardSshSecretWrite(incoming, existing)),
        updatedAt: new Date().toISOString(),
      };
      if (index >= 0) {
        payload.ssh[index] = stamped;
      } else {
        payload.ssh.push(stamped);
      }
      await this.persistPayload(file, vaultKey, payload);
    });
  }

  async deleteSSHProfile(id: string): Promise<void> {
    return this.queueMutation(async () => {
      const file = await this.requireFile();
      const vaultKey = this.requireUnlocked();
      const payload = await this.decryptPayload(file, vaultKey);
      payload.ssh = payload.ssh.filter((p) => p.id !== id);
      await this.persistPayload(file, vaultKey, payload);
    });
  }

  /** Same password-field exception as `saveSSHProfile` (see its doc comment), applied to
   * `secretAccessKey`/`sessionToken` via `guardS3SecretWrite`. */
  async saveS3Profile(profile: S3Config): Promise<void> {
    if (!profile?.id) {
      throw new Error('Profile ID is required');
    }
    return this.queueMutation(async () => {
      const file = await this.requireFile();
      const vaultKey = this.requireUnlocked();
      const recipientId = this.requireUnlockedRecipientId();
      const isAdmin = this.isSelfAdmin(file, recipientId);
      const payload = await this.decryptPayload(file, vaultKey);
      const index = payload.s3.findIndex((p) => p.id === profile.id);
      const existing = index >= 0 ? payload.s3[index] : undefined;
      const stamped: S3Config = {
        ...(isAdmin ? profile : guardS3SecretWrite(profile, existing)),
        updatedAt: new Date().toISOString(),
      };
      if (index >= 0) {
        payload.s3[index] = stamped;
      } else {
        payload.s3.push(stamped);
      }
      await this.persistPayload(file, vaultKey, payload);
    });
  }

  async deleteS3Profile(id: string): Promise<void> {
    return this.queueMutation(async () => {
      const file = await this.requireFile();
      const vaultKey = this.requireUnlocked();
      const payload = await this.decryptPayload(file, vaultKey);
      payload.s3 = payload.s3.filter((p) => p.id !== id);
      await this.persistPayload(file, vaultKey, payload);
    });
  }

  private decryptPayload(file: TeamVaultFile, vaultKey: Buffer): TeamVaultPayload {
    const plaintext = this.cryptoService.decryptPayload(vaultKey, file.vaultId, file.formatVersion, file.encryptedPayload);
    try {
      const parsed = JSON.parse(plaintext);
      const ssh = Array.isArray(parsed?.ssh) ? parsed.ssh : [];
      const s3 = Array.isArray(parsed?.s3) ? parsed.s3 : [];
      const folders = Array.isArray(parsed?.folders) ? parsed.folders : [];
      const folderIcons =
        parsed?.folderIcons && typeof parsed.folderIcons === 'object' && !Array.isArray(parsed.folderIcons)
          ? parsed.folderIcons
          : {};
      // Defense in depth against a legacy entry stored by an older app version that still wrote
      // a `pin` — never surfaced on read, same as it's never accepted on write (withoutPin).
      return {
        ssh: ssh.map((p: SSHConnectionConfig) => withoutPin(p)),
        s3,
        folders,
        folderIcons,
        ...(parsed?.folderDescriptions && typeof parsed.folderDescriptions === 'object' && !Array.isArray(parsed.folderDescriptions)
          ? { folderDescriptions: parsed.folderDescriptions }
          : {}),
        ...(Array.isArray(parsed?.workspaceMemories) ? { workspaceMemories: parsed.workspaceMemories } : {}),
        ...(Array.isArray(parsed?.activityLog) ? { activityLog: parsed.activityLog } : {}),
      };
    } catch {
      // The original `createVault` payload is the literal string '{}' (pre-dating this feature),
      // not a parse error — either way, treat as empty rather than throwing.
      return { ssh: [], s3: [], folders: [], folderIcons: {} };
    }
  }

  /** Returns the currently unlocked recipient ID, or undefined when locked. */
  getUnlockedRecipientId(): string | undefined {
    return this.unlockedAsRecipientId ?? undefined;
  }

  /** Appends a secret-scrubbed activity event to the shared Team Vault payload if unlocked. */
  async recordWorkspaceActivity(event: WorkspaceActivityEvent): Promise<void> {
    if (!this.unlockedVaultKey) return;
    return this.queueMutation(async () => {
      const file = await this.readFile();
      if (!file || !this.unlockedVaultKey) return;
      const payload = this.decryptPayload(file, this.unlockedVaultKey);
      const existing = payload.activityLog ?? [];
      const filtered = existing.filter((item) => item.id !== event.id);
      filtered.push({
        ...event,
        actor: event.actor || this.unlockedAsRecipientId || 'member',
      });
      const activityLog = filtered.sort((a, b) => a.at - b.at).slice(-500);
      await this.persistPayload(file, this.unlockedVaultKey, { ...payload, activityLog });
    });
  }

  /** Upserts a shared AI memory or skill inside the Team Vault payload if unlocked. */
  async saveWorkspaceMemory(entry: WorkspaceMemoryEntry): Promise<void> {
    if (!this.unlockedVaultKey) return;
    return this.queueMutation(async () => {
      const file = await this.readFile();
      if (!file || !this.unlockedVaultKey) return;
      const payload = this.decryptPayload(file, this.unlockedVaultKey);
      const existing = (payload.workspaceMemories ?? []).filter((m) => m.id !== entry.id);
      existing.push({
        ...entry,
        author: entry.author || this.unlockedAsRecipientId || 'member',
      });
      await this.persistPayload(file, this.unlockedVaultKey, { ...payload, workspaceMemories: existing });
    });
  }

  /** Deletes a shared AI memory or skill from the Team Vault payload if unlocked. */
  async deleteWorkspaceMemory(id: string): Promise<void> {
    if (!this.unlockedVaultKey) return;
    return this.queueMutation(async () => {
      const file = await this.readFile();
      if (!file || !this.unlockedVaultKey) return;
      const payload = this.decryptPayload(file, this.unlockedVaultKey);
      if (!payload.workspaceMemories) return;
      const workspaceMemories = payload.workspaceMemories.filter((m) => m.id !== id);
      await this.persistPayload(file, this.unlockedVaultKey, { ...payload, workspaceMemories });
    });
  }

  /** Sets or clears a shared folder's description inside the Team Vault payload if unlocked. */
  async setTeamFolderDescription(folderPath: string, description: string | undefined): Promise<void> {
    const trimmed = normalizeFolderPath(folderPath);
    if (!trimmed || !this.unlockedVaultKey) return;
    const file = await this.readFile();
    if (file && this.unlockedVaultKey) {
      const payload = this.decryptPayload(file, this.unlockedVaultKey);
      const folderDescriptions = { ...(payload.folderDescriptions ?? {}) };
      if (description?.trim()) folderDescriptions[trimmed] = description.trim();
      else delete folderDescriptions[trimmed];
      await this.persistPayload(file, this.unlockedVaultKey, { ...payload, folderDescriptions });
    }
  }

  /** Creates an (initially empty) shared folder — same purpose as `ProfileStore.saveFolder` for
   * personal profiles, just synced via the vault payload instead of kept local. Any unlocked
   * member may organize shared profiles, not just an admin (same reasoning as
   * `saveSSHProfile`). `path` is a `/`-separated tree path (e.g. `"Acme Infra/Cluster A"`) —
   * segments are trimmed and empty segments rejected, but intermediate ancestors need not already
   * exist as their own entries (the renderer's tree builder synthesizes them from any deeper
   * path). */
  async saveTeamFolder(folderPath: string): Promise<void> {
    const trimmed = normalizeFolderPath(folderPath);
    if (!trimmed) {
      throw new Error('Folder name is required');
    }
    return this.queueMutation(async () => {
      const file = await this.requireFile();
      const vaultKey = this.requireUnlocked();
      const payload = await this.decryptPayload(file, vaultKey);
      const folders = payload.folders ?? [];
      if (!folders.includes(trimmed)) {
        folders.push(trimmed);
      }
      await this.persistPayload(file, vaultKey, { ...payload, folders });
    });
  }

  /** Renames a shared folder, cascading to every descendant folder entry and every profile's
   * `group` whose path is the folder itself or starts with `folderPath + '/'` — unlike the
   * personal `ProfileStore.renameFolder` (exact-match only, no nesting), a Team Vault folder path
   * can have arbitrarily deep children that must move with it. */
  async renameTeamFolder(oldPath: string, newPath: string): Promise<void> {
    const trimmedOld = normalizeFolderPath(oldPath);
    const trimmedNew = normalizeFolderPath(newPath);
    if (!trimmedNew) {
      throw new Error('New folder name is required');
    }
    if (trimmedOld === trimmedNew) return;
    return this.queueMutation(async () => {
      const file = await this.requireFile();
      const vaultKey = this.requireUnlocked();
      const payload = await this.decryptPayload(file, vaultKey);
      const remap = (p: string) => remapFolderPath(p, trimmedOld, trimmedNew);

      const folders = (payload.folders ?? []).map(remap);
      if (!folders.includes(trimmedNew)) {
        folders.push(trimmedNew);
      }
      const ssh = payload.ssh.map((p) => (p.group ? { ...p, group: remap(p.group) } : p));
      const s3 = payload.s3.map((p) => (p.group ? { ...p, group: remap(p.group) } : p));
      const folderIcons: Record<string, string> = {};
      for (const [path, icon] of Object.entries(payload.folderIcons ?? {})) {
        folderIcons[remap(path)] = icon;
      }

      await this.persistPayload(file, vaultKey, { ...payload, ssh, s3, folders: Array.from(new Set(folders)), folderIcons });
    });
  }

  /** Deletes a shared folder and every descendant folder entry. Affected profiles (the folder
   * itself or any descendant) either lose their `group` (become ungrouped, the default) or — if
   * `deleteProfiles` is set — are removed from the vault outright, mirroring `ProfileStore`'s
   * `deleteFolder(name, deleteProfiles)`. Team profiles have no tombstone/soft-delete concept
   * (unlike personal ones): a Team Vault "delete" always just drops the entry from the payload. */
  async deleteTeamFolder(folderPath: string, deleteProfiles = false): Promise<void> {
    const trimmed = normalizeFolderPath(folderPath);
    if (!trimmed) return;
    return this.queueMutation(async () => {
      const file = await this.requireFile();
      const vaultKey = this.requireUnlocked();
      const payload = await this.decryptPayload(file, vaultKey);
      const affected = (group: string | undefined) => !!group && isSelfOrDescendant(group, trimmed);

      const folders = (payload.folders ?? []).filter((f) => !isSelfOrDescendant(f, trimmed));
      const ssh = deleteProfiles ? payload.ssh.filter((p) => !affected(p.group)) : payload.ssh.map((p) => (affected(p.group) ? { ...p, group: undefined } : p));
      const s3 = deleteProfiles ? payload.s3.filter((p) => !affected(p.group)) : payload.s3.map((p) => (affected(p.group) ? { ...p, group: undefined } : p));
      const folderIcons: Record<string, string> = {};
      for (const [path, icon] of Object.entries(payload.folderIcons ?? {})) {
        if (!isSelfOrDescendant(path, trimmed)) folderIcons[path] = icon;
      }

      await this.persistPayload(file, vaultKey, { ...payload, ssh, s3, folders, folderIcons });
    });
  }

  /** Sets (or, with `icon` undefined, clears back to the default) a folder's icon — any unlocked
   * member may organize shared folders, same reasoning as `saveTeamFolder`/profile edits. `icon`
   * is validated by the IPC handler against `TEAM_FOLDER_ICONS` before this is ever called; this
   * layer doesn't re-validate it, same division of responsibility as the rest of this file's
   * handler-vs-service validation split. */
  async setTeamFolderIcon(folderPath: string, icon: string | undefined): Promise<void> {
    const trimmed = normalizeFolderPath(folderPath);
    if (!trimmed) {
      throw new Error('Folder name is required');
    }
    return this.queueMutation(async () => {
      const file = await this.requireFile();
      const vaultKey = this.requireUnlocked();
      const payload = await this.decryptPayload(file, vaultKey);
      const folderIcons = { ...(payload.folderIcons ?? {}) };
      if (icon) {
        folderIcons[trimmed] = icon;
      } else {
        delete folderIcons[trimmed];
      }
      await this.persistPayload(file, vaultKey, { ...payload, folderIcons });
    });
  }

  /** Re-encrypts and writes `payload` as the vault's new `encryptedPayload`, bumping `revision`
   * and recomputing `accessHeaderMac` even though `accessHeader`/`recovery` themselves don't
   * change here — the MAC covers `revision` (see `TeamVaultFile.accessHeaderMac`'s doc comment),
   * which always bumps on a mutating write, so it must always be recomputed too. */
  private async persistPayload(file: TeamVaultFile, vaultKey: Buffer, payload: TeamVaultPayload): Promise<void> {
    const updatedBy = this.requireUnlockedRecipientId();
    const newRevision = file.revision + 1;
    const updated: TeamVaultFile = {
      ...file,
      revision: newRevision,
      updatedAt: new Date().toISOString(),
      updatedBy,
      encryptedPayload: this.cryptoService.encryptPayload(vaultKey, file.vaultId, file.formatVersion, JSON.stringify(payload)),
      accessHeaderMac: this.cryptoService.computeAccessHeaderMac(
        vaultKey,
        file.vaultId,
        newRevision,
        file.vaultName ?? '',
        file.accessHeader,
        file.recovery
      ),
    };
    await this.writeFile(updated);
  }

  /** Removes the Team Vault from THIS machine only — the local file and the in-memory unlocked
   * state. Deliberately never touches the remote S3 copy (if any): that's reachable through the
   * app's own generic S3 file manager if the admin explicitly wants to destroy it for the whole
   * team too, a much higher-blast-radius action than forgetting it locally. Admin only
   * (`requireUnlockedAsAdmin`). The caller (`teamVaultHandlers.ts`) is responsible for also
   * clearing `TeamVaultConfigStore`'s remembered self-identity, same as it sets it after
   * enroll/create/unlock — `TeamVaultService` has no dependency on that store. */
  async deleteVault(): Promise<void> {
    return this.queueMutation(async () => {
      const file = await this.requireFile();
      this.requireUnlockedAsAdmin(file);
      await fs.unlink(this.filePath).catch((err) => {
        if (err?.code !== 'ENOENT') throw err;
      });
      this.lock();
      this.lastKnownRemoteEntry = undefined;
      this.lastSyncedRevision = undefined;
    });
  }

  /** Unwraps the Vault Key for `recipientId` (a member or the recovery identity) using
   * `identityFilePath`, and caches it for the rest of this session. See the class doc comment for
   * the unresolved PIN-prompt caveat. */
  async unlock(recipientId: string, identityFilePath: string): Promise<void> {
    const file = await this.requireFile();
    const source =
      file.accessHeader.find((e) => e.recipientId === recipientId) ??
      (file.recovery.recipientId === recipientId ? file.recovery : undefined);
    if (!source) {
      throw new Error(`"${recipientId}" is not a recipient of this vault`);
    }
    const vaultKey = await this.cryptoService.unwrapVaultKey(
      source.wrappedVaultKey,
      identityFilePath,
      this.buildPtyCallbacks(recipientId)
    );
    // Defense in depth, not the primary control (see `TeamVaultRotationProofError`'s doc comment
    // — `pullFromRemote` is what actually keeps a forged file out of local storage in the first
    // place). This only catches a LOCAL file that's internally inconsistent — e.g. corrupted on
    // disk, or some future bug writing one without recomputing the MAC — since
    // `computeAccessHeaderMac` with the just-unwrapped key must reproduce exactly what's already
    // stored in `accessHeaderMac` for any header this service itself ever wrote.
    const expectedMac = this.cryptoService.computeAccessHeaderMac(
      vaultKey,
      file.vaultId,
      file.revision,
      file.vaultName ?? '',
      file.accessHeader,
      file.recovery
    );
    if (expectedMac !== file.accessHeaderMac) {
      throw new TeamVaultHeaderIntegrityError();
    }
    this.unlockedVaultKey = vaultKey;
    this.unlockedAsRecipientId = recipientId;
  }

  /**
   * Guided counterpart to `unlock()` for someone who only has the recovery identity TEXT
   * (printed/saved at vault creation, never written to a file by the app — see
   * `generateRecoveryIdentity`), not a file path and not the `'recovery-key-1'` recipientId. Both
   * are handled internally here, never by the renderer: the recipientId is fixed (the recovery
   * entry's id never varies, see `createVault`), and the pasted text — a private key — is fed to
   * `age` through a FIFO, never written to disk (see `TeamVaultCryptoService.withRecoveryIdentity`).
   */
  async unlockWithRecoveryText(identityText: string): Promise<void> {
    const file = await this.requireFile();
    await this.cryptoService.withRecoveryIdentity(identityText, (identityPath) =>
      this.unlock(file.recovery.recipientId, identityPath)
    );
  }

  /** Must be called whenever the configured S3 target/remoteBasePath changes — otherwise a stat
   * recorded against a *previous* target would be compared against the newly configured one on
   * the next push, producing a spurious (or worse, falsely-absent) conflict. Same reasoning as
   * `ProfileSyncService.resetRemoteState()`. */
  resetRemoteState(): void {
    this.lastKnownRemoteEntry = undefined;
    this.lastSyncedRevision = undefined;
  }

  /** Whether a vault file already exists at the remote target — used by the UI to offer "Pull
   * existing vault" instead of "Create Vault" when no local file exists yet (§4.3: a new member
   * joins an existing team vault, they don't create their own). */
  async hasRemoteVault(provider: IStorageProvider, remoteBasePath = ''): Promise<boolean> {
    return (await this.statOrNull(provider, this.remoteVaultPath(remoteBasePath))) !== null;
  }

  /**
   * Pushes the local vault file to the configured S3 target (docs/team-vault-plan.md Fas 3).
   * Serialized through `queueMutation` along with every local mutation and `pullFromRemote`, so a
   * push can never interleave with a concurrent local write or pull touching the same in-memory
   * state (`lastKnownRemoteEntry`, `unlockedVaultKey`).
   *
   * Two independent checks, not one, run before any byte is written remotely:
   * 1. **Identity.** Whenever something already exists at the remote path, its `vaultId` is read
   *    and compared to the local file's — regardless of whether this instance has ever observed
   *    the remote before. Holding S3 write access to a path is not the same thing as being a
   *    vault recipient (bucket IAM vs. vault membership are different trust domains), so a stat
   *    cache that starts `undefined` after every app restart must never be treated as "nothing to
   *    check" — that would silently let a brand-new local vault clobber a completely unrelated
   *    team's vault the first time it's pushed. Mismatch throws `TeamVaultForeignVaultError`.
   * 2. **Freshness.** Once identity is confirmed, `ProfileSyncService.checkNotChangedRemotely`'s
   *    proven size+mtime comparison (the real `S3StorageProvider` has no `If-Match`
   *    conditional-write primitive to use instead — verified, and not portable across S3/MinIO
   *    versions anyway) still applies when this instance has previously observed the remote,
   *    rejecting with `TeamVaultSyncConflictError` if someone else pushed since.
   */
  async pushToRemote(provider: IStorageProvider, remoteBasePath = ''): Promise<void> {
    return this.queueMutation(async () => {
      const file = await this.requireFile();
      const remotePath = this.remoteVaultPath(remoteBasePath);

      const current = await this.statOrNull(provider, remotePath);
      if (current !== null) {
        const remoteFile = await this.readRemoteVaultFile(provider, remotePath);
        if (remoteFile.vaultId !== file.vaultId) {
          throw new TeamVaultForeignVaultError();
        }
      }

      if (this.lastKnownRemoteEntry !== undefined) {
        const known = this.lastKnownRemoteEntry;
        const unchanged =
          (known === null && current === null) ||
          (known !== null && current !== null && known.size === current.size && known.mtime === current.mtime);
        if (!unchanged) {
          throw new TeamVaultSyncConflictError();
        }
      }

      await this.writeProviderFile(provider, remotePath, Buffer.from(JSON.stringify(file), 'utf-8'));
      this.lastKnownRemoteEntry = await this.statOrNull(provider, remotePath);
      this.lastSyncedRevision = file.revision;
    });
  }

  /**
   * Pulls the vault file from the configured S3 target and overwrites the local copy — used both
   * to catch up with changes pushed elsewhere and to join a vault that already exists remotely
   * (when no local file exists yet). Locks the vault afterwards UNLESS the held Vault Key is
   * proven to still work against the pulled file (the `accessHeaderMac` check below passing,
   * `keyProvenStillValid`): a `removeMember` elsewhere rotates the key, and reusing a now-stale
   * one blindly would be wrong — but an ordinary profile edit or a role change doesn't rotate
   * anything, so forcing a re-unlock on every pull would needlessly fight the background
   * auto-poll (`IpcBridge.runTeamVaultAutoPoll`), which must be able to pick up a plain shared-
   * profile change without surprise-locking the session.
   *
   * Refuses a pulled file whose `revision` goes backwards relative to the local copy
   * (`TeamVaultRollbackError`) — see `TeamVaultFile.revision`'s doc comment for why a bucket
   * write-access holder restoring an older version is a real, not theoretical, concern.
   *
   * Refuses outright when a local vault already exists but the session is locked
   * (`TeamVaultLockedForPullError`) — verifying the pulled header needs the Vault Key, so a
   * locked session has no way to tell a legitimate update from a forged one (see that error's
   * doc comment). Doesn't apply to a brand-new join (no local file yet), which has nothing to
   * verify against either way.
   *
   * Also refuses to overwrite local changes that were never pushed (`TeamVaultUnpushedChangesError`,
   * see `lastSyncedRevision`'s doc comment) unless `options.force` is set — there's no per-record
   * merge here (docs/team-vault-plan.md: a whole-file reject-and-pull-first model, same as push's
   * own conflict check), so silently overwriting would otherwise just discard whatever the admin
   * or a member edited locally since the last sync.
   */
  async pullFromRemote(provider: IStorageProvider, remoteBasePath = '', options: { force?: boolean } = {}): Promise<void> {
    return this.queueMutation(async () => {
      const remotePath = this.remoteVaultPath(remoteBasePath);
      const file = await this.readRemoteVaultFile(provider, remotePath);

      // Whether the currently-held Vault Key is proven to still decrypt the pulled file —
      // confirmed below via the accessHeaderMac check, the only place that's actually verified.
      // Starts false: a brand-new join (no localFile, nothing held yet) or an already-locked
      // session has nothing to preserve either way, and `lock()` on either is a no-op.
      let keyProvenStillValid = false;

      const localFile = await this.readFile();
      if (localFile) {
        // Verifying the pulled header against a tampered/forged entry requires the Vault Key
        // (see TeamVaultLockedForPullError's doc comment) — refuse outright rather than silently
        // persisting an unverifiable file over the one already trusted locally. A brand-new join
        // (localFile === null) has nothing to verify against either way, so this never blocks that.
        if (!this.unlockedVaultKey) {
          throw new TeamVaultLockedForPullError();
        }
        // Identity BEFORE freshness, and never skippable: `revision` is an ordinary field in an
        // unsigned JSON file, not a cryptographic guarantee — anyone with S3 write access (not
        // necessarily a real recipient) can substitute the entire vault with one of their own
        // choosing and simply pick a `revision` higher than ours, sailing straight past a
        // rollback check that only compares numbers. Checking `vaultId` first closes exactly that
        // bypass: a *different* vault, however "newer" it claims to be, is never silently
        // accepted as a continuation of this one. Leaving/joining a different vault on purpose
        // means deleting the local file first (so `localFile` is null here) — not something this
        // sync action does implicitly.
        if (file.vaultId !== localFile.vaultId) {
          throw new TeamVaultForeignVaultError();
        }
        if (
          !options.force &&
          this.lastSyncedRevision !== undefined &&
          localFile.revision !== this.lastSyncedRevision
        ) {
          throw new TeamVaultUnpushedChangesError();
        }
        if (file.revision < localFile.revision) {
          throw new TeamVaultRollbackError();
        }
        // Same vault, same-or-newer revision — but a bucket-write-access holder could still have
        // silently swapped an existing recipient's public key rather than the whole vault. See
        // `TeamVaultTamperedEntryError`'s doc comment for the two-step attack this closes.
        this.assertNoAgeRecipientTampering(localFile, file);

        // The tampering check above only catches a *substituted* existing recipient — it says
        // nothing about a wholly new, illegitimate entry a bucket-write-access holder could
        // inject (their own ageRecipient, no existing recipientId to collide with), which is
        // indistinguishable at the field level from a real addMember pushed from another machine.
        //
        // An earlier version of this check tried to catch that by requiring the payload to still
        // decrypt with our held key, but *only* for a single-step pull (`revision` exactly +1) —
        // which a reviewer correctly flagged as an ineffective control: `revision` is a plain,
        // attacker-chosen field, so the attacker simply picks a different delta (or the same
        // revision as ours) and walks straight past that narrow equality check. Verifying
        // `accessHeaderMac` instead has no such hole: it's valid only if computed with the real
        // Vault Key, for the exact `vaultId`/`revision`/`accessHeader`/`recovery` being pulled —
        // there is no revision value an attacker can choose their way around.
        //
        // When the entry count hasn't dropped, no rotation is claimed — verify `accessHeaderMac`
        // directly against our still-held key. It's valid only if computed with the real Vault
        // Key, for the exact `vaultId`/`revision`/`accessHeader`/`recovery` being pulled — there
        // is no revision value an attacker can choose their way around.
        if (this.unlockedVaultKey && file.accessHeader.length >= localFile.accessHeader.length) {
          const expectedMac = this.cryptoService.computeAccessHeaderMac(
            this.unlockedVaultKey,
            file.vaultId,
            file.revision,
            file.vaultName ?? '',
            file.accessHeader,
            file.recovery
          );
          if (expectedMac !== file.accessHeaderMac) {
            throw new TeamVaultHeaderIntegrityError();
          }
          keyProvenStillValid = true;
        } else if (this.unlockedVaultKey && file.accessHeader.length < localFile.accessHeader.length) {
          // A shrunk header claims a `removeMember` rotation happened — which is the ONLY
          // operation allowed to change the Vault Key, so `accessHeaderMac` (now keyed by a
          // DIFFERENT key than ours) can no longer be checked directly. Previously this branch
          // was skipped entirely, which let mere S3 write access — no member key or card
          // involved at all — forge a whole new Vault Key, wrap it to the remaining (public)
          // recipients, and have it accepted as a legitimate rotation. `prevKeyProof` closes
          // that: it's an HMAC over this exact new header, keyed by a subkey derived from the
          // Vault Key we're still holding (the real previous one) — only whoever actually
          // rotated away from that key could have produced it. See
          // `TeamVaultRotationProofError`'s doc comment for the multi-step-offline caveat.
          const expectedProof = this.cryptoService.computeRotationProof(
            this.unlockedVaultKey,
            file.vaultId,
            file.revision,
            file.vaultName ?? '',
            file.accessHeader,
            file.recovery
          );
          if (!file.prevKeyProof || expectedProof !== file.prevKeyProof) {
            throw new TeamVaultRotationProofError();
          }
          // keyProvenStillValid stays false: the proof shows this rotation is legitimate, not
          // that our now-superseded key still works — lock() below is still the right call.
        }
      }

      await this.writeFile(file);
      this.lastKnownRemoteEntry = await this.statOrNull(provider, remotePath);
      this.lastSyncedRevision = file.revision;
      // Only lock when the held key ISN'T proven still valid — e.g. after a removeMember
      // elsewhere rotated it (accessHeader.length dropped, so the check above never ran). A
      // background auto-poll (IpcBridge.runTeamVaultAutoPoll) pulling in a plain profile edit
      // from another member must not force a re-unlock every time; only an actual re-key should.
      if (!keyProvenStillValid) {
        this.lock();
      }
    });
  }

  /** Lightweight pre-check for a background poll (see `IpcBridge.runTeamVaultAutoPoll`): a
   * metadata-only `stat()` (no body download — `S3StorageProvider.stat()` issues a
   * `HeadObjectCommand`), compared against `lastKnownRemoteEntry` the same way `pushToRemote`'s
   * own freshness check does. Deliberately NOT run through `queueMutation` (read-only, mutates no
   * state) so a poll never has to wait behind an unrelated pending push/pull. */
  /**
   * Cryptographically verifies and merges concurrent local & remote Team Vault payloads
   * (SSH/S3 profiles, folders, shared AI memories, and terminal activity logs) when
   * multiple teammates are working simultaneously while the vault is unlocked.
   */
  async mergeWithRemote(provider: IStorageProvider, remoteBasePath = ''): Promise<boolean> {
    if (!this.unlockedVaultKey || !this.unlockedAsRecipientId) return false;
    return this.queueMutation(async () => {
      const localFile = await this.readFile();
      if (!localFile || !this.unlockedVaultKey || !this.unlockedAsRecipientId) return false;
      const remotePath = this.remoteVaultPath(remoteBasePath);
      const current = await this.statOrNull(provider, remotePath);
      if (!current) return false;

      const remoteFile = await this.readRemoteVaultFile(provider, remotePath);
      if (remoteFile.vaultId !== localFile.vaultId) {
        throw new TeamVaultForeignVaultError();
      }
      this.assertNoAgeRecipientTampering(localFile, remoteFile);
      if (remoteFile.accessHeader.length < localFile.accessHeader.length) {
        return false;
      }
      const expectedMac = this.cryptoService.computeAccessHeaderMac(
        this.unlockedVaultKey,
        remoteFile.vaultId,
        remoteFile.revision,
        remoteFile.vaultName ?? '',
        remoteFile.accessHeader,
        remoteFile.recovery
      );
      if (expectedMac !== remoteFile.accessHeaderMac) {
        throw new TeamVaultHeaderIntegrityError();
      }

      const localPayload = this.decryptPayload(localFile, this.unlockedVaultKey);
      const remotePayload = this.decryptPayload(remoteFile, this.unlockedVaultKey);

      const mergeByUpdatedAt = <T extends { id: string; updatedAt?: string | number }>(a: T[], b: T[]): T[] => {
        const map = new Map<string, T>();
        for (const item of a) map.set(item.id, item);
        for (const item of b) {
          const prev = map.get(item.id);
          if (!prev) {
            map.set(item.id, item);
            continue;
          }
          const tPrev = typeof prev.updatedAt === 'number' ? prev.updatedAt : Date.parse(String(prev.updatedAt || '')) || 0;
          const tNext = typeof item.updatedAt === 'number' ? item.updatedAt : Date.parse(String(item.updatedAt || '')) || 0;
          if (tNext >= tPrev) {
            map.set(item.id, item);
          }
        }
        return Array.from(map.values());
      };

      const activityMap = new Map<string, WorkspaceActivityEvent>();
      for (const evt of remotePayload.activityLog ?? []) activityMap.set(evt.id, evt);
      for (const evt of localPayload.activityLog ?? []) activityMap.set(evt.id, evt);
      const mergedActivity = Array.from(activityMap.values())
        .sort((x, y) => x.at - y.at)
        .slice(-500);

      const mergedPayload: TeamVaultPayload = {
        ssh: mergeByUpdatedAt(remotePayload.ssh ?? [], localPayload.ssh ?? []),
        s3: mergeByUpdatedAt(remotePayload.s3 ?? [], localPayload.s3 ?? []),
        folders: Array.from(new Set([...(remotePayload.folders ?? []), ...(localPayload.folders ?? [])])),
        folderIcons: { ...(remotePayload.folderIcons ?? {}), ...(localPayload.folderIcons ?? {}) },
        folderDescriptions: { ...(remotePayload.folderDescriptions ?? {}), ...(localPayload.folderDescriptions ?? {}) },
        workspaceMemories: mergeByUpdatedAt(remotePayload.workspaceMemories ?? [], localPayload.workspaceMemories ?? []),
        activityLog: mergedActivity,
      };

      const newRevision = Math.max(localFile.revision, remoteFile.revision) + 1;
      const mergedHeader =
        remoteFile.accessHeader.length >= localFile.accessHeader.length
          ? remoteFile.accessHeader
          : localFile.accessHeader;
      const mergedVaultName = localFile.vaultName ?? remoteFile.vaultName;
      const updated: TeamVaultFile = {
        ...localFile,
        vaultName: mergedVaultName,
        revision: newRevision,
        updatedAt: new Date().toISOString(),
        updatedBy: this.unlockedAsRecipientId,
        accessHeader: mergedHeader,
        encryptedPayload: this.cryptoService.encryptPayload(
          this.unlockedVaultKey,
          localFile.vaultId,
          localFile.formatVersion,
          JSON.stringify(mergedPayload)
        ),
        accessHeaderMac: this.cryptoService.computeAccessHeaderMac(
          this.unlockedVaultKey,
          localFile.vaultId,
          newRevision,
          mergedVaultName ?? '',
          mergedHeader,
          localFile.recovery
        ),
      };

      await this.writeFile(updated);
      await this.writeProviderFile(provider, remotePath, Buffer.from(JSON.stringify(updated), 'utf-8'));
      this.lastKnownRemoteEntry = await this.statOrNull(provider, remotePath);
      this.lastSyncedRevision = newRevision;
      return true;
    });
  }

  async hasRemoteChangedSinceLastSync(provider: IStorageProvider, remoteBasePath = ''): Promise<boolean> {
    const remotePath = this.remoteVaultPath(remoteBasePath);
    const current = await this.statOrNull(provider, remotePath);
    if (this.lastKnownRemoteEntry === undefined) {
      return current !== null;
    }
    const known = this.lastKnownRemoteEntry;
    const unchanged =
      (known === null && current === null) ||
      (known !== null && current !== null && known.size === current.size && known.mtime === current.mtime);
    return !unchanged;
  }

  /** Whether this machine has local Team Vault mutations that have never been pushed — used by
   * the background poll to decide whether a detected remote change can be pulled automatically
   * (see `lastSyncedRevision`'s doc comment) or must instead just be surfaced as a notice. */
  async hasUnpushedLocalChanges(): Promise<boolean> {
    const file = await this.readFile();
    if (!file || this.lastSyncedRevision === undefined) return false;
    return file.revision !== this.lastSyncedRevision;
  }

  /** Reads and fully validates a vault file from the remote — shared by `pushToRemote`'s identity
   * check and `pullFromRemote`, since both need the same untrusted-content guarantees. The threat
   * model elsewhere in this file already assumes mere S3 write access without real membership
   * (see every `TeamVault*Error` above), and without a size cap, that same attacker could upload
   * a multi-GB `vault.json` for every member's background auto-poll to fully download and
   * `JSON.parse()` on every tick — a straightforward remote DoS.
   *
   * Two layers, not one: a cheap `stat()` precheck rejects the common case (an honestly reported
   * oversized object) before ever attempting a download, and `readProviderFile`'s `maxBytes`
   * enforces the cap against what's actually received regardless — a `stat()`-then-download
   * precheck ALONE has a TOCTOU gap (whoever controls the object can serve a small size to
   * `stat()` and a huge body to the actual read moments later), so dropping either layer
   * reopens a real gap: the `stat()` precheck alone is racy, and `maxBytes` alone means every
   * oversized object is fully downloaded (on a provider whose `readFile()` is an opaque,
   * uninterruptible single call) before being rejected instead of never downloaded at all. */
  private async readRemoteVaultFile(provider: IStorageProvider, remotePath: string): Promise<TeamVaultFile> {
    const stat = await provider.stat(remotePath);
    if (stat.size > MAX_REMOTE_VAULT_FILE_SIZE) {
      throw new Error(
        `Remote Team Vault file is too large (${stat.size} bytes, max ${MAX_REMOTE_VAULT_FILE_SIZE}) — refusing to download it`
      );
    }
    const raw = await this.readProviderFile(provider, remotePath, MAX_REMOTE_VAULT_FILE_SIZE);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf-8'));
    } catch {
      throw new Error('Remote Team Vault file is not valid JSON');
    }
    assertValidVaultFile(parsed);
    return parsed;
  }

  private remoteVaultPath(remoteBasePath: string): string {
    return joinPaths('s3', remoteBasePath, REMOTE_VAULT_FILENAME);
  }

  private assertNoAgeRecipientTampering(localFile: TeamVaultFile, remoteFile: TeamVaultFile): void {
    const knownAgeRecipients = new Map<string, string>();
    for (const entry of localFile.accessHeader) {
      knownAgeRecipients.set(entry.recipientId, entry.ageRecipient);
    }
    knownAgeRecipients.set(localFile.recovery.recipientId, localFile.recovery.ageRecipient);

    for (const entry of [...remoteFile.accessHeader, remoteFile.recovery]) {
      const known = knownAgeRecipients.get(entry.recipientId);
      if (known !== undefined && known !== entry.ageRecipient) {
        throw new TeamVaultTamperedEntryError(entry.recipientId);
      }
    }
  }

  // Same provider-capability fallback as ProfileSyncService.readProviderFile/writeProviderFile:
  // IStorageProvider.readFile/writeFile are optional on the interface (not every provider
  // implements the convenience form), so fall back to the stream API any provider must support.
  //
  // `maxBytes`, when given, is enforced against the actual bytes received, not a prior `stat()` —
  // on the streaming path it aborts (destroys the stream) the moment the running total would
  // exceed it, so an oversized remote object is never fully buffered in memory; on the
  // convenience `readFile()` path (an opaque single-call read this code can't interrupt
  // mid-flight) it's checked once the full buffer is back, which still refuses to hand an
  // oversized result on to `JSON.parse()`/`assertValidVaultFile()`.
  private async readProviderFile(provider: IStorageProvider, remotePath: string, maxBytes?: number): Promise<Buffer> {
    if (typeof provider.readFile === 'function') {
      const data = await provider.readFile(remotePath);
      if (maxBytes !== undefined && data.length > maxBytes) {
        throw new Error(`Remote file is too large (${data.length} bytes, max ${maxBytes}) — refusing to use it`);
      }
      return data;
    }
    const stream = await provider.createReadStream(remotePath);
    const chunks: Buffer[] = [];
    let total = 0;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        action();
      };
      stream.on('data', (chunk: Buffer) => {
        if (settled) return;
        total += chunk.length;
        if (maxBytes !== undefined && total > maxBytes) {
          (stream as unknown as { destroy?: () => void }).destroy?.();
          settle(() => reject(new Error(`Remote file is too large (over ${maxBytes} bytes) — aborting download`)));
          return;
        }
        chunks.push(chunk);
      });
      stream.on('end', () => settle(resolve));
      stream.on('error', (err: unknown) => settle(() => reject(err)));
    });
    return Buffer.concat(chunks);
  }

  private async writeProviderFile(provider: IStorageProvider, remotePath: string, buffer: Buffer): Promise<void> {
    if (typeof provider.writeFile === 'function') {
      await provider.writeFile(remotePath, buffer, { mode: 0o600, size: buffer.length });
      return;
    }
    const stream = await provider.createWriteStream(remotePath, { mode: 0o600, size: buffer.length });
    await new Promise<void>((resolve, reject) => {
      stream.on('error', reject);
      stream.end(buffer, () => resolve());
    });
  }

  private async statOrNull(provider: IStorageProvider, remotePath: string): Promise<FileEntry | null> {
    try {
      return await provider.stat(remotePath);
    } catch (err: any) {
      if (this.isNotFoundError(err)) return null;
      throw err;
    }
  }

  // Same heuristics as ProfileSyncService.isNotFoundError — distinguishes "the object doesn't
  // exist" from other failures (network errors, auth errors) which must propagate, not be
  // swallowed into a false "not found".
  private isNotFoundError(err: any): boolean {
    if (!err) return false;
    const code = err.code || err.$metadata?.httpStatusCode;
    if (code === 'ENOENT' || code === 2 || code === 404 || code === 'NotFound' || code === 'NoSuchKey') {
      return true;
    }
    const name = err.name || '';
    if (name === 'NoSuchKey' || name === 'NotFound') return true;
    const msg = typeof err.message === 'string' ? err.message.toLowerCase() : '';
    if (msg.includes('no such file') || msg.includes('file does not exist') || msg.includes('does not exist') || msg.includes('not found')) {
      if (msg.includes('host not found') || msg.includes('socket not found') || msg.includes('getaddrinfo') || msg.includes('connect')) {
        return false;
      }
      return true;
    }
    return false;
  }

  private requireUnlocked(): Buffer {
    if (!this.unlockedVaultKey) {
      throw new Error('Unlock the Team Vault before making changes to it');
    }
    return this.unlockedVaultKey;
  }

  private requireUnlockedRecipientId(): string {
    if (!this.unlockedAsRecipientId) {
      throw new Error('Unlock the Team Vault before making changes to it');
    }
    return this.unlockedAsRecipientId;
  }

  /** Beyond merely being unlocked (any valid member, admin or not — what
   * `requireUnlockedRecipientId` alone guarantees), membership mutations and vault deletion
   * require the acting identity to actually hold the `admin` role, or be the recovery identity
   * (full restoration access by design, §4.1 — not a regular member, never demotable). Without
   * this, any plain member could already add/remove/promote other members or delete the vault —
   * a real gap `requireUnlockedRecipientId` alone never closed. */
  private requireUnlockedAsAdmin(file: TeamVaultFile): string {
    const recipientId = this.requireUnlockedRecipientId();
    if (!this.isSelfAdmin(file, recipientId)) {
      throw new Error('Only a Team Vault admin can do this');
    }
    return recipientId;
  }

  /** Non-throwing version of the check inside `requireUnlockedAsAdmin` — used to decide whether
   * to redact secrets from `getPayloadForRenderer()` and whether a profile save may touch a
   * secret field, without rejecting the read/save outright for a plain member. The recovery
   * identity counts as admin here too, same as `requireUnlockedAsAdmin`. */
  private isSelfAdmin(file: TeamVaultFile, recipientId: string): boolean {
    if (recipientId === file.recovery.recipientId) return true;
    const entry = file.accessHeader.find((e) => e.recipientId === recipientId);
    return entry?.role === 'admin';
  }

  private async readFile(): Promise<TeamVaultFile | null> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      return JSON.parse(raw) as TeamVaultFile;
    } catch (err: any) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
  }

  private async requireFile(): Promise<TeamVaultFile> {
    const file = await this.readFile();
    if (!file) {
      throw new Error('No Team Vault exists on this machine yet');
    }
    return file;
  }

  private async writeFile(file: TeamVaultFile): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(file, null, 2), { encoding: 'utf-8', mode: 0o600 });
    try {
      await fs.chmod(this.filePath, 0o600);
    } catch {
      // Ignore chmod failures on non-POSIX filesystems.
    }
  }

  private queueMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const resultPromise = this.writeQueue.then(mutation, mutation);
    this.writeQueue = resultPromise.then(
      () => {},
      () => {}
    );
    return resultPromise;
  }
}
