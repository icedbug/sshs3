import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IPty, IDisposable } from 'node-pty';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Mirrors the mock-node-pty pattern already used in SSHPtyManager.test.ts: a minimal fake
// IPty that lets tests drive onData/onExit manually and assert on write()/kill() calls.
const mockPtyInstances: MockPty[] = [];

class MockPty implements Partial<IPty> {
  pid = 999;
  cols = 120;
  rows = 30;

  write = vi.fn();
  kill = vi.fn();

  private dataListeners: ((data: string) => void)[] = [];
  private exitListeners: ((event: { exitCode: number; signal?: number }) => void)[] = [];

  onData = vi.fn((listener: (data: string) => void): IDisposable => {
    this.dataListeners.push(listener);
    return { dispose: () => {} };
  });

  onExit = vi.fn((listener: (event: { exitCode: number; signal?: number }) => void): IDisposable => {
    this.exitListeners.push(listener);
    return { dispose: () => {} };
  });

  emitData(data: string) {
    for (const l of [...this.dataListeners]) l(data);
  }

  emitExit(exitCode: number) {
    for (const l of [...this.exitListeners]) l({ exitCode });
  }
}

vi.mock('node-pty', () => {
  const spawn = vi.fn(() => {
    const mock = new MockPty();
    mockPtyInstances.push(mock);
    return mock as unknown as IPty;
  });
  return { default: { spawn }, spawn };
});

import {
  runAgeCommandViaPty,
  createFifo,
  removeFifo,
  createSecretOutputChannel,
  readChannelAfterExit,
  stripAnsi,
  TeamVaultWrongPinError,
  TeamVaultDefaultCredentialsError,
  type AgePtyPromptCallbacks,
} from '../../src/main/services/AgePtyPinRelay';

function makeCallbacks(pins: string[]): AgePtyPromptCallbacks & { calls: unknown[] } {
  const calls: unknown[] = [];
  let i = 0;
  return {
    calls,
    requestPin: vi.fn(async (prompt: string, retry?: unknown) => {
      calls.push({ prompt, retry });
      const pin = pins[i] ?? pins[pins.length - 1];
      i += 1;
      return pin;
    }),
    onTouchRequested: vi.fn(),
    onTouchCleared: vi.fn(),
  };
}

describe('stripAnsi', () => {
  it('removes CSI and OSC sequences but keeps the text', () => {
    expect(stripAnsi('[2J[H🎲 Generating key...]0;C:\\x.exe[?25hok')).toBe('🎲 Generating key...ok');
  });
});

describe('runAgeCommandViaPty', () => {
  beforeEach(() => {
    mockPtyInstances.length = 0;
  });

  it('recognizes the PIN prompt through ConPTY control sequences and shows only the prompt text', async () => {
    const callbacks = makeCallbacks(['123456']);
    const promise = runAgeCommandViaPty('age', ['-d'], process.env, callbacks);
    const term = mockPtyInstances[0];

    // Captured from age-plugin-yubikey 0.5.0 under ConPTY on Windows.
    term.emitData('[?9001h[?1004h[?25l[2J[m[H🎲 Generating key...]0;C:\\p\\age-plugin-yubikey.exe');
    term.emitData('[?25h[?25l[3;1HEnter PIN for YubiKey with serial 7015986 (default is 123456): [?25h');
    await Promise.resolve();
    await Promise.resolve();
    expect(callbacks.requestPin).toHaveBeenCalledWith('Enter PIN for YubiKey with serial 7015986:', undefined);

    term.emitExit(0);
    await promise;
  });

  it('shows the touch hint immediately on spawn (before any PIN prompt), and relays the PIN prompt without the "(default is ...)" hint', async () => {
    const callbacks = makeCallbacks(['123456']);
    const promise = runAgeCommandViaPty('age', ['-d', '-i', '/tmp/identity.txt'], process.env, callbacks);
    const term = mockPtyInstances[0];

    // Shown unconditionally from the start — there's no reliable textual signal for exactly when
    // a touch will be needed: `age -d`'s plugin-protocol mode prints no touch prompt at all
    // (unlike `--generate`'s own CLI mode), and a cached PIN means there may be no PIN prompt
    // either to key a hint off of (found via real-world use — see docs/team-vault-plan.md).
    expect(callbacks.onTouchRequested).toHaveBeenCalledTimes(1);
    expect(callbacks.onTouchCleared).not.toHaveBeenCalled();

    term.emitData('Enter PIN for YubiKey with serial 20185052 (default is 123456): ');
    await Promise.resolve();
    await Promise.resolve();
    expect(callbacks.requestPin).toHaveBeenCalledTimes(1);
    // "(default is 123456)" is just fixed CLI wording, not a real signal the card is on a
    // default PIN — confusing to show in the UI, so it's stripped before reaching the modal.
    expect(callbacks.requestPin).toHaveBeenCalledWith('Enter PIN for YubiKey with serial 20185052:', undefined);
    expect(term.write).toHaveBeenCalledWith('123456\r');
    expect(callbacks.onTouchRequested).toHaveBeenCalledTimes(1); // still just once

    term.emitData('# Recipient: age1yubikey1test\r\nAGE-PLUGIN-YUBIKEY-1TEST\r\n');
    expect(callbacks.onTouchCleared).not.toHaveBeenCalled(); // only clears once the op concludes

    term.emitExit(0);
    const result = await promise;
    expect(result).toContain('AGE-PLUGIN-YUBIKEY-1TEST');
    expect(callbacks.onTouchCleared).toHaveBeenCalledTimes(1);
  });

  it('shows and clears the touch hint even when no PIN prompt occurs at all (PIN cached on the card)', async () => {
    const callbacks = makeCallbacks([]);
    const promise = runAgeCommandViaPty('age', ['-d', '-i', '/tmp/identity.txt'], process.env, callbacks);
    const term = mockPtyInstances[0];

    expect(callbacks.onTouchRequested).toHaveBeenCalledTimes(1);
    expect(callbacks.requestPin).not.toHaveBeenCalled();

    term.emitExit(0);
    await promise;
    expect(callbacks.onTouchCleared).toHaveBeenCalledTimes(1);
  });

  it('re-fires the touch hint periodically while the operation is still running, so a long PIN-entry pause does not let the UI banner expire early', async () => {
    // Found via real-world use: the renderer's touch banner has its own 4s fallback auto-hide
    // (TouchPresenceBanner.tsx). Typing a PIN into the modal routinely takes longer than that,
    // so without a periodic re-fire the banner vanished long before the real touch moment.
    vi.useFakeTimers();
    try {
      const callbacks = makeCallbacks(['123456']);
      const promise = runAgeCommandViaPty('age', ['-d', '-i', '/tmp/identity.txt'], process.env, callbacks);
      const term = mockPtyInstances[0];

      expect(callbacks.onTouchRequested).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10000);
      expect(vi.mocked(callbacks.onTouchRequested).mock.calls.length).toBeGreaterThan(1);

      term.emitData('Enter PIN for YubiKey with serial 20185052: ');
      await Promise.resolve();
      await Promise.resolve();
      term.emitExit(0);
      await promise;
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries after a wrong PIN, forwarding the remaining-tries count, then succeeds', async () => {
    const callbacks = makeCallbacks(['000000', '123456']);
    const promise = runAgeCommandViaPty('age', ['-d', '-i', '/tmp/identity.txt'], process.env, callbacks);
    const term = mockPtyInstances[0];

    term.emitData('Enter PIN for YubiKey with serial 20185052: ');
    await Promise.resolve();
    await Promise.resolve();
    expect(term.write).toHaveBeenNthCalledWith(1, '000000\r');

    term.emitData('Error: Invalid PIN (2 tries remaining before it is blocked)\r\n');
    await Promise.resolve();
    await Promise.resolve();

    expect(callbacks.requestPin).toHaveBeenCalledTimes(2);
    expect(callbacks.calls[1]).toMatchObject({ retry: { attempt: 2, maxAttempts: 3 } });
    expect(term.write).toHaveBeenNthCalledWith(2, '123456\r');

    term.emitData('# Recipient: age1yubikey1test\r\n');
    term.emitExit(0);
    await promise;
  });

  it('rejects with TeamVaultWrongPinError once PIV tries are exhausted, never retrying further', async () => {
    const callbacks = makeCallbacks(['1', '2', '3']);
    const promise = runAgeCommandViaPty('age', ['-d', '-i', '/tmp/identity.txt'], process.env, callbacks);
    const term = mockPtyInstances[0];

    term.emitData('Enter PIN for YubiKey with serial 20185052: ');
    await Promise.resolve();
    await Promise.resolve();
    term.emitData('Error: Invalid PIN (0 tries remaining before it is blocked)\r\n');
    term.emitExit(1);

    await expect(promise).rejects.toBeInstanceOf(TeamVaultWrongPinError);
    expect(callbacks.requestPin).toHaveBeenCalledTimes(1);
  });

  it('aborts immediately on a default-PIN/PUK migration wizard prompt, never writing anything to the pty', async () => {
    const callbacks = makeCallbacks(['123456']);
    const promise = runAgeCommandViaPty('age-plugin-yubikey', ['--generate'], process.env, callbacks);
    const term = mockPtyInstances[0];

    term.emitData('Enter PIN for YubiKey with serial 20185052 (default is 123456): ');
    await Promise.resolve();
    await Promise.resolve();
    term.write.mockClear();

    term.emitData('Please choose a new PIN: ');

    await expect(promise).rejects.toBeInstanceOf(TeamVaultDefaultCredentialsError);
    expect(term.kill).toHaveBeenCalled();
    expect(term.write).not.toHaveBeenCalled();
  });

  it('does NOT abort on the benign, non-interactive default-management-key auto-migration message', async () => {
    // Regression guard for a real-world bug found against a YubiKey 4: `age-plugin-yubikey
    // --generate` prints this purely informational line (no input needed, it migrates the
    // management key itself using the already-entered PIN) on any card whose management key
    // isn't yet PIN-protected — common on older/first-generation YubiKeys, less so on 5-series
    // ones often provisioned with --protect already. An earlier, overly broad pattern treated
    // any mention of "management key" as the interactive wizard and killed the process mid-way.
    const callbacks = makeCallbacks(['123456']);
    const promise = runAgeCommandViaPty('age-plugin-yubikey', ['--generate'], process.env, callbacks);
    const term = mockPtyInstances[0];

    term.emitData('Enter PIN for YubiKey with serial 20185052 (default is 123456): ');
    await Promise.resolve();
    await Promise.resolve();

    term.emitData(
      "Your YubiKey is using the default management key.\r\nWe'll migrate it to a PIN-protected management key.\r\n"
    );
    term.emitData('# Recipient: age1yubikey1test\r\nAGE-PLUGIN-YUBIKEY-1TEST\r\n');
    term.emitExit(0);

    const result = await promise;
    expect(result).toContain('AGE-PLUGIN-YUBIKEY-1TEST');
  });

  it('still aborts on an actual interactive management-key entry prompt', async () => {
    const callbacks = makeCallbacks(['123456']);
    const promise = runAgeCommandViaPty('age-plugin-yubikey', ['--generate'], process.env, callbacks);
    const term = mockPtyInstances[0];

    term.emitData('Enter PIN for YubiKey with serial 20185052: ');
    await Promise.resolve();
    await Promise.resolve();
    term.write.mockClear();

    term.emitData('Enter new management key [hex]: ');

    await expect(promise).rejects.toBeInstanceOf(TeamVaultDefaultCredentialsError);
    expect(term.kill).toHaveBeenCalled();
    expect(term.write).not.toHaveBeenCalled();
  });

  it('recognizes the default-credentials wizard prompt even when it is split across two pty writes', async () => {
    // Regression guard: an earlier version of this code tested each incoming chunk in isolation,
    // so a detection phrase split across two onData callbacks (as node-pty may deliver it) would
    // never match either chunk alone — a fail-closed violation for a flow this codebase treats as
    // security-critical (must never drive the migration wizard programmatically).
    const callbacks = makeCallbacks(['123456']);
    const promise = runAgeCommandViaPty('age-plugin-yubikey', ['--generate'], process.env, callbacks);
    const term = mockPtyInstances[0];

    term.emitData('Please choose a new P');
    term.emitData('IN: ');

    await expect(promise).rejects.toBeInstanceOf(TeamVaultDefaultCredentialsError);
    expect(term.kill).toHaveBeenCalled();
    expect(term.write).not.toHaveBeenCalled();
  });

  it('recognizes a wrong-PIN message even when it is split across two pty writes', async () => {
    const callbacks = makeCallbacks(['000000', '123456']);
    const promise = runAgeCommandViaPty('age', ['-d', '-i', '/tmp/identity.txt'], process.env, callbacks);
    const term = mockPtyInstances[0];

    term.emitData('Enter PIN for YubiKey with serial 20185052: ');
    await Promise.resolve();
    await Promise.resolve();

    term.emitData('Error: Invalid PIN (2 tries rema');
    term.emitData('ining before it is blocked)\r\n');
    await Promise.resolve();
    await Promise.resolve();

    expect(callbacks.requestPin).toHaveBeenCalledTimes(2);
    expect(callbacks.calls[1]).toMatchObject({ retry: { attempt: 2, maxAttempts: 3 } });

    term.emitExit(0);
    await promise;
  });

  it('aborts with an error rather than accumulating output forever once the output cap is exceeded', async () => {
    const callbacks = makeCallbacks([]);
    const promise = runAgeCommandViaPty('age', ['-d', '-i', '/tmp/identity.txt'], process.env, callbacks);
    const term = mockPtyInstances[0];

    // A misbehaving/tampered binary flooding stdout with otherwise-unrecognizable output (no
    // prompt phrase ever matches) must still be stopped well before the full DEFAULT_TIMEOUT_MS.
    const chunk = 'x'.repeat(1024 * 1024);
    for (let i = 0; i < 5; i++) {
      term.emitData(chunk);
    }

    await expect(promise).rejects.toThrow(/too much output/);
    expect(term.kill).toHaveBeenCalled();
  });

  it('kills the pty and rejects on timeout', async () => {
    const callbacks = makeCallbacks(['123456']);
    const promise = runAgeCommandViaPty('age', ['-d', '-i', '/tmp/identity.txt'], process.env, callbacks, 20);
    const term = mockPtyInstances[0];

    await expect(promise).rejects.toThrow();
    expect(term.kill).toHaveBeenCalled();
  });

  it('writes a provided stdin payload followed by EOF (Ctrl-D) right after spawning', async () => {
    const callbacks = makeCallbacks([]);
    const promise = runAgeCommandViaPty(
      'age',
      ['-d', '-i', '/tmp/identity.txt', '-o', '/tmp/out.fifo'],
      process.env,
      callbacks,
      undefined,
      '-----BEGIN AGE ENCRYPTED FILE-----\nfake\n-----END AGE ENCRYPTED FILE-----\n'
    );
    const term = mockPtyInstances[0];
    term.emitExit(0);
    await promise;

    expect(term.write.mock.calls[0][0]).toContain('BEGIN AGE ENCRYPTED FILE');
    expect(term.write.mock.calls[1][0]).toBe('\x04');
  });
});

// `unwrapVaultKey`'s actual Vault Key bytes must never flow through the pty's text channel (see
// docs/team-vault-plan.md: it's both UTF-8-decoded and CRLF-normalized, and `age` itself refuses
// to write binary to a terminal) — instead `age -d ... -o <fifo>` writes them to a FIFO, a kernel
// pipe that never touches disk. Verified byte-exact against real hardware; these tests cover the
// FIFO plumbing itself with a real (but disposable, non-sensitive) temp FIFO.
// POSIX only: Windows has no mkfifo — see the secret output channel tests below.
describe.skipIf(process.platform === 'win32')('FIFO helpers (binary-safe path for unwrapVaultKey)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'age-pty-fifo-test-'));
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('creates a real FIFO (not a regular file) that only its owner may use, and removes it', async () => {
    const fifoPath = await createFifo(tempDir);
    const stat = fs.statSync(fifoPath);
    expect(stat.isFIFO()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o600);

    await removeFifo(fifoPath);
    expect(fs.existsSync(fifoPath)).toBe(false);
  });

  it('removeFifo is a no-op if the path is already gone', async () => {
    const fifoPath = path.join(tempDir, 'already-gone.fifo');
    await expect(removeFifo(fifoPath)).resolves.toBeUndefined();
  });
});

describe('readChannelAfterExit', () => {
  const channelOf = (read: () => Promise<Buffer>) => ({ path: '/x', read, dispose: async () => undefined });

  it('returns what the channel delivers', async () => {
    const data = Buffer.from([1, 2, 3]);
    await expect(readChannelAfterExit(channelOf(() => Promise.resolve(data)), 1000)).resolves.toBe(data);
  });

  it('passes a read failure through', async () => {
    await expect(readChannelAfterExit(channelOf(() => Promise.reject(new Error('boom'))), 1000)).rejects.toThrow('boom');
  });

  it('gives up with a clear error when age finished but nothing ever arrives', async () => {
    await expect(readChannelAfterExit(channelOf(() => new Promise<Buffer>(() => undefined)), 30)).rejects.toThrow(
      '"age" finished but wrote no output'
    );
  });

  it('says the same when the channel ends with nothing in it, instead of handing back an empty secret', async () => {
    await expect(readChannelAfterExit(channelOf(() => Promise.resolve(Buffer.alloc(0))), 1000)).rejects.toThrow(
      '"age" finished but wrote no output'
    );
  });
});

describe('createSecretOutputChannel', () => {
  const payload = Buffer.from([0x00, 0x0a, 0x0d, 0xff, 0x41, 0x04]); // LF/CR/EOF-like bytes

  it.skipIf(process.platform !== 'win32')(
    'on Windows serves a named pipe, ignores the empty probe connections age makes, and returns the data one',
    async () => {
      const net = await import('node:net');
      const channel = await createSecretOutputChannel(os.tmpdir());
      expect(channel.path.startsWith(String.fromCharCode(92, 92, 46, 92) + 'pipe')).toBe(true);

      const connect = () =>
        new Promise<import('node:net').Socket>((resolve, reject) => {
          const sock = net.connect(channel.path, () => resolve(sock));
          sock.on('error', reject);
        });
      // Two empty probes, then the real write — what age v1.3.2 does with `-o <pipe>`.
      (await connect()).end();
      (await connect()).end();
      (await connect()).end(payload);

      expect((await channel.read()).equals(payload)).toBe(true);
      await channel.dispose();
    }
  );

  it.skipIf(process.platform !== 'win32')('on Windows read() fails instead of hanging when nothing was ever written', async () => {
    const channel = await createSecretOutputChannel(os.tmpdir());
    await expect(channel.read()).rejects.toThrow('wrote no output');
    await channel.dispose();
  }, 10000);

  it.skipIf(process.platform === 'win32')('on POSIX serves a FIFO and removes it on dispose', async () => {
    const channel = await createSecretOutputChannel(os.tmpdir());
    expect(fs.statSync(channel.path).isFIFO()).toBe(true);
    await fsp.writeFile(channel.path, payload);
    expect((await channel.read()).equals(payload)).toBe(true);
    await channel.dispose();
    expect(fs.existsSync(channel.path)).toBe(false);
  });

  // What `age` does with `-o <fifo>`: Go's os.Create opens it read-write, which never waits for a reader, then it
  // writes, closes and exits. A FIFO nobody has open keeps nothing, so a reader that is not there yet loses it all.
  const writeAsAgeDoes = (fifoPath: string, bytes: Buffer): void => {
    const fd = fs.openSync(fifoPath, fs.constants.O_RDWR);
    fs.writeSync(fd, bytes);
    fs.closeSync(fd);
  };

  // The failure that was retried for a long time: `age` exited with 0 and the unlock said "wrote no output". The
  // reader was opened through libuv's thread pool, and when the pool was busy `age` had come and gone before the
  // open() reached the kernel. Here every thread of the pool is kept busy to make that the certain order of things.
  it.skipIf(process.platform === 'win32')(
    'on POSIX keeps what age wrote though age came and went while the thread pool was busy',
    async () => {
      const cryptoModule = await import('node:crypto');
      let busyDone = 0;
      const busy = Array.from(
        { length: 4 },
        () =>
          new Promise<void>((resolve) =>
            cryptoModule.pbkdf2('a', 'salt', 1_500_000, 64, 'sha512', () => {
              busyDone++;
              resolve();
            })
          )
      );
      const channel = await createSecretOutputChannel(os.tmpdir());
      writeAsAgeDoes(channel.path, payload);
      const read = await readChannelAfterExit(channel, 3000);
      // It was read while the pool was still busy: nothing about the channel waits its turn there.
      expect(busyDone).toBeLessThan(4);
      expect(read.equals(payload)).toBe(true);
      await channel.dispose();
      await Promise.all(busy);
    },
    30000
  );

  it.skipIf(process.platform === 'win32')('on POSIX is not at its end when a writer opens the target, closes it and comes back', async () => {
    const channel = await createSecretOutputChannel(os.tmpdir());
    // A first open that writes nothing (newer versions of age look at the target before they write to it).
    writeAsAgeDoes(channel.path, Buffer.alloc(0));
    await new Promise((resolve) => setTimeout(resolve, 30));
    writeAsAgeDoes(channel.path, payload);
    expect((await readChannelAfterExit(channel, 2000)).equals(payload)).toBe(true);
    await channel.dispose();
  });

  it.skipIf(process.platform === 'win32')('on POSIX drains more than a pipe holds while the writer is still writing', async () => {
    const { execFile } = await import('node:child_process');
    const channel = await createSecretOutputChannel(os.tmpdir());
    // 300 kB through a 64 kB pipe: the writer can only finish if the channel reads while it writes.
    const script = "const fs = require('node:fs'); const fd = fs.openSync(process.argv[1], fs.constants.O_RDWR); fs.writeSync(fd, Buffer.alloc(300000, 7)); fs.closeSync(fd);";
    await new Promise<void>((resolve, reject) => execFile(process.execPath, ['-e', script, channel.path], { timeout: 10000 }, (err) => (err ? reject(err) : resolve())));
    const read = await readChannelAfterExit(channel, 2000);
    expect(read.length).toBe(300000);
    expect(read.every((b) => b === 7)).toBe(true);
    await channel.dispose();
  }, 20000);

  // A failed `age` run never writes to the FIFO. Nothing of the channel sits in libuv's thread pool, so however many
  // runs fail, the pool still serves the app. (The reader once blocked a pool thread in open() for every failed run.)
  it.skipIf(process.platform === 'win32')(
    'on POSIX a run that wrote nothing ends with nothing, leaves no FIFO behind and holds no pool thread',
    async () => {
      for (let i = 0; i < 8; i++) {
        const channel = await createSecretOutputChannel(os.tmpdir());
        await new Promise((resolve) => setTimeout(resolve, 10));
        await expect(readChannelAfterExit(channel, 1000)).rejects.toThrow('"age" finished but wrote no output');
        await channel.dispose();
        expect(fs.existsSync(channel.path)).toBe(false);
        // Safe to call more than once.
        await channel.dispose();
      }
      // And a run that is given up without ever asking for the output.
      for (let i = 0; i < 8; i++) {
        const channel = await createSecretOutputChannel(os.tmpdir());
        await channel.dispose();
        expect(fs.existsSync(channel.path)).toBe(false);
        await expect(channel.read()).rejects.toThrow('closed before any data arrived');
      }
      // The thread pool still serves other fs work.
      await expect(fsp.readFile(__filename, 'utf-8')).resolves.toContain('holds no pool thread');
    },
    10000
  );
});
