import { X509Certificate, type KeyObject } from 'node:crypto';
import { exportSshWirePublicKey } from '../ca/sshPublicKeyFormat';

/** Certificate details extracted for display in the "cached smartcard identities" UI. */
export interface SmartcardCertificateDetails {
  /** SSH fingerprint (SHA256:...) of the certificate's public key — used to match it to an `ssh-add -l` identity. */
  fingerprint: string;
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  /** Microsoft UPN (User Principal Name) from the Subject Alternative Name extension, if present (common on PIV/CAC/SITHS cards). */
  upn?: string;
  /**
   * Whether the certificate may be used to authenticate (Key Usage digitalSignature and, if an Extended
   * Key Usage is present, clientAuth / smartcard logon / anyEKU). False for signing-only (nonRepudiation),
   * key-management and similar certificates, which must not be offered as SSH identities.
   */
  authCapable: boolean;
}

const SAN_OID = '2.5.29.17';
const UPN_OID = '1.3.6.1.4.1.311.20.2.3';
const KEY_USAGE_OID = '2.5.29.15';
/** Bits of the first Key Usage octet (bit 0 is the most significant). */
const KU_DIGITAL_SIGNATURE = 0x80;
const KU_NON_REPUDIATION = 0x40;
/** Extended Key Usage values that allow client authentication. */
const AUTH_EKU_OIDS = new Set([
  '1.3.6.1.5.5.7.3.2', // id-kp-clientAuth
  '1.3.6.1.4.1.311.20.2.2', // Microsoft smartcard logon
  '2.5.29.37.0', // anyExtendedKeyUsage
]);

// --- Minimal definite-length DER/BER TLV reader --------------------------------------------
// X.509 certificates always use definite-length DER encoding, so a full BER parser isn't needed.

export interface Tlv {
  tag: number;
  /** Start of the value bytes (i.e. right after tag + length octets). */
  start: number;
  /** End of the value bytes (exclusive). */
  end: number;
}

function readLength(buf: Buffer, pos: number): { length: number; bytesRead: number } {
  if (pos >= buf.length) throw new Error('DER: truncated length');
  const first = buf[pos];
  if ((first & 0x80) === 0) return { length: first, bytesRead: 1 };
  const numBytes = first & 0x7f;
  // DER has no indefinite form; more than 4 length bytes cannot describe a certificate (and would
  // overflow a 32-bit shift into a negative length, sending iterateChildren backwards forever).
  if (numBytes < 1 || numBytes > 4 || pos + numBytes >= buf.length) throw new Error('DER: invalid length encoding');
  let length = 0;
  for (let i = 0; i < numBytes; i++) length = length * 256 + buf[pos + 1 + i];
  return { length, bytesRead: 1 + numBytes };
}

export function readTlv(buf: Buffer, pos: number): Tlv {
  if (pos >= buf.length) throw new Error('DER: truncated element');
  const tag = buf[pos];
  const { length, bytesRead } = readLength(buf, pos + 1);
  const start = pos + 1 + bytesRead;
  if (start + length > buf.length) throw new Error('DER: element exceeds buffer');
  return { tag, start, end: start + length };
}

export function* iterateChildren(buf: Buffer, start: number, end: number): Generator<Tlv> {
  let pos = start;
  while (pos < end) {
    const tlv = readTlv(buf, pos);
    yield tlv;
    pos = tlv.end;
  }
}

export function decodeOid(buf: Buffer, start: number, end: number): string {
  const bytes = buf.subarray(start, end);
  const parts: number[] = [Math.floor(bytes[0] / 40), bytes[0] % 40];
  let value = 0;
  for (let i = 1; i < bytes.length; i++) {
    value = (value << 7) | (bytes[i] & 0x7f);
    if ((bytes[i] & 0x80) === 0) {
      parts.push(value);
      value = 0;
    }
  }
  return parts.join('.');
}

/**
 * Extracts the Microsoft UPN (`1.3.6.1.4.1.311.20.2.3`) from a certificate's
 * subjectAltName extension, if present. Node's built-in `X509Certificate`
 * doesn't decode this otherName type (it's Microsoft-specific, not a
 * standard SAN choice like email/DNS), so this walks the raw DER by hand.
 */
export function extractUpnFromCertificateDer(der: Buffer): string | undefined {
  try {
    const cert = readTlv(der, 0); // Certificate ::= SEQUENCE
    const tbs = readTlv(der, cert.start); // tbsCertificate ::= SEQUENCE (first child)

    for (const field of iterateChildren(der, tbs.start, tbs.end)) {
      if (field.tag !== 0xa3) continue; // [3] EXPLICIT extensions
      const extSeq = readTlv(der, field.start); // SEQUENCE OF Extension

      for (const ext of iterateChildren(der, extSeq.start, extSeq.end)) {
        const children = iterateChildren(der, ext.start, ext.end);
        const oidTlv = children.next().value;
        if (!oidTlv || oidTlv.tag !== 0x06) continue;
        if (decodeOid(der, oidTlv.start, oidTlv.end) !== SAN_OID) continue;

        let valueTlv = children.next().value; // optional BOOLEAN critical, then OCTET STRING
        if (valueTlv && valueTlv.tag === 0x01) valueTlv = children.next().value;
        if (!valueTlv || valueTlv.tag !== 0x04) continue;

        const sanSeq = readTlv(der, valueTlv.start); // extnValue content: SEQUENCE OF GeneralName
        for (const generalName of iterateChildren(der, sanSeq.start, sanSeq.end)) {
          if (generalName.tag !== 0xa0) continue; // otherName [0] IMPLICIT SEQUENCE
          const onFields = iterateChildren(der, generalName.start, generalName.end);
          const typeOidTlv = onFields.next().value;
          if (!typeOidTlv || typeOidTlv.tag !== 0x06) continue;
          if (decodeOid(der, typeOidTlv.start, typeOidTlv.end) !== UPN_OID) continue;

          const explicitWrapper = onFields.next().value; // value [0] EXPLICIT ANY
          if (!explicitWrapper) continue;
          const inner = readTlv(der, explicitWrapper.start); // the actual string (usually UTF8String)
          return der.subarray(inner.start, inner.end).toString('utf8');
        }
      }
      return undefined; // extensions block found and scanned; no need to keep looking
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Whether a certificate may be used for authentication. Node exposes only the Extended Key Usage list
 * (as `keyUsage`), not the basic Key Usage bits, so the latter are decoded from the raw DER here.
 *
 * - Key Usage, when present, must include digitalSignature.
 * - Extended Key Usage, when present, must include clientAuth, smartcard logon or anyEKU.
 * - A certificate that also asserts nonRepudiation (contentCommitment) is a signing certificate (a PIV
 *   9c certificate has digitalSignature + nonRepudiation and usually no EKU), so it only counts as
 *   authentication-capable when an EKU says so explicitly.
 *
 * An absent extension places no restriction, and anything that cannot be decoded counts as capable:
 * a parser problem must never hide a card's only usable key.
 */
export function isAuthCapableCertificate(x509: X509Certificate, der: Buffer): boolean {
  try {
    const keyUsageBits = readKeyUsageFirstByte(der);
    if (keyUsageBits !== undefined && (keyUsageBits & KU_DIGITAL_SIGNATURE) === 0) return false;
    const eku = x509.keyUsage;
    const hasEku = !!eku && eku.length > 0;
    const ekuAllowsAuth = hasEku && eku.some((oid) => AUTH_EKU_OIDS.has(oid));
    if (hasEku && !ekuAllowsAuth) return false;
    if (keyUsageBits !== undefined && (keyUsageBits & KU_NON_REPUDIATION) !== 0 && !ekuAllowsAuth) return false;
    return true;
  } catch {
    return true;
  }
}

/** First content byte of the Key Usage BIT STRING, or undefined when the extension is absent. */
function readKeyUsageFirstByte(der: Buffer): number | undefined {
  const cert = readTlv(der, 0);
  const tbs = readTlv(der, cert.start);
  for (const field of iterateChildren(der, tbs.start, tbs.end)) {
    if (field.tag !== 0xa3) continue; // [3] EXPLICIT extensions
    const extSeq = readTlv(der, field.start);
    for (const ext of iterateChildren(der, extSeq.start, extSeq.end)) {
      const children = iterateChildren(der, ext.start, ext.end);
      const oidTlv = children.next().value;
      if (!oidTlv || oidTlv.tag !== 0x06) continue;
      if (decodeOid(der, oidTlv.start, oidTlv.end) !== KEY_USAGE_OID) continue;

      let valueTlv = children.next().value; // optional BOOLEAN critical, then OCTET STRING
      if (valueTlv && valueTlv.tag === 0x01) valueTlv = children.next().value;
      if (!valueTlv || valueTlv.tag !== 0x04) return undefined;

      const bitString = readTlv(der, valueTlv.start);
      // BIT STRING content: one "unused bits" octet, then the flag octets. An empty flag set grants nothing.
      if (bitString.tag !== 0x03) throw new Error('malformed Key Usage');
      return bitString.end - bitString.start > 1 ? der[bitString.start + 1] : 0;
    }
    return undefined;
  }
  return undefined;
}

// --- SSH fingerprint of a certificate's public key ------------------------------------------
// Lets us match a certificate (read directly from the PKCS#11 token) back to the identity
// `ssh-add -l` reports for the same key pair, without relying on CKA_ID/label conventions
// that vary between PKCS#11 providers (OpenSC vs. Net iD vs. p11-kit).

/** Only RSA and ECDSA keys are fingerprinted (the PKCS#11 authentication certificates this reads are never ed25519). */
function computeSshFingerprint(publicKey: KeyObject): string | undefined {
  const type = publicKey.asymmetricKeyType;
  if (type !== 'rsa' && type !== 'ec') return undefined;
  try {
    return exportSshWirePublicKey(publicKey).fingerprint;
  } catch {
    return undefined; // e.g. an EC curve OpenSSH has no name for
  }
}

/**
 * Parses a DER-encoded X.509 certificate (as read directly off a PKCS#11
 * token) into the subset of fields worth surfacing in the UI: subject,
 * issuer, validity window, UPN, and the SSH fingerprint of its key so it
 * can be matched to the corresponding `ssh-add -l` identity.
 */
export function parseCertificateDer(der: Buffer): SmartcardCertificateDetails | undefined {
  try {
    const x509 = new X509Certificate(der);
    const fingerprint = computeSshFingerprint(x509.publicKey);
    if (!fingerprint) return undefined;
    return {
      fingerprint,
      subject: x509.subject,
      issuer: x509.issuer,
      validFrom: x509.validFrom,
      validTo: x509.validTo,
      upn: extractUpnFromCertificateDer(der),
      authCapable: isAuthCapableCertificate(x509, der),
    };
  } catch {
    return undefined;
  }
}
