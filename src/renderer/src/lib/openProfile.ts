import type { SSHConnectionConfig } from '@shared/types/ssh';
import { formatDateTime } from './format';

/** A one-off, unsaved connection for a typed `user@host[:port]` (see parseAdHocTarget). */
export function buildAdHocConfig(target: { username: string; host: string; port?: number }): SSHConnectionConfig {
  return {
    id: crypto.randomUUID(),
    name: target.username ? `${target.username}@${target.host}` : target.host,
    host: target.host,
    port: target.port,
    username: target.username || '',
    authType: 'password',
  };
}

/**
 * Whether connecting to a profile should write its `lastUsedAt` back. `source` is the Connection
 * Manager's tab key: 'personal' or a Team Vault id. A Team Vault profile never gets the write: every
 * mutating save bumps the vault's revision, which every other member's background poll would then
 * pick up as a change, for what is really a per-viewer stat.
 */
export function shouldTouchLastUsed(source: string): boolean {
  return source === 'personal';
}

/**
 * The profile to connect with: for a personal one a copy with `lastUsedAt` set to now, saved through
 * `save` first (a failed save is ignored, connecting matters more); any other source is returned as is.
 */
export async function prepareConnect<T extends { lastUsedAt?: string }>(
  profile: T,
  source: string,
  save: (profile: T) => Promise<unknown>,
  now: Date = new Date()
): Promise<T> {
  if (!shouldTouchLastUsed(source)) return profile;
  const updated = { ...profile, lastUsedAt: formatDateTime(now) };
  try {
    await save(updated);
  } catch {
    // Safe to proceed even if touch fails
  }
  return updated;
}
