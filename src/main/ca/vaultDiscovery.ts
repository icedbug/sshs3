import type {
  SshCaDetectedAuthMount,
  SshCaDetectedSshMount,
  SshCaVaultDetectRequest,
  SshCaVaultDetectResult,
} from '../../shared/types/sshCa';
import { requestJson as defaultRequestJson } from '../oauth/requestJson';
import { certErrorMessage } from './certErrors';
import { isLoopbackHttpUrl } from './loopbackUrl';
import { normalizeCaBaseUrl, rootCaBuffer } from './providers/common';
import { computeOpenSshFingerprint } from './sshCertificateUtils';

const REQUEST_TIMEOUT_MS = 15_000;
/** Mount names tried when the server does not list its mounts: OpenBao/Vault's own default and the docs' example. */
export const DEFAULT_SSH_MOUNTS = ['ssh', 'ssh-client-signer'];
const MAX_SSH_MOUNT_PROBES = 8;
const MOUNT_SEGMENT = /^[A-Za-z0-9._-]+$/;
const PUBLIC_KEY_LINE = /^(ssh-[a-z0-9-]+|ecdsa-sha2-nistp\d+) ([A-Za-z0-9+/]+={0,2})(?:\s|$)/;

export const VAULT_NOT_TRUSTED_MESSAGE =
  "The server's certificate is not trusted by this computer. Paste the root certificate into Custom Root CA Certificate, or add the root to the OS trust store.";

/** `ssh-ed25519 AAAA… comment` → key type and SHA256 fingerprint, or undefined if it is not an OpenSSH public key. */
export function parseSshPublicKey(text: string): { keyType: string; fingerprint: string } | undefined {
  const m = PUBLIC_KEY_LINE.exec(text.trim());
  if (!m) return undefined;
  const wire = Buffer.from(m[2], 'base64');
  if (wire.length < 8) return undefined;
  return { keyType: m[1], fingerprint: computeOpenSshFingerprint(wire) };
}

/** A mount path of plain segments: no empty, `.` or `..` parts, because the server controls these names and they end up in a URL. */
export function isSafeMountName(name: string): boolean {
  return name.split('/').every((seg) => seg !== '.' && seg !== '..' && MOUNT_SEGMENT.test(seg));
}

/** `data` of a `sys/internal/ui/mounts` answer (Vault wraps it in `data`, the OpenBao docs show it unwrapped). */
export function parseUiMounts(json: unknown): { sshMountNames: string[]; authMounts: SshCaDetectedAuthMount[] } {
  const root = json as { data?: unknown } | undefined;
  const body = (root && typeof root.data === 'object' && root.data !== null ? root.data : root) as
    | { auth?: unknown; secret?: unknown }
    | undefined;
  const entries = (section: unknown): Array<[string, { type?: unknown }]> =>
    section && typeof section === 'object' ? (Object.entries(section) as Array<[string, { type?: unknown }]>) : [];
  const clean = (path: string): string => path.replace(/^\/+|\/+$/g, '');

  const sshMountNames: string[] = [];
  for (const [path, info] of entries(body?.secret)) {
    const name = clean(path);
    if (info?.type === 'ssh' && isSafeMountName(name)) sshMountNames.push(name);
  }
  const authMounts: SshCaDetectedAuthMount[] = [];
  for (const [path, info] of entries(body?.auth)) {
    const name = clean(path);
    if ((info?.type === 'jwt' || info?.type === 'oidc') && isSafeMountName(name)) {
      authMounts.push({ mount: name, type: info.type });
    }
  }
  return { sshMountNames, authMounts };
}

export interface VaultDiscoveryDeps {
  requestJson: typeof defaultRequestJson;
}

/**
 * Looks at a Vault / OpenBao server without a token: checks that it is one and usable, finds SSH secrets engines
 * (mounts the server lists, plus `ssh` and `ssh-client-signer`) by reading their public CA key, and reports JWT/OIDC
 * auth mounts the server chooses to list. Roles, the OIDC issuer and the client ID need a token and are not detectable.
 */
export async function detectVault(
  request: SshCaVaultDetectRequest,
  deps: VaultDiscoveryDeps = { requestJson: defaultRequestJson }
): Promise<SshCaVaultDetectResult> {
  if (!request.caUrl?.trim()) throw new Error('Enter the CA URL first');
  const base = normalizeCaBaseUrl(request.caUrl);
  try {
    new URL(base);
  } catch {
    throw new Error('The CA URL is not valid');
  }
  const allowHttp = isLoopbackHttpUrl(base);
  const ca = rootCaBuffer(request);
  const headers: Record<string, string> = {};
  const namespace = request.namespace?.trim();
  if (namespace) headers['X-Vault-Namespace'] = namespace;

  const get = (path: string, accept = 'application/json') =>
    deps.requestJson(`${base}/v1/${path}`, {
      method: 'GET',
      headers: { ...headers, Accept: accept },
      ca,
      timeoutMs: REQUEST_TIMEOUT_MS,
      allowHttp,
    });

  // Health answers with a JSON body for every state (active, standby, sealed, not initialized); the status code differs.
  let health;
  try {
    health = await get('sys/health');
  } catch (err) {
    const message = certErrorMessage(err, VAULT_NOT_TRUSTED_MESSAGE);
    if (message) throw new Error(message, { cause: err });
    throw err;
  }
  const h = health.json as { initialized?: unknown; sealed?: unknown; version?: unknown } | undefined;
  if (!h || typeof h.initialized !== 'boolean' || typeof h.sealed !== 'boolean') {
    throw new Error('This does not look like a Vault or OpenBao server (unexpected answer from sys/health)');
  }
  if (!h.initialized) throw new Error('The server is not initialized');
  if (h.sealed) throw new Error('The server is sealed. Ask an administrator to unseal it.');
  const version = typeof h.version === 'string' && h.version ? h.version : undefined;

  // Best effort: the endpoint is open but lists only mounts with listing_visibility=unauth.
  let listed: ReturnType<typeof parseUiMounts> = { sshMountNames: [], authMounts: [] };
  try {
    const ui = await get('sys/internal/ui/mounts');
    if (ui.statusCode === 200) listed = parseUiMounts(ui.json);
  } catch {
    // Not available on this server or namespace: fall back to the default names.
  }

  const candidates = [...new Set([...listed.sshMountNames, ...DEFAULT_SSH_MOUNTS])].slice(0, MAX_SSH_MOUNT_PROBES);
  const sshMounts: SshCaDetectedSshMount[] = [];
  for (const mount of candidates) {
    try {
      const path = mount.split('/').map(encodeURIComponent).join('/');
      const res = await get(`${path}/public_key`, 'text/plain');
      const key = res.statusCode === 200 && typeof res.text === 'string' ? parseSshPublicKey(res.text) : undefined;
      if (key) sshMounts.push({ mount, ...key });
    } catch {
      // This mount does not exist or is not readable: skip it.
    }
  }

  return { version, sshMounts, authMounts: listed.authMounts };
}
