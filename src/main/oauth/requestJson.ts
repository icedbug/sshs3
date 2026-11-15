import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { SystemTrustStore } from '../crypto/SystemTrustStore';

export const MAX_RESPONSE_BYTES = 1024 * 1024;

export const CERT_ERROR_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

export type AddressClass = 'public' | 'private' | 'loopback' | 'link-local' | 'never';

export interface ResolvedAddress {
  address: string;
  family: number;
}

export interface SsrfPolicyOptions {
  /**
   * Permits plain `http://` ONLY for loopback (or private network when `allowPrivate` is also true).
   * Public hosts always require `https://`.
   */
  allowHttp?: boolean;
  /**
   * Explicitly permits connecting to loopback addresses (`127.0.0.0/8`, `::1`, `localhost`).
   * Defaults to `Boolean(allowHttp)` when `allowHttp` is true, and `false` otherwise.
   */
  allowLoopback?: boolean;
  /**
   * Explicitly permits RFC1918 / ULA / CGNAT private network addresses.
   * Link-local/metadata (`169.254.0.0/16`, `fe80::/10`, `fd00:ec2::254`) and unspecified/multicast
   * addresses are always blocked.
   */
  allowPrivate?: boolean;
  /** Optional custom DNS resolver (primarily for deterministic testing). */
  lookup?: (host: string) => Promise<ResolvedAddress[]>;
}

export interface GuardedHttpTarget {
  url: URL;
  address: string;
  family: number;
}

export class SsrfBlockedError extends Error {
  public readonly code = 'ERR_SSRF_BLOCKED';

  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

export interface JsonResponse {
  statusCode: number;
  json: unknown;
  /** The raw body, for endpoints that answer in plain text. */
  text?: string;
}

export interface RequestJsonOptions extends SsrfPolicyOptions {
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  insecureSkipTlsVerify?: boolean;
  ca?: string | Buffer | Array<string | Buffer>;
  timeoutMs: number;
  /** Aborting rejects with 'Request was cancelled' and tears the connection down. */
  signal?: AbortSignal;
}

export function describeNetworkError(host: string, err: NodeJS.ErrnoException): Error {
  const hint =
    err.code && CERT_ERROR_CODES.has(err.code)
      ? ' Enable "Skip TLS certificate verification" if the cluster uses a private CA.'
      : '';
  // `code` lets callers tell a certificate problem from other network failures.
  return Object.assign(new Error(`Could not reach ${host}: ${err.message}.${hint}`), { code: err.code });
}

/**
 * The roots to verify a server with when the caller names none: Node's bundled list plus the OS trust store. Without
 * this, Electron trusts only its own bundled roots, so a company root installed in the OS would be rejected.
 */
let cachedDefaultRoots: { roots: Array<string | Buffer> | undefined } | undefined;

function defaultRoots(): Array<string | Buffer> | undefined {
  // Built once: the list is several hundred PEMs, and the OS store is read once per run anyway.
  cachedDefaultRoots ??= {
    roots: SystemTrustStore.getCAs().length > 0 ? SystemTrustStore.getMergedRootCertificates() : undefined,
  };
  return cachedDefaultRoots.roots;
}

function stripZoneAndBrackets(address: string): string {
  const unbracketed = address.trim().replace(/^\[|\]$/g, '');
  const zoneIdx = unbracketed.indexOf('%');
  return zoneIdx >= 0 ? unbracketed.slice(0, zoneIdx) : unbracketed;
}

function expandIpv6Groups(address: string): number[] | undefined {
  const clean = stripZoneAndBrackets(address).toLowerCase();
  if (!net.isIPv6(clean)) return undefined;
  const [head, tail] = clean.split('::');
  const parsePart = (part: string): number[] | undefined => {
    if (!part) return [];
    const tokens = part.split(':');
    const out: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok.includes('.')) {
        if (i !== tokens.length - 1 || !net.isIPv4(tok)) return undefined;
        const octs = tok.split('.').map(Number);
        out.push((octs[0] << 8) | octs[1], (octs[2] << 8) | octs[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(tok)) return undefined;
        out.push(parseInt(tok, 16));
      }
    }
    return out;
  };
  const headGroups = parsePart(head);
  if (!headGroups) return undefined;
  if (tail === undefined) {
    return headGroups.length === 8 ? headGroups : undefined;
  }
  const tailGroups = parsePart(tail);
  if (!tailGroups) return undefined;
  const missing = 8 - (headGroups.length + tailGroups.length);
  if (missing < 1) return undefined;
  return [...headGroups, ...new Array<number>(missing).fill(0), ...tailGroups];
}

function embeddedIpv4FromGroups(groups: number[]): string | undefined {
  const isMapped =
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    (groups[5] === 0xffff || groups[5] === 0);
  const isNat64 =
    groups[0] === 0x0064 &&
    groups[1] === 0xff9b &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0;
  if (!isMapped && !isNat64) return undefined;
  // Ignore :: and ::1 (where groups 6..7 represent unspecified/loopback IPv6 rather than IPv4).
  if (groups[5] === 0 && groups[6] === 0 && groups[7] <= 1) return undefined;
  const hi = groups[6];
  const lo = groups[7];
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

export function classifyIpAddress(rawAddress: string): AddressClass {
  const ip = stripZoneAndBrackets(rawAddress);
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split('.').map(Number);
    if (a === 127) return 'loopback';
    if (a === 169 && b === 254) return 'link-local';
    if (a === 0 || a >= 224) return 'never';
    if (a === 192 && b === 0 && c === 0) return 'never';
    if (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19))
    ) {
      return 'private';
    }
    return 'public';
  }
  const groups = expandIpv6Groups(ip);
  if (!groups) return 'never';

  const embedded = embeddedIpv4FromGroups(groups);
  if (embedded) return classifyIpAddress(embedded);

  const allZeroExceptLast =
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0 &&
    groups[6] === 0;
  if (allZeroExceptLast && groups[7] === 0) return 'never';
  if (allZeroExceptLast && groups[7] === 1) return 'loopback';
  // Multicast ff00::/8
  if ((groups[0] & 0xff00) === 0xff00) return 'never';
  // AWS EC2 IPv6 metadata endpoint fd00:ec2::254 is always blocked even when allowPrivate is set.
  if (
    groups[0] === 0xfd00 &&
    groups[1] === 0x0ec2 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0 &&
    groups[6] === 0 &&
    groups[7] === 0x0254
  ) {
    return 'never';
  }
  // Link-local fe80::/10
  if ((groups[0] & 0xffc0) === 0xfe80) return 'link-local';
  // Unique Local fc00::/7
  if ((groups[0] & 0xfe00) === 0xfc00) return 'private';
  return 'public';
}

function isBlockedMetadataHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, '');
  return (
    host === 'metadata.google.internal' ||
    host.endsWith('.metadata.google.internal') ||
    host === 'metadata.goog' ||
    host === 'instance-data' ||
    host === '169.254.169.254' ||
    host === '169.254.170.2' ||
    host === 'fd00:ec2::254'
  );
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, '');
  return host === 'localhost' || host.endsWith('.localhost');
}

export function validateResolvedIpForUrl(url: URL, address: string, policy: SsrfPolicyOptions = {}): void {
  const allowHttp = Boolean(policy.allowHttp);
  const allowLoopback = policy.allowLoopback ?? allowHttp;
  const allowPrivate = Boolean(policy.allowPrivate);
  const kind = classifyIpAddress(address);

  if (kind === 'never' || kind === 'link-local') {
    throw new SsrfBlockedError(`Blocked request to ${url.hostname}: ${kind} address (${address}) is not allowed`);
  }
  if (kind === 'loopback' && !allowLoopback) {
    throw new SsrfBlockedError(`Blocked request to ${url.hostname}: loopback address (${address}) is not allowed`);
  }
  if (kind === 'private' && !allowPrivate) {
    throw new SsrfBlockedError(`Blocked request to ${url.hostname}: private network address (${address}) is not allowed`);
  }
  if (url.protocol !== 'https:') {
    const httpPermitted = allowHttp && (kind === 'loopback' || (kind === 'private' && allowPrivate));
    if (!httpPermitted) {
      throw new SsrfBlockedError('Only https URLs are allowed');
    }
  }
}

function parseAndPrecheckUrl(urlString: string, policy: SsrfPolicyOptions): { url: URL; host: string; allowLoopback: boolean } {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error('Invalid URL');
  }
  if (url.username || url.password) {
    throw new SsrfBlockedError('URL must not contain embedded credentials');
  }
  const isHttps = url.protocol === 'https:';
  if (!isHttps && !(policy.allowHttp && url.protocol === 'http:')) {
    throw new Error('Only https URLs are allowed');
  }
  const host = stripZoneAndBrackets(url.hostname);
  if (!host) {
    throw new Error('Invalid URL');
  }
  if (isBlockedMetadataHost(host)) {
    throw new SsrfBlockedError(`Blocked request to metadata host (${host})`);
  }
  const allowLoopback = policy.allowLoopback ?? Boolean(policy.allowHttp);
  if (isLoopbackHostname(host) && !allowLoopback) {
    throw new SsrfBlockedError(`Blocked request to loopback host (${host})`);
  }
  return { url, host, allowLoopback };
}

async function defaultDnsLookup(host: string): Promise<ResolvedAddress[]> {
  const entries = await dns.lookup(host, { all: true, verbatim: true });
  return entries.map((e) => ({ address: e.address, family: e.family }));
}

export async function resolveAndValidateTarget(
  urlString: string,
  policy: SsrfPolicyOptions = {}
): Promise<GuardedHttpTarget> {
  const { url, host } = parseAndPrecheckUrl(urlString, policy);
  const ipVersion = net.isIP(host);
  if (ipVersion !== 0) {
    validateResolvedIpForUrl(url, host, policy);
    return { url, address: host, family: ipVersion };
  }
  const lookupFn = policy.lookup ?? defaultDnsLookup;
  const resolved = await lookupFn(host);
  if (!resolved.length) {
    throw new Error(`Could not resolve ${host}`);
  }
  for (const entry of resolved) {
    validateResolvedIpForUrl(url, entry.address, policy);
  }
  return { url, address: resolved[0].address, family: resolved[0].family };
}

export function requestJson(urlString: string, init: RequestJsonOptions): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    if (init.signal?.aborted) {
      reject(new Error('Request was cancelled'));
      return;
    }

    let url: URL;
    let host: string;
    try {
      ({ url, host } = parseAndPrecheckUrl(urlString, init));
      if (net.isIP(host) !== 0) {
        validateResolvedIpForUrl(url, host, init);
      }
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    const executeRequest = (preResolved?: GuardedHttpTarget) => {
      if (init.signal?.aborted) {
        reject(new Error('Request was cancelled'));
        return;
      }

      const isHttps = url.protocol === 'https:';
      const client = isHttps ? https : http;
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'User-Agent': 'sshs3-client',
        ...init.headers,
      };
      if (init.body !== undefined) {
        headers['Content-Length'] = String(Buffer.byteLength(init.body));
      }

      const pinnedLookup: NonNullable<http.RequestOptions['lookup']> = (reqHost, opts, cb) => {
        const callback = typeof opts === 'function' ? opts : cb;
        const wantsAll = typeof opts === 'object' && opts !== null && Boolean(opts.all);
        const replyWith = (pinned: ResolvedAddress) => {
          if (wantsAll) {
            // Return only the single validated address so multi-address Happy Eyeballs cannot pick an unpinned IP.
            (callback as (err: NodeJS.ErrnoException | null, addresses: Array<{ address: string; family: number }>) => void)(
              null,
              [{ address: pinned.address, family: pinned.family }]
            );
          } else {
            (callback as (err: NodeJS.ErrnoException | null, address: string, family: number) => void)(
              null,
              pinned.address,
              pinned.family
            );
          }
        };

        if (preResolved) {
          replyWith({ address: preResolved.address, family: preResolved.family });
          return;
        }
        const literalFamily = net.isIP(reqHost);
        if (literalFamily !== 0) {
          try {
            validateResolvedIpForUrl(url, reqHost, init);
            replyWith({ address: reqHost, family: literalFamily });
          } catch (err) {
            (callback as (err: Error | null) => void)(err instanceof Error ? err : new Error(String(err)));
          }
          return;
        }

        defaultDnsLookup(reqHost)
          .then((addrs) => {
            if (!addrs.length) {
              throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${reqHost}`), { code: 'ENOTFOUND' });
            }
            for (const entry of addrs) {
              validateResolvedIpForUrl(url, entry.address, init);
            }
            replyWith(addrs[0]);
          })
          .catch((err) => {
            (callback as (err: Error | null) => void)(err instanceof Error ? err : new Error(String(err)));
          });
      };

      // Node's http.request/https.request never follows 3xx redirects automatically.
      const req = client.request(
        url,
        {
          method: init.method,
          headers,
          rejectUnauthorized: !init.insecureSkipTlsVerify,
          ca: init.ca ?? (isHttps && !init.insecureSkipTlsVerify ? defaultRoots() : undefined),
          timeout: init.timeoutMs,
          signal: init.signal,
          lookup: pinnedLookup,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) {
              req.destroy(new Error('Response too large'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json: unknown;
            try {
              json = JSON.parse(text);
            } catch {
              json = undefined;
            }
            resolve({ statusCode: res.statusCode ?? 0, json, text });
          });
          res.on('error', reject);
        }
      );
      req.on('timeout', () => req.destroy(new Error('Request timed out')));
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (init.signal?.aborted) {
          reject(new Error('Request was cancelled'));
          return;
        }
        if (err instanceof SsrfBlockedError || err.code === 'ERR_SSRF_BLOCKED') {
          reject(err);
          return;
        }
        reject(describeNetworkError(url.host, err));
      });
      if (init.body !== undefined) req.write(init.body);
      req.end();
    };

    if (init.lookup) {
      resolveAndValidateTarget(urlString, init).then(
        (target) => executeRequest(target),
        (err) => reject(err instanceof Error ? err : new Error(String(err)))
      );
      return;
    }

    const literalFamily = net.isIP(host);
    if (literalFamily !== 0) {
      executeRequest({ url, address: host, family: literalFamily });
      return;
    }

    executeRequest();
  });
}
