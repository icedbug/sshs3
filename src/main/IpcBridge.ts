import crypto from 'node:crypto';
import { ipcMain as electronIpcMain } from 'electron';
import type { IpcMain } from 'electron';
import { SSHPtyManager, type InternalSSHPtySession } from './ssh/SSHPtyManager';
import { withResolvedProxyJump } from './ssh/resolveProxyJump';
import { AgentLifecycleManager } from './ssh/AgentLifecycleManager';
import { SmartcardDetector } from './smartcard/SmartcardDetector';
import type { AskpassPromptRetryContext } from './smartcard/AskpassServer';
import { StorageRegistry } from './storage/StorageRegistry';
import { TransferQueue } from './transfer/TransferQueue';
import { ProfileStore } from './profile/ProfileStore';
import { SessionStore } from './session/SessionStore';
import { ClipboardHistoryStore } from './clipboard/ClipboardHistoryStore';
import { SnippetStore } from './snippets/SnippetStore';
import { SettingsStore } from './settings/SettingsStore';
import { AiConfigStore } from './ai/AiConfigStore';
import { AiService } from './ai/AiService';
import { UpdateService } from './update/UpdateService';
import { SmartcardCoordinator } from './smartcard/SmartcardCoordinator';
import { createHostVerifier, type HostKeyPromptInfo } from './ssh/HostKeyVerifier';
import { DotfilePoolStore } from './dotfiles/DotfilePoolStore';
import { DotfileSyncService } from './dotfiles/DotfileSyncService';
import { DirectorySyncProfileStore } from './dirsync/DirectorySyncProfileStore';
import { FileEditorService } from './editor/FileEditorService';
import { FileTailService } from './editor/FileTailService';
import { SearchOrchestrator } from './search/SearchOrchestrator';
import { K8sDiscoveryService } from './services/K8sDiscoveryService';
import { K8sDebugService } from './services/K8sDebugService';
import { K8sPortForwardManager } from './services/K8sPortForwardManager';
import { SSHTunnelManager } from './services/SSHTunnelManager';
import { K8sTerminalManager } from './terminal/K8sTerminalManager';
import { PerfMetricsService } from './services/PerfMetricsService';
import { K8sLogManager } from './terminal/K8sLogManager';
import { AwsSsoAuthService } from './aws/AwsSsoAuthService';
import { SyncConfigStore, type SyncConfigData } from './services/SyncConfigStore';
import { SyncCryptoService, SyncDecryptionError, generateSalt } from './services/SyncCryptoService';
import { ProfileSyncService } from './services/ProfileSyncService';
import { getAgentIdentities, signChallengeWithAgent, verifyAgentSignature, deriveSecretFromSignature, getKeyAlgorithm, KEY_DERIVATION_MESSAGE } from './smartcard/SmartcardSyncService';
import { decryptSecretValue } from './crypto/SecretFieldCrypto';
import { XServerManager } from './x11/XServerManager';
import { IPC_CHANNELS, type StorageConnectConfig, type HostKeyPromptEvent, type PresencePromptEvent, type PresenceClearEvent, type TransferConflictPromptEvent, type TransferConflictResolution, type QuitConfirmPromptEvent, type AskpassPromptKind } from '../shared/types/ipc';
import type { K8sActivePortForward } from '../shared/types/kubernetes';
import type { DotfilesSyncPromptEvent, DotfilesSyncResolution } from '../shared/types/dotfiles';
import type { SSHConnectionConfig, SSHPtyExitEvent, SSHActiveTunnel } from '../shared/types/ssh';
import type { TransferProgress } from '../shared/types/storage';
import type { ProfileSyncStatus } from '../shared/types/sync';
import { registerSessionHandlers, registerClipboardHistoryHandlers, registerSnippetHandlers, registerSettingsHandlers } from './ipc/appDataHandlers';
import { registerFileEditorHandlers } from './ipc/fileEditorHandlers';
import { registerSearchHandlers } from './ipc/searchHandlers';
import { registerAwsSsoHandlers } from './ipc/awsSsoHandlers';
import { registerDirSyncHandlers } from './ipc/dirSyncHandlers';
import { registerGeneralHandlers } from './ipc/generalHandlers';
import { registerLogHandlers } from './ipc/logHandlers';
import { registerConnectionTestHandlers } from './ipc/connectionTestHandlers';
import { registerGitHandlers } from './ipc/gitHandlers';
import { registerTerminalHandlers } from './ipc/terminalHandlers';
import { registerSmartcardHandlers } from './ipc/smartcardHandlers';
import { registerStorageHandlers } from './ipc/storageHandlers';
import { registerTransferHandlers } from './ipc/transferHandlers';
import { registerProfileHandlers } from './ipc/profileHandlers';
import { registerDotfileHandlers } from './ipc/dotfileHandlers';
import { registerK8sHandlers } from './ipc/k8sHandlers';
import { registerKeyInstallHandlers } from './ipc/keyInstallHandlers';
import { registerSyncHandlers } from './ipc/syncHandlers';
import { registerAiHandlers } from './ipc/aiHandlers';
import { createLogger } from './log';
const ipcLog = createLogger('ipc');
const sshLog = createLogger('ssh');
const smartcardLog = createLogger('smartcard');
const autosyncLog = createLogger('AutoSync');
const DISPOSE_STEP_TIMEOUT_MS = 5000;

interface PendingAskpassPrompt {
  sessionId?: string;
  callback: (pin: string) => void;
}

interface PendingHostKeyPrompt {
  callback: (trust: boolean) => void;
}

interface PendingTransferConflictPrompt {
  callback: (resolution: TransferConflictResolution, applyToAll: boolean) => void;
}

interface PendingQuitConfirmPrompt {
  callback: (proceed: boolean) => void;
}

interface PendingDotfilesSyncPrompt {
  callback: (resolution: DotfilesSyncResolution) => void;
}

interface PendingAwsSsoLogin {
  cancel: () => void;
}

export interface IpcBridgeOptions {
  ipcMain?: IpcMain;
  sshPtyManager?: SSHPtyManager;
  storageRegistry?: StorageRegistry;
  transferQueue?: TransferQueue;
  profileStore?: ProfileStore;
  sessionStore?: SessionStore;
  clipboardHistoryStore?: ClipboardHistoryStore;
  snippetStore?: SnippetStore;
  settingsStore?: SettingsStore;
  aiConfigStore?: AiConfigStore;
  aiService?: AiService;
  dotfilePoolStore?: DotfilePoolStore;
  dotfileSyncService?: DotfileSyncService;
  directorySyncProfileStore?: DirectorySyncProfileStore;
  fileEditorService?: FileEditorService;
  fileTailService?: FileTailService;
  searchOrchestrator?: SearchOrchestrator;
  awsSsoAuthService?: AwsSsoAuthService;
  syncConfigStore?: SyncConfigStore;
  syncCryptoService?: SyncCryptoService;
  profileSyncService?: ProfileSyncService;
  k8sDiscoveryService?: K8sDiscoveryService;
  k8sDebugService?: K8sDebugService;
  k8sTerminalManager?: K8sTerminalManager;
  k8sLogManager?: K8sLogManager;
  k8sPortForwardManager?: K8sPortForwardManager;
  sshTunnelManager?: SSHTunnelManager;
  getWebContents?: () => Electron.WebContents | null | undefined;
  /** Quit confirmation (transfers, confirm-before-quit) run before an update restart. */
  confirmQuit?: () => Promise<boolean>;
}

export class IpcBridge {
  private ipcMain: IpcMain;
  public readonly sshPtyManager: SSHPtyManager;
  public readonly storageRegistry: StorageRegistry;
  public readonly transferQueue: TransferQueue;
  public readonly profileStore: ProfileStore;
  public readonly sessionStore: SessionStore;
  public readonly clipboardHistoryStore: ClipboardHistoryStore;
  public readonly snippetStore: SnippetStore;
  public readonly settingsStore: SettingsStore;
  public readonly aiConfigStore: AiConfigStore;
  public readonly aiService: AiService;
  public readonly dotfilePoolStore: DotfilePoolStore;
  public readonly dotfileSyncService: DotfileSyncService;
  public readonly directorySyncProfileStore: DirectorySyncProfileStore;
  public readonly fileEditorService: FileEditorService;
  public readonly fileTailService: FileTailService;
  public readonly searchOrchestrator: SearchOrchestrator;
  public readonly awsSsoAuthService: AwsSsoAuthService;
  public readonly syncConfigStore: SyncConfigStore;
  public readonly syncCryptoService: SyncCryptoService;
  public readonly profileSyncService: ProfileSyncService;
  public readonly k8sDiscoveryService: K8sDiscoveryService;
  public readonly k8sDebugService: K8sDebugService;
  public readonly k8sTerminalManager: K8sTerminalManager;
  public readonly perfMetricsService: PerfMetricsService;
  public readonly k8sLogManager: K8sLogManager;
  public readonly k8sPortForwardManager: K8sPortForwardManager;
  public readonly sshTunnelManager: SSHTunnelManager;
  private updateService: UpdateService | null = null;
  private confirmQuit: (() => Promise<boolean>) | undefined;
  public getWebContents: () => Electron.WebContents | null | undefined;

  // The members below are public only so the handler groups in src/main/ipc can reach them. Each group
  // declares the exact subset it uses as a Pick<IpcBridge, ...> (see ipc/*Handlers.ts), and
  // tests/main/ipcHostAccess.test.ts pins which groups may touch the prompt maps and agent state.
  public pendingAskpass = new Map<string, PendingAskpassPrompt>();
  public pendingHostKeyPrompts = new Map<string, PendingHostKeyPrompt>();
  public pendingTransferConflicts = new Map<string, PendingTransferConflictPrompt>();
  public pendingQuitConfirms = new Map<string, PendingQuitConfirmPrompt>();
  public pendingDotfilesSyncPrompts = new Map<string, PendingDotfilesSyncPrompt>();
  public pendingAwsSsoLogins = new Map<string, PendingAwsSsoLogin>();
  private handlers = new Set<string>();
  /** Owns the smartcard/FIDO2 agent state and its lifecycle (see smartcard/SmartcardCoordinator.ts). */
  public readonly smartcard: SmartcardCoordinator;
  private autoSyncTimer: NodeJS.Timeout | null = null;
  private autoPullTimer: NodeJS.Timeout | null = null;
  private lastSmartcardAutoUnlockAttempt = 0;
  private static readonly AUTO_PULL_INTERVAL_MS = 10 * 60 * 1000;
  private static readonly SMARTCARD_AUTO_UNLOCK_COOLDOWN_MS = 5 * 60 * 1000;
  private activePresenceSessions = new Set<string>();

  // Event listener references for clean teardown
  private onPtyData?: (event: { sessionId: string; data: string }) => void;
  private onPtyExit?: (event: { sessionId: string; exitCode: number; signal?: number }) => void;
  private onPtyAskpass?: (event: {
    sessionId: string;
    prompt: string;
    kind?: AskpassPromptKind;
    context?: string;
    retry?: AskpassPromptRetryContext;
    callback: (pin: string) => void;
  }) => void;
  private onPtyPresence?: (event: { sessionId: string; prompt: string }) => void;
  private onTransferProgress?: (progress: TransferProgress) => void;
  private onK8sTerminalData?: (event: { sessionId: string; data: string }) => void;
  private onK8sTerminalExit?: (event: { sessionId: string; status: string }) => void;
  private onK8sLogData?: (event: { sessionId: string; data: string }) => void;
  private onK8sLogEnd?: (event: { sessionId: string }) => void;
  private onK8sPortForwardChange?: (list: K8sActivePortForward[]) => void;
  private onSshTunnelChange?: (list: SSHActiveTunnel[]) => void;
  private onK8sConfigChanged?: () => void;
  private unsubscribeK8sConfig?: () => void;

  constructor(options: IpcBridgeOptions = {}) {
    this.ipcMain = options.ipcMain ?? electronIpcMain;
    this.settingsStore = options.settingsStore ?? new SettingsStore();
    this.sshPtyManager =
      options.sshPtyManager ??
      new SSHPtyManager({
        settingsStore: this.settingsStore,
        // Dead wiring: SSHPtyManager no longer reads isTunnelActive (terminal sessions don't
        // auto-start a profile's saved tunnels anymore, only the Tunnels panel does). Left in
        // place rather than removed — see SSHPtyManagerOptions.isTunnelActive.
        isTunnelActive: (connectionId, tunnelId) =>
          this.sshTunnelManager
            .listActive()
            .some((t) => t.connectionId === connectionId && t.tunnel.id === tunnelId),
      });
    this.storageRegistry =
      options.storageRegistry ??
      new StorageRegistry({
        sftpHostVerifierFactory: (host, port) =>
          createHostVerifier({
            host,
            port,
            onUnknownOrChanged: (info) => this.promptHostKeyTrust(info),
          }),
        sftpPresenceFactory: (cfg) => {
          const n = this.makePresenceNotifier(undefined, `Touch your security key to connect to ${cfg.name || cfg.host}`);
          return { onPresence: n.onPresenceRequested, onPresenceCleared: n.onPresenceCleared };
        },
        sftpPinPromptHandlerFactory: (cfg) => (prompt) =>
          this.promptForPinDirect(
            prompt.trim(),
            cfg.authType === 'fido2' ? 'fido2' : cfg.authType === 'smartcard' ? 'smartcard' : undefined,
            `SFTP: ${cfg.name || cfg.host}`
          ),
      });
    this.transferQueue = options.transferQueue ?? new TransferQueue();
    this.profileStore = options.profileStore ?? new ProfileStore();
    this.sessionStore = options.sessionStore ?? new SessionStore();
    this.clipboardHistoryStore = options.clipboardHistoryStore ?? new ClipboardHistoryStore();
    this.snippetStore = options.snippetStore ?? new SnippetStore();
    this.aiConfigStore = options.aiConfigStore ?? new AiConfigStore();
    this.aiService = options.aiService ?? new AiService(this.aiConfigStore);
    this.dotfilePoolStore = options.dotfilePoolStore ?? new DotfilePoolStore();
    this.dotfileSyncService = options.dotfileSyncService ?? new DotfileSyncService();
    this.directorySyncProfileStore = options.directorySyncProfileStore ?? new DirectorySyncProfileStore();
    this.fileEditorService = options.fileEditorService ?? new FileEditorService();
    this.fileTailService = options.fileTailService ?? new FileTailService();
    this.searchOrchestrator = options.searchOrchestrator ?? new SearchOrchestrator();
    this.awsSsoAuthService = options.awsSsoAuthService ?? new AwsSsoAuthService();
    this.syncConfigStore = options.syncConfigStore ?? new SyncConfigStore();
    this.syncCryptoService = options.syncCryptoService ?? new SyncCryptoService();
    this.profileSyncService =
      options.profileSyncService ??
      new ProfileSyncService(this.profileStore, this.dotfilePoolStore, this.settingsStore, this.syncCryptoService, {
        directorySyncProfileStore: this.directorySyncProfileStore,
      });
    this.smartcard = new SmartcardCoordinator({
      settingsStore: this.settingsStore,
      profileStore: this.profileStore,
      sessionStore: this.sessionStore,
      syncConfigStore: this.syncConfigStore,
      sshPtyManager: this.sshPtyManager,
      getWebContents: () => this.getWebContents(),
      promptForPin: (prompt, kind, context, retry) => this.promptForPinDirect(prompt, kind, context, retry),
      makePresenceNotifier: (sessionId, message) => this.makePresenceNotifier(sessionId, message),
      clearPresence: (sessionId) => this.clearPresence(sessionId),
      syncAgentBlock: (entries) => this.profileSyncService.syncAgentBlockToLocalSshConfig(entries),
    });
    // The local agent block is derived from the managed block, so refresh it after every managed-block sync.
    this.profileSyncService.onLocalSshConfigSynced = () => this.smartcard.refreshAgentSshConfig();
    this.k8sDiscoveryService = options.k8sDiscoveryService ?? new K8sDiscoveryService();
    this.k8sDebugService = options.k8sDebugService ?? new K8sDebugService();
    this.k8sTerminalManager = options.k8sTerminalManager ?? new K8sTerminalManager();
    this.perfMetricsService = new PerfMetricsService((sessionId) => {
      const session = this.sshPtyManager.getSession(sessionId);
      return session
        ? {
            host: session.config.host,
            controlPath: session.controlPath,
            config: session.config,
            askpassEnv: (session as InternalSSHPtySession).askpassServer?.getEnv(),
          }
        : undefined;
    });
    this.k8sLogManager = options.k8sLogManager ?? new K8sLogManager();
    this.k8sPortForwardManager = options.k8sPortForwardManager ?? new K8sPortForwardManager();
    this.sshTunnelManager = options.sshTunnelManager ?? new SSHTunnelManager();
    this.getWebContents = options.getWebContents ?? (() => null);
    this.confirmQuit = options.confirmQuit;
  }

  public setWebContentsGetter(getter: () => Electron.WebContents | null | undefined): void {
    this.getWebContents = getter;
  }

  public register(): void {
    registerTerminalHandlers(this);
    registerSmartcardHandlers(this);
    registerStorageHandlers(this);
    registerTransferHandlers(this);
    registerProfileHandlers(this);
    registerDotfileHandlers(this);
    registerSessionHandlers(this);
    registerClipboardHistoryHandlers(this);
    registerSnippetHandlers(this);
    registerSettingsHandlers(this);
    registerAiHandlers(this);
    registerSyncHandlers(this);
    void this.syncConfigStore
      .getConfig()
      .then((config) => {
        if (config.autoSync && config.target) {
          this.startAutoPullTimer();
        }
      })
      .catch(() => {});
    registerConnectionTestHandlers(this);
    registerKeyInstallHandlers(this);
    registerGitHandlers(this);
    registerAwsSsoHandlers(this);
    registerFileEditorHandlers(this);
    registerSearchHandlers(this);
    registerGeneralHandlers(this);
    registerLogHandlers(this);
    registerDirSyncHandlers(this);
    registerK8sHandlers(this);
    this.setupEventListeners();

    if (process.platform === 'win32') {
      void this.settingsStore
        .getSettings()
        .then((settings) => {
          if (settings.x11ServerMode === 'always') {
            void XServerManager.ensureRunning({
              customPath: settings.x11ServerPath,
              customArgs: settings.x11ServerArgs,
            }).catch(() => {});
          }
        })
        .catch(() => {});
    }
  }

  /**
   * Defense-in-depth (not currently exploitable): window creation and
   * navigation are already locked down (see setWindowOpenHandler/
   * will-navigate in src/main/index.ts), so today the main window's own
   * frame is the only thing that can ever call an IPC handler. But this
   * privileged API surface — ~90 methods reachable from the renderer,
   * including local filesystem access, SSH/S3 credentials, and arbitrary
   * command execution helpers — should not rely on that holding forever. A
   * future regression that lets a second frame or a <webview> load
   * untrusted content would otherwise expose the entire API to it with no
   * additional check. getWebContents() returning null/undefined (as in
   * tests, where it's often not wired up) skips the check rather than
   * failing every handler.
   */
  private assertTrustedSender(event: Electron.IpcMainInvokeEvent): void {
    const webContents = this.getWebContents();
    if (!webContents || webContents.isDestroyed()) return;
    if (event.senderFrame !== webContents.mainFrame) {
      throw new Error('Rejected IPC call from an untrusted frame');
    }
  }

  public registerHandler(channel: string, handler: (...args: any[]) => any): void {
    // async, not a plain arrow function: assertTrustedSender's throw must
    // surface as a rejected promise (what ipcMain.invoke's caller expects)
    // rather than a synchronous exception out of the handle() dispatch.
    this.ipcMain.handle(channel, async (event, ...args) => {
      this.assertTrustedSender(event);
      return handler(event, ...args);
    });
    this.handlers.add(channel);
  }

  /**
   * Asks the renderer to show a TOFU (trust-on-first-use) dialog for an
   * unknown or changed SFTP host key and resolves to whether the user chose
   * to trust it. Resolves to false (fail closed) if no window is available
   * to prompt.
   */
  public promptHostKeyTrust(info: HostKeyPromptInfo): Promise<boolean> {
    return new Promise((resolve) => {
      const webContents = this.getWebContents();
      if (!webContents || webContents.isDestroyed?.()) {
        resolve(false);
        return;
      }

      const id = crypto.randomUUID();
      this.pendingHostKeyPrompts.set(id, { callback: resolve });

      const event: HostKeyPromptEvent = { id, ...info };
      webContents.send(IPC_CHANNELS.HOSTKEY_PROMPT, event);
    });
  }

  /**
   * Directly prompts the user for a PIN (e.g. during sync unlock/link, or a
   * FIDO2 key generation/discovery flow) via the standard Askpass modal in
   * the renderer. `kind` lets the modal label itself as FIDO2/security key
   * vs PIV/smartcard rather than showing generic wording — pass it whenever
   * the caller knows which credential this PIN belongs to.
   */
  public promptForPinDirect(
    prompt = 'Enter smartcard PIN:',
    kind?: AskpassPromptKind,
    context?: string,
    retry?: AskpassPromptRetryContext
  ): Promise<string> {
    return new Promise((resolve) => {
      const webContents = this.getWebContents();
      if (!webContents || webContents.isDestroyed?.()) {
        resolve('');
        return;
      }

      const id = crypto.randomUUID();
      this.pendingAskpass.set(id, { callback: resolve });
      webContents.send(IPC_CHANNELS.ASKPASS_PROMPT, {
        id,
        prompt,
        kind,
        context,
        error: retry?.error,
        attempt: retry?.attempt,
        maxAttempts: retry?.maxAttempts,
      });
    });
  }

  /** Clears the "touch your key" banner of a session, if one is showing (SmartcardCoordinator dependency). */
  private clearPresence(sessionId: string): void {
    if (this.activePresenceSessions.has(sessionId)) {
      this.activePresenceSessions.delete(sessionId);
      const webContents = this.getWebContents();
      if (webContents && !webContents.isDestroyed?.()) {
        const event: PresenceClearEvent = { sessionId };
        webContents.send(IPC_CHANNELS.PRESENCE_CLEAR, event);
      }
    }
  }

  /**
   * Builds a fresh (id-scoped) pair of onPresenceRequested/onPresenceCleared
   * callbacks that surface a "touch your key" banner in the renderer,
   * shared by every flow that spawns a private agent for a physical
   * key/card — PIV smartcards (`loadSmartcardIntoPrivateAgentWithPresence`)
   * and FIDO2 resident-key discovery/generation alike.
   */
  public makePresenceNotifier(
    sessionId: string | undefined,
    message: string
  ): { onPresenceRequested: () => void; onPresenceCleared: () => void } {
    const id = crypto.randomUUID();
    return {
      onPresenceRequested: () => {
        if (sessionId) {
          this.activePresenceSessions.add(sessionId);
        }
        const webContents = this.getWebContents();
        if (!webContents || webContents.isDestroyed?.()) return;
        const event: PresencePromptEvent = { id, sessionId, message };
        webContents.send(IPC_CHANNELS.PRESENCE_PROMPT, event);
      },
      onPresenceCleared: () => {
        if (sessionId) {
          this.activePresenceSessions.delete(sessionId);
        }
        const webContents = this.getWebContents();
        if (!webContents || webContents.isDestroyed?.()) return;
        const event: PresenceClearEvent = { id, sessionId };
        webContents.send(IPC_CHANNELS.PRESENCE_CLEAR, event);
      },
    };
  }

  /**
   * Asks the renderer to show a conflict-resolution dialog (overwrite / skip
   * / rename) for a transfer target that already exists. Resolves to 'skip'
   * (the non-destructive default) if no window is available to prompt.
   */
  public promptTransferConflict(
    info: Omit<TransferConflictPromptEvent, 'id'>
  ): Promise<{ resolution: TransferConflictResolution; applyToAll: boolean }> {
    return new Promise((resolve) => {
      const webContents = this.getWebContents();
      if (!webContents || webContents.isDestroyed?.()) {
        resolve({ resolution: 'skip', applyToAll: false });
        return;
      }

      const id = crypto.randomUUID();
      this.pendingTransferConflicts.set(id, {
        callback: (resolution, applyToAll) => resolve({ resolution, applyToAll }),
      });

      const event: TransferConflictPromptEvent = { id, ...info };
      webContents.send(IPC_CHANNELS.TRANSFER_CONFLICT_PROMPT, event);
    });
  }

  /**
   * UX audit finding #2: asks the renderer to show its own themed
   * ConfirmDialog instead of a native `dialog.showMessageBoxSync` box, so
   * quitting looks and behaves like every other confirmation in the app.
   * Resolves to `true` (proceed with quitting) if no window is available to
   * prompt — matches the previous native-dialog fallback behavior.
   */
  public promptQuitConfirm(info: Omit<QuitConfirmPromptEvent, 'id'>): Promise<boolean> {
    return new Promise((resolve) => {
      const webContents = this.getWebContents();
      if (!webContents || webContents.isDestroyed?.()) {
        resolve(true);
        return;
      }

      const id = crypto.randomUUID();
      this.pendingQuitConfirms.set(id, { callback: resolve });

      const event: QuitConfirmPromptEvent = { id, ...info };
      webContents.send(IPC_CHANNELS.QUIT_CONFIRM_PROMPT, event);
    });
  }

  public requireS3Capability<K extends keyof import('../shared/types/storage').IStorageProvider>(
    providerId: string,
    capability: K
  ): import('../shared/types/storage').IStorageProvider {
    const provider = this.storageRegistry.get(providerId);
    if (!provider) {
      throw new Error(`Storage provider not found: ${providerId}`);
    }
    if (typeof provider[capability] !== 'function') {
      throw new Error(`Storage provider "${providerId}" does not support "${String(capability)}"`);
    }
    return provider;
  }

  /**
   * Resolves the effective smartcard PIN-caching mode (profile override, else
   * the global default) and stamps it onto the config so downstream code
   * (SSHPtyManager, the dotfiles-sync scheduling above) can act on it without
   * each needing their own settings lookup. A no-op for non-smartcard auth.
   */
  /**
   * For smartcard profiles in 'agent-per-session' mode, loads the card into
   * a private ssh-agent *before* the PTY is spawned (prompting for the PIN
   * once via the normal askpass UI), and returns a config pointing the PTY
   * at that agent via IdentityAgent instead of a direct -I login.
   *
   * This sequencing matters: PIV/PKCS#11 readers generally only support one
   * active transaction at a time, so if the PTY's own -I login and a
   * separately-loaded agent both talk to the card around the same moment,
   * they can collide and both fail. Loading the agent first and having the
   * PTY authenticate purely through it means only one process ever opens a
   * PKCS#11 session for a given connection.
   *
   * If loading the agent fails, this is a no-op — the PTY falls back to its
   * own direct -I login, and dotfiles sync (if any) prompts for its own PIN
   * independently.
   *
   * 'always-prompt' also goes through the per-session agent (see
   * resolveSmartcardAgentPath), on every platform: OpenSSH's
   * ssh-pkcs11-helper subprocess doesn't reliably route its PIN prompt
   * through our askpass server the way the plain account-password prompt
   * does, so a direct -I login can silently fall through to password auth
   * instead of ever asking for the card's PIN (observed on both Win32-OpenSSH
   * and Linux OpenSSH — ssh-pkcs11-helper doesn't trust our askpass chain
   * either way). Loading through ssh-add (which runs headless, with no
   * console, so askpass is used unconditionally) sidesteps that, while still
   * discarding the card the moment the session ends — a reconnect still
   * needs a fresh PIN, keeping 'always-prompt's "ask every time" contract.
   */
  /**
   * Restored tabs have their password/passphrase stripped from the persisted session state
   * (see sanitizePaneNode in the renderer) and get a fresh id per terminal, so a saved
   * credential is looked up again here by connection identity. Secrets never leave main.
   */
  public async restoreSavedSecrets(config: SSHConnectionConfig): Promise<SSHConnectionConfig> {
    const needsPassword = config.authType === 'password' && !config.password;
    const needsPassphrase = config.authType === 'privateKey' && !config.passphrase && !!config.privateKeyPath;
    if (!needsPassword && !needsPassphrase) return config;

    const { ssh } = await this.profileStore.getProfiles();
    const match = ssh.find(
      (p) =>
        p.host === config.host &&
        (p.port ?? 22) === (config.port ?? 22) &&
        p.username === config.username &&
        p.authType === config.authType &&
        (needsPassword ? !!p.password : p.privateKeyPath === config.privateKeyPath && !!p.passphrase)
    );
    if (!match) return config;
    return needsPassword ? { ...config, password: match.password } : { ...config, passphrase: match.passphrase };
  }

  public async resolveProxyJumpConfig<T extends { proxyJumpProfileId?: string; proxyJump?: string }>(
    config: T
  ): Promise<T> {
    if (!config.proxyJumpProfileId) return config;
    const profiles = await this.profileStore.getProfiles();
    const byId = new Map(profiles.ssh.map((p) => [p.id, p]));
    if (!byId.has(config.proxyJumpProfileId)) {
      sshLog.warn(`ProxyJump profile ${config.proxyJumpProfileId} not found; connecting ${config.proxyJump ? 'via the manual proxyJump string' : 'WITHOUT a jump host'}`
      );
    }
    return withResolvedProxyJump(config, (id) => byId.get(id));
  }

  /**
   * Opens (or reuses) the remote-profile-sync storage provider. Unlike the file manager's
   * STORAGE_CONNECT, the sync target used to be created straight from its saved config, so a
   * smartcard/FIDO2 target ignored the already-unlocked agent and opened its own PKCS#11 session
   * (often via a different library than the one the card was unlocked with) — surfacing a second
   * PIN prompt whose answer then fell through to a password prompt and failed.
   */
  public async getSyncProvider(target: StorageConnectConfig): ReturnType<StorageRegistry["getOrCreate"]> {
    // Windows-only: Linux keeps creating the sync provider straight from its saved config.
    if (process.platform !== 'win32' || target.type !== 'sftp' || !target.sftpConfig || this.storageRegistry.has(target.id)) {
      return await this.storageRegistry.getOrCreate(target);
    }
    let sftpConfig = await this.resolveProxyJumpConfig(target.sftpConfig);
    if (sftpConfig.authType === 'smartcard' && !sftpConfig.agentPath) {
      // Same physical card as an already-unlocked terminal/startup agent: reuse it rather than
      // opening a second PKCS#11 session (the card's PIV keys are the same whichever library
      // loaded them).
      const unlockedSocket = this.smartcard.unlockedPivSocket();
      if (unlockedSocket) {
        sftpConfig = { ...sftpConfig, agentPath: unlockedSocket };
      }
    }
    sftpConfig = await this.smartcard.prepareSftpSmartcardConfig(sftpConfig, target.id);
    sftpConfig = await this.smartcard.prepareFido2SftpConfig(sftpConfig, target.id);
    return await this.storageRegistry.getOrCreate({ ...target, sftpConfig });
  }


  /**
   * Checks the host's assigned dotfiles pool (if any) against the live
   * server and applies it per the profile's sync policy. A no-op unless the
   * feature is enabled globally and the profile has explicitly opted in with
   * both a pool and a policy — see AppSettings.dotfilesPoolEnabled and
   * SSHConnectionConfig.dotfilesSyncPolicy.
   */
  public async runDotfilesSyncCheck(sessionId: string, config: SSHConnectionConfig): Promise<void> {
    smartcardLog.info(`runDotfilesSyncCheck: firing for session ${sessionId}, poolId=${config.poolId}, policy=${config.dotfilesSyncPolicy}, agentPath=${config.agentPath ?? '(none — will load its own if smartcard)'}`
    );
    if (!config.poolId || !config.dotfilesSyncPolicy) return;

    if (config.authType === 'smartcard' && config.pkcs11LibPath && !config.agentPath) {
      if (this.smartcard.isInLoadCooldown(config.pkcs11LibPath)) {
        smartcardLog.info(`runDotfilesSyncCheck: skipping dotfiles sync for ${sessionId} (smartcard load failed recently)`
        );
        return;
      }
    }

    const settings = await this.settingsStore.getSettings();
    if (!settings.dotfilesPoolEnabled) return;

    const pool = await this.dotfilePoolStore.getPool(config.poolId);
    if (!pool || pool.files.length === 0) return;

    const session = this.sshPtyManager.getSession(sessionId);
    const controlPath = session?.controlPath;

    const { onPresenceRequested, onPresenceCleared } = this.makePresenceNotifier(
      sessionId,
      'Touch your security key to sync dotfiles...'
    );

    let provider: Awaited<ReturnType<DotfileSyncService['computeDiff']>>['provider'] | undefined;
    try {
      const diff = await this.dotfileSyncService.computeDiff(config, pool, {
        controlPath,
        onPresence: onPresenceRequested,
        onPresenceCleared,
      });
      provider = diff.provider;
      if (diff.entries.length === 0) {
        return;
      }

      const filesToApply = pool.files.filter((f) => diff.entries.some((e) => e.fileId === f.id));

      if (config.dotfilesSyncPolicy === 'ask') {
        const resolution = await this.promptDotfilesSync({
          sessionId,
          poolName: pool.name,
          hostLabel: `${config.username}@${config.host}`,
          entries: diff.entries,
        });

        if (resolution === 'ignore') {
          return;
        }
        if (resolution === 'always') {
          // `config` is the resolved runtime config (agent socket, resolved jump host, …); persist the
          // policy on the saved profile instead, so those runtime values never leak into it.
          const saved = (await this.profileStore.getProfiles()).ssh.find((p) => p.id === config.id);
          if (saved) await this.profileStore.saveSSH({ ...saved, dotfilesSyncPolicy: 'always' });
        }
      }
      // 'always' policy (either pre-set or just chosen above) falls through and applies silently.

      await this.dotfileSyncService.applyFiles(provider, filesToApply);
      this.sendDotfilesSyncStatus({ sessionId, status: 'updated', updatedCount: filesToApply.length });
    } catch (err) {
      this.sendDotfilesSyncStatus({
        sessionId,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      await provider?.disconnect?.().catch(() => {});
    }
  }

  private promptDotfilesSync(info: Omit<DotfilesSyncPromptEvent, 'id'>): Promise<DotfilesSyncResolution> {
    return new Promise((resolve) => {
      const webContents = this.getWebContents();
      if (!webContents || webContents.isDestroyed?.()) {
        resolve('ignore');
        return;
      }

      const id = crypto.randomUUID();
      this.pendingDotfilesSyncPrompts.set(id, { callback: resolve });

      const event: DotfilesSyncPromptEvent = { id, ...info };
      webContents.send(IPC_CHANNELS.DOTFILES_SYNC_PROMPT, event);
    });
  }

  private sendDotfilesSyncStatus(event: {
    sessionId: string;
    status: 'updated' | 'error';
    updatedCount?: number;
    error?: string;
  }): void {
    const webContents = this.getWebContents();
    if (webContents && !webContents.isDestroyed?.()) {
      webContents.send(IPC_CHANNELS.DOTFILES_SYNC_STATUS, event);
    }
  }


  public scheduleAutoSync(delayMs = 2000): void {
    if (this.autoSyncTimer) {
      clearTimeout(this.autoSyncTimer);
    }
    this.autoSyncTimer = setTimeout(async () => {
      this.autoSyncTimer = null;
      try {
        const config = await this.syncConfigStore.getConfig();
        if (!config.autoSync || !config.target) {
          return;
        }
        if (!(await this.ensureSyncUnlockedForAutoSync(config))) {
          return;
        }
        const provider = await this.getSyncProvider(config.target);
        await this.profileSyncService.pushToRemote(provider, config.remoteBasePath ?? '');
        await this.syncConfigStore.setLastSyncAt(new Date().toISOString());
        await this.pushSyncStatusToRenderer();
      } catch (err) {
        autosyncLog.warn('Background push failed:', err);
      }
    }, delayMs);
  }

  /**
   * Starts (or restarts) the periodic background pull, so machines pick up
   * changes pushed from elsewhere without the user having to open Settings
   * and click "Pull" themselves. Runs only while auto-sync is enabled — see
   * stopAutoPullTimer() for where it's torn down.
   */
  public startAutoPullTimer(): void {
    this.stopAutoPullTimer();
    this.autoPullTimer = setInterval(() => {
      void this.runAutoPull();
    }, IpcBridge.AUTO_PULL_INTERVAL_MS);
    // node's timer would otherwise keep the process alive just for this.
    this.autoPullTimer.unref?.();
  }

  public stopAutoPullTimer(): void {
    if (this.autoPullTimer) {
      clearInterval(this.autoPullTimer);
      this.autoPullTimer = null;
    }
  }

  private async runAutoPull(): Promise<void> {
    try {
      const config = await this.syncConfigStore.getConfig();
      if (!config.autoSync || !config.target) {
        this.stopAutoPullTimer();
        return;
      }
      if (!(await this.ensureSyncUnlockedForAutoSync(config))) {
        return;
      }
      const provider = await this.getSyncProvider(config.target);
      const result = await this.profileSyncService.pullFromRemote(provider, config.remoteBasePath ?? '');
      await this.syncConfigStore.setLastSyncAt(new Date().toISOString());
      if (result.sshNativeConflicts.length > 0) {
        // No interactive flow for a conflict discovered by a background pull
        // (the user may not even have Settings open) — surfaced in the log
        // instead; the conflict itself is never auto-resolved either way.
        autosyncLog.warn(`Background pull found ${result.sshNativeConflicts.length} known_hosts conflict(s), left unapplied.`
        );
      }
      await this.pushSyncStatusToRenderer();
    } catch (err) {
      autosyncLog.warn('Background pull failed:', err);
    }
  }

  private async pushSyncStatusToRenderer(): Promise<void> {
    const webContents = this.getWebContents();
    if (webContents && !webContents.isDestroyed?.()) {
      const status = await this.buildSyncStatus();
      webContents.send(IPC_CHANNELS.PROFILE_SYNC_STATUS, status);
    }
  }

  /**
   * Whether sync is unlocked for a background auto-sync/auto-pull cycle to
   * proceed — unlocking it via the linked smartcard first if it isn't.
   * Deliberately never attempts a text master-password prompt on its own
   * (unlike the smartcard PIN dialog, that's not something a user expects to
   * pop up unprompted); if no smartcard is linked, a locked sync just skips
   * this cycle exactly as before. A failed/declined auto-unlock attempt is
   * throttled (SMARTCARD_AUTO_UNLOCK_COOLDOWN_MS) so a persistently missing
   * card or a user who dismisses the prompt isn't re-nagged on every debounce
   * tick or pull interval.
   */
  private async ensureSyncUnlockedForAutoSync(config: SyncConfigData): Promise<boolean> {
    if (this.syncCryptoService.isUnlocked('topology') && this.syncCryptoService.isUnlocked('credentials')) {
      return true;
    }
    if (!config.smartcardSync) {
      return false;
    }
    if (Date.now() - this.lastSmartcardAutoUnlockAttempt < IpcBridge.SMARTCARD_AUTO_UNLOCK_COOLDOWN_MS) {
      return false;
    }
    this.lastSmartcardAutoUnlockAttempt = Date.now();
    try {
      await this.unlockWithSmartcardInternal(
        { pkcs11LibPath: config.smartcardSync.pkcs11LibPath },
        { skipAutoSyncSchedule: true }
      );
      return this.syncCryptoService.isUnlocked('topology') && this.syncCryptoService.isUnlocked('credentials');
    } catch (err) {
      autosyncLog.warn('Automatic smartcard unlock failed:', err);
      return false;
    }
  }

  public async buildSyncStatus(): Promise<ProfileSyncStatus> {
    const config = await this.syncConfigStore.getConfig();
    return {
      configured: !!config.target,
      target:
        config.target && (config.target.type === 'sftp' || config.target.type === 's3')
          ? { id: config.target.id, name: config.target.name, type: config.target.type }
          : undefined,
      targetConfig:
        config.target && (config.target.type === 'sftp' || config.target.type === 's3')
          ? {
              type: config.target.type,
              sftpConfig: config.target.sftpConfig,
              s3Config: config.target.s3Config,
            }
          : undefined,
      remoteBasePath: config.remoteBasePath,
      hasLocalSalts: !!(config.topologySaltBase64 && config.credentialsSaltBase64),
      topologyUnlocked: this.syncCryptoService.isUnlocked('topology'),
      credentialsUnlocked: this.syncCryptoService.isUnlocked('credentials'),
      lastSyncAt: config.lastSyncAt,
      comparison: this.profileSyncService.getLastComparison() ?? undefined,
      autoSync: Boolean(config.autoSync),
      smartcardLinked: Boolean(config.smartcardSync),
      smartcardLibPath: config.smartcardSync?.pkcs11LibPath,
      smartcardAvailable: (await SmartcardDetector.detectAvailableLibraries(undefined, { onlyExisting: true }).catch(() => [])).length > 0,
    };
  }

  /**
   * Unlocks sync via a linked hardware smartcard: loads the card into a
   * private agent, has it sign a challenge to prove possession, then derives
   * or unwraps the master passwords from that signature and unlocks through
   * the normal password path. Shared by the interactive profile-sync:unlock-
   * smartcard handler and ensureSyncUnlockedForAutoSync's background
   * auto-unlock — either way the PIN is requested through the same in-app
   * dialog (promptForPinDirect), never silently.
   */
  public async unlockWithSmartcardInternal(
    options?: { pkcs11LibPath?: string; pin?: string },
    unlockOptions?: { skipAutoSyncSchedule?: boolean }
  ): Promise<ProfileSyncStatus> {
    const config = await this.syncConfigStore.getConfig();
    if (!config.target) {
      throw new Error('Configure a sync target first (profile-sync:setup)');
    }

    let libPath = options?.pkcs11LibPath || config.smartcardSync?.pkcs11LibPath;
    if (!libPath) {
      const preferredLib = (await this.settingsStore.getSettings()).smartcardLibPath;
      if (preferredLib && (await SmartcardDetector.validateLibraryPath(preferredLib))) {
        libPath = preferredLib;
      }
    }
    if (!libPath) {
      const detected = await SmartcardDetector.detectAvailableLibraries(undefined, { onlyExisting: true });
      if (detected.length === 0) {
        throw new Error('No smartcard libraries detected. Please ensure your card reader / PKCS#11 module is installed.');
      }
      libPath = detected[0].path;
    }

    const pinHandler = async (_prompt: string, retry?: AskpassPromptRetryContext) => {
      if (options?.pin && !retry) return options.pin;
      return await this.promptForPinDirect(
        'Enter your smartcard PIN to unlock Remote Profile Sync:',
        'smartcard',
        undefined,
        retry
      );
    };

    const settings = await this.settingsStore.getSettings();
    const mode = settings.smartcardAuthMode ?? 'always-prompt';

    let socketPath: string;
    let privateAgentPid: number | undefined;

    // Windows only: there several PKCS#11 modules for one card (opensc-pkcs11 / onepin-opensc-pkcs11 /
    // libykcs11) share the single system agent; other platforms keep the plain per-library cache lookup.
    const unlockedSocket = await this.smartcard.getUnlockedCardSocket(libPath);
    const sameCardSocket =
      unlockedSocket || process.platform !== 'win32' || mode !== 'agent-global'
        ? undefined
        : await this.smartcard.findCachedGlobalAgentHoldingKey(config.smartcardSync?.keyBlobBase64);

    if (unlockedSocket) {
      socketPath = unlockedSocket;
    } else if (sameCardSocket) {
      socketPath = sameCardSocket;
    } else if (mode === 'agent-global') {
      socketPath = await this.smartcard.getOrLoadGlobalSmartcardAgent(libPath, pinHandler);
    } else {
      const agent = await this.smartcard.loadSmartcardIntoPrivateAgentWithPresence(libPath, pinHandler);
      socketPath = agent.socketPath;
      privateAgentPid = agent.pid;
    }

    try {
      const identities = this.smartcard.identitiesForLibrary(
        await getAgentIdentities(socketPath),
        libPath,
        privateAgentPid === undefined && !sameCardSocket
      );
      if (identities.length === 0) {
        throw new Error('No smartcard identities/certificates found on the card');
      }
      const chosen =
        identities.find(
          (id) =>
            (config.smartcardSync?.keyBlobBase64 && id.keyBlob.toString('base64') === config.smartcardSync.keyBlobBase64) ||
            (config.smartcardSync?.keyFingerprint &&
              crypto.createHash('sha256').update(id.keyBlob).digest('hex') === config.smartcardSync.keyFingerprint)
        ) || identities[0];

      const challenge = crypto.randomBytes(32);
      const sig = await signChallengeWithAgent(socketPath, chosen.keyBlob, challenge);
      const verified = verifyAgentSignature(chosen.keyBlob, challenge, sig);
      if (!verified) {
        throw new Error('Failed to verify cryptographic signature from smartcard. Please ensure the correct card is inserted.');
      }

      let topologyPassword = '';
      let credentialsPassword = '';

      if (config.smartcardSync?.wrappedPasswordsEncrypted) {
        try {
          const decrypted = decryptSecretValue(config.smartcardSync.wrappedPasswordsEncrypted);
          const parsed = JSON.parse(decrypted);
          topologyPassword = parsed.topologyPassword;
          credentialsPassword = parsed.credentialsPassword;
        } catch {
          throw new Error('Failed to decrypt saved sync passwords with OS keyring.');
        }
      } else if (config.smartcardSync?.wrappedPassword) {
        // Legacy format from an older sshs3 version: its wrapping key was
        // derived from a signature over a single-use random challenge,
        // which by construction can never be reproduced on a later unlock
        // (a fresh random challenge — and, for most ECDSA tokens, a fresh
        // nonce — on every call) — this can only ever fail. Don't bother
        // attempting it.
        throw new Error(
          'This smartcard was linked with an older, incompatible version of sshs3. Please re-link it in Settings.'
        );
      } else {
        // No saved passwords are linked to this card at all. There is no
        // stable secret derivable from a smartcard signature over a random,
        // single-use challenge (see the doc comment on KEY_DERIVATION_MESSAGE),
        // so derive it from a second signature over the fixed derivation
        // message instead — and refuse outright for an ECDSA key, whose
        // signature (and thus the derived secret) can't be reproduced
        // across separate unlocks on most PKCS#11 tokens.
        if (getKeyAlgorithm(chosen.keyBlob).startsWith('ecdsa-sha2-')) {
          throw new Error(
            'No saved sync passwords are linked to this smartcard, and its ECDSA key cannot derive a stable one on its own. Unlock Remote Profile Sync with your master passwords, then re-link the smartcard to save them.'
          );
        }
        const derivationSig = await signChallengeWithAgent(socketPath, chosen.keyBlob, KEY_DERIVATION_MESSAGE);
        const smartcardSecret = deriveSecretFromSignature(derivationSig);
        topologyPassword = smartcardSecret;
        credentialsPassword = smartcardSecret;
      }

      return await this.unlockSyncInternal({ topologyPassword, credentialsPassword }, unlockOptions);
    } catch (err) {
      this.smartcard.forgetGlobalCardAfterFailure(libPath, privateAgentPid);
      throw err;
    } finally {
      if (privateAgentPid !== undefined) {
        void AgentLifecycleManager.unloadCard(socketPath, libPath);
        AgentLifecycleManager.killPrivateAgent(privateAgentPid);
      }
    }
  }

  public async unlockSyncInternal(
    passwords: { topologyPassword: string; credentialsPassword: string },
    options?: { skipAutoSyncSchedule?: boolean }
  ): Promise<ProfileSyncStatus> {
    const config = await this.syncConfigStore.getConfig();
    if (!config.target) {
      throw new Error('Configure a sync target first (profile-sync:setup)');
    }
    const provider = await this.getSyncProvider(config.target);

    if (config.topologySaltBase64 && config.credentialsSaltBase64) {
      this.syncCryptoService.unlock(
        'topology',
        passwords.topologyPassword,
        Buffer.from(config.topologySaltBase64, 'base64')
      );
      this.syncCryptoService.unlock(
        'credentials',
        passwords.credentialsPassword,
        Buffer.from(config.credentialsSaltBase64, 'base64')
      );
      try {
        await this.profileSyncService.pullFromRemote(provider, config.remoteBasePath ?? '');
      } catch (err) {
        // unlock() only derives keys and never verifies them; a wrong master
        // password would otherwise stay cached and let the next push encrypt
        // (and overwrite) the remote data with the wrong key.
        if (err instanceof SyncDecryptionError) this.syncCryptoService.lock();
        throw err;
      }
      // Re-unlocking only pulls, never pushes — any local edits made while
      // locked would otherwise sit unpushed until the user notices and clicks
      // Push manually. Flush them now if auto-sync is on (scheduleAutoSync is
      // itself a no-op when it isn't, or when there's nothing new to push).
      // Skipped when called from ensureSyncUnlockedForAutoSync, which already
      // pushes/pulls itself right after unlocking — scheduling another one
      // here too would just double up that same request 500ms later.
      if (!options?.skipAutoSyncSchedule) {
        this.scheduleAutoSync(500);
      }
    } else {
      if (await this.profileSyncService.hasRemoteData(provider, config.remoteBasePath ?? '')) {
        throw new Error(
          'This sync target already has data pushed from another machine. Use profile-sync:pull to bootstrap this machine instead of profile-sync:enable.'
        );
      }
      const topologySalt = generateSalt();
      const credentialsSalt = generateSalt();
      this.syncCryptoService.unlock('topology', passwords.topologyPassword, topologySalt);
      this.syncCryptoService.unlock('credentials', passwords.credentialsPassword, credentialsSalt);
      await this.syncConfigStore.setSalts({ topologySalt, credentialsSalt });
      await this.profileSyncService.pushToRemote(provider, config.remoteBasePath ?? '');
    }

    await this.syncConfigStore.setLastSyncAt(new Date().toISOString());
    return await this.buildSyncStatus();
  }

  public getUpdateService(): UpdateService {
    if (!this.updateService) {
      this.updateService = new UpdateService({
        disabled: process.env.SSHS3_DISABLE_UPDATES === '1',
        confirmQuit: this.confirmQuit,
        getAutoCheck: async () => (await this.settingsStore.getSettings()).autoCheckUpdates !== false,
        send: (state) => {
          const webContents = this.getWebContents();
          if (webContents && !webContents.isDestroyed?.()) {
            webContents.send(IPC_CHANNELS.UPDATE_STATE, state);
          }
        },
      });
    }
    return this.updateService;
  }

  /** Starts the periodic update poll; called once the main window exists. */
  public startUpdateChecks(): void {
    this.getUpdateService().start();
  }


  private setupEventListeners(): void {
    this.onPtyData = ({ sessionId, data }) => {
      if (sessionId && this.activePresenceSessions.has(sessionId)) {
        this.activePresenceSessions.delete(sessionId);
        const webContents = this.getWebContents();
        if (webContents && !webContents.isDestroyed?.()) {
          const event: PresenceClearEvent = { sessionId };
          webContents.send(IPC_CHANNELS.PRESENCE_CLEAR, event);
        }
      }
      const webContents = this.getWebContents();
      if (webContents && !webContents.isDestroyed?.()) {
        webContents.send(IPC_CHANNELS.TERMINAL_DATA, sessionId, data);
      }
    };
    this.sshPtyManager.on('data', this.onPtyData);

    this.onPtyExit = ({ sessionId, exitCode, signal }) => {
      if (sessionId && this.activePresenceSessions.has(sessionId)) {
        this.activePresenceSessions.delete(sessionId);
        const webContents = this.getWebContents();
        if (webContents && !webContents.isDestroyed?.()) {
          const event: PresenceClearEvent = { sessionId };
          webContents.send(IPC_CHANNELS.PRESENCE_CLEAR, event);
        }
      }

      // Reject and remove any pending askpass prompts matching that sessionId
      for (const [id, prompt] of this.pendingAskpass.entries()) {
        if (prompt.sessionId === sessionId) {
          try {
            prompt.callback('');
          } catch {
            // Ignore callback error
          }
          this.pendingAskpass.delete(id);
        }
      }

      // Tear down any private smartcard agent that was pre-loaded for this session.
      void this.smartcard.cleanupSmartcardSessionAgent(sessionId);

      const webContents = this.getWebContents();
      if (webContents && !webContents.isDestroyed?.()) {
        const event: SSHPtyExitEvent = { exitCode, signal };
        webContents.send(IPC_CHANNELS.TERMINAL_EXIT, sessionId, event);
      }
    };
    this.sshPtyManager.on('exit', this.onPtyExit);

    this.onPtyAskpass = ({ sessionId, prompt, kind, context, retry, callback }) => {
      const id = crypto.randomUUID();
      this.pendingAskpass.set(id, { sessionId, callback });
      if (sessionId) {
        this.activePresenceSessions.add(sessionId);
      }

      const webContents = this.getWebContents();
      if (webContents && !webContents.isDestroyed?.()) {
        webContents.send(IPC_CHANNELS.ASKPASS_PROMPT, {
          id,
          prompt,
          sessionId,
          kind,
          context,
          error: retry?.error,
          attempt: retry?.attempt,
          maxAttempts: retry?.maxAttempts,
        });
      }
    };
    this.sshPtyManager.on('askpass', this.onPtyAskpass);

    this.onPtyPresence = ({ sessionId, prompt }) => {
      const id = crypto.randomUUID();
      if (sessionId) {
        this.activePresenceSessions.add(sessionId);
      }
      const webContents = this.getWebContents();
      if (webContents && !webContents.isDestroyed?.()) {
        const message = /touch/i.test(prompt) ? prompt : 'Touch your security key to confirm';
        const event: PresencePromptEvent = { id, sessionId, message };
        webContents.send(IPC_CHANNELS.PRESENCE_PROMPT, event);
      }
    };
    this.sshPtyManager.on('presence', this.onPtyPresence);

    this.sshPtyManager.on('reconnecting', ({ sessionId, attempt, maxAttempts }) => {
      const webContents = this.getWebContents();
      if (webContents && !webContents.isDestroyed?.()) {
        webContents.send(IPC_CHANNELS.TERMINAL_RECONNECTING, sessionId, { attempt, maxAttempts });
      }
    });

    this.onTransferProgress = (progress) => {
      const webContents = this.getWebContents();
      if (webContents && !webContents.isDestroyed?.()) {
        webContents.send(IPC_CHANNELS.TRANSFER_PROGRESS, progress);
      }
    };
    this.transferQueue.on('progress', this.onTransferProgress);

    this.onK8sTerminalData = ({ sessionId, data }) => {
      const webContents = this.getWebContents();
      if (webContents && !webContents.isDestroyed?.()) {
        webContents.send(IPC_CHANNELS.K8S_TERMINAL_DATA, sessionId, data);
      }
    };
    this.k8sTerminalManager.on('data', this.onK8sTerminalData);

    this.onK8sTerminalExit = ({ sessionId, status }) => {
      const webContents = this.getWebContents();
      if (webContents && !webContents.isDestroyed?.()) {
        webContents.send(IPC_CHANNELS.K8S_TERMINAL_EXIT, sessionId, { status });
      }
    };
    this.k8sTerminalManager.on('exit', this.onK8sTerminalExit);

    this.onK8sLogData = ({ sessionId, data }) => {
      const webContents = this.getWebContents();
      if (webContents && !webContents.isDestroyed?.()) {
        webContents.send(IPC_CHANNELS.K8S_LOG_DATA, sessionId, data);
      }
    };
    this.k8sLogManager.on('data', this.onK8sLogData);

    this.onK8sLogEnd = ({ sessionId }) => {
      const webContents = this.getWebContents();
      if (webContents && !webContents.isDestroyed?.()) {
        webContents.send(IPC_CHANNELS.K8S_LOG_END, sessionId);
      }
    };
    this.k8sLogManager.on('end', this.onK8sLogEnd);

    this.onK8sPortForwardChange = (activeForwards) => {
      const webContents = this.getWebContents();
      if (webContents && !webContents.isDestroyed?.()) {
        webContents.send(IPC_CHANNELS.K8S_PORT_FORWARD_EVENT, activeForwards);
      }
    };
    this.k8sPortForwardManager.on('change', this.onK8sPortForwardChange);

    this.onSshTunnelChange = (active) => {
      const webContents = this.getWebContents();
      if (webContents && !webContents.isDestroyed?.()) {
        webContents.send(IPC_CHANNELS.SSH_TUNNEL_EVENT, active);
      }
    };
    this.sshTunnelManager.on('change', this.onSshTunnelChange);

    this.onK8sConfigChanged = () => {
      const webContents = this.getWebContents();
      if (webContents && !webContents.isDestroyed?.()) {
        // Carries an optional warning (H8 code-review finding) when this
        // reload just introduced a new exec-auth user — see
        // K8sDiscoveryService.checkExecAuthChange.
        webContents.send(IPC_CHANNELS.K8S_CONFIG_CHANGED, this.k8sDiscoveryService.consumePendingExecAuthWarning());
      }
    };
    this.unsubscribeK8sConfig = this.k8sDiscoveryService.onConfigChanged(this.onK8sConfigChanged);
  }

  /**
   * Runs one awaited cleanup step of dispose() so a rejection or a hang in one manager
   * can neither skip the remaining cleanup nor block app quit.
   */
  private async disposeStep(label: string, step: () => Promise<void> | void): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(step),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            ipcLog.warn(`IpcBridge.dispose: ${label} did not finish within ${DISPOSE_STEP_TIMEOUT_MS} ms`);
            resolve();
          }, DISPOSE_STEP_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      ipcLog.warn(`IpcBridge.dispose: ${label} failed:`, err instanceof Error ? err.message : err);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Empties the clipboard history when the "empty on exit" setting is on. */
  public async clearClipboardHistoryIfConfigured(): Promise<void> {
    const settings = await this.settingsStore.getSettings();
    if (settings.clipboardHistoryClearOnExit) {
      await this.clipboardHistoryStore.clear();
    }
  }

  public async dispose(): Promise<void> {
    this.updateService?.dispose();

    for (const channel of this.handlers) {
      this.ipcMain.removeHandler(channel);
    }
    this.handlers.clear();
    // After the handlers are gone no late selection can be added behind this clear.
    await this.disposeStep('clear clipboard history', () => this.clearClipboardHistoryIfConfigured());

    if (this.onPtyData) {
      this.sshPtyManager.off('data', this.onPtyData);
    }
    if (this.onPtyExit) {
      this.sshPtyManager.off('exit', this.onPtyExit);
    }
    if (this.onPtyAskpass) {
      this.sshPtyManager.off('askpass', this.onPtyAskpass);
    }
    if (this.onPtyPresence) {
      this.sshPtyManager.off('presence', this.onPtyPresence);
    }
    if (this.onTransferProgress) {
      this.transferQueue.off('progress', this.onTransferProgress);
    }
    this.transferQueue?.cancelAll?.();

    if (this.onK8sTerminalData) {
      this.k8sTerminalManager.off('data', this.onK8sTerminalData);
    }
    if (this.onK8sTerminalExit) {
      this.k8sTerminalManager.off('exit', this.onK8sTerminalExit);
    }
    await this.disposeStep('k8sTerminalManager.killAll', () => this.k8sTerminalManager.killAll());

    if (this.onK8sLogData) {
      this.k8sLogManager.off('data', this.onK8sLogData);
    }
    if (this.onK8sLogEnd) {
      this.k8sLogManager.off('end', this.onK8sLogEnd);
    }
    await this.disposeStep('k8sLogManager.stopAll', () => this.k8sLogManager.stopAll());

    if (this.onK8sPortForwardChange) {
      this.k8sPortForwardManager.off('change', this.onK8sPortForwardChange);
    }
    await this.disposeStep('k8sPortForwardManager.stopAll', () => this.k8sPortForwardManager.stopAll());

    if (this.onSshTunnelChange) {
      this.sshTunnelManager.off('change', this.onSshTunnelChange);
    }
    // Awaited (unlike the other managers' stopAll() calls above): dispose() is itself awaited by
    // app 'before-quit' before app.quit() runs, so this is what actually guarantees every standalone
    // tunnel process is signalled before the app exits on a normal quit.
    await this.disposeStep('sshTunnelManager.stopAll', () => this.sshTunnelManager.stopAll());

    if (this.unsubscribeK8sConfig) {
      this.unsubscribeK8sConfig();
      this.unsubscribeK8sConfig = undefined;
    }

    for (const prompt of this.pendingAskpass.values()) {
      try {
        prompt.callback('');
      } catch {
        // Ignore
      }
    }
    this.pendingAskpass.clear();

    for (const prompt of this.pendingHostKeyPrompts.values()) {
      try {
        prompt.callback(false);
      } catch {
        // Ignore
      }
    }
    this.pendingHostKeyPrompts.clear();

    for (const prompt of this.pendingTransferConflicts.values()) {
      try {
        prompt.callback('skip', false);
      } catch {
        // Ignore
      }
    }
    this.pendingTransferConflicts.clear();

    for (const prompt of this.pendingQuitConfirms.values()) {
      try {
        prompt.callback(true);
      } catch {
        // Ignore
      }
    }
    this.pendingQuitConfirms.clear();

    for (const prompt of this.pendingDotfilesSyncPrompts.values()) {
      try {
        prompt.callback('ignore');
      } catch {
        // Ignore
      }
    }
    this.pendingDotfilesSyncPrompts.clear();

    for (const pending of this.pendingAwsSsoLogins.values()) {
      try {
        pending.cancel();
      } catch {
        // Ignore
      }
    }
    this.pendingAwsSsoLogins.clear();

    await this.sshPtyManager.killAll();
    await this.storageRegistry.disconnectAll?.();
    await this.fileEditorService.dispose();
    this.fileTailService.dispose();
    this.searchOrchestrator.dispose();
    if (this.autoSyncTimer) {
      clearTimeout(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
    this.stopAutoPullTimer();
    // The PTY-exit listener that normally drives cleanupSmartcardSessionAgent()
    // was already detached above, so killAll() won't trigger it — kill every
    // remaining per-session ('agent-per-session' mode) private agent explicitly,
    // in addition to the global ones, or their ssh-agent processes and sockets
    // under ~/.ssh/agent leak past app quit.
    await this.smartcard.dispose();
    AgentLifecycleManager.killAllPrivateAgents();
    await AgentLifecycleManager.stopManagedAgent();
    await XServerManager.stopServer();
  }
}
