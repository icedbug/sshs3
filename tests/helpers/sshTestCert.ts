import crypto from 'node:crypto';
import { BinaryReader } from '../../src/main/ca/sshWire';

export interface TestCertificate {
  wire: Buffer;
  wireBase64: string;
  /** authorized_keys-style `<type>-cert-v01@openssh.com <base64> <comment>` line. */
  line: string;
}

export interface BuildUserCertificateOptions {
  /** Base64 SSH wire blob of the public key the certificate is issued for. */
  subjectWireBase64: string;
  principals?: string[];
  keyId?: string;
  /** Validity from `now` in seconds (default 3600). */
  validForSeconds?: number;
  /** Epoch seconds treated as "now" (default: the current time). */
  nowSec?: number;
  serial?: bigint;
}

function sshString(value: Buffer | string): Buffer {
  const buf = typeof value === 'string' ? Buffer.from(value) : value;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

function u32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value, 0);
  return b;
}

function u64(value: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(value, 0);
  return b;
}

/**
 * Builds a structurally valid OpenSSH user certificate for any ed25519, rsa or ecdsa public key,
 * signed by a throwaway ed25519 CA. The public-key fields of a certificate are encoded exactly like
 * the key's own wire format (minus the type string), so they are copied over unchanged.
 */
export function buildUserCertificate(options: BuildUserCertificateOptions): TestCertificate {
  const subjectWire = Buffer.from(options.subjectWireBase64, 'base64');
  const reader = new BinaryReader(subjectWire);
  const keyType = reader.readString();
  const keyFields = subjectWire.subarray(subjectWire.length - reader.remaining);

  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  const validAfter = BigInt(nowSec - 60);
  const validBefore = BigInt(nowSec + (options.validForSeconds ?? 3600));
  const principals = options.principals ?? ['alun', 'alun@alun.se'];

  const ca = crypto.generateKeyPairSync('ed25519');
  const caRaw = ca.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const caWire = Buffer.concat([sshString('ssh-ed25519'), sshString(caRaw)]);

  const body = Buffer.concat([
    sshString(`${keyType}-cert-v01@openssh.com`),
    sshString(crypto.randomBytes(32)),
    keyFields,
    u64(options.serial ?? 1n),
    u32(1), // user certificate
    sshString(options.keyId ?? 'test-key-id'),
    sshString(Buffer.concat(principals.map((p) => sshString(p)))),
    u64(validAfter),
    u64(validBefore),
    sshString(Buffer.alloc(0)), // critical options
    sshString(Buffer.alloc(0)), // extensions
    sshString(Buffer.alloc(0)), // reserved
    sshString(caWire),
  ]);
  const signature = crypto.sign(null, body, ca.privateKey);
  const wire = Buffer.concat([body, sshString(Buffer.concat([sshString('ssh-ed25519'), sshString(signature)]))]);
  const wireBase64 = wire.toString('base64');

  return { wire, wireBase64, line: `${keyType}-cert-v01@openssh.com ${wireBase64} test` };
}
