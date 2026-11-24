import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { startModelProxy, type ModelProxy } from '../src/modelProxy';
import { labTls } from '../src/tls';

/** A stand-in for OpenAI: a streamed Responses answer in three events, the last with its usage. */
async function fakeUpstream(opts: { holdLast?: () => Promise<void> } = {}) {
  const seen: Array<{ auth: string | undefined; body: string }> = [];
  let lastSentAt = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      seen.push({ auth: req.headers.authorization, body });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello"}\n\n');
      await opts.holdLast?.();
      res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":" there"}\n\n');
      lastSentAt = Date.now();
      res.end('event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":120,"input_tokens_details":{"cached_tokens":100},"output_tokens":7}}}\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, lastSentAt: () => lastSentAt, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const ask = (proxy: ModelProxy, runId: string) =>
  fetch(`${proxy.url}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer lab-${runId}` },
    body: JSON.stringify({ model: 'gpt-6.2-sol', input: 'hi', stream: true }),
  });

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function setup(upstreamOpts?: Parameters<typeof fakeUpstream>[0], tls?: { key: string; cert: string }) {
  const upstream = await fakeUpstream(upstreamOpts);
  const logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lab-proxy-'));
  const proxy = await startModelProxy({ port: 0, upstream: upstream.url, logDir, tls });
  closers.push(() => proxy.stop(), () => upstream.close(), () => fs.rm(logDir, { recursive: true, force: true }));
  return { upstream, proxy, logDir };
}

describe('the model proxy', () => {
  it('passes a streamed answer on piece by piece', async () => {
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const { proxy, upstream } = await setup({ holdLast: () => Promise.race([released, new Promise<void>((r) => setTimeout(r, 2000))]) });
    const res = await ask(proxy, 'stream');
    const reader = res.body!.getReader();
    const first = await reader.read();
    const clientSawFirstAt = Date.now();
    expect(new TextDecoder().decode(first.value)).toContain('Hello');
    release();
    let rest = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toContain('response.completed');
    expect(clientSawFirstAt).toBeLessThanOrEqual(upstream.lastSentAt());
  });

  it('logs each call under its run, with its tokens, and never the key', async () => {
    const { proxy, upstream, logDir } = await setup();
    for (const run of ['run-a', 'run-a', 'run-b']) await (await ask(proxy, run)).text();
    const a = await proxy.calls('run-a');
    expect(a).toHaveLength(2);
    expect(a[0]).toMatchObject({ runId: 'run-a', path: '/v1/responses', model: 'gpt-6.2-sol', status: 200, inputTokens: 120, cachedTokens: 100, outputTokens: 7 });
    expect(await proxy.calls('run-b')).toHaveLength(1);
    // OpenAI gets the placeholder the environment's proxy replaces, never the run's dummy key.
    expect(upstream.seen.map((s) => s.auth)).toEqual(['Bearer proxy-injected', 'Bearer proxy-injected', 'Bearer proxy-injected']);
    const logged = await fs.readFile(path.join(logDir, 'run-a.jsonl'), 'utf8');
    expect(logged).not.toContain('Bearer');
    expect(logged).not.toContain('lab-run-a');
  });

  it('answers over https with a certificate the lab\'s own CA signed, for this machine and every lab gateway', async () => {
    const tls = await labTls();
    const { proxy } = await setup(undefined, tls);
    expect(proxy.url).toMatch(/^https:\/\/127\.0\.0\.1:/);
    const ca = await fs.readFile(tls.caPath, 'utf8');
    const answer = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = https.request(`${proxy.url}/v1/responses`, { method: 'POST', ca, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer lab-tls' } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      req.end(JSON.stringify({ model: 'gpt-6.2-sol', input: 'hi', stream: true }));
    });
    expect(answer.status).toBe(200);
    expect(answer.body).toContain('response.completed');
    // The same certificate holds for the gateway address of each lab network, where the web server reaches it.
    const { X509Certificate } = await import('node:crypto');
    const cert = new X509Certificate(tls.cert);
    for (const ip of ['127.0.0.1', '10.77.1.1', '10.77.2.1', '10.77.9.1']) expect(cert.checkIP(ip)).toBe(ip);
    expect(cert.verify(new X509Certificate(ca).publicKey)).toBe(true);
  });

  it('answers 429 or 500, or cuts the stream, as a fault rule says, then passes calls on again', async () => {
    const { proxy } = await setup();
    proxy.setFaults('run-f', [
      { afterCalls: 1, kind: '429', times: 1 },
      { afterCalls: 2, kind: 'cut', times: 1 },
      { afterCalls: 3, kind: '500', times: 1 },
    ]);
    const first = await ask(proxy, 'run-f');
    expect(first.status).toBe(200);
    await first.text();
    const second = await ask(proxy, 'run-f');
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBe('1');
    await second.text();
    const third = await ask(proxy, 'run-f');
    expect(third.status).toBe(200);
    await expect(third.text()).rejects.toThrow();
    const fourth = await ask(proxy, 'run-f');
    expect(fourth.status).toBe(500);
    await fourth.text();
    const fifth = await ask(proxy, 'run-f');
    expect(fifth.status).toBe(200);
    expect(await fifth.text()).toContain('response.completed');
    expect((await proxy.calls('run-f')).map((c) => c.status)).toEqual([200, 429, 200, 500, 200]);
  });
});
