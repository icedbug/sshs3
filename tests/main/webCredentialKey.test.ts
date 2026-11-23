import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', async () => await import('../../src/main/web/electronShim'));

import { safeStorage, setHeadlessUserDataPath } from '../../src/main/web/electronShim';
import { decryptSecretValue, encryptSecretValue } from '../../src/main/crypto/SecretFieldCrypto';

/** What an earlier version wrote for a passphrase: AES-256-GCM under one SHA-256 of it, no mark. */
function sealedByEarlierVersion(passphrase: string, text: string): Buffer {
  const key = crypto.createHash('sha256').update(passphrase.trim(), 'utf8').digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}

/**
 * C3: the key for saved credentials was one SHA-256 of the SSHS3_MASTER_KEY passphrase, with no salt.
 */
describe('web server: the credential key made from SSHS3_MASTER_KEY', () => {
  let dir: string;
  const before = process.env.SSHS3_MASTER_KEY;
  const PASSPHRASE = 'a passphrase from the environment'; // pragma: allowlist secret

  /** As after a restart: the key the process remembered is forgotten. */
  const restart = (dataDir = dir): void => setHeadlessUserDataPath(dataDir);

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'credential-key-'));
    process.env.SSHS3_MASTER_KEY = PASSPHRASE;
    restart();
  });

  afterEach(async () => {
    if (before === undefined) delete process.env.SSHS3_MASTER_KEY;
    else process.env.SSHS3_MASTER_KEY = before;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('a new install: scrypt with a salt of its own, kept beside the data', async () => {
    const sealed = safeStorage.encryptString('a-saved-password');
    expect(sealed.subarray(0, 4).toString()).toBe('S3K2');
    const salt = (await fs.readFile(path.join(dir, 'server-master.salt'), 'utf8')).trim();
    expect(salt).toMatch(/^[a-f0-9]{32}$/);
    if (process.platform !== 'win32') expect((await fs.stat(path.join(dir, 'server-master.salt'))).mode & 0o077).toBe(0);
    // No key file is made: the passphrase is the key.
    await expect(fs.stat(path.join(dir, 'server-master.key'))).rejects.toThrow();

    restart();
    expect(safeStorage.decryptString(sealed)).toBe('a-saved-password');
    expect((await fs.readFile(path.join(dir, 'server-master.salt'), 'utf8')).trim()).toBe(salt);

    // The key is what scrypt makes of the passphrase and that salt, and not the single hash it used to be.
    const scryptKey = crypto.scryptSync(PASSPHRASE, Buffer.from(salt, 'hex'), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const open = (key: Buffer): string => {
      const body = sealed.subarray(4);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, body.subarray(0, 12));
      decipher.setAuthTag(body.subarray(12, 28));
      return Buffer.concat([decipher.update(body.subarray(28)), decipher.final()]).toString('utf8');
    };
    expect(open(scryptKey)).toBe('a-saved-password');
    expect(() => open(crypto.createHash('sha256').update(PASSPHRASE, 'utf8').digest())).toThrow();

    // The same passphrase on another server is another key.
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'credential-key-other-'));
    try {
      restart(other);
      expect(() => safeStorage.decryptString(sealed)).toThrow();
    } finally {
      await fs.rm(other, { recursive: true, force: true });
    }
    // A wrong passphrase opens nothing.
    process.env.SSHS3_MASTER_KEY = 'another passphrase'; // pragma: allowlist secret
    restart();
    expect(() => safeStorage.decryptString(sealed)).toThrow();
  });

  it('an install from before: what it sealed still opens, and is sealed the new way when saved again', () => {
    const old = sealedByEarlierVersion(PASSPHRASE, 'saved-by-the-earlier-version');
    expect(safeStorage.decryptString(old)).toBe('saved-by-the-earlier-version');
    // Through the code the profile stores use, in the form they keep on disk.
    const stored = `enc:v1:${old.toString('base64')}`;
    expect(decryptSecretValue(stored)).toBe('saved-by-the-earlier-version');
    const saved = encryptSecretValue(decryptSecretValue(stored));
    expect(Buffer.from(saved.slice('enc:v1:'.length), 'base64').subarray(0, 4).toString()).toBe('S3K2');
    restart();
    expect(decryptSecretValue(saved)).toBe('saved-by-the-earlier-version');
    expect(decryptSecretValue(stored)).toBe('saved-by-the-earlier-version');
    // With another passphrase the old data stays closed.
    process.env.SSHS3_MASTER_KEY = 'another passphrase'; // pragma: allowlist secret
    restart();
    expect(() => safeStorage.decryptString(old)).toThrow();
  });

  it('an install that only now gets a passphrase: what the key file sealed still opens', async () => {
    delete process.env.SSHS3_MASTER_KEY;
    restart();
    const sealed = encryptSecretValue('saved-under-the-key-file');
    await expect(fs.stat(path.join(dir, 'server-master.key'))).resolves.toBeTruthy();
    process.env.SSHS3_MASTER_KEY = PASSPHRASE;
    restart();
    expect(decryptSecretValue(sealed)).toBe('saved-under-the-key-file');
  });

  it('without a passphrase nothing changes: the key file, and no mark', async () => {
    delete process.env.SSHS3_MASTER_KEY;
    restart();
    const sealed = safeStorage.encryptString('plain');
    expect(sealed.length).toBe(12 + 16 + 'plain'.length);
    expect(safeStorage.decryptString(sealed)).toBe('plain');
    await expect(fs.stat(path.join(dir, 'server-master.salt'))).rejects.toThrow();
  });
});
