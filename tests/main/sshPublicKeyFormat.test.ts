import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  exportSshWirePublicKey,
  spkiToOpenSsh,
  x509DerToOpenSsh,
  parseSshWirePublicKey,
  encodeEd25519SshWire,
} from '../../src/main/ca/sshPublicKeyFormat';
import { encodeMpint } from '../../src/main/ca/sshWire';

describe('sshPublicKeyFormat', () => {
  it('encodes Ed25519 key correctly', () => {
    const keyPair = crypto.generateKeyPairSync('ed25519');
    const info = exportSshWirePublicKey(keyPair.publicKey, 'test-ed25519');

    expect(info.keyType).toBe('ssh-ed25519');
    expect(info.publicKeyLine).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+ test-ed25519$/);
    expect(info.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);

    const reParsed = parseSshWirePublicKey(info.wireBlob, 'test-ed25519');
    expect(reParsed.wireBase64).toBe(info.wireBase64);
    expect(reParsed.fingerprint).toBe(info.fingerprint);
  });

  it('encodes RSA-2048 key correctly', () => {
    const keyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const info = exportSshWirePublicKey(keyPair.publicKey, 'test-rsa');

    expect(info.keyType).toBe('ssh-rsa');
    expect(info.publicKeyLine).toMatch(/^ssh-rsa [A-Za-z0-9+/=]+ test-rsa$/);
    expect(info.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);

    const reParsed = parseSshWirePublicKey(info.wireBlob, 'test-rsa');
    expect(reParsed.wireBase64).toBe(info.wireBase64);
  });

  it('encodes ECDSA NIST-P256 key correctly', () => {
    const keyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const info = exportSshWirePublicKey(keyPair.publicKey, 'test-ecdsa');

    expect(info.keyType).toBe('ecdsa-sha2-nistp256');
    expect(info.publicKeyLine).toMatch(/^ecdsa-sha2-nistp256 [A-Za-z0-9+/=]+ test-ecdsa$/);
    expect(info.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);

    const reParsed = parseSshWirePublicKey(info.wireBlob, 'test-ecdsa');
    expect(reParsed.wireBase64).toBe(info.wireBase64);
  });

  it('converts SPKI DER to OpenSSH format', () => {
    const keyPair = crypto.generateKeyPairSync('ed25519');
    const spki = keyPair.publicKey.export({ type: 'spki', format: 'der' });

    const info = spkiToOpenSsh(spki);
    expect(info.keyType).toBe('ssh-ed25519');
    expect(info.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
  });

  it('converts X.509 DER certificate to OpenSSH format', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const der = fs.readFileSync(path.join(__dirname, 'fixtures', 'certs', 'leaf.der'));
    const info = x509DerToOpenSsh(der);
    expect(info.keyType).toBe('ssh-rsa');
    expect(info.publicKeyLine).toMatch(/^ssh-rsa /);
    expect(info.fingerprint).toMatch(/^SHA256:/);
  });

  it('rejects invalid ed25519 length', () => {
    expect(() => encodeEd25519SshWire(Buffer.alloc(16))).toThrow(/expected 32 bytes/);
  });

  it('rejects malformed wire blob in parseSshWirePublicKey', () => {
    expect(() => parseSshWirePublicKey(Buffer.from([0, 0]))).toThrow(/too short/);
  });

  it('encodes mpint correctly for zero, positive, and high-bit integers per RFC 4251', () => {
    // Zero MUST be 0-length string: 4 bytes length of 0, 0 data bytes
    expect(encodeMpint(Buffer.alloc(0))).toEqual(Buffer.from([0x00, 0x00, 0x00, 0x00]));
    expect(encodeMpint(Buffer.from([0x00]))).toEqual(Buffer.from([0x00, 0x00, 0x00, 0x00]));

    // Positive integer without high bit set
    expect(encodeMpint(Buffer.from([0x01, 0x02]))).toEqual(Buffer.from([0x00, 0x00, 0x00, 0x02, 0x01, 0x02]));

    // Positive integer with MSB set (0x80) gets 0x00 prefix to stay positive
    expect(encodeMpint(Buffer.from([0x80, 0x01]))).toEqual(Buffer.from([0x00, 0x00, 0x00, 0x03, 0x00, 0x80, 0x01]));
  });
});
