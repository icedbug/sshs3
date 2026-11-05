import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as SmartcardAgentLoader from '../../src/main/smartcard/SmartcardAgentLoader';
import * as YkmanFido from '../../src/main/smartcard/YkmanFido';
import { AgentLifecycleManager } from '../../src/main/ssh/AgentLifecycleManager';
import { withPkcs11Lock } from '../../src/main/smartcard/Pkcs11Lock';
import { generateFido2Key, listFido2ResidentKeys, deleteFido2ResidentKey } from '../../src/main/smartcard/Fido2KeyManager';

describe('Fido2KeyManager', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('generateFido2Key', () => {
    it('refuses to overwrite an existing file without ever invoking ssh-keygen', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fido2-test-'));
      const outPath = path.join(dir, 'id_ed25519_sk');
      await fs.writeFile(outPath, 'not a key');

      await expect(
        generateFido2Key({ outPath, keyType: 'ed25519-sk', resident: true, verifyRequired: true })
      ).rejects.toThrow(/already exists/);

      await fs.rm(dir, { recursive: true, force: true });
    });

    it.skipIf(process.platform === 'win32')('deletes the stale local file first and proceeds when overwrite is explicitly requested', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fido2-overwrite-test-'));
      const outPath = path.join(dir, 'id_ed25519_sk');
      await fs.writeFile(outPath, 'stale stub from a deleted credential');
      await fs.writeFile(`${outPath}.pub`, 'stale pub');

      const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-ssh-keygen-overwrite-'));
      const originalPath = process.env.PATH;
      process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;
      await fs.writeFile(
        path.join(fakeBinDir, 'ssh-keygen'),
        '#!/bin/sh\n' +
          'f=""\n' +
          'while [ "$#" -gt 0 ]; do if [ "$1" = "-f" ]; then f="$2"; fi; shift; done\n' +
          'echo "new private" > "$f"\n' +
          'echo "new public" > "$f.pub"\n' +
          'exit 0\n',
        { mode: 0o755 }
      );

      try {
        const result = await generateFido2Key({
          outPath,
          keyType: 'ed25519-sk',
          resident: true,
          verifyRequired: true,
          overwrite: true,
        });
        expect(result.publicKey).toBe('new public');
        expect(await fs.readFile(outPath, 'utf-8')).toBe('new private\n');
      } finally {
        process.env.PATH = originalPath;
        await fs.rm(dir, { recursive: true, force: true });
        await fs.rm(fakeBinDir, { recursive: true, force: true });
      }
    });

    it('expands a leading ~ against the real home directory instead of creating a literal "~" folder', async () => {
      const relSubdir = `.sshs3-fido2-test-${Date.now()}`;
      const expandedDir = path.join(os.homedir(), relSubdir);
      const expandedPath = path.join(expandedDir, 'id_ed25519_sk');
      const literalTildeSubdir = path.join(process.cwd(), '~', relSubdir);

      await fs.mkdir(expandedDir, { recursive: true });
      await fs.writeFile(expandedPath, 'not a key');

      try {
        // The pre-existing-file check must resolve `~/<relSubdir>/id_ed25519_sk` to the SAME
        // path as expandedPath above — if it instead resolved to a literal "~" directory under
        // cwd, this would find nothing there and proceed to (uselessly) spawn ssh-keygen.
        await expect(
          generateFido2Key({
            outPath: `~/${relSubdir}/id_ed25519_sk`,
            keyType: 'ed25519-sk',
            resident: true,
            verifyRequired: true,
          })
        ).rejects.toThrow(new RegExp(expandedPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

        // A collision-proof, per-test subdir name, so this only fails if THIS run created it
        // under a literal "~" directory rather than the real home directory.
        const literalTildeSubdirExists = await fs
          .stat(literalTildeSubdir)
          .then(() => true)
          .catch(() => false);
        expect(literalTildeSubdirExists).toBe(false);
      } finally {
        await fs.rm(expandedDir, { recursive: true, force: true });
        await fs.rm(literalTildeSubdir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it.skipIf(process.platform === 'win32')('shares the app-wide Pkcs11Lock queue, so it never runs concurrently with a resident-key scan against the same physical device', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fido2-lock-test-'));
      const outPath = path.join(dir, 'id_ed25519_sk');
      const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-ssh-keygen-'));
      const originalPath = process.env.PATH;
      process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;

      // A fake ssh-keygen that just writes out the two files generateFido2Key expects, standing in
      // for the real hardware-dependent binary — the point of this test is the lock ordering, not
      // ssh-keygen's own behavior (already covered by manual/real-device testing elsewhere).
      await fs.writeFile(
        path.join(fakeBinDir, 'ssh-keygen'),
        '#!/bin/sh\n' +
          'f=""\n' +
          'while [ "$#" -gt 0 ]; do if [ "$1" = "-f" ]; then f="$2"; fi; shift; done\n' +
          'echo "private" > "$f"\n' +
          'echo "public" > "$f.pub"\n' +
          'exit 0\n',
        { mode: 0o755 }
      );

      const events: string[] = [];
      // Occupies the shared queue first, so generateFido2Key's own withPkcs11Lock call must wait
      // behind it — if generateFido2Key didn't actually go through the lock, its "start"/"end"
      // events would interleave with the occupier's instead of strictly following it.
      const occupier = withPkcs11Lock(async () => {
        events.push('occupier:start');
        await new Promise((resolve) => setTimeout(resolve, 150));
        events.push('occupier:end');
      });

      try {
        await new Promise((resolve) => setTimeout(resolve, 20)); // let the occupier grab the queue first
        events.push('generate:start');
        await generateFido2Key({ outPath, keyType: 'ed25519-sk', resident: true, verifyRequired: true });
        events.push('generate:end');
        await occupier;

        // The only thing that actually matters: generate's lock-protected ssh-keygen call can't
        // finish (so generate:end can't fire) until AFTER the occupier releases the shared queue.
        expect(events.indexOf('generate:end')).toBeGreaterThan(events.indexOf('occupier:end'));
      } finally {
        process.env.PATH = originalPath;
        await fs.rm(dir, { recursive: true, force: true });
        await fs.rm(fakeBinDir, { recursive: true, force: true });
      }
    });

    it.skipIf(process.platform === 'win32')('scopes each resident key by its output filename, so distinct profiles don\'t collide on-token', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fido2-scope-test-'));
      const outPath = path.join(dir, 'id_work_server_sk');
      const argsFile = path.join(dir, 'captured-args.txt');
      const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-ssh-keygen-scope-'));
      const originalPath = process.env.PATH;
      process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;

      await fs.writeFile(
        path.join(fakeBinDir, 'ssh-keygen'),
        '#!/bin/sh\n' +
          `echo "$@" > "${argsFile}"\n` +
          'f=""\n' +
          'while [ "$#" -gt 0 ]; do if [ "$1" = "-f" ]; then f="$2"; fi; shift; done\n' +
          'echo "private" > "$f"\n' +
          'echo "public" > "$f.pub"\n' +
          'exit 0\n',
        { mode: 0o755 }
      );

      try {
        await generateFido2Key({ outPath, keyType: 'ed25519-sk', resident: true, verifyRequired: true });
        const capturedArgs = await fs.readFile(argsFile, 'utf-8');
        expect(capturedArgs).toContain('application=ssh:id_work_server_sk');
      } finally {
        process.env.PATH = originalPath;
        await fs.rm(dir, { recursive: true, force: true });
        await fs.rm(fakeBinDir, { recursive: true, force: true });
      }
    });
  });

  describe('listFido2ResidentKeys — ssh-add fallback (ykman not installed)', () => {
    it('loads resident keys into a throwaway agent, lists them, and always tears the agent down', async () => {
      vi.spyOn(YkmanFido, 'isYkmanAvailable').mockResolvedValue(false);
      const loadSpy = vi
        .spyOn(SmartcardAgentLoader, 'loadFido2ResidentKeysIntoPrivateAgent')
        .mockResolvedValue({ pid: 1234, socketPath: '/tmp/fido2-agent.sock' });
      const listSpy = vi.spyOn(SmartcardAgentLoader, 'listAgentIdentities').mockResolvedValue([
        { bits: '256', fingerprint: 'SHA256:abc', comment: 'id_ed25519_sk', keyType: 'ED25519-SK' },
      ]);
      const killSpy = vi.spyOn(AgentLifecycleManager, 'killPrivateAgent').mockImplementation(() => {});

      const promptHandler = () => '';
      const result = await listFido2ResidentKeys(promptHandler);

      expect(loadSpy).toHaveBeenCalledWith(promptHandler, undefined);
      expect(listSpy).toHaveBeenCalledWith('/tmp/fido2-agent.sock');
      expect(killSpy).toHaveBeenCalledWith(1234);
      expect(result).toEqual([{ bits: '256', fingerprint: 'SHA256:abc', comment: 'id_ed25519_sk', keyType: 'ED25519-SK' }]);
    });

    it('still tears down the agent if listing identities throws', async () => {
      vi.spyOn(YkmanFido, 'isYkmanAvailable').mockResolvedValue(false);
      vi.spyOn(SmartcardAgentLoader, 'loadFido2ResidentKeysIntoPrivateAgent').mockResolvedValue({
        pid: 5678,
        socketPath: '/tmp/fido2-agent-2.sock',
      });
      vi.spyOn(SmartcardAgentLoader, 'listAgentIdentities').mockRejectedValue(new Error('boom'));
      const killSpy = vi.spyOn(AgentLifecycleManager, 'killPrivateAgent').mockImplementation(() => {});

      await expect(listFido2ResidentKeys(() => '')).rejects.toThrow('boom');
      expect(killSpy).toHaveBeenCalledWith(5678);
    });
  });

  describe('listFido2ResidentKeys — prefers ykman when installed', () => {
    it('prompts once for the PIN and maps ykman credentials into Fido2ResidentKey shape, including credentialId', async () => {
      vi.spyOn(YkmanFido, 'isYkmanAvailable').mockResolvedValue(true);
      const listSpy = vi.spyOn(YkmanFido, 'listYkmanFidoCredentials').mockResolvedValue([
        { credentialId: 'abc123', rpId: 'ssh:id_ed25519_sk', userName: 'alun', userDisplayName: 'Alun' },
      ]);
      const promptHandler = vi.fn().mockResolvedValue('123456');

      const result = await listFido2ResidentKeys(promptHandler);

      expect(promptHandler).toHaveBeenCalledTimes(1);
      expect(listSpy).toHaveBeenCalledWith('123456');
      expect(result).toEqual([
        { fingerprint: 'abc123', comment: 'Alun', keyType: 'ssh:id_ed25519_sk', credentialId: 'abc123' },
      ]);
    });

    it('lists only SSH credentials, not the key\'s web passkeys', async () => {
      vi.spyOn(YkmanFido, 'isYkmanAvailable').mockResolvedValue(true);
      vi.spyOn(YkmanFido, 'listYkmanFidoCredentials').mockResolvedValue([
        { credentialId: 'web1', rpId: 'github.com', userName: 'alun', userDisplayName: 'Alun' },
        { credentialId: 'ssh1', rpId: 'ssh:work', userName: 'alun', userDisplayName: 'Alun' },
        { credentialId: 'web2', rpId: 'google.com', userName: 'alun', userDisplayName: 'Alun' },
        { credentialId: 'ssh2', rpId: 'ssh:', userName: 'alun', userDisplayName: 'Alun' },
      ]);

      const result = await listFido2ResidentKeys(vi.fn().mockResolvedValue('123456'));

      expect(result.map((k) => k.credentialId)).toEqual(['ssh1', 'ssh2']);
    });

    it('does not run ykman when the PIN prompt was dismissed', async () => {
      vi.spyOn(YkmanFido, 'isYkmanAvailable').mockResolvedValue(true);
      const listSpy = vi.spyOn(YkmanFido, 'listYkmanFidoCredentials');

      await expect(listFido2ResidentKeys(vi.fn().mockResolvedValue(''))).rejects.toThrow(/cancelled/);
      expect(listSpy).not.toHaveBeenCalled();
    });

    it('never touches ssh-add at all when ykman is available', async () => {
      vi.spyOn(YkmanFido, 'isYkmanAvailable').mockResolvedValue(true);
      vi.spyOn(YkmanFido, 'listYkmanFidoCredentials').mockResolvedValue([]);
      const loadSpy = vi.spyOn(SmartcardAgentLoader, 'loadFido2ResidentKeysIntoPrivateAgent');

      await listFido2ResidentKeys(() => '123456');

      expect(loadSpy).not.toHaveBeenCalled();
    });
  });

  describe('deleteFido2ResidentKey', () => {
    it('prompts for the PIN and deletes the credential via ykman', async () => {
      vi.spyOn(YkmanFido, 'isYkmanAvailable').mockResolvedValue(true);
      vi.spyOn(YkmanFido, 'listYkmanFidoCredentials').mockResolvedValue([
        { credentialId: 'abc123', rpId: 'ssh:id_ed25519_sk', userName: 'alun', userDisplayName: 'Alun' },
      ]);
      const deleteSpy = vi.spyOn(YkmanFido, 'deleteYkmanFidoCredential').mockResolvedValue();
      const promptHandler = vi.fn().mockResolvedValue('123456');

      await deleteFido2ResidentKey('abc123', promptHandler);

      expect(promptHandler).toHaveBeenCalledTimes(1);
      expect(deleteSpy).toHaveBeenCalledWith('abc123', '123456');
    });

    it('refuses to delete a web passkey, or an id that is not on the key, and a dismissed PIN prompt', async () => {
      vi.spyOn(YkmanFido, 'isYkmanAvailable').mockResolvedValue(true);
      vi.spyOn(YkmanFido, 'listYkmanFidoCredentials').mockResolvedValue([
        { credentialId: 'web1', rpId: 'github.com', userName: 'alun', userDisplayName: 'Alun' },
      ]);
      const deleteSpy = vi.spyOn(YkmanFido, 'deleteYkmanFidoCredential').mockResolvedValue();
      const pin = vi.fn().mockResolvedValue('123456');

      await expect(deleteFido2ResidentKey('web1', pin)).rejects.toThrow(/not an SSH key/);
      await expect(deleteFido2ResidentKey('missing', pin)).rejects.toThrow(/no longer on the security key/);
      await expect(deleteFido2ResidentKey('web1', vi.fn().mockResolvedValue(''))).rejects.toThrow(/cancelled/);
      expect(deleteSpy).not.toHaveBeenCalled();
    });

    it('refuses without ever prompting for a PIN when ykman is not installed', async () => {
      vi.spyOn(YkmanFido, 'isYkmanAvailable').mockResolvedValue(false);
      const promptHandler = vi.fn().mockResolvedValue('123456');

      await expect(deleteFido2ResidentKey('abc123', promptHandler)).rejects.toThrow(/ykman/i);
      expect(promptHandler).not.toHaveBeenCalled();
    });
  });
});
