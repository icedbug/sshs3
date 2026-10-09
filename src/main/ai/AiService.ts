import Anthropic from '@anthropic-ai/sdk';
import * as electron from 'electron';
import type { AiAskRequest, AiAskResult, AiConfig } from '../../shared/types/ai';
import { buildPrompt, parseCommandAnswer, type BuiltPrompt } from './aiPrompt';
import type { AiConfigStore } from './AiConfigStore';
import { createLogger } from '../log';
const aiLog = createLogger('ai');

type FetchFn = typeof fetch;

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_TOKENS = 4096;

/** Models that accept the server-side refusal fallback (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
/** Current models that take `output_config.effort`; older ones (e.g. Haiku 4.5) reject it. */
const EFFORT_MODEL = /^claude-(fable-5|mythos-5|opus-5|opus-4-[678]|sonnet-5|sonnet-4-6|haiku-5)/;

export interface AiServiceOptions {
  /** Defaults to Electron's net.fetch, so the system proxy and certificate store apply. */
  fetch?: FetchFn;
}

/** Sends AI assistant requests to the configured provider. Runs in the main process only. */
export class AiService {
  private readonly fetchImpl: FetchFn;

  constructor(
    private readonly configStore: AiConfigStore,
    options: AiServiceOptions = {}
  ) {
    this.fetchImpl = options.fetch ?? defaultFetch;
  }

  public async ask(request: AiAskRequest): Promise<AiAskResult> {
    const config = await this.configStore.getConfig();
    if (!config.enabled) throw new Error('The AI assistant is turned off. Turn it on in Settings → AI Assistant.');
    if (!config.model) throw new Error('No AI model is set. Choose one in Settings → AI Assistant.');

    const built = buildPrompt(request);
    aiLog.info('AI request', { task: request.task, provider: config.provider, model: config.model, redacted: built.redacted });

    const answer =
      config.provider === 'anthropic'
        ? await this.askAnthropic(config, built)
        : await this.askOpenAiCompatible(config, built);

    if (request.task === 'command') {
      const { command, explanation } = parseCommandAnswer(answer);
      return { text: explanation, command, redacted: built.redacted };
    }
    return { text: answer.trim(), redacted: built.redacted };
  }

  private async askAnthropic(config: AiConfig & { apiKey: string }, built: BuiltPrompt): Promise<string> {
    if (!config.apiKey) throw new Error('No Anthropic API key is saved. Add one in Settings → AI Assistant.');
    const client = new Anthropic({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
      fetch: this.fetchImpl,
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: 1,
    });
    try {
      const response = await client.beta.messages.create({
        model: config.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: built.system,
        messages: [{ role: 'user', content: built.user }],
        // Quick terminal help: low effort keeps answers fast and cheap.
        ...(EFFORT_MODEL.test(config.model) ? { output_config: { effort: 'low' as const } } : {}),
        ...(FALLBACK_MODELS.has(config.model)
          ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
          : {}),
      });
      if (response.stop_reason === 'refusal') {
        throw new Error('The model declined this request.');
      }
      const text = response.content
        .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');
      if (!text.trim()) throw new Error('The model returned an empty answer.');
      return text;
    } catch (err) {
      throw friendlyAnthropicError(err);
    }
  }

  private async askOpenAiCompatible(config: AiConfig & { apiKey: string }, built: BuiltPrompt): Promise<string> {
    if (!config.baseUrl) {
      throw new Error('No endpoint is set for the OpenAI-compatible provider. Add one in Settings → AI Assistant.');
    }
    const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: MAX_OUTPUT_TOKENS,
          messages: [
            { role: 'system', content: built.system },
            { role: 'user', content: built.user },
          ],
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      aiLog.warn('AI endpoint unreachable', { error: err });
      throw new Error(`Could not reach ${new URL(url).host}. Check the endpoint and that the server is running.`, { cause: err });
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error('The endpoint rejected the API key.');
      if (response.status === 404) throw new Error(`Model "${config.model}" or the endpoint path was not found.`);
      throw new Error(`The AI endpoint answered with HTTP ${response.status}.`);
    }
    const data = (await response.json().catch(() => null)) as { choices?: { message?: { content?: unknown } }[] } | null;
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('The model returned an empty answer.');
    return content;
  }
}

function defaultFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  try {
    if (typeof electron.net?.fetch === 'function') return electron.net.fetch(input as string, init);
  } catch {
    // Not running inside Electron (tests, scripts): fall back to Node's fetch.
  }
  return fetch(input, init);
}

function friendlyAnthropicError(err: unknown): Error {
  const cause = { cause: err };
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new Error('Anthropic rejected the API key.', cause);
  }
  if (err instanceof Anthropic.NotFoundError) return new Error('The model was not found. Check the model name.', cause);
  if (err instanceof Anthropic.RateLimitError) return new Error('Rate limited by Anthropic. Try again in a moment.', cause);
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new Error('The request to Anthropic timed out.', cause);
  if (err instanceof Anthropic.APIConnectionError) return new Error('Could not reach the Anthropic API.', cause);
  if (err instanceof Anthropic.BadRequestError) return new Error(`Anthropic refused the request: ${err.message}`, cause);
  if (err instanceof Anthropic.APIError) return new Error(`Anthropic API error ${err.status ?? ''}`.trim(), cause);
  return err instanceof Error ? err : new Error(String(err));
}
