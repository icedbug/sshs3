/**
 * Types shared between the Main-process remote profile sync implementation
 * (src/main/services/SyncCryptoService.ts, ProfileSyncService.ts,
 * SshNativeFileMerger.ts) and the Renderer (via IPC), so both sides agree on
 * shapes without the renderer importing anything from src/main.
 */

/**
 * The kinds of data remote profile sync can upload/download. Each
 * category is bound as AES-GCM AAD when encrypting, so a file encrypted as
 * one category can never be decrypted as another — even with the correct
 * password — preventing the files from being swapped for one another.
 */
export type SyncDataCategory =
  | 'topology'
  | 'credentials'
  | 'dotfile-pools'
  | 'settings'
  | 'ssh-native'
  | 'dirsync-profiles'
  | 'k8s-profiles';

/**
 * The two independent key groups. `topology`/`settings`/`dirsync-profiles` (saved
 * directory-sync pairs: provider references and paths only) and `k8s-profiles` (saved clusters:
 * server, project and TLS option only, never a token) share the
 * "topology" master password so that data can be shared with a team in the
 * future without also exposing private credentials; `credentials`,
 * `dotfile-pools` (file contents may embed arbitrary secrets) and
 * `ssh-native` (an `~/.ssh/config` block may contain a `ProxyCommand` with
 * embedded secrets) share the "credentials" master password.
 */
export type SyncKeyGroup = 'topology' | 'credentials';

export interface KnownHostsConflict {
  hostPatternField: string;
  localKeyType: string;
  localFingerprint: string;
  remoteKeyType: string;
  remoteFingerprint: string;
}

export interface ProfileSyncPullResult {
  changedCategories: SyncDataCategory[];
  sshNativeConflicts: KnownHostsConflict[];
}

export type SyncState = 'in_sync' | 'ahead' | 'behind' | 'diverged' | 'not_initialized' | 'error';

export interface CategoryComparison {
  category: SyncDataCategory;
  state: 'in_sync' | 'ahead' | 'behind' | 'diverged';
  ahead: number;
  behind: number;
  details?: string[];
}

export interface SyncComparisonResult {
  state: SyncState;
  aheadCount: number;
  behindCount: number;
  categories: CategoryComparison[];
  checkedAt: string;
  error?: string;
}

import type { SFTPConfig, S3Config } from './storage';

export interface ProfileSyncStatus {
  /** Whether a sync target (S3/SFTP location) has been configured via profile-sync:setup. */
  configured: boolean;
  target?: { id: string; name: string; type: 'sftp' | 's3' };
  /** Complete target connection configuration for autofilling the target editor form. */
  targetConfig?: {
    type: 'sftp' | 's3';
    sftpConfig?: SFTPConfig;
    s3Config?: S3Config;
  };
  /** Directory (SFTP) or `bucket[/prefix]` (S3) under which the `.sshs3` sync folder lives. */
  remoteBasePath?: string;
  /** Whether this machine has already run through setup once (salts exist) — decides whether the next password entry needs double-confirmation (first time) or is just a re-unlock. */
  hasLocalSalts: boolean;
  /** Whether each key group's master password has been unlocked in this running session. */
  topologyUnlocked: boolean;
  credentialsUnlocked: boolean;
  lastSyncAt?: string;
  comparison?: SyncComparisonResult;
  /** Whether automatic synchronization (auto-push on changes) is enabled. */
  autoSync?: boolean;
  /** Whether a smartcard has been linked for PIN-based unlock. */
  smartcardLinked?: boolean;
  /** The PKCS#11 library path associated with the linked smartcard. */
  smartcardLibPath?: string;
  /** Whether a smartcard library is detected and available on this system. */
  smartcardAvailable?: boolean;
}
