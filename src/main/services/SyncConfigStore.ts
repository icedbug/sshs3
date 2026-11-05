import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { app } from 'electron';
import type { StorageConnectConfig } from '../../shared/types/ipc';
import type { SFTPConfig, S3Config } from '../../shared/types/storage';
import { encryptSecretValue, decryptSecretValue, isEncryptedSecret, transformEntrySecrets } from '../crypto/SecretFieldCrypto';
import { backupCorruptFile, writeFileAtomic } from '../storage/atomicFile';

const SFTP_SECRET_FIELDS: Array<keyof SFTPConfig> = ['password', 'passphrase'];
const S3_SECRET_FIELDS: Array<keyof S3Config> = ['secretAccessKey', 'sessionToken'];

export interface SyncConfigData {
  /** Where sync files are read from / written to. Never the data being synced itself. */
  target?: StorageConnectConfig;
  /**
   * Directory (SFTP) or `bucket[/prefix]` (S3 — a "remotePath" is always
   * `bucket/key...`, S3Config itself carries no bucket) under which the
   * `.sshs3` sync folder is created. Empty means the connection's own
   * default/home directory.
   */
  remoteBasePath?: string;
  /** Base64-encoded. Not secret — only the two master passwords are — but never sent anywhere except embedded in the encrypted sync files themselves. */
  topologySaltBase64?: string;
  credentialsSaltBase64?: string;
  lastSyncAt?: string;
  /** Whether automatic background push is enabled on profile/dotfile/settings changes. */
  autoSync?: boolean;
  /** Optional hardware smartcard configuration for unlocking sync via PKCS#11 PIN. */
  smartcardSync?: {
    pkcs11LibPath: string;
    keyComment?: string;
    keyBlobBase64?: string;
    keyFingerprint?: string;
    wrappedPasswordsEncrypted?: string;
    wrappedPassword?: {
      ciphertext: string;
      iv: string;
      tag: string;
    };
  };
}

function encryptTarget(target: StorageConnectConfig): StorageConnectConfig {
  const result: StorageConnectConfig = { ...target };
  if (result.sftpConfig) {
    // A smartcard/FIDO2 PIN is never written to disk, not even encrypted.
    const { pin: _pin, ...withoutPin } = result.sftpConfig;
    result.sftpConfig = withoutPin;
    result.sftpConfig = transformEntrySecrets(result.sftpConfig, SFTP_SECRET_FIELDS, encryptSecretValue);
  }
  if (result.s3Config) {
    result.s3Config = transformEntrySecrets(result.s3Config, S3_SECRET_FIELDS, encryptSecretValue);
  }
  return result;
}

function decryptTarget(target: StorageConnectConfig): StorageConnectConfig {
  const result: StorageConnectConfig = { ...target };
  if (result.sftpConfig) {
    result.sftpConfig = transformEntrySecrets(result.sftpConfig, SFTP_SECRET_FIELDS, decryptSecretValue);
  }
  if (result.s3Config) {
    result.s3Config = transformEntrySecrets(result.s3Config, S3_SECRET_FIELDS, decryptSecretValue);
  }
  return result;
}

/**
 * Carries over a secret that is still on disk as ciphertext this process could not decrypt (locked
 * or unavailable keyring, file moved between machines). Such a value loads as '' and would
 * otherwise be overwritten with '' by the next unrelated save (e.g. `setLastSyncAt`), destroying
 * the ciphertext for good. Same rule as `ProfileStore.keepUndecryptableSecrets`.
 */
function keepUndecryptableSecrets<T extends { proxy?: any }>(
  next: T,
  prev: T | undefined,
  fields: Array<keyof T>
): T {
  if (!prev) return next;
  const lost = (current: unknown, old: unknown): old is string =>
    !current && isEncryptedSecret(old) && decryptSecretValue(old) === '';
  const result: any = { ...next };
  for (const field of fields) {
    if (lost(result[field], prev[field])) result[field] = prev[field];
  }
  if (result.proxy && prev.proxy && lost(result.proxy.password, prev.proxy.password)) {
    result.proxy = { ...result.proxy, password: prev.proxy.password };
  }
  return result;
}

function keepUndecryptableTargetSecrets(
  next: StorageConnectConfig,
  prev: StorageConnectConfig | undefined
): StorageConnectConfig {
  // Only for the same target; a different target must not inherit another server's credentials.
  if (!prev || prev.id !== next.id) return next;
  const result: StorageConnectConfig = { ...next };
  if (result.sftpConfig && prev.sftpConfig) {
    result.sftpConfig = keepUndecryptableSecrets(result.sftpConfig, prev.sftpConfig, SFTP_SECRET_FIELDS);
  }
  if (result.s3Config && prev.s3Config) {
    result.s3Config = keepUndecryptableSecrets(result.s3Config, prev.s3Config, S3_SECRET_FIELDS);
  }
  return result;
}

/**
 * Persists remote profile sync's own configuration: which S3/SFTP location
 * to sync to/from (with its own credentials, at-rest encrypted the same way
 * ProfileStore encrypts saved connection profiles), and the per-key-group
 * salts established at first enable. The two master passwords themselves
 * are never written here — only SyncCryptoService's in-memory cache holds
 * the derived keys, for as long as the app considers sync "unlocked".
 */
export class SyncConfigStore {
  private filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(customPath?: string) {
    if (customPath) {
      this.filePath = customPath;
    } else {
      let baseDir: string;
      try {
        baseDir = app.getPath('userData');
      } catch {
        baseDir = path.join(os.homedir(), '.sshs3');
      }
      this.filePath = path.join(baseDir, 'sync-config.json');
    }
  }

  public getFilePath(): string {
    return this.filePath;
  }

  public async getConfig(): Promise<SyncConfigData> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const data = JSON.parse(raw) as SyncConfigData;
      return {
        ...data,
        target: data.target ? decryptTarget(data.target) : undefined,
      };
    } catch (err: any) {
      if (err?.code === 'ENOENT') return {};
      return {};
    }
  }

  public async setTarget(target: StorageConnectConfig, remoteBasePath = ''): Promise<void> {
    return this.queueMutation(async () => {
      const current = await this.getConfig();
      await this.persist({ ...current, target, remoteBasePath });
    });
  }

  /**
   * Points sync at a different location in one step: the salts, last-sync time and auto-sync flag belonged to
   * the data on the previous target, so they are dropped together with it (the smartcard link stays). The next
   * unlock then has to go through a pull (or start a brand-new set), never reuse the old key.
   */
  public async replaceTarget(target: StorageConnectConfig, remoteBasePath = ''): Promise<void> {
    return this.queueMutation(async () => {
      const current = await this.getConfig();
      await this.persist({
        ...current,
        target,
        remoteBasePath,
        topologySaltBase64: undefined,
        credentialsSaltBase64: undefined,
        lastSyncAt: undefined,
        autoSync: false,
      });
    });
  }

  /**
   * Updates whichever salt(s) are provided, leaving the other untouched.
   * Independent so that e.g. a bootstrap pull that only received one of the
   * two master passwords doesn't clobber the salt for the other, not-yet-
   * learned, key group.
   */
  public async setSalts(salts: { topologySalt?: Buffer; credentialsSalt?: Buffer }): Promise<void> {
    return this.queueMutation(async () => {
      const current = await this.getConfig();
      await this.persist({
        ...current,
        topologySaltBase64: salts.topologySalt ? salts.topologySalt.toString('base64') : current.topologySaltBase64,
        credentialsSaltBase64: salts.credentialsSalt
          ? salts.credentialsSalt.toString('base64')
          : current.credentialsSaltBase64,
      });
    });
  }

  public async setLastSyncAt(timestamp: string): Promise<void> {
    return this.queueMutation(async () => {
      const current = await this.getConfig();
      await this.persist({ ...current, lastSyncAt: timestamp });
    });
  }

  public async setAutoSync(enabled: boolean): Promise<void> {
    return this.queueMutation(async () => {
      const current = await this.getConfig();
      await this.persist({ ...current, autoSync: enabled });
    });
  }

  public async setSmartcardSync(
    smartcardSync?: SyncConfigData['smartcardSync']
  ): Promise<void> {
    return this.queueMutation(async () => {
      const current = await this.getConfig();
      await this.persist({ ...current, smartcardSync });
    });
  }

  /**
   * Resets sync configuration entirely: target, salts, last-sync timestamp,
   * auto-sync flag, and smartcard link. Used by the "delete all sync data"
   * action — this only clears local configuration, never the remote files
   * themselves (see ProfileSyncService.wipeRemote for that).
   */
  public async clear(): Promise<void> {
    return this.queueMutation(async () => {
      await this.persist({});
    });
  }

  private queueMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const resultPromise = this.writeQueue.then(mutation, mutation);
    this.writeQueue = resultPromise.then(
      () => {},
      () => {}
    );
    return resultPromise;
  }

  /** The stored file exactly as written (secrets still encrypted); an unparsable file is copied aside first. */
  private async readRawConfig(): Promise<SyncConfigData | undefined> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf-8');
    } catch {
      return undefined;
    }
    try {
      return JSON.parse(raw) as SyncConfigData;
    } catch {
      await backupCorruptFile(this.filePath, raw);
      return undefined;
    }
  }

  private async persist(data: SyncConfigData): Promise<void> {
    const existing = data.target ? (await this.readRawConfig())?.target : undefined;
    const onDisk: SyncConfigData = {
      ...data,
      target: data.target ? keepUndecryptableTargetSecrets(encryptTarget(data.target), existing) : undefined,
    };
    await writeFileAtomic(this.filePath, JSON.stringify(onDisk, null, 2), { mode: 0o600 });
  }
}
