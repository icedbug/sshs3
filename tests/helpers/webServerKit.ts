import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setHeadlessUserDataPath } from '../../src/main/web/electronShim';
import { Sshs3WebServer, type Sshs3WebServerOptions } from '../../src/main/web/WebServer';

/**
 * A real web server on a free port with a data folder of its own, and what a test needs to talk to it
 * the way a browser does: requests with a session cookie, and the WebSocket the page calls handlers over.
 * The test file itself mocks 'electron' with the web stand-in (vi.mock is hoisted per file).
 */

export interface Answer {
  status: number;
  body: any;
  /** The session cookie the answer set, as "name=value", or an empty string. */
  cookie: string;
  text: string;
}

export interface WebClient {
  invoke: (channel: string, ...args: unknown[]) => Promise<any>;
  /** Sends a raw text frame, whatever it is. */
  raw: (text: string) => void;
  closed: () => boolean;
  /** Resolves when the server has closed the connection, with the close code. */
  whenClosed: Promise<number>;
  close: () => void;
}

export interface WebServerKit {
  server: Sshs3WebServer;
  /** The folder that holds the data folder, the static folder and anything else the test puts beside them. */
  tmpDir: string;
  dataDir: string;
  baseUrl: string;
  send: (method: string, urlPath: string, body?: unknown, cookie?: string, extra?: { headers?: Record<string, string>; raw?: string }) => Promise<Answer>;
  /** An administrator ("maria") and a member ("omar"), each signed in. */
  team: () => Promise<{ adminCookie: string; adminId: string; memberCookie: string; memberId: string }>;
  connect: (cookie: string) => Promise<WebClient>;
  stop: () => Promise<void>;
}

export const ADMIN_PASSWORD = 'maria-password-123'; // pragma: allowlist secret
export const MEMBER_PASSWORD = 'omar-password-123'; // pragma: allowlist secret

export async function startWebServer(options: Partial<Sshs3WebServerOptions> = {}): Promise<WebServerKit> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sshs3-web-kit-'));
  const dataDir = path.join(tmpDir, 'data');
  await fs.mkdir(dataDir, { recursive: true });
  setHeadlessUserDataPath(dataDir);
  const staticDir = path.join(tmpDir, 'static');
  await fs.mkdir(staticDir, { recursive: true });
  await fs.writeFile(path.join(staticDir, 'index.html'), '<!doctype html><html><body>x</body></html>', 'utf-8');
  const server = new Sshs3WebServer({ port: 0, host: '127.0.0.1', dataDir, staticDir, ...options });
  const info = await server.start();
  const baseUrl = `http://127.0.0.1:${info.port}`;
  const wsUrl = `ws://127.0.0.1:${info.port}`;

  const send: WebServerKit['send'] = async (method, urlPath, body, cookie, extra) => {
    const res = await fetch(`${baseUrl}${urlPath}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(extra?.headers ?? {}) },
      ...(extra?.raw !== undefined ? { body: extra.raw } : body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let json: any = {};
    try {
      json = JSON.parse(text);
    } catch {
      // Not JSON: the text is what the test looks at.
    }
    return { status: res.status, body: json, cookie: (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '', text };
  };

  const team: WebServerKit['team'] = async () => {
    const admin = await send('POST', '/api/auth/setup', { username: 'maria', password: ADMIN_PASSWORD });
    const invite = await send('POST', '/api/admin/invites', { role: 'member', maxUses: 1 }, admin.cookie);
    const made = await send('POST', '/api/auth/register-invite', { inviteToken: invite.body.invite.token, username: 'omar', password: MEMBER_PASSWORD });
    return { adminCookie: admin.cookie, adminId: admin.body.user.id, memberCookie: made.cookie, memberId: made.body.user.id };
  };

  const connect: WebServerKit['connect'] = async (cookie) => {
    const ticket = await send('POST', '/api/ws-ticket', {}, cookie);
    if (ticket.status !== 200) throw new Error(`No WebSocket ticket (${ticket.status})`);
    const ws = new WebSocket(`${wsUrl}/api/ws?ticket=${encodeURIComponent(ticket.body.ticket)}`);
    let isClosed = false;
    const waiting = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    const whenClosed = new Promise<number>((resolve) => {
      ws.addEventListener('close', (ev) => {
        isClosed = true;
        for (const w of waiting.values()) w.reject(new Error('socket closed'));
        waiting.clear();
        resolve(ev.code);
      });
    });
    ws.addEventListener('message', (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      const w = msg?.type === 'response' ? waiting.get(msg.id) : undefined;
      if (!w) return;
      waiting.delete(msg.id);
      if (msg.ok) w.resolve(msg.result);
      else w.reject(new Error(msg.error));
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('The WebSocket did not open')));
    });
    let n = 0;
    return {
      invoke: (channel, ...args) =>
        new Promise((resolve, reject) => {
          if (isClosed) return reject(new Error('socket closed'));
          const id = `r${++n}`;
          waiting.set(id, { resolve, reject });
          ws.send(JSON.stringify({ id, type: 'invoke', channel, args }));
        }),
      raw: (text) => ws.send(text),
      closed: () => isClosed,
      whenClosed,
      close: () => ws.close(),
    };
  };

  return {
    server,
    tmpDir,
    dataDir,
    baseUrl,
    send,
    team,
    connect,
    stop: async () => {
      await server.stop();
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/** A ustar archive, as text, holding one link `name -> target`: a symbolic link, or a hard link with `hard`. */
export function tarWithLink(name: string, target: string, hard = false): string {
  const block = Buffer.alloc(512, 0);
  block.write(name, 0, 'ascii');
  block.write('0000777\0', 100, 'ascii');
  block.write('0000000\0', 108, 'ascii');
  block.write('0000000\0', 116, 'ascii');
  block.write('00000000000\0', 124, 'ascii');
  block.write('00000000000\0', 136, 'ascii');
  block.write('        ', 148, 'ascii');
  block.write(hard ? '1' : '2', 156, 'ascii');
  block.write(target, 157, 'ascii');
  block.write('ustar\0', 257, 'ascii');
  block.write('00', 263, 'ascii');
  let sum = 0;
  for (const b of block) sum += b;
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return Buffer.concat([block, Buffer.alloc(1024, 0)]).toString('latin1');
}
