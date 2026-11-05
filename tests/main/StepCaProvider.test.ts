import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { StepCaProvider } from '../../src/main/ca/providers/StepCaProvider';
import type { SshCaConfig, SshCaSignRequest } from '../../src/shared/types/sshCa';

describe('StepCaProvider', () => {
  let mockServer: http.Server;
  let serverBaseUrl = '';
  let receivedRequestBody: any = null;

  beforeEach(async () => {
    receivedRequestBody = null;
    mockServer = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/1.0/ssh/sign') {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          try {
            receivedRequestBody = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          } catch {
            receivedRequestBody = null;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              crt: 'dGVzdC1jZXJ0LWJsb2I=',
            })
          );
        });
        return;
      }

      res.writeHead(404).end();
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

  it('signs an SSH certificate using loopback HTTP endpoint', async () => {
    const provider = new StepCaProvider();
    const config: SshCaConfig = {
      id: 'step-1',
      name: 'Local Step CA',
      backend: 'step-ca',
      caUrl: serverBaseUrl,
      oidcIssuerUrl: 'http://127.0.0.1:8080',
      oidcClientId: 'step-ca',
      keySource: 'ephemeral',
    };

    const req: SshCaSignRequest = {
      publicKeyWireBase64: 'AAAAInNzaC1lZDI1NTE5AAAAIAD123',
      keyType: 'ssh-ed25519',
      publicKeyLine: 'ssh-ed25519 AAAAInNzaC1lZDI1NTE5AAAAIAD123 sshs3-ca:alun',
      identityToken: 'dummy-ott-token',
      username: 'alun',
      principals: ['alun', 'root'],
    };

    const res = await provider.sign(req, config);
    expect(res.certificateWireBase64).toBe('dGVzdC1jZXJ0LWJsb2I=');
    expect(res.certificateLine).toContain('ssh-ed25519-cert-v01@openssh.com dGVzdC1jZXJ0LWJsb2I= sshs3-ca:alun');

    expect(receivedRequestBody).not.toBeNull();
    expect(receivedRequestBody.ott).toBe('dummy-ott-token');
    expect(receivedRequestBody.publicKey).toBe('AAAAInNzaC1lZDI1NTE5AAAAIAD123');
    expect(receivedRequestBody.certType).toBe('user');
    expect(receivedRequestBody.principals).toEqual(['alun', 'root']);
  });

  it('validates required fields before calling sign', async () => {
    const provider = new StepCaProvider();
    const config: SshCaConfig = {
      id: 'step-1',
      name: 'Local Step CA',
      backend: 'step-ca',
      caUrl: '',
      oidcIssuerUrl: 'http://127.0.0.1:8080',
      oidcClientId: 'step-ca',
      keySource: 'ephemeral',
    };

    const req: SshCaSignRequest = {
      publicKeyWireBase64: 'wire',
      keyType: 'ssh-ed25519',
      publicKeyLine: 'line',
      identityToken: 'token',
      username: 'user',
    };

    await expect(provider.sign(req, config)).rejects.toThrow(/Step-CA URL is required/);

    config.caUrl = 'https://ca.example.com';
    req.identityToken = '';
    await expect(provider.sign(req, config)).rejects.toThrow(/OIDC identity token is required/);
  });
});
