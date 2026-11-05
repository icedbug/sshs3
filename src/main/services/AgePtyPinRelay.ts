import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { IPty } from 'node-pty';
import * as nodePty from 'node-pty';

const DEFAULT_TIMEOUT_MS = 30000;
// Mirrors the 4MB `maxBuffer` TeamVaultCryptoService's own non-interactive `execFile` calls
// already enforce — a misbehaving or tampered age/age-plugin-yubikey binary that floods stdout
// would otherwise accumulate in `fullText` unbounded for the whole DEFAULT_TIMEOUT_MS instead of
// being stopped as soon as it's clearly not a normal prompt/output exchange.
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
// A single prompt line/phrase never approaches this size — bounds the re-scan window used to
// detect a prompt that might be split across two pty writes, without letting that window grow
// unbounded if no recognizable prompt ever shows up (e.g. a hung or chatty process).
const MAX_PENDING_CHUNK = 8192;

export class TeamVaultWrongPinError extends Error {
  constructor(message = 'Wrong PIV PIN') {
    super(message);
    this.name = 'TeamVaultWrongPinError';
  }
}

/** The card still has its factory-default PIN/PUK/management-key, which forces
 * `age-plugin-yubikey` into a mandatory interactive migration wizard that changes
 * card-wide credentials (not just this one slot) — see docs/team-vault-plan.md's
 * "Hårdvaruverifiering" section. We never drive that wizard programmatically. */
export class TeamVaultDefaultCredentialsError extends Error {
  constructor(
    message = 'This YubiKey still has its factory-default PIN/PUK. Change them yourself first ' +
      '(e.g. "ykman piv access change-pin" / "change-puk"), then retry.'
  ) {
    super(message);
    this.name = 'TeamVaultDefaultCredentialsError';
  }
}

export interface AgePtyPromptRetryContext {
  error: string;
  attempt: number;
  maxAttempts: number;
}

export interface AgePtyPromptCallbacks {
  requestPin(promptText: string, retry?: AgePtyPromptRetryContext): Promise<string>;
  onTouchRequested(): void;
  onTouchCleared(): void;
}

/** node-pty's ESM/CJS interop is inconsistent across bundling setups — same defensive guard
 * already used by `SSHPtyManager.getSpawn()`, duplicated here rather than shared since it's a
 * handful of lines and this module has no other dependency on SSHPtyManager. */
function getSpawn(): typeof nodePty.spawn {
  if (typeof (nodePty as any).spawn === 'function') return (nodePty as any).spawn;
  if ((nodePty as any).default && typeof (nodePty as any).default.spawn === 'function') {
    return (nodePty as any).default.spawn;
  }
  throw new Error('node-pty spawn function not found');
}

const PIN_PROMPT_RE = /enter pin for yubikey/i;
const WRONG_PIN_RE = /invalid pin \((\d+) tries? remaining/i;
// Matches the INTERACTIVE default-PIN/PUK-change wizard (a multi-step guide: current PUK, new
// PIN, new PUK — see docs/team-vault-plan.md's hardware verification notes) and a hypothetical
// interactive management-key entry prompt, which this code must never drive programmatically
// (changing card-wide credentials without the user's explicit input). Deliberately does NOT
// match a bare mention of "management key": `age-plugin-yubikey --generate` also prints a purely
// informational, non-interactive line on a card whose management key isn't yet PIN-protected —
// "Your YubiKey is using the default management key. We'll migrate it to a PIN-protected
// management key." — and then completes that migration itself using the PIN already entered, no
// further input needed. An earlier version of this pattern (`|management key` as a bare
// alternative) matched that informational line too and aborted a perfectly normal enrollment on
// first-generation/older YubiKeys (e.g. YubiKey 4) where that auto-migration hadn't already
// happened — found via real-world use against one. Failing closed (aborting) on a genuine false
// positive is still safe here, just misleading; the real risk this pattern guards against is the
// opposite — failing to recognize an actual interactive prompt and writing into it blind.
const DEFAULT_CREDENTIALS_WIZARD_RE = /choose a new (pin|puk)|enter.*new (piv )?(pin|puk)|enter.*management key/i;

/** `age-plugin-yubikey`'s prompt always includes "(default is 123456)" verbatim — fixed CLI
 * wording, not a real signal that this card is actually on its default PIN. Showing it in the
 * app's PIN modal is just confusing noise (and could misleadingly suggest the card is
 * unconfigured), so it's stripped before the text ever reaches `callbacks.requestPin`. */
function cleanPinPrompt(text: string): string {
  return text.replace(/\s*\(default is \d+\)/i, '').trim();
}

// Windows' ConPTY wraps everything in terminal control sequences (screen clears, cursor moves,
// window-title OSC) that a Linux pty doesn't emit; they can land in the middle of a phrase and
// would otherwise leak into the PIN modal's prompt text.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/**
 * Runs an `age`/`age-plugin-yubikey` invocation inside a real pty (required — see
 * docs/team-vault-plan.md's hardware verification notes: plain `execFile` fails with
 * "not a terminal" because the plugin needs a controlling terminal to prompt for PIN/touch).
 * Returns the full captured text output on success — safe for callers whose actual payload is
 * text (e.g. `enrollOwnPivRecipient`'s identity stanza). Callers whose payload is binary (e.g.
 * `unwrapVaultKey`'s decrypted Vault Key) must not rely on this text channel for that payload —
 * route it through a FIFO via `-o <fifo>` instead (see `TeamVaultCryptoService`), since this
 * pty's text channel both UTF-8-decodes and CRLF-normalizes everything that flows through it.
 */
export function runAgeCommandViaPty(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  callbacks: AgePtyPromptCallbacks,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  stdin?: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const spawn = getSpawn();
    const term: IPty = spawn(binary, args, { name: 'xterm-color', cols: 120, rows: 30, env });

    if (stdin !== undefined) {
      // `stdin` is always ASCII-armored age ciphertext (see `unwrapVaultKey`), never raw binary,
      // so it can't contain control bytes the pty's line discipline would misinterpret. A pty
      // has no real "close stdin" like a pipe does, so EOF is signalled explicitly with Ctrl-D.
      term.write(stdin);
      term.write('\x04');
    }

    let fullText = '';
    // Separate from `fullText` (the complete transcript returned on success/failure): this is
    // the re-scan window the prompt regexes are tested against, so a prompt split across two pty
    // writes (e.g. "Enter PIN for Yu" + "biKey...") is still recognized — testing only the latest
    // `data` chunk, as a prior version of this code did, would silently miss that split and never
    // detect the prompt at all. Cleared after a successful match (that prompt is now handled;
    // nothing left worth re-scanning) and capped at MAX_PENDING_CHUNK otherwise.
    let pendingChunk = '';
    let settled = false;
    let pinAttempt = 0;
    let awaitingPinResponse = false;

    const timeoutHandle = setTimeout(() => {
      finish(() => reject(new Error(`Timed out waiting for "${binary}" to finish`)));
      term.kill();
    }, timeoutMs);

    function finish(action: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      clearInterval(touchRefreshHandle);
      callbacks.onTouchCleared();
      action();
    }

    // A touch may be required at any point between now and the operation concluding — and for
    // `age -d` (unlock), there's no reliable textual signal for exactly when (its plugin-protocol
    // mode prints no touch prompt at all, unlike `--generate`'s own CLI mode; and when the card's
    // PIN is already cached from a recent prior operation, there's no PIN prompt either to key a
    // hint off of — found via real-world use, see docs/team-vault-plan.md). So the hint is shown
    // for the whole operation unconditionally, not keyed off any particular prompt: a touch-policy
    // of "never" just means it flashes briefly instead of never appearing when actually needed.
    //
    // Re-fired periodically (well under the renderer's own 4s fallback auto-hide,
    // TouchPresenceBanner.tsx) because PIN entry (the modal round-trip to the user) routinely
    // takes longer than that — without a refresh, the banner vanished long before the real touch
    // moment, also found via real-world use.
    callbacks.onTouchRequested();
    const touchRefreshHandle = setInterval(() => callbacks.onTouchRequested(), 2000);

    function requestAndWritePin(promptText: string, retry?: AgePtyPromptRetryContext): void {
      awaitingPinResponse = true;
      callbacks
        .requestPin(promptText, retry)
        .then((pin) => {
          awaitingPinResponse = false;
          if (settled) return;
          term.write(`${pin}\r`);
        })
        .catch((err) => {
          finish(() => reject(err));
          term.kill();
        });
    }

    term.onData((data: string) => {
      if (settled) return;
      fullText += data;
      if (fullText.length > MAX_OUTPUT_BYTES) {
        finish(() => reject(new Error(`"${binary}" produced too much output (over ${MAX_OUTPUT_BYTES} bytes) — aborting`)));
        term.kill();
        return;
      }

      pendingChunk += data;
      if (pendingChunk.length > MAX_PENDING_CHUNK) {
        pendingChunk = pendingChunk.slice(-MAX_PENDING_CHUNK);
      }

      const view = stripAnsi(pendingChunk);

      if (DEFAULT_CREDENTIALS_WIZARD_RE.test(view)) {
        finish(() => reject(new TeamVaultDefaultCredentialsError()));
        term.kill();
        return;
      }

      // The card's own message is authoritative on how many tries are left — once it says 0,
      // the PIN is about to be (or already is) blocked, so this gives up rather than retrying.
      const wrongPinMatch = view.match(WRONG_PIN_RE);
      if (wrongPinMatch) {
        pendingChunk = '';
        const triesRemaining = Number(wrongPinMatch[1]);
        if (triesRemaining <= 0) {
          finish(() => reject(new TeamVaultWrongPinError(`Invalid PIN (${triesRemaining} tries remaining before it is blocked)`)));
          term.kill();
          return;
        }
        pinAttempt += 1;
        // Total attempts = tries already spent (pinAttempt - 1) + tries still remaining, per
        // the card's own count — not an arbitrary constant on our side.
        requestAndWritePin('Enter PIN for YubiKey', {
          error: `Invalid PIN (${triesRemaining} tries remaining before it is blocked)`,
          attempt: pinAttempt,
          maxAttempts: triesRemaining + pinAttempt - 1,
        });
        return;
      }

      if (PIN_PROMPT_RE.test(view) && pinAttempt === 0 && !awaitingPinResponse) {
        pinAttempt = 1;
        // Start at the prompt itself: on Windows the chunk also carries the plugin's preceding
        // status line ("Generating key...") with only cursor moves between it and the prompt.
        const promptText = cleanPinPrompt(view.slice(view.search(PIN_PROMPT_RE)));
        pendingChunk = '';
        requestAndWritePin(promptText);
        return;
      }
    });

    term.onExit(({ exitCode }: { exitCode: number }) => {
      finish(() => {
        if (exitCode === 0) {
          resolve(fullText);
        } else {
          reject(new Error(fullText.trim() || `"${binary}" exited with code ${exitCode}`));
        }
      });
    });
  });
}

/**
 * Creates a fresh FIFO (named pipe) in `dir` and returns its path. A FIFO is a kernel pipe
 * buffer that happens to have a filesystem name — nothing written through it is ever persisted
 * to disk, so routing the decrypted Vault Key through one (see `unwrapVaultKey`) doesn't violate
 * CLAUDE.md's "never write secrets to disk" rule. Linux/macOS only (no `mkfifo` on Windows) —
 * Windows support for this flow is a known, documented gap (docs/team-vault-plan.md).
 */
export function createFifo(dir: string): Promise<string> {
  const fifoPath = path.join(dir, `${crypto.randomUUID()}.fifo`);
  return new Promise((resolve, reject) => {
    execFile('mkfifo', ['-m', '600', fifoPath], (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(fifoPath);
    });
  });
}

/** Reads everything written to `fifoPath` by its one expected writer, resolving once that
 * writer closes its end (EOF). */
export function readFifoOnce(fifoPath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = fs.createReadStream(fifoPath);
    stream.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/**
 * Lets a reader that is still waiting for a writer give up. `readFifoOnce` opens the FIFO for reading, and that open()
 * blocks one of libuv's four threadpool threads until some writer opens the other end. If `age` fails before it opens
 * `-o <fifo>` (wrong PIN, bad identity, cancelled), no writer ever comes: removing the FIFO does not wake the reader, the
 * thread stays blocked for the life of the process, and after four such failures every async fs call in the app hangs.
 * Opening the write end without writing a byte releases the reader, which then sees end-of-file. It does nothing when no
 * reader is waiting (ENXIO) or the FIFO is already gone, and it runs on the calling thread (O_NONBLOCK) so it cannot
 * itself get stuck behind a starved threadpool.
 */
export function releaseFifoReader(fifoPath: string): void {
  try {
    const fd = fs.openSync(fifoPath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    fs.closeSync(fd);
  } catch {
    // ENXIO: nobody is waiting (the reader already finished). ENOENT: already removed.
  }
}

// After `age` has exited successfully, its output is already in the FIFO. If the reader still has nothing after this
// long, `age` did not deliver it (seen once in a while on a heavily loaded machine: `age` exits 0 but the reader's open()
// never completes) and waiting longer only freezes the unlock.
export const CHANNEL_GRACE_MS = 5000;

/**
 * `channel.read()`, but bounded: rejects with a clear error instead of waiting forever when `age` finished without
 * delivering its output. The caller's `dispose()` then releases the blocked reader.
 */
export async function readChannelAfterExit(channel: SecretOutputChannel, graceMs: number = CHANNEL_GRACE_MS): Promise<Buffer> {
  let timer: NodeJS.Timeout | undefined;
  const giveUp = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('"age" finished but wrote no output')), graceMs);
  });
  try {
    return await Promise.race([channel.read(), giveUp]);
  } finally {
    clearTimeout(timer);
  }
}

/** Removes a FIFO created by `createFifo`. A no-op if it's already gone. */
export async function removeFifo(fifoPath: string): Promise<void> {
  try {
    await fs.promises.unlink(fifoPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * A one-shot, never-on-disk channel for a secret that `age` writes with `-o <path>`: a FIFO on
 * Linux/macOS, a named pipe on Windows, where `mkfifo` doesn't exist. Listening/reading starts
 * immediately — `age` blocks opening a FIFO until a reader is there — so create the channel
 * BEFORE spawning `age`, then call `read()` once it has exited.
 */
export interface SecretOutputChannel {
  /** The path to hand `age` as `-o`. */
  path: string;
  /** The bytes `age` wrote. Call after the `age` process finished. */
  read(): Promise<Buffer>;
  /** Tears the channel down; safe to call more than once. */
  dispose(): Promise<void>;
}

// After `age` has exited, how long a Windows pipe waits for a connection that carries data
// before concluding `age` produced no output. Only reached on a broken run; a normal one has
// already delivered the bytes by then.
const PIPE_GRACE_MS = 3000;

const BACKSLASH = String.fromCharCode(92);

/** `\\.\pipe\<name>` — the Windows named-pipe namespace. */
function windowsPipePath(name: string): string {
  return [BACKSLASH, BACKSLASH, '.', BACKSLASH, 'pipe', BACKSLASH, name].join('');
}

export async function createSecretOutputChannel(dir: string): Promise<SecretOutputChannel> {
  if (process.platform !== 'win32') {
    const fifoPath = await createFifo(dir);
    const readPromise = readFifoOnce(fifoPath);
    // A failed run never calls read(), so don't let this surface as an unhandled rejection.
    readPromise.catch(() => {});
    return {
      path: fifoPath,
      read: () => readPromise,
      dispose: async () => {
        releaseFifoReader(fifoPath);
        await removeFifo(fifoPath);
      },
    };
  }

  const pipePath = windowsPipePath(`sshs3-${crypto.randomUUID()}`);
  // `age` opens its `-o` target several times (verified against age v1.3.2: two empty probe
  // connections, then the one that carries the data), so the first connection to close can't be
  // taken as the answer — the first non-empty one is.
  let data: Buffer | undefined;
  let waiter: { resolve: (b: Buffer) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | undefined;
  let disposed = false;
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    const chunks: Buffer[] = [];
    let total = 0;
    socket.on('data', (c: Buffer) => {
      total += c.length;
      if (total > MAX_OUTPUT_BYTES) {
        socket.destroy();
        return;
      }
      chunks.push(c);
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      sockets.delete(socket);
      const buf = Buffer.concat(chunks);
      if (buf.length === 0 || data) return;
      data = buf;
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(buf);
        waiter = undefined;
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipePath, () => {
      server.off('error', reject);
      server.on('error', () => {});
      resolve();
    });
  });

  return {
    path: pipePath,
    read: () => {
      if (data) return Promise.resolve(data);
      if (disposed) return Promise.reject(new Error('Secret output channel was closed before any data arrived'));
      return new Promise<Buffer>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiter = undefined;
          reject(new Error('"age" finished but wrote no output'));
        }, PIPE_GRACE_MS);
        waiter = { resolve, reject, timer };
      });
    },
    dispose: async () => {
      disposed = true;
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('Secret output channel was closed before any data arrived'));
        waiter = undefined;
      }
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
