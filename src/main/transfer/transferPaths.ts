import fsp from 'node:fs/promises';
import path from 'node:path';
import type { StorageType } from '../../shared/types/storage';

export const SAME_FILE_ERROR = 'Source and target are the same file';

/**
 * Canonical form used only to compare two paths on one provider: native rules for local paths
 * (case-insensitive on Windows), posix rules with no trailing slash for SFTP, S3 and K8s.
 */
export function comparablePath(providerType: StorageType, p: string): string {
  if (providerType === 'local') {
    const resolved = path.resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }
  const normalized = path.posix.normalize(p.replace(/\\/g, '/'));
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

/**
 * True when copying `sourcePath` to `targetPath` on the same provider would write a file onto itself
 * (the target is opened and truncated while the source is still being read). The caller must already
 * know both paths belong to one provider.
 */
export function isSamePathOnProvider(providerType: StorageType, sourcePath: string, targetPath: string): boolean {
  return comparablePath(providerType, sourcePath) === comparablePath(providerType, targetPath);
}

/** The resolver `isSameFileOnProvider` needs for a provider: its own `resolvePath` when it has one (a base-path sandbox), else identity. */
export function resolverFor(provider: unknown): (p: string) => string {
  const resolvePath = (provider as { resolvePath?: (p: string) => string } | null | undefined)?.resolvePath;
  return typeof resolvePath === 'function' ? (p) => resolvePath.call(provider, p) : (p) => p;
}

/**
 * Like `isSamePathOnProvider`, but for local files it also compares device and inode when the spelling differs. That
 * catches a differently-cased name on a case-insensitive filesystem (default on macOS), a symlink and a hard link to
 * the source, none of which a string comparison can see. A target that does not exist yet is never the same file.
 */
export async function isSameFileOnProvider(
  providerType: StorageType,
  sourcePath: string,
  targetPath: string,
  /** Maps a provider path to the real path (a `LocalStorageProvider` with a base path resolves relative paths against it). */
  resolve: (p: string) => string = (p) => p
): Promise<boolean> {
  if (isSamePathOnProvider(providerType, sourcePath, targetPath)) return true;
  if (providerType !== 'local') return false;
  try {
    const [a, b] = await Promise.all([fsp.stat(resolve(sourcePath), { bigint: true }), fsp.stat(resolve(targetPath), { bigint: true })]);
    // Device and inode are authoritative: a hard link or symlink shares them whatever the file's size or mtime do meanwhile (a
    // growing log file would differ between the two stats). On a filesystem that reports no real inodes (0) the check stays off.
    return a.ino !== 0n && a.ino === b.ino && a.dev === b.dev;
  } catch {
    return false;
  }
}
