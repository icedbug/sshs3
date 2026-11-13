import type { LocalPublicKey, SSHConnectionConfig } from './ssh';

export type GitKeyProvider = 'github' | 'gitlab' | 'custom';

export interface FetchGitKeysRequest {
  provider: GitKeyProvider;
  username: string;
  customHost?: string;
}

export interface FetchGitKeysResult {
  success: boolean;
  keys: LocalPublicKey[];
  error?: string;
}

export interface GitSigningConfig {
  enabled: boolean;
  format?: string;
  signingKey?: string;
  allowedSignersFile?: string;
  email?: string;
}

export interface ConfigureGitSigningRequest {
  signingKey: string;
  email?: string;
  global?: boolean;
}

export interface ConfigureGitSigningResult {
  success: boolean;
  allowedSignersUpdated?: boolean;
  error?: string;
}

export interface GitRepoStatus {
  isRepo: boolean;
  branch?: string;
  isClean?: boolean;
  ahead?: number;
  behind?: number;
  untrackedCount?: number;
  modifiedCount?: number;
  rootPath?: string;
  remoteOriginUrl?: string;
}

export interface GitCloneRequest {
  url: string;
  targetDirectory: string;
  directoryName?: string;
  depth?: number;
  /** If set and not 'local': runs over SFTP/SSH */
  providerId?: string;
  sftpConfig?: SSHConnectionConfig;
}

export interface GitOperationResult {
  success: boolean;
  output?: string;
  error?: string;
}

export interface TestRemoteGitAccessRequest {
  config: SSHConnectionConfig;
  provider?: 'github' | 'gitlab';
}

export interface TestRemoteGitAccessResult {
  success: boolean;
  authenticatedUser?: string;
  rawOutput: string;
  error?: string;
}

export interface DotfilesImportFromGitRequest {
  urlOrRepo: string;
  poolName?: string;
}

export interface DotfilesImportFromGitResult {
  success: boolean;
  poolId?: string;
  importedFilesCount?: number;
  error?: string;
}
