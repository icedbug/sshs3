import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { IStorageProvider, FileEntry } from '../../shared/types/storage';
import type { SSHConnectionConfig } from '../../shared/types/ssh';
import type { S3Config } from '../../shared/types/storage';
import type { DotfilePool, DotfilePoolFile } from '../../shared/types/dotfiles';
import type { AppSettings } from '../../shared/types/settings';
import { ProfileStore, type ProfilesData } from '../profile/ProfileStore';
import { DotfilePoolStore } from '../dotfiles/DotfilePoolStore';
import type { DirectorySyncProfileStore } from '../dirsync/DirectorySyncProfileStore';
import type { DirectorySyncProfile } from '../../shared/types/dirsync';
import { SettingsStore } from '../settings/SettingsStore';
import { SyncCryptoService, SyncLockedError, type SyncDataCategory } from './SyncCryptoService';
import { joinPaths } from '../transfer/TransferPipeline';
import {
  mergeKnownHosts,
  parseManagedSshConfigBlock,
  writeManagedSshConfigBlock,
  buildManagedSshConfigBlockFromProfiles,
  buildAgentSshConfigBody,
  writeAgentSshConfigBlock,
  type AgentHostEntry,
  type KnownHostsConflict,
  type ManagedSshConfigBlock,
} from './SshNativeFileMerger';

const SYNC_DIR_NAME = '.sshs3';

function formatTimestamp(d = new Date()): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

/**
 * Builds the remote file paths for a sync target. `remoteBasePath` is
 * required for an S3 target — an S3 "remotePath" is `bucket/key...` with no
 * bucket embedded in S3Config itself (see parseS3Path in
 * S3StorageProvider.ts) — so the bucket (and optionally a sub-path) must be
 * prefixed here. For an SFTP target it's the directory to sync under
 * (empty = the connection's default/home directory).
 */
/**
 * For an SFTP target, anchors a relative base path to the home directory
 * (`~`) explicitly. `SFTPStorageProvider.resolveRemotePath` only resolves
 * paths that are empty or start with `~` against the real home directory —
 * a bare relative path like `.sshs3` is passed through to the server
 * unresolved, and the underlying SFTP client's recursive `mkdir` does not
 * reliably create it in that form, so the very first upload fails with the
 * server's "No such file". S3 paths are always `bucket/key...` already, so
 * this is a no-op for an S3 target.
 */
function resolveEffectiveBasePath(provider: IStorageProvider, remoteBasePath: string): string {
  if (provider.type !== 'sftp') return remoteBasePath;
  const trimmed = remoteBasePath.trim();
  if (!trimmed) return '~';
  if (trimmed.startsWith('/') || trimmed.startsWith('~')) return trimmed;
  return `~/${trimmed}`;
}

function buildRemoteFiles(remoteBasePath: string): Record<SyncDataCategory, string> {
  const dir = joinPaths('sftp', remoteBasePath, SYNC_DIR_NAME);
  return {
    topology: joinPaths('sftp', dir, 'topology.enc'),
    credentials: joinPaths('sftp', dir, 'credentials.enc'),
    'dotfile-pools': joinPaths('sftp', dir, 'dotfile-pools.enc'),
    settings: joinPaths('sftp', dir, 'settings.enc'),
    'ssh-native': joinPaths('sftp', dir, 'ssh-native.enc'),
    'dirsync-profiles': joinPaths('sftp', dir, 'dirsync-profiles.enc'),
  };
}

/**
 * Path of the marker written for the duration of a push (M4, code review).
 * The 5 category files are uploaded sequentially with no cross-file
 * transaction, so a crash/network drop partway through leaves a mix of
 * new and old category versions. This marker is written before the first
 * upload and removed only after the last one succeeds, so a pull or
 * compare that finds it present knows the remote data may currently be an
 * inconsistent partial push rather than a clean, in-sync state.
 */
function buildPushMarkerPath(remoteBasePath: string): string {
  const dir = joinPaths('sftp', remoteBasePath, SYNC_DIR_NAME);
  return joinPaths('sftp', dir, '.push-in-progress');
}

export class SyncConflictError extends Error {
  constructor(category: SyncDataCategory) {
    super(
      `Remote "${category}" file changed since it was last read here. Pull the latest changes before pushing again.`
    );
    this.name = 'SyncConflictError';
  }
}

export class SyncInProgressError extends Error {
  constructor() {
    super(
      'The remote sync data looks like a partial push (interrupted mid-upload) rather than a consistent snapshot. ' +
        'Push again from a device with current data to repair it before pulling.'
    );
    this.name = 'SyncInProgressError';
  }
}

interface Syncable {
  id: string;
  updatedAt?: string;
  deletedAt?: string;
}

/**
 * Merges two arrays of the same syncable record type by id, last-`updatedAt`
 * wins. When the remote copy wins, it's applied on top of the existing local
 * record (not used to replace it outright) so that fields never included in
 * the synced payload — e.g. a local SSH private key path — survive the pull.
 */
export function mergeRecords<T extends Syncable>(local: T[], remote: T[]): { merged: T[]; changed: boolean } {
  const byId = new Map<string, T>();
  for (const item of local) byId.set(item.id, item);
  let changed = false;

  for (const remoteItem of remote) {
    const localItem = byId.get(remoteItem.id);
    if (!localItem) {
      byId.set(remoteItem.id, remoteItem);
      changed = true;
      continue;
    }
    const remoteTime = remoteItem.updatedAt ?? '';
    const localTime = localItem.updatedAt ?? '';
    if (remoteTime > localTime) {
      const mergedItem: any = { ...localItem, ...remoteItem };
      if (!remoteItem.deletedAt && (localItem as any).deletedAt) {
        delete mergedItem.deletedAt;
      }
      byId.set(remoteItem.id, mergedItem);
      changed = true;
    } else if (remoteTime === localTime) {
      // If timestamps match, but remote has fields that local is missing
      // (e.g. topology was pulled first, credentials unlocked and pulled second),
      // merge the non-empty fields in without overwriting existing local values.
      let updated = false;
      const mergedItem: any = { ...localItem };
      for (const [key, val] of Object.entries(remoteItem)) {
        if (val !== undefined && val !== '' && (mergedItem[key] === undefined || mergedItem[key] === '')) {
          mergedItem[key] = val;
          updated = true;
        }
      }
      if (updated) {
        byId.set(remoteItem.id, mergedItem);
        changed = true;
      }
    }
  }

  return { merged: Array.from(byId.values()), changed };
}

/**
 * Nested merge for dotfile pools: a pool-level tombstone that's newer than
 * the other side wins outright (no point merging files of a pool being
 * deleted); otherwise the pool "shell" (name etc.) is taken from whichever
 * side is newer, but its files are always merged independently via
 * mergeRecords, since a file can be edited on one machine while a sibling
 * file in the same pool is edited on another.
 */
/** Removes fields that only make sense on this device (local source paths) before a pool is pushed. */
export function stripDeviceLocalPoolFields(pool: DotfilePool): DotfilePool {
  return {
    ...pool,
    files: pool.files.map((f) => {
      const { sourcePath: _sourcePath, ...rest } = f;
      return rest;
    }),
  };
}

export function mergePools(
  local: DotfilePool[],
  remote: DotfilePool[]
): { merged: DotfilePool[]; changedIds: Set<string> } {
  // A remote pool is untrusted input: a sourcePath it carries would make
  // "Refresh" read an arbitrary local file into the pool, so drop it up front
  // (this device's own sourcePath values are re-applied below from `local`).
  remote = remote.map(stripDeviceLocalPoolFields);
  const byId = new Map<string, DotfilePool>();
  for (const pool of local) byId.set(pool.id, pool);
  const changedIds = new Set<string>();

  for (const remotePool of remote) {
    const localPool = byId.get(remotePool.id);
    if (!localPool) {
      byId.set(remotePool.id, remotePool);
      changedIds.add(remotePool.id);
      continue;
    }

    const remoteIsNewer = (remotePool.updatedAt ?? '') > (localPool.updatedAt ?? '');

    if (remoteIsNewer && remotePool.deletedAt) {
      byId.set(remotePool.id, remotePool);
      changedIds.add(remotePool.id);
      continue;
    }
    if (!remoteIsNewer && localPool.deletedAt) {
      continue; // Local tombstone stands as-is.
    }

    const { merged: mergedFiles, changed: filesChanged } = mergeRecords<DotfilePoolFile>(
      localPool.files,
      remotePool.files
    );
    const winnerShell = remoteIsNewer ? remotePool : localPool;
    // sourcePath is a local filesystem path: keep this device's value, never the remote's.
    const localSources = new Map(localPool.files.map((f) => [f.id, f.sourcePath]));
    const filesWithLocalSources = mergedFiles.map((f) => {
      const { sourcePath: _remoteSource, ...rest } = f;
      const local = localSources.get(f.id);
      return local ? { ...rest, sourcePath: local } : rest;
    });
    byId.set(remotePool.id, { ...winnerShell, files: filesWithLocalSources });
    if (remoteIsNewer || filesChanged) {
      changedIds.add(remotePool.id);
    }
  }

  return { merged: Array.from(byId.values()), changedIds };
}

interface FieldSplitSpec<T> {
  /** Fields that hold secrets and belong in credentials.enc, not topology.enc. */
  credentialFields: Array<keyof T>;
  /** Local-only fields (e.g. a filesystem path to a private key) that are never synced at all. */
  excludedFields: Array<keyof T>;
  /** Sub-fields of an optional `proxy` object that are credential-tier. */
  proxyCredentialFields: Array<'username' | 'password'>;
}

const SSH_FIELD_SPLIT: FieldSplitSpec<SSHConnectionConfig> = {
  credentialFields: ['username', 'password', 'passphrase'],
  excludedFields: ['privateKeyPath', 'pkcs11LibPath', 'agentPath', 'agentIdentityFiles', 'pin'],
  proxyCredentialFields: ['username', 'password'],
};

const S3_FIELD_SPLIT: FieldSplitSpec<S3Config> = {
  credentialFields: ['accessKeyId', 'secretAccessKey', 'sessionToken'],
  excludedFields: ['customCaPath'],
  proxyCredentialFields: ['username', 'password'],
};

/**
 * Removes local-only fields (see FieldSplitSpec.excludedFields) from records received in a pull.
 * Those fields are never pushed, so a remote copy carrying them can only be planted — and they
 * point at local files/libraries that get loaded or executed on the next connection.
 */
function stripLocalOnlyFields<T extends object>(items: T[], spec: { excludedFields: Array<keyof T> }): T[] {
  return items.map((item) => {
    const copy: any = { ...item };
    for (const field of spec.excludedFields) delete copy[field];
    return copy as T;
  });
}

/**
 * Settings that name a local executable, library or its arguments. They are machine-specific
 * and, if taken from a remote copy, would let a compromised sync source choose what the app
 * launches — so they are neither pushed nor applied from a pull.
 */
const LOCAL_ONLY_SETTINGS = ['x11ServerPath', 'x11ServerArgs', 'smartcardLibPath'] as const;

function withoutLocalOnlySettings(settings: AppSettings): AppSettings {
  const copy: any = { ...settings };
  for (const key of LOCAL_ONLY_SETTINGS) delete copy[key];
  return copy as AppSettings;
}

/** `remote` with the local-only settings taken from `local` instead. */
function withLocalOnlySettingsFrom(remote: AppSettings, local: AppSettings): AppSettings {
  const copy: any = withoutLocalOnlySettings(remote);
  for (const key of LOCAL_ONLY_SETTINGS) {
    if (local[key] !== undefined) copy[key] = local[key];
  }
  return copy as AppSettings;
}

/** Splits one record into its topology-tier and credentials-tier halves, both keeping `id` so they can be rejoined. */
function splitFields<T extends { id: string; proxy?: { username?: string; password?: string } }>(
  item: T,
  spec: FieldSplitSpec<T>
): { topology: Partial<T>; credentials: Partial<T> } {
  const topology: any = { ...item };
  for (const field of spec.excludedFields) {
    delete topology[field];
  }

  const credentials: any = { id: item.id };
  for (const field of spec.credentialFields) {
    if (topology[field] !== undefined) {
      credentials[field] = topology[field];
    }
    delete topology[field];
  }

  if (topology.proxy && spec.proxyCredentialFields.length > 0) {
    const proxy = { ...topology.proxy };
    const proxyCredentials: any = {};
    for (const field of spec.proxyCredentialFields) {
      if (proxy[field] !== undefined) {
        proxyCredentials[field] = proxy[field];
      }
      delete proxy[field];
    }
    topology.proxy = proxy;
    if (Object.keys(proxyCredentials).length > 0) {
      credentials.proxy = proxyCredentials;
    }
  }

  return { topology, credentials };
}

/** Rejoins a topology half with its matching credentials half (if any) back into one full record. */
function joinFields<T extends { id: string; proxy?: any }>(topology: Partial<T>, credentials?: Partial<T>): T {
  const merged: any = { ...topology };
  if (credentials) {
    for (const [key, value] of Object.entries(credentials)) {
      if (key === 'id') continue;
      if (key === 'proxy') {
        merged.proxy = { ...(merged.proxy ?? {}), ...(value as any) };
      } else {
        merged[key] = value;
      }
    }
  }
  return merged as T;
}

function joinById<T extends { id: string }>(topologyHalves: Partial<T>[], credentialHalves: Partial<T>[]): T[] {
  const credentialsById = new Map<string, Partial<T>>();
  for (const half of credentialHalves) {
    if (half.id) credentialsById.set(half.id, half);
  }
  const ids = new Set<string>();
  const results: T[] = [];
  for (const topologyHalf of topologyHalves) {
    if (!topologyHalf.id || ids.has(topologyHalf.id)) continue;
    ids.add(topologyHalf.id);
    results.push(joinFields<T>(topologyHalf, credentialsById.get(topologyHalf.id)));
  }
  return results;
}

import type { WorkspaceActivityEvent, WorkspaceMemoryEntry } from '../../shared/types/teamVault';

interface TopologyPayload {
  workspaceMemories?: WorkspaceMemoryEntry[];
  activityLog?: WorkspaceActivityEvent[];
  ssh: Partial<SSHConnectionConfig>[];
  s3: Partial<S3Config>[];
}
interface CredentialsPayload {
  ssh: Partial<SSHConnectionConfig>[];
  s3: Partial<S3Config>[];
}
interface DotfilePoolsPayload {
  pools: DotfilePool[];
}
interface DirSyncProfilesPayload {
  profiles: DirectorySyncProfile[];
}
interface SshNativePayload {
  sshConfigBlock: { updatedAt: string; body: string } | null;
  knownHostsContent: string;
}

import type {
  ProfileSyncPullResult,
  SyncComparisonResult,
  CategoryComparison,
} from '../../shared/types/sync';
import { createLogger } from '../log';
const sshs3Log = createLogger('sshs3');

export type PullResult = ProfileSyncPullResult;

export interface ProfileSyncServiceOptions {
  /** Saved directory-sync pairs to include in the sync; omitted = that category is skipped. */
  directorySyncProfileStore?: DirectorySyncProfileStore;
  sshConfigPath?: string;
  knownHostsPath?: string;
}

export function getComparisonState(ahead: number, behind: number): 'in_sync' | 'ahead' | 'behind' | 'diverged' {
  if (ahead > 0 && behind > 0) return 'diverged';
  if (ahead > 0) return 'ahead';
  if (behind > 0) return 'behind';
  return 'in_sync';
}

export function compareRecords<T extends { id: string; name?: string; updatedAt?: string; deletedAt?: string }>(
  local: T[],
  remote: T[],
  label: string,
  spec?: FieldSplitSpec<any>
): { ahead: number; behind: number; details: string[] } {
  const localById = new Map<string, T>();
  for (const item of local) localById.set(item.id, item);

  const remoteById = new Map<string, T>();
  for (const item of remote) remoteById.set(item.id, item);

  const allIds = new Set([...localById.keys(), ...remoteById.keys()]);
  let ahead = 0;
  let behind = 0;
  const details: string[] = [];

  for (const id of allIds) {
    const localItem = localById.get(id);
    const remoteItem = remoteById.get(id);

    if (localItem && !remoteItem) {
      if (!localItem.deletedAt) {
        ahead++;
        details.push(`${label} "${localItem.name ?? id}" created locally`);
      }
      continue;
    }

    if (!localItem && remoteItem) {
      if (!remoteItem.deletedAt) {
        behind++;
        details.push(`${label} "${remoteItem.name ?? id}" added on remote`);
      }
      continue;
    }

    if (localItem && remoteItem) {
      if (localItem.deletedAt && !remoteItem.deletedAt) {
        const localDel = localItem.deletedAt ?? '';
        const remoteUpd = remoteItem.updatedAt ?? '';
        if (localDel >= remoteUpd) {
          ahead++;
          details.push(`${label} "${localItem.name ?? id}" deleted locally`);
        } else {
          behind++;
          details.push(`${label} "${remoteItem.name ?? id}" updated on remote`);
        }
        continue;
      }

      if (!localItem.deletedAt && remoteItem.deletedAt) {
        const remoteDel = remoteItem.deletedAt ?? '';
        const localUpd = localItem.updatedAt ?? '';
        if (remoteDel >= localUpd) {
          behind++;
          details.push(`${label} "${remoteItem.name ?? id}" deleted on remote`);
        } else {
          ahead++;
          details.push(`${label} "${localItem.name ?? id}" updated locally`);
        }
        continue;
      }

      if (localItem.deletedAt && remoteItem.deletedAt) {
        continue; // Both deleted, in sync
      }

      // Both active
      const localTime = localItem.updatedAt ?? '';
      const remoteTime = remoteItem.updatedAt ?? '';
      if (localTime > remoteTime) {
        ahead++;
        details.push(`${label} "${localItem.name ?? id}" updated locally`);
      } else if (remoteTime > localTime) {
        behind++;
        details.push(`${label} "${remoteItem.name ?? id}" updated on remote`);
      } else if (spec) {
        const localSyncable = splitFields(localItem, spec);
        const remoteSyncable = splitFields(remoteItem, spec);
        if (JSON.stringify(localSyncable) !== JSON.stringify(remoteSyncable)) {
          ahead++;
          details.push(`${label} "${localItem.name ?? id}" modified locally`);
        }
      }
    }
  }

  return { ahead, behind, details };
}

export function compareDotfilePools(
  local: DotfilePool[],
  remote: DotfilePool[]
): { ahead: number; behind: number; details: string[] } {
  const localById = new Map<string, DotfilePool>();
  for (const pool of local) localById.set(pool.id, pool);

  const remoteById = new Map<string, DotfilePool>();
  for (const pool of remote) remoteById.set(pool.id, pool);

  const allIds = new Set([...localById.keys(), ...remoteById.keys()]);
  let ahead = 0;
  let behind = 0;
  const details: string[] = [];

  for (const id of allIds) {
    const localPool = localById.get(id);
    const remotePool = remoteById.get(id);

    if (localPool && !remotePool) {
      if (!localPool.deletedAt) {
        ahead++;
        details.push(`Dotfile pool "${localPool.name}" created locally`);
      }
      continue;
    }

    if (!localPool && remotePool) {
      if (!remotePool.deletedAt) {
        behind++;
        details.push(`Dotfile pool "${remotePool.name}" added on remote`);
      }
      continue;
    }

    if (localPool && remotePool) {
      if (localPool.deletedAt && !remotePool.deletedAt) {
        if ((localPool.deletedAt ?? '') >= (remotePool.updatedAt ?? '')) {
          ahead++;
          details.push(`Dotfile pool "${localPool.name}" deleted locally`);
        } else {
          behind++;
          details.push(`Dotfile pool "${remotePool.name}" updated on remote`);
        }
        continue;
      }

      if (!localPool.deletedAt && remotePool.deletedAt) {
        if ((remotePool.deletedAt ?? '') >= (localPool.updatedAt ?? '')) {
          behind++;
          details.push(`Dotfile pool "${remotePool.name}" deleted on remote`);
        } else {
          ahead++;
          details.push(`Dotfile pool "${localPool.name}" updated locally`);
        }
        continue;
      }

      if (localPool.deletedAt && remotePool.deletedAt) {
        continue;
      }

      // Check pool files
      const fileComp = compareRecords(localPool.files, remotePool.files, `File in "${localPool.name}"`);
      if (fileComp.ahead > 0 || fileComp.behind > 0) {
        ahead += fileComp.ahead;
        behind += fileComp.behind;
        details.push(...fileComp.details);
      } else {
        const localTime = localPool.updatedAt ?? '';
        const remoteTime = remotePool.updatedAt ?? '';
        if (localTime > remoteTime) {
          ahead++;
          details.push(`Dotfile pool "${localPool.name}" updated locally`);
        } else if (remoteTime > localTime) {
          behind++;
          details.push(`Dotfile pool "${remotePool.name}" updated on remote`);
        }
      }
    }
  }

  return { ahead, behind, details };
}

/**
 * Pushes/pulls the app's local data to/from a remote S3/SFTP location as a
 * set of Zero-Knowledge encrypted files, via an already-connected
 * IStorageProvider. Handling of the sync target's own connection details and
 * of the master passwords' lifecycle (setup/enable/unlock UI) is a separate
 * concern (IPC + Renderer layer) — this service only implements the crypto,
 * merge, and file-transfer mechanics.
 */
export class ProfileSyncService {
  private readonly sshConfigPath: string;
  private readonly knownHostsPath: string;
  /**
   * Last known remote file state per category, used for optimistic
   * concurrency (see checkNotChangedRemotely). In-memory only for this
   * service — persisting it across app restarts is a concern for the
   * IPC/settings layer that owns this service's lifecycle.
   */
  private readonly lastKnownRemoteState = new Map<SyncDataCategory, FileEntry | null>();
  private lastComparison: SyncComparisonResult | null = null;

  public getLastComparison(): SyncComparisonResult | null {
    return this.lastComparison;
  }

  /**
   * Clears the cached "last known remote state" used by checkNotChangedRemotely().
   * Must be called whenever the configured sync target or remoteBasePath changes:
   * this service instance lives for the app's whole lifetime (see IpcBridge), so
   * without this, a stat recorded against a *previous* target would otherwise be
   * compared against the newly configured one on the next push — producing a
   * spurious SyncConflictError (or, worse, silently masking a real one) since the
   * two targets' remote files have nothing to do with each other.
   */
  public resetRemoteState(): void {
    this.lastKnownRemoteState.clear();
    this.lastComparison = null;
  }

  private readonly dirSyncProfileStore?: DirectorySyncProfileStore;

  private sshConfigWriteQueue: Promise<unknown> = Promise.resolve();
  /** Called after every automatic sync of the managed ~/.ssh/config block (also after a remote pull). */
  public onLocalSshConfigSynced?: () => void;
  public workspaceStateProvider?: {
    getState: () => Promise<{
      workspaceMemories?: TopologyPayload['workspaceMemories'];
      activityLog?: TopologyPayload['activityLog'];
    }>;
    applyRemoteState: (state: {
      workspaceMemories?: TopologyPayload['workspaceMemories'];
      activityLog?: TopologyPayload['activityLog'];
    }) => Promise<boolean>;
  };

  constructor(
    private readonly profileStore: ProfileStore,
    private readonly dotfilePoolStore: DotfilePoolStore,
    private readonly settingsStore: SettingsStore,
    private readonly cryptoService: SyncCryptoService,
    options: ProfileSyncServiceOptions = {}
  ) {
    this.dirSyncProfileStore = options.directorySyncProfileStore;
    this.sshConfigPath = options.sshConfigPath ?? path.join(os.homedir(), '.ssh', 'config');
    this.knownHostsPath = options.knownHostsPath ?? path.join(os.homedir(), '.ssh', 'known_hosts');
  }

  /**
   * Whether this sync target already has data pushed from some machine.
   * Used to refuse generating a brand new salt (which would silently start
   * an incompatible, unrelated sync history) on a machine that should
   * instead bootstrap via pullFromRemote().
   */
  public async hasRemoteData(provider: IStorageProvider, remoteBasePath = ''): Promise<boolean> {
    const remoteFiles = buildRemoteFiles(resolveEffectiveBasePath(provider, remoteBasePath));
    return (await this.statOrNull(provider, remoteFiles.topology)) !== null;
  }

  /**
   * Permanently deletes this target's encrypted sync files (and the
   * now-empty `.sshs3` directory, best-effort) from the remote. Local
   * profiles, dotfile pools, and settings on this device are never touched —
   * this only removes the remote backup. Callers are responsible for
   * separately clearing local sync configuration (target, salts, smartcard
   * link) and locking the crypto service.
   */
  public async wipeRemote(provider: IStorageProvider, remoteBasePath = ''): Promise<{ deletedCount: number; errors: string[] }> {
    const effectiveBasePath = resolveEffectiveBasePath(provider, remoteBasePath);
    const remoteFiles = buildRemoteFiles(effectiveBasePath);
    const syncDir = joinPaths('sftp', effectiveBasePath, SYNC_DIR_NAME);

    let deletedCount = 0;
    const errors: string[] = [];

    for (const category of Object.keys(remoteFiles) as SyncDataCategory[]) {
      const filePath = remoteFiles[category];
      try {
        if ((await this.statOrNull(provider, filePath)) === null) continue;
        await provider.delete(filePath, false);
        deletedCount++;
      } catch (err: any) {
        if (!this.isNotFoundError(err)) {
          errors.push(`${category}: ${err?.message || String(err)}`);
        }
      }
    }

    await provider.delete(syncDir, true).catch(() => {
      // Best-effort: already gone, non-empty (e.g. a stray .tmp-* file from
      // an interrupted push), or the provider doesn't support directory
      // deletion this way — none of that should block the wipe.
    });

    this.resetRemoteState();
    return { deletedCount, errors };
  }

  // ---------------------------------------------------------------------
  // Push
  // ---------------------------------------------------------------------

  public async pushToRemote(provider: IStorageProvider, remoteBasePath = ''): Promise<void> {
    if (!this.cryptoService.isUnlocked('topology')) {
      throw new SyncLockedError('topology');
    }
    if (!this.cryptoService.isUnlocked('credentials')) {
      throw new SyncLockedError('credentials');
    }

    const effectiveBasePath = resolveEffectiveBasePath(provider, remoteBasePath);
    const remoteFiles = buildRemoteFiles(effectiveBasePath);
    const syncDir = joinPaths('sftp', effectiveBasePath, SYNC_DIR_NAME);
    await provider.createFolder(syncDir).catch(() => {
      // Already exists, or the provider creates directories implicitly (S3).
    });
    if (provider.chmod) {
      await provider.chmod(syncDir, 0o700).catch(() => {});
    }

    const [profiles, pools, settings, sshNativePayload, dirSyncProfiles] = await Promise.all([
      this.profileStore.getProfilesIncludingTombstones(),
      this.dotfilePoolStore.getPoolsIncludingTombstones(),
      this.settingsStore.getSettings(),
      this.buildLocalSshNativePayload(),
      this.dirSyncProfileStore?.listIncludingTombstones() ?? Promise.resolve(null),
    ]);

    if (sshNativePayload.sshConfigBlock) {
      await this.writeLocalSshNativePayload(sshNativePayload.sshConfigBlock);
    }

    const sshSplit = profiles.ssh.map((item) => splitFields(item, SSH_FIELD_SPLIT));
    const s3Split = profiles.s3.map((item) => splitFields(item, S3_FIELD_SPLIT));

    const wsState = await this.workspaceStateProvider?.getState().catch(() => null);
    const topologyPayload: TopologyPayload = {
      ...(wsState?.workspaceMemories?.length ? { workspaceMemories: wsState.workspaceMemories } : {}),
      ...(wsState?.activityLog?.length ? { activityLog: wsState.activityLog } : {}),
      ssh: sshSplit.map((s) => s.topology),
      s3: s3Split.map((s) => s.topology),
    };
    const credentialsPayload: CredentialsPayload = {
      ssh: sshSplit.map((s) => s.credentials),
      s3: s3Split.map((s) => s.credentials),
    };
    const dotfilePoolsPayload: DotfilePoolsPayload = { pools: pools.map(stripDeviceLocalPoolFields) };

    // M4 (code review): mark the remote as "push in progress" for the
    // duration of the 5 sequential uploads below, so a crash or network
    // drop partway through leaves a trace a later pull/compare can detect,
    // instead of silently treating a mismatched partial set of category
    // files as a clean, in-sync snapshot. Best-effort: a provider that
    // can't write it (e.g. read-only mount) still proceeds with the push.
    const markerPath = buildPushMarkerPath(effectiveBasePath);
    await this.writeProviderFile(provider, markerPath, Buffer.from(formatTimestamp(), 'utf-8')).catch(() => {});

    // M3 (code review): each category's optimistic-concurrency check is run
    // immediately before its own upload (rather than all 5 checks up front,
    // then all 5 uploads) to keep the check-then-write race window as small
    // as possible instead of spanning the other categories' checks/uploads.
    await this.checkNotChangedRemotely(provider, 'topology', remoteFiles);
    await this.encryptAndUpload(provider, 'topology', JSON.stringify(topologyPayload), remoteFiles);

    await this.checkNotChangedRemotely(provider, 'credentials', remoteFiles);
    await this.encryptAndUpload(provider, 'credentials', JSON.stringify(credentialsPayload), remoteFiles);

    await this.checkNotChangedRemotely(provider, 'dotfile-pools', remoteFiles);
    await this.encryptAndUpload(provider, 'dotfile-pools', JSON.stringify(dotfilePoolsPayload), remoteFiles);

    await this.checkNotChangedRemotely(provider, 'settings', remoteFiles);
    await this.encryptAndUpload(provider, 'settings', JSON.stringify(withoutLocalOnlySettings(settings)), remoteFiles);

    await this.checkNotChangedRemotely(provider, 'ssh-native', remoteFiles);
    await this.encryptAndUpload(provider, 'ssh-native', JSON.stringify(sshNativePayload), remoteFiles);

    if (dirSyncProfiles) {
      const dirSyncPayload: DirSyncProfilesPayload = { profiles: dirSyncProfiles };
      await this.checkNotChangedRemotely(provider, 'dirsync-profiles', remoteFiles);
      await this.encryptAndUpload(provider, 'dirsync-profiles', JSON.stringify(dirSyncPayload), remoteFiles);
    }

    // All 5 categories now reflect this push; only now is the remote back
    // to a consistent state, so the marker comes off. If any of the steps
    // above threw, this line is never reached and the marker is left in
    // place on purpose.
    await provider.delete(markerPath, false).catch(() => {});

    this.lastComparison = {
      state: 'in_sync',
      aheadCount: 0,
      behindCount: 0,
      categories: [
        { category: 'topology', state: 'in_sync', ahead: 0, behind: 0 },
        { category: 'credentials', state: 'in_sync', ahead: 0, behind: 0 },
        { category: 'dotfile-pools', state: 'in_sync', ahead: 0, behind: 0 },
        { category: 'settings', state: 'in_sync', ahead: 0, behind: 0 },
        { category: 'ssh-native', state: 'in_sync', ahead: 0, behind: 0 },
        { category: 'dirsync-profiles', state: 'in_sync', ahead: 0, behind: 0 },
      ],
      checkedAt: formatTimestamp(),
    };
  }

  // ---------------------------------------------------------------------
  // Pull
  // ---------------------------------------------------------------------

  public async pullFromRemote(
    provider: IStorageProvider,
    remoteBasePath = '',
    passwords?: { topology?: string; credentials?: string }
  ): Promise<PullResult> {
    const effectiveBasePath = resolveEffectiveBasePath(provider, remoteBasePath);
    const remoteFiles = buildRemoteFiles(effectiveBasePath);
    const changedCategories: SyncDataCategory[] = [];

    // M4 (code review): refuse to merge a remote that a push left in an
    // inconsistent partial state (see pushToRemote's marker) rather than
    // silently combining some new-push categories with some stale ones.
    if ((await this.statOrNull(provider, buildPushMarkerPath(effectiveBasePath))) !== null) {
      throw new SyncInProgressError();
    }

    const [topologyRaw, credentialsRaw, dotfilePoolsRaw, settingsRaw, sshNativeRaw, dirSyncRaw] = await Promise.all([
      this.downloadAndDecrypt(provider, 'topology', remoteFiles, passwords?.topology),
      this.downloadAndDecrypt(provider, 'credentials', remoteFiles, passwords?.credentials),
      this.downloadAndDecrypt(provider, 'dotfile-pools', remoteFiles, passwords?.credentials),
      this.downloadAndDecrypt(provider, 'settings', remoteFiles, passwords?.topology),
      this.downloadAndDecrypt(provider, 'ssh-native', remoteFiles, passwords?.credentials),
      this.downloadAndDecrypt(provider, 'dirsync-profiles', remoteFiles, passwords?.topology),
    ]);

    if (topologyRaw !== null || credentialsRaw !== null) {
      const topology: TopologyPayload = topologyRaw ? JSON.parse(topologyRaw) : { ssh: [], s3: [] };
      const credentials: CredentialsPayload = credentialsRaw ? JSON.parse(credentialsRaw) : { ssh: [], s3: [] };

      const remoteSsh = stripLocalOnlyFields(joinById<SSHConnectionConfig>(topology.ssh, credentials.ssh), SSH_FIELD_SPLIT);
      const remoteS3 = stripLocalOnlyFields(joinById<S3Config>(topology.s3, credentials.s3), S3_FIELD_SPLIT);

      const local = await this.profileStore.getProfilesIncludingTombstones();
      const sshResult = mergeRecords(local.ssh, remoteSsh);
      const s3Result = mergeRecords(local.s3, remoteS3);

      if (this.workspaceStateProvider && (topology.workspaceMemories?.length || topology.activityLog?.length)) {
        const wsChanged = await this.workspaceStateProvider
          .applyRemoteState({
            workspaceMemories: topology.workspaceMemories,
            activityLog: topology.activityLog,
          })
          .catch(() => false);
        if (wsChanged && !changedCategories.includes('topology')) {
          changedCategories.push('topology');
        }
      }
      if (sshResult.changed || s3Result.changed) {
        const merged: ProfilesData = { ssh: sshResult.merged, s3: s3Result.merged };
        await this.profileStore.replaceAll(merged);
        changedCategories.push('topology', 'credentials');
        if (sshResult.changed) {
          void this.autoSyncLocalSshConfig();
        }
      }
    }

    if (dotfilePoolsRaw !== null) {
      const remotePayload: DotfilePoolsPayload = JSON.parse(dotfilePoolsRaw);
      const local = await this.dotfilePoolStore.getPoolsIncludingTombstones();
      const { merged, changedIds } = mergePools(local, remotePayload.pools);
      if (changedIds.size > 0) {
        const mergedById = new Map(merged.map((pool) => [pool.id, pool]));
        for (const id of changedIds) {
          const pool = mergedById.get(id);
          if (pool) {
            await this.dotfilePoolStore.savePool(pool, { preserveTimestamps: true });
          }
        }
        changedCategories.push('dotfile-pools');
      }
    }

    if (settingsRaw !== null) {
      const remoteSettings: AppSettings = JSON.parse(settingsRaw);
      const localSettings = await this.settingsStore.getSettings();
      if ((remoteSettings.updatedAt ?? '') > (localSettings.updatedAt ?? '')) {
        await this.settingsStore.saveSettings(withLocalOnlySettingsFrom(remoteSettings, localSettings), {
          preserveTimestamp: true,
        });
        changedCategories.push('settings');
      }
    }

    // Remotes pushed by an older version have no dirsync-profiles file (null) — nothing to merge then.
    if (dirSyncRaw !== null && this.dirSyncProfileStore) {
      const remotePayload: DirSyncProfilesPayload = JSON.parse(dirSyncRaw);
      const local = await this.dirSyncProfileStore.listIncludingTombstones();
      const { merged, changed } = mergeRecords(local, remotePayload.profiles ?? []);
      if (changed) {
        await this.dirSyncProfileStore.replaceAll(merged);
        changedCategories.push('dirsync-profiles');
      }
    }

    let sshNativeConflicts: KnownHostsConflict[] = [];
    if (sshNativeRaw !== null) {
      const remotePayload: SshNativePayload = JSON.parse(sshNativeRaw);
      const applied = await this.applySshNativePayload(remotePayload);
      if (applied.changed) {
        changedCategories.push('ssh-native');
      }
      sshNativeConflicts = applied.conflicts;
    }

    this.lastComparison = {
      state: 'in_sync',
      aheadCount: 0,
      behindCount: 0,
      categories: [
        { category: 'topology', state: 'in_sync', ahead: 0, behind: 0 },
        { category: 'credentials', state: 'in_sync', ahead: 0, behind: 0 },
        { category: 'dotfile-pools', state: 'in_sync', ahead: 0, behind: 0 },
        { category: 'settings', state: 'in_sync', ahead: 0, behind: 0 },
        { category: 'ssh-native', state: 'in_sync', ahead: 0, behind: 0 },
        { category: 'dirsync-profiles', state: 'in_sync', ahead: 0, behind: 0 },
      ],
      checkedAt: formatTimestamp(),
    };

    return { changedCategories, sshNativeConflicts };
  }

  // ---------------------------------------------------------------------
  // Compare / Sync state detection
  // ---------------------------------------------------------------------

  public async compareWithRemote(
    provider: IStorageProvider,
    remoteBasePath = ''
  ): Promise<SyncComparisonResult> {
    if (!this.cryptoService.isUnlocked('topology') || !this.cryptoService.isUnlocked('credentials')) {
      throw new SyncLockedError('topology');
    }

    const effectiveBasePath = resolveEffectiveBasePath(provider, remoteBasePath);
    const remoteFiles = buildRemoteFiles(effectiveBasePath);

    // M4 (code review): a push marker means the remote is currently a
    // partial, inconsistent snapshot — don't report a (misleading) diff
    // against it.
    if ((await this.statOrNull(provider, buildPushMarkerPath(effectiveBasePath))) !== null) {
      throw new SyncInProgressError();
    }

    const hasTopology = (await this.statOrNull(provider, remoteFiles.topology)) !== null;

    const [localProfiles, localPools, localSettings, localSshNative, localDirSync] = await Promise.all([
      this.profileStore.getProfilesIncludingTombstones(),
      this.dotfilePoolStore.getPoolsIncludingTombstones(),
      this.settingsStore.getSettings(),
      this.buildLocalSshNativePayload(),
      this.dirSyncProfileStore?.listIncludingTombstones() ?? Promise.resolve([] as DirectorySyncProfile[]),
    ]);

    if (!hasTopology) {
      const activeSsh = localProfiles.ssh.filter((p) => !p.deletedAt).length;
      const activeS3 = localProfiles.s3.filter((p) => !p.deletedAt).length;
      const activePools = localPools.filter((p) => !p.deletedAt).length;
      const activeDirSync = localDirSync.filter((p) => !p.deletedAt).length;
      const totalAhead = activeSsh + activeS3 + activePools + activeDirSync + (localSettings ? 1 : 0);

      const result: SyncComparisonResult = {
        state: 'not_initialized',
        aheadCount: totalAhead,
        behindCount: 0,
        categories: [
          {
            category: 'topology',
            state: activeSsh + activeS3 > 0 ? 'ahead' : 'in_sync',
            ahead: activeSsh + activeS3,
            behind: 0,
            details: ['Remote sync target is not initialized'],
          },
          {
            category: 'credentials',
            state: activeSsh + activeS3 > 0 ? 'ahead' : 'in_sync',
            ahead: activeSsh + activeS3,
            behind: 0,
          },
          {
            category: 'dotfile-pools',
            state: activePools > 0 ? 'ahead' : 'in_sync',
            ahead: activePools,
            behind: 0,
          },
          {
            category: 'settings',
            state: 'ahead',
            ahead: 1,
            behind: 0,
          },
          {
            category: 'ssh-native',
            state: 'in_sync',
            ahead: 0,
            behind: 0,
          },
          {
            category: 'dirsync-profiles',
            state: activeDirSync > 0 ? 'ahead' : 'in_sync',
            ahead: activeDirSync,
            behind: 0,
          },
        ],
        checkedAt: formatTimestamp(),
      };
      this.lastComparison = result;
      return result;
    }

    const [topologyRaw, credentialsRaw, dotfilePoolsRaw, settingsRaw, sshNativeRaw, dirSyncRaw] = await Promise.all([
      this.downloadAndDecrypt(provider, 'topology', remoteFiles),
      this.downloadAndDecrypt(provider, 'credentials', remoteFiles),
      this.downloadAndDecrypt(provider, 'dotfile-pools', remoteFiles),
      this.downloadAndDecrypt(provider, 'settings', remoteFiles),
      this.downloadAndDecrypt(provider, 'ssh-native', remoteFiles),
      this.downloadAndDecrypt(provider, 'dirsync-profiles', remoteFiles),
    ]);

    const categories: CategoryComparison[] = [];

    // 1. Topology & Credentials
    const topology: TopologyPayload = topologyRaw ? JSON.parse(topologyRaw) : { ssh: [], s3: [] };
    const credentials: CredentialsPayload = credentialsRaw ? JSON.parse(credentialsRaw) : { ssh: [], s3: [] };
    const remoteSsh = joinById<SSHConnectionConfig>(topology.ssh, credentials.ssh);
    const remoteS3 = joinById<S3Config>(topology.s3, credentials.s3);

    const sshComp = compareRecords(localProfiles.ssh, remoteSsh, 'SSH profile', SSH_FIELD_SPLIT);
    const s3Comp = compareRecords(localProfiles.s3, remoteS3, 'S3 profile', S3_FIELD_SPLIT);

    const profilesAhead = sshComp.ahead + s3Comp.ahead;
    const profilesBehind = sshComp.behind + s3Comp.behind;
    const profilesDetails = [...sshComp.details, ...s3Comp.details];
    const profilesState = getComparisonState(profilesAhead, profilesBehind);

    categories.push({
      category: 'topology',
      state: profilesState,
      ahead: profilesAhead,
      behind: profilesBehind,
      details: profilesDetails,
    });
    categories.push({
      category: 'credentials',
      state: profilesState,
      ahead: profilesAhead,
      behind: profilesBehind,
    });

    // 2. Dotfile Pools
    const remotePools: DotfilePool[] = dotfilePoolsRaw ? JSON.parse(dotfilePoolsRaw).pools ?? [] : [];
    const poolsComp = compareDotfilePools(localPools, remotePools);
    categories.push({
      category: 'dotfile-pools',
      state: getComparisonState(poolsComp.ahead, poolsComp.behind),
      ahead: poolsComp.ahead,
      behind: poolsComp.behind,
      details: poolsComp.details,
    });

    // 3. Settings
    const remoteSettings: AppSettings | null = settingsRaw ? JSON.parse(settingsRaw) : null;
    let settingsAhead = 0;
    let settingsBehind = 0;
    const settingsDetails: string[] = [];
    if (remoteSettings) {
      const localTime = localSettings.updatedAt ?? '';
      const remoteTime = remoteSettings.updatedAt ?? '';
      if (localTime > remoteTime) {
        settingsAhead = 1;
        settingsDetails.push('Settings modified locally');
      } else if (remoteTime > localTime) {
        settingsBehind = 1;
        settingsDetails.push('Settings modified on remote');
      }
    }
    categories.push({
      category: 'settings',
      state: getComparisonState(settingsAhead, settingsBehind),
      ahead: settingsAhead,
      behind: settingsBehind,
      details: settingsDetails,
    });

    // 4. SSH Native
    const remoteSshNative: SshNativePayload | null = sshNativeRaw ? JSON.parse(sshNativeRaw) : null;
    let sshNativeAhead = 0;
    let sshNativeBehind = 0;
    const sshNativeDetails: string[] = [];

    if (remoteSshNative?.sshConfigBlock) {
      const localBlock = localSshNative.sshConfigBlock;
      if (!localBlock) {
        sshNativeBehind += 1;
        sshNativeDetails.push('Managed SSH config block on remote');
      } else if (localBlock.updatedAt > remoteSshNative.sshConfigBlock.updatedAt) {
        sshNativeAhead += 1;
        sshNativeDetails.push('Managed SSH config block updated locally');
      } else if (remoteSshNative.sshConfigBlock.updatedAt > localBlock.updatedAt) {
        sshNativeBehind += 1;
        sshNativeDetails.push('Managed SSH config block updated on remote');
      }
    } else if (localSshNative.sshConfigBlock?.body.trim()) {
      // Generated fresh from local SSH profiles on every comparison (see
      // buildLocalSshNativePayload) — an empty body just means no SSH
      // profiles exist yet, not "new content to push".
      sshNativeAhead += 1;
      sshNativeDetails.push('Managed SSH config block created locally');
    }

    if (remoteSshNative?.knownHostsContent) {
      const localMerge = mergeKnownHosts(localSshNative.knownHostsContent, remoteSshNative.knownHostsContent);
      if (localMerge.addedCount > 0 || localMerge.conflicts.length > 0) {
        const count = localMerge.addedCount + localMerge.conflicts.length;
        sshNativeBehind += count;
        sshNativeDetails.push(`${count} known_hosts key(s) on remote`);
      }
      const remoteMerge = mergeKnownHosts(remoteSshNative.knownHostsContent, localSshNative.knownHostsContent);
      if (remoteMerge.addedCount > 0) {
        sshNativeAhead += remoteMerge.addedCount;
        sshNativeDetails.push(`${remoteMerge.addedCount} local known_hosts key(s) to push`);
      }
    }

    categories.push({
      category: 'ssh-native',
      state: getComparisonState(sshNativeAhead, sshNativeBehind),
      ahead: sshNativeAhead,
      behind: sshNativeBehind,
      details: sshNativeDetails,
    });

    // 5. Saved directory-sync profiles
    const remoteDirSync: DirectorySyncProfile[] = dirSyncRaw ? JSON.parse(dirSyncRaw).profiles ?? [] : [];
    const dirSyncComp = this.dirSyncProfileStore
      ? compareRecords(localDirSync, remoteDirSync, 'Directory sync profile')
      : { ahead: 0, behind: 0, details: [] as string[] };
    categories.push({
      category: 'dirsync-profiles',
      state: getComparisonState(dirSyncComp.ahead, dirSyncComp.behind),
      ahead: dirSyncComp.ahead,
      behind: dirSyncComp.behind,
      details: dirSyncComp.details,
    });

    const totalAhead = profilesAhead + poolsComp.ahead + settingsAhead + sshNativeAhead + dirSyncComp.ahead;
    const totalBehind = profilesBehind + poolsComp.behind + settingsBehind + sshNativeBehind + dirSyncComp.behind;

    const result: SyncComparisonResult = {
      state: getComparisonState(totalAhead, totalBehind),
      aheadCount: totalAhead,
      behindCount: totalBehind,
      categories,
      checkedAt: formatTimestamp(),
    };
    this.lastComparison = result;
    return result;
  }

  // ---------------------------------------------------------------------
  // ssh-native (~/.ssh/config managed block + ~/.ssh/known_hosts)
  // ---------------------------------------------------------------------

  /**
   * Read-only: builds what the managed `~/.ssh/config` block *should* be
   * from the current local SSH profiles, without touching disk. Used by
   * both pushToRemote() (which also writes the result locally) and
   * compareWithRemote() (a pure status check, which must not have the side
   * effect of writing to the user's real ~/.ssh/config just to show a badge).
   */
  private async buildLocalSshNativePayload(): Promise<SshNativePayload> {
    const sshConfigContent = await this.readLocalFile(this.sshConfigPath);
    const existingBlock = parseManagedSshConfigBlock(sshConfigContent ?? '');
    const knownHostsContent = await this.readLocalFile(this.knownHostsPath);
    const activeProfiles = (await this.profileStore.getProfiles()).ssh;
    const generated = buildManagedSshConfigBlockFromProfiles(activeProfiles, existingBlock);
    // No SSH profiles and no pre-existing managed block: nothing to sync, and
    // returning it anyway would mint a fresh `now` timestamp on every single
    // call (buildManagedSshConfigBlockFromProfiles only reuses a previous
    // timestamp when it *has* a previous block to compare against), which
    // would make compareWithRemote() spuriously flip-flop between ahead/behind.
    const hasContent = generated.body.trim().length > 0;
    return {
      sshConfigBlock: hasContent || existingBlock ? generated : null,
      knownHostsContent: knownHostsContent ?? '',
    };
  }

  /**
   * Writes the freshly generated managed block to the real local
   * ~/.ssh/config if it actually changed, so a plain `ssh <alias>` in any
   * terminal picks up current profiles right after a push — not only after
   * some other device's pull. Skipped when there's nothing to write (no
   * profiles yet and no pre-existing managed block), so installs that never
   * use this feature don't get an empty stub block.
   */
  private async writeLocalSshNativePayload(sshConfigBlock: ManagedSshConfigBlock): Promise<void> {
    await this.enqueueSshConfigWrite(async () => {
      const currentContent = (await this.readLocalFile(this.sshConfigPath)) ?? '';
      const currentBlock = parseManagedSshConfigBlock(currentContent);
      const hasContent = sshConfigBlock.body.trim().length > 0;
      if (!hasContent && currentBlock === null) return;
      if (currentBlock && currentBlock.body === sshConfigBlock.body) return;

      const updated = writeManagedSshConfigBlock(currentContent, sshConfigBlock);
      await this.writeLocalFile(this.sshConfigPath, updated);
    });
  }

  /** Serializes read-modify-write cycles on ~/.ssh/config so concurrent triggers can't clobber each other. */
  private enqueueSshConfigWrite<T>(task: () => Promise<T>): Promise<T> {
    const result = this.sshConfigWriteQueue.then(task);
    this.sshConfigWriteQueue = result.then(
      () => {},
      () => {}
    );
    return result;
  }

  /**
   * Fire-and-forget trigger used after profile changes and at startup. Honors the
   * `autoSyncLocalSshConfig` setting (on by default) and logs failures instead of
   * swallowing them.
   */
  public async autoSyncLocalSshConfig(): Promise<void> {
    try {
      const settings = await this.settingsStore.getSettings();
      if (settings.autoSyncLocalSshConfig === false) return;
      await this.syncProfilesToLocalSshConfig();
    } catch (err) {
      sshs3Log.warn('Failed to sync profiles to ~/.ssh/config:', err instanceof Error ? err.message : err);
    } finally {
      // Whatever depends on the managed block (the local agent block) is refreshed *after* it, in order.
      this.onLocalSshConfigSynced?.();
    }
  }

  /**
   * Writes (or, with null/empty `entries`, removes) the local-only agent block that makes plain
   * `ssh <alias>` use the keys unlocked in the app agent — see writeAgentSshConfigBlock. Never touches the
   * managed block (which is what gets synced) and honors the `autoSyncLocalSshConfig` setting (off ⇒
   * the block is removed). Failures are logged, not thrown: this is a convenience, never fatal.
   */
  public async syncAgentBlockToLocalSshConfig(entries: AgentHostEntry[] | null): Promise<void> {
    try {
      const settings = await this.settingsStore.getSettings();
      const wanted = settings.autoSyncLocalSshConfig === false ? null : entries;
      await this.enqueueSshConfigWrite(async () => {
        const current = (await this.readLocalFile(this.sshConfigPath)) ?? '';
        const updated = writeAgentSshConfigBlock(current, wanted ? buildAgentSshConfigBody(wanted) : null);
        if (updated !== current) await this.writeLocalFile(this.sshConfigPath, updated);
      });
    } catch (err) {
      sshs3Log.warn('Failed to update the agent block in ~/.ssh/config:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Synchronizes saved SSH profiles directly to the local ~/.ssh/config managed block,
   * enabling native shell tab-completion and CLI ssh usage without requiring Remote Profile Sync.
   */
  public syncProfilesToLocalSshConfig(): Promise<{ changed: boolean; count: number; path: string }> {
    return this.enqueueSshConfigWrite(async () => {
      const activeProfiles = (await this.profileStore.getProfiles()).ssh;
      const currentContent = (await this.readLocalFile(this.sshConfigPath)) ?? '';
      const currentBlock = parseManagedSshConfigBlock(currentContent);
      const generated = buildManagedSshConfigBlockFromProfiles(activeProfiles, currentBlock);
      const hasContent = generated.body.trim().length > 0;
      if (!hasContent && currentBlock === null) {
        return { changed: false, count: 0, path: this.sshConfigPath };
      }
      if (currentBlock && currentBlock.body === generated.body) {
        return { changed: false, count: activeProfiles.length, path: this.sshConfigPath };
      }

      const updated = writeManagedSshConfigBlock(currentContent, generated);
      await this.writeLocalFile(this.sshConfigPath, updated);
      return { changed: true, count: activeProfiles.length, path: this.sshConfigPath };
    });
  }

  private async applySshNativePayload(
    remotePayload: SshNativePayload
  ): Promise<{ changed: boolean; conflicts: KnownHostsConflict[] }> {
    let changed = false;
    const conflicts: KnownHostsConflict[] = [];

    if (remotePayload.sshConfigBlock) {
      const localContent = (await this.readLocalFile(this.sshConfigPath)) ?? '';
      const localBlock = parseManagedSshConfigBlock(localContent);
      if (!localBlock || remotePayload.sshConfigBlock.updatedAt > localBlock.updatedAt) {
        const updated = writeManagedSshConfigBlock(localContent, remotePayload.sshConfigBlock);
        await this.writeLocalFile(this.sshConfigPath, updated);
        changed = true;
      }
    }

    const localKnownHosts = (await this.readLocalFile(this.knownHostsPath)) ?? '';
    const knownHostsResult = mergeKnownHosts(localKnownHosts, remotePayload.knownHostsContent);
    conflicts.push(...knownHostsResult.conflicts);
    if (knownHostsResult.changed) {
      await this.writeLocalFile(this.knownHostsPath, knownHostsResult.mergedContent);
      changed = true;
    }

    return { changed, conflicts };
  }

  private async readLocalFile(filePath: string): Promise<string | null> {
    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch (err: any) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
  }

  private async writeLocalFile(filePath: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
  }

  // ---------------------------------------------------------------------
  // Remote transfer helpers
  // ---------------------------------------------------------------------

  /**
   * Optimistic concurrency check: refuses to push if the remote file has
   * changed since it was last read/written by this service instance, rather
   * than silently overwriting another machine's newer push.
   */
  private async checkNotChangedRemotely(
    provider: IStorageProvider,
    category: SyncDataCategory,
    remoteFiles: Record<SyncDataCategory, string>
  ): Promise<void> {
    const known = this.lastKnownRemoteState.get(category);
    if (known === undefined) return; // Never observed remotely from this instance — nothing to compare against.

    const current = await this.statOrNull(provider, remoteFiles[category]);
    const unchanged =
      (known === null && current === null) ||
      (known !== null && current !== null && known.size === current.size && known.mtime === current.mtime);

    if (!unchanged) {
      throw new SyncConflictError(category);
    }
  }

  private isNotFoundError(err: any): boolean {
    if (!err) return false;
    const code = err.code || err.$metadata?.httpStatusCode;
    if (code === 'ENOENT' || code === 2 || code === 404 || code === 'NotFound' || code === 'NoSuchKey') {
      return true;
    }
    const name = err.name || '';
    if (name === 'NoSuchKey' || name === 'NotFound') {
      return true;
    }
    const msg = typeof err.message === 'string' ? err.message.toLowerCase() : '';
    if (
      msg.includes('no such file') ||
      msg.includes('file does not exist') ||
      msg.includes('does not exist') ||
      msg.includes('not found')
    ) {
      if (
        msg.includes('host not found') ||
        msg.includes('socket not found') ||
        msg.includes('getaddrinfo') ||
        msg.includes('connect')
      ) {
        return false;
      }
      return true;
    }
    return false;
  }

  private async statOrNull(provider: IStorageProvider, remotePath: string): Promise<FileEntry | null> {
    try {
      return await provider.stat(remotePath);
    } catch (err: any) {
      if (this.isNotFoundError(err)) {
        return null;
      }
      throw err;
    }
  }

  private async encryptAndUpload(
    provider: IStorageProvider,
    category: SyncDataCategory,
    plaintext: string,
    remoteFiles: Record<SyncDataCategory, string>
  ): Promise<void> {
    const encrypted = this.cryptoService.encrypt(category, plaintext);
    const targetPath = remoteFiles[category];

    if (provider.type === 's3') {
      // S3 PutObject is inherently atomic (replaces the key atomically).
      // Writing directly avoids multipart CopyObject/DeleteObject races, replication latency,
      // and eliminates the need for separate s3:DeleteObject permissions.
      await this.writeProviderFile(provider, targetPath, encrypted);
    } else {
      const tmpPath = `${targetPath}.tmp-${crypto.randomUUID()}`;
      await this.writeProviderFile(provider, tmpPath, encrypted);
      try {
        await provider.rename(tmpPath, targetPath);
      } catch (err) {
        await provider.delete(tmpPath, false).catch(() => {});
        throw err;
      }
    }

    if (provider.chmod) {
      await provider.chmod(targetPath, 0o600).catch(() => {});
    }

    this.lastKnownRemoteState.set(category, await this.statOrNull(provider, targetPath));
  }

  /** Returns null if the remote file doesn't exist yet (first sync). */
  private async downloadAndDecrypt(
    provider: IStorageProvider,
    category: SyncDataCategory,
    remoteFiles: Record<SyncDataCategory, string>,
    password?: string
  ): Promise<string | null> {
    const remotePath = remoteFiles[category];
    const stat = await this.statOrNull(provider, remotePath);
    if (!stat) {
      this.lastKnownRemoteState.set(category, null);
      return null;
    }

    const buffer = await this.readProviderFile(provider, remotePath);
    // Recorded only after a successful decrypt: a failed one (wrong password)
    // must not make the remote look "already seen" to the push-conflict check.
    const plaintext = this.cryptoService.decrypt(category, buffer, password);
    this.lastKnownRemoteState.set(category, stat);
    return plaintext;
  }

  private async readProviderFile(provider: IStorageProvider, remotePath: string): Promise<Buffer> {
    if (typeof provider.readFile === 'function') {
      return provider.readFile(remotePath);
    }

    const stream = await provider.createReadStream(remotePath);
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => resolve());
      stream.on('error', reject);
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
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const fail = (err: unknown) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };
      stream.once('finish', finish);
      stream.once('error', fail);
      stream.end(buffer);
    });
  }
}
