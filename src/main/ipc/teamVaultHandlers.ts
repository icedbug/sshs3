import path from 'node:path';
import { IPC_CHANNELS, type StorageConnectConfig } from '../../shared/types/ipc';
import { TEAM_FOLDER_ICONS, type TeamVaultPayload, type TeamVaultRole, type TeamVaultStatus } from '../../shared/types/teamVault';
import type { SSHConnectionConfig } from '../../shared/types/ssh';
import type { S3Config } from '../../shared/types/storage';
import type { IpcBridge } from '../IpcBridge';
import { readSmartcardCertificates } from '../smartcard/SmartcardCertificateReader';
import { createLogger } from '../log';

const teamVaultLog = createLogger('team-vault');

/** The part of IpcBridge this handler group may use. */
export type TeamVaultHost = Pick<
  IpcBridge,
  | 'aiHub'
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

function requireRecipientId(value: string, label: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) {
    throw new Error(`${label} is required`);
  }
}

function requireRole(role: TeamVaultRole): void {
  if (role !== 'admin' && role !== 'member') {
    throw new Error(`Invalid role "${role}"`);
  }
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
  if (typeof value !== 'string' || value.length > 200) {
    throw new Error('Vault name must be a string of at most 200 characters');
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
  bridge.registerHandler(IPC_CHANNELS.TEAM_VAULT_GET_STATUS, async (): Promise<TeamVaultStatus> => {
    return bridge.buildTeamVaultStatus();
  });

  bridge.registerHandler(IPC_CHANNELS.TEAM_VAULT_ENROLL_RECIPIENT, async () => {
    const result = await bridge.teamVaultService.enrollOwnPivRecipient();
    // Only remember this identity when there's no local vault yet — this is the first-time
    // setup flow (about to create or join one), the one case `createVault`'s own
    // `setSelfIdentity` call relies on this having already saved the path. "Generate my
    // recipient" is also always visible once a vault already exists (for joining a *second*
    // team later — docs/team-vault-plan.md), and must NOT overwrite the identity `unlock()`
    // already needs for the current vault — a real regression found via real-world use
    // ("no identity matched any of the recipients" on the next unlock attempt).
    const { exists } = await bridge.teamVaultService.getStatus();
    if (!exists) {
      await bridge.teamVaultConfigStore.setSelfIdentity(undefined, result.identityFilePath);
    }
    const suggestedLabel = await suggestLabelFromSmartcard(bridge);
    return { ...result, suggestedLabel };
  });

  bridge.registerHandler(
    IPC_CHANNELS.TEAM_VAULT_CREATE,
    async (_event, selfRecipientId: string, selfAgeRecipient: string, vaultName?: string) => {
      requireRecipientId(selfRecipientId, 'Recipient id');
      requireAgeRecipient(selfAgeRecipient, 'Age recipient');
      requireVaultName(vaultName ?? '');
      const result = await bridge.teamVaultService.createVault(selfRecipientId, selfAgeRecipient, vaultName);
      await bridge.teamVaultConfigStore.setSelfIdentity(selfRecipientId, undefined);
      bridge.startTeamVaultAutoPollTimer();
      return result;
    }
  );

  bridge.registerHandler(IPC_CHANNELS.TEAM_VAULT_RENAME, async (_event, vaultName: string) => {
    requireVaultName(vaultName);
    await bridge.teamVaultService.renameVault(vaultName);
    bridge.scheduleTeamVaultAutoPush();
  });

  bridge.registerHandler(
    IPC_CHANNELS.TEAM_VAULT_ADD_MEMBER,
    async (_event, recipientId: string, ageRecipient: string, role: TeamVaultRole) => {
      requireRecipientId(recipientId, 'Recipient id');
      requireAgeRecipient(ageRecipient, 'Age recipient');
      requireRole(role);
      await bridge.teamVaultService.addMember(recipientId, ageRecipient, role);
    }
  );

  bridge.registerHandler(IPC_CHANNELS.TEAM_VAULT_REMOVE_MEMBER, async (_event, recipientId: string) => {
    requireRecipientId(recipientId, 'Recipient id');
    return bridge.teamVaultService.removeMember(recipientId);
  });

  bridge.registerHandler(
    IPC_CHANNELS.TEAM_VAULT_SET_ROLE,
    async (_event, recipientId: string, role: TeamVaultRole) => {
      requireRecipientId(recipientId, 'Recipient id');
      requireRole(role);
      await bridge.teamVaultService.setRole(recipientId, role);
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.TEAM_VAULT_UNLOCK,
    async (_event, recipientId: string, identityFilePath: string) => {
      requireRecipientId(recipientId, 'Recipient id');
      requireIdentityFilePath(identityFilePath);
      await bridge.teamVaultService.unlock(recipientId, identityFilePath);
      await bridge.teamVaultConfigStore.setSelfIdentity(recipientId, identityFilePath);
      bridge.startTeamVaultAutoPollTimer();
    }
  );

  bridge.registerHandler(IPC_CHANNELS.TEAM_VAULT_UNLOCK_WITH_RECOVERY_TEXT, async (_event, identityText: string) => {
    if (typeof identityText !== 'string' || !identityText.trim() || identityText.length > 10_000) {
      throw new Error('Recovery key text is required');
    }
    await bridge.teamVaultService.unlockWithRecoveryText(identityText);
    bridge.startTeamVaultAutoPollTimer();
  });

  bridge.registerHandler(IPC_CHANNELS.TEAM_VAULT_LOCK, async () => {
    bridge.teamVaultService.lock();
    bridge.stopTeamVaultAutoPollTimer();
  });

  bridge.registerHandler(IPC_CHANNELS.TEAM_VAULT_DELETE, async () => {
    await bridge.teamVaultService.deleteVault();
    await bridge.teamVaultConfigStore.clearSelfIdentity();
    bridge.stopTeamVaultAutoPollTimer();
  });

  bridge.registerHandler(
    IPC_CHANNELS.TEAM_VAULT_SET_TARGET,
    async (_event, target: StorageConnectConfig, remoteBasePath?: string) => {
      if (!target || !target.id || !target.name) {
        throw new Error('A Team Vault target with an id and name is required');
      }
      if (target.type !== 's3') {
        throw new Error('The Team Vault only supports an S3-compatible target');
      }
      if (!remoteBasePath?.trim()) {
        throw new Error('An S3 target requires a bucket (optionally "bucket/prefix") to sync to');
      }
      await bridge.teamVaultConfigStore.setTarget(target, remoteBasePath);
      await bridge.storageRegistry.disconnect?.(target.id);
      // The (app-lifetime) TeamVaultService instance otherwise keeps comparing against whatever
      // remote state it last observed on the *previous* target — same reasoning as
      // ProfileSyncService.resetRemoteState() in syncHandlers.ts.
      bridge.teamVaultService.resetRemoteState();
      // Restart rather than merely leave running: a stale timer would otherwise keep polling
      // against whatever target it captured when first started, not this new one.
      if (bridge.teamVaultService.isUnlocked()) {
        bridge.startTeamVaultAutoPollTimer();
      }
    }
  );

  bridge.registerHandler(IPC_CHANNELS.TEAM_VAULT_PUSH, async (): Promise<TeamVaultStatus> => {
    const config = await bridge.teamVaultConfigStore.getConfig();
    if (!config.target) {
      throw new Error('Configure a Team Vault target first (team-vault:set-target)');
    }
    const provider = await bridge.storageRegistry.getOrCreate(config.target);
    await bridge.teamVaultService.pushToRemote(provider, config.remoteBasePath ?? '');
    await bridge.teamVaultConfigStore.setLastSyncAt(new Date().toISOString());
    return bridge.buildTeamVaultStatus();
  });

  bridge.registerHandler(
    IPC_CHANNELS.TEAM_VAULT_PULL,
    async (_event, options?: { force?: boolean }): Promise<TeamVaultStatus> => {
      const config = await bridge.teamVaultConfigStore.getConfig();
      if (!config.target) {
        throw new Error('Configure a Team Vault target first (team-vault:set-target)');
      }
      const provider = await bridge.storageRegistry.getOrCreate(config.target);
      await bridge.teamVaultService.pullFromRemote(provider, config.remoteBasePath ?? '', options);
      bridge.aiHub?.changed();
      await bridge.teamVaultConfigStore.setLastSyncAt(new Date().toISOString());
      return bridge.buildTeamVaultStatus();
    }
  );

  bridge.registerHandler(IPC_CHANNELS.TEAM_VAULT_HAS_REMOTE_VAULT, async (): Promise<boolean> => {
    const config = await bridge.teamVaultConfigStore.getConfig();
    if (!config.target) return false;
    const provider = await bridge.storageRegistry.getOrCreate(config.target);
    return bridge.teamVaultService.hasRemoteVault(provider, config.remoteBasePath ?? '');
  });

  // Shared SSH/S3 profiles (connection-manager-plan: the Team Vault's actual payoff) — any
  // unlocked member may read/edit them, not just an admin (see TeamVaultService.saveSSHProfile's
  // doc comment: profiles aren't a membership trust boundary). The one exception is the
  // password/secret fields themselves — getPayloadForRenderer strips those for a non-admin
  // before this ever reaches the renderer (see its doc comment).
  bridge.registerHandler(IPC_CHANNELS.TEAM_VAULT_GET_PAYLOAD, async (): Promise<TeamVaultPayload | null> => {
    if (!bridge.teamVaultService.isUnlocked()) return null;
    try {
      return await bridge.teamVaultService.getPayloadForRenderer();
    } catch (err) {
      teamVaultLog.warn('Failed to read Team Vault payload (treating as unavailable):', err);
      return null;
    }
  });

  bridge.registerHandler(IPC_CHANNELS.TEAM_VAULT_SAVE_SSH_PROFILE, async (_event, profile: SSHConnectionConfig) => {
    requireProfile(profile, 'SSH profile');
    await bridge.teamVaultService.saveSSHProfile(profile);
    bridge.aiHub?.changed();
    bridge.scheduleTeamVaultAutoPush();
  });

  bridge.registerHandler(IPC_CHANNELS.TEAM_VAULT_DELETE_SSH_PROFILE, async (_event, id: string) => {
    requireRecipientId(id, 'Profile id');
    await bridge.teamVaultService.deleteSSHProfile(id);
    bridge.aiHub?.changed();
    bridge.scheduleTeamVaultAutoPush();
  });

  bridge.registerHandler(IPC_CHANNELS.TEAM_VAULT_SAVE_S3_PROFILE, async (_event, profile: S3Config) => {
    requireProfile(profile, 'S3 profile');
    await bridge.teamVaultService.saveS3Profile(profile);
    bridge.scheduleTeamVaultAutoPush();
  });

  bridge.registerHandler(IPC_CHANNELS.TEAM_VAULT_DELETE_S3_PROFILE, async (_event, id: string) => {
    requireRecipientId(id, 'Profile id');
    await bridge.teamVaultService.deleteS3Profile(id);
    bridge.scheduleTeamVaultAutoPush();
  });

  bridge.registerHandler(IPC_CHANNELS.TEAM_VAULT_SAVE_FOLDER, async (_event, folderPath: string) => {
    requireFolderPath(folderPath, 'Folder path');
    await bridge.teamVaultService.saveTeamFolder(folderPath);
    bridge.scheduleTeamVaultAutoPush();
  });

  bridge.registerHandler(IPC_CHANNELS.TEAM_VAULT_RENAME_FOLDER, async (_event, oldPath: string, newPath: string) => {
    requireFolderPath(oldPath, 'Folder path');
    requireFolderPath(newPath, 'New folder path');
    await bridge.teamVaultService.renameTeamFolder(oldPath, newPath);
    bridge.scheduleTeamVaultAutoPush();
  });

  bridge.registerHandler(
    IPC_CHANNELS.TEAM_VAULT_DELETE_FOLDER,
    async (_event, folderPath: string, deleteProfiles?: boolean) => {
      requireFolderPath(folderPath, 'Folder path');
      await bridge.teamVaultService.deleteTeamFolder(folderPath, Boolean(deleteProfiles));
      bridge.scheduleTeamVaultAutoPush();
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.TEAM_VAULT_SET_FOLDER_ICON,
    async (_event, folderPath: string, icon: string | undefined) => {
      requireFolderPath(folderPath, 'Folder path');
      if (icon !== undefined && !(TEAM_FOLDER_ICONS as readonly string[]).includes(icon)) {
        throw new Error(`Unknown folder icon "${icon}"`);
      }
      await bridge.teamVaultService.setTeamFolderIcon(folderPath, icon);
      bridge.scheduleTeamVaultAutoPush();
    }
  );
}
