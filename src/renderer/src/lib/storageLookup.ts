import type { FileEntry } from '@shared/types/storage';

/**
 * Looks up a path that may well not exist. Resolves to the entry, or to null when the path is missing;
 * any other failure (lost connection, timeout, permission) rejects, so it is never mistaken for a miss.
 *
 * A plain `storageStat` of a missing path rejects, and Electron prints every rejected IPC handler as an
 * error in the main process log, so `storageLookup` is used for ordinary misses.
 */
export async function lookupPath(providerId: string, path: string): Promise<FileEntry | null> {
  const api = window.multissh;
  if (api?.storageLookup) return api.storageLookup(providerId, path);
  if (api?.storageStat) return api.storageStat(providerId, path);
  throw new Error('Storage is not available');
}

/** Like `lookupPath`, but a failure of any kind resolves to null. */
export async function statIfExists(providerId: string, path: string): Promise<FileEntry | null> {
  try {
    return await lookupPath(providerId, path);
  } catch {
    return null;
  }
}

/**
 * `lookupPath`, but gives up after `ms` so a slow or stuck connection cannot hold the answer back
 * indefinitely: resolves to `'timeout'` then.
 */
export async function lookupPathWithin(
  providerId: string,
  path: string,
  ms: number
): Promise<FileEntry | null | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  try {
    return await Promise.race([lookupPath(providerId, path), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
