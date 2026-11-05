import path from 'node:path';
import { IPC_CHANNELS, type StorageConnectConfig } from '../../shared/types/ipc';
import {
  TEAM_FOLDER_ICONS,
  type TeamVaultPayload,
  type TeamVaultRole,
  type TeamVaultStatus,
  type TeamVaultSyncPreview,
} from '../../shared/types/teamVault';
import type { SSHConnectionConfig } from '../../shared/types/ssh';
import type { S3Config } from '../../shared/types/storage';
import type { IpcBridge } from '../IpcBridge';
import { readSmartcardCertificates } from '../smartcard/SmartcardCertificateReader';
import { testS3ConnectionConfig } from './connectionTestHandlers';
import { toTeamK8sProfile } from '../services/teamVaultK8s';
import { withNormalizedTags } from '../../shared/tags';
import { withNormalizedSystem } from '../../shared/system';
import { createLogger } from '../log';
import { isSyncTargetChanged } from '../services/syncTargetIdentity';

const teamVaultLog = createLogger('team-vault');

/** The part of IpcBridge this handler group may use. */
export type TeamVaultHost = Pick<
  IpcBridge,
  | 'aiHub'
  | 'buildAllTeamVaultStatuses'
  | 'buildTeamVaultStatus'
  | 'registerHandler'
  | 'scheduleTeamVaultAutoPush'
  | 'startTeamVaultAutoPollTimer'
  | 'stopTeamVaultAutoPollTimer'
  | 'storageRegistry'
  | 'syncConfigStore'
  | 'teamVaultConfigStore'
  | 'teamVaultService'
>;

/** Best-effort only — reads whatever authentication-capable smartcard certificate is already
 * configured for Remote Profile Sync (same `smartcardSync.pkcs11LibPath` as
 * `IpcBridge.unlockWithSmartcardInternal`, no new setting needed) and suggests its UPN as a
 * default recipient-id label, purely to save the admin from inventing their own. No PIN prompt —
 * `readSmartcardCertificates` never logs in (public cert objects). Never throws: a missing/absent
 * card, an unconfigured path, or any read error just means no suggestion, not a failed enroll. */
async function suggestLabelFromSmartcard(bridge: TeamVaultHost): Promise<string | undefined> {
  try {
    const pkcs11LibPath = (await bridge.syncConfigStore.getConfig()).smartcardSync?.pkcs11LibPath;
    if (!pkcs11LibPath) return undefined;
    const certs = await readSmartcardCertificates(pkcs11LibPath);
    for (const details of certs.values()) {
      if (details.authCapable && details.upn) return details.upn;
    }
    return undefined;
  } catch (err) {
    teamVaultLog.warn('failed to suggest a label from the smartcard certificate (non-fatal):', err);
    return undefined;
  }
}

// `age`'s own recipient encoding (bech32: lowercase letters + digits only) — also doubles as an
// argument-injection guard, since nothing matching this can start with '-' or contain shell/CLI
// metacharacters.
const AGE_RECIPIENT_PATTERN = /^age1[a-z0-9]{20,}$/;

function requireAgeRecipient(value: string, label: string): void {
  if (typeof value !== 'string' || !AGE_RECIPIENT_PATTERN.test(value)) {
    throw new Error(`${label} must be a valid age recipient string (age1...)`);
  }
}

// `canonicalAccessHeaderString` (TeamVaultCryptoService.ts) joins the header-MAC's fields with
// these three control characters as delimiters (\u0001 between an access-entry's own fields,
// \u0002 within the header line, \u0003 between lines) on the assumption that no real field value
// ever contains one. None of recipientId/vaultName/vaultDescription are otherwise restricted in
// character set, so without this guard a value containing one of these could be crafted to shift
// where the canonicalizer "sees" a field boundary — letting a bucket-write-access-only attacker
// (no Vault Key) reinterpret which bytes belong to which field while an old, still-valid MAC
// keeps verifying against the tampered split (a security review on 2026-10-12 flagged exactly
// this ambiguity after `vaultDescription` was added). Rejecting the delimiters outright at the
// point every one of these values is first accepted closes the construction path entirely,
// without touching the canonical string format itself (so it can never re-break an existing
// vault's MAC the way the `vaultDescription` backward-compatibility bug just did).
// Built from character codes, not a regex literal, so the delimiters aren't control-character
// escapes eslint-plugin-security's `no-control-regex` (rightly) flags in a `/.../ ` pattern.
function containsCanonicalizationDelimiter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x01 || code === 0x02 || code === 0x03) return true;
  }
  return false;
}

function requireRecipientId(value: string, label: string): void {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 512 ||
    containsCanonicalizationDelimiter(value)
  ) {
    throw new Error(`${label} is required`);
  }
}

function requireRole(role: TeamVaultRole): void {
  if (role !== 'admin' && role !== 'member') {
    throw new Error(`Invalid role "${role}"`);
  }
}

// A vaultId is either one this service itself minted (`vlt_${uuid}`) or the pending-config
// sentinel (`__pending__`, see shared/types/teamVault.ts) — never free-form renderer input used
// to build a filesystem path, so this is primarily an argument-shape guard (defense in depth,
// same posture as `requireIdentityFilePath` below) rather than the primary control against path
// traversal (every vaultId-derived path in TeamVaultService/TeamVaultConfigStore is a plain
// `path.join`, never interpolated into a shell command).
const VAULT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function requireVaultId(value: unknown): string {
  if (typeof value !== 'string' || !VAULT_ID_PATTERN.test(value)) {
    throw new Error('A valid vaultId is required');
  }
  return value;
}

/** The identity file is a path the user themselves typed/picked (their own card's identity
 * stanza, or the recovery identity they saved) — unlike a credential, rejecting it outright would
 * defeat the feature, so this only guards against it being mistaken for a CLI flag by `age`
 * (defense in depth; `TeamVaultCryptoService` enforces the same check at the actual exec site). */
function requireIdentityFilePath(value: string): void {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value) || value.startsWith('-')) {
    throw new Error('Identity file path must be an absolute path');
  }
}

// A real profile (host, username, key paths, tunnel definitions, ...) is a few KB at most —
// without a ceiling here, any unlocked (non-admin) member could save a profile with an
// arbitrarily large field (e.g. `group`, `privateKeyPath`), which gets stored verbatim in the
// shared, auto-pushed vault payload and downloaded again by every member on every pull.
const MAX_PROFILE_JSON_SIZE = 256 * 1024;

function requireProfile(value: unknown, label: string): void {
  if (!value || typeof value !== 'object' || !(value as { id?: unknown }).id) {
    throw new Error(`${label} is required`);
  }
  if (JSON.stringify(value).length > MAX_PROFILE_JSON_SIZE) {
    throw new Error(`${label} is too large (max ${MAX_PROFILE_JSON_SIZE} bytes serialized)`);
  }
}

function requireVaultName(value: string): void {
  if (typeof value !== 'string' || value.length > 200 || containsCanonicalizationDelimiter(value)) {
    throw new Error('Vault name must be a string of at most 200 characters');
  }
}

function requireVaultDescription(value: string): void {
  if (typeof value !== 'string' || value.length > 500 || containsCanonicalizationDelimiter(value)) {
    throw new Error('Vault description must be a string of at most 500 characters');
  }
}

// An armored age blob of the small JSON object `TeamVaultService.buildInvite` encrypts (vaultId +
// an S3 target + an optional prefix) is a few KB at most — well under this ceiling even with the
// human-readable header line prepended. Without a cap, a pasted invite of unbounded size would be
// handed straight to the `age` CLI via a pty (see `decryptWithIdentity`), which has its own
// MAX_OUTPUT_BYTES guard but only after spawning the process.
const MAX_INVITE_TEXT_LENGTH = 64 * 1024;

function requireInviteText(value: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_INVITE_TEXT_LENGTH) {
    throw new Error('A valid invite is required');
  }
}

// `TeamVaultService.saveTeamFolder`/`renameTeamFolder`/`deleteTeamFolder` already reject an
// empty-after-trim path, but nothing there bounds its size — without this, a compromised or
// buggy renderer could push an arbitrarily large (or absurdly deep) path straight into the
// synced, auto-pushed vault payload, bloating it for every member on every pull. 1000 chars /
// 50 segments is generous for a real folder tree while still being a hard ceiling.
const MAX_FOLDER_PATH_LENGTH = 1000;
const MAX_FOLDER_PATH_SEGMENTS = 50;

function requireFolderPath(value: string, label: string): void {
  if (typeof value !== 'string' || value.length > MAX_FOLDER_PATH_LENGTH) {
    throw new Error(`${label} must be a string of at most ${MAX_FOLDER_PATH_LENGTH} characters`);
  }
  if (value.split('/').length > MAX_FOLDER_PATH_SEGMENTS) {
    throw new Error(`${label} is nested too deeply (max ${MAX_FOLDER_PATH_SEGMENTS} segments)`);
  }
}

export function registerTeamVaultHandlers(bridge: TeamVaultHost): void {
  bridge.registerHandler(IPC_CHANNELS.TEAM_VAULT_GET_STATUS, async (_event, vaultId: string): Promise<TeamVaultStatus> => {
    return bridge.buildTeamVaultStatus(requireVaultId(vaultId));
  });

  bridge.registerHandler(IPC_CHANNELS.TEAM_VAULT_LIST, async (): Promise<TeamVaultStatus[]> => {
    return bridge.buildAllTeamVaultStatuses();
  });

  bridge.registerHandler(IPC_CHANNELS.TEAM_VAULT_ENROLL_RECIPIENT, async (_event, vaultId?: string) => {
    // Deliberately optional/unvalidated-as-path-segment here: enrolling a recipient for a vault
    // this machine is about to CREATE or JOIN has no real vaultId to pass yet (see
    // `TeamVaultService.enrollOwnPivRecipient`'s doc comment) — `undefined` is the normal case,
    // not a missing-argument bug. When a caller does pass one (enrolling a second identity for a
    // team already partially set up), it's still checked like any other vaultId.
    const knownVaultId = vaultId === undefined ? undefined : requireVaultId(vaultId);
    const result = await bridge.teamVaultService.enrollOwnPivRecipient(knownVaultId);
    // Only remember this identity when there's no local vault yet for this vaultId — this is the
    // first-time setup flow (about to create or join one), the one case `createVault`'s own
    // `setSelfIdentity` call relies on this having already saved the path. "Generate my
    // recipient" is also always visible once a vault already exists (for joining a *second*
    // team later — docs/team-vault-plan.md), and must NOT overwrite the identity `unlock()`
    // already needs for the current vault — a real regression found via real-world use
    // ("no identity matched any of the recipients" on the next unlock attempt).
    if (knownVaultId) {
      const { exists } = await bridge.teamVaultService.getStatus(knownVaultId);
      if (!exists) {
        await bridge.teamVaultConfigStore.setSelfIdentity(knownVaultId, undefined, result.identityFilePath);
      }
    }
    const suggestedLabel = await suggestLabelFromSmartcard(bridge);
    return { ...result, suggestedLabel };
  });

  bridge.registerHandler(
    IPC_CHANNELS.TEAM_VAULT_CREATE,
    async (
      _event,
      selfRecipientId: string,
      selfAgeRecipient: string,
      vaultName?: string,
      selfIdentityFilePath?: string
    ) => {
      requireRecipientId(selfRecipientId, 'Recipient id');
      requireAgeRecipient(selfAgeRecipient, 'Age recipient');
      requireVaultName(vaultName ?? '');
      if (selfIdentityFilePath !== undefined) requireIdentityFilePath(selfIdentityFilePath);
      const result = await bridge.teamVaultService.createVault(selfRecipientId, selfAgeRecipient, vaultName);
      // The identity file was already generated by a preceding `TEAM_VAULT_ENROLL_RECIPIENT` call
      // (vaultId-less at that point, since it hadn't been minted yet — see that handler's doc
      // comment on why it couldn't remember the path itself). Saving it here is what makes the
      // "Unlock as <you>" one-click shortcut available the very next time this vault is locked,
      // instead of forcing the creating admin to retype their own identity path forever.
      await bridge.teamVaultConfigStore.setSelfIdentity(result.vaultId, selfRecipientId, selfIdentityFilePath);
      bridge.startTeamVaultAutoPollTimer(result.vaultId);
      return result;
    }
  );

  bridge.registerHandler(IPC_CHANNELS.TEAM_VAULT_RENAME, async (_event, vaultId: string, vaultName: string) => {
    const vid = requireVaultId(vaultId);
    requireVaultName(vaultName);
    await bridge.teamVaultService.renameVault(vid, vaultName);
    bridge.scheduleTeamVaultAutoPush(vid);
  });

  bridge.registerHandler(IPC_CHANNELS.TEAM_VAULT_SET_DESCRIPTION, async (_event, vaultId: string, description: string) => {
    const vid = requireVaultId(vaultId);
    requireVaultDescription(description);
    await bridge.teamVaultService.setDescription(vid, description);
    bridge.scheduleTeamVaultAutoPush(vid);
  });

  bridge.registerHandler(
    IPC_CHANNELS.TEAM_VAULT_ADD_MEMBER,
    async (_event, vaultId: string, recipientId: string, ageRecipient: string, role: TeamVaultRole) => {
      const vid = requireVaultId(vaultId);
      requireRecipientId(recipientId, 'Recipient id');
      requireAgeRecipient(ageRecipient, 'Age recipient');
      requireRole(role);
      await bridge.teamVaultService.addMember(vid, recipientId, ageRecipient, role);
    }
  );

  bridge.registerHandler(IPC_CHANNELS.TEAM_VAULT_REMOVE_MEMBER, async (_event, vaultId: string, recipientId: string) => {
    const vid = requireVaultId(vaultId);
    requireRecipientId(recipientId, 'Recipient id');
    return bridge.teamVaultService.removeMember(vid, recipientId);
  });

  // Invite-blob join-flow simplification (docs/team-vault-plan.md): the admin builds an
  // age-encrypted blob for an already-added member (TEAM_VAULT_ADD_MEMBER must run first) so that
  // member never has to type the S3 target in by hand — see TeamVaultService.buildInvite's doc
  // comment for why this is admin-gated.
  bridge.registerHandler(IPC_CHANNELS.TEAM_VAULT_BUILD_INVITE, async (_event, vaultId: string, recipientId: string): Promise<string> => {
    const vid = requireVaultId(vaultId);
    requireRecipientId(recipientId, 'Recipient id');
    return bridge.teamVaultService.buildInvite(vid, recipientId);
  });

  // New-member side of TEAM_VAULT_BUILD_INVITE — deliberately NOT vaultId-led (the vault being
  // joined isn't locally known yet; its id comes back inside the decrypted result).
  bridge.registerHandler(
    IPC_CHANNELS.TEAM_VAULT_DECODE_INVITE,
    async (_event, inviteText: string, identityFilePath: string) => {
      requireInviteText(inviteText);
      requireIdentityFilePath(identityFilePath);
      return bridge.teamVaultService.decodeInvite(inviteText, identityFilePath);
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.TEAM_VAULT_SET_ROLE,
    async (_event, vaultId: string, recipientId: string, role: TeamVaultRole) => {
      const vid = requireVaultId(vaultId);
      requireRecipientId(recipientId, 'Recipient id');
      requireRole(role);
      await bridge.teamVaultService.setRole(vid, recipientId, role);
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.TEAM_VAULT_UNLOCK,
    async (_event, vaultId: string, recipientId: string, identityFilePath: string) => {
      const vid = requireVaultId(vaultId);
      requireRecipientId(recipientId, 'Recipient id');
      requireIdentityFilePath(identityFilePath);
      await bridge.teamVaultService.unlock(vid, recipientId, identityFilePath);
      await bridge.teamVaultConfigStore.setSelfIdentity(vid, recipientId, identityFilePath);
      bridge.startTeamVaultAutoPollTimer(vid);
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.TEAM_VAULT_UNLOCK_WITH_RECOVERY_TEXT,
    async (_event, vaultId: string, identityText: string) => {
      const vid = requireVaultId(vaultId);
      if (typeof identityText !== 'string' || !identityText.trim() || identityText.length > 10_000) {
        throw new Error('Recovery key text is required');
      }
      await bridge.teamVaultService.unlockWithRecoveryText(vid, identityText);
      bridge.startTeamVaultAutoPollTimer(vid);
    }
  );

  bridge.registerHandler(IPC_CHANNELS.TEAM_VAULT_LOCK, async (_event, vaultId: string) => {
    const vid = requireVaultId(vaultId);
    bridge.teamVaultService.lock(vid);
    bridge.stopTeamVaultAutoPollTimer(vid);
  });

  bridge.registerHandler(IPC_CHANNELS.TEAM_VAULT_DELETE, async (_event, vaultId: string) => {
    const vid = requireVaultId(vaultId);
    await bridge.teamVaultService.deleteVault(vid);
    await bridge.teamVaultConfigStore.clearSelfIdentity(vid);
    bridge.stopTeamVaultAutoPollTimer(vid);
  });

  // Distinct from TEAM_VAULT_DELETE: removes a LOCKED vault's local file/identity/config from
  // THIS device only, without the Vault Key — "forget a team I'm no longer actively using here",
  // not an authenticated whole-team-affecting action. See
  // `TeamVaultService.forgetLocalVault`'s doc comment for why it refuses an unlocked vault.
  bridge.registerHandler(IPC_CHANNELS.TEAM_VAULT_FORGET, async (_event, vaultId: string) => {
    const vid = requireVaultId(vaultId);
    await bridge.teamVaultService.forgetLocalVault(vid);
    await bridge.teamVaultConfigStore.clear(vid);
    bridge.stopTeamVaultAutoPollTimer(vid);
  });

  bridge.registerHandler(
    IPC_CHANNELS.TEAM_VAULT_SET_TARGET,
    async (_event, vaultId: string, target: StorageConnectConfig, remoteBasePath?: string) => {
      const vid = requireVaultId(vaultId);
      if (!target || !target.id || !target.name) {
        throw new Error('A Team Vault target with an id and name is required');
      }
      if (target.type !== 's3') {
        throw new Error('The Team Vault only supports an S3-compatible target');
      }
      if (!remoteBasePath?.trim()) {
        throw new Error('An S3 target requires a bucket (optionally "bucket/prefix") to sync to');
      }
      // Guards against an accidental/blank submission silently clobbering a previously-working
      // secret (e.g. a renderer bug, or any other caller of this channel that doesn't round-trip
      // the saved secret back the way the admin UI does) — never the admin-permission check
      // guardS3SecretWrite does for shared member profiles, since this channel is already
      // admin-only at the UI layer; purely "don't let blank silently beat real".
      const existingConfig = await bridge.teamVaultConfigStore.getConfig(vid);
      const existingTarget = existingConfig.target;
      if (
        target.s3Config &&
        !target.s3Config.secretAccessKey &&
        existingTarget?.type === 's3' &&
        existingTarget.s3Config?.secretAccessKey &&
        existingTarget.id === target.id
      ) {
        target.s3Config.secretAccessKey = existingTarget.s3Config.secretAccessKey;
      }
      await bridge.teamVaultConfigStore.setTarget(vid, target, remoteBasePath);
      await bridge.storageRegistry.disconnect?.(target.id);
      // Re-saving the same location (e.g. rotated credentials) keeps the remembered remote state: it holds the
      // unpushed-changes guard and the highest remote format seen (the downgrade barrier).
      const sameLocation =
        existingTarget !== undefined &&
        !isSyncTargetChanged(
          { target: existingTarget, remoteBasePath: existingConfig.remoteBasePath },
          { target, remoteBasePath }
        );
      // The (app-lifetime) TeamVaultService instance otherwise keeps comparing against whatever
      // remote state it last observed on the *previous* target — same reasoning as
      // ProfileSyncService.resetRemoteState() in syncHandlers.ts.
      if (!sameLocation) {
        await bridge.teamVaultService.resetRemoteState(vid);
      }
      // Restart rather than merely leave running: a stale timer would otherwise keep polling
      // against whatever target it captured when first started, not this new one.
      if (bridge.teamVaultService.isUnlocked(vid)) {
        bridge.startTeamVaultAutoPollTimer(vid);
      }
    }
  );

  bridge.registerHandler(IPC_CHANNELS.TEAM_VAULT_PUSH, async (_event, vaultId: string): Promise<TeamVaultStatus> => {
    const vid = requireVaultId(vaultId);
    const config = await bridge.teamVaultConfigStore.getConfig(vid);
    if (!config.target) {
      throw new Error('Configure a Team Vault target first (team-vault:set-target)');
    }
    const provider = await bridge.storageRegistry.getOrCreate(config.target);
    await bridge.teamVaultService.pushToRemote(vid, provider, config.remoteBasePath ?? '');
    await bridge.teamVaultConfigStore.setLastSyncAt(vid, new Date().toISOString());
    return bridge.buildTeamVaultStatus(vid);
  });

  bridge.registerHandler(
    IPC_CHANNELS.TEAM_VAULT_PULL,
    async (_event, vaultId: string, options?: { force?: boolean }): Promise<TeamVaultStatus> => {
      const vid = requireVaultId(vaultId);
      const config = await bridge.teamVaultConfigStore.getConfig(vid);
      if (!config.target) {
        throw new Error('Configure a Team Vault target first (team-vault:set-target)');
      }
      const provider = await bridge.storageRegistry.getOrCreate(config.target);
      await bridge.teamVaultService.pullFromRemote(vid, provider, config.remoteBasePath ?? '', options);
      bridge.aiHub?.changed();
      await bridge.teamVaultConfigStore.setLastSyncAt(vid, new Date().toISOString());
      // The first successful pull for a vault configured before its real vaultId was known
      // (joining: a target had to be set up under the pending sentinel to pull from at all —
      // see TEAM_VAULT_PENDING_VAULT_ID's doc comment) reveals that real id here. Promoting is a
      // no-op whenever there was nothing pending (the common case, every pull after the first).
      await bridge.teamVaultConfigStore.promotePendingConfig(vid);
      return bridge.buildTeamVaultStatus(vid);
    }
  );

  bridge.registerHandler(IPC_CHANNELS.TEAM_VAULT_HAS_REMOTE_VAULT, async (_event, vaultId: string): Promise<boolean> => {
    const vid = requireVaultId(vaultId);
    const config = await bridge.teamVaultConfigStore.getConfig(vid);
    if (!config.target) return false;
    const provider = await bridge.storageRegistry.getOrCreate(config.target);
    return bridge.teamVaultService.hasRemoteVault(vid, provider, config.remoteBasePath ?? '');
  });

  // Best-effort (§14/§15: shown before Push/Pull, not load-bearing) — any failure (no target
  // configured yet, locked vault, a transient network error) just reports "nothing to sync".
  bridge.registerHandler(
    IPC_CHANNELS.TEAM_VAULT_GET_SYNC_PREVIEW,
    async (_event, vaultId: string): Promise<TeamVaultSyncPreview> => {
      const vid = requireVaultId(vaultId);
      try {
        const config = await bridge.teamVaultConfigStore.getConfig(vid);
        if (!config.target) return { hasUnpushedLocalChanges: false, remoteChanged: false };
        const provider = await bridge.storageRegistry.getOrCreate(config.target);
        return await bridge.teamVaultService.getSyncPreview(vid, provider, config.remoteBasePath ?? '');
      } catch (err) {
        teamVaultLog.warn(`Failed to build sync preview (vaultId=${vid}):`, err);
        return { hasUnpushedLocalChanges: false, remoteChanged: false };
      }
    }
  );

  // "Test Connection" from the target editor: the form's secret can be deliberately blank
  // (meaning "use the saved one" — see TeamVaultStatus.targetConfig's doc comment), so substitute
  // it the same way TEAM_VAULT_SET_TARGET's own guard does before handing off to the same S3
  // connection check the generic "Test Connection" flow uses.
  bridge.registerHandler(
    IPC_CHANNELS.TEAM_VAULT_TEST_TARGET,
    async (_event, vaultId: string, config: S3Config): Promise<{ success: boolean; error?: string }> => {
      const vid = requireVaultId(vaultId);
      if (!config?.secretAccessKey) {
        const existingTarget = (await bridge.teamVaultConfigStore.getConfig(vid)).target;
        if (existingTarget?.type === 's3' && existingTarget.s3Config?.secretAccessKey) {
          config = { ...config, secretAccessKey: existingTarget.s3Config.secretAccessKey };
        }
      }
      return testS3ConnectionConfig(config);
    }
  );

  // Shared SSH/S3 profiles (connection-manager-plan: the Team Vault's actual payoff) — any
  // unlocked member may read/edit them, not just an admin (see TeamVaultService.saveSSHProfile's
  // doc comment: profiles aren't a membership trust boundary). The one exception is the
  // password/secret fields themselves — getPayloadForRenderer strips those for a non-admin
  // before this ever reaches the renderer (see its doc comment).
  bridge.registerHandler(IPC_CHANNELS.TEAM_VAULT_GET_PAYLOAD, async (_event, vaultId: string): Promise<TeamVaultPayload | null> => {
    const vid = requireVaultId(vaultId);
    if (!bridge.teamVaultService.isUnlocked(vid)) return null;
    try {
      return await bridge.teamVaultService.getPayloadForRenderer(vid);
    } catch (err) {
      teamVaultLog.warn('Failed to read Team Vault payload (treating as unavailable):', err);
      return null;
    }
  });

  bridge.registerHandler(IPC_CHANNELS.TEAM_VAULT_SAVE_SSH_PROFILE, async (_event, vaultId: string, profile: SSHConnectionConfig) => {
    const vid = requireVaultId(vaultId);
    requireProfile(profile, 'SSH profile');
    await bridge.teamVaultService.saveSSHProfile(vid, withNormalizedSystem(withNormalizedTags(profile)));
    bridge.aiHub?.changed();
    bridge.scheduleTeamVaultAutoPush(vid);
  });

  bridge.registerHandler(IPC_CHANNELS.TEAM_VAULT_DELETE_SSH_PROFILE, async (_event, vaultId: string, id: string) => {
    const vid = requireVaultId(vaultId);
    requireRecipientId(id, 'Profile id');
    await bridge.teamVaultService.deleteSSHProfile(vid, id);
    bridge.aiHub?.changed();
    bridge.scheduleTeamVaultAutoPush(vid);
  });

  bridge.registerHandler(IPC_CHANNELS.TEAM_VAULT_SAVE_K8S_PROFILE, async (_event, vaultId: string, profile: unknown) => {
    const vid = requireVaultId(vaultId);
    requireProfile(profile, 'K8s profile');
    // Only the template fields get through (no context name, tombstone or token); the service stamps updatedAt.
    await bridge.teamVaultService.saveK8sProfile(vid, toTeamK8sProfile(profile));
    bridge.scheduleTeamVaultAutoPush(vid);
  });

  bridge.registerHandler(IPC_CHANNELS.TEAM_VAULT_DELETE_K8S_PROFILE, async (_event, vaultId: string, id: string) => {
    const vid = requireVaultId(vaultId);
    requireRecipientId(id, 'Profile id');
    await bridge.teamVaultService.deleteK8sProfile(vid, id);
    bridge.scheduleTeamVaultAutoPush(vid);
  });

  bridge.registerHandler(IPC_CHANNELS.TEAM_VAULT_SAVE_S3_PROFILE, async (_event, vaultId: string, profile: S3Config) => {
    const vid = requireVaultId(vaultId);
    requireProfile(profile, 'S3 profile');
    await bridge.teamVaultService.saveS3Profile(vid, withNormalizedTags(profile));
    bridge.scheduleTeamVaultAutoPush(vid);
  });

  bridge.registerHandler(IPC_CHANNELS.TEAM_VAULT_DELETE_S3_PROFILE, async (_event, vaultId: string, id: string) => {
    const vid = requireVaultId(vaultId);
    requireRecipientId(id, 'Profile id');
    await bridge.teamVaultService.deleteS3Profile(vid, id);
    bridge.scheduleTeamVaultAutoPush(vid);
  });

  bridge.registerHandler(IPC_CHANNELS.TEAM_VAULT_SAVE_FOLDER, async (_event, vaultId: string, folderPath: string) => {
    const vid = requireVaultId(vaultId);
    requireFolderPath(folderPath, 'Folder path');
    await bridge.teamVaultService.saveTeamFolder(vid, folderPath);
    bridge.scheduleTeamVaultAutoPush(vid);
  });

  bridge.registerHandler(
    IPC_CHANNELS.TEAM_VAULT_RENAME_FOLDER,
    async (_event, vaultId: string, oldPath: string, newPath: string) => {
      const vid = requireVaultId(vaultId);
      requireFolderPath(oldPath, 'Folder path');
      requireFolderPath(newPath, 'New folder path');
      await bridge.teamVaultService.renameTeamFolder(vid, oldPath, newPath);
      bridge.scheduleTeamVaultAutoPush(vid);
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.TEAM_VAULT_DELETE_FOLDER,
    async (_event, vaultId: string, folderPath: string, deleteProfiles?: boolean) => {
      const vid = requireVaultId(vaultId);
      requireFolderPath(folderPath, 'Folder path');
      await bridge.teamVaultService.deleteTeamFolder(vid, folderPath, Boolean(deleteProfiles));
      bridge.scheduleTeamVaultAutoPush(vid);
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.TEAM_VAULT_SET_FOLDER_ICON,
    async (_event, vaultId: string, folderPath: string, icon: string | undefined) => {
      const vid = requireVaultId(vaultId);
      requireFolderPath(folderPath, 'Folder path');
      if (icon !== undefined && !(TEAM_FOLDER_ICONS as readonly string[]).includes(icon)) {
        throw new Error(`Unknown folder icon "${icon}"`);
      }
      await bridge.teamVaultService.setTeamFolderIcon(vid, folderPath, icon);
      bridge.scheduleTeamVaultAutoPush(vid);
    }
  );
}
