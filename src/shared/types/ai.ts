/** Model connection settings; task execution contracts live in aiHub.ts. */
export type AiProvider = "openai-codex" | "anthropic" | "openai-compatible";

export interface AiConfig {
  /** Master switch. Off by default: an opt-in feature. */
  enabled: boolean;
  provider: AiProvider;
  model: string;
  /** Optional endpoint override. Required for 'openai-compatible' (e.g. http://localhost:11434/v1). */
  baseUrl?: string;
  /** Reserved for config compatibility. */
  useHermes: boolean;
  /** Display name / handle used when recording team workspace changes (e.g. 'jacob'). */
  actorName?: string;
}

/** What the renderer sees: the API key itself never leaves the main process. */
export interface AiConfigView extends AiConfig {
  hasApiKey: boolean;
  keyStorage?: "session" | "encrypted" | "oauth";
  codexConnected?: boolean;
  codexAccountEmail?: string;
  codexDefaultModel?: string;
  codexModels?: string[];
}

/** `apiKey`: a string replaces the stored key, null removes it, undefined keeps it. */
export interface AiConfigUpdate extends Partial<AiConfig> {
  apiKey?: string | null;
}

/** The bundled Hermes agent: whether this build includes it, and whether it is running now. */
export interface AiHermesStatus {
  bundled: boolean;
  /** Hermes release tag, when bundled. */
  version?: string;
  running: boolean;
}

export const DEFAULT_AI_MODELS: Record<AiProvider, string> = {
  "openai-codex": "gpt-6.1-sol",
  anthropic: "claude-sonnet-4-5",
  "openai-compatible": "",
};

export const DEFAULT_PROVIDER_MODELS: Record<AiProvider, string[]> = {
  "openai-codex": [
    "gpt-6.1-sol",
    "gpt-6.1-sol-900k",
    "gpt-6-astra",
    "gpt-6-astra-900k",
    "gpt-6-sol",
    "gpt-6-sol-900k",
    "gpt-6-luna",
    "gpt-6-luna-900k",
    "gpt-5.6-sol",
    "gpt-5.6-sol-900k",
    "gpt-5.6-terra",
    "gpt-5.6-terra-900k",
    "gpt-5.6-luna",
    "gpt-5.6-luna-900k",
  ],
  anthropic: [
    "claude-sonnet-4-5",
    "claude-opus-4-1",
    "claude-3-7-sonnet-latest",
    "claude-3-5-haiku-latest",
  ],
  "openai-compatible": [],
};

export const DEFAULT_AI_CONFIG: AiConfig = {
  enabled: false,
  provider: "anthropic",
  model: DEFAULT_AI_MODELS.anthropic,
  useHermes: true,
};
