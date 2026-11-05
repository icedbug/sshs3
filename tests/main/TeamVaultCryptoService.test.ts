import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { mockExecFile, mockRunAgeCommandViaPty, mockCreateChannel } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockRunAgeCommandViaPty: vi.fn(),
  mockCreateChannel: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: mockExecFile };
});

vi.mock('electron', () => ({
  app: { getAppPath: vi.fn().mockReturnValue('/app') },
}));

import { app as mockedElectronApp } from 'electron';

// enrollOwnPivRecipient/unwrapVaultKey go through AgePtyPinRelay (a real terminal is required
// for age-plugin-yubikey to prompt for PIN/touch — see docs/team-vault-plan.md). Mocked here so
// these unit tests never spawn a pty or touch real hardware; the one real-CLI round trip test
// below uses a software (non-PIV) identity instead, which needs none of this.
vi.mock('../../src/main/services/AgePtyPinRelay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/services/AgePtyPinRelay')>();
  return {
    ...actual,
    runAgeCommandViaPty: mockRunAgeCommandViaPty,
    createSecretOutputChannel: mockCreateChannel,
  };
});

import {
  TeamVaultCryptoService,
  TeamVaultDecryptionError,
  TEAM_VAULT_FILE_FIELD_COVERAGE,
  normalizeAsciiArmoredAge,
  payloadDigest,
  type TeamVaultMacInput,
} from '../../src/main/services/TeamVaultCryptoService';
import type { AgePtyPromptCallbacks } from '../../src/main/services/AgePtyPinRelay';

function noopCallbacks(): AgePtyPromptCallbacks {
  return {
    requestPin: vi.fn().mockRejectedValue(new Error('requestPin should not be called in this test')),
    onTouchRequested: vi.fn(),
    onTouchCleared: vi.fn(),
  };
}

const armor = (body: string) => `-----BEGIN AGE ENCRYPTED FILE-----\n${body}\n-----END AGE ENCRYPTED FILE-----\n`;
const ARMOR = armor('YWdlLWVuY3J5cHRpb24ub3JnL3YxCg==');
const ARMOR_1 = armor('QUFBQQ==');
const ARMOR_2 = armor('QkJCQg==');
// Malformed variants of ARMOR, built from its lines rather than by replacing characters in it.
const [ARMOR_HEADER, ...ARMOR_AFTER_HEADER] = ARMOR.split('\n');
const ARMOR_WITH_BLANK_LINE = [ARMOR_HEADER, '', ...ARMOR_AFTER_HEADER].join('\n'); // text between the lines
const ARMOR_WITH_BARE_CR = `${ARMOR_HEADER}\r${ARMOR_AFTER_HEADER.join('\n')}`; // header ended by a lone CR

describe('TeamVaultCryptoService', () => {
  const service = new TeamVaultCryptoService();

  describe('generateVaultKey', () => {
    it('returns a fresh 32-byte key each time', () => {
      const a = service.generateVaultKey();
      const b = service.generateVaultKey();
      expect(a).toHaveLength(32);
      expect(b).toHaveLength(32);
      expect(a.equals(b)).toBe(false);
    });
  });

  describe('encryptPayload / decryptPayload (pure crypto, no binary)', () => {
    it('round-trips plaintext', () => {
      const key = service.generateVaultKey();
      const encrypted = service.encryptPayload(key, 'vlt_1', 1, 'hello team vault');
      expect(service.decryptPayload(key, 'vlt_1', 1, encrypted)).toBe('hello team vault');
    });

    it('produces a fresh IV on every call, even for identical plaintext', () => {
      const key = service.generateVaultKey();
      const a = service.encryptPayload(key, 'vlt_1', 1, 'same payload');
      const b = service.encryptPayload(key, 'vlt_1', 1, 'same payload');
      expect(a).not.toBe(b);
    });

    it('rejects decryption with the wrong Vault Key', () => {
      const key = service.generateVaultKey();
      const wrongKey = service.generateVaultKey();
      const encrypted = service.encryptPayload(key, 'vlt_1', 1, 'secret');
      expect(() => service.decryptPayload(wrongKey, 'vlt_1', 1, encrypted)).toThrow(TeamVaultDecryptionError);
    });

    it('rejects decryption with a mismatched vaultId (AAD binding)', () => {
      const key = service.generateVaultKey();
      const encrypted = service.encryptPayload(key, 'vlt_1', 1, 'secret');
      expect(() => service.decryptPayload(key, 'vlt_2', 1, encrypted)).toThrow(TeamVaultDecryptionError);
    });

    it('rejects decryption with a mismatched formatVersion (AAD binding)', () => {
      const key = service.generateVaultKey();
      const encrypted = service.encryptPayload(key, 'vlt_1', 1, 'secret');
      expect(() => service.decryptPayload(key, 'vlt_1', 2, encrypted)).toThrow(TeamVaultDecryptionError);
    });

    it('rejects a tampered ciphertext (GCM auth tag failure)', () => {
      const key = service.generateVaultKey();
      const encrypted = service.encryptPayload(key, 'vlt_1', 1, 'secret');
      const bytes = Buffer.from(encrypted, 'base64');
      bytes[bytes.length - 1] ^= 0xff;
      expect(() => service.decryptPayload(key, 'vlt_1', 1, bytes.toString('base64'))).toThrow(
        TeamVaultDecryptionError
      );
    });

    it('rejects a truncated payload', () => {
      const key = service.generateVaultKey();
      expect(() => service.decryptPayload(key, 'vlt_1', 1, Buffer.from('short').toString('base64'))).toThrow(
        TeamVaultDecryptionError
      );
    });
  });

  describe('wrapVaultKeyForRecipient / unwrapVaultKey against the real `age` CLI', { retry: 2 }, () => {
    // Real age + pty + FIFO subprocesses: now and then (a few percent of full-suite runs) age exits 0 but the FIFO reader's
    // open() never completes, which readChannelAfterExit turns into a 5 s "wrote no output" error. The round trip has
    // no PIN or card, so a retry is harmless. The root cause is not found (CPU load alone does not reproduce it).
    // Prefer the CI-fetched copy (build-resources/age/<platform>) so this also runs on a machine
    // without a system-wide age: the real service resolves a bare `age` via PATH in this file.
    const bundledDir = path.join(process.cwd(), 'build-resources', 'age', process.platform === 'win32' ? 'win' : 'linux');
    if (fs.existsSync(bundledDir)) process.env.PATH = bundledDir + path.delimiter + process.env.PATH;
    const hasAge = !spawnSync('age', ['--version'], { stdio: 'ignore' }).error;
    const hasAgeKeygen = !spawnSync('age-keygen', ['--version'], { stdio: 'ignore' }).error;

    it.skipIf(!hasAge || !hasAgeKeygen)(
      'wraps a Vault Key for a software age identity and unwraps it back',
      async () => {
        // Unmock node:child_process and AgePtyPinRelay for this one real-binary round trip.
        // A software (non-PIV) identity never prompts for anything, so the real
        // runAgeCommandViaPty/createSecretOutputChannel can run unmocked too.
        vi.doUnmock('node:child_process');
        vi.doUnmock('../../src/main/services/AgePtyPinRelay');
        vi.resetModules();
        const real = await vi.importActual<typeof import('../../src/main/services/TeamVaultCryptoService')>(
          '../../src/main/services/TeamVaultCryptoService'
        );
        const realService = new real.TeamVaultCryptoService();

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshs3-vault-it-'));
        const identityPath = path.join(dir, 'identity.txt');
        const keygen = spawnSync('age-keygen', ['-o', identityPath]);
        expect(keygen.status).toBe(0);
        const identity = fs.readFileSync(identityPath, 'utf8');
        const recipientLine = identity.match(/# public key: (age1\S+)/)?.[1];
        expect(recipientLine).toBeTruthy();

        const vaultKey = realService.generateVaultKey();
        const wrapped = await realService.wrapVaultKeyForRecipient(vaultKey, recipientLine!);
        const unwrapped = await realService.unwrapVaultKey(wrapped, identityPath, noopCallbacks());
        expect(unwrapped.equals(vaultKey)).toBe(true);
      },
      // A real subprocess round trip (age-keygen + age wrap + age unwrap via pty) is slower than
      // the default 5s under full-suite parallel load (many vitest workers competing for CPU) —
      // seen flaking in pre-commit's `npm test` even though it's consistently <1s in isolation.
      60000
    );
  });

  describe('encryptForRecipient / decryptWithIdentity against the real `age` CLI', { retry: 2 }, () => {
    // Real age + pty + FIFO subprocesses: now and then (a few percent of full-suite runs) age exits 0 but the FIFO reader's
    // open() never completes, which readChannelAfterExit turns into a 5 s "wrote no output" error. The round trip has
    // no PIN or card, so a retry is harmless. The root cause is not found (CPU load alone does not reproduce it).
    const hasAge = !spawnSync('age', ['--version'], { stdio: 'ignore' }).error;
    const hasAgeKeygen = !spawnSync('age-keygen', ['--version'], { stdio: 'ignore' }).error;

    it.skipIf(!hasAge || !hasAgeKeygen)(
      'round-trips an arbitrary JSON string (the invite payload) for a software age identity',
      async () => {
        vi.doUnmock('node:child_process');
        vi.doUnmock('../../src/main/services/AgePtyPinRelay');
        vi.resetModules();
        const real = await vi.importActual<typeof import('../../src/main/services/TeamVaultCryptoService')>(
          '../../src/main/services/TeamVaultCryptoService'
        );
        const realService = new real.TeamVaultCryptoService();

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshs3-invite-it-'));
        const identityPath = path.join(dir, 'identity.txt');
        const keygen = spawnSync('age-keygen', ['-o', identityPath]);
        expect(keygen.status).toBe(0);
        const identity = fs.readFileSync(identityPath, 'utf8');
        const recipientLine = identity.match(/# public key: (age1\S+)/)?.[1];
        expect(recipientLine).toBeTruthy();

        const plaintext = JSON.stringify({ vaultId: 'vlt_1', target: { id: 't1', name: 'x', type: 's3' } });
        const armored = await realService.encryptForRecipient(plaintext, recipientLine!);
        const decrypted = await realService.decryptWithIdentity(armored, identityPath, noopCallbacks());
        expect(decrypted).toBe(plaintext);
      },
      // Same reasoning as the real round-trip test above — a real subprocess, not mocked.
      60000
    );
  });

  describe('decryptWithIdentity (pty + secret output channel, mocked)', () => {
    function fakeChannel(bytes: Buffer = Buffer.from('{"vaultId":"vlt_1"}', 'utf8')) {
      const channel = {
        path: '/tmp/fake-invite.fifo',
        read: vi.fn(() => Promise.resolve(bytes)),
        dispose: vi.fn().mockResolvedValue(undefined),
      };
      mockCreateChannel.mockResolvedValue(channel);
      return channel;
    }

    beforeEach(() => {
      mockRunAgeCommandViaPty.mockReset();
      mockCreateChannel.mockReset();
    });

    it('decrypts via the pty with -o <channel>, reads the result as text, and cleans up', async () => {
      const channel = fakeChannel();
      mockRunAgeCommandViaPty.mockResolvedValue('# some human-readable status text\n');

      const callbacks = noopCallbacks();
      const service2 = new TeamVaultCryptoService();
      const result = await service2.decryptWithIdentity(ARMOR, '/tmp/identity.txt', callbacks);

      expect(result).toBe('{"vaultId":"vlt_1"}');
      expect(mockCreateChannel).toHaveBeenCalledTimes(1);
      const [binary, args, , cbArg, , stdinArg] = mockRunAgeCommandViaPty.mock.calls[0];
      expect(binary).toMatch(/age(\.exe)?$/);
      expect(args.slice(0, 5)).toEqual(['-d', '-i', '/tmp/identity.txt', '-o', '/tmp/fake-invite.fifo']);
      expect(cbArg).toBe(callbacks);
      if (process.platform !== 'win32') expect(stdinArg).toBe(ARMOR);
      expect(channel.dispose).toHaveBeenCalledTimes(1);
    });

    it('sends the validated, whitespace-trimmed text rather than what it was given', async () => {
      fakeChannel();
      mockRunAgeCommandViaPty.mockResolvedValue('');
      await new TeamVaultCryptoService().decryptWithIdentity(`\n\n${ARMOR}  \n\n`, '/tmp/identity.txt', noopCallbacks());
      const stdinArg = mockRunAgeCommandViaPty.mock.calls[0][5];
      if (process.platform !== 'win32') expect(stdinArg).toBe(ARMOR);
    });

    it('refuses anything but a single armored age file before it can reach the pty', async () => {
      fakeChannel();
      const service2 = new TeamVaultCryptoService();
      const hostile = [
        `${ARMOR}000000\n000000\n000000\n`, // PIN guesses typed after the footer
        ARMOR.replace('YWdl', 'YW\u0015dl'), // Ctrl+U inside the body
        `${ARMOR}\u0003`, // Ctrl+C after the footer
        ARMOR_WITH_BLANK_LINE,
        `echo hi\n${ARMOR}`, // text before the header
        'armored-blob',
        '',
      ];
      for (const text of hostile) {
        await expect(service2.decryptWithIdentity(text, '/tmp/identity.txt', noopCallbacks())).rejects.toThrow(
          /valid ASCII-armored age ciphertext/
        );
        await expect(service2.unwrapVaultKey(text, '/tmp/identity.txt', noopCallbacks())).rejects.toThrow(
          /valid ASCII-armored age ciphertext/
        );
      }
      expect(mockRunAgeCommandViaPty).not.toHaveBeenCalled();
      expect(mockCreateChannel).not.toHaveBeenCalled();
    });

    it('still cleans up the channel when the pty run rejects (e.g. mismatched identity)', async () => {
      const channel = fakeChannel(Buffer.alloc(0));
      mockRunAgeCommandViaPty.mockRejectedValue(new Error('age: error: no identity matched any of the recipients'));

      const service2 = new TeamVaultCryptoService();
      await expect(
        service2.decryptWithIdentity(ARMOR, '/tmp/identity.txt', noopCallbacks())
      ).rejects.toThrow('no identity matched');
      expect(channel.dispose).toHaveBeenCalledTimes(1);
    });

    it('rejects a flag-like identity file path before ever creating a channel or spawning (argument-injection guard)', async () => {
      const service2 = new TeamVaultCryptoService();
      await expect(
        service2.decryptWithIdentity(ARMOR, '--output=/etc/passwd', noopCallbacks())
      ).rejects.toThrow('Invalid identity file path');
      expect(mockCreateChannel).not.toHaveBeenCalled();
      expect(mockRunAgeCommandViaPty).not.toHaveBeenCalled();
    });
  });

  describe('unwrapVaultKey (pty + secret output channel, mocked)', () => {
    function fakeChannel(bytes: Buffer = Buffer.from('raw-vault-key-bytes')) {
      const channel = {
        path: '/tmp/fake.fifo',
        read: vi.fn(() => Promise.resolve(bytes)),
        dispose: vi.fn().mockResolvedValue(undefined),
      };
      mockCreateChannel.mockResolvedValue(channel);
      return channel;
    }

    beforeEach(() => {
      mockRunAgeCommandViaPty.mockReset();
      mockCreateChannel.mockReset();
    });

    it('creates the channel, decrypts via the pty with -o <channel>, reads the result from it, and cleans up', async () => {
      const channel = fakeChannel();
      mockRunAgeCommandViaPty.mockResolvedValue('# some human-readable status text\n');

      const callbacks = noopCallbacks();
      const service2 = new TeamVaultCryptoService();
      const result = await service2.unwrapVaultKey(ARMOR, '/tmp/identity.txt', callbacks);

      expect(result.toString('utf8')).toBe('raw-vault-key-bytes');
      expect(mockCreateChannel).toHaveBeenCalledTimes(1);
      expect(mockRunAgeCommandViaPty).toHaveBeenCalledTimes(1);
      const [binary, args, , cbArg, , stdinArg] = mockRunAgeCommandViaPty.mock.calls[0];
      expect(binary).toMatch(/age(\.exe)?$/);
      expect(cbArg).toBe(callbacks);
      if (process.platform === 'win32') {
        // A ConPTY has no Ctrl-D EOF: the (non-secret) ciphertext goes in as a file argument.
        expect(args.slice(0, 5)).toEqual(['-d', '-i', '/tmp/identity.txt', '-o', '/tmp/fake.fifo']);
        expect(args).toHaveLength(6);
        expect(stdinArg).toBeUndefined();
        expect(fs.existsSync(args[5])).toBe(false);
      } else {
        expect(args).toEqual(['-d', '-i', '/tmp/identity.txt', '-o', '/tmp/fake.fifo']);
        expect(stdinArg).toBe(ARMOR);
      }
      expect(channel.dispose).toHaveBeenCalledTimes(1);
    });

    it('still cleans up the channel when the pty run rejects', async () => {
      const channel = fakeChannel(Buffer.alloc(0));
      mockRunAgeCommandViaPty.mockRejectedValue(new Error('age: error: no YubiKey detected'));

      const service2 = new TeamVaultCryptoService();
      await expect(service2.unwrapVaultKey(ARMOR, '/tmp/identity.txt', noopCallbacks())).rejects.toThrow(
        'no YubiKey detected'
      );
      expect(channel.dispose).toHaveBeenCalledTimes(1);
    });

    it('rejects a flag-like identity file path before ever creating a channel or spawning (argument-injection guard)', async () => {
      const service2 = new TeamVaultCryptoService();
      await expect(
        service2.unwrapVaultKey(ARMOR, '--output=/etc/passwd', noopCallbacks())
      ).rejects.toThrow('Invalid identity file path');
      expect(mockCreateChannel).not.toHaveBeenCalled();
      expect(mockRunAgeCommandViaPty).not.toHaveBeenCalled();
    });

    it('serializes concurrent unwrapVaultKey calls app-wide (Pkcs11Lock) — two different vaults unlocked at once must never run age-plugin-yubikey concurrently against the same physical card', async () => {
      fakeChannel();
      let inFlight = 0;
      let maxInFlight = 0;
      mockRunAgeCommandViaPty.mockImplementation(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 0));
        inFlight -= 1;
        return '';
      });

      const service2 = new TeamVaultCryptoService();
      await Promise.all([
        service2.unwrapVaultKey(ARMOR_1, '/tmp/identity-1.txt', noopCallbacks()),
        service2.unwrapVaultKey(ARMOR_2, '/tmp/identity-2.txt', noopCallbacks()),
      ]);

      expect(maxInFlight).toBe(1);
      expect(mockRunAgeCommandViaPty).toHaveBeenCalledTimes(2);
    });
  });

  describe('wrapVaultKeyForRecipient argument-injection guard', () => {
    beforeEach(() => {
      mockExecFile.mockReset();
    });

    // Wrapping for an age1yubikey1... recipient needs `age` to find the `age-plugin-yubikey`
    // plugin binary to parse/validate the recipient stanza — a pure public-key operation
    // (no PIV card or PIN involved), but it still execs the plugin, so it needs the same
    // PATH-prepending `unwrapVaultKey` already gets. Without it, this call fails identically in
    // a packaged build (the plugin is bundled right next to `age`, but not found by bare name on
    // PATH) as it does in dev with no system-wide install.
    it("passes an env with the age-plugin-yubikey directory prepended to PATH, same as unwrapVaultKey, so wrapping for a yubikey recipient doesn't fail with \"plugin not found\"", async () => {
      // Give resolveAgeBinary('age-plugin-yubikey') a real directory to resolve to (its
      // dev-checkout lookup is a plain fs.existsSync against <appPath>/build-resources/age/<os>),
      // so this test doesn't depend on whatever happens to be on the real machine's disk.
      const fakeAppRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sshs3-fake-app-root-'));
      const platformBinDir = path.join(fakeAppRoot, 'build-resources', 'age', process.platform === 'win32' ? 'win' : 'linux');
      fs.mkdirSync(platformBinDir, { recursive: true });
      fs.writeFileSync(path.join(platformBinDir, process.platform === 'win32' ? 'age-plugin-yubikey.exe' : 'age-plugin-yubikey'), '');
      vi.mocked(mockedElectronApp.getAppPath).mockReturnValueOnce(fakeAppRoot);

      mockExecFile.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: any) => {
        cb(null, Buffer.from('wrapped'), Buffer.from(''));
        return { stdin: { end: vi.fn() } };
      });

      const service2 = new TeamVaultCryptoService();
      const key = service2.generateVaultKey();
      await service2.wrapVaultKeyForRecipient(key, 'age1yubikey1fakerecipient');

      const [, , opts] = mockExecFile.mock.calls[0];
      // Mirrors unwrapVaultKey's pluginPathEnv exactly, so `age` can exec the plugin by bare
      // name even when it isn't installed system-wide (dev checkout or packaged build alike).
      expect(opts.env).not.toBe(process.env);
      expect(opts.env.PATH.split(path.delimiter)[0]).toBe(platformBinDir);
    });

    it('rejects a flag-like recipient string before ever shelling out', async () => {
      const service2 = new TeamVaultCryptoService();
      const key = service2.generateVaultKey();
      await expect(service2.wrapVaultKeyForRecipient(key, '-o/etc/passwd')).rejects.toThrow(
        'Invalid age recipient'
      );
      expect(mockExecFile).not.toHaveBeenCalled();
    });
  });

  describe('enrollOwnPivRecipient (mocked, pty path)', () => {
    beforeEach(() => {
      mockRunAgeCommandViaPty.mockReset();
    });

    it('parses the recipient string, persists the identity stanza to a file, and forwards callbacks', async () => {
      const generated =
        '#       Serial: 31310420, Slot: 1\n' +
        '#     PIN policy: Once (requires PIN once per session)\n' +
        '#   Touch policy: Always\n' +
        '#    Recipient: age1yubikey1qg69g6anlkd8w9ql0ugvyahm3ex8qd0v6v2n5l5w6rr0pq0wjxs8nqg6c2a\n' +
        'AGE-PLUGIN-YUBIKEY-1QG69G6ANLKD8W9QL0UGVYAHM3EX8QD0V6V2N5L5W6RR0PQ0WJXS8NQG6C2A\n'; // pragma: allowlist secret
      mockRunAgeCommandViaPty.mockImplementation(async (_binary: string, args: string[], _env: unknown, cb: unknown) => {
        expect(args).toEqual(['--generate']);
        expect(cb).toBe(callbacks);
        return generated;
      });

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshs3-vault-enroll-'));
      const service2 = new TeamVaultCryptoService();
      const callbacks = noopCallbacks();
      const result = await service2.enrollOwnPivRecipient(dir, callbacks);

      expect(result.recipient).toBe(
        'age1yubikey1qg69g6anlkd8w9ql0ugvyahm3ex8qd0v6v2n5l5w6rr0pq0wjxs8nqg6c2a' // pragma: allowlist secret
      );
      expect(fs.readFileSync(result.identityFilePath, 'utf8')).toBe(generated);
    });

    // Real hardware transcripts (docs/team-vault-plan.md's "Hårdvaruverifiering") include
    // interactive noise before the actual stanza — a "Generating key..." banner, the echoed PIN
    // prompt (with cursor-redraw escape codes), and a touch-prompt line. Found via run-desktop:
    // the file was unusable by `age -d -i <file>` ("unknown identity type") because the FULL
    // noisy transcript was being written verbatim instead of just the stanza.
    it('strips interactive pty noise from the saved identity file, keeping only the real stanza', async () => {
      const noisyTranscript =
        '\u{1f3b2} Generating key...\r\n' +
        '\r\n' +
        'Enter PIN for YubiKey with serial 20185052 (default is 123456): \r\n' +
        '\u001b[1A\r\u001b[2K\u001b[1B\u001b[1AEnter PIN for YubiKey with serial 20185052 (default is 123456): [hidden]\r\n' +
        '\r\n' +
        '\u{1f50f} Generating certificate...\r\n' +
        '\u{1f446} Please touch the YubiKey\r\n' +
        '#       Serial: 20185052, Slot: 3\r\n' +
        '#         Name: age identity 0b5f7a03\r\n' +
        '#      Created: Fri, 09 Oct 2026 14:18:26 +0000\r\n' +
        '#   PIN policy: Once   (A PIN is required once per session, if set)\r\n' +
        '# Touch policy: Always (A physical touch is required for every decryption)\r\n' +
        '#    Recipient: age1yubikey1qt5hwsyd95vtvxkpyjayvcgys4ng7gs4ucd02g07z2l32qvpvumesxkwg9u\r\n' +
        'AGE-PLUGIN-YUBIKEY-1MNLNXQVYPD0H5QCVDPS26\r\n'; // pragma: allowlist secret
      mockRunAgeCommandViaPty.mockResolvedValue(noisyTranscript);

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshs3-vault-enroll-'));
      const service2 = new TeamVaultCryptoService();
      const result = await service2.enrollOwnPivRecipient(dir, noopCallbacks());

      const saved = fs.readFileSync(result.identityFilePath, 'utf8');
      expect(saved).not.toContain('Generating key');
      expect(saved).not.toContain('Enter PIN');
      expect(saved).not.toContain('Please touch');
      expect(saved).toBe(
        '#       Serial: 20185052, Slot: 3\n' +
          '#         Name: age identity 0b5f7a03\n' +
          '#      Created: Fri, 09 Oct 2026 14:18:26 +0000\n' +
          '#   PIN policy: Once   (A PIN is required once per session, if set)\n' +
          '# Touch policy: Always (A physical touch is required for every decryption)\n' +
          '#    Recipient: age1yubikey1qt5hwsyd95vtvxkpyjayvcgys4ng7gs4ucd02g07z2l32qvpvumesxkwg9u\n' +
          'AGE-PLUGIN-YUBIKEY-1MNLNXQVYPD0H5QCVDPS26\n' // pragma: allowlist secret
      );
    });

    it('throws if no recipient string is found in the output', async () => {
      mockRunAgeCommandViaPty.mockResolvedValue('nothing useful here');

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshs3-vault-enroll-'));
      const service2 = new TeamVaultCryptoService();
      await expect(service2.enrollOwnPivRecipient(dir, noopCallbacks())).rejects.toThrow(
        'did not produce a recipient string'
      );
    });

    it('propagates TeamVaultDefaultCredentialsError/TeamVaultWrongPinError unchanged', async () => {
      const { TeamVaultDefaultCredentialsError } = await import('../../src/main/services/AgePtyPinRelay');
      mockRunAgeCommandViaPty.mockRejectedValue(new TeamVaultDefaultCredentialsError());

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshs3-vault-enroll-'));
      const service2 = new TeamVaultCryptoService();
      await expect(service2.enrollOwnPivRecipient(dir, noopCallbacks())).rejects.toBeInstanceOf(
        TeamVaultDefaultCredentialsError
      );
    });
  });

  // The recovery identity is a private key — CLAUDE.md forbids writing it to disk, so it reaches
  // `age` on stdin (`-i -`) and the Vault Key comes back on stdout; no pty, FIFO or pipe, which
  // is also what makes this path work on Windows.
  describe('unwrapVaultKeyWithRecoveryIdentity (stdin identity, never a file on disk)', () => {
    const CLEAN = '# created: 2026-01-01T00:00:00Z\n# public key: age1fakerecovery\nAGE-SECRET-KEY-1FAKERECOVERYTEXT\n';

    beforeEach(() => {
      mockExecFile.mockReset();
    });

    function fakeAge(stdout: Buffer) {
      const stdinEnd = vi.fn();
      mockExecFile.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
        queueMicrotask(() => cb(null, stdout, Buffer.alloc(0)));
        return { stdin: { end: stdinEnd } };
      });
      return stdinEnd;
    }

    it('feeds only the stanza on stdin, passes the ciphertext as a temp file, and removes that file', async () => {
      const stdinEnd = fakeAge(Buffer.from('vault-key'));
      const service2 = new TeamVaultCryptoService();
      const result = await service2.unwrapVaultKeyWithRecoveryIdentity(ARMOR, CLEAN);

      expect(result.toString('utf8')).toBe('vault-key');
      const [, args] = mockExecFile.mock.calls[0];
      expect(args.slice(0, 3)).toEqual(['-d', '-i', '-']);
      expect(args).toHaveLength(4);
      expect(fs.existsSync(args[3])).toBe(false);
      expect(stdinEnd.mock.calls[0][0].toString('utf8')).toBe(CLEAN);
    });

    it('tolerates surrounding chat/email quoting, passing only the real stanza', async () => {
      const stdinEnd = fakeAge(Buffer.from('vault-key'));
      const service2 = new TeamVaultCryptoService();
      const pasted = `Hey, here is the recovery key we printed:\n\n${CLEAN}\n-- sent from my phone`;
      await service2.unwrapVaultKeyWithRecoveryIdentity(ARMOR, pasted);
      expect(stdinEnd.mock.calls[0][0].toString('utf8')).toBe(CLEAN);
    });

    it('rejects text with no recognizable AGE-SECRET-KEY-1... line without spawning age', async () => {
      const service2 = new TeamVaultCryptoService();
      await expect(service2.unwrapVaultKeyWithRecoveryIdentity(ARMOR, 'not a key at all')).rejects.toThrow(
        'does not look like a Team Vault recovery key'
      );
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('removes the temp ciphertext file even when age fails', async () => {
      let seen = '';
      mockExecFile.mockImplementation((_bin: string, args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
        seen = args[3];
        queueMicrotask(() =>
          cb(new Error('exit 1'), Buffer.alloc(0), Buffer.from('age: error: no identity matched any of the recipients'))
        );
        return { stdin: { end: vi.fn() } };
      });
      const service2 = new TeamVaultCryptoService();
      await expect(service2.unwrapVaultKeyWithRecoveryIdentity(ARMOR, CLEAN)).rejects.toThrow('no identity matched');
      expect(fs.existsSync(seen)).toBe(false);
    });

    const platformDir = process.platform === 'win32' ? 'win' : 'linux';
    const exe = (n: string) => (process.platform === 'win32' ? `${n}.exe` : n);
    const realAge = [path.join(process.cwd(), 'build-resources', 'age', platformDir), '']
      .map((dir) => ({
        age: dir ? path.join(dir, exe('age')) : 'age',
        keygen: dir ? path.join(dir, exe('age-keygen')) : 'age-keygen',
      }))
      .find((b) => !spawnSync(b.age, ['--version'], { stdio: 'ignore' }).error && !spawnSync(b.keygen, ['--version'], { stdio: 'ignore' }).error);

    it.skipIf(!realAge)('real `age -d -i -` recovers the Vault Key with a pasted recovery identity', async () => {
      const identity = spawnSync(realAge!.keygen, [], { encoding: 'utf8' }).stdout;
      const recipient = identity.match(/# public key: (age1\S+)/)![1];
      const ciphertext = spawnSync(realAge!.age, ['-r', recipient, '-a'], { input: 'vault-key-bytes', encoding: 'utf8' }).stdout;

      const realChildProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      mockExecFile.mockReset().mockImplementation(((_bin: string, args: string[], opts: unknown, cb: unknown) =>
        (realChildProcess.execFile as any)(realAge!.age, args, opts, cb)) as any);

      const service2 = new TeamVaultCryptoService();
      const plaintext = await service2.unwrapVaultKeyWithRecoveryIdentity(ciphertext, `pasted:\n${identity}\nthanks`);
      expect(plaintext.toString('utf8')).toBe('vault-key-bytes');
    });
  });

  describe('computeAccessHeaderMac', () => {
    const accessHeader = [
      {
        recipientId: 'alice@piv:abc',
        role: 'admin' as const,
        method: 'piv-rsa-oaep' as const,
        ageRecipient: 'age1yubikey1alice',
        wrappedVaultKey: 'wrapped-alice',
        addedAt: '2026-01-01T00:00:00Z',
        addedBy: 'alice@piv:abc',
      },
    ];
    const recovery = {
      recipientId: 'recovery-key-1',
      ageRecipient: 'age1recovery',
      wrappedVaultKey: 'wrapped-recovery',
    };

    it('is deterministic for the same inputs', () => {
      const svc = new TeamVaultCryptoService();
      const key = Buffer.alloc(32, 1);
      const a = svc.computeAccessHeaderMac(key, 'vlt_1', 1, '', accessHeader, recovery);
      const b = svc.computeAccessHeaderMac(key, 'vlt_1', 1, '', accessHeader, recovery);
      expect(a).toBe(b);
    });

    it('changes if the Vault Key differs', () => {
      const svc = new TeamVaultCryptoService();
      const macA = svc.computeAccessHeaderMac(Buffer.alloc(32, 1), 'vlt_1', 1, '', accessHeader, recovery);
      const macB = svc.computeAccessHeaderMac(Buffer.alloc(32, 2), 'vlt_1', 1, '', accessHeader, recovery);
      expect(macA).not.toBe(macB);
    });

    it('changes if any access entry field differs, even a single character', () => {
      const svc = new TeamVaultCryptoService();
      const key = Buffer.alloc(32, 1);
      const macA = svc.computeAccessHeaderMac(key, 'vlt_1', 1, '', accessHeader, recovery);
      const tampered = [{ ...accessHeader[0], ageRecipient: 'age1yubikey1alicX' }];
      const macB = svc.computeAccessHeaderMac(key, 'vlt_1', 1, '', tampered, recovery);
      expect(macA).not.toBe(macB);
    });

    it('changes if the revision, vaultId, or vaultName differs', () => {
      const svc = new TeamVaultCryptoService();
      const key = Buffer.alloc(32, 1);
      const base = svc.computeAccessHeaderMac(key, 'vlt_1', 1, '', accessHeader, recovery);
      expect(svc.computeAccessHeaderMac(key, 'vlt_1', 2, '', accessHeader, recovery)).not.toBe(base);
      expect(svc.computeAccessHeaderMac(key, 'vlt_2', 1, '', accessHeader, recovery)).not.toBe(base);
      expect(svc.computeAccessHeaderMac(key, 'vlt_1', 1, 'Acme Team', accessHeader, recovery)).not.toBe(base);
    });

    it('is insensitive to access-entry array order (sorted canonicalization)', () => {
      const svc = new TeamVaultCryptoService();
      const key = Buffer.alloc(32, 1);
      const second = {
        recipientId: 'bob@piv:def',
        role: 'member' as const,
        method: 'piv-rsa-oaep' as const,
        ageRecipient: 'age1yubikey1bob',
        wrappedVaultKey: 'wrapped-bob',
        addedAt: '2026-01-02T00:00:00Z',
        addedBy: 'alice@piv:abc',
      };
      const forward = svc.computeAccessHeaderMac(key, 'vlt_1', 1, '', [accessHeader[0], second], recovery);
      const reversed = svc.computeAccessHeaderMac(key, 'vlt_1', 1, '', [second, accessHeader[0]], recovery);
      expect(forward).toBe(reversed);
    });

    it('changes if vaultDescription differs, and defaults to the empty string when omitted', () => {
      const svc = new TeamVaultCryptoService();
      const key = Buffer.alloc(32, 1);
      const withoutDescription = svc.computeAccessHeaderMac(key, 'vlt_1', 1, '', accessHeader, recovery);
      const withEmptyDescription = svc.computeAccessHeaderMac(key, 'vlt_1', 1, '', accessHeader, recovery, '');
      const withDescription = svc.computeAccessHeaderMac(key, 'vlt_1', 1, '', accessHeader, recovery, 'Acme Infra team');
      expect(withoutDescription).toBe(withEmptyDescription);
      expect(withDescription).not.toBe(withoutDescription);
    });

    it('reproduces the exact pre-vaultDescription MAC (golden value) for a vault with no description, so every vault written before this field existed keeps unlocking', () => {
      // Regression pin: an earlier version of this canonicalization always appended a
      // `\u0002${vaultDescription}` segment, even when empty — which changed the canonical bytes
      // (and therefore the MAC) for every vault that predates the `vaultDescription` field,
      // breaking unlock with TeamVaultHeaderIntegrityError on real installs the moment it shipped.
      // This golden value was computed once against the fixed (backward-compatible) 3-field
      // header line and must never change for a description-less vault.
      const svc = new TeamVaultCryptoService();
      const key = Buffer.alloc(32, 7);
      const entry = [
        {
          recipientId: 'alice@piv:abc',
          role: 'admin' as const,
          method: 'piv-rsa-oaep' as const,
          ageRecipient: 'age1yubikey1alice',
          wrappedVaultKey: 'wrapped-alice',
          addedAt: '2026-01-01T00:00:00Z',
          addedBy: 'alice@piv:abc',
        },
      ];
      const goldenRecovery = {
        recipientId: 'recovery-key-1',
        ageRecipient: 'age1fakerecovery',
        wrappedVaultKey: 'wrapped-recovery',
      };
      const mac = svc.computeAccessHeaderMac(key, 'vlt_golden', 1, 'Golden Team', entry, goldenRecovery);
      expect(mac).toBe('uQ8waktnAlCZTy3zVUd8AZuBWXyqv7e6LuHJ+vUr3gw='); // pragma: allowlist secret
    });

    it('throws rather than silently computing an ambiguous MAC when a field contains a canonicalization delimiter — defense in depth, even though every known caller already rejects these at its own input boundary', () => {
      const svc = new TeamVaultCryptoService();
      const key = Buffer.alloc(32, 1);
      // vaultName "Foo\u0002Bar" with no description would otherwise canonicalize identically to
      // vaultName "Foo" with description "Bar" — the exact collision this check closes.
      expect(() => svc.computeAccessHeaderMac(key, 'vlt_1', 1, 'Foo\u0002Bar', accessHeader, recovery)).toThrow(
        /reserved control character/
      );
      expect(() =>
        svc.computeAccessHeaderMac(key, 'vlt_1', 1, '', accessHeader, recovery, 'desc\u0003injected')
      ).toThrow(/reserved control character/);
      expect(() =>
        svc.computeAccessHeaderMac(
          key,
          'vlt_1',
          1,
          '',
          [{ ...accessHeader[0], recipientId: 'alice\u0001evil' }],
          recovery
        )
      ).toThrow(/reserved control character/);
      expect(() =>
        svc.computeAccessHeaderMac(key, 'vlt_1', 1, '', accessHeader, { ...recovery, recipientId: 'r\u0002x' })
      ).toThrow(/reserved control character/);
    });
  });

  describe('computeRotationProof', () => {
    const accessHeader = [
      {
        recipientId: 'alice@piv:abc',
        role: 'admin' as const,
        method: 'piv-rsa-oaep' as const,
        ageRecipient: 'age1yubikey1alice',
        wrappedVaultKey: 'wrapped-alice-under-new-key',
        addedAt: '2026-01-01T00:00:00Z',
        addedBy: 'alice@piv:abc',
      },
    ];
    const recovery = {
      recipientId: 'recovery-key-1',
      ageRecipient: 'age1recovery',
      wrappedVaultKey: 'wrapped-recovery-under-new-key',
    };

    it('is deterministic for the same inputs', () => {
      const svc = new TeamVaultCryptoService();
      const oldKey = Buffer.alloc(32, 1);
      const a = svc.computeRotationProof(oldKey, 'vlt_1', 2, '', accessHeader, recovery);
      const b = svc.computeRotationProof(oldKey, 'vlt_1', 2, '', accessHeader, recovery);
      expect(a).toBe(b);
    });

    it('changes if the old Vault Key differs', () => {
      const svc = new TeamVaultCryptoService();
      const proofA = svc.computeRotationProof(Buffer.alloc(32, 1), 'vlt_1', 2, '', accessHeader, recovery);
      const proofB = svc.computeRotationProof(Buffer.alloc(32, 2), 'vlt_1', 2, '', accessHeader, recovery);
      expect(proofA).not.toBe(proofB);
    });

    it('changes if the new header content differs', () => {
      const svc = new TeamVaultCryptoService();
      const oldKey = Buffer.alloc(32, 1);
      const base = svc.computeRotationProof(oldKey, 'vlt_1', 2, '', accessHeader, recovery);
      const tampered = [{ ...accessHeader[0], ageRecipient: 'age1yubikey1attacker' }];
      expect(svc.computeRotationProof(oldKey, 'vlt_1', 2, '', tampered, recovery)).not.toBe(base);
    });

    it('never equals computeAccessHeaderMac for the same key and fields (separate HKDF info strings)', () => {
      // A rotation proof (keyed by the OLD key) must never be mistakable for a header MAC (keyed
      // by the NEW key) even if an attacker could somehow get both derived from the same raw key
      // — see TeamVaultRotationProofError's doc comment on why these are deliberately separate
      // primitives, not the same HMAC reused for two purposes.
      const svc = new TeamVaultCryptoService();
      const key = Buffer.alloc(32, 1);
      const proof = svc.computeRotationProof(key, 'vlt_1', 2, '', accessHeader, recovery);
      const mac = svc.computeAccessHeaderMac(key, 'vlt_1', 2, '', accessHeader, recovery);
      expect(proof).not.toBe(mac);
    });

    it("an attacker holding only the new, self-generated key cannot reproduce a valid proof without the old one", () => {
      const svc = new TeamVaultCryptoService();
      const realOldKey = Buffer.alloc(32, 1);
      const attackerGeneratedKey = Buffer.alloc(32, 99); // stands in for the NEW key, irrelevant to the proof
      const realProof = svc.computeRotationProof(realOldKey, 'vlt_1', 2, '', accessHeader, recovery);
      const forgedProof = svc.computeRotationProof(attackerGeneratedKey, 'vlt_1', 2, '', accessHeader, recovery);
      expect(forgedProof).not.toBe(realProof);
    });
  });
});

describe('format v2: computeFileMac / computeFileRotationProof', () => {
  const svc = new TeamVaultCryptoService();
  const key = Buffer.alloc(32, 9);
  const oldKey = Buffer.alloc(32, 3);

  const v2File = (over: Partial<TeamVaultMacInput> = {}): TeamVaultMacInput => ({
    formatVersion: 2,
    vaultId: 'vlt_1',
    vaultName: 'Acme',
    vaultDescription: 'Acme infra',
    revision: 5,
    updatedAt: '2026-11-04T10:00:00.000Z',
    updatedBy: 'alice@piv:abc',
    accessHeader: [
      {
        recipientId: 'alice@piv:abc',
        role: 'admin',
        method: 'piv-rsa-oaep',
        ageRecipient: 'age1yubikey1alice',
        wrappedVaultKey: 'wrapped-alice',
        addedAt: '2026-01-01T00:00:00Z',
        addedBy: 'alice@piv:abc',
      },
    ],
    recovery: { recipientId: 'recovery-key-1', ageRecipient: 'age1recovery', wrappedVaultKey: 'wrapped-recovery', note: 'in the safe' },
    encryptedPayload: 'cGF5bG9hZC1vbmU=',
    ...over,
  });

  it('is deterministic, and ignores the two tags it produces', () => {
    const base = v2File();
    expect(svc.computeFileMac(key, base)).toBe(svc.computeFileMac(key, v2File()));
    // The tags are not part of the input type, but a whole file passed in (as the service does) must give the same MAC.
    expect(svc.computeFileMac(key, { ...base, accessHeaderMac: 'x', prevKeyProof: 'y' } as TeamVaultMacInput)).toBe(svc.computeFileMac(key, base));
  });

  // Cross-checked against an independent implementation (HKDF-SHA256 + HMAC-SHA256 written separately), not just this code.
  it('pins the v2 MAC so the canonicalization cannot change by accident', () => {
    expect(svc.computeFileMac(key, v2File())).toBe('3DAi/EdOEVbZxC0sDxV+yQwGw/BTUbegWQdopqU+VNU='); // pragma: allowlist secret
  });

  // M1 (code review 2026-11-03): the header MAC did not cover the payload, so an older payload could be placed under a
  // current header. In v2 any change of the ciphertext changes the MAC.
  it('changes when the payload ciphertext changes (the M1 splice)', () => {
    expect(svc.computeFileMac(key, v2File({ encryptedPayload: 'b2xkZXItcGF5bG9hZA==' }))).not.toBe(svc.computeFileMac(key, v2File()));
  });

  // Every field classified 'mac' must really be covered: a compile error if a field is added without a mutator here.
  const mutators: Record<Exclude<keyof typeof TEAM_VAULT_FILE_FIELD_COVERAGE, 'accessHeaderMac' | 'prevKeyProof'>, (f: TeamVaultMacInput) => TeamVaultMacInput> = {
    formatVersion: (f) => ({ ...f, formatVersion: 1 }),
    vaultId: (f) => ({ ...f, vaultId: 'vlt_2' }),
    vaultName: (f) => ({ ...f, vaultName: 'Other' }),
    vaultDescription: (f) => ({ ...f, vaultDescription: 'Other description' }),
    revision: (f) => ({ ...f, revision: f.revision + 1 }),
    updatedAt: (f) => ({ ...f, updatedAt: '2026-11-04T11:00:00.000Z' }),
    updatedBy: (f) => ({ ...f, updatedBy: 'mallory' }),
    accessHeader: (f) => ({ ...f, accessHeader: [{ ...f.accessHeader[0], role: 'member' }] }),
    recovery: (f) => ({ ...f, recovery: { ...f.recovery, note: 'tampered note' } }),
    encryptedPayload: (f) => ({ ...f, encryptedPayload: 'dGFtcGVyZWQ=' }),
  };

  it('covers every field the coverage table marks as authenticated', () => {
    const base = svc.computeFileMac(key, v2File());
    const covered = Object.entries(TEAM_VAULT_FILE_FIELD_COVERAGE).filter(([, c]) => c === 'mac').map(([field]) => field);
    expect(covered.sort()).toEqual(Object.keys(mutators).sort());
    for (const [field, mutate] of Object.entries(mutators)) {
      expect(svc.computeFileMac(key, mutate(v2File())), `changing ${field} must change the MAC`).not.toBe(base);
    }
  });

  it('keeps the two tags out of the authenticated set', () => {
    expect(TEAM_VAULT_FILE_FIELD_COVERAGE.accessHeaderMac).toBe('unauthenticated');
    expect(TEAM_VAULT_FILE_FIELD_COVERAGE.prevKeyProof).toBe('unauthenticated');
  });

  it('keeps v1 exactly as it was, and a v1 MAC can never verify as a v2 MAC (or the other way round)', () => {
    const v1 = v2File({ formatVersion: 1 });
    expect(svc.computeFileMac(key, v1)).toBe(
      svc.computeAccessHeaderMac(key, v1.vaultId, v1.revision, v1.vaultName ?? '', v1.accessHeader, v1.recovery, v1.vaultDescription ?? '')
    );
    expect(svc.computeFileMac(key, v1)).not.toBe(svc.computeFileMac(key, v2File()));
  });

  it('refuses a format it does not know', () => {
    expect(() => svc.computeFileMac(key, v2File({ formatVersion: 3 as never }))).toThrow(/Unsupported Team Vault format version 3/);
  });

  it('throws instead of computing an ambiguous MAC when a field contains a canonicalization delimiter', () => {
    expect(() => svc.computeFileMac(key, v2File({ updatedBy: 'a\u0002b' }))).toThrow(/updatedBy/);
    expect(() => svc.computeFileMac(key, v2File({ recovery: { ...v2File().recovery, note: 'n\u0003x' } }))).toThrow(/recovery.note/);
  });

  it('rotation proof: keyed from the old key, covers the new payload, and is never equal to the file MAC', () => {
    const file = v2File();
    const proof = svc.computeFileRotationProof(oldKey, file);
    expect(proof).toBe(svc.computeFileRotationProof(oldKey, v2File()));
    expect(svc.computeFileRotationProof(oldKey, v2File({ encryptedPayload: 'dGFtcGVyZWQ=' }))).not.toBe(proof);
    expect(svc.computeFileRotationProof(Buffer.alloc(32, 4), file)).not.toBe(proof);
    expect(svc.computeFileMac(oldKey, file)).not.toBe(proof);
    const v1 = v2File({ formatVersion: 1 });
    expect(svc.computeFileRotationProof(oldKey, v1)).toBe(
      svc.computeRotationProof(oldKey, v1.vaultId, v1.revision, v1.vaultName ?? '', v1.accessHeader, v1.recovery, v1.vaultDescription ?? '')
    );
  });

  it('payloadDigest is SHA-256 of the ciphertext string, base64', () => {
    expect(payloadDigest('abc')).toBe('ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0='); // pragma: allowlist secret
  });
});

describe('normalizeAsciiArmoredAge', () => {
  it('accepts one armored file, with LF or CRLF lines, and returns it with a single final newline', () => {
    const multi = `-----BEGIN AGE ENCRYPTED FILE-----\nQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=\nYWJj\n-----END AGE ENCRYPTED FILE-----`;
    expect(normalizeAsciiArmoredAge(multi)).toBe(`${multi}\n`);
    expect(normalizeAsciiArmoredAge(`${multi}\n`)).toBe(`${multi}\n`);
    expect(normalizeAsciiArmoredAge(multi.replace(/\n/g, '\r\n'))).toBe(`${multi}\n`);
  });

  it('drops surrounding whitespace that a paste or an edit leaves behind, and returns what it validated', () => {
    expect(normalizeAsciiArmoredAge(`\n\n  ${ARMOR}  \n\n`)).toBe(ARMOR);
  });

  it('trims only ASCII whitespace: a BOM, NBSP or U+2028 around the armor is not "blank"', () => {
    for (const edge of ['\uFEFF', '\u00A0', '\u2028', '\u000B']) {
      expect(() => normalizeAsciiArmoredAge(`${edge}${ARMOR}`)).toThrow();
      expect(() => normalizeAsciiArmoredAge(`${ARMOR.trimEnd()}${edge}`)).toThrow();
    }
  });

  it('rejects an empty body, a bare carriage return, text around the file and a non-string', () => {
    expect(() => normalizeAsciiArmoredAge('-----BEGIN AGE ENCRYPTED FILE-----\n-----END AGE ENCRYPTED FILE-----\n')).toThrow();
    expect(() => normalizeAsciiArmoredAge(ARMOR_WITH_BARE_CR)).toThrow();
    expect(() => normalizeAsciiArmoredAge(`x ${ARMOR}`)).toThrow();
    expect(() => normalizeAsciiArmoredAge(`${ARMOR}x`)).toThrow();
    expect(() => normalizeAsciiArmoredAge(undefined as unknown as string)).toThrow();
  });
});
