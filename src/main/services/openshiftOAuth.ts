import {
  DEFAULT_CALLBACK_PATH,
  generatePkce,
  generateState,
  buildRedirectUri,
  parseCallback,
  sanitizeServerText,
  type PkcePair,
  type CallbackOutcome,
} from '../oauth/loopbackAuth';

export {
  generatePkce,
  generateState,
  buildRedirectUri,
  parseCallback,
  type PkcePair,
  type CallbackOutcome,
};

/**
 * Pure helpers for the OpenShift browser sign-in (OAuth 2.0 authorization code
 * grant with PKCE against the built-in OAuth server). They mirror what
 * `oc login --web` does (openshift/library-go `pkg/oauth/tokenrequest`), so the
 * flow stays compatible with the server side without any I/O in this file.
 */

/** Public OAuth client that the cluster-authentication-operator registers (OpenShift 4.13+). */
export const OPENSHIFT_CLI_CLIENT_ID = 'openshift-cli-client';

/** Unauthenticated OAuth 2.0 Authorization Server Metadata document of the OpenShift OAuth server. */
export const OAUTH_METADATA_PATH = '/.well-known/oauth-authorization-server';

/** The client is registered with `http://127.0.0.1/callback` and `http://[::1]/callback`; the server ignores the port. */
export const CALLBACK_PATH = DEFAULT_CALLBACK_PATH;

export interface OAuthMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** PKCE is only used when the server advertises S256 (same rule as `oc`). */
  supportsS256: boolean;
}

export interface TokenResult {
  accessToken: string;
  /** ISO timestamp, only when the server reported `expires_in`. */
  expiresAt?: string;
}

function normalizeServer(server: string): URL {
  let normalized = server.trim();
  if (!/^https?:\/\//i.test(normalized)) {
    normalized = `https://${normalized}`;
  }
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`Invalid cluster URL: ${server}`);
  }
  return parsed;
}

export function buildMetadataUrl(server: string): string {
  const parsed = normalizeServer(server);
  return new URL(OAUTH_METADATA_PATH, `${parsed.protocol}//${parsed.host}`).toString();
}

function requireEndpoint(value: unknown, name: string, allowHttp: boolean): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`OAuth metadata is missing ${name}`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`OAuth metadata has an invalid ${name}`);
  }
  if (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:')) {
    throw new Error(`OAuth metadata ${name} must use https`);
  }
  return parsed.toString();
}

/** Fails closed: every required field must be present and the endpoints must be https. */
export function parseOAuthMetadata(raw: unknown, options: { allowHttp?: boolean } = {}): OAuthMetadata {
  if (!raw || typeof raw !== 'object') {
    throw new Error('OAuth metadata is not a JSON object');
  }
  const doc = raw as Record<string, unknown>;
  const allowHttp = options.allowHttp === true;
  if (typeof doc.issuer !== 'string' || !doc.issuer) {
    throw new Error('OAuth metadata is missing issuer');
  }
  const methods = Array.isArray(doc.code_challenge_methods_supported) ? doc.code_challenge_methods_supported : [];
  return {
    issuer: doc.issuer,
    authorizationEndpoint: requireEndpoint(doc.authorization_endpoint, 'authorization_endpoint', allowHttp),
    tokenEndpoint: requireEndpoint(doc.token_endpoint, 'token_endpoint', allowHttp),
    supportsS256: methods.includes('S256'),
  };
}

export function buildAuthorizeUrl(
  metadata: OAuthMetadata,
  params: { redirectUri: string; state: string; challenge?: string }
): string {
  const url = new URL(metadata.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', OPENSHIFT_CLI_CLIENT_ID);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('state', params.state);
  if (params.challenge) {
    url.searchParams.set('code_challenge', params.challenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  return url.toString();
}

/**
 * Token request as `oc` sends it: form body, the public client authenticates
 * with HTTP Basic `client_id:` (empty secret), `code_verifier` only with PKCE.
 */
export function buildTokenRequest(params: { code: string; redirectUri: string; verifier?: string }): {
  body: string;
  authorization: string;
} {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
  });
  if (params.verifier) {
    body.set('code_verifier', params.verifier);
  }
  return {
    body: body.toString(),
    authorization: `Basic ${Buffer.from(`${OPENSHIFT_CLI_CLIENT_ID}:`).toString('base64')}`,
  };
}

export function parseTokenResponse(raw: unknown, now: number = Date.now()): TokenResult {
  if (!raw || typeof raw !== 'object') {
    throw new Error('OpenShift token endpoint returned an unexpected response');
  }
  const doc = raw as Record<string, unknown>;
  if (typeof doc.error === 'string' && doc.error) {
    const description = typeof doc.error_description === 'string' ? `: ${doc.error_description}` : '';
    throw new Error(`OpenShift token request failed (${sanitizeServerText(`${doc.error}${description}`)})`);
  }
  const accessToken = typeof doc.access_token === 'string' ? doc.access_token.trim() : '';
  if (!accessToken) {
    throw new Error('OpenShift token endpoint did not return an access token');
  }
  if (typeof doc.token_type === 'string' && doc.token_type.toLowerCase() !== 'bearer') {
    throw new Error('OpenShift token endpoint returned an unsupported token type');
  }
  const result: TokenResult = { accessToken };
  if (typeof doc.expires_in === 'number' && Number.isFinite(doc.expires_in) && doc.expires_in > 0) {
    result.expiresAt = new Date(now + doc.expires_in * 1000).toISOString();
  }
  return result;
}
