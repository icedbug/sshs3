import { describe, it, expect, beforeEach } from 'vitest';
import {
  SyncCryptoService,
  SyncDecryptionError,
  SyncLockedError,
  generateSalt,
  deriveKey,
  type ScryptParams,
} from '../../src/main/services/SyncCryptoService';

// Cheap scrypt params so the (deliberately slow) production defaults don't
// make the test suite slow. Security of the KDF cost itself is not what
// these tests are validating.
const FAST_PARAMS: ScryptParams = { N: 16, r: 1, p: 1, maxmem: 4 * 1024 * 1024 };

describe('SyncCryptoService', () => {
  let service: SyncCryptoService;

  beforeEach(() => {
    service = new SyncCryptoService(FAST_PARAMS);
  });

  it('round-trips plaintext through encrypt/decrypt for a category', () => {
    const salt = generateSalt();
    service.unlock('topology', 'correct horse battery staple', salt);

    const encrypted = service.encrypt('topology', '{"servers":["a","b"]}');
    const decrypted = service.decrypt('topology', encrypted);

    expect(decrypted).toBe('{"servers":["a","b"]}');
  });

  it('reuses the same embedded salt across multiple encryptions in a group, with fresh IVs', () => {
    const salt = generateSalt();
    service.unlock('topology', 'pw', salt);

    const a = service.encrypt('topology', 'first');
    const b = service.encrypt('topology', 'second');

    const saltA = a.subarray(1, 1 + 16);
    const saltB = b.subarray(1, 1 + 16);
    const ivA = a.subarray(1 + 16, 1 + 16 + 12);
    const ivB = b.subarray(1 + 16, 1 + 16 + 12);

    expect(saltA.equals(salt)).toBe(true);
    expect(saltB.equals(salt)).toBe(true);
    expect(ivA.equals(ivB)).toBe(false);
  });

  it('a single unlock() covers every category in that key group, without needing a password per category', () => {
    const topologySalt = generateSalt();
    service.unlock('topology', 'topology-pw', topologySalt);

    // 'topology' and 'settings' share the 'topology' key group (see
    // CATEGORY_TO_GROUP) — one unlock() call must suffice for both.
    const settings = service.encrypt('settings', 'settings-payload');
    expect(service.decrypt('settings', settings)).toBe('settings-payload');
    const topology = service.encrypt('topology', 'topology-payload');
    expect(service.decrypt('topology', topology)).toBe('topology-payload');

    // But the categories remain AAD-isolated from each other even though
    // they share a key: one category's ciphertext must not decrypt as another.
    expect(() => service.decrypt('topology', settings)).toThrow(SyncDecryptionError);
  });

  it('throws SyncLockedError when encrypting before unlock', () => {
    expect(() => service.encrypt('topology', 'x')).toThrow(SyncLockedError);
  });

  it('throws SyncLockedError when decrypting before unlock and no password is supplied', () => {
    const salt = generateSalt();
    const other = new SyncCryptoService(FAST_PARAMS);
    other.unlock('topology', 'pw', salt);
    const encrypted = other.encrypt('topology', 'x');

    expect(() => service.decrypt('topology', encrypted)).toThrow(SyncLockedError);
  });

  it('bootstraps on a fresh machine by deriving the key from the salt embedded in the downloaded file', () => {
    const salt = generateSalt();
    const remote = new SyncCryptoService(FAST_PARAMS);
    remote.unlock('credentials', 'shared-master-password', salt);
    const encrypted = remote.encrypt('credentials', 'bootstrap-payload');

    // Fresh instance, nothing unlocked yet — simulates a brand new machine.
    const fresh = new SyncCryptoService(FAST_PARAMS);
    const decrypted = fresh.decrypt('credentials', encrypted, 'shared-master-password');
    expect(decrypted).toBe('bootstrap-payload');

    // The derived key is now cached, so a subsequent call needs no password.
    const again = fresh.encrypt('credentials', 'second-payload');
    expect(fresh.decrypt('credentials', again)).toBe('second-payload');
  });

  it('throws SyncDecryptionError for a wrong password', () => {
    const salt = generateSalt();
    const remote = new SyncCryptoService(FAST_PARAMS);
    remote.unlock('credentials', 'right-password', salt);
    const encrypted = remote.encrypt('credentials', 'secret-data');

    const fresh = new SyncCryptoService(FAST_PARAMS);
    expect(() => fresh.decrypt('credentials', encrypted, 'wrong-password')).toThrow(SyncDecryptionError);
  });

  it('does not stay unlocked after a failed bootstrap decrypt with a wrong password', () => {
    const owner = new SyncCryptoService(FAST_PARAMS);
    owner.unlock('credentials', 'right-password', generateSalt());
    const encrypted = owner.encrypt('credentials', 'secret');

    const fresh = new SyncCryptoService(FAST_PARAMS);
    expect(() => fresh.decrypt('credentials', encrypted, 'wrong-password')).toThrow(SyncDecryptionError);
    expect(fresh.isUnlocked('credentials')).toBe(false);

    expect(fresh.decrypt('credentials', encrypted, 'right-password')).toBe('secret');
    expect(fresh.isUnlocked('credentials')).toBe(true);
  });

  it('throws SyncDecryptionError for a truncated/corrupt file', () => {
    const salt = generateSalt();
    service.unlock('topology', 'pw', salt);
    const encrypted = service.encrypt('topology', 'data');

    expect(() => service.decrypt('topology', encrypted.subarray(0, 10))).toThrow(SyncDecryptionError);
    expect(() => service.decrypt('topology', encrypted.subarray(0, encrypted.length - 5))).toThrow(
      SyncDecryptionError
    );
  });

  it('throws SyncDecryptionError for an unsupported format version byte', () => {
    const salt = generateSalt();
    service.unlock('topology', 'pw', salt);
    const encrypted = service.encrypt('topology', 'data');
    const tampered = Buffer.from(encrypted);
    tampered[0] = 99;

    expect(() => service.decrypt('topology', tampered)).toThrow(SyncDecryptionError);
  });

  it('binds the category as AAD: data encrypted as one category cannot be decrypted as another, even with the right key', () => {
    const salt = generateSalt();
    service.unlock('credentials', 'pw', salt);

    // Both 'credentials' and 'dotfile-pools' share the credentials key group,
    // so the key is identical — only the AAD (category name) differs.
    const encryptedAsCredentials = service.encrypt('credentials', 'payload');

    expect(() => service.decrypt('dotfile-pools', encryptedAsCredentials)).toThrow(SyncDecryptionError);
  });

  it('deriveKey is deterministic for the same password/salt/params and differs for different salts', () => {
    const salt1 = generateSalt();
    const salt2 = generateSalt();
    const keyA = deriveKey('same-password', salt1, FAST_PARAMS);
    const keyB = deriveKey('same-password', salt1, FAST_PARAMS);
    const keyC = deriveKey('same-password', salt2, FAST_PARAMS);

    expect(keyA.equals(keyB)).toBe(true);
    expect(keyA.equals(keyC)).toBe(false);
  });

  describe('the header check on downloaded blobs', () => {
    // 1 version byte + 16 salt + 12 IV + 16 auth tag: the shortest blob that has a complete header.
    const HEADER_BYTES = 45;
    const TRUNCATED = 'Encrypted file is truncated or corrupt';

    it('names a truncated blob as truncated, one byte short of a complete header', () => {
      service.unlock('topology', 'pw', generateSalt());
      const blob = Buffer.alloc(HEADER_BYTES - 1);
      blob[0] = 1;
      expect(() => service.decrypt('topology', blob)).toThrow(TRUNCATED);
    });

    it('does not call a blob with a complete header truncated: it fails the authentication check instead', () => {
      service.unlock('topology', 'pw', generateSalt());
      const blob = Buffer.alloc(HEADER_BYTES);
      blob[0] = 1;
      expect(() => service.decrypt('topology', blob)).toThrow(SyncDecryptionError);
      expect(() => service.decrypt('topology', blob)).not.toThrow(TRUNCATED);
    });

    it('round-trips an empty plaintext, which is a header-only blob', () => {
      service.unlock('topology', 'pw', generateSalt());
      const blob = service.encrypt('topology', '');
      expect(blob.length).toBe(HEADER_BYTES);
      expect(service.decrypt('topology', blob)).toBe('');
    });

    it('treats a value that is not a Buffer as a corrupt file', () => {
      service.unlock('topology', 'pw', generateSalt());
      const notABuffer = 'x'.repeat(100) as unknown as Buffer;
      expect(() => service.decrypt('topology', notABuffer)).toThrow(TRUNCATED);
    });
  });

  // Low finding (code review 2026-11-03): scryptSync with N=2^17 blocks the main process for 1-4 s on every unlock.
  describe('asynchronous key derivation', () => {
    it('unlockAsync derives the same key as unlock', async () => {
      const salt = generateSalt();
      const sync = new SyncCryptoService(FAST_PARAMS);
      sync.unlock('topology', 'pw', salt);
      const encrypted = sync.encrypt('topology', 'secret payload');

      await service.unlockAsync('topology', 'pw', salt);

      expect(service.isUnlocked('topology')).toBe(true);
      expect(service.getSalt('topology')?.equals(salt)).toBe(true);
      expect(service.decrypt('topology', encrypted)).toBe('secret payload');
    });

    it('decryptAsync derives the key from the password and the blob salt, and caches it only after the tag verifies', async () => {
      const salt = generateSalt();
      const writer = new SyncCryptoService(FAST_PARAMS);
      writer.unlock('credentials', 'right', salt);
      const blob = writer.encrypt('credentials', '{"a":1}');

      await expect(service.decryptAsync('credentials', blob, 'wrong')).rejects.toBeInstanceOf(SyncDecryptionError);
      expect(service.isUnlocked('credentials')).toBe(false);

      expect(await service.decryptAsync('credentials', blob, 'right')).toBe('{"a":1}');
      expect(service.isUnlocked('credentials')).toBe(true);
      expect(service.decrypt('credentials', blob)).toBe('{"a":1}'); // cached for the next file
    });

    it('decryptAsync without a password on a locked group throws like decrypt', async () => {
      const writer = new SyncCryptoService(FAST_PARAMS);
      writer.unlock('topology', 'pw', generateSalt());
      await expect(service.decryptAsync('topology', writer.encrypt('topology', 'x'))).rejects.toBeInstanceOf(SyncLockedError);
    });

    it('does not block the event loop while it derives the key', async () => {
      const heavy = new SyncCryptoService({ N: 1 << 16, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
      let ticks = 0;
      const timer = setInterval(() => ticks++, 5);
      try {
        await heavy.unlockAsync('topology', 'pw', generateSalt());
      } finally {
        clearInterval(timer);
      }
      // A synchronous derivation of this size would leave the timer without a single turn.
      expect(ticks).toBeGreaterThanOrEqual(2);
    });
  });
});
