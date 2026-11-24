/**
 * Talks to a running sshs3 web server the way the page does: JSON requests with the session cookie,
 * and the WebSocket the page calls the server's handlers over. Every event the server pushes is kept,
 * with the time it came, so a run can be read afterwards (what streamed, what the terminal showed).
 */

export interface CapturedEvent {
  at: number;
  channel: string;
  args: unknown[];
}

export interface Answer {
  status: number;
  body: any;
  /** The session cookie the answer set, as "name=value", or an empty string. */
  cookie: string;
}

export interface WebSession {
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
  events: CapturedEvent[];
  /** Events not kept because `events` was full (it keeps the first EVENTS_KEPT). */
  dropped(): number;
  onEvent(listener: (event: CapturedEvent) => void): () => void;
  closed(): boolean;
  close(): void;
}

const EVENTS_KEPT = 200_000;
const INVOKE_TIMEOUT_MS = 15 * 60_000;

export async function send(baseUrl: string, method: string, urlPath: string, body?: unknown, cookie?: string): Promise<Answer> {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { text };
  }
  return { status: res.status, body: json, cookie: (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '' };
}

/** `send`, failing with the server's own words on a status of 400 or more. */
export async function must(baseUrl: string, method: string, urlPath: string, body?: unknown, cookie?: string): Promise<Answer> {
  const answer = await send(baseUrl, method, urlPath, body, cookie);
  if (answer.status >= 400) throw new Error(`${method} ${urlPath}: ${answer.status} ${answer.body?.error ?? answer.body?.text ?? ''}`.trim());
  return answer;
}

export async function openSession(baseUrl: string, cookie: string): Promise<WebSession> {
  const ticket = await must(baseUrl, 'POST', '/api/ws-ticket', {}, cookie);
  const ws = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/api/ws?ticket=${encodeURIComponent(ticket.body.ticket)}`);
  const events: CapturedEvent[] = [];
  const listeners = new Set<(event: CapturedEvent) => void>();
  const waiting = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  let isClosed = false;
  let dropped = 0;
  let n = 0;

  ws.addEventListener('close', () => {
    isClosed = true;
    for (const w of waiting.values()) {
      clearTimeout(w.timer);
      w.reject(new Error('The connection to the web server closed.'));
    }
    waiting.clear();
  });
  ws.addEventListener('message', (ev) => {
    let msg: any;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (msg?.type === 'event' && typeof msg.channel === 'string') {
      const event: CapturedEvent = { at: Date.now(), channel: msg.channel, args: Array.isArray(msg.args) ? msg.args : [] };
      if (events.length < EVENTS_KEPT) events.push(event);
      else dropped++;
      for (const listener of listeners) listener(event);
      return;
    }
    const w = msg?.type === 'response' ? waiting.get(msg.id) : undefined;
    if (!w) return;
    waiting.delete(msg.id);
    clearTimeout(w.timer);
    if (msg.ok) w.resolve(msg.result);
    else w.reject(new Error(String(msg.error)));
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('The WebSocket to the web server did not open.')));
  });

  return {
    invoke: <T>(channel: string, ...args: unknown[]) =>
      new Promise<T>((resolve, reject) => {
        if (isClosed) return reject(new Error('The connection to the web server is closed.'));
        const id = `r${++n}`;
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new Error(`${channel}: no answer within ${INVOKE_TIMEOUT_MS / 60_000} minutes.`));
        }, INVOKE_TIMEOUT_MS);
        waiting.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, type: 'invoke', channel, args }));
      }),
    events,
    dropped: () => dropped,
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    closed: () => isClosed,
    close: () => ws.close(),
  };
}
