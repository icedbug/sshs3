/**
 * Opt-in AI assistant for terminals: suggests a shell command from a description,
 * or explains selected terminal output. Nothing is sent anywhere until the user
 * submits a request, and a suggested command is only ever typed into the terminal,
 * never run, without the user pressing Enter themselves.
 */

/**
 * 'anthropic' calls the Claude API. 'openai-compatible' calls any server that speaks
 * the OpenAI chat-completions protocol, such as a local Ollama or LM Studio, for
 * people who don't want terminal content to leave their machine or network.
 */
export type AiProvider = 'anthropic' | 'openai-compatible';

/** 'command': describe a task, get one shell command back. 'explain': explain the given terminal text. */
export type AiTask = 'command' | 'explain';

/** Where the terminal runs, so the model can pick a command that fits. */
export interface AiTerminalEnvironment {
  kind: 'ssh' | 'local' | 'k8s';
  /** Renderer platform for local shells ('linux', 'win32', 'darwin'). */
  platform?: string;
  /** Local shell type when known (e.g. 'powershell', 'wsl'). */
  shell?: string;
}

export interface AiConfig {
  /** Master switch. Off by default: an opt-in feature. */
  enabled: boolean;
  provider: AiProvider;
  model: string;
  /** Optional endpoint override. Required for 'openai-compatible' (e.g. http://localhost:11434/v1). */
  baseUrl?: string;
}

/** What the renderer sees: the API key itself never leaves the main process. */
export interface AiConfigView extends AiConfig {
  hasApiKey: boolean;
}

/** `apiKey`: a string replaces the stored key, null removes it, undefined keeps it. */
export interface AiConfigUpdate extends Partial<AiConfig> {
  apiKey?: string | null;
}

export interface AiAskRequest {
  task: AiTask;
  /** What the user typed. For 'explain' it may be empty when context is given. */
  prompt: string;
  /** Terminal text the user chose to include (selection or last command output). */
  context?: string;
  environment?: AiTerminalEnvironment;
}

export interface AiAskResult {
  /** The full answer (for 'command': the explanation that came with the command). */
  text: string;
  /** 'command' only: the suggested command, ready to be typed into the terminal. */
  command?: string;
  /** True when secrets were masked out of the prompt or context before sending. */
  redacted: boolean;
}

export const AI_MAX_PROMPT_CHARS = 2000;
/** Longer context is cut from the start: the end of an output is usually where the error is. */
export const AI_MAX_CONTEXT_CHARS = 16000;

export const DEFAULT_AI_MODELS: Record<AiProvider, string> = {
  anthropic: 'claude-opus-5-5',
  'openai-compatible': 'llama3.1',
};

export const DEFAULT_AI_CONFIG: AiConfig = {
  enabled: false,
  provider: 'anthropic',
  model: DEFAULT_AI_MODELS.anthropic,
};
