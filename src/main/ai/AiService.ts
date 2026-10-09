import Anthropic from '@anthropic-ai/sdk';
import * as electron from 'electron';
import type { AiAskRequest, AiAskResult, AiConfig } from '../../shared/types/ai';
import { buildPrompt, parseCommandAnswer, type BuiltPrompt } from './aiPrompt';
import type { AiConfigStore } from './AiConfigStore';
import type { HermesEndpoint, HermesModelConfig } from './HermesManager';
import { createLogger } from '../log';
const aiLog = createLogger('ai');

type FetchFn = typeof fetch;

const REQUEST_TIMEOUT_MS = 60_000;
/** Hermes may take a few seconds to start, and it reads and writes its memory around the model call. */
const HERMES_TIMEOUT_MS = 120_000;
/** Hermes' name for "the model in its config" on its OpenAI-compatible API. */
const HERMES_VIRTUAL_MODEL = 'hermes-agent';
/** Hermes scopes long-term memory by this key, so everything sshs3 asks shares one memory. */
const HERMES_MEMORY_SCOPE = 'sshs3';
const MAX_OUTPUT_TOKENS = 4096;

/** Models that accept the server-side refusal fallback (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
/** Current models that take `output_config.effort`; older ones (e.g. Haiku 4.5) reject it. */
const EFFORT_MODEL = /^claude-(fable-5|mythos-5|opus-5|opus-4-[678]|sonnet-5|sonnet-4-6|haiku-5)/;

/** The part of HermesManager the service needs. */
export interface HermesRuntime {
  ensureRunning(model: HermesModelConfig): Promise<HermesEndpoint>;
}

export interface AiServiceOptions {
  /** Defaults to Electron's net.fetch, so the system proxy and certificate store apply. */
  fetch?: FetchFn;
  /** The bundled Hermes agent, used when the user turns it on. */
  hermes?: HermesRuntime;
}

/** Sends AI assistant requests to the configured provider. Runs in the main process only. */
export class AiService {
  private readonly fetchImpl: FetchFn;
  private readonly hermes: HermesRuntime | undefined;

  constructor(
    private readonly configStore: AiConfigStore,
    options: AiServiceOptions = {}
  ) {
    this.fetchImpl = options.fetch ?? defaultFetch;
    this.hermes = options.hermes;
  }

  public async ask(request: AiAskRequest): Promise<AiAskResult> {
    const config = await this.configStore.getConfig();
    if (!config.enabled) throw new Error('The AI assistant is turned off. Turn it on in Settings → AI Assistant.');
    if (!config.model) throw new Error('No AI model is set. Choose one in Settings → AI Assistant.');

    const built = buildPrompt(request);
    aiLog.info('AI request', {
      task: request.task,
      provider: config.provider,
      model: config.model,
      hermes: config.useHermes,
      redacted: built.redacted,
    });

    const answer = config.useHermes
      ? await this.askHermes(config, built)
      : config.provider === 'anthropic'
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
    return this.chatCompletions({
      baseUrl: config.baseUrl,
      headers: config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {},
      model: config.model,
      built,
      timeoutMs: REQUEST_TIMEOUT_MS,
      unreachable: (host) => `Could not reach ${host}. Check the endpoint and that the server is running.`,
    });
  }

  /**
   * Through the bundled Hermes agent: it is started (or restarted for a new model) on demand,
   * calls the configured model itself and keeps memory across requests. Hermes runs with sshs3's
   * guardrails: no shell, file or network tools, and none of sshs3's credentials (see HermesManager).
   */
  private async askHermes(config: AiConfig & { apiKey: string }, built: BuiltPrompt): Promise<string> {
    if (!this.hermes) throw new Error('This build of sshs3 does not include the Hermes agent.');
    let model: HermesModelConfig;
    if (config.provider === 'anthropic') {
      if (!config.apiKey) throw new Error('No Anthropic API key is saved. Add one in Settings → AI Assistant.');
      model = { kind: 'anthropic', model: config.model, apiKey: config.apiKey, ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}) };
    } else {
      if (!config.baseUrl) {
        throw new Error('No endpoint is set for the OpenAI-compatible provider. Add one in Settings → AI Assistant.');
      }
      model = { kind: 'custom', model: config.model, baseUrl: config.baseUrl, ...(config.apiKey ? { apiKey: config.apiKey } : {}) };
    }
    let endpoint: HermesEndpoint;
    try {
      endpoint = await this.hermes.ensureRunning(model);
    } catch (err) {
      aiLog.warn('Hermes did not start', { error: err });
      throw new Error(`The Hermes agent could not start: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    return this.chatCompletions({
      baseUrl: endpoint.baseUrl,
      headers: { authorization: `Bearer ${endpoint.apiKey}`, 'x-hermes-session-key': HERMES_MEMORY_SCOPE },
      model: HERMES_VIRTUAL_MODEL,
      built,
      timeoutMs: HERMES_TIMEOUT_MS,
      unreachable: () => 'Could not reach the Hermes agent.',
    });
  }

  private async chatCompletions(options: {
    baseUrl: string;
    headers: Record<string, string>;
    model: string;
    built: BuiltPrompt;
    timeoutMs: number;
    unreachable: (host: string) => string;
  }): Promise<string> {
    const url = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...options.headers },
        body: JSON.stringify({
          model: options.model,
          max_tokens: MAX_OUTPUT_TOKENS,
          messages: [
            { role: 'system', content: options.built.system },
            { role: 'user', content: options.built.user },
          ],
        }),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (err) {
      aiLog.warn('AI endpoint unreachable', { error: err });
      throw new Error(options.unreachable(new URL(url).host), { cause: err });
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error('The endpoint rejected the API key.');
      if (response.status === 404) throw new Error(`Model "${options.model}" or the endpoint path was not found.`);
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
