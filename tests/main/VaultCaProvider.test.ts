import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { VaultCaProvider } from '../../src/main/ca/providers/VaultCaProvider';
import type { SshCaConfig, SshCaSignRequest } from '../../src/shared/types/sshCa';

describe('VaultCaProvider', () => {
  let mockServer: http.Server;
  let serverBaseUrl = '';
  const receivedRequests: Array<{ url: string; method: string; headers: http.IncomingHttpHeaders; body: any }> = [];

  beforeEach(async () => {
    receivedRequests.length = 0;

    mockServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let body: any;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        } catch {
          body = null;
        }

        receivedRequests.push({
          url: req.url || '',
          method: req.method || '',
          headers: req.headers,
          body,
        });

        // Endpoint: /v1/auth/{mount}/login
        if (req.method === 'POST' && req.url?.startsWith('/v1/auth/') && req.url?.endsWith('/login')) {
          if (body?.jwt === 'invalid-jwt') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ errors: ['role "default" not allowed for token'] }));
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              auth: {
                client_token: 'vault-client-token-999',
                policies: ['default'],
              },
            })
          );
          return;
        }

        // Endpoint: /v1/{mount}/sign/{role}
        if (req.method === 'POST' && req.url?.includes('/sign/')) {
          if (req.headers['x-vault-token'] !== 'vault-client-token-999') {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ errors: ['permission denied: invalid token'] }));
            return;
          }

          if (body?.public_key === 'error-key') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ errors: ['key could not be parsed'] }));
            return;
          }

          if (body?.public_key?.includes('single-token')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                data: {
                  signed_key: 'dGVzdC1jZXJ0LWJsb2I=',
                },
              })
            );
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              data: {
                serial_number: '123456789',
                signed_key: 'ssh-ed25519-cert-v01@openssh.com dGVzdC1jZXJ0LWJsb2I= vault-user@example.com',
              },
            })
          );
          return;
        }

        // Endpoint: /v1/auth/token/revoke-self
        if (req.method === 'POST' && req.url === '/v1/auth/token/revoke-self') {
          res.writeHead(204).end();
          return;
        }

        res.writeHead(404).end();
      });
    });

    await new Promise<void>((resolve) => {
      mockServer.listen(0, '127.0.0.1', () => {
        const addr = mockServer.address() as AddressInfo;
        serverBaseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  });

  it('signs an SSH certificate using Vault JWT login, SSH secrets signing, and revokes token', async () => {
    const provider = new VaultCaProvider();
    const config: SshCaConfig = {
      id: 'vault-1',
      name: 'Vault Local',
      backend: 'vault',
      caUrl: serverBaseUrl,
      oidcIssuerUrl: 'http://127.0.0.1:8080',
      oidcClientId: 'vault-client',
      keySource: 'ephemeral',
    };

    const req: SshCaSignRequest = {
      publicKeyWireBase64: 'AAAAInNzaC1lZDI1NTE5AAAAIAD123',
      keyType: 'ssh-ed25519',
      publicKeyLine: 'ssh-ed25519 AAAAInNzaC1lZDI1NTE5AAAAIAD123 test@sshs3',
      identityToken: 'valid-jwt-token',
      username: 'alun',
      principals: ['alun', 'dev'],
    };

    const res = await provider.sign(req, config);
    expect(res.certificateWireBase64).toBe('dGVzdC1jZXJ0LWJsb2I=');
    expect(res.certificateLine).toBe('ssh-ed25519-cert-v01@openssh.com dGVzdC1jZXJ0LWJsb2I= vault-user@example.com');

    // Verify calls: login, sign, revoke-self
    expect(receivedRequests.length).toBe(3);

    const loginReq = receivedRequests[0];
    expect(loginReq.url).toBe('/v1/auth/jwt/login');
    expect(loginReq.body).toEqual({
      role: 'default',
      jwt: 'valid-jwt-token',
    });

    const signReq = receivedRequests[1];
    expect(signReq.url).toBe('/v1/ssh/sign/client');
    expect(signReq.headers['x-vault-token']).toBe('vault-client-token-999');
    expect(signReq.body).toEqual({
      public_key: 'ssh-ed25519 AAAAInNzaC1lZDI1NTE5AAAAIAD123 test@sshs3',
      cert_type: 'user',
      valid_principals: 'alun,dev',
    });

    const revokeReq = receivedRequests[2];
    expect(revokeReq.url).toBe('/v1/auth/token/revoke-self');
    expect(revokeReq.headers['x-vault-token']).toBe('vault-client-token-999');
  });

  it('supports custom mount paths, custom roles, and enterprise namespace', async () => {
    const provider = new VaultCaProvider();
    const config: SshCaConfig = {
      id: 'vault-2',
      name: 'Vault Custom',
      backend: 'vault',
      caUrl: serverBaseUrl,
      oidcIssuerUrl: 'http://127.0.0.1:8080',
      oidcClientId: 'vault-client',
      keySource: 'piv',
      vaultAuthPath: 'custom-jwt',
      vaultRole: 'custom-role',
      vaultSshMount: 'custom-ssh',
      vaultSshRole: 'custom-signer',
      vaultNamespace: 'my-corp/engineering',
    };

    const req: SshCaSignRequest = {
      publicKeyWireBase64: 'AAAAInNzaC1lZDI1NTE5AAAAIAD123',
      keyType: 'ssh-ed25519',
      publicKeyLine: 'ssh-ed25519 AAAAInNzaC1lZDI1NTE5AAAAIAD123 test@sshs3',
      identityToken: 'valid-jwt-token',
      username: 'alun',
    };

    const res = await provider.sign(req, config);
    expect(res.certificateWireBase64).toBe('dGVzdC1jZXJ0LWJsb2I=');

    expect(receivedRequests[0].url).toBe('/v1/auth/custom-jwt/login');
    expect(receivedRequests[0].headers['x-vault-namespace']).toBe('my-corp/engineering');
    expect(receivedRequests[0].body.role).toBe('custom-role');

    expect(receivedRequests[1].url).toBe('/v1/custom-ssh/sign/custom-signer');
    expect(receivedRequests[1].headers['x-vault-namespace']).toBe('my-corp/engineering');
  });

  it('handles single-token signed_key fallback format from Vault', async () => {
    const provider = new VaultCaProvider();
    const config: SshCaConfig = {
      id: 'vault-1',
      name: 'Vault Local',
      backend: 'vault',
      caUrl: serverBaseUrl,
      oidcIssuerUrl: 'http://127.0.0.1:8080',
      oidcClientId: 'vault-client',
      keySource: 'ephemeral',
    };

    const req: SshCaSignRequest = {
      publicKeyWireBase64: 'AAAAInNzaC1lZDI1NTE5AAAAIAD123',
      keyType: 'ssh-ed25519',
      publicKeyLine: 'single-token',
      identityToken: 'valid-jwt-token',
      username: 'alun',
    };

    const res = await provider.sign(req, config);
    expect(res.certificateWireBase64).toBe('dGVzdC1jZXJ0LWJsb2I=');
    expect(res.certificateLine).toBe('ssh-ed25519-cert-v01@openssh.com dGVzdC1jZXJ0LWJsb2I= sshs3-ca:alun');
  });

  it('fails with clear error message when Vault login fails', async () => {
    const provider = new VaultCaProvider();
    const config: SshCaConfig = {
      id: 'vault-1',
      name: 'Vault Local',
      backend: 'vault',
      caUrl: serverBaseUrl,
      oidcIssuerUrl: 'http://127.0.0.1:8080',
      oidcClientId: 'vault-client',
      keySource: 'ephemeral',
    };

    const req: SshCaSignRequest = {
      publicKeyWireBase64: 'AAAA',
      keyType: 'ssh-ed25519',
      publicKeyLine: 'ssh-ed25519 AAAA',
      identityToken: 'invalid-jwt',
      username: 'alun',
    };

    await expect(provider.sign(req, config)).rejects.toThrow(/Vault OIDC login failed: role "default" not allowed for token/);
  });

  it('fails with clear error message when Vault signing fails', async () => {
    const provider = new VaultCaProvider();
    const config: SshCaConfig = {
      id: 'vault-1',
      name: 'Vault Local',
      backend: 'vault',
      caUrl: serverBaseUrl,
      oidcIssuerUrl: 'http://127.0.0.1:8080',
      oidcClientId: 'vault-client',
      keySource: 'ephemeral',
    };

    const req: SshCaSignRequest = {
      publicKeyWireBase64: 'AAAA',
      keyType: 'ssh-ed25519',
      publicKeyLine: 'error-key',
      identityToken: 'valid-jwt-token',
      username: 'alun',
    };

    await expect(provider.sign(req, config)).rejects.toThrow(/Vault SSH key signing failed: key could not be parsed/);
  });

  it('validates required fields before executing network calls', async () => {
    const provider = new VaultCaProvider();
    const config: SshCaConfig = {
      id: 'vault-1',
      name: 'Vault Local',
      backend: 'vault',
      caUrl: '',
      oidcIssuerUrl: 'http://127.0.0.1:8080',
      oidcClientId: 'vault-client',
      keySource: 'ephemeral',
    };

    const req: SshCaSignRequest = {
      publicKeyWireBase64: 'wire',
      keyType: 'ssh-ed25519',
      publicKeyLine: 'line',
      identityToken: 'token',
      username: 'user',
    };

    await expect(provider.sign(req, config)).rejects.toThrow(/Vault CA URL is required/);

    config.caUrl = 'https://vault.example.com';
    req.identityToken = '';
    await expect(provider.sign(req, config)).rejects.toThrow(/OIDC identity token is required/);

    req.identityToken = 'token';
    req.publicKeyLine = '';
    await expect(provider.sign(req, config)).rejects.toThrow(/Public key line is required/);
  });

  it('respects abort signal', async () => {
    const provider = new VaultCaProvider();
    const config: SshCaConfig = {
      id: 'vault-1',
      name: 'Vault Local',
      backend: 'vault',
      caUrl: serverBaseUrl,
      oidcIssuerUrl: 'http://127.0.0.1:8080',
      oidcClientId: 'vault-client',
      keySource: 'ephemeral',
    };

    const req: SshCaSignRequest = {
      publicKeyWireBase64: 'wire',
      keyType: 'ssh-ed25519',
      publicKeyLine: 'line',
      identityToken: 'token',
      username: 'user',
    };

    const controller = new AbortController();
    controller.abort();

    await expect(provider.sign(req, config, controller.signal)).rejects.toThrow(/Vault request was cancelled/);
  });
});
