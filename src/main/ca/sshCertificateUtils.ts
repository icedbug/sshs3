import crypto from 'node:crypto';
import type { SshCaCertificateInfo } from '../../shared/types/sshCa';
import { BinaryReader } from './sshWire';

/** Whole epoch seconds of an ISO timestamp (as produced by parseOpenSshCertificate). */
export function isoToEpochSeconds(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

/** Calculates the OpenSSH-style `SHA256:<base64-no-padding>` fingerprint of a public key wire blob. */
export function computeOpenSshFingerprint(wireBlob: Buffer): string {
  const hash = crypto.createHash('sha256').update(wireBlob).digest('base64');
  return `SHA256:${hash.replace(/=+$/, '')}`;
}

/**
 * Parses an OpenSSH certificate wire blob or single-line text representation.
 * Follows the OpenSSH PROTOCOL.certkeys specification.
 */
export function parseOpenSshCertificate(certInput: string | Buffer): SshCaCertificateInfo {
  let certBlob: Buffer;

  if (typeof certInput === 'string') {
    const trimmed = certInput.trim();
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2 && parts[0].includes('-cert-v01@openssh.com')) {
      certBlob = Buffer.from(parts[1], 'base64');
    } else {
      certBlob = Buffer.from(trimmed, 'base64');
    }
  } else {
    certBlob = certInput;
  }

  if (certBlob.length < 64) {
    throw new Error('Invalid OpenSSH certificate: buffer is too short');
  }

  const reader = new BinaryReader(certBlob);
  const certTypeString = reader.readString();

  if (!certTypeString.includes('-cert-v01@openssh.com')) {
    throw new Error(`Not an OpenSSH certificate: unknown key type "${certTypeString}"`);
  }

  // Nonce
  const nonce = reader.readBuffer();
  if (nonce.length !== 32) {
    throw new Error(`Invalid certificate nonce length: expected 32 bytes, got ${nonce.length}`);
  }

  // Underlying public key bytes depend on certificate type
  let underlyingPubKeyWire: Buffer;
  if (certTypeString.startsWith('ssh-ed25519')) {
    const pk = reader.readBuffer(); // 32 bytes public key
    const pkType = Buffer.from('ssh-ed25519');
    const b = Buffer.alloc(4 + pkType.length + 4 + pk.length);
    b.writeUInt32BE(pkType.length, 0);
    pkType.copy(b, 4);
    b.writeUInt32BE(pk.length, 4 + pkType.length);
    pk.copy(b, 8 + pkType.length);
    underlyingPubKeyWire = b;
  } else if (certTypeString.startsWith('ssh-rsa')) {
    const e = reader.readBuffer();
    const n = reader.readBuffer();
    const pkType = Buffer.from('ssh-rsa');
    const b = Buffer.alloc(4 + pkType.length + 4 + e.length + 4 + n.length);
    let pos = 0;
    b.writeUInt32BE(pkType.length, pos); pos += 4;
    pkType.copy(b, pos); pos += pkType.length;
    b.writeUInt32BE(e.length, pos); pos += 4;
    e.copy(b, pos); pos += e.length;
    b.writeUInt32BE(n.length, pos); pos += 4;
    n.copy(b, pos);
    underlyingPubKeyWire = b;
  } else if (certTypeString.startsWith('ecdsa-sha2-')) {
    const curve = reader.readString();
    const q = reader.readBuffer();
    const pkType = Buffer.from(certTypeString.replace('-cert-v01@openssh.com', ''));
    const curveBuf = Buffer.from(curve);
    const b = Buffer.alloc(4 + pkType.length + 4 + curveBuf.length + 4 + q.length);
    let pos = 0;
    b.writeUInt32BE(pkType.length, pos); pos += 4;
    pkType.copy(b, pos); pos += pkType.length;
    b.writeUInt32BE(curveBuf.length, pos); pos += 4;
    curveBuf.copy(b, pos); pos += curveBuf.length;
    b.writeUInt32BE(q.length, pos); pos += 4;
    q.copy(b, pos);
    underlyingPubKeyWire = b;
  } else {
    throw new Error(`Unsupported certificate key type: "${certTypeString}"`);
  }

  const serialBig = reader.readUint64();
  const certTypeNum = reader.readUint32(); // 1 = user, 2 = host
  const keyId = reader.readString();

  // Principals: string containing a list of strings
  const principalsBlob = reader.readBuffer();
  const principals: string[] = [];
  if (principalsBlob.length > 0) {
    const pReader = new BinaryReader(principalsBlob);
    while (pReader.remaining > 0) {
      principals.push(pReader.readString());
    }
  }

  const validAfterSec = Number(reader.readUint64());
  const validBeforeSec = Number(reader.readUint64());

  // Critical options
  reader.readBuffer();
  // Extensions
  reader.readBuffer();
  // Reserved
  reader.readBuffer();

  // Signature key (CA public key)
  const caKeyWire = reader.readBuffer();
  const signatureKeyFingerprint = computeOpenSshFingerprint(caKeyWire);

  // Signature
  reader.readBuffer();

  const publicKeyFingerprint =
    underlyingPubKeyWire.length > 0 ? computeOpenSshFingerprint(underlyingPubKeyWire) : '';

  return {
    certType: certTypeNum === 1 ? 'user' : 'host',
    keyId,
    principals,
    validAfter: new Date(validAfterSec * 1000).toISOString(),
    validBefore: new Date(validBeforeSec * 1000).toISOString(),
    serial: serialBig.toString(),
    signatureKeyFingerprint,
    publicKeyFingerprint,
  };
}

export interface CertValidationOptions {
  now?: number;
  expectedPublicKeyFingerprint?: string;
  expectedCaFingerprint?: string;
  maxTtlSeconds?: number;
}

/**
 * Validates that an OpenSSH certificate is safe and valid:
 * - Must be a 'user' certificate (not a 'host' certificate).
 * - Must be within its validity window.
 * - Must have at least one principal.
 * - Must match the expected public key fingerprint (if provided).
 * - Must match the expected CA fingerprint (if provided).
 */
export function validateOpenSshCertificate(
  cert: SshCaCertificateInfo,
  options: CertValidationOptions = {}
): { valid: boolean; error?: string } {
  const now = options.now ?? Date.now();
  const validAfterMs = new Date(cert.validAfter).getTime();
  const validBeforeMs = new Date(cert.validBefore).getTime();

  if (cert.certType !== 'user') {
    return { valid: false, error: `Invalid certificate type "${cert.certType}": expected a user certificate` };
  }

  if (cert.principals.length === 0) {
    return { valid: false, error: 'Certificate has no principals specified' };
  }

  // Allow 5 minutes clock skew for validAfter
  if (validAfterMs - now > 5 * 60 * 1000) {
    return { valid: false, error: `Certificate is not yet valid (valid after ${cert.validAfter})` };
  }

  if (now >= validBeforeMs) {
    return { valid: false, error: `Certificate has expired (valid until ${cert.validBefore})` };
  }

  if (options.maxTtlSeconds && validBeforeMs - validAfterMs > (options.maxTtlSeconds + 60) * 1000) {
    return { valid: false, error: 'Certificate validity duration exceeds maximum allowed TTL' };
  }

  if (
    options.expectedPublicKeyFingerprint &&
    cert.publicKeyFingerprint &&
    cert.publicKeyFingerprint !== options.expectedPublicKeyFingerprint
  ) {
    return {
      valid: false,
      error: `Certificate public key mismatch: expected ${options.expectedPublicKeyFingerprint}, got ${cert.publicKeyFingerprint}`,
    };
  }

  if (
    options.expectedCaFingerprint &&
    cert.signatureKeyFingerprint &&
    cert.signatureKeyFingerprint !== options.expectedCaFingerprint
  ) {
    return {
      valid: false,
      error: `Certificate CA mismatch: expected ${options.expectedCaFingerprint}, got ${cert.signatureKeyFingerprint}`,
    };
  }

  return { valid: true };
}
