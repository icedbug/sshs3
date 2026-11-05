import { fetchGitPublicKeys } from '../git/GitKeyFetcher';
import { GitConfigService } from '../git/GitConfigService';
import { GitStatusService } from '../git/GitStatusService';
import { RemoteGitService } from '../git/RemoteGitService';
import { DotfileGitImporter } from '../dotfiles/DotfileGitImporter';
import type { ConfigureGitSigningRequest, ConfigureGitSigningResult, DotfilesImportFromGitRequest, DotfilesImportFromGitResult, FetchGitKeysRequest, FetchGitKeysResult, GitCloneRequest, GitOperationResult, GitRepoStatus, GitSigningConfig, TestRemoteGitAccessRequest, TestRemoteGitAccessResult } from '../../shared/types/git';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type { SSHConnectionConfig } from '../../shared/types/ssh';
import type { IpcBridge } from '../IpcBridge';
import { isFeatureAllowed } from '../policy/policyApply';

const DISABLED_BY_POLICY = 'Disabled by your administrator.';

/** The part of IpcBridge this handler group may use. */
export type GitHost = Pick<
  IpcBridge,
  'dotfilePoolStore' | 'policy' | 'profileStore' | 'registerHandler' | 'resolveProxyJumpConfig' | 'restoreSavedSecrets' | 'scheduleAutoSync' | 'storageRegistry'
>;

export function registerGitHandlers(bridge: GitHost): void {
  bridge.registerHandler(
    IPC_CHANNELS.GIT_FETCH_PUBLIC_KEYS,
    async (_event, request: FetchGitKeysRequest): Promise<FetchGitKeysResult> => {
      if (!isFeatureAllowed(bridge.policy.policy, 'gitKeyFetch')) {
        return { success: false, keys: [], error: DISABLED_BY_POLICY };
      }
      return await fetchGitPublicKeys(request);
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.GIT_GET_SIGNING_CONFIG,
    async (): Promise<GitSigningConfig> => {
      return await GitConfigService.getSigningConfig();
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.GIT_CONFIGURE_SIGNING,
    async (_event, request: ConfigureGitSigningRequest): Promise<ConfigureGitSigningResult> => {
      return await GitConfigService.configureSigning(request);
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.GIT_SET_SIGNING_ENABLED,
    async (_event, enabled: boolean): Promise<ConfigureGitSigningResult> => {
      return await GitConfigService.setSigningEnabled(Boolean(enabled));
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.GIT_GET_STATUS,
    async (_event, directoryPath: string, providerId?: string): Promise<GitRepoStatus> => {
      return await GitStatusService.getStatus(directoryPath, providerId, bridge.storageRegistry);
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.GIT_CLONE,
    async (_event, request: GitCloneRequest): Promise<GitOperationResult> => {
      if (request.sftpConfig) {
        const config = await bridge.restoreSavedSecrets(request.sftpConfig);
        request.sftpConfig = await bridge.resolveProxyJumpConfig(config);
      }
      return await RemoteGitService.clone(request);
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.GIT_PULL,
    async (_event, directoryPath: string, providerId?: string): Promise<GitOperationResult> => {
      // Remote panes are identified by `sftp-<profileId>`. The connection is resolved from the saved
      // profile here, never taken from the renderer.
      let sftpConfig: SSHConnectionConfig | undefined;
      if (providerId && providerId !== 'local') {
        const profileId = providerId.startsWith('sftp-') ? providerId.slice('sftp-'.length) : undefined;
        const profile = profileId
          ? (await bridge.profileStore.getProfiles()).ssh.find((p) => p.id === profileId)
          : undefined;
        if (profile) {
          sftpConfig = await bridge.resolveProxyJumpConfig(await bridge.restoreSavedSecrets(profile));
        }
      }
      return await RemoteGitService.pull(directoryPath, providerId, sftpConfig);
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.GIT_TEST_REMOTE_ACCESS,
    async (_event, request: TestRemoteGitAccessRequest): Promise<TestRemoteGitAccessResult> => {
      const config = await bridge.restoreSavedSecrets(request.config);
      const resolved = await bridge.resolveProxyJumpConfig(config);
      return await RemoteGitService.testRemoteAccess({ ...request, config: resolved });
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.DOTFILES_IMPORT_FROM_GIT,
    async (_event, request: DotfilesImportFromGitRequest): Promise<DotfilesImportFromGitResult> => {
      if (!isFeatureAllowed(bridge.policy.policy, 'dotfileGitImport')) {
        return { success: false, error: DISABLED_BY_POLICY };
      }
      const res = await DotfileGitImporter.importFromGit(request, bridge.dotfilePoolStore);
      if (res.success) {
        bridge.scheduleAutoSync();
      }
      return res;
    }
  );
}
