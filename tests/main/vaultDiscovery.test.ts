import { describe, it, expect, vi } from 'vitest';
import {
  detectVault,
  isSafeMountName,
  parseSshPublicKey,
  parseUiMounts,
  VAULT_NOT_TRUSTED_MESSAGE,
} from '../../src/main/ca/vaultDiscovery';
import { validateSshCaVaultDetectRequest } from '../../src/main/ipc/sshCaHandlers';
import type { JsonResponse, RequestJsonOptions } from '../../src/main/oauth/requestJson';

// A throw-away key; the fingerprint is what `ssh-keygen -lf` prints for it.
const KEY_LINE = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAII2138MihWeKw6SqTSty5Af2o6A/3YQy6P0+d2uk7lm2 vault-ca';
const KEY_FP = 'SHA256:t0GRf8F9p4M+ZIyZGoXltxXlDlyCrxhVihal1OnA4j8'; // pragma: allowlist secret -- public key fingerprint

const HEALTHY = { initialized: true, sealed: false, version: '1.18.0' };

describe('parseSshPublicKey', () => {
  it('returns the key type and the fingerprint ssh-keygen prints', () => {
    expect(parseSshPublicKey(`${KEY_LINE}\n`)).toEqual({ keyType: 'ssh-ed25519', fingerprint: KEY_FP });
  });

  it.each(['', 'not a key', '<html>login</html>', 'ssh-ed25519 !!!', 'ssh-ed25519 AA', '{"errors":[]}'])(
    'rejects %j',
    (text) => {
      expect(parseSshPublicKey(text)).toBeUndefined();
    }
  );
});

describe('isSafeMountName', () => {
  it.each(['ssh', 'ssh-client-signer', 'team/ssh', 'a.b_c-1'])('accepts %s', (name) => {
    expect(isSafeMountName(name)).toBe(true);
  });

  it.each(['', '..', '../x', 'a/../b', '.', 'a//b', 'a b', 'a?x=1', 'a#b', 'a%2e'])('rejects %j', (name) => {
    expect(isSafeMountName(name)).toBe(false);
  });
});

describe('parseUiMounts', () => {
  const body = {
    auth: { 'jwt/': { type: 'jwt' }, 'oidc/': { type: 'oidc' }, 'token/': { type: 'token' }, 'github/': { type: 'github' } },
    secret: { 'ssh/': { type: 'ssh' }, 'kv/': { type: 'kv' }, 'team/ssh-ca/': { type: 'ssh' }, '../evil/': { type: 'ssh' } },
  };

  it('finds SSH engines and JWT/OIDC auth methods, in both the wrapped and the unwrapped shape', () => {
    for (const json of [body, { data: body }]) {
      expect(parseUiMounts(json)).toEqual({
        sshMountNames: ['ssh', 'team/ssh-ca'],
        authMounts: [
          { mount: 'jwt', type: 'jwt' },
          { mount: 'oidc', type: 'oidc' },
        ],
      });
    }
  });

  it('tolerates unexpected input', () => {
    expect(parseUiMounts(undefined)).toEqual({ sshMountNames: [], authMounts: [] });
    expect(parseUiMounts({ data: { auth: 'x', secret: 5 } })).toEqual({ sshMountNames: [], authMounts: [] });
  });
});

describe('detectVault', () => {
  type Handler = (url: string, init: RequestJsonOptions) => JsonResponse | Promise<JsonResponse>;
  const make = (handler: Handler) => {
    const requestJson = vi.fn((url: string, init: RequestJsonOptions) => Promise.resolve(handler(url, init)));
    return { deps: { requestJson: requestJson as never }, requestJson };
  };
  const urls = (m: ReturnType<typeof make>) => m.requestJson.mock.calls.map((c) => c[0]);
  const certError = () => Object.assign(new Error('Could not reach vault: self-signed'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });

  /** A server with an SSH engine at the given mounts and the given ui/mounts answer. */
  const server = (sshAt: string[], ui: JsonResponse = { statusCode: 200, json: { data: { auth: {}, secret: {} } } }) =>
    make((url) => {
      if (url.endsWith('/v1/sys/health')) return { statusCode: 200, json: HEALTHY };
      if (url.endsWith('/v1/sys/internal/ui/mounts')) return ui;
      const hit = sshAt.find((m) => url.endsWith(`/v1/${m}/public_key`));
      return hit ? { statusCode: 200, json: undefined, text: `${KEY_LINE}\n` } : { statusCode: 404, json: { errors: [] } };
    });

  it('finds the SSH engine at a default mount name and reports the CA key fingerprint', async () => {
    const s = server(['ssh-client-signer']);
    const res = await detectVault({ caUrl: 'vault.example.com:8200/' }, s.deps);
    expect(res).toEqual({
      version: '1.18.0',
      sshMounts: [{ mount: 'ssh-client-signer', keyType: 'ssh-ed25519', fingerprint: KEY_FP }],
      authMounts: [],
    });
    expect(urls(s)).toContain('https://vault.example.com:8200/v1/ssh/public_key');
    expect(urls(s)).toContain('https://vault.example.com:8200/v1/ssh-client-signer/public_key');
  });

  it('also probes the SSH mounts the server lists and reports listed auth mounts', async () => {
    const s = server(['team/ssh-ca'], {
      statusCode: 200,
      json: { data: { auth: { 'jwt/': { type: 'jwt' } }, secret: { 'team/ssh-ca/': { type: 'ssh' } } } },
    });
    const res = await detectVault({ caUrl: 'https://vault.example.com' }, s.deps);
    expect(res.sshMounts.map((m) => m.mount)).toEqual(['team/ssh-ca']);
    expect(res.authMounts).toEqual([{ mount: 'jwt', type: 'jwt' }]);
    expect(urls(s)).toContain('https://vault.example.com/v1/team/ssh-ca/public_key');
  });

  it('returns no SSH mounts when none answers with a public key (not even for a 200 with other content)', async () => {
    const s = make((url) =>
      url.endsWith('/v1/sys/health')
        ? { statusCode: 200, json: HEALTHY }
        : { statusCode: 200, json: undefined, text: '<html>sign in</html>' }
    );
    expect((await detectVault({ caUrl: 'https://vault.example.com' }, s.deps)).sshMounts).toEqual([]);
  });

  it('sends the namespace and the custom root, and asks for plain text for the key', async () => {
    const s = server(['ssh']);
    await detectVault({ caUrl: 'https://vault.example.com', namespace: ' team-a ', rootCaCert: 'PEM' }, s.deps);
    for (const [, init] of s.requestJson.mock.calls) {
      expect(init.headers?.['X-Vault-Namespace']).toBe('team-a');
      expect(String(init.ca)).toBe('PEM');
    }
    const keyCall = s.requestJson.mock.calls.find((c) => c[0].endsWith('/ssh/public_key'));
    expect(keyCall?.[1].headers?.Accept).toBe('text/plain');
  });

  it('never skips certificate verification and allows plain http only on loopback', async () => {
    const s = server(['ssh']);
    await detectVault({ caUrl: 'http://127.0.0.1:8200' }, s.deps);
    await detectVault({ caUrl: 'http://vault.example.com' }, s.deps);
    expect(s.requestJson.mock.calls.every((c) => c[1].insecureSkipTlsVerify === undefined)).toBe(true);
    expect(s.requestJson.mock.calls[0][1].allowHttp).toBe(true);
    expect(s.requestJson.mock.calls.at(-1)?.[1].allowHttp).toBe(false);
  });

  it('copes when the mount listing is unavailable', async () => {
    const s = make((url) => {
      if (url.endsWith('/v1/sys/health')) return { statusCode: 200, json: HEALTHY };
      if (url.endsWith('/ui/mounts')) throw new Error('boom');
      return url.endsWith('/v1/ssh/public_key') ? { statusCode: 200, json: undefined, text: KEY_LINE } : { statusCode: 404, json: undefined };
    });
    const res = await detectVault({ caUrl: 'https://vault.example.com' }, s.deps);
    expect(res.sshMounts).toHaveLength(1);
  });

  it('accepts the non-200 health statuses of a standby node and a redacted version', async () => {
    const s = make((url) =>
      url.endsWith('/v1/sys/health')
        ? { statusCode: 429, json: { initialized: true, sealed: false, standby: true, version: '' } }
        : { statusCode: 404, json: undefined }
    );
    const res = await detectVault({ caUrl: 'https://vault.example.com' }, s.deps);
    expect(res.version).toBeUndefined();
  });

  it('rejects servers that are sealed, uninitialized or not Vault at all', async () => {
    const sealed = make(() => ({ statusCode: 503, json: { initialized: true, sealed: true } }));
    await expect(detectVault({ caUrl: 'https://v' }, sealed.deps)).rejects.toThrow(/sealed/);
    const fresh = make(() => ({ statusCode: 501, json: { initialized: false, sealed: true } }));
    await expect(detectVault({ caUrl: 'https://v' }, fresh.deps)).rejects.toThrow(/not initialized/);
    const web = make(() => ({ statusCode: 200, json: undefined, text: '<html></html>' }));
    await expect(detectVault({ caUrl: 'https://v' }, web.deps)).rejects.toThrow(/does not look like a Vault or OpenBao/);
  });

  it('explains an untrusted certificate and passes other errors through', async () => {
    const untrusted = make(() => {
      throw certError();
    });
    await expect(detectVault({ caUrl: 'https://v' }, untrusted.deps)).rejects.toThrow(VAULT_NOT_TRUSTED_MESSAGE);
    const down = make(() => {
      throw new Error('Could not reach v: connect ECONNREFUSED');
    });
    await expect(detectVault({ caUrl: 'https://v' }, down.deps)).rejects.toThrow(/ECONNREFUSED/);
  });

  it('does not send an expired or wrong-host certificate to the trust store advice', async () => {
    for (const code of ['CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID']) {
      const s = make(() => {
        throw Object.assign(new Error('x'), { code });
      });
      const run = detectVault({ caUrl: 'https://v' }, s.deps);
      await expect(run).rejects.toThrow(/certificate/);
      await expect(run).rejects.not.toThrow(VAULT_NOT_TRUSTED_MESSAGE);
    }
  });

  it('requires a valid CA URL', async () => {
    const s = server([]);
    await expect(detectVault({ caUrl: '  ' }, s.deps)).rejects.toThrow(/Enter the CA URL/);
    await expect(detectVault({ caUrl: 'https://' }, s.deps)).rejects.toThrow(/not valid/);
    expect(s.requestJson).not.toHaveBeenCalled();
  });

  it('caps the number of probed mounts', async () => {
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`m${i}/`, { type: 'ssh' }]));
    const s = server([], { statusCode: 200, json: { data: { secret: many } } });
    await detectVault({ caUrl: 'https://vault.example.com' }, s.deps);
    expect(urls(s).filter((u) => u.endsWith('/public_key'))).toHaveLength(8);
  });
});

describe('validateSshCaVaultDetectRequest', () => {
  it('accepts a URL with optional namespace and root', () => {
    expect(validateSshCaVaultDetectRequest({ caUrl: 'https://v', namespace: 'ns', rootCaCert: 'PEM' })).toEqual({
      caUrl: 'https://v',
      namespace: 'ns',
      rootCaCert: 'PEM',
    });
    expect(validateSshCaVaultDetectRequest({ caUrl: 'https://v' }).namespace).toBeUndefined();
  });

  it.each([
    undefined,
    null,
    'x',
    {},
    { caUrl: '' },
    { caUrl: 5 },
    { caUrl: 'a'.repeat(3000) },
    { caUrl: 'x', namespace: 5 },
    { caUrl: 'x', namespace: 'n'.repeat(300) },
    { caUrl: 'x', rootCaCert: 5 },
    { caUrl: 'x', rootCaCert: 'p'.repeat(200_000) },
  ])('rejects %j', (input) => {
    expect(() => validateSshCaVaultDetectRequest(input)).toThrow(/Invalid SSH CA detect request/);
  });
});
