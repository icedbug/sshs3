import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

/**
 * A small proxy between sshs3 and the model provider. Every call is written down under the run it
 * belongs to (to count tokens and to look for planted secrets in what was sent), and a run can be
 * given faults: a 429, a 500, or a stream cut in the middle.
 *
 * A run is known by the dummy key sshs3 is given for it: `Bearer lab-<runId>` (OpenAI) or
 * `x-api-key: lab-<runId>` (Anthropic). That key never goes on. OpenAI gets `Bearer proxy-injected`,
 * which the environment's own proxy replaces with the real key. Anthropic's hosts get no key from the
 * environment's proxy, so a call to Claude (`/v1/messages`) is sent with the lab's own key, read from
 * LAB_ANTHROPIC_API_KEY when the call is made; the product under test never sees it.
 */

export interface FaultRule {
  /** The rule applies to the calls after this many calls of the run. */
  afterCalls: number;
  kind: '429' | '500' | 'cut';
  /** How many calls it applies to. */
  times: number;
}

export interface ModelCall {
  at: string;
  runId: string;
  path: string;
  model: string;
  status: number;
  ms: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  /** What was sent, without its headers. */
  request: string;
  /** What came back (cut at 2 MB). */
  response: string;
  /** Why no whole answer came: the provider could not be reached (status 0), or its stream broke. */
  error?: string;
  /** The answer's stream broke in the middle (the provider's, or a cut the lab made). */
  broken?: boolean;
  /** Anthropic only: the tokens written to the prompt cache (billed above plain input). */
  cacheWriteTokens?: number;
  /** The provider sent an error inside an answer that began well (status 200): its type. */
  providerError?: string;
}

/**
 * A call the provider failed: no answer (status 0), a rate limit, a server error, a broken stream, or
 * an error the provider sent inside its stream (no credits left, overloaded).
 */
export const providerFailed = (c: Pick<ModelCall, 'status' | 'broken' | 'providerError'>): boolean =>
  c.status === 0 || c.status === 429 || c.status >= 500 || c.broken === true || Boolean(c.providerError);

/** Errors of the provider's own making. A refusal by its filter, or a bad request, is not one of them. */
const PROVIDER_ERROR_TYPES = ['insufficient_quota', 'rate_limit_exceeded', 'rate_limit_error', 'server_error', 'service_unavailable', 'overloaded_error', 'api_error'];

/** Every JSON object of an answer: the answer itself, or each `data:` line of a streamed one. */
function jsonPieces(text: string): unknown[] {
  const pieces: unknown[] = [];
  const tryParse = (s: string): void => {
    try {
      pieces.push(JSON.parse(s));
    } catch {
      // Not JSON.
    }
  };
  if (text.trimStart().startsWith('{')) tryParse(text);
  else for (const line of text.split('\n')) if (line.startsWith('data:')) tryParse(line.slice(5).trim());
  return pieces;
}

/** The type of an error event the provider put in its stream, when it is one of the provider's own. */
export function providerErrorIn(text: string): string | undefined {
  for (const piece of jsonPieces(text)) {
    const event = piece as { type?: unknown; error?: { type?: unknown } };
    const type = typeof event?.error?.type === 'string' ? event.error.type : undefined;
    if (event?.type === 'error' && type && PROVIDER_ERROR_TYPES.includes(type)) return type;
  }
  return undefined;
}

export interface ModelProxy {
  /** The address on this machine's loopback. The shared web server reaches it at a private address of this machine instead. */
  url: string;
  port: number;
  stop(): Promise<void>;
  setFaults(runId: string, rules: FaultRule[]): void;
  calls(runId: string): Promise<ModelCall[]>;
  /** The file a run's calls are written to. */
  logFile(runId: string): string;
}

const RESPONSE_KEPT = 2 * 1024 * 1024;

/**
 * The usage the provider reported, from a JSON answer or from the events of a streamed one. OpenAI:
 * the last usage wins, its input counts the cached part too. Anthropic: the start of the message and
 * its last delta each carry part of it, and its input, cache reads and cache writes are counted apart;
 * here they are added up, so that `inputTokens` means all the input in both.
 */
export function usageOf(text: string): { inputTokens: number; cachedTokens: number; outputTokens: number; cacheWriteTokens?: number } {
  const found: Array<Record<string, unknown>> = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (record.usage && typeof record.usage === 'object') found.push(record.usage as Record<string, unknown>);
    for (const child of Object.values(record)) if (child && typeof child === 'object') visit(child);
  };
  for (const piece of jsonPieces(text)) visit(piece);
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
  if (found.some((u) => 'cache_read_input_tokens' in u || 'cache_creation_input_tokens' in u)) {
    const most = (key: string): number => Math.max(0, ...found.map((u) => num(u[key])));
    const read = most('cache_read_input_tokens');
    const write = most('cache_creation_input_tokens');
    return { inputTokens: most('input_tokens') + read + write, cachedTokens: read, cacheWriteTokens: write, outputTokens: most('output_tokens') };
  }
  const u = found.at(-1) ?? {};
  const details = (u.input_tokens_details ?? u.prompt_tokens_details ?? {}) as Record<string, unknown>;
  return {
    inputTokens: num(u.input_tokens ?? u.prompt_tokens),
    cachedTokens: num(details.cached_tokens),
    outputTokens: num(u.output_tokens ?? u.completion_tokens),
  };
}

const errorText = (error: unknown): string => {
  const e = error as { message?: unknown; cause?: { message?: unknown; code?: unknown } };
  const cause = e?.cause ? ` (${String(e.cause.code ?? e.cause.message ?? '')})` : '';
  return `${String(e?.message ?? error)}${cause}`;
};

/** Whether a connection comes from this machine itself: from one of its own addresses. */
function fromThisMachine(socket: { remoteAddress?: string; localAddress?: string }): boolean {
  const bare = (a?: string): string => (a ?? '').replace(/^::ffff:/, '');
  const remote = bare(socket.remoteAddress);
  if (!remote) return false;
  if (remote === bare(socket.localAddress) || remote.startsWith('127.') || remote === '::1') return true;
  return Object.values(os.networkInterfaces()).some((list) => list?.some((i) => bare(i.address) === remote));
}

/**
 * `host` is where it listens: this machine's loopback unless told otherwise. Wherever it listens it
 * answers only calls made from this machine itself (from one of its own addresses): a lab server,
 * where an agent runs commands, never gets to spend the real key.
 */
export async function startModelProxy(opts: {
  port: number;
  upstream: string;
  logDir: string;
  host?: string;
  tls?: { key: string; cert: string };
  /** Where Claude calls (`/v1/messages`) go, and the lab's key for them, read at each call. */
  anthropic?: { upstream: string; key: () => string | undefined };
}): Promise<ModelProxy> {
  await fs.mkdir(opts.logDir, { recursive: true });
  const faults = new Map<string, Array<FaultRule & { used: number }>>();
  const counts = new Map<string, number>();
  const logPath = (runId: string): string => path.join(opts.logDir, `${runId.replace(/[^A-Za-z0-9._-]/g, '_')}.jsonl`);
  // One queue per run, so lines of the same run never interleave.
  const writes = new Map<string, Promise<void>>();
  const log = (call: ModelCall): Promise<void> => {
    const next = (writes.get(call.runId) ?? Promise.resolve()).then(() => fs.appendFile(logPath(call.runId), `${JSON.stringify(call)}\n`));
    writes.set(call.runId, next.catch(() => {}));
    return next;
  };

  const answer = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    if (!fromThisMachine(req.socket)) {
      res.writeHead(403, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify({ error: { message: 'lab model proxy: only this machine may call it.' } }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void handle(req, res, Buffer.concat(chunks)).catch((error: unknown) => {
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `lab model proxy: ${error instanceof Error ? error.message : String(error)}` } }));
      });
    });
  };
  const server = opts.tls ? https.createServer({ key: opts.tls.key, cert: opts.tls.cert }, answer) : http.createServer(answer);

  async function handle(req: http.IncomingMessage, res: http.ServerResponse, body: Buffer): Promise<void> {
    const started = Date.now();
    const auth = String(req.headers.authorization ?? '');
    const runId = /^Bearer lab-(.+)$/.exec(auth)?.[1] ?? /^lab-(.+)$/.exec(String(req.headers['x-api-key'] ?? ''))?.[1] ?? 'unknown';
    const toClaude = Boolean(opts.anthropic) && (req.url ?? '').startsWith('/v1/messages');
    const n = (counts.get(runId) ?? 0) + 1;
    counts.set(runId, n);
    const requestText = body.toString('utf8');
    let model = '';
    try {
      model = String((JSON.parse(requestText) as { model?: unknown }).model ?? '');
    } catch {
      // A request without a JSON body.
    }
    const base = { at: new Date(started).toISOString(), runId, path: req.url ?? '', model, request: requestText };
    const rule = (faults.get(runId) ?? []).find((r) => n > r.afterCalls && r.used < r.times);
    if (rule) rule.used++;

    if (rule?.kind === '429' || rule?.kind === '500') {
      const status = rule.kind === '429' ? 429 : 500;
      const message = status === 429 ? 'Rate limit reached (lab fault).' : 'Server error (lab fault).';
      // In the provider's own shape, so the product reads it as it would the provider's.
      const answer = toClaude
        ? JSON.stringify({ type: 'error', error: { type: status === 429 ? 'rate_limit_error' : 'api_error', message } })
        : JSON.stringify({ error: { message, type: status === 429 ? 'rate_limit_exceeded' : 'server_error' } });
      // A fault answer closes its connection, so a client never reuses a connection the lab broke.
      res.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close', ...(status === 429 ? { 'retry-after': '1' } : {}) });
      res.end(answer);
      await log({ ...base, status, ms: Date.now() - started, inputTokens: 0, cachedTokens: 0, outputTokens: 0, response: answer });
      return;
    }

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers))
      if (typeof v === 'string' && !['host', 'authorization', 'x-api-key', 'content-length', 'connection', 'accept-encoding'].includes(k.toLowerCase())) headers[k] = v;
    if (toClaude) {
      const key = opts.anthropic!.key();
      if (!key) {
        const why = 'The lab has no Anthropic key: set LAB_ANTHROPIC_API_KEY.';
        res.writeHead(503, { 'Content-Type': 'application/json', Connection: 'close' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `lab model proxy: ${why}` } }));
        await log({ ...base, status: 0, ms: Date.now() - started, inputTokens: 0, cachedTokens: 0, outputTokens: 0, response: '', error: why });
        return;
      }
      headers['x-api-key'] = key;
    } else headers.authorization = 'Bearer proxy-injected';
    let upstream: Response;
    try {
      upstream = await fetch(new URL(req.url ?? '/', toClaude ? opts.anthropic!.upstream : opts.upstream), {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : new Uint8Array(body),
      });
    } catch (error) {
      // The provider could not be reached: written down like any call, then answered 502 below.
      await log({ ...base, status: 0, ms: Date.now() - started, inputTokens: 0, cachedTokens: 0, outputTokens: 0, response: '', error: errorText(error) });
      throw error;
    }
    const passOn: Record<string, string> = {};
    upstream.headers.forEach((v, k) => {
      if (!['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(k)) passOn[k] = v;
    });
    if (rule?.kind === 'cut') passOn.connection = 'close';
    res.writeHead(upstream.status, passOn);
    let kept = '';
    const decoder = new TextDecoder();
    if (upstream.body) {
      const reader = upstream.body.getReader();
      for (;;) {
        let piece: ReadableStreamReadResult<Uint8Array>;
        try {
          piece = await reader.read();
        } catch (error) {
          // The provider broke its stream: the caller's breaks too, as it would with no lab in between,
          // instead of ending cleanly with an error added after it.
          res.socket?.destroy();
          await log({ ...base, status: upstream.status, ms: Date.now() - started, ...usageOf(kept), response: kept.slice(0, RESPONSE_KEPT), broken: true, error: errorText(error) });
          return;
        }
        const { value, done } = piece;
        if (done) break;
        if (kept.length < RESPONSE_KEPT) kept += decoder.decode(value, { stream: true });
        if (rule?.kind === 'cut') {
          // A cut: the status and the first piece reach the client, then the connection drops as a
          // broken network would. The piece is flushed first, or the client would see no answer at all.
          await new Promise<void>((resolve) => res.write(value, () => resolve()));
          await reader.cancel().catch(() => {});
          res.socket?.destroy();
          await log({ ...base, status: upstream.status, ms: Date.now() - started, ...usageOf(kept), response: `${kept}\n[cut by the lab]`, broken: true, error: 'cut by the lab' });
          return;
        }
        res.write(value);
      }
    }
    res.end();
    const providerError = upstream.status === 200 ? providerErrorIn(kept) : undefined;
    await log({ ...base, status: upstream.status, ms: Date.now() - started, ...usageOf(kept), response: kept.slice(0, RESPONSE_KEPT), ...(providerError ? { providerError } : {}) });
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host ?? '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `${opts.tls ? 'https' : 'http'}://127.0.0.1:${port}`,
    port,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    setFaults: (runId, rules) => faults.set(runId, rules.map((r) => ({ ...r, used: 0 }))),
    logFile: logPath,
    calls: async (runId) => {
      await writes.get(runId);
      try {
        return (await fs.readFile(logPath(runId), 'utf8'))
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as ModelCall);
      } catch {
        return [];
      }
    },
  };
}
