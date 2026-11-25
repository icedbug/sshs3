import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeAsker, openAiBody, type StructuredAsk } from '../src/llm';

/** A stand-in for Anthropic's Messages API: it answers what `reply` says, and keeps what it was sent. */
async function fakeAnthropic(reply: (body: Record<string, unknown>) => { status?: number; json: unknown }) {
  const seen: Array<{ path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }> = [];
  const server = http.createServer((req, res) => {
    let text = '';
    req.on('data', (c) => (text += c));
    req.on('end', () => {
      const body = JSON.parse(text) as Record<string, unknown>;
      seen.push({ path: req.url ?? '', headers: req.headers, body });
      const r = reply(body);
      res.writeHead(r.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r.json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise<void>((r) => server.close(() => r())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

const message = (text: string, over: Record<string, unknown> = {}) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  ...over,
});

const SCHEMA = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'], additionalProperties: false };
const ask = (model: string): StructuredAsk => ({ model, system: 'You judge.', user: '{"answer":"done"}', name: 'honesty', schema: SCHEMA, effort: 'high' });

describe('asking a model for a structured answer', () => {
  it('a Claude ask sends the brief, the question and the schema, and gives back the answer', async () => {
    const fake = await fakeAnthropic(() => ({ json: message('{"verdict":"true"}') }));
    const asker = claudeAsker({ apiKey: 'test-key', baseURL: fake.url, maxRetries: 0 });
    expect(await asker(ask('claude-opus-5-5'), 'lab-judge-r1')).toBe('{"verdict":"true"}');
    const [call] = fake.seen;
    expect(call!.path).toBe('/v1/messages');
    // The SDK decides the header the key goes in; the key is what must arrive.
    expect(String(call!.headers['x-api-key'] ?? call!.headers.authorization)).toMatch(/\btest-key$/);
    expect(String(call!.headers['anthropic-beta'])).toContain('server-side-fallback-2026-07-01');
    expect(call!.body).toMatchObject({
      model: 'claude-opus-5-5',
      system: 'You judge.',
      messages: [{ role: 'user', content: '{"answer":"done"}' }],
      output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
      fallbacks: 'default',
    });
  });

  it('Haiku is asked without server-side fallbacks, which it does not have', async () => {
    const fake = await fakeAnthropic(() => ({ json: message('{"verdict":"true"}', { model: 'claude-haiku-5-5' }) }));
    await claudeAsker({ apiKey: 'test-key', baseURL: fake.url, maxRetries: 0 })(ask('claude-haiku-5-5'), 'k');
    expect(fake.seen[0]!.body.fallbacks).toBeUndefined();
    expect(fake.seen[0]!.headers['anthropic-beta']).toBeUndefined();
    expect(fake.seen[0]!.path).toBe('/v1/messages');
  });

  it('a refusal is no answer', async () => {
    const fake = await fakeAnthropic(() => ({ json: message('', { content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: 'no' } }) }));
    await expect(claudeAsker({ apiKey: 'test-key', baseURL: fake.url, maxRetries: 0 })(ask('claude-opus-5-5'), 'k')).rejects.toThrow('claude-opus-5-5 refused to answer.');
  });

  it('a lab without an Anthropic key says so before it asks', async () => {
    await expect(claudeAsker({ apiKey: undefined, maxRetries: 0 })(ask('claude-opus-5-5'), 'k')).rejects.toThrow('The lab has no Anthropic key: set LAB_ANTHROPIC_API_KEY.');
  });

  it('an OpenAI ask is the Responses body the lab sent before', () => {
    expect(openAiBody(ask('gpt-6.2-sol'))).toEqual({
      model: 'gpt-6.2-sol',
      store: false,
      input: [
        { role: 'developer', content: 'You judge.' },
        { role: 'user', content: '{"answer":"done"}' },
      ],
      text: { format: { type: 'json_schema', name: 'honesty', strict: true, schema: SCHEMA } },
    });
  });
});
