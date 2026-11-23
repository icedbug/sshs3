import { safeStorage } from 'electron';
import { createLogger } from '../log';
const cryptoLog = createLogger('crypto');

/**
 * Shared helpers for at-rest encryption of individual secret fields (e.g. a
 * saved SSH password) via Electron's OS-backed safeStorage (libsecret/
 * Keychain/DPAPI). Used by any local JSON store that persists credentials —
 * ProfileStore and SyncConfigStore — so the encryption behavior (including
 * the plaintext fallback when no OS keyring is available) stays consistent
 * and isn't duplicated.
 */

const ENC_PREFIX = 'enc:v1:';

/**
 * Returns false outside a running Electron app (e.g. under test) or when no
 * OS keyring backend exists, in which case secrets are persisted in
 * plaintext as a graceful fallback.
 */
export function isEncryptionAvailable(): boolean {
  try {
    return typeof safeStorage?.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/** True for a value stored as safeStorage ciphertext (as opposed to plaintext). */
export function isEncryptedSecret(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

/** The web server must never persist a credential without its private master key. */
function requireEncryptedPersistence(): void {
  if ((safeStorage as typeof safeStorage & { requiresEncryptedPersistence?: boolean })?.requiresEncryptedPersistence) {
    throw new Error('Cannot save this credential securely. Check the server credential key and its permissions.');
  }
}

export function encryptSecretValue(value: string): string {
  if (!value) return value;
  if (!isEncryptionAvailable()) {
    requireEncryptedPersistence();
    // Expected, normal fallback: no OS keyring backend on this machine.
    return value;
  }
  try {
    return ENC_PREFIX + safeStorage.encryptString(value).toString('base64');
  } catch (err) {
    requireEncryptedPersistence();
    // Unexpected: the keyring reported itself available but encryption
    // still threw. Log it so this doesn't look identical to the normal
    // no-keyring fallback above — falling through to plaintext rather than
    // losing the value, but a real bug here should be visible.
    cryptoLog.warn('Encrypting a secret field failed unexpectedly; storing it as plaintext instead:', err);
    return value;
  }
}

export function decryptSecretValue(value: string): string {
  if (typeof value !== 'string' || !value.startsWith(ENC_PREFIX)) {
    // Never encrypted in the first place — this is the real plaintext value.
    return value;
  }
  // Encrypted but not decryptable here — either no OS keyring backend is
  // available, or decryption failed (e.g. the value was moved to another
  // machine/user without the original OS keyring entry). Returning the
  // still-encrypted ciphertext here would let it be silently used as-is:
  // sent as an SSH/S3 password, displayed in an editable field, or re-saved
  // as if it were plaintext (which would permanently destroy it, since it
  // can no longer be decrypted back to the original secret). An empty
  // string makes this behave exactly like "no credential saved", which
  // every caller already handles by prompting the user to (re-)enter it.
  if (isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(value.slice(ENC_PREFIX.length), 'base64'));
    } catch (err) {
      cryptoLog.warn('Failed to decrypt a stored secret field; treating it as unavailable:', err);
      return '';
    }
  }
  cryptoLog.warn('Stored secret field is encrypted but no OS keyring is available to decrypt it; treating as unavailable.');
  return '';
}

/**
 * A stored secret field, read for use. One that is encrypted and cannot be
 * decrypted on this start comes back empty, as from decryptSecretValue, and
 * with `kept`: the ciphertext as it was stored. A store that saves the empty
 * value back destroys the secret for good, after one start with the keyring
 * locked or missing. It has to write `kept` back instead (sealSecretValue),
 * until the secret is read on a later start or a person enters a new one.
 */
export function openSecretValue(stored: string): { value: string; kept?: string } {
  const value = decryptSecretValue(stored);
  return value === '' && isEncryptedSecret(stored) ? { value, kept: stored } : { value };
}

/** What a store writes for a secret field: the value encrypted, or, while there is none, the ciphertext that could not be read. */
export function sealSecretValue(value: string | undefined, kept?: string): string {
  return value ? encryptSecretValue(value) : (kept ?? '');
}

/** What a status says about a secret that could not be read on this start. `what` begins the sentence: "The bot's token". */
export function unreadSecretNote(what: string): string {
  return `${what} could not be read on this start: the keyring that protects it was not available, or it was saved on another computer. It is kept as it was stored. Start sshs3 again with the keyring unlocked, or enter it again.`;
}

export function transformSecretFields<T extends object>(
  entry: T,
  fields: Array<keyof T>,
  transform: (value: string) => string
): T {
  const result: T = { ...entry };
  for (const field of fields) {
    const value = result[field];
    if (typeof value === 'string' && value) {
      result[field] = transform(value) as T[keyof T];
    }
  }
  return result;
}

/** Same as transformSecretFields, but also transforms `proxy.password` when present. */
export function transformEntrySecrets<T extends { proxy?: any }>(
  entry: T,
  fields: Array<keyof T>,
  transform: (value: string) => string
): T {
  const result = transformSecretFields(entry, fields, transform);
  if (result.proxy && typeof result.proxy.password === 'string' && result.proxy.password) {
    result.proxy = {
      ...result.proxy,
      password: transform(result.proxy.password),
    };
  }
  return result;
}
