import { createHash, X509Certificate } from 'node:crypto';
import type {
  SshCaDetectedProvisioner,
  SshCaDetectedRoot,
  SshCaDetectRequest,
  SshCaDetectResult,
} from '../../shared/types/sshCa';
import { requestJson as defaultRequestJson } from '../oauth/requestJson';
import { certErrorMessage } from './certErrors';
import { isLoopbackHttpUrl } from './loopbackUrl';
import { normalizeCaBaseUrl, rootCaBuffer } from './providers/common';

const WELL_KNOWN_SUFFIX = '/.well-known/openid-configuration';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_PROVISIONER_PAGES = 5;

export const NOT_TRUSTED_MESSAGE =
  "The CA's certificate is not trusted by this computer. Enter the root CA fingerprint to fetch and verify the root certificate, or add the root to the OS trust store.";

/** `ab:cd…`, `AB CD…` or `sha256:abcd…` → 64 lowercase hex characters, or undefined if it is not a SHA-256 fingerprint. */
export function normalizeFingerprint(input: string): string | undefined {
  const hex = input
    .trim()
    .replace(/^sha-?256[:=\s]*/i, '')
    .replace(/[:\s]/g, '')
    .toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : undefined;
}

/**
 * Accepts a root certificate only if it is exactly one valid, self-issued CA certificate that has not expired
 * and whose SHA-256 fingerprint equals `expectedFingerprint` (64 lowercase hex characters).
 */
export function verifyRootCertificate(
  pem: string,
  expectedFingerprint: string,
  now: Date = new Date()
): { ok: true; root: SshCaDetectedRoot } | { ok: false; error: string } {
  if ((pem.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length !== 1) {
    return { ok: false, error: 'The CA did not return exactly one certificate' };
  }
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(pem);
  } catch {
    return { ok: false, error: 'The CA returned a certificate that cannot be parsed' };
  }
  const fingerprint = createHash('sha256').update(cert.raw).digest('hex');
  if (fingerprint !== expectedFingerprint) {
    return {
      ok: false,
      error: `The certificate returned by the CA does not match the fingerprint (it is ${fingerprint}). Not trusting it.`,
    };
  }
  if (!cert.ca || !cert.checkIssued(cert) || !cert.verify(cert.publicKey)) {
    return { ok: false, error: 'The certificate is not a self-signed root CA certificate' };
  }
  if (new Date(cert.validTo).getTime() <= now.getTime() || new Date(cert.validFrom).getTime() > now.getTime()) {
    return { ok: false, error: 'The root CA certificate is expired or not yet valid' };
  }
  return {
    ok: true,
    root: {
      pem: cert.toString().trim(),
      subject: cert.subject.replace(/\n/g, ', '),
      validTo: new Date(cert.validTo).toISOString(),
      fingerprint,
    },
  };
}

function isAcceptableIssuer(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.username || u.password) return false;
    return u.protocol === 'https:' || isLoopbackHttpUrl(url);
  } catch {
    return false;
  }
}

/** The OIDC provisioners of a Step-CA `GET /provisioners` page; entries without a usable issuer are skipped. */
export function parseOidcProvisioners(json: unknown): SshCaDetectedProvisioner[] {
  const list = (json as { provisioners?: unknown } | undefined)?.provisioners;
  if (!Array.isArray(list)) return [];
  const out: SshCaDetectedProvisioner[] = [];
  for (const entry of list) {
    const p = entry as { type?: unknown; name?: unknown; clientID?: unknown; configurationEndpoint?: unknown };
    if (p?.type !== 'OIDC') continue;
    if (typeof p.name !== 'string' || typeof p.clientID !== 'string' || typeof p.configurationEndpoint !== 'string') {
      continue;
    }
    if (!p.name || !p.clientID || !p.configurationEndpoint.endsWith(WELL_KNOWN_SUFFIX)) continue;
    const issuerUrl = p.configurationEndpoint.slice(0, -WELL_KNOWN_SUFFIX.length).replace(/\/+$/, '');
    if (!isAcceptableIssuer(issuerUrl)) continue;
    out.push({ name: p.name, clientId: p.clientID, issuerUrl });
  }
  return out;
}

function nextCursor(json: unknown): string | undefined {
  const c = (json as { nextCursor?: unknown } | undefined)?.nextCursor;
  return typeof c === 'string' && c ? c : undefined;
}

export interface DiscoveryDeps {
  requestJson: typeof defaultRequestJson;
  now: () => Date;
}

/**
 * Asks a Step-CA which OIDC provisioner it uses. Without a fingerprint the CA's certificate must already be
 * trusted by the OS. With one, the root certificate is downloaded over an unverified connection and accepted only
 * if its fingerprint matches (the same trust step as `step ca bootstrap`), then used to verify the CA itself.
 */
export async function detectStepCa(
  request: SshCaDetectRequest,
  deps: DiscoveryDeps = { requestJson: defaultRequestJson, now: () => new Date() }
): Promise<SshCaDetectResult> {
  if (!request.caUrl?.trim()) throw new Error('Enter the CA URL first');
  const base = normalizeCaBaseUrl(request.caUrl);
  try {
    new URL(base);
  } catch {
    throw new Error('The CA URL is not valid');
  }
  const allowHttp = isLoopbackHttpUrl(base);
  // A root CA the user already entered: it replaces the OS roots, like for the login itself.
  const customRoot = rootCaBuffer(request);

  let root: SshCaDetectedRoot | undefined;
  const rawFingerprint = request.rootFingerprint?.trim();
  if (rawFingerprint) {
    const fingerprint = normalizeFingerprint(rawFingerprint);
    if (!fingerprint) throw new Error('The fingerprint must be 64 hexadecimal characters (SHA-256)');
    const res = await deps
      .requestJson(`${base}/root/${fingerprint}`, {
        method: 'GET',
        // The response is not trusted until its fingerprint has matched below.
        insecureSkipTlsVerify: true,
        timeoutMs: REQUEST_TIMEOUT_MS,
        allowHttp,
      })
      .catch((err: Error) => {
        throw new Error(`Could not download the root certificate: ${err.message}`, { cause: err });
      });
    const pem = (res.json as { ca?: unknown } | undefined)?.ca;
    if (res.statusCode !== 200 || typeof pem !== 'string') {
      throw new Error(`The CA has no root certificate with that fingerprint (HTTP ${res.statusCode})`);
    }
    const verified = verifyRootCertificate(pem, fingerprint, deps.now());
    if (!verified.ok) throw new Error(verified.error);
    root = verified.root;
  }

  const provisioners: SshCaDetectedProvisioner[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PROVISIONER_PAGES; page++) {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    let res;
    try {
      res = await deps.requestJson(`${base}/provisioners${query}`, {
        method: 'GET',
        ca: root?.pem ?? customRoot,
        timeoutMs: REQUEST_TIMEOUT_MS,
        allowHttp,
      });
    } catch (err) {
      const message = certErrorMessage(err, NOT_TRUSTED_MESSAGE);
      if (message) throw new Error(message, { cause: err });
      throw err;
    }
    if (res.statusCode !== 200) throw new Error(`The CA answered HTTP ${res.statusCode} to the provisioner list`);
    provisioners.push(...parseOidcProvisioners(res.json));
    cursor = nextCursor(res.json);
    if (!cursor) break;
  }
  if (provisioners.length === 0) throw new Error('The CA has no OIDC provisioner with a usable issuer URL');
  return { provisioners, root };
}
