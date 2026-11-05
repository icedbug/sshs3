import crypto from 'node:crypto';
import type { SshCaConfig } from '../../shared/types/sshCa';
import { buildRedirectUri, generatePkce, generateState, startCallbackServer } from '../oauth/loopbackAuth';
import { requestJson } from '../oauth/requestJson';
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

export function oidcClientOf(config: SshCaConfig): OidcClient {
  return { issuerUrl: config.oidcIssuerUrl, clientId: config.oidcClientId, rootCa: rootCaBuffer(config) };
}

/** Plain http is only ever allowed when the configured issuer itself is a loopback address. */
function allowsHttp(client: OidcClient): boolean {
  return isLoopbackHttpUrl(client.issuerUrl.trim());
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
  const issuer = client.issuerUrl.trim().replace(/\/+$/, '');
  const discoveryUrl = `${issuer}/.well-known/openid-configuration`;

  const res = await requestJson(discoveryUrl, {
    method: 'GET',
    ca: client.rootCa,
    timeoutMs: REQUEST_TIMEOUT_MS,
    allowHttp: allowsHttp(client),
    signal,
  });
  if (res.statusCode !== 200) {
    throw new Error(`Failed to fetch OIDC discovery configuration from ${discoveryUrl} (HTTP ${res.statusCode})`);
  }

  const doc = res.json as { authorization_endpoint?: string; token_endpoint?: string };
  if (!doc.authorization_endpoint || !doc.token_endpoint) {
    throw new Error('OIDC discovery response missing authorization_endpoint or token_endpoint');
  }
  return { authorizationEndpoint: doc.authorization_endpoint, tokenEndpoint: doc.token_endpoint };
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
  const allowHttp = allowsHttp(client);
  const pkce = generatePkce();
  const state = generateState();
  const nonce = crypto.randomBytes(16).toString('base64url');

  // Validate the endpoint before binding a port, so a bad discovery document never leaves a listener behind.
  const authUrl = new URL(endpoints.authorizationEndpoint);
  if (authUrl.protocol !== 'https:' && !(allowHttp && authUrl.protocol === 'http:')) {
    throw new Error(`Insecure or invalid authorization_endpoint protocol: "${authUrl.protocol}"`);
  }

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

  const res = await requestJson(endpoints.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: pkce.verifier,
    }).toString(),
    ca: client.rootCa,
    timeoutMs: REQUEST_TIMEOUT_MS,
    allowHttp,
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
  assertIdTokenNonce(tokens.id_token, nonce);

  return {
    idToken: tokens.id_token,
    refreshToken: tokens.refresh_token,
    username: usernameFromIdToken(tokens.id_token),
  };
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
    allowHttp: allowsHttp(client),
    signal,
  });
  if (res.statusCode !== 200) return undefined;

  const tokens = res.json as { id_token?: string; refresh_token?: string };
  return tokens.id_token ? { idToken: tokens.id_token, refreshToken: tokens.refresh_token } : undefined;
}
