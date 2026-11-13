export type StorageType = 'local' | 'sftp' | 's3' | 'k8s';

export interface FileEntry {
  name: string;
  path: string;
  size: number;
  isDirectory: boolean;
  /** True for non-regular files (FIFOs, devices, sockets) that must not be read to completion. */
  isSpecial?: boolean;
  /**
   * True when this entry is a symbolic link (reported via lstat-like
   * semantics, not resolved through to the link's target). Populated by
   * LocalStorageProvider and SFTPStorageProvider; storage types without a
   * real symlink concept (S3, K8s pod exec) leave it undefined. Transfer's
   * directory scan skips any entry with this set — see TransferPipeline's
   * scanDirectory: a link to a regular file is copied as that file; links to
   * folders are never followed (no escaping the source tree, no cycles) and are
   * counted as skipped (see the H6 code-review finding).
   */
  isSymlink?: boolean;
  mtime?: string; // ISO 8601 string yyyy-mm-dd HH:mm or ISO
  mtimeMs?: number; // epoch ms, UTC — precise value for diffing, unlike the display-rounded `mtime` above
  mimeType?: string;
  permissions?: string;
  etag?: string;
}

export interface TransferProgress {
  jobId: string;
  fileName: string;
  transferredBytes: number;
  totalBytes: number;
  percentage: number;
  bytesPerSecond: number;
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  error?: string;
  statusMessage?: string;
}

export interface WriteStreamOptions {
  size?: number;
  mode?: number;
  /** Fail instead of replacing something already at the path (local disk only; other providers ignore it). */
  exclusive?: boolean;
}

export interface ObjectMetadata {
  contentType?: string;
}

export interface S3Tag {
  key: string;
  value: string;
}

export type S3VersioningStatus = 'Enabled' | 'Suspended' | 'Disabled';

export interface BucketVersioningInfo {
  status: S3VersioningStatus;
}

export interface ObjectVersionEntry {
  versionId: string;
  isLatest: boolean;
  isDeleteMarker: boolean;
  size: number;
  lastModified?: string;
}

export interface IStorageProvider {
  readonly id: string;
  readonly name: string;
  readonly type: StorageType;
  list(remotePath: string, options?: { force?: boolean }): Promise<FileEntry[]>;
  stat(remotePath: string): Promise<FileEntry>;
  createFolder(remotePath: string): Promise<void>;
  delete(remotePath: string, isDirectory: boolean): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  createReadStream(remotePath: string, start?: number, end?: number): Promise<NodeJS.ReadableStream>;
  createWriteStream(remotePath: string, options?: WriteStreamOptions): Promise<NodeJS.WritableStream>;
  writeFile?(remotePath: string, data: Buffer | Uint8Array, options?: WriteStreamOptions): Promise<void>;
  readFile?(remotePath: string): Promise<Buffer>;
  chmod?(remotePath: string, mode: number | string): Promise<void>;
  /** Windows file attributes (local provider on Windows only). */
  getWinAttributes?(remotePath: string): Promise<WinAttributes>;
  /** Sets the given attributes (others untouched); `recursive` also covers a folder's contents. */
  setWinAttributes?(remotePath: string, changes: Partial<WinAttributes>, recursive?: boolean): Promise<void>;
  setMetadata?(remotePath: string, metadata: ObjectMetadata): Promise<void>;
  /**
   * Sets a file's modification time (epoch ms) after it's written, so a copy
   * preserves the source's mtime instead of taking the write time. Not
   * supported by all providers (e.g. S3's LastModified is server-controlled).
   */
  setModifiedTime?(remotePath: string, mtimeMs: number): Promise<void>;
  /**
   * Computes or retrieves a cryptographic checksum (e.g. 'sha256' or 'md5') for a file.
   * Returns hex string or undefined if not supported by the provider.
   */
  getChecksum?(remotePath: string, algorithm?: 'sha256' | 'md5'): Promise<string | undefined>;
  getHomeDir?(): Promise<string>;
  /** Free/total space of the filesystem holding `remotePath` (like `df <path>`). Undefined when unsupported. */
  getSpace?(remotePath: string): Promise<SpaceInfo | undefined>;
  /** Mounted volumes / drives with their fill level (local provider only). */
  listVolumes?(): Promise<VolumeInfo[]>;
  disconnect?(): Promise<void>;
  // S3-specific administration (buckets & objects)
  getTags?(remotePath: string): Promise<S3Tag[]>;
  setTags?(remotePath: string, tags: S3Tag[]): Promise<void>;
  getBucketPolicy?(bucketPath: string): Promise<string | null>;
  setBucketPolicy?(bucketPath: string, policy: string | null): Promise<void>;
  getBucketCors?(bucketPath: string): Promise<string | null>;
  setBucketCors?(bucketPath: string, corsJson: string | null): Promise<void>;
  getBucketVersioning?(bucketPath: string): Promise<BucketVersioningInfo>;
  setBucketVersioning?(bucketPath: string, enabled: boolean): Promise<void>;
  listObjectVersions?(remotePath: string): Promise<ObjectVersionEntry[]>;
  deleteObjectVersion?(remotePath: string, versionId: string): Promise<void>;
  restoreObjectVersion?(remotePath: string, versionId: string): Promise<void>;
  getPresignedUrl?(remotePath: string, expiresInSeconds: number): Promise<string>;
}

export interface SpaceInfo {
  totalBytes: number;
  freeBytes: number;
}

/** The Windows file attributes the file manager can show and change (the `attrib` flags R, H, S, A). */
export interface WinAttributes {
  readOnly: boolean;
  hidden: boolean;
  system: boolean;
  archive: boolean;
}

export interface VolumeInfo extends SpaceInfo {
  /** Root to navigate to: "C:\" on Windows, the mount point elsewhere. */
  path: string;
  label: string;
}

// SFTP runs over the system OpenSSH client (`ssh -s sftp`), so all auth types — including 'fido2'
// (libfido2 / resident keys via a private ssh-agent) — are handled by OpenSSH itself.
export type SFTPAuthType = 'password' | 'privateKey' | 'smartcard' | 'agent' | 'fido2';

export type ProxyType = 'http' | 'socks5' | 'socks4';

export interface ProxyConfig {
  enabled?: boolean;
  type: ProxyType;
  host: string;
  port: number;
  username?: string;
  password?: string;
  /** Team Vault only — see `SSHConnectionConfig.hasPassword`. */
  hasPassword?: boolean;
}

export interface SFTPConfig {
  id?: string;
  name?: string;
  host: string;
  port: number;
  username: string;
  authType: SFTPAuthType;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  /** Team Vault only — see `SSHConnectionConfig.teamVaultProfileRef`. */
  teamVaultProfileRef?: { vaultId: string; profileId: string };
  agentPath?: string;
  /** Whether to use the active SSH Certificate Authority session when authType is 'agent'. */
  useSshCa?: boolean;
  /** Runtime only: path to an OpenSSH certificate file (`-o CertificateFile=...`). */
  certificateFile?: string;
  /** Runtime only: public key files selecting this connection's keys in a shared agent — see SSHConnectionConfig.agentIdentityFiles. */
  agentIdentityFiles?: string[];
  pkcs11LibPath?: string;
  pin?: string;
  /** authType 'fido2' only — see SSHConnectionConfig.fido2Resident. */
  fido2Resident?: boolean;
  initialPath?: string;
  proxy?: ProxyConfig;
  proxyJumpProfileId?: string;
  proxyJump?: string;
  group?: string;
  lastUsedAt?: string;
  compression?: boolean;
  serverAliveInterval?: number;
  ciphers?: string;
  kexAlgorithms?: string;
  macs?: string;
  forwardAgent?: boolean;
}

export type S3AuthMode = 'static' | 'sso';

export interface S3SsoConfig {
  startUrl: string;
  region: string;
  accountId?: string;
  roleName?: string;
}

export type S3ServerSideEncryption = 'none' | 'AES256' | 'aws:kms';

export interface S3Config {
  id: string;
  name: string;
  endpoint?: string;
  region: string;
  /** Defaults to 'static' (the accessKeyId/secretAccessKey fields below) when unset. */
  authMode?: S3AuthMode;
  accessKeyId: string;
  secretAccessKey: string;
  /** Team Vault only, set by the main process on read: true when a secret key is stored but was
   * stripped before reaching the renderer (member role — see TeamVaultService.getPayloadForRenderer).
   * Never persisted as part of the profile itself. */
  hasSecretAccessKey?: boolean;
  sessionToken?: string;
  /** Team Vault only — see `SSHConnectionConfig.teamVaultProfileRef`. */
  teamVaultProfileRef?: { vaultId: string; profileId: string };
  sso?: S3SsoConfig;
  serverSideEncryption?: S3ServerSideEncryption;
  kmsKeyId?: string;
  forcePathStyle?: boolean;
  ssl?: boolean;
  rejectUnauthorized?: boolean;
  customCaPath?: string;
  initialPath?: string;
  proxy?: ProxyConfig;
  group?: string;
  /** Free-form labels for searching and filtering; cleaned by `normalizeTags` (shared/tags.ts) on every save. */
  tags?: string[];
  lastUsedAt?: string;
  /** ISO 8601 timestamp of the last edit. Used by remote profile sync to resolve conflicts. */
  updatedAt?: string;
  /** ISO 8601 timestamp set instead of removing the entry outright, so sync can propagate the deletion. */
  deletedAt?: string;
}
