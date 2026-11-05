import { decodeOid } from '../smartcard/CertificateParser';

/**
 * Bounds-checked readers for the X.509 extensions Node does not decode (Key Usage bits, path length,
 * CRL distribution points). The input is untrusted: every length is checked against its parent and a
 * malformed structure yields `undefined` / an empty list, never an exception or an unbounded loop.
 */

interface Node {
  tag: number;
  /** Start of the value bytes. */
  start: number;
  /** End of the value bytes (exclusive). */
  end: number;
}

const MAX_CHILDREN = 64;
const KEY_USAGE_OID = '2.5.29.15';
const BASIC_CONSTRAINTS_OID = '2.5.29.19';
const CRL_DISTRIBUTION_POINTS_OID = '2.5.29.31';

const KEY_USAGE_NAMES = [
  'digitalSignature',
  'nonRepudiation',
  'keyEncipherment',
  'dataEncipherment',
  'keyAgreement',
  'keyCertSign',
  'cRLSign',
  'encipherOnly',
  'decipherOnly',
];

function readNode(buf: Buffer, pos: number, limit: number): Node | undefined {
  if (pos < 0 || pos + 2 > limit) return undefined;
  const tag = buf[pos];
  const first = buf[pos + 1];
  let length = first;
  let headerEnd = pos + 2;
  if ((first & 0x80) !== 0) {
    const count = first & 0x7f;
    if (count === 0 || count > 3 || headerEnd + count > limit) return undefined;
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + buf[headerEnd + i];
    headerEnd += count;
  }
  const end = headerEnd + length;
  return end <= limit ? { tag, start: headerEnd, end } : undefined;
}

function childrenOf(buf: Buffer, parent: Node): Node[] {
  const out: Node[] = [];
  let pos = parent.start;
  while (pos < parent.end && out.length < MAX_CHILDREN) {
    const child = readNode(buf, pos, parent.end);
    if (!child) break;
    out.push(child);
    pos = child.end;
  }
  return out;
}

/** The value of the extension with this OID: the DER inside its OCTET STRING. */
function extensionValue(der: Buffer, oid: string): Node | undefined {
  const cert = readNode(der, 0, der.length);
  if (!cert) return undefined;
  const tbs = childrenOf(der, cert)[0];
  if (!tbs) return undefined;
  for (const field of childrenOf(der, tbs)) {
    if (field.tag !== 0xa3) continue; // [3] EXPLICIT extensions
    const list = readNode(der, field.start, field.end);
    if (!list) return undefined;
    for (const ext of childrenOf(der, list)) {
      const parts = childrenOf(der, ext);
      const id = parts[0];
      if (!id || id.tag !== 0x06 || decodeOid(der, id.start, id.end) !== oid) continue;
      const octets = parts[parts.length - 1]; // optional BOOLEAN critical sits before it
      if (!octets || octets.tag !== 0x04) return undefined;
      return { tag: octets.tag, start: octets.start, end: octets.end };
    }
    return undefined;
  }
  return undefined;
}

/** Names of the Key Usage bits that are set (e.g. `digitalSignature`, `keyCertSign`); empty when absent. */
export function readKeyUsage(der: Buffer): string[] {
  try {
    const value = extensionValue(der, KEY_USAGE_OID);
    const bits = value && readNode(der, value.start, value.end);
    if (!bits || bits.tag !== 0x03 || bits.end - bits.start < 2) return [];
    const names: string[] = [];
    for (let i = 0; i < KEY_USAGE_NAMES.length; i++) {
      const byte = der[bits.start + 1 + (i >> 3)];
      if (bits.start + 1 + (i >> 3) < bits.end && byte !== undefined && (byte & (0x80 >> (i & 7))) !== 0) {
        names.push(KEY_USAGE_NAMES[i]);
      }
    }
    return names;
  } catch {
    return [];
  }
}

/** The pathLenConstraint of Basic Constraints, when the certificate sets one. */
export function readPathLength(der: Buffer): number | undefined {
  try {
    const value = extensionValue(der, BASIC_CONSTRAINTS_OID);
    const seq = value && readNode(der, value.start, value.end);
    if (!seq || seq.tag !== 0x30) return undefined;
    const integer = childrenOf(der, seq).find((child) => child.tag === 0x02);
    if (!integer || integer.end - integer.start < 1 || integer.end - integer.start > 2) return undefined;
    const length = integer.end - integer.start === 1 ? der[integer.start] : (der[integer.start] << 8) | der[integer.start + 1];
    return length < 0x8000 ? length : undefined;
  } catch {
    return undefined;
  }
}

/** URIs from the CRL Distribution Points extension (raw; the caller sanitizes and caps them). */
export function readCrlUrls(der: Buffer): string[] {
  try {
    const value = extensionValue(der, CRL_DISTRIBUTION_POINTS_OID);
    const seq = value && readNode(der, value.start, value.end);
    if (!seq || seq.tag !== 0x30) return [];
    const urls: string[] = [];
    for (const point of childrenOf(der, seq)) {
      const distributionPoint = childrenOf(der, point).find((n) => n.tag === 0xa0);
      const fullName = distributionPoint && childrenOf(der, distributionPoint).find((n) => n.tag === 0xa0);
      if (!fullName) continue;
      for (const name of childrenOf(der, fullName)) {
        if (name.tag === 0x86) urls.push(der.subarray(name.start, name.end).toString('latin1')); // [6] uniformResourceIdentifier
      }
    }
    return urls;
  } catch {
    return [];
  }
}
