import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  OPENSHIFT_CLI_CLIENT_ID,
  buildAuthorizeUrl,
  buildMetadataUrl,
  buildRedirectUri,
  buildTokenRequest,
  generatePkce,
  generateState,
  parseCallback,
  parseOAuthMetadata,
  parseTokenResponse,
} from '../../src/main/services/openshiftOAuth';

const metadata = {
  issuer: 'https://oauth-openshift.apps.example.com',
  authorizationEndpoint: 'https://oauth-openshift.apps.example.com/oauth/authorize',
  tokenEndpoint: 'https://oauth-openshift.apps.example.com/oauth/token',
  supportsS256: true,
};

describe('openshiftOAuth', () => {
  describe('buildMetadataUrl', () => {
    it('points at the well-known OAuth metadata document of the API server', () => {
      expect(buildMetadataUrl('https://api.cluster.example.com:6443')).toBe(
        'https://api.cluster.example.com:6443/.well-known/oauth-authorization-server'
      );
    });

    it('adds https when no scheme is given and drops any path', () => {
      expect(buildMetadataUrl('api.cluster.example.com:6443/some/path/')).toBe(
        'https://api.cluster.example.com:6443/.well-known/oauth-authorization-server'
      );
    });

    it('rejects an invalid server URL', () => {
      expect(() => buildMetadataUrl('http://')).toThrow(/Invalid cluster URL/);
    });
  });

  describe('parseOAuthMetadata', () => {
    const doc = {
      issuer: 'https://oauth-openshift.apps.example.com',
      authorization_endpoint: 'https://oauth-openshift.apps.example.com/oauth/authorize',
      token_endpoint: 'https://oauth-openshift.apps.example.com/oauth/token',
      code_challenge_methods_supported: ['plain', 'S256'],
    };

    it('reads endpoints and detects S256 support', () => {
      expect(parseOAuthMetadata(doc)).toEqual(metadata);
    });

    it('reports no S256 support when the server does not advertise it', () => {
      const { code_challenge_methods_supported: _unused, ...withoutMethods } = doc;
      void _unused;
      expect(parseOAuthMetadata(withoutMethods).supportsS256).toBe(false);
      expect(parseOAuthMetadata({ ...doc, code_challenge_methods_supported: ['plain'] }).supportsS256).toBe(false);
    });

    it('fails closed on non-https endpoints unless explicitly allowed', () => {
      const insecure = { ...doc, token_endpoint: 'http://oauth.example.com/oauth/token' };
      expect(() => parseOAuthMetadata(insecure)).toThrow(/token_endpoint must use https/);
      expect(parseOAuthMetadata(insecure, { allowHttp: true }).tokenEndpoint).toBe('http://oauth.example.com/oauth/token');
    });

    it('rejects missing or malformed fields', () => {
      expect(() => parseOAuthMetadata(null)).toThrow(/not a JSON object/);
      expect(() => parseOAuthMetadata({ ...doc, issuer: undefined })).toThrow(/missing issuer/);
      expect(() => parseOAuthMetadata({ ...doc, authorization_endpoint: undefined })).toThrow(/missing authorization_endpoint/);
      expect(() => parseOAuthMetadata({ ...doc, token_endpoint: 'not a url' })).toThrow(/invalid token_endpoint/);
    });
  });

  describe('PKCE and state', () => {
    it('generates a 128-character verifier whose challenge is the S256 hash', () => {
      const { verifier, challenge } = generatePkce();
      expect(verifier).toMatch(/^[A-Za-z0-9_-]{128}$/);
      expect(challenge).toBe(crypto.createHash('sha256').update(verifier).digest('base64url'));
    });

    it('generates unique values', () => {
      expect(generatePkce().verifier).not.toBe(generatePkce().verifier);
      expect(generateState()).not.toBe(generateState());
      expect(generateState()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });
  });

  describe('buildRedirectUri', () => {
    it('uses the loopback address the client is registered with', () => {
      expect(buildRedirectUri('127.0.0.1', 41234)).toBe('http://127.0.0.1:41234/callback');
      expect(buildRedirectUri('::1', 41234)).toBe('http://[::1]:41234/callback');
    });
  });

  describe('buildAuthorizeUrl', () => {
    it('builds the authorization code request for openshift-cli-client', () => {
      const url = new URL(
        buildAuthorizeUrl(metadata, { redirectUri: 'http://127.0.0.1:5000/callback', state: 's', challenge: 'c' })
      );
      expect(url.origin + url.pathname).toBe(metadata.authorizationEndpoint);
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('client_id')).toBe(OPENSHIFT_CLI_CLIENT_ID);
      expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:5000/callback');
      expect(url.searchParams.get('state')).toBe('s');
      expect(url.searchParams.get('code_challenge')).toBe('c');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.has('scope')).toBe(false);
    });

    it('omits the PKCE parameters when no challenge is given', () => {
      const url = new URL(buildAuthorizeUrl(metadata, { redirectUri: 'http://127.0.0.1:5000/callback', state: 's' }));
      expect(url.searchParams.has('code_challenge')).toBe(false);
      expect(url.searchParams.has('code_challenge_method')).toBe(false);
    });
  });

  describe('parseCallback', () => {
    it('returns the code when the state matches', () => {
      expect(parseCallback('?code=abc&state=expected', 'expected')).toEqual({ kind: 'code', code: 'abc' });
    });

    it('treats a missing or different state as a mismatch, even with an error', () => {
      expect(parseCallback('?code=abc', 'expected')).toEqual({ kind: 'state-mismatch' });
      expect(parseCallback('?code=abc&state=other', 'expected')).toEqual({ kind: 'state-mismatch' });
      expect(parseCallback('?error=access_denied&state=other', 'expected')).toEqual({ kind: 'state-mismatch' });
    });

    it('reports an OAuth error with a sanitized description', () => {
      const outcome = parseCallback(
        `?error=access_denied&error_description=${encodeURIComponent('no\nway\u0007' + 'x'.repeat(500))}&state=expected`,
        'expected'
      );
      expect(outcome.kind).toBe('error');
      if (outcome.kind === 'error') {
        expect(outcome.message).toContain('access_denied');
        expect(outcome.message.includes('\n')).toBe(false);
        expect(outcome.message.includes('\u0007')).toBe(false);
        expect(outcome.message.length).toBeLessThan(260);
      }
    });

    it('reports a missing code', () => {
      expect(parseCallback('?state=expected', 'expected')).toEqual({
        kind: 'error',
        message: 'OpenShift sign-in did not return an authorization code',
      });
    });
  });

  describe('buildTokenRequest', () => {
    it('sends a form body and authenticates the public client with an empty secret', () => {
      const { body, authorization } = buildTokenRequest({
        code: 'abc',
        redirectUri: 'http://127.0.0.1:5000/callback',
        verifier: 'ver',
      });
      const params = new URLSearchParams(body);
      expect(params.get('grant_type')).toBe('authorization_code');
      expect(params.get('code')).toBe('abc');
      expect(params.get('redirect_uri')).toBe('http://127.0.0.1:5000/callback');
      expect(params.get('code_verifier')).toBe('ver');
      expect(authorization).toBe(`Basic ${Buffer.from('openshift-cli-client:').toString('base64')}`);
    });

    it('omits code_verifier without PKCE', () => {
      const { body } = buildTokenRequest({ code: 'abc', redirectUri: 'http://127.0.0.1:5000/callback' });
      expect(new URLSearchParams(body).has('code_verifier')).toBe(false);
    });
  });

  describe('parseTokenResponse', () => {
    it('returns the token and an expiry derived from expires_in', () => {
      const now = Date.UTC(2026, 0, 1, 12, 0, 0);
      expect(parseTokenResponse({ access_token: 'sha256~abc', token_type: 'Bearer', expires_in: 86400 }, now)).toEqual({
        accessToken: 'sha256~abc',
        expiresAt: '2026-01-02T12:00:00.000Z',
      });
    });

    it('omits the expiry when the server does not report one', () => {
      expect(parseTokenResponse({ access_token: 'sha256~abc' })).toEqual({ accessToken: 'sha256~abc' });
    });

    it('rejects error responses, missing tokens and unsupported token types', () => {
      expect(() => parseTokenResponse({ error: 'invalid_grant', error_description: 'expired' })).toThrow(/invalid_grant/);
      expect(() => parseTokenResponse({})).toThrow(/did not return an access token/);
      expect(() => parseTokenResponse({ access_token: 'x', token_type: 'mac' })).toThrow(/unsupported token type/);
      expect(() => parseTokenResponse('nope')).toThrow(/unexpected response/);
    });
  });
});
