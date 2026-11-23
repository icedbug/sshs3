import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';

vi.mock('electron', async () => await import('../../src/main/web/electronShim'));

import { ADMIN_PASSWORD, MEMBER_PASSWORD, startWebServer, type WebServerKit } from '../helpers/webServerKit';

const mcpCall = (baseUrl: string, token: string): Promise<Response> =>
  fetch(`${baseUrl}/api/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_servers', arguments: {} } }),
  });

describe('web server: sign-ins and what was opened with them', () => {
  let kit: WebServerKit;

  beforeEach(async () => {
    kit = await startWebServer();
  });

  afterEach(async () => {
    await kit.stop();
  });

  // W5: a WebSocket was checked when it was opened and never again.
  it('signing out closes the connections of that sign-in, and only those', async () => {
    const { memberCookie } = await kit.team();
    const second = await kit.send('POST', '/api/auth/login', { username: 'omar', password: MEMBER_PASSWORD });
    const tab = await kit.connect(memberCookie);
    const otherTab = await kit.connect(memberCookie);
    const otherSignIn = await kit.connect(second.cookie);
    expect(await tab.invoke('app:get-platform')).toBeTruthy();

    expect((await kit.send('POST', '/api/auth/logout', {}, memberCookie)).status).toBe(200);
    // 1008: the server says the connection ended because the sign-in did, not because something broke.
    expect(await tab.whenClosed).toBe(1008);
    expect(await otherTab.whenClosed).toBe(1008);
    await expect(tab.invoke('app:get-platform')).rejects.toThrow();
    // The same person's other sign-in (another browser) goes on.
    expect(otherSignIn.closed()).toBe(false);
    expect(await otherSignIn.invoke('app:get-platform')).toBeTruthy();
    otherSignIn.close();
  });

  it('a new password closes the connections of every other sign-in', async () => {
    const { memberCookie, adminCookie } = await kit.team();
    // A second sign-in of the same person: say, a laptop that was stolen.
    const stolen = await kit.send('POST', '/api/auth/login', { username: 'omar', password: MEMBER_PASSWORD });
    const thief = await kit.connect(stolen.cookie);
    const mine = await kit.connect(memberCookie);
    const admin = await kit.connect(adminCookie);
    // A ticket the thief asked for before the change opens nothing after it.
    const ticket = await kit.send('POST', '/api/ws-ticket', {}, stolen.cookie);

    const changed = await kit.send('POST', '/api/user/password', { currentPassword: MEMBER_PASSWORD, newPassword: 'omar-new-password-456' }, memberCookie); // pragma: allowlist secret
    expect(changed.status).toBe(200);
    expect(await thief.whenClosed).toBe(1008);
    expect((await kit.send('GET', '/api/mcp-keys', undefined, stolen.cookie)).status).toBe(401);
    const late = new WebSocket(`${kit.baseUrl.replace('http', 'ws')}/api/ws?ticket=${encodeURIComponent(ticket.body.ticket)}`);
    await new Promise<void>((resolve) => {
      late.addEventListener('error', () => resolve());
      late.addEventListener('open', () => resolve());
    });
    expect(late.readyState).not.toBe(WebSocket.OPEN);
    // The sign-in the password was changed from stays, and so does everybody else's.
    expect(mine.closed()).toBe(false);
    expect(await mine.invoke('app:get-platform')).toBeTruthy();
    expect(admin.closed()).toBe(false);
    mine.close();
    admin.close();
  });

  it('turning an account off, or removing it, closes its connections', async () => {
    const { memberCookie, memberId, adminCookie } = await kit.team();
    const omar = await kit.connect(memberCookie);
    const maria = await kit.connect(adminCookie);
    await kit.server.auth.deprovisionUser(memberId);
    expect(await omar.whenClosed).toBe(1008);
    expect(maria.closed()).toBe(false);

    await kit.server.auth.reactivateUser(memberId);
    const again = await kit.send('POST', '/api/auth/login', { username: 'omar', password: MEMBER_PASSWORD });
    const back = await kit.connect(again.cookie);
    expect((await kit.send('DELETE', `/api/admin/users/${memberId}`, undefined, adminCookie)).status).toBe(200);
    expect(await back.whenClosed).toBeGreaterThan(0);
    maria.close();
  });

  it('a sign-in that ended does nothing more over a connection that is still closing', async () => {
    const { memberCookie, memberId } = await kit.team();
    const omar = await kit.connect(memberCookie);
    // The session is gone from the account file without anybody being told (as when it runs out).
    const sessions = (kit.server.auth as unknown as { data: { sessions: Array<{ userId: string }> } }).data.sessions;
    sessions.splice(0, sessions.length, ...sessions.filter((s) => s.userId !== memberId));
    await expect(omar.invoke('app:get-platform')).rejects.toThrow();
    expect(await omar.whenClosed).toBe(1008);
  });

  // W6: a turned-off account kept working through its MCP keys and its alert address.
  it('a turned-off account\'s MCP key and alert address are refused', async () => {
    const { memberCookie, memberId } = await kit.team();
    const key = await kit.send('POST', '/api/mcp-keys', { name: 'laptop', scopes: ['read'] }, memberCookie);
    expect(key.status).toBe(200);
    expect((await mcpCall(kit.baseUrl, key.body.token)).status).toBe(200);
    const omar = await kit.connect(memberCookie);
    const made = (await omar.invoke('ai-hub:request', { action: 'alert-hook-create' })) as { reply?: { alertHook?: { path?: string } } };
    omar.close();
    const hookPath = made.reply?.alertHook?.path;
    expect(hookPath).toMatch(/^\/api\/hooks\//);
    expect((await kit.send('POST', hookPath!, { title: 'disk full' })).status).toBe(200);

    expect(kit.server.tenants.runningUserIds()).toContain(memberId);
    await kit.server.auth.deprovisionUser(memberId);
    // What ran for the account in the background (its hub, with its schedules) stops with it.
    await vi.waitFor(() => expect(kit.server.tenants.runningUserIds()).not.toContain(memberId));
    const refused = await mcpCall(kit.baseUrl, key.body.token);
    expect(refused.status).toBe(401);
    // The same answer as for a key that never existed: nothing says the account is only turned off.
    const unknown = await mcpCall(kit.baseUrl, key.body.token.replace(/.$/, 'x'));
    expect(await refused.text()).toBe(await unknown.text());
    expect((await kit.send('POST', hookPath!, { title: 'disk full' })).status).toBe(404);
    expect((await kit.send('POST', `/api/hooks/${memberId}.${'x'.repeat(32)}`, { title: 'disk full' })).status).toBe(404);
    // Nor is its background work started again when the server starts.
    await kit.server.tenants.disposeAll();
    expect(await kit.server.wakeUsers()).toBe(1);

    await kit.server.auth.reactivateUser(memberId);
    expect((await mcpCall(kit.baseUrl, key.body.token)).status).toBe(200);
  });

  // W7: four redemptions of a single-use invite at once made four accounts.
  it('an invite for one person makes one account, however many redeem it at once', async () => {
    const admin = await kit.send('POST', '/api/auth/setup', { username: 'maria', password: ADMIN_PASSWORD });
    const invite = await kit.send('POST', '/api/admin/invites', { role: 'admin', maxUses: 1 }, admin.cookie);
    const token = invite.body.invite.token;
    const results = await Promise.all(
      ['a1', 'a2', 'a3', 'a4'].map((name) => kit.send('POST', '/api/auth/register-invite', { inviteToken: token, username: `eve-${name}`, password: 'eve-password-123' })), // pragma: allowlist secret
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 400)).toHaveLength(3);
    const users = await kit.send('GET', '/api/admin/users', undefined, admin.cookie);
    expect(users.body.users.map((u: { role: string }) => u.role).sort()).toEqual(['admin', 'admin']);

    // An invite for three makes three, and a redemption that fails gives its use back.
    const three = await kit.send('POST', '/api/admin/invites', { role: 'member', maxUses: 3 }, admin.cookie);
    const bad = await kit.send('POST', '/api/auth/register-invite', { inviteToken: three.body.invite.token, username: 'x', password: 'short-name-123' }); // pragma: allowlist secret
    expect(bad.status).toBe(400);
    const taken = await kit.send('POST', '/api/auth/register-invite', { inviteToken: three.body.invite.token, username: 'maria', password: 'taken-name-123' }); // pragma: allowlist secret
    expect(taken.status).toBe(400);
    const more = await Promise.all(
      ['b1', 'b2', 'b3', 'b4', 'b5'].map((name) => kit.send('POST', '/api/auth/register-invite', { inviteToken: three.body.invite.token, username: `bo-${name}`, password: 'bo-password-123' })), // pragma: allowlist secret
    );
    expect(more.filter((r) => r.status === 200)).toHaveLength(3);
  });

  // W8: a page on another origin of the same site sends the session cookie along (SameSite=Lax).
  it('a request that changes something is taken only from the server\'s own page', async () => {
    const { adminCookie, memberCookie } = await kit.team();
    const host = new URL(kit.baseUrl).host;
    const elsewhere = { Origin: 'http://wiki.internal.example:3000', 'Content-Type': 'text/plain;charset=UTF-8' };

    const forged = await kit.send('POST', '/api/admin/users', undefined, adminCookie, {
      headers: elsewhere,
      raw: JSON.stringify({ username: 'backdoor', password: 'attacker-chosen-1', role: 'admin' }), // pragma: allowlist secret
    });
    expect(forged.status).toBe(403);
    expect(forged.body.error).toBe('Origin not allowed');
    expect((await kit.send('POST', '/api/auth/login', { username: 'backdoor', password: 'attacker-chosen-1' })).status).toBe(401); // pragma: allowlist secret

    // Every route that changes something, whatever the method.
    for (const [method, route] of [['DELETE', '/api/admin/users/someone'], ['POST', '/api/admin/invites'], ['POST', '/api/user/password'], ['POST', '/api/mcp-keys'], ['POST', '/api/user/ssh-key'], ['POST', '/api/auth/logout'], ['PUT', '/api/anything'], ['PATCH', '/api/anything']] as const) {
      expect((await kit.send(method, route, {}, adminCookie, { headers: { Origin: 'http://wiki.internal.example:3000' } })).status, `${method} ${route}`).toBe(403);
    }
    // Signing in, setting the server up and redeeming an invite are refused from another page as well.
    expect((await kit.send('POST', '/api/auth/login', { username: 'maria', password: ADMIN_PASSWORD }, undefined, { headers: { Origin: 'http://wiki.internal.example:3000' } })).status).toBe(403);
    // "null" is what a sandboxed page or a file sends.
    expect((await kit.send('POST', '/api/admin/invites', { role: 'member' }, adminCookie, { headers: { Origin: 'null' } })).status).toBe(403);
    // The sign-out above was refused: the administrator is still signed in.
    expect((await kit.send('GET', '/api/admin/users', undefined, adminCookie)).status).toBe(200);

    // The server's own page: the same host and port. Without an Origin (a script, curl) there is no page to check.
    expect((await kit.send('POST', '/api/admin/invites', { role: 'member' }, adminCookie, { headers: { Origin: `http://${host}` } })).status).toBe(200);
    expect((await kit.send('POST', '/api/admin/invites', { role: 'member' }, adminCookie)).status).toBe(200);
    // Reading is not a change.
    expect((await kit.send('GET', '/api/admin/users', undefined, adminCookie, { headers: { Origin: 'http://wiki.internal.example:3000' } })).status).toBe(200);

    // A request with a key and no cookie is not a browser acting for somebody: a session token sent as a key.
    // (The MCP endpoint has its own key and its own rule about Origin; it is not part of this.)
    expect(memberCookie).toBeTruthy();
    const sessionToken = decodeURIComponent(adminCookie.split('=')[1]!);
    const withKey = await fetch(`${kit.baseUrl}/api/admin/invites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}`, Origin: 'http://wiki.internal.example:3000' },
      body: JSON.stringify({ role: 'member' }),
    });
    expect(withKey.status).toBe(200);
    // The same key together with the cookie is a browser again.
    const both = await fetch(`${kit.baseUrl}/api/admin/invites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}`, Cookie: adminCookie, Origin: 'http://wiki.internal.example:3000' },
      body: JSON.stringify({ role: 'member' }),
    });
    expect(both.status).toBe(403);
    // An alert from a monitoring system has no session and is not held to an origin.
    expect((await kit.send('POST', `/api/hooks/usr_nobody.${crypto.randomBytes(16).toString('hex')}`, { title: 't' }, undefined, { headers: { Origin: 'http://monitoring.example' } })).status).toBe(404);
  });

  it('the address people are told to use counts as the server\'s own page', async () => {
    const before = process.env.SSHS3_PUBLIC_URL;
    process.env.SSHS3_PUBLIC_URL = 'https://sshs3.corp.example/';
    try {
      const { adminCookie } = await kit.team();
      // Behind a proxy that changes Host, the page's origin is the public address.
      expect((await kit.send('POST', '/api/admin/invites', { role: 'member' }, adminCookie, { headers: { Origin: 'https://sshs3.corp.example' } })).status).toBe(200);
      expect((await kit.send('POST', '/api/admin/invites', { role: 'member' }, adminCookie, { headers: { Origin: 'https://other.corp.example' } })).status).toBe(403);
      expect((await kit.send('POST', '/api/ws-ticket', {}, adminCookie, { headers: { Origin: 'https://sshs3.corp.example' } })).status).toBe(200);
    } finally {
      if (before === undefined) delete process.env.SSHS3_PUBLIC_URL;
      else process.env.SSHS3_PUBLIC_URL = before;
    }
  });
});
