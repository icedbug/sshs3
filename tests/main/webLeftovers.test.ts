import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', async () => await import('../../src/main/web/electronShim'));

import { WebAuthService } from '../../src/main/web/WebAuthService';
import { ADMIN_PASSWORD, startWebServer, type WebServerKit } from '../helpers/webServerKit';

/** Small things in the web server that earlier rounds saw and left. */

describe('an account whose key could not be made', () => {
  let dir: string;
  let auth: WebAuthService;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-leftovers-'));
    auth = new WebAuthService(dir);
    await auth.initialize();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('does not exist afterwards: the name is free, and the server is still not set up', async () => {
    const keys = vi.spyOn(auth, 'ensureUserSshKey').mockRejectedValueOnce(new Error('ssh-keygen is not installed'));
    await expect(auth.setupInitialAdmin({ username: 'maria', password: ADMIN_PASSWORD })).rejects.toThrow('ssh-keygen is not installed');
    expect(auth.hasAnyUsers()).toBe(false);
    await expect(fs.readdir(path.join(dir, 'users'))).rejects.toThrow();
    keys.mockRestore();
    // The same person tries again and is the first administrator: nothing was left behind in their way.
    const made = await auth.setupInitialAdmin({ username: 'maria', password: ADMIN_PASSWORD });
    expect(made.user.role).toBe('admin');
    expect((await auth.login('maria', ADMIN_PASSWORD)).user.username).toBe('maria');
    // What is on disk has the one account, once.
    const stored = JSON.parse(await fs.readFile(path.join(dir, 'web-users.json'), 'utf8'));
    expect(stored.users.map((u: { username: string }) => u.username)).toEqual(['maria']);
  });

  it('does not exist either when it could not be written down, and its key folder is gone', async () => {
    const admin = await auth.setupInitialAdmin({ username: 'maria', password: ADMIN_PASSWORD });
    vi.spyOn(auth as unknown as { save: () => Promise<void> }, 'save').mockRejectedValueOnce(new Error('disk full'));
    await expect(auth.createUserByAdmin({ username: 'omar', password: 'omar-password-123', role: 'member' })).rejects.toThrow('disk full'); // pragma: allowlist secret
    expect((await auth.listUsers()).map((u) => u.username)).toEqual(['maria']);
    expect(await fs.readdir(path.join(dir, 'users'))).toEqual([admin.user.id]);
    // The name was not used up.
    const again = await auth.createUserByAdmin({ username: 'omar', password: 'omar-password-123', role: 'member' }); // pragma: allowlist secret
    expect(again.username).toBe('omar');
  });
});

interface FakeSocket extends EventEmitter {
  destroyed: boolean;
  writable: boolean;
  ended: Buffer[];
  written: Buffer[];
  destroys: number;
  end(frame: Buffer): void;
  write(frame: Buffer): boolean;
  destroy(): void;
}

const fakeSocket = (): FakeSocket => {
  const socket = new EventEmitter() as FakeSocket;
  socket.destroyed = false;
  socket.writable = true;
  socket.ended = [];
  socket.written = [];
  socket.destroys = 0;
  socket.end = (frame) => {
    socket.ended.push(frame);
    socket.writable = false;
  };
  socket.write = (frame) => {
    socket.written.push(frame);
    return true;
  };
  socket.destroy = () => {
    socket.destroys += 1;
    socket.destroyed = true;
  };
  return socket;
};

describe('web server: closing a connection', () => {
  let kit: WebServerKit;
  const GRACE = 60;

  beforeEach(async () => {
    kit = await startWebServer({ wsCloseGraceMs: GRACE });
  });

  afterEach(async () => {
    await kit.stop();
  });

  const reap = (socket: FakeSocket, policy?: string): { released: () => number; entry: Record<string, unknown> } => {
    let released = 0;
    const entry = { socket, userId: 'usr_x', clientId: 1, isAlive: true, awaitingPong: false, pingSentAt: 0, backpressureEvents: 0, droppedStreamFrames: 0, release: () => void released++ };
    (kit.server as unknown as { reapWsEntry: (e: unknown, p?: string) => void }).reapWsEntry(entry, policy);
    return { released: () => released, entry };
  };
  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  it('ends the socket with the close frame as the last thing written, and cuts it only after a while', async () => {
    const socket = fakeSocket();
    const { released, entry } = reap(socket, 'Signed out');
    // The frame is handed to end(): it leaves after what was written before it. Nothing is cut yet.
    expect(socket.written).toEqual([]);
    expect(socket.ended).toHaveLength(1);
    const frame = socket.ended[0]!;
    expect(frame[0]).toBe(0x88);
    expect(frame.readUInt16BE(2)).toBe(1008);
    expect(frame.subarray(4).toString('utf8')).toBe('Signed out');
    expect(socket.destroys).toBe(0);
    // It is no client of the account from that moment.
    expect(released()).toBe(1);
    expect(entry.closing).toBe(true);
    // A client that does not go by itself is cut.
    await wait(GRACE * 3);
    expect(socket.destroys).toBe(1);
  });

  it('does not cut a socket that closed by itself in time, and closes a connection once', async () => {
    const socket = fakeSocket();
    const { entry, released } = reap(socket);
    expect(socket.ended[0]).toEqual(Buffer.from([0x88, 0]));
    (kit.server as unknown as { reapWsEntry: (e: unknown, p?: string) => void }).reapWsEntry(entry, 'Signed out');
    expect(socket.ended).toHaveLength(1);
    expect(released()).toBe(1);
    socket.emit('close');
    await wait(GRACE * 3);
    expect(socket.destroys).toBe(0);
  });

  it('cuts a socket that cannot be written to at once', () => {
    const socket = fakeSocket();
    socket.writable = false;
    reap(socket, 'Signed out');
    expect(socket.ended).toEqual([]);
    expect(socket.destroys).toBe(1);
  });

  it('tells a real client why, and cuts one that stays although it was told to go', async () => {
    await kit.send('POST', '/api/auth/setup', { username: 'maria', password: ADMIN_PASSWORD });
    const signIn = await kit.send('POST', '/api/auth/login', { username: 'maria', password: ADMIN_PASSWORD });
    const ticket = await kit.send('POST', '/api/ws-ticket', {}, signIn.cookie);
    const port = Number(new URL(kit.baseUrl).port);
    // A client that keeps its side open whatever the server says.
    const client = net.connect({ host: '127.0.0.1', port, allowHalfOpen: true });
    try {
      const got: Buffer[] = [];
      client.on('data', (chunk) => got.push(chunk));
      const ended = new Promise<void>((resolve) => client.once('end', () => resolve()));
      await new Promise<void>((resolve) => client.once('connect', () => resolve()));
      client.write(
        [`GET /api/ws?ticket=${encodeURIComponent(ticket.body.ticket)} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13', '', ''].join('\r\n'),
      );
      await vi.waitFor(() => expect(Buffer.concat(got).toString('latin1')).toContain('101 Switching Protocols'), { timeout: 15_000 });
      const sockets = (): number => (kit.server as unknown as { activeSockets: Set<unknown> }).activeSockets.size;
      expect(sockets()).toBe(1);

      expect((await kit.send('POST', '/api/auth/logout', {}, signIn.cookie)).status).toBe(200);
      await ended;
      const all = Buffer.concat(got);
      const close = all.subarray(all.length - 14);
      expect(close[0]).toBe(0x88);
      expect(close.readUInt16BE(2)).toBe(1008);
      expect(close.subarray(4).toString('utf8')).toBe('Signed out');
      // The client has not closed its side. The server does not keep the socket for it.
      await vi.waitFor(() => expect(sockets()).toBe(0), { timeout: 5000 });
    } finally {
      client.destroy();
    }
  }, 30_000);
});
