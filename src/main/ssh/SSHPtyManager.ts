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
import { isDemoTarget } from '../demo/demoMode';
import { DemoVirtualPty } from '../demo/DemoVirtualPty';
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
import { describeAskpassPrompt, isHostKeyConfirmPrompt, savedAskpassAnswer } from './askpassPrompt';
import { isHostKeyChangedOutput } from './hostKeyChanged';
import { parseHostKeyPrompt } from '../storage/sftp/OpenSshSftpProcess';
import type { HostKeyPromptInfo } from './HostKeyVerifier';
import type { SFTPConfig } from '../../shared/types/storage';
import { listAgentPublicKeys } from './PublicKeyDiscovery';
import type { AskpassPromptRetryContext } from '../smartcard/AskpassServer';
import { createLogger } from '../log';
import { createMuxControlPath } from './muxControlPath';
import { accountChildEnv, clientTerminalEnv, isWebServerProcess, serverEnvForAccountChild, sshClientFileArgs } from '../web/tenantBoundary';
const sshLog = createLogger('ssh');

export const CONPTY_WRITE_CHUNK_BYTES = 512;
export const DEFAULT_SERVER_ALIVE_INTERVAL = 30;
export const DEFAULT_SERVER_ALIVE_COUNT_MAX = 3;

export interface WriteChunkedOptions {
  /** Max UTF-8 bytes per chunk (default: 512 for Windows ConPTY). */
  chunkBytes?: number;
  /** Delay in ms between chunks when split across multiple writes (default: 2; 0 for synchronous writes). */
  delayMs?: number;
}

/**
 * Splits terminal input into chunks bounded by `maxBytes` UTF-8 bytes without
 * breaking UTF-16 surrogate pairs.
 */
export function splitConPtyChunks(data: string, maxBytes = CONPTY_WRITE_CHUNK_BYTES): string[] {
  if (!data) return [];
  const limit = Math.max(1, Math.floor(maxBytes));
  if (Buffer.byteLength(data, 'utf8') <= limit) {
    return [data];
  }
  const chunks: string[] = [];
  let start = 0;
  let bytes = 0;
  for (let i = 0; i < data.length; ) {
    const cp = data.codePointAt(i) ?? 0;
    const charLen = cp > 0xffff ? 2 : 1;
    const charBytes = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
    if (bytes > 0 && bytes + charBytes > limit) {
      chunks.push(data.slice(start, i));
      start = i;
      bytes = 0;
    }
    bytes += charBytes;
    i += charLen;
  }
  if (start < data.length) {
    chunks.push(data.slice(start));
  }
  return chunks;
}

/**
 * Writes data to a PTY or writer callback in 512-byte ConPTY-safe chunks so large
 * pastes and escape sequences are not dropped on Windows pseudo-consoles.
 */
export async function writeChunked(
  target: { write(chunk: string): void } | ((chunk: string) => void),
  data: string,
  options: WriteChunkedOptions = {}
): Promise<void> {
  if (!data) return;
  const writeFn = typeof target === 'function' ? target : (chunk: string) => target.write(chunk);
  const chunkBytes = options.chunkBytes ?? CONPTY_WRITE_CHUNK_BYTES;
  const delayMs = options.delayMs ?? 2;
  const chunks = splitConPtyChunks(data, chunkBytes);
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0 && delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
    writeFn(chunks[i]);
  }
}

function hasExtraOptionCaseInsensitive(
  extraOptions: Record<string, string> | undefined,
  key: string
): boolean {
  if (!extraOptions) return false;
  const target = key.toLowerCase();
  return Object.keys(extraOptions).some((k) => k.trim().toLowerCase() === target);
}

/**
 * Applies default OpenSSH keepalive settings (`ServerAliveInterval=30` and
 * `ServerAliveCountMax=3`) unless explicitly overridden in `config`.
 */
export function applySshKeepaliveDefaults(config: SSHConnectionConfig): SSHConnectionConfig {
  const hasInterval =
    config.serverAliveInterval !== undefined ||
    hasExtraOptionCaseInsensitive(config.extraOptions, 'ServerAliveInterval');
  const hasCountMax = hasExtraOptionCaseInsensitive(config.extraOptions, 'ServerAliveCountMax');
  if (hasInterval && hasCountMax) {
    return config;
  }
  return {
    ...config,
    ...(!hasInterval ? { serverAliveInterval: DEFAULT_SERVER_ALIVE_INTERVAL } : {}),
    ...(!hasCountMax
      ? {
          extraOptions: {
            ...(config.extraOptions ?? {}),
            ServerAliveCountMax: String(DEFAULT_SERVER_ALIVE_COUNT_MAX),
          },
        }
      : {}),
  };
}

export type SessionConnectionState = 'connected' | 'reconnecting' | 'disconnected';

export interface SessionReconnectGraceState {
  state: SessionConnectionState;
  attempt: number;
  maxAttempts: number;
  startedAt?: number;
  graceUntil?: number;
}

export type SessionShareRole = 'owner' | 'peer' | 'observer';

export interface SessionParticipant {
  clientId: string;
  actor: string;
  role: SessionShareRole;
  joinedAt: number;
  lastActiveAt: number;
}

export interface SessionShareMetadata {
  sessionId: string;
  ownerClientId?: string;
  participants: SessionParticipant[];
  observerCount: number;
  peerCount: number;
  sharingEnabled: boolean;
}

export interface SessionShareAttachment {
  clientId: string;
  role: SessionShareRole;
  write(data: string): boolean;
  dispose(): void;
}

export interface SSHPtyManagerEvents {
  data: (event: { sessionId: string; data: string }) => void;
  exit: (event: { sessionId: string; exitCode: number; signal?: number }) => void;
  reconnecting: (event: {
    sessionId: string;
    attempt: number;
    maxAttempts: number;
  }) => void;
  reconnected: (event: { sessionId: string }) => void;
  'share-changed': (event: { sessionId: string; metadata: SessionShareMetadata }) => void;
  'fanout-data': (event: {
    sessionId: string;
    data: string;
    participants: SessionParticipant[];
  }) => void;
  'observer-input-blocked': (event: {
    sessionId: string;
    clientId: string;
    actor: string;
  }) => void;
  'hostkey-changed': (event: {
    sessionId: string;
    host: string;
    port: number;
  }) => void;
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
  /** Set by kill(): the user closed this session, so its exit is final and must never reconnect. */
  private killedByUser: boolean = false;
  private cleanupPromise?: Promise<void>;
  private reconnecting: boolean = false;
  private reconnectAttempts: number = 0;
  private reconnectStartedAt?: number;
  private reconnectGraceUntil?: number;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectStableTimer?: NodeJS.Timeout;
  /** A reconnected session must stay up this long before its retry budget is restored. */
  private static readonly RECONNECT_STABLE_MS = 30_000;
  private writeQueue: Promise<void> = Promise.resolve();
  private participants: Map<string, SessionParticipant> = new Map();
  private fanoutListeners: Map<string, (data: string) => void> = new Map();

  private scrollbackChunks: string[] = [];
  private scrollbackLength: number = 0;
  /** Output of the current ssh process only (unlike the scrollback, which spans reconnects). */
  private recentOutput: string = '';
  private static readonly RECENT_OUTPUT_CHARS = 8192;
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

  public getConnectionState(): SessionConnectionState {
    if (this.disposed) return 'disconnected';
    if (this.reconnecting) return 'reconnecting';
    return 'connected';
  }

  public getReconnectState(): SessionReconnectGraceState {
    return {
      state: this.getConnectionState(),
      attempt: this.reconnectAttempts,
      maxAttempts: this.config.maxReconnectAttempts ?? 3,
      ...(this.reconnectStartedAt !== undefined ? { startedAt: this.reconnectStartedAt } : {}),
      ...(this.reconnectGraceUntil !== undefined ? { graceUntil: this.reconnectGraceUntil } : {}),
    };
  }

  private emitOutputChunk(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
    for (const listener of this.fanoutListeners.values()) {
      listener(data);
    }
    this.manager.emit('data', { sessionId: this.sessionId, data });
    if (this.participants.size > 0) {
      this.manager.emit('fanout-data', {
        sessionId: this.sessionId,
        data,
        participants: this.listParticipants(),
      });
    }
  }

  public joinParticipant(input: {
    clientId: string;
    actor: string;
    role: SessionShareRole;
  }): SessionParticipant {
    const now = Date.now();
    const existing = this.participants.get(input.clientId);
    const participant: SessionParticipant = {
      clientId: input.clientId,
      actor: input.actor,
      role: input.role,
      joinedAt: existing?.joinedAt ?? now,
      lastActiveAt: now,
    };
    this.participants.set(input.clientId, participant);
    this.manager.emit('share-changed', {
      sessionId: this.sessionId,
      metadata: this.getShareMetadata(),
    });
    return { ...participant };
  }

  public leaveParticipant(clientId: string): boolean {
    const removed = this.participants.delete(clientId);
    this.fanoutListeners.delete(clientId);
    if (removed) {
      this.manager.emit('share-changed', {
        sessionId: this.sessionId,
        metadata: this.getShareMetadata(),
      });
    }
    return removed;
  }

  public setParticipantRole(clientId: string, role: SessionShareRole): SessionParticipant | undefined {
    const existing = this.participants.get(clientId);
    if (!existing) return undefined;
    const updated: SessionParticipant = {
      ...existing,
      role,
      lastActiveAt: Date.now(),
    };
    this.participants.set(clientId, updated);
    this.manager.emit('share-changed', {
      sessionId: this.sessionId,
      metadata: this.getShareMetadata(),
    });
    return { ...updated };
  }

  public listParticipants(): SessionParticipant[] {
    return Array.from(this.participants.values(), (p) => ({ ...p }));
  }

  public getShareMetadata(): SessionShareMetadata {
    const participants = this.listParticipants();
    const owner = participants.find((p) => p.role === 'owner');
    const observerCount = participants.filter((p) => p.role === 'observer').length;
    const peerCount = participants.filter((p) => p.role === 'peer').length;
    return {
      sessionId: this.sessionId,
      ...(owner ? { ownerClientId: owner.clientId } : {}),
      participants,
      observerCount,
      peerCount,
      sharingEnabled: participants.length > 0,
    };
  }

  public canClientWrite(clientId: string): boolean {
    const participant = this.participants.get(clientId);
    if (!participant) return this.participants.size === 0;
    return participant.role !== 'observer';
  }

  public writeFromClient(clientId: string, data: string): boolean {
    const participant = this.participants.get(clientId);
    if (!this.canClientWrite(clientId)) {
      if (participant) {
        this.manager.emit('observer-input-blocked', {
          sessionId: this.sessionId,
          clientId,
          actor: participant.actor,
        });
      }
      return false;
    }
    if (participant) {
      participant.lastActiveAt = Date.now();
    }
    this.write(data);
    return true;
  }

  public attachShareClient(
    participant: { clientId: string; actor: string; role: SessionShareRole },
    onData: (data: string) => void
  ): SessionShareAttachment {
    const joined = this.joinParticipant(participant);
    this.fanoutListeners.set(participant.clientId, onData);
    return {
      clientId: joined.clientId,
      role: joined.role,
      write: (data: string) => this.writeFromClient(joined.clientId, data),
      dispose: () => {
        this.leaveParticipant(joined.clientId);
      },
    };
  }

  public bindPty(newPty: IPty): void {
    this.pty = newPty;
    this.pid = newPty.pid;
    this.recentOutput = '';

    newPty.onData((data: string) => {
      this.recentOutput = (this.recentOutput + data).slice(-InternalSSHPtySession.RECENT_OUTPUT_CHARS);
      this.appendScrollback(data);
      this.emitOutputChunk(data);
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
    // A changed host key never fixes itself, so retrying would only repeat the warning.
    const changedKey = !this.disposed && event.exitCode !== 0 && isHostKeyChangedOutput(this.recentOutput);
    if (changedKey) {
      const msg =
        `\r\n\x1b[31m[sshs3: ssh reported that the host key for ${this.config.host} has changed. ` +
        `The server may have been reinstalled, or the connection is being intercepted. Checking...]\x1b[0m\r\n`;
      this.appendScrollback(msg);
      this.emitOutputChunk(msg);
      this.manager.emit('hostkey-changed', {
        sessionId: this.sessionId,
        host: this.config.host,
        port: this.config.port ?? 22,
      });
    }
    const shouldReconnect =
      !this.disposed &&
      !this.killedByUser &&
      !changedKey &&
      Boolean(this.config.autoReconnect) &&
      // 255 is ssh's own "the connection failed or dropped" code; any other non-zero code is the remote shell or
      // command ending (e.g. `exit 1`), which is not a reason to connect again. node-pty reports signal 0 (not
      // undefined) for a normal exit, so only a real signal counts.
      (event.exitCode === 255 || Boolean(event.signal)) &&
      this.reconnectAttempts < (this.config.maxReconnectAttempts ?? 3);

    if (shouldReconnect) {
      this.reconnecting = true;
      this.reconnectAttempts++;
      const attempt = this.reconnectAttempts;
      const maxAttempts = this.config.maxReconnectAttempts ?? 3;
      const delay = this.config.reconnectDelayMs ?? 1000;
      this.reconnectStartedAt ??= Date.now();
      this.reconnectGraceUntil = Date.now() + delay;

      this.manager.emit('reconnecting', {
        sessionId: this.sessionId,
        attempt,
        maxAttempts,
      });
      const msg = `\r\n\x1b[33m[sshs3: connection dropped, reconnecting (${attempt}/${maxAttempts})...]\x1b[0m\r\n`;
      this.appendScrollback(msg);
      this.emitOutputChunk(msg);

      this.reconnectTimer = setTimeout(async () => {
        this.reconnectTimer = undefined;
        if (this.disposed || this.killedByUser) return;
        try {
          const success = await this.manager.reconnectSession(this);
          if (success && this.killedByUser) {
            // Closed while the new ssh was starting: end that one too (its exit then ends the session).
            this.reconnecting = false;
            this.reconnectStartedAt = undefined;
            this.reconnectGraceUntil = undefined;
            this.pty.kill();
            return;
          }
          if (success) {
            this.reconnecting = false;
            this.reconnectStartedAt = undefined;
            this.reconnectGraceUntil = undefined;
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
            this.emitOutputChunk(okMsg);
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

    this.reconnectStartedAt = undefined;
    this.reconnectGraceUntil = undefined;
    this.emitFinalExit(event);
  }

  private emitFinalExit(event: { exitCode: number; signal?: number }): void {
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
    if (this.disposed || this.reconnecting || !data) return;
    if (process.platform === 'win32' && Buffer.byteLength(data, 'utf8') > CONPTY_WRITE_CHUNK_BYTES) {
      void this.writeChunked(data);
      return;
    }
    this.pty.write(data);
  }

  public writeChunked(data: string, options?: WriteChunkedOptions): Promise<void> {
    if (this.disposed || this.reconnecting || !data) return Promise.resolve();
    const run = this.writeQueue.then(
      () =>
        writeChunked(
          (chunk) => {
            if (!this.disposed && !this.reconnecting) {
              this.pty.write(chunk);
            }
          },
          data,
          options
        ),
      () =>
        writeChunked(
          (chunk) => {
            if (!this.disposed && !this.reconnecting) {
              this.pty.write(chunk);
            }
          },
          data,
          options
        )
    );
    this.writeQueue = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  public resize(cols: number, rows: number): void {
    if (!this.disposed) {
      if (cols === this.cols && rows === this.rows) return;
      this.cols = cols;
      this.rows = rows;
      this.pty.resize(cols, rows);
    }
  }

  /**
   * True when the shell has spawned an interactive ssh client (Linux only; false when it cannot be
   * told). What the terminal then shows belongs to the remote host, not to this machine.
   */
  public hasSshClient(): boolean {
    if (this.disposed || !this.pty) return false;
    const pid = (this.pty as any).pid;
    if (!pid || process.platform !== 'linux') return false;
    try {
      const childrenStr = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim();
      if (!childrenStr) return false;
      for (const cPid of childrenStr.split(/\s+/).filter(Boolean)) {
        try {
          // The client only: `ssh-add`, `ssh-agent` and `sshfs` are not a login to another host.
          if (fs.readFileSync(`/proc/${cPid}/comm`, 'utf8').trim() === 'ssh') return true;
        } catch {
          // Child process may have already exited
        }
      }
    } catch {
      // Ignore error checking children
    }
    return false;
  }

  public getCwd(): string | null {
    if (this.disposed || !this.pty) return null;
    const pid = (this.pty as any).pid;
    if (!pid) return null;
    if (process.platform === 'linux') {
      // If the shell process has spawned an interactive ssh client, its local /proc/pid/cwd
      // is just the local directory where ssh was launched, not the remote CWD.
      // In that case, return null so caller falls back to remote prompt detection.
      if (this.hasSshClient()) return null;
      try {
        return fs.readlinkSync(`/proc/${pid}/cwd`);
      } catch {
        return null;
      }
    }
    return null;
  }

  public kill(signal?: string): void {
    this.killedByUser = true;
    if (this.reconnectStableTimer) {
      clearTimeout(this.reconnectStableTimer);
      this.reconnectStableTimer = undefined;
    }
    const pendingReconnect = this.reconnectTimer !== undefined;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.reconnecting = false;
    if (this.disposed) return;
    if (pendingReconnect) {
      // The ssh process is already gone and only the reconnect was waiting: no pty exit will follow,
      // so end the session here.
      this.emitFinalExit({ exitCode: 255 });
      return;
    }
    this.pty.kill(signal);
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
    this.reconnecting = false;
    this.reconnectStartedAt = undefined;
    this.reconnectGraceUntil = undefined;
    this.manager.removeSessionInternal(this.sessionId);
    this.dataListeners.clear();
    this.exitListeners.clear();
    this.participants.clear();
    this.fanoutListeners.clear();

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
            execFile(sshBinary, [...sshClientFileArgs(this.config), '-S', controlPath, '-O', 'exit', '--', host], { timeout: 3000, env: accountChildEnv() }, () => resolve());
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
  /** Answers OpenSSH's unknown-host-key question; absent means "no" (fail closed). */
  hostKeyPromptHandler?: (info: HostKeyPromptInfo) => Promise<boolean>;
  /**
   * Web server only: this manager is one account's. Every connection is made the account's own before
   * ssh is started (its ssh files, only its own key files: see IpcBridge.confineSshConfig), a client
   * sets only display and language variables on the ssh process, and there is no shell on the server.
   */
  confineConfig?: (config: SSHConnectionConfig) => SSHConnectionConfig;
}

/** Options of an SSH session: those of its pty, and the saved profile it is for. */
export interface SshSessionOptions extends PtyOptions {
  /**
   * The saved profile this session connects to. Terminals give every session its own `config.id`, so
   * this is what identifies a demo target (`isDemoTarget`): in demo mode such a session runs on the
   * virtual demo terminal and never gets an ssh process. Host names and addresses never decide that.
   */
  profileId?: string;
}

export class SSHPtyManager extends EventEmitter {
  private sessions: Map<string, SSHPtySession> = new Map();
  private sessionOptions: Map<string, SshSessionOptions | undefined> = new Map();
  private settingsStore?: SettingsStore;
  private hostKeyPromptHandler?: (info: HostKeyPromptInfo) => Promise<boolean>;
  private confineConfig?: (config: SSHConnectionConfig) => SSHConnectionConfig;
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
    this.hostKeyPromptHandler = options?.hostKeyPromptHandler;
    this.confineConfig = options?.confineConfig;
  }

  /**
   * The environment of an ssh process. What a client asked for comes before the app's own variables
   * (askpass, proxy), so it can never replace them. On a web server the client is a browser somewhere
   * else: only its display and language names are taken, and the server's ssh agent and credential
   * key are not handed to the child.
   */
  private sshChildEnv(config: SSHConnectionConfig, askpassEnv: Record<string, string>, clientEnv?: Record<string, string>): Record<string, string> {
    const account = Boolean(this.confineConfig) || isWebServerProcess();
    const env: Record<string, string> = {
      ...(account ? serverEnvForAccountChild(process.env) : (process.env as Record<string, string>)),
      TERM: 'xterm-256color',
      ...(account ? clientTerminalEnv(clientEnv) : clientEnv || {}),
      ...askpassEnv,
      ...SmartcardDetector.buildProxyEnv(config),
    };
    // The native agent's host capability is never an environment credential for a PTY.
    delete env.SSHS3_NATIVE_TOOL_KEY;
    delete env.SSHS3_NATIVE_TOOL_URL;
    return env;
  }

  public static getControlPath(config: SSHConnectionConfig): string {
    const hashInput = `${config.username}@${config.host}:${config.port ?? 22}:${config.privateKeyPath ?? ''}`;
    const digest = crypto.createHash('sha256').update(hashInput).digest('hex').slice(0, 8);
    return path.join(os.tmpdir(), `s3m-${digest}-${crypto.randomUUID().slice(0, 8)}.sock`);
  }

  public getControlPath(config: SSHConnectionConfig): string {
    return SSHPtyManager.getControlPath(config);
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

  /** Where an ssh process starts. A web client does not choose a folder on the server. */
  private childCwd(options?: PtyOptions): string {
    const fallback = process.env.HOME || process.cwd();
    return this.confineConfig || isWebServerProcess() ? fallback : (options?.cwd ?? fallback);
  }

  /**
   * Reconnects an existing session by spawning a new underlying SSH process.
   */
  public async reconnectSession(session: InternalSSHPtySession): Promise<boolean> {
    const config = session.config;
    const options = this.sessionOptions.get(session.sessionId);
    const cols = session.cols;
    const rows = session.rows;
    const cwd = this.childCwd(options);

    if (isDemoTarget(config.id, options?.profileId)) {
      // A demo target stays on the virtual terminal: reconnecting starts a fresh one, never ssh.
      session.bindPty(new DemoVirtualPty(config, cols, rows));
      return true;
    }

    const askpassEnv = session.askpassServer ? session.askpassServer.getEnv() : {};
    const env = this.sshChildEnv(config, askpassEnv, options?.env);

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

    const filteredConfig = applySshKeepaliveDefaults(
      this.withoutConflictingTunnels(config, session.sessionId)
    );
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
   * Creates and spawns an OpenSSH PTY session with the given connection configuration. A demo target
   * (`options.profileId`, see SshSessionOptions) gets the virtual demo terminal instead.
   */
  public async createSession(
    requested: SSHConnectionConfig,
    options?: SshSessionOptions
  ): Promise<SSHPtySession> {
    // A demo target never gets an ssh process, so there is nothing of the account's to check for it.
    const demo = isDemoTarget(requested.id, options?.profileId);
    const config = this.confineConfig && !demo ? this.confineConfig(requested) : requested;
    const sessionId = config.id || `ssh-${crypto.randomUUID()}`;
    this.sessionOptions.set(sessionId, options);
    const cols = options?.cols ?? 80;
    const rows = options?.rows ?? 24;
    const cwd = this.childCwd(options);

    if (isDemoTarget(config.id, options?.profileId)) {
      const demoPty = new DemoVirtualPty(config, cols, rows);
      const session = new InternalSSHPtySession({
        sessionId,
        config,
        pty: demoPty,
        cols,
        rows,
        manager: this,
      });
      this.sessions.set(sessionId, session);
      return session;
    }

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
          // ssh asks "continue connecting?" through askpass too; it must never reach the PIN modal.
          if (isHostKeyConfirmPrompt(rawPrompt)) {
            if (!this.hostKeyPromptHandler) return 'no';
            const info = parseHostKeyPrompt(rawPrompt, { host: config.host, port: config.port ?? 22 } as SFTPConfig);
            return (await this.hostKeyPromptHandler(info)) ? 'yes' : 'no';
          }
          // Kind only, never the answer. A 'password' prompt on a key-based profile means ssh could not
          // authenticate with the agent and fell back to asking for the account password.
          const promptKind = describeAskpassPrompt(rawPrompt, config).kind ?? 'passphrase';
          const saved = savedAskpassAnswer(rawPrompt, config);
          sshLog.info('askpass prompt', {
            sessionId,
            kind: promptKind,
            authType: config.authType,
            answeredFrom: saved ? 'saved' : 'ui',
            retry: Boolean(retry),
          });
          if (saved) return saved;
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
          return '';
        },
      });

      await askpassServer.start();
      askpassEnv = askpassServer.getEnv();
    }

    // In the app's private 0700 folder rather than the shared temp folder (M3); undefined means no multiplexing.
    const controlPath = process.platform !== 'win32' ? await createMuxControlPath() : undefined;
    let muxRegistryId: string | null = null;
    let filteredConfig: SSHConnectionConfig;
    let ptyProcess: IPty;

    // Everything from here to the spawn may throw (invalid proxy/tunnel config, argument
    // building, spawn itself); the askpass server and mux registry entry must not leak then.
    try {
      const env = this.sshChildEnv(config, askpassEnv, options?.env);

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

      filteredConfig = applySshKeepaliveDefaults(
        this.withoutConflictingTunnels(config, sessionId)
      );
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
    // A shell here would be a shell on the server itself, as the server's own user.
    if (this.confineConfig || isWebServerProcess()) {
      throw new Error('This is a shared sshs3 server: there is no local terminal here. Connect to one of your servers instead.');
    }
    const sessionId = `shell-${crypto.randomUUID()}`;
    const cols = options?.cols ?? 80;
    const rows = options?.rows ?? 24;
    const cwd = options?.cwd ?? (process.env.HOME || process.env.USERPROFILE || process.cwd());

    const shellBinary = options?.shellBinary ?? resolveLocalShellBinary(options?.shellType);
    const args: string[] = [...(options?.shellArgs ?? [])];
    if (process.platform === 'win32' && options?.shellType === 'wsl' && options?.wslDistro) {
      args.push('-d', options.wslDistro);
    }

    const env: Record<string, string> = {
      ...accountChildEnv(),
      TERM: 'xterm-256color',
    };
    delete env.SSHS3_NATIVE_TOOL_KEY;
    delete env.SSHS3_NATIVE_TOOL_URL;

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
    delete env.SSHS3_NATIVE_TOOL_KEY;
    delete env.SSHS3_NATIVE_TOOL_URL;
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
   * Writes data to an active session in ConPTY-safe 512-byte chunks.
   */
  public writeChunked(
    sessionId: string,
    data: string,
    options?: WriteChunkedOptions
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return Promise.resolve();
    if (session instanceof InternalSSHPtySession) {
      return session.writeChunked(data, options);
    }
    return writeChunked((chunk) => session.write(chunk), data, options);
  }

  public getSessionState(sessionId: string): SessionConnectionState | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    if (session instanceof InternalSSHPtySession) {
      return session.getConnectionState();
    }
    return session.isReconnecting?.() ? 'reconnecting' : 'connected';
  }

  public getSessionReconnectState(sessionId: string): SessionReconnectGraceState | undefined {
    const session = this.sessions.get(sessionId);
    if (session instanceof InternalSSHPtySession) {
      return session.getReconnectState();
    }
    return undefined;
  }

  public attachShareClient(
    sessionId: string,
    participant: { clientId: string; actor: string; role: SessionShareRole },
    onData: (data: string) => void
  ): SessionShareAttachment | undefined {
    const session = this.sessions.get(sessionId);
    if (session instanceof InternalSSHPtySession) {
      return session.attachShareClient(participant, onData);
    }
    return undefined;
  }

  public detachShareClient(sessionId: string, clientId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (session instanceof InternalSSHPtySession) {
      return session.leaveParticipant(clientId);
    }
    return false;
  }

  public setShareParticipantRole(
    sessionId: string,
    clientId: string,
    role: SessionShareRole
  ): SessionParticipant | undefined {
    const session = this.sessions.get(sessionId);
    if (session instanceof InternalSSHPtySession) {
      return session.setParticipantRole(clientId, role);
    }
    return undefined;
  }

  public writeFromClient(sessionId: string, clientId: string, data: string): boolean {
    const session = this.sessions.get(sessionId);
    if (session instanceof InternalSSHPtySession) {
      return session.writeFromClient(clientId, data);
    }
    return false;
  }

  public getSessionShareMetadata(sessionId: string): SessionShareMetadata | undefined {
    const session = this.sessions.get(sessionId);
    if (session instanceof InternalSSHPtySession) {
      return session.getShareMetadata();
    }
    return undefined;
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
   * Returns the current working directory of an active local shell session, or null if unknown.
   */
  public getSessionCwd(sessionId: string): string | null {
    const session = this.sessions.get(sessionId);
    return session && 'getCwd' in session ? (session as any).getCwd() : null;
  }

  /** Whether the local shell of this session currently runs an interactive ssh client. */
  public sessionHasSshClient(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return session && 'hasSshClient' in session ? Boolean((session as any).hasSshClient()) : false;
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
