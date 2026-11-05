import { getBaseName, joinPaths } from '../transfer/TransferPipeline';
import type { StorageType } from '../../shared/types/storage';
import type { K8sProfile, K8sWebLoginOptions } from '../../shared/types/kubernetes';

/** True when any leaf pane of a saved session's pane tree uses the given auth type. */
export function paneTreeHasAuthType(node: unknown, authType: string): boolean {
  if (!node || typeof node !== 'object') return false;
  const n = node as Record<string, any>;
  if (n.type === 'leaf') {
    return n.config?.authType === authType;
  }
  if (Array.isArray(n.children)) {
    return n.children.some((child) => paneTreeHasAuthType(child, authType));
  }
  return false;
}

/**
 * True when any saved tab of the session, in the main window or in a secondary one, has a pane using the given
 * auth type. A secondary window's tabs are restored and connect at startup just like the main window's.
 */
export function sessionUsesAuthType(
  session: { tabs?: Array<{ paneTree?: unknown }>; windows?: Array<{ tabs?: Array<{ paneTree?: unknown }> }> } | null | undefined,
  authType: string
): boolean {
  const tabs = [...(session?.tabs ?? []), ...(session?.windows ?? []).flatMap((w) => w.tabs ?? [])];
  return tabs.some((tab) => paneTreeHasAuthType(tab.paneTree, authType));
}

/**
 * `ssh-add -K` (load FIDO2 *resident/discoverable* credentials) reports "Provider \"internal\"
 * returned failure -1" / "Unable to load resident keys: invalid format" whenever the
 * authenticator's own CTAP2 stack returns FIDO_ERR_PIN_AUTH_BLOCKED — verified directly with
 * `ssh-add -v -K`, which prints that exact libfido2 error code for this failure. That's a
 * device-side safety lockout (CTAP2 blocks further PIN verification until the key is unplugged
 * and reconnected, after a few failed/rapid PIN submissions in the current power cycle) — it is
 * NOT the persistent PIN-retry counter (`ykman fido info` still showed all attempts remaining
 * while this reproduced), so it is unrelated to whether the PIN typed was actually correct, and
 * unplugging/reconnecting the key is the only way to clear it — retrying in-app cannot help.
 */
export function describeFido2StartupError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/provider "internal" returned failure -1/i.test(message) && /invalid format/i.test(message)) {
    if (process.platform === 'win32') {
      // The Linux-verified PIN_AUTH_BLOCKED cause above was not confirmed on Windows: the same
      // message persisted after unplugging/reconnecting and entering the PIN once. Windows also
      // blocks direct HID access to FIDO devices for non-elevated processes, which the built-in
      // provider needs to enumerate resident keys — so don't claim a cause we haven't proven.
      return 'Windows could not read the resident keys from the security key (ssh-add -K failed with "Provider internal returned failure -1"). If you already unplugged and reconnected the key and entered the PIN once, this is likely because reading resident credentials needs direct access to the device, which Windows only allows for an elevated (Administrator) process. Resident-key login may need sshs3 started as Administrator, or a key file instead.';
    }
    return 'This security key has temporarily blocked PIN verification (likely after a few failed or rapid attempts) and needs to be unplugged and reconnected before it will accept a PIN again. This is not a wrong PIN.';
  }
  return message;
}

/**
 * The target field always names an existing parent directory (so it stays
 * browsable even when the eventual sync root doesn't exist yet); the
 * source folder's own name is nested under it, mirroring how drag/drop
 * copy (TRANSFER_ADD, above) and most file managers behave.
 */
export function resolveDirSyncTargetRoot(
  sourcePath: string,
  targetProviderType: StorageType,
  targetParentPath: string
): string {
  const sourceBaseName = getBaseName(sourcePath);
  if (!sourceBaseName) {
    return targetParentPath;
  }
  return joinPaths(targetProviderType, targetParentPath, sourceBaseName);
}

/**
 * True when a storage provider's error means "that path does not exist" (as opposed to a lost
 * connection, a permission problem or a timeout). Codes and status fields only, plus the exact
 * "not found" messages the S3 and pod providers throw, so a connection failure is never read as a miss.
 */
export function isMissingPathError(err: unknown): boolean {
  const e = err as { code?: unknown; statusCode?: unknown; name?: unknown; message?: unknown } | null;
  if (!e || typeof e !== 'object') return false;
  if (e.code === 'ENOENT' || e.code === 'ENOTDIR' || e.code === 'NoSuchKey' || e.code === 'NotFound') return true;
  if (e.name === 'NotFound' || e.name === 'NoSuchKey') return true;
  // SFTP status 2 (SSH_FX_NO_SUCH_FILE).
  if (e.name === 'SftpError' && e.statusCode === 2) return true;
  return typeof e.message === 'string' && /^(?:Path|File or directory|Directory) not found\b/.test(e.message);
}

const MAX_SERVER_URL_LENGTH = 2048;
const MAX_NAMESPACE_LENGTH = 253;

/** Validates the cluster API URL that the renderer sends for the OpenShift browser sign-in. */
export function parseK8sServerArg(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Server URL is required');
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_SERVER_URL_LENGTH) {
    throw new Error('Server URL is too long');
  }
  if (trimmed.includes('\\')) {
    throw new Error('Invalid server URL');
  }
  const hasScheme = /^https?:\/\//i.test(trimmed);
  // Any other "scheme:" prefix (e.g. "http:/host") would be parsed differently here than by a consumer; "host:port" is fine.
  if (!hasScheme && /^[a-z][a-z0-9+.-]*:(?!\d+(?:[/?#]|$))/i.test(trimmed)) {
    throw new Error('Invalid server URL');
  }
  const candidate = hasScheme ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error('Invalid server URL');
  }
  if (!url.hostname) {
    throw new Error('Invalid server URL');
  }
  // A saved, synced or shared server must never carry a secret, and a token must not travel unencrypted.
  if (url.username || url.password) {
    throw new Error('Server URL must not contain a user name or password');
  }
  if (url.search || url.hash) {
    throw new Error('Server URL must not contain a query or fragment');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))) {
    throw new Error('Server URL must use https (plain http is only allowed for localhost)');
  }
  // Return what was validated, so every consumer sees the same URL as this check did.
  return hasScheme ? url.toString().replace(/\/+$/, '') : trimmed;
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const octets = hostname.split('.');
  return octets.length === 4 && octets[0] === '127' && octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255);
}

/** Validates untrusted IPC arguments for the OpenShift browser sign-in. */
export function parseWebLoginOptions(raw: unknown): K8sWebLoginOptions {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid sign-in options');
  }
  const input = raw as Record<string, unknown>;
  const options: K8sWebLoginOptions = { server: parseK8sServerArg(input.server) };

  if (input.insecureSkipTlsVerify !== undefined) {
    if (typeof input.insecureSkipTlsVerify !== 'boolean') {
      throw new Error('Invalid TLS option');
    }
    options.insecureSkipTlsVerify = input.insecureSkipTlsVerify;
  }
  if (input.namespace !== undefined) {
    if (typeof input.namespace !== 'string' || input.namespace.length > MAX_NAMESPACE_LENGTH) {
      throw new Error('Invalid namespace');
    }
    const namespace = input.namespace.trim();
    if (namespace) options.namespace = namespace;
  }
  if (input.callbackPort !== undefined) {
    const port = input.callbackPort;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new Error('Callback port must be an integer between 1024 and 65535');
    }
    options.callbackPort = port;
  }
  return options;
}

const MAX_PROFILE_NAME_LENGTH = 200;
const PROFILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const PROFILE_NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function optionalProfileString(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length > maxLength) throw new Error(`Invalid ${label}`);
  return value.trim() || undefined;
}

/** Validates an untrusted saved-cluster profile and drops every field it does not know. */
export function parseK8sProfile(raw: unknown): K8sProfile {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid profile');
  const input = raw as Record<string, unknown>;
  if (typeof input.id !== 'string' || !PROFILE_ID_PATTERN.test(input.id)) throw new Error('Invalid profile id');
  const server = parseK8sServerArg(input.server);
  const name = optionalProfileString(input.name, 'profile name', MAX_PROFILE_NAME_LENGTH);
  if (!name) throw new Error('Profile name is required');

  const profile: K8sProfile = { id: input.id, name, server };
  if (input.insecureSkipTlsVerify !== undefined) {
    if (typeof input.insecureSkipTlsVerify !== 'boolean') throw new Error('Invalid TLS option');
    profile.insecureSkipTlsVerify = input.insecureSkipTlsVerify;
  }
  const namespace = optionalProfileString(input.namespace, 'namespace', MAX_NAMESPACE_LENGTH);
  if (namespace) {
    if (!PROFILE_NAMESPACE_PATTERN.test(namespace)) throw new Error('Invalid namespace');
    profile.namespace = namespace;
  }
  const contextName = optionalProfileString(input.contextName, 'context name', MAX_SERVER_URL_LENGTH);
  if (contextName) profile.contextName = contextName;
  const lastUsedAt = optionalProfileString(input.lastUsedAt, 'timestamp', 64);
  if (lastUsedAt && !Number.isNaN(Date.parse(lastUsedAt))) profile.lastUsedAt = lastUsedAt;
  return profile;
}

function isoTimestamp(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 64 && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

/**
 * Like parseK8sProfile, but for records read from disk, a sync payload or a Team Vault: it also keeps
 * the `updatedAt`/`deletedAt` stamps that merging and tombstones depend on.
 */
export function parseStoredK8sProfile(raw: unknown): K8sProfile {
  const profile = parseK8sProfile(raw);
  const input = raw as Record<string, unknown>;
  const updatedAt = isoTimestamp(input.updatedAt);
  const deletedAt = isoTimestamp(input.deletedAt);
  return { ...profile, ...(updatedAt ? { updatedAt } : {}), ...(deletedAt ? { deletedAt } : {}) };
}

/** Throws unless every named IPC argument is a non-empty string (the renderer is not trusted to send the right types). */
export function assertStrings(args: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(args)) {
    if (typeof value !== 'string' || value === '') throw new Error(`Invalid argument: ${name}`);
  }
}
