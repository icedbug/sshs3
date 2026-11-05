import { ELECTRON_IPC_PREFIX } from './format';

/**
 * Turns a raw sync error (as it arrives in the renderer — Electron's
 * ipcRenderer.invoke wraps whatever the main process threw into a single
 * string like `Error invoking remote method 'profile-sync:push':
 * SyncConflictError: Remote "topology" file changed...`) into a short,
 * user-facing message with no IPC/class-name plumbing showing through.
 *
 * The underlying error messages thrown by ProfileSyncService/SyncCryptoService
 * are already specific (wrong password vs. conflict vs. locked); this mostly
 * strips noise, but also recognizes a handful of common low-level connection
 * errors (ECONNREFUSED, DNS failures, auth failures, timeouts) that would
 * otherwise surface as cryptic ssh2/AWS SDK text.
 */

export type SyncErrorKind = 'wrong-password' | 'conflict' | 'in-progress' | 'locked' | 'smartcard' | 'network' | 'unknown';

export interface FormattedSyncError {
  kind: SyncErrorKind;
  message: string;
}

const NAMED_ERROR_RE = /^(SyncDecryptionError|SyncConflictError|SyncInProgressError|SyncLockedError):\s*/;

export function formatSyncError(err: unknown, fallback = 'Something went wrong.'): FormattedSyncError {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : fallback;
  let message = raw.replace(ELECTRON_IPC_PREFIX, '').trim();

  const nameMatch = message.match(NAMED_ERROR_RE);
  const name = nameMatch?.[1];
  message = message.replace(NAMED_ERROR_RE, '').trim();

  if (name === 'SyncDecryptionError') {
    return { kind: 'wrong-password', message: message || 'Wrong master password, or the sync file is corrupted.' };
  }
  if (!message) {
    return { kind: 'unknown', message: fallback };
  }
  if (name === 'SyncConflictError') {
    return { kind: 'conflict', message };
  }
  if (name === 'SyncInProgressError') {
    return { kind: 'in-progress', message };
  }
  if (name === 'SyncLockedError') {
    return { kind: 'locked', message };
  }
  if (/verify cryptographic signature|smartcard|PKCS#11|PIV card|card PIN/i.test(message)) {
    return { kind: 'smartcard', message };
  }
  if (/ECONNREFUSED/.test(message)) {
    return { kind: 'network', message: 'Could not connect to the sync server — check the host, port, and that it is reachable.' };
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(message)) {
    return { kind: 'network', message: 'Could not resolve the sync server\'s address — check the hostname.' };
  }
  if (/ETIMEDOUT|timed out/i.test(message)) {
    return { kind: 'network', message: 'Connection to the sync server timed out.' };
  }
  if (/all configured authentication methods failed|authentication failed/i.test(message)) {
    return {
      kind: 'network',
      message: 'Could not authenticate to the sync server — check its username/password/key under "Change target".',
    };
  }

  return { kind: 'unknown', message: message || 'Something went wrong.' };
}
