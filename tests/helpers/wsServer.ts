import crypto from 'node:crypto';
import type http from 'node:http';
import type { Duplex } from 'node:stream';

/**
 * The server side of a WebSocket, written on the raw upgrade so tests can see every frame the client
 * sends and send frames no real server library would (split, masked, too large). Used by the stand-ins
 * for Slack and Mattermost, and by the client's own tests.
 */

export interface ReceivedFrame {
  fin: boolean;
  opcode: number;
  masked: boolean;
  payload: Buffer;
}

export interface ServerSocket {
  /** The upgrade request: its path and headers. */
  request: http.IncomingMessage;
  frames: ReceivedFrame[];
  /** Text messages the client sent, joined when split. */
  messages: string[];
  send(text: string): void;
  frame(opcode: number, payload: Buffer | string, options?: { fin?: boolean; mask?: boolean; length?: number }): void;
  raw(bytes: Buffer): void;
  ping(payload?: string): void;
  close(code?: number, reason?: string): void;
  /** Ends the connection without a close frame. */
  drop(): void;
  /** Stops reading what the client sends, and starts again: a server that does not keep up. */
  pause(): void;
  resume(): void;
  onMessage(listener: (text: string) => void): void;
  closed: Promise<void>;
  isClosed(): boolean;
}

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function serverFrame(opcode: number, payload: Buffer, options: { fin?: boolean; mask?: boolean; length?: number } = {}): Buffer {
  const fin = options.fin ?? true;
  const length = options.length ?? payload.length;
  const head = length < 126 ? 2 : length < 65536 ? 4 : 10;
  const mask = options.mask ? crypto.randomBytes(4) : undefined;
  const out = Buffer.alloc(head + (mask ? 4 : 0) + payload.length);
  out[0] = (fin ? 0x80 : 0) | opcode;
  const maskBit = mask ? 0x80 : 0;
  if (length < 126) out[1] = maskBit | length;
  else if (length < 65536) {
    out[1] = maskBit | 126;
    out.writeUInt16BE(length, 2);
  } else {
    out[1] = maskBit | 127;
    out.writeBigUInt64BE(BigInt(length), 2);
  }
  if (mask) mask.copy(out, head);
  const start = head + (mask ? 4 : 0);
  for (let i = 0; i < payload.length; i++) out[start + i] = mask ? payload[i] ^ mask[i & 3] : payload[i];
  return out;
}

/** Answers an upgrade request and returns the socket, or refuses it with `status`. */
export function acceptUpgrade(
  request: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  options: { status?: number; headers?: Record<string, string>; badAccept?: boolean; noPong?: boolean } = {},
): ServerSocket | undefined {
  if (options.status && options.status !== 101) {
    const extra = Object.entries(options.headers ?? {})
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join('');
    socket.end(`HTTP/1.1 ${options.status} No\r\n${extra}Content-Length: 0\r\nConnection: close\r\n\r\n`);
    return undefined;
  }
  const key = String(request.headers['sec-websocket-key'] ?? '');
  const accept = options.badAccept ? 'wrong' : crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n` +
      Object.entries(options.headers ?? {})
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join('') +
      '\r\n',
  );
  const frames: ReceivedFrame[] = [];
  const messages: string[] = [];
  const listeners = new Set<(text: string) => void>();
  let buffer: Buffer = head.length ? Buffer.from(head) : Buffer.alloc(0);
  let parts: Buffer[] = [];
  let closed = false;
  let closeSent = false;
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((r) => (resolveClosed = r));
  const write = (bytes: Buffer): void => {
    if (!socket.destroyed && socket.writable) socket.write(bytes);
  };
  const parse = (): void => {
    for (;;) {
      if (buffer.length < 2) return;
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskAt = offset;
      if (masked) offset += 4;
      if (buffer.length < offset + length) return;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= buffer[maskAt + (i & 3)];
      buffer = buffer.subarray(offset + length);
      frames.push({ fin, opcode, masked, payload });
      if (opcode === 0x8) {
        if (!closeSent) {
          closeSent = true;
          write(serverFrame(0x8, payload.subarray(0, 2)));
        }
        socket.end();
        continue;
      }
      if (opcode === 0x9) {
        if (!options.noPong) write(serverFrame(0xa, payload));
        continue;
      }
      if (opcode === 0xa) continue;
      parts.push(payload);
      if (fin) {
        const text = Buffer.concat(parts).toString('utf8');
        parts = [];
        messages.push(text);
        for (const l of listeners) l(text);
      }
    }
  };
  socket.on('data', (chunk: Buffer) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    parse();
  });
  socket.on('error', () => undefined);
  // An upgraded socket of an http server stays half open when the client ends it: ended here too.
  socket.on('end', () => socket.end());
  socket.on('close', () => {
    closed = true;
    resolveClosed();
  });
  if (buffer.length) setImmediate(parse);
  return {
    request,
    frames,
    messages,
    send: (text) => write(serverFrame(0x1, Buffer.from(text, 'utf8'))),
    frame: (opcode, payload, o) => write(serverFrame(opcode, Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8'), o)),
    raw: (bytes) => write(bytes),
    ping: (payload = '') => write(serverFrame(0x9, Buffer.from(payload, 'utf8'))),
    close: (code = 1000, reason = '') => {
      if (closeSent) return;
      closeSent = true;
      const why = Buffer.from(reason, 'utf8');
      const body = Buffer.alloc(2 + why.length);
      body.writeUInt16BE(code, 0);
      why.copy(body, 2);
      write(serverFrame(0x8, body));
    },
    drop: () => socket.destroy(),
    pause: () => void socket.pause(),
    resume: () => void socket.resume(),
    onMessage: (listener) => void listeners.add(listener),
    closed: closedPromise,
    isClosed: () => closed,
  };
}

/** Waits until `check` is true, a little at a time. */
export async function until(check: () => boolean | Promise<boolean>, timeoutMs = 3000, what = 'the condition'): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
