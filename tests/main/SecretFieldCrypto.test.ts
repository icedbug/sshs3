import { captureLogs } from './helpers/captureLogs';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockEncryptString, mockDecryptString, mockIsEncryptionAvailable } = vi.hoisted(() => {
  return {
    mockEncryptString: vi.fn((value: string) => Buffer.from(`cipher:${value}`, 'utf-8')),
    mockDecryptString: vi.fn((buf: Buffer) => buf.toString('utf-8').replace(/^cipher:/, '')),
    mockIsEncryptionAvailable: vi.fn().mockReturnValue(true),
  };
});

vi.mock('electron', () => {
  const mockObj = {
    safeStorage: {
      isEncryptionAvailable: mockIsEncryptionAvailable,
      encryptString: mockEncryptString,
      decryptString: mockDecryptString,
    },
  };
  return { ...mockObj, default: mockObj };
});

import {
  encryptSecretValue,
  decryptSecretValue,
  isEncryptionAvailable,
  isEncryptedSecret,
  transformSecretFields,
  transformEntrySecrets,
} from '../../src/main/crypto/SecretFieldCrypto';

describe('decryptSecretValue', () => {
  beforeEach(() => {
    mockIsEncryptionAvailable.mockReturnValue(true);
    mockEncryptString.mockClear();
    mockDecryptString.mockClear();
  });

  it('returns a never-encrypted (unprefixed) value unchanged', () => {
    expect(decryptSecretValue('plain-password')).toBe('plain-password');
    expect(decryptSecretValue('')).toBe('');
  });

  it('decrypts a value that was encrypted with the same keyring', () => {
    const encrypted = encryptSecretValue('super-secret');
    expect(encrypted).toContain('enc:v1:');
    expect(decryptSecretValue(encrypted)).toBe('super-secret');
  });

  // Regression tests for the H1 finding (code review): an encrypted value
  // that can't be decrypted here used to fall through and return the raw
  // ciphertext string as if it were the real secret — which a caller would
  // then use directly as an SSH/S3 password, silently failing auth with a
  // confusing error, or worse, re-save as "plaintext" and permanently lose
  // the original value. It must come back as '' instead, matching "no
  // credential saved", which callers already handle by re-prompting.

  it('returns "" instead of raw ciphertext when no OS keyring is available to decrypt', () => {
    const encrypted = encryptSecretValue('super-secret');
    mockIsEncryptionAvailable.mockReturnValue(false);

    const result = decryptSecretValue(encrypted);

    expect(result).toBe('');
    expect(result).not.toContain('enc:v1:');
  });

  it('returns "" instead of raw ciphertext when decryptString throws', () => {
    const encrypted = encryptSecretValue('super-secret');
    mockDecryptString.mockImplementationOnce(() => {
      throw new Error('decryption failed');
    });

    const result = decryptSecretValue(encrypted);

    expect(result).toBe('');
    expect(result).not.toContain('enc:v1:');
  });

  it('returns "" for a corrupted enc:v1: value that is not valid base64/ciphertext', () => {
    mockDecryptString.mockImplementationOnce(() => {
      throw new Error('bad ciphertext');
    });

    const result = decryptSecretValue('enc:v1:not-really-valid-ciphertext');

    expect(result).toBe('');
  });
});

// M2: encryptSecretValue must fall through to plaintext for both the
// expected "no OS keyring" case and an unexpected encryptString() failure,
// but only log a warning for the latter — the two used to be
// indistinguishable, which could hide a real bug behind the normal
// no-keyring fallback.
describe('encryptSecretValue (M2)', () => {
  beforeEach(() => {
    mockIsEncryptionAvailable.mockReturnValue(true);
    mockEncryptString.mockClear();
    mockDecryptString.mockClear();
  });

  it('stores as plaintext without warning when no OS keyring is available', () => {
    mockIsEncryptionAvailable.mockReturnValue(false);
    const warnSpy = captureLogs();

    const result = encryptSecretValue('super-secret');

    expect(result).toBe('super-secret');
    expect(warnSpy.lines).toHaveLength(0);
    warnSpy.restore();
  });

  it('falls through to plaintext AND warns when encryptString throws unexpectedly', () => {
    mockEncryptString.mockImplementationOnce(() => {
      throw new Error('keyring locked');
    });
    const warnSpy = captureLogs();

    const result = encryptSecretValue('super-secret');

    expect(result).toBe('super-secret');
    expect(warnSpy.lines).toHaveLength(1);
    warnSpy.restore();
  });
});

describe('isEncryptionAvailable', () => {
  beforeEach(() => {
    mockIsEncryptionAvailable.mockReset();
  });

  it('follows what the OS keyring reports', () => {
    mockIsEncryptionAvailable.mockReturnValue(true);
    expect(isEncryptionAvailable()).toBe(true);
    mockIsEncryptionAvailable.mockReturnValue(false);
    expect(isEncryptionAvailable()).toBe(false);
  });

  it('reports "not available" instead of throwing when the keyring probe itself fails', () => {
    mockIsEncryptionAvailable.mockImplementation(() => {
      throw new Error('keyring locked');
    });
    expect(isEncryptionAvailable()).toBe(false);
  });
});

describe('isEncryptedSecret', () => {
  it('is true only for a string that starts with the ciphertext prefix', () => {
    expect(isEncryptedSecret('enc:v1:abc')).toBe(true);
    expect(isEncryptedSecret('plain')).toBe(false);
    expect(isEncryptedSecret('')).toBe(false);
    expect(isEncryptedSecret(undefined)).toBe(false);
    expect(isEncryptedSecret(null)).toBe(false);
    expect(isEncryptedSecret(42)).toBe(false);
    expect(isEncryptedSecret({ startsWith: () => true })).toBe(false);
  });
});

describe('transformSecretFields', () => {
  const upper = (v: string) => v.toUpperCase();

  it('transforms the named string fields and returns a copy, leaving the input untouched', () => {
    const entry = { name: 'prod', first: 'a1', second: 'b2' };
    const result = transformSecretFields(entry, ['first', 'second'], upper);
    expect(result).toEqual({ name: 'prod', first: 'A1', second: 'B2' });
    expect(entry).toEqual({ name: 'prod', first: 'a1', second: 'b2' });
    expect(result).not.toBe(entry);
  });

  it('skips empty strings and values that are not strings, without calling the transform for them', () => {
    const transform = vi.fn(upper);
    const entry = { empty: '', zero: 0, flag: false, nothing: null, object: { a: 1 }, secret: 'x' } as Record<string, unknown>;
    const result = transformSecretFields(entry, ['empty', 'zero', 'flag', 'nothing', 'object', 'secret', 'missing'], transform);
    expect(result).toEqual({ empty: '', zero: 0, flag: false, nothing: null, object: { a: 1 }, secret: 'X' });
    expect(transform).toHaveBeenCalledTimes(1);
    expect(transform).toHaveBeenCalledWith('x');
    expect(result).not.toHaveProperty('missing');
  });
});

describe('transformEntrySecrets', () => {
  const upper = (v: string) => v.toUpperCase();

  it('also transforms proxy.password and keeps the rest of the proxy', () => {
    const value = 'pw';
    const proxy = { host: 'proxy.example.com', port: 8080, password: value };
    const entry = { token: 'abc', proxy };
    const result = transformEntrySecrets(entry, ['token'], upper);
    expect(result).toEqual({ token: 'ABC', proxy: { host: 'proxy.example.com', port: 8080, password: upper(value) } });
    expect(proxy.password).toBe(value); // the original proxy object is not modified
  });

  it('leaves an entry without a proxy, a proxy without a password and an empty proxy password alone', () => {
    const transform = vi.fn(upper);
    type Entry = { password?: string; proxy?: { host?: string; password?: unknown } };
    const plain: Entry = { password: 'a' };
    expect(transformEntrySecrets(plain, ['password'], transform)).toEqual({ password: 'A' });
    expect(transformEntrySecrets({ proxy: { host: 'h' } }, [], transform)).toEqual({ proxy: { host: 'h' } });
    expect(transformEntrySecrets({ proxy: { password: '' } }, [], transform)).toEqual({ proxy: { password: '' } });
    expect(transformEntrySecrets({ proxy: { password: 12345 } }, [], transform)).toEqual({ proxy: { password: 12345 } });
    expect(transform).toHaveBeenCalledTimes(1);
  });
});
