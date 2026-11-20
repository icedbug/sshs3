import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { connectWs, WsError, type WsClient, type WsClose } from '../../src/main/net/wsClient';
import { acceptUpgrade, serverFrame, until, type ServerSocket } from '../helpers/wsServer';

/**
 * The agent bot's own WebSocket client: it opens over the same checked, pinned connection as every
 * other call, and speaks enough of the protocol for Slack and Mattermost, no more.
 */

const LOCAL = { server: false, allowPrivate: true };
const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const servers: (http.Server | https.Server)[] = [];
const clients: WsClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

async function server(
  options: { status?: number; headers?: Record<string, string>; badAccept?: boolean; noPong?: boolean; response?: (req: http.IncomingMessage, res: http.ServerResponse) => void } = {},
) {
  const sockets: ServerSocket[] = [];
  const srv = http.createServer((req, res) => {
    if (options.response) return options.response(req, res);
    res.writeHead(404).end();
  });
  srv.on('upgrade', (req, socket, head) => {
    const s = acceptUpgrade(req, socket, head, options);
    if (s) sockets.push(s);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  servers.push(srv);
  const port = (srv.address() as AddressInfo).port;
  return { port, url: `ws://127.0.0.1:${port}/socket?x=1`, sockets, srv };
}

function open(url: string, extra: Partial<Parameters<typeof connectWs>[1]> = {}) {
  const ws = connectWs(url, { guard: LOCAL, pingEveryMs: 0, ...extra });
  clients.push(ws);
  const messages: string[] = [];
  const errors: Error[] = [];
  let closed: WsClose | undefined;
  ws.on('message', (m) => messages.push(m));
  ws.on('error', (e) => errors.push(e));
  ws.on('close', (c) => (closed = c));
  return { ws, messages, errors, closed: () => closed };
}

describe('wsClient', () => {
  it('opens with the right handshake and masks what it sends', async () => {
    const s = await server();
    const c = open(s.url, { headers: { Authorization: 'Bearer secret-token' } });
    let opened = false;
    c.ws.on('open', () => (opened = true));
    await c.ws.ready;
    expect(opened).toBe(true);
    await until(() => s.sockets.length === 1);
    const req = s.sockets[0].request;
    expect(req.url).toBe('/socket?x=1');
    expect(req.headers.upgrade).toBe('websocket');
    expect(req.headers.connection).toMatch(/upgrade/i);
    expect(req.headers['sec-websocket-version']).toBe('13');
    expect(req.headers.authorization).toBe('Bearer secret-token');
    expect(req.headers['sec-websocket-extensions']).toBeUndefined();

    c.ws.send('hello from the client');
    c.ws.send('x'.repeat(70_000));
    await until(() => s.sockets[0].messages.length === 2);
    expect(s.sockets[0].messages[0]).toBe('hello from the client');
    expect(s.sockets[0].messages[1]).toHaveLength(70_000);
    expect(s.sockets[0].frames.every((f) => f.masked)).toBe(true);

    s.sockets[0].send('{"type":"hello"}');
    await until(() => c.messages.length === 1);
    expect(c.messages).toEqual(['{"type":"hello"}']);
  });

  it('joins a message split in frames, and answers a ping between them', async () => {
    const s = await server();
    const c = open(s.url);
    await c.ws.ready;
    await until(() => s.sockets.length === 1);
    const sock = s.sockets[0];
    sock.frame(0x1, 'one ', { fin: false });
    sock.ping('are you there');
    sock.frame(0x0, 'two ', { fin: false });
    sock.frame(0x0, 'three', { fin: true });
    await until(() => c.messages.length === 1);
    expect(c.messages).toEqual(['one two three']);
    await until(() => sock.frames.some((f) => f.opcode === 0xa));
    const pong = sock.frames.find((f) => f.opcode === 0xa)!;
    expect(pong.payload.toString()).toBe('are you there');
    expect(pong.masked).toBe(true);
  });

  it('closes when the server closes, answering with the same code', async () => {
    const s = await server();
    const c = open(s.url);
    await c.ws.ready;
    await until(() => s.sockets.length === 1);
    s.sockets[0].close(4000, 'going away now');
    await until(() => Boolean(c.closed()));
    expect(c.closed()).toEqual({ code: 4000, reason: 'going away now' });
    const answer = s.sockets[0].frames.find((f) => f.opcode === 0x8)!;
    expect(answer.payload.readUInt16BE(0)).toBe(4000);
    expect(() => c.ws.send('late')).toThrow('not open');
  });

  it('closes from its own side with a close frame', async () => {
    const s = await server();
    const c = open(s.url);
    await c.ws.ready;
    await until(() => s.sockets.length === 1);
    c.ws.close(1000, 'done');
    await until(() => Boolean(c.closed()));
    expect(c.closed()?.code).toBe(1000);
    const frame = s.sockets[0].frames.find((f) => f.opcode === 0x8)!;
    expect(frame.payload.readUInt16BE(0)).toBe(1000);
    expect(frame.payload.subarray(2).toString()).toBe('done');
  });

  it('ends the connection without a close frame as 1006', async () => {
    const s = await server();
    const c = open(s.url);
    await c.ws.ready;
    await until(() => s.sockets.length === 1);
    s.sockets[0].drop();
    await until(() => Boolean(c.closed()));
    expect(c.closed()?.code).toBe(1006);
  });

  it('refuses a message larger than the cap, whole or split', async () => {
    const s = await server();
    const whole = open(s.url, { maxMessageBytes: 1000 });
    await whole.ws.ready;
    await until(() => s.sockets.length === 1);
    s.sockets[0].send('y'.repeat(2000));
    await until(() => Boolean(whole.closed()));
    expect(whole.messages).toEqual([]);
    expect(whole.closed()?.code).toBe(1009);
    expect(whole.errors[0]?.message).toMatch(/larger than the socket takes/);

    const split = open(s.url, { maxMessageBytes: 1000 });
    await split.ws.ready;
    await until(() => s.sockets.length === 2);
    s.sockets[1].frame(0x1, 'z'.repeat(600), { fin: false });
    s.sockets[1].frame(0x0, 'z'.repeat(600), { fin: true });
    await until(() => Boolean(split.closed()));
    expect(split.messages).toEqual([]);
    expect(split.closed()?.code).toBe(1009);

    // A frame that only says it is huge is refused before anything of it is read.
    const claimed = open(s.url, { maxMessageBytes: 1000 });
    await claimed.ws.ready;
    await until(() => s.sockets.length === 3);
    s.sockets[2].frame(0x1, Buffer.alloc(0), { length: 5_000_000_000 });
    await until(() => Boolean(claimed.closed()));
    expect(claimed.closed()?.code).toBe(1009);
  });

  it('refuses frames a server must not send', async () => {
    const s = await server();
    const masked = open(s.url);
    await masked.ws.ready;
    await until(() => s.sockets.length === 1);
    s.sockets[0].frame(0x1, 'hidden', { mask: true });
    await until(() => Boolean(masked.closed()));
    expect(masked.closed()?.code).toBe(1002);
    expect(masked.messages).toEqual([]);

    const notText = open(s.url);
    await notText.ws.ready;
    await until(() => s.sockets.length === 2);
    s.sockets[1].frame(0x1, Buffer.from([0xff, 0xfe, 0xfd]));
    await until(() => Boolean(notText.closed()));
    expect(notText.closed()?.code).toBe(1007);

    const stray = open(s.url);
    await stray.ws.ready;
    await until(() => s.sockets.length === 3);
    s.sockets[2].frame(0x0, 'continued');
    await until(() => Boolean(stray.closed()));
    expect(stray.closed()?.code).toBe(1002);
  });

  it('sends a ping when the connection is quiet', async () => {
    const s = await server();
    const c = open(s.url, { pingEveryMs: 40 });
    await c.ws.ready;
    await until(() => s.sockets.length === 1);
    await until(() => s.sockets[0].frames.some((f) => f.opcode === 0x9), 2000, 'a ping');
    expect(c.closed()).toBeUndefined();
  });

  it('counts a connection with no answer to its pings as gone', async () => {
    const s = await server({ noPong: true });
    const c = open(s.url, { pingEveryMs: 40 });
    await c.ws.ready;
    const started = Date.now();
    await until(() => Boolean(c.closed()), 500, 'the close');
    expect(c.closed()).toEqual({ code: 1006, reason: 'The connection went quiet.' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
  });

  it('gives up on an upgrade that is never answered', async () => {
    const s = await server();
    s.srv.removeAllListeners('upgrade');
    const held: Duplex[] = [];
    s.srv.on('upgrade', (_req, socket: Duplex) => void held.push(socket));
    const c = open(s.url, { timeoutMs: 100 });
    await expect(c.ws.ready).rejects.toThrow('did not open in time');
    expect(c.closed()?.code).toBe(1006);
    for (const socket of held) socket.destroy();
  });

  it('ends, and says why, when a header cannot be sent', async () => {
    const s = await server();
    const c = open(s.url, { headers: { Authorization: 'Bearer abc\ndef' } });
    const error = await c.ws.ready.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(c.closed()?.code).toBe(1006);
    expect(c.closed()?.error).toBe(error);
    expect(s.sockets).toHaveLength(0);
  });

  it('carries why opening failed on the close, with how long to wait', async () => {
    const s = await server({ status: 429, headers: { 'Retry-After': '5' } });
    const c = open(s.url);
    await c.ws.ready.catch(() => undefined);
    const error = c.closed()?.error as WsError;
    expect(error).toBeInstanceOf(WsError);
    expect(error.retryAfterMs).toBe(5000);
  });

  it('refuses a message sent in too many pieces, also when they are empty', async () => {
    const s = await server();
    const c = open(s.url);
    await c.ws.ready;
    await until(() => s.sockets.length === 1);
    s.sockets[0].frame(0x1, Buffer.alloc(0), { fin: false });
    s.sockets[0].raw(Buffer.alloc(2 * 5000));
    await until(() => Boolean(c.closed()));
    expect(c.closed()?.code).toBe(1009);
    expect(c.errors[0]?.message).toBe('A message came in too many pieces.');
    const sent = s.sockets[0].frames.find((f) => f.opcode === 0x8)!;
    expect(sent.payload.readUInt16BE(0)).toBe(1009);
  });

  it('reads nothing more after the protocol was broken', async () => {
    const s = await server();
    const c = open(s.url);
    await c.ws.ready;
    await until(() => s.sockets.length === 1);
    s.sockets[0].frame(0x1, 'hidden', { mask: true });
    s.sockets[0].raw(Buffer.alloc(2_000_000, 0x41));
    await until(() => Boolean(c.closed()));
    expect(c.closed()?.code).toBe(1002);
    expect((c.ws as unknown as { pendingBytes: number }).pendingBytes).toBe(0);
  });

  it('reads a frame that comes a few bytes at a time', async () => {
    const s = await server();
    const c = open(s.url);
    await c.ws.ready;
    await until(() => s.sockets.length === 1);
    const text = 'z'.repeat(70_000);
    const bytes = serverFrame(0x1, Buffer.from(text));
    // The ten byte head alone comes in four pieces, then the rest in a few.
    for (const [from, to] of [[0, 1], [1, 3], [3, 7], [7, 12], [12, 30_000], [30_000, bytes.length]]) {
      s.sockets[0].raw(bytes.subarray(from, to));
      await new Promise((r) => setTimeout(r, 5));
    }
    await until(() => c.messages.length === 1);
    expect(c.messages[0]).toBe(text);
  });

  it('answers many pings with few pongs', async () => {
    const s = await server();
    const c = open(s.url);
    await c.ws.ready;
    await until(() => s.sockets.length === 1);
    const one = serverFrame(0x9, Buffer.from('p'));
    s.sockets[0].raw(Buffer.concat(Array.from({ length: 20_000 }, () => one)));
    s.sockets[0].send('after');
    await until(() => c.messages.length === 1);
    await until(() => s.sockets[0].frames.some((f) => f.opcode === 0xa));
    await new Promise((r) => setTimeout(r, 30));
    const pongs = s.sockets[0].frames.filter((f) => f.opcode === 0xa);
    expect(pongs.length).toBeLessThan(200);
    expect(pongs[0].payload.toString()).toBe('p');
  });

  it('ends a connection whose server does not read what is sent', async () => {
    const s = await server();
    const c = open(s.url, { maxMessageBytes: 1000 });
    await c.ws.ready;
    await until(() => s.sockets.length === 1);
    s.sockets[0].pause();
    const big = 'x'.repeat(256 * 1024);
    for (let i = 0; i < 400 && !c.closed(); i++) {
      try {
        c.ws.send(big);
      } catch {
        break;
      }
      await new Promise((r) => setImmediate(r));
    }
    await until(() => Boolean(c.closed()), 3000, 'the close');
    expect(c.closed()).toEqual({ code: 1008, reason: 'The server does not read what is sent.' });
    s.sockets[0].drop();
  });

  it('checks the close frame before it answers it', async () => {
    const s = await server();
    const cases: { payload: Buffer; code: number }[] = [
      { payload: Buffer.from([0x03]), code: 1002 },
      { payload: Buffer.from([0x03, 0xee]), code: 1002 },
      { payload: Buffer.from([0x13, 0x88]), code: 1002 },
      { payload: Buffer.from([0x00, 0x00]), code: 1002 },
      { payload: Buffer.from([0x03, 0xe8, 0xff, 0xfe]), code: 1007 },
    ];
    for (const [i, { payload, code }] of cases.entries()) {
      const c = open(s.url);
      await c.ws.ready;
      await until(() => s.sockets.length === i + 1);
      s.sockets[i].frame(0x8, payload);
      await until(() => Boolean(c.closed()));
      expect(c.closed()?.code).toBe(code);
      const answer = s.sockets[i].frames.find((f) => f.opcode === 0x8)!;
      // The client never sends a code it may not: it says what was wrong instead.
      expect(answer.payload.readUInt16BE(0)).toBe(code);
    }
    // A code the server may send, such as 1012 for a restart, is answered with the same code.
    const ok = open(s.url);
    await ok.ws.ready;
    await until(() => s.sockets.length === cases.length + 1);
    s.sockets[cases.length].close(1012, 'restarting');
    await until(() => Boolean(ok.closed()));
    expect(ok.closed()).toEqual({ code: 1012, reason: 'restarting' });
    expect(s.sockets[cases.length].frames.find((f) => f.opcode === 0x8)!.payload.readUInt16BE(0)).toBe(1012);
  });

  it('refuses a private address on a shared server before connecting', async () => {
    const lookups: string[] = [];
    const guard = {
      server: true,
      allowPrivate: false,
      lookup: async (host: string) => {
        lookups.push(host);
        return [{ address: '10.1.2.3', family: 4 }];
      },
    };
    const c = open('wss://chat.internal.example/api/v4/websocket', { guard });
    await expect(c.ws.ready).rejects.toThrow(/private network/);
    expect(lookups).toEqual(['chat.internal.example']);
    expect(c.closed()?.code).toBe(1006);

    const self = open('ws://127.0.0.1:9/socket', { guard: { server: true, allowPrivate: true } });
    await expect(self.ws.ready).rejects.toThrow('A shared server does not call itself.');

    const plain = open('ws://chat.example.com/socket', { guard: { server: true, allowPrivate: false, lookup: async () => [{ address: '93.184.216.34', family: 4 }] } });
    await expect(plain.ws.ready).rejects.toThrow('has to be https');

    const other = open('https://chat.example.com/socket');
    await expect(other.ws.ready).rejects.toThrow('wss://');
  });

  it('connects to the address that was checked, not to what the name says later', async () => {
    const s = await server();
    // The name does not exist; the check's own lookup gives the address, and the connection uses it.
    const guard = { server: false, allowPrivate: true, lookup: async () => [{ address: '127.0.0.1', family: 4 }] };
    const c = open(`ws://socket.sshs3-test.invalid:${s.port}/socket`, { guard });
    await c.ws.ready;
    await until(() => s.sockets.length === 1);
    expect(s.sockets[0].request.headers.host).toBe(`socket.sshs3-test.invalid:${s.port}`);
  });

  it('does not follow a redirect', async () => {
    const elsewhere = await server();
    const s = await server({
      response: (_req, res) => res.writeHead(302, { Location: elsewhere.url.replace('ws:', 'http:') }).end(),
    });
    // The upgrade is answered with a plain response instead.
    s.srv.removeAllListeners('upgrade');
    s.srv.on('upgrade', (_req, socket) => {
      socket.end(`HTTP/1.1 302 Found\r\nLocation: ${elsewhere.url.replace('ws:', 'http:')}\r\nContent-Length: 0\r\n\r\n`);
    });
    const c = open(s.url);
    const error = await c.ws.ready.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(WsError);
    expect((error as WsError).status).toBe(302);
    expect((error as Error).message).toMatch(/Redirects are not followed/);
    await new Promise((r) => setTimeout(r, 50));
    expect(elsewhere.sockets).toHaveLength(0);
  });

  it('says when the server refused, with how long to wait', async () => {
    const s = await server({ status: 429, headers: { 'Retry-After': '7' } });
    const c = open(s.url);
    const error = (await c.ws.ready.catch((e: unknown) => e)) as WsError;
    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBe(7000);
  });

  it('refuses a server that answers the key wrongly', async () => {
    const s = await server({ badAccept: true });
    const c = open(s.url);
    await expect(c.ws.ready).rejects.toThrow('answered the socket');
    expect(c.closed()?.code).toBe(1006);
  });

  it.skipIf(!hasOpenssl)('over TLS, names the host for SNI and checks the certificate', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshs3-ws-tls-'));
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=socket.sshs3-test.invalid', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
      const names: string[] = [];
      const srv = https.createServer({
        key: fs.readFileSync(path.join(dir, 'key.pem')),
        cert: fs.readFileSync(path.join(dir, 'cert.pem')),
        SNICallback: (name, done) => {
          names.push(name);
          done(null);
        },
      });
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
      servers.push(srv);
      const port = (srv.address() as AddressInfo).port;
      const guard = { server: false, allowPrivate: true, lookup: async () => [{ address: '127.0.0.1', family: 4 }] };
      const c = open(`wss://socket.sshs3-test.invalid:${port}/socket`, { guard });
      // A certificate nobody vouches for is refused, after the name was sent to the checked address.
      await expect(c.ws.ready).rejects.toThrow(/self[- ]signed|certificate/i);
      expect(names).toEqual(['socket.sshs3-test.invalid']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('can be closed before it opened', async () => {
    const s = await server();
    const c = open(s.url);
    c.ws.close();
    await expect(c.ws.ready).rejects.toThrow('closed before it opened');
    expect(c.closed()?.code).toBe(1000);
  });
});
