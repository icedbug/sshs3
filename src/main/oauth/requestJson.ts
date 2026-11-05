import http from 'node:http';
import https from 'node:https';
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

export interface JsonResponse {
  statusCode: number;
  json: unknown;
  /** The raw body, for endpoints that answer in plain text. */
  text?: string;
}

export interface RequestJsonOptions {
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  insecureSkipTlsVerify?: boolean;
  ca?: string | Buffer | Array<string | Buffer>;
  timeoutMs: number;
  allowHttp?: boolean;
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

export function requestJson(urlString: string, init: RequestJsonOptions): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(urlString);
    } catch {
      reject(new Error('Invalid URL'));
      return;
    }
    const isHttps = url.protocol === 'https:';
    if (!isHttps && !(init.allowHttp && url.protocol === 'http:')) {
      reject(new Error('Only https URLs are allowed'));
      return;
    }
    const client = isHttps ? https : http;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': 'sshs3-client',
      ...init.headers,
    };
    if (init.body !== undefined) {
      headers['Content-Length'] = String(Buffer.byteLength(init.body));
    }
    const req = client.request(
      url,
      {
        method: init.method,
        headers,
        rejectUnauthorized: !init.insecureSkipTlsVerify,
        ca: init.ca ?? (isHttps && !init.insecureSkipTlsVerify ? defaultRoots() : undefined),
        timeout: init.timeoutMs,
        signal: init.signal,
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
    req.on('error', (err: NodeJS.ErrnoException) =>
      reject(init.signal?.aborted ? new Error('Request was cancelled') : describeNetworkError(url.host, err))
    );
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}
