import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { setWebDataDir } from './electronShim';
import { WebAuthService, type WebUserPublic } from './WebAuthService';
import { WebTenantManager } from './WebTenantManager';
import { MCP_SCOPES, McpTokenStore, type McpScope } from './McpTokenStore';
import { callBudget, handleMcpHttp } from './mcp/McpEndpoint';
import { AuditLog } from '../ai/hub/AuditLog';
import { verifyStandardWebhook, WEBHOOK_TOLERANCE_SECONDS } from '../ai/hub/Notifier';
import { createLogger } from '../log';
import { createWsSender } from './wsSender';

const log = createLogger('web');

const WS_MAGIC_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const SESSION_COOKIE_NAME = 'sshs3_session';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function parseCookies(cookieHeader?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function isSecureRequest(req: http.IncomingMessage): boolean {
  const sock = req.socket as { encrypted?: boolean } | undefined;
  if (sock?.encrypted === true) return true;
  const proto = req.headers['x-forwarded-proto'];
  if (typeof proto === 'string') {
    return proto.split(',')[0]!.trim().toLowerCase() === 'https';
  }
  return false;
}

function buildSessionCookie(
  token: string,
  maxAgeSec = 30 * 24 * 3600,
  secure = false,
): string {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
}

/**
 * Strict CSWSH defense: verifies that a browser-supplied Origin matches the
 * request Host on BOTH normalized hostname AND exact port (or matches an
 * explicitly configured allowed origin).
 */
export function isAllowedWsOrigin(
  originHeader: string | string[] | undefined,
  hostHeader: string | string[] | undefined,
  allowedOrigins?: string[],
): boolean {
  if (originHeader === undefined) {
    // Non-browser clients (CLI / Node WebSocket) do not send an Origin header.
    return true;
  }
  if (typeof originHeader !== 'string') return false;
  const trimmedOrigin = originHeader.trim();
  if (!trimmedOrigin || trimmedOrigin.toLowerCase() === 'null') return false;

  let originUrl: URL;
  try {
    originUrl = new URL(trimmedOrigin);
  } catch {
    return false;
  }
  if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') {
    return false;
  }
  if (originUrl.username || originUrl.password) {
    return false;
  }

  const originHostname = originUrl.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const originPort = originUrl.port || (originUrl.protocol === 'https:' ? '443' : '80');

  if (Array.isArray(allowedOrigins) && allowedOrigins.length > 0) {
    for (const entry of allowedOrigins) {
      try {
        const allowed = new URL(entry);
        if (allowed.protocol !== originUrl.protocol) continue;
        const allowedHost = allowed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
        const allowedPort = allowed.port || (allowed.protocol === 'https:' ? '443' : '80');
        if (allowedHost === originHostname && allowedPort === originPort) {
          return true;
        }
      } catch {
        // Ignore malformed configured origin
      }
    }
  }

  if (typeof hostHeader !== 'string') return false;
  const trimmedHost = hostHeader.trim();
  if (!trimmedHost || /[\s@/?#\\]/.test(trimmedHost)) return false;

  let hostUrl: URL;
  try {
    hostUrl = new URL(`${originUrl.protocol}//${trimmedHost}`);
  } catch {
    return false;
  }
  const reqHostname = hostUrl.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const reqPort = hostUrl.port || (originUrl.protocol === 'https:' ? '443' : '80');

  return Boolean(reqHostname) && originHostname === reqHostname && originPort === reqPort;
}

async function readJsonBody(
  req: http.IncomingMessage,
  maxBytes = 256_000,
): Promise<Record<string, unknown>> {
  const raw = (await readRawBody(req, maxBytes)).trim();
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

async function readRawBody(
  req: http.IncomingMessage,
  maxBytes = 256_000,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new Error('Request payload too large');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const data = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(data.length),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(data);
}

/**
 * Encodes a UTF-8 text payload into an unmasked server-to-client RFC 6455 WebSocket frame.
 */
function encodeWsTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text frame
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/** A close frame's body: the status code, then a short reason. */
function wsClosePayload(code: number, reason: string): Buffer {
  const text = Buffer.from(reason, 'utf8').subarray(0, 120);
  const body = Buffer.alloc(2 + text.length);
  body.writeUInt16BE(code, 0);
  text.copy(body, 2);
  return body;
}

/**
 * Terminal and log output events: under backpressure these may be dropped (the next chunk carries on).
 * Classified by the start of the frame the tenant built (`{"type":"event","channel":...}`), never by
 * text anywhere in it: an RPC response whose result mentions a channel name is still a response.
 */
const STREAM_EVENT_PREFIXES = [
  '{"type":"event","channel":"terminal:data"',
  '{"type":"event","channel":"k8s-terminal:data"',
  '{"type":"event","channel":"k8s-log:data"',
];

export function isDroppableStreamFrame(jsonText: string): boolean {
  return STREAM_EVENT_PREFIXES.some((prefix) => jsonText.startsWith(prefix));
}

function encodeWsControlFrame(opcode: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const len = Math.min(payload.length, 125);
  const header = Buffer.from([0x80 | (opcode & 0x0f), len]);
  return Buffer.concat([header, payload.subarray(0, len)]);
}

/**
 * Attaches an RFC 6455 WebSocket frame parser to a raw upgraded socket.
 */
const MAX_WS_MESSAGE_BYTES = 16 * 1024 * 1024;

function attachWsFrameParser(
  socket: Duplex,
  onMessage: (text: string) => void,
  onClose: () => void,
  hooks?: {
    onPong?: (payload: Buffer) => void;
    onActivity?: () => void;
  },
): void {
  let buffer = Buffer.alloc(0);
  let fragments: Buffer[] = [];
  let fragmentsBytes = 0;

  const cleanup = () => {
    fragments = [];
    fragmentsBytes = 0;
    buffer = Buffer.alloc(0);
    onClose();
  };

  socket.on('close', cleanup);
  socket.on('error', () => {
    socket.destroy();
  });

  socket.on('data', (chunk: Buffer) => {
    if (buffer.length + chunk.length > MAX_WS_MESSAGE_BYTES) {
      socket.destroy();
      return;
    }
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 2) {
      const byte0 = buffer[0]!;
      const byte1 = buffer[1]!;
      const fin = (byte0 & 0x80) !== 0;
      const opcode = byte0 & 0x0f;
      const masked = (byte1 & 0x80) !== 0;
      let payloadLen = byte1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (buffer.length < 4) return;
        payloadLen = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buffer.length < 10) return;
        const bigLen = buffer.readBigUInt64BE(2);
        if (bigLen > BigInt(MAX_WS_MESSAGE_BYTES)) {
          socket.destroy();
          return;
        }
        payloadLen = Number(bigLen);
        offset = 10;
      }

      if (payloadLen > MAX_WS_MESSAGE_BYTES) {
        socket.destroy();
        return;
      }

      const maskLen = masked ? 4 : 0;
      if (buffer.length < offset + maskLen + payloadLen) {
        return;
      }

      const maskKey = masked
        ? buffer.subarray(offset, offset + 4)
        : null;
      offset += maskLen;

      const payload = Buffer.from(
        buffer.subarray(offset, offset + payloadLen),
      );
      buffer = buffer.subarray(offset + payloadLen);

      if (maskKey) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i & 3]!;
        }
      }

      hooks?.onActivity?.();

      if (opcode === 0x8) {
        // Close frame
        try {
          socket.write(encodeWsControlFrame(0x8));
        } catch {
          // ignore
        }
        socket.end();
        return;
      } else if (opcode === 0x9) {
        // Ping -> Pong
        try {
          socket.write(encodeWsControlFrame(0xa, payload));
        } catch {
          // ignore
        }
      } else if (opcode === 0xa) {
        // Pong
        hooks?.onPong?.(payload);
      } else if (opcode === 0x1 || opcode === 0x0) {
        fragmentsBytes += payload.length;
        if (fragmentsBytes > MAX_WS_MESSAGE_BYTES) {
          socket.destroy();
          return;
        }
        fragments.push(payload);
        if (fin) {
          const fullText = Buffer.concat(fragments).toString('utf8');
          fragments = [];
          fragmentsBytes = 0;
          onMessage(fullText);
        }
      }
    }
  });
}

interface WsTicketRecord {
  userId: string;
  expiresAt: number;
  origin?: string;
}

interface WsConnectionEntry {
  socket: Duplex;
  userId: string;
  clientId: number;
  isAlive: boolean;
  awaitingPong: boolean;
  pingSentAt: number;
  pongTimer?: NodeJS.Timeout;
  backpressureEvents: number;
  droppedStreamFrames: number;
}

export interface Sshs3WebServerOptions {
  port?: number;
  host?: string;
  dataDir: string;
  staticDir?: string;
  /**
   * Start every user's background work when the server starts instead of
   * when they first log in (also SSHS3_WORKFORCE=1). A server that runs the
   * team's workforce needs this: after a restart nobody may log in for days.
   */
  wakeUsersAtStart?: boolean;
  /** Explicit allowed Origin URLs (e.g. reverse proxy) in addition to exact Host match. */
  allowedOrigins?: string[];
  /** Single-use WS ticket TTL in milliseconds (default: 15000). */
  wsTicketTtlMs?: number;
  /** Server-side WS ping interval in milliseconds (default: 30000; 0 disables). */
  wsHeartbeatIntervalMs?: number;
  /** Max time to wait for a WS pong before reaping zombie socket (default: 10000). */
  wsHeartbeatTimeoutMs?: number;
  /** High-water threshold on socket.writableLength before queueing frames (default: 262144). */
  wsHighWaterBytes?: number;
  /** Hard cap on writableLength + queued bytes before dropping stream chunks or closing slow sockets (default: 16777216). */
  wsMaxBufferedBytes?: number;
}

export class Sshs3WebServer {
  public readonly auth: WebAuthService;
  public readonly tenants: WebTenantManager;
  /** The keys that let a person's own agent reach this server over MCP. */
  public readonly mcpTokens: McpTokenStore;
  private readonly mcpRate = callBudget();
  /**
   * The server's own chain: who signed in, who failed to, who was added or
   * removed. Each person's hub keeps its own log of what was run; this one is
   * about the door.
   */
  public readonly signIns: AuditLog;
  private httpServer?: http.Server;
  private boundPort = 0;
  private activeSockets = new Set<Duplex>();
  private activeWsEntries = new Map<Duplex, WsConnectionEntry>();
  private wsTickets = new Map<string, WsTicketRecord>();
  private heartbeatTimer?: NodeJS.Timeout;

  constructor(private readonly options: Sshs3WebServerOptions) {
    setWebDataDir(options.dataDir);
    this.auth = new WebAuthService(options.dataDir);
    this.tenants = new WebTenantManager(
      options.dataDir,
      () => this.auth.userCount(),
      () => this.auth.accountsBrief(),
    );
    this.mcpTokens = new McpTokenStore(options.dataDir);
    this.signIns = new AuditLog(path.join(options.dataDir, 'audit'), 'server');
  }

  getPort(): number {
    return this.boundPort;
  }

  getWsStats(): {
    activeConnections: number;
    totalBackpressureEvents: number;
    totalDroppedStreamFrames: number;
    activeTickets: number;
  } {
    let totalBackpressureEvents = 0;
    let totalDroppedStreamFrames = 0;
    for (const entry of this.activeWsEntries.values()) {
      totalBackpressureEvents += entry.backpressureEvents;
      totalDroppedStreamFrames += entry.droppedStreamFrames;
    }
    return {
      activeConnections: this.activeWsEntries.size,
      totalBackpressureEvents,
      totalDroppedStreamFrames,
      activeTickets: this.wsTickets.size,
    };
  }

  private getAllowedOrigins(): string[] {
    if (this.options.allowedOrigins?.length) return this.options.allowedOrigins;
    const raw = process.env.SSHS3_ALLOWED_ORIGINS || '';
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }

  private issueWsTicket(userId: string, originHeader?: string | string[]): {
    ticket: string;
    expiresAt: number;
    expiresInMs: number;
  } {
    const now = Date.now();
    for (const [k, rec] of this.wsTickets.entries()) {
      if (rec.expiresAt <= now) this.wsTickets.delete(k);
    }
    if (this.wsTickets.size >= 10_000) {
      const oldestKey = this.wsTickets.keys().next().value;
      if (oldestKey) this.wsTickets.delete(oldestKey);
    }
    const ttlMs = Math.max(100, this.options.wsTicketTtlMs ?? 15_000);
    const ticket = crypto.randomBytes(24).toString('base64url');
    const expiresAt = now + ttlMs;
    const origin =
      typeof originHeader === 'string' && originHeader.trim()
        ? originHeader.trim().toLowerCase()
        : undefined;
    this.wsTickets.set(ticket, { userId, expiresAt, ...(origin ? { origin } : {}) });
    return { ticket, expiresAt, expiresInMs: ttlMs };
  }

  private consumeWsTicket(ticket: string, originHeader?: string | string[]): string | null {
    const clean = ticket.trim();
    if (!clean) return null;
    const entry = this.wsTickets.get(clean);
    // Single-use: consume immediately regardless of validity/expiry
    this.wsTickets.delete(clean);
    if (!entry || entry.expiresAt <= Date.now()) {
      return null;
    }
    if (entry.origin && typeof originHeader === 'string' && originHeader.trim()) {
      if (entry.origin !== originHeader.trim().toLowerCase()) {
        return null;
      }
    }
    return entry.userId;
  }

  private reapWsEntry(entry: WsConnectionEntry): void {
    if (entry.pongTimer) {
      clearTimeout(entry.pongTimer);
      entry.pongTimer = undefined;
    }
    try {
      if (!entry.socket.destroyed && entry.socket.writable) {
        entry.socket.write(encodeWsControlFrame(0x8));
      }
    } catch {
      // ignore
    }
    try {
      entry.socket.destroy();
    } catch {
      // ignore
    }
  }

  private startWsHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    const intervalMs = this.options.wsHeartbeatIntervalMs ?? 30_000;
    if (intervalMs <= 0) return;
    const timeoutMs = Math.max(20, this.options.wsHeartbeatTimeoutMs ?? 10_000);

    this.heartbeatTimer = setInterval(() => {
      for (const entry of Array.from(this.activeWsEntries.values())) {
        if (entry.socket.destroyed || !entry.socket.writable) {
          this.reapWsEntry(entry);
          continue;
        }
        if (entry.awaitingPong) {
          this.reapWsEntry(entry);
          continue;
        }
        entry.awaitingPong = true;
        entry.isAlive = false;
        entry.pingSentAt = Date.now();
        try {
          entry.socket.write(encodeWsControlFrame(0x9, Buffer.from('hb')));
        } catch {
          this.reapWsEntry(entry);
          continue;
        }
        if (timeoutMs < intervalMs) {
          if (entry.pongTimer) clearTimeout(entry.pongTimer);
          entry.pongTimer = setTimeout(() => {
            entry.pongTimer = undefined;
            if (entry.awaitingPong) {
              this.reapWsEntry(entry);
            }
          }, timeoutMs);
          entry.pongTimer.unref?.();
        }
      }
    }, intervalMs);
    this.heartbeatTimer.unref?.();
  }

  async start(): Promise<{ port: number; host: string }> {
    await this.auth.initialize();
    await this.tenants.initialize();
    await this.mcpTokens.initialize();

    const host = this.options.host ?? process.env.SSHS3_WEB_HOST ?? '0.0.0.0';
    const requestedPort =
      this.options.port ?? Number(process.env.SSHS3_WEB_PORT || 8080);

    const server = http.createServer((req, res) => {
      void this.handleHttpRequest(req, res).catch((err) => {
        if (!res.headersSent) {
          sendJson(res, 500, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    });

    server.on('upgrade', (req, socket, head) => {
      void this.handleWsUpgrade(req, socket, head).catch((err) => {
        log.error('WS upgrade error', err);
        socket.destroy();
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(requestedPort, host, () => {
        server.removeListener('error', reject);
        const addr = server.address();
        this.boundPort =
          typeof addr === 'object' && addr ? addr.port : requestedPort;
        resolve();
      });
    });

    this.httpServer = server;
    this.startWsHeartbeat();
    if (this.options.wakeUsersAtStart ?? process.env.SSHS3_WORKFORCE === '1')
      await this.wakeUsers();
    return { port: this.boundPort, host };
  }

  private hookHits = new Map<string, number[]>();
  /** Message ids of signed alerts already taken, per hook, with when they were taken. */
  private hookSeenIds = new Map<string, number>();

  /**
   * A monitoring system posting an alert. The address names the user and
   * carries the secret; a wrong address is answered exactly like a missing
   * one. At most 60 posts a minute per address and 256 kB per post.
   *
   * A sender may also sign the post the Standard Webhooks way, with the
   * secret in the address as the key (UTF-8 bytes): headers webhook-id,
   * webhook-timestamp (unix seconds) and webhook-signature
   * (v1,<base64 HMAC-SHA256 of "<id>.<timestamp>.<body>">). When any of these
   * headers is present, all must be, the signature must match, the timestamp
   * must be within 5 minutes, and an id already taken is refused, so a copied
   * request cannot be sent again. Unsigned posts are still taken.
   */
  private async handleAlertHook(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    token: string,
  ): Promise<void> {
    const dot = token.indexOf('.');
    const userId = dot > 0 ? token.slice(0, dot) : '';
    const secret = dot > 0 ? token.slice(dot + 1) : '';
    const now = Date.now();
    // Two limits, neither of which a stranger can use against a real sender: wrong addresses are
    // limited per caller, and accepted alerts per hook. Old entries age out; nothing is cleared wholesale.
    const caller = `ip:${req.socket.remoteAddress ?? '?'}`;
    const recent = (key: string): number[] => (this.hookHits.get(key) ?? []).filter((t) => now - t < 60_000);
    if (recent(caller).length >= 20) {
      sendJson(res, 429, { error: 'Too many wrong hook addresses from here; try again in a minute.' });
      return;
    }
    if (recent(`hook:${userId}`).length >= 60) {
      sendJson(res, 429, { error: 'Too many alerts; try again in a minute.' });
      return;
    }
    if (this.hookHits.size > 4000)
      for (const [key, times] of this.hookHits) if (!times.some((t) => now - t < 60_000)) this.hookHits.delete(key);
    const count = (key: string): void => void this.hookHits.set(key, [...recent(key), now]);
    let raw: string;
    let body: Record<string, unknown>;
    try {
      raw = await readRawBody(req);
      body = raw.trim() ? (JSON.parse(raw.trim()) as Record<string, unknown>) : {};
    } catch {
      sendJson(res, 400, { error: 'The body must be JSON of at most 256 kB.' });
      return;
    }
    const header = (name: string): string | undefined => {
      const value = req.headers[name];
      return Array.isArray(value) ? value[0] : value;
    };
    const signed = { id: header('webhook-id'), timestamp: header('webhook-timestamp'), signature: header('webhook-signature') };
    let seenKey: string | undefined;
    if (signed.id || signed.timestamp || signed.signature) {
      // Checked with the secret from the address only, before any lookup: the answer says nothing about who exists.
      const check = verifyStandardWebhook(secret, signed, raw);
      if (!check.ok) {
        count(caller);
        sendJson(res, 401, { error: check.reason });
        return;
      }
      for (const [key, at] of this.hookSeenIds) if (now - at > 2 * WEBHOOK_TOLERANCE_SECONDS * 1000) this.hookSeenIds.delete(key);
      seenKey = `${userId}:${signed.id}`;
      if (this.hookSeenIds.has(seenKey)) {
        sendJson(res, 409, { error: 'This webhook-id was already received.' });
        return;
      }
      // Held now, so the same request sent twice at once is taken once.
      this.hookSeenIds.set(seenKey, now);
    }
    const user = userId && secret ? (await this.auth.listUsers()).find((u) => u.id === userId) : undefined;
    const tenant = user ? await this.tenants.getOrCreateTenant(user).catch(() => undefined) : undefined;
    const result = tenant ? await tenant.hub.receiveAlert(secret, body) : undefined;
    if (!result) {
      if (seenKey) this.hookSeenIds.delete(seenKey);
      count(caller);
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    count(`hook:${userId}`);
    sendJson(res, 200, { ok: true, created: result.created.length, updated: result.updated.length });
  }

  /**
   * Starts each user's hub, whose timer runs their schedules, takes tickets
   * when their heartbeat is on, and reads the team's learning queue. A user
   * whose hub cannot start is logged and skipped.
   */
  async wakeUsers(): Promise<number> {
    let awake = 0;
    for (const user of await this.auth.listUsers()) {
      try {
        await this.tenants.getOrCreateTenant(user);
        awake++;
      } catch (err) {
        log.error(`Could not start background work for ${user.username}`, err);
      }
    }
    return awake;
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    for (const entry of this.activeWsEntries.values()) {
      if (entry.pongTimer) {
        clearTimeout(entry.pongTimer);
        entry.pongTimer = undefined;
      }
    }
    this.activeWsEntries.clear();
    this.wsTickets.clear();
    for (const sock of this.activeSockets) {
      try {
        // 1012 "service restart": a client tells its person the server went away on purpose and fails
        // what it was waiting for at once, instead of a connection that simply drops.
        if (!sock.destroyed) sock.write(encodeWsControlFrame(0x8, wsClosePayload(1012, 'The server is restarting')));
        sock.destroy();
      } catch {
        // ignore
      }
    }
    this.activeSockets.clear();
    await this.tenants.disposeAll();
    if (this.httpServer) {
      const srv = this.httpServer;
      this.httpServer = undefined;
      srv.closeAllConnections?.();
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  }

  /**
   * The MCP endpoint. The body is read first and whole (at most 1 MB), then
   * handed to a handler that opens nothing: what comes back is what is sent.
   */
  private async handleMcpEndpoint(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    method: string,
  ): Promise<void> {
    let body = '';
    if (method === 'POST') {
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buf.length;
        if (total > 1_000_000) {
          sendJson(res, 413, { error: 'That is more than this endpoint takes.' });
          return;
        }
        chunks.push(buf);
      }
      body = Buffer.concat(chunks).toString('utf8');
    }
    const answer = await handleMcpHttp(
      { method, headers: req.headers as Record<string, string | string[] | undefined>, body },
      {
        tokens: this.mcpTokens,
        rate: this.mcpRate,
        allowedHosts: () => {
          const configured = (process.env.SSHS3_MCP_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean);
          return configured.length ? [...configured, 'localhost', '127.0.0.1'] : undefined;
        },
        enabled: () => process.env.SSHS3_MCP !== '0',
        hubFor: async (userId) => {
          const user = (await this.auth.listUsers()).find((u) => u.id === userId);
          if (!user) return undefined;
          const tenant = await this.tenants.getOrCreateTenant(user);
          return {
            request: (r) => tenant.hub.request(r),
            actor: user.displayName || user.username,
            runCommand: (input) => tenant.hub.runForMcp({ ...input, by: user.displayName || user.username }),
            commandStatus: (id) => tenant.hub.mcpCommandStatus(id),
            audit: (entry) => tenant.hub.audit().append(entry),
          };
        },
      },
    );
    res.writeHead(answer.status, answer.headers);
    res.end(answer.body);
  }

  /** A person's own keys: made and revoked while signed in, never shown again after they are made. */
  private async handleMcpKeys(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    user: WebUserPublic,
    method: string,
    pathname: string,
  ): Promise<void> {
    if (method === 'GET') {
      sendJson(res, 200, { keys: this.mcpTokens.list(user.id), scopes: MCP_SCOPES });
      return;
    }
    if (method === 'POST') {
      const body = await readJsonBody(req);
      try {
        const asked = Array.isArray(body.scopes) ? body.scopes.map(String) : [];
        const made = await this.mcpTokens.create({
          userId: user.id,
          name: String(body.name || ''),
          createdBy: user.displayName || user.username,
          scopes: MCP_SCOPES.filter((s) => asked.includes(s)) as McpScope[],
          serverId: body.serverId ? String(body.serverId) : undefined,
          expiresInDays: body.expiresInDays ? Number(body.expiresInDays) : undefined,
          tools: Array.isArray(body.tools) ? body.tools.map(String) : undefined,
        });
        // The only time the key itself is ever sent anywhere.
        sendJson(res, 200, { key: made.view, token: made.token });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    if (method === 'DELETE') {
      const id = decodeURIComponent(pathname.slice('/api/mcp-keys/'.length));
      const gone = await this.mcpTokens.revoke(user.id, id);
      sendJson(res, gone ? 200 : 404, gone ? { ok: true } : { error: 'No such key' });
      return;
    }
    sendJson(res, 405, { error: 'Use GET, POST or DELETE.' });
  }

  private extractSessionToken(req: http.IncomingMessage): string | null {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      return authHeader.slice(7).trim();
    }
    const cookies = parseCookies(req.headers.cookie);
    if (cookies[SESSION_COOKIE_NAME]) {
      return cookies[SESSION_COOKIE_NAME]!;
    }
    return null;
  }

  private async authenticateRequest(
    req: http.IncomingMessage,
  ): Promise<WebUserPublic | null> {
    const token = this.extractSessionToken(req);
    return this.auth.verifySession(token);
  }

  private async handleHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    const method = req.method || 'GET';

    // Health check endpoint
    if (pathname === '/api/health' && method === 'GET') {
      sendJson(res, 200, { ok: true, mode: 'web-multiuser' });
      return;
    }

    // Alerts in: POST /api/hooks/<user id>.<secret>. No session: the secret in the address is the key.
    if (pathname.startsWith('/api/hooks/') && method === 'POST') {
      await this.handleAlertHook(req, res, pathname.slice('/api/hooks/'.length));
      return;
    }

    // Somebody's own agent, over MCP. Its own key in the Authorization header; no session, no cookie.
    if (pathname === '/api/mcp') {
      await this.handleMcpEndpoint(req, res, method);
      return;
    }

    // Auth status endpoint
    if (pathname === '/api/auth/status' && method === 'GET') {
      const user = await this.authenticateRequest(req);
      let publicUrl: string | undefined;
      const rawPublicUrl = process.env.SSHS3_PUBLIC_URL?.trim();
      if (rawPublicUrl) {
        try {
          const parsed = new URL(rawPublicUrl);
          if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            publicUrl = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
          }
        } catch {
          // Ignore invalid SSHS3_PUBLIC_URL
        }
      }
      sendJson(res, 200, {
        initialized: this.auth.hasAnyUsers(),
        authenticated: Boolean(user),
        user,
        ...(publicUrl ? { publicUrl } : {}),
      });
      return;
    }

    // First-run initial admin setup
    if (pathname === '/api/auth/setup' && method === 'POST') {
      const body = await readJsonBody(req);
      try {
        const { user, sessionToken } = await this.auth.setupInitialAdmin({
          username: String(body.username || ''),
          password: String(body.password || ''),
          displayName: body.displayName ? String(body.displayName) : undefined,
        });
        await this.signIns
          .append({ kind: 'setting', actor: user.username, target: 'server', what: 'set the server up as its first administrator' })
          .catch(() => undefined);
        sendJson(
          res,
          200,
          { user },
          { 'Set-Cookie': buildSessionCookie(sessionToken, undefined, isSecureRequest(req)) },
        );
      } catch (err) {
        sendJson(res, 400, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    // Login
    if (pathname === '/api/auth/login' && method === 'POST') {
      const body = await readJsonBody(req);
      const clientIp = req.socket.remoteAddress || 'local';
      try {
        const { user, sessionToken } = await this.auth.login(
          String(body.username || ''),
          String(body.password || ''),
          clientIp,
        ).catch(async (err: unknown) => {
          // A failed attempt is written down too: a run of them is what an incident looks like.
          await this.signIns
            .append({ kind: 'sign-in', actor: String(body.username || '(no name)').slice(0, 80), what: 'failed to sign in', outcome: 'refused', detail: `from ${clientIp}` })
            .catch(() => undefined);
          throw err;
        });
        await this.signIns
          .append({ kind: 'sign-in', actor: user.username, what: 'signed in', outcome: 'allowed', detail: `from ${clientIp}` })
          .catch(() => undefined);
        sendJson(
          res,
          200,
          { user },
          { 'Set-Cookie': buildSessionCookie(sessionToken, undefined, isSecureRequest(req)) },
        );
      } catch (err) {
        sendJson(res, 401, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    // Redeem invite link/token
    if (pathname === '/api/auth/register-invite' && method === 'POST') {
      const body = await readJsonBody(req);
      try {
        const { user, sessionToken } = await this.auth.redeemInvite({
          inviteToken: String(body.inviteToken || ''),
          username: String(body.username || ''),
          password: String(body.password || ''),
          displayName: body.displayName ? String(body.displayName) : undefined,
        });
        sendJson(
          res,
          200,
          { user },
          { 'Set-Cookie': buildSessionCookie(sessionToken, undefined, isSecureRequest(req)) },
        );
      } catch (err) {
        sendJson(res, 400, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    // Logout
    if (pathname === '/api/auth/logout' && method === 'POST') {
      const token = this.extractSessionToken(req);
      const who = await this.auth.verifySession(token).catch(() => null);
      if (who)
        await this.signIns.append({ kind: 'sign-in', actor: who.username, what: 'signed out' }).catch(() => undefined);
      await this.auth.revokeSession(token);
      sendJson(
        res,
        200,
        { ok: true },
        { 'Set-Cookie': buildSessionCookie('', 0, isSecureRequest(req)) },
      );
      return;
    }

    // Protected endpoints require authentication
    if (pathname.startsWith('/api/')) {
      const user = await this.authenticateRequest(req);
      if (!user) {
        sendJson(res, 401, { error: 'Not signed in' });
        return;
      }

      // Single-use short-lived WebSocket upgrade ticket exchange (replaces ?token= session leakage)
      if (pathname === '/api/ws-ticket' && method === 'POST') {
        if (
          req.headers.origin !== undefined &&
          !isAllowedWsOrigin(req.headers.origin, req.headers.host, this.getAllowedOrigins())
        ) {
          sendJson(res, 403, { error: 'Origin not allowed' });
          return;
        }
        const issued = this.issueWsTicket(user.id, req.headers.origin);
        sendJson(res, 200, issued);
        return;
      }

      if (pathname === '/api/mcp-keys' || pathname.startsWith('/api/mcp-keys/')) {
        await this.handleMcpKeys(req, res, user, method, pathname);
        return;
      }

      // Per-user SSH key management on the VM
      if (pathname === '/api/user/ssh-key' && method === 'POST') {
        const body = await readJsonBody(req);
        try {
          if (body.action === 'rotate' || body.rotate) {
            const rotated = await this.auth.ensureUserSshKey(
              user.id,
              user.username,
              true,
            );
            sendJson(res, 200, { ...rotated, sshPublicKey: rotated.publicKey });
            return;
          }
          if (body.action === 'import' || body.privateKey || body.privateKeyPem) {
            const imported = await this.auth.importUserSshKey(
              user.id,
              String(body.privateKeyPem || body.privateKey || ''),
              body.publicKeyLine ? String(body.publicKeyLine) : undefined,
            );
            sendJson(res, 200, { ...imported, sshPublicKey: imported.publicKey });
            return;
          }
          sendJson(res, 400, { error: 'Unknown action' });
        } catch (err) {
          sendJson(res, 400, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }

      if (pathname === '/api/user/password' && method === 'POST') {
        const body = await readJsonBody(req);
        try {
          await this.auth.changePassword(
            user.id,
            String(body.currentPassword || ''),
            String(body.newPassword || ''),
            // This sign-in stays; every other one of this user ends.
            this.extractSessionToken(req),
          );
          sendJson(res, 200, { ok: true });
        } catch (err) {
          sendJson(res, 400, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }

      // Admin endpoints
      if (pathname.startsWith('/api/admin/')) {
        if (user.role !== 'admin') {
          sendJson(res, 403, { error: 'Only an administrator can do this' });
          return;
        }

        if (pathname === '/api/admin/users' && method === 'GET') {
          const users = await this.auth.listUsers();
          const invites = this.auth.listInvites();
          sendJson(res, 200, { users, invites });
          return;
        }

        if (pathname === '/api/admin/invites' && method === 'GET') {
          const invites = this.auth.listInvites();
          sendJson(res, 200, { invites });
          return;
        }

        if (pathname === '/api/admin/users' && method === 'POST') {
          const body = await readJsonBody(req);
          try {
            const created = await this.auth.createUserByAdmin({
              username: String(body.username || ''),
              password: String(body.password || ''),
              displayName: body.displayName ? String(body.displayName) : undefined,
              role: body.role === 'admin' ? 'admin' : 'member',
            });
            await this.signIns
              .append({ kind: 'setting', actor: user.username, target: 'server', what: `added the account ${created.username} (${created.role})` })
              .catch(() => undefined);
            sendJson(res, 200, { user: created });
          } catch (err) {
            sendJson(res, 400, {
              error: err instanceof Error ? err.message : String(err),
            });
          }
          return;
        }

        if (
          (pathname === '/api/admin/users' || pathname.startsWith('/api/admin/users/')) &&
          method === 'DELETE'
        ) {
          const pathUserId = pathname.startsWith('/api/admin/users/')
            ? decodeURIComponent(pathname.slice('/api/admin/users/'.length))
            : '';
          const body = pathUserId ? {} : await readJsonBody(req);
          const targetUserId = String(pathUserId || body.userId || '');
          try {
            await this.auth.deleteUserByAdmin(targetUserId, user.id);
            await this.signIns
              .append({ kind: 'setting', actor: user.username, target: 'server', what: `removed the account ${targetUserId}` })
              .catch(() => undefined);
            await this.tenants.disposeTenant(targetUserId);
            await this.mcpTokens.forgetUser(targetUserId);
            sendJson(res, 200, { ok: true });
          } catch (err) {
            sendJson(res, 400, {
              error: err instanceof Error ? err.message : String(err),
            });
          }
          return;
        }

        if (pathname === '/api/admin/invites' && method === 'POST') {
          const body = await readJsonBody(req);
          const invite = await this.auth.createInvite({
            createdBy: user.username,
            role: body.role === 'admin' ? 'admin' : 'member',
            note: body.note ? String(body.note) : undefined,
            maxUses: body.maxUses ? Number(body.maxUses) : 10,
          });
          sendJson(res, 200, { invite });
          return;
        }

        if (
          (pathname === '/api/admin/invites' || pathname.startsWith('/api/admin/invites/')) &&
          method === 'DELETE'
        ) {
          const pathToken = pathname.startsWith('/api/admin/invites/')
            ? decodeURIComponent(pathname.slice('/api/admin/invites/'.length))
            : '';
          const body = pathToken ? {} : await readJsonBody(req);
          const token = String(
            pathToken || body.token || '',
          );
          await this.auth.revokeInvite(token);
          sendJson(res, 200, { ok: true, invites: this.auth.listInvites() });
          return;
        }
      }

      sendJson(res, 404, { error: 'No such endpoint' });
      return;
    }

    // Serve static frontend files from dist/
    const staticDir =
      this.options.staticDir || path.resolve(process.cwd(), 'dist');
    const relPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    let candidate = path.resolve(staticDir, relPath);
    if (!candidate.startsWith(path.resolve(staticDir))) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    if (!fs.existsSync(candidate) || fs.statSync(candidate).isDirectory()) {
      candidate = path.resolve(staticDir, 'index.html');
    }

    if (!fs.existsSync(candidate)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('sshs3 web build not found. Run npm run build:web first.');
      return;
    }

    const ext = path.extname(candidate).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const content = await fsp.readFile(candidate);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': String(content.length),
    });
    res.end(content);
  }

  private async handleWsUpgrade(
    req: http.IncomingMessage,
    socket: Duplex,
    _head: Buffer,
  ): Promise<void> {
    // Node's HTTP server lets go of an upgraded socket's errors: from here on an 'error' with no listener
    // (a client that gives up and resets while sign-in or its workspace is still being set up) would end
    // the whole server. The connection is one person's: it is closed and nothing else.
    socket.on('error', (err: NodeJS.ErrnoException) => {
      log.debug(`WebSocket connection error (${err.code ?? err.message})`);
      socket.destroy();
    });
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== '/api/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    // CSWSH protection: strict hostname + port verification on Origin / Host
    if (!isAllowedWsOrigin(req.headers.origin, req.headers.host, this.getAllowedOrigins())) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    // Reject ?token= query-string session auth to eliminate URL/log token leakage
    if (url.searchParams.has('token')) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    let user: WebUserPublic | null = null;
    if (url.searchParams.has('ticket')) {
      const ticketUserId = this.consumeWsTicket(
        url.searchParams.get('ticket') || '',
        req.headers.origin,
      );
      if (ticketUserId) {
        user = await this.auth.getUserById(ticketUserId);
      }
    } else {
      user = await this.authenticateRequest(req);
    }

    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const wsKey = req.headers['sec-websocket-key'];
    if (!wsKey || typeof wsKey !== 'string') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    const acceptKey = crypto
      .createHash('sha1')
      .update(wsKey + WS_MAGIC_GUID)
      .digest('base64');

    const tenant = await this.tenants.getOrCreateTenant(user);
    // Gone while it was signed in and its workspace was set up: there is nobody to answer, and a client
    // added now would never be removed (its 'close' has already been).
    if (socket.destroyed) return;
    const highWaterBytes = Math.max(1024, this.options.wsHighWaterBytes ?? 256 * 1024);
    const maxBufferedBytes = Math.max(
      highWaterBytes * 2,
      this.options.wsMaxBufferedBytes ?? MAX_WS_MESSAGE_BYTES,
    );

    const entry: WsConnectionEntry = {
      socket,
      userId: user.id,
      clientId: 0,
      isAlive: true,
      awaitingPong: false,
      pingSentAt: 0,
      backpressureEvents: 0,
      droppedStreamFrames: 0,
    };

    // How frames go out to a client that may read slowly: see wsSender.ts.
    const sender = createWsSender(
      socket,
      { highWaterBytes, maxBufferedBytes, maxQueuedResponseBytes: maxBufferedBytes + MAX_WS_MESSAGE_BYTES },
      entry,
      { encode: encodeWsTextFrame, droppable: isDroppableStreamFrame, reap: () => this.reapWsEntry(entry) },
    );
    const sendFrame = sender.send;

    const clientId = tenant.registerClient(socket, (payload) => sendFrame(payload));
    entry.clientId = clientId;
    this.activeSockets.add(socket);
    this.activeWsEntries.set(socket, entry);

    const markAlive = () => {
      entry.isAlive = true;
      entry.awaitingPong = false;
      if (entry.pongTimer) {
        clearTimeout(entry.pongTimer);
        entry.pongTimer = undefined;
      }
    };

    attachWsFrameParser(
      socket,
      (rawText) => {
        markAlive();
        void (async () => {
          let parsed: {
            id?: string;
            type?: string;
            channel?: string;
            args?: unknown[];
            sessionId?: string;
            ts?: number;
          };
          try {
            parsed = JSON.parse(rawText);
          } catch {
            return;
          }
          if (parsed.type === 'ping') {
            sendFrame(JSON.stringify({ type: 'pong', ts: parsed.ts ?? Date.now() }));
            return;
          }
          if (parsed.type === 'pong') {
            return;
          }
          if (parsed.type === 'subscribe' && typeof parsed.sessionId === 'string') {
            tenant.subscribeSession(clientId, parsed.sessionId);
            return;
          }
          if (parsed.type === 'unsubscribe' && typeof parsed.sessionId === 'string') {
            tenant.unsubscribeSession(clientId, parsed.sessionId);
            return;
          }
          if (parsed.type === 'invoke' && parsed.id && parsed.channel) {
            try {
              const result = await tenant.invokeFromClient(
                clientId,
                parsed.channel,
                ...(Array.isArray(parsed.args) ? parsed.args : []),
              );
              sendFrame(
                JSON.stringify({
                  id: parsed.id,
                  type: 'response',
                  ok: true,
                  result,
                }),
                'response',
              );
            } catch (err) {
              sendFrame(
                JSON.stringify({
                  id: parsed.id,
                  type: 'response',
                  ok: false,
                  error: err instanceof Error ? err.message : String(err),
                }),
                'response',
              );
            }
          }
        })();
      },
      () => {
        if (entry.pongTimer) {
          clearTimeout(entry.pongTimer);
          entry.pongTimer = undefined;
        }
        sender.clear();
        tenant.unregisterClient(clientId);
        this.activeSockets.delete(socket);
        this.activeWsEntries.delete(socket);
      },
      {
        onPong: markAlive,
        onActivity: markAlive,
      },
    );

    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey}`,
        '',
        '',
      ].join('\r\n'),
    );
  }
}
