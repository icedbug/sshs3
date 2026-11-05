import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentLifecycleManager } from '../ssh/AgentLifecycleManager';
import { AskpassServer, type AskpassPromptHandler, type AskpassPromptRetryContext } from './AskpassServer';
import { withPkcs11Lock } from './Pkcs11Lock';
import { createLogger } from '../log';
const agentLoaderLog = createLogger('agent-loader');

const execFileAsync = promisify(execFile);

export interface LoadedSmartcardAgent {
  pid: number;
  socketPath: string;
  /**
   * Only set when the caller opted into `keepAskpassAliveForAgentLifetime`
   * (see LoadIntoPrivateAgentOptions) — still running, and wired into the
   * agent process's own environment, so a *later* sign request the agent
   * itself has to prompt for (not just this initial load) still goes
   * through this app's own PIN modal. The caller now owns stopping it
   * (`await askpassServer.stop()`) whenever the agent itself is torn down.
   */
  askpassServer?: AskpassServer;
}

/**
 * Substrings (case-insensitive) OpenSSH/its PKCS#11 or FIDO2 provider is
 * known to print when it's blocked waiting for a physical touch on the key
 * (as opposed to a PIN, which goes through the Askpass protocol instead).
 * This is informational text written straight to the child's stdout/stderr,
 * never a real prompt the OpenSSH askpass protocol asks us to answer, so it
 * has to be scraped from the process output rather than intercepted like a
 * PIN. Kept as an allowlist with graceful non-detection (rather than a
 * strict parse) since the exact wording varies across OpenSSH/libfido2
 * versions and platforms.
 */
const PRESENCE_HINT_PATTERNS: RegExp[] = [
  /confirm user presence/i,
  /touch (your|the) (security key|authenticator|yubikey|token)/i,
  /please touch/i,
];

/**
 * Whether an error from `execWithPresenceDetection` describes a completely
 * textless process failure — i.e. its message is exactly
 * "<bin> <args> exited with code N" with no trailing ": <detail>" suffix.
 * Exported so the "no resident credentials yet" heuristic below can be
 * unit-tested without spawning a real `ssh-add`.
 */
export function isTextlessExitFailure(err: unknown): boolean {
  return (
    err instanceof Error &&
    (/exited with code \d+$/.test(err.message) ||
      /exited with code \d+: Enter PIN for authenticator:?$/i.test(err.message))
  );
}

/**
 * Runs a command while watching its combined stdout/stderr for a physical
 * "touch the key" hint, invoking `onPresenceRequested` (at most once) the
 * moment one is seen. Resolves once the process exits 0, otherwise rejects
 * with an error describing the failure — mirrors the subset of
 * child_process.execFile's contract this module actually relies on
 * (a timeout, and a thrown error for a non-zero exit), since execFile itself
 * only buffers output until the process exits and so can never observe the
 * hint in time to still be useful.
 */
export function execWithPresenceDetection(
  bin: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; timeoutMs: number; onOutput?: (text: string) => void },
  onPresenceRequested?: () => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const logPrefix = `[exec] ${bin} ${args.join(' ')}`;
    agentLoaderLog.info(`${logPrefix}: spawning (pid pending), timeout=${opts.timeoutMs}ms`);
    const child = spawn(bin, args, { env: opts.env });
    agentLoaderLog.info(`${logPrefix}: spawned pid=${child.pid}`);
    // None of our callers ever have interactive input to feed a child (PIN/touch both go through
    // Askpass/the device itself, never stdin) — but some OpenSSH tools fall back to an interactive
    // "Overwrite? (y/n)" stdin prompt in cases we don't otherwise detect (e.g. ssh-keygen finding a
    // same-scoped resident credential already on the token). Closing stdin immediately turns that
    // into a fast, clearly-worded failure (still captured below via fullOutput) instead of hanging
    // until the timeout — a real touch-blocked step and "waiting on stdin we'll never answer" would
    // otherwise look identical to the user.
    child.stdin?.end();
    let settled = false;
    let presenceCheckBuf = '';
    let presenceSignaled = false;
    // Captures everything the child prints, independent of presence detection above, purely so
    // a non-zero exit can surface *why* (e.g. "no FIDO authenticator found", a PIN retry count,
    // a missing ssh-sk-helper) instead of a bare exit code — ssh-add's own error text is the only
    // place that reason exists, and it was previously discarded here entirely.
    let fullOutput = '';

    const timer = setTimeout(() => {
      agentLoaderLog.warn(`${logPrefix}: timed out after ${opts.timeoutMs}ms, killing pid=${child.pid}`);
      child.kill();
    }, opts.timeoutMs);

    const checkForPresenceHint = (streamName: 'stdout' | 'stderr') => (chunk: Buffer): void => {
      const text = chunk.toString();
      agentLoaderLog.debug(`${logPrefix} [${streamName}]: ${JSON.stringify(text)}`);
      fullOutput += text;
      opts.onOutput?.(text);
      if (presenceSignaled) return;
      presenceCheckBuf += text;
      if (PRESENCE_HINT_PATTERNS.some((re) => re.test(presenceCheckBuf))) {
        presenceSignaled = true;
        onPresenceRequested?.();
      }
    };
    child.stdout?.on('data', checkForPresenceHint('stdout'));
    child.stderr?.on('data', checkForPresenceHint('stderr'));

    child.on('error', (err) => {
      agentLoaderLog.warn(`${logPrefix}: process error event:`, err);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      agentLoaderLog.info(`${logPrefix}: closed with code ${code}`);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        const detail = fullOutput.trim();
        const suffix = detail ? `: ${detail}` : '';
        reject(new Error(`${bin} ${args.join(' ')} exited with code ${code}${suffix}`));
      }
    });
  });
}

export interface AgentIdentity {
  bits: string;
  fingerprint: string;
  comment: string;
  keyType: string;
}

/**
 * Lists the identities an ssh-agent currently holds (`ssh-add -l`), parsed
 * into structured entries. For a PKCS#11-loaded smartcard key this surfaces
 * the certificate's label as `comment` (e.g. "PIV AUTH pubkey"). Returns an
 * empty array if the agent holds nothing, or can't be reached.
 */
export async function listAgentIdentities(socketPath: string): Promise<AgentIdentity[]> {
  const sshAddBin = process.platform === 'win32' ? 'ssh-add.exe' : 'ssh-add';
  const { stdout } = await execFileAsync(sshAddBin, ['-l'], {
    env: { ...process.env, SSH_AUTH_SOCK: socketPath },
  }).catch(() => ({ stdout: '' }));

  if (!stdout || stdout.toLowerCase().includes('no identities')) {
    return [];
  }

  const identities: AgentIdentity[] = [];
  for (const line of stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)\s+\(([^)]+)\)$/);
    if (match) {
      identities.push({ bits: match[1], fingerprint: match[2], comment: match[3], keyType: match[4] });
    }
  }
  return identities;
}

/**
 * An already-running agent to add identities to, instead of spawning a throwaway one (see AppAgent).
 * The agent is never killed here, even if the add fails — it may hold other keys.
 *
 * Load-time PIN/touch prompts come from the `ssh-add` process itself (agents for PIV are spawned without
 * any askpass environment and still load fine), so each add gets its own temporary askpass server in
 * `ssh-add`'s environment and never touches the agent's own askpass server. That server answers prompts
 * the agent raises *later* (e.g. a `verify-required` FIDO2 signature) and must keep belonging to the
 * agent's owner: otherwise such a prompt arriving mid-load would get this load's PIN.
 */
export interface AgentTarget {
  pid: number;
  socketPath: string;
}

/**
 * Which kind of secret an askpass prompt is asking for, to label the PIN dialog: a FIDO2 security key
 * (e.g. "Enter PIN and confirm user presence for ED25519-SK key SHA256:…", "Enter PIN for
 * authenticator:") or a PIV smartcard ("Enter passphrase for PKCS#11:").
 */
export function pinPromptKind(prompt: string): 'fido2' | 'smartcard' {
  return /authenticator|security key|fido|-SK\b|user presence/i.test(prompt) ? 'fido2' : 'smartcard';
}

/** Output of a refused/failed `ssh-add` that nevertheless exits 0 (seen with "agent refused operation"). */
const ADD_FAILURE_OUTPUT = /refused|fail|error|cannot|unable|invalid/i;

export interface LoadIntoPrivateAgentOptions {
  retries?: number;
  retryDelayMs?: number;
  /** How many wrong-PIN entries to allow (with an inline "Incorrect PIN, try again" re-prompt) before giving up. Default 3. */
  maxPinAttempts?: number;
  /** Called (possibly more than once, across retries) when the card/key appears to be waiting for a physical touch. */
  onPresenceRequested?: () => void;
  /** Called once the attempt that triggered `onPresenceRequested` has finished, successfully or not. */
  onPresenceCleared?: () => void;
  /**
   * `ssh-add -K` exits non-zero with *zero* stdout/stderr output (no touch
   * prompt, no error text, the PIN's own retry counter unaffected by a
   * correct PIN) when the connected authenticator simply has no resident
   * SSH credentials yet — this is an OpenSSH quirk, not a real failure, and
   * was previously indistinguishable from a genuine error, causing a
   * needless 3-retry PIN-reprompt loop for what is really just "nothing to
   * load". When set, a completely textless failure is treated as success
   * with zero identities loaded rather than retried/thrown. Only
   * appropriate for `-K` (FIDO2 resident keys) — a PIV `-s <lib>` failure
   * always has real, non-empty diagnostic text.
   */
  emptyFailureMeansNoIdentities?: boolean;
  /** Called with each PIN/passphrase the user enters for this load (not for server account passwords). */
  onPinEntered?: (pin: string) => void;
  /**
   * Keeps the Askpass server backing this load running (and wires its env
   * into the spawned agent PROCESS itself, not just this one load call)
   * instead of stopping it once the load finishes. Needed for FIDO2 keys
   * generated with `-O verify-required`: the agent re-prompts for PIN+touch
   * on every future signature, not just when the key is first loaded, and
   * that later prompt comes from the long-lived agent process — without
   * this, it falls back to whatever SSH_ASKPASS this app inherited (e.g.
   * the desktop's own ksshaskpass), popping up an unstyled system dialog
   * instead of this app's own PIN modal. The caller becomes responsible for
   * stopping the returned `askpassServer` when the agent itself is torn
   * down. Leave unset for short-lived, single-use agents (list/generate
   * flows) where nothing signs anything after the load completes anyway.
   */
  keepAskpassAliveForAgentLifetime?: boolean;
}

/** A FIDO2 signature PIN asked for again within this time of a replay is treated as wrong (also used by AppAgent). */
export const FIDO2_PIN_REPLAY_WINDOW_MS = 3000;

/**
 * Spawns a private, app-managed ssh-agent and runs `ssh-add <addArgs>`
 * against it, prompting for the PIN via our own AskpassServer. Shared by
 * `loadSmartcardIntoPrivateAgent` (PIV/PKCS#11, `-s <lib>`) and
 * `loadFido2ResidentKeysIntoPrivateAgent` (FIDO2 discoverable credentials,
 * `-K`) — both are "hand a physical key's credentials to a throwaway agent"
 * operations with identical PIN-caching, retry and touch-detection needs,
 * differing only in the literal ssh-add invocation.
 *
 * Deliberately never touches the process's inherited SSH_AUTH_SOCK (e.g.
 * the desktop's gnome-keyring/KWallet agent) — reusing that agent is what
 * causes the OS to independently (and repeatedly) prompt for the same
 * smartcard's PIN outside of sshs3's own UI. On failure, the spawned agent
 * is killed before the error propagates.
 *
 * Retries the ssh-add step a few times: most PIV/FIDO2 readers only allow
 * one active transaction at a time, so this can transiently collide with
 * another process still holding the card right after the PIN was entered.
 * The user is only ever asked for the PIN once — its answer is cached and
 * reused for every retry, whether promptHandler is a live interactive
 * prompt or a fixed, already-known-good value — retries repeat the
 * mechanical ssh-add step, never the human interaction.
 */
async function runAddIntoPrivateAgent(
  addArgs: string[],
  promptHandler: AskpassPromptHandler,
  options?: LoadIntoPrivateAgentOptions,
  target?: AgentTarget
): Promise<LoadedSmartcardAgent> {
  // With a target agent the caller owns the agent; this add's own askpass server is always stopped below.
  const keepAlive = !target && (options?.keepAskpassAliveForAgentLifetime ?? false);
  const logPrefix = `[smartcard] runAddIntoPrivateAgent(${addArgs.join(' ')})`;

  // Caches the PIN so the user isn't asked again for a mechanical ssh-add retry after a transient
  // collision. For a `keepAlive` agent (the per-session FIDO2 agent) it is also replayed for later
  // signature prompts, so a verify-required key only needs a touch: the same deliberate, memory-only
  // exception as AppAgent's FIDO2 PIN. After the load a replay is guarded (see `replayingPromptHandler`):
  // a PIN that is asked for again right after a replay was wrong, and is never replayed again.
  let cachedPin: string | undefined;
  let inFlightPrompt: Promise<string> | undefined;
  // Set by the retry loop below just before re-entering it after a wrong PIN, and consumed (cleared)
  // by the very next prompt this handler issues, so it only ever decorates that one re-prompt.
  let pendingRetryContext: AskpassPromptRetryContext | undefined;
  const cachingPromptHandler: AskpassPromptHandler = async (prompt) => {
    // Only reuse cached key PIN if the prompt is for the authenticator, key, or smartcard passphrase/PIN.
    // If OpenSSH is asking for a server/account password (e.g. "user@host's password:"), never supply the key PIN.
    const isAccountPasswordPrompt = /password/i.test(prompt) && !/pin|passphrase/i.test(prompt);
    if (!isAccountPasswordPrompt && cachedPin !== undefined) {
      agentLoaderLog.info(`${logPrefix}: reusing already-entered PIN for a retry (prompt: "${prompt}")`);
      if (/presence|touch/i.test(prompt)) {
        options?.onPresenceRequested?.();
      }
      return cachedPin;
    }
    if (inFlightPrompt) {
      agentLoaderLog.info(`${logPrefix}: awaiting in-flight PIN prompt (prompt: "${prompt}")`);
      return inFlightPrompt;
    }
    agentLoaderLog.info(`${logPrefix}: asking for a fresh PIN (prompt: "${prompt}")`);
    const retryContext = pendingRetryContext;
    pendingRetryContext = undefined;
    inFlightPrompt = (async () => {
      try {
        const pin = await promptHandler(prompt, retryContext);
        if (!isAccountPasswordPrompt) {
          cachedPin = pin;
          options?.onPinEntered?.(pin);
        }
        if (/presence|touch/i.test(prompt)) {
          options?.onPresenceRequested?.();
        }
        return pin;
      } finally {
        inFlightPrompt = undefined;
      }
    })();
    return inFlightPrompt;
  };

  let lastReplayAt = 0;
  const replayingPromptHandler: AskpassPromptHandler = async (prompt, retry) => {
    const isAccountPasswordPrompt = /password/i.test(prompt) && !/pin|passphrase/i.test(prompt);
    if (!isAccountPasswordPrompt && cachedPin !== undefined) {
      const now = Date.now();
      if (now - lastReplayAt > FIDO2_PIN_REPLAY_WINDOW_MS) {
        lastReplayAt = now;
        return cachingPromptHandler(prompt, retry); // replays the cached PIN
      }
      // Asked again right after a replay: the PIN was wrong (or changed). Replaying it again would burn the
      // authenticator's PIN retries, so ask the user.
      cachedPin = undefined;
    }
    return cachingPromptHandler(prompt, retry);
  };

  const askpassServer = new AskpassServer({
    promptHandler: cachingPromptHandler,
    onPresence: () => options?.onPresenceRequested?.(),
  });
  await askpassServer.start();

  const retries = options?.retries ?? 3;
  const retryDelayMs = options?.retryDelayMs ?? 1200;
  // A wrong PIN gets its own budget, separate from `retries` (which is for mechanical
  // card-busy collisions): the user gets up to this many PIN entries before giving up.
  const maxPinAttempts = options?.maxPinAttempts ?? 3;
  let pinAttempts = 0;

  // Assigned inside the try below: a failure to spawn the agent or to list its identities must still reach the
  // catch/finally that stop the askpass server (and kill an agent that did start).
  let pid = 0;
  let socketPath: string;
  try {
    ({ pid, socketPath } =
      target ?? (await AgentLifecycleManager.spawnPrivateAgent(keepAlive ? askpassServer.getEnv() : undefined)));
    // A shared agent may already hold other identities, so "the list is non-empty" proves nothing about
    // this add: remember what was there to tell new identities apart.
    const knownFingerprints = target
      ? new Set((await listAgentIdentities(socketPath)).map((i) => i.fingerprint))
      : undefined;

    const sshAddBin = process.platform === 'win32' ? 'ssh-add.exe' : 'ssh-add';
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SSH_AUTH_SOCK: socketPath,
      ...askpassServer.getEnv(),
    };
    // Microsoft's Win32-OpenSSH build has no default security-key provider, so a bare
    // `ssh-add -K` fails with "Cannot download keys without provider" — it must be told to use
    // the built-in one. (Verified: with this set, ssh-add proceeds to the PIN/touch step.)
    if (process.platform === 'win32' && addArgs[0] === '-K' && !env.SSH_SK_PROVIDER) {
      env.SSH_SK_PROVIDER = 'internal';
    }

    let lastErr: unknown;
    let attemptOutput = '';
    for (let attempt = 0; attempt <= retries + maxPinAttempts; attempt++) {
      agentLoaderLog.info(`${logPrefix}: attempt ${attempt + 1}`);
      try {
        // See Pkcs11Lock's doc comment: this is the one moment this process actually opens a
        // PKCS#11/FIDO2 session against the token, so it must never race a concurrent load for
        // a different session, or the global agent's cert read, against the same physical card.
        attemptOutput = '';
        await withPkcs11Lock(() =>
          execWithPresenceDetection(
            sshAddBin,
            addArgs,
            { env, timeoutMs: 60000, onOutput: (text) => (attemptOutput += text) },
            options?.onPresenceRequested
          )
        );
        lastErr = undefined;
      } catch (err) {
        agentLoaderLog.warn(`${logPrefix}: attempt ${attempt + 1} failed:`, err);
        lastErr = err;
      } finally {
        options?.onPresenceCleared?.();
      }

      // ssh-add's exit code isn't reliable when the card add is refused
      // (observed exiting 0 despite reporting "agent refused operation"), so
      // verify directly against the agent rather than trusting it.
      if (knownFingerprints) {
        const now = await listAgentIdentities(socketPath);
        const gotNewIdentity = now.some((i) => !knownFingerprints.has(i.fingerprint));
        // Re-adding a key the agent already holds adds nothing new; accept that only if ssh-add itself
        // reported no problem.
        const alreadyLoaded = !lastErr && !ADD_FAILURE_OUTPUT.test(attemptOutput) && now.length > 0;
        if (gotNewIdentity || alreadyLoaded) {
          lastErr = undefined;
          break;
        }
      }
      const listRes = knownFingerprints
        ? { stdout: '' }
        : await execFileAsync(sshAddBin, ['-l'], { env }).catch(() => ({ stdout: '' }));
      // On Windows the "private" agent is really the single shared ssh-agent service, which can
      // already hold unrelated identities (e.g. a PIV key loaded earlier) — so a non-empty `-l`
      // proves nothing about *this* `-K` call, and would hide a real failure (observed: "Provider
      // internal returned failure -1" reported as loaded OK while the agent held only the PIV key).
      const sharedAgentMaskingFailure =
        process.platform === 'win32' && addArgs[0] === '-K' && lastErr !== undefined && !isTextlessExitFailure(lastErr);
      if (!sharedAgentMaskingFailure && listRes.stdout && !listRes.stdout.toLowerCase().includes('no identities')) {
        lastErr = undefined;
        break;
      }

      if (options?.emptyFailureMeansNoIdentities && (!lastErr || isTextlessExitFailure(lastErr))) {
        agentLoaderLog.info(
          `${logPrefix}: treating success/textless failure with no identities as "no resident credentials on this device", not an error`
        );
        lastErr = undefined;
        break;
      }

      if (!lastErr) {
        lastErr = new Error(`ssh-add ${addArgs.join(' ')} reported success but no identity was loaded`);
      }

      if (cachedPin === '') {
        agentLoaderLog.info(`${logPrefix}: giving up (user cancelled)`);
        break;
      }

      const errMsg = lastErr instanceof Error ? lastErr.message.toLowerCase() : '';
      const isWrongPinError =
        errMsg.includes('incorrect passphrase') ||
        errMsg.includes('bad passphrase') ||
        errMsg.includes('pin incorrect') ||
        // ssh-agent's response to a failed `ssh-add -s` (PIV/PKCS#11) add is always this one
        // generic string, regardless of whether the underlying cause was a wrong PIN, a locked
        // card, or something else — verified with `ssh-add -v -s <lib>` against a real card: a
        // wrong PIN produces exactly "agent refused operation" and nothing more specific. There is
        // no way to distinguish "wrong PIN, retries remain" from "card locked" from this string
        // alone, so treat it as retryable (the common case by far) rather than failing after one
        // attempt; a genuinely locked card just exhausts the retry budget below with the same
        // message shown each time, which is no worse than before.
        errMsg.includes('agent refused operation');
      // "invalid format" turned out NOT to reliably mean a wrong PIN — it reproduced even with a
      // confirmed-correct PIN (6 chars entered, still failed), so treating it as retryable just
      // told the user "Incorrect PIN" when that wasn't actually established. Until the real cause
      // is root-caused, surface it as-is (fatal, no PIN re-prompt) rather than guessing.
      const isFatalNonRetryableError = errMsg.includes('pin blocked') || errMsg.includes('invalid format');

      if (isWrongPinError) {
        pinAttempts++;
        if (pinAttempts >= maxPinAttempts) {
          agentLoaderLog.warn(`${logPrefix}: giving up after ${pinAttempts} wrong PIN attempts`);
          break;
        }
        agentLoaderLog.warn(`${logPrefix}: wrong PIN (attempt ${pinAttempts}/${maxPinAttempts}), re-prompting`);
        cachedPin = undefined;
        pendingRetryContext = {
          error: 'Incorrect PIN. Please try again.',
          attempt: pinAttempts + 1,
          maxAttempts: maxPinAttempts,
        };
        continue;
      }

      if (isFatalNonRetryableError) {
        agentLoaderLog.warn(`${logPrefix}: non-retryable error encountered: ${errMsg}`);
        break;
      }

      if (attempt >= retries) {
        agentLoaderLog.info(`${logPrefix}: giving up (out of retries)`);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
    if (lastErr) throw lastErr;
  } catch (err) {
    if (!target) {
      if (pid) AgentLifecycleManager.killPrivateAgent(pid);
      if (keepAlive) await askpassServer.stop();
    }
    throw err;
  } finally {
    if (!keepAlive) {
      await askpassServer.stop();
    }
  }

  if (keepAlive) {
    // Keep using the PIN that was entered during the load step for subsequent signature
    // requests during this session, rather than forcing the user to re-type the exact same PIN
    // a split-second later when ssh initiates public-key authentication.
    askpassServer.setPromptHandler(replayingPromptHandler);
    if (options?.onPresenceRequested) {
      askpassServer.setOnPresence(() => options.onPresenceRequested?.());
    }
  }

  return { pid, socketPath, askpassServer: keepAlive ? askpassServer : undefined };
}

/**
 * Loads a PKCS#11 module's PIV key into a private, app-managed ssh-agent.
 * See `runAddIntoPrivateAgent` for the shared retry/PIN/presence machinery.
 */
export async function loadSmartcardIntoPrivateAgent(
  pkcs11LibPath: string,
  promptHandler: AskpassPromptHandler,
  options?: LoadIntoPrivateAgentOptions
): Promise<LoadedSmartcardAgent> {
  return runAddIntoPrivateAgent(['-s', pkcs11LibPath], promptHandler, options);
}

/**
 * Loads every FIDO2 discoverable ("resident") credential on a connected
 * security key into a private, app-managed ssh-agent (`ssh-add -K`). Unlike
 * `loadSmartcardIntoPrivateAgent`, this isn't scoped to one library path —
 * it's whatever resident credentials the currently plugged-in authenticator
 * holds — so there's no PKCS#11Lock-style keying by library needed beyond
 * the same single-transaction-at-a-time guard `runAddIntoPrivateAgent`
 * already applies.
 */
export async function loadFido2ResidentKeysIntoPrivateAgent(
  promptHandler: AskpassPromptHandler,
  options?: LoadIntoPrivateAgentOptions
): Promise<LoadedSmartcardAgent> {
  return runAddIntoPrivateAgent(['-K'], promptHandler, { emptyFailureMeansNoIdentities: true, ...options });
}

/**
 * Adds a PKCS#11 module's PIV key to an agent that is already running (see `AgentTarget`) instead of
 * spawning a private one. Same retry/PIN/presence behavior as `loadSmartcardIntoPrivateAgent`.
 */
export async function addSmartcardToAgent(
  target: AgentTarget,
  pkcs11LibPath: string,
  promptHandler: AskpassPromptHandler,
  options?: LoadIntoPrivateAgentOptions
): Promise<LoadedSmartcardAgent> {
  return runAddIntoPrivateAgent(['-s', pkcs11LibPath], promptHandler, options, target);
}

/** Adds every FIDO2 resident credential on the connected security key to an already-running agent. */
export async function addFido2ResidentKeysToAgent(
  target: AgentTarget,
  promptHandler: AskpassPromptHandler,
  options?: LoadIntoPrivateAgentOptions
): Promise<LoadedSmartcardAgent> {
  return runAddIntoPrivateAgent(['-K'], promptHandler, { emptyFailureMeansNoIdentities: true, ...options }, target);
}
