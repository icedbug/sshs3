/** Model connection settings; task execution contracts live in aiHub.ts. */
export type AiProvider = "openai-codex" | "anthropic" | "openai-compatible";

export type AiApiProtocol = "auto" | "responses" | "chat-completions";

export function usesResponsesApi(baseUrl: string, protocol?: AiApiProtocol): boolean {
  if (protocol && protocol !== "auto") return protocol === "responses";
  try {
    const url = new URL(baseUrl);
    return url.origin === "https://api.openai.com" && url.pathname.replace(/\/$/, "") === "/v1" && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export type AiReasoningEffort = "low" | "medium" | "high";

export type AiEgressPolicy = "standard" | "local-only" | "eu-pinned";

export type AiPiiScrubbingMode = "off" | "standard" | "strict";

export type AiProfileRole = "primary" | "fastTriage" | "backgroundDistill" | "embedding";

export type AiActiveProfileByRole = Partial<Record<AiProfileRole, string>>;

/** Named model + endpoint profile for multi-provider switching and role routing. */
export interface ProviderProfile {
  id: string;
  name: string;
  provider: AiProvider;
  model: string;
  baseUrl?: string;
  apiProtocol?: AiApiProtocol;
  reasoningEffort?: AiReasoningEffort;
  temperature?: number;
  maxOutputTokens?: number;
  contextWindowTokens?: number;
  embeddingModel?: string;
  egressPolicy?: AiEgressPolicy;
  zdrConfirmed?: boolean;
  hasApiKey?: boolean;
  keyStorage?: "session" | "encrypted" | "oauth";
  fallbackProfileIds?: string[];
  updatedAt?: number;
}

export interface AiConfig {
  /** Master switch. Off by default: an opt-in feature. */
  enabled: boolean;
  provider: AiProvider;
  model: string;
  /** Optional endpoint override. Required for 'openai-compatible' (e.g. http://localhost:11434/v1). */
  baseUrl?: string;
  apiProtocol?: AiApiProtocol;
  /** Reserved for config compatibility. */
  useHermes: boolean;
  /** Display name / handle used when recording team workspace changes (e.g. 'jacob'). */
  actorName?: string;
  /** Context window budget in tokens (e.g. 16000, 32000, 64000, 128000, 256000, 900000). Default: 128000. */
  contextWindowTokens?: number;
  /** Max characters of terminal scrollback included per session in context. Default: 8000. */
  terminalContextChars?: number;
  /** Max output tokens per model turn. Default: 8192. */
  maxOutputTokens?: number;
  /**
   * Not used: a run has no limit on how many times it goes round. Kept so that settings saved
   * before the limit was taken away still load, and so that a window that still sends it is not refused.
   */
  maxToolTurns?: number;
  /** Reasoning effort for reasoning-capable models. Default: 'medium'. */
  reasoningEffort?: AiReasoningEffort;
  /** Sampling temperature (0.0 - 1.0) for custom/compatible models. Default: 0.2. */
  temperature?: number;
  /**
   * Embedding model served by the OpenAI-compatible endpoint (`baseUrl` +
   * `/embeddings`), e.g. `text-embedding-3-small` or `nomic-embed-text`.
   * When set with that provider, knowledge base search also ranks by meaning;
   * otherwise it is lexical only.
   */
  embeddingModel?: string;
  /**
   * A smaller, cheaper model of the same provider for the work the hub does
   * in the background: an agent's investigators, workforce reviews and
   * reading sessions for team memory. Conversations keep `model`. Unset:
   * everything runs on `model`. A background run that fails on this model is
   * run again on `model`.
   */
  fastModel?: string;
  /** Named provider profiles (multi-provider auth & model pool). */
  profiles?: ProviderProfile[];
  /** Role-to-profile ID bindings (`primary`, `fastTriage`, `backgroundDistill`, `embedding`). */
  activeProfileByRole?: AiActiveProfileByRole;
  /** Network egress / data-residency policy for outbound AI calls. */
  egressPolicy?: AiEgressPolicy;
  /** Explicit Zero Data Retention confirmation for external endpoints. */
  zdrConfirmed?: boolean;
  /** PII scrubbing mode applied before context leaves the device. */
  piiScrubbing?: AiPiiScrubbingMode;
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
  profileApiKeys?: Record<string, string | null>;
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
  anthropic: "claude-opus-5-5",
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
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
    "claude-fable-5-2",
  ],
  "openai-compatible": [],
};

export const DEFAULT_AI_CONFIG: AiConfig = {
  enabled: false,
  provider: "anthropic",
  model: DEFAULT_AI_MODELS.anthropic,
  useHermes: true,
};
