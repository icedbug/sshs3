import { afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

vi.mock('electron', async () => {
  const shim = await import('../../src/main/web/electronShim');
  return shim;
});

import { setHeadlessUserDataPath } from '../../src/main/web/electronShim';
import { isDroppableStreamFrame, Sshs3WebServer } from '../../src/main/web/WebServer';
import { observeHubSnapshot } from '../../src/renderer/src/lib/aiHub';
import { createMultiSSHApi } from '../../src/shared/ipc/createMultiSSHApi';
import { installProcessGuards, isConnectionError } from '../../src/main/web/processGuards';
import {
  BrowserWebSocketIpcTransport,
  CONNECTION_LOST_MESSAGE,
} from '../../src/renderer/src/lib/webClientBridge';

const cleanupQueue: Array<{ server?: Sshs3WebServer; dir?: string }> = [];

afterEach(async () => {
  for (const item of cleanupQueue.splice(0)) {
    if (item.server) await item.server.stop().catch(() => {});
    if (item.dir) await fs.rm(item.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
  vi.restoreAllMocks();
});

async function startTestServer(
  opts: Partial<ConstructorParameters<typeof Sshs3WebServer>[0]> = {},
): Promise<{ server: Sshs3WebServer; dir: string; baseUrl: string; wsBaseUrl: string; port: number }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sshs3-s2-test-'));
  setHeadlessUserDataPath(dir);
  const staticDir = path.join(dir, 'static');
  await fs.mkdir(staticDir, { recursive: true });
  await fs.writeFile(path.join(staticDir, 'index.html'), '<html></html>', 'utf8');
  const server = new Sshs3WebServer({ port: 0, host: '127.0.0.1', dataDir: dir, staticDir, ...opts });
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

async function setupAdmin(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'strong-test-password', displayName: 'Alice' }), // pragma: allowlist secret
  });
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

async function getTicket(baseUrl: string, cookie: string): Promise<string> {
  const r = await fetch(`${baseUrl}/api/ws-ticket`, { method: 'POST', headers: { cookie } });
  return ((await r.json()) as { ticket: string }).ticket;
}

function rawUpgrade(baseUrl: string, urlPath: string): Promise<net.Socket> {
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
      },
    });
    req.on('response', (res) => reject(new Error(`no upgrade (${res.statusCode})`)));
    req.on('upgrade', (_res, sock) => resolve(sock as net.Socket));
    req.on('error', reject);
    req.end();
  });
}

function maskedTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3]!;
  const header =
    payload.length < 126
      ? Buffer.from([0x81, 0x80 | payload.length])
      : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([header, mask, masked]);
}

/** A tenant client without a real WebSocket: what it was sent, parsed. */
function fakeClient(tenant: Awaited<ReturnType<Sshs3WebServer['tenants']['getOrCreateTenant']>>) {
  const received: Array<{ channel: string; args: unknown[] }> = [];
  const id = tenant.registerClient(new PassThrough(), (payload) => {
    const msg = JSON.parse(payload) as { type: string; channel: string; args: unknown[] };
    if (msg.type === 'event') received.push({ channel: msg.channel, args: msg.args });
  });
  return { id, received };
}

describe('web tenant: one window per person, replies to the client that asked', () => {
  it('keeps one saved session for every connection, and replies to the asking client without a TypeError', async () => {
    const { baseUrl, server } = await startTestServer();
    await setupAdmin(baseUrl);
    const user = (await server.auth.listUsers())[0]!;
    const tenant = await server.tenants.getOrCreateTenant(user);

    const c1 = fakeClient(tenant);
    const c2 = fakeClient(tenant);
    const tab = { id: 't1', type: 'terminal', title: 'prod', profileId: 'p1' };
    await tenant.invokeFromClient(c1.id, 'session:save', { tabs: [tab], activeTabId: 't1' });
    // A reload is a new connection: it sees the tabs the old one saved, and no new window is added.
    const c3 = fakeClient(tenant);
    tenant.unregisterClient(c1.id);
    const restored = (await tenant.invokeFromClient(c3.id, 'session:get')) as { tabs: unknown[]; windows?: unknown[] };
    expect(restored?.tabs).toHaveLength(1);
    await tenant.invokeFromClient(c2.id, 'session:save', { tabs: [tab], activeTabId: 't1' });
    const onDisk = JSON.parse(await fs.readFile(path.join(tenant.userDir, 'sessions.json'), 'utf8')) as {
      windows?: unknown[];
    };
    expect(onDisk.windows ?? []).toEqual([]);

    // Search results, dir-sync progress, file tail ...: sent with bridge.sendToSender(event.sender, ...).
    tenant.ipcMain.handle('test:reply', async (event: unknown) => {
      const sender = (event as { sender: Electron.WebContents }).sender;
      return tenant.bridge.sendToSender(sender, 'search:result', { hit: 1 });
    });
    await expect(tenant.invokeFromClient(c2.id, 'test:reply')).resolves.toBe(true);
    expect(c2.received).toContainEqual({ channel: 'search:result', args: [{ hit: 1 }] });
    expect(c3.received.some((e) => e.channel === 'search:result')).toBe(false);
  });

  it('sends output of a session nobody subscribed to every connection of that person', async () => {
    const { baseUrl, server } = await startTestServer();
    await setupAdmin(baseUrl);
    const user = (await server.auth.listUsers())[0]!;
    const tenant = await server.tenants.getOrCreateTenant(user);
    const c1 = fakeClient(tenant);
    const c2 = fakeClient(tenant);
    tenant.subscribeSession(c1.id, 'mine');

    expect(tenant.sendToSession('ai-opened', 'terminal:data', 'ai-opened', 'hello')).toBe(true);
    expect(c1.received).toContainEqual({ channel: 'terminal:data', args: ['ai-opened', 'hello'] });
    expect(c2.received).toContainEqual({ channel: 'terminal:data', args: ['ai-opened', 'hello'] });

    // A subscribed session still goes only to its subscriber.
    tenant.sendToSession('mine', 'terminal:data', 'mine', 'private');
    expect(c2.received.some((e) => e.args[1] === 'private')).toBe(false);
  });
});

describe('web server: frames are classified by their own type', () => {
  it('treats only terminal/log output events as droppable', () => {
    expect(isDroppableStreamFrame(JSON.stringify({ type: 'event', channel: 'terminal:data', args: ['s', 'x'] }))).toBe(true);
    expect(isDroppableStreamFrame(JSON.stringify({ type: 'event', channel: 'k8s-log:data', args: [] }))).toBe(true);
    expect(
      isDroppableStreamFrame(
        JSON.stringify({ id: 'r1', type: 'response', ok: true, result: '{"channel":"terminal:data"}' }),
      ),
    ).toBe(false);
    expect(isDroppableStreamFrame(JSON.stringify({ type: 'event', channel: 'ai-hub:changed', args: ['"channel":"terminal:data"'] }))).toBe(false);
  });

  it('delivers a response that mentions terminal:data even while the socket is backed up', async () => {
    const { baseUrl, server } = await startTestServer({ wsHighWaterBytes: 1024, wsMaxBufferedBytes: 2048 });
    const cookie = await setupAdmin(baseUrl);
    const user = (await server.auth.listUsers())[0]!;
    const tenant = await server.tenants.getOrCreateTenant(user);
    const chunk = 'X'.repeat(64 * 1024);
    // The answer is sent right behind a burst of output: the socket is backed up when it goes out.
    // How much the operating system's own buffers take first differs from machine to machine (megabytes,
    // with large TCP buffers), so output is sent until the server itself is holding some and drops it.
    tenant.ipcMain.handle('test:echo', async () => {
      for (let i = 0; i < 2000 && server.getWsStats().totalDroppedStreamFrames === 0; i++)
        tenant.sendToSession('sess-flood', 'terminal:data', 'sess-flood', chunk);
      // e.g. a recorded event in a result: its JSON contains "channel":"terminal:data" verbatim.
      return { recorded: [{ channel: 'terminal:data', args: ['s1', 'ls'] }] };
    });

    const sock = await rawUpgrade(baseUrl, `/api/ws?ticket=${encodeURIComponent(await getTicket(baseUrl, cookie))}`);
    sock.pause();
    sock.write(maskedTextFrame(JSON.stringify({ type: 'subscribe', sessionId: 'sess-flood' })));
    await new Promise((r) => setTimeout(r, 30));
    sock.write(maskedTextFrame(JSON.stringify({ id: 'rpc-echo-1', type: 'invoke', channel: 'test:echo', args: [] })));
    await vi.waitFor(() => expect(server.getWsStats().totalDroppedStreamFrames).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 60));
    const chunks: Buffer[] = [];
    sock.on('data', (d: Buffer) => chunks.push(d));
    sock.resume();
    // The answer is small and comes last: it is looked for at the end of what has arrived.
    await vi.waitFor(() => expect(Buffer.concat(chunks.slice(-8)).toString('latin1')).toContain('"id":"rpc-echo-1"'), {
      timeout: 15000,
    });
    expect(server.getWsStats().activeConnections).toBe(1);
    sock.destroy();
  });
});

describe('webClientBridge: reconnects and lost connections', () => {
  class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static all: MockWebSocket[] = [];
    readyState = MockWebSocket.CONNECTING;
    bufferedAmount = 0;
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onclose: ((ev?: { code?: number; reason?: string }) => void) | null = null;
    onerror: ((err: unknown) => void) | null = null;
    constructor(public readonly url: string) {
      MockWebSocket.all.push(this);
    }
    send(data: string) {
      this.sent.push(data);
    }
    close() {
      this.readyState = MockWebSocket.CLOSED;
      this.onclose?.({ code: 1000 });
    }
    open() {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.();
    }
    drop(code = 1006, reason = '') {
      this.readyState = MockWebSocket.CLOSED;
      this.onclose?.({ code, reason });
    }
    reply(id: string, result: unknown) {
      this.onmessage?.({ data: JSON.stringify({ type: 'response', id, ok: true, result }) });
    }
  }

  const realWebSocket = globalThis.WebSocket;
  const realFetch = globalThis.fetch;
  function install(): void {
    MockWebSocket.all = [];
    (globalThis as any).window = { location: { protocol: 'http:', host: 'team.local' }, dispatchEvent: vi.fn() };
    (globalThis as any).WebSocket = MockWebSocket;
    (globalThis as any).fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ticket: 'tkt' }) }));
  }
  function uninstall(): void {
    delete (globalThis as any).window;
    (globalThis as any).WebSocket = realWebSocket;
    (globalThis as any).fetch = realFetch;
  }

  it('opens a fresh transport when the workspace identity changes', async () => {
    install();
    const transport = new BrowserWebSocketIpcTransport();
    try {
      transport.connect(null, 'first');
      await vi.waitFor(() => expect(MockWebSocket.all).toHaveLength(1));
      const first = MockWebSocket.all[0]!;
      first.open();
      transport.connect(null, 'second');
      expect(first.readyState).toBe(MockWebSocket.CLOSED);
      await vi.waitFor(() => expect(MockWebSocket.all).toHaveLength(2));
      expect(fetch).toHaveBeenLastCalledWith('/api/ws-ticket', expect.objectContaining({
        headers: { 'X-SSHS3-Workspace-User': 'second' },
      }));
    } finally {
      transport.disconnect();
      uninstall();
    }
  });

  it('refreshes the visible hub once after reconnect even when the server sends no more events', async () => {
    install();
    const transport = new BrowserWebSocketIpcTransport();
    let stop: (() => void) | undefined;
    try {
      const api = createMultiSSHApi(transport);
      Object.assign(window, { multissh: api });
      transport.connect(null, 'example-member');
      await vi.waitFor(() => expect(MockWebSocket.all).toHaveLength(1));
      const first = MockWebSocket.all[0]!;
      first.open();
      const statuses: string[] = [];
      stop = observeHubSnapshot((snapshot) => statuses.push(snapshot.tasks[0].status));
      const snapshots = (ws: MockWebSocket) => ws.sent.map((p) => JSON.parse(p)).filter((p) => p.args?.[0]?.action === 'snapshot');
      const initial = snapshots(first);
      expect(initial).toHaveLength(1);
      first.reply(initial[0].id, { tasks: [{ status: 'running' }] });
      await vi.waitFor(() => expect(statuses).toEqual(['running']));
      first.drop();
      await vi.waitFor(() => expect(MockWebSocket.all).toHaveLength(2), { timeout: 3000 });
      expect(fetch).toHaveBeenLastCalledWith('/api/ws-ticket', expect.objectContaining({
        headers: { 'X-SSHS3-Workspace-User': 'example-member' },
      }));
      const second = MockWebSocket.all[1]!;
      second.open();
      await vi.waitFor(() => expect(snapshots(second)).toHaveLength(1));
      second.reply(snapshots(second)[0].id, { tasks: [{ status: 'completed' }] });
      await vi.waitFor(() => expect(statuses).toEqual(['running', 'completed']));
      expect(snapshots(second)).toHaveLength(1);
    } finally {
      stop?.();
      transport.disconnect();
      uninstall();
    }
  });

  it('subscribes again to the sessions it opened after a reconnect', async () => {
    install();
    try {
      const t = new BrowserWebSocketIpcTransport();
      t.connect();
      await vi.waitFor(() => expect(MockWebSocket.all).toHaveLength(1));
      const first = MockWebSocket.all[0]!;
      first.open();
      const created = t.invoke('terminal:create', { profileId: 'p1' });
      const req = JSON.parse(first.sent.at(-1)!) as { id: string };
      first.reply(req.id, { sessionId: 'sess-42' });
      await expect(created).resolves.toEqual({ sessionId: 'sess-42' });
      await new Promise((r) => setTimeout(r, 0));

      first.drop();
      await vi.waitFor(() => expect(MockWebSocket.all).toHaveLength(2), { timeout: 3000 });
      const second = MockWebSocket.all[1]!;
      second.open();
      expect(second.sent.map((p) => JSON.parse(p))).toContainEqual({ type: 'subscribe', sessionId: 'sess-42' });

      // Killing it stops the re-subscription.
      void t.invoke('terminal:kill', 'sess-42').catch(() => {});
      expect(second.sent.map((p) => JSON.parse(p))).toContainEqual({ type: 'unsubscribe', sessionId: 'sess-42' });
      t.disconnect();
    } finally {
      uninstall();
    }
  });

  it('fails what was waiting with a clear message when the connection drops, and never sends it later', async () => {
    install();
    try {
      const t = new BrowserWebSocketIpcTransport();
      t.connect();
      await vi.waitFor(() => expect(MockWebSocket.all).toHaveLength(1));
      const first = MockWebSocket.all[0]!;
      first.open();
      const sentNow = t.invoke('fs:list', '/');
      first.bufferedAmount = 10 * 1024 * 1024;
      const queued = t.invoke('terminal:write', 's1', 'rm -rf build\n');
      first.drop(1012, 'The server is restarting');
      await expect(sentNow).rejects.toThrow(CONNECTION_LOST_MESSAGE);
      await expect(queued).rejects.toThrow(/restarting/);

      await vi.waitFor(() => expect(MockWebSocket.all).toHaveLength(2), { timeout: 3000 });
      const second = MockWebSocket.all[1]!;
      second.open();
      await new Promise((r) => setTimeout(r, 60));
      expect(second.sent.some((p) => p.includes('terminal:write'))).toBe(false);
      t.disconnect();
    } finally {
      uninstall();
    }
  });
});

/**
 * The team server died during the 15-person simulation on a socket 'error' nobody listened to
 * ("read ECONNRESET" from TCP.onStreamRead), with "11 exit/suspend/resume listeners added" before it.
 */
describe('team server: one broken connection does not end the server', () => {
  it('survives a client that resets its connection while its sign-in is still being checked', async () => {
    const { baseUrl, server, port } = await startTestServer();
    const cookie = await setupAdmin(baseUrl);
    const inner = server as unknown as { authenticateRequest: (req: unknown) => Promise<unknown> };
    const original = inner.authenticateRequest.bind(server);
    let entered!: () => void;
    const checking = new Promise<void>((resolve) => (entered = resolve));
    inner.authenticateRequest = async (req: unknown) => {
      entered();
      await new Promise((resolve) => setTimeout(resolve, 150));
      return original(req);
    };
    const uncaught: unknown[] = [];
    const catcher = (err: unknown) => uncaught.push(err);
    process.on('uncaughtException', catcher);
    try {
      const sock = net.connect(port, '127.0.0.1');
      sock.on('error', () => {});
      await new Promise<void>((resolve) => sock.once('connect', () => resolve()));
      sock.write(
        [
          'GET /api/ws HTTP/1.1',
          `Host: 127.0.0.1:${port}`,
          `Cookie: ${cookie}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          '',
          '',
        ].join('\r\n'),
      );
      await checking;
      sock.resetAndDestroy();
      await new Promise((resolve) => setTimeout(resolve, 400));
    } finally {
      process.removeListener('uncaughtException', catcher);
    }
    expect(uncaught).toEqual([]);
    // The person's workspace was set up but no client was left registered for a connection that is gone.
    const tenant = await server.tenants.getOrCreateTenant((await server.auth.listUsers())[0]!);
    expect(tenant.clients.size).toBe(0);
    const status = await fetch(`${baseUrl}/api/auth/status`);
    expect(status.ok).toBe(true);
  });

  it('tells its clients it is restarting when it stops', async () => {
    const { baseUrl, wsBaseUrl, server } = await startTestServer();
    const cookie = await setupAdmin(baseUrl);
    const ws = new WebSocket(`${wsBaseUrl}/api/ws?ticket=${encodeURIComponent(await getTicket(baseUrl, cookie))}`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('ws failed'));
    });
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.onclose = (ev) => resolve({ code: ev.code, reason: ev.reason });
    });
    await server.stop();
    const ev = await closed;
    expect(ev.code).toBe(1012);
    expect(ev.reason).toMatch(/restarting/);
  });
});

describe('the shared bucket settings file', () => {
  it('leaves no temporary file behind when the rename over it is refused', async () => {
    const { S3WorkspaceSyncService } = await import('../../src/main/ai/hub/S3WorkspaceSyncService');
    const fsp = (await import('node:fs/promises')).default;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sshs3-s3cfg-'));
    const sync = new S3WorkspaceSyncService(path.join(dir, 's3-workspace.json'), {} as never);
    const rename = vi.spyOn(fsp, 'rename').mockRejectedValue(Object.assign(new Error('refused'), { code: 'EXDEV' }));
    try {
      await expect(sync.save()).rejects.toThrow('refused');
    } finally {
      rename.mockRestore();
    }
    expect(await fs.readdir(dir)).toEqual([]);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('listeners per signed-in person', () => {
  it('adds one process exit listener for all tunnel managers, and lets go of a stopped one', async () => {
    const { SSHTunnelManager } = await import('../../src/main/services/SSHTunnelManager');
    const before = process.listenerCount('exit');
    const managers = Array.from({ length: 12 }, () => new SSHTunnelManager());
    expect(process.listenerCount('exit') - before).toBeLessThanOrEqual(1);
    await Promise.all(managers.map((m) => m.stopAll()));
  });

  it('takes a suspend listener for each person without a leak warning', async () => {
    const { powerMonitor } = await import('../../src/main/web/electronShim');
    const warnings: Error[] = [];
    const onWarning = (w: Error) => warnings.push(w);
    process.on('warning', onWarning);
    const fns = Array.from({ length: 15 }, () => () => {});
    try {
      for (const fn of fns) powerMonitor.on('suspend', fn);
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      for (const fn of fns) powerMonitor.removeListener('suspend', fn);
      process.removeListener('warning', onWarning);
    }
    expect(warnings.filter((w) => w.name === 'MaxListenersExceededWarning')).toEqual([]);
  });
});

describe('process guards of the server entry point', () => {
  it('keeps running on a connection error and on a promise nobody waited for, and stops on anything else', () => {
    const target = new EventEmitter() as unknown as NodeJS.Process;
    const lines: string[] = [];
    const fatal = vi.fn();
    const guards = installProcessGuards({ write: (l) => lines.push(l), fatal }, target);
    const emit = (name: string, err: unknown) => (target as unknown as EventEmitter).emit(name, err);

    emit('uncaughtException', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    emit('uncaughtException', new TypeError('terminated'));
    emit('unhandledRejection', new Error('model endpoint said 500'));
    expect(fatal).not.toHaveBeenCalled();
    expect(lines.filter((l) => /keeps running/.test(l))).toHaveLength(3);
    expect(lines[0]).toContain('ECONNRESET');

    emit('uncaughtException', new RangeError('index out of range'));
    emit('uncaughtException', new RangeError('again'));
    expect(fatal).toHaveBeenCalledTimes(1);
    expect(lines.at(-1)).toMatch(/server stops/);

    guards.remove();
    expect((target as unknown as EventEmitter).listenerCount('uncaughtException')).toBe(0);
  });

  it('knows a connection error by its code, its name or its cause', () => {
    expect(isConnectionError(Object.assign(new Error('x'), { code: 'EPIPE' }))).toBe(true);
    expect(isConnectionError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true);
    expect(
      isConnectionError(new Error('fetch failed', { cause: Object.assign(new Error('y'), { code: 'UND_ERR_SOCKET' }) })),
    ).toBe(true);
    expect(isConnectionError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isConnectionError(Object.assign(new Error('x'), { code: 'ENOSPC' }))).toBe(false);
  });
});
