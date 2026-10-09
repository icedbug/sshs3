import type { UpdateState } from '../shared/types/update';
import type { LogLevel } from '../shared/types/log';
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import {
  IPC_CHANNELS,
  type MultiSSHApi,
  type StorageConnectConfig,
  type HostKeyPromptEvent,
  type PresencePromptEvent,
  type PresenceClearEvent,
  type AskpassPromptEvent,
  type SmartcardStartupUnlockStatusEvent,
  type TransferConflictPromptEvent,
  type TransferConflictResolution,
  type QuitConfirmPromptEvent,
  type SshAgentStatus,
  type FileReadResult,
  type ExternalFileStatusEvent,
  type AwsSsoPromptEvent,
  type DirSyncComputeDiffOptions,
  type DirSyncScanProgressEvent,
  type DirSyncApplyOptions,
} from '../shared/types/ipc';
import type {
  K8sClusterNode,
  K8sNamespaceNode,
  K8sPodNode,
  K8sTerminalTarget,
  K8sPodDescription,
  K8sPortForwardTarget,
  K8sActivePortForward,
  K8sDebugTarget,
  K8sLoginOptions,
  K8sLoginResult,
} from '../shared/types/kubernetes';
import type { DirectoryDiffResult, DirectorySyncApplyResult, DirectorySyncProfile } from '../shared/types/dirsync';
import type { AwsSsoAccount, AwsSsoAccountRole, AwsSsoLoginResult } from '../shared/types/aws';
import type {
  DotfileImportedFile,
  DotfilePool,
  DotfilesSyncPromptEvent,
  DotfilesSyncResolution,
  DotfilesSyncStatusEvent,
} from '../shared/types/dotfiles';
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
} from '../shared/types/git';
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
} from '../shared/types/ssh';
import type {
  FileEntry,
  ObjectMetadata,
  TransferProgress,
  S3Config,
  S3Tag,
  BucketVersioningInfo,
  ObjectVersionEntry,
  SpaceInfo,
  VolumeInfo,
} from '../shared/types/storage';
import type { SessionData } from '../shared/types/session';
import type { ClipboardHistoryEntry } from '../shared/types/clipboard';
import type { Snippet } from '../shared/types/snippets';
import type { AppSettings } from '../shared/types/settings';
import type { AiAskRequest, AiAskResult, AiConfigUpdate, AiConfigView } from '../shared/types/ai';
import type { PerfK8sResult, PerfK8sTarget, PerfSshResult } from '../shared/types/perf';
import type { ProfileSyncStatus, ProfileSyncPullResult, SyncComparisonResult } from '../shared/types/sync';
import type {
  SearchDoneEvent,
  SearchErrorEvent,
  SearchPreviewResult,
  SearchProgressEvent,
  SearchResultEvent,
  SearchStartOptions,
  SearchStartResult,
} from '../shared/types/search';

export const api: MultiSSHApi = {
  // Terminal
  terminalCreate: (options: {
    config?: SSHConnectionConfig;
    local?: boolean;
    ptyOptions?: PtyOptions;
  }): Promise<{ sessionId: string }> => ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_CREATE, options),

  terminalWrite: (sessionId: string, data: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_WRITE, sessionId, data),

  terminalResize: (sessionId: string, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_RESIZE, sessionId, cols, rows),

  terminalKill: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_KILL, sessionId),

  terminalReconnect: (sessionId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_RECONNECT, sessionId),

  onTerminalData: (callback: (sessionId: string, data: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, sessionId: string, data: string) =>
      callback(sessionId, data);
    ipcRenderer.on(IPC_CHANNELS.TERMINAL_DATA, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.TERMINAL_DATA, listener);
    };
  },

  onTerminalExit: (callback: (sessionId: string, event: SSHPtyExitEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, sessionId: string, event: SSHPtyExitEvent) =>
      callback(sessionId, event);
    ipcRenderer.on(IPC_CHANNELS.TERMINAL_EXIT, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.TERMINAL_EXIT, listener);
    };
  },

  onTerminalReconnecting: (
    callback: (sessionId: string, event: { attempt: number; maxAttempts: number }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      sessionId: string,
      event: { attempt: number; maxAttempts: number }
    ) => callback(sessionId, event);
    ipcRenderer.on(IPC_CHANNELS.TERMINAL_RECONNECTING, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.TERMINAL_RECONNECTING, listener);
    };
  },

  // Smartcard
  smartcardDetect: (): Promise<DetectedSmartcardLib[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.SMARTCARD_DETECT),

  smartcardValidate: (path: string): Promise<{ valid: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.SMARTCARD_VALIDATE, path),

  smartcardAgentPathStatus: (
    pkcs11LibPath: string
  ): Promise<{ applicable: boolean; needsFix: boolean; libDir?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.SMARTCARD_AGENT_PATH_STATUS, pkcs11LibPath),

  smartcardAgentPathFix: (pkcs11LibPath: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SMARTCARD_AGENT_PATH_FIX, pkcs11LibPath),

  smartcardLockAll: (): Promise<{ locked: number }> => ipcRenderer.invoke(IPC_CHANNELS.SMARTCARD_LOCK_ALL),

  smartcardListCached: (): Promise<CachedSmartcardAgent[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.SMARTCARD_LIST_CACHED),

  smartcardUnlockAtStartup: (): Promise<{ started: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.SMARTCARD_UNLOCK_AT_STARTUP),
  smartcardUnlockNow: (): Promise<{ started: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.SMARTCARD_UNLOCK_NOW),

  onSmartcardStartupUnlockStatus: (
    callback: (event: SmartcardStartupUnlockStatusEvent) => void
  ): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: SmartcardStartupUnlockStatusEvent) =>
      callback(event);
    ipcRenderer.on(IPC_CHANNELS.SMARTCARD_STARTUP_UNLOCK_STATUS, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.SMARTCARD_STARTUP_UNLOCK_STATUS, listener);
    };
  },

  onAskpassPrompt: (callback: (event: AskpassPromptEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: AskpassPromptEvent) => callback(event);
    ipcRenderer.on(IPC_CHANNELS.ASKPASS_PROMPT, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.ASKPASS_PROMPT, listener);
    };
  },

  submitAskpassPin: (id: string, pin: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.ASKPASS_SUBMIT_PIN, id, pin),

  onPresencePrompt: (callback: (event: PresencePromptEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: PresencePromptEvent) => callback(event);
    ipcRenderer.on(IPC_CHANNELS.PRESENCE_PROMPT, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.PRESENCE_PROMPT, listener);
    };
  },

  onPresenceClear: (callback: (event: PresenceClearEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: PresenceClearEvent) => callback(event);
    ipcRenderer.on(IPC_CHANNELS.PRESENCE_CLEAR, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.PRESENCE_CLEAR, listener);
    };
  },

  fido2GenerateKey: (options: GenerateFido2KeyRequest): Promise<GeneratedFido2Key> =>
    ipcRenderer.invoke(IPC_CHANNELS.FIDO2_GENERATE_KEY, options),

  fido2ListResidentKeys: (): Promise<Fido2ResidentKey[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.FIDO2_LIST_RESIDENT_KEYS),

  fido2DeleteResidentKey: (credentialId: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.FIDO2_DELETE_RESIDENT_KEY, credentialId),

  onHostKeyPrompt: (callback: (event: HostKeyPromptEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: HostKeyPromptEvent) => callback(event);
    ipcRenderer.on(IPC_CHANNELS.HOSTKEY_PROMPT, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.HOSTKEY_PROMPT, listener);
    };
  },

  respondHostKeyPrompt: (id: string, trust: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.HOSTKEY_RESPOND, id, trust),

  onTransferConflictPrompt: (callback: (event: TransferConflictPromptEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: TransferConflictPromptEvent) => callback(event);
    ipcRenderer.on(IPC_CHANNELS.TRANSFER_CONFLICT_PROMPT, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.TRANSFER_CONFLICT_PROMPT, listener);
    };
  },

  respondTransferConflict: (id: string, resolution: TransferConflictResolution, applyToAll: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.TRANSFER_CONFLICT_RESPOND, id, resolution, applyToAll),

  onQuitConfirmPrompt: (callback: (event: QuitConfirmPromptEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: QuitConfirmPromptEvent) => callback(event);
    ipcRenderer.on(IPC_CHANNELS.QUIT_CONFIRM_PROMPT, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.QUIT_CONFIRM_PROMPT, listener);
    };
  },

  respondQuitConfirm: (id: string, proceed: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.QUIT_CONFIRM_RESPOND, id, proceed),

  // Storage
  connectStorage: (config: StorageConnectConfig): Promise<{ id: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.STORAGE_CONNECT, config),

  disconnectStorage: (providerId: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.STORAGE_DISCONNECT, providerId),

  storageList: (providerId: string, remotePath: string, force?: boolean): Promise<FileEntry[]> =>
    force !== undefined
      ? ipcRenderer.invoke(IPC_CHANNELS.STORAGE_LIST, providerId, remotePath, force)
      : ipcRenderer.invoke(IPC_CHANNELS.STORAGE_LIST, providerId, remotePath),

  storageStat: (providerId: string, remotePath: string): Promise<FileEntry> =>
    ipcRenderer.invoke(IPC_CHANNELS.STORAGE_STAT, providerId, remotePath),

  storageCreateFolder: (providerId: string, remotePath: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.STORAGE_CREATE_FOLDER, providerId, remotePath),

  storageDelete: (providerId: string, remotePath: string, isDirectory: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.STORAGE_DELETE, providerId, remotePath, isDirectory),

  storageRename: (providerId: string, oldPath: string, newPath: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.STORAGE_RENAME, providerId, oldPath, newPath),

  storageChmod: (providerId: string, remotePath: string, mode: number | string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.STORAGE_CHMOD, providerId, remotePath, mode),

  storageSetMetadata: (providerId: string, remotePath: string, metadata: ObjectMetadata): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.STORAGE_SET_METADATA, providerId, remotePath, metadata),

  storageGetTags: (providerId: string, remotePath: string): Promise<S3Tag[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.STORAGE_GET_TAGS, providerId, remotePath),

  storageSetTags: (providerId: string, remotePath: string, tags: S3Tag[]): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.STORAGE_SET_TAGS, providerId, remotePath, tags),

  storageGetBucketPolicy: (providerId: string, bucketPath: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.STORAGE_GET_BUCKET_POLICY, providerId, bucketPath),

  storageSetBucketPolicy: (providerId: string, bucketPath: string, policy: string | null): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.STORAGE_SET_BUCKET_POLICY, providerId, bucketPath, policy),

  storageGetBucketCors: (providerId: string, bucketPath: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.STORAGE_GET_BUCKET_CORS, providerId, bucketPath),

  storageSetBucketCors: (providerId: string, bucketPath: string, corsJson: string | null): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.STORAGE_SET_BUCKET_CORS, providerId, bucketPath, corsJson),

  storageGetBucketVersioning: (providerId: string, bucketPath: string): Promise<BucketVersioningInfo> =>
    ipcRenderer.invoke(IPC_CHANNELS.STORAGE_GET_BUCKET_VERSIONING, providerId, bucketPath),

  storageSetBucketVersioning: (providerId: string, bucketPath: string, enabled: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.STORAGE_SET_BUCKET_VERSIONING, providerId, bucketPath, enabled),

  storageListObjectVersions: (providerId: string, remotePath: string): Promise<ObjectVersionEntry[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.STORAGE_LIST_OBJECT_VERSIONS, providerId, remotePath),

  storageDeleteObjectVersion: (providerId: string, remotePath: string, versionId: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.STORAGE_DELETE_OBJECT_VERSION, providerId, remotePath, versionId),

  storageRestoreObjectVersion: (providerId: string, remotePath: string, versionId: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.STORAGE_RESTORE_OBJECT_VERSION, providerId, remotePath, versionId),

  storageGetPresignedUrl: (providerId: string, remotePath: string, expiresInSeconds: number): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.STORAGE_GET_PRESIGNED_URL, providerId, remotePath, expiresInSeconds),

  storageGetHomeDir: (providerId: string): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.STORAGE_GET_HOMEDIR, providerId),

  storageGetSpace: (providerId: string, remotePath: string): Promise<SpaceInfo | undefined> =>
    ipcRenderer.invoke(IPC_CHANNELS.STORAGE_GET_SPACE, providerId, remotePath),

  storageListVolumes: (providerId: string): Promise<VolumeInfo[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.STORAGE_LIST_VOLUMES, providerId),

  // Transfer
  transferAdd: (options: {
    sourceProviderId: string;
    sourcePath: string;
    targetProviderId: string;
    targetPath: string;
    conflictPolicy?: TransferConflictResolution;
  }): Promise<{ jobId: string | null; skipped?: boolean; resolvedPolicy?: TransferConflictResolution; appliedToAll?: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.TRANSFER_ADD, options),

  transferPause: (jobId: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.TRANSFER_PAUSE, jobId),

  transferResume: (jobId: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.TRANSFER_RESUME, jobId),

  transferCancel: (jobId: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.TRANSFER_CANCEL, jobId),

  transferGetJobs: (): Promise<TransferProgress[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.TRANSFER_GET_JOBS),

  transferClearCompleted: (): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.TRANSFER_CLEAR_COMPLETED),

  onTransferProgress: (callback: (progress: TransferProgress) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: TransferProgress) =>
      callback(progress);
    ipcRenderer.on(IPC_CHANNELS.TRANSFER_PROGRESS, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.TRANSFER_PROGRESS, listener);
    };
  },

  getPathForFile: (file: File): string => {
    try {
      return webUtils?.getPathForFile ? webUtils.getPathForFile(file) : (file as any)?.path || '';
    } catch {
      return (file as any)?.path || '';
    }
  },

  // Profiles
  profilesGet: (): Promise<{ ssh: SSHConnectionConfig[]; s3: S3Config[]; folders?: string[] }> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROFILES_GET),

  profilesSaveSSH: (config: SSHConnectionConfig): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROFILES_SAVE_SSH, config),

  profilesDeleteSSH: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROFILES_DELETE_SSH, id),

  profilesSaveS3: (config: S3Config): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROFILES_SAVE_S3, config),

  profilesDeleteS3: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROFILES_DELETE_S3, id),

  profilesSaveFolder: (name: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROFILES_SAVE_FOLDER, name),

  profilesDeleteFolder: (name: string, deleteProfiles?: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROFILES_DELETE_FOLDER, name, deleteProfiles),

  profilesRenameFolder: (oldName: string, newName: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROFILES_RENAME_FOLDER, oldName, newName),

  // No filePath argument (H4, code review): these three used to accept an
  // optional caller-supplied path that went straight to fs.readFile/
  // writeFile in the main process, bypassing the save/open dialog entirely.
  // The real UI never passed one — only a compromised renderer could — so
  // the parameter is removed from this exposed surface rather than merely
  // left "optional but trusted"; the main process always resolves the path
  // itself (a fixed default for SSH config, an electronDialog prompt for
  // JSON export/import).
  profilesImportSshConfig: (): Promise<{ profiles: SSHConnectionConfig[]; filePath: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROFILES_IMPORT_SSH_CONFIG),

  profilesExportJson: (): Promise<{ count: number; filePath: string } | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROFILES_EXPORT_JSON),

  profilesImportJson: (): Promise<{ count: number }> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROFILES_IMPORT_JSON),

  // Session
  sessionGet: (): Promise<SessionData | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.SESSION_GET),

  sessionSave: (data: SessionData): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SESSION_SAVE, data),

  // Clipboard history
  clipboardHistoryList: (hostKey?: string): Promise<ClipboardHistoryEntry[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.CLIPBOARD_HISTORY_LIST, hostKey),

  clipboardHistoryAdd: (text: string, hostKey: string, hostLabel: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.CLIPBOARD_HISTORY_ADD, text, hostKey, hostLabel),

  clipboardHistoryDelete: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.CLIPBOARD_HISTORY_DELETE, id),

  clipboardHistoryClear: (): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.CLIPBOARD_HISTORY_CLEAR),

  // Terminal snippets
  snippetsList: (hostKey?: string): Promise<Snippet[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.SNIPPETS_LIST, hostKey),

  snippetsSave: (snippet: Omit<Snippet, 'id'> & { id?: string }): Promise<Snippet> =>
    ipcRenderer.invoke(IPC_CHANNELS.SNIPPETS_SAVE, snippet),

  snippetsDelete: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SNIPPETS_DELETE, id),

  // Settings
  settingsGet: (): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET),

  settingsSave: (settings: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SAVE, settings),

  // AI assistant
  aiGetConfig: (): Promise<AiConfigView> =>
    ipcRenderer.invoke(IPC_CHANNELS.AI_GET_CONFIG),

  aiSaveConfig: (update: AiConfigUpdate): Promise<AiConfigView> =>
    ipcRenderer.invoke(IPC_CHANNELS.AI_SAVE_CONFIG, update),

  aiAsk: (request: AiAskRequest): Promise<AiAskResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.AI_ASK, request),

  // Remote profile sync
  profileSyncSetup: (payload: { target: StorageConnectConfig; remoteBasePath?: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROFILE_SYNC_SETUP, payload),

  profileSyncEnable: (passwords: {
    topologyPassword: string;
    credentialsPassword: string;
  }): Promise<ProfileSyncStatus> => ipcRenderer.invoke(IPC_CHANNELS.PROFILE_SYNC_ENABLE, passwords),

  profileSyncPush: (): Promise<ProfileSyncStatus> => ipcRenderer.invoke(IPC_CHANNELS.PROFILE_SYNC_PUSH),

  profileSyncPull: (passwords?: {
    topologyPassword?: string;
    credentialsPassword?: string;
  }): Promise<ProfileSyncPullResult & ProfileSyncStatus> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROFILE_SYNC_PULL, passwords),

  profileSyncStatus: (): Promise<ProfileSyncStatus> => ipcRenderer.invoke(IPC_CHANNELS.PROFILE_SYNC_STATUS),
  profileSyncCompare: (): Promise<SyncComparisonResult> => ipcRenderer.invoke(IPC_CHANNELS.PROFILE_SYNC_COMPARE),
  profileSyncSetAutoSync: (enabled: boolean): Promise<ProfileSyncStatus> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROFILE_SYNC_SET_AUTO_SYNC, enabled),
  profileSyncUnlockSmartcard: (options?: { pkcs11LibPath?: string; pin?: string }): Promise<ProfileSyncStatus> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROFILE_SYNC_UNLOCK_SMARTCARD, options),
  profileSyncLinkSmartcard: (options: {
    pkcs11LibPath: string;
    pin?: string;
    passwords?: { topologyPassword: string; credentialsPassword: string };
  }): Promise<ProfileSyncStatus> => ipcRenderer.invoke(IPC_CHANNELS.PROFILE_SYNC_LINK_SMARTCARD, options),
  profileSyncUnlinkSmartcard: (): Promise<ProfileSyncStatus> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROFILE_SYNC_UNLINK_SMARTCARD),
  profileSyncWipe: (): Promise<ProfileSyncStatus & { remoteWipeErrors: string[] }> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROFILE_SYNC_WIPE),
  onProfileSyncStatus: (callback: (status: ProfileSyncStatus) => void): (() => void) => {
    const subscription = (_event: any, status: ProfileSyncStatus) => callback(status);
    ipcRenderer.on(IPC_CHANNELS.PROFILE_SYNC_STATUS, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PROFILE_SYNC_STATUS, subscription);
  },

  // Connection Testing
  testSSHConnection: (config: SSHConnectionConfig): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONNECTION_TEST_SSH, config),

  // Install public keys in a host's authorized_keys (ssh-copy-id)
  listPublicKeys: (request: ListPublicKeysRequest): Promise<LocalPublicKey[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.SSH_LIST_PUBLIC_KEYS, request),

  installPublicKeys: (request: InstallPublicKeysRequest): Promise<InstallPublicKeysResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.SSH_INSTALL_PUBLIC_KEYS, request),

  buildInstallCommand: (publicKeys: string[]): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.SSH_BUILD_INSTALL_COMMAND, publicKeys),

  sshProbeHost: (config: SSHConnectionConfig): Promise<ProbeHostResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.SSH_PROBE_HOST, config),

  sshTestLogin: (config: SSHConnectionConfig): Promise<TestLoginResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.SSH_TEST_LOGIN, config),

  testS3Connection: (config: S3Config): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONNECTION_TEST_S3, config),

  // AWS SSO login (device-authorization flow)
  awsSsoLogin: (startUrl: string, region: string): Promise<AwsSsoLoginResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.AWS_SSO_LOGIN, startUrl, region),

  awsSsoCancelLogin: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.AWS_SSO_LOGIN_CANCEL, id),

  onAwsSsoPrompt: (callback: (event: AwsSsoPromptEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: AwsSsoPromptEvent) => callback(event);
    ipcRenderer.on(IPC_CHANNELS.AWS_SSO_PROMPT, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.AWS_SSO_PROMPT, listener);
    };
  },

  awsSsoListAccounts: (accessToken: string, region: string): Promise<AwsSsoAccount[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.AWS_SSO_LIST_ACCOUNTS, accessToken, region),

  awsSsoListRoles: (accessToken: string, region: string, accountId: string): Promise<AwsSsoAccountRole[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.AWS_SSO_LIST_ROLES, accessToken, region, accountId),

  // SSH Agent
  getSshAgentStatus: (): Promise<SshAgentStatus> =>
    ipcRenderer.invoke(IPC_CHANNELS.SSH_AGENT_STATUS),

  // Git & Git Provider Integration
  gitFetchPublicKeys: (request: FetchGitKeysRequest): Promise<FetchGitKeysResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_FETCH_PUBLIC_KEYS, request),

  gitGetSigningConfig: (): Promise<GitSigningConfig> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_GET_SIGNING_CONFIG),

  gitConfigureSigning: (request: ConfigureGitSigningRequest): Promise<ConfigureGitSigningResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_CONFIGURE_SIGNING, request),

  gitSetSigningEnabled: (enabled: boolean): Promise<ConfigureGitSigningResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_SET_SIGNING_ENABLED, enabled),

  gitGetStatus: (directoryPath: string, providerId?: string): Promise<GitRepoStatus> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_GET_STATUS, directoryPath, providerId),

  gitClone: (request: GitCloneRequest): Promise<GitOperationResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_CLONE, request),

  gitPull: (directoryPath: string, providerId?: string): Promise<GitOperationResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_PULL, directoryPath, providerId),

  gitTestRemoteAccess: (request: TestRemoteGitAccessRequest): Promise<TestRemoteGitAccessResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_TEST_REMOTE_ACCESS, request),

  dotfilesImportFromGit: (request: DotfilesImportFromGitRequest): Promise<DotfilesImportFromGitResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.DOTFILES_IMPORT_FROM_GIT, request),

  // Dotfiles pools
  dotfilePoolsGet: (): Promise<DotfilePool[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.DOTFILES_POOLS_GET),

  dotfilePoolsSave: (pool: DotfilePool): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.DOTFILES_POOLS_SAVE, pool),

  dotfilePoolsDelete: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.DOTFILES_POOLS_DELETE, id),

  dotfilePoolOpenFolder: (poolId: string): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.DOTFILES_OPEN_FOLDER, poolId),

  dotfilePoolSelectFiles: (): Promise<DotfileImportedFile[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.DOTFILES_SELECT_FILES),

  dotfilePoolReadSources: (paths: string[]): Promise<DotfileImportedFile[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.DOTFILES_READ_SOURCES, paths),

  dotfilePoolAddFromStorage: (options: {
    poolId: string;
    providerId: string;
    filePath: string;
    targetRemotePath?: string;
  }): Promise<DotfilePool> =>
    ipcRenderer.invoke(IPC_CHANNELS.DOTFILES_ADD_FROM_STORAGE, options),

  onDotfilesSyncPrompt: (callback: (event: DotfilesSyncPromptEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: DotfilesSyncPromptEvent) => callback(event);
    ipcRenderer.on(IPC_CHANNELS.DOTFILES_SYNC_PROMPT, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.DOTFILES_SYNC_PROMPT, listener);
    };
  },

  respondDotfilesSyncPrompt: (id: string, resolution: DotfilesSyncResolution): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.DOTFILES_SYNC_RESPOND, id, resolution),

  onDotfilesSyncStatus: (callback: (event: DotfilesSyncStatusEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: DotfilesSyncStatusEvent) => callback(event);
    ipcRenderer.on(IPC_CHANNELS.DOTFILES_SYNC_STATUS, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.DOTFILES_SYNC_STATUS, listener);
    };
  },

  // File Editor
  fileRead: (providerId: string, remotePath: string, maxBytes?: number): Promise<FileReadResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_READ, providerId, remotePath, maxBytes),

  fileSave: (providerId: string, remotePath: string, content: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_SAVE, providerId, remotePath, content),

  fileOpenExternal: (
    providerId: string,
    remotePath: string
  ): Promise<{ sessionToken: string; localPath: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_OPEN_EXTERNAL, providerId, remotePath),

  fileCloseExternal: (sessionToken: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_CLOSE_EXTERNAL, sessionToken),

  onExternalFileStatus: (callback: (event: ExternalFileStatusEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: ExternalFileStatusEvent) =>
      callback(event);
    ipcRenderer.on(IPC_CHANNELS.FILE_EXTERNAL_STATUS, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.FILE_EXTERNAL_STATUS, listener);
    };
  },

  fileTailStart: (
    providerId: string,
    remotePath: string
  ): Promise<{ tailId: string; initialContent: string; size: number }> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_TAIL_START, providerId, remotePath),

  fileTailStop: (tailId: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_TAIL_STOP, tailId),

  onFileTailData: (
    callback: (event: { tailId: string; chunk: string }) => void
  ): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: { tailId: string; chunk: string }) =>
      callback(event);
    ipcRenderer.on(IPC_CHANNELS.FILE_TAIL_DATA, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.FILE_TAIL_DATA, listener);
    };
  },

  onFileTailError: (
    callback: (event: { tailId: string; error: string }) => void
  ): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: { tailId: string; error: string }) =>
      callback(event);
    ipcRenderer.on(IPC_CHANNELS.FILE_TAIL_ERROR, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.FILE_TAIL_ERROR, listener);
    };
  },

  // Content search ("search inside files")
  searchStart: (options: SearchStartOptions): Promise<SearchStartResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.SEARCH_START, options),

  searchCancel: (searchId: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SEARCH_CANCEL, searchId),

  searchPreview: (
    providerId: string,
    remotePath: string,
    lineNumber: number,
    contextLines: number
  ): Promise<SearchPreviewResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.SEARCH_PREVIEW, providerId, remotePath, lineNumber, contextLines),

  onSearchResult: (callback: (event: SearchResultEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: SearchResultEvent) => callback(event);
    ipcRenderer.on(IPC_CHANNELS.SEARCH_RESULT, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.SEARCH_RESULT, listener);
    };
  },

  onSearchProgress: (callback: (event: SearchProgressEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: SearchProgressEvent) => callback(event);
    ipcRenderer.on(IPC_CHANNELS.SEARCH_PROGRESS, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.SEARCH_PROGRESS, listener);
    };
  },

  onSearchError: (callback: (event: SearchErrorEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: SearchErrorEvent) => callback(event);
    ipcRenderer.on(IPC_CHANNELS.SEARCH_ERROR, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.SEARCH_ERROR, listener);
    };
  },

  onSearchDone: (callback: (event: SearchDoneEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: SearchDoneEvent) => callback(event);
    ipcRenderer.on(IPC_CHANNELS.SEARCH_DONE, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.SEARCH_DONE, listener);
    };
  },

  // Kubernetes / OpenShift discovery
  k8sListContexts: (): Promise<K8sClusterNode[]> => ipcRenderer.invoke(IPC_CHANNELS.K8S_LIST_CONTEXTS),

  k8sListNamespaces: (contextName: string): Promise<K8sNamespaceNode[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.K8S_LIST_NAMESPACES, contextName),

  k8sListPods: (contextName: string, namespace: string): Promise<K8sPodNode[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.K8S_LIST_PODS, contextName, namespace),

  k8sReload: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.K8S_RELOAD),

  k8sLogin: (options: K8sLoginOptions): Promise<K8sLoginResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.K8S_LOGIN, options),

  onK8sConfigChanged: (callback: (execAuthWarning?: string | null) => void): (() => void) => {
    const listener = (_event: unknown, execAuthWarning?: string | null) => callback(execAuthWarning);
    ipcRenderer.on(IPC_CHANNELS.K8S_CONFIG_CHANGED, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.K8S_CONFIG_CHANGED, listener);
    };
  },

  k8sTerminalCreate: (
    target: K8sTerminalTarget,
    options?: { cols?: number; rows?: number }
  ): Promise<{ sessionId: string }> => ipcRenderer.invoke(IPC_CHANNELS.K8S_TERMINAL_CREATE, target, options),

  k8sTerminalWrite: (sessionId: string, data: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.K8S_TERMINAL_WRITE, sessionId, data),

  k8sTerminalResize: (sessionId: string, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.K8S_TERMINAL_RESIZE, sessionId, cols, rows),

  k8sTerminalKill: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.K8S_TERMINAL_KILL, sessionId),

  perfSshSample: (sessionId: string): Promise<PerfSshResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.PERF_SSH_SAMPLE, sessionId),

  perfK8sSample: (target: PerfK8sTarget): Promise<PerfK8sResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.PERF_K8S_SAMPLE, target),

  perfLocalSample: (): Promise<PerfSshResult> => ipcRenderer.invoke(IPC_CHANNELS.PERF_LOCAL_SAMPLE),

  onK8sTerminalData: (callback: (sessionId: string, data: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, sessionId: string, data: string) =>
      callback(sessionId, data);
    ipcRenderer.on(IPC_CHANNELS.K8S_TERMINAL_DATA, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.K8S_TERMINAL_DATA, listener);
    };
  },

  onK8sTerminalExit: (callback: (sessionId: string, event: { status: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, sessionId: string, event: { status: string }) =>
      callback(sessionId, event);
    ipcRenderer.on(IPC_CHANNELS.K8S_TERMINAL_EXIT, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.K8S_TERMINAL_EXIT, listener);
    };
  },

  k8sLogStart: (
    target: K8sTerminalTarget,
    options?: { tailLines?: number; timestamps?: boolean; previous?: boolean }
  ): Promise<{ sessionId: string }> => ipcRenderer.invoke(IPC_CHANNELS.K8S_LOG_START, target, options),

  k8sLogStop: (sessionId: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.K8S_LOG_STOP, sessionId),

  onK8sLogData: (callback: (sessionId: string, data: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, sessionId: string, data: string) => callback(sessionId, data);
    ipcRenderer.on(IPC_CHANNELS.K8S_LOG_DATA, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.K8S_LOG_DATA, listener);
    };
  },

  onK8sLogEnd: (callback: (sessionId: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, sessionId: string) => callback(sessionId);
    ipcRenderer.on(IPC_CHANNELS.K8S_LOG_END, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.K8S_LOG_END, listener);
    };
  },

  k8sDescribePod: (
    contextName: string,
    namespace: string,
    podName: string
  ): Promise<K8sPodDescription> =>
    ipcRenderer.invoke(IPC_CHANNELS.K8S_POD_DESCRIBE, contextName, namespace, podName),

  k8sStartPortForward: (target: K8sPortForwardTarget): Promise<K8sActivePortForward> =>
    ipcRenderer.invoke(IPC_CHANNELS.K8S_PORT_FORWARD_START, target),

  k8sStopPortForward: (id: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.K8S_PORT_FORWARD_STOP, id),

  k8sListPortForwards: (): Promise<K8sActivePortForward[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.K8S_PORT_FORWARD_LIST),

  onK8sPortForwardEvent: (
    callback: (activeForwards: K8sActivePortForward[]) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      activeForwards: K8sActivePortForward[]
    ) => callback(activeForwards);
    ipcRenderer.on(IPC_CHANNELS.K8S_PORT_FORWARD_EVENT, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.K8S_PORT_FORWARD_EVENT, listener);
    };
  },

  k8sAttachDebugContainer: (target: K8sDebugTarget): Promise<{ containerName: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.K8S_DEBUG_ATTACH, target),

  sshTunnelStart: (config: SSHConnectionConfig, tunnel: SSHTunnelConfig): Promise<SSHActiveTunnel> =>
    ipcRenderer.invoke(IPC_CHANNELS.SSH_TUNNEL_START, config, tunnel),

  sshTunnelStop: (id: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.SSH_TUNNEL_STOP, id),

  sshTunnelList: (): Promise<SSHActiveTunnel[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.SSH_TUNNEL_LIST),

  onSshTunnelEvent: (callback: (active: SSHActiveTunnel[]) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, active: SSHActiveTunnel[]) =>
      callback(active);
    ipcRenderer.on(IPC_CHANNELS.SSH_TUNNEL_EVENT, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.SSH_TUNNEL_EVENT, listener);
    };
  },

  sshTunnelCheckPort: (port: number): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.SSH_TUNNEL_CHECK_PORT, port),

  // Window / General
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.APP_OPEN_EXTERNAL, url),

  getVersion: (): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.APP_GET_VERSION),

  getUpdateState: (): Promise<UpdateState> => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_GET_STATE),

  checkForUpdates: (): Promise<UpdateState> => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_CHECK),

  downloadUpdate: (): Promise<UpdateState> => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_DOWNLOAD),

  installUpdate: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_INSTALL),

  writeLog: (level: LogLevel, scope: string, message: string, ctx?: unknown): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.LOG_WRITE, level, scope, message, ctx),

  openLogFolder: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.LOG_OPEN_FOLDER),

  getDiagnostics: (): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.LOG_GET_DIAGNOSTICS),

  onUpdateState: (callback: (state: UpdateState) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: UpdateState) => callback(state);
    ipcRenderer.on(IPC_CHANNELS.UPDATE_STATE, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.UPDATE_STATE, listener);
    };
  },

  getHomeDir: (): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.APP_GET_HOMEDIR),

  getPlatform: (): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.APP_GET_PLATFORM),

  getHostname: (): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.APP_GET_HOSTNAME),

  getSecurityStatus: (): Promise<{ credentialEncryptionAvailable: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.APP_GET_SECURITY_STATUS),

  detectLocalShells: (): Promise<{ pwsh: boolean; wsl: boolean; wslDistros: string[] }> =>
    ipcRenderer.invoke(IPC_CHANNELS.APP_DETECT_LOCAL_SHELLS),

  checkX11Server: (display?: string): Promise<{ running: boolean; display: string; platform?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.APP_CHECK_X11_SERVER, display),

  x11GetStatus: (customPath?: string, display?: string): Promise<XServerStatus> =>
    ipcRenderer.invoke(IPC_CHANNELS.X11_GET_STATUS, customPath, display),

  x11StartServer: (options?: { customPath?: string; customArgs?: string; display?: string }): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.X11_START_SERVER, options),

  x11StopServer: (): Promise<{ success: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.X11_STOP_SERVER),

  dialogOpenFile: (options?: { title?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.DIALOG_OPEN_FILE, options),

  dialogSaveFile: (options?: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SAVE_FILE, options),

  dialogOpenFolder: (options?: { title?: string }): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.DIALOG_OPEN_FOLDER, options),

  // Directory sync
  dirSyncComputeDiff: (options: DirSyncComputeDiffOptions): Promise<DirectoryDiffResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.DIR_SYNC_COMPUTE_DIFF, options),

  onDirSyncScanProgress: (callback: (event: DirSyncScanProgressEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: DirSyncScanProgressEvent) => callback(event);
    ipcRenderer.on(IPC_CHANNELS.DIR_SYNC_SCAN_PROGRESS, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.DIR_SYNC_SCAN_PROGRESS, listener);
    };
  },

  dirSyncApply: (options: DirSyncApplyOptions): Promise<DirectorySyncApplyResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.DIR_SYNC_APPLY, options),

  onDirSyncApplyProgress: (callback: (progress: TransferProgress) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: TransferProgress) => callback(progress);
    ipcRenderer.on(IPC_CHANNELS.DIR_SYNC_APPLY_PROGRESS, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.DIR_SYNC_APPLY_PROGRESS, listener);
    };
  },

  dirSyncProfileList: (): Promise<DirectorySyncProfile[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.DIR_SYNC_PROFILE_LIST),

  dirSyncProfileSave: (profile: DirectorySyncProfile): Promise<DirectorySyncProfile> =>
    ipcRenderer.invoke(IPC_CHANNELS.DIR_SYNC_PROFILE_SAVE, profile),

  dirSyncProfileDelete: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.DIR_SYNC_PROFILE_DELETE, id),
};

export function exposePreloadApi(): void {
  try {
    contextBridge.exposeInMainWorld('sshs3', api);
    contextBridge.exposeInMainWorld('multissh', api);
  } catch {
    // Safely ignore when run outside electron preload environment
  }
}

exposePreloadApi();
