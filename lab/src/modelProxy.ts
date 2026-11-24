import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

/**
 * A small proxy between sshs3 and the model provider. Every call is written down under the run it
 * belongs to (to count tokens and to look for planted secrets in what was sent), and a run can be
 * given faults: a 429, a 500, or a stream cut in the middle.
 *
 * A run is known by the dummy key sshs3 is given for it: `Bearer lab-<runId>`. That key never goes on:
 * the provider gets `Bearer proxy-injected`, which the environment's own proxy replaces with the real key.
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
}

export interface ModelProxy {
  url: string;
  stop(): Promise<void>;
  setFaults(runId: string, rules: FaultRule[]): void;
  calls(runId: string): Promise<ModelCall[]>;
}

const RESPONSE_KEPT = 2 * 1024 * 1024;

/** The usage the provider reported, from a JSON answer or from the events of a streamed one (the last wins). */
export function usageOf(text: string): { inputTokens: number; cachedTokens: number; outputTokens: number } {
  const found: Array<Record<string, unknown>> = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (record.usage && typeof record.usage === 'object') found.push(record.usage as Record<string, unknown>);
    for (const child of Object.values(record)) if (child && typeof child === 'object') visit(child);
  };
  const tryParse = (s: string): void => {
    try {
      visit(JSON.parse(s));
    } catch {
      // Not JSON.
    }
  };
  if (text.trimStart().startsWith('{')) tryParse(text);
  else for (const line of text.split('\n')) if (line.startsWith('data:')) tryParse(line.slice(5).trim());
  const u = found.at(-1) ?? {};
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
  const details = (u.input_tokens_details ?? u.prompt_tokens_details ?? {}) as Record<string, unknown>;
  return {
    inputTokens: num(u.input_tokens ?? u.prompt_tokens),
    cachedTokens: num(details.cached_tokens),
    outputTokens: num(u.output_tokens ?? u.completion_tokens),
  };
}

export async function startModelProxy(opts: { port: number; upstream: string; logDir: string }): Promise<ModelProxy> {
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

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void handle(req, res, Buffer.concat(chunks)).catch((error: unknown) => {
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `lab model proxy: ${error instanceof Error ? error.message : String(error)}` } }));
      });
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse, body: Buffer): Promise<void> {
    const started = Date.now();
    const auth = String(req.headers.authorization ?? '');
    const runId = /^Bearer lab-(.+)$/.exec(auth)?.[1] ?? 'unknown';
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
      const answer = JSON.stringify({ error: { message: status === 429 ? 'Rate limit reached (lab fault).' : 'Server error (lab fault).', type: status === 429 ? 'rate_limit_exceeded' : 'server_error' } });
      // A fault answer closes its connection, so a client never reuses a connection the lab broke.
      res.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close', ...(status === 429 ? { 'retry-after': '1' } : {}) });
      res.end(answer);
      await log({ ...base, status, ms: Date.now() - started, inputTokens: 0, cachedTokens: 0, outputTokens: 0, response: answer });
      return;
    }

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers))
      if (typeof v === 'string' && !['host', 'authorization', 'content-length', 'connection', 'accept-encoding'].includes(k.toLowerCase())) headers[k] = v;
    headers.authorization = 'Bearer proxy-injected';
    const upstream = await fetch(new URL(req.url ?? '/', opts.upstream), { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : new Uint8Array(body) });
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
        const { value, done } = await reader.read();
        if (done) break;
        if (kept.length < RESPONSE_KEPT) kept += decoder.decode(value, { stream: true });
        if (rule?.kind === 'cut') {
          // A cut: the status and the first piece reach the client, then the connection drops as a
          // broken network would. The piece is flushed first, or the client would see no answer at all.
          await new Promise<void>((resolve) => res.write(value, () => resolve()));
          await reader.cancel().catch(() => {});
          res.socket?.destroy();
          await log({ ...base, status: upstream.status, ms: Date.now() - started, ...usageOf(kept), response: `${kept}\n[cut by the lab]` });
          return;
        }
        res.write(value);
      }
    }
    res.end();
    await log({ ...base, status: upstream.status, ms: Date.now() - started, ...usageOf(kept), response: kept.slice(0, RESPONSE_KEPT) });
  }

  await new Promise<void>((resolve) => server.listen(opts.port, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    setFaults: (runId, rules) => faults.set(runId, rules.map((r) => ({ ...r, used: 0 }))),
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
