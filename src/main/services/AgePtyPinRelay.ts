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
 * "Hårdvaruverifiering" (hardware verification) section. We never drive that wizard programmatically. */
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

/**
 * Opens a FIFO as the channel `age` writes its output through, with both ends held by this process
 * from the moment this returns.
 *
 * `age` opens its `-o` target read-write (Go's `os.Create`), and a FIFO opened read-write never waits
 * for a reader: `age` opens it, writes, closes and exits, whoever is or is not listening. A FIFO that
 * nobody has open keeps nothing. So if the reader's open() has not reached the kernel by the time
 * `age` closes, what `age` wrote is gone, `age` has exited with 0, and the reader then waits for a
 * writer that never comes. That is what happened here once in a while: the reader used to be opened
 * through Node's file streams, whose open() waits its turn in libuv's four-thread pool, and on a busy
 * machine `age` could finish first.
 *
 * So the read end is opened here, on the calling thread, before `age` exists (non-blocking: such an
 * open does not wait for a writer). The pipe then holds what `age` writes until it is read. It is read
 * as a socket, by the event loop, not through the thread pool: nothing can be queued behind other
 * work, a payload larger than the pipe's buffer is drained while `age` writes it, and no pool thread is
 * left blocked when a run fails before `age` writes anything.
 *
 * A write end is held too, until the output is asked for. With no writer at all a reader is at
 * end-of-file, on some systems before a first writer ever came and on all of them between two writers,
 * and `age` may open the target more than once. Holding a writer keeps the reader waiting until this
 * process says that `age` is done.
 */
function openFifoChannel(fifoPath: string): SecretOutputChannel {
  const readFd = fs.openSync(fifoPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  let heldWriteFd: number | undefined;
  try {
    heldWriteFd = fs.openSync(fifoPath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
  } catch (err) {
    fs.closeSync(readFd);
    throw err;
  }
  const releaseWriter = (): void => {
    if (heldWriteFd === undefined) return;
    fs.closeSync(heldWriteFd);
    heldWriteFd = undefined;
  };

  const reader = new net.Socket({ fd: readFd, readable: true, writable: false });
  const chunks: Buffer[] = [];
  let total = 0;
  const output = new Promise<Buffer>((resolve, reject) => {
    reader.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_OUTPUT_BYTES) {
        reader.destroy(new Error(`"age" produced too much output (over ${MAX_OUTPUT_BYTES} bytes), aborting`));
        return;
      }
      chunks.push(chunk);
    });
    reader.on('end', () => resolve(Buffer.concat(chunks)));
    reader.on('error', reject);
    // Closed without an end: the channel was torn down while it still waited.
    reader.on('close', () => reject(new Error('Secret output channel was closed before any data arrived')));
  });
  // A failed run never calls read(), so don't let this surface as an unhandled rejection.
  output.catch(() => {});

  return {
    path: fifoPath,
    read: () => {
      // `age` has finished: with our writer gone too, the reader gets what is in the pipe and then its end.
      releaseWriter();
      return output;
    },
    dispose: async () => {
      releaseWriter();
      reader.destroy();
      await removeFifo(fifoPath);
    },
  };
}

// After `age` has exited successfully, its output is already in the channel, and reading it takes no time worth
// naming. This is how long a read may still take before it is given up: waiting longer only freezes the unlock.
export const CHANNEL_GRACE_MS = 5000;

/**
 * `channel.read()`, but bounded, and never empty: rejects with a clear error instead of waiting forever, or handing
 * back nothing, when `age` finished without delivering its output.
 */
export async function readChannelAfterExit(channel: SecretOutputChannel, graceMs: number = CHANNEL_GRACE_MS): Promise<Buffer> {
  let timer: NodeJS.Timeout | undefined;
  const giveUp = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('"age" finished but wrote no output')), graceMs);
  });
  try {
    const output = await Promise.race([channel.read(), giveUp]);
    if (output.length === 0) throw new Error('"age" finished but wrote no output');
    return output;
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
 * Linux/macOS, a named pipe on Windows, where `mkfifo` doesn't exist. The channel listens from the
 * moment it is made. `age` does not wait for a listener (see `openFifoChannel`), so create the
 * channel BEFORE spawning `age`, then call `read()` once it has exited.
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
    try {
      return openFifoChannel(fifoPath);
    } catch (err) {
      await removeFifo(fifoPath).catch(() => {});
      throw err;
    }
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
