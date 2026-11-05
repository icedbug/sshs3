import type { StorageConnectConfig } from '../../shared/types/ipc';

interface TargetLocation {
  target?: StorageConnectConfig;
  remoteBasePath?: string;
}

/**
 * Fields that only say HOW to log in or label the entry, never WHERE the data is. Everything else in a target's
 * config counts as part of its location, so a field nobody thought of (a new routing option, a proxy, a jump host)
 * makes the target "changed", which is the safe default: the cost of a false alarm is one extra unlock, the cost of
 * a miss is writing to another device's data with the old key.
 */
const SFTP_LOGIN_ONLY_FIELDS = new Set([
  'id', 'name', 'authType', 'password', 'passphrase', 'privateKeyPath', 'agentPath', 'useSshCa', 'certificateFile',
  'agentIdentityFiles', 'pkcs11LibPath', 'pin', 'fido2Resident', 'teamVaultProfileRef', 'group', 'lastUsedAt',
]);
const S3_LOGIN_ONLY_FIELDS = new Set([
  'id', 'name', 'authMode', 'accessKeyId', 'secretAccessKey', 'hasSecretAccessKey', 'sessionToken',
  'teamVaultProfileRef', 'group', 'tags', 'lastUsedAt', 'updatedAt', 'deletedAt',
]);
/** Inside a proxy only the route matters, not how the proxy is logged into. */
const PROXY_LOGIN_ONLY_FIELDS = new Set(['username', 'password', 'hasPassword']);

/** Drops trailing slashes but keeps a lone "/": on SFTP the root is not the same place as the empty path (home). */
function normalizePath(value: string | undefined): string {
  const trimmed = (value ?? '').trim();
  return /^\/+$/.test(trimmed) ? '/' : trimmed.replace(/\/+$/, '');
}

/** Stable form of a config value: sorted keys, and unset, empty and false values removed. */
function canonical(value: unknown, skip: Set<string> = new Set()): unknown {
  if (Array.isArray(value)) return value.map((item) => canonical(item));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (skip.has(key) || item === undefined || item === null || item === '' || item === false) continue;
      out[key] = key === 'proxy' ? canonical(item, PROXY_LOGIN_ONLY_FIELDS) : canonical(item);
    }
    return out;
  }
  return value;
}

/** The connection part of a target (everything but the base path): what a cached provider was created from. */
export function syncTargetConnectionKey(target: StorageConnectConfig): string {
  if (target.type === 'sftp') {
    const c = target.sftpConfig;
    const config = canonical(
      { ...c, host: (c?.host ?? '').trim().toLowerCase(), port: c?.port ?? 22 },
      SFTP_LOGIN_ONLY_FIELDS
    );
    return JSON.stringify(['sftp', config]);
  }
  if (target.type === 's3') {
    const c = target.s3Config;
    const config = canonical(
      { ...c, endpoint: normalizePath(c?.endpoint).toLowerCase(), region: (c?.region ?? '').trim() },
      S3_LOGIN_ONLY_FIELDS
    );
    return JSON.stringify(['s3', config]);
  }
  return JSON.stringify([target.type, target.id]);
}

function locationKey({ target, remoteBasePath }: TargetLocation): string | null {
  if (!target) return null;
  return JSON.stringify([syncTargetConnectionKey(target), normalizePath(remoteBasePath)]);
}

/**
 * True when `next` may point at different storage than the previously configured target. A first setup (nothing
 * configured before) is not a change. Used to drop the cached sync key and salts, which belong to the data on
 * the old target and must never be used to write to a new one. The target `id` is not part of the comparison:
 * the renderer gives every sync target the same id.
 */
export function isSyncTargetChanged(previous: TargetLocation, next: TargetLocation): boolean {
  const before = locationKey(previous);
  if (before === null) return false;
  return before !== locationKey(next);
}
