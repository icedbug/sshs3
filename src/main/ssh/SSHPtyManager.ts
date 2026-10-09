import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import * as nodePty from 'node-pty';
import type { IPty } from 'node-pty';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { SmartcardDetector } from '../smartcard/SmartcardDetector';
import { AskpassServer } from '../smartcard/AskpassServer';
import { AgentLifecycleManager } from './AgentLifecycleManager';
import { registerEntry, unregisterEntry } from './AgentRegistry';
import { K8sShimManager } from '../services/K8sShimManager';
import type { SettingsStore } from '../settings/SettingsStore';
import type {
  SSHConnectionConfig,
  PtyOptions,
  SSHPtyExitEvent,
  SSHPtySession,
  LocalShellType,
} from '../../shared/types/ssh';

/**
 * Resolves the local shell binary to spawn for `createShellSession`.
 * On Windows this honors the user's `shellType` choice (cmd/powershell/pwsh);
 * on macOS/Linux we always launch the user's own login shell ($SHELL), since
 * that's the one place there's no equivalent "which shell" choice to make.
 */
function resolveLocalShellBinary(shellType?: LocalShellType): string {
  if (process.platform !== 'win32') {
    return process.env.SHELL || '/bin/bash';
  }
  switch (shellType) {
    case 'powershell':
      return 'powershell.exe';
    case 'pwsh':
      return 'pwsh.exe';
    case 'wsl':
      return 'wsl.exe';
    case 'cmd':
      return 'cmd.exe';
    default:
      return process.env.COMSPEC || 'cmd.exe';
  }
}

function getSpawn(): typeof nodePty.spawn {
  if (typeof (nodePty as any).spawn === 'function') {
    return (nodePty as any).spawn;
  }
  if ((nodePty as any).default && typeof (nodePty as any).default.spawn === 'function') {
    return (nodePty as any).default.spawn;
  }
  throw new Error('node-pty spawn function not found');
}

import type { AskpassPromptKind } from '../../shared/types/ipc';
import { describeAskpassPrompt } from './askpassPrompt';
import { listAgentPublicKeys } from './PublicKeyDiscovery';
import type { AskpassPromptRetryContext } from '../smartcard/AskpassServer';
import { createLogger } from '../log';
const sshLog = createLogger('ssh');
export interface SSHPtyManagerEvents {
  data: (event: { sessionId: string; data: string }) => void;
  exit: (event: { sessionId: string; exitCode: number; signal?: number }) => void;
  reconnecting: (event: { sessionId: string; attempt: number; maxAttempts: number }) => void;
  reconnected: (event: { sessionId: string }) => void;
  presence: (event: { sessionId: string; prompt: string }) => void;
  askpass: (event: {
    sessionId: string;
    prompt: string;
    kind?: AskpassPromptKind;
    context?: string;
    retry?: AskpassPromptRetryContext;
    callback: (pin: string) => void;
  }) => void;
}

export class InternalSSHPtySession implements SSHPtySession {
  public sessionId: string;
  public config: SSHConnectionConfig;
  public pid: number;
  public cols: number;
  public rows: number;
  public controlPath?: string;
  public muxRegistryId?: string | null;

  private pty: IPty;
  public askpassServer?: AskpassServer;
  private manager: SSHPtyManager;
  private dataListeners: Set<(data: string) => void> = new Set();
  private exitListeners: Set<(event: SSHPtyExitEvent) => void> = new Set();
  private disposed: boolean = false;
  private cleanupPromise?: Promise<void>;
  private reconnecting: boolean = false;
  private reconnectAttempts: number = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectStableTimer?: NodeJS.Timeout;
  /** A reconnected session must stay up this long before its retry budget is restored. */
  private static readonly RECONNECT_STABLE_MS = 30_000;

  private scrollbackChunks: string[] = [];
  private scrollbackLength: number = 0;
  private static readonly MAX_SCROLLBACK_BYTES = 128 * 1024; // 128 KB

  constructor(params: {
    sessionId: string;
    config: SSHConnectionConfig;
    pty: IPty;
    cols: number;
    rows: number;
    manager: SSHPtyManager;
    askpassServer?: AskpassServer;
    controlPath?: string;
    muxRegistryId?: string | null;
  }) {
    this.sessionId = params.sessionId;
    this.config = params.config;
    this.pty = params.pty;
    this.pid = params.pty.pid;
    this.cols = params.cols;
    this.rows = params.rows;
    this.manager = params.manager;
    this.askpassServer = params.askpassServer;
    this.controlPath = params.controlPath;
    this.muxRegistryId = params.muxRegistryId;

    this.bindPty(params.pty);
  }

  private appendScrollback(data: string): void {
    this.scrollbackChunks.push(data);
    this.scrollbackLength += data.length;
    while (this.scrollbackLength > InternalSSHPtySession.MAX_SCROLLBACK_BYTES && this.scrollbackChunks.length > 1) {
      const removed = this.scrollbackChunks.shift();
      if (removed) this.scrollbackLength -= removed.length;
    }
  }

  public getScrollbackBuffer(): string {
    return this.scrollbackChunks.join('');
  }

  public isReconnecting(): boolean {
    return this.reconnecting;
  }

  public bindPty(newPty: IPty): void {
    this.pty = newPty;
    this.pid = newPty.pid;

    newPty.onData((data: string) => {
      this.appendScrollback(data);
      for (const listener of this.dataListeners) {
        listener(data);
      }
      this.manager.emit('data', { sessionId: this.sessionId, data });
    });

    newPty.onExit((event: { exitCode: number; signal?: number }) => {
      this.handlePtyExit(event);
    });
  }

  private handlePtyExit(event: { exitCode: number; signal?: number }): void {
    sshLog.info('ssh exited', { sessionId: this.sessionId, exitCode: event.exitCode, signal: event.signal ?? null });
    if (this.reconnectStableTimer) {
      clearTimeout(this.reconnectStableTimer);
      this.reconnectStableTimer = undefined;
    }
    const shouldReconnect =
      !this.disposed &&
      Boolean(this.config.autoReconnect) &&
      (event.exitCode !== 0 || event.signal !== undefined) &&
      this.reconnectAttempts < (this.config.maxReconnectAttempts ?? 3);

    if (shouldReconnect) {
      this.reconnecting = true;
      this.reconnectAttempts++;
      const attempt = this.reconnectAttempts;
      const maxAttempts = this.config.maxReconnectAttempts ?? 3;
      const delay = this.config.reconnectDelayMs ?? 1000;

      this.manager.emit('reconnecting', { sessionId: this.sessionId, attempt, maxAttempts });
      const msg = `\r\n\x1b[33m[sshs3: connection dropped, reconnecting (${attempt}/${maxAttempts})...]\x1b[0m\r\n`;
      this.appendScrollback(msg);
      for (const listener of this.dataListeners) listener(msg);
      this.manager.emit('data', { sessionId: this.sessionId, data: msg });

      this.reconnectTimer = setTimeout(async () => {
        if (this.disposed) return;
        try {
          const success = await this.manager.reconnectSession(this);
          if (success) {
            this.reconnecting = false;
            // A successful spawn is not a successful connection: ssh may exit seconds later
            // (host still down). Only restore the retry budget once the session has stayed
            // up, otherwise maxReconnectAttempts would never be reached.
            this.reconnectStableTimer = setTimeout(() => {
              this.reconnectAttempts = 0;
              this.reconnectStableTimer = undefined;
            }, InternalSSHPtySession.RECONNECT_STABLE_MS);
            this.reconnectStableTimer.unref?.();
            const okMsg = `\r\n\x1b[32m[sshs3: reconnected successfully]\x1b[0m\r\n`;
            this.appendScrollback(okMsg);
            for (const listener of this.dataListeners) listener(okMsg);
            this.manager.emit('data', { sessionId: this.sessionId, data: okMsg });
            this.manager.emit('reconnected', { sessionId: this.sessionId });
            return;
          }
        } catch {
          // Fall through to retry or exit
        }

        // Spawn failed: count it as another dropped connection — retry, or give up and emit exit.
        this.reconnecting = false;
        this.handlePtyExit(event);
      }, delay);
      return;
    }

    for (const listener of this.exitListeners) {
      listener(event);
    }
    this.manager.emit('exit', {
      sessionId: this.sessionId,
      exitCode: event.exitCode,
      signal: event.signal,
    });
    void this.cleanup();
  }

  public async reconnect(): Promise<boolean> {
    return this.manager.reconnectSession(this);
  }

  public write(data: string): void {
    if (!this.disposed) {
      this.pty.write(data);
    }
  }

  public resize(cols: number, rows: number): void {
    if (!this.disposed) {
      this.cols = cols;
      this.rows = rows;
      this.pty.resize(cols, rows);
    }
  }

  public kill(signal?: string): void {
    if (this.reconnectStableTimer) {
      clearTimeout(this.reconnectStableTimer);
      this.reconnectStableTimer = undefined;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.reconnecting = false;
    if (!this.disposed) {
      this.pty.kill(signal);
    }
  }

  public onData(listener: (data: string) => void): { dispose: () => void } {
    this.dataListeners.add(listener);
    return {
      dispose: () => {
        this.dataListeners.delete(listener);
      },
    };
  }

  public onExit(listener: (event: SSHPtyExitEvent) => void): { dispose: () => void } {
    this.exitListeners.add(listener);
    return {
      dispose: () => {
        this.exitListeners.delete(listener);
      },
    };
  }

  public dispose(): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    if (this.reconnectStableTimer) {
      clearTimeout(this.reconnectStableTimer);
      this.reconnectStableTimer = undefined;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.reconnecting = false;
    try {
      this.pty.kill();
    } catch {
      // Ignore error if process already terminated
    }
    return this.cleanup();
  }

  private cleanup(): Promise<void> {
    if (!this.cleanupPromise) {
      this.cleanupPromise = this.performCleanup();
    }
    return this.cleanupPromise;
  }

  private async performCleanup(): Promise<void> {
    this.disposed = true;
    this.manager.removeSessionInternal(this.sessionId);
    this.dataListeners.clear();
    this.exitListeners.clear();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    if (this.askpassServer) {
      try {
        await this.askpassServer.stop();
      } catch {
        // Ignore cleanup errors
      }
      this.askpassServer = undefined;
    }

    if (this.controlPath) {
      const controlPath = this.controlPath;
      try {
        if (fs.existsSync(controlPath)) {
          // ControlPersist keeps the ssh master connection alive as a detached background
          // process (renamed "ssh: <path> [mux]") after the interactive session ends, so it can
          // no longer be assumed to be — or even share a pid with — the process `this.pty.kill()`
          // just targeted above; it may have already forked away into that persisted role by the
          // time this runs. `-O exit` is the one thing OpenSSH itself provides that identifies
          // and tears down that master purely by its control socket, regardless of its current
          // pid, so it's what actually closes the connection instead of leaving it running and
          // only deleting the now-stale socket file.
          // Defense in depth: a leading '-' on either argument would be parsed by `ssh` as a flag
          // rather than a value (argv flag smuggling). `createSession`/`reconnectSession` already
          // reject a host starting with '-' before a session can exist at all, and `controlPath`
          // is always our own generated tmp path, never user input — but neither is worth trusting
          // implicitly here since a future refactor could change either invariant silently.
          const host = this.config.host;
          if (host.startsWith('-') || controlPath.startsWith('-')) {
            throw new Error('Refusing to run ssh -O exit: host or control path looks like a flag');
          }
          await new Promise<void>((resolve) => {
            const sshBinary = process.platform === 'win32' ? 'ssh.exe' : 'ssh';
            // Bounded: never let a stuck/unresponsive master block session cleanup.
            execFile(sshBinary, ['-S', controlPath, '-O', 'exit', '--', host], { timeout: 3000 }, () => resolve());
          });
        }
      } catch {
        // Ignore cleanup errors
      }
      try {
        if (fs.existsSync(controlPath)) {
          fs.unlinkSync(controlPath);
        }
      } catch {
        // Ignore cleanup errors
      }
    }

    // Only drop the crash-recovery record once the master has actually been
    // torn down (or we've confirmed there's nothing left to tear down) — if
    // this process is killed mid-cleanup, the record must still be here so
    // the next startup's orphan scan can finish the job.
    if (this.muxRegistryId) {
      try {
        await unregisterEntry(this.muxRegistryId);
      } catch {
        // Ignore cleanup errors
      }
      this.muxRegistryId = undefined;
    }
  }
}

export interface SSHPtyManagerOptions {
  settingsStore?: SettingsStore;
  /**
   * Unused: terminal sessions no longer auto-embed a profile's saved tunnels into their own `ssh`
   * process (only the Tunnels panel, via `SSHTunnelManager`, ever starts a tunnel), so there is
   * nothing left for this to disambiguate. Kept for now so existing callers don't need to change.
   */
  isTunnelActive?: (connectionId: string, tunnelId: string) => boolean;
}

export class SSHPtyManager extends EventEmitter {
  private sessions: Map<string, SSHPtySession> = new Map();
  private sessionOptions: Map<string, PtyOptions | undefined> = new Map();
  private settingsStore?: SettingsStore;
  /**
   * Local ports our own already-open sessions have bound a tunnel for, keyed by the owning
   * session id. Terminal sessions no longer auto-embed saved tunnels (only the Tunnels panel
   * starts them, via `SSHTunnelManager`), so this stays empty in practice — kept in place as a
   * harmless guard in case a caller ever hands a session a config with tunnels again.
   */
  private boundLocalPorts: Map<number, string> = new Map();

  constructor(options?: SSHPtyManagerOptions) {
    super();
    this.settingsStore = options?.settingsStore;
  }

  /**
   * Strips any saved tunnels from a config before it's handed to `buildSSHArguments`. Tunnels
   * are only ever started explicitly from the Tunnels panel (`SSHTunnelManager`) now — a terminal
   * session must never auto-embed a profile's saved tunnels into its own `ssh` invocation, since
   * that used to race with the tunnel panel starting the same tunnel independently.
   */
  private withoutConflictingTunnels(config: SSHConnectionConfig, _sessionId: string): SSHConnectionConfig {
    if (!config.tunnels?.length) return config;
    return { ...config, tunnels: undefined };
  }

  /**
   * Records which local ports `filteredConfig` (the config actually handed to
   * `buildSSHArguments`, post-filtering) causes this session's `ssh` process to bind, so a later
   * session to the same or another host can avoid re-requesting the same port. Clears this
   * session's previous registrations first, since reconnecting can end up with a different set.
   */
  private registerBoundPorts(filteredConfig: SSHConnectionConfig, sessionId: string): void {
    for (const [port, owner] of this.boundLocalPorts) {
      if (owner === sessionId) this.boundLocalPorts.delete(port);
    }
    for (const t of filteredConfig.tunnels || []) {
      if (t.enabled === false || t.type === 'remote') continue;
      this.boundLocalPorts.set(t.localPort, sessionId);
    }
  }

  private releaseBoundPorts(sessionId: string): void {
    for (const [port, owner] of this.boundLocalPorts) {
      if (owner === sessionId) this.boundLocalPorts.delete(port);
    }
  }

  /**
   * Asks the UI (via the same 'askpass' channel used for in-session smartcard
   * prompts) for a PIN/passphrase, e.g. to load a smartcard into a private
   * ssh-agent ahead of or independently of a PTY login. Resolves to '' if
   * nothing is listening.
   */
  public async promptForPin(
    sessionId: string,
    prompt: string,
    kind?: AskpassPromptKind,
    context?: string,
    retry?: AskpassPromptRetryContext
  ): Promise<string> {
    if (this.listenerCount('askpass') === 0) {
      return '';
    }
    return new Promise<string>((resolve) => {
      this.emit('askpass', { sessionId, prompt, kind, context, retry, callback: (pin: string) => resolve(pin) });
    });
  }

  /**
   * Reconnects an existing session by spawning a new underlying SSH process.
   */
  public async reconnectSession(session: InternalSSHPtySession): Promise<boolean> {
    const config = session.config;
    const options = this.sessionOptions.get(session.sessionId);
    const cols = session.cols;
    const rows = session.rows;
    const cwd = options?.cwd ?? (process.env.HOME || process.cwd());

    const askpassEnv = session.askpassServer ? session.askpassServer.getEnv() : {};
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      TERM: 'xterm-256color',
      ...askpassEnv,
      ...SmartcardDetector.buildProxyEnv(config),
      ...(options?.env || {}),
    };

    if (config.agentPath) {
      env.SSH_AUTH_SOCK = config.agentPath;
    } else if (config.authType === 'smartcard') {
      delete env.SSH_AUTH_SOCK;
    }

    if (config.x11Forwarding) {
      env.DISPLAY =
        config.x11Display ||
        process.env.DISPLAY ||
        (process.platform === 'win32' ? '127.0.0.1:0.0' : ':0');
    }

    const filteredConfig = this.withoutConflictingTunnels(config, session.sessionId);
    // Same ControlPath as the original connection, so features using the mux socket
    // (`-S`: perf sampling, dotfiles sync) keep working after a reconnect.
    const sshArgs = SmartcardDetector.buildSSHArguments(filteredConfig, session.controlPath);
    const sshBinary = process.platform === 'win32' ? 'ssh.exe' : 'ssh';
    sshLog.info(`spawning ${sshBinary} ${sshArgs.join(' ')}`);

    try {
      const spawn = getSpawn();
      const ptyProcess = spawn(sshBinary, sshArgs, {
        cols,
        rows,
        cwd,
        env,
      });

      this.registerBoundPorts(filteredConfig, session.sessionId);
      session.bindPty(ptyProcess);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Creates and spawns an OpenSSH PTY session with the given connection configuration.
   */
  public async createSession(
    config: SSHConnectionConfig,
    options?: PtyOptions
  ): Promise<SSHPtySession> {
    const sessionId = config.id || `ssh-${crypto.randomUUID()}`;
    this.sessionOptions.set(sessionId, options);
    const cols = options?.cols ?? 80;
    const rows = options?.rows ?? 24;
    const cwd = options?.cwd ?? (process.env.HOME || process.cwd());

    let askpassServer: AskpassServer | undefined;
    let askpassEnv: Record<string, string> = {};

    // Start Askpass server if Smartcard/FIDO2/password is used, or if a saved credential or passphrase is provided
    const needsAskpass =
      config.authType === 'smartcard' ||
      config.authType === 'fido2' ||
      config.authType === 'password' ||
      Boolean(config.password) ||
      Boolean(config.passphrase);

    if (needsAskpass) {
      askpassServer = new AskpassServer({
        onPresence: (prompt: string) => {
          this.emit('presence', { sessionId, prompt });
        },
        promptHandler: async (rawPrompt: string, retry?: AskpassPromptRetryContext) => {
          // Kind only, never the answer. A 'password' prompt on a key-based profile means ssh could not
          // authenticate with the agent and fell back to asking for the account password.
          const promptKind = describeAskpassPrompt(rawPrompt, config).kind ?? 'passphrase';
          const savedAnswer = Boolean(
            (config.authType === 'password' && config.password) || config.passphrase
          );
          sshLog.info('askpass prompt', {
            sessionId,
            kind: promptKind,
            authType: config.authType,
            answeredFrom: savedAnswer ? 'saved' : 'ui',
            retry: Boolean(retry),
          });
          if (config.authType === 'password' && config.password) {
            return config.password;
          }
          if (config.passphrase) {
            return config.passphrase;
          }
          if (this.listenerCount('askpass') > 0) {
            const { kind, prompt: promptText, context } = describeAskpassPrompt(rawPrompt, config);
            return new Promise<string>((resolve) => {
              this.emit('askpass', {
                sessionId,
                prompt: promptText,
                kind,
                context,
                retry,
                callback: (resolvedPin: string) => resolve(resolvedPin),
              });
            });
          }
          return config.passphrase || config.password || '';
        },
      });

      await askpassServer.start();
      askpassEnv = askpassServer.getEnv();
    }

    const controlPath =
      process.platform !== 'win32'
        ? path.join(os.tmpdir(), `s3m-${crypto.randomUUID().slice(0, 8)}.sock`)
        : undefined;
    let muxRegistryId: string | null = null;
    let filteredConfig: SSHConnectionConfig;
    let ptyProcess: IPty;

    // Everything from here to the spawn may throw (invalid proxy/tunnel config, argument
    // building, spawn itself); the askpass server and mux registry entry must not leak then.
    try {
      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        TERM: 'xterm-256color',
        ...askpassEnv,
        ...SmartcardDetector.buildProxyEnv(config),
        ...(options?.env || {}),
      };

      if (config.agentPath) {
        env.SSH_AUTH_SOCK = config.agentPath;
      } else if (config.authType === 'smartcard') {
        delete env.SSH_AUTH_SOCK;
      }

      if (config.x11Forwarding) {
        env.DISPLAY =
          config.x11Display ||
          process.env.DISPLAY ||
          (process.platform === 'win32' ? '127.0.0.1:0.0' : ':0');
      }

      if (controlPath) {
        try {
          muxRegistryId = await registerEntry({
            kind: 'ssh-mux',
            ownerPid: process.pid,
            controlPath,
            host: config.host,
            createdAt: new Date().toISOString(),
          });
        } catch {
          // Best-effort
        }
      }

      filteredConfig = this.withoutConflictingTunnels(config, sessionId);
      const sshArgs = SmartcardDetector.buildSSHArguments(filteredConfig, controlPath);
      const sshBinary = process.platform === 'win32' ? 'ssh.exe' : 'ssh';
      sshLog.info(`spawning ${sshBinary} ${sshArgs.join(' ')}`);
      sshLog.info('connect', {
        sessionId,
        host: config.host,
        port: config.port,
        authType: config.authType,
        agentSocket: env.SSH_AUTH_SOCK ?? null,
        agentSocketPresent: env.SSH_AUTH_SOCK ? fs.existsSync(env.SSH_AUTH_SOCK) : null,
        agentSource: config.agentPath ? 'profile' : env.SSH_AUTH_SOCK ? 'inherited' : 'none',
        savedAuth: Boolean(config.password || config.passphrase),
      });
      if (env.SSH_AUTH_SOCK) {
        // Fire and forget: how many identities the agent offered at connect time (count only, no key material).
        void listAgentPublicKeys('agent', 'agent', env.SSH_AUTH_SOCK)
          .then((keys) => sshLog.info('agent identities at connect', { sessionId, count: keys.length }))
          .catch(() => {});
      }

      const spawn = getSpawn();
      ptyProcess = spawn(sshBinary, sshArgs, {
        cols,
        rows,
        cwd,
        env,
      });
    } catch (err) {
      this.sessionOptions.delete(sessionId);
      if (askpassServer) {
        await askpassServer.stop();
      }
      if (muxRegistryId) {
        await unregisterEntry(muxRegistryId);
      }
      throw err;
    }

    this.registerBoundPorts(filteredConfig, sessionId);

    const session = new InternalSSHPtySession({
      sessionId,
      config,
      pty: ptyProcess,
      cols,
      rows,
      manager: this,
      askpassServer,
      controlPath,
      muxRegistryId,
    });

    this.sessions.set(sessionId, session);
    return session;
  }

  /**
   * Spawns a local shell PTY session (e.g. bash or powershell/cmd).
   */
  public async createShellSession(options?: PtyOptions): Promise<SSHPtySession> {
    const sessionId = `shell-${crypto.randomUUID()}`;
    const cols = options?.cols ?? 80;
    const rows = options?.rows ?? 24;
    const cwd = options?.cwd ?? (process.env.HOME || process.env.USERPROFILE || process.cwd());

    const shellBinary = resolveLocalShellBinary(options?.shellType);
    const args: string[] = [];
    if (process.platform === 'win32' && options?.shellType === 'wsl' && options?.wslDistro) {
      args.push('-d', options.wslDistro);
    }

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      TERM: 'xterm-256color',
    };

    const settings = await this.settingsStore?.getSettings().catch(() => null);
    const agentMode = settings?.localTerminalAgentMode ?? 'auto';

    if (agentMode === 'disabled') {
      delete env.SSH_AUTH_SOCK;
      delete env.SSH_AGENT_PID;
    } else if (process.platform !== 'win32' && options?.shellType !== 'wsl') {
      if (agentMode === 'system') {
        if (process.env.SSH_AUTH_SOCK && fs.existsSync(process.env.SSH_AUTH_SOCK)) {
          env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK;
        } else {
          delete env.SSH_AUTH_SOCK;
        }
      } else {
        const agentStatus = await AgentLifecycleManager.ensureAgent();
        if (agentStatus.isRunning && agentStatus.socketPath) {
          env.SSH_AUTH_SOCK = agentStatus.socketPath;
        }
      }
    }

    Object.assign(env, options?.env || {});
    if (agentMode === 'disabled') {
      delete env.SSH_AUTH_SOCK;
      delete env.SSH_AGENT_PID;
    }

    try {
      if (settings?.enableOpenShift) {
        const shimDir = K8sShimManager.ensureShim();
        const currentPath = env.PATH || process.env.PATH || '';
        env.PATH = `${shimDir}${path.delimiter}${currentPath}`;
      }
    } catch {
      // Non-fatal if shim directory cannot be provisioned or settings cannot be read
    }

    const sessionName =
      options?.shellType === 'wsl'
        ? options?.wslDistro
          ? `WSL: ${options.wslDistro}`
          : 'WSL'
        : 'Local Shell';

    const config: SSHConnectionConfig = {
      id: sessionId,
      name: sessionName,
      host: 'localhost',
      username: process.env.USER || process.env.USERNAME || 'local',
      authType: 'password',
    };

    const spawn = getSpawn();

    // On Linux, node-pty uses `forkpty()` which does not close file descriptors
    // above stderr. In Electron, dozens of internal file descriptors (GPU cache,
    // Dawn Graphite cache, sockets, render nodes) remain open. When user commands
    // (such as k3s/kubectl executing iptables-restore) undergo SELinux domain transitions,
    // the kernel checks all inherited fds and logs AVC denials if the target domain
    // cannot access Electron cache files. Wrapping execution in `/bin/sh` to close
    // all fds > 2 before `exec "$@"` cleanly eliminates this descriptor leak.
    // When /bin/sh is dash (Debian, Ubuntu), a redirection only takes fds 0-9:
    // `exec 10>&-` runs a command named "10", which ends the wrapper with code 127
    // before the shell starts. So fds above 9 are only closed when sh is bash.
    let spawnBinary = shellBinary;
    let spawnArgs = args;
    if (process.platform === 'linux') {
      const script =
        'for fd in $(ls /proc/self/fd 2>/dev/null); do ' +
        'case "$fd" in ""|*[!0-9]*) continue ;; esac; ' +
        'if [ "$fd" -gt 9 ] && [ -z "${BASH_VERSION-}" ]; then continue; fi; ' +
        'if [ "$fd" -gt 2 ]; then eval "exec $fd>&-" 2>/dev/null; fi; ' +
        'done; ' +
        'exec "$@"';
      spawnBinary = '/bin/sh';
      spawnArgs = ['-c', script, '--', shellBinary, ...args];
    }

    const ptyProcess = spawn(spawnBinary, spawnArgs, {
      cols,
      rows,
      cwd,
      env,
    });

    const session = new InternalSSHPtySession({
      sessionId,
      config,
      pty: ptyProcess,
      cols,
      rows,
      manager: this,
    });

    this.sessions.set(sessionId, session);
    return session;
  }

  /**
   * Retrieves an active session by ID.
   */
  public getSession(sessionId: string): SSHPtySession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Returns all active sessions.
   */
  public getAllSessions(): SSHPtySession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Writes data to an active session.
   */
  public write(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.write(data);
    }
  }

  /**
   * Resizes an active session.
   */
  public resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.resize(cols, rows);
    }
  }

  /**
   * Kills an active session.
   */
  public kill(sessionId: string, signal?: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.kill(signal);
    }
  }

  /**
   * Terminates all active sessions.
   */
  public async killAll(): Promise<void> {
    const activeSessions = Array.from(this.sessions.values());
    for (const session of activeSessions) {
      await session.dispose();
    }
    this.sessions.clear();
  }

  /**
   * Internal removal from session map.
   */
  public removeSessionInternal(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.sessionOptions.delete(sessionId);
    this.releaseBoundPorts(sessionId);
  }
}
