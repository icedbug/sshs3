import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentLifecycleManager } from './AgentLifecycleManager';
import { AskpassServer, type AskpassPromptHandler } from '../smartcard/AskpassServer';
import { getAgentIdentities, getKeyAlgorithm } from '../smartcard/SmartcardSyncService';
import {
  listAgentIdentities,
  addSmartcardToAgent,
  addFido2ResidentKeysToAgent,
  FIDO2_PIN_REPLAY_WINDOW_MS,
  type AgentIdentity,
  type AgentTarget,
  type LoadIntoPrivateAgentOptions,
} from '../smartcard/SmartcardAgentLoader';
import { addCertifiedEd25519KeyToAgent, type AddCertifiedEd25519KeyOptions } from '../ca/agentProtocol';
import { createLogger } from '../log';
const appAgentLog = createLogger('app-agent');

const execFileAsync = promisify(execFile);

/** Upper bound for one `ssh-add` eviction call, which app quit waits on. */
const EVICT_TIMEOUT_MS = 3000;

/** "Enter PIN and confirm user presence for ED25519-SK key SHA256:…" — a FIDO2 signature asking for its PIN. */
const FIDO2_SIGNATURE_PIN_PROMPT = /\bPIN\b.*(-SK\b|authenticator|security key|user presence)/i;

/**
 * Why a load that was running or waiting when the user locked is reported as failed. Not a fault of the card or
 * the PIN, so callers must not treat it like a failed load (no cooldown).
 */
export class KeysLockedWhileLoadingError extends Error {
  constructor() {
    super('The keys were locked while they were being loaded');
    this.name = 'KeysLockedWhileLoadingError';
  }
}

/** sun_path is 104 bytes on macOS/BSD and 108 on Linux; stay below both. */
const MAX_UNIX_SOCKET_PATH = 100;

export interface AppAgentHandlers {
  /** Answers PIN/passphrase prompts raised by the agent itself (e.g. a later `verify-required` FIDO2 signature). */
  promptHandler?: AskpassPromptHandler;
  /** Called when the agent asks the user to touch a key. */
  onPresence?: (prompt: string) => void;
}

/** OpenSSH-style `SHA256:<base64, no padding>` fingerprint of a key blob (what `ssh-add -l` prints). */
export function fingerprintOfKeyBlob(keyBlob: Buffer): string {
  return `SHA256:${crypto.createHash('sha256').update(keyBlob).digest('base64').replace(/=+$/, '')}`;
}

/** Directory holding the app agent's socket; created 0700 and verified before use. */
export function resolveAppAgentDir(): string {
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  if (runtimeDir && path.isAbsolute(runtimeDir) && fs.existsSync(runtimeDir)) {
    return path.join(runtimeDir, 'sshs3');
  }
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : 'user';
  return path.join(os.tmpdir(), `sshs3-${uid}`);
}

/**
 * Creates `dir` (mode 0700) if missing and refuses to use it unless it is a real directory, owned by
 * this user and closed to group/others. The fallback location lives under a shared temp directory,
 * where another user could otherwise pre-create the path (or a symlink to somewhere they control)
 * and have the agent socket land in a place they can reach.
 */
export async function ensureSecureDir(dir: string): Promise<void> {
  try {
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const st = await fs.promises.lstat(dir);
  const reason = insecureDirReason(st, process.platform, typeof process.getuid === 'function' ? process.getuid() : undefined);
  if (reason) {
    throw new Error(`Refusing to use ${dir} for the app ssh-agent: ${reason}`);
  }
}

/**
 * Why a directory must not hold the app agent's files, or null when it is fine. A symlink or a non-directory is
 * refused everywhere. The owner and group/other checks use POSIX permission bits, which Windows does not have
 * (its stat reports 0o666/0o777 for everything); there the per-user temp directory is protected by its ACL, so
 * those two checks are skipped.
 */
export function insecureDirReason(
  st: Pick<fs.Stats, 'mode' | 'uid' | 'isSymbolicLink' | 'isDirectory'>,
  platform: NodeJS.Platform,
  uid: number | undefined
): string | null {
  if (st.isSymbolicLink() || !st.isDirectory()) return 'not a plain directory';
  if (platform === 'win32') return null;
  if (uid !== undefined && st.uid !== uid) return 'owned by another user';
  if ((st.mode & 0o077) !== 0) return 'accessible by group/others';
  return null;
}

/**
 * One app-wide ssh-agent for the 'agent-global' PIN caching mode: every unlocked smartcard / FIDO2
 * key is loaded into it, and terminals and SFTP connections use its (stable) socket instead of one
 * private agent per device. The agent process is a normal private agent (registered in
 * AgentRegistry, killed on exit); this class adds the stable socket, the askpass server that lives as
 * long as the agent, and lock/list/remove. It does not load keys itself.
 *
 * On Windows the "agent" is the shared OpenSSH service pipe (which also holds identities this app
 * did not load), so locking only evicts the PKCS#11 libraries registered via `noteLoadedLibrary`.
 */
export class AppAgent {
  private pid = 0;
  private socketPath: string | null = null;
  private askpass: AskpassServer | null = null;
  private ensuring: Promise<string> | null = null;
  private loadedLibs = new Set<string>();
  /** Windows only: fingerprint -> key blob of identities we added to the shared agent without a PKCS#11 library (FIDO2). */
  private loadedKeys = new Map<string, Buffer>();
  private handlers: AppAgentHandlers = {};
  private onExit?: () => void;
  private addQueue: Promise<unknown> = Promise.resolve();
  /** Bumped by every lock. A load requested before a lock must not leave its keys (or PIN) behind after it. */
  private lockEpoch = 0;

  /**
   * The PIN entered when the FIDO2 keys were loaded, kept in memory only until the keys are locked.
   * A `verify-required` key asks for PIN + touch on every signature; replaying this PIN means only the
   * touch is needed (what the per-card FIDO2 agent did before).
   */
  private fido2Pin: string | undefined;
  private lastFido2PinReplay = 0;

  private delegatePrompt: AskpassPromptHandler = (prompt, retry) => {
    if (this.fido2Pin !== undefined && FIDO2_SIGNATURE_PIN_PROMPT.test(prompt)) {
      const now = Date.now();
      if (now - this.lastFido2PinReplay > FIDO2_PIN_REPLAY_WINDOW_MS) {
        this.lastFido2PinReplay = now;
        return this.fido2Pin;
      }
      // Asked again right after a replay: the PIN was wrong (or changed). Never keep replaying it —
      // that would burn the authenticator's PIN retries — ask the user instead.
      this.fido2Pin = undefined;
    }
    return this.handlers.promptHandler?.(prompt, retry) ?? '';
  };
  private delegatePresence = (prompt: string): void => this.handlers.onPresence?.(prompt);

  /** Handlers used for prompts the agent raises after keys were loaded; can be changed at any time. */
  public setHandlers(handlers: AppAgentHandlers): void {
    this.handlers = handlers;
  }

  /** Called when the agent was found dead on a later ensure(), so the owner can drop state tied to its keys. */
  public setOnExit(callback: (() => void) | undefined): void {
    this.onExit = callback;
  }

  public getSocketPath(): string | null {
    return this.socketPath;
  }

  /** Records that a PKCS#11 library was loaded, so Windows can evict just it (see class comment). */
  public noteLoadedLibrary(pkcs11LibPath: string): void {
    this.loadedLibs.add(pkcs11LibPath);
  }

  /** Starts the agent if needed and returns its socket path. Concurrent callers share one start. */
  public ensure(): Promise<string> {
    if (!this.ensuring) {
      this.ensuring = this.doEnsure().finally(() => {
        this.ensuring = null;
      });
    }
    return this.ensuring;
  }

  private async doEnsure(): Promise<string> {
    if (this.socketPath) {
      if (await AgentLifecycleManager.probeSocket(this.socketPath)) {
        return this.socketPath;
      }
      appAgentLog.warn('agent is no longer reachable; restarting');
      await this.discardDeadAgent();
    }

    if (process.platform === 'win32') {
      // The shared OpenSSH service; no stable path of our own and no askpass env to inject.
      const { pid, socketPath } = await AgentLifecycleManager.spawnPrivateAgent();
      this.pid = pid;
      this.socketPath = socketPath;
      return socketPath;
    }

    const dir = resolveAppAgentDir();
    await ensureSecureDir(dir);
    const wanted = await this.chooseSocketPath(dir);
    if (wanted.length > MAX_UNIX_SOCKET_PATH) {
      throw new Error(`App ssh-agent socket path is too long (${wanted.length} > ${MAX_UNIX_SOCKET_PATH}): ${wanted}`);
    }

    const askpass = new AskpassServer({
      promptHandler: this.delegatePrompt,
      onPresence: this.delegatePresence,
    });
    await askpass.start();
    try {
      const { pid, socketPath } = await AgentLifecycleManager.spawnPrivateAgent(askpass.getEnv(), {
        socketPath: wanted,
      });
      this.pid = pid;
      this.socketPath = socketPath;
      this.askpass = askpass;
      appAgentLog.info(`started pid=${pid}, socket=${socketPath}`);
      return socketPath;
    } catch (err) {
      await askpass.stop().catch(() => {});
      throw err;
    }
  }

  /** Picks `agent.sock`, or `agent-<pid>.sock` when another live app instance already owns it. Removes stale sockets. */
  private async chooseSocketPath(dir: string): Promise<string> {
    for (const name of ['agent.sock', `agent-${process.pid}.sock`]) {
      const candidate = path.join(dir, name);
      let st: fs.Stats;
      try {
        st = await fs.promises.lstat(candidate);
      } catch {
        return candidate;
      }
      if (!st.isSocket()) {
        throw new Error(`Refusing to replace ${candidate}: not a socket`);
      }
      if (await AgentLifecycleManager.probeSocket(candidate)) continue;
      await fs.promises.unlink(candidate);
      return candidate;
    }
    throw new Error(`No free app ssh-agent socket in ${dir}`);
  }

  private async discardDeadAgent(): Promise<void> {
    const { pid, socketPath, askpass } = this;
    this.pid = 0;
    this.socketPath = null;
    this.askpass = null;
    this.loadedLibs.clear();
    this.fido2Pin = undefined;
    await askpass?.stop().catch(() => {});
    if (pid > 0) {
      AgentLifecycleManager.killPrivateAgent(pid);
      if (socketPath) await fs.promises.unlink(socketPath).catch(() => {});
    }
    this.onExit?.();
  }

  /** Loads a PKCS#11 module's key into the agent (PIN via `promptHandler`), starting the agent if needed. */
  public async addPkcs11(
    pkcs11LibPath: string,
    promptHandler: AskpassPromptHandler,
    options?: LoadIntoPrivateAgentOptions
  ): Promise<void> {
    await this.runAdd(async (target) => {
      const loaded = await addSmartcardToAgent(target, pkcs11LibPath, promptHandler, options);
      // Recorded here, not after runAdd returns: if the user locked meanwhile, runAdd throws and its clean-up
      // (which on Windows evicts only recorded libraries) must already know about this one.
      this.noteLoadedLibrary(pkcs11LibPath);
      return loaded;
    });
  }

  /** Loads the connected security key's FIDO2 resident credentials into the agent. */
  public async addFido2Resident(promptHandler: AskpassPromptHandler, options?: LoadIntoPrivateAgentOptions): Promise<void> {
    let enteredPin: string | undefined;
    await this.runAdd(async (target) => {
      // Windows: the agent is the shared system service, which also holds keys we didn't load. FIDO2 keys
      // have no library to `ssh-add -e` by, so remember exactly which identities this load added.
      const before = process.platform === 'win32' ? await this.identityBlobs(target.socketPath) : null;
      try {
        return await addFido2ResidentKeysToAgent(target, promptHandler, {
          ...options,
          onPinEntered: (pin) => (enteredPin = pin),
        });
      } finally {
        // Also when the load fails part-way: keys it already added must still be evicted on lock/quit.
        // Best-effort attribution: a key another process adds to the shared agent in this window is
        // recorded too, and would be evicted with ours.
        if (before) {
          for (const [fp, blob] of await this.identityBlobs(target.socketPath)) {
            if (!before.has(fp)) this.loadedKeys.set(fp, blob);
          }
        }
      }
    });
    // Only remember a PIN that actually unlocked the keys.
    if (enteredPin) this.fido2Pin = enteredPin;
  }

  /**
   * Loads an OpenSSH Ed25519 certificate and its private key directly into the agent
   * over the agent wire protocol (SSH2_AGENTC_ADD_ID_CONSTRAINED), constrained by certificate lifetime.
   */
  public async addCertifiedEd25519Key(options: Omit<AddCertifiedEd25519KeyOptions, 'socketPath'>): Promise<void> {
    await this.runAdd(async ({ socketPath }) => {
      await addCertifiedEd25519KeyToAgent(socketPath, options);
      if (process.platform === 'win32') {
        const fp = fingerprintOfKeyBlob(options.certificateWire);
        this.loadedKeys.set(fp, options.certificateWire);
      }
    });
  }

  /**
   * Adds are serialized: most readers only allow one PKCS#11/FIDO2 transaction at a time. Each add
   * prompts through its own askpass server (see AgentTarget), so the agent's askpass server — which
   * answers signature-time prompts — is never involved and keeps using this owner's handlers.
   */
  private runAdd(add: (target: AgentTarget) => Promise<unknown>, options: { guardLock?: boolean } = {}): Promise<unknown> {
    const guardLock = options.guardLock ?? true;
    // Taken when the load is requested, not when it starts: one still waiting its turn when the user locks is
    // part of what the lock cancels.
    const epoch = this.lockEpoch;
    const task = this.addQueue.then(async () => {
      if (guardLock && this.lockEpoch !== epoch) throw new KeysLockedWhileLoadingError();
      const socketPath = await this.ensure();
      let result: unknown;
      let failure: unknown;
      try {
        result = await add({ pid: this.pid, socketPath });
      } catch (err) {
        failure = err;
      }
      if (guardLock && this.lockEpoch !== epoch) {
        // Locked while this load ran: lockAll() already wiped, so whatever the load added since must go too.
        await this.forgetKeys(socketPath);
        throw new KeysLockedWhileLoadingError();
      }
      if (failure) throw failure;
      return result;
    });
    this.addQueue = task.catch(() => {});
    return task;
  }

  /**
   * Writes the public half of the agent's keys with the given fingerprints to files, so an `ssh -i
   * <file>.pub -o IdentitiesOnly=yes` run can select exactly those keys from this shared agent.
   * Public keys are not secret, but the files live in a verified 0700 directory (and are 0600) like
   * the socket. Not supported on Windows (shared service pipe): returns an empty list there.
   */
  public async writePublicKeyFiles(fingerprints: Iterable<string>): Promise<string[]> {
    const socketPath = this.socketPath;
    if (!socketPath || process.platform === 'win32') return [];
    const wanted = new Set(fingerprints);
    if (wanted.size === 0) return [];

    const dir = path.join(resolveAppAgentDir(), 'keys');
    await ensureSecureDir(path.dirname(dir));
    await ensureSecureDir(dir);

    const files: string[] = [];
    for (const identity of await getAgentIdentities(socketPath)) {
      if (!wanted.has(fingerprintOfKeyBlob(identity.keyBlob))) continue;
      const name = crypto.createHash('sha256').update(identity.keyBlob).digest('hex').slice(0, 32);
      const file = path.join(dir, `${name}.pub`);
      const comment = identity.comment.replace(/[\r\n]+/g, ' ');
      const line = `${getKeyAlgorithm(identity.keyBlob)} ${identity.keyBlob.toString('base64')} ${comment}\n`;
      await fs.promises.writeFile(file, line, { mode: 0o600 });
      files.push(file);
    }
    return files;
  }

  /**
   * Evicts the agent keys with the given fingerprints (`ssh-add -d` with the key's public half), leaving
   * every other key loaded. Used to drop keys a card contributed that must not be offered (e.g. signing
   * certificates). Best-effort: returns how many were removed, and a failure for one key never stops the
   * rest. On Windows (the shared system service) only these exact keys are evicted, never anything else.
   */
  public async removeIdentities(fingerprints: Iterable<string>): Promise<number> {
    const unwanted = new Set(fingerprints);
    if (!this.socketPath || unwanted.size === 0) return 0;

    if (process.platform === 'win32') {
      const socketPath = this.socketPath;
      let removed = 0;
      for (const [fp, blob] of await this.identityBlobs(socketPath)) {
        if (unwanted.has(fp) && (await this.evictBlob(socketPath, blob))) removed++;
      }
      return removed;
    }

    // Only evicts keys, so a lock that happens meanwhile has nothing to undo: not guarded.
    return (await this.runAdd(async ({ socketPath }) => {
      const dir = path.join(resolveAppAgentDir(), 'keys');
      await ensureSecureDir(path.dirname(dir));
      await ensureSecureDir(dir);

      let removed = 0;
      for (const identity of await getAgentIdentities(socketPath)) {
        if (!unwanted.has(fingerprintOfKeyBlob(identity.keyBlob))) continue;
        const name = crypto.createHash('sha256').update(identity.keyBlob).digest('hex').slice(0, 32);
        const file = path.join(dir, `remove-${name}.pub`);
        const line = `${getKeyAlgorithm(identity.keyBlob)} ${identity.keyBlob.toString('base64')}\n`;
        try {
          await fs.promises.writeFile(file, line, { mode: 0o600 });
          await execFileAsync('ssh-add', ['-d', file], { env: { ...process.env, SSH_AUTH_SOCK: socketPath } });
          removed++;
        } catch (err) {
          appAgentLog.warn('could not remove an unwanted identity from the agent:', (err as Error).message);
        } finally {
          await fs.promises.rm(file, { force: true }).catch(() => {});
        }
      }
      return removed;
    }, { guardLock: false })) as number;
  }

  public async list(): Promise<AgentIdentity[]> {
    return this.socketPath ? listAgentIdentities(this.socketPath) : [];
  }

  /** Removes one PKCS#11 library's keys from the agent, leaving everything else loaded. */
  public async remove(pkcs11LibPath: string): Promise<void> {
    if (!this.socketPath) return;
    await AgentLifecycleManager.unloadCard(this.socketPath, pkcs11LibPath);
    this.loadedLibs.delete(pkcs11LibPath);
  }

  /** Forgets every key (the "lock" action) without stopping the agent, so its socket stays valid for open terminals. */
  public async lockAll(): Promise<void> {
    this.lockEpoch++;
    this.fido2Pin = undefined;
    const socketPath = this.socketPath;
    if (!socketPath) return;
    await this.forgetKeys(socketPath);
  }

  /** Removes the loaded keys from the agent (everything it holds on Unix, only what we loaded on Windows). */
  private async forgetKeys(socketPath: string): Promise<void> {
    if (process.platform === 'win32') {
      for (const lib of this.loadedLibs) {
        await AgentLifecycleManager.unloadCard(socketPath, lib);
      }
      await this.evictLoadedKeys(socketPath);
    } else {
      await execFileAsync('ssh-add', ['-D'], { env: { ...process.env, SSH_AUTH_SOCK: socketPath } }).catch(() => {
        // Best-effort: nothing loaded, or the agent already went away.
      });
    }
    this.loadedLibs.clear();
    this.loadedKeys.clear();
  }

  private async identityBlobs(socketPath: string): Promise<Map<string, Buffer>> {
    const blobs = new Map<string, Buffer>();
    try {
      for (const identity of await getAgentIdentities(socketPath)) {
        blobs.set(fingerprintOfKeyBlob(identity.keyBlob), identity.keyBlob);
      }
    } catch {
      // Agent unreachable: nothing to record.
    }
    return blobs;
  }

  /**
   * Windows only: records the shared agent's identities with these fingerprints as ours, so lock/quit
   * evicts them. Needed for keys the app did not add itself this run (already in the service from an
   * earlier run, or loaded by `ssh-add -s` whose `-e` counterpart does not reliably work there).
   */
  public async adoptIdentities(fingerprints: Iterable<string>): Promise<void> {
    if (process.platform !== 'win32' || !this.socketPath) return;
    const wanted = new Set(fingerprints);
    for (const [fp, blob] of await this.identityBlobs(this.socketPath)) {
      if (wanted.has(fp)) this.loadedKeys.set(fp, blob);
    }
  }

  /** Windows only: evicts the identities with these fingerprints from the shared agent. Best-effort. */
  public async evictIdentities(fingerprints: Iterable<string>): Promise<void> {
    if (process.platform !== 'win32' || !this.socketPath) return;
    const wanted = new Set(fingerprints);
    for (const [fp, blob] of await this.identityBlobs(this.socketPath)) {
      if (!wanted.has(fp)) continue;
      await this.evictBlob(this.socketPath, blob);
      this.loadedKeys.delete(fp);
    }
  }

  /** Windows: `ssh-add -d` each identity recorded in `loadedKeys`, leaving everything else in the shared agent. Best-effort. */
  private async evictLoadedKeys(socketPath: string): Promise<void> {
    // Skip keys that are already gone (e.g. removed with their PKCS#11 library): `ssh-add -d` reports
    // those as "agent refused operation".
    const present = await this.identityBlobs(socketPath);
    for (const [fp, blob] of this.loadedKeys) {
      if (present.has(fp)) await this.evictBlob(socketPath, blob);
    }
    this.loadedKeys.clear();
  }

  /** Windows: `ssh-add -d` for one identity. Returns whether it was removed. */
  private async evictBlob(socketPath: string, blob: Buffer): Promise<boolean> {
    const file = path.join(os.tmpdir(), `sshs3-evict-${crypto.randomUUID()}.pub`);
    try {
      await fs.promises.writeFile(file, `${getKeyAlgorithm(blob)} ${blob.toString('base64')}\n`);
      // Bounded: quit waits for this, and a stopped/hung agent service must not keep the app from exiting.
      await execFileAsync('ssh-add.exe', ['-d', file], {
        env: { ...process.env, SSH_AUTH_SOCK: socketPath },
        timeout: EVICT_TIMEOUT_MS,
      });
      return true;
    } catch (err) {
      appAgentLog.warn('could not evict an identity from the agent:', (err as Error).message);
      return false;
    } finally {
      await fs.promises.rm(file, { force: true }).catch(() => {});
    }
  }

  /** Stops the agent and its askpass server and removes the socket. Safe to call repeatedly. */
  public async shutdown(): Promise<void> {
    const pid = this.pid;
    if (process.platform === 'win32' && this.socketPath) {
      await this.lockAll();
    }
    const { socketPath, askpass } = this;
    this.pid = 0;
    this.socketPath = null;
    this.askpass = null;
    this.loadedLibs.clear();
    this.fido2Pin = undefined;
    await askpass?.stop().catch(() => {});
    if (pid > 0) {
      AgentLifecycleManager.killPrivateAgent(pid);
      if (socketPath) await fs.promises.unlink(socketPath).catch(() => {});
    }
    if (process.platform !== 'win32') {
      await fs.promises.rm(path.join(resolveAppAgentDir(), 'keys'), { recursive: true, force: true }).catch(() => {});
    }
  }
}
