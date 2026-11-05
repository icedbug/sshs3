import { describe, it, expect } from 'vitest';
import { certErrorMessage } from '../../src/main/ca/certErrors';

const err = (code?: string) => Object.assign(new Error('x'), { code });

describe('certErrorMessage', () => {
  it.each([
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  ])('sends %s to the root CA (missing trust anchor)', (code) => {
    expect(certErrorMessage(err(code), 'UNTRUSTED')).toBe('UNTRUSTED');
  });

  it('does not blame the trust store for an expired certificate', () => {
    const msg = certErrorMessage(err('CERT_HAS_EXPIRED'), 'UNTRUSTED');
    expect(msg).toMatch(/has expired/);
    expect(msg).not.toContain('UNTRUSTED');
  });

  it('does not blame the trust store for a host name the certificate does not cover', () => {
    const msg = certErrorMessage(err('ERR_TLS_CERT_ALTNAME_INVALID'), 'UNTRUSTED');
    expect(msg).toMatch(/not valid for this host name/);
    expect(msg).not.toContain('UNTRUSTED');
  });

  it.each([undefined, null, 'x', {}, err(), err('ECONNREFUSED')])('is undefined for %j', (e) => {
    expect(certErrorMessage(e, 'UNTRUSTED')).toBeUndefined();
  });
});
