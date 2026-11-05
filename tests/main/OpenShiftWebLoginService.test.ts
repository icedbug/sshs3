import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { OpenShiftWebLoginService } from '../../src/main/services/OpenShiftWebLoginService';

interface MockOptions {
  advertiseS256?: boolean;
  tokenStatus?: number;
  tokenBody?: unknown;
  metadataStatus?: number;
}

interface TokenCall {
  authorization?: string;
  params: URLSearchParams;
}

/**
 * Mimics the OpenShift OAuth server behaviour read from the source: public
 * client `openshift-cli-client` registered with loopback redirect URIs that
 * match regardless of port, code exchange authenticated with HTTP Basic and an
 * empty secret, PKCE verified against the challenge from the authorize call.
 */
async function startMockOAuth(options: MockOptions = {}) {
  const tokenCalls: TokenCall[] = [];
  const codes = new Map<string, string | undefined>();
  let baseUrl = '';

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', baseUrl);
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      if (options.metadataStatus && options.metadataStatus !== 200) {
        res.writeHead(options.metadataStatus).end('nope');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          issuer: baseUrl,
          authorization_endpoint: `${baseUrl}/oauth/authorize`,
          token_endpoint: `${baseUrl}/oauth/token`,
          ...(options.advertiseS256 === false ? {} : { code_challenge_methods_supported: ['plain', 'S256'] }),
        })
      );
      return;
    }
    if (url.pathname === '/oauth/token' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const params = new URLSearchParams(raw);
        tokenCalls.push({ authorization: req.headers.authorization, params });
        const expectedAuth = `Basic ${Buffer.from('openshift-cli-client:').toString('base64')}`;
        const challenge = codes.get(params.get('code') ?? '');
        const hasCode = codes.has(params.get('code') ?? '');
        const verifier = params.get('code_verifier');
        const pkceOk = challenge === undefined
          ? verifier === null
          : verifier !== null && crypto.createHash('sha256').update(verifier).digest('base64url') === challenge;
        if (options.tokenStatus && options.tokenStatus !== 200) {
          res.writeHead(options.tokenStatus, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(options.tokenBody ?? { error: 'unauthorized_client' }));
          return;
        }
        if (req.headers.authorization !== expectedAuth || !hasCode || !pkceOk || params.get('grant_type') !== 'authorization_code') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(options.tokenBody ?? { access_token: 'sha256~issued', token_type: 'Bearer', expires_in: 86400 }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    server,
    baseUrl,
    tokenCalls,
    /** What the OAuth server does once the user has signed in: validate the request and issue a code. */
    authorize(authorizeUrl: string): { redirect: string; code: string } {
      const url = new URL(authorizeUrl);
      expect(url.searchParams.get('client_id')).toBe('openshift-cli-client');
      expect(url.searchParams.get('response_type')).toBe('code');
      const redirectUri = new URL(url.searchParams.get('redirect_uri') ?? '');
      // Registered URIs are http://127.0.0.1/callback and http://[::1]/callback; the port is ignored.
      expect(['127.0.0.1', '[::1]']).toContain(redirectUri.hostname === '::1' ? '[::1]' : redirectUri.hostname);
      expect(redirectUri.pathname).toBe('/callback');
      const code = `code-${crypto.randomBytes(4).toString('hex')}`;
      codes.set(code, url.searchParams.get('code_challenge') ?? undefined);
      const redirect = new URL(redirectUri.toString());
      redirect.searchParams.set('code', code);
      redirect.searchParams.set('state', url.searchParams.get('state') ?? '');
      return { redirect: redirect.toString(), code };
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function httpGet(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, { headers }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

describe('OpenShiftWebLoginService', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (closers.length) await closers.pop()!();
  });

  async function setup(options?: MockOptions) {
    const mock = await startMockOAuth(options);
    closers.push(mock.close);
    const service = new OpenShiftWebLoginService({ allowHttp: true, callbackTimeoutMs: 600, requestTimeoutMs: 2000 });
    return { mock, service };
  }

  describe('probe', () => {
    it('reports support when the OAuth metadata is served', async () => {
      const { mock, service } = await setup();
      await expect(service.probe(mock.baseUrl)).resolves.toEqual({ supported: true });
    });

    it('reports no support (and never throws) for 404, non-JSON and unreachable servers', async () => {
      const { mock, service } = await setup({ metadataStatus: 404 });
      expect((await service.probe(mock.baseUrl)).supported).toBe(false);

      const html = http.createServer((_req, res) => res.end('<html>console</html>'));
      await new Promise<void>((resolve) => html.listen(0, '127.0.0.1', () => resolve()));
      closers.push(() => new Promise<void>((resolve) => html.close(() => resolve())));
      const htmlUrl = `http://127.0.0.1:${(html.address() as AddressInfo).port}`;
      expect((await service.probe(htmlUrl)).supported).toBe(false);

      expect((await service.probe('http://127.0.0.1:1')).supported).toBe(false);
    });

    it('does not accept plain http in production mode', async () => {
      const { mock } = await setup();
      const strict = new OpenShiftWebLoginService();
      const result = await strict.probe(mock.baseUrl);
      expect(result.supported).toBe(false);
    });
  });

  describe('login', () => {
    it('completes the authorization code flow with PKCE and returns the token', async () => {
      const { mock, service } = await setup();
      const result = await service.login(
        { server: mock.baseUrl },
        {
          onAuthorizeUrl: (url) => {
            const { redirect } = mock.authorize(url);
            void httpGet(redirect);
          },
        }
      );
      expect(result.token).toBe('sha256~issued');
      expect(result.expiresAt).toBeDefined();
      expect(mock.tokenCalls).toHaveLength(1);
      expect(mock.tokenCalls[0].params.get('code_verifier')).toHaveLength(128);
    });

    it('runs without PKCE when the server does not advertise S256', async () => {
      const { mock, service } = await setup({ advertiseS256: false });
      let authorizeUrl = '';
      const result = await service.login(
        { server: mock.baseUrl },
        {
          onAuthorizeUrl: (url) => {
            authorizeUrl = url;
            void httpGet(mock.authorize(url).redirect);
          },
        }
      );
      expect(result.token).toBe('sha256~issued');
      expect(new URL(authorizeUrl).searchParams.has('code_challenge')).toBe(false);
      expect(mock.tokenCalls[0].params.has('code_verifier')).toBe(false);
    });

    it('ignores callbacks with a wrong state and still accepts the real one', async () => {
      const { mock, service } = await setup();
      const result = await service.login(
        { server: mock.baseUrl },
        {
          onAuthorizeUrl: (url) => {
            const { redirect } = mock.authorize(url);
            const forged = new URL(redirect);
            forged.searchParams.set('state', 'forged');
            void (async () => {
              const bad = await httpGet(forged.toString());
              expect(bad.status).toBe(400);
              await httpGet(redirect);
            })();
          },
        }
      );
      expect(result.token).toBe('sha256~issued');
    });

    it('rejects a callback addressed to another host name and only handles /callback', async () => {
      const { mock, service } = await setup();
      const result = await service.login(
        { server: mock.baseUrl },
        {
          onAuthorizeUrl: (url) => {
            const { redirect } = mock.authorize(url);
            void (async () => {
              const rebind = await httpGet(redirect, { Host: 'evil.example.com' });
              expect(rebind.status).toBe(400);
              const other = await httpGet(redirect.replace('/callback', '/elsewhere'));
              expect(other.status).toBe(404);
              await httpGet(redirect);
            })();
          },
        }
      );
      expect(result.token).toBe('sha256~issued');
    });

    it('closes the callback server once the flow is done', async () => {
      const { mock, service } = await setup();
      let redirectUrl = '';
      await service.login(
        { server: mock.baseUrl },
        {
          onAuthorizeUrl: (url) => {
            redirectUrl = mock.authorize(url).redirect;
            void httpGet(redirectUrl);
          },
        }
      );
      // The callback server is closed after the flow, so a replay cannot reach it any more.
      await expect(httpGet(redirectUrl)).rejects.toBeDefined();
    });

    it('surfaces an OAuth error from the callback', async () => {
      const { mock, service } = await setup();
      await expect(
        service.login(
          { server: mock.baseUrl },
          {
            onAuthorizeUrl: (url) => {
              const { redirect } = mock.authorize(url);
              const denied = new URL(redirect);
              denied.searchParams.delete('code');
              denied.searchParams.set('error', 'access_denied');
              void httpGet(denied.toString());
            },
          }
        )
      ).rejects.toThrow(/access_denied/);
    });

    it('surfaces token endpoint failures without leaking the code', async () => {
      const { mock, service } = await setup({ tokenStatus: 401, tokenBody: { error: 'unauthorized_client' } });
      await expect(
        service.login(
          { server: mock.baseUrl },
          { onAuthorizeUrl: (url) => void httpGet(mock.authorize(url).redirect) }
        )
      ).rejects.toThrow(/unauthorized_client/);
    });

    it('times out when the browser never calls back', async () => {
      const { mock, service } = await setup();
      await expect(service.login({ server: mock.baseUrl }, { onAuthorizeUrl: () => {} })).rejects.toThrow(
        /Timed out waiting for the browser sign-in/
      );
    });

    it('can be cancelled while waiting for the browser', async () => {
      const { mock, service } = await setup();
      const promise = service.login({ server: mock.baseUrl }, { onAuthorizeUrl: () => setTimeout(() => service.cancel(), 20) });
      await expect(promise).rejects.toThrow(/cancelled/);
    });

    it('can be cancelled through the abort signal', async () => {
      const { mock, service } = await setup();
      const controller = new AbortController();
      const promise = service.login(
        { server: mock.baseUrl },
        { onAuthorizeUrl: () => setTimeout(() => controller.abort(), 20), signal: controller.signal }
      );
      await expect(promise).rejects.toThrow(/cancelled/);
    });

    it('fails with guidance when the cluster has no OAuth server', async () => {
      const { mock, service } = await setup({ metadataStatus: 404 });
      await expect(service.login({ server: mock.baseUrl }, { onAuthorizeUrl: () => {} })).rejects.toThrow(
        /OpenShift 4\.13 or newer/
      );
    });

    it('reports a port that is already in use', async () => {
      const { mock, service } = await setup();
      const blocker = http.createServer();
      await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve()));
      closers.push(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
      const port = (blocker.address() as AddressInfo).port;
      await expect(
        service.login({ server: mock.baseUrl, callbackPort: port }, { onAuthorizeUrl: () => {} })
      ).rejects.toThrow(/already in use/);
    });
  });
});
