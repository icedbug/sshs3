import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import {
  MAX_CERTIFICATE_FILE_BYTES,
  describeCertificateFile,
  validHostInput,
  sanitizeDisplay,
  signatureAlgorithmName,
  validityStatus,
} from '../../src/main/certs/certificateInfo';

const fixture = (name: string): Buffer => fs.readFileSync(path.join(__dirname, 'fixtures', 'certs', name));
const DAY = 86_400_000;
// Built from parts so secret scanners do not mistake the synthetic test block for a real key.
const pemBlock = (label: string, body: string): string => `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
const NOW = Date.parse('2027-01-01T00:00:00Z');

describe('describeCertificateFile', () => {
  it('describes a PEM leaf certificate', () => {
    const res = describeCertificateFile(fixture('leaf.pem'), NOW);
    expect(res.error).toBeUndefined();
    expect(res.certs).toHaveLength(1);
    const cert = res.certs[0];
    expect(cert.subject).toBe('C=SE, O=Test Org, CN=www.example.test');
    expect(cert.issuer).toBe('C=SE, O=Test Org, CN=Test Root CA');
    expect(cert.sans).toEqual(['DNS:www.example.test', 'DNS:example.test', 'IP Address:192.0.2.10']);
    expect(cert.publicKey).toBe('RSA 2048');
    expect(cert.signatureAlgorithm).toBe('SHA-256 with RSA');
    expect(cert.weakSignature).toBe(false);
    expect(cert.isCa).toBe(false);
    expect(cert.selfSigned).toBe(false);
    expect(cert.extendedKeyUsage).toEqual(['serverAuth', 'clientAuth']);
    expect(cert.validity).toBe('valid');
    expect(cert.sha256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });

  it('flags a self-signed CA and an EC key', () => {
    const ca = describeCertificateFile(fixture('ca.pem'), NOW).certs[0];
    expect(ca.isCa).toBe(true);
    expect(ca.selfSigned).toBe(true);
    const ec = describeCertificateFile(fixture('ec.pem'), NOW).certs[0];
    expect(ec.publicKey).toBe('EC P-256');
    expect(ec.signatureAlgorithm).toBe('SHA-256 with ECDSA');
  });

  it('reads a DER certificate the same as its PEM', () => {
    const der = describeCertificateFile(fixture('leaf.der'), NOW).certs[0];
    const pem = describeCertificateFile(fixture('leaf.pem'), NOW).certs[0];
    expect(der).toEqual(pem);
  });

  it('lists every certificate of a bundle, up to the cap', () => {
    const bundle = Buffer.concat([fixture('leaf.pem'), fixture('ca.pem')]);
    expect(describeCertificateFile(bundle, NOW).certs.map((c) => c.isCa)).toEqual([false, true]);

    const many = Buffer.concat(Array.from({ length: 12 }, () => fixture('ca.pem')));
    const res = describeCertificateFile(many, NOW);
    expect(res.certs).toHaveLength(10);
    expect(res.moreCerts).toBe(2);
  });

  it('derives the validity from the injected time', () => {
    const cert = (now: number) => describeCertificateFile(fixture('leaf.pem'), now).certs[0];
    expect(cert(Date.parse('1990-01-01T00:00:00Z')).validity).toBe('not-yet-valid');
    expect(cert(Date.parse('2300-01-01T00:00:00Z')).validity).toBe('expired');
    expect(cert(Date.parse('2300-01-01T00:00:00Z')).daysLeft).toBeLessThan(0);
  });

  it('never decodes or returns a private key sharing the file', () => {
    const marker = 'TOPSECRETKEYMATERIAL0123456789';
    const keyBlock = pemBlock('PRIVATE KEY', Buffer.from(marker).toString('base64'));
    const file = Buffer.concat([Buffer.from(keyBlock), fixture('leaf.pem'), Buffer.from(keyBlock)]);
    const res = describeCertificateFile(file, NOW);
    expect(res.certs).toHaveLength(1);
    const json = JSON.stringify(res);
    expect(json).not.toContain(marker);
    expect(json).not.toContain(Buffer.from(marker).toString('base64'));
    expect(json).not.toContain('PRIVATE');
  });

  it('reports files without a certificate or that cannot be parsed', () => {
    expect(describeCertificateFile(Buffer.from('hello world\n'), NOW).error).toBe('none');
    expect(describeCertificateFile(Buffer.alloc(0), NOW).error).toBe('none');
    const onlyKey = Buffer.from(pemBlock('PRIVATE KEY', 'AAAA'));
    expect(describeCertificateFile(onlyKey, NOW)).toEqual({ certs: [], moreCerts: 0, error: 'none' });
    const garbage = Buffer.from('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n');
    expect(describeCertificateFile(garbage, NOW).error).toBe('unreadable');
    expect(describeCertificateFile(Buffer.from([0x30, 0x82, 0xff, 0xff, 0x01]), NOW).error).toBe('unreadable');
  });

  it('skips a truncated PEM block and non-base64 bodies', () => {
    const truncated = fixture('leaf.pem').subarray(0, 400);
    expect(describeCertificateFile(truncated, NOW).error).toBe('none');
    const notBase64 = Buffer.from('-----BEGIN CERTIFICATE-----\n<script>alert(1)</script>\n-----END CERTIFICATE-----\n');
    expect(describeCertificateFile(notBase64, NOW).error).toBe('none');
  });

  it('refuses a file larger than the cap instead of parsing part of it', () => {
    const big = Buffer.concat([fixture('leaf.pem'), Buffer.alloc(MAX_CERTIFICATE_FILE_BYTES)]);
    expect(describeCertificateFile(big, NOW)).toEqual({ certs: [], moreCerts: 0, error: 'too-large' });
  });
});

describe('extended details', () => {
  const leaf2 = () => describeCertificateFile(fixture('leaf2.pem'), NOW).certs[0];

  it('reads key usage, revocation URLs and the extra fingerprints', () => {
    const cert = leaf2();
    expect(cert.keyUsage).toEqual(['digitalSignature', 'keyEncipherment']);
    expect(cert.extendedKeyUsage).toEqual(['serverAuth']);
    expect(cert.ocspUrls).toEqual(['http://ocsp.example.test']);
    expect(cert.caIssuerUrls).toEqual(['http://pki.example.test/int.crt']);
    expect(cert.crlUrls).toEqual(['http://pki.example.test/int.crl']);
    expect(cert.sha1).toMatch(/^([0-9A-F]{2}:){19}[0-9A-F]{2}$/);
    expect(cert.spkiSha256).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(cert.pathLength).toBeUndefined();
  });

  it('reads CA key usage and the path length constraint', () => {
    const int = describeCertificateFile(fixture('int.pem'), NOW).certs[0];
    expect(int.isCa).toBe(true);
    expect(int.keyUsage).toEqual(['keyCertSign', 'cRLSign']);
    expect(int.pathLength).toBe(0);
  });

  it('leaves the new lists empty for a certificate without those extensions', () => {
    const cert = describeCertificateFile(fixture('ec.pem'), NOW).certs[0];
    expect(cert).toMatchObject({ keyUsage: expect.any(Array), ocspUrls: [], caIssuerUrls: [], crlUrls: [] });
  });

  it('returns one certificate as PEM that parses to the same certificate', () => {
    const bundle = Buffer.concat([fixture('leaf2.pem'), fixture('int.pem')]);
    const certs = describeCertificateFile(bundle, NOW).certs;
    expect(certs[1].pem).toMatch(/^-----BEGIN CERTIFICATE-----\n[\s\S]+\n-----END CERTIFICATE-----\n$/);
    expect(new X509Certificate(certs[1].pem).fingerprint256).toBe(certs[1].sha256);
    expect(certs[1].pem).not.toBe(certs[0].pem);
  });

  it('describes how a bundle chains', () => {
    const chain = (...names: string[]) => describeCertificateFile(Buffer.concat(names.map(fixture)), NOW).chain;
    expect(chain('leaf2.pem')).toBeUndefined();
    expect(chain('leaf2.pem', 'int.pem')).toEqual({ status: 'ordered', endsWithRoot: false });
    expect(chain('leaf2.pem', 'int.pem', 'ca.pem')).toEqual({ status: 'ordered', endsWithRoot: true });
    expect(chain('ca.pem', 'int.pem', 'leaf2.pem')?.status).toBe('out-of-order');
    expect(chain('leaf2.pem', 'ec.pem', 'ca.pem')?.status).toBe('broken');
    expect(chain('ca.pem', 'ca.pem')?.status).toBe('broken');
  });

  it('does not claim the root when certificates were cut from the list', () => {
    const many = Buffer.concat([fixture('leaf2.pem'), fixture('int.pem'), ...Array.from({ length: 10 }, () => fixture('ca.pem'))]);
    const res = describeCertificateFile(many, NOW);
    expect(res.moreCerts).toBe(2);
    expect(res.chain?.endsWithRoot).toBeUndefined();
  });

  it('checks a host name or IP address against the SANs, wildcards included', () => {
    const check = (host: string, file = 'leaf2.pem') => describeCertificateFile(fixture(file), NOW, host);
    expect(check('api.example.test').certs[0].hostMatch).toBe(true);
    expect(check('api.example.test').checkedHost).toBe('api.example.test');
    expect(check('foo.apps.example.test').certs[0].hostMatch).toBe(true);
    expect(check('a.b.apps.example.test').certs[0].hostMatch).toBe(false);
    expect(check('other.example.test').certs[0].hostMatch).toBe(false);
    expect(check('192.0.2.10', 'leaf.pem').certs[0].hostMatch).toBe(true);
    expect(check('192.0.2.11', 'leaf.pem').certs[0].hostMatch).toBe(false);
  });

  it('checks the host name against the end-entity certificate only, not against CAs in the bundle', () => {
    const bundle = Buffer.concat([fixture('leaf2.pem'), fixture('int.pem'), fixture('ca.pem')]);
    const res = describeCertificateFile(bundle, NOW, 'api.example.test');
    expect(res.certs.map((c) => c.hostMatch)).toEqual([true, undefined, undefined]);
  });

  it('counts a certificate that cannot be read and does not judge the chain without it', () => {
    const broken = Buffer.from(pemBlock('CERTIFICATE', 'AAAA'));
    const res = describeCertificateFile(Buffer.concat([fixture('leaf2.pem'), broken, fixture('int.pem')]), NOW);
    expect(res.certs).toHaveLength(2);
    expect(res.unreadableCerts).toBe(1);
    expect(res.chain).toBeUndefined();
    expect(describeCertificateFile(fixture('leaf2.pem'), NOW).unreadableCerts).toBeUndefined();
  });

  it('ignores a host that is not a plain host name, and does no check without one', () => {
    for (const bad of ['', '   ', 'a b', 'x\u0000y', 'x'.repeat(300), 42, null, { a: 1 }]) {
      const res = describeCertificateFile(fixture('leaf2.pem'), NOW, bad);
      expect(res.checkedHost).toBeUndefined();
      expect(res.certs[0].hostMatch).toBeUndefined();
    }
    expect(describeCertificateFile(fixture('leaf2.pem'), NOW).certs[0].hostMatch).toBeUndefined();
    expect(validHostInput('  www.example.com ')).toBe('www.example.com');
    expect(validHostInput('2001:db8::1')).toBe('2001:db8::1');
  });

  it('survives a certificate with a corrupted extension block', () => {
    const der = new X509Certificate(fixture('leaf2.pem')).raw;
    // Flip bytes inside the extensions (near the end of the TBS, before the signature) and re-parse.
    const damaged = Buffer.from(der);
    for (let i = 300; i < 330; i++) damaged[i] = 0xff;
    expect(() => describeCertificateFile(Buffer.from(damaged), NOW)).not.toThrow();
  });
});

describe('helpers', () => {
  it('sanitizeDisplay replaces control and bidi characters and caps the length', () => {
    expect(sanitizeDisplay('a\u0000b\u001bc')).toBe('a?b?c');
    expect(sanitizeDisplay('evil‮gnp.exe')).toBe('evil?gnp.exe');
    expect(sanitizeDisplay('x'.repeat(500))).toHaveLength(200);
  });

  it('validityStatus covers the boundaries', () => {
    expect(validityStatus(1000, 2000, 999)).toBe('not-yet-valid');
    expect(validityStatus(0, DAY, 2 * DAY)).toBe('expired');
    expect(validityStatus(0, 31 * DAY, 2 * DAY)).toBe('expiring');
    expect(validityStatus(0, 100 * DAY, 2 * DAY)).toBe('valid');
  });

  it('signatureAlgorithmName marks SHA-1 and MD5 as weak and keeps unknown OIDs', () => {
    expect(signatureAlgorithmName('1.2.840.113549.1.1.5')).toEqual({ name: 'SHA-1 with RSA', weak: true });
    expect(signatureAlgorithmName('1.2.840.113549.1.1.4').weak).toBe(true);
    expect(signatureAlgorithmName('1.3.101.112')).toEqual({ name: 'Ed25519', weak: false });
    expect(signatureAlgorithmName('1.2.3.4')).toEqual({ name: '1.2.3.4', weak: false });
  });
});
