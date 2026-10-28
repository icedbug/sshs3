import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { app } from "electron";
import {
  DEFAULT_AI_CONFIG,
  DEFAULT_AI_MODELS,
  type AiConfig,
  type AiConfigUpdate,
  type AiConfigView,
  type AiProvider,
} from "../../shared/types/ai";
import { CodexAuthProvider } from "./CodexAuthProvider";
import {
  decryptSecretValue,
  encryptSecretValue,
  isEncryptedSecret,
  isEncryptionAvailable,
} from "../crypto/SecretFieldCrypto";

interface StoredAiConfig extends AiConfig {
  /** OS-keyring ciphertext. New keys remain session-only if encryption is unavailable. */
  apiKey?: string;
}

const PROVIDERS: AiProvider[] = ["openai-codex", "anthropic", "openai-compatible"];

/**
 * Persists the AI assistant's configuration in its own file (ai-config.json), not in
 * settings.json: settings are part of remote profile sync, and an API key, or the choice
 * to send terminal text to a third party at all, should stay on the machine where it was made.
 */
export class AiConfigStore {
  private filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();
  private sessionKey = "";

  constructor(customPath?: string) {
    if (customPath) {
      this.filePath = customPath;
    } else {
      let baseDir: string;
      try {
        baseDir = app.getPath("userData");
      } catch {
        baseDir = path.join(os.homedir(), ".sshs3");
      }
      this.filePath = path.join(baseDir, "ai-config.json");
    }
  }

  public getFilePath(): string {
    return this.filePath;
  }

  /** The configuration including the decrypted API key. Main process only. */
  public async getConfig(): Promise<AiConfig & { apiKey: string }> {
    const stored = await this.readWithCodexAutoDetect();
    return {
      ...this.publicFields(stored),
      apiKey:
        this.sessionKey ||
        (stored.apiKey ? decryptSecretValue(stored.apiKey) : ""),
    };
  }

  public async getView(): Promise<AiConfigView> {
    const config = await this.getConfig();
    const { apiKey, ...rest } = config;
    const codexProvider = new CodexAuthProvider(path.dirname(this.filePath));
    const codex = await codexProvider.getStatus();
    const codexModels = await codexProvider.getAvailableModels();
    const hasOAuth = rest.provider === "openai-codex" && codex.connected;
    return {
      ...rest,
      hasApiKey: Boolean(apiKey) || hasOAuth,
      keyStorage: this.sessionKey ? "session" : hasOAuth && !apiKey ? "oauth" : "encrypted",
      codexConnected: codex.connected,
      codexAccountEmail: codex.email,
      codexDefaultModel: codex.defaultModel || DEFAULT_AI_MODELS["openai-codex"],
      codexModels,
    };
  }

  public async update(update: AiConfigUpdate): Promise<AiConfigView> {
    await this.queueMutation(async () => {
      const current = await this.read();
      const next: StoredAiConfig = { ...current };
      if (update.enabled !== undefined) next.enabled = Boolean(update.enabled);
      if (update.provider !== undefined) {
        if (!PROVIDERS.includes(update.provider))
          throw new Error("Unknown AI provider");
        next.provider = update.provider;
      }
      if (update.model !== undefined) next.model = update.model.trim();
      if (update.actorName !== undefined) {
        const actor = update.actorName.trim().slice(0, 80);
        if (actor) next.actorName = actor;
        else delete next.actorName;
      }
      if (update.useHermes !== undefined)
        next.useHermes = Boolean(update.useHermes);
      if (update.baseUrl !== undefined) {
        const baseUrl = update.baseUrl.trim();
        if (baseUrl) assertHttpUrl(baseUrl);
        next.baseUrl = baseUrl || undefined;
      }
      if (next.provider === "openai-codex") {
        if (next.baseUrl && next.baseUrl.includes("openrouter.ai")) {
          delete next.baseUrl;
        }
        if (isStaleOrNonCodexModel(next.model)) {
          const codex = await new CodexAuthProvider(path.dirname(this.filePath)).getStatus();
          next.model = codex.defaultModel || DEFAULT_AI_MODELS["openai-codex"];
        }
      }
      if (update.apiKey === null || update.apiKey === "") {
        delete next.apiKey;
        this.sessionKey = "";
      } else if (typeof update.apiKey === "string") {
        const encrypted = isEncryptionAvailable()
          ? encryptSecretValue(update.apiKey.trim())
          : "";
        if (isEncryptedSecret(encrypted)) {
          next.apiKey = encrypted;
          this.sessionKey = "";
        } else {
          this.sessionKey = update.apiKey.trim();
          delete next.apiKey;
        }
      }
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(
        this.filePath + ".tmp",
        JSON.stringify(next, null, 2),
        { encoding: "utf-8", mode: 0o600 },
      );
      await fs.rename(this.filePath + ".tmp", this.filePath);
      try {
        await fs.chmod(this.filePath, 0o600);
      } catch {
        // Ignore chmod failures on non-POSIX filesystems
      }
    });
    return this.getView();
  }

  private async readWithCodexAutoDetect(): Promise<StoredAiConfig> {
    try {
      const raw = stripBom(await fs.readFile(this.filePath, "utf-8"));
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new SyntaxError("Invalid AI config JSON");
      }
      const data = parsed as Partial<StoredAiConfig>;
      const merged = { ...DEFAULT_AI_CONFIG, ...data } as StoredAiConfig;
      const hasStoredKey = Boolean(data.apiKey || this.sessionKey);
      const isUnconfiguredDefault =
        !hasStoredKey &&
        (((!data.provider || data.provider === "anthropic") &&
          (!data.model || data.model === DEFAULT_AI_MODELS.anthropic)) ||
          (data.provider === "openai-compatible" && !data.baseUrl));
      const isLegacyStaleCodexConfig =
        isStaleOrNonCodexModel(data.model) &&
        (!hasStoredKey ||
          data.provider === "openai-codex" ||
          (data.provider === "openai-compatible" &&
            (!data.baseUrl || data.baseUrl.includes("openrouter.ai"))));

      if (isUnconfiguredDefault || isLegacyStaleCodexConfig) {
        const codex = await new CodexAuthProvider(path.dirname(this.filePath)).getStatus();
        if (codex.connected) {
          return {
            ...merged,
            enabled: true,
            provider: "openai-codex",
            model: codex.defaultModel || DEFAULT_AI_MODELS["openai-codex"],
            baseUrl: undefined,
            useHermes: false,
          };
        }
      }
      if (merged.provider === "openai-codex") {
        if (merged.baseUrl && merged.baseUrl.includes("openrouter.ai")) {
          delete merged.baseUrl;
        }
        if (isStaleOrNonCodexModel(merged.model)) {
          const codex = await new CodexAuthProvider(path.dirname(this.filePath)).getStatus();
          merged.model = codex.defaultModel || DEFAULT_AI_MODELS["openai-codex"];
        }
      }
      return merged;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" &&
        !(error instanceof SyntaxError)
      ) {
        throw error;
      }
      const codex = await new CodexAuthProvider(path.dirname(this.filePath)).getStatus();
      if (codex.connected) {
        return {
          ...DEFAULT_AI_CONFIG,
          enabled: true,
          provider: "openai-codex",
          model: codex.defaultModel || DEFAULT_AI_MODELS["openai-codex"],
          useHermes: false,
        };
      }
      return { ...DEFAULT_AI_CONFIG };
    }
  }

  private async read(): Promise<StoredAiConfig> {
    try {
      const raw = stripBom(await fs.readFile(this.filePath, "utf-8"));
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new SyntaxError("Invalid AI config JSON");
      }
      const data = parsed as Partial<StoredAiConfig>;
      return { ...DEFAULT_AI_CONFIG, ...data } as StoredAiConfig;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { ...DEFAULT_AI_CONFIG };
    }
  }

  private publicFields(stored: StoredAiConfig): AiConfig {
    return {
      enabled: stored.enabled === true,
      provider: PROVIDERS.includes(stored.provider)
        ? stored.provider
        : DEFAULT_AI_CONFIG.provider,
      model:
        typeof stored.model === "string" && stored.model
          ? stored.model
          : DEFAULT_AI_CONFIG.model,
      ...(typeof stored.baseUrl === "string" && stored.baseUrl
        ? { baseUrl: stored.baseUrl }
        : {}),
      ...(typeof stored.actorName === "string" && stored.actorName
        ? { actorName: stored.actorName }
        : {}),
      useHermes: stored.useHermes === true,
    };
  }

  private queueMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const resultPromise = this.writeQueue.then(mutation, mutation);
    this.writeQueue = resultPromise.then(
      () => {},
      () => {},
    );
    return resultPromise;
  }
}

export function isStaleOrNonCodexModel(model?: string): boolean {
  if (!model) return true;
  const trimmed = model.trim();
  if (!trimmed) return true;
  return (
    trimmed === "gpt-sol-latest" ||
    trimmed === "local" ||
    trimmed === "gpt-5.3-codex" ||
    trimmed === "gpt-5.4" ||
    trimmed === "gpt-5.4-mini" ||
    trimmed === "gpt-5.2-codex" ||
    trimmed === "gpt-5.1-codex-max" ||
    trimmed.startsWith("claude-")
  );
}

function stripBom(text: string): string {
  return text.replace(/^\uFEFF/, "");
}

function assertHttpUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "The endpoint must be a full URL, e.g. http://localhost:11434/v1",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The endpoint must use http or https");
  }
  if (url.username || url.password) {
    throw new Error(
      "Put credentials in the API key field, not in the endpoint URL",
    );
  }
}
