import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SshCaService } from '../../src/main/ca/SshCaService';
import { computeOpenSshFingerprint } from '../../src/main/ca/sshCertificateUtils';
import { exportSshWirePublicKey } from '../../src/main/ca/sshPublicKeyFormat';
import type { SshCaConfig, ISshCaProvider, SshCaSignRequest, SshCaSignResponse } from '../../src/shared/types/sshCa';
import { buildUserCertificate, type TestCertificate } from '../helpers/sshTestCert';

describe('SshCaService', () => {
  let mockOidcServer: http.Server;
  let oidcBaseUrl = '';
  const issued: TestCertificate[] = [];
  /** Nonce of the latest authorization request; the mock IdP echoes it in the id_token like a real one. */
  let idpNonce = '';
  /** Test hook: a different nonce for the id_token, or null to leave the claim out. */
  let idpNonceOverride: string | null | undefined;

  /** Acts as the CA: issues a valid user certificate for exactly the key it was asked to sign. */
  const issueCert = (req: SshCaSignRequest): SshCaSignResponse => {
    const cert = buildUserCertificate({ subjectWireBase64: req.publicKeyWireBase64 });
    issued.push(cert);
    return { certificateWireBase64: cert.wireBase64, certificateLine: cert.line };
  };

  /** Fake app agent; pass overrides to make a call fail or to record ordering. */
  const makeAgent = (overrides: Record<string, unknown> = {}) =>
    ({
      addCertifiedEd25519Key: vi.fn().mockResolvedValue(undefined),
      removeIdentities: vi.fn().mockResolvedValue(0),
      ...overrides,
    }) as any;

  /** Plays the user's browser: follows the authorization URL and delivers the loopback redirect. */
  const completeBrowserLogin = () =>
    vi.fn().mockImplementation(async (targetUrl: string) => {
      const parsedUrl = new URL(targetUrl);
      idpNonce = parsedUrl.searchParams.get('nonce') ?? '';
      const cbUrl = new URL(parsedUrl.searchParams.get('redirect_uri')!);
      cbUrl.searchParams.set('code', 'test-auth-code');
      cbUrl.searchParams.set('state', parsedUrl.searchParams.get('state')!);
      http.get(cbUrl.toString());
    });

  const ephemeralConfig = (): SshCaConfig => ({
    id: 'cfg-1',
    name: 'Test Step CA',
    backend: 'step-ca',
    caUrl: 'https://ca.example.com',
    oidcIssuerUrl: oidcBaseUrl,
    oidcClientId: 'step-ca',
    keySource: 'ephemeral',
    defaultPrincipals: ['alun'],
  });

  beforeEach(async () => {
    issued.length = 0;
    idpNonce = '';
    idpNonceOverride = undefined;
    // Start mock OIDC server
    mockOidcServer = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', oidcBaseUrl);

      if (url.pathname === '/.well-known/openid-configuration') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            issuer: oidcBaseUrl,
            authorization_endpoint: `${oidcBaseUrl}/auth`,
            token_endpoint: `${oidcBaseUrl}/token`,
          })
        );
        return;
      }

      if (url.pathname === '/token' && req.method === 'POST') {
        // Construct dummy JWT with user claims; a real IdP echoes the nonce of the authorization request
        const nonceClaim = idpNonceOverride === undefined ? idpNonce : idpNonceOverride;
        const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
        const payload = Buffer.from(
          JSON.stringify({
            sub: 'user-123',
            preferred_username: 'alun',
            email: 'alun@alun.se',
            ...(nonceClaim === null ? {} : { nonce: nonceClaim }),
          })
        ).toString('base64url');
        const idToken = `${header}.${payload}.signature`;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id_token: idToken,
            access_token: 'dummy-access',
            refresh_token: 'dummy-refresh',
            expires_in: 3600,
          })
        );
        return;
      }

      res.writeHead(404).end();
    });

    await new Promise<void>((resolve) => {
      mockOidcServer.listen(0, '127.0.0.1', () => {
        const addr = mockOidcServer.address() as AddressInfo;
        oidcBaseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => mockOidcServer.close(() => resolve()));
  });

  it('starts inactive and reports inactive status', () => {
    const mockAppAgent = makeAgent();

    const service = new SshCaService({ appAgent: mockAppAgent });
    const status = service.getStatus();
    expect(status.active).toBe(false);
  });

  it('executes login flow, signs cert, loads key into agent, and updates status', async () => {
    const mockAppAgent = makeAgent();

    const mockProvider: ISshCaProvider = {
      id: 'step-ca',
      sign: vi.fn().mockImplementation(async (req: SshCaSignRequest): Promise<SshCaSignResponse> => {
        expect(req.username).toBe('alun');
        expect(req.keyType).toBe('ssh-ed25519');
        return issueCert(req);
      }),
    };

    const openExternal = completeBrowserLogin();

    const testConfig = ephemeralConfig();

    const service = new SshCaService({
      appAgent: mockAppAgent,
      openExternal,
      providers: new Map([['step-ca', mockProvider]]),
    });

    const statusList: boolean[] = [];
    service.onStatusChanged((s) => statusList.push(s.active));

    const status = await service.login(testConfig);
    expect(status.active).toBe(true);
    expect(status.username).toBe('alun');
    expect(status.principals).toEqual(['alun', 'alun@alun.se']);
    expect(openExternal.mock.calls[0][0]).toContain('/auth?client_id=step-ca');
    expect(mockAppAgent.addCertifiedEd25519Key).toHaveBeenCalledTimes(1);
    expect(statusList).toContain(true);

    // Test logout
    await service.logout();
    const expectedCertFp = computeOpenSshFingerprint(issued[0].wire);
    expect(mockAppAgent.removeIdentities).toHaveBeenCalledWith([expectedCertFp]);
    expect(service.getStatus().active).toBe(false);
  });

  it('renews session using refresh token without prompting in browser', async () => {
    const mockAppAgent = makeAgent();

    const mockProvider: ISshCaProvider = {
      id: 'step-ca',
      sign: vi.fn().mockImplementation(async (req: SshCaSignRequest): Promise<SshCaSignResponse> => issueCert(req)),
    };

    const openExternal = completeBrowserLogin();

    const testConfig = ephemeralConfig();

    const service = new SshCaService({
      appAgent: mockAppAgent,
      openExternal,
      providers: new Map([['step-ca', mockProvider]]),
    });

    await service.login(testConfig);
    expect(openExternal).toHaveBeenCalledTimes(1);

    // Renew
    const renewed = await service.renew();
    expect(renewed.active).toBe(true);
    // Should NOT have opened the browser again because refresh token succeeded!
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(mockAppAgent.addCertifiedEd25519Key).toHaveBeenCalledTimes(2);
  });

  it('signs PIV key without loading private key into agent, writes certificate file and cleans up on logout', async () => {
    const fs = await import('node:fs');
    const mockAppAgent = makeAgent();

    const pivKeyInfo = exportSshWirePublicKey(
      crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey,
      'YubiKey PIV'
    );

    const mockProvider: ISshCaProvider = {
      id: 'step-ca',
      sign: vi.fn().mockImplementation(async (req: SshCaSignRequest): Promise<SshCaSignResponse> => {
        expect(req.username).toBe('alun');
        expect(req.keyType).toBe('ecdsa-sha2-nistp256');
        expect(req.publicKeyWireBase64).toBe(pivKeyInfo.wireBase64);
        return issueCert(req);
      }),
    };

    const openExternal = completeBrowserLogin();

    const getPivPublicKey = vi.fn().mockResolvedValue(pivKeyInfo);

    const pivConfig: SshCaConfig = {
      id: 'cfg-piv',
      name: 'Test PIV CA',
      backend: 'step-ca',
      caUrl: 'https://ca.example.com',
      oidcIssuerUrl: oidcBaseUrl,
      oidcClientId: 'step-ca',
      keySource: 'piv',
      defaultPrincipals: ['alun'],
    };

    const service = new SshCaService({
      appAgent: mockAppAgent,
      openExternal,
      getPivPublicKey,
      providers: new Map([['step-ca', mockProvider]]),
    });

    const status = await service.login(pivConfig);
    expect(status.active).toBe(true);
    expect(getPivPublicKey).toHaveBeenCalledTimes(1);
    // Crucial: addCertifiedEd25519Key must NOT be called for PIV since the private key is in the card!
    expect(mockAppAgent.addCertifiedEd25519Key).not.toHaveBeenCalled();

    // Verify certificate file was written
    const certPath = service.getActiveCertificateFilePath();
    expect(certPath).toBeDefined();
    expect(fs.existsSync(certPath!)).toBe(true);
    const content = fs.readFileSync(certPath!, 'utf-8');
    expect(content).toContain(issued[0].line);

    // Verify logout removes certificate file
    await service.logout();
    expect(fs.existsSync(certPath!)).toBe(false);
    expect(service.getActiveCertificateFilePath()).toBeUndefined();
    expect(service.getStatus().active).toBe(false);
  });

  it('rejects PIV login when no PIV card is detected', async () => {
    const mockAppAgent = makeAgent();
    const getPivPublicKey = vi.fn().mockResolvedValue(null);

    const pivConfig: SshCaConfig = {
      id: 'cfg-piv',
      name: 'Test PIV CA',
      backend: 'step-ca',
      caUrl: 'https://ca.example.com',
      oidcIssuerUrl: oidcBaseUrl,
      oidcClientId: 'step-ca',
      keySource: 'piv',
    };

    const service = new SshCaService({
      appAgent: mockAppAgent,
      getPivPublicKey,
    });

    await expect(service.login(pivConfig)).rejects.toThrow(/No smartcard detected/);
  });

  it('returns undefined for active certificate file path when certificate is expired', async () => {
    const mockAppAgent = makeAgent();
    const service = new SshCaService({ appAgent: mockAppAgent });

    // Manually set an active session with an expired cert date
    (service as any).activeSession = {
      config: { id: 'c1' },
      username: 'alun',
      principals: ['alun'],
      parsedCert: {
        validBefore: '2020-01-01T00:00:00.000Z',
      },
      certificateFilePath: '/tmp/expired-cert.pub',
    };

    expect(service.getActiveCertificateFilePath()).toBeUndefined();
    expect(service.getStatus().active).toBe(false);
  });

  it('rejects authorization_endpoint with non-http/https protocol', async () => {
    const mockAppAgent = makeAgent();

    // Spin up server with invalid authorization_endpoint
    const badOidcServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          authorization_endpoint: 'javascript:alert(1)',
          token_endpoint: 'http://127.0.0.1:9999/token',
        })
      );
    });

    await new Promise<void>((resolve) => badOidcServer.listen(0, '127.0.0.1', () => resolve()));
    const port = (badOidcServer.address() as any).port;

    const service = new SshCaService({
      appAgent: mockAppAgent,
    });

    try {
      await expect(
        service.login({
          id: 'bad-proto',
          name: 'Bad Proto',
          backend: 'step-ca',
          caUrl: 'https://ca.example.com',
          oidcIssuerUrl: `http://127.0.0.1:${port}`,
          oidcClientId: 'client',
          keySource: 'ephemeral',
        })
      ).rejects.toThrow(/Insecure or invalid authorization_endpoint protocol/);
    } finally {
      badOidcServer.close();
    }
  });
  describe('certificate installation', () => {
    it('rejects a certificate issued for a different key than the one requested', async () => {
      const otherKey = exportSshWirePublicKey(crypto.generateKeyPairSync('ed25519').publicKey, 'other');
      const mockAppAgent = makeAgent();
      const provider: ISshCaProvider = {
        id: 'step-ca',
        sign: vi.fn().mockImplementation(async (): Promise<SshCaSignResponse> => {
          const cert = buildUserCertificate({ subjectWireBase64: otherKey.wireBase64 });
          return { certificateWireBase64: cert.wireBase64, certificateLine: cert.line };
        }),
      };
      const service = new SshCaService({
        appAgent: mockAppAgent,
        openExternal: completeBrowserLogin(),
        providers: new Map([['step-ca', provider]]),
      });

      await expect(service.login(ephemeralConfig())).rejects.toThrow(/public key mismatch/);
      expect(mockAppAgent.addCertifiedEd25519Key).not.toHaveBeenCalled();
      expect(service.getStatus().active).toBe(false);
    });

    it.each([
      ['carries a different nonce', 'attacker-chosen-nonce'],
      ['carries no nonce claim at all', null],
    ])('rejects an id_token that %s than the sign-in request', async (_label, nonceInToken) => {
      idpNonceOverride = nonceInToken;
      const mockAppAgent = makeAgent();
      const provider: ISshCaProvider = { id: 'step-ca', sign: vi.fn() };
      const service = new SshCaService({
        appAgent: mockAppAgent,
        openExternal: completeBrowserLogin(),
        providers: new Map([['step-ca', provider]]),
      });

      await expect(service.login(ephemeralConfig())).rejects.toThrow(/nonce/);

      expect(provider.sign).not.toHaveBeenCalled();
      expect(mockAppAgent.addCertifiedEd25519Key).not.toHaveBeenCalled();
      expect(service.getStatus().active).toBe(false);
    });

    it('keeps the working identity when installing the replacement certificate fails', async () => {
      const mockAppAgent = {
        addCertifiedEd25519Key: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error('agent gone')),
        removeIdentities: vi.fn().mockResolvedValue(0),
      } as any;
      const provider: ISshCaProvider = { id: 'step-ca', sign: vi.fn().mockImplementation(async (r: SshCaSignRequest) => issueCert(r)) };
      const service = new SshCaService({
        appAgent: mockAppAgent,
        openExternal: completeBrowserLogin(),
        providers: new Map([['step-ca', provider]]),
      });

      await service.login(ephemeralConfig());
      const before = service.getStatus();
      await expect(service.renew()).rejects.toThrow(/agent gone/);

      expect(mockAppAgent.removeIdentities).not.toHaveBeenCalled();
      const after = service.getStatus();
      expect(after.active).toBe(true);
      expect(after.certInfo?.serial).toBe(before.certInfo?.serial);
    });

    it('evicts the previous agent identity only after the new certificate is installed', async () => {
      const calls: string[] = [];
      const mockAppAgent = {
        addCertifiedEd25519Key: vi.fn().mockImplementation(async () => void calls.push('add')),
        removeIdentities: vi.fn().mockImplementation(async () => void calls.push('remove')),
      } as any;
      const provider: ISshCaProvider = { id: 'step-ca', sign: vi.fn().mockImplementation(async (r: SshCaSignRequest) => issueCert(r)) };
      const service = new SshCaService({
        appAgent: mockAppAgent,
        openExternal: completeBrowserLogin(),
        providers: new Map([['step-ca', provider]]),
      });

      await service.login(ephemeralConfig());
      await service.renew();

      expect(calls).toEqual(['add', 'add', 'remove']);
      expect(mockAppAgent.removeIdentities).toHaveBeenCalledWith([computeOpenSshFingerprint(issued[0].wire)]);
      await service.logout();
    });

    it('keeps the PIV certificate file in place when it is renewed (same path every time)', async () => {
      const fs = await import('node:fs');
      const pivKey = exportSshWirePublicKey(crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey, 'piv');
      const mockAppAgent = makeAgent();
      const provider: ISshCaProvider = { id: 'step-ca', sign: vi.fn().mockImplementation(async (r: SshCaSignRequest) => issueCert(r)) };
      const service = new SshCaService({
        appAgent: mockAppAgent,
        openExternal: completeBrowserLogin(),
        getPivPublicKey: vi.fn().mockResolvedValue(pivKey),
        providers: new Map([['step-ca', provider]]),
      });

      await service.login({ ...ephemeralConfig(), keySource: 'piv' });
      const firstPath = service.getActiveCertificateFilePath()!;
      await service.renew();

      expect(service.getActiveCertificateFilePath()).toBe(firstPath);
      expect(fs.readFileSync(firstPath, 'utf-8')).toBe(issued[1].line + '\n');
      expect(fs.readdirSync(path.dirname(firstPath)).filter((f) => f.endsWith('.tmp'))).toEqual([]);

      await service.logout();
      expect(fs.existsSync(firstPath)).toBe(false);
    });

    it('does not leave the loopback callback server listening when opening the browser fails', async () => {
      const mockAppAgent = makeAgent();
      let callbackPort = 0;
      const openExternal = vi.fn().mockImplementation(async (targetUrl: string) => {
        callbackPort = Number(new URL(new URL(targetUrl).searchParams.get('redirect_uri')!).port);
        throw new Error('no browser available');
      });
      const service = new SshCaService({ appAgent: mockAppAgent, openExternal });

      await expect(service.login(ephemeralConfig())).rejects.toThrow(/no browser available/);

      expect(callbackPort).toBeGreaterThan(0);
      const net = await import('node:net');
      const code = await new Promise<string>((resolve) => {
        const sock = net.connect(callbackPort, '127.0.0.1');
        sock.once('connect', () => { sock.destroy(); resolve('CONNECTED'); });
        sock.once('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? 'ERR'));
      });
      expect(code).toBe('ECONNREFUSED');
    });

    it('does not start a callback server for an insecure authorization_endpoint', async () => {
      const mockAppAgent = makeAgent();
      const insecure = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ authorization_endpoint: 'ftp://idp.example.com/auth', token_endpoint: 'https://idp.example.com/token' }));
      });
      await new Promise<void>((resolve) => insecure.listen(0, '127.0.0.1', () => resolve()));
      const port = (insecure.address() as AddressInfo).port;
      const openExternal = vi.fn();
      const service = new SshCaService({ appAgent: mockAppAgent, openExternal });
      try {
        await expect(
          service.login({ ...ephemeralConfig(), oidcIssuerUrl: `http://127.0.0.1:${port}` })
        ).rejects.toThrow(/Insecure or invalid authorization_endpoint/);
        expect(openExternal).not.toHaveBeenCalled();
      } finally {
        insecure.close();
      }
    });

    it('does not treat a lookalike host as loopback (no plain-http OIDC discovery)', async () => {
      const mockAppAgent = makeAgent();
      const service = new SshCaService({ appAgent: mockAppAgent, openExternal: vi.fn() });
      await expect(
        service.login({ ...ephemeralConfig(), oidcIssuerUrl: 'http://localhost.invalid' })
      ).rejects.toThrow(/https/i);
    });

    describe('serialised operations', () => {
      const newProvider = (onSign?: () => Promise<void>): ISshCaProvider => ({
        id: 'step-ca',
        sign: vi.fn().mockImplementation(async (r: SshCaSignRequest) => {
          await onSign?.();
          return issueCert(r);
        }),
      });
      const hangingBrowser = () => vi.fn().mockImplementation(async () => {});
      const until = async (predicate: () => boolean) => {
        for (let i = 0; i < 200 && !predicate(); i++) await new Promise((r) => setTimeout(r, 10));
        expect(predicate()).toBe(true);
      };

      it('never runs two sign-ins at the same time', async () => {
        let running = 0;
        let maxRunning = 0;
        const provider = newProvider(async () => {
          running++;
          maxRunning = Math.max(maxRunning, running);
          await new Promise((r) => setTimeout(r, 30));
          running--;
        });
        const mockAppAgent = makeAgent();
        const service = new SshCaService({
          appAgent: mockAppAgent,
          openExternal: completeBrowserLogin(),
          providers: new Map([['step-ca', provider]]),
        });

        await Promise.all([service.login(ephemeralConfig()), service.login(ephemeralConfig())]);

        expect(maxRunning).toBe(1);
        expect(mockAppAgent.addCertifiedEd25519Key).toHaveBeenCalledTimes(2);
        // The first identity was evicted once the second was in place; exactly one remains.
        expect(mockAppAgent.removeIdentities).toHaveBeenCalledTimes(1);
        expect(mockAppAgent.removeIdentities).toHaveBeenCalledWith([computeOpenSshFingerprint(issued[0].wire)]);
        await service.logout();
      });

      it('logout cancels a pending browser sign-in and the user stays logged out', async () => {
        const mockAppAgent = makeAgent();
        const openExternal = hangingBrowser();
        const service = new SshCaService({
          appAgent: mockAppAgent,
          openExternal,
          providers: new Map([['step-ca', newProvider()]]),
        });

        const login = service.login(ephemeralConfig());
        const loginOutcome = login.then(() => 'resolved', (e: Error) => e.message);
        await until(() => openExternal.mock.calls.length === 1);

        await service.logout();

        expect(await loginOutcome).toMatch(/cancel/i);
        expect(mockAppAgent.addCertifiedEd25519Key).not.toHaveBeenCalled();
        expect(service.getStatus().active).toBe(false);
      });

      it('logout drops sign-ins that were still queued behind the running one', async () => {
        const mockAppAgent = makeAgent();
        const openExternal = hangingBrowser();
        const service = new SshCaService({
          appAgent: mockAppAgent,
          openExternal,
          providers: new Map([['step-ca', newProvider()]]),
        });

        const first = service.login(ephemeralConfig()).catch((e: Error) => e.message);
        await until(() => openExternal.mock.calls.length === 1);
        const queued = service.login(ephemeralConfig()).catch((e: Error) => e.message);

        await service.logout();

        expect(await first).toMatch(/cancel/i);
        expect(await queued).toMatch(/cancel/i);
        expect(openExternal).toHaveBeenCalledTimes(1);
        expect(service.getStatus().active).toBe(false);
      });

      it('timer-driven renewal never falls back to an interactive browser sign-in', async () => {
        const mockAppAgent = makeAgent();
        const openExternal = completeBrowserLogin();
        const service = new SshCaService({
          appAgent: mockAppAgent,
          openExternal,
          providers: new Map([['step-ca', newProvider()]]),
        });
        await service.login(ephemeralConfig());
        expect(openExternal).toHaveBeenCalledTimes(1);

        // Make the silent refresh fail: the token endpoint answers 404.
        (service as any).activeSession.tokenEndpoint = `${oidcBaseUrl}/missing`;

        await expect((service as any).renewSilently()).rejects.toThrow(/Silent SSH CA renewal failed/);
        expect(openExternal).toHaveBeenCalledTimes(1);
        expect(service.getStatus().active).toBe(true);
        await service.logout();
      });

      it('manual renewal still falls back to an interactive sign-in when the refresh fails', async () => {
        const mockAppAgent = makeAgent();
        const openExternal = completeBrowserLogin();
        const service = new SshCaService({
          appAgent: mockAppAgent,
          openExternal,
          providers: new Map([['step-ca', newProvider()]]),
        });
        await service.login(ephemeralConfig());
        (service as any).activeSession.tokenEndpoint = `${oidcBaseUrl}/missing`;

        const status = await service.renew();

        expect(status.active).toBe(true);
        expect(openExternal).toHaveBeenCalledTimes(2);
        await service.logout();
      });
    });
  });
});
