import crypto from 'node:crypto';
import { shell as electronShell } from 'electron';
import { AwsSsoLoginCancelledError } from '../aws/AwsSsoAuthService';
import { IPC_CHANNELS, type AwsSsoPromptEvent } from '../../shared/types/ipc';
import type {
  AwsSsoAccount,
  AwsSsoAccountRole,
  AwsSsoLoginResult,
  AwsSsoNetworkOptions,
} from '../../shared/types/aws';
import type { IpcBridge } from '../IpcBridge';
import type { S3StorageProvider } from '../storage/S3StorageProvider';

/** The part of IpcBridge this handler group may use. */
export type AwsSsoHost = Pick<
  IpcBridge,
  'awsSsoAuthService' | 'pendingAwsSsoLogins' | 'registerHandler' | 'sendToSender' | 'storageRegistry'
>;

async function runSsoLogin(
  bridge: AwsSsoHost,
  event: { sender?: unknown } | undefined,
  startUrl: string,
  region: string,
  network?: AwsSsoNetworkOptions
): Promise<AwsSsoLoginResult> {
  if (!startUrl?.trim() || !region?.trim()) {
    throw new Error('Start URL and region are required');
  }

  const sender = event?.sender as Parameters<AwsSsoHost['sendToSender']>[0];
  const id = crypto.randomUUID();
  const controller = new AbortController();
  bridge.pendingAwsSsoLogins.set(id, { cancel: () => controller.abort() });

  try {
    return await bridge.awsSsoAuthService.login(startUrl, region, {
      network,
      onPrompt: (prompt) => {
        const urlToOpen = prompt.verificationUriComplete || prompt.verificationUri;
        if (
          urlToOpen &&
          (urlToOpen.startsWith('http://') || urlToOpen.startsWith('https://')) &&
          electronShell?.openExternal
        ) {
          void electronShell.openExternal(urlToOpen).catch(() => {});
        }
        const promptEvent: AwsSsoPromptEvent = { id, ...prompt };
        bridge.sendToSender(sender, IPC_CHANNELS.AWS_SSO_PROMPT, promptEvent);
      },
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof AwsSsoLoginCancelledError) {
      throw new Error('AWS SSO login was cancelled', { cause: err });
    }
    throw err;
  } finally {
    bridge.pendingAwsSsoLogins.delete(id);
    // Closes the renderer's approval dialog; without it the dialog stays up after approval.
    bridge.sendToSender(sender, IPC_CHANNELS.AWS_SSO_PROMPT_DONE, id);
  }
}

/**
 * Runs the AWS SSO device-authorization flow and resolves once the user
 * approves it in their browser. Mirrors `promptHostKeyTrust`'s pattern of
 * leaving a single long-lived `ipcMain.handle` invoke pending, but also
 * supports cancellation via a separate channel since this wait can be
 * minutes rather than a single click.
 */
export function registerAwsSsoHandlers(bridge: AwsSsoHost): void {
  bridge.registerHandler(
    IPC_CHANNELS.AWS_SSO_LOGIN,
    async (event, startUrl: string, region: string, network?: AwsSsoNetworkOptions): Promise<AwsSsoLoginResult> =>
      runSsoLogin(bridge, event, startUrl, region, network)
  );

  // Re-authenticates a pane's existing provider from its own saved profile, so an expired session
  // never forces the user to recreate the profile.
  bridge.registerHandler(IPC_CHANNELS.AWS_SSO_RELOGIN_PROVIDER, async (event, providerId: string): Promise<void> => {
    const found = typeof providerId === 'string' ? bridge.storageRegistry.get(providerId) : undefined;
    const provider = found?.type === 's3' ? (found as S3StorageProvider) : undefined;
    const sso = provider?.config.authMode === 'sso' ? provider.config.sso : undefined;
    if (!provider || !sso) {
      throw new Error('This connection does not use AWS SSO');
    }
    const { config } = provider;
    await runSsoLogin(bridge, event, sso.startUrl, sso.region || config.region, {
      customCaPath: config.customCaPath,
      rejectUnauthorized: config.rejectUnauthorized,
      proxy: config.proxy,
    });
    provider.clearCache();
  });

  bridge.registerHandler(IPC_CHANNELS.AWS_SSO_LOGIN_CANCEL, async (_event, id: string) => {
    const pending = bridge.pendingAwsSsoLogins.get(id);
    pending?.cancel();
  });

  bridge.registerHandler(
    IPC_CHANNELS.AWS_SSO_LIST_ACCOUNTS,
    async (
      _event,
      accessToken: string,
      region: string,
      network?: AwsSsoNetworkOptions
    ): Promise<AwsSsoAccount[]> => {
      return await bridge.awsSsoAuthService.listAccounts(accessToken, region, network);
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.AWS_SSO_LIST_ROLES,
    async (
      _event,
      accessToken: string,
      region: string,
      accountId: string,
      network?: AwsSsoNetworkOptions
    ): Promise<AwsSsoAccountRole[]> => {
      return await bridge.awsSsoAuthService.listAccountRoles(accessToken, region, accountId, network);
    }
  );
}
