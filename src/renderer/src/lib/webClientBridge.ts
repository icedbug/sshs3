import { createMultiSSHApi, type IpcRendererTransport } from '../../../shared/ipc/createMultiSSHApi';

type EventListener = (_event: any, ...args: any[]) => void;

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timer: ReturnType<typeof setTimeout>;
}

const SESSION_TOKEN_STORAGE_KEY = 'sshs3_web_session_token';

export function getStoredWebSessionToken(): string | null {
  try {
    return window.localStorage.getItem(SESSION_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setStoredWebSessionToken(token: string | null): void {
  try {
    if (token) {
      window.localStorage.setItem(SESSION_TOKEN_STORAGE_KEY, token);
    } else {
      window.localStorage.removeItem(SESSION_TOKEN_STORAGE_KEY);
    }
  } catch {
    // ignore storage errors
  }
}

class BrowserWebSocketIpcTransport implements IpcRendererTransport {
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<EventListener>>();
  private pending = new Map<string, PendingRequest>();
  private sendQueue: string[] = [];
  private nextId = 1;
  private shouldReconnect = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionStateListeners = new Set<(connected: boolean) => void>();

  public connect(explicitToken?: string | null): void {
    this.shouldReconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const token = explicitToken ?? getStoredWebSessionToken();
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const tokenParam = token ? `?token=${encodeURIComponent(token)}` : '';
    const wsUrl = `${proto}//${window.location.host}/api/ws${tokenParam}`;

    try {
      const socket = new WebSocket(wsUrl);
      this.ws = socket;

      socket.onopen = () => {
        this.notifyConnectionState(true);
        while (this.sendQueue.length > 0 && socket.readyState === WebSocket.OPEN) {
          const payload = this.sendQueue.shift()!;
          socket.send(payload);
        }
      };

      socket.onmessage = (ev) => {
        try {
          const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
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
          } else if (msg.type === 'event' && msg.channel) {
            const set = this.listeners.get(msg.channel);
            if (set) {
              const args = Array.isArray(msg.args) ? msg.args : [];
              for (const fn of Array.from(set)) {
                try {
                  fn({}, ...args);
                } catch (err) {
                  console.error(`[WebClientBridge] Listener error on ${msg.channel}:`, err);
                }
              }
            }
          }
        } catch (err) {
          console.error('[WebClientBridge] Failed to parse message:', err);
        }
      };

      socket.onclose = () => {
        this.notifyConnectionState(false);
        this.ws = null;
        if (this.shouldReconnect) {
          this.reconnectTimer = setTimeout(() => {
            this.connect();
          }, 1500);
        }
      };

      socket.onerror = () => {
        // onclose will handle reconnect
      };
    } catch (err) {
      console.error('[WebClientBridge] WebSocket creation failed:', err);
    }
  }

  public disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
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
    for (const [, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(new Error('Disconnected from web server'));
    }
    this.pending.clear();
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

    return new Promise((resolve, reject) => {
      const id = `req_${this.nextId++}_${Date.now()}`;
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
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

      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(packet);
      } else {
        this.sendQueue.push(packet);
        if (!this.ws && this.shouldReconnect) {
          this.connect();
        }
      }
    });
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
  if (isNativeElectronMode !== null) {
    return !isNativeElectronMode;
  }
  if (typeof window === 'undefined') return false;
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
