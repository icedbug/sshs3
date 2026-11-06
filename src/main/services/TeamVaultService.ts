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
  TeamVaultSyncPreview,
  WorkspaceActivityEvent,
  WorkspaceMemoryEntry,
} from '../../shared/types/teamVault';
import type { SSHConnectionConfig } from '../../shared/types/ssh';
import type { FileEntry, IStorageProvider, S3Config } from '../../shared/types/storage';
import type { AskpassPromptKind, StorageConnectConfig } from '../../shared/types/ipc';
import type { AskpassPromptRetryContext } from '../smartcard/AskpassServer';
import { joinPaths } from '../transfer/TransferPipeline';
import { TeamVaultCryptoService, type AgePtyPromptCallbacks } from './TeamVaultCryptoService';
import { createLogger } from '../log/Logger';
import { normalizeK8sList, removeK8sProfile, toTeamK8sProfile, upsertK8sProfile } from './teamVaultK8s';
import type { K8sProfile } from '../../shared/types/kubernetes';
import { writeFileAtomic } from '../storage/atomicFile';
import { assertOutwardSyncAllowed } from '../demo/outwardSync';

import {
  CURRENT_FORMAT_VERSION,
  SUPPORTED_FORMAT_VERSIONS,
  TeamVaultFormatDowngradeError,
  TeamVaultUnsupportedFormatError,
  migrateToCurrentFormat,
  serializePayload,
  unknownPayloadKeys,
} from './teamVaultFormat';

export { TeamVaultFormatDowngradeError, TeamVaultUnsupportedFormatError };

const teamVaultLog = createLogger('team-vault');

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
 * rotation. `prevKeyProof` closes that: it's an HMAC over the new header keyed by a subkey derived
 * from the Vault Key being rotated AWAY from — only whoever actually held that real previous key
 * could produce it, so a bucket-write-access-only attacker generating their own fresh key cannot
 * forge it.
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
 * easy to miss since it lives one level down from the fields this is named after. Also reused by
 * `IpcBridge.buildTeamVaultStatus` to redact the vault's own sync *target* config before it ever
 * reaches the renderer (not just member profiles) — the target's secret is shared team
 * infrastructure, not a single member's own credential, so it gets no exception. */
export function redactS3Secrets(profile: S3Config): S3Config {
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

// Same shape teamVaultHandlers.ts's VAULT_ID_PATTERN already enforces at the IPC boundary —
// duplicated here (not imported, to keep this file's own validation self-contained, same posture
// as AGE_RECIPIENT_SHAPE above) so a decoded invite's vaultId can never carry something that
// wasn't actually minted by this service's own `vlt_${uuid}` scheme before it's adopted as a
// filesystem path segment elsewhere (TeamVaultService.getFilePath, identityDirFor).
const INVITE_VAULT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

// `age -a`'s own ASCII-armor envelope (age-encryption.org/v1) — matched anywhere in the pasted
// text, not anchored to the start, same tolerance `parseTeamVaultJoinInfo` already gives the
// join-info blob. This is the primary extraction path: it survives a chat client prefixing every
// line with a quote marker (`> `) or inserting its own commentary before/after the real content,
// neither of which the old "the first line must be exactly ..." check tolerated. The lazy
// [\s\S]*? sits between two fixed, non-overlapping literal anchors (no nested/overlapping
// quantifiers), so this can't backtrack catastrophically regardless of input; the IPC boundary
// (teamVaultHandlers.ts's requireInviteText) also caps the input at 64KB before it ever reaches
// this regex.
const AGE_ARMOR_PATTERN = /-----BEGIN AGE ENCRYPTED FILE-----[\s\S]*?-----END AGE ENCRYPTED FILE-----/;

/** Strips a leading quote marker (`>`, possibly repeated for nested quoting, with optional
 * surrounding whitespace) from every line — the only mangling a chat/email client's "reply with
 * quote" feature does that would otherwise break recognizing either the header line or the armor
 * markers below. Always safe to apply unconditionally: `>` never legitimately starts a line of
 * age's own armor output or of `buildInvite`'s header line, so a text that was never quoted comes
 * back byte-for-byte unchanged. */
function stripQuoteMarkers(text: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => line.replace(/^[ \t>]+/, ''))
    .join('\n');
}

/** Extracts just the armored ciphertext from a pasted invite, tolerating the same real-world
 * mangling `parseTeamVaultJoinInfo` already tolerates for the join-info blob (surrounding
 * chat/email quoting, extra commentary, blank lines) — a prior version of this function required
 * the human-readable `"sshs3 Team Vault invite for <recipientId>\n"` header `buildInvite`
 * prepends to be the text's exact, unquoted first line, which broke the moment a chat client
 * prefixed it with its own `> ` quote marker on reply.
 *
 * Primary path: find `age -a`'s own `-----BEGIN/END AGE ENCRYPTED FILE-----` envelope anywhere in
 * the (de-quoted) text — this is reliable regardless of what surrounds it, including the header
 * line itself. Falls back to the old "strip the header line, if present" behavior only when no
 * armor envelope is found at all (e.g. a test fake that isn't real age output, or a paste that
 * somehow dropped the BEGIN/END markers) — `decryptWithIdentity` still fails naturally on
 * anything that isn't actually decryptable either way. */
function extractInviteCiphertext(inviteText: string): string {
  const dequoted = stripQuoteMarkers(inviteText);
  const armorMatch = dequoted.match(AGE_ARMOR_PATTERN);
  if (armorMatch) {
    return armorMatch[0];
  }
  const trimmed = dequoted.trim();
  const newlineIndex = trimmed.indexOf('\n');
  if (newlineIndex === -1) return trimmed;
  const firstLine = trimmed.slice(0, newlineIndex);
  if (/^sshs3 Team Vault invite for /.test(firstLine)) {
    return trimmed.slice(newlineIndex + 1).trim();
  }
  return trimmed;
}

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
  if (file && Number.isInteger(file.formatVersion) && file.formatVersion > CURRENT_FORMAT_VERSION) {
    throw new TeamVaultUnsupportedFormatError(file.formatVersion);
  }
  if (
    !file ||
    !SUPPORTED_FORMAT_VERSIONS.includes(file.formatVersion) ||
    typeof file.vaultId !== 'string' ||
    !file.vaultId ||
    (file.vaultName !== undefined && typeof file.vaultName !== 'string') ||
    (file.vaultDescription !== undefined && typeof file.vaultDescription !== 'string') ||
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
    typeof file.updatedAt !== 'string' ||
    typeof file.updatedBy !== 'string' ||
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
  /**
   * Waits (with an "insert your token" prompt) until the PIV card is plugged in; throws if the user
   * dismisses it. Called before any age-plugin-yubikey run, never from inside one.
   */
  ensurePivPresent?(context: string): Promise<void>;
}

/** The narrow slice of `TeamVaultConfigStore` this service needs — originally just for
 * `buildInvite()` to learn the vault's configured S3 target, now also used to persist/restore
 * `VaultRuntimeState.lastKnownRemoteEntry` across restarts (see `hydratedState`) — injected
 * rather than taking the whole config store, same reasoning as `TeamVaultPinPrompter` above
 * (keeps the dependency explicit and easy to fake in tests). */
export interface TeamVaultConfigReader {
  getConfig(
    vaultId: string
  ): Promise<{
    target?: StorageConnectConfig;
    remoteBasePath?: string;
    lastKnownRemoteEntry?: FileEntry | null;
    lastSyncedRevision?: number;
    remoteFormatVersion?: number;
  }>;
  setLastKnownRemoteEntry(
    vaultId: string,
    entry: FileEntry | null,
    lastSyncedRevision?: number,
    remoteFormatVersion?: number
  ): Promise<void>;
  clearSyncState?(vaultId: string): Promise<void>;
}

export interface TeamVaultServiceOptions {
  cryptoService?: TeamVaultCryptoService;
  /** Overrides the base directory vault files/identities are written under — tests only;
   * production always uses userData. Per-vault paths are derived from it: `<baseDir>/team-vaults/
   * <vaultId>.json` and `<baseDir>/team-vault-identities/<vaultId>/`. */
  baseDir?: string;
  /** Required in production for `unlock()`/`enrollOwnPivRecipient()` to actually prompt for a
   * PIN/touch (see docs/team-vault-plan.md's hardware verification notes) — omitted in most
   * tests, whose fake crypto service never needs to prompt for anything. */
  pinPrompter?: TeamVaultPinPrompter;
  /** Required in production for `buildInvite()` to read the vault's configured S3 target —
   * omitted in most tests that never call it. */
  configStore?: TeamVaultConfigReader;
  /** Called after a vault file was upgraded to the current format on this machine (see `upgradeFormatIfNeeded`), so the app can push
   * it. Fire-and-forget; omitted in most tests. */
  onFormatUpgraded?: (vaultId: string) => void;
}

/** Per-vault in-memory state — never persisted, cleared on `lock()`/app quit, and deliberately
 * kept in its own `Map` entry per `vaultId` so unlocking one team's vault can never leak or be
 * mistaken for another's (see `TeamVaultService`'s class doc comment). */
interface VaultRuntimeState {
  unlockedVaultKey: Buffer | null;
  /** The recipientId that produced `unlockedVaultKey` (via `createVault` or `unlock`) — the
   * authoritative identity for `addedBy`/`removedBy`/`updatedBy` audit fields. Deliberately NOT a
   * caller-supplied parameter on `addMember`/`removeMember`/`setRole`: a renderer asserting an
   * arbitrary "I am X" string for an audit trail that's shared with the whole team (§2.3:
   * `updated_by` exists so a member can tell "who made the last change" without asking S3) would
   * make that field purely decorative instead of authoritative. */
  unlockedAsRecipientId: string | null;
  /** Last observed remote `FileEntry` for this vault's file, used for optimistic concurrency on
   * push (see `pushToRemote`) — `undefined` means never observed from this instance (no check
   * to do yet), `null` means observed as "doesn't exist yet". Same pattern as
   * `ProfileSyncService.lastKnownRemoteState`/`checkNotChangedRemotely`, which the real S3
   * provider has no `If-Match`-style primitive to replace (verified against the code; see
   * docs/team-vault-plan.md Fas 3). */
  lastKnownRemoteEntry: FileEntry | null | undefined;
  /** This vault's local file's `revision` as of the last successful push OR pull — i.e. "this
   * revision is known to match what's on the remote". `undefined` means never synced from this
   * instance. `pullFromRemote` compares this against the local file's *current* `revision` before
   * overwriting it: a mismatch means local mutations (shared-profile edits, membership changes)
   * happened since the last sync and were never pushed — pulling now would silently discard them
   * (see `TeamVaultUnpushedChangesError`). Distinct from `lastKnownRemoteEntry`, which tracks the
   * *remote* side for push's conflict check. */
  lastSyncedRevision: number | undefined;
  /** The highest `formatVersion` the remote vault file has had when this instance last pushed or pulled it (never lowered).
   * `pullFromRemote` refuses a lower-format file once this is set — see `TeamVaultFormatDowngradeError`. */
  remoteFormatVersion: number | undefined;
}

function freshRuntimeState(): VaultRuntimeState {
  return {
    unlockedVaultKey: null,
    unlockedAsRecipientId: null,
    lastKnownRemoteEntry: undefined,
    lastSyncedRevision: undefined,
    remoteFormatVersion: undefined,
  };
}

/**
 * Owns every local Team Vault file this machine knows about
 * (`<userData>/team-vaults/<vaultId>.json`, same directory convention as `SyncConfigStore`) and
 * the in-memory, never-persisted Vault Key of each once unlocked — exactly the
 * `SyncCryptoService`/§4.2 pattern: unlocked fresh every app session (or after an explicit
 * `lock(vaultId)`), never cached to disk or the OS keyring.
 *
 * A single instance serves every team a user belongs to: runtime state (the unlocked key, sync
 * cursors) lives in an internal `Map<vaultId, VaultRuntimeState>`, and every public method below
 * takes `vaultId` as its leading parameter. This is deliberate, not incidental — see
 * docs/team-vault-plan.md's multi-team plan §3 for why a single service with an internal map was
 * chosen over one instance per team (avoids `IpcBridge` needing its own duplicate bookkeeping).
 * The critical invariant this map design exists to uphold: unlocking vault A must never unlock,
 * read, or leak key material for vault B — every mutation/read below only ever touches the one
 * `VaultRuntimeState` entry named by its own `vaultId` argument.
 *
 * PIN-prompt wiring (docs/team-vault-plan.md's hardware verification notes): `unlock()`/
 * `enrollOwnPivRecipient()` relay PIN/touch prompts through an injected `TeamVaultPinPrompter`
 * (see `buildPtyCallbacks()`), which in production is `IpcBridge.promptForPinDirect`/
 * `makePresenceNotifier` — the same Askpass modal and touch banner every other PIV/FIDO2 flow in
 * the app already uses.
 */
export class TeamVaultService {
  private readonly cryptoService: TeamVaultCryptoService;
  private readonly vaultsDir: string;
  private readonly identitiesBaseDir: string;
  private readonly states = new Map<string, VaultRuntimeState>();
  private readonly writeQueues = new Map<string, Promise<void>>();
  private readonly pinPrompter?: TeamVaultPinPrompter;
  private readonly configStore?: TeamVaultConfigReader;
  private readonly onFormatUpgraded?: (vaultId: string) => void;

  constructor(options: TeamVaultServiceOptions = {}) {
    this.cryptoService = options.cryptoService ?? new TeamVaultCryptoService();
    this.pinPrompter = options.pinPrompter;
    this.configStore = options.configStore;
    this.onFormatUpgraded = options.onFormatUpgraded;

    let baseDir: string;
    if (options.baseDir) {
      baseDir = options.baseDir;
    } else {
      try {
        baseDir = app.getPath('userData');
      } catch {
        baseDir = path.join(os.homedir(), '.sshs3');
      }
    }
    this.vaultsDir = path.join(baseDir, 'team-vaults');
    this.identitiesBaseDir = path.join(baseDir, 'team-vault-identities');
  }

  getFilePath(vaultId: string): string {
    return path.join(this.vaultsDir, `${vaultId}.json`);
  }

  /** Every vault this machine has a local file for — a plain directory listing, same "derivable
   * without unlocking" guarantee as `getStatus` (see its doc comment). Drives the team list/
   * switcher UI and `listStatuses()`. */
  async listVaultIds(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.vaultsDir);
      return entries.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length));
    } catch (err: any) {
      if (err?.code === 'ENOENT') return [];
      throw err;
    }
  }

  /** `listVaultIds()` + `getStatus()` for each — the one call a team-list UI needs at mount. */
  async listStatuses(): Promise<TeamVaultStatus[]> {
    const vaultIds = await this.listVaultIds();
    return Promise.all(vaultIds.map((vaultId) => this.getStatus(vaultId)));
  }

  private stateFor(vaultId: string): VaultRuntimeState {
    let state = this.states.get(vaultId);
    if (!state) {
      state = freshRuntimeState();
      this.states.set(vaultId, state);
    }
    return state;
  }

  /** Same as `stateFor`, but also restores `lastKnownRemoteEntry` from `TeamVaultConfigStore` the
   * first time this process sees `vaultId`, instead of leaving it `undefined` (== "never synced,
   * from this instance's point of view") on every fresh app start. Only affects the sync preview's
   * "remote changed" hint and `pushToRemote`'s optimistic-concurrency check — never the actual
   * trust-boundary checks (foreign-vault/rollback detection), which always re-verify fresh against
   * the remote regardless of this value (see `TeamVaultConfigEntry.lastKnownRemoteEntry`'s doc
   * comment and docs/team-vault-plan.md's 2026-10-08 security review). Best-effort: a missing
   * `configStore` (most tests) or a read failure just leaves the state as `stateFor` would. */
  private async hydratedState(vaultId: string): Promise<VaultRuntimeState> {
    const state = this.stateFor(vaultId);
    if (
      (state.lastKnownRemoteEntry === undefined || state.lastSyncedRevision === undefined || state.remoteFormatVersion === undefined) &&
      this.configStore
    ) {
      try {
        const config = await this.configStore.getConfig(vaultId);
        if (state.lastKnownRemoteEntry === undefined && config.lastKnownRemoteEntry !== undefined) {
          state.lastKnownRemoteEntry = config.lastKnownRemoteEntry;
        }
        // Without this, unpushed local edits made before a restart look "in sync" and the next pull overwrites them.
        if (state.lastSyncedRevision === undefined && config.lastSyncedRevision !== undefined) {
          state.lastSyncedRevision = config.lastSyncedRevision;
        }
        if (state.remoteFormatVersion === undefined && config.remoteFormatVersion !== undefined) {
          state.remoteFormatVersion = config.remoteFormatVersion;
        }
      } catch (err) {
        teamVaultLog.warn(`Failed to restore the last known remote state for vaultId=${vaultId} (non-fatal):`, err);
      }
    }
    return state;
  }

  /** Sets `state.lastKnownRemoteEntry` and persists it via `TeamVaultConfigStore`, so the next
   * process start can restore it via `hydratedState` instead of starting blank — see that
   * method's doc comment. Best-effort on the persist: an in-memory-only failure here would just
   * reproduce today's "always unknown after restart" behavior, not corrupt anything. */
  private async setLastKnownRemoteEntry(
    vaultId: string,
    state: VaultRuntimeState,
    entry: FileEntry | null,
    syncedRevision?: number,
    remoteFormatVersion?: number
  ): Promise<void> {
    state.lastKnownRemoteEntry = entry;
    if (syncedRevision !== undefined) state.lastSyncedRevision = syncedRevision;
    if (remoteFormatVersion !== undefined) {
      state.remoteFormatVersion = Math.max(remoteFormatVersion, state.remoteFormatVersion ?? 0);
    }
    if (this.configStore) {
      try {
        await this.configStore.setLastKnownRemoteEntry(vaultId, entry, syncedRevision, remoteFormatVersion);
      } catch (err) {
        teamVaultLog.warn(`Failed to persist the last known remote state for vaultId=${vaultId} (non-fatal):`, err);
      }
    }
  }

  isUnlocked(vaultId: string): boolean {
    return this.states.get(vaultId)?.unlockedVaultKey != null;
  }

  /** Clears vault `vaultId`'s Vault Key from memory — call on app lock/quit (for every known
   * vault) or when the user explicitly locks one team, same as `SyncCryptoService.lock()`. Other
   * vaults' runtime state is untouched. */
  lock(vaultId: string): void {
    const state = this.states.get(vaultId);
    if (state) {
      state.unlockedVaultKey = null;
      state.unlockedAsRecipientId = null;
    }
  }

  /** Derived entirely from the plaintext `accessHeader` (§2.3) — never requires unlocking. */
  async getStatus(vaultId: string): Promise<TeamVaultStatus> {
    const filePath = this.getFilePath(vaultId);
    const file = await this.readFile(vaultId);
    if (!file) {
      return { exists: false, unlocked: this.isUnlocked(vaultId), filePath };
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
      vaultDescription: file.vaultDescription,
      members,
      adminCount: members.filter((m) => m.role === 'admin').length,
      unlocked: this.isUnlocked(vaultId),
      filePath,
    };
  }

  /** Builds the PIN/touch callback bundle `TeamVaultCryptoService` needs for a pty-backed
   * `age-plugin-yubikey` call, routed through `pinPrompter` (the app's existing Askpass modal
   * and touch banner — see `TeamVaultPinPrompter`). Without a configured `pinPrompter` (most
   * tests, whose fake crypto service never actually prompts), `requestPin` fails loudly instead
   * of hanging forever waiting for a UI that doesn't exist. */
  /** `contextLabel`, when given, is forwarded to `promptForPinDirect` so the PIN/touch modal's
   * context row can show which team/operation the prompt is for (e.g. "Team Vault: Acme Infra")
   * instead of staying blank — `SmartcardPinModal.resolvePromptContext` already reads this field
   * first, before falling back to guessing from the prompt text, so passing a real string here is
   * the only change needed for it to show up. */
  private buildPtyCallbacks(sessionId?: string, contextLabel?: string): AgePtyPromptCallbacks {
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
      requestPin: (promptText, retry) => prompter.promptForPinDirect(promptText, 'smartcard', contextLabel, retry),
      onTouchRequested: onPresenceRequested,
      onTouchCleared: onPresenceCleared,
    };
  }

  /** Generates a fresh recipient from the caller's own PIV card — used both by the admin
   * enrolling themselves at vault creation and by any later member joining (§4.3). Deliberately
   * NOT scoped to a `vaultId`: when creating a brand-new vault the id doesn't exist yet
   * (`createVault` mints it), and when generating a recipient to send an admin for a vault this
   * machine is about to join, the vaultId isn't locally known either (that's the whole reason the
   * admin has to `addMember` before this machine can `unlock`). `vaultId`, when the caller already
   * knows it (e.g. enrolling a second identity for a team already partially set up), simply
   * scopes where the identity file is written — purely a filing convenience, not a security
   * boundary (the identity file's own content is what matters). */
  async enrollOwnPivRecipient(vaultId?: string): Promise<{ recipient: string; identityFilePath: string }> {
    const contextLabel = vaultId ? `Team Vault: ${vaultId}` : 'Team Vault: new identity';
    await this.pinPrompter?.ensurePivPresent?.(contextLabel);
    return this.cryptoService.enrollOwnPivRecipient(this.identityDirFor(vaultId), this.buildPtyCallbacks(undefined, contextLabel));
  }

  private identityDirFor(vaultId?: string): string {
    return vaultId ? path.join(this.identitiesBaseDir, vaultId) : this.identitiesBaseDir;
  }

  /**
   * Initiates a new vault (§4.1): mints a fresh `vaultId`, generates the Vault Key, wraps it for
   * the creating admin and for a freshly generated recovery identity, writes the file. The
   * recovery identity's plaintext is returned exactly once — the caller must show it to the admin
   * for printing and never persist it anywhere in the app. Returns the minted `vaultId` so the
   * caller (renderer, eventually) can adopt it as the newly selected vault.
   */
  async createVault(
    selfRecipientId: string,
    selfAgeRecipient: string,
    vaultName = ''
  ): Promise<{ vaultId: string; recoveryIdentity: string }> {
    const vaultId = `vlt_${crypto.randomUUID()}`;
    return this.queueMutation(vaultId, async () => {
      const vaultKey = this.cryptoService.generateVaultKey();
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
      const unsigned = {
        formatVersion: CURRENT_FORMAT_VERSION,
        vaultId,
        vaultName: trimmedName || undefined,
        revision: 1,
        updatedAt: now,
        updatedBy: selfRecipientId,
        accessHeader,
        recovery,
        encryptedPayload: this.cryptoService.encryptPayload(vaultKey, vaultId, CURRENT_FORMAT_VERSION, '{}'),
      };
      const file: TeamVaultFile = { ...unsigned, accessHeaderMac: this.cryptoService.computeFileMac(vaultKey, unsigned) };

      await this.writeFile(vaultId, file);
      const state = this.stateFor(vaultId);
      state.unlockedVaultKey = vaultKey;
      state.unlockedAsRecipientId = selfRecipientId;

      return { vaultId, recoveryIdentity };
    });
  }

  /** Pure public-key wrap, no card/PIN involved on either side (§4.3) — requires the Vault Key
   * already unlocked in this session (e.g. right after `createVault`, or via `unlock()`) AND the
   * acting identity to be an admin (`requireUnlockedAsAdmin`). The audit `addedBy` is always the
   * recipient that actually unlocked this session, never a caller-supplied value (see
   * `VaultRuntimeState.unlockedAsRecipientId`'s doc comment). */
  async addMember(vaultId: string, recipientId: string, ageRecipient: string, role: TeamVaultRole): Promise<void> {
    return this.queueMutation(vaultId, async () => {
      const file = await this.requireFile(vaultId);
      const vaultKey = this.requireUnlocked(vaultId);
      const addedBy = this.requireUnlockedAsAdmin(vaultId, file);
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
      await this.commitHeaderMutation(vaultId, file, vaultKey, addedBy);
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
  private async commitHeaderMutation(
    vaultId: string,
    file: TeamVaultFile,
    vaultKey: Buffer,
    updatedBy: string
  ): Promise<void> {
    file.revision += 1;
    file.updatedAt = new Date().toISOString();
    file.updatedBy = updatedBy;
    file.accessHeaderMac = this.cryptoService.computeFileMac(vaultKey, file);
    await this.writeFile(vaultId, file);
  }

  /**
   * Offboarding (§4.3): a fresh Vault Key, the payload re-encrypted under it, and every
   * *remaining* recipient (plus the recovery key) re-wrapped for it — the removed recipient's old
   * wrap still exists in any S3 version history (Fas 3), so they keep whatever they already
   * synced but lose all future updates. Returns the remaining admin count so the caller can warn,
   * not block, when it drops below 2 (§4.3's multi-admin rule is advisory). Requires the acting
   * identity to be an admin (`requireUnlockedAsAdmin`), not merely unlocked.
   */
  async removeMember(vaultId: string, recipientId: string): Promise<{ remainingAdmins: number }> {
    return this.queueMutation(vaultId, async () => {
      const file = await this.requireFile(vaultId);
      const vaultKey = this.requireUnlocked(vaultId);
      const removedBy = this.requireUnlockedAsAdmin(vaultId, file);
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

      const rotated: TeamVaultFile = {
        ...file,
        revision: newRevision,
        updatedAt: now,
        updatedBy: removedBy,
        accessHeader: rewrapped,
        recovery: newRecovery,
        encryptedPayload: this.cryptoService.encryptPayload(newVaultKey, file.vaultId, file.formatVersion, plaintext),
      };
      const updated: TeamVaultFile = {
        ...rotated,
        accessHeaderMac: this.cryptoService.computeFileMac(newVaultKey, rotated),
        // Proves to anyone still holding the OLD key (`vaultKey`, about to be replaced below)
        // that THIS specific rotation is the real one — see `TeamVaultRotationProofError`'s doc
        // comment and `computeFileRotationProof`'s.
        prevKeyProof: this.cryptoService.computeFileRotationProof(vaultKey, rotated),
      };

      await this.writeFile(vaultId, updated);
      this.stateFor(vaultId).unlockedVaultKey = newVaultKey;

      return { remainingAdmins: rewrapped.filter((e) => e.role === 'admin').length };
    });
  }

  /** Role is UI-only — every member already shares the same Vault Key by design, so changing it
   * never needs re-keying (§4.3). Requires the acting identity to actually be an admin
   * (`requireUnlockedAsAdmin`) — a plain member being merely unlocked isn't enough, otherwise any
   * member could promote themselves. Needs the Vault Key itself too (not just the identity),
   * since the access header's MAC must be recomputed. */
  async setRole(vaultId: string, recipientId: string, role: TeamVaultRole): Promise<void> {
    return this.queueMutation(vaultId, async () => {
      const file = await this.requireFile(vaultId);
      const vaultKey = this.requireUnlocked(vaultId);
      const updatedBy = this.requireUnlockedAsAdmin(vaultId, file);
      const entry = file.accessHeader.find((e) => e.recipientId === recipientId);
      if (!entry) {
        throw new Error(`"${recipientId}" is not a member of this vault`);
      }
      entry.role = role;
      await this.commitHeaderMutation(vaultId, file, vaultKey, updatedBy);
    });
  }

  /** Cosmetic-only rename (not a security boundary — same reasoning as the rest of the shared
   * metadata), but kept admin-gated like `setRole` for coherence with the rest of membership/vault
   * management, and tamper-evident via the recomputed `accessHeaderMac` so a bucket-write-access
   * holder can't silently rename the vault without the real Vault Key. */
  async renameVault(vaultId: string, vaultName: string): Promise<void> {
    return this.queueMutation(vaultId, async () => {
      const file = await this.requireFile(vaultId);
      const vaultKey = this.requireUnlocked(vaultId);
      const updatedBy = this.requireUnlockedAsAdmin(vaultId, file);
      const trimmed = vaultName.trim();
      file.vaultName = trimmed || undefined;
      await this.commitHeaderMutation(vaultId, file, vaultKey, updatedBy);
    });
  }

  /** Sets (or, with an empty/whitespace-only string, clears) the vault's free-text description —
   * shown in the Connection Manager's per-team tab so a member can tell what the team is for
   * without asking the admin out of band. Same trust posture as `renameVault`: admin-gated,
   * cosmetic metadata (not a security boundary), tamper-evident via the recomputed
   * `accessHeaderMac` (see `commitHeaderMutation`). */
  async setDescription(vaultId: string, description: string): Promise<void> {
    return this.queueMutation(vaultId, async () => {
      const file = await this.requireFile(vaultId);
      const vaultKey = this.requireUnlocked(vaultId);
      const updatedBy = this.requireUnlockedAsAdmin(vaultId, file);
      const trimmed = description.trim();
      file.vaultDescription = trimmed || undefined;
      await this.commitHeaderMutation(vaultId, file, vaultKey, updatedBy);
    });
  }

  /** Decrypts the current payload (shared SSH/S3 profiles, docs/team-vault-plan.md §3) — requires
   * the vault unlocked. Returns an empty payload (not an error) if the vault was created before
   * this feature existed and still holds the original `'{}'`. */
  async getPayload(vaultId: string): Promise<TeamVaultPayload> {
    const file = await this.requireFile(vaultId);
    const vaultKey = this.requireUnlocked(vaultId);
    return this.decryptPayload(file, vaultKey);
  }

  /** Same as `getPayload()`, but strips the password/secret fields of every shared profile when
   * the caller is a plain member (not admin, not the recovery identity) — the renderer calls
   * this, never `getPayload()` directly, so a member's secret never crosses the IPC boundary.
   * `hasPassword`/`hasSecretAccessKey` are set so the UI can still show "a secret is set" without
   * revealing it. Connecting to a profile does NOT go through this method — see
   * `resolveProfileForConnect`, which main-process-only callers use to get the real secret back. */
  async getPayloadForRenderer(vaultId: string): Promise<TeamVaultPayload> {
    const file = await this.requireFile(vaultId);
    const vaultKey = this.requireUnlocked(vaultId);
    const recipientId = this.requireUnlockedRecipientId(vaultId);
    const payload = await this.decryptPayload(file, vaultKey);
    // Only the fields this version knows: keys it preserves but does not understand (`unknownKeys`) never reach the renderer, so
    // they can neither be shown unredacted nor depended on before a version that knows them exists.
    const known: TeamVaultPayload = {
      ssh: payload.ssh,
      s3: payload.s3,
      folders: payload.folders,
      folderIcons: payload.folderIcons,
      k8s: payload.k8s,
      ...(payload.folderDescriptions ? { folderDescriptions: payload.folderDescriptions } : {}),
      ...(payload.workspaceMemories ? { workspaceMemories: payload.workspaceMemories } : {}),
      ...(payload.activityLog ? { activityLog: payload.activityLog } : {}),
    };
    if (this.isSelfAdmin(file, recipientId)) {
      return known;
    }
    return {
      ...known,
      ssh: known.ssh.map((p) => redactSshSecrets(p)),
      s3: known.s3.map((p) => redactS3Secrets(p)),
    };
  }

  /** Main-process-only: resolves a shared profile's full config, including its secret fields,
   * for establishing an actual connection. Any unlocked member may connect (same as
   * `requireUnlocked` alone guarantees) — unlike `getPayloadForRenderer`, this must never be
   * wired to an IPC handler that echoes its return value back to the renderer as-is, or a
   * member's secret would leak the same way redaction is meant to prevent. */
  async resolveProfileForConnect(
    vaultId: string,
    profileType: 'ssh' | 's3',
    profileId: string
  ): Promise<SSHConnectionConfig | S3Config> {
    const file = await this.requireFile(vaultId);
    const vaultKey = this.requireUnlocked(vaultId);
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
  async saveSSHProfile(vaultId: string, profile: SSHConnectionConfig): Promise<void> {
    if (!profile?.id) {
      throw new Error('Profile ID is required');
    }
    return this.queueMutation(vaultId, async () => {
      const file = await this.requireFile(vaultId);
      const vaultKey = this.requireUnlocked(vaultId);
      const recipientId = this.requireUnlockedRecipientId(vaultId);
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
      await this.persistPayload(vaultId, file, vaultKey, payload);
    });
  }

  async deleteSSHProfile(vaultId: string, id: string): Promise<void> {
    return this.queueMutation(vaultId, async () => {
      const file = await this.requireFile(vaultId);
      const vaultKey = this.requireUnlocked(vaultId);
      const payload = await this.decryptPayload(file, vaultKey);
      payload.ssh = payload.ssh.filter((p) => p.id !== id);
      await this.persistPayload(vaultId, file, vaultKey, payload);
    });
  }

  /** Same password-field exception as `saveSSHProfile` (see its doc comment), applied to
   * `secretAccessKey`/`sessionToken` via `guardS3SecretWrite`. */
  async saveS3Profile(vaultId: string, profile: S3Config): Promise<void> {
    if (!profile?.id) {
      throw new Error('Profile ID is required');
    }
    return this.queueMutation(vaultId, async () => {
      const file = await this.requireFile(vaultId);
      const vaultKey = this.requireUnlocked(vaultId);
      const recipientId = this.requireUnlockedRecipientId(vaultId);
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
      await this.persistPayload(vaultId, file, vaultKey, payload);
    });
  }

  async deleteS3Profile(vaultId: string, id: string): Promise<void> {
    return this.queueMutation(vaultId, async () => {
      const file = await this.requireFile(vaultId);
      const vaultKey = this.requireUnlocked(vaultId);
      const payload = await this.decryptPayload(file, vaultKey);
      payload.s3 = payload.s3.filter((p) => p.id !== id);
      await this.persistPayload(vaultId, file, vaultKey, payload);
    });
  }

  /** Adds or edits a shared K8s cluster template. Any unlocked member may, same as other profile
   * edits: it holds no secret (the token only ever lives in a member's own kubeconfig). */
  async saveK8sProfile(vaultId: string, profile: K8sProfile): Promise<void> {
    const clean = toTeamK8sProfile(profile);
    return this.queueMutation(vaultId, async () => {
      const file = await this.requireFile(vaultId);
      const vaultKey = this.requireUnlocked(vaultId);
      const payload = await this.decryptPayload(file, vaultKey);
      const k8s = upsertK8sProfile(payload.k8s ?? [], clean, new Date().toISOString());
      await this.persistPayload(vaultId, file, vaultKey, { ...payload, k8s });
    });
  }

  async deleteK8sProfile(vaultId: string, id: string): Promise<void> {
    return this.queueMutation(vaultId, async () => {
      const file = await this.requireFile(vaultId);
      const vaultKey = this.requireUnlocked(vaultId);
      const payload = await this.decryptPayload(file, vaultKey);
      await this.persistPayload(vaultId, file, vaultKey, { ...payload, k8s: removeK8sProfile(payload.k8s ?? [], id) });
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
      const unknownKeys = unknownPayloadKeys(parsed);
      return {
        ssh: ssh.map((p: SSHConnectionConfig) => withoutPin(p)),
        s3,
        folders,
        folderIcons,
        k8s: normalizeK8sList(parsed?.k8s),
        ...(parsed?.folderDescriptions && typeof parsed.folderDescriptions === 'object' && !Array.isArray(parsed.folderDescriptions)
          ? { folderDescriptions: parsed.folderDescriptions }
          : {}),
        ...(Array.isArray(parsed?.workspaceMemories) ? { workspaceMemories: parsed.workspaceMemories } : {}),
        ...(Array.isArray(parsed?.activityLog) ? { activityLog: parsed.activityLog } : {}),
        ...(unknownKeys ? { unknownKeys } : {}),
      };
    } catch {
      // The original `createVault` payload is the literal string '{}' (pre-dating this feature),
      // not a parse error — either way, treat as empty rather than throwing.
      return { ssh: [], s3: [], folders: [], folderIcons: {}, k8s: [] };
    }
  }

  /** Returns the currently unlocked recipient ID, or undefined when locked. */
  getUnlockedRecipientId(vaultId: string): string | undefined {
    return this.states.get(vaultId)?.unlockedAsRecipientId ?? undefined;
  }

  /** Appends a secret-scrubbed activity event to the shared Team Vault payload if unlocked. */
  async recordWorkspaceActivity(vaultId: string, event: WorkspaceActivityEvent): Promise<void> {
    if (!this.isUnlocked(vaultId)) return;
    return this.queueMutation(vaultId, async () => {
      const file = await this.readFile(vaultId);
      const state = this.states.get(vaultId);
      const vaultKey = state?.unlockedVaultKey;
      if (!file || !vaultKey) return;
      const payload = this.decryptPayload(file, vaultKey);
      const existing = payload.activityLog ?? [];
      const filtered = existing.filter((item) => item.id !== event.id);
      filtered.push({
        ...event,
        actor: event.actor || state?.unlockedAsRecipientId || 'member',
      });
      const activityLog = filtered.sort((a, b) => a.at - b.at).slice(-500);
      await this.persistPayload(vaultId, file, vaultKey, { ...payload, activityLog });
    });
  }

  /** Upserts a shared AI memory or skill inside the Team Vault payload if unlocked. */
  async saveWorkspaceMemory(vaultId: string, entry: WorkspaceMemoryEntry): Promise<void> {
    if (!this.isUnlocked(vaultId)) return;
    return this.queueMutation(vaultId, async () => {
      const file = await this.readFile(vaultId);
      const state = this.states.get(vaultId);
      const vaultKey = state?.unlockedVaultKey;
      if (!file || !vaultKey) return;
      const payload = this.decryptPayload(file, vaultKey);
      const existing = (payload.workspaceMemories ?? []).filter((m) => m.id !== entry.id);
      existing.push({
        ...entry,
        author: entry.author || state?.unlockedAsRecipientId || 'member',
      });
      await this.persistPayload(vaultId, file, vaultKey, { ...payload, workspaceMemories: existing });
    });
  }

  /** Deletes a shared AI memory or skill from the Team Vault payload if unlocked. */
  async deleteWorkspaceMemory(vaultId: string, id: string): Promise<void> {
    if (!this.isUnlocked(vaultId)) return;
    return this.queueMutation(vaultId, async () => {
      const file = await this.readFile(vaultId);
      const vaultKey = this.states.get(vaultId)?.unlockedVaultKey;
      if (!file || !vaultKey) return;
      const payload = this.decryptPayload(file, vaultKey);
      if (!payload.workspaceMemories) return;
      const workspaceMemories = payload.workspaceMemories.filter((m) => m.id !== id);
      await this.persistPayload(vaultId, file, vaultKey, { ...payload, workspaceMemories });
    });
  }

  /** Sets or clears a shared folder's description inside the Team Vault payload if unlocked. */
  async setTeamFolderDescription(vaultId: string, folderPath: string, description: string | undefined): Promise<void> {
    const trimmed = normalizeFolderPath(folderPath);
    if (!trimmed || !this.isUnlocked(vaultId)) return;
    const file = await this.readFile(vaultId);
    const vaultKey = this.states.get(vaultId)?.unlockedVaultKey;
    if (file && vaultKey) {
      const payload = this.decryptPayload(file, vaultKey);
      const folderDescriptions = { ...(payload.folderDescriptions ?? {}) };
      if (description?.trim()) folderDescriptions[trimmed] = description.trim();
      else delete folderDescriptions[trimmed];
      await this.persistPayload(vaultId, file, vaultKey, { ...payload, folderDescriptions });
    }
  }

  /** Creates an (initially empty) shared folder — same purpose as `ProfileStore.saveFolder` for
   * personal profiles, just synced via the vault payload instead of kept local. Any unlocked
   * member may organize shared profiles, not just an admin (same reasoning as
   * `saveSSHProfile`). `path` is a `/`-separated tree path (e.g. `"Acme Infra/Cluster A"`) —
   * segments are trimmed and empty segments rejected, but intermediate ancestors need not already
   * exist as their own entries (the renderer's tree builder synthesizes them from any deeper
   * path). */
  async saveTeamFolder(vaultId: string, folderPath: string): Promise<void> {
    const trimmed = normalizeFolderPath(folderPath);
    if (!trimmed) {
      throw new Error('Folder name is required');
    }
    return this.queueMutation(vaultId, async () => {
      const file = await this.requireFile(vaultId);
      const vaultKey = this.requireUnlocked(vaultId);
      const payload = await this.decryptPayload(file, vaultKey);
      const folders = payload.folders ?? [];
      if (!folders.includes(trimmed)) {
        folders.push(trimmed);
      }
      await this.persistPayload(vaultId, file, vaultKey, { ...payload, folders });
    });
  }

  /** Renames a shared folder, cascading to every descendant folder entry and every profile's
   * `group` whose path is the folder itself or starts with `folderPath + '/'` — unlike the
   * personal `ProfileStore.renameFolder` (exact-match only, no nesting), a Team Vault folder path
   * can have arbitrarily deep children that must move with it. */
  async renameTeamFolder(vaultId: string, oldPath: string, newPath: string): Promise<void> {
    const trimmedOld = normalizeFolderPath(oldPath);
    const trimmedNew = normalizeFolderPath(newPath);
    if (!trimmedNew) {
      throw new Error('New folder name is required');
    }
    if (trimmedOld === trimmedNew) return;
    return this.queueMutation(vaultId, async () => {
      const file = await this.requireFile(vaultId);
      const vaultKey = this.requireUnlocked(vaultId);
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

      await this.persistPayload(vaultId, file, vaultKey, {
        ...payload,
        ssh,
        s3,
        folders: Array.from(new Set(folders)),
        folderIcons,
      });
    });
  }

  /** Deletes a shared folder and every descendant folder entry. Affected profiles (the folder
   * itself or any descendant) either lose their `group` (become ungrouped, the default) or — if
   * `deleteProfiles` is set — are removed from the vault outright, mirroring `ProfileStore`'s
   * `deleteFolder(name, deleteProfiles)`. Team profiles have no tombstone/soft-delete concept
   * (unlike personal ones): a Team Vault "delete" always just drops the entry from the payload. */
  async deleteTeamFolder(vaultId: string, folderPath: string, deleteProfiles = false): Promise<void> {
    const trimmed = normalizeFolderPath(folderPath);
    if (!trimmed) return;
    return this.queueMutation(vaultId, async () => {
      const file = await this.requireFile(vaultId);
      const vaultKey = this.requireUnlocked(vaultId);
      const payload = await this.decryptPayload(file, vaultKey);
      const affected = (group: string | undefined) => !!group && isSelfOrDescendant(group, trimmed);

      const folders = (payload.folders ?? []).filter((f) => !isSelfOrDescendant(f, trimmed));
      const ssh = deleteProfiles ? payload.ssh.filter((p) => !affected(p.group)) : payload.ssh.map((p) => (affected(p.group) ? { ...p, group: undefined } : p));
      const s3 = deleteProfiles ? payload.s3.filter((p) => !affected(p.group)) : payload.s3.map((p) => (affected(p.group) ? { ...p, group: undefined } : p));
      const folderIcons: Record<string, string> = {};
      for (const [path, icon] of Object.entries(payload.folderIcons ?? {})) {
        if (!isSelfOrDescendant(path, trimmed)) folderIcons[path] = icon;
      }

      await this.persistPayload(vaultId, file, vaultKey, { ...payload, ssh, s3, folders, folderIcons });
    });
  }

  /** Sets (or, with `icon` undefined, clears back to the default) a folder's icon — any unlocked
   * member may organize shared folders, same reasoning as `saveTeamFolder`/profile edits. `icon`
   * is validated by the IPC handler against `TEAM_FOLDER_ICONS` before this is ever called; this
   * layer doesn't re-validate it, same division of responsibility as the rest of this file's
   * handler-vs-service validation split. */
  async setTeamFolderIcon(vaultId: string, folderPath: string, icon: string | undefined): Promise<void> {
    const trimmed = normalizeFolderPath(folderPath);
    if (!trimmed) {
      throw new Error('Folder name is required');
    }
    return this.queueMutation(vaultId, async () => {
      const file = await this.requireFile(vaultId);
      const vaultKey = this.requireUnlocked(vaultId);
      const payload = await this.decryptPayload(file, vaultKey);
      const folderIcons = { ...(payload.folderIcons ?? {}) };
      if (icon) {
        folderIcons[trimmed] = icon;
      } else {
        delete folderIcons[trimmed];
      }
      await this.persistPayload(vaultId, file, vaultKey, { ...payload, folderIcons });
    });
  }

  /** Re-encrypts and writes `payload` as the vault's new `encryptedPayload`, bumping `revision`
   * and recomputing `accessHeaderMac` even though `accessHeader`/`recovery` themselves don't
   * change here — the MAC covers `revision` (see `TeamVaultFile.accessHeaderMac`'s doc comment),
   * which always bumps on a mutating write, so it must always be recomputed too. */
  private async persistPayload(
    vaultId: string,
    file: TeamVaultFile,
    vaultKey: Buffer,
    payload: TeamVaultPayload
  ): Promise<void> {
    const updatedBy = this.requireUnlockedRecipientId(vaultId);
    const newRevision = file.revision + 1;
    const changed: TeamVaultFile = {
      ...file,
      revision: newRevision,
      updatedAt: new Date().toISOString(),
      updatedBy,
      encryptedPayload: this.cryptoService.encryptPayload(vaultKey, file.vaultId, file.formatVersion, serializePayload(payload)),
    };
    // The MAC is computed over the finished file, so in format v2 it covers the new ciphertext too.
    await this.writeFile(vaultId, { ...changed, accessHeaderMac: this.cryptoService.computeFileMac(vaultKey, changed) });
  }

  /** Removes the Team Vault from THIS machine only — the local file and the in-memory unlocked
   * state. Deliberately never touches the remote S3 copy (if any): that's reachable through the
   * app's own generic S3 file manager if the admin explicitly wants to destroy it for the whole
   * team too, a much higher-blast-radius action than forgetting it locally. Admin only
   * (`requireUnlockedAsAdmin`). The caller (`teamVaultHandlers.ts`) is responsible for also
   * clearing `TeamVaultConfigStore`'s remembered self-identity, same as it sets it after
   * enroll/create/unlock — `TeamVaultService` has no dependency on that store. */
  async deleteVault(vaultId: string): Promise<void> {
    return this.queueMutation(vaultId, async () => {
      const file = await this.requireFile(vaultId);
      this.requireUnlockedAsAdmin(vaultId, file);
      await fs.unlink(this.getFilePath(vaultId)).catch((err) => {
        if (err?.code !== 'ENOENT') throw err;
      });
      this.states.delete(vaultId);
    });
  }

  /** Removes a LOCKED vault's local file, identity subdirectory, and runtime state from this
   * device, without needing the Vault Key — distinct from `deleteVault`, which is an
   * authenticated, whole-team-affecting action. Used for "forget a team I'm no longer actively
   * using on this machine" (`TEAM_VAULT_FORGET`). Refuses outright while the vault is unlocked:
   * forgetting it would silently discard whatever hasn't been pushed yet, exactly what
   * `TeamVaultUnpushedChangesError` already guards against on the sync path — the caller must
   * lock it first. The caller (`teamVaultHandlers.ts`) is responsible for also clearing this
   * vault's `TeamVaultConfigStore` entry. */
  async forgetLocalVault(vaultId: string): Promise<void> {
    return this.queueMutation(vaultId, async () => {
      if (this.isUnlocked(vaultId)) {
        throw new Error('Lock this Team Vault before forgetting it on this device');
      }
      await fs.unlink(this.getFilePath(vaultId)).catch((err) => {
        if (err?.code !== 'ENOENT') throw err;
      });
      await fs.rm(this.identityDirFor(vaultId), { recursive: true, force: true }).catch(() => {});
      this.states.delete(vaultId);
    });
  }

  /** Unwraps the Vault Key for `recipientId` (a member or the recovery identity) using
   * `identityFilePath`, and caches it for the rest of this session. See the class doc comment for
   * the unresolved PIN-prompt caveat. */
  async unlock(vaultId: string, recipientId: string, identityFilePath: string): Promise<void> {
    const file = await this.requireFile(vaultId);
    const source =
      file.accessHeader.find((e) => e.recipientId === recipientId) ??
      (file.recovery.recipientId === recipientId ? file.recovery : undefined);
    if (!source) {
      throw new Error(`"${recipientId}" is not a recipient of this vault`);
    }
    await this.pinPrompter?.ensurePivPresent?.(`Team Vault: ${file.vaultName || vaultId}`);
    const vaultKey = await this.cryptoService.unwrapVaultKey(
      source.wrappedVaultKey,
      identityFilePath,
      this.buildPtyCallbacks(recipientId, `Team Vault: ${file.vaultName || vaultId}`)
    );
    this.completeUnlock(vaultId, file, recipientId, vaultKey);
    await this.upgradeFormatIfNeeded(vaultId);
  }

  /**
   * Brings an older-format vault file to the current format, if this session is unlocked and allowed to (see `FormatMigration.requires`).
   * Automatic and role-independent for the steps that need only the Vault Key: whoever unlocks first with this version does it, and the
   * app is told (`onFormatUpgraded`) so it can push the result. Best-effort by design: a failure is logged and the vault simply stays in
   * its old format, it never blocks an unlock or a pull. Revision, `updatedAt` and `updatedBy` do not change.
   *
   * The file's current MAC is verified again first, so a local file that was changed after the unlock check is not re-signed. What this
   * cannot know is whether a v1 payload is the genuine latest one (v1 never covered it): the protection starts from the upgrade.
   */
  async upgradeFormatIfNeeded(vaultId: string): Promise<boolean> {
    try {
      const upgraded = await this.queueMutation(vaultId, async () => {
        const file = await this.readFile(vaultId);
        const state = this.states.get(vaultId);
        const vaultKey = state?.unlockedVaultKey;
        if (!file || !vaultKey || file.formatVersion >= CURRENT_FORMAT_VERSION) return false;
        if (this.cryptoService.computeFileMac(vaultKey, file) !== file.accessHeaderMac) return false;

        const isAdmin = this.isSelfAdmin(file, state?.unlockedAsRecipientId ?? '');
        const migrated = migrateToCurrentFormat(file, vaultKey, isAdmin, this.cryptoService);
        if (!migrated) return false;
        await this.writeFile(vaultId, { ...migrated, accessHeaderMac: this.cryptoService.computeFileMac(vaultKey, migrated) });
        return true;
      });
      if (upgraded) {
        teamVaultLog.info(`Team Vault ${vaultId} upgraded to format ${CURRENT_FORMAT_VERSION}`);
        this.onFormatUpgraded?.(vaultId);
      }
      return upgraded;
    } catch (err) {
      teamVaultLog.warn(`Could not upgrade Team Vault ${vaultId} to the current format (non-fatal, it stays as it is):`, err);
      return false;
    }
  }

  /** Verifies the just-unwrapped Vault Key against the stored header MAC and caches it. */
  private completeUnlock(vaultId: string, file: TeamVaultFile, recipientId: string, vaultKey: Buffer): void {
    // Defense in depth, not the primary control (see `TeamVaultRotationProofError`'s doc comment
    // — `pullFromRemote` is what actually keeps a forged file out of local storage in the first
    // place). This only catches a LOCAL file that's internally inconsistent — e.g. corrupted on
    // disk, or some future bug writing one without recomputing the MAC — since
    // `computeAccessHeaderMac` with the just-unwrapped key must reproduce exactly what's already
    // stored in `accessHeaderMac` for any header this service itself ever wrote.
    if (!SUPPORTED_FORMAT_VERSIONS.includes(file.formatVersion)) {
      throw new TeamVaultUnsupportedFormatError(file.formatVersion);
    }
    const expectedMac = this.cryptoService.computeFileMac(vaultKey, file);
    if (expectedMac !== file.accessHeaderMac) {
      throw new TeamVaultHeaderIntegrityError();
    }
    const state = this.stateFor(vaultId);
    state.unlockedVaultKey = vaultKey;
    state.unlockedAsRecipientId = recipientId;
  }

  /**
   * Guided counterpart to `unlock()` for someone who only has the recovery identity TEXT
   * (printed/saved at vault creation, never written to a file by the app — see
   * `generateRecoveryIdentity`), not a file path and not the `'recovery-key-1'` recipientId. Both
   * are handled internally here, never by the renderer: the recipientId is fixed (the recovery
   * entry's id never varies, see `createVault`), and the pasted text — a private key — is fed to
   * `age` on stdin, never written to disk (see `TeamVaultCryptoService.unwrapVaultKeyWithRecoveryIdentity`).
   */
  async unlockWithRecoveryText(vaultId: string, identityText: string): Promise<void> {
    const file = await this.requireFile(vaultId);
    const vaultKey = await this.cryptoService.unwrapVaultKeyWithRecoveryIdentity(
      file.recovery.wrappedVaultKey,
      identityText
    );
    this.completeUnlock(vaultId, file, file.recovery.recipientId, vaultKey);
    await this.upgradeFormatIfNeeded(vaultId);
  }

  /**
   * Builds an age-encrypted invite blob for `recipientId` — a join-flow simplification
   * (docs/team-vault-plan.md) that lets a new member skip typing in the vault's S3
   * target/bucket/prefix by hand. `recipientId` must already be a member (added via
   * `addMember`) — their `ageRecipient` (public key) is read straight out of the vault's own
   * already-plaintext `accessHeader`, no new input needed. Admin-only (`requireUnlockedAsAdmin`,
   * same gate as `addMember`/`removeMember`): building an invite that reveals the S3
   * target/bucket/prefix is itself a membership-adjacent action, not something any unlocked
   * member should be able to do for an arbitrary recipientId. Requires `configStore` to be wired
   * up (production only, same as `pinPrompter`).
   */
  async buildInvite(vaultId: string, recipientId: string): Promise<string> {
    const file = await this.requireFile(vaultId);
    this.requireUnlockedAsAdmin(vaultId, file);
    const entry = file.accessHeader.find((e) => e.recipientId === recipientId);
    if (!entry) {
      throw new Error(`"${recipientId}" is not a member of this vault`);
    }
    if (!this.configStore) {
      throw new Error('Team Vault invite building is not wired up (missing configStore)');
    }
    const config = await this.configStore.getConfig(vaultId);
    if (!config.target) {
      throw new Error('Configure a Team Vault target first (team-vault:set-target)');
    }
    const body = JSON.stringify({ vaultId, target: config.target, remoteBasePath: config.remoteBasePath });
    const armored = await this.cryptoService.encryptForRecipient(body, entry.ageRecipient);
    return `sshs3 Team Vault invite for ${recipientId}\n${armored}`;
  }

  /**
   * New-member side of `buildInvite`: decrypts a pasted invite blob with the identity at
   * `identityFilePath` (the one generated by this machine's own `enrollOwnPivRecipient()` call,
   * same as the manual join flow it replaces) and returns the S3 target it carries. Not scoped to
   * a particular `vaultId` in its own runtime state (the vault being joined isn't locally known
   * yet — that's the whole point) — the `vaultId` inside the decrypted blob is returned for the
   * caller to adopt. Throws a plain, user-facing error on a truncated/garbled paste or an
   * identity that doesn't match the intended recipient, since `age` itself fails the same way
   * `unwrapVaultKey` already does for those cases.
   */
  async decodeInvite(
    inviteText: string,
    identityFilePath: string
  ): Promise<{ vaultId: string; target: StorageConnectConfig; remoteBasePath?: string }> {
    const armored = extractInviteCiphertext(inviteText);
    let decrypted: string;
    await this.pinPrompter?.ensurePivPresent?.('Team Vault: reading invite');
    try {
      decrypted = await this.cryptoService.decryptWithIdentity(
        armored,
        identityFilePath,
        this.buildPtyCallbacks(undefined, 'Team Vault: reading invite')
      );
    } catch {
      throw new Error(
        'Could not read this invite — check it was pasted completely, or that it matches your identity.'
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(decrypted);
    } catch {
      throw new Error(
        'Could not read this invite — check it was pasted completely, or that it matches your identity.'
      );
    }
    const candidate = parsed as { vaultId?: unknown; target?: unknown; remoteBasePath?: unknown };
    if (
      typeof candidate.vaultId !== 'string' ||
      !INVITE_VAULT_ID_PATTERN.test(candidate.vaultId) ||
      !candidate.target ||
      typeof candidate.target !== 'object' ||
      typeof (candidate.target as { id?: unknown }).id !== 'string' ||
      typeof (candidate.target as { name?: unknown }).name !== 'string' ||
      (candidate.target as { type?: unknown }).type !== 's3' ||
      (candidate.remoteBasePath !== undefined && typeof candidate.remoteBasePath !== 'string')
    ) {
      throw new Error('This invite is not a recognizable Team Vault invite');
    }
    return {
      vaultId: candidate.vaultId,
      target: candidate.target as StorageConnectConfig,
      remoteBasePath: candidate.remoteBasePath as string | undefined,
    };
  }

  /** Must be called whenever the configured S3 target/remoteBasePath for `vaultId` changes —
   * otherwise a stat recorded against a *previous* target would be compared against the newly
   * configured one on the next push, producing a spurious (or worse, falsely-absent) conflict.
   * Same reasoning as `ProfileSyncService.resetRemoteState()`. */
  async resetRemoteState(vaultId: string): Promise<void> {
    const state = this.states.get(vaultId);
    if (state) {
      state.lastKnownRemoteEntry = undefined;
      state.lastSyncedRevision = undefined;
      state.remoteFormatVersion = undefined;
    }
    // Also forget the persisted copy, or hydratedState would restore the old target's values. Awaited, so
    // that a status refresh straight after cannot read the file before the clear has been written.
    try {
      await this.configStore?.clearSyncState?.(vaultId);
    } catch (err) {
      teamVaultLog.warn(`Failed to clear the persisted sync state for vaultId=${vaultId} (non-fatal):`, err);
    }
  }

  /** Whether a vault file already exists at the remote target — used by the UI to offer "Pull
   * existing vault" instead of "Create Vault" when no local file exists yet (§4.3: a new member
   * joins an existing team vault, they don't create their own). */
  async hasRemoteVault(vaultId: string, provider: IStorageProvider, remoteBasePath = ''): Promise<boolean> {
    // Like every method here that touches the remote target: never in demo mode (demo/outwardSync.ts).
    // Refused rather than answered with `false`, which the join flow would show as "no vault found".
    assertOutwardSyncAllowed('Team Vault sync');
    return (await this.statOrNull(provider, this.remoteVaultPath(remoteBasePath, vaultId))) !== null;
  }

  /**
   * Pushes the local vault file to the configured S3 target (docs/team-vault-plan.md Fas 3).
   * Serialized through `queueMutation` along with every local mutation and `pullFromRemote` FOR
   * THIS `vaultId` only, so a push can never interleave with a concurrent local write or pull
   * touching the same in-memory state (`lastKnownRemoteEntry`, `unlockedVaultKey`) — a push/pull
   * for a *different* vaultId runs on its own independent queue and never waits behind this one.
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
   *
   * The remote object path itself is `${remoteBasePath}/team-vault/${vaultId}/vault.json` (see
   * `remoteVaultPath`) — including `vaultId` in the path, not just a fixed filename, means two
   * unrelated teams that (by misconfiguration) share the same `target`+`remoteBasePath` can never
   * collide on the same S3 object regardless of what either admin configures.
   */
  async pushToRemote(vaultId: string, provider: IStorageProvider, remoteBasePath = ''): Promise<void> {
    assertOutwardSyncAllowed('Team Vault sync');
    return this.queueMutation(vaultId, async () => {
      const file = await this.requireFile(vaultId);
      const remotePath = this.remoteVaultPath(remoteBasePath, vaultId);
      const state = await this.hydratedState(vaultId);

      const current = await this.statOrNull(provider, remotePath);
      if (current !== null) {
        const remoteFile = await this.readRemoteVaultFile(provider, remotePath);
        if (remoteFile.vaultId !== file.vaultId) {
          throw new TeamVaultForeignVaultError();
        }
        // This machine's copy is older than the remote (it has not been upgraded or pulled yet): pushing it would replace a
        // newer-format vault with an older one.
        if (remoteFile.formatVersion > file.formatVersion) {
          throw new TeamVaultFormatDowngradeError('push');
        }
      }

      if (state.lastKnownRemoteEntry !== undefined) {
        const known = state.lastKnownRemoteEntry;
        const unchanged =
          (known === null && current === null) ||
          (known !== null && current !== null && known.size === current.size && known.mtime === current.mtime);
        if (!unchanged) {
          throw new TeamVaultSyncConflictError();
        }
      }

      await this.writeProviderFile(provider, remotePath, Buffer.from(JSON.stringify(file), 'utf-8'));
      await this.setLastKnownRemoteEntry(vaultId, state, await this.statOrNull(provider, remotePath), file.revision, file.formatVersion);
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
   * see `VaultRuntimeState.lastSyncedRevision`'s doc comment) unless `options.force` is set —
   * there's no per-record merge here (docs/team-vault-plan.md: a whole-file reject-and-pull-first
   * model, same as push's own conflict check), so silently overwriting would otherwise just
   * discard whatever the admin or a member edited locally since the last sync.
   */
  async pullFromRemote(
    vaultId: string,
    provider: IStorageProvider,
    remoteBasePath = '',
    options: { force?: boolean } = {}
  ): Promise<void> {
    assertOutwardSyncAllowed('Team Vault sync');
    await this.pullFromRemoteQueued(vaultId, provider, remoteBasePath, options);
    // A pulled older-format file (a mixed team that has not upgraded yet) is brought to the current format straight away.
    await this.upgradeFormatIfNeeded(vaultId);
  }

  private async pullFromRemoteQueued(
    vaultId: string,
    provider: IStorageProvider,
    remoteBasePath: string,
    options: { force?: boolean }
  ): Promise<void> {
    return this.queueMutation(vaultId, async () => {
      const remotePath = this.remoteVaultPath(remoteBasePath, vaultId);
      const file = await this.readRemoteVaultFile(provider, remotePath);
      const state = await this.hydratedState(vaultId);

      // The remote object's path already embeds `vaultId` (see `remoteVaultPath`'s doc comment),
      // but that only prevents two DIFFERENT teams' admins from accidentally colliding on the
      // same object — it says nothing about whoever actually controls the bytes AT that path
      // claiming to be a different vault than the one this call asked to pull (a brand-new join
      // has nothing stored locally yet to cross-check against, so without this the content's own
      // `vaultId` field would simply be trusted as-is). Checked unconditionally, before the
      // local-file branch below even runs, so this holds for a first-ever join exactly as much
      // as for every later pull.
      if (file.vaultId !== vaultId) {
        throw new TeamVaultForeignVaultError();
      }
      // Once the remote has been seen in a newer format, an older-format file is a replay (its MAC does not cover the
      // payload). No `force` exemption: unlike unpushed local changes, this is not something the user can decide.
      if (state.remoteFormatVersion !== undefined && file.formatVersion < state.remoteFormatVersion) {
        throw new TeamVaultFormatDowngradeError('pull');
      }
      // The local copy's own format is a floor too: it can be ahead of the mark (upgraded here but not pushed yet, or the mark was
      // lost), and a replay of the pre-upgrade file carries the SAME revision. An older-format file is accepted only when its
      // revision is strictly higher (the v1 MAC covers the revision, so the header is genuine, but it does NOT vouch for the payload: this is the
      // known v1 weakness, open only while the remote has never been seen as v2, see team-vault-plan §0.8): an older client that wrote to a remote
      // that was never seen in the newer format (the mixed-team transition). Never at an equal or lower revision.
      const localForFloor = await this.readFile(vaultId);
      if (
        localForFloor &&
        file.formatVersion < localForFloor.formatVersion &&
        file.revision <= localForFloor.revision
      ) {
        throw new TeamVaultFormatDowngradeError('pull');
      }

      // Whether the currently-held Vault Key is proven to still decrypt the pulled file —
      // confirmed below via the accessHeaderMac check, the only place that's actually verified.
      // Starts false: a brand-new join (no localFile, nothing held yet) or an already-locked
      // session has nothing to preserve either way, and `lock()` on either is a no-op.
      let keyProvenStillValid = false;
      // Whether this file's header was authenticated (MAC or rotation proof). Only then may its format version be remembered as the
      // highest seen: a first join has no key yet, so an unverified file must not be able to set the downgrade barrier.
      let headerVerified = false;

      const localFile = await this.readFile(vaultId);
      if (localFile) {
        // Verifying the pulled header against a tampered/forged entry requires the Vault Key
        // (see TeamVaultLockedForPullError's doc comment) — refuse outright rather than silently
        // persisting an unverifiable file over the one already trusted locally. A brand-new join
        // (localFile === null) has nothing to verify against either way, so this never blocks that.
        if (!state.unlockedVaultKey) {
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
          state.lastSyncedRevision !== undefined &&
          localFile.revision !== state.lastSyncedRevision
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
        if (state.unlockedVaultKey && file.accessHeader.length >= localFile.accessHeader.length) {
          const expectedMac = this.cryptoService.computeFileMac(state.unlockedVaultKey, file);
          if (expectedMac !== file.accessHeaderMac) {
            throw new TeamVaultHeaderIntegrityError();
          }
          keyProvenStillValid = true;
          headerVerified = true;
        } else if (state.unlockedVaultKey && file.accessHeader.length < localFile.accessHeader.length) {
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
          const expectedProof = this.cryptoService.computeFileRotationProof(state.unlockedVaultKey, file);
          if (!file.prevKeyProof || expectedProof !== file.prevKeyProof) {
            throw new TeamVaultRotationProofError();
          }
          headerVerified = true;
          // keyProvenStillValid stays false: the proof shows this rotation is legitimate, not
          // that our now-superseded key still works — lock() below is still the right call.
        }
      }

      await this.writeFile(vaultId, file);
      await this.setLastKnownRemoteEntry(
        vaultId,
        state,
        await this.statOrNull(provider, remotePath),
        file.revision,
        headerVerified ? file.formatVersion : undefined
      );
      // Only lock when the held key ISN'T proven still valid — e.g. after a removeMember
      // elsewhere rotated it (accessHeader.length dropped, so the check above never ran). A
      // background auto-poll (IpcBridge.runTeamVaultAutoPoll) pulling in a plain profile edit
      // from another member must not force a re-unlock every time; only an actual re-key should.
      if (!keyProvenStillValid) {
        this.lock(vaultId);
      }
    });
  }

  /**
   * Cryptographically verifies and merges concurrent local & remote Team Vault payloads
   * (SSH/S3 profiles, folders, shared AI memories, and terminal activity logs) when
   * multiple teammates are working simultaneously while the vault is unlocked.
   */
  async mergeWithRemote(vaultId: string, provider: IStorageProvider, remoteBasePath = ''): Promise<boolean> {
    assertOutwardSyncAllowed('Team Vault sync');
    if (!this.isUnlocked(vaultId)) return false;
    return this.queueMutation(vaultId, async () => {
      const localFile = await this.readFile(vaultId);
      const state = await this.hydratedState(vaultId);
      const vaultKey = state.unlockedVaultKey;
      const recipientId = state.unlockedAsRecipientId;
      if (!localFile || !vaultKey || !recipientId) return false;
      const remotePath = this.remoteVaultPath(remoteBasePath, vaultId);
      const current = await this.statOrNull(provider, remotePath);
      if (!current) return false;

      const remoteFile = await this.readRemoteVaultFile(provider, remotePath);
      if (remoteFile.vaultId !== localFile.vaultId || remoteFile.vaultId !== vaultId) {
        throw new TeamVaultForeignVaultError();
      }
      // Same format guards as `pushToRemote` (never overwrite a newer-format remote) and
      // `pullFromRemoteQueued` (never accept an older-format replay once a newer one was seen).
      if (remoteFile.formatVersion > localFile.formatVersion) {
        throw new TeamVaultFormatDowngradeError('push');
      }
      if (state.remoteFormatVersion !== undefined && remoteFile.formatVersion < state.remoteFormatVersion) {
        throw new TeamVaultFormatDowngradeError('pull');
      }
      this.assertNoAgeRecipientTampering(localFile, remoteFile);
      if (remoteFile.accessHeader.length < localFile.accessHeader.length) {
        return false;
      }
      const expectedMac = this.cryptoService.computeFileMac(vaultKey, remoteFile);
      if (expectedMac !== remoteFile.accessHeaderMac) {
        throw new TeamVaultHeaderIntegrityError();
      }

      const localPayload = this.decryptPayload(localFile, vaultKey);
      const remotePayload = this.decryptPayload(remoteFile, vaultKey);

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

      const mergedUnknownKeys =
        remotePayload.unknownKeys || localPayload.unknownKeys
          ? { ...(remotePayload.unknownKeys ?? {}), ...(localPayload.unknownKeys ?? {}) }
          : undefined;
      const mergedPayload: TeamVaultPayload = {
        ssh: mergeByUpdatedAt(remotePayload.ssh ?? [], localPayload.ssh ?? []),
        s3: mergeByUpdatedAt(remotePayload.s3 ?? [], localPayload.s3 ?? []),
        folders: Array.from(new Set([...(remotePayload.folders ?? []), ...(localPayload.folders ?? [])])),
        folderIcons: { ...(remotePayload.folderIcons ?? {}), ...(localPayload.folderIcons ?? {}) },
        k8s: mergeByUpdatedAt(remotePayload.k8s ?? [], localPayload.k8s ?? []),
        folderDescriptions: { ...(remotePayload.folderDescriptions ?? {}), ...(localPayload.folderDescriptions ?? {}) },
        workspaceMemories: mergeByUpdatedAt(remotePayload.workspaceMemories ?? [], localPayload.workspaceMemories ?? []),
        activityLog: mergedActivity,
        ...(mergedUnknownKeys ? { unknownKeys: mergedUnknownKeys } : {}),
      };

      const newRevision = Math.max(localFile.revision, remoteFile.revision) + 1;
      const mergedHeader =
        remoteFile.accessHeader.length >= localFile.accessHeader.length
          ? remoteFile.accessHeader
          : localFile.accessHeader;
      const mergedVaultName = localFile.vaultName ?? remoteFile.vaultName;
      const changed: TeamVaultFile = {
        ...localFile,
        vaultName: mergedVaultName,
        revision: newRevision,
        updatedAt: new Date().toISOString(),
        updatedBy: recipientId,
        accessHeader: mergedHeader,
        encryptedPayload: this.cryptoService.encryptPayload(
          vaultKey,
          localFile.vaultId,
          localFile.formatVersion,
          serializePayload(mergedPayload)
        ),
      };
      // Same as `persistPayload`: the MAC is computed over the finished file (in format v2 it covers the payload too).
      const updated: TeamVaultFile = { ...changed, accessHeaderMac: this.cryptoService.computeFileMac(vaultKey, changed) };

      await this.writeFile(vaultId, updated);
      await this.writeProviderFile(provider, remotePath, Buffer.from(JSON.stringify(updated), 'utf-8'));
      await this.setLastKnownRemoteEntry(
        vaultId,
        state,
        await this.statOrNull(provider, remotePath),
        newRevision,
        updated.formatVersion
      );
      return true;
    });
  }

  /** Lightweight pre-check for a background poll (see `IpcBridge.runTeamVaultAutoPoll`): a
   * metadata-only `stat()` (no body download — `S3StorageProvider.stat()` issues a
   * `HeadObjectCommand`), compared against `lastKnownRemoteEntry` the same way `pushToRemote`'s
   * own freshness check does (`hydratedState` restores it from disk on first use after a
   * restart). Deliberately NOT run through `queueMutation` (never writes to `configStore` or
   * conflicts with a push/pull's own state) so a poll never has to wait behind an unrelated
   * pending push/pull. */
  async hasRemoteChangedSinceLastSync(vaultId: string, provider: IStorageProvider, remoteBasePath = ''): Promise<boolean> {
    // Also covers getSyncPreview, which asks this for its remote half.
    assertOutwardSyncAllowed('Team Vault sync');
    const remotePath = this.remoteVaultPath(remoteBasePath, vaultId);
    const current = await this.statOrNull(provider, remotePath);
    const state = await this.hydratedState(vaultId);
    if (state.lastKnownRemoteEntry === undefined) {
      return current !== null;
    }
    const known = state.lastKnownRemoteEntry;
    const unchanged =
      (known === null && current === null) ||
      (known !== null && current !== null && known.size === current.size && known.mtime === current.mtime);
    return !unchanged;
  }

  /** Whether this machine has local Team Vault mutations that have never been pushed — used by
   * the background poll to decide whether a detected remote change can be pulled automatically
   * (see `VaultRuntimeState.lastSyncedRevision`'s doc comment) or must instead just be surfaced
   * as a notice. */
  async hasUnpushedLocalChanges(vaultId: string): Promise<boolean> {
    const file = await this.readFile(vaultId);
    const state = file ? await this.hydratedState(vaultId) : undefined;
    if (!file || !state || state.lastSyncedRevision === undefined) return false;
    return file.revision !== state.lastSyncedRevision;
  }

  /** Combines `hasUnpushedLocalChanges`/`hasRemoteChangedSinceLastSync` into the one check the
   * Team Vault detail/list UI needs before Push/Pull is pressed (§14/§15) — same cheap,
   * metadata-only checks the background auto-poll already runs on every tick, just surfaced
   * on demand instead of acted on automatically. */
  async getSyncPreview(vaultId: string, provider: IStorageProvider, remoteBasePath = ''): Promise<TeamVaultSyncPreview> {
    const [hasUnpushedLocalChanges, remoteChanged] = await Promise.all([
      this.hasUnpushedLocalChanges(vaultId),
      this.hasRemoteChangedSinceLastSync(vaultId, provider, remoteBasePath),
    ]);
    return { hasUnpushedLocalChanges, remoteChanged };
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

  /** `${remoteBasePath}/team-vault/${vaultId}/vault.json` — `vaultId` is part of the path, not
   * just a fixed filename, so two teams that happen to share the same `target`+`remoteBasePath`
   * (e.g. one bucket, per-team IAM-scoped prefixes an admin got wrong) can never collide on the
   * same remote object: collision becomes structurally impossible regardless of admin
   * misconfiguration, rather than merely unlikely. See `pushToRemote`'s doc comment. */
  private remoteVaultPath(remoteBasePath: string, vaultId: string): string {
    return joinPaths('s3', remoteBasePath, `team-vault/${vaultId}/vault.json`);
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

  private requireUnlocked(vaultId: string): Buffer {
    const vaultKey = this.states.get(vaultId)?.unlockedVaultKey;
    if (!vaultKey) {
      throw new Error('Unlock the Team Vault before making changes to it');
    }
    return vaultKey;
  }

  private requireUnlockedRecipientId(vaultId: string): string {
    const recipientId = this.states.get(vaultId)?.unlockedAsRecipientId;
    if (!recipientId) {
      throw new Error('Unlock the Team Vault before making changes to it');
    }
    return recipientId;
  }

  /** Beyond merely being unlocked (any valid member, admin or not — what
   * `requireUnlockedRecipientId` alone guarantees), membership mutations and vault deletion
   * require the acting identity to actually hold the `admin` role, or be the recovery identity
   * (full restoration access by design, §4.1 — not a regular member, never demotable). Without
   * this, any plain member could already add/remove/promote other members or delete the vault —
   * a real gap `requireUnlockedRecipientId` alone never closed. */
  private requireUnlockedAsAdmin(vaultId: string, file: TeamVaultFile): string {
    const recipientId = this.requireUnlockedRecipientId(vaultId);
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

  private async readFile(vaultId: string): Promise<TeamVaultFile | null> {
    try {
      const raw = await fs.readFile(this.getFilePath(vaultId), 'utf-8');
      return JSON.parse(raw) as TeamVaultFile;
    } catch (err: any) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
  }

  private async requireFile(vaultId: string): Promise<TeamVaultFile> {
    const file = await this.readFile(vaultId);
    if (!file) {
      throw new Error('No Team Vault exists on this machine yet');
    }
    return file;
  }

  private async writeFile(vaultId: string, file: TeamVaultFile): Promise<void> {
    const filePath = this.getFilePath(vaultId);
    await writeFileAtomic(filePath, JSON.stringify(file, null, 2), { mode: 0o600 });
  }

  /** Per-`vaultId` write queue: mutations against DIFFERENT vaults run fully independently
   * (never wait behind one another), while mutations against the SAME vault are still fully
   * serialized, same guarantee the single queue gave the single-vault version of this file. */
  private queueMutation<T>(vaultId: string, mutation: () => Promise<T>): Promise<T> {
    const previous = this.writeQueues.get(vaultId) ?? Promise.resolve();
    const resultPromise = previous.then(mutation, mutation);
    this.writeQueues.set(
      vaultId,
      resultPromise.then(
        () => {},
        () => {}
      )
    );
    return resultPromise;
  }
}
