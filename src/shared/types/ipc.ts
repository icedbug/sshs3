import type { AiHubApi } from './aiHub';
import type { NativeHermesApi } from './nativeHermes';
import type { UpdateState } from './update';
import type {
  SshCaConfig,
  SshCaDetectRequest,
  SshCaDetectResult,
  SshCaStatus,
  SshCaVaultDetectRequest,
  SshCaVaultDetectResult,
} from './sshCa';
import type { LogLevel } from './log';
import type { PerfK8sResult, PerfK8sTarget, PerfSshResult } from './perf';
import type {
  SSHConnectionConfig,
  PtyOptions,
  SSHPtyExitEvent,
  DetectedSmartcardLib,
  CachedSmartcardAgent,
  XServerStatus,
  GenerateFido2KeyRequest,
  GeneratedFido2Key,
  Fido2ResidentKey,
  SSHTunnelConfig,
  SSHActiveTunnel,
  LocalPublicKey,
  ListPublicKeysRequest,
  InstallPublicKeysRequest,
  InstallPublicKeysResult,
  ProbeHostResult,
  TestLoginResult,
} from './ssh';
import type {
  FileEntry,
  ObjectMetadata,
  WinAttributes,
  TransferProgress,
  SFTPConfig,
  S3Config,
  S3Tag,
  BucketVersioningInfo,
  ObjectVersionEntry,
  SpaceInfo,
  VolumeInfo,
} from './storage';
import type {
  AwsSsoAccount,
  AwsSsoAccountRole,
  AwsSsoDevicePrompt,
  AwsSsoLoginResult,
  AwsSsoNetworkOptions,
} from './aws';
import type { SessionData } from './session';
import type { ClipboardHistoryEntry } from './clipboard';
import type { Snippet } from './snippets';
import type { AppSettings } from './settings';
import type { PolicyInfo } from './policy';
import type { CertificatePreviewResult } from './certificate';
import type {
  DotfileImportedFile,
  DotfilePool,
  DotfilesSyncPromptEvent,
  DotfilesSyncResolution,
  DotfilesSyncStatusEvent,
} from './dotfiles';
import type { ProfileSyncStatus, ProfileSyncPullResult, SyncComparisonResult } from './sync';
import type { TeamVaultPayload, TeamVaultRole, TeamVaultStatus, TeamVaultSyncPreview } from './teamVault';
import type { DirectoryDiffEntry, DirectoryDiffResult, DirectorySyncApplyResult, DirectorySyncProfile } from './dirsync';
import type {
  ConfigureGitSigningRequest,
  ConfigureGitSigningResult,
  DotfilesImportFromGitRequest,
  DotfilesImportFromGitResult,
  FetchGitKeysRequest,
  FetchGitKeysResult,
  GitCloneRequest,
  GitOperationResult,
  GitRepoStatus,
  GitSigningConfig,
  TestRemoteGitAccessRequest,
  TestRemoteGitAccessResult,
} from './git';
import type {
  SearchDoneEvent,
  SearchErrorEvent,
  SearchPreviewResult,
  SearchProgressEvent,
  SearchResultEvent,
  SearchStartOptions,
  SearchStartResult,
} from './search';
import type {
  K8sClusterNode,
  K8sNamespaceNode,
  K8sPodNode,
  K8sTerminalTarget,
  K8sPodDescription,
  K8sPortForwardTarget,
  K8sActivePortForward,
  K8sStorageConfig,
  K8sDebugTarget,
  K8sLoginOptions,
  K8sLoginResult,
  K8sOpenShiftProbeResult,
  K8sProfile,
  K8sWebLoginOptions,
  K8sWebLoginResult,
} from './kubernetes';

export const IPC_CHANNELS = {
  // Terminal
  TERMINAL_CREATE: 'terminal:create',
  TERMINAL_WRITE: 'terminal:write',
  TERMINAL_RESIZE: 'terminal:resize',
  TERMINAL_KILL: 'terminal:kill',
  TERMINAL_RECONNECT: 'terminal:reconnect',
  TERMINAL_ATTACH: 'terminal:attach',
  TERMINAL_DATA: 'terminal:data',
  TERMINAL_EXIT: 'terminal:exit',
  TERMINAL_RECONNECTING: 'terminal:reconnecting',
  TERMINAL_GET_CWD: 'terminal:getCwd',
  TERMINAL_HAS_SSH_CLIENT: 'terminal:hasSshClient',

  // Smartcard
  SMARTCARD_DETECT: 'smartcard:detect',
  SMARTCARD_VALIDATE: 'smartcard:validate',
  SMARTCARD_AGENT_PATH_STATUS: 'smartcard:agent-path-status',
  SMARTCARD_AGENT_PATH_FIX: 'smartcard:agent-path-fix',
  SMARTCARD_LOCK_ALL: 'smartcard:lock-all',
  SMARTCARD_LIST_CACHED: 'smartcard:list-cached',
  SMARTCARD_UNLOCK_AT_STARTUP: 'smartcard:unlock-at-startup',
  SMARTCARD_UNLOCK_NOW: 'smartcard:unlock-now',
  SMARTCARD_STARTUP_UNLOCK_STATUS: 'smartcard:startup-unlock-status',
  ASKPASS_PROMPT: 'askpass:prompt',
  ASKPASS_SUBMIT_PIN: 'askpass:submit-pin',
  INSERT_TOKEN_PROMPT: 'insert-token:prompt',
  INSERT_TOKEN_DISMISS: 'insert-token:dismiss',
  INSERT_TOKEN_CANCEL: 'insert-token:cancel',
  PRESENCE_PROMPT: 'presence:prompt',
  PRESENCE_CLEAR: 'presence:clear',
  FIDO2_GENERATE_KEY: 'fido2:generate-key',
  FIDO2_LIST_RESIDENT_KEYS: 'fido2:list-resident-keys',
  FIDO2_DELETE_RESIDENT_KEY: 'fido2:delete-resident-key',

  // SFTP host key verification (TOFU)
  HOSTKEY_PROMPT: 'hostkey:prompt',
  HOSTKEY_RESPOND: 'hostkey:respond',

  // Storage
  STORAGE_CONNECT: 'storage:connect',
  STORAGE_DISCONNECT: 'storage:disconnect',
  STORAGE_LIST: 'storage:list',
  STORAGE_STAT: 'storage:stat',
  STORAGE_LOOKUP: 'storage:lookup',
  STORAGE_CREATE_FOLDER: 'storage:create-folder',
  STORAGE_CREATE_FILE: 'storage:create-file',
  ARCHIVE_COMPRESS: 'archive:compress',
  ARCHIVE_EXTRACT: 'archive:extract',
  STORAGE_DELETE: 'storage:delete',
  STORAGE_RENAME: 'storage:rename',
  STORAGE_CHMOD: 'storage:chmod',
  STORAGE_GET_WIN_ATTRIBUTES: 'storage:get-win-attributes',
  STORAGE_SET_WIN_ATTRIBUTES: 'storage:set-win-attributes',
  STORAGE_SET_METADATA: 'storage:set-metadata',
  STORAGE_GET_TAGS: 'storage:get-tags',
  STORAGE_SET_TAGS: 'storage:set-tags',
  STORAGE_GET_BUCKET_POLICY: 'storage:get-bucket-policy',
  STORAGE_SET_BUCKET_POLICY: 'storage:set-bucket-policy',
  STORAGE_GET_BUCKET_CORS: 'storage:get-bucket-cors',
  STORAGE_SET_BUCKET_CORS: 'storage:set-bucket-cors',
  STORAGE_GET_BUCKET_VERSIONING: 'storage:get-bucket-versioning',
  STORAGE_SET_BUCKET_VERSIONING: 'storage:set-bucket-versioning',
  STORAGE_LIST_OBJECT_VERSIONS: 'storage:list-object-versions',
  STORAGE_DELETE_OBJECT_VERSION: 'storage:delete-object-version',
  STORAGE_RESTORE_OBJECT_VERSION: 'storage:restore-object-version',
  STORAGE_GET_PRESIGNED_URL: 'storage:get-presigned-url',
  STORAGE_GET_HOMEDIR: 'storage:get-homedir',
  STORAGE_GET_SPACE: 'storage:get-space',
  STORAGE_LIST_VOLUMES: 'storage:list-volumes',

  // Transfer
  TRANSFER_ADD: 'transfer:add',
  TRANSFER_PAUSE: 'transfer:pause',
  TRANSFER_RESUME: 'transfer:resume',
  TRANSFER_CANCEL: 'transfer:cancel',
  TRANSFER_GET_JOBS: 'transfer:get-jobs',
  TRANSFER_CLEAR_COMPLETED: 'transfer:clear-completed',
  TRANSFER_PROGRESS: 'transfer:progress',
  TRANSFER_CONFLICT_PROMPT: 'transfer:conflict-prompt',
  TRANSFER_CONFLICT_RESPOND: 'transfer:conflict-respond',

  // Quit confirmation (renders the app's own themed dialog instead of a native OS message box)
  QUIT_CONFIRM_PROMPT: 'app:quit-confirm-prompt',
  QUIT_CONFIRM_RESPOND: 'app:quit-confirm-respond',

  // Profiles
  PROFILES_GET: 'profiles:get',
  PROFILES_SAVE_SSH: 'profiles:save-ssh',
  PROFILES_DELETE_SSH: 'profiles:delete-ssh',
  PROFILES_SAVE_S3: 'profiles:save-s3',
  PROFILES_DELETE_S3: 'profiles:delete-s3',
  PROFILES_SAVE_FOLDER: 'profiles:save-folder',
  PROFILES_DELETE_FOLDER: 'profiles:delete-folder',
  PROFILES_RENAME_FOLDER: 'profiles:rename-folder',
  PROFILES_IMPORT_SSH_CONFIG: 'profiles:import-ssh-config',
  PROFILES_EXPORT_JSON: 'profiles:export-json',
  PROFILES_IMPORT_JSON: 'profiles:import-json',

  // Session & Tabs
  SESSION_GET: 'session:get',
  SESSION_SAVE: 'session:save',
  WINDOW_NEW: 'window:new',
  WINDOW_MOVE_TAB: 'window:move-tab',
  WINDOW_TAKE_HANDOFF: 'window:take-handoff',
  WINDOW_LIST: 'window:list',
  WINDOW_ADOPT_TAB: 'window:adopt-tab',
  CLIPBOARD_HISTORY_LIST: 'clipboardHistory:list',
  CLIPBOARD_HISTORY_ADD: 'clipboardHistory:add',
  CLIPBOARD_HISTORY_DELETE: 'clipboardHistory:delete',
  CLIPBOARD_HISTORY_CLEAR: 'clipboardHistory:clear',
  SNIPPETS_LIST: 'snippets:list',
  SNIPPETS_SAVE: 'snippets:save',
  SNIPPETS_DELETE: 'snippets:delete',

  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SAVE: 'settings:save',
  // Machine policy (which settings an administrator locks); read-only for the renderer.
  POLICY_GET: 'policy:get',
  // Atomic read-modify-write for one team's entry in connectionManagerVisibleTeamVaults — see
  // SettingsStore.setTeamVaultTabVisible's doc comment for why this isn't just settingsSave().
  SETTINGS_SET_TEAM_VAULT_TAB_VISIBLE: 'settings:set-team-vault-tab-visible',

  // Remote profile sync ("Remote Profile Sync" — distinct from the
  // dotfiles:sync-* channels above, which deploy a dotfile pool to a remote
  // SSH server on connect. This syncs the user's own profiles/pools/settings
  // between their own machines via a Zero-Knowledge-encrypted S3/SFTP target.)
  PROFILE_SYNC_SETUP: 'profile-sync:setup',
  PROFILE_SYNC_ENABLE: 'profile-sync:enable',
  PROFILE_SYNC_PUSH: 'profile-sync:push',
  PROFILE_SYNC_PULL: 'profile-sync:pull',
  PROFILE_SYNC_STATUS: 'profile-sync:status',
  PROFILE_SYNC_COMPARE: 'profile-sync:compare',
  PROFILE_SYNC_SET_AUTO_SYNC: 'profile-sync:set-auto-sync',
  PROFILE_SYNC_UNLOCK_SMARTCARD: 'profile-sync:unlock-smartcard',
  PROFILE_SYNC_LINK_SMARTCARD: 'profile-sync:link-smartcard',
  PROFILE_SYNC_UNLINK_SMARTCARD: 'profile-sync:unlink-smartcard',
  PROFILE_SYNC_WIPE: 'profile-sync:wipe',

  // Team Vault (docs/team-vault-plan.md) — separate trust model and feature from the password-
  // based Remote Profile Sync above; see TeamVaultService for the local-only Fas 2 scope.
  TEAM_VAULT_GET_STATUS: 'team-vault:get-status',
  // Merged statuses+configs across every known vault — drives a multi-team list/switcher.
  TEAM_VAULT_LIST: 'team-vault:list',
  TEAM_VAULT_ENROLL_RECIPIENT: 'team-vault:enroll-recipient',
  TEAM_VAULT_CREATE: 'team-vault:create',
  TEAM_VAULT_ADD_MEMBER: 'team-vault:add-member',
  TEAM_VAULT_REMOVE_MEMBER: 'team-vault:remove-member',
  TEAM_VAULT_SET_ROLE: 'team-vault:set-role',
  TEAM_VAULT_RENAME: 'team-vault:rename',
  TEAM_VAULT_UNLOCK: 'team-vault:unlock',
  TEAM_VAULT_UNLOCK_WITH_RECOVERY_TEXT: 'team-vault:unlock-with-recovery-text',
  TEAM_VAULT_LOCK: 'team-vault:lock',
  TEAM_VAULT_DELETE: 'team-vault:delete',
  // Removes a LOCKED vault's local file/identity/config from this device only — see
  // teamVaultHandlers.ts's doc comment for how this differs from TEAM_VAULT_DELETE.
  TEAM_VAULT_FORGET: 'team-vault:forget',
  TEAM_VAULT_SET_TARGET: 'team-vault:set-target',
  TEAM_VAULT_PUSH: 'team-vault:push',
  TEAM_VAULT_PULL: 'team-vault:pull',
  TEAM_VAULT_HAS_REMOTE_VAULT: 'team-vault:has-remote-vault',
  TEAM_VAULT_GET_SYNC_PREVIEW: 'team-vault:get-sync-preview',
  TEAM_VAULT_TEST_TARGET: 'team-vault:test-target',
  TEAM_VAULT_GET_PAYLOAD: 'team-vault:get-payload',
  TEAM_VAULT_SAVE_SSH_PROFILE: 'team-vault:save-ssh-profile',
  TEAM_VAULT_DELETE_SSH_PROFILE: 'team-vault:delete-ssh-profile',
  TEAM_VAULT_SAVE_K8S_PROFILE: 'team-vault:save-k8s-profile',
  TEAM_VAULT_DELETE_K8S_PROFILE: 'team-vault:delete-k8s-profile',
  TEAM_VAULT_SAVE_S3_PROFILE: 'team-vault:save-s3-profile',
  TEAM_VAULT_DELETE_S3_PROFILE: 'team-vault:delete-s3-profile',
  TEAM_VAULT_SAVE_FOLDER: 'team-vault:save-folder',
  TEAM_VAULT_RENAME_FOLDER: 'team-vault:rename-folder',
  TEAM_VAULT_DELETE_FOLDER: 'team-vault:delete-folder',
  TEAM_VAULT_SET_FOLDER_ICON: 'team-vault:set-folder-icon',
  // Age-encrypted invite blob (join-flow simplification): admin side builds one for a specific
  // member, new-member side decodes it to recover the S3 target without typing it by hand.
  TEAM_VAULT_BUILD_INVITE: 'team-vault:build-invite',
  TEAM_VAULT_DECODE_INVITE: 'team-vault:decode-invite',
  TEAM_VAULT_SET_DESCRIPTION: 'team-vault:set-description',
  // Push-only (main -> renderer), fired by the background auto-poll (IpcBridge.runTeamVaultAutoPoll).
  TEAM_VAULT_AUTO_PULLED: 'team-vault:auto-pulled',
  TEAM_VAULT_REMOTE_CHANGED: 'team-vault:remote-changed',
  // Push-only (main -> renderer): fired right before/after each background push/pull, so the UI
  // can show a discreet per-team "syncing now" indicator (not just the after-the-fact result).
  TEAM_VAULT_SYNC_STATUS: 'team-vault:sync-status',

  // Connection Testing
  CONNECTION_TEST_SSH: 'connection:test-ssh',

  // Install public keys in a host's authorized_keys (ssh-copy-id)
  SSH_LIST_PUBLIC_KEYS: 'ssh:list-public-keys',
  SSH_INSTALL_PUBLIC_KEYS: 'ssh:install-public-keys',
  SSH_PROBE_HOST: 'ssh:probe-host',
  SSH_TEST_LOGIN: 'ssh:test-login',
  SSH_BUILD_INSTALL_COMMAND: 'ssh:build-install-command',
  CONNECTION_TEST_S3: 'connection:test-s3',

  // AWS SSO login (device-authorization flow)
  AWS_SSO_LOGIN: 'aws-sso:login',
  AWS_SSO_LOGIN_CANCEL: 'aws-sso:login-cancel',
  AWS_SSO_PROMPT: 'aws-sso:prompt',
  AWS_SSO_PROMPT_DONE: 'aws-sso:prompt-done',
  AWS_SSO_LIST_ACCOUNTS: 'aws-sso:list-accounts',
  AWS_SSO_LIST_ROLES: 'aws-sso:list-roles',
  AWS_SSO_RELOGIN_PROVIDER: 'aws-sso:relogin-provider',

  // Git & Git Provider Integration
  GIT_FETCH_PUBLIC_KEYS: 'git:fetch-public-keys',
  GIT_GET_SIGNING_CONFIG: 'git:get-signing-config',
  GIT_CONFIGURE_SIGNING: 'git:configure-signing',
  GIT_SET_SIGNING_ENABLED: 'git:set-signing-enabled',
  GIT_GET_STATUS: 'git:get-status',
  GIT_CLONE: 'git:clone',
  GIT_PULL: 'git:pull',
  GIT_TEST_REMOTE_ACCESS: 'git:test-remote-access',
  DOTFILES_IMPORT_FROM_GIT: 'dotfiles:import-from-git',

  // SSH Agent
  SSH_AGENT_STATUS: 'ssh:agent-status',

  // SSH CA (Step-CA, OIDC Certificate Authority)
  SSH_CA_GET_STATUS: 'ssh-ca:get-status',
  SSH_CA_LOGIN: 'ssh-ca:login',
  SSH_CA_LOGOUT: 'ssh-ca:logout',
  SSH_CA_RENEW: 'ssh-ca:renew',
  SSH_CA_DETECT: 'ssh-ca:detect',
  SSH_CA_DETECT_VAULT: 'ssh-ca:detect-vault',
  SSH_CA_STATUS_CHANGED: 'ssh-ca:status-changed',

  // Dotfiles pools (opt-in, see AppSettings.dotfilesPoolEnabled)
  DOTFILES_POOLS_GET: 'dotfiles:pools-get',
  DOTFILES_POOLS_SAVE: 'dotfiles:pools-save',
  DOTFILES_POOLS_DELETE: 'dotfiles:pools-delete',
  DOTFILES_OPEN_FOLDER: 'dotfiles:open-folder',
  DOTFILES_SELECT_FILES: 'dotfiles:select-files',
  DOTFILES_READ_SOURCES: 'dotfiles:read-sources',
  DOTFILES_ADD_FROM_STORAGE: 'dotfiles:add-from-storage',
  DOTFILES_SYNC_PROMPT: 'dotfiles:sync-prompt',
  DOTFILES_SYNC_RESPOND: 'dotfiles:sync-respond',
  DOTFILES_SYNC_STATUS: 'dotfiles:sync-status',

  // File Editor
  FILE_READ: 'file:read',
  CERTIFICATE_PREVIEW: 'certificate:preview',
  FILE_SAVE: 'file:save',
  FILE_OPEN_EXTERNAL: 'file:open-external',
  FILE_CLOSE_EXTERNAL: 'file:close-external',
  FILE_EXTERNAL_STATUS: 'file:external-status',
  FILE_TAIL_START: 'file:tail:start',
  FILE_TAIL_STOP: 'file:tail:stop',
  FILE_TAIL_DATA: 'file:tail:data',
  FILE_TAIL_ERROR: 'file:tail:error',

  // Content search ("search inside files")
  SEARCH_START: 'search:start',
  SEARCH_CANCEL: 'search:cancel',
  SEARCH_PREVIEW: 'search:preview',
  SEARCH_RESULT: 'search:result',
  SEARCH_PROGRESS: 'search:progress',
  SEARCH_ERROR: 'search:error',
  SEARCH_DONE: 'search:done',

  // General
  DRAG_OUT_START: 'drag-out:start',
  DRAG_OUT_PREPARE: 'drag-out:prepare',
  APP_OPEN_EXTERNAL: 'app:open-external',
  APP_GET_VERSION: 'app:get-version',
  UPDATE_GET_STATE: 'update:get-state',
  UPDATE_CHECK: 'update:check',
  UPDATE_DOWNLOAD: 'update:download',
  UPDATE_INSTALL: 'update:install',
  LOG_WRITE: 'log:write',
  LOG_OPEN_FOLDER: 'log:open-folder',
  LOG_GET_DIAGNOSTICS: 'log:get-diagnostics',
  UPDATE_STATE: 'update:state',
  APP_GET_HOMEDIR: 'app:get-homedir',
  APP_GET_PLATFORM: 'app:get-platform',
  APP_GET_HOSTNAME: 'app:get-hostname',
  APP_GET_SECURITY_STATUS: 'app:get-security-status',
  APP_DETECT_LOCAL_SHELLS: 'app:detect-local-shells',
  APP_OPEN_ELEVATED_SHELL: 'app:open-elevated-shell',
  APP_CHECK_X11_SERVER: 'app:check-x11-server',
  X11_GET_STATUS: 'x11:get-status',
  X11_START_SERVER: 'x11:start-server',
  X11_STOP_SERVER: 'x11:stop-server',
  DIALOG_OPEN_FILE: 'dialog:open-file',
  DIALOG_OPEN_FOLDER: 'dialog:open-folder',
  DIALOG_SAVE_FILE: 'dialog:save-file',

  // Directory sync (dual-pane folder → folder diff/copy between any two storage providers)
  DIR_SYNC_COMPUTE_DIFF: 'dirsync:compute-diff',
  DIR_SYNC_SCAN_PROGRESS: 'dirsync:scan-progress',
  DIR_SYNC_APPLY: 'dirsync:apply',
  DIR_SYNC_APPLY_PROGRESS: 'dirsync:apply-progress',
  DIR_SYNC_PROFILE_LIST: 'dirsync:profile-list',
  DIR_SYNC_PROFILE_SAVE: 'dirsync:profile-save',
  DIR_SYNC_PROFILE_DELETE: 'dirsync:profile-delete',

  // Kubernetes / OpenShift discovery
  K8S_LIST_CONTEXTS: 'k8s:list-contexts',
  K8S_LIST_NAMESPACES: 'k8s:list-namespaces',
  K8S_LIST_PODS: 'k8s:list-pods',
  K8S_RELOAD: 'k8s:reload',
  K8S_LOGIN: 'k8s:login',
  K8S_OPENSHIFT_PROBE: 'k8s:openshift-probe',
  K8S_OPENSHIFT_WEB_LOGIN: 'k8s:openshift-web-login',
  K8S_OPENSHIFT_WEB_LOGIN_CANCEL: 'k8s:openshift-web-login-cancel',
  K8S_CONFIG_CHANGED: 'k8s:config-changed',
  K8S_PROFILES_LIST: 'k8s:profiles-list',
  K8S_PROFILES_SAVE: 'k8s:profiles-save',
  K8S_PROFILES_DELETE: 'k8s:profiles-delete',

  // Kubernetes / OpenShift interactive exec terminal
  K8S_TERMINAL_CREATE: 'k8s-terminal:create',
  K8S_TERMINAL_WRITE: 'k8s-terminal:write',
  K8S_TERMINAL_RESIZE: 'k8s-terminal:resize',
  K8S_TERMINAL_KILL: 'k8s-terminal:kill',
  PERF_SSH_SAMPLE: 'perf:ssh-sample',
  PERF_K8S_SAMPLE: 'perf:k8s-sample',
  PERF_LOCAL_SAMPLE: 'perf:local-sample',
  K8S_TERMINAL_DATA: 'k8s-terminal:data',
  K8S_TERMINAL_EXIT: 'k8s-terminal:exit',

  // Kubernetes / OpenShift log follow
  K8S_LOG_START: 'k8s-log:start',
  K8S_LOG_STOP: 'k8s-log:stop',
  K8S_LOG_DATA: 'k8s-log:data',
  K8S_LOG_END: 'k8s-log:end',

  // Kubernetes / OpenShift pod describe & details
  K8S_POD_DESCRIBE: 'k8s:pod-describe',
  K8S_POD_DELETE: 'k8s:pod-delete',

  // Kubernetes / OpenShift port forward
  K8S_PORT_FORWARD_START: 'k8s-port-forward:start',
  K8S_PORT_FORWARD_STOP: 'k8s-port-forward:stop',
  K8S_PORT_FORWARD_RECONNECT: 'k8s-port-forward:reconnect',
  K8S_PORT_FORWARD_LIST: 'k8s-port-forward:list',
  K8S_PORT_FORWARD_EVENT: 'k8s-port-forward:event',

  // Kubernetes / OpenShift debug
  K8S_DEBUG_ATTACH: 'k8s:debug-attach',

  // SSH tunnels (standalone port forwarding, independent of terminal sessions)
  SSH_TUNNEL_START: 'ssh-tunnel:start',
  SSH_TUNNEL_STOP: 'ssh-tunnel:stop',
  SSH_TUNNEL_LIST: 'ssh-tunnel:list',
  SSH_TUNNEL_EVENT: 'ssh-tunnel:event',
  SSH_TUNNEL_CHECK_PORT: 'ssh-tunnel:check-port',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

/** Informational only — no reply is expected or accepted, unlike an Askpass prompt. */
export interface PresencePromptEvent {
  id: string;
  sessionId?: string;
  message: string;
}

export interface PresenceClearEvent {
  id?: string;
  sessionId?: string;
}

/**
 * `kind` tells the renderer which physical credential this PIN belongs to
 * (FIDO2 security key vs PIV smartcard) so the modal can label itself
 * correctly instead of leaving the user to guess from OpenSSH's own raw
 * prompt text, which doesn't consistently say so. Set explicitly by
 * whichever flow requested the prompt — never inferred from the prompt
 * string itself, since that text varies across OpenSSH/libfido2 versions.
 * Undefined for prompts this app can't attribute (e.g. a plain account
 * password or key passphrase) — the modal falls back to generic wording.
 */
export type AskpassPromptKind = 'smartcard' | 'fido2' | 'password';

export interface AskpassPromptEvent {
  id: string;
  prompt: string;
  sessionId?: string;
  kind?: AskpassPromptKind;
  context?: string;
  /** Set when this prompt is re-asking after a wrong PIN — the modal shows this inline instead of failing silently. */
  error?: string;
  /** 1-based attempt number this prompt represents, paired with `maxAttempts`. */
  attempt?: number;
  maxAttempts?: number;
}

/** Asks the user to plug in the smartcard / security key an operation needs; dismissed once it is detected. */
export interface InsertTokenPromptEvent {
  id: string;
  kind: 'smartcard' | 'fido2';
  context?: string;
}

export interface SmartcardStartupUnlockStatusEvent {
  kind: 'smartcard' | 'fido2';
  status: 'unlocked' | 'error';
  libPath?: string;
  error?: string;
}

export interface HostKeyPromptEvent {
  id: string;
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
  /** 'unknown' = first time connecting to this host. 'mismatch' = the presented key differs from a previously trusted one. */
  status: 'unknown' | 'mismatch';
}

export interface AwsSsoPromptEvent extends AwsSsoDevicePrompt {
  id: string;
}

export type TransferConflictResolution = 'overwrite' | 'skip' | 'rename';

export interface TransferConflictPromptEvent {
  id: string;
  sourcePath: string;
  targetPath: string;
  fileName: string;
  isDirectory: boolean;
}

/**
 * UX audit finding #2: quitting used to show a native `dialog.showMessageBoxSync`
 * box, which looks and behaves nothing like the rest of the app's themed
 * `ConfirmDialog` (default-focused button, danger styling, etc.). The main
 * process now asks the renderer to show its own dialog and awaits the
 * result over this same request/response IPC pattern as transfer conflicts.
 */
/** A live terminal session that moves along with a tab (keyed by the pane that shows it). */
export interface TabHandoffSession {
  paneId: string;
  sessionId: string;
  kind: 'ssh' | 'k8s';
}

/** A tab moving between windows. `tab` is the renderer's tab, already stripped of secrets. */
export interface TabHandoff {
  tab: Record<string, unknown>;
  sessions: TabHandoffSession[];
}

/** Where a moved tab goes: a new window, or the window with this id. */
export type MoveTabTarget = 'new' | number;

export interface WindowInfo {
  id: number;
  label: string;
  /** True for the window that asked. */
  current: boolean;
}

export interface QuitConfirmPromptEvent {
  id: string;
  kind: 'active-transfers' | 'confirm-before-quit' | 'close-window';
  activeTransferCount?: number;
  /** For 'close-window': how many live sessions closing the window will end. */
  sessionCount?: number;
}

export interface DirSyncComputeDiffOptions {
  sourceProviderId: string;
  sourcePath: string;
  targetProviderId: string;
  targetPath: string;
}

export interface DirSyncScanProgressEvent {
  side: 'source' | 'target';
  filesCount: number;
  currentItem: string;
}

export interface DirSyncApplyOptions {
  entries: DirectoryDiffEntry[];
  sourceProviderId: string;
  sourcePath: string;
  targetProviderId: string;
  targetPath: string;
  deleteExtraneous: boolean;
}

export interface StorageConnectConfig {
  id: string;
  name: string;
  type: 'local' | 'sftp' | 's3' | 'k8s';
  localBasePath?: string;
  sftpConfig?: SFTPConfig;
  s3Config?: S3Config;
  k8sConfig?: K8sStorageConfig;
  /** SSH terminal this provider serves; main lets its SFTP channel share the terminal's SSH connection. */
  terminalSessionId?: string;
}

export interface MultiSSHApi extends AiHubApi {
  nativeHermes?: NativeHermesApi;
  // Terminal
  terminalCreate(options: {
    profileId?: string;
    config?: SSHConnectionConfig;
    local?: boolean;
    ptyOptions?: PtyOptions;
  }): Promise<{ sessionId: string }>;
  terminalWrite(sessionId: string, data: string): Promise<void>;
  terminalResize(sessionId: string, cols: number, rows: number): Promise<void>;
  terminalKill(sessionId: string): Promise<void>;
  terminalReconnect(sessionId: string): Promise<boolean>;
  terminalGetCwd(sessionId: string): Promise<string | null>;
  /** Whether the local shell of a terminal currently runs an interactive ssh client (Linux only). */
  terminalHasSshClient(sessionId: string): Promise<boolean>;
  onTerminalData(callback: (sessionId: string, data: string) => void): () => void;
  onTerminalExit(callback: (sessionId: string, event: SSHPtyExitEvent) => void): () => void;
  onTerminalReconnecting?(callback: (sessionId: string, event: { attempt: number; maxAttempts: number }) => void): () => void;

  // Smartcard
  smartcardDetect(): Promise<DetectedSmartcardLib[]>;
  smartcardValidate(path: string): Promise<{ valid: boolean; error?: string }>;
  /** Windows only: can the ssh-agent service load this PKCS#11 module with the machine PATH? */
  smartcardAgentPathStatus(pkcs11LibPath: string): Promise<{ applicable: boolean; needsFix: boolean; libDir?: string }>;
  /** Windows only: adds the module's folder to the machine PATH (UAC prompt) and restarts ssh-agent. */
  smartcardAgentPathFix(pkcs11LibPath: string): Promise<void>;
  smartcardLockAll(): Promise<{ locked: number }>;
  smartcardListCached(): Promise<CachedSmartcardAgent[]>;
  /** Called once on renderer startup; a no-op unless 'agent-global' PIN caching + the startup-unlock setting are both on and exactly one PKCS#11 library is detected. */
  smartcardUnlockAtStartup(): Promise<{ started: boolean }>;
  /** The top-bar "Unlock" action: same as the startup unlock but on demand, regardless of the startup-unlock setting (still only in 'agent-global' mode). */
  smartcardUnlockNow(): Promise<{ started: boolean }>;
  /** Fired asynchronously once the startup unlock kicked off by smartcardUnlockAtStartup finishes, reporting whether the PIN was accepted. */
  onSmartcardStartupUnlockStatus(callback: (event: SmartcardStartupUnlockStatusEvent) => void): () => void;
  onAskpassPrompt(callback: (event: AskpassPromptEvent) => void): () => void;
  submitAskpassPin(id: string, pin: string): Promise<void>;
  /** Fired when an operation needs a smartcard / security key that is not plugged in. */
  onInsertTokenPrompt(callback: (event: InsertTokenPromptEvent) => void): () => void;
  /** Fired when the token has been detected (the operation continues with its PIN prompt) or the wait ended. */
  onInsertTokenDismiss(callback: (event: { id: string }) => void): () => void;
  cancelInsertToken(id: string): Promise<void>;
  /** Fired when a smartcard/FIDO2 operation is blocked waiting for a physical touch. Informational only. */
  onPresencePrompt(callback: (event: PresencePromptEvent) => void): () => void;
  /** Fired once the operation that triggered a matching `onPresencePrompt` id has finished. */
  onPresenceClear(callback: (event: PresenceClearEvent) => void): () => void;

  // FIDO2 / hardware security keys
  fido2GenerateKey(options: GenerateFido2KeyRequest): Promise<GeneratedFido2Key>;
  fido2ListResidentKeys(): Promise<Fido2ResidentKey[]>;
  /** Only valid for an entry whose `credentialId` was set (i.e. sourced from `ykman`, see Fido2ResidentKey). */
  fido2DeleteResidentKey(credentialId: string): Promise<void>;

  // SFTP host key verification (TOFU)
  onHostKeyPrompt(callback: (event: HostKeyPromptEvent) => void): () => void;
  respondHostKeyPrompt(id: string, trust: boolean): Promise<void>;

  // Transfer conflict resolution
  onTransferConflictPrompt(callback: (event: TransferConflictPromptEvent) => void): () => void;
  respondTransferConflict(id: string, resolution: TransferConflictResolution, applyToAll: boolean): Promise<void>;

  // Quit confirmation (see QuitConfirmPromptEvent)
  onQuitConfirmPrompt(callback: (event: QuitConfirmPromptEvent) => void): () => void;
  respondQuitConfirm(id: string, proceed: boolean): Promise<void>;

  // Storage
  connectStorage(config: StorageConnectConfig): Promise<{ id: string }>;
  disconnectStorage(providerId: string): Promise<void>;
  storageList(providerId: string, remotePath: string, force?: boolean): Promise<FileEntry[]>;
  storageStat(providerId: string, remotePath: string): Promise<FileEntry>;
  /** Like `storageStat`, but a path that does not exist resolves to `null` instead of rejecting. */
  storageLookup(providerId: string, remotePath: string): Promise<FileEntry | null>;
  storageCreateFolder(providerId: string, remotePath: string): Promise<void>;
  /** Creates an empty file; rejects when something already exists at `remotePath`. */
  storageCreateFile(providerId: string, remotePath: string): Promise<void>;
  /** Packs children of `parentDir` into a new archive beside them (local and SFTP only); resolves to the archive's file name. */
  archiveCompress(providerId: string, parentDir: string, names: string[], format: 'tar.gz' | 'zip'): Promise<string>;
  /** Unpacks an archive into a new folder named after it, beside it; resolves to the folder's name. */
  archiveExtract(providerId: string, archivePath: string): Promise<string>;
  storageDelete(providerId: string, remotePath: string, isDirectory: boolean): Promise<void>;
  storageRename(providerId: string, oldPath: string, newPath: string): Promise<void>;
  storageChmod(providerId: string, remotePath: string, mode: number | string): Promise<void>;
  storageGetWinAttributes(providerId: string, remotePath: string): Promise<WinAttributes>;
  storageSetWinAttributes(providerId: string, remotePath: string, changes: Partial<WinAttributes>, recursive?: boolean): Promise<void>;
  storageSetMetadata(providerId: string, remotePath: string, metadata: ObjectMetadata): Promise<void>;
  storageGetTags(providerId: string, remotePath: string): Promise<S3Tag[]>;
  storageSetTags(providerId: string, remotePath: string, tags: S3Tag[]): Promise<void>;
  storageGetBucketPolicy(providerId: string, bucketPath: string): Promise<string | null>;
  storageSetBucketPolicy(providerId: string, bucketPath: string, policy: string | null): Promise<void>;
  storageGetBucketCors(providerId: string, bucketPath: string): Promise<string | null>;
  storageSetBucketCors(providerId: string, bucketPath: string, corsJson: string | null): Promise<void>;
  storageGetBucketVersioning(providerId: string, bucketPath: string): Promise<BucketVersioningInfo>;
  storageSetBucketVersioning(providerId: string, bucketPath: string, enabled: boolean): Promise<void>;
  storageListObjectVersions(providerId: string, remotePath: string): Promise<ObjectVersionEntry[]>;
  storageDeleteObjectVersion(providerId: string, remotePath: string, versionId: string): Promise<void>;
  storageRestoreObjectVersion(providerId: string, remotePath: string, versionId: string): Promise<void>;
  storageGetPresignedUrl(providerId: string, remotePath: string, expiresInSeconds: number): Promise<string>;
  storageGetHomeDir(providerId: string): Promise<string>;
  storageGetSpace(providerId: string, remotePath: string): Promise<SpaceInfo | undefined>;
  storageListVolumes(providerId: string): Promise<VolumeInfo[]>;

  // Transfer
  transferAdd(options: {
    sourceProviderId: string;
    sourcePath: string;
    targetProviderId: string;
    targetPath: string;
    conflictPolicy?: TransferConflictResolution;
    verifyIntegrity?: boolean;
    verifyChecksum?: boolean | 'sha256' | 'md5';
    expectedChecksum?: string;
  }): Promise<{ jobId: string | null; skipped?: boolean; resolvedPolicy?: TransferConflictResolution; appliedToAll?: boolean; targetPath?: string }>;
  transferPause(jobId: string): Promise<void>;
  transferResume(jobId: string): Promise<void>;
  transferCancel(jobId: string): Promise<void>;
  transferGetJobs(): Promise<TransferProgress[]>;
  transferClearCompleted(): Promise<void>;
  onTransferProgress(callback: (progress: TransferProgress) => void): () => void;
  getPathForFile?(file: File): string;

  // Profiles
  profilesGet(): Promise<{ ssh: SSHConnectionConfig[]; s3: S3Config[]; folders?: string[] }>;
  profilesSaveSSH(config: SSHConnectionConfig): Promise<void>;
  profilesDeleteSSH(id: string): Promise<void>;
  profilesSaveS3(config: S3Config): Promise<void>;
  profilesDeleteS3(id: string): Promise<void>;
  profilesSaveFolder(name: string): Promise<void>;
  profilesDeleteFolder(name: string, deleteProfiles?: boolean): Promise<void>;
  profilesRenameFolder(oldName: string, newName: string): Promise<void>;
  profilesImportSshConfig(): Promise<{ profiles: SSHConnectionConfig[]; filePath: string }>;
  profilesExportJson(): Promise<{ count: number; filePath: string } | null>;
  profilesImportJson(): Promise<{ count: number }>;

  // Session
  sessionGet(): Promise<SessionData | null>;
  sessionSave(data: SessionData): Promise<void>;
  /** Opens another app window (e.g. for a second monitor). */
  windowNew(): Promise<void>;
  /** Hands a tab (and its live terminal sessions) to a new or another window. */
  windowMoveTab(handoff: TabHandoff, target: MoveTabTarget): Promise<void>;
  /** The tab this window was opened for, if any (fetched once at start-up). */
  windowTakeHandoff(): Promise<TabHandoff | null>;
  windowList(): Promise<WindowInfo[]>;
  onWindowAdoptTab(callback: (handoff: TabHandoff) => void): () => void;
  /** Claims a live terminal session for this window and returns the output it printed so far. */
  terminalAttach(sessionId: string, kind: 'ssh' | 'k8s'): Promise<{ scrollback: string }>;
  clipboardHistoryList(hostKey?: string): Promise<ClipboardHistoryEntry[]>;
  clipboardHistoryAdd(text: string, hostKey: string, hostLabel: string): Promise<void>;
  clipboardHistoryDelete(id: string): Promise<void>;
  clipboardHistoryClear(): Promise<void>;
  snippetsList(hostKey?: string): Promise<Snippet[]>;
  snippetsSave(snippet: Omit<Snippet, 'id'> & { id?: string }): Promise<Snippet>;
  snippetsDelete(id: string): Promise<void>;

  // Settings
  settingsGet(): Promise<AppSettings>;
  settingsSave(settings: Partial<AppSettings>): Promise<AppSettings>;
  policyGet(): Promise<PolicyInfo>;
  /** Atomically flips one team's `connectionManagerVisibleTeamVaults` entry — see
   * `SettingsStore.setTeamVaultTabVisible`'s doc comment for why this exists instead of a plain
   * `settingsGet()` -> mutate -> `settingsSave()` round trip. */
  settingsSetTeamVaultTabVisible(vaultId: string, visible: boolean): Promise<AppSettings>;

  // Remote profile sync
  profileSyncSetup(payload: { target: StorageConnectConfig; remoteBasePath?: string }): Promise<void>;
  profileSyncEnable(passwords: { topologyPassword: string; credentialsPassword: string }): Promise<ProfileSyncStatus>;
  profileSyncPush(): Promise<ProfileSyncStatus>;
  profileSyncPull(passwords?: {
    topologyPassword?: string;
    credentialsPassword?: string;
  }): Promise<ProfileSyncPullResult & ProfileSyncStatus>;
  profileSyncStatus(): Promise<ProfileSyncStatus>;
  profileSyncCompare(): Promise<SyncComparisonResult>;
  profileSyncSetAutoSync(enabled: boolean): Promise<ProfileSyncStatus>;
  profileSyncUnlockSmartcard(options?: { pkcs11LibPath?: string; pin?: string }): Promise<ProfileSyncStatus>;
  profileSyncLinkSmartcard(options: {
    pkcs11LibPath: string;
    pin?: string;
    passwords?: { topologyPassword: string; credentialsPassword: string };
  }): Promise<ProfileSyncStatus>;
  profileSyncUnlinkSmartcard(): Promise<ProfileSyncStatus>;
  /** Deletes the remote sync files for the current target and clears all local sync configuration (target, salts, smartcard link). Never touches local profiles/dotfiles/settings. */
  profileSyncWipe(): Promise<ProfileSyncStatus & { remoteWipeErrors: string[] }>;
  onProfileSyncStatus?(callback: (status: ProfileSyncStatus) => void): () => void;

  // Team Vault (docs/team-vault-plan.md) — multi-team: every method below takes a leading
  // `vaultId`, except `teamVaultCreate` (mints one and returns it) and `teamVaultEnrollRecipient`
  // (generating a recipient to create/join a vault has no vaultId to pass yet — see
  // TeamVaultService.enrollOwnPivRecipient's doc comment).
  teamVaultGetStatus(vaultId: string): Promise<TeamVaultStatus>;
  /** Merged statuses+configs across every vault this device knows about — the one call a
   * team-list/switcher UI needs at mount. */
  teamVaultList(): Promise<TeamVaultStatus[]>;
  teamVaultEnrollRecipient(
    vaultId?: string
  ): Promise<{ recipient: string; identityFilePath: string; suggestedLabel?: string }>;
  teamVaultCreate(
    selfRecipientId: string,
    selfAgeRecipient: string,
    vaultName?: string,
    selfIdentityFilePath?: string
  ): Promise<{ vaultId: string; recoveryIdentity: string }>;
  teamVaultAddMember(vaultId: string, recipientId: string, ageRecipient: string, role: TeamVaultRole): Promise<void>;
  teamVaultRemoveMember(vaultId: string, recipientId: string): Promise<{ remainingAdmins: number }>;
  teamVaultSetRole(vaultId: string, recipientId: string, role: TeamVaultRole): Promise<void>;
  teamVaultRename(vaultId: string, vaultName: string): Promise<void>;
  teamVaultUnlock(vaultId: string, recipientId: string, identityFilePath: string): Promise<void>;
  teamVaultUnlockWithRecoveryText(vaultId: string, identityText: string): Promise<void>;
  teamVaultLock(vaultId: string): Promise<void>;
  teamVaultDelete(vaultId: string): Promise<void>;
  /** Removes a LOCKED vault's local file/identity/config from this device only — distinct from
   * `teamVaultDelete`, an authenticated whole-team-affecting action; see teamVaultHandlers.ts. */
  teamVaultForget(vaultId: string): Promise<void>;
  teamVaultSetTarget(vaultId: string, target: StorageConnectConfig, remoteBasePath?: string): Promise<void>;
  // Both return the post-push/pull TeamVaultStatus (same as teamVaultGetStatus would right
  // after) — used by TeamVaultListPanel's join flow to learn the real vaultId a pending-sentinel
  // pull resolves to, without a second round trip.
  teamVaultPush(vaultId: string): Promise<TeamVaultStatus>;
  teamVaultPull(vaultId: string, options?: { force?: boolean }): Promise<TeamVaultStatus>;
  teamVaultHasRemoteVault(vaultId: string): Promise<boolean>;
  /** Best-effort: resolves to `{ hasUnpushedLocalChanges: false, remoteChanged: false }` (shown
   * as "Up to date") if the preview check itself fails, e.g. no target configured yet or the
   * vault is locked — see teamVaultHandlers.ts. */
  teamVaultGetSyncPreview(vaultId: string): Promise<TeamVaultSyncPreview>;
  /** Like `testS3Connection`, but for a Team Vault's own sync target: if `config.secretAccessKey`
   * is blank, substitutes the vault's already-saved secret before testing — the target editor
   * never round-trips the real secret to the renderer (see `TeamVaultStatus.targetConfig`'s doc
   * comment), so a blank field here means "use the saved one", not "no secret". */
  teamVaultTestTarget(vaultId: string, config: S3Config): Promise<{ success: boolean; error?: string }>;
  /** Null when the vault doesn't exist or isn't unlocked — best-effort, see teamVaultHandlers.ts. */
  teamVaultGetPayload(vaultId: string): Promise<TeamVaultPayload | null>;
  teamVaultSaveSSHProfile(vaultId: string, profile: SSHConnectionConfig): Promise<void>;
  teamVaultDeleteSSHProfile(vaultId: string, id: string): Promise<void>;
  teamVaultSaveK8sProfile(vaultId: string, profile: K8sProfile): Promise<void>;
  teamVaultDeleteK8sProfile(vaultId: string, id: string): Promise<void>;
  teamVaultSaveS3Profile(vaultId: string, profile: S3Config): Promise<void>;
  teamVaultDeleteS3Profile(vaultId: string, id: string): Promise<void>;
  teamVaultSaveFolder(vaultId: string, folderPath: string): Promise<void>;
  teamVaultRenameFolder(vaultId: string, oldPath: string, newPath: string): Promise<void>;
  teamVaultDeleteFolder(vaultId: string, folderPath: string, deleteProfiles?: boolean): Promise<void>;
  teamVaultSetFolderIcon(vaultId: string, folderPath: string, icon: string | undefined): Promise<void>;
  /** Admin-only (see `TeamVaultService.buildInvite`'s doc comment): builds an age-encrypted
   * invite blob for `recipientId`, already a member (added via `teamVaultAddMember`), containing
   * the vault's configured S3 target — so the new member never has to type it in by hand. Returns
   * the blob as a single string, ready to copy/paste out of band (chat, email, ...). */
  teamVaultBuildInvite(vaultId: string, recipientId: string): Promise<string>;
  /** New-member side of `teamVaultBuildInvite`: decrypts a pasted invite blob with the identity at
   * `identityFilePath` (prompts for PIN/touch like any other PIV operation) and returns the S3
   * target it carries. Throws a user-facing error on a malformed/truncated paste or a mismatched
   * identity. */
  teamVaultDecodeInvite(
    inviteText: string,
    identityFilePath: string
  ): Promise<{ vaultId: string; target: StorageConnectConfig; remoteBasePath?: string }>;
  /** Admin-only: sets (or, with an empty string, clears) the vault's free-text description shown
   * in the Connection Manager's per-team tab. */
  teamVaultSetDescription(vaultId: string, description: string): Promise<void>;
  /** Fired by the main-process background poll (IpcBridge.runTeamVaultAutoPoll) when it detected
   * and auto-applied a remote change, or detected one it couldn't safely auto-apply —
   * `vaultId` tells the renderer which team's UI to refresh. */
  onTeamVaultAutoPulled?(callback: (payload: { vaultId: string }) => void): () => void;
  onTeamVaultRemoteChanged?(callback: (payload: { vaultId: string }) => void): () => void;
  /** Fired right before (`syncing: true`) and after (`syncing: false`) each background
   * push/pull for `vaultId` — drives the per-team-tab sync dot (§C/§D of the join-flow plan). */
  onTeamVaultSyncStatus?(callback: (payload: { vaultId: string; syncing: boolean }) => void): () => void;

  // Connection Testing
  testSSHConnection(config: SSHConnectionConfig): Promise<{ success: boolean; error?: string }>;

  // Install public keys in a host's authorized_keys (ssh-copy-id)
  listPublicKeys(request: ListPublicKeysRequest): Promise<LocalPublicKey[]>;
  installPublicKeys(request: InstallPublicKeysRequest): Promise<InstallPublicKeysResult>;
  buildInstallCommand(publicKeys: string[]): Promise<string>;
  sshProbeHost(config: SSHConnectionConfig): Promise<ProbeHostResult>;
  sshTestLogin(config: SSHConnectionConfig): Promise<TestLoginResult>;
  testS3Connection(config: S3Config): Promise<{ success: boolean; error?: string }>;

  // AWS SSO login (device-authorization flow)
  awsSsoLogin(startUrl: string, region: string, network?: AwsSsoNetworkOptions): Promise<AwsSsoLoginResult>;
  awsSsoCancelLogin(id: string): Promise<void>;
  onAwsSsoPrompt(callback: (event: AwsSsoPromptEvent) => void): () => void;
  /** Fires with the prompt id once a login attempt has ended (approved, failed, expired or cancelled). */
  onAwsSsoPromptDone(callback: (id: string) => void): () => void;
  awsSsoListAccounts(
    accessToken: string,
    region: string,
    network?: AwsSsoNetworkOptions
  ): Promise<AwsSsoAccount[]>;
  awsSsoListRoles(
    accessToken: string,
    region: string,
    accountId: string,
    network?: AwsSsoNetworkOptions
  ): Promise<AwsSsoAccountRole[]>;
  /** Signs an already-connected S3 provider in again with the SSO settings of its own profile. */
  awsSsoReloginProvider(providerId: string): Promise<void>;

  // SSH Agent
  getSshAgentStatus(): Promise<SshAgentStatus>;

  // Git & Git Provider Integration
  gitFetchPublicKeys(request: FetchGitKeysRequest): Promise<FetchGitKeysResult>;
  gitGetSigningConfig(): Promise<GitSigningConfig>;
  gitConfigureSigning(request: ConfigureGitSigningRequest): Promise<ConfigureGitSigningResult>;
  gitSetSigningEnabled(enabled: boolean): Promise<ConfigureGitSigningResult>;
  gitGetStatus(directoryPath: string, providerId?: string): Promise<GitRepoStatus>;
  gitClone(request: GitCloneRequest): Promise<GitOperationResult>;
  gitPull(directoryPath: string, providerId?: string): Promise<GitOperationResult>;
  gitTestRemoteAccess(request: TestRemoteGitAccessRequest): Promise<TestRemoteGitAccessResult>;
  dotfilesImportFromGit(request: DotfilesImportFromGitRequest): Promise<DotfilesImportFromGitResult>;

  // Dotfiles pools
  dotfilePoolsGet(): Promise<DotfilePool[]>;
  dotfilePoolsSave(pool: DotfilePool): Promise<void>;
  dotfilePoolsDelete(id: string): Promise<void>;
  dotfilePoolOpenFolder(poolId: string): Promise<string>;
  dotfilePoolSelectFiles(): Promise<DotfileImportedFile[]>;
  /** Re-reads local source files of pooled entries; missing/unimportable files are absent from the result. */
  dotfilePoolReadSources(paths: string[]): Promise<DotfileImportedFile[]>;
  dotfilePoolAddFromStorage(options: {
    poolId: string;
    providerId: string;
    filePath: string;
    targetRemotePath?: string;
  }): Promise<DotfilePool>;
  onDotfilesSyncPrompt(callback: (event: DotfilesSyncPromptEvent) => void): () => void;
  respondDotfilesSyncPrompt(id: string, resolution: DotfilesSyncResolution): Promise<void>;
  onDotfilesSyncStatus(callback: (event: DotfilesSyncStatusEvent) => void): () => void;

  // File Editor
  fileRead(providerId: string, remotePath: string, maxBytes?: number): Promise<FileReadResult>;
  /** Human-readable facts about the certificates in a file, parsed locally; never returns file text or key material. With `host`, also checks whether each certificate is valid for that name. */
  certificatePreview(providerId: string, remotePath: string, host?: string): Promise<CertificatePreviewResult>;
  fileSave(providerId: string, remotePath: string, content: string): Promise<void>;
  fileOpenExternal(providerId: string, remotePath: string): Promise<{ sessionToken: string; localPath: string }>;
  fileCloseExternal(sessionToken: string): Promise<void>;
  onExternalFileStatus(callback: (event: ExternalFileStatusEvent) => void): () => void;
  fileTailStart(providerId: string, remotePath: string): Promise<{ tailId: string; initialContent: string; size: number }>;
  fileTailStop(tailId: string): Promise<void>;
  onFileTailData(callback: (event: { tailId: string; chunk: string }) => void): () => void;
  onFileTailError(callback: (event: { tailId: string; error: string }) => void): () => void;

  // Content search ("search inside files")
  searchStart(options: SearchStartOptions): Promise<SearchStartResult>;
  searchCancel(searchId: string): Promise<void>;
  searchPreview(
    providerId: string,
    remotePath: string,
    lineNumber: number,
    contextLines: number
  ): Promise<SearchPreviewResult>;
  onSearchResult(callback: (event: SearchResultEvent) => void): () => void;
  onSearchProgress(callback: (event: SearchProgressEvent) => void): () => void;
  onSearchError(callback: (event: SearchErrorEvent) => void): () => void;
  onSearchDone(callback: (event: SearchDoneEvent) => void): () => void;

  // Kubernetes / OpenShift discovery
  k8sListContexts(): Promise<K8sClusterNode[]>;
  k8sListNamespaces(contextName: string): Promise<K8sNamespaceNode[]>;
  k8sListPods(contextName: string, namespace: string): Promise<K8sPodNode[]>;
  k8sReload(): Promise<void>;
  k8sLogin(options: K8sLoginOptions): Promise<K8sLoginResult>;
  k8sOpenShiftProbe(server: string, insecureSkipTlsVerify?: boolean): Promise<K8sOpenShiftProbeResult>;
  k8sOpenShiftWebLogin(options: K8sWebLoginOptions): Promise<K8sWebLoginResult>;
  k8sOpenShiftWebLoginCancel(): Promise<void>;
  k8sProfilesList(): Promise<K8sProfile[]>;
  k8sProfilesSave(profile: K8sProfile): Promise<K8sProfile>;
  k8sProfilesDelete(id: string): Promise<void>;
  onK8sConfigChanged(callback: (execAuthWarning?: string | null) => void): () => void;
  k8sTerminalCreate(target: K8sTerminalTarget, options?: { cols?: number; rows?: number }): Promise<{ sessionId: string }>;
  k8sTerminalWrite(sessionId: string, data: string): Promise<void>;
  k8sTerminalResize(sessionId: string, cols: number, rows: number): Promise<void>;
  k8sTerminalKill(sessionId: string): Promise<void>;
  perfSshSample(sessionId: string): Promise<PerfSshResult>;
  perfK8sSample(target: PerfK8sTarget): Promise<PerfK8sResult>;
  perfLocalSample(): Promise<PerfSshResult>;
  onK8sTerminalData(callback: (sessionId: string, data: string) => void): () => void;
  onK8sTerminalExit(callback: (sessionId: string, event: { status: string }) => void): () => void;
  k8sLogStart(
    target: K8sTerminalTarget,
    options?: { tailLines?: number; timestamps?: boolean; previous?: boolean }
  ): Promise<{ sessionId: string }>;
  k8sLogStop(sessionId: string): Promise<void>;
  onK8sLogData(callback: (sessionId: string, data: string) => void): () => void;
  onK8sLogEnd(callback: (sessionId: string) => void): () => void;
  k8sDescribePod(contextName: string, namespace: string, podName: string): Promise<K8sPodDescription>;
  k8sDeletePod(contextName: string, namespace: string, podName: string): Promise<void>;
  k8sStartPortForward(target: K8sPortForwardTarget): Promise<K8sActivePortForward>;
  k8sStopPortForward(id: string): Promise<boolean>;
  k8sReconnectPortForward(id: string): Promise<boolean>;
  k8sListPortForwards(): Promise<K8sActivePortForward[]>;
  onK8sPortForwardEvent(callback: (activeForwards: K8sActivePortForward[]) => void): () => void;
  k8sAttachDebugContainer(target: K8sDebugTarget): Promise<{ containerName: string }>;

  sshTunnelStart(config: SSHConnectionConfig, tunnel: SSHTunnelConfig): Promise<SSHActiveTunnel>;
  sshTunnelStop(id: string): Promise<boolean>;
  sshTunnelList(): Promise<SSHActiveTunnel[]>;
  onSshTunnelEvent(callback: (active: SSHActiveTunnel[]) => void): () => void;
  /** Probes whether a local port is free to bind on 127.0.0.1. Best-effort — a free result can
   * still lose a race to something else binding the port between the check and the real start. */
  sshTunnelCheckPort(port: number): Promise<boolean>;

  // Window / General
  /** Starts a native OS drag of local files/folders (call from a `dragstart` handler after `preventDefault()`). Resolves false when no path was draggable. */
  dragOutStart(paths: string[]): Promise<boolean>;
  /** Downloads remote files/folders into a private temp dir and resolves to the local paths (same order), ready for `dragOutStart`. */
  dragOutPrepare(providerId: string, paths: string[]): Promise<string[]>;
  openExternal(url: string): Promise<void>;
  getVersion(): Promise<string>;
  getUpdateState(): Promise<UpdateState>;
  checkForUpdates(): Promise<UpdateState>;
  downloadUpdate(): Promise<UpdateState>;
  installUpdate(): Promise<void>;
  /** Renderer diagnostics into the main-process log (masked and rate-limited there). */
  writeLog(level: LogLevel, scope: string, message: string, ctx?: unknown): Promise<void>;
  openLogFolder(): Promise<void>;
  /** Version/OS header plus the most recent (already masked) log lines, for bug reports. */
  getDiagnostics(): Promise<string>;
  onUpdateState(callback: (state: UpdateState) => void): () => void;
  getHomeDir(): Promise<string>;
  getPlatform(): Promise<'win32' | 'darwin' | 'linux' | string>;
  getHostname(): Promise<string>;
  /**
   * Whether saved credentials (SSH/S3 passwords, passphrases, proxy
   * passwords) are actually being encrypted at rest via the OS keyring
   * (safeStorage). When false — no keyring/libsecret backend available,
   * common on minimal Linux setups — they're stored in plaintext instead.
   */
  getSecurityStatus(): Promise<{ credentialEncryptionAvailable: boolean; undecryptableSecretCount: number }>;
  /** Windows only: which optional local shells (PowerShell 7 / pwsh, WSL / wsl) and distributions are actually installed and available. */
  detectLocalShells(): Promise<{ pwsh: boolean; wsl: boolean; wslDistros: string[] }>;
  /** Windows only: opens cmd / PowerShell / pwsh in a separate elevated window via UAC. `started` is false if UAC was declined. */
  openElevatedShell(shellType: 'cmd' | 'powershell' | 'pwsh'): Promise<{ started: boolean }>;
  /** Windows/Linux: check whether an X11 server is actively listening on the target display. */
  checkX11Server(display?: string): Promise<{ running: boolean; display: string; platform?: string }>;
  /** Windows: Get current status of managed/detected X server. */
  x11GetStatus(customPath?: string, display?: string): Promise<XServerStatus>;
  /** Windows: Start local X server (VcXsrv/Xming/custom). */
  x11StartServer(options?: { customPath?: string; customArgs?: string; display?: string }): Promise<{ success: boolean; error?: string }>;
  /** Windows: Stop managed local X server. */
  x11StopServer(): Promise<{ success: boolean }>;
  dialogOpenFile(options?: { title?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>;
  dialogSaveFile(options?: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>;
  dialogOpenFolder(options?: { title?: string }): Promise<string | null>;

  // Directory sync
  dirSyncComputeDiff(options: DirSyncComputeDiffOptions): Promise<DirectoryDiffResult>;
  onDirSyncScanProgress(callback: (event: DirSyncScanProgressEvent) => void): () => void;
  dirSyncApply(options: DirSyncApplyOptions): Promise<DirectorySyncApplyResult>;
  onDirSyncApplyProgress(callback: (progress: TransferProgress) => void): () => void;
  dirSyncProfileList(): Promise<DirectorySyncProfile[]>;
  dirSyncProfileSave(profile: DirectorySyncProfile): Promise<DirectorySyncProfile>;
  dirSyncProfileDelete(id: string): Promise<void>;

  // SSH CA
  sshCaGetStatus(): Promise<SshCaStatus>;
  sshCaLogin(config?: SshCaConfig): Promise<SshCaStatus>;
  sshCaLogout(): Promise<void>;
  sshCaRenew(): Promise<SshCaStatus>;
  sshCaDetect(request: SshCaDetectRequest): Promise<SshCaDetectResult>;
  sshCaDetectVault(request: SshCaVaultDetectRequest): Promise<SshCaVaultDetectResult>;
  onSshCaStatusChanged(callback: (status: SshCaStatus) => void): () => void;
}

export interface FileReadResult {
  content: string;
  size: number;
  isBinary: boolean;
  truncated: boolean;
  /** True when the target path is a directory rather than a file. */
  isDirectory?: boolean;
  /** The content is not valid UTF-8, so saving it back would corrupt the file. */
  notUtf8?: boolean;
  /** Base64-encoded file bytes, provided for binary media (images, PDFs). */
  base64?: string;
  /** Inferred or detected MIME type (e.g. image/png, application/pdf). */
  mimeType?: string;
}

export interface ExternalFileStatusEvent {
  sessionToken: string;
  /** The storage the file belongs to: the same path can exist on several servers. */
  providerId: string;
  remotePath: string;
  status: 'uploaded' | 'error';
  error?: string;
  timestamp: string;
}

export interface SshAgentStatus {
  isRunning: boolean;
  socketPath?: string;
  isManaged: boolean;
  platform: string;
  instructions?: string;
  error?: string;
}

export type SSHS3Api = MultiSSHApi;

declare global {
  interface Window {
    sshs3: MultiSSHApi;
    multissh: MultiSSHApi;
  }
}
