import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { providerFailed, providerErrorIn, startModelProxy, usageOf, type ModelProxy } from '../src/modelProxy';
import { labTls } from '../src/tls';

/** A stand-in for OpenAI: a streamed Responses answer in three events, the last with its usage. */
async function fakeUpstream(opts: { holdLast?: () => Promise<void>; breakAfterFirst?: boolean } = {}) {
  const seen: Array<{ auth: string | undefined; body: string }> = [];
  let lastSentAt = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      seen.push({ auth: req.headers.authorization, body });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello"}\n\n');
      if (opts.breakAfterFirst) {
        // The provider's side of the connection drops in the middle of the answer.
        await new Promise((r) => setTimeout(r, 50));
        res.socket?.destroy();
        return;
      }
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

  it('an upstream it cannot reach: the caller gets 502 and the call is logged as a failure of the provider', async () => {
    const logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lab-proxy-'));
    // Port 1 on this machine: nothing listens there, so the connection is refused.
    const proxy = await startModelProxy({ port: 0, upstream: 'http://127.0.0.1:1', logDir });
    closers.push(() => proxy.stop(), () => fs.rm(logDir, { recursive: true, force: true }));
    const res = await ask(proxy, 'run-down');
    expect(res.status).toBe(502);
    await res.text();
    const calls = await proxy.calls('run-down');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ runId: 'run-down', status: 0, model: 'gpt-6.2-sol' });
    expect(calls[0]!.error).toBeTruthy();
  });

  it('a stream the provider breaks: the caller sees its stream break too, and the call is logged as broken', async () => {
    const { proxy } = await setup({ breakAfterFirst: true });
    const res = await ask(proxy, 'run-broken');
    expect(res.status).toBe(200);
    // Not a clean end with something added after it: the stream breaks, as it broke upstream.
    await expect(res.text()).rejects.toThrow();
    const calls = await proxy.calls('run-broken');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ status: 200, broken: true });
    expect(calls[0]!.response).toContain('Hello');
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

  it('an error the provider sends inside a 200 stream is its failure, not the agent’s', () => {
    // OpenAI, when the account has no credits left: the stream starts, then an error event.
    const quota =
      'event: response.created\ndata: {"type":"response.created"}\n\nevent: error\ndata: {"type":"error","sequence_number":2,"error":{"message":"You have no credits remaining.","type":"insufficient_quota","param":null,"code":"credit_balance_exhausted"}}\n\nevent: response.failed\ndata: {"type":"response.failed"}\n\n';
    expect(providerErrorIn(quota)).toBe('insufficient_quota');
    expect(providerFailed({ status: 200, providerError: providerErrorIn(quota) })).toBe(true);
    // Anthropic, when it is overloaded.
    expect(providerErrorIn('event: message_start\ndata: {"type":"message_start","message":{}}\n\nevent: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n')).toBe('overloaded_error');
    expect(providerErrorIn('event: error\ndata: {"type":"error","error":{"type":"server_error","message":"Our servers are currently overloaded. Please try again later."}}\n\n')).toBe('server_error');
    // An answer that went well, and a refusal by the provider's filter (the product's to handle), are not.
    expect(providerErrorIn('event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1}}}\n\n')).toBeUndefined();
    expect(providerErrorIn('{"error":{"message":"Invalid prompt: flagged","type":"invalid_request_error","code":"invalid_prompt"}}')).toBeUndefined();
    expect(providerFailed({ status: 200 })).toBe(false);
  });

  it("counts Anthropic's tokens: what came from the cache, what was written to it, and the output", () => {
    const stream = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":12,"cache_creation_input_tokens":300,"cache_read_input_tokens":4000,"output_tokens":1}}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":57}}',
      '',
    ].join('\n');
    expect(usageOf(stream)).toEqual({ inputTokens: 4312, cachedTokens: 4000, cacheWriteTokens: 300, outputTokens: 57 });
    expect(usageOf('{"id":"msg_2","usage":{"input_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":9}}')).toEqual({ inputTokens: 5, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 9 });
  });

  it("sends a Claude call to Anthropic with the lab's real key, and never gives that key to the caller", async () => {
    const seen: Array<{ path: string; key: string | undefined; auth: string | undefined; version: string | undefined }> = [];
    const anthropic = http.createServer((req, res) => {
      seen.push({ path: req.url ?? '', key: req.headers['x-api-key'] as string | undefined, auth: req.headers.authorization, version: req.headers['anthropic-version'] as string | undefined });
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3,"cache_read_input_tokens":7,"cache_creation_input_tokens":0,"output_tokens":1}}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":4}}\n\n');
      });
    });
    await new Promise<void>((resolve) => anthropic.listen(0, '127.0.0.1', resolve));
    const logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lab-proxy-'));
    const proxy = await startModelProxy({
      port: 0,
      upstream: 'http://127.0.0.1:9',
      anthropic: { upstream: `http://127.0.0.1:${(anthropic.address() as AddressInfo).port}`, key: () => 'the-real-key' },
      logDir,
    });
    closers.push(() => proxy.stop(), () => new Promise<void>((r) => anthropic.close(() => r())), () => fs.rm(logDir, { recursive: true, force: true }));
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'lab-claude-run', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toContain('message_delta');
    expect(text).not.toContain('the-real-key');
    expect(seen).toEqual([{ path: '/v1/messages', key: 'the-real-key', auth: undefined, version: '2023-06-01' }]);
    const [call] = await proxy.calls('claude-run');
    expect(call).toMatchObject({ runId: 'claude-run', model: 'claude-opus-5-5', status: 200, inputTokens: 10, cachedTokens: 7, outputTokens: 4 });
    expect(JSON.stringify(call)).not.toContain('the-real-key');
  });

  it('a Claude call with no key in the lab is a provider failure, said in plain words', async () => {
    const logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lab-proxy-'));
    const proxy = await startModelProxy({ port: 0, upstream: 'http://127.0.0.1:9', anthropic: { upstream: 'http://127.0.0.1:9', key: () => undefined }, logDir });
    closers.push(() => proxy.stop(), () => fs.rm(logDir, { recursive: true, force: true }));
    const res = await fetch(`${proxy.url}/v1/messages`, { method: 'POST', headers: { 'x-api-key': 'lab-nokey' }, body: '{"model":"claude-haiku-5-5"}' });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('LAB_ANTHROPIC_API_KEY');
    const [call] = await proxy.calls('nokey');
    expect(call).toMatchObject({ status: 0, error: 'The lab has no Anthropic key: set LAB_ANTHROPIC_API_KEY.' });
    expect(providerFailed(call!)).toBe(true);
  });
});
