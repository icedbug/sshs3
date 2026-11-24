import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('electron', async () => await import('../../src/main/web/electronShim'));

import { callerAddress, isSecureRequest, parseTrustedProxies } from '../../src/main/web/trustedProxies';
import { ADMIN_PASSWORD, startWebServer, type WebServerKit } from '../helpers/webServerKit';

/**
 * A reverse proxy's headers (`X-Forwarded-For`, `X-Forwarded-Proto`) are read only from a proxy named in
 * SSHS3_TRUSTED_PROXIES. Before, `X-Forwarded-Proto` was believed from anybody, and behind a proxy the
 * sign-in limit per address counted everybody as the proxy.
 */

const request = (peer: string, headers: Record<string, string | string[]> = {}, encrypted = false) => ({ headers, socket: { remoteAddress: peer, encrypted } });

describe('SSHS3_TRUSTED_PROXIES: the list', () => {
  it('takes addresses and ranges, IPv4 and IPv6, and leaves out what is neither', () => {
    const proxies = parseTrustedProxies(' 10.0.0.5, 10.1.0.0/16 ,::1, 2001:db8::/32, proxy.example.com, 10.0.0.0/40, 10.0.0.9/x, ');
    expect(proxies.entries).toEqual(['10.0.0.5', '10.1.0.0/16', '::1', '2001:db8::/32']);
    expect(proxies.ignored).toEqual(['proxy.example.com', '10.0.0.0/40', '10.0.0.9/x']);
    expect(proxies.has('10.0.0.5')).toBe(true);
    expect(proxies.has('::ffff:10.0.0.5')).toBe(true);
    expect(proxies.has('10.0.0.6')).toBe(false);
    expect(proxies.has('10.1.200.7')).toBe(true);
    expect(proxies.has('10.2.0.1')).toBe(false);
    expect(proxies.has('::1')).toBe(true);
    expect(proxies.has('2001:db8:1::7')).toBe(true);
    expect(proxies.has('2001:db9::7')).toBe(false);
    expect(proxies.has('not an address')).toBe(false);
    expect(parseTrustedProxies(undefined).entries).toEqual([]);
  });
});

describe('who a request is from', () => {
  const proxies = parseTrustedProxies('10.0.0.5, 10.9.0.0/24');

  it('is the socket when no proxy is trusted, whatever the headers say', () => {
    const none = parseTrustedProxies('');
    expect(callerAddress(request('::ffff:198.51.100.7', { 'x-forwarded-for': '203.0.113.1' }), none)).toBe('198.51.100.7');
    expect(isSecureRequest(request('198.51.100.7', { 'x-forwarded-proto': 'https' }), none)).toBe(false);
  });

  it('is the socket when the request does not come from a trusted proxy', () => {
    expect(callerAddress(request('198.51.100.7', { 'x-forwarded-for': '203.0.113.1' }), proxies)).toBe('198.51.100.7');
    expect(isSecureRequest(request('198.51.100.7', { 'x-forwarded-proto': 'https' }), proxies)).toBe(false);
  });

  it('is the last address in X-Forwarded-For that is not a trusted proxy', () => {
    expect(callerAddress(request('10.0.0.5', { 'x-forwarded-for': '203.0.113.1' }), proxies)).toBe('203.0.113.1');
    // What a caller wrote in front is not believed: the proxy added the address it saw at the end.
    expect(callerAddress(request('10.0.0.5', { 'x-forwarded-for': '9.9.9.9, 203.0.113.1' }), proxies)).toBe('203.0.113.1');
    // Two proxies in a row: the inner one is skipped.
    expect(callerAddress(request('10.0.0.5', { 'x-forwarded-for': '9.9.9.9, 203.0.113.1, 10.9.0.4' }), proxies)).toBe('203.0.113.1');
    expect(callerAddress(request('10.0.0.5', { 'x-forwarded-for': ['9.9.9.9', '203.0.113.2'] }), proxies)).toBe('203.0.113.2');
    // With a port, as some proxies write it.
    expect(callerAddress(request('10.0.0.5', { 'x-forwarded-for': '203.0.113.3:51234' }), proxies)).toBe('203.0.113.3');
    expect(callerAddress(request('10.0.0.5', { 'x-forwarded-for': '[2001:db8::7]:51234' }), proxies)).toBe('2001:db8::7');
    // No header, or only proxies in it.
    expect(callerAddress(request('10.0.0.5'), proxies)).toBe('10.0.0.5');
    expect(callerAddress(request('10.0.0.5', { 'x-forwarded-for': '10.9.0.4, 10.9.0.3' }), proxies)).toBe('10.9.0.4');
  });

  it('is over https when the socket is encrypted, or a trusted proxy says so', () => {
    expect(isSecureRequest(request('198.51.100.7', {}, true), proxies)).toBe(true);
    expect(isSecureRequest(request('10.0.0.5', { 'x-forwarded-proto': 'https' }), proxies)).toBe(true);
    expect(isSecureRequest(request('10.0.0.5', { 'x-forwarded-proto': 'HTTPS, http' }), proxies)).toBe(true);
    expect(isSecureRequest(request('10.0.0.5', { 'x-forwarded-proto': 'http' }), proxies)).toBe(false);
    expect(isSecureRequest(request('10.0.0.5'), proxies)).toBe(false);
  });
});

describe('web server behind a proxy', () => {
  let kit: WebServerKit;

  afterEach(async () => {
    vi.unstubAllEnvs();
    await kit?.stop();
  });

  /** A wrong sign-in as it would reach the server through a proxy that took it from `from`. */
  const wrongSignIn = async (from: string, n: number): Promise<string> =>
    (await kit.send('POST', '/api/auth/login', { username: `nobody-${from}-${n}`, password: 'wrong-password' }, undefined, { headers: { 'X-Forwarded-For': from } })).body.error; // pragma: allowlist secret
  const setCookieOf = async (headers: Record<string, string>): Promise<string> => {
    const res = await fetch(`${kit.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ username: 'maria', password: ADMIN_PASSWORD }),
    });
    expect(res.status).toBe(200);
    return res.headers.get('set-cookie') ?? '';
  };

  it('reads neither header without the setting: one limit for the socket, and no Secure on a say-so', async () => {
    vi.stubEnv('SSHS3_TRUSTED_PROXIES', '');
    kit = await startWebServer();
    await kit.send('POST', '/api/auth/setup', { username: 'maria', password: ADMIN_PASSWORD });
    expect(await setCookieOf({ 'X-Forwarded-Proto': 'https' })).not.toMatch(/;\s*Secure/i);
    const answers: string[] = [];
    // Every attempt claims another address. They all count as the one on the socket.
    for (let i = 0; i < 32; i++) answers.push(await wrongSignIn(`203.0.113.${i + 1}`, i));
    expect(answers.filter((a) => a === 'Wrong user name or password')).toHaveLength(30);
    expect(answers.filter((a) => a.startsWith('Too many'))).toHaveLength(2);
    const journal = await kit.server.signIns.recent(100);
    expect(journal.some((e) => e.detail === 'from 127.0.0.1')).toBe(true);
    expect(journal.some((e) => /203\.0\.113\./.test(e.detail ?? ''))).toBe(false);
  });

  it('counts failed sign-ins per forwarded address when the proxy is trusted, and marks the cookie Secure', async () => {
    vi.stubEnv('SSHS3_TRUSTED_PROXIES', '127.0.0.1, ::1');
    kit = await startWebServer();
    await kit.send('POST', '/api/auth/setup', { username: 'maria', password: ADMIN_PASSWORD });
    expect(await setCookieOf({ 'X-Forwarded-Proto': 'https' })).toMatch(/;\s*Secure/i);
    expect(await setCookieOf({ 'X-Forwarded-Proto': 'http' })).not.toMatch(/;\s*Secure/i);
    expect(await setCookieOf({})).not.toMatch(/;\s*Secure/i);

    const first: string[] = [];
    for (let i = 0; i < 31; i++) first.push(await wrongSignIn('203.0.113.1', i));
    expect(first.filter((a) => a === 'Wrong user name or password')).toHaveLength(30);
    expect(first[30]).toMatch(/^Too many/);
    // Another caller behind the same proxy has a count of their own.
    expect(await wrongSignIn('203.0.113.2', 0)).toBe('Wrong user name or password');
    // An address written in front of the real one does not get the first caller out of their limit.
    expect(await wrongSignIn('198.51.100.99, 203.0.113.1', 99)).toMatch(/^Too many/);
    const journal = await kit.server.signIns.recent(200);
    expect(journal.some((e) => e.detail === 'from 203.0.113.1')).toBe(true);
    expect(journal.some((e) => e.detail === 'from 203.0.113.2')).toBe(true);
  });
});
