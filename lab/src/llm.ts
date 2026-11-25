import fs from 'node:fs/promises';
import https from 'node:https';
import Anthropic from '@anthropic-ai/sdk';
import { labTls } from './tls';

/**
 * The lab's own questions to a model, answered in a fixed JSON shape: the honesty judge and the
 * careful person ask them. A Claude model is asked through Anthropic's SDK with the lab's key
 * (LAB_ANTHROPIC_API_KEY), straight to Anthropic; another model through the lab's model proxy, as the
 * product's own calls go, under the key given (`lab-judge-<runId>`, `lab-human-<runId>`).
 */

export interface StructuredAsk {
  model: string;
  /** The brief, as the system prompt. */
  system: string;
  /** The question, as one user message. */
  user: string;
  /** The answer's shape: a name and a JSON schema. */
  name: string;
  schema: Record<string, unknown>;
  /** How hard a Claude model thinks about it. */
  effort?: 'low' | 'medium' | 'high';
}

/** Asks and gives back the answer's JSON text. `key` names the caller to the lab's proxy. */
export type Asker = (q: StructuredAsk, key: string) => Promise<string>;

/** The model could not be asked: no connection (status 0), a rate limit or a server error. Asked again. */
export class JudgeUnavailable extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Asked again after 5, 20 and 60 seconds while the model cannot be reached; any other failure is final. */
export async function withRetries<T>(attempt: () => Promise<T>, delaysMs: number[] = [5_000, 20_000, 60_000]): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof JudgeUnavailable) || i >= delaysMs.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, delaysMs[i]));
    }
  }
}

/** One POST over https to the lab's model proxy, trusting the lab's own CA. */
export function post(url: string, body: string, headers: Record<string, string>, ca: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', ca, headers: { 'Content-Type': 'application/json', ...headers }, timeout: 180_000 }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on('timeout', () => req.destroy(new Error('The model took longer than 3 minutes.')));
    req.on('error', reject);
    req.end(body);
  });
}

/** The text of a Responses API reply's message, if it has one. */
export function outputText(json: string): string | undefined {
  try {
    const parsed = JSON.parse(json) as { output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> };
    return (parsed.output ?? []).flatMap((o) => (o.type === 'message' ? (o.content ?? []) : [])).find((c) => c.type === 'output_text')?.text;
  } catch {
    return undefined;
  }
}

/** The Responses API body for an OpenAI model: the brief as the developer message, the answer's shape strict. */
export function openAiBody(q: StructuredAsk): Record<string, unknown> {
  return {
    model: q.model,
    store: false,
    input: [
      { role: 'developer', content: q.system },
      { role: 'user', content: q.user },
    ],
    text: { format: { type: 'json_schema', name: q.name, strict: true, schema: q.schema } },
  };
}

/** An OpenAI model through the lab's model proxy, asked again after a rate limit, a server error or no connection. */
export function openAiAsker(proxyUrl: string): Asker {
  let ca: string | undefined;
  return async (q, key) => {
    ca ??= await fs.readFile((await labTls()).caPath, 'utf8');
    return withRetries(async () => {
      const answer = await post(`${proxyUrl}/v1/responses`, JSON.stringify(openAiBody(q)), { Authorization: `Bearer ${key}` }, ca!).catch((error: unknown) => {
        throw new JudgeUnavailable(0, `${q.model} could not be reached: ${error instanceof Error ? error.message : String(error)}`);
      });
      if (answer.status === 429 || answer.status >= 500) throw new JudgeUnavailable(answer.status, `${q.model} could not answer (${answer.status}): ${answer.text.slice(0, 300)}`);
      if (answer.status !== 200) throw new Error(`${q.model} could not answer (${answer.status}): ${answer.text.slice(0, 300)}`);
      return outputText(answer.text) ?? '';
    });
  };
}

/** Claude models that a refused request may fall back from, on the server (Haiku has no such fallback). */
const FALLS_BACK = /^claude-(opus|sonnet|fable)-/;

/**
 * A Claude model through Anthropic's SDK. A request the model refuses on policy grounds falls back on
 * the server to another model (`fallbacks: "default"`) where the model has that; a refusal that stands
 * is no answer. Asked again after a rate limit, an overload or no connection.
 */
export function claudeAsker(opts: { apiKey?: string | undefined; baseURL?: string; maxRetries?: number } = { apiKey: process.env.LAB_ANTHROPIC_API_KEY }): Asker {
  return async (q) => {
    if (!opts.apiKey) throw new Error('The lab has no Anthropic key: set LAB_ANTHROPIC_API_KEY.');
    const client = new Anthropic({ apiKey: opts.apiKey, ...(opts.baseURL ? { baseURL: opts.baseURL } : {}), maxRetries: opts.maxRetries ?? 2 });
    const fallback = FALLS_BACK.test(q.model);
    return withRetries(async () => {
      let response: Anthropic.Beta.BetaMessage;
      try {
        response = await client.beta.messages.create({
          model: q.model,
          max_tokens: 16_000,
          system: q.system,
          messages: [{ role: 'user', content: q.user }],
          output_config: { ...(q.effort ? { effort: q.effort } : {}), format: { type: 'json_schema', schema: q.schema } },
          ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        });
      } catch (error) {
        if (error instanceof Anthropic.RateLimitError || error instanceof Anthropic.InternalServerError || error instanceof Anthropic.APIConnectionError)
          throw new JudgeUnavailable(error instanceof Anthropic.APIError ? (error.status ?? 0) : 0, `${q.model} could not answer: ${error.message}`);
        throw error;
      }
      if (response.stop_reason === 'refusal') throw new Error(`${q.model} refused to answer.`);
      const text = response.content.find((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')?.text;
      if (!text) throw new Error(`${q.model} gave no answer (stop reason ${response.stop_reason ?? 'none'}).`);
      return text;
    });
  };
}

/** The asker for a model: Claude through Anthropic's SDK, any other model through the lab's proxy. */
export function askerFor(model: string, proxyUrl: string): Asker {
  return model.startsWith('claude-') ? claudeAsker() : openAiAsker(proxyUrl);
}
