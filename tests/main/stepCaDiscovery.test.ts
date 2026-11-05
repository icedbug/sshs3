import { describe, it, expect, vi } from 'vitest';
import {
  detectStepCa,
  NOT_TRUSTED_MESSAGE,
  normalizeFingerprint,
  parseOidcProvisioners,
  verifyRootCertificate,
} from '../../src/main/ca/stepCaDiscovery';
import { VAULT_NOT_TRUSTED_MESSAGE } from '../../src/main/ca/vaultDiscovery';
import { validateSshCaDetectRequest } from '../../src/main/ipc/sshCaHandlers';
import { SSH_CA_UNTRUSTED_MARKER } from '../../src/shared/types/sshCa';
import type { JsonResponse, RequestJsonOptions } from '../../src/main/oauth/requestJson';

// Throw-away test certificates (public data, no private keys): a self-signed CA, a self-signed non-CA and an
// intermediate signed by the root.
const ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIIBozCCAUmgAwIBAgIUJ5teuAEn2X770kq4/4jGV4bpzx8wCgYIKoZIzj0EAwIw
JjENMAsGA1UECgwEVGVzdDEVMBMGA1UEAwwMVGVzdCBSb290IENBMCAXDTI2MTEw
MTEyNTUzM1oYDzIxMjYxMDA4MTI1NTMzWjAmMQ0wCwYDVQQKDARUZXN0MRUwEwYD
VQQDDAxUZXN0IFJvb3QgQ0EwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAATSQeDo
GMm2Kc3JAvJb65D1lP/YGnwLHGVzAWxL+7EP6Qy3MzwMT/78PFlU+3YOPOeMtKAx
mPr/d7hJvt20k6Zyo1MwUTAdBgNVHQ4EFgQUrPZclXDEiTHn612422DVTPPYISIw
HwYDVR0jBBgwFoAUrPZclXDEiTHn612422DVTPPYISIwDwYDVR0TAQH/BAUwAwEB
/zAKBggqhkjOPQQDAgNIADBFAiBIZJrQm6OD17VmJ65DmCmKCKisNsBALL/420AN
zJfkigIhAMZrTVmrywMVc00XzyqygmfAPyV+wU1pnLTWS5cJqw2e
-----END CERTIFICATE-----`;
const ROOT_FP = '590fbd5a005f60ce21c496314b09324a5d09042846c790e656c6427ba21704a1'; // pragma: allowlist secret -- public test-certificate fingerprint
const NOT_CA_PEM = `-----BEGIN CERTIFICATE-----
MIIBdzCCAR2gAwIBAgIUQK27kbZatwO5Sm3nK8Vki2KRLuswCgYIKoZIzj0EAwIw
EzERMA8GA1UEAwwIbm90IGEgY2EwIBcNMjYxMTAxMTI1NTMzWhgPMjEyNjEwMDgx
MjU1MzNaMBMxETAPBgNVBAMMCG5vdCBhIGNhMFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAEYLC3ZVW5wKU2RM8v5fAbtSLbETpGTgPDhu7/91laEu83a6raZQ95yGyX
LX4qlDA207FrZnzfjkQiCOThwpn/IKNNMEswHQYDVR0OBBYEFFnh2W28hXpbRTwa
oDqI4pGPYuqRMB8GA1UdIwQYMBaAFFnh2W28hXpbRTwaoDqI4pGPYuqRMAkGA1Ud
EwQCMAAwCgYIKoZIzj0EAwIDSAAwRQIhANxhAZsdzKgksvpD5bswYsyvmQLaGs4j
4iI/tv280AUzAiB7FaXaqcLY+EPo4TCXyy/eqVer4DOgItAAmw2Dkx3rYA==
-----END CERTIFICATE-----`;
const NOT_CA_FP = 'b9dcc029f8a26c71d4da98829fb61e590a02dc4728acfda3bef287df6826fcd5'; // pragma: allowlist secret -- public test-certificate fingerprint
const INTERMEDIATE_PEM = `-----BEGIN CERTIFICATE-----
MIIBlDCCATqgAwIBAgIUR3VVyQPPuaXFSd8ryYbVBN74xJcwCgYIKoZIzj0EAwIw
JjENMAsGA1UECgwEVGVzdDEVMBMGA1UEAwwMVGVzdCBSb290IENBMCAXDTI2MTEw
MTEyNTUzM1oYDzIxMjYxMDA4MTI1NTMzWjAXMRUwEwYDVQQDDAxpbnRlcm1lZGlh
dGUwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAQRYjWZu93AL5g4nt9wP/CKb9/S
xmaVJeiDpir0xnQBGAtvjXmxlgoaB7TX6Fc1emisf+41c/JzGF3/48DkNeIqo1Mw
UTAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBTEKCz75BKP7TA2ujyNdyk0yoVW
tDAfBgNVHSMEGDAWgBSs9lyVcMSJMefrXbjbYNVM89ghIjAKBggqhkjOPQQDAgNI
ADBFAiBvmRwX8+whii1+kjOxwoB715mt98OsPOQ+Ma3Gw5RNugIhANQjHhHUJvov
CfLYUapMMVlEJb4vE7hrLXxxZmjblS6i
-----END CERTIFICATE-----`;
const INTERMEDIATE_FP = '1b02978d10a8064b36889dd38915789f46f3d3f626dac9571b122ccd2472a0f0'; // pragma: allowlist secret -- public test-certificate fingerprint

const OIDC = {
  type: 'OIDC',
  name: 'Keycloak',
  clientID: 'step-ca',
  configurationEndpoint: 'https://idp.example.com/realms/sshca/.well-known/openid-configuration',
};

describe('untrusted-certificate messages', () => {
  it('both carry the marker the UI looks for to ask for the fingerprint', () => {
    expect(NOT_TRUSTED_MESSAGE).toContain(SSH_CA_UNTRUSTED_MARKER);
    expect(VAULT_NOT_TRUSTED_MESSAGE).toContain(SSH_CA_UNTRUSTED_MARKER);
  });
});

describe('normalizeFingerprint', () => {
  it.each([
    [ROOT_FP, ROOT_FP],
    [ROOT_FP.toUpperCase(), ROOT_FP],
    [`  sha256:${ROOT_FP}  `, ROOT_FP],
    [ROOT_FP.replace(/(..)/g, '$1:').slice(0, -1).toUpperCase(), ROOT_FP],
    [ROOT_FP.replace(/(.{8})/g, '$1 ').trim(), ROOT_FP],
  ])('%#% accepts common spellings', (input, expected) => {
    expect(normalizeFingerprint(input)).toBe(expected);
  });

  it.each(['', 'abcd', ROOT_FP.slice(1), `${ROOT_FP}0`, `${ROOT_FP.slice(1)}g`])('rejects %j', (input) => {
    expect(normalizeFingerprint(input)).toBeUndefined();
  });
});

describe('verifyRootCertificate', () => {
  it('accepts a self-signed CA whose fingerprint matches', () => {
    const res = verifyRootCertificate(ROOT_PEM, ROOT_FP);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.root.fingerprint).toBe(ROOT_FP);
      expect(res.root.subject).toContain('Test Root CA');
      expect(res.root.pem).toContain('BEGIN CERTIFICATE');
      expect(Number.isNaN(Date.parse(res.root.validTo))).toBe(false);
    }
  });

  it('rejects a certificate whose fingerprint differs', () => {
    const res = verifyRootCertificate(ROOT_PEM, NOT_CA_FP);
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toContain('does not match the fingerprint');
  });

  it('rejects a self-signed certificate that is not a CA, even with a matching fingerprint', () => {
    const res = verifyRootCertificate(NOT_CA_PEM, NOT_CA_FP);
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('not a self-signed root') });
  });

  it('rejects an intermediate (not self-issued) even with a matching fingerprint', () => {
    const res = verifyRootCertificate(INTERMEDIATE_PEM, INTERMEDIATE_FP);
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('not a self-signed root') });
  });

  it('rejects a bundle of several certificates', () => {
    const res = verifyRootCertificate(`${ROOT_PEM}\n${INTERMEDIATE_PEM}`, ROOT_FP);
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('exactly one') });
  });

  it('rejects text that is not a certificate', () => {
    expect(verifyRootCertificate('hello', ROOT_FP)).toMatchObject({ ok: false });
    const broken = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----';
    expect(verifyRootCertificate(broken, ROOT_FP)).toMatchObject({ ok: false, error: expect.stringContaining('parsed') });
  });

  it('rejects an expired certificate', () => {
    const farFuture = new Date('2300-01-01T00:00:00Z');
    expect(verifyRootCertificate(ROOT_PEM, ROOT_FP, farFuture)).toMatchObject({
      ok: false,
      error: expect.stringContaining('expired'),
    });
  });

  it('rejects a certificate that is not valid yet', () => {
    const past = new Date('2000-01-01T00:00:00Z');
    expect(verifyRootCertificate(ROOT_PEM, ROOT_FP, past)).toMatchObject({ ok: false });
  });
});

describe('parseOidcProvisioners', () => {
  it('returns only OIDC provisioners with the issuer derived from the configuration endpoint', () => {
    const out = parseOidcProvisioners({
      provisioners: [{ type: 'JWK', name: 'admin' }, { type: 'SSHPOP', name: 'sshpop' }, OIDC],
    });
    expect(out).toEqual([{ name: 'Keycloak', clientId: 'step-ca', issuerUrl: 'https://idp.example.com/realms/sshca' }]);
  });

  it('skips entries with missing fields, a foreign endpoint shape or an unsafe issuer', () => {
    const out = parseOidcProvisioners({
      provisioners: [
        { ...OIDC, clientID: undefined },
        { ...OIDC, name: '' },
        { ...OIDC, configurationEndpoint: 'https://idp.example.com/openid' },
        { ...OIDC, configurationEndpoint: 'http://idp.example.com/.well-known/openid-configuration' },
        { ...OIDC, configurationEndpoint: 'https://user:pw@idp.example.com/.well-known/openid-configuration' }, // pragma: allowlist secret -- fake credentials in a URL
        { ...OIDC, configurationEndpoint: 'javascript:alert(1)//.well-known/openid-configuration' },
        null,
      ],
    });
    expect(out).toEqual([]);
  });

  it('allows plain http only for a loopback issuer', () => {
    const out = parseOidcProvisioners({
      provisioners: [{ ...OIDC, configurationEndpoint: 'http://127.0.0.1:8080/realms/x/.well-known/openid-configuration' }],
    });
    expect(out[0]?.issuerUrl).toBe('http://127.0.0.1:8080/realms/x');
  });

  it('returns an empty list for unexpected input', () => {
    expect(parseOidcProvisioners(undefined)).toEqual([]);
    expect(parseOidcProvisioners({ provisioners: 'x' })).toEqual([]);
  });
});

describe('detectStepCa', () => {
  const NOW = new Date();
  type Handler = (url: string, init: RequestJsonOptions) => JsonResponse | Promise<JsonResponse>;
  const make = (handler: Handler) => {
    const requestJson = vi.fn((url: string, init: RequestJsonOptions) => Promise.resolve(handler(url, init)));
    return { deps: { requestJson: requestJson as never, now: () => NOW }, requestJson };
  };
  const certError = () => Object.assign(new Error('Could not reach ca:9000: self-signed'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' });

  it('lists the OIDC provisioner without a fingerprint and never downloads a root', async () => {
    const { deps, requestJson } = make(() => ({ statusCode: 200, json: { provisioners: [OIDC] } }));
    const res = await detectStepCa({ caUrl: 'ca.example.com:9000/' }, deps);
    expect(res.root).toBeUndefined();
    expect(res.provisioners).toHaveLength(1);
    expect(requestJson).toHaveBeenCalledTimes(1);
    expect(requestJson.mock.calls[0][0]).toBe('https://ca.example.com:9000/provisioners');
    expect(requestJson.mock.calls[0][1].insecureSkipTlsVerify).toBeUndefined();
    expect(requestJson.mock.calls[0][1].ca).toBeUndefined();
  });

  it('downloads the root unverified, checks the fingerprint, then verifies the CA against it', async () => {
    const { deps, requestJson } = make((url) =>
      url.includes('/root/') ? { statusCode: 200, json: { ca: ROOT_PEM } } : { statusCode: 200, json: { provisioners: [OIDC] } }
    );
    const res = await detectStepCa({ caUrl: 'https://ca.example.com', rootFingerprint: ROOT_FP.toUpperCase() }, deps);
    expect(res.root?.fingerprint).toBe(ROOT_FP);
    const [rootUrl, rootInit] = requestJson.mock.calls[0];
    expect(rootUrl).toBe(`https://ca.example.com/root/${ROOT_FP}`);
    expect(rootInit.insecureSkipTlsVerify).toBe(true);
    const [, provInit] = requestJson.mock.calls[1];
    expect(provInit.insecureSkipTlsVerify).toBeUndefined();
    expect(String(provInit.ca)).toContain('BEGIN CERTIFICATE');
  });

  it('refuses a root that does not match the fingerprint and does not ask for provisioners', async () => {
    const { deps, requestJson } = make(() => ({ statusCode: 200, json: { ca: NOT_CA_PEM } }));
    await expect(detectStepCa({ caUrl: 'https://ca.example.com', rootFingerprint: ROOT_FP }, deps)).rejects.toThrow(
      /does not match the fingerprint/
    );
    expect(requestJson).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed fingerprint before any network request', async () => {
    const { deps, requestJson } = make(() => ({ statusCode: 200, json: {} }));
    await expect(detectStepCa({ caUrl: 'https://ca.example.com', rootFingerprint: 'abc' }, deps)).rejects.toThrow(
      /64 hexadecimal/
    );
    expect(requestJson).not.toHaveBeenCalled();
  });

  it('explains an untrusted CA certificate', async () => {
    const { deps } = make(() => {
      throw certError();
    });
    await expect(detectStepCa({ caUrl: 'https://ca.example.com' }, deps)).rejects.toThrow(NOT_TRUSTED_MESSAGE);
  });

  it('does not send an expired or wrong-host certificate to the fingerprint flow', async () => {
    for (const [code, pattern] of [['CERT_HAS_EXPIRED', /has expired/], ['ERR_TLS_CERT_ALTNAME_INVALID', /host name/]] as const) {
      const { deps } = make(() => {
        throw Object.assign(new Error('x'), { code });
      });
      const run = detectStepCa({ caUrl: 'https://ca.example.com' }, deps);
      await expect(run).rejects.toThrow(pattern);
      await expect(run).rejects.not.toThrow(SSH_CA_UNTRUSTED_MARKER);
    }
  });

  it('verifies the CA against a custom root the user already entered', async () => {
    const { deps, requestJson } = make(() => ({ statusCode: 200, json: { provisioners: [OIDC] } }));
    await detectStepCa({ caUrl: 'https://ca.example.com', rootCaCert: ` ${ROOT_PEM} ` }, deps);
    expect(requestJson).toHaveBeenCalledTimes(1);
    expect(String(requestJson.mock.calls[0][1].ca)).toBe(ROOT_PEM);
  });

  it('prefers the root it just verified over a custom one', async () => {
    const { deps, requestJson } = make((url) =>
      url.includes('/root/') ? { statusCode: 200, json: { ca: ROOT_PEM } } : { statusCode: 200, json: { provisioners: [OIDC] } }
    );
    await detectStepCa({ caUrl: 'https://ca.example.com', rootFingerprint: ROOT_FP, rootCaCert: 'OTHER' }, deps);
    expect(String(requestJson.mock.calls[1][1].ca)).toContain('BEGIN CERTIFICATE');
    expect(String(requestJson.mock.calls[1][1].ca)).not.toBe('OTHER');
  });

  it('passes other network errors through', async () => {
    const { deps } = make(() => {
      throw new Error('Could not reach ca:9000: connect ECONNREFUSED');
    });
    await expect(detectStepCa({ caUrl: 'https://ca.example.com' }, deps)).rejects.toThrow(/ECONNREFUSED/);
  });

  it('reports a missing root and HTTP errors', async () => {
    const missing = make(() => ({ statusCode: 404, json: undefined }));
    await expect(
      detectStepCa({ caUrl: 'https://ca.example.com', rootFingerprint: ROOT_FP }, missing.deps)
    ).rejects.toThrow(/no root certificate with that fingerprint \(HTTP 404\)/);
    const failing = make(() => ({ statusCode: 500, json: undefined }));
    await expect(detectStepCa({ caUrl: 'https://ca.example.com' }, failing.deps)).rejects.toThrow(/HTTP 500/);
  });

  it('fails when the CA has no usable OIDC provisioner', async () => {
    const { deps } = make(() => ({ statusCode: 200, json: { provisioners: [{ type: 'JWK', name: 'admin' }] } }));
    await expect(detectStepCa({ caUrl: 'https://ca.example.com' }, deps)).rejects.toThrow(/no OIDC provisioner/);
  });

  it('follows the pagination cursor, within a limit', async () => {
    const { deps, requestJson } = make((url) =>
      url.endsWith('/provisioners')
        ? { statusCode: 200, json: { provisioners: [], nextCursor: 'c 1' } }
        : { statusCode: 200, json: { provisioners: [OIDC] } }
    );
    const res = await detectStepCa({ caUrl: 'https://ca.example.com' }, deps);
    expect(res.provisioners).toHaveLength(1);
    expect(requestJson.mock.calls[1][0]).toBe('https://ca.example.com/provisioners?cursor=c%201');

    const endless = make(() => ({ statusCode: 200, json: { provisioners: [OIDC], nextCursor: 'again' } }));
    const capped = await detectStepCa({ caUrl: 'https://ca.example.com' }, endless.deps);
    expect(endless.requestJson).toHaveBeenCalledTimes(5);
    expect(capped.provisioners).toHaveLength(5);
  });

  it('requires a CA URL and allows plain http only on loopback', async () => {
    const { deps, requestJson } = make(() => ({ statusCode: 200, json: { provisioners: [OIDC] } }));
    await expect(detectStepCa({ caUrl: '  ' }, deps)).rejects.toThrow(/Enter the CA URL/);
    await detectStepCa({ caUrl: 'http://127.0.0.1:9000' }, deps);
    await detectStepCa({ caUrl: 'http://ca.example.com' }, deps);
    expect(requestJson.mock.calls[0][1].allowHttp).toBe(true);
    expect(requestJson.mock.calls[1][1].allowHttp).toBe(false);
  });
});

describe('validateSshCaDetectRequest', () => {
  it('accepts a URL with an optional fingerprint', () => {
    expect(validateSshCaDetectRequest({ caUrl: 'https://ca', rootFingerprint: ROOT_FP })).toEqual({
      caUrl: 'https://ca',
      rootFingerprint: ROOT_FP,
    });
    expect(validateSshCaDetectRequest({ caUrl: 'https://ca' }).rootFingerprint).toBeUndefined();
  });

  it('passes a custom root through', () => {
    expect(validateSshCaDetectRequest({ caUrl: 'https://ca', rootCaCert: 'PEM' }).rootCaCert).toBe('PEM');
  });

  it.each([undefined, null, 'x', {}, { caUrl: '' }, { caUrl: 5 }, { caUrl: 'a'.repeat(3000) }, { caUrl: 'x', rootFingerprint: 5 }, { caUrl: 'x', rootFingerprint: 'a'.repeat(300) }, { caUrl: 'x', rootCaCert: 5 }, { caUrl: 'x', rootCaCert: 'p'.repeat(200_000) }])(
    'rejects %j',
    (input) => {
      expect(() => validateSshCaDetectRequest(input)).toThrow(/Invalid SSH CA detect request/);
    }
  );
});
