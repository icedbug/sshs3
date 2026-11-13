import { XServerManager } from '../x11/XServerManager';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import { resolveSshConfigForConnect } from './sshConfigResolve';
import type { SSHConnectionConfig, PtyOptions } from '../../shared/types/ssh';
import type { ShellKind } from '../../shared/types/aiHub';
import type { IpcBridge } from '../IpcBridge';
import type { SmartcardCoordinator } from '../smartcard/SmartcardCoordinator';

function resolveLocalShellKind(ptyOptions?: PtyOptions): ShellKind {
  const shellType = ptyOptions?.shellType;
  if (shellType === 'powershell') return 'powershell';
  if (shellType === 'pwsh') return 'pwsh';
  if (shellType === 'cmd') return 'cmd';
  if (shellType === 'wsl') return 'bash';

  const rawBinary = (
    ptyOptions?.shellBinary ||
    (process.platform === 'win32'
      ? process.env.COMSPEC || 'cmd.exe'
      : process.env.SHELL || '/bin/bash')
  ).toLowerCase();

  if (rawBinary.includes('pwsh')) return 'pwsh';
  if (rawBinary.includes('powershell')) return 'powershell';
  if (rawBinary.includes('cmd')) return 'cmd';
  if (rawBinary.includes('zsh')) return 'zsh';
  if (rawBinary.includes('fish')) return 'fish';
  if (process.platform === 'win32') return 'cmd';
  return 'bash';
}

/** The part of IpcBridge this handler group may use. */
export type TerminalHost = Pick<
  IpcBridge,
  | 'assignSession'
  | 'k8sTerminalManager'
  | 'scrollback'
  | 'registerHandler'
  | 'resolveProxyJumpConfig'
  | 'restoreSavedSecrets'
  | 'runDotfilesSyncCheck'
  | 'settingsStore'
  | 'sshPtyManager'
  | 'teamVaultService'
  | 'aiHub'
  | 'tenantHomeDir'
> & {
  smartcard: Pick<
    SmartcardCoordinator,
    'awaitStartupUnlock' | 'prepareFido2Config' | 'prepareSmartcardConfig' | 'prepareSshCaConfig' | 'resolveLocalShellAgentSocket'
  >;
};

export function registerTerminalHandlers(bridge: TerminalHost): void {
  bridge.registerHandler(
    IPC_CHANNELS.TERMINAL_CREATE,
    async (
      event,
      options: { config?: SSHConnectionConfig; local?: boolean; ptyOptions?: PtyOptions; profileId?: string }
    ) => {
      if (!options || (!options.config && !options.local)) {
        throw new Error('Connection config is required to create terminal');
      }
      // On a shared server a "local" terminal would be a shell on the server itself, as the server's
      // own user, which can read every other user's data. There is none: connect to a server instead.
      if (options.local && bridge.tenantHomeDir) {
        throw new Error('This is a shared sshs3 server: there is no local terminal here. Connect to one of your servers instead.');
      }

      // A startup unlock error does not block the session; it proceeds and prompts if needed.
      await bridge.smartcard.awaitStartupUnlock();

      let config = options.config;
      if (!options.local && config) {
        // Real secrets are resolved server-side: a member's copy of a shared config has them stripped
        // (TeamVaultService.getPayloadForRenderer), so never trust `config.password`/`passphrase` here.
        config = await resolveSshConfigForConnect(bridge, config);
        config = await bridge.resolveProxyJumpConfig(config);
        config = await bridge.smartcard.prepareSmartcardConfig(config);
        config = await bridge.smartcard.prepareFido2Config(config);
        config = await bridge.smartcard.prepareSshCaConfig(config);

        if (config.x11Forwarding && process.platform === 'win32') {
          try {
            const settings = await bridge.settingsStore.getSettings();
            if (settings.x11ServerMode !== 'manual') {
              await XServerManager.ensureRunning({
                customPath: settings.x11ServerPath,
                customArgs: settings.x11ServerArgs,
                display: config.x11Display,
              });
            }
          } catch {
            // Ignore failure to launch X server; SSH will still connect
          }
        }
      }

      let ptyOptions = options.ptyOptions;
      if (options.local) {
        const settings = await bridge.settingsStore.getSettings().catch(() => null);
        const agentMode = settings?.localTerminalAgentMode ?? 'auto';
        if (agentMode === 'auto' || agentMode === 'app-managed') {
          const globalAgentSocket = await bridge.smartcard.resolveLocalShellAgentSocket(settings?.smartcardAuthMode);
          if (globalAgentSocket) {
            ptyOptions = { ...ptyOptions, env: { SSH_AUTH_SOCK: globalAgentSocket, ...ptyOptions?.env } };
          }
        }
      }

      // The renderer gives each terminal its own config.id; the profile id identifies a demo target.
      const session = options.local
        ? await bridge.sshPtyManager.createShellSession(ptyOptions)
        : await bridge.sshPtyManager.createSession(config!, { ...ptyOptions, profileId: options.profileId });
      const localShell = options.local ? resolveLocalShellKind(ptyOptions) : undefined;
      bridge.aiHub?.terminals.register(
        {
          id: session.sessionId,
          label: options.local ? `Local ${ptyOptions?.shellType ?? localShell ?? 'shell'}` : config!.name || config!.host,
          kind: options.local ? 'local' : 'ssh',
          shell: localShell,
          profileId: options.local ? 'local' : options.profileId,
        },
        (data) => bridge.sshPtyManager.write(session.sessionId, data)
      );

      bridge.assignSession(event?.sender, session.sessionId);

      if (!options.local && config) {
        // Fire-and-forget: never let the dotfiles check delay or fail the
        // terminal session itself, and give the PTY a moment to become
        // interactive before a second connection competes for the network.
        const resolvedConfig = config;
        const sessionId = session.sessionId;
        setTimeout(() => {
          void bridge.runDotfilesSyncCheck(sessionId, resolvedConfig).catch(() => {});
        }, 1500);
      }

      return { sessionId: session.sessionId };
    }
  );

  // A terminal that moved to this window claims its running session. Ownership changes in the same
  // step the output so far is read, so every later chunk reaches this window and none is lost or
  // shown twice (the renderer queues what arrives while it waits for this reply).
  bridge.registerHandler(
    IPC_CHANNELS.TERMINAL_ATTACH,
    async (event, sessionId: unknown, kind: unknown): Promise<{ scrollback: string }> => {
      if (typeof sessionId !== 'string' || !sessionId || (kind !== 'ssh' && kind !== 'k8s')) {
        throw new Error('Invalid terminal session');
      }
      const exists =
        kind === 'ssh' ? !!bridge.sshPtyManager.getSession(sessionId) : !!bridge.k8sTerminalManager.getSession(sessionId);
      if (!exists) throw new Error('The terminal session has ended');
      bridge.assignSession(event?.sender, sessionId);
      return { scrollback: bridge.scrollback.get(sessionId) };
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.TERMINAL_WRITE,
    async (_event, sessionId: string, data: string) => {
      bridge.aiHub?.terminals.observeHumanInput(sessionId, data);
      bridge.sshPtyManager.write(sessionId, data);
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.TERMINAL_RESIZE,
    async (_event, sessionId: string, cols: number, rows: number) => {
      bridge.aiHub?.terminals.resized(sessionId, cols, rows);
      bridge.sshPtyManager.resize(sessionId, cols, rows);
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.TERMINAL_KILL,
    async (_event, sessionId: string) => {
      bridge.aiHub?.terminals.invalidate(sessionId, 'Terminal closed', true);
      bridge.sshPtyManager.kill(sessionId);
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.TERMINAL_RECONNECT,
    async (_event, sessionId: string) => {
      const session = bridge.sshPtyManager.getSession(sessionId);
      if (session && session.reconnect) {
        return await session.reconnect();
      }
      return false;
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.TERMINAL_GET_CWD,
    async (_event, sessionId: string): Promise<string | null> => {
      if (typeof sessionId !== 'string') return null;
      return bridge.sshPtyManager.getSessionCwd(sessionId);
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.TERMINAL_HAS_SSH_CLIENT,
    async (_event, sessionId: string): Promise<boolean> => {
      if (typeof sessionId !== 'string') return false;
      return bridge.sshPtyManager.sessionHasSshClient(sessionId);
    }
  );
}
