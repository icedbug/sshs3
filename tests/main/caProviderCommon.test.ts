import { describe, it, expect } from 'vitest';
import {
  buildCertificateLine,
  normalizeCaBaseUrl,
  rootCaBuffer,
  throwIfCancelled,
} from '../../src/main/ca/providers/common';

describe('rootCaBuffer', () => {
  it('returns undefined when no root CA is configured', () => {
    expect(rootCaBuffer({})).toBeUndefined();
    expect(rootCaBuffer({ rootCaCert: '' })).toBeUndefined();
  });

  it('treats a whitespace-only value as not set (it would otherwise replace the system roots with nothing)', () => {
    expect(rootCaBuffer({ rootCaCert: '  \n\t ' })).toBeUndefined();
  });

  it('returns the trimmed PEM as a buffer', () => {
    const buf = rootCaBuffer({ rootCaCert: '\n-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n' });
    expect(buf?.toString('utf8')).toBe('-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----');
  });
});

describe('normalizeCaBaseUrl', () => {
  it.each([
    ['ca.example.com', 'https://ca.example.com'],
    ['  ca.example.com:9000/  ', 'https://ca.example.com:9000'],
    ['https://ca.example.com//', 'https://ca.example.com'],
    ['http://127.0.0.1:8200/', 'http://127.0.0.1:8200'],
    ['https://vault.example.com/ns/path/', 'https://vault.example.com/ns/path'],
  ])('%s -> %s', (raw, expected) => {
    expect(normalizeCaBaseUrl(raw)).toBe(expected);
  });
});

describe('buildCertificateLine', () => {
  it('appends the certificate suffix to a plain key type', () => {
    expect(buildCertificateLine({ keyType: 'ssh-ed25519', username: 'alun' }, 'AAAA')).toBe(
      'ssh-ed25519-cert-v01@openssh.com AAAA sshs3-ca:alun'
    );
  });

  it('does not double the suffix', () => {
    expect(buildCertificateLine({ keyType: 'ssh-rsa-cert-v01@openssh.com', username: 'u' }, 'BBBB')).toBe(
      'ssh-rsa-cert-v01@openssh.com BBBB sshs3-ca:u'
    );
  });
});

describe('throwIfCancelled', () => {
  it('does nothing without a signal or with a live one', () => {
    expect(() => throwIfCancelled(undefined, 'Vault')).not.toThrow();
    expect(() => throwIfCancelled(new AbortController().signal, 'Vault')).not.toThrow();
  });

  it('throws a backend-labelled error for an aborted signal', () => {
    const c = new AbortController();
    c.abort();
    expect(() => throwIfCancelled(c.signal, 'Step-CA')).toThrow('Step-CA request was cancelled');
  });
});
