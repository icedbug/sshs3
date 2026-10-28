import type { SSHConnectionConfig } from './ssh';
import type { S3Config } from './storage';

export type TeamVaultRole = 'admin' | 'member';

/** Shared team activity event synced across the workspace so all teammates and the AI know who changed what on which VM/cluster. */
export interface WorkspaceActivityEvent {
  id: string;
  profileId?: string;
  targetLabel: string;
  actor: string;
  kind:
    | 'config-edit'
    | 'service-action'
    | 'service'
    | 'package-change'
    | 'deploy'
    | 'command'
    | 'ai-action'
    | 'profile-update'
    | 'note';
  summary: string;
  commandOrPath?: string;
  detail?: string;
  details?: string;
  at: number;
}

/** Shared team AI memory / runbook / server knowledge entry synced inside TeamVaultPayload. */
export interface WorkspaceMemoryEntry {
  id: string;
  kind: 'memory' | 'skill';
  scope: string;
  title: string;
  text: string;
  author?: string;
  updatedAt: number;
}

/** The decrypted shape of `TeamVaultFile.encryptedPayload` — reuses the same domain models as
 * local profiles (`ProfileStore`'s `SSHConnectionConfig`/`S3Config`), per docs/team-vault-plan.md
 * §3's decision to avoid a third profile representation. Every field is shared as-is, including
 * `pkcs11LibPath`/`agentPath`/`privateKeyPath` — none of them execute anything on their own, they
 * either resolve on a given member's machine or silently don't (same risk profile as a wrong
 * hostname). The one exception is `pin`, never accepted on a shared profile — see
 * `TeamVaultService`'s `withoutPin()` — matching `ProfileStore`'s identical rule that a
 * smartcard/FIDO2 PIN is never written to disk anywhere in this app. A profile whose own
 * `pkcs11LibPath` is empty falls back to the connecting member's personal default
 * (`AppSettings.smartcardLibPath`, resolved in `SmartcardDetector.buildSSHArguments`), so a new
 * member doesn't need to edit every shared profile individually. Private key CONTENT sharing
 * (not just the path) remains out of scope — see the connection-manager plan. */
export interface TeamVaultPayload {
  ssh: SSHConnectionConfig[];
  s3: S3Config[];
  /** Shared, arbitrarily-deep folder registry for organizing Team Vault profiles — unlike
   * personal profiles' local `folders` list (ProfileStore), this is part of the synced payload so
   * every member sees the same structure. A profile's existing `group` field is reused as a
   * `/`-separated path into this tree (e.g. `"Acme Infra/Cluster A"`); this array exists
   * separately so an empty folder (no profile in it yet) can still be created/shown/renamed —
   * same purpose as the personal `folders` list, just shared. Absent on a payload written before
   * this field existed; treat as `[]`. */
  folders?: string[];
  /** Per-folder icon override, keyed by the same `/`-separated path used in `folders`/a
   * profile's `group` — values are keys into `TEAM_FOLDER_ICONS` (shared/types/teamVault.ts),
   * not arbitrary strings or image data (no custom image upload — see
   * `TeamVaultService.setTeamFolderIcon`). Absent/missing entry means the default folder icon.
   * `renameTeamFolder`/`deleteTeamFolder` keep this in sync with `folders` (remap or remove the
   * same self+descendant keys). Absent on a payload written before this field existed; treat as
   * `{}`. */
  folderIcons?: Record<string, string>;
  /** Optional descriptions for shared project/cluster folders. */
  folderDescriptions?: Record<string, string>;
  /** Shared AI memories, server facts, and skills across the workspace. */
  workspaceMemories?: WorkspaceMemoryEntry[];
  /** Shared activity & configuration change log across team members. */
  activityLog?: WorkspaceActivityEvent[];
}

/** The fixed set of icons a Team Vault folder can be given (`TeamVaultPayload.folderIcons`) —
 * deliberately a closed allowlist (no custom image upload, no arbitrary string), both so the
 * main process can validate an incoming icon key without guessing at the renderer's icon set,
 * and so every member's renderer (possibly a different app version) has a reasonable fallback
 * for a key it doesn't recognize (the default folder icon). Chosen to broadly cover common
 * infra/connection groupings (clusters, databases, cloud providers, network gear, ...); the
 * renderer maps each key to its actual `lucide-react` icon component (`TeamProfileTree.tsx`).
 */
export const TEAM_FOLDER_ICONS = [
  'folder',
  'server',
  'database',
  'cloud',
  'shield',
  'globe',
  'box',
  'layers',
  'hard-drive',
  'network',
  'git-branch',
  'cpu',
] as const;

export type TeamFolderIcon = (typeof TEAM_FOLDER_ICONS)[number];

/** One recipient's wrapped copy of the Vault Key. `method` is deliberately an open field (only
 * `'piv-rsa-oaep'` exists in v1) so a future recipient mechanism doesn't need a format change —
 * see docs/team-vault-plan.md §2.3. */
export interface TeamVaultAccessEntry {
  recipientId: string;
  role: TeamVaultRole;
  method: 'piv-rsa-oaep';
  /** The recipient's public `age1yubikey1...` string. Public by definition (already shared
   * out-of-band per §4.3), and storing it is not optional: offboarding (removeMember) re-wraps a
   * fresh Vault Key for every *remaining* recipient, which is only possible if their public key
   * is available — `wrappedVaultKey` alone can't be reversed to recover it. Correction to the
   * original §2.3 sketch in docs/team-vault-plan.md, which omitted this field. */
  ageRecipient: string;
  wrappedVaultKey: string;
  addedAt: string;
  addedBy: string;
}

/** The recovery key is an ordinary recipient, not a special case in the format — only flagged
 * separately so the UI can give it the "print this, store it in a safe" ceremony (§4.1/§4.3). */
export interface TeamVaultRecovery {
  recipientId: string;
  /** See `TeamVaultAccessEntry.ageRecipient` — same reason, needed to re-wrap on offboarding. */
  ageRecipient: string;
  wrappedVaultKey: string;
  note?: string;
}

export interface TeamVaultFile {
  formatVersion: 1;
  vaultId: string;
  /** Creator-chosen descriptive name (e.g. "Acme Infra Team"), shown in the UI instead of the
   * opaque `vaultId`. Optional for files written before this field existed — the UI falls back to
   * `vaultId` when absent. Tamper-evident like the rest of the header: included in
   * `accessHeaderMac` (see below), so changing it requires the real Vault Key, not just S3 write
   * access. */
  vaultName?: string;
  /** Monotonically incremented on every mutating write (create=1, then +1 per add/remove/role
   * change). Rollback/replay guard: anyone with mere S3 write access to the vault's path (not
   * necessarily a real recipient — bucket permissions and "is a vault member" are different
   * things) could otherwise overwrite the file with an older version to resurrect a removed
   * member's access to the pre-removal state. `pullFromRemote` refuses a revision that goes
   * backwards relative to the local copy. */
  revision: number;
  updatedAt: string;
  updatedBy: string;
  accessHeader: TeamVaultAccessEntry[];
  recovery: TeamVaultRecovery;
  encryptedPayload: string;
  /** HMAC-SHA256 (base64) over `vaultId`+`revision`+`vaultName`+`accessHeader`+`recovery`, keyed
   * by a subkey derived from the Vault Key — see `TeamVaultCryptoService.computeAccessHeaderMac`.
   * Lets `pullFromRemote` detect any tampering with the header itself (a substituted or wholly
   * new entry, a changed role, a renamed vault, ...) without depending on a specific `revision`
   * delta: mere S3 write access can't produce a valid tag, since that requires the real Vault
   * Key. */
  accessHeaderMac: string;
  /** HMAC-SHA256 (base64) over this file's own header fields, keyed by a subkey derived from the
   * PREVIOUS Vault Key — set only by a Vault Key rotation (`removeMember`), proving the rotation
   * was performed by whoever actually held that previous key. Absent on a file whose Vault Key has
   * never been rotated (created, then only `addMember`/`setRole`/`renameVault` since) — those
   * never shrink `accessHeader` in the first place, so `pullFromRemote` never needs to check this
   * field for them. See `TeamVaultCryptoService.computeRotationProof` /
   * `TeamVaultService.TeamVaultRotationProofError` for why this exists and what it does and
   * doesn't prove. */
  prevKeyProof?: string;
}

export interface TeamVaultMemberSummary {
  recipientId: string;
  role: TeamVaultRole;
  addedAt: string;
}

/** `access_header` is plaintext JSON (§2.3), so this status is derivable without ever unlocking
 * the vault — only decrypting `encrypted_payload` needs the Vault Key. */
export interface TeamVaultStatus {
  exists: boolean;
  vaultId?: string;
  vaultName?: string;
  members?: TeamVaultMemberSummary[];
  adminCount?: number;
  unlocked: boolean;
  filePath: string;
  /** Whether an S3 target has been configured for this vault (Fas 3) — distinct from `exists`,
   * since a brand new install can have a remote target configured but no local file yet (join an
   * existing team's vault) or vice versa (a local-only vault never pushed anywhere). Optional
   * because `TeamVaultService.getStatus()` itself doesn't know about remote config (that's
   * `TeamVaultConfigStore`'s job) — only `IpcBridge.buildTeamVaultStatus()`, which merges both,
   * always sets it for a real IPC response. */
  remoteConfigured?: boolean;
  lastSyncAt?: string;
  /** This machine's last-known own recipient id / PIV identity file path (see
   * `TeamVaultConfigStore.setSelfIdentity`) — lets the UI prefill the unlock form instead of
   * making the admin retype or relocate them every session. Neither is a secret. */
  selfRecipientId?: string;
  selfIdentityFilePath?: string;
}
