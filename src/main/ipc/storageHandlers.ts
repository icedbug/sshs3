import fs from 'node:fs';
import os from 'node:os';
import { IPC_CHANNELS, type StorageConnectConfig } from '../../shared/types/ipc';
import type {
  FileEntry,
  ObjectMetadata,
  S3Tag,
  S3Config,
  BucketVersioningInfo,
  ObjectVersionEntry,
  SpaceInfo,
  VolumeInfo,
  WinAttributes,
} from '../../shared/types/storage';
import type { SSHConnectionConfig } from '../../shared/types/ssh';
import type { IpcBridge } from '../IpcBridge';
import type { SmartcardCoordinator } from '../smartcard/SmartcardCoordinator';
import type { S3StorageProvider } from '../storage/S3StorageProvider';
import { resolveTerminalControlPath } from '../storage/terminalControlPath';
import { describeS3Error } from '../aws/awsErrors';
import { assertStrings, isMissingPathError } from './ipcHelpers';

/** The part of IpcBridge this handler group may use. */
export type StorageHost = Pick<
  IpcBridge,
  'registerHandler' | 'requireS3Capability' | 'resolveProxyJumpConfig' | 'storageRegistry' | 'teamVaultService' | 'sshPtyManager'
> & {
  smartcard: Pick<
    SmartcardCoordinator,
    'awaitStartupUnlock' | 'cleanupSmartcardSessionAgent' | 'prepareFido2SftpConfig' | 'prepareSftpSmartcardConfig' | 'prepareSftpSshCaConfig'
  >;
};

/** Last path segment, for messages; local Windows paths use backslashes, everything else uses '/'. */
function baseName(p: string): string {
  return p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);
}

export function registerStorageHandlers(bridge: StorageHost): void {
  bridge.registerHandler(
    IPC_CHANNELS.STORAGE_CONNECT,
    async (_event, config: StorageConnectConfig) => {
      let resolvedConfig = config;
      if (config.type === 'sftp') {
        // A startup unlock error does not block a background connect.
        await bridge.smartcard.awaitStartupUnlock();
      }
      if (config.type === 'sftp' && config.sftpConfig?.teamVaultProfileRef && !bridge.storageRegistry.has(config.id)) {
        // Resolves the whole config server-side from the vault's stored profile — never merges
        // in the renderer-supplied sftpConfig, which (for a non-admin member) is not just
        // missing the secret but untrusted for host/port/proxy too (TeamVaultService guards
        // those server-side on save, but connect must still ignore whatever the renderer sent).
        const resolved = await bridge.teamVaultService.resolveProfileForConnect(
          config.sftpConfig.teamVaultProfileRef.vaultId,
          'ssh',
          config.sftpConfig.teamVaultProfileRef.profileId
        );
        const resolvedSsh = resolved as SSHConnectionConfig;
        resolvedConfig = {
          ...config,
          sftpConfig: { ...resolvedSsh, port: resolvedSsh.port ?? 22, id: config.sftpConfig.id },
        };
      }
      if (config.type === 's3' && config.s3Config?.teamVaultProfileRef && !bridge.storageRegistry.has(config.id)) {
        const resolved = await bridge.teamVaultService.resolveProfileForConnect(
          config.s3Config.teamVaultProfileRef.vaultId,
          's3',
          config.s3Config.teamVaultProfileRef.profileId
        );
        resolvedConfig = { ...config, s3Config: { ...(resolved as S3Config), id: config.s3Config.id } };
      }
      if (resolvedConfig.type === 'sftp' && resolvedConfig.sftpConfig && !bridge.storageRegistry.has(config.id)) {
        let sftpConfig = await bridge.resolveProxyJumpConfig(resolvedConfig.sftpConfig);
        sftpConfig = await bridge.smartcard.prepareSftpSmartcardConfig(sftpConfig, config.id);
        sftpConfig = await bridge.smartcard.prepareFido2SftpConfig(sftpConfig, config.id);
        sftpConfig = await bridge.smartcard.prepareSftpSshCaConfig(sftpConfig);
        resolvedConfig = { ...resolvedConfig, sftpConfig };
      }
      // Only an id comes from the renderer; the socket path is read from the terminal session itself.
      const terminalSessionId = typeof config.terminalSessionId === 'string' ? config.terminalSessionId : undefined;
      const terminalControlPath =
        resolvedConfig.type === 'sftp' && resolvedConfig.sftpConfig && terminalSessionId
          ? resolveTerminalControlPath(
              bridge.sshPtyManager.getSession(terminalSessionId),
              resolvedConfig.sftpConfig,
              process.platform,
              fs.existsSync
            )
          : undefined;
      await bridge.storageRegistry.getOrCreate(resolvedConfig, { controlPath: terminalControlPath });
      return { id: config.id };
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.STORAGE_DISCONNECT,
    async (_event, providerId: string) => {
      await bridge.storageRegistry.disconnect(providerId);
      void bridge.smartcard.cleanupSmartcardSessionAgent(providerId);
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.STORAGE_LIST,
    async (_event, providerId: string, remotePath: string, force?: boolean): Promise<FileEntry[]> => {
      const provider = bridge.storageRegistry.get(providerId);
      if (!provider) {
        throw new Error(`Storage provider not found: ${providerId}`);
      }
      try {
        return await (provider as any).list(remotePath, { force });
      } catch (err) {
        if (provider.type !== 's3') throw err;
        // Gives the pane a readable reason, and lets it offer a sign-in when the SSO session is gone.
        const ssoProfile = (provider as S3StorageProvider).config.authMode === 'sso';
        throw new Error(describeS3Error(err, ssoProfile), { cause: err });
      }
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.STORAGE_STAT,
    async (_event, providerId: string, remotePath: string): Promise<FileEntry> => {
      const provider = bridge.storageRegistry.get(providerId);
      if (!provider) {
        throw new Error(`Storage provider not found: ${providerId}`);
      }
      return await provider.stat(remotePath);
    }
  );

  // A lookup for something that may well not exist (a word in the terminal that looks like a path): a
  // miss is the normal answer, so it resolves to null instead of rejecting, which Electron would print as
  // an "Error occurred in handler" line for every hover. Any other failure (lost connection, timeout,
  // permission) still rejects so the caller does not mistake it for a missing file.
  bridge.registerHandler(
    IPC_CHANNELS.STORAGE_LOOKUP,
    async (_event, providerId: string, remotePath: string): Promise<FileEntry | null> => {
      if (typeof providerId !== 'string' || typeof remotePath !== 'string') {
        throw new Error('Invalid arguments');
      }
      const provider = bridge.storageRegistry.get(providerId);
      if (!provider) {
        throw new Error(`Storage provider not found: ${providerId}`);
      }
      try {
        return await provider.stat(remotePath);
      } catch (err) {
        if (isMissingPathError(err)) return null;
        throw err;
      }
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.STORAGE_CREATE_FOLDER,
    async (_event, providerId: string, remotePath: string): Promise<void> => {
      const provider = bridge.storageRegistry.get(providerId);
      if (!provider) {
        throw new Error(`Storage provider not found: ${providerId}`);
      }
      await provider.createFolder(remotePath);
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.STORAGE_CREATE_FILE,
    async (_event, providerId: string, remotePath: string): Promise<void> => {
      if (typeof providerId !== 'string' || typeof remotePath !== 'string' || remotePath.includes('\0')) {
        throw new Error('Invalid arguments');
      }
      const provider = bridge.storageRegistry.get(providerId);
      if (!provider) {
        throw new Error(`Storage provider not found: ${providerId}`);
      }
      if (!provider.writeFile) {
        throw new Error('Creating files is not supported by this connection');
      }
      // writeFile replaces existing content, so refuse anything that is already there.
      const existing = await provider.stat(remotePath).then(
        () => true,
        (err: unknown) => {
          if (isMissingPathError(err)) return false;
          throw err;
        }
      );
      if (existing) {
        throw new Error(`"${baseName(remotePath)}" already exists`);
      }
      // On local disk the write itself refuses an existing path (O_EXCL), which also covers a dangling
      // symlink that stat() reports as missing, and a file created since the check above.
      await provider.writeFile(remotePath, Buffer.alloc(0), { exclusive: true }).catch((err: unknown) => {
        if ((err as { code?: unknown } | null)?.code === 'EEXIST') {
          throw new Error(`"${baseName(remotePath)}" already exists`, { cause: err });
        }
        throw err;
      });
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.STORAGE_DELETE,
    async (_event, providerId: string, remotePath: string, isDirectory: boolean): Promise<void> => {
      const provider = bridge.storageRegistry.get(providerId);
      if (!provider) {
        throw new Error(`Storage provider not found: ${providerId}`);
      }
      await provider.delete(remotePath, isDirectory);
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.STORAGE_RENAME,
    async (_event, providerId: string, oldPath: string, newPath: string): Promise<void> => {
      const provider = bridge.storageRegistry.get(providerId);
      if (!provider) {
        throw new Error(`Storage provider not found: ${providerId}`);
      }
      await provider.rename(oldPath, newPath);
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.STORAGE_CHMOD,
    async (_event, providerId: string, remotePath: string, mode: number | string): Promise<void> => {
      const provider = bridge.storageRegistry.get(providerId);
      if (!provider) {
        throw new Error(`Storage provider not found: ${providerId}`);
      }
      if (typeof provider.chmod !== 'function') {
        throw new Error(`Storage provider "${providerId}" does not support chmod`);
      }
      await provider.chmod(remotePath, mode);
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.STORAGE_GET_WIN_ATTRIBUTES,
    async (_event, providerId: string, remotePath: string): Promise<WinAttributes> => {
      assertStrings({ providerId, remotePath });
      const provider = bridge.storageRegistry.get(providerId);
      if (!provider) {
        throw new Error(`Storage provider not found: ${providerId}`);
      }
      if (typeof provider.getWinAttributes !== 'function') {
        throw new Error(`Storage provider "${providerId}" does not support Windows attributes`);
      }
      return provider.getWinAttributes(remotePath);
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.STORAGE_SET_WIN_ATTRIBUTES,
    async (
      _event,
      providerId: string,
      remotePath: string,
      changes: Partial<WinAttributes>,
      recursive?: boolean
    ): Promise<void> => {
      assertStrings({ providerId, remotePath });
      const provider = bridge.storageRegistry.get(providerId);
      if (!provider) {
        throw new Error(`Storage provider not found: ${providerId}`);
      }
      if (typeof provider.setWinAttributes !== 'function') {
        throw new Error(`Storage provider "${providerId}" does not support Windows attributes`);
      }
      const clean: Partial<WinAttributes> = {};
      for (const key of ['readOnly', 'hidden', 'system', 'archive'] as const) {
        if (typeof changes?.[key] === 'boolean') clean[key] = changes[key];
      }
      await provider.setWinAttributes(remotePath, clean, recursive === true);
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.STORAGE_SET_METADATA,
    async (_event, providerId: string, remotePath: string, metadata: ObjectMetadata): Promise<void> => {
      const provider = bridge.storageRegistry.get(providerId);
      if (!provider) {
        throw new Error(`Storage provider not found: ${providerId}`);
      }
      if (typeof provider.setMetadata !== 'function') {
        throw new Error(`Storage provider "${providerId}" does not support metadata updates`);
      }
      await provider.setMetadata(remotePath, metadata);
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.STORAGE_GET_TAGS,
    async (_event, providerId: string, remotePath: string): Promise<S3Tag[]> => {
      const provider = bridge.requireS3Capability(providerId, 'getTags');
      return await provider.getTags!(remotePath);
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.STORAGE_SET_TAGS,
    async (_event, providerId: string, remotePath: string, tags: S3Tag[]): Promise<void> => {
      const provider = bridge.requireS3Capability(providerId, 'setTags');
      await provider.setTags!(remotePath, tags);
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.STORAGE_GET_BUCKET_POLICY,
    async (_event, providerId: string, bucketPath: string): Promise<string | null> => {
      const provider = bridge.requireS3Capability(providerId, 'getBucketPolicy');
      return await provider.getBucketPolicy!(bucketPath);
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.STORAGE_SET_BUCKET_POLICY,
    async (_event, providerId: string, bucketPath: string, policy: string | null): Promise<void> => {
      const provider = bridge.requireS3Capability(providerId, 'setBucketPolicy');
      await provider.setBucketPolicy!(bucketPath, policy);
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.STORAGE_GET_BUCKET_CORS,
    async (_event, providerId: string, bucketPath: string): Promise<string | null> => {
      const provider = bridge.requireS3Capability(providerId, 'getBucketCors');
      return await provider.getBucketCors!(bucketPath);
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.STORAGE_SET_BUCKET_CORS,
    async (_event, providerId: string, bucketPath: string, corsJson: string | null): Promise<void> => {
      const provider = bridge.requireS3Capability(providerId, 'setBucketCors');
      await provider.setBucketCors!(bucketPath, corsJson);
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.STORAGE_GET_BUCKET_VERSIONING,
    async (_event, providerId: string, bucketPath: string): Promise<BucketVersioningInfo> => {
      const provider = bridge.requireS3Capability(providerId, 'getBucketVersioning');
      return await provider.getBucketVersioning!(bucketPath);
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.STORAGE_SET_BUCKET_VERSIONING,
    async (_event, providerId: string, bucketPath: string, enabled: boolean): Promise<void> => {
      const provider = bridge.requireS3Capability(providerId, 'setBucketVersioning');
      await provider.setBucketVersioning!(bucketPath, enabled);
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.STORAGE_LIST_OBJECT_VERSIONS,
    async (_event, providerId: string, remotePath: string): Promise<ObjectVersionEntry[]> => {
      const provider = bridge.requireS3Capability(providerId, 'listObjectVersions');
      return await provider.listObjectVersions!(remotePath);
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.STORAGE_DELETE_OBJECT_VERSION,
    async (_event, providerId: string, remotePath: string, versionId: string): Promise<void> => {
      const provider = bridge.requireS3Capability(providerId, 'deleteObjectVersion');
      await provider.deleteObjectVersion!(remotePath, versionId);
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.STORAGE_RESTORE_OBJECT_VERSION,
    async (_event, providerId: string, remotePath: string, versionId: string): Promise<void> => {
      const provider = bridge.requireS3Capability(providerId, 'restoreObjectVersion');
      await provider.restoreObjectVersion!(remotePath, versionId);
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.STORAGE_GET_PRESIGNED_URL,
    async (_event, providerId: string, remotePath: string, expiresInSeconds: number): Promise<string> => {
      const provider = bridge.requireS3Capability(providerId, 'getPresignedUrl');
      return await provider.getPresignedUrl!(remotePath, expiresInSeconds);
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.STORAGE_GET_HOMEDIR,
    async (_event, providerId: string): Promise<string> => {
      if (providerId === 'local') {
        return os.homedir();
      }
      const provider = bridge.storageRegistry.get(providerId);
      if (!provider) {
        throw new Error(`Storage provider not found: ${providerId}`);
      }
      if (typeof provider.getHomeDir === 'function') {
        return await provider.getHomeDir();
      }
      return '/';
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.STORAGE_GET_SPACE,
    async (_event, providerId: string, remotePath: string): Promise<SpaceInfo | undefined> => {
      if (typeof providerId !== 'string' || typeof remotePath !== 'string') {
        throw new Error('Invalid arguments');
      }
      const provider = bridge.storageRegistry.get(providerId);
      if (!provider) {
        throw new Error(`Storage provider not found: ${providerId}`);
      }
      return typeof provider.getSpace === 'function' ? await provider.getSpace(remotePath) : undefined;
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.STORAGE_LIST_VOLUMES,
    async (_event, providerId: string): Promise<VolumeInfo[]> => {
      if (typeof providerId !== 'string') {
        throw new Error('Invalid arguments');
      }
      const provider = bridge.storageRegistry.get(providerId);
      if (!provider) {
        throw new Error(`Storage provider not found: ${providerId}`);
      }
      return typeof provider.listVolumes === 'function' ? await provider.listVolumes() : [];
    }
  );
}
