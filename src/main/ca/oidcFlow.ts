import crypto from 'node:crypto';
import net from 'node:net';
import type { SshCaConfig } from '../../shared/types/sshCa';
import {
  buildRedirectUri,
  type CallbackOutcome,
  generatePkce,
  generateState,
  parseCallback,
  sanitizeServerText,
  startCallbackServer,
  statesEqual,
} from '../oauth/loopbackAuth';
import { classifyIpAddress, requestJson, userEndpointPolicy, type SsrfPolicyOptions } from '../oauth/requestJson';
import { isLoopbackHttpUrl } from './loopbackUrl';
import { rootCaBuffer } from './providers/common';

const OIDC_SCOPE = 'openid profile email';
const REQUEST_TIMEOUT_MS = 15_000;
const BROWSER_SIGN_IN_TIMEOUT_MS = 120_000;

/** The parts of an SSH CA config the OIDC login needs. */
export interface OidcClient {
  issuerUrl: string;
  clientId: string;
  rootCa?: Buffer;
  /**
   * Private-network issuers (a corporate IdP) are allowed unless this is false; on a shared web server only with
   * the administrator's opt-in (see userEndpointPolicy).
   */
  allowPrivateIssuer?: boolean;
  /** Explicit opt-in for plain http on a private-network local dev OIDC issuer (requires `allowPrivateIssuer`). */
  allowHttpPrivateIssuer?: boolean;
}

export interface OidcEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

export interface OidcSignIn {
  idToken: string;
  refreshToken?: string;
  username: string;
}

export interface WebOidcAuthRequest {
  authorizationUrl: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  createdAt: number;
  expiresAt: number;
}

export interface WebOidcCallbackInput {
  state?: string | null;
  code?: string | null;
  error?: string | null;
  error_description?: string | null;
}

export interface WebOidcRelayOptions {
  redirectUri: string;
  openAuthUrl: (url: string, state: string) => Promise<void>;
  waitForCallback: (state: string, signal: AbortSignal) => Promise<WebOidcCallbackInput | string | URLSearchParams>;
  signal: AbortSignal;
  ttlMs?: number;
  allowInsecureRedirectUri?: boolean;
}

export function oidcClientOf(config: SshCaConfig): OidcClient {
  return { issuerUrl: config.oidcIssuerUrl, clientId: config.oidcClientId, rootCa: rootCaBuffer(config) };
}

function isLoopbackHostOrIp(url: URL): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (net.isIP(host) !== 0) return classifyIpAddress(host) === 'loopback';
  return false;
}

/** Plain http is only ever allowed when the configured issuer is loopback (or explicitly opted-in private dev). */
function allowsHttp(client: OidcClient): boolean {
  const trimmed = client.issuerUrl.trim();
  if (isLoopbackHttpUrl(trimmed)) return true;
  if (client.allowPrivateIssuer && client.allowHttpPrivateIssuer) {
    try {
      const url = new URL(trimmed);
      return url.protocol === 'http:' && !url.username && !url.password;
    } catch {
      return false;
    }
  }
  return false;
}

function ssrfOptionsForClient(client: OidcClient): SsrfPolicyOptions {
  const isLoopback = (() => {
    try {
      return isLoopbackHostOrIp(new URL(client.issuerUrl.trim()));
    } catch {
      return false;
    }
  })();
  return {
    allowHttp: allowsHttp(client),
    allowLoopback: isLoopback,
    allowPrivate: client.allowPrivateIssuer,
  };
}

/** Whether a private-network address may be used: the caller's word, within what this process allows. */
function privateAllowed(optIn: boolean | undefined): boolean {
  return userEndpointPolicy().allowPrivate && optIn !== false;
}

/**
 * Validates and normalizes an OIDC issuer URL:
 * - Rejects invalid URLs, embedded credentials, query strings, and fragments.
 * - Enforces `https://` except for loopback HTTP (`http://localhost`, `http://127.x.x.x`, `http://[::1]`)
 *   or an explicitly opted-in private dev issuer.
 * - Blocks link-local / cloud metadata / unspecified / multicast IP literals, and private IP literals where
 *   userEndpointPolicy does not allow them (a shared web server) or the caller said false.
 */
export function validateOidcIssuerUrl(
  rawIssuerUrl: string,
  options: { allowPrivate?: boolean; allowHttpPrivate?: boolean } = {}
): string {
  const trimmed = rawIssuerUrl.trim();
  if (!trimmed) {
    throw new Error('OIDC issuer URL is required');
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('OIDC issuer URL is not a valid URL');
  }
  if (url.username || url.password) {
    throw new Error('OIDC issuer URL must not contain embedded credentials');
  }
  if (url.search || url.hash) {
    throw new Error('OIDC issuer URL must not contain query parameters or fragments');
  }

  const loopbackHttp = isLoopbackHttpUrl(trimmed);
  const privateHttpAllowed = Boolean(options.allowPrivate && options.allowHttpPrivate && url.protocol === 'http:');
  if (url.protocol !== 'https:' && !loopbackHttp && !privateHttpAllowed) {
    throw new Error('OIDC issuer URL must use https (only loopback http is exempted for local development)');
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) !== 0) {
    const kind = classifyIpAddress(host);
    if (kind === 'never' || kind === 'link-local') {
      throw new Error(`OIDC issuer URL points to disallowed ${kind} IP address (${host})`);
    }
    if (kind === 'private' && !privateAllowed(options.allowPrivate)) {
      throw new Error(`OIDC issuer URL points to private IP address (${host}), which this server does not allow`);
    }
  }

  return trimmed.replace(/\/+$/, '');
}

function validateEndpointUrl(
  rawEndpoint: string,
  field: 'authorization_endpoint' | 'token_endpoint',
  client: OidcClient
): URL {
  let url: URL;
  try {
    url = new URL(rawEndpoint);
  } catch {
    throw new Error(`Invalid ${field} URL`);
  }
  if (url.username || url.password) {
    throw new Error(`Invalid ${field}: embedded credentials are not allowed`);
  }
  const allowHttp = allowsHttp(client);
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    throw new Error(`Insecure or invalid ${field} protocol: "${url.protocol}"`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) !== 0) {
    const kind = classifyIpAddress(host);
    if (kind === 'never' || kind === 'link-local') {
      throw new Error(`Invalid ${field}: disallowed ${kind} IP address (${host})`);
    }
    if (kind === 'private' && !privateAllowed(client.allowPrivateIssuer)) {
      throw new Error(`Invalid ${field}: private IP address (${host}) is not allowed`);
    }
    if (kind === 'loopback' && !isLoopbackHostOrIp(new URL(client.issuerUrl.trim()))) {
      throw new Error(`Invalid ${field}: loopback endpoint is not allowed for non-loopback issuer`);
    }
  }
  return url;
}

/** Validates a web-relayed OIDC callback redirect URI (https, or loopback http / explicit local dev). */
export function validateWebRedirectUri(redirectUri: string, allowInsecureLocal = false): string {
  const trimmed = redirectUri.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('OIDC redirect_uri is not a valid URL');
  }
  if (url.username || url.password || url.hash) {
    throw new Error('OIDC redirect_uri must not contain credentials or fragments');
  }
  if (url.protocol !== 'https:' && !isLoopbackHttpUrl(trimmed) && !(allowInsecureLocal && url.protocol === 'http:')) {
    throw new Error('OIDC redirect_uri must use https (or loopback http)');
  }
  return url.toString();
}

/** Claims of a JWT without verifying it; undefined if it is not a decodable JWT. */
export function decodeJwtClaims(jwt: string): Record<string, unknown> | undefined {
  const parts = jwt.split('.');
  if (parts.length < 2) return undefined;
  try {
    const claims: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
    return claims && typeof claims === 'object' && !Array.isArray(claims) ? (claims as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Display name for a session: preferred_username, then email, then sub. */
export function usernameFromIdToken(idToken: string): string {
  const claims = decodeJwtClaims(idToken);
  return (
    (claims?.preferred_username as string) ||
    (claims?.email as string) ||
    (claims?.sub as string) ||
    'user'
  );
}

/** OIDC Core 3.1.3.7: when a nonce was sent, the id_token must carry exactly that nonce. */
export function assertIdTokenNonce(idToken: string, expectedNonce: string): void {
  if (decodeJwtClaims(idToken)?.nonce !== expectedNonce) {
    throw new Error('OIDC id_token nonce does not match the sign-in request');
  }
}

export async function discoverOidc(client: OidcClient, signal?: AbortSignal): Promise<OidcEndpoints> {
  const issuer = validateOidcIssuerUrl(client.issuerUrl, {
    allowPrivate: client.allowPrivateIssuer,
    allowHttpPrivate: client.allowHttpPrivateIssuer,
  });
  const discoveryUrl = `${issuer}/.well-known/openid-configuration`;

  const res = await requestJson(discoveryUrl, {
    method: 'GET',
    ca: client.rootCa,
    timeoutMs: REQUEST_TIMEOUT_MS,
    ...ssrfOptionsForClient(client),
    signal,
  });
  if (res.statusCode !== 200) {
    throw new Error(`Failed to fetch OIDC discovery configuration from ${discoveryUrl} (HTTP ${res.statusCode})`);
  }

  const doc = res.json as { issuer?: string; authorization_endpoint?: string; token_endpoint?: string };
  if (typeof doc.issuer === 'string' && doc.issuer.trim()) {
    const discoveredIssuer = doc.issuer.trim().replace(/\/+$/, '');
    if (discoveredIssuer !== issuer) {
      throw new Error(`OIDC discovery issuer mismatch: expected "${issuer}", got "${discoveredIssuer}"`);
    }
  }
  if (!doc.authorization_endpoint || !doc.token_endpoint) {
    throw new Error('OIDC discovery response missing authorization_endpoint or token_endpoint');
  }
  validateEndpointUrl(doc.authorization_endpoint, 'authorization_endpoint', client);
  validateEndpointUrl(doc.token_endpoint, 'token_endpoint', client);
  return { authorizationEndpoint: doc.authorization_endpoint, tokenEndpoint: doc.token_endpoint };
}

/**
 * Builds an authorization request (URL + PKCE verifier + state + nonce) for a web-relayed OIDC callback.
 */
export function createWebOidcAuthRequest(
  client: OidcClient,
  endpoints: Pick<OidcEndpoints, 'authorizationEndpoint'>,
  redirectUri: string,
  options: { ttlMs?: number; allowInsecureRedirectUri?: boolean } = {}
): WebOidcAuthRequest {
  validateOidcIssuerUrl(client.issuerUrl, {
    allowPrivate: client.allowPrivateIssuer,
    allowHttpPrivate: client.allowHttpPrivateIssuer,
  });
  const authUrl = validateEndpointUrl(endpoints.authorizationEndpoint, 'authorization_endpoint', client);
  const validatedRedirectUri = validateWebRedirectUri(redirectUri, options.allowInsecureRedirectUri);

  const pkce = generatePkce();
  const state = generateState();
  const nonce = crypto.randomBytes(16).toString('base64url');

  authUrl.searchParams.set('client_id', client.clientId);
  authUrl.searchParams.set('redirect_uri', validatedRedirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', OIDC_SCOPE);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', pkce.challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('nonce', nonce);

  const createdAt = Date.now();
  const ttlMs = Math.max(10_000, options.ttlMs ?? BROWSER_SIGN_IN_TIMEOUT_MS);
  return {
    authorizationUrl: authUrl.toString(),
    state,
    nonce,
    codeVerifier: pkce.verifier,
    redirectUri: validatedRedirectUri,
    createdAt,
    expiresAt: createdAt + ttlMs,
  };
}

/** Parses and constant-time verifies a web-relayed OIDC callback payload against the expected state. */
export function parseWebOidcCallback(
  input: string | URLSearchParams | WebOidcCallbackInput,
  expectedState: string,
  providerName = 'SSH CA'
): CallbackOutcome {
  if (typeof input === 'string' || input instanceof URLSearchParams) {
    const search = typeof input === 'string' ? input : input.toString();
    return parseCallback(search, expectedState, providerName);
  }
  if (!statesEqual(input.state ?? null, expectedState)) {
    return { kind: 'state-mismatch' };
  }
  if (input.error) {
    const text = sanitizeServerText(input.error_description ? `${input.error}: ${input.error_description}` : input.error);
    return { kind: 'error', message: `${providerName} was rejected (${text})` };
  }
  if (!input.code) {
    return { kind: 'error', message: `${providerName} did not return an authorization code` };
  }
  return { kind: 'code', code: input.code };
}

/** Exchanges an authorization code + PKCE verifier at the OIDC token endpoint and verifies id_token nonce. */
export async function exchangeOidcAuthorizationCode(
  client: OidcClient,
  endpoints: Pick<OidcEndpoints, 'tokenEndpoint'>,
  params: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
    expectedNonce: string;
  },
  signal?: AbortSignal
): Promise<OidcSignIn> {
  validateOidcIssuerUrl(client.issuerUrl, {
    allowPrivate: client.allowPrivateIssuer,
    allowHttpPrivate: client.allowHttpPrivateIssuer,
  });
  validateEndpointUrl(endpoints.tokenEndpoint, 'token_endpoint', client);

  const res = await requestJson(endpoints.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code: params.code,
      redirect_uri: params.redirectUri,
      code_verifier: params.codeVerifier,
    }).toString(),
    ca: client.rootCa,
    timeoutMs: REQUEST_TIMEOUT_MS,
    ...ssrfOptionsForClient(client),
    signal,
  });
  if (res.statusCode !== 200) {
    const errBody = res.json as { error_description?: string; error?: string } | undefined;
    const desc = errBody?.error_description || errBody?.error || `HTTP ${res.statusCode}`;
    throw new Error(`OIDC token exchange failed: ${desc}`);
  }

  const tokens = res.json as { id_token?: string; refresh_token?: string };
  if (!tokens.id_token) {
    throw new Error('OIDC token endpoint did not return an id_token');
  }
  assertIdTokenNonce(tokens.id_token, params.expectedNonce);

  return {
    idToken: tokens.id_token,
    refreshToken: tokens.refresh_token,
    username: usernameFromIdToken(tokens.id_token),
  };
}

/**
 * Authorization-code flow with PKCE via a web-relayed callback URL (for headless / web-server mode).
 */
export async function signInWithWebRelay(
  client: OidcClient,
  endpoints: OidcEndpoints,
  options: WebOidcRelayOptions
): Promise<OidcSignIn> {
  validateEndpointUrl(endpoints.tokenEndpoint, 'token_endpoint', client);
  const authReq = createWebOidcAuthRequest(client, endpoints, options.redirectUri, {
    ttlMs: options.ttlMs,
    allowInsecureRedirectUri: options.allowInsecureRedirectUri,
  });

  await options.openAuthUrl(authReq.authorizationUrl, authReq.state);
  const rawCallback = await options.waitForCallback(authReq.state, options.signal);
  const outcome = parseWebOidcCallback(rawCallback, authReq.state);
  if (outcome.kind === 'state-mismatch') {
    throw new Error('Invalid OIDC callback state');
  }
  if (outcome.kind === 'error') {
    throw new Error(outcome.message);
  }
  return exchangeOidcAuthorizationCode(
    client,
    endpoints,
    {
      code: outcome.code,
      redirectUri: authReq.redirectUri,
      codeVerifier: authReq.codeVerifier,
      expectedNonce: authReq.nonce,
    },
    options.signal
  );
}

/**
 * Authorization-code flow with PKCE in the system browser: opens the authorize URL, waits for the loopback
 * redirect and exchanges the code for tokens.
 */
export async function signInWithBrowser(
  client: OidcClient,
  endpoints: OidcEndpoints,
  openBrowser: (url: string) => Promise<void>,
  signal: AbortSignal
): Promise<OidcSignIn> {
  validateOidcIssuerUrl(client.issuerUrl, {
    allowPrivate: client.allowPrivateIssuer,
    allowHttpPrivate: client.allowHttpPrivateIssuer,
  });
  const pkce = generatePkce();
  const state = generateState();
  const nonce = crypto.randomBytes(16).toString('base64url');

  // Validate the endpoints before binding a port, so a bad discovery document never leaves a listener behind.
  const authUrl = validateEndpointUrl(endpoints.authorizationEndpoint, 'authorization_endpoint', client);
  validateEndpointUrl(endpoints.tokenEndpoint, 'token_endpoint', client);

  const callbackServer = await startCallbackServer({
    state,
    signal,
    timeoutMs: BROWSER_SIGN_IN_TIMEOUT_MS,
    providerName: 'SSH CA',
    timeoutMessage: 'Timed out waiting for the browser sign-in to the SSH CA identity provider. Please try again.',
  });

  let redirectUri: string;
  let code: string;
  try {
    redirectUri = buildRedirectUri(callbackServer.host, callbackServer.port);
    authUrl.searchParams.set('client_id', client.clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', OIDC_SCOPE);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', pkce.challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('nonce', nonce);

    await openBrowser(authUrl.toString());
    code = await callbackServer.waitForCode();
  } finally {
    callbackServer.close();
  }

  return exchangeOidcAuthorizationCode(
    client,
    endpoints,
    {
      code,
      redirectUri,
      codeVerifier: pkce.verifier,
      expectedNonce: nonce,
    },
    signal
  );
}

/**
 * Silent token refresh. Resolves with the new tokens, or undefined when the IdP refused or answered without
 * an id_token; rejects on network errors and cancellation.
 */
export async function refreshOidcTokens(
  client: OidcClient,
  tokenEndpoint: string,
  refreshToken: string,
  signal?: AbortSignal
): Promise<{ idToken: string; refreshToken?: string } | undefined> {
  validateOidcIssuerUrl(client.issuerUrl, {
    allowPrivate: client.allowPrivateIssuer,
    allowHttpPrivate: client.allowHttpPrivateIssuer,
  });
  validateEndpointUrl(tokenEndpoint, 'token_endpoint', client);

  const res = await requestJson(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: client.clientId,
      refresh_token: refreshToken,
      scope: OIDC_SCOPE,
    }).toString(),
    ca: client.rootCa,
    timeoutMs: REQUEST_TIMEOUT_MS,
    ...ssrfOptionsForClient(client),
    signal,
  });
  if (res.statusCode !== 200) return undefined;

  const tokens = res.json as { id_token?: string; refresh_token?: string };
  return tokens.id_token ? { idToken: tokens.id_token, refreshToken: tokens.refresh_token } : undefined;
}
