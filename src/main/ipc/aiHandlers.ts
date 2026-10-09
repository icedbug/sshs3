import { IPC_CHANNELS } from '../../shared/types/ipc';
import {
  AI_MAX_CONTEXT_CHARS,
  AI_MAX_PROMPT_CHARS,
  type AiAskRequest,
  type AiAskResult,
  type AiConfigUpdate,
  type AiConfigView,
  type AiTerminalEnvironment,
} from '../../shared/types/ai';
import type { IpcBridge } from '../IpcBridge';

/** The part of IpcBridge this handler group may use. */
export type AiHost = Pick<IpcBridge, 'aiConfigStore' | 'aiService' | 'registerHandler'>;

/** The renderer may send a whole scrollback as context; anything far beyond what is used is rejected outright. */
const MAX_CONTEXT_INPUT_CHARS = AI_MAX_CONTEXT_CHARS * 8;

const isOptionalString = (v: unknown, max: number): v is string | undefined =>
  v === undefined || (typeof v === 'string' && v.length <= max);

function parseEnvironment(value: unknown): AiTerminalEnvironment | undefined {
  if (value === undefined) return undefined;
  const env = value as Record<string, unknown> | null;
  if (
    !env ||
    typeof env !== 'object' ||
    (env.kind !== 'ssh' && env.kind !== 'local' && env.kind !== 'k8s') ||
    !isOptionalString(env.platform, 32) ||
    !isOptionalString(env.shell, 64)
  ) {
    throw new Error('Invalid terminal environment');
  }
  return { kind: env.kind, platform: env.platform, shell: env.shell };
}

export function parseAskRequest(input: unknown): AiAskRequest {
  const r = input as Record<string, unknown> | null;
  if (
    !r ||
    typeof r !== 'object' ||
    (r.task !== 'command' && r.task !== 'explain') ||
    typeof r.prompt !== 'string' ||
    r.prompt.length > AI_MAX_PROMPT_CHARS ||
    !isOptionalString(r.context, MAX_CONTEXT_INPUT_CHARS)
  ) {
    throw new Error('Invalid AI request');
  }
  if (r.task === 'command' && !r.prompt.trim()) throw new Error('Describe what the command should do.');
  if (r.task === 'explain' && !r.prompt.trim() && !(r.context ?? '').trim()) {
    throw new Error('Select some terminal text or ask a question.');
  }
  return { task: r.task, prompt: r.prompt, context: r.context, environment: parseEnvironment(r.environment) };
}

export function parseConfigUpdate(input: unknown): AiConfigUpdate {
  const u = input as Record<string, unknown> | null;
  if (
    !u ||
    typeof u !== 'object' ||
    (u.enabled !== undefined && typeof u.enabled !== 'boolean') ||
    (u.provider !== undefined && u.provider !== 'anthropic' && u.provider !== 'openai-compatible') ||
    !isOptionalString(u.model, 200) ||
    !isOptionalString(u.baseUrl, 2048) ||
    (u.apiKey !== undefined && u.apiKey !== null && !(typeof u.apiKey === 'string' && u.apiKey.length <= 4096)) // pragma: allowlist secret
  ) {
    throw new Error('Invalid AI settings');
  }
  return {
    ...(u.enabled !== undefined ? { enabled: u.enabled } : {}),
    ...(u.provider !== undefined ? { provider: u.provider } : {}),
    ...(u.model !== undefined ? { model: u.model } : {}),
    ...(u.baseUrl !== undefined ? { baseUrl: u.baseUrl } : {}),
    ...(u.apiKey !== undefined ? { apiKey: u.apiKey as string | null } : {}),
  };
}

export function registerAiHandlers(bridge: AiHost): void {
  bridge.registerHandler(IPC_CHANNELS.AI_GET_CONFIG, async (): Promise<AiConfigView> => {
    return await bridge.aiConfigStore.getView();
  });

  bridge.registerHandler(IPC_CHANNELS.AI_SAVE_CONFIG, async (_event, update: unknown): Promise<AiConfigView> => {
    return await bridge.aiConfigStore.update(parseConfigUpdate(update));
  });

  bridge.registerHandler(IPC_CHANNELS.AI_ASK, async (_event, request: unknown): Promise<AiAskResult> => {
    return await bridge.aiService.ask(parseAskRequest(request));
  });
}
