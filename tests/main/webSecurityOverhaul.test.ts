import { afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', async () => {
  const shim = await import('../../src/main/web/electronShim');
  return shim;
});

import { setHeadlessUserDataPath } from '../../src/main/web/electronShim';
import { isAllowedWsOrigin, Sshs3WebServer } from '../../src/main/web/WebServer';
import {
  evaluatePeerApproval,
  isProdTargetContext,
  mapOidcClaimsToIdentity,
  WebAuthService,
} from '../../src/main/web/WebAuthService';
import {
  BrowserWebSocketIpcTransport,
  computeReconnectDelayMs,
  getStoredWebSessionToken,
  setStoredWebSessionToken,
} from '../../src/renderer/src/lib/webClientBridge';

const cleanupQueue: Array<{ server?: Sshs3WebServer; dir?: string }> = [];

afterEach(async () => {
  for (const item of cleanupQueue.splice(0)) {
    if (item.server) {
      await item.server.stop().catch(() => {});
    }
    if (item.dir) {
      await fs.rm(item.dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  vi.restoreAllMocks();
});

async function startTestServer(
  opts: Partial<ConstructorParameters<typeof Sshs3WebServer>[0]> = {},
): Promise<{
  server: Sshs3WebServer;
  dir: string;
  baseUrl: string;
  wsBaseUrl: string;
  port: number;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sshs3-sec-test-'));
  setHeadlessUserDataPath(dir);
  const staticDir = path.join(dir, 'static');
  await fs.mkdir(staticDir, { recursive: true });
  await fs.writeFile(path.join(staticDir, 'index.html'), '<html></html>', 'utf8');

  const server = new Sshs3WebServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    staticDir,
    ...opts,
  });
  cleanupQueue.push({ server, dir });
  const info = await server.start();
  return {
    server,
    dir,
    port: info.port,
    baseUrl: `http://127.0.0.1:${info.port}`,
    wsBaseUrl: `ws://127.0.0.1:${info.port}`,
  };
}

async function setupAdmin(baseUrl: string, username = 'alice'): Promise<{
  cookie: string;
  setCookie: string;
  user: any;
  body: any;
}> {
  const res = await fetch(`${baseUrl}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username,
      password: 'strong-test-password', // pragma: allowlist secret
      displayName: 'Alice Admin',
    }),
  });
  const body = (await res.json()) as any;
  const setCookie = res.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0] ?? '';
  return { cookie, setCookie, user: body.user, body };
}

function rawUpgradeRequest(
  baseUrl: string,
  urlPath: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; socket?: net.Socket }> {
  return new Promise((resolve, reject) => {
    const u = new URL(`${baseUrl}${urlPath}`);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        'Sec-WebSocket-Version': '13',
        ...headers,
      },
    });
    req.on('response', (res) => {
      res.resume();
      resolve({ status: res.statusCode || 0 });
    });
    req.on('upgrade', (_res, sock) => {
      resolve({ status: 101, socket: sock as net.Socket });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('Web Security Overhaul: Tickets, Cookies & CSWSH', () => {
  it('eliminates JSON body token leakage and ?token= query auth, using HttpOnly cookie + single-use /api/ws-ticket', async () => {
    const { baseUrl, wsBaseUrl } = await startTestServer({ wsTicketTtlMs: 5000 });
    const setup = await setupAdmin(baseUrl);

    // No session token leaked in JSON response body
    expect(setup.body.token).toBeUndefined();
    expect(setup.body.sessionToken).toBeUndefined();
    expect(setup.setCookie).toContain('HttpOnly');
    expect(setup.setCookie).toContain('SameSite=Lax');

    const rawSessionToken = decodeURIComponent(setup.cookie.split('=').slice(1).join('='));
    expect(rawSessionToken.length).toBeGreaterThan(20);

    // Unauthenticated ticket request fails
    const unauthTicket = await fetch(`${baseUrl}/api/ws-ticket`, { method: 'POST' });
    expect(unauthTicket.status).toBe(401);

    // Query-string ?token= is rejected on HTTP and WS upgrade
    const queryHttp = await fetch(`${baseUrl}/api/auth/status?token=${encodeURIComponent(rawSessionToken)}`);
    expect((await queryHttp.json()).authenticated).toBe(false);
    const queryWs = await rawUpgradeRequest(baseUrl, `/api/ws?token=${encodeURIComponent(rawSessionToken)}`);
    expect(queryWs.status).toBe(401);

    // Ticket issued with HttpOnly cookie works once and cannot be replayed
    const ticketRes = await fetch(`${baseUrl}/api/ws-ticket`, {
      method: 'POST',
      headers: { cookie: setup.cookie },
    });
    expect(ticketRes.status).toBe(200);
    const { ticket } = (await ticketRes.json()) as { ticket: string };
    expect(ticket).toBeTruthy();

    const ws = new WebSocket(`${wsBaseUrl}/api/ws?ticket=${encodeURIComponent(ticket)}`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e);
    });
    ws.close();

    // Replaying the consumed single-use ticket fails with 401
    const replay = await rawUpgradeRequest(baseUrl, `/api/ws?ticket=${encodeURIComponent(ticket)}`);
    expect(replay.status).toBe(401);

    // Backward compatibility: explicit Cookie or Authorization header on WS upgrade still works without ?token=
    const cookieUpgrade = await rawUpgradeRequest(baseUrl, '/api/ws', { Cookie: setup.cookie });
    expect(cookieUpgrade.status).toBe(101);
    cookieUpgrade.socket?.destroy();

    const bearerUpgrade = await rawUpgradeRequest(baseUrl, '/api/ws', {
      Authorization: `Bearer ${rawSessionToken}`,
    });
    expect(bearerUpgrade.status).toBe(101);
    bearerUpgrade.socket?.destroy();
  });

  it('rejects expired ws-ticket tokens', async () => {
    const { baseUrl } = await startTestServer({ wsTicketTtlMs: 100 });
    const setup = await setupAdmin(baseUrl);
    const ticketRes = await fetch(`${baseUrl}/api/ws-ticket`, {
      method: 'POST',
      headers: { cookie: setup.cookie },
    });
    const { ticket } = (await ticketRes.json()) as { ticket: string };

    await new Promise((r) => setTimeout(r, 150));
    const expired = await rawUpgradeRequest(baseUrl, `/api/ws?ticket=${encodeURIComponent(ticket)}`);
    expect(expired.status).toBe(401);
  });

  it('enforces strict hostname + port Origin/Host CSWSH checks (no loose loopback port bypass)', async () => {
    expect(isAllowedWsOrigin('http://127.0.0.1:8080', '127.0.0.1:8080')).toBe(true);
    expect(isAllowedWsOrigin('http://[::1]:8080', '[::1]:8080')).toBe(true);
    expect(isAllowedWsOrigin('https://app.example.com', 'app.example.com')).toBe(true);
    expect(isAllowedWsOrigin('http://localhost:3000', 'localhost:8080')).toBe(false);
    expect(isAllowedWsOrigin('http://127.0.0.1:9999', '127.0.0.1:8080')).toBe(false);
    expect(isAllowedWsOrigin('http://localhost:8080', '127.0.0.1:8080')).toBe(false);
    expect(isAllowedWsOrigin('http://127.0.0.1.evil.com:8080', '127.0.0.1:8080')).toBe(false);
    expect(isAllowedWsOrigin('null', '127.0.0.1:8080')).toBe(false);
    expect(isAllowedWsOrigin('', '127.0.0.1:8080')).toBe(false);
    expect(isAllowedWsOrigin('http://127.0.0.1:8080', '127.0.0.1:8080@evil.com')).toBe(false);
    expect(
      isAllowedWsOrigin('https://proxy.example.com:8443', '127.0.0.1:8080', [
        'https://proxy.example.com:8443',
      ]),
    ).toBe(true);

    const { baseUrl, port } = await startTestServer();
    const setup = await setupAdmin(baseUrl);

    const issueTicket = async () => {
      const r = await fetch(`${baseUrl}/api/ws-ticket`, {
        method: 'POST',
        headers: { cookie: setup.cookie },
      });
      return ((await r.json()) as { ticket: string }).ticket;
    };

    // Wrong port on loopback is blocked with 403
    const t1 = await issueTicket();
    const wrongPort = await rawUpgradeRequest(baseUrl, `/api/ws?ticket=${encodeURIComponent(t1)}`, {
      Origin: `http://127.0.0.1:${port + 1}`,
    });
    expect(wrongPort.status).toBe(403);

    // Hostname mismatch on same port (localhost vs 127.0.0.1) is blocked with 403
    const t2 = await issueTicket();
    const wrongHost = await rawUpgradeRequest(baseUrl, `/api/ws?ticket=${encodeURIComponent(t2)}`, {
      Origin: `http://localhost:${port}`,
    });
    expect(wrongHost.status).toBe(403);

    // Exact hostname + port succeeds
    const t3 = await issueTicket();
    const exactMatch = await rawUpgradeRequest(baseUrl, `/api/ws?ticket=${encodeURIComponent(t3)}`, {
      Origin: `http://127.0.0.1:${port}`,
    });
    expect(exactMatch.status).toBe(101);
    exactMatch.socket?.destroy();
  });
});

describe('Web Security Overhaul: Heartbeat, Per-Session Routing & Backpressure', () => {
  it('keeps healthy sockets alive via ping/pong and reaps unresponsive zombie sockets', async () => {
    const { baseUrl, wsBaseUrl, server } = await startTestServer({
      wsHeartbeatIntervalMs: 50,
      wsHeartbeatTimeoutMs: 40,
    });
    const setup = await setupAdmin(baseUrl);

    const getTicket = async () => {
      const r = await fetch(`${baseUrl}/api/ws-ticket`, {
        method: 'POST',
        headers: { cookie: setup.cookie },
      });
      return ((await r.json()) as { ticket: string }).ticket;
    };

    // Healthy native WebSocket answers pings automatically and stays open
    const healthyWs = new WebSocket(`${wsBaseUrl}/api/ws?ticket=${encodeURIComponent(await getTicket())}`);
    await new Promise<void>((resolve, reject) => {
      healthyWs.onopen = () => resolve();
      healthyWs.onerror = (e) => reject(e);
    });

    // Zombie raw socket completes handshake but never reads/replies with pong
    const zombie = await rawUpgradeRequest(baseUrl, `/api/ws?ticket=${encodeURIComponent(await getTicket())}`);
    expect(zombie.status).toBe(101);
    const zombieClosed = new Promise<void>((resolve) => {
      zombie.socket!.on('close', () => resolve());
      zombie.socket!.on('error', () => resolve());
    });
    // Drain incoming ping bytes so TCP FIN/RST from server is observed, while never sending pong
    zombie.socket!.resume();

    await zombieClosed;
    await new Promise((r) => setTimeout(r, 120));

    expect(healthyWs.readyState).toBe(WebSocket.OPEN);
    expect(server.getWsStats().activeConnections).toBe(1);
    healthyWs.close();
  });

  it('routes terminal events strictly per subscribed session (no cross-session broadcast)', async () => {
    const { baseUrl, wsBaseUrl, server } = await startTestServer();
    const setup = await setupAdmin(baseUrl);
    const user = (await server.auth.listUsers())[0]!;
    const tenant = await server.tenants.getOrCreateTenant(user);

    const connectClient = async () => {
      const r = await fetch(`${baseUrl}/api/ws-ticket`, {
        method: 'POST',
        headers: { cookie: setup.cookie },
      });
      const { ticket } = (await r.json()) as { ticket: string };
      const ws = new WebSocket(`${wsBaseUrl}/api/ws?ticket=${encodeURIComponent(ticket)}`);
      const events: Array<{ channel: string; args: unknown[] }> = [];
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = (e) => reject(e);
        ws.onmessage = (ev) => {
          const msg = JSON.parse(String(ev.data));
          if (msg.type === 'event') {
            events.push({ channel: msg.channel, args: msg.args });
          }
        };
      });
      return { ws, events };
    };

    const c1 = await connectClient();
    const c2 = await connectClient();

    c1.ws.send(JSON.stringify({ type: 'subscribe', sessionId: 'sess-alpha' }));
    c2.ws.send(JSON.stringify({ type: 'subscribe', sessionId: 'sess-beta' }));
    await new Promise((r) => setTimeout(r, 40));

    expect(tenant.sendToSession('sess-alpha', 'terminal:data', 'sess-alpha', 'alpha-secret')).toBe(true);
    expect(tenant.sendToSession('sess-beta', 'terminal:data', 'sess-beta', 'beta-secret')).toBe(true);
    // A session nobody subscribed to (an AI-opened terminal, a client that reconnected) reaches all of
    // this person's connections rather than none.
    expect(tenant.sendToSession('sess-orphan', 'terminal:data', 'sess-orphan', 'everyone-sees')).toBe(true);

    // Tenant-wide broadcast reaches both
    tenant.broadcast('ai-hub:changed');
    await new Promise((r) => setTimeout(r, 50));

    expect(c1.events.some((e) => e.channel === 'terminal:data' && e.args[1] === 'alpha-secret')).toBe(true);
    expect(c1.events.some((e) => e.args[1] === 'beta-secret')).toBe(false);
    expect(c1.events.some((e) => e.args[1] === 'everyone-sees')).toBe(true);

    expect(c2.events.some((e) => e.channel === 'terminal:data' && e.args[1] === 'beta-secret')).toBe(true);
    expect(c2.events.some((e) => e.args[1] === 'alpha-secret')).toBe(false);
    expect(c2.events.some((e) => e.args[1] === 'everyone-sees')).toBe(true);

    expect(c1.events.some((e) => e.channel === 'ai-hub:changed')).toBe(true);
    expect(c2.events.some((e) => e.channel === 'ai-hub:changed')).toBe(true);

    c1.ws.close();
    c2.ws.close();
  });

  it('applies writableLength backpressure and drops excess stream chunks instead of unbounded buffering', async () => {
    const { baseUrl, server } = await startTestServer({
      wsHighWaterBytes: 1024,
      wsMaxBufferedBytes: 2048,
    });
    const setup = await setupAdmin(baseUrl);
    const user = (await server.auth.listUsers())[0]!;
    const tenant = await server.tenants.getOrCreateTenant(user);

    const ticketRes = await fetch(`${baseUrl}/api/ws-ticket`, {
      method: 'POST',
      headers: { cookie: setup.cookie },
    });
    const { ticket } = (await ticketRes.json()) as { ticket: string };
    const up = await rawUpgradeRequest(baseUrl, `/api/ws?ticket=${encodeURIComponent(ticket)}`);
    expect(up.status).toBe(101);
    const clientSock = up.socket!;
    // Simulate a stalled slow consumer by pausing its read side
    clientSock.pause();

    // Subscribe the single connected client to sess-flood
    const sendSub = (sid: string) => {
      const payload = Buffer.from(JSON.stringify({ type: 'subscribe', sessionId: sid }), 'utf8');
      const mask = crypto.randomBytes(4);
      const masked = Buffer.from(payload);
      for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3]!;
      const header = Buffer.from([0x81, 0x80 | payload.length]);
      clientSock.write(Buffer.concat([header, mask, masked]));
    };
    sendSub('sess-flood');
    await new Promise((r) => setTimeout(r, 30));

    // 64 KiB chunks until the server itself is holding output and drops it. How much the operating
    // system's own buffers take first differs from machine to machine (megabytes, with large TCP
    // buffers), so the amount is not fixed.
    const bigChunk = 'X'.repeat(64 * 1024);
    for (let i = 0; i < 2000 && server.getWsStats().totalDroppedStreamFrames === 0; i++) {
      tenant.sendToSession('sess-flood', 'terminal:data', 'sess-flood', bigChunk);
    }

    const stats = server.getWsStats();
    expect(stats.totalBackpressureEvents).toBeGreaterThan(0);
    expect(stats.totalDroppedStreamFrames).toBeGreaterThan(0);

    clientSock.destroy();
  });

  it('delivers >2 MB JSON RPC responses on healthy idle sockets without reaping, while reaping overwhelmed sockets', async () => {
    const { baseUrl, wsBaseUrl, server } = await startTestServer({
      wsHighWaterBytes: 64 * 1024,
      wsMaxBufferedBytes: 512 * 1024,
    });
    const setup = await setupAdmin(baseUrl);
    const user = (await server.auth.listUsers())[0]!;
    const tenant = await server.tenants.getOrCreateTenant(user);

    const largeBlob = 'S'.repeat(3 * 1024 * 1024); // > 2 MB single RPC payload
    tenant.ipcMain.handle('test:large-snapshot', async () => ({ payload: largeBlob }));

    const getTicket = async () => {
      const r = await fetch(`${baseUrl}/api/ws-ticket`, {
        method: 'POST',
        headers: { cookie: setup.cookie },
      });
      return ((await r.json()) as { ticket: string }).ticket;
    };

    // 1. Healthy idle socket (inFlight === 0) receives >2 MB RPC response intact without reaping
    const healthyWs = new WebSocket(`${wsBaseUrl}/api/ws?ticket=${encodeURIComponent(await getTicket())}`);
    const rpcReply = new Promise<any>((resolve, reject) => {
      healthyWs.onopen = () => {
        healthyWs.send(
          JSON.stringify({ id: 'snap-1', type: 'invoke', channel: 'test:large-snapshot', args: [] }),
        );
      };
      healthyWs.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data));
        if (msg.type === 'response' && msg.id === 'snap-1') {
          resolve(msg);
        }
      };
      healthyWs.onerror = (e) => reject(e);
      healthyWs.onclose = (ev) => reject(new Error(`healthy socket closed unexpectedly: ${ev.code}`));
    });

    const res = await rpcReply;
    expect(res.ok).toBe(true);
    expect(res.result.payload.length).toBe(3 * 1024 * 1024);
    expect(healthyWs.readyState).toBe(WebSocket.OPEN);

    // 2. Overwhelmed slow consumer with un-drained backlog (inFlight > 0) still drops stream chunks and gets reaped on control frames
    const up = await rawUpgradeRequest(baseUrl, `/api/ws?ticket=${encodeURIComponent(await getTicket())}`);
    expect(up.status).toBe(101);
    const slowSock = up.socket!;
    slowSock.pause();

    const subPayload = Buffer.from(JSON.stringify({ type: 'subscribe', sessionId: 'sess-slow' }), 'utf8');
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(subPayload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3]!;
    slowSock.write(Buffer.concat([Buffer.from([0x81, 0x80 | subPayload.length]), mask, masked]));
    await new Promise((r) => setTimeout(r, 30));

    const slowClosed = new Promise<void>((resolve) => {
      slowSock.on('close', () => resolve());
      slowSock.on('error', () => resolve());
    });

    // 64 KiB stream chunks until the server holds an un-drained backlog past 512 KiB and drops output
    // (the operating system's buffers take a machine-dependent amount first), then a control event
    const streamChunk = 'Y'.repeat(64 * 1024);
    for (let i = 0; i < 2000 && server.getWsStats().totalDroppedStreamFrames === 0; i++) {
      tenant.sendToSession('sess-slow', 'terminal:data', 'sess-slow', streamChunk);
    }
    expect(server.getWsStats().totalDroppedStreamFrames).toBeGreaterThan(0);
    expect(server.getWsStats().activeConnections).toBe(2);

    // Control broadcast while inFlight > 0 && inFlight + frame.length > maxBufferedBytes reaps slow consumer
    tenant.broadcast('ai-hub:changed', 'Z'.repeat(128 * 1024));
    await vi.waitFor(() => expect(server.getWsStats().activeConnections).toBe(1));
    slowSock.resume();
    await slowClosed;
    slowSock.destroy();

    expect(healthyWs.readyState).toBe(WebSocket.OPEN);
    healthyWs.close();
  });
});

describe('Web Security Overhaul: webClientBridge Ticket Flow, Backoff & Stream Safety', () => {
  it('never stores tokens in localStorage and computes jittered exponential reconnect backoff', () => {
    const storage = new Map<string, string>();
    (globalThis as any).window = {
      localStorage: {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => void storage.set(k, v),
        removeItem: (k: string) => void storage.delete(k),
      },
    };
    storage.set('sshs3_web_session_token', 'stale-leaked-token');

    setStoredWebSessionToken('new-secret-token');
    expect(storage.has('sshs3_web_session_token')).toBe(false);
    expect(getStoredWebSessionToken()).toBeNull();

    const d0Min = computeReconnectDelayMs(0, { baseMs: 500, maxMs: 30_000, random: () => 0 });
    const d0Max = computeReconnectDelayMs(0, { baseMs: 500, maxMs: 30_000, random: () => 1 });
    expect(d0Min).toBe(250);
    expect(d0Max).toBe(500);

    const d3Min = computeReconnectDelayMs(3, { baseMs: 500, maxMs: 30_000, random: () => 0 });
    const d3Max = computeReconnectDelayMs(3, { baseMs: 500, maxMs: 30_000, random: () => 1 });
    expect(d3Min).toBe(2000);
    expect(d3Max).toBe(4000);

    const dCapped = computeReconnectDelayMs(20, { baseMs: 500, maxMs: 30_000, random: () => 1 });
    expect(dCapped).toBe(30_000);
    delete (globalThis as any).window;
  });

  it('connects via POST /api/ws-ticket, handles delta/batch/ping/ArrayBuffer frames, and queues on bufferedAmount', async () => {
    const createdUrls: string[] = [];
    const sentPackets: string[] = [];
    const sockets: any[] = [];

    class MockWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = MockWebSocket.CONNECTING;
      bufferedAmount = 0;
      onopen: (() => void) | null = null;
      onmessage: ((ev: { data: any }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: ((err: any) => void) | null = null;
      constructor(public readonly url: string) {
        createdUrls.push(url);
        sockets.push(this);
      }
      send(data: string) {
        sentPackets.push(data);
      }
      close() {
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.();
      }
    }

    (globalThis as any).window = {
      location: { protocol: 'https:', host: 'ssh.example.com' },
      dispatchEvent: vi.fn(),
    };
    (globalThis as any).WebSocket = MockWebSocket;
    (globalThis as any).fetch = vi.fn(async (input: string) => {
      if (input === '/api/ws-ticket') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ticket: 'tkt_single_use_123' }),
        };
      }
      return { ok: false, status: 404 };
    });

    try {
      const transport = new BrowserWebSocketIpcTransport();
      const received: any[] = [];
      transport.on('terminal:data', (_ev, sid, chunk) => received.push({ sid, chunk }));

      transport.connect();
      await vi.waitFor(() => expect(createdUrls.length).toBe(1));
      const mockSocket = sockets[0];
      expect(createdUrls[0]).toBe('wss://ssh.example.com/api/ws?ticket=tkt_single_use_123');
      expect(createdUrls[0]).not.toContain('token=');

      mockSocket.readyState = MockWebSocket.OPEN;
      mockSocket.onopen?.();

      // Ping -> Pong
      mockSocket.onmessage?.({ data: JSON.stringify({ type: 'ping', ts: 42 }) });
      expect(sentPackets.some((p) => p.includes('"type":"pong"') && p.includes('42'))).toBe(true);

      // Delta + batch + ArrayBuffer delivery
      mockSocket.onmessage?.({
        data: JSON.stringify({ type: 'delta', channel: 'terminal:data', args: ['s1', 'd1'] }),
      });
      mockSocket.onmessage?.({
        data: new TextEncoder().encode(
          JSON.stringify({
            type: 'batch',
            events: [{ channel: 'terminal:data', args: ['s1', 'd2'] }],
          }),
        ).buffer,
      });
      expect(received).toEqual([
        { sid: 's1', chunk: 'd1' },
        { sid: 's1', chunk: 'd2' },
      ]);

      // Client-side bufferedAmount backpressure queues rather than overflowing socket
      mockSocket.bufferedAmount = 2 * 1024 * 1024;
      const beforeCount = sentPackets.length;
      const pendingInvoke = transport.invoke('terminal:write', 's1', 'ls\n');
      expect(sentPackets.length).toBe(beforeCount);

      mockSocket.bufferedAmount = 0;
      await vi.waitFor(() => expect(sentPackets.length).toBe(beforeCount + 1));
      const sentReq = JSON.parse(sentPackets[beforeCount]!);
      mockSocket.onmessage?.({
        data: JSON.stringify({ type: 'response', id: sentReq.id, ok: true, result: 'ok' }),
      });
      await expect(pendingInvoke).resolves.toBe('ok');

      transport.disconnect();
    } finally {
      delete (globalThis as any).window;
      delete (globalThis as any).WebSocket;
      delete (globalThis as any).fetch;
    }
  });
});

describe('Web Security Overhaul: OIDC Claim Mapping, SCIM Deprovisioning & Peer Approval', () => {
  it('maps OIDC claims cleanly, enforces required groups & issuer, and blocks account takeover', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sshs3-oidc-test-'));
    cleanupQueue.push({ dir });

    const identity = mapOidcClaimsToIdentity(
      {
        sub: 'idp-user-99',
        iss: 'https://idp.example.com/',
        preferred_username: 'Sara.Ops@example.com',
        name: 'Sara Lindqvist',
        email: 'sara@example.com',
        groups: ['sre-team', 'platform-admins'],
      },
      {
        issuer: 'https://idp.example.com',
        requiredGroups: ['sre-team'],
        adminGroups: ['platform-admins'],
      },
    );
    expect(identity.username).toBe('sara.ops');
    expect(identity.role).toBe('admin');
    expect(identity.groups).toEqual(['sre-team', 'platform-admins']);

    expect(() =>
      mapOidcClaimsToIdentity(
        { sub: 'u1', iss: 'https://wrong-idp.example.com' },
        { issuer: 'https://idp.example.com' },
      ),
    ).toThrow(/issuer mismatch/i);

    expect(() =>
      mapOidcClaimsToIdentity(
        { sub: 'u1', iss: 'https://idp.example.com', groups: ['guest'] },
        { issuer: 'https://idp.example.com', requiredGroups: ['sre-team'] },
      ),
    ).toThrow(/required SSO group/i);

    const auth = new WebAuthService(dir);
    await auth.initialize();
    await auth.setupInitialAdmin({
      username: 'sara',
      password: 'local-admin-password', // pragma: allowlist secret
    });

    // OIDC user with preferred_username 'sara' must NOT silently hijack the local 'sara' account
    const oidcRes = await auth.upsertOidcUser({
      sub: 'sub-sara-oidc',
      iss: 'https://idp.example.com',
      preferred_username: 'sara',
      name: 'Sara SSO',
      groups: ['sre'],
    });
    expect(oidcRes.created).toBe(true);
    expect(oidcRes.user.username).toMatch(/^sara_/);
    expect(oidcRes.user.authSource).toBe('oidc');
    expect(oidcRes.user.role).toBe('member');

    // Re-login updates role/groups from IdP claims
    const promoted = await auth.upsertOidcUser(
      {
        sub: 'sub-sara-oidc',
        iss: 'https://idp.example.com',
        preferred_username: 'sara',
        groups: ['admins'],
      },
      { adminGroups: ['admins'] },
    );
    expect(promoted.created).toBe(false);
    expect(promoted.user.id).toBe(oidcRes.user.id);
    expect(promoted.user.role).toBe('admin');

    // SCIM/SSO offboarding disables user and immediately revokes all active sessions
    const deprov = await auth.deprovisionUser(oidcRes.user.id);
    expect(deprov.deprovisioned).toBe(true);
    expect(deprov.revokedSessions).toBeGreaterThanOrEqual(2);
    expect(await auth.verifySession(promoted.sessionToken)).toBeNull();
    await expect(
      auth.upsertOidcUser({ sub: 'sub-sara-oidc', iss: 'https://idp.example.com' }),
    ).rejects.toThrow(/disabled/i);
  });

  it('enforces Separation of Duties and role-based prod peer approval in WebAuthService & WebTenantManager', async () => {
    const { server } = await startTestServer();
    const { user: admin } = await server.auth.setupInitialAdmin({
      username: 'admin1',
      password: 'admin-password-123', // pragma: allowlist secret
    });
    const member = await server.auth.createUserByAdmin({
      username: 'member1',
      password: 'member-password-123', // pragma: allowlist secret
      role: 'member',
    });
    const { user: sreApprover } = await server.auth.upsertOidcUser({
      sub: 'sre-approver-sub',
      preferred_username: 'lead1',
      groups: ['prod-approver'],
    });

    expect(isProdTargetContext(undefined, ['eu-west', 'prod'])).toBe(true);
    expect(isProdTargetContext('staging', ['web'])).toBe(false);

    // Self-approval is always blocked (SoD)
    const selfAttempt = server.tenants.authorizePeerApproval({
      requesterUserId: admin.id,
      requesterUsername: admin.username,
      approver: admin,
      targetTags: ['prod'],
    });
    expect(selfAttempt.authorized).toBe(false);
    expect(selfAttempt.reason).toMatch(/Self-approval/i);

    // Plain member cannot approve prod change
    const memberProd = server.tenants.authorizePeerApproval({
      requesterUserId: admin.id,
      approver: member,
      targetTags: ['prod'],
    });
    expect(memberProd.authorized).toBe(false);
    expect(memberProd.reason).toMatch(/admin or authorized approver/i);

    // Plain member CAN peer-approve non-prod staging change
    const memberStaging = server.tenants.authorizePeerApproval({
      requesterUserId: admin.id,
      approver: member,
      targetEnv: 'staging',
    });
    expect(memberStaging.authorized).toBe(true);

    // Authorized approver group or admin satisfies prod two-person approval
    const sreProd = evaluatePeerApproval({
      requesterId: admin.id,
      approver: sreApprover,
      targetTags: ['production'],
      requiredApprovals: 2,
      existingApprovals: [{ actorId: 'usr_other', allowed: true }],
    });
    expect(sreProd.authorized).toBe(true);
    expect(sreProd.satisfiedCount).toBe(2);
    expect(sreProd.remainingApprovals).toBe(0);
  });
});
