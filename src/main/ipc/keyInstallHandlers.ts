import crypto from 'node:crypto';
import path from 'node:path';
import { classifyAskpassPrompt } from '../ssh/askpassPrompt';
import { type HostKeyPromptInfo } from '../ssh/HostKeyVerifier';
import { installPublicKeys, probeHost, testLogin, verifyKeyLogin } from '../ssh/KeyInstallService';
import { listFilePublicKeys, listAgentPublicKeys, dedupeKeys } from '../ssh/PublicKeyDiscovery';
import { buildInstallCommand, parsePublicKeyLine } from '../ssh/PublicKeyUtils';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type { SSHConnectionConfig, LocalPublicKey, ListPublicKeysRequest, InstallPublicKeysRequest, InstallPublicKeysResult, ProbeHostResult, TestLoginResult } from '../../shared/types/ssh';
import type { SFTPConfig } from '../../shared/types/storage';
import type { IpcBridge } from '../IpcBridge';
import type { SmartcardCoordinator } from '../smartcard/SmartcardCoordinator';

/** The part of IpcBridge this handler group may use. */
export type KeyInstallHost = Pick<
  IpcBridge,
  'makePresenceNotifier' | 'promptForPinDirect' | 'promptHostKeyTrust' | 'registerHandler' | 'resolveProxyJumpConfig' | 'restoreSavedSecrets' | 'tenantHomeDir' | 'tenantSshPrivateKeyPath'
> & {
  smartcard: Pick<
    SmartcardCoordinator,
    'appAgentSocketIfUnlocked' | 'cleanupSmartcardSessionAgent' | 'listSessionAgents' | 'prepareFido2SftpConfig' | 'prepareSftpSmartcardConfig'
  >;
};

/**
 * ssh-copy-id: listar installerbara publika nycklar, probar hosten och lägger nycklarna i
 * `authorized_keys`. Fungerar på en osparad profil (formuläret skickar hela configen, på samma sätt som
 * TERMINAL_CREATE och CONNECTION_TEST_SSH redan gör, så det ger ingen ny förmåga). Configen valideras och
 * `agentPath` nollas, eftersom main själv sätter den; nyckelraderna valideras om innan de når ssh.
 */
export function registerKeyInstallHandlers(bridge: KeyInstallHost): void {
  const MAX_KEYS = 50;
  const AUTH_TYPES = new Set(['password', 'privateKey', 'smartcard', 'agent', 'fido2']);
  const LOGIN_METHODS = new Set(['auto', 'password', 'profile', 'smartcard', 'agent']);

  /** Validerar och normaliserar en config från renderern; kastar vid ogiltig form. */
  const resolveDraft = async (raw: unknown): Promise<SSHConnectionConfig> => {
    const c = raw as Partial<SSHConnectionConfig> | undefined;
    if (
      !c ||
      typeof c.host !== 'string' ||
      !c.host.trim() ||
      typeof c.username !== 'string' ||
      !c.username.trim() ||
      typeof c.authType !== 'string' ||
      !AUTH_TYPES.has(c.authType) ||
      (c.port !== undefined && (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535))
    ) {
      throw new Error('A host, a user name and a valid login method are required');
    }
    if (c.authType === 'smartcard' && !c.pkcs11LibPath?.trim()) {
      throw new Error('A PKCS#11 library is required for smartcard login');
    }
    if (c.authType === 'fido2' && !c.fido2Resident && !c.privateKeyPath?.trim()) {
      throw new Error('A key file is required for FIDO2 login (or use a resident key)');
    }
    let config: SSHConnectionConfig = { ...(c as SSHConnectionConfig), agentPath: undefined };
    config = await bridge.restoreSavedSecrets(config);
    return bridge.resolveProxyJumpConfig(config);
  };

  /** Laddar kortets/säkerhetsnyckelns agent (PIN/touch). Anropas först när profilens egen inloggning behövs. */
  const prepareHardware = async (config: SSHConnectionConfig, agentId: string): Promise<SSHConnectionConfig> => {
    let prepared = (await bridge.smartcard.prepareSftpSmartcardConfig(config as unknown as SFTPConfig, agentId)) as unknown as SSHConnectionConfig;
    prepared = (await bridge.smartcard.prepareFido2SftpConfig(prepared as unknown as SFTPConfig, agentId)) as unknown as SSHConnectionConfig;
    return prepared;
  };

  const listTenantSafeFileKeys = async (profilePrivateKeyPath?: string): Promise<LocalPublicKey[]> => {
    if (bridge.tenantHomeDir) {
      const tenantRoot = path.resolve(bridge.tenantHomeDir);
      const safeProfileKey =
        profilePrivateKeyPath &&
        path.resolve(profilePrivateKeyPath).startsWith(tenantRoot + path.sep)
          ? profilePrivateKeyPath
          : undefined;
      return dedupeKeys(
        bridge.tenantSshPrivateKeyPath
          ? await listFilePublicKeys(bridge.tenantSshPrivateKeyPath, bridge.tenantHomeDir)
          : [],
        await listFilePublicKeys(safeProfileKey, bridge.tenantHomeDir)
      );
    }
    return dedupeKeys(
      bridge.tenantSshPrivateKeyPath ? await listFilePublicKeys(bridge.tenantSshPrivateKeyPath) : [],
      await listFilePublicKeys(profilePrivateKeyPath)
    );
  };

  bridge.registerHandler(
    IPC_CHANNELS.SSH_LIST_PUBLIC_KEYS,
    async (_event, request?: ListPublicKeysRequest): Promise<LocalPublicKey[]> => {
      let profile: SSHConnectionConfig | undefined;
      if (request?.config?.host && request?.config?.username && request?.config?.authType) {
        try {
          profile = await resolveDraft(request.config);
        } catch {
          // Draft resolution optional for global key discovery
        }
      }
      const fileKeys = await listTenantSafeFileKeys(profile?.privateKeyPath);
      const lists: LocalPublicKey[][] = [fileKeys];
      if (!bridge.tenantHomeDir) {
        lists.push(await listAgentPublicKeys('agent', 'Cached key'));
      }

      // The app-wide agent ('agent-global' PIN caching) holds every unlocked smartcard and FIDO2 key.
      const appSocket = bridge.smartcard.appAgentSocketIfUnlocked();
      if (appSocket) {
        const keys = await listAgentPublicKeys('smartcard', 'Smartcard key', appSocket);
        lists.push(
          keys.map((k) => (k.type.startsWith('sk-') ? { ...k, source: 'fido2' as const, label: 'Security key' } : k))
        );
      }

      // Query ALL active session agents
      for (const entry of bridge.smartcard.listSessionAgents()) {
        lists.push(
          await listAgentPublicKeys(
            entry.kind === 'fido2' ? 'fido2' : 'smartcard',
            entry.kind === 'fido2' ? 'Security key' : 'Smartcard key',
            entry.socketPath
          )
        );
      }

      const wantsCard = profile?.authType === 'smartcard' && !!profile?.pkcs11LibPath;
      const wantsFido = profile?.authType === 'fido2' && !!profile?.fido2Resident;
      const cached = lists.some((l) => l.some((k) => k.source === 'smartcard' || k.source === 'fido2'));

      if (!cached && request?.includeHardware && (wantsCard || wantsFido) && profile) {
        const installId = `keylist-${crypto.randomUUID()}`;
        try {
          const config = await prepareHardware(profile, installId);
          if (!config.agentPath) {
            // The loaders swallow their own errors (see resolveFido2AgentPath); don't let that look like "nothing happened".
            throw new Error(
              wantsCard
                ? 'Could not read the smartcard. Check that it is inserted and the PIN is correct, then try again.'
                : 'Could not read the security key. Check that it is plugged in, touch it when it blinks, and try again.'
            );
          }
          lists.push(
            await listAgentPublicKeys(wantsCard ? 'smartcard' : 'fido2', wantsCard ? 'Smartcard key' : 'Security key', config.agentPath)
          );
        } finally {
          void bridge.smartcard.cleanupSmartcardSessionAgent(installId);
        }
      }
      return dedupeKeys(...lists);
    }
  );

  /** Gemensamma prompt-handlers (PIN/lösen/värdnyckel/touch) för probe, test och installation. */
  const promptHandlersFor = (profile: SSHConnectionConfig, installId: string, presenceMessage: string) => {
    const label = profile.name || profile.host;
    const presence = bridge.makePresenceNotifier(installId, presenceMessage);
    return {
      pinPromptHandler: (prompt: string) => {
        const text = prompt.trim();
        return bridge.promptForPinDirect(text, classifyAskpassPrompt(text, profile.authType), `SSH: ${label}`);
      },
      hostKeyPromptHandler: (info: HostKeyPromptInfo) => bridge.promptHostKeyTrust(info),
      onPresence: () => presence.onPresenceRequested(),
      onPresenceCleared: () => presence.onPresenceCleared(),
    };
  };

  bridge.registerHandler(
    IPC_CHANNELS.SSH_PROBE_HOST,
    async (_event, config: SSHConnectionConfig): Promise<ProbeHostResult> => {
      const profile = await resolveDraft(config);
      const installId = `keyprobe-${crypto.randomUUID()}`;
      return probeHost(profile, promptHandlersFor(profile, installId, 'Touch your security key'));
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.SSH_TEST_LOGIN,
    async (_event, config: SSHConnectionConfig): Promise<TestLoginResult> => {
      const profile = await resolveDraft(config);
      const installId = `keytest-${crypto.randomUUID()}`;
      try {
        const prepared = await prepareHardware(profile, installId);
        return await testLogin(
          prepared,
          promptHandlersFor(profile, installId, `Touch your security key to log in to ${profile.name || profile.host}`)
        );
      } finally {
        void bridge.smartcard.cleanupSmartcardSessionAgent(installId);
      }
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.SSH_INSTALL_PUBLIC_KEYS,
    async (_event, request: InstallPublicKeysRequest): Promise<InstallPublicKeysResult> => {
      if (
        !request ||
        !Array.isArray(request.publicKeys) ||
        request.publicKeys.length === 0 ||
        request.publicKeys.length > MAX_KEYS ||
        request.publicKeys.some((k) => typeof k !== 'string' || k.length > 2000) ||
        (request.loginMethod !== undefined && !LOGIN_METHODS.has(request.loginMethod)) ||
        (request.serverMethods !== undefined &&
          (!Array.isArray(request.serverMethods) || request.serverMethods.some((m) => typeof m !== 'string')))
      ) {
        throw new Error(`Between 1 and ${MAX_KEYS} public keys are required`);
      }
      const profile = await resolveDraft(request.config);
      const installId = `keyinstall-${crypto.randomUUID()}`;
      const label = profile.name || profile.host;

      try {
        const outcome = await installPublicKeys({
          config: profile,
          publicKeys: request.publicKeys,
          loginMethod: request.loginMethod,
          installsOwnKeyOnly: request.installsOwnKeyOnly === true,
          serverMethods: request.serverMethods,
          prepareProfileConfig: (c) => prepareHardware(c, installId),
          ...promptHandlersFor(profile, installId, `Touch your security key to install the key on ${label}`),
        });

        // Verifiera nycklar som har en oskyddad privat nyckelfil lokalt; allt annat lämnas som "okänt".
        const fileKeys = outcome.success
          ? await listTenantSafeFileKeys(profile.privateKeyPath)
          : [];
        const results = await Promise.all(
          outcome.results.map(async (r) => {
            if (!outcome.success || (r.status !== 'installed' && r.status !== 'present')) return r;
            const local = fileKeys.find((k) => k.fingerprint === r.fingerprint);
            const parsed = local ? parsePublicKeyLine(local.line) : null;
            if (!local?.privateKeyPath || !parsed) return r;
            const verified = await verifyKeyLogin(profile, local.privateKeyPath, parsed.type);
            return verified === undefined ? r : { ...r, verified };
          })
        );
        return { ...outcome, results };
      } finally {
        void bridge.smartcard.cleanupSmartcardSessionAgent(installId);
      }
    }
  );

  bridge.registerHandler(IPC_CHANNELS.SSH_BUILD_INSTALL_COMMAND, async (_event, publicKeys: string[]): Promise<string> => {
    if (!Array.isArray(publicKeys) || publicKeys.length === 0 || publicKeys.length > MAX_KEYS) {
      throw new Error(`Between 1 and ${MAX_KEYS} public keys are required`);
    }
    return buildInstallCommand(publicKeys);
  });
}
