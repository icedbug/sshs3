export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  const formatted = exponent === 0 ? String(value) : value.toFixed(value < 10 ? 2 : 1);
  return `${formatted} ${units[exponent]}`;
}

export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function joinPath(base: string, name: string): string {
  if (!base || base === '/' || base === '') return `/${name}`;
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  return base.endsWith(sep) ? `${base}${name}` : `${base}${sep}${name}`;
}

export function parentPath(currentPath: string): string {
  if (!currentPath || currentPath === '/') return '/';
  const sep = currentPath.includes('\\') && !currentPath.includes('/') ? '\\' : '/';
  const trimmed = currentPath.endsWith(sep) ? currentPath.slice(0, -1) : currentPath;
  // A Windows drive root ("C:\") is its own parent; "C:" alone would mean the drive's current directory.
  if (/^[a-zA-Z]:$/.test(trimmed)) return `${trimmed}\\`;
  const idx = trimmed.lastIndexOf(sep);
  if (idx <= 0) return sep;
  const parent = trimmed.slice(0, idx);
  return /^[a-zA-Z]:$/.test(parent) ? `${parent}\\` : parent;
}

export function pathSegments(currentPath: string): { label: string; path: string }[] {
  if (!currentPath) return [{ label: '/', path: '/' }];
  const sep = currentPath.includes('\\') && !currentPath.includes('/') ? '\\' : '/';
  const parts = currentPath.split(sep).filter(Boolean);
  const isWindows = sep === '\\';
  const segments: { label: string; path: string }[] = [];

  if (isWindows && parts.length > 0 && /^[a-zA-Z]:$/.test(parts[0])) {
    segments.push({ label: parts[0], path: `${parts[0]}\\` });
    for (let i = 1; i < parts.length; i++) {
      segments.push({ label: parts[i], path: parts.slice(0, i + 1).join(sep) });
    }
    return segments;
  }

  segments.push({ label: '/', path: '/' });
  for (let i = 0; i < parts.length; i++) {
    segments.push({ label: parts[i], path: `/${parts.slice(0, i + 1).join('/')}` });
  }
  return segments;
}

export function classNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

// Re-exported rather than duplicated (LOW finding, code review): this file,
// dateFormat.ts, and a third ad-hoc copy in SyncSettingsPanel.tsx each had
// their own formatDateTime with different edge-case behavior (no null
// guard here vs. a "—" guard there). dateFormat.ts's version is the one
// canonical implementation now; SyncSettingsPanel.tsx wraps it locally for
// its own "Never" fallback instead of reimplementing the formatting itself.
export { formatDateTime } from './dateFormat';

// Electron wraps every main-process throw with this prefix, which leaks the
// internal IPC channel name (e.g. "fs:readFile") into user-facing error text.
export const ELECTRON_IPC_PREFIX = /^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/;

/**
 * Renders a caught error for display to the user, stripping Electron's
 * internal IPC error prefix so implementation details (IPC channel names)
 * never leak into the UI (UX review #12). Falls back to `fallback` when the
 * error has no usable message.
 */
export function describeIpcError(err: unknown, fallback: string): string {
  if (!(err instanceof Error) || !err.message) return fallback;
  return err.message.replace(ELECTRON_IPC_PREFIX, '') || fallback;
}
