import crypto from 'node:crypto';
import { describeFido2StartupError, sessionUsesAuthType } from '../ipc/ipcHelpers';
import { AgentLifecycleManager } from '../ssh/AgentLifecycleManager';
import { AppAgent, KeysLockedWhileLoadingError, fingerprintOfKeyBlob } from '../ssh/AppAgent';
import { assignHostAliases, type AgentHostEntry } from '../services/SshNativeFileMerger';
import { SmartcardDetector } from './SmartcardDetector';
import { loadSmartcardIntoPrivateAgent, loadFido2ResidentKeysIntoPrivateAgent, pinPromptKind } from './SmartcardAgentLoader';
import type { AskpassPromptHandler, AskpassPromptRetryContext, AskpassServer } from './AskpassServer';
import { isSmartcardTokenPresent, readSmartcardCertificates } from './SmartcardCertificateReader';
import { isFido2DeviceConnected } from './Fido2DeviceDetector';
import type { SmartcardCertificateDetails } from './CertificateParser';
import { getAgentIdentities, getKeyAlgorithm } from './SmartcardSyncService';
import { parseSshWirePublicKey, type SshWireKeyInfo } from '../ca/sshPublicKeyFormat';
import type { SshCaService } from '../ca/SshCaService';
import { IPC_CHANNELS, type AskpassPromptKind } from '../../shared/types/ipc';
import type { SSHConnectionConfig, CachedSmartcardAgent } from '../../shared/types/ssh';
import type { SFTPConfig } from '../../shared/types/storage';
import type { SSHPtyManager } from '../ssh/SSHPtyManager';
import type { SettingsStore } from '../settings/SettingsStore';
import type { ProfileStore } from '../profile/ProfileStore';
import type { SessionStore } from '../session/SessionStore';
import type { SyncConfigStore } from '../services/SyncConfigStore';
import { createLogger } from '../log';
const appAgentLog = createLogger('app-agent');
const smartcardLog = createLogger('smartcard');
const fido2Log = createLogger('fido2');

/** What the coordinator needs from the rest of the app; it never imports IpcBridge. */
export interface SmartcardDeps {
  settingsStore: SettingsStore;
  profileStore: ProfileStore;
  sessionStore: SessionStore;
  syncConfigStore: SyncConfigStore;
  sshPtyManager: SSHPtyManager;
  getWebContents: () => Electron.WebContents | null | undefined;
  /** Prompts for a PIN/passphrase in the renderer (IpcBridge.promptForPinDirect). */
  promptForPin: (
    prompt: string,
    kind?: AskpassPromptKind,
    context?: string,
    retry?: AskpassPromptRetryContext
  ) => Promise<string>;
  /**
   * Shows an "insert your token" prompt until `isPresent` stops reporting false: true once the token is
   * there, false when the user cancelled (IpcBridge.waitForTokenDirect).
   */
  waitForToken: (
    kind: 'smartcard' | 'fido2',
    context: string | undefined,
    isPresent: () => Promise<boolean | undefined>
  ) => Promise<boolean>;
  makePresenceNotifier: (
    sessionId: string | undefined,
    message: string
  ) => { onPresenceRequested: () => void; onPresenceCleared: () => void };
  /** Clears a pending "touch your key" banner for a session, if one is showing. */
  clearPresence: (sessionId: string) => void;
  /** Rewrites (entries) or removes (null) the local-only agent block in ~/.ssh/config. */
  syncAgentBlock: (entries: AgentHostEntry[] | null) => Promise<void>;
}

/** The fields of an SSH or SFTP connection config that SSH CA routing reads and sets. */
interface SshCaConnection {
  authType?: string;
  useSshCa?: boolean;
  agentPath?: string;
  certificateFile?: string;
  agentIdentityFiles?: string[];
}

/** Key of the FIDO2 resident keys in `globalCards` and the load/failure maps (PKCS#11 cards use their library path). */
const FIDO2_KEY = '__fido2__';
/** After a failed load of a card, wait this long before prompting for its PIN again. */
const LOAD_COOLDOWN_MS = 30_000;

/** The user dismissed the "insert your token" prompt: the connection must stop, not fall back to another PIN prompt. */
export class TokenNotInsertedError extends Error {
  constructor(kind: 'smartcard' | 'fido2') {
    super(kind === 'fido2' ? 'No security key inserted' : 'No smartcard inserted');
    this.name = 'TokenNotInsertedError';
  }
}

export class SmartcardCoordinator {
  /** sessionId -> the private ssh-agent pre-loaded with a smartcard for 'agent-per-session' mode. */
  private smartcardSessionAgents = new Map<
    string,
    { pid: number; socketPath: string } & (
      | { kind: 'pkcs11'; pkcs11LibPath: string }
      | { kind: 'fido2'; askpassServer?: AskpassServer }
    )
  >();

  /**
   * The one app-wide ssh-agent for 'agent-global' mode (see AppAgent): every unlocked smartcard and
   * FIDO2 key lives in it, so a local shell can use all of them through a single SSH_AUTH_SOCK.
   */
  private appAgent = new AppAgent();

  /** pkcs11LibPath or '__fido2__' -> what that unlocked card/key contributed to the app agent (its key fingerprints), so keys can be attributed to a card. */
  private globalCards = new Map<string, { fingerprints: Set<string> }>();

  private agentConfigRefresh: Promise<void> = Promise.resolve();

  /** pkcs11LibPath or '__fido2__' -> in-flight load, so concurrent connections to the same card don't each prompt separately. */
  private globalSmartcardAgentLoads = new Map<string, Promise<string>>();

  private globalSmartcardAgentFailures = new Map<string, number>();

  private startupUnlockPromise?: Promise<void>;
  private disposed = false;
  private sshCaService?: SshCaService;

  /**
   * pkcs11LibPath -> certificate details read once, right after the card is loaded into its
   * global agent, instead of on every "cached smartcard identities" dropdown open. Re-reading on
   * every open meant opening a fresh PKCS#11 session against the token on every click, which can
   * race the already-live ssh-agent session for the same module — some PKCS#11 providers (e.g.
   * Net iD) handle that contention far worse than others and have been observed to crash the
   * whole process instead of returning a clean error. Reading once, right after `ssh-add -s`
   * already proved the card is present and responsive, avoids that race entirely.
   */
  private globalSmartcardCerts = new Map<string, Map<string, SmartcardCertificateDetails>>();

  /**
   * pkcs11LibPath -> certificates read ahead of the first `ssh-add -s` of a startup unlock that loads several
   * modules. Reading a module's certificates opens its own PKCS#11 session against the token, which makes the
   * token drop the PIN login of any session another process (the agent's ssh-pkcs11-helper) already holds
   * ("agent refused operation" on the next signature, verified with libykcs11 after p11-kit-proxy). So every
   * module is read before any card is loaded, and the loader uses these instead of reading again.
   */
  private prefetchedSmartcardCerts = new Map<string, Map<string, SmartcardCertificateDetails>>();

  constructor(private readonly deps: SmartcardDeps) {
    // Prompts the app agent itself raises later (e.g. a verify-required FIDO2 signature) — loads
    // prompt through their own askpass server and never come through here.
    this.appAgent.setHandlers({
      promptHandler: (prompt, retry) =>
        this.deps.promptForPin(prompt.trim(), pinPromptKind(prompt), 'App ssh-agent', retry),
      onPresence: () => {
        const { onPresenceRequested, onPresenceCleared } = this.deps.makePresenceNotifier(
          undefined,
          'Touch your security key to continue'
        );
        onPresenceRequested();
        setTimeout(onPresenceCleared, 20_000).unref?.();
      },
    });
    this.appAgent.setOnExit(() => {
      this.globalCards.clear();
      this.globalSmartcardCerts.clear();
      this.refreshAgentSshConfig();
    });
  }

  // ---- Read-only facade for handlers and IpcBridge: the state above stays private ----

  /** Waits for a startup unlock that is still in flight; a failure is ignored (callers prompt again if they must). */
  public async awaitStartupUnlock(): Promise<void> {
    if (!this.startupUnlockPromise) return;
    try {
      await this.startupUnlockPromise;
    } catch {
      // The connection proceeds and prompts for the PIN itself if it needs to.
    }
  }

  /** The FIDO2 PIN prompt: through the renderer directly, or through the terminal session's askpass. */
  private fido2PinPrompt(
    sessionId: string,
    promptLabel: string,
    mode: 'pty' | 'direct'
  ): (rawPrompt: string, retry?: AskpassPromptRetryContext) => Promise<string> {
    return (rawPrompt, retry) =>
      mode === 'direct'
        ? this.deps.promptForPin(rawPrompt.trim(), 'fido2', promptLabel, retry)
        : this.deps.sshPtyManager.promptForPin(sessionId, rawPrompt.trim(), 'fido2', promptLabel, retry);
  }

  /** Starts the app agent if needed. Refuses after dispose(), so a prompt that resolves during quit cannot respawn it. */
  private ensureAgent(): Promise<string> {
    if (this.disposed) return Promise.reject(new Error('SmartcardCoordinator is disposed'));
    return this.appAgent.ensure();
  }

  /** Returns the app-wide SSH agent instance. */
  public getAppAgent(): AppAgent {
    return this.appAgent;
  }

  /** True when a PIV/PKCS#11 card (not just a FIDO2 key) is unlocked in the app agent. */
  private hasPivCard(): boolean {
    return Array.from(this.globalCards.keys()).some((key) => key !== FIDO2_KEY);
  }

  /**
   * The app agent's socket if this card (pkcs11LibPath, or FIDO2_KEY) is unlocked in it, else undefined.
   * Checking and starting the agent is one step on purpose: `ensure()` drops all card state when it has to
   * restart a dead agent, so the answer is re-checked afterwards.
   */
  public async getUnlockedCardSocket(libPath: string): Promise<string | undefined> {
    if (!this.globalCards.has(libPath)) return undefined;
    const socketPath = await this.ensureAgent();
    return this.globalCards.has(libPath) ? socketPath : undefined;
  }

  /** The app agent's socket when a PIV/PKCS#11 card (not just a FIDO2 key) is unlocked in it, else null. */
  public unlockedPivSocket(): string | null {
    return this.hasPivCard() ? this.appAgent.getSocketPath() : null;
  }

  /** The app agent's socket when any card or key is unlocked in it, else null. */
  public appAgentSocketIfUnlocked(): string | null {
    return this.globalCards.size > 0 ? this.appAgent.getSocketPath() : null;
  }

  /** The private per-session agents ('agent-per-session' mode) that are currently alive. */
  public listSessionAgents(): Array<{ kind: 'pkcs11' | 'fido2'; socketPath: string }> {
    return Array.from(this.smartcardSessionAgents.values()).map((entry) => ({
      kind: entry.kind,
      socketPath: entry.socketPath,
    }));
  }

  /** True while a recent failed load of this card (or FIDO2_KEY for the security key) blocks another PIN prompt. */
  public isInLoadCooldown(libPath: string): boolean {
    const failedAt = this.globalSmartcardAgentFailures.get(libPath);
    return Boolean(failedAt) && Date.now() - failedAt! < LOAD_COOLDOWN_MS;
  }

  /** App quit: ends every per-session agent, forgets the cards and takes the agent block out of ~/.ssh/config before the socket goes away. */
  public async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all(Array.from(this.smartcardSessionAgents.keys(), (id) => this.cleanupSmartcardSessionAgent(id)));
    this.globalCards.clear();
    this.globalSmartcardCerts.clear();
    // The socket is about to disappear: take the agent block out of ~/.ssh/config first.
    await this.agentConfigRefresh;
    await this.deps.syncAgentBlock(null).catch(() => {});
    await this.appAgent.shutdown();
  }

  public async prepareSmartcardConfig(config: SSHConnectionConfig): Promise<SSHConnectionConfig> {
    if (config.authType !== 'smartcard' || config.agentPath) {
      return config;
    }
    config = await this.withSmartcardLibPathFallback(config);
    if (!config.pkcs11LibPath) {
      return config;
    }

    // Pin the session id now so the askpass prompt below and the eventual
    // PTY session correlate to the same id.
    const sessionId = config.id || `ssh-${crypto.randomUUID()}`;
    const configWithId = { ...config, id: sessionId };

    const agentPath = await this.resolveSmartcardAgentPath(
      config.pkcs11LibPath,
      sessionId,
      `connect via SSH to ${config.name || config.host}`
    );
    return agentPath
      ? { ...configWithId, agentPath, ...(await this.agentIdentityFilesFor(agentPath, config.pkcs11LibPath)) }
      : configWithId;
  }

  /** A profile's own `pkcs11LibPath` always wins; falls back to this machine's configured
   * default (`AppSettings.smartcardLibPath`, Settings > Security & Smartcard) when the profile
   * doesn't set one — otherwise a smartcard profile with an empty library path connects with
   * PKCS11Provider silently disabled (`SmartcardDetector.buildSSHArguments`) instead of using
   * it. Lets a Team Vault shared smartcard profile (necessarily missing a driver path specific
   * to any one member's machine) actually work for every member without each of them editing
   * the profile individually — found via real-world use ("PKCS11Provider=none" on a freshly
   * shared profile). Every caller of `buildSSHArguments` routes through this method (or
   * `withSmartcardLibPathFallback` directly for SFTP) first, so the fallback only needs to live
   * here, not in `buildSSHArguments` itself. */
  private async withSmartcardLibPathFallback<T extends { pkcs11LibPath?: string }>(config: T): Promise<T> {
    if (config.pkcs11LibPath) return config;
    let fallback: string | undefined;
    try {
      fallback = (await this.deps.settingsStore.getSettings()).smartcardLibPath;
    } catch {
      return config;
    }
    return fallback ? { ...config, pkcs11LibPath: fallback } : config;
  }

  /**
   * For 'fido2' profiles using a discoverable/resident credential (no
   * privateKeyPath), loads every resident credential on the connected
   * security key into a private ssh-agent *before* the PTY is spawned, same
   * rationale as prepareSmartcardConfig: only one process should ever open a
   * session against the physical key at a time, and the PTY then just points
   * at that agent via IdentityAgent instead of needing a key file on disk.
   *
   * Always spawns a fresh private agent per session (no 'agent-global'-style
   * caching, unlike PIV) — resident FIDO2 credentials are rarer and the
   * caching machinery in resolveSmartcardAgentPath is keyed by PKCS#11
   * library path, which doesn't apply here. A follow-up can add caching if
   * repeated per-connection touches turn out to be annoying in practice.
   *
   * A non-resident 'fido2' profile (privateKeyPath set) is a no-op here —
   * OpenSSH's own `-i` handling already deals with `-sk` key files natively.
   */
  public async prepareFido2Config(config: SSHConnectionConfig): Promise<SSHConnectionConfig> {
    if (config.authType !== 'fido2' || !config.fido2Resident || config.agentPath) {
      return config;
    }

    const sessionId = config.id || `ssh-${crypto.randomUUID()}`;
    const configWithId = { ...config, id: sessionId };

    const agentPath = await this.resolveFido2AgentPath(
      sessionId,
      `connecting to ${config.name || config.host}`,
      'pty'
    );
    return agentPath ? { ...configWithId, agentPath, ...(await this.agentIdentityFilesFor(agentPath, FIDO2_KEY)) } : configWithId;
  }

  /**
   * Same agent-caching logic as prepareSmartcardConfig, applied to an SFTP connection (used by
   * the file manager's own STORAGE_CONNECT, which — unlike terminals — never went through
   * prepareSmartcardConfig, so it always spawned its own ephemeral PKCS#11 agent even when a
   * terminal already held the card open under 'agent-global'/'agent-per-session' mode. Spawning a
   * second, independent PKCS#11 session against the same physical reader collides with the one
   * already open ("agent refused operation"), since most PIV/CAC readers allow only one
   * transaction at a time.
   */
  public async prepareSftpSmartcardConfig(config: SFTPConfig, providerId: string): Promise<SFTPConfig> {
    if (config.authType !== 'smartcard' || config.agentPath) {
      return config;
    }
    config = await this.withSmartcardLibPathFallback(config);
    if (!config.pkcs11LibPath) {
      return config;
    }

    // Keyed by providerId so a matching STORAGE_DISCONNECT can tear down the
    // same 'agent-per-session' agent this connection loaded.
    const agentPath = await this.resolveSmartcardAgentPath(
      config.pkcs11LibPath,
      providerId,
      `connect via SFTP to ${config.name || config.host}`
    );
    return agentPath
      ? { ...config, agentPath, ...(await this.agentIdentityFilesFor(agentPath, config.pkcs11LibPath)) }
      : config;
  }

  /** Same rationale as prepareFido2Config, applied to an SFTP connection (see prepareSftpSmartcardConfig). */
  public async prepareFido2SftpConfig(config: SFTPConfig, providerId: string): Promise<SFTPConfig> {
    if (config.authType !== 'fido2' || !config.fido2Resident || config.agentPath) {
      return config;
    }

    const agentPath = await this.resolveFido2AgentPath(
      providerId,
      `connecting via SFTP to ${config.name || config.host}`,
      'direct'
    );
    return agentPath ? { ...config, agentPath, ...(await this.agentIdentityFilesFor(agentPath, FIDO2_KEY)) } : config;
  }

  /** Sets the SSH CA service instance to retrieve active certificate files. */
  public setSshCaService(service: SshCaService): void {
    this.sshCaService = service;
  }

  /** Public key files pinning a connection to the first unlocked PIV card of the shared app agent (none if there is none). */
  private async pivIdentityFilesFor(socketPath: string): Promise<{ agentIdentityFiles?: string[] }> {
    for (const cardKey of this.globalCards.keys()) {
      if (cardKey === FIDO2_KEY) continue;
      const files = await this.agentIdentityFilesFor(socketPath, cardKey);
      if (files.agentIdentityFiles && files.agentIdentityFiles.length > 0) return files;
    }
    return {};
  }

  /**
   * Prepares an SSH connection config that uses SSH CA certificate authentication (`useSshCa`).
   * When `authType === 'agent'` and `useSshCa` is true:
   * 1. Routes the connection through the app-managed SSH agent socket holding the user certificate / PIV key.
   * 2. Attaches the signed certificate file (`-o CertificateFile=...`) if one is active (e.g. for PIV).
   * 3. For a PIV session only, attaches the PIV card's public key identity files (`agentIdentityFiles`)
   *    to restrict agent offerings; an ephemeral session's key is offered from the agent unrestricted.
   */
  public prepareSshCaConfig(config: SSHConnectionConfig): Promise<SSHConnectionConfig> {
    return this.applySshCa(config);
  }

  /** Same rationale as prepareSshCaConfig, applied to an SFTP connection. */
  public prepareSftpSshCaConfig(config: SFTPConfig): Promise<SFTPConfig> {
    return this.applySshCa(config);
  }

  private async applySshCa<T extends SshCaConnection>(config: T): Promise<T> {
    if (config.authType !== 'agent' || !config.useSshCa) {
      return config;
    }
    const certFile = this.sshCaService?.getActiveCertificateFilePath();
    const socketPath = config.agentPath ?? (await this.ensureAgent());
    const updated: T = {
      ...config,
      agentPath: socketPath,
      certificateFile: certFile ?? config.certificateFile,
    };
    // Only a PIV session (it has a certificate file) is pinned to the card's key. An ephemeral session's
    // certified key lives in the agent without any public-key file, and `IdentitiesOnly` + `-i <card>.pub`
    // would hide it from ssh even though it is the identity this connection needs.
    return certFile ? { ...updated, ...(await this.pivIdentityFilesFor(socketPath)) } : updated;
  }

  /**
   * Discovers and retrieves the OpenSSH public key for the connected smartcard (any PKCS#11 card, e.g. a YubiKey or another PIV card).
   * If not already unlocked in the app agent, attempts to unlock/load it first.
   */
  public async getPivPublicKey(): Promise<SshWireKeyInfo | null> {
    // 1. Check if an auth key is already present in the active app agent
    const socketPath = this.appAgent.getSocketPath();
    if (socketPath && this.hasPivCard()) {
      const identities = await getAgentIdentities(socketPath);
      for (const card of this.globalCards.values()) {
        const matching = identities.find(
          (id) => card.fingerprints.has(fingerprintOfKeyBlob(id.keyBlob)) && !getKeyAlgorithm(id.keyBlob).endsWith('-sk')
        );
        if (matching) {
          return parseSshWirePublicKey(matching.keyBlob, matching.comment);
        }
      }
    }

    // 2. Discover PIV library
    const preferred = (await this.deps.settingsStore.getSettings()).smartcardLibPath;
    const libs = await SmartcardDetector.detectAvailableLibraries(undefined, { onlyExisting: true });
    const chosen =
      (preferred ? libs.find((l) => l.path === preferred) : undefined) ??
      libs.find((l) => l.name === 'p11-kit') ??
      libs[0];

    if (!chosen) {
      throw new Error('No smartcard PKCS#11 module (e.g. OpenSC or libykcs11) detected on this system');
    }

    // 3. Ensure token is plugged in
    await this.ensureTokenPresent('smartcard', 'SSH CA authentication', chosen.path);

    // 4. Load into app agent (prompts for PIN if needed). An explicit user login
    // bypasses any previous background-failure cooldown on this library.
    this.globalSmartcardAgentFailures.delete(chosen.path);
    await this.getOrLoadGlobalSmartcardAgent(
      chosen.path,
      (prompt, retry) => this.deps.promptForPin(prompt.trim(), 'smartcard', 'SSH CA', retry),
      'unlock the smartcard for SSH CA'
    );

    // 5. Retrieve the loaded identity from the agent
    const liveSocket = this.appAgent.getSocketPath();
    if (!liveSocket) return null;

    const identities = await getAgentIdentities(liveSocket);
    const card = this.globalCards.get(chosen.path);
    if (!card) return null;

    const matching = identities.find(
      (id) => card.fingerprints.has(fingerprintOfKeyBlob(id.keyBlob)) && !getKeyAlgorithm(id.keyBlob).endsWith('-sk')
    );
    if (!matching) return null;

    return parseSshWirePublicKey(matching.keyBlob, matching.comment);
  }

  /**
   * When `agentPath` is the shared app agent (which holds every unlocked card), the public key files
   * that pin a connection to just this card's keys (see SSHConnectionConfig.agentIdentityFiles).
   * Empty for a private per-session agent, which holds only this card, and on Windows.
   */
  private async agentIdentityFilesFor(
    agentPath: string,
    cardKey: string
  ): Promise<{ agentIdentityFiles?: string[] }> {
    const card = this.globalCards.get(cardKey);
    if (!card || agentPath !== this.appAgent.getSocketPath()) return {};
    try {
      const files = await this.appAgent.writePublicKeyFiles(card.fingerprints);
      return files.length > 0 ? { agentIdentityFiles: files } : {};
    } catch (err) {
      appAgentLog.warn('could not write identity files; the connection will offer all agent keys:', err);
      return {};
    }
  }

  /**
   * Makes sure the card / security key is plugged in before anything asks for its PIN: when it is not,
   * the user gets an "insert your token" prompt that gives way to the PIN prompt once it is detected.
   * An unknown answer (presence can't be told) lets the load go ahead as before. Throws
   * TokenNotInsertedError when the prompt is dismissed.
   */
  private async ensureTokenPresent(kind: 'smartcard' | 'fido2', context: string, pkcs11LibPath?: string): Promise<void> {
    const check = () => (pkcs11LibPath ? isSmartcardTokenPresent(pkcs11LibPath) : isFido2DeviceConnected());
    if ((await check()) !== false) return;
    smartcardLog.info(`${kind}: not plugged in; asking the user to insert it`);
    if (!(await this.deps.waitForToken(kind, context, check))) throw new TokenNotInsertedError(kind);
  }

  /**
   * For flows that talk to the PIV card without a PKCS#11 library of their own (Team Vault's
   * age-plugin-yubikey): waits for a card in the configured (or only / p11-kit) module. Nothing to
   * check against when no module can be picked, so that case goes ahead as before. Must run before
   * the caller takes the PKCS#11 lock, since the check takes it too.
   */
  public async ensureDefaultPivPresent(context: string): Promise<void> {
    const preferred = (await this.deps.settingsStore.getSettings()).smartcardLibPath;
    const libs = await SmartcardDetector.detectAvailableLibraries(undefined, { onlyExisting: true });
    const chosen =
      (preferred ? libs.find((lib) => lib.path === preferred) : undefined) ??
      libs.find((lib) => lib.name === 'p11-kit') ??
      (libs.length === 1 ? libs[0] : undefined);
    if (chosen) await this.ensureTokenPresent('smartcard', context, chosen.path);
  }

  /**
   * Resolves (loading it if necessary) the ssh-agent socket to use for a PKCS#11 library, per the
   * user's Settings > Security > Smartcard PIN Caching mode. Returns undefined only if loading the
   * agent fails — callers should then fall back to a direct `-I` login (SSH) or their own ephemeral
   * agent (SFTP), which still prompts for the PIN on its own.
   */
  private async resolveSmartcardAgentPath(
    pkcs11LibPath: string,
    sessionId: string,
    promptLabel: string
  ): Promise<string | undefined> {
    const settings = await this.deps.settingsStore.getSettings();
    const mode = settings.smartcardAuthMode ?? 'always-prompt';

    if (mode === 'agent-global') {
      try {
        return await this.getOrLoadGlobalSmartcardAgent(pkcs11LibPath, sessionId, promptLabel);
      } catch (err) {
        if (err instanceof TokenNotInsertedError) throw err;
        smartcardLog.warn(
          'SmartcardCoordinator: failed to load smartcard into the global agent, falling back to per-connection prompts:',
          err
        );
        return undefined;
      }
    }

    // 'always-prompt' is routed through the same per-session agent as 'agent-per-session' on
    // every platform — see the doc comment on prepareSmartcardConfig for why a direct -I login
    // can't reliably prompt for the card's PIN via ssh-pkcs11-helper. It's still discarded at
    // session end (never cached across connections), so 'always-prompt's "ask every time"
    // contract is unchanged — only *how* the PIN is collected differs from a direct -I login.
    if (mode !== 'agent-per-session' && mode !== 'always-prompt') {
      return undefined;
    }

    smartcardLog.info(`resolveSmartcardAgentPath: starting shared-agent preload for session ${sessionId}`);
    try {
      const { pid, socketPath } = await this.loadSmartcardIntoPrivateAgentWithPresence(
        pkcs11LibPath,
        () => this.deps.sshPtyManager.promptForPin(sessionId, `Enter your smartcard PIN to ${promptLabel}:`, 'smartcard', promptLabel),
        sessionId,
        promptLabel
      );
      smartcardLog.info(`resolveSmartcardAgentPath: shared agent loaded OK for session ${sessionId}, pid=${pid}, socket=${socketPath}`
      );
      this.smartcardSessionAgents.set(sessionId, { pid, socketPath, kind: 'pkcs11', pkcs11LibPath });
      return socketPath;
    } catch (err) {
      if (err instanceof TokenNotInsertedError) throw err;
      smartcardLog.warn(
        'SmartcardCoordinator: failed to load smartcard into a private session agent, falling back to per-connection prompts:',
        err
      );
      return undefined;
    }
  }

  /**
   * Resolves (loading it if necessary) the ssh-agent socket to use for FIDO2 resident keys,
   * per the user's Settings > Security & Smartcard > Smartcard & Security Key PIN Caching mode.
   */
  private async resolveFido2AgentPath(
    sessionId: string,
    promptLabel: string,
    pinPromptKind: 'pty' | 'direct' = 'pty'
  ): Promise<string | undefined> {
    const settings = await this.deps.settingsStore.getSettings();
    const mode = settings.smartcardAuthMode ?? 'always-prompt';

    if (mode === 'agent-global') {
      try {
        return await this.getOrLoadGlobalFido2Agent(sessionId, promptLabel, pinPromptKind);
      } catch (err) {
        if (err instanceof TokenNotInsertedError) throw err;
        smartcardLog.warn(
          'SmartcardCoordinator: failed to load FIDO2 resident keys into the global agent, falling back to per-connection prompts:',
          err
        );
        return undefined;
      }
    }

    if (mode !== 'agent-per-session' && mode !== 'always-prompt') {
      return undefined;
    }

    fido2Log.info(`resolveFido2AgentPath: starting shared-agent preload for session ${sessionId}`);
    await this.ensureTokenPresent('fido2', promptLabel);
    const { onPresenceRequested, onPresenceCleared } = this.deps.makePresenceNotifier(
      sessionId,
      'Touch your security key to connect'
    );
    try {
      const promptPin = this.fido2PinPrompt(sessionId, promptLabel, pinPromptKind);

      const { pid, socketPath, askpassServer } = await loadFido2ResidentKeysIntoPrivateAgent(
        promptPin,
        { onPresenceRequested, onPresenceCleared, keepAskpassAliveForAgentLifetime: true }
      );
      this.smartcardSessionAgents.set(sessionId, { pid, socketPath, kind: 'fido2', askpassServer });
      return socketPath;
    } catch (err) {
      smartcardLog.warn('SmartcardCoordinator: failed to load FIDO2 resident keys into a private session agent:', err);
      return undefined;
    }
  }

  /**
   * Returns the app agent's socket after making sure the given PKCS#11 library's card is loaded into
   * it (prompting for the PIN once if it isn't). Concurrent callers for the same library share the
   * same in-flight load rather than each prompting separately.
   */
  public async getOrLoadGlobalSmartcardAgent(
    pkcs11LibPath: string,
    sessionIdOrPinPrompt: string | AskpassPromptHandler,
    promptLabel?: string
  ): Promise<string> {
    const unlockedSocket = await this.getUnlockedCardSocket(pkcs11LibPath);
    if (unlockedSocket) {
      smartcardLog.info(`getOrLoadGlobalSmartcardAgent: reusing the app agent for ${pkcs11LibPath}`);
      return unlockedSocket;
    }

    if (this.isInLoadCooldown(pkcs11LibPath)) {
      smartcardLog.info(`getOrLoadGlobalSmartcardAgent: skipping load for ${pkcs11LibPath} (failed recently)`);
      throw new Error(`Smartcard load for ${pkcs11LibPath} failed recently; cooling down`);
    }

    const inFlight = this.globalSmartcardAgentLoads.get(pkcs11LibPath);
    if (inFlight) {
      smartcardLog.info(`getOrLoadGlobalSmartcardAgent: awaiting in-flight load for ${pkcs11LibPath}`);
      return await inFlight;
    }

    smartcardLog.info(`getOrLoadGlobalSmartcardAgent: loading ${pkcs11LibPath} into the app agent`);
    const pinHandler =
      typeof sessionIdOrPinPrompt === 'function'
        ? sessionIdOrPinPrompt
        : (_prompt: string, retry?: AskpassPromptRetryContext) =>
            this.deps.sshPtyManager.promptForPin(
              sessionIdOrPinPrompt,
              `Enter your smartcard PIN to ${promptLabel}:`,
              'smartcard',
              promptLabel,
              retry
            );

    // Windows: loads of different modules must not overlap, or one sees the other's freshly added keys
    // as stale (globalCards is only filled at the end of a load) and evicts them. Captured before this
    // load registers itself, so it only waits for loads that started earlier.
    const earlierLoads = process.platform === 'win32' ? [...this.globalSmartcardAgentLoads.values()] : [];
    const loadPromise = (async () => {
      await Promise.allSettled(earlierLoads);
      // The startup unlock passes no label: it has already checked presence itself.
      if (promptLabel !== undefined) {
        await this.ensureTokenPresent('smartcard', promptLabel, pkcs11LibPath);
      }
      // Read the certificate details *before* handing the module to `ssh-add -s` below (see
      // the doc comment on `globalSmartcardCerts` for why we want them at all). This must run
      // strictly before, not concurrently with or fire-and-forget after: once `ssh-add -s`
      // succeeds, the agent keeps the PKCS#11 module initialized and the token open for as long
      // as it lives, and opening a second, independent PKCS#11 session against the same physical
      // token from this (separate) process while that first one is live crashed the vendor's
      // Net iD module outright (SIGTRAP inside the driver, observed right at startup's
      // auto-unlock). No PIN/session is needed to read certs (they're public objects, see
      // readSmartcardCertificates' doc comment), so doing this first is safe and guarantees
      // we're never more than one process talking to the token at a time.
      let certs = new Map<string, SmartcardCertificateDetails>();
      try {
        const prefetched = this.prefetchedSmartcardCerts.get(pkcs11LibPath);
        this.prefetchedSmartcardCerts.delete(pkcs11LibPath);
        certs = prefetched ?? (await readSmartcardCertificates(pkcs11LibPath));
        this.globalSmartcardCerts.set(pkcs11LibPath, certs);
      } catch (err) {
        smartcardLog.warn(`failed to read certificate details for ${pkcs11LibPath}:`, err);
      }
      await this.ensureAgent();
      const before = new Set((await this.appAgent.list()).map((i) => i.fingerprint));
      // The same physical card is often reachable through several modules (p11-kit-proxy proxies
      // libykcs11, OpenSC, …). If one of this module's keys is already in the agent, loading it again
      // would prompt for the PIN a second time and open a second PKCS#11 session against the same
      // token (which most readers reject), for keys the agent already holds.
      let alreadyLoaded = Array.from(certs.keys()).filter((fingerprint) => before.has(fingerprint));
      if (process.platform === 'win32' && alreadyLoaded.length > 0) {
        // The shared Windows ssh-agent service outlives this app, so a key still in it is left over
        // from an earlier run (or a manual `ssh-add`), not one this process unlocked — reusing it
        // would skip the PIN prompt and leave "lock" unable to evict it. Evict it and load afresh,
        // unless another module of this run already owns it.
        const owned = new Set<string>();
        for (const card of this.globalCards.values()) card.fingerprints.forEach((f) => owned.add(f));
        const stale = alreadyLoaded.filter((fingerprint) => !owned.has(fingerprint));
        if (stale.length > 0) {
          smartcardLog.info(`getOrLoadGlobalSmartcardAgent: evicting ${stale.length} stale key(s) left in the Windows ssh-agent to force a PIN prompt`);
          await this.appAgent.evictIdentities(stale);
          alreadyLoaded = alreadyLoaded.filter((fingerprint) => !stale.includes(fingerprint));
        }
      }
      const authFingerprints = await this.selectAuthFingerprints(certs);
      if (alreadyLoaded.length > 0) {
        smartcardLog.info(`getOrLoadGlobalSmartcardAgent: ${pkcs11LibPath} is the same card as one already loaded; not loading it again`
        );
        this.globalCards.set(pkcs11LibPath, { fingerprints: authFingerprints });
        this.refreshAgentSshConfig();
        return await this.ensureAgent();
      }
      await this.addSmartcardToAppAgentWithPresence(
        pkcs11LibPath,
        pinHandler,
        typeof sessionIdOrPinPrompt === 'string' ? sessionIdOrPinPrompt : undefined
      );
      const socketPath = await this.ensureAgent();
      // `ssh-add -s` loads every key the module exposes; drop the ones that must not be used or offered
      // (signing, key management, …) now, rather than leaving them in the shared agent.
      const unwanted = Array.from(certs.keys()).filter((fingerprint) => !authFingerprints.has(fingerprint));
      if (unwanted.length > 0) {
        const removed = await this.appAgent.removeIdentities(unwanted);
        smartcardLog.info(`${pkcs11LibPath}: removed ${removed} of ${unwanted.length} non-authentication key(s) from the app agent`);
      }
      // Which keys are this card's: its authentication certificates' fingerprints; if the certificates
      // couldn't be read, whatever this add contributed (excluding security keys, which belong to FIDO2).
      const fingerprints = new Set(authFingerprints);
      if (fingerprints.size === 0) {
        const nonSecurityKeys = (await this.appAgent.list()).filter((i) => !/-SK$/i.test(i.keyType));
        for (const i of nonSecurityKeys) {
          if (!before.has(i.fingerprint)) fingerprints.add(i.fingerprint);
        }
        // The add contributed nothing new (the same key was already there, e.g. loaded via another
        // module for the same card): attribute every non-security key rather than none at all.
        if (fingerprints.size === 0) nonSecurityKeys.forEach((i) => fingerprints.add(i.fingerprint));
      }
      this.globalCards.set(pkcs11LibPath, { fingerprints });
      // Windows: make lock/quit evict these by fingerprint (`ssh-add -e <lib>` is unreliable there).
      await this.appAgent.adoptIdentities(fingerprints);
      this.refreshAgentSshConfig();
      return socketPath;
    })();
    this.globalSmartcardAgentLoads.set(pkcs11LibPath, loadPromise);

    try {
      const socketPath = await loadPromise;
      this.globalSmartcardAgentFailures.delete(pkcs11LibPath);
      smartcardLog.info(`getOrLoadGlobalSmartcardAgent: loaded OK for ${pkcs11LibPath}, socket=${socketPath}`);
      return socketPath;
    } catch (err) {
      // A dismissed "insert your token" prompt is not a failed load: no cooldown before the next try.
      if (!(err instanceof TokenNotInsertedError) && !(err instanceof KeysLockedWhileLoadingError)) {
        this.globalSmartcardAgentFailures.set(pkcs11LibPath, Date.now());
      }
      throw err;
    } finally {
      this.globalSmartcardAgentLoads.delete(pkcs11LibPath);
    }
  }

  /**
   * Returns the app agent's socket after making sure the connected security key's FIDO2 resident
   * credentials are loaded into it (prompting for the PIN once if they aren't). Concurrent callers
   * share the same in-flight load rather than each prompting separately.
   */
  private async getOrLoadGlobalFido2Agent(
    sessionId: string,
    promptLabel: string,
    pinPromptKind: 'pty' | 'direct' = 'pty'
  ): Promise<string> {
    const unlockedSocket = await this.getUnlockedCardSocket(FIDO2_KEY);
    if (unlockedSocket) {
      fido2Log.info('getOrLoadGlobalFido2Agent: reusing the app agent');
      return unlockedSocket;
    }

    if (this.isInLoadCooldown(FIDO2_KEY)) {
      fido2Log.info('getOrLoadGlobalFido2Agent: skipping load (failed recently)');
      throw new Error('FIDO2 agent load failed recently; cooling down');
    }

    const inFlight = this.globalSmartcardAgentLoads.get(FIDO2_KEY);
    if (inFlight) {
      fido2Log.info('getOrLoadGlobalFido2Agent: awaiting in-flight load');
      return await inFlight;
    }

    fido2Log.info('getOrLoadGlobalFido2Agent: loading FIDO2 resident keys into the app agent');
    const { onPresenceRequested, onPresenceCleared } = this.deps.makePresenceNotifier(
      sessionId,
      'Touch your security key to connect'
    );

    const promptPin = this.fido2PinPrompt(sessionId, promptLabel, pinPromptKind);

    const loadPromise = (async () => {
      // The startup unlock has already checked for the key itself.
      if (sessionId !== 'startup') await this.ensureTokenPresent('fido2', promptLabel);
      await this.appAgent.addFido2Resident(promptPin, { onPresenceRequested, onPresenceCleared });
      const socketPath = await this.ensureAgent();
      // Every security-key (`*-SK`) identity in the agent belongs to FIDO2; PIV keys never are.
      const identities = await this.appAgent.list();
      this.globalCards.set(FIDO2_KEY, {
        fingerprints: new Set(identities.filter((i) => /-SK$/i.test(i.keyType)).map((i) => i.fingerprint)),
      });
      this.refreshAgentSshConfig();
      return socketPath;
    })();
    this.globalSmartcardAgentLoads.set(FIDO2_KEY, loadPromise);

    try {
      const socketPath = await loadPromise;
      this.globalSmartcardAgentFailures.delete(FIDO2_KEY);
      fido2Log.info(`getOrLoadGlobalFido2Agent: loaded OK, socket=${socketPath}`);
      return socketPath;
    } catch (err) {
      if (!(err instanceof TokenNotInsertedError) && !(err instanceof KeysLockedWhileLoadingError)) {
        this.globalSmartcardAgentFailures.set(FIDO2_KEY, Date.now());
      }
      throw err;
    } finally {
      this.globalSmartcardAgentLoads.delete(FIDO2_KEY);
    }
  }

  /**
   * Which of a card's certificates (by SSH fingerprint) this app may use and offer: the
   * authentication-capable ones. Never an empty set while the card has certificates — if none look
   * authentication-capable the heuristic is not trusted and every certificate is kept, as before. A key
   * already linked for smartcard sync is always kept, since sync unlock must keep finding it.
   */
  private async selectAuthFingerprints(certs: Map<string, SmartcardCertificateDetails>): Promise<Set<string>> {
    const auth = new Set<string>();
    for (const [fingerprint, details] of certs) {
      if (details.authCapable) auth.add(fingerprint);
    }
    if (auth.size === 0) {
      if (certs.size > 0) {
        smartcardLog.warn('no authentication-capable certificate found on the card; keeping all of them');
      }
      return new Set(certs.keys());
    }
    const linkedKey = await this.linkedSyncKeyFingerprint();
    if (linkedKey && certs.has(linkedKey)) auth.add(linkedKey);
    return auth;
  }

  /**
   * SSH fingerprint of the key linked for smartcard sync, if any. Links store the key blob and its
   * sha256 in hex; an older link may only have the latter, which is the same digest as the SSH
   * fingerprint (base64, no padding).
   */
  private async linkedSyncKeyFingerprint(): Promise<string | undefined> {
    try {
      const link = (await this.deps.syncConfigStore.getConfig()).smartcardSync;
      if (link?.keyBlobBase64) return fingerprintOfKeyBlob(Buffer.from(link.keyBlobBase64, 'base64'));
      if (link?.keyFingerprint && /^[0-9a-f]{64}$/i.test(link.keyFingerprint)) {
        return `SHA256:${Buffer.from(link.keyFingerprint, 'hex').toString('base64').replace(/=+$/, '')}`;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Reads the certificates of several PKCS#11 modules up front (see `prefetchedSmartcardCerts`). Skipped for a
   * single module, where nothing can be disturbed, and whenever the app agent already holds a PKCS#11 card:
   * reading now would break that card's session, so the loader falls back to reading as it goes.
   */
  private async prefetchSmartcardCertificates(libPaths: string[]): Promise<void> {
    if (libPaths.length < 2) return;
    if (this.hasPivCard()) return;
    for (const libPath of libPaths) {
      try {
        this.prefetchedSmartcardCerts.set(libPath, await readSmartcardCertificates(libPath));
      } catch (err) {
        smartcardLog.warn(`failed to read certificate details for ${libPath}:`, err);
      }
    }
  }

  /** Same presence banner as loadSmartcardIntoPrivateAgentWithPresence, but loading into the app agent. */
  private addSmartcardToAppAgentWithPresence(
    pkcs11LibPath: string,
    promptHandler: AskpassPromptHandler,
    sessionId?: string
  ): Promise<void> {
    const { onPresenceRequested, onPresenceCleared } = this.deps.makePresenceNotifier(
      sessionId,
      'Touch your YubiKey / smartcard to confirm'
    );
    return this.appAgent.addPkcs11(pkcs11LibPath, promptHandler, { onPresenceRequested, onPresenceCleared });
  }

  /**
   * Loads a PKCS#11 module into a private ssh-agent (see
   * `loadSmartcardIntoPrivateAgent`), additionally surfacing a
   * "touch your key" banner in the renderer for as long as the underlying
   * `ssh-add -s` looks like it's blocked waiting for a physical touch.
   * Every call site that spawns a private smartcard agent should
   * go through this instead of calling `loadSmartcardIntoPrivateAgent`
   * directly, so the banner appears consistently regardless of which flow
   * (interactive connect, background sync, vault unlock/link) triggered it.
   */
  public async loadSmartcardIntoPrivateAgentWithPresence(
    pkcs11LibPath: string,
    promptHandler: AskpassPromptHandler,
    sessionId?: string,
    /** What the card is for; when given, an unplugged card gets an "insert your token" prompt first. */
    context?: string
  ): ReturnType<typeof loadSmartcardIntoPrivateAgent> {
    if (context !== undefined) await this.ensureTokenPresent('smartcard', context, pkcs11LibPath);
    const { onPresenceRequested, onPresenceCleared } = this.deps.makePresenceNotifier(
      sessionId,
      'Touch your YubiKey / smartcard to confirm'
    );
    return loadSmartcardIntoPrivateAgent(pkcs11LibPath, promptHandler, { onPresenceRequested, onPresenceCleared });
  }

  /**
   * Keeps the local agent block in ~/.ssh/config (see writeAgentSshConfigBlock) in step with what is
   * unlocked, so a plain `ssh <alias>` in any terminal uses the app agent instead of asking for the
   * card's PIN itself. Serialized, fire-and-forget, never throws.
   */
  public refreshAgentSshConfig(): void {
    if (this.disposed) return;
    this.agentConfigRefresh = this.agentConfigRefresh
      .then(async () => {
        await this.deps.syncAgentBlock(await this.buildAgentHostEntries());
      })
      .catch((err) => appAgentLog.warn('could not refresh the ~/.ssh/config agent block:', err));
  }

  /**
   * Hosts to point at the app agent: SSH profiles whose card (PIV library, or FIDO2 resident key) is
   * unlocked in it. Null (⇒ block removed) unless 'agent-global' mode is on and the agent holds a card.
   * Not on Windows (shared OpenSSH service, no key selection there).
   */
  private async buildAgentHostEntries(): Promise<AgentHostEntry[] | null> {
    if (process.platform === 'win32') return null;
    const settings = await this.deps.settingsStore.getSettings().catch(() => null);
    const socketPath = this.appAgent.getSocketPath();
    if (settings?.smartcardAuthMode !== 'agent-global' || !socketPath || this.globalCards.size === 0) return null;

    const { ssh } = await this.deps.profileStore.getProfiles();
    const aliases = assignHostAliases(ssh);
    const entries: AgentHostEntry[] = [];
    const filesByCard = new Map<string, string[]>();
    for (const profile of ssh) {
      const cardKey =
        profile.authType === 'smartcard' && profile.pkcs11LibPath
          ? profile.pkcs11LibPath
          : profile.authType === 'fido2' && profile.fido2Resident
            ? FIDO2_KEY
            : undefined;
      const card = cardKey ? this.globalCards.get(cardKey) : undefined;
      const alias = aliases.get(profile.id);
      if (!card || !alias) continue;
      let identityFiles = filesByCard.get(cardKey!);
      if (!identityFiles) {
        identityFiles = await this.appAgent.writePublicKeyFiles(card.fingerprints);
        filesByCard.set(cardKey!, identityFiles);
      }
      if (identityFiles.length > 0) entries.push({ alias, agentSocket: socketPath, identityFiles });
    }
    return entries;
  }

  /**
   * The SSH_AUTH_SOCK a local shell should get under 'agent-global' PIN caching: always the app agent
   * (even while empty, so a card unlocked later is usable from terminals that are already open). On
   * Windows the app agent is the shared system service, so only hand it out once a card is cached.
   * Undefined in every other mode, or if the agent can't be started (the shell then keeps the default).
   */
  public async resolveLocalShellAgentSocket(smartcardAuthMode: string | undefined): Promise<string | undefined> {
    if (smartcardAuthMode !== 'agent-global') return undefined;
    if (process.platform === 'win32' && this.globalCards.size === 0) return undefined;
    try {
      return await this.ensureAgent();
    } catch (err) {
      appAgentLog.warn('could not start for a local shell; using the default agent:', err);
      return undefined;
    }
  }

  /**
   * 'agent-global' PIN caching + the opt-in "unlock at startup" setting: prompts
   * for security credentials (FIDO2 resident keys and/or smartcard PIN) and loads them
   * into app-lifetime global agents sequentially before terminal sessions start.
   * Concurrent terminal session restorations await this startup unlock so that
   * multiple connections never race against the physical security key hardware.
   */
  public async maybeUnlockSmartcardAtStartup(options: { force?: boolean } = {}): Promise<{ started: boolean }> {
    // Assign the guard promise synchronously, before any awaits, so a concurrent restored
    // terminal session's TERMINAL_CREATE (which awaits awaitStartupUnlock()) always has something to
    // wait on from the very first tick of this call — closing the TOCTOU gap where a restored pane could otherwise race ahead of the async
    // settings/profile/session detection below (previously done before the guard was assigned)
    // and fall through to a fresh PIN prompt, even though a startup unlock was about to happen.
    // The guard resolves once the real unlock work finishes (or immediately if none is needed);
    // it does NOT gate this function's own return, which still resolves as soon as detection
    // decides whether an unlock was started, same as before — callers of this IPC handler don't
    // wait for the PIN to actually be entered, only concurrent session creation does.
    let resolveGuard!: () => void;
    const ownGuard = new Promise<void>((resolve) => {
      resolveGuard = resolve;
    });
    // An unlock that is still waiting for the PIN must keep gating terminal/SFTP creation even if
    // another unlock request (e.g. clicking Unlock Now again) finishes sooner: chain, don't replace.
    const previousGuard = this.startupUnlockPromise;
    const guardPromise = previousGuard ? Promise.all([previousGuard, ownGuard]).then(() => undefined) : ownGuard;
    this.startupUnlockPromise = guardPromise;
    void guardPromise.finally(() => {
      if (this.startupUnlockPromise === guardPromise) {
        this.startupUnlockPromise = undefined;
      }
    });

    let unlockKickedOff = false;
    try {
      return await this.runSmartcardStartupUnlockWork((unlockPromise) => {
        unlockKickedOff = true;
        void unlockPromise.finally(resolveGuard);
      }, options.force);
    } finally {
      if (!unlockKickedOff) {
        resolveGuard();
      }
    }
  }

  /**
   * `force` is the on-demand "Unlock" action (top bar): it runs the same detection and unlock as the
   * startup flow but doesn't require the "unlock at startup" setting — the user asked for it now.
   */
  private async runSmartcardStartupUnlockWork(
    onUnlockStarted: (unlockPromise: Promise<void>) => void,
    force = false
  ): Promise<{ started: boolean }> {
    // An explicit retry must not be refused by the cooldown a just-failed (wrong/cancelled PIN) attempt set.
    if (force) this.globalSmartcardAgentFailures.clear();
    const settings = await this.deps.settingsStore.getSettings();
    if ((!settings.smartcardUnlockAtStartup && !force) || (settings.smartcardAuthMode ?? 'always-prompt') !== 'agent-global') {
      return { started: false };
    }

    const libs = await SmartcardDetector.detectAvailableLibraries(undefined, { onlyExisting: true });
    const preferred = settings.smartcardLibPath ? libs.find((lib) => lib.path === settings.smartcardLibPath) : undefined;
    const chosen =
      preferred ?? libs.find((lib) => lib.name === 'p11-kit') ?? (libs.length === 1 ? libs[0] : undefined);

    let hasFido2 = false;
    let hasSmartcard = Boolean(chosen);
    const targetSmartcardPaths = new Set<string>();

    try {
      const profiles = await this.deps.profileStore.getProfiles();
      if (profiles.ssh?.some((p) => p.authType === 'fido2')) {
        hasFido2 = true;
      }
      for (const p of profiles.ssh ?? []) {
        if (p.authType === 'smartcard') {
          hasSmartcard = true;
          if (p.pkcs11LibPath) {
            targetSmartcardPaths.add(p.pkcs11LibPath);
          }
        }
      }
    } catch {
      // Ignore profile read errors on startup
    }

    try {
      const session = await this.deps.sessionStore.getSession();
      if (sessionUsesAuthType(session, 'fido2')) hasFido2 = true;
      if (sessionUsesAuthType(session, 'smartcard')) hasSmartcard = true;
    } catch {
      // Ignore session read errors on startup
    }

    // A driver the user explicitly picked in Settings wins over the per-profile library paths:
    // otherwise an existing profile's own path (e.g. OpenSC) would silently override the choice and
    // unlock the wrong driver. Profiles using a different driver are still unlocked on demand.
    if (preferred) {
      targetSmartcardPaths.clear();
      targetSmartcardPaths.add(preferred.path);
      hasSmartcard = true;
    }

    // Fall back to detected library if smartcard is used but no specific library was saved in profiles
    if (targetSmartcardPaths.size === 0 && chosen) {
      targetSmartcardPaths.add(chosen.path);
    }

    // Filter to only libraries that exist on the system
    const existingLibPaths = new Set(libs.map((l) => l.path));
    const validPathsToUnlock: string[] = [];
    for (const libPath of targetSmartcardPaths) {
      if (existingLibPaths.has(libPath) || (await SmartcardDetector.validateLibraryPath(libPath))) {
        validPathsToUnlock.push(libPath);
      }
    }

    const pathsNeedingUnlock = validPathsToUnlock.filter(
      (p) => !this.globalCards.has(p) && !this.globalSmartcardAgentLoads.has(p)
    );

    // Windows' OpenSSH can't load resident FIDO2 keys (`ssh-add -K` always fails there), and its
    // FIDO2 profiles use a key file signed via WebAuthn instead — nothing to unlock at startup, so
    // don't ask for a PIN just to show an error.
    if (process.platform === 'win32') hasFido2 = false;

    if (!hasFido2 && (!hasSmartcard || validPathsToUnlock.length === 0)) {
      return { started: false };
    }

    const fido2Active = this.globalCards.has(FIDO2_KEY) || this.globalSmartcardAgentLoads.has(FIDO2_KEY);
    const smartcardActive = !hasSmartcard || pathsNeedingUnlock.length === 0;
    if ((!hasFido2 || fido2Active) && smartcardActive) {
      return { started: false };
    }

    const unlockPromise = (async () => {
      // 1. Smartcard / PIV unlock first (if detected and not yet active)
      if (hasSmartcard && pathsNeedingUnlock.length > 0) {
        try {
          smartcardLog.info(`Startup unlock: loading Smartcard into global agent for ${pathsNeedingUnlock.join(', ')}...`
          );
          let transientPin: string | null = null;
          const startupPinPrompt = async (_prompt: string, retry?: AskpassPromptRetryContext) => {
            if (!retry && transientPin !== null) {
              return transientPin;
            }
            transientPin = await this.deps.promptForPin(
              'Enter your smartcard PIN to unlock it for this app session:',
              'smartcard',
              'Startup: Global Agent Cache',
              retry
            );
            return transientPin;
          };

          try {
            // A PKCS#11 module can load (and ssh-add can ask for a PIN) with no card in the reader: only
            // prompt for modules that report a token. Unknown (undefined) keeps the old behavior.
            const loadable: string[] = [];
            for (const libPath of pathsNeedingUnlock) {
              if ((await isSmartcardTokenPresent(libPath)) === false) {
                smartcardLog.info(`Startup unlock: no card present for ${libPath}; skipping`);
              } else {
                loadable.push(libPath);
              }
            }
            await this.prefetchSmartcardCertificates(loadable);
            for (const libPath of loadable) {
              try {
                await this.getOrLoadGlobalSmartcardAgent(libPath, startupPinPrompt);
                this.sendSmartcardStartupUnlockStatus({ kind: 'smartcard', status: 'unlocked', libPath });
              } catch (err) {
                smartcardLog.warn(`Startup unlock failed for ${libPath}:`, err);
                this.sendSmartcardStartupUnlockStatus({
                  kind: 'smartcard',
                  status: 'error',
                  libPath,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
          } finally {
            transientPin = null;
            this.prefetchedSmartcardCerts.clear();
          }
        } catch (err) {
          smartcardLog.warn('Startup unlock failed or cancelled:', err);
        }
      }

      // 2. FIDO2 resident keys unlock last (if configured and not yet active). A FIDO2 key that needs
      // PIN+touch per signature (verify-required) can only be asked for one once it is in the agent, so
      // loading it after the PIV card keeps those prompts out of the way of the PIV load.
      if (hasFido2 && !this.globalCards.has(FIDO2_KEY) && !this.globalSmartcardAgentLoads.has(FIDO2_KEY)) {
        if ((await isFido2DeviceConnected()) === false) {
          fido2Log.info('Startup unlock: no security key connected; skipping');
          return;
        }
        try {
          fido2Log.info('Startup unlock: loading FIDO2 resident keys into global agent...');
          await this.getOrLoadGlobalFido2Agent('startup', 'Startup: Global Agent Cache', 'direct');
          this.sendSmartcardStartupUnlockStatus({ kind: 'fido2', status: 'unlocked' });
        } catch (err) {
          fido2Log.warn('Startup unlock failed or cancelled:', err);
          this.sendSmartcardStartupUnlockStatus({
            kind: 'fido2',
            status: 'error',
            error: describeFido2StartupError(err),
          });
        }
      }
    })();

    onUnlockStarted(unlockPromise);
    return { started: true };
  }

  /**
   * Kills the private per-session smartcard agent (if any) that was loaded for `sessionId` under
   * 'agent-per-session' mode (or 'always-prompt', which reuses the same per-session mechanism —
   * see resolveSmartcardAgentPath), whether that session was a terminal (PTY exit) or a file
   * manager SFTP connection (STORAGE_DISCONNECT).
   */
  public cleanupSmartcardSessionAgent(sessionId: string): Promise<void> {
    this.deps.clearPresence(sessionId);
    const entry = this.smartcardSessionAgents.get(sessionId);
    if (entry === undefined) return Promise.resolve();
    this.smartcardSessionAgents.delete(sessionId);
    let evicted: Promise<void> = Promise.resolve();
    if (entry.kind === 'pkcs11') {
      // Evict just this card first — killPrivateAgent() is a no-op on Windows
      // (the socket is the shared system agent service, not a process we own).
      // Returned so app quit can await it before the process exits.
      evicted = AgentLifecycleManager.unloadCard(entry.socketPath, entry.pkcs11LibPath);
    } else {
      // See loadFido2ResidentKeysIntoPrivateAgent's keepAskpassAliveForAgentLifetime: this
      // session's agent was given its own long-lived Askpass server so a *later* signature
      // request (not just the initial load) still prompts through this app's own PIN modal —
      // that server is never stopped anywhere else, so it must be torn down here or it leaks
      // for the rest of the app's process lifetime.
      void entry.askpassServer?.stop();
      if (process.platform === 'win32') {
        // Resident FIDO2 credentials have no library path to unload by, and `ssh-add -D`
        // would nuke every identity in the shared Windows agent service, including ones
        // unrelated apps loaded — so, unlike PKCS#11, there's currently no way to evict
        // just this session's credentials from that shared agent. They stay loaded until
        // the ssh-agent service itself is restarted. Non-Windows doesn't hit this: each
        // session gets its own freshly-spawned agent process, torn down below.
        smartcardLog.warn(
          `SmartcardCoordinator: session ${sessionId}'s FIDO2 resident credentials remain loaded in the shared Windows ssh-agent service (no per-credential eviction implemented yet)`
        );
      }
    }
    AgentLifecycleManager.killPrivateAgent(entry.pid);
    return evicted;
  }

  /**
   * The 'agent-global' mode's "lock card" action: makes the app agent forget every key, forcing the
   * next connection that needs any of those cards to prompt for the PIN again. The agent itself keeps
   * running, so its socket stays valid for terminals that are already open. Returns how many cards
   * were cached.
   */
  public async lockAllGlobalSmartcardAgents(): Promise<number> {
    const count = this.globalCards.size;
    await this.appAgent.lockAll();
    this.globalCards.clear();
    this.globalSmartcardCerts.clear();
    this.globalSmartcardAgentFailures.clear();
    this.refreshAgentSshConfig();
    return count;
  }

  /**
   * Reports what's currently cached under 'agent-global' PIN caching mode:
   * which PKCS#11 libraries have an unlocked agent, and which certificate(s)
   * each one is holding (queried live from the agent via `ssh-add -l`).
   *
   * Each identity is additionally enriched with X.509 certificate details
   * (subject, UPN, validity) — see `globalSmartcardCerts` for why those come
   * from a cache populated once at load time rather than a fresh PKCS#11
   * read on every call.
   */
  public async listGlobalSmartcardAgents(): Promise<CachedSmartcardAgent[]> {
    if (this.globalCards.size === 0) return [];
    // One agent holds every card, so attribute each identity to the card that contributed it.
    const rawIdentities = await this.appAgent.list();
    const identities = Array.isArray(rawIdentities) ? rawIdentities : [];
    return Array.from(this.globalCards.entries()).map(([pkcs11LibPath, cardInfo]) => {
      const fingerprints = cardInfo?.fingerprints ?? new Set<string>();
      const certsByFingerprint =
        this.globalSmartcardCerts.get(pkcs11LibPath) ?? new Map<string, SmartcardCertificateDetails>();
      const mine = identities.filter((identity) =>
        pkcs11LibPath === FIDO2_KEY ? /-SK$/i.test(identity.keyType) : fingerprints.has(identity.fingerprint)
      );
      return {
        pkcs11LibPath: pkcs11LibPath === FIDO2_KEY ? 'FIDO2 Security Key' : pkcs11LibPath,
        identities: (mine ?? []).map((identity) => {
          const cert = certsByFingerprint.get(identity.fingerprint);
          return cert
            ? {
                ...identity,
                certificate: {
                  subject: cert.subject,
                  issuer: cert.issuer,
                  validFrom: cert.validFrom,
                  validTo: cert.validTo,
                  upn: cert.upn,
                },
              }
            : identity;
        }),
      };
    });
  }

  /**
   * The global agent cache is keyed by PKCS#11 library path, but one physical card is often
   * reachable through several modules (e.g. OpenSC's opensc-pkcs11.dll and onepin-opensc-pkcs11.dll
   * on Windows) — so a sync link made against one module would otherwise miss the cache filled by
   * another and ask for the PIN a second time. Returns the socket of any already-cached global
   * PKCS#11 agent that holds the given key, so the caller can reuse it instead.
   */
  public async findCachedGlobalAgentHoldingKey(keyBlobBase64: string | undefined): Promise<string | undefined> {
    if (!keyBlobBase64 || !this.hasPivCard()) return undefined;
    const socketPath = this.appAgent.getSocketPath();
    if (!socketPath) return undefined;
    try {
      const identities = await getAgentIdentities(socketPath);
      return identities.some((id) => id.keyBlob.toString('base64') === keyBlobBase64) ? socketPath : undefined;
    } catch {
      return undefined; // Agent gone or unreachable.
    }
  }

  /**
   * Narrows an agent's identities to the ones belonging to `pkcs11LibPath` when they come from the
   * shared app agent, which holds every unlocked card: sync linking/unlocking signs with the first
   * identity it is given, and a key from another card would derive the wrong sync secret. A private
   * per-session agent only ever holds this one card's keys, so it is returned untouched.
   */
  public identitiesForLibrary<T extends { keyBlob: Buffer }>(
    identities: T[],
    pkcs11LibPath: string,
    fromAppAgent: boolean
  ): T[] {
    const card = this.globalCards.get(pkcs11LibPath);
    if (!fromAppAgent || !card) return identities;
    return identities.filter((id) => card.fingerprints.has(fingerprintOfKeyBlob(id.keyBlob)));
  }

  /** After a failed sync link/unlock: drop the card's keys from the app agent (never the agent itself). */
  public forgetGlobalCardAfterFailure(pkcs11LibPath: string, privateAgentPid: number | undefined): void {
    if (!this.globalCards.has(pkcs11LibPath) || privateAgentPid !== undefined) return;
    void this.appAgent.remove(pkcs11LibPath);
    this.globalCards.delete(pkcs11LibPath);
    this.globalSmartcardCerts.delete(pkcs11LibPath);
    this.refreshAgentSshConfig();
  }

  private sendSmartcardStartupUnlockStatus(event: {
    kind: 'smartcard' | 'fido2';
    status: 'unlocked' | 'error';
    libPath?: string;
    error?: string;
  }): void {
    const webContents = this.deps.getWebContents();
    if (webContents && !webContents.isDestroyed?.()) {
      webContents.send(IPC_CHANNELS.SMARTCARD_STARTUP_UNLOCK_STATUS, event);
    }
  }
}
