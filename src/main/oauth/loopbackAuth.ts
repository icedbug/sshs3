import http from 'node:http';
import type { AddressInfo } from 'node:net';
import crypto from 'node:crypto';

export const DEFAULT_CALLBACK_PATH = '/callback';

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export type CallbackOutcome =
  | { kind: 'code'; code: string }
  | { kind: 'error'; message: string }
  | { kind: 'state-mismatch' };

export interface CallbackServer {
  host: '127.0.0.1' | '::1';
  port: number;
  waitForCode: () => Promise<string>;
  close: () => void;
}

export interface StartCallbackServerOptions {
  requestedPort?: number;
  state: string;
  signal: AbortSignal;
  timeoutMs: number;
  callbackPath?: string;
  providerName?: string;
  successMessage?: string;
  onCancelError?: () => Error;
  timeoutMessage?: string;
}

const MAX_ERROR_TEXT = 200;

function base64Url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function sanitizeServerText(value: string): string {
  // eslint-disable-next-line no-control-regex -- strips control characters from server-provided text before it reaches the UI
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, MAX_ERROR_TEXT);
}

/** 96 random bytes as base64url (128 characters), challenge = base64url(SHA-256(verifier)). */
export function generatePkce(): PkcePair {
  const verifier = base64Url(crypto.randomBytes(96));
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function generateState(): string {
  return base64Url(crypto.randomBytes(32));
}

export function statesEqual(actual: string | null, expected: string): boolean {
  if (actual === null) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function buildRedirectUri(host: '127.0.0.1' | '::1', port: number, callbackPath: string = DEFAULT_CALLBACK_PATH): string {
  const hostPart = host === '::1' ? '[::1]' : host;
  return `http://${hostPart}:${port}${callbackPath}`;
}

export function parseCallback(search: string, expectedState: string, providerName = 'OpenShift sign-in'): CallbackOutcome {
  const params = new URLSearchParams(search);
  if (!statesEqual(params.get('state'), expectedState)) {
    return { kind: 'state-mismatch' };
  }
  const error = params.get('error');
  if (error) {
    const description = params.get('error_description');
    const text = sanitizeServerText(description ? `${error}: ${description}` : error);
    return { kind: 'error', message: `${providerName} was rejected (${text})` };
  }
  const code = params.get('code');
  if (!code) {
    return { kind: 'error', message: `${providerName} did not return an authorization code` };
  }
  return { kind: 'code', code };
}

function listenOn(server: http.Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function respond(res: http.ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

/**
 * Starts the loopback server that receives the browser redirect. It accepts
 * exactly one valid callback, ignores anything with a wrong `state` (so a stray
 * local request cannot abort the sign-in) and never reflects request data.
 */
export async function startCallbackServer(options: StartCallbackServerOptions): Promise<CallbackServer> {
  const callbackPath = options.callbackPath ?? DEFAULT_CALLBACK_PATH;
  const providerName = options.providerName ?? 'OpenShift sign-in';
  const successMessage = options.successMessage ?? 'Sign-in complete. You can close this tab and return to sshs3.';

  let hostLabel = '127.0.0.1';
  let settled = false;
  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // The flow may be aborted before anyone awaits the promise; avoid an unhandled rejection.
  codePromise.catch(() => {});

  const server = http.createServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      respond(res, 400, 'Bad request.');
      return;
    }
    if (req.method !== 'GET' || url.pathname !== callbackPath) {
      respond(res, 404, 'Not found.');
      return;
    }
    const address = server.address() as AddressInfo | null;
    if (!address || req.headers.host !== `${hostLabel}:${address.port}`) {
      respond(res, 400, 'Bad request.');
      return;
    }
    if (settled) {
      respond(res, 410, 'This sign-in has already been handled.');
      return;
    }
    const outcome = parseCallback(url.search, options.state, providerName);
    if (outcome.kind === 'state-mismatch') {
      respond(res, 400, 'Invalid sign-in response.');
      return;
    }
    settled = true;
    if (outcome.kind === 'error') {
      respond(res, 400, 'Sign-in failed. Return to sshs3 for details.');
      rejectCode(new Error(outcome.message));
      return;
    }
    respond(res, 200, successMessage);
    resolveCode(outcome.code);
  });

  let host: '127.0.0.1' | '::1' = '127.0.0.1';
  try {
    await listenOn(server, host, options.requestedPort ?? 0);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT') {
      host = '::1';
      hostLabel = '[::1]';
      await listenOn(server, host, options.requestedPort ?? 0);
    } else if (code === 'EADDRINUSE') {
      throw new Error(`Port ${options.requestedPort} is already in use. Choose another callback port.`, { cause: err });
    } else {
      throw err;
    }
  }

  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectCode(
      new Error(
        options.timeoutMessage ??
          'Timed out waiting for the browser sign-in. If the browser showed an error, the cluster may not support browser sign-in (OpenShift 4.13 or newer is required).'
      )
    );
  }, options.timeoutMs);

  const onAbort = () => {
    if (settled) return;
    settled = true;
    const cancelErr = options.onCancelError ? options.onCancelError() : new Error('Sign-in was cancelled');
    rejectCode(cancelErr);
  };
  if (options.signal.aborted) onAbort();
  else options.signal.addEventListener('abort', onAbort, { once: true });

  const port = (server.address() as AddressInfo).port;
  return {
    host,
    port,
    waitForCode: () => codePromise,
    close: () => {
      clearTimeout(timer);
      options.signal.removeEventListener('abort', onAbort);
      server.close();
      setTimeout(() => server.closeAllConnections?.(), 1000).unref();
    },
  };
}
