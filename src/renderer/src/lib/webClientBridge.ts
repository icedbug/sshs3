import { createMultiSSHApi, type IpcRendererTransport } from '../../../shared/ipc/createMultiSSHApi';

type EventListener = (_event: any, ...args: any[]) => void;

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timer: ReturnType<typeof setTimeout>;
}

const LEGACY_SESSION_TOKEN_STORAGE_KEY = 'sshs3_web_session_token';
const MAX_CLIENT_BUFFERED_BYTES = 1024 * 1024; // 1 MiB backpressure watermark
const MAX_SEND_QUEUE_LENGTH = 500;
const DEFAULT_RECONNECT_BASE_MS = 500;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
export const CONNECTION_LOST_MESSAGE = 'The connection to the server was lost';

/** Channels whose reply names a session this client now shows (its output must keep reaching it). */
const SESSION_OPENING_CHANNELS = new Set(['terminal:create', 'k8s-terminal:create', 'k8s-log:start']);
/** Channels whose first argument is a session this client stops showing. */
const SESSION_CLOSING_CHANNELS = new Set(['terminal:kill', 'k8s-terminal:kill', 'k8s-log:stop']);

/**
 * Computes jittered exponential reconnect delay (equal jitter in [cap/2, cap]).
 */
export function computeReconnectDelayMs(
  attempt: number,
  options: { baseMs?: number; maxMs?: number; random?: () => number } = {},
): number {
  const baseMs = Math.max(50, options.baseMs ?? DEFAULT_RECONNECT_BASE_MS);
  const maxMs = Math.max(baseMs, options.maxMs ?? DEFAULT_RECONNECT_MAX_MS);
  const rand = Math.max(0, Math.min(1, (options.random ?? Math.random)()));
  const exp = Math.min(maxMs, baseMs * Math.pow(2, Math.max(0, Math.floor(attempt))));
  return Math.max(50, Math.round(exp * 0.5 + rand * exp * 0.5));
}

function clearLegacyStoredToken(): void {
  try {
    window.localStorage.removeItem(LEGACY_SESSION_TOKEN_STORAGE_KEY);
  } catch {
    // ignore storage errors
  }
}

/**
 * Legacy API preserved for WebAuthGate compatibility.
 * Session tokens are stored exclusively in HttpOnly cookies, never in Web Storage.
 */
export function getStoredWebSessionToken(): string | null {
  clearLegacyStoredToken();
  return null;
}

/**
 * Legacy API preserved for WebAuthGate compatibility.
 * Purges any legacy localStorage token and never persists session tokens in JS storage.
 */
export function setStoredWebSessionToken(_token: string | null): void {
  clearLegacyStoredToken();
}

export class BrowserWebSocketIpcTransport implements IpcRendererTransport {
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<EventListener>>();
  private pending = new Map<string, PendingRequest>();
  /** Packets waiting for the socket; `id` marks a request, so a failed one is never sent later. */
  private sendQueue: Array<{ packet: string; id?: string }> = [];
  private nextId = 1;
  private shouldReconnect = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private connectGeneration = 0;
  private explicitToken: string | null = null;
  private subscribedSessions = new Set<string>();
  private connectionStateListeners = new Set<(connected: boolean) => void>();

  public connect(explicitToken?: string | null): void {
    if (explicitToken !== undefined) {
      this.explicitToken = explicitToken || null;
    }
    this.shouldReconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    const generation = ++this.connectGeneration;
    void this.openWithTicket(generation);
  }

  private async openWithTicket(generation: number): Promise<void> {
    let ticket: string;
    try {
      const headers: Record<string, string> = {};
      if (this.explicitToken) {
        headers['Authorization'] = `Bearer ${this.explicitToken}`;
      }
      const res = await fetch('/api/ws-ticket', {
        method: 'POST',
        credentials: 'same-origin',
        headers,
      });

      if (generation !== this.connectGeneration || !this.shouldReconnect) {
        return;
      }

      if (res.status === 401 || res.status === 403) {
        this.shouldReconnect = false;
        this.notifyConnectionState(false);
        this.rejectAllPending(new Error('WebSocket authentication expired'));
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
          try {
            window.dispatchEvent(new CustomEvent('sshs3:web-auth-expired'));
          } catch {
            // ignore
          }
        }
        return;
      }

      if (!res.ok) {
        throw new Error(`Ticket exchange failed (${res.status})`);
      }

      const data = (await res.json()) as { ticket?: string };
      if (!data?.ticket || typeof data.ticket !== 'string') {
        throw new Error('Ticket exchange response missing ticket');
      }
      ticket = data.ticket;
    } catch (err) {
      if (generation === this.connectGeneration && this.shouldReconnect) {
        this.scheduleReconnect();
      } else {
        console.error('[WebClientBridge] WS ticket exchange failed:', err);
      }
      return;
    }

    if (generation !== this.connectGeneration || !this.shouldReconnect) {
      return;
    }

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${window.location.host}/api/ws?ticket=${encodeURIComponent(ticket)}`;

    try {
      const socket = new WebSocket(wsUrl);
      this.ws = socket;

      socket.onopen = () => {
        if (this.ws !== socket) return;
        this.reconnectAttempt = 0;
        this.notifyConnectionState(true);
        for (const sid of this.subscribedSessions) {
          this.enqueueOrSend(JSON.stringify({ type: 'subscribe', sessionId: sid }));
        }
        this.flushSendQueue();
      };

      socket.onmessage = (ev) => {
        try {
          let rawText: string;
          if (typeof ev.data === 'string') {
            rawText = ev.data;
          } else if (ev.data instanceof ArrayBuffer) {
            rawText = new TextDecoder().decode(new Uint8Array(ev.data));
          } else if (ArrayBuffer.isView(ev.data)) {
            rawText = new TextDecoder().decode(ev.data);
          } else {
            rawText = String(ev.data);
          }

          const msg = JSON.parse(rawText);
          this.handleIncomingMessage(socket, msg);
        } catch (err) {
          console.error('[WebClientBridge] Failed to parse message:', err);
        }
      };

      socket.onclose = (ev?: { code?: number; reason?: string }) => {
        if (this.ws === socket) {
          this.ws = null;
        }
        this.notifyConnectionState(false);
        // What was waiting for an answer fails now with a clear message, instead of hanging until the
        // timeout: the server cannot answer a request over a connection that is gone.
        const reason = ev?.code === 1012 && ev.reason ? ` (${ev.reason})` : '';
        this.rejectAllPending(new Error(`${CONNECTION_LOST_MESSAGE}${reason}`));
        if (this.shouldReconnect && generation === this.connectGeneration) {
          this.scheduleReconnect();
        }
      };

      socket.onerror = () => {
        // onclose handles reconnect scheduling
      };
    } catch (err) {
      console.error('[WebClientBridge] WebSocket creation failed:', err);
      if (this.shouldReconnect && generation === this.connectGeneration) {
        this.scheduleReconnect();
      }
    }
  }

  private handleIncomingMessage(socket: WebSocket, msg: any): void {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'ping') {
      if (socket.readyState === WebSocket.OPEN) {
        this.enqueueOrSend(JSON.stringify({ type: 'pong', ts: msg.ts ?? Date.now() }));
      }
      return;
    }

    if (msg.type === 'pong') {
      return;
    }

    if (msg.type === 'response' && msg.id) {
      const req = this.pending.get(msg.id);
      if (req) {
        clearTimeout(req.timer);
        this.pending.delete(msg.id);
        if (msg.ok) {
          req.resolve(msg.result);
        } else {
          req.reject(new Error(msg.error || 'Web IPC request failed'));
        }
      }
      return;
    }

    if ((msg.type === 'event' || msg.type === 'delta') && msg.channel) {
      this.dispatchEvent(msg.channel, Array.isArray(msg.args) ? msg.args : []);
      return;
    }

    if (msg.type === 'batch' && Array.isArray(msg.events)) {
      for (const ev of msg.events) {
        if (ev && typeof ev.channel === 'string') {
          this.dispatchEvent(ev.channel, Array.isArray(ev.args) ? ev.args : []);
        }
      }
    }
  }

  private dispatchEvent(channel: string, args: any[]): void {
    const set = this.listeners.get(channel);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try {
        fn({}, ...args);
      } catch (err) {
        console.error(`[WebClientBridge] Listener error on ${channel}:`, err);
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    const delay = computeReconnectDelayMs(this.reconnectAttempt++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldReconnect) {
        this.connect();
      }
    }, delay);
  }

  private rejectAllPending(err: Error): void {
    for (const [, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(err);
    }
    this.pending.clear();
    // A request its caller was told failed must not run later, after a reconnect.
    this.sendQueue = this.sendQueue.filter((entry) => entry.id === undefined);
  }

  private enqueueOrSend(packet: string, isTelemetry = false, id?: string): void {
    if (
      this.ws &&
      this.ws.readyState === WebSocket.OPEN &&
      this.sendQueue.length === 0 &&
      (this.ws.bufferedAmount ?? 0) <= MAX_CLIENT_BUFFERED_BYTES
    ) {
      this.ws.send(packet);
      return;
    }

    if (isTelemetry && this.sendQueue.length >= MAX_SEND_QUEUE_LENGTH / 2) {
      return;
    }

    if (this.sendQueue.length >= MAX_SEND_QUEUE_LENGTH) {
      // Evict oldest packet to bound client memory under prolonged disconnect/backpressure
      const evicted = this.sendQueue.shift();
      const req = evicted?.id !== undefined ? this.pending.get(evicted.id) : undefined;
      if (req && evicted?.id !== undefined) {
        clearTimeout(req.timer);
        this.pending.delete(evicted.id);
        req.reject(new Error('Too many requests are waiting for the server; this one was not sent'));
      }
    }
    this.sendQueue.push(id === undefined ? { packet } : { packet, id });
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.drainTimer) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.flushSendQueue();
    }, 40);
  }

  private flushSendQueue(): void {
    while (
      this.sendQueue.length > 0 &&
      this.ws &&
      this.ws.readyState === WebSocket.OPEN
    ) {
      if ((this.ws.bufferedAmount ?? 0) > MAX_CLIENT_BUFFERED_BYTES) {
        this.scheduleDrain();
        return;
      }
      const { packet } = this.sendQueue.shift()!;
      this.ws.send(packet);
    }
  }

  public subscribeSession(sessionId: string): void {
    if (!sessionId) return;
    this.subscribedSessions.add(sessionId);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.enqueueOrSend(JSON.stringify({ type: 'subscribe', sessionId }));
    }
  }

  public unsubscribeSession(sessionId: string): void {
    if (!sessionId) return;
    this.subscribedSessions.delete(sessionId);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.enqueueOrSend(JSON.stringify({ type: 'unsubscribe', sessionId }));
    }
  }

  public disconnect(): void {
    this.shouldReconnect = false;
    this.connectGeneration++;
    this.reconnectAttempt = 0;
    this.explicitToken = null;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.sendQueue = [];
    this.subscribedSessions.clear();
    this.rejectAllPending(new Error('Disconnected from web server'));
    this.notifyConnectionState(false);
  }

  public onConnectionStateChange(cb: (connected: boolean) => void): () => void {
    this.connectionStateListeners.add(cb);
    cb(Boolean(this.ws && this.ws.readyState === WebSocket.OPEN));
    return () => {
      this.connectionStateListeners.delete(cb);
    };
  }

  private notifyConnectionState(connected: boolean): void {
    for (const cb of this.connectionStateListeners) {
      try {
        cb(connected);
      } catch {
        // ignore
      }
    }
  }

  public invoke(channel: string, ...args: any[]): Promise<any> {
    if (channel === 'log:write' && (!this.ws || this.ws.readyState !== WebSocket.OPEN)) {
      return Promise.resolve();
    }
    if (
      channel === 'log:write' &&
      this.ws &&
      (this.ws.bufferedAmount ?? 0) > MAX_CLIENT_BUFFERED_BYTES
    ) {
      return Promise.resolve();
    }

    const request = new Promise<any>((resolve, reject) => {
      const id = `req_${this.nextId++}_${Date.now()}`;
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          this.sendQueue = this.sendQueue.filter((entry) => entry.id !== id);
          reject(new Error(`Timeout waiting for IPC channel: ${channel}`));
        }
      }, 60_000);

      this.pending.set(id, { resolve, reject, timer });
      const packet = JSON.stringify({
        type: 'invoke',
        id,
        channel,
        args,
      });

      this.enqueueOrSend(packet, channel === 'log:write', id);
      if (!this.ws && this.shouldReconnect && !this.reconnectTimer) {
        this.connect();
      }
    });
    if (SESSION_CLOSING_CHANNELS.has(channel) && typeof args[0] === 'string') {
      this.unsubscribeSession(args[0]);
    } else if (SESSION_OPENING_CHANNELS.has(channel) || channel === 'terminal:attach') {
      // The server routes a session's output to the connection that opened it; a new connection (after
      // a reconnect) has to say again which sessions it shows, so they are remembered here.
      void request.then(
        (result) => {
          const sid =
            channel === 'terminal:attach' ? args[0] : (result as { sessionId?: unknown } | null)?.sessionId;
          if (typeof sid === 'string' && sid) this.subscribeSession(sid);
        },
        () => {},
      );
    }
    return request;
  }

  public on(channel: string, listener: EventListener): void {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(listener);
  }

  public removeListener(channel: string, listener: EventListener): void {
    const set = this.listeners.get(channel);
    if (set) {
      set.delete(listener);
    }
  }
}

let singletonTransport: BrowserWebSocketIpcTransport | null = null;
let isNativeElectronMode: boolean | null = null;

export function isWebBrowserMode(): boolean {
  if (typeof window === 'undefined') return false;
  if ((window as any).__SSHS3_WEB_MODE__ === true) return true;
  if (isNativeElectronMode !== null) {
    return !isNativeElectronMode;
  }
  if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent || '')) {
    return false;
  }
  isNativeElectronMode = Boolean((window as any).multissh && !(window as any).__SSHS3_WEB_MODE__);
  return !isNativeElectronMode;
}

export function ensureWebClientBridgeInstalled(): BrowserWebSocketIpcTransport | null {
  if (!isWebBrowserMode()) {
    return null;
  }
  if (!singletonTransport) {
    singletonTransport = new BrowserWebSocketIpcTransport();
    const api = createMultiSSHApi(singletonTransport);
    (window as any).__SSHS3_WEB_MODE__ = true;
    (window as any).multissh = api;
    (window as any).sshs3 = api;
  }
  return singletonTransport;
}

export function connectWebClientBridge(token?: string | null): void {
  const transport = ensureWebClientBridgeInstalled();
  if (transport) {
    transport.connect(token);
  }
}

export function disconnectWebClientBridge(): void {
  if (singletonTransport) {
    singletonTransport.disconnect();
  }
}

export function onWebConnectionStateChange(cb: (connected: boolean) => void): () => void {
  const transport = ensureWebClientBridgeInstalled();
  if (!transport) {
    cb(true);
    return () => {};
  }
  return transport.onConnectionStateChange(cb);
}
