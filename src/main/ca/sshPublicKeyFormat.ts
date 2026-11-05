import crypto from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { computeOpenSshFingerprint } from './sshCertificateUtils';
import { encodeMpint, encodeSshString } from './sshWire';

const EC_CURVE_NAMES: Record<string, string> = {
  'P-256': 'nistp256',
  'P-384': 'nistp384',
  'P-521': 'nistp521',
};

export interface SshWireKeyInfo {
  wireBlob: Buffer;
  keyType: string;
  wireBase64: string;
  publicKeyLine: string;
  fingerprint: string;
}

/**
 * Encodes a 32-byte Ed25519 public key into the RFC 4253 OpenSSH wire format blob.
 */
export function encodeEd25519SshWire(pubKeyBytes: Buffer): Buffer {
  if (pubKeyBytes.length !== 32) {
    throw new Error(`Invalid Ed25519 public key length: expected 32 bytes, got ${pubKeyBytes.length}`);
  }
  return Buffer.concat([
    encodeSshString('ssh-ed25519'),
    encodeSshString(pubKeyBytes),
  ]);
}

/**
 * Builds RFC 4253 OpenSSH wire format for a crypto.KeyObject (Ed25519, RSA, or ECDSA).
 */
export function exportSshWirePublicKey(publicKey: KeyObject, comment = 'sshs3-ca'): SshWireKeyInfo {
  let wireBlob: Buffer | undefined;
  let keyType: string;

  if (publicKey.asymmetricKeyType === 'ed25519') {
    keyType = 'ssh-ed25519';
    const spki = publicKey.export({ type: 'spki', format: 'der' });
    const rawKey = spki.subarray(spki.length - 32);
    wireBlob = encodeEd25519SshWire(rawKey);
  } else if (publicKey.asymmetricKeyType === 'rsa') {
    keyType = 'ssh-rsa';
    const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
    const n = Buffer.from(jwk.n, 'base64url');
    const e = Buffer.from(jwk.e, 'base64url');
    wireBlob = Buffer.concat([encodeSshString('ssh-rsa'), encodeMpint(e), encodeMpint(n)]);
  } else if (publicKey.asymmetricKeyType === 'ec') {
    const jwk = publicKey.export({ format: 'jwk' }) as { crv: string; x: string; y: string };
    const curve = EC_CURVE_NAMES[jwk.crv];
    if (!curve) {
      throw new Error(`Unsupported elliptic curve for SSH: "${jwk.crv}"`);
    }
    keyType = `ecdsa-sha2-${curve}`;
    const x = Buffer.from(jwk.x, 'base64url');
    const y = Buffer.from(jwk.y, 'base64url');
    const point = Buffer.concat([Buffer.from([0x04]), x, y]);
    wireBlob = Buffer.concat([
      encodeSshString(keyType),
      encodeSshString(curve),
      encodeSshString(point),
    ]);
  } else {
    throw new Error(`Unsupported asymmetric key type for SSH: "${publicKey.asymmetricKeyType}"`);
  }

  const wireBase64 = wireBlob.toString('base64');
  const publicKeyLine = `${keyType} ${wireBase64} ${comment}`.trim();
  const fingerprint = computeOpenSshFingerprint(wireBlob);

  return {
    wireBlob,
    keyType,
    wireBase64,
    publicKeyLine,
    fingerprint,
  };
}

/**
 * Converts a DER-encoded X.509 SPKI (SubjectPublicKeyInfo) into OpenSSH public key wire format.
 */
export function spkiToOpenSsh(spkiDer: Buffer, comment = 'sshs3-ca'): SshWireKeyInfo {
  const pubKey = crypto.createPublicKey({
    key: spkiDer,
    format: 'der',
    type: 'spki',
  });
  return exportSshWirePublicKey(pubKey, comment);
}

/**
 * Converts a DER-encoded X.509 certificate (such as read from a PIV card slot) into OpenSSH public key wire format.
 */
export function x509DerToOpenSsh(x509Der: Buffer, comment = 'sshs3-ca'): SshWireKeyInfo {
  const cert = new crypto.X509Certificate(x509Der);
  return exportSshWirePublicKey(cert.publicKey, comment);
}

/**
 * Wraps an existing OpenSSH wire public key blob into SshWireKeyInfo.
 */
export function parseSshWirePublicKey(wireBlob: Buffer, comment = 'sshs3-ca'): SshWireKeyInfo {
  if (wireBlob.length < 4) {
    throw new Error('Invalid SSH public key: blob is too short');
  }
  const typeLen = wireBlob.readUInt32BE(0);
  if (wireBlob.length < 4 + typeLen) {
    throw new Error('Invalid SSH public key: truncated key type');
  }
  const keyType = wireBlob.subarray(4, 4 + typeLen).toString('utf-8');
  const wireBase64 = wireBlob.toString('base64');
  const publicKeyLine = `${keyType} ${wireBase64} ${comment}`.trim();
  const fingerprint = computeOpenSshFingerprint(wireBlob);

  return {
    wireBlob,
    keyType,
    wireBase64,
    publicKeyLine,
    fingerprint,
  };
}
