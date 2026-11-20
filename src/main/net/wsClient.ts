import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { Duplex } from "node:stream";
import { guardUrl, pinnedLookup, type GuardOptions } from "../ai/hub/Notifier";

/**
 * A small WebSocket client (RFC 6455) for the agent bot's sockets to Slack and Mattermost.
 *
 * Node has a WebSocket of its own, but it looks the host name up itself: the address guardUrl
 * checked could not be the address it connects to. So the upgrade goes through the same pinned
 * request every other call of the hub uses, and only text messages are spoken: that is all the two
 * services send. No extensions are asked for, so frames are never compressed.
 */

export interface WsOptions {
  /** Sent with the upgrade request, such as Authorization. */
  headers?: Record<string, string>;
  /** The same rules as every other address sshs3 calls. */
  guard: GuardOptions;
  /** A message larger than this closes the socket. One megabyte unless said. */
  maxMessageBytes?: number;
  /** How long the upgrade may take. */
  timeoutMs?: number;
  /**
   * With nothing heard for this long a ping is sent, and with nothing heard for twice as long the
   * connection counts as gone. A socket dropped by a router in between says nothing, so this is
   * how it is found out. Zero turns it off.
   */
  pingEveryMs?: number;
}

/** Opens a socket. The default is connectWs; tests give their own. */
export type WsConnector = (url: string, options: WsOptions) => WsClient;

export interface WsClose {
  /** 1000 for a normal close, 1006 when the connection ended without a close frame. */
  code: number;
  reason: string;
  /** What ended it, when something went wrong: a WsError says what the server answered and when to come back. */
  error?: Error;
}

/** Why opening failed, with what the server said when it answered with something else than a socket. */
export class WsError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "WsError";
  }
}

interface WsEvents {
  open: () => void;
  message: (text: string) => void;
  close: (info: WsClose) => void;
  error: (error: Error) => void;
}

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const DEFAULT_MAX_MESSAGE = 1024 * 1024;
const CLOSE_WAIT_MS = 5000;
/** Slack and Mattermost split a message in a few frames at most. Empty frames carry no bytes, so they are counted. */
const MAX_FRAMES_PER_MESSAGE = 1024;
/** The close codes a server may send (RFC 6455 7.4, and the three IANA added since). Anything else is a broken close. */
const validCloseCode = (code: number): boolean => (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) || (code >= 3000 && code <= 4999);

/** The value a server must answer the key with. */
export function acceptFor(key: string): string {
  return crypto.createHash("sha1").update(key + GUID).digest("base64");
}

/** One frame from the client: always masked, as the protocol requires of a client. */
export function clientFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const mask = crypto.randomBytes(4);
  const length = payload.length;
  const head = length < 126 ? 2 : length < 65536 ? 4 : 10;
  const frame = Buffer.alloc(head + 4 + length);
  frame[0] = (fin ? 0x80 : 0) | opcode;
  if (length < 126) frame[1] = 0x80 | length;
  else if (length < 65536) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(length, 2);
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(length), 2);
  }
  mask.copy(frame, head);
  for (let i = 0; i < length; i++) frame[head + 4 + i] = payload[i] ^ mask[i & 3];
  return frame;
}

const retryAfterMs = (value: string | string[] | undefined): number | undefined => {
  const seconds = Number(Array.isArray(value) ? value[0] : value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 600) * 1000 : undefined;
};

/**
 * One socket. Made by connectWs, which returns at once: `ready` settles when the upgrade is done or
 * has failed, and the events say what happens after. An error is always followed by a close, so a
 * caller that only listens for close learns of every end.
 */
export class WsClient {
  readonly ready: Promise<void>;
  private state: "connecting" | "open" | "closing" | "closed" = "connecting";
  private socket?: Duplex;
  private request?: http.ClientRequest;
  /**
   * What came in and is not read yet, as it came. The chunks are joined once, when a whole frame is
   * there: joining on every chunk would copy a large frame again for each small piece of it.
   */
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private fragmentFrames = 0;
  /** The kind of the message being joined from frames: text or binary. Nothing when no message is half read. */
  private fragmentKind?: "text" | "binary";
  /** The protocol was broken: nothing more is read. */
  private broken = false;
  /** The server's close frame came: what it sends after is not read. */
  private closeReceived = false;
  /** The newest ping not answered yet. Only the newest is answered, once per read, so pings cannot pile up answers. */
  private pong?: Buffer;
  private readonly listeners: { [K in keyof WsEvents]: Set<WsEvents[K]> } = { open: new Set(), message: new Set(), close: new Set(), error: new Set() };
  private closeTimer?: NodeJS.Timeout;
  private pingTimer?: NodeJS.Timeout;
  private heardAt = Date.now();
  private closeSent = false;
  private closeInfo?: WsClose;
  private settleReady!: (error?: Error) => void;
  private readonly maxMessageBytes: number;
  /** How much may wait to be sent. A server that never reads would otherwise make it grow without end. */
  private readonly maxUnsentBytes: number;

  constructor(
    readonly url: string,
    private readonly options: WsOptions,
  ) {
    this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE;
    this.maxUnsentBytes = Math.max(DEFAULT_MAX_MESSAGE, 2 * this.maxMessageBytes);
    this.ready = new Promise<void>((resolve, reject) => {
      this.settleReady = (error) => (error ? reject(error) : resolve());
    });
    // A caller that only listens for events must not get an unhandled rejection.
    this.ready.catch(() => undefined);
  }

  on<K extends keyof WsEvents>(event: K, listener: WsEvents[K]): () => void {
    this.listeners[event].add(listener);
    return () => this.listeners[event].delete(listener);
  }

  private emit<K extends keyof WsEvents>(event: K, ...args: Parameters<WsEvents[K]>): void {
    for (const listener of [...this.listeners[event]]) {
      try {
        (listener as (...a: Parameters<WsEvents[K]>) => void)(...args);
      } catch {
        // A listener that throws must not break the socket for the others.
      }
    }
  }

  get isOpen(): boolean {
    return this.state === "open";
  }

  /**
   * Starts the upgrade. Called once, by connectWs. It never throws: whatever goes wrong ends in a
   * rejected `ready` and a close, so a caller waiting on either is never left waiting. A header value
   * Node will not send, such as a token with a line break in it, throws while the request is made.
   */
  async start(): Promise<void> {
    try {
      await this.upgrade();
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async upgrade(): Promise<void> {
    const raw = new URL(this.url);
    if (raw.protocol !== "wss:" && raw.protocol !== "ws:") throw new WsError("A socket address starts with wss://.");
    raw.protocol = raw.protocol === "wss:" ? "https:" : "http:";
    const target = await guardUrl(raw.toString(), this.options.guard);
    if (this.state !== "connecting") return;
    const url = target.url;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const key = crypto.randomBytes(16).toString("base64");
    const secure = url.protocol === "https:";
    const options: https.RequestOptions = {
      protocol: url.protocol,
      hostname: host,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: {
        ...this.options.headers,
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": key,
        "Sec-WebSocket-Version": "13",
        "User-Agent": "sshs3",
      },
      timeout: this.options.timeoutMs ?? 15_000,
      // A connection of its own: an upgraded socket is never handed back to a pool.
      agent: false,
      // The address that was checked, not whatever the name resolves to now.
      lookup: pinnedLookup(target),
      // The certificate is checked against the name, also when the address was looked up by us.
      ...(secure && !net.isIP(host) ? { servername: host } : {}),
    };
    const req = (secure ? https : http).request(options);
    this.request = req;
    req.on("timeout", () => req.destroy(new WsError("The socket did not open in time.")));
    req.on("error", (error) => this.fail(error));
    req.on("response", (res) => {
      res.resume();
      const status = res.statusCode ?? 0;
      // Not followed: where a redirect leads was never checked.
      if (status >= 300 && status < 400) return this.fail(new WsError("The server sent the socket elsewhere. Redirects are not followed.", status));
      this.fail(new WsError(`The server answered ${status} instead of opening a socket.`, status, retryAfterMs(res.headers["retry-after"])));
    });
    req.on("upgrade", (res, socket, head) => {
      const upgrade = String(res.headers.upgrade ?? "").toLowerCase();
      const connection = String(res.headers.connection ?? "").toLowerCase();
      if (res.statusCode !== 101 || upgrade !== "websocket" || !connection.split(/\s*,\s*/).includes("upgrade")) {
        socket.destroy();
        return this.fail(new WsError("The server did not open a socket.", res.statusCode));
      }
      if (res.headers["sec-websocket-accept"] !== acceptFor(key)) {
        socket.destroy();
        return this.fail(new WsError("The server answered the socket's key wrongly."));
      }
      // Nothing was asked for, so nothing may be agreed: a frame would not be read right.
      if (res.headers["sec-websocket-extensions"] || res.headers["sec-websocket-protocol"]) {
        socket.destroy();
        return this.fail(new WsError("The server turned on something the socket did not ask for."));
      }
      if (this.state !== "connecting") return void socket.destroy();
      this.opened(socket, head);
    });
    req.end();
  }

  private opened(socket: Duplex, head: Buffer): void {
    this.socket = socket;
    this.state = "open";
    this.heardAt = Date.now();
    if (socket instanceof net.Socket) {
      socket.setTimeout(0);
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 30_000);
    }
    socket.on("data", (chunk: Buffer) => this.received(chunk));
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.ended());
    this.startPing();
    this.settleReady();
    this.emit("open");
    if (head.length) this.received(head);
  }

  private startPing(): void {
    const every = this.options.pingEveryMs ?? 30_000;
    if (!(every > 0)) return;
    this.pingTimer = setInterval(() => {
      const quiet = Date.now() - this.heardAt;
      if (quiet >= every * 2) {
        this.closeInfo ??= { code: 1006, reason: "The connection went quiet." };
        this.socket?.destroy();
      } else if (quiet >= every && this.state === "open") this.write(0x9, Buffer.alloc(0));
    }, Math.max(10, Math.floor(every / 2)));
    this.pingTimer.unref?.();
  }

  /** Sends one text message. */
  send(text: string): void {
    if (this.state !== "open") throw new Error("The socket is not open.");
    this.write(0x1, Buffer.from(text, "utf8"));
  }

  /** Closes the socket: says so to the server, and ends the connection if it does not answer. */
  close(code = 1000, reason = ""): void {
    if (this.state === "connecting") {
      this.closeInfo = { code, reason };
      this.state = "closed";
      this.request?.destroy();
      this.settleReady(new WsError("The socket was closed before it opened."));
      this.finish();
      return;
    }
    if (this.state !== "open") return;
    this.state = "closing";
    this.sendClose(code, reason);
    this.closeTimer = setTimeout(() => this.socket?.destroy(), CLOSE_WAIT_MS);
    this.closeTimer.unref?.();
  }

  private sendClose(code: number, reason: string): void {
    if (this.closeSent) return;
    this.closeSent = true;
    const why = Buffer.from(reason, "utf8").subarray(0, 123);
    const payload = Buffer.alloc(2 + why.length);
    payload.writeUInt16BE(code, 0);
    why.copy(payload, 2);
    this.write(0x8, payload);
  }

  private write(opcode: number, payload: Buffer): void {
    const socket = this.socket;
    if (!socket || socket.destroyed) return;
    if (socket.writableLength > this.maxUnsentBytes) {
      this.closeInfo ??= { code: 1008, reason: "The server does not read what is sent." };
      socket.destroy();
      return;
    }
    socket.write(clientFrame(opcode, payload));
  }

  /** The protocol was broken: says why with a close frame and ends. */
  private refuse(code: number, reason: string): void {
    this.broken = true;
    this.pending = [];
    this.pendingBytes = 0;
    this.fragments = [];
    this.closeInfo ??= { code, reason };
    this.emit("error", new WsError(reason));
    if (this.state === "open") this.state = "closing";
    this.sendClose(code, reason);
    this.socket?.end();
    this.closeTimer ??= setTimeout(() => this.socket?.destroy(), 1000);
    this.closeTimer.unref?.();
  }

  /** The first `count` bytes not read yet, without taking them. Nothing when fewer have come. */
  private peek(count: number): Buffer | undefined {
    if (this.pendingBytes < count) return undefined;
    if (this.pending[0].length >= count) return this.pending[0];
    // At most a frame's head (14 bytes) is ever asked for this way, so this copy is small.
    const out = Buffer.alloc(count);
    let at = 0;
    for (const chunk of this.pending) {
      at += chunk.copy(out, at, 0, Math.min(chunk.length, count - at));
      if (at >= count) break;
    }
    return out;
  }

  /** Takes `count` bytes from the front, joining chunks only when the bytes span more than one. */
  private take(count: number): Buffer {
    this.pendingBytes -= count;
    const first = this.pending[0];
    if (first && first.length >= count) {
      if (first.length === count) this.pending.shift();
      else this.pending[0] = first.subarray(count);
      return first.subarray(0, count);
    }
    const out = Buffer.alloc(count);
    let at = 0;
    while (at < count) {
      const chunk = this.pending[0];
      const used = chunk.copy(out, at, 0, Math.min(chunk.length, count - at));
      at += used;
      if (used === chunk.length) this.pending.shift();
      else this.pending[0] = chunk.subarray(used);
    }
    return out;
  }

  private received(chunk: Buffer): void {
    // After a broken frame or the server's close nothing is read, so nothing is kept either.
    if (this.broken || this.closeReceived || this.state === "closed") return;
    this.heardAt = Date.now();
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;
    this.readFrames();
    this.answerPing();
  }

  private readFrames(): void {
    while ((this.state === "open" || this.state === "closing") && !this.broken && !this.closeReceived) {
      const start = this.peek(2);
      if (!start) return;
      const first = start[0];
      const second = start[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      if (first & 0x70) return this.refuse(1002, "The server used a part of the protocol that was not agreed.");
      if (second & 0x80) return this.refuse(1002, "The server masked a frame, which a server must not.");
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        const head = this.peek(4);
        if (!head) return;
        length = head.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        const head = this.peek(10);
        if (!head) return;
        const big = head.readBigUInt64BE(2);
        if (big > BigInt(this.maxMessageBytes)) return this.refuse(1009, "A message was larger than the socket takes.");
        length = Number(big);
        offset = 10;
      }
      const control = opcode >= 0x8;
      if (control && (!fin || length > 125)) return this.refuse(1002, "The server sent a control frame that was too long or split.");
      if (!control && this.fragmentBytes + length > this.maxMessageBytes) return this.refuse(1009, "A message was larger than the socket takes.");
      if (this.pendingBytes < offset + length) return;
      this.take(offset);
      const payload = this.take(length);
      if (control) this.control(opcode, payload);
      else this.data(opcode, fin, payload);
    }
  }

  private control(opcode: number, payload: Buffer): void {
    if (opcode === 0x9) {
      this.pong = Buffer.from(payload);
      return;
    }
    if (opcode === 0xa) return;
    if (opcode !== 0x8) return this.refuse(1002, "The server sent a frame of an unknown kind.");
    // A code is two bytes or nothing, and only some codes may be sent: the one sent is echoed, so it is checked first.
    const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
    if (payload.length === 1 || (payload.length >= 2 && !validCloseCode(code))) return this.refuse(1002, "The server closed with a code that is not allowed.");
    let reason: string;
    try {
      reason = payload.length > 2 ? new TextDecoder("utf-8", { fatal: true }).decode(payload.subarray(2)) : "";
    } catch {
      return this.refuse(1007, "The server closed with a reason that is not UTF-8.");
    }
    this.closeReceived = true;
    this.closeInfo ??= { code, reason };
    // Answered with the same code, then the server ends the connection; if it does not, it is ended here.
    this.sendClose(code === 1005 ? 1000 : code, "");
    this.state = "closing";
    this.pending = [];
    this.pendingBytes = 0;
    this.socket?.end();
    clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(() => this.socket?.destroy(), 1000);
    this.closeTimer.unref?.();
  }

  /** Answers the newest ping of this read, unless what was sent before is still waiting to go out. */
  private answerPing(): void {
    const pong = this.pong;
    if (!pong || this.state !== "open" || this.socket?.writableNeedDrain) return;
    this.pong = undefined;
    this.write(0xa, pong);
  }

  private data(opcode: number, fin: boolean, payload: Buffer): void {
    if (opcode === 0x0) {
      if (!this.fragmentKind) return this.refuse(1002, "The server continued a message it never started.");
    } else if (opcode === 0x1 || opcode === 0x2) {
      if (this.fragmentKind) return this.refuse(1002, "The server started a message inside another.");
      // The kind of a split message is said by its first frame only.
      this.fragmentKind = opcode === 0x1 ? "text" : "binary";
    } else return this.refuse(1002, "The server sent a frame of an unknown kind.");
    // Empty frames add no bytes, so without a count a server could send them without end.
    if (++this.fragmentFrames > MAX_FRAMES_PER_MESSAGE) return this.refuse(1009, "A message came in too many pieces.");
    if (payload.length) this.fragments.push(Buffer.from(payload));
    this.fragmentBytes += payload.length;
    if (!fin) return;
    const kind = this.fragmentKind;
    const parts = this.fragments;
    this.fragmentKind = undefined;
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentFrames = 0;
    // Slack and Mattermost send text only; anything else is not ours to read.
    if (kind !== "text" || this.state !== "open") return;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts));
    } catch {
      return this.refuse(1007, "The server sent text that is not UTF-8.");
    }
    this.emit("message", text);
  }

  private fail(error: Error): void {
    if (this.state === "closed") return;
    if (this.state === "connecting") {
      this.state = "closed";
      this.closeInfo ??= { code: 1006, reason: error.message, error };
      this.request?.destroy();
      this.settleReady(error);
      this.emit("error", error);
      this.finish();
      return;
    }
    this.closeInfo ??= { code: 1006, reason: error.message, error };
    this.emit("error", error);
    this.socket?.destroy();
  }

  private ended(): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.finish();
  }

  private finish(): void {
    clearInterval(this.pingTimer);
    clearTimeout(this.closeTimer);
    this.emit("close", this.closeInfo ?? { code: 1006, reason: "The connection ended." });
    for (const set of Object.values(this.listeners)) set.clear();
  }
}

/** Opens a socket to a wss:// (or ws://) address after the address is checked. */
export function connectWs(url: string, options: WsOptions): WsClient {
  const client = new WsClient(url, options);
  void client.start();
  return client;
}
