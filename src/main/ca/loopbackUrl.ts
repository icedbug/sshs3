/**
 * True only for an `http://` URL whose host is exactly localhost, an IPv4 127.x.x.x address or [::1].
 * A prefix test such as `startsWith('http://localhost')` also accepts `http://localhost.evil.com`
 * and `http://127.0.0.1.nip.io`, which would let tokens travel over plain HTTP to a remote host.
 */
export function isLoopbackHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host === '[::1]') return true;
  const octets = host.split('.');
  return octets.length === 4 && octets[0] === '127' && octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255);
}
