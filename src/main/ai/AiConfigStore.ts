import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { app } from 'electron';
import { DEFAULT_AI_CONFIG, type AiConfig, type AiConfigUpdate, type AiConfigView, type AiProvider } from '../../shared/types/ai';
import { decryptSecretValue, encryptSecretValue } from '../crypto/SecretFieldCrypto';

interface StoredAiConfig extends AiConfig {
  /** safeStorage ciphertext (plaintext only when no OS keyring exists, as for saved profiles). */
  apiKey?: string;
}

const PROVIDERS: AiProvider[] = ['anthropic', 'openai-compatible'];

/**
 * Persists the AI assistant's configuration in its own file (ai-config.json), not in
 * settings.json: settings are part of remote profile sync, and an API key, or the choice
 * to send terminal text to a third party at all, should stay on the machine where it was made.
 */
export class AiConfigStore {
  private filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(customPath?: string) {
    if (customPath) {
      this.filePath = customPath;
    } else {
      let baseDir: string;
      try {
        baseDir = app.getPath('userData');
      } catch {
        baseDir = path.join(os.homedir(), '.sshs3');
      }
      this.filePath = path.join(baseDir, 'ai-config.json');
    }
  }

  public getFilePath(): string {
    return this.filePath;
  }

  /** The configuration including the decrypted API key. Main process only. */
  public async getConfig(): Promise<AiConfig & { apiKey: string }> {
    const stored = await this.read();
    return { ...this.publicFields(stored), apiKey: stored.apiKey ? decryptSecretValue(stored.apiKey) : '' };
  }

  public async getView(): Promise<AiConfigView> {
    const config = await this.getConfig();
    const { apiKey, ...rest } = config;
    return { ...rest, hasApiKey: Boolean(apiKey) };
  }

  public async update(update: AiConfigUpdate): Promise<AiConfigView> {
    await this.queueMutation(async () => {
      const current = await this.read();
      const next: StoredAiConfig = { ...current };
      if (update.enabled !== undefined) next.enabled = Boolean(update.enabled);
      if (update.provider !== undefined) {
        if (!PROVIDERS.includes(update.provider)) throw new Error('Unknown AI provider');
        next.provider = update.provider;
      }
      if (update.model !== undefined) next.model = update.model.trim();
      if (update.baseUrl !== undefined) {
        const baseUrl = update.baseUrl.trim();
        if (baseUrl) assertHttpUrl(baseUrl);
        next.baseUrl = baseUrl || undefined;
      }
      if (update.apiKey === null || update.apiKey === '') delete next.apiKey;
      else if (typeof update.apiKey === 'string') next.apiKey = encryptSecretValue(update.apiKey.trim());
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(next, null, 2), { encoding: 'utf-8', mode: 0o600 });
      try {
        await fs.chmod(this.filePath, 0o600);
      } catch {
        // Ignore chmod failures on non-POSIX filesystems
      }
    });
    return this.getView();
  }

  private async read(): Promise<StoredAiConfig> {
    try {
      const data = JSON.parse(await fs.readFile(this.filePath, 'utf-8')) as Partial<StoredAiConfig>;
      return { ...DEFAULT_AI_CONFIG, ...data } as StoredAiConfig;
    } catch {
      return { ...DEFAULT_AI_CONFIG };
    }
  }

  private publicFields(stored: StoredAiConfig): AiConfig {
    return {
      enabled: stored.enabled === true,
      provider: PROVIDERS.includes(stored.provider) ? stored.provider : DEFAULT_AI_CONFIG.provider,
      model: typeof stored.model === 'string' && stored.model ? stored.model : DEFAULT_AI_CONFIG.model,
      ...(typeof stored.baseUrl === 'string' && stored.baseUrl ? { baseUrl: stored.baseUrl } : {}),
    };
  }

  private queueMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const resultPromise = this.writeQueue.then(mutation, mutation);
    this.writeQueue = resultPromise.then(
      () => {},
      () => {}
    );
    return resultPromise;
  }
}

function assertHttpUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('The endpoint must be a full URL, e.g. http://localhost:11434/v1');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('The endpoint must use http or https');
  }
  if (url.username || url.password) {
    throw new Error('Put credentials in the API key field, not in the endpoint URL');
  }
}
