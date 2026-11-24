import type http from 'node:http';
import { BlockList, isIP } from 'node:net';

/**
 * Who a request is from when the server sits behind a reverse proxy.
 *
 * A proxy says in `X-Forwarded-For` whom it took the request from and in `X-Forwarded-Proto` whether
 * that was https. Anybody can send those headers, so they are read only when the request itself
 * arrives from an address named in `SSHS3_TRUSTED_PROXIES` (addresses or CIDR ranges, comma
 * separated). Without the setting neither header is read: the caller is whoever is on the socket.
 */

/** An address as the socket gives it, without the IPv4-in-IPv6 prefix, so "::ffff:10.0.0.5" is "10.0.0.5". */
export function plainAddress(address: string | undefined): string {
  const a = (address ?? '').trim().toLowerCase();
  return a.startsWith('::ffff:') && a.includes('.') ? a.slice('::ffff:'.length) : a;
}

export interface TrustedProxies {
  /** The entries that were understood, as written. */
  entries: string[];
  /** The entries that are neither an address nor a range: they are left out. */
  ignored: string[];
  has(address: string): boolean;
}

/** Reads a list such as "10.0.0.5, 10.1.0.0/16, ::1". */
export function parseTrustedProxies(list: string | undefined): TrustedProxies {
  const block = new BlockList();
  const entries: string[] = [];
  const ignored: string[] = [];
  for (const raw of (list ?? '').split(',')) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    const slash = entry.indexOf('/');
    const address = plainAddress(slash < 0 ? entry : entry.slice(0, slash));
    const family = isIP(address);
    const bits = slash < 0 ? undefined : Number(entry.slice(slash + 1));
    const width = family === 4 ? 32 : 128;
    if (!family || (bits !== undefined && (!/^\d+$/.test(entry.slice(slash + 1)) || bits > width))) {
      ignored.push(entry);
      continue;
    }
    if (bits === undefined) block.addAddress(address, family === 4 ? 'ipv4' : 'ipv6');
    else block.addSubnet(address, bits, family === 4 ? 'ipv4' : 'ipv6');
    entries.push(entry);
  }
  return {
    entries,
    ignored,
    has: (address) => {
      const plain = plainAddress(address);
      const family = isIP(plain);
      return family !== 0 && block.check(plain, family === 4 ? 'ipv4' : 'ipv6');
    },
  };
}

let read: { list: string; proxies: TrustedProxies } | undefined;

/** The proxies named in `SSHS3_TRUSTED_PROXIES`. Read again when the variable changes. */
export function trustedProxies(env: NodeJS.ProcessEnv = process.env): TrustedProxies {
  const list = env.SSHS3_TRUSTED_PROXIES ?? '';
  if (read?.list !== list) read = { list, proxies: parseTrustedProxies(list) };
  return read.proxies;
}

type Incoming = Pick<http.IncomingMessage, 'headers'> & { socket?: { remoteAddress?: string; encrypted?: boolean } };

/** A name as a proxy may write it in `X-Forwarded-For`: "10.0.0.5", "10.0.0.5:4711" or "[2001:db8::1]:4711". */
function forwardedAddress(entry: string): string {
  const text = entry.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(text);
  if (bracketed) return plainAddress(bracketed[1]);
  const withPort = /^(\d+\.\d+\.\d+\.\d+):\d+$/.exec(text);
  return plainAddress(withPort ? withPort[1] : text);
}

/**
 * The address a request comes from. From a trusted proxy it is the last address in `X-Forwarded-For`
 * that is not itself a trusted proxy: what the nearest proxy saw, not what a caller wrote in front of
 * it. From anybody else it is the address on the socket.
 */
export function callerAddress(req: Incoming, proxies: TrustedProxies = trustedProxies()): string {
  const peer = plainAddress(req.socket?.remoteAddress);
  if (!peer || !proxies.has(peer)) return peer;
  const header = req.headers['x-forwarded-for'];
  const hops = (Array.isArray(header) ? header.join(',') : (header ?? ''))
    .split(',')
    .map(forwardedAddress)
    .filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) if (!proxies.has(hops[i]!)) return hops[i]!;
  // Every address in the header is a proxy of ours: the request began at the first of them.
  return hops[0] ?? peer;
}

/**
 * Whether the person's browser reached the server over https: the socket is encrypted, or a trusted
 * proxy says so. Decides the "Secure" mark of the session cookie.
 */
export function isSecureRequest(req: Incoming, proxies: TrustedProxies = trustedProxies()): boolean {
  if (req.socket?.encrypted === true) return true;
  if (!proxies.has(plainAddress(req.socket?.remoteAddress))) return false;
  const proto = req.headers['x-forwarded-proto'];
  const first = (Array.isArray(proto) ? proto[0] : proto)?.split(',')[0]?.trim().toLowerCase();
  return first === 'https';
}
