import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { app } from "electron";
import { DEFAULT_PROVIDER_MODELS } from "../../shared/types/ai";

export const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const REFRESH_SKEW_SECONDS = 120;

export interface CodexCredentials {
  accessToken: string;
  refreshToken: string;
  baseUrl: string;
  accountId?: string;
  email?: string;
  residency?: string;
  defaultModel?: string;
}

interface AuthStoreShape {
  version?: number;
  active_provider?: string;
  providers?: {
    "openai-codex"?: {
      tokens?: {
        access_token?: string;
        refresh_token?: string;
      };
      last_refresh?: string;
      auth_mode?: string;
    };
  };
  tokens?: {
    access_token?: string;
    refresh_token?: string;
  };
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return {};
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function isTokenExpiring(accessToken: string, skewSeconds = REFRESH_SKEW_SECONDS): boolean {
  const claims = decodeJwtPayload(accessToken);
  const exp = claims.exp;
  if (typeof exp !== "number") return false;
  return exp <= Date.now() / 1000 + skewSeconds;
}

export function extractCodexClaims(accessToken: string): {
  accountId?: string;
  email?: string;
  residency?: string;
} {
  const claims = decodeJwtPayload(accessToken);
  const auth = (claims["https://api.openai.com/auth"] ?? {}) as Record<string, unknown>;
  const profile = (claims["https://api.openai.com/profile"] ?? {}) as Record<string, unknown>;
  const accountId = typeof auth.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
  const email =
    typeof profile.email === "string"
      ? profile.email
      : typeof claims.email === "string"
        ? claims.email
        : undefined;
  const rawResidency = auth.chatgpt_data_residency ?? auth.chatgpt_compute_residency;
  const residency = typeof rawResidency === "string" && rawResidency.trim() ? rawResidency.trim() : undefined;
  return { accountId, email, residency };
}

export function buildCodexHeaders(accessToken: string, baseUrl = DEFAULT_CODEX_BASE_URL): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "User-Agent": "HermesAgent/0.17.6",
    originator: baseUrl.includes("chatgpt.com") ? "hermes-agent" : "codex_cli_rs",
  };
  const { accountId, residency } = extractCodexClaims(accessToken);
  if (accountId) headers["ChatGPT-Account-ID"] = accountId;
  if (residency) headers["x-openai-internal-codex-residency"] = residency;
  return headers;
}

export class CodexAuthProvider {
  private readonly baseDir: string;
  private readonly isCustomDir: boolean;

  constructor(baseDir?: string) {
    if (baseDir) {
      this.baseDir = baseDir;
      this.isCustomDir = true;
    } else {
      this.isCustomDir = false;
      try {
        this.baseDir = app.getPath("userData");
      } catch {
        this.baseDir = path.join(os.homedir(), ".sshs3");
      }
    }
  }

  private candidateAuthPaths(): string[] {
    const paths = [
      path.join(this.baseDir, "hermes-native", "auth.json"),
      path.join(this.baseDir, "ai-auth.json"),
    ];
    if (!this.isCustomDir) {
      paths.push(
        path.join(os.homedir(), ".codex", "auth.json"),
        path.join(os.homedir(), ".sshs3", "hermes-native", "auth.json"),
      );
    }
    return paths;
  }

  private async readConfiguredModel(): Promise<string | undefined> {
    try {
      const cfgPath = path.join(this.baseDir, "hermes-native", "config.yaml");
      const raw = (await fs.readFile(cfgPath, "utf8")).replace(/^\uFEFF/, "");
      const match = /^\s*default:\s*["']?([^"'\r\n]+)["']?/m.exec(raw);
      return match?.[1]?.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  async getAvailableModels(): Promise<string[]> {
    const configured = await this.readConfiguredModel();
    try {
      const cachePath = path.join(this.baseDir, "hermes-native", "provider_models_cache.json");
      const raw = (await fs.readFile(cachePath, "utf8")).replace(/^\uFEFF/, "");
      const parsed = JSON.parse(raw) as Record<
        string,
        { models?: unknown }
      >;
      const cached = parsed?.["openai-codex"]?.models;
      if (Array.isArray(cached)) {
        const models = cached
          .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          .map((item) => item.trim());
        if (configured && !models.includes(configured)) {
          models.unshift(configured);
        }
        if (models.length > 0) return models;
      }
    } catch {
      // fall through to defaults
    }
    const defaults = [...DEFAULT_PROVIDER_MODELS["openai-codex"]];
    if (configured && !defaults.includes(configured)) {
      defaults.unshift(configured);
    }
    return defaults;
  }

  async getStatus(): Promise<{ connected: boolean; email?: string; defaultModel?: string }> {
    for (const file of this.candidateAuthPaths()) {
      try {
        const raw = (await fs.readFile(file, "utf8")).replace(/^\uFEFF/, "");
        const parsed = JSON.parse(raw) as AuthStoreShape;
        const tokens = parsed.providers?.["openai-codex"]?.tokens ?? parsed.tokens;
        if (tokens?.access_token && tokens?.refresh_token) {
          const { email } = extractCodexClaims(tokens.access_token);
          const defaultModel = await this.readConfiguredModel();
          return { connected: true, email, defaultModel };
        }
      } catch {
        // continue
      }
    }
    return { connected: false };
  }

  async resolveCredentials(fetchImpl: typeof fetch = fetch): Promise<CodexCredentials | null> {
    for (const file of this.candidateAuthPaths()) {
      try {
        const raw = (await fs.readFile(file, "utf8")).replace(/^\uFEFF/, "");
        const parsed = JSON.parse(raw) as AuthStoreShape;
        const tokens = parsed.providers?.["openai-codex"]?.tokens ?? parsed.tokens;
        if (!tokens?.access_token || !tokens?.refresh_token) continue;

        let accessToken = tokens.access_token.trim();
        let refreshToken = tokens.refresh_token.trim();

        if (isTokenExpiring(accessToken)) {
          const refreshed = await this.refreshTokens(refreshToken, fetchImpl);
          if (refreshed) {
            accessToken = refreshed.accessToken;
            refreshToken = refreshed.refreshToken;
            await this.persistRefreshedTokens(file, parsed, accessToken, refreshToken);
          }
        }

        const claims = extractCodexClaims(accessToken);
        const defaultModel = await this.readConfiguredModel();
        return {
          accessToken,
          refreshToken,
          baseUrl: DEFAULT_CODEX_BASE_URL,
          ...claims,
          defaultModel,
        };
      } catch {
        // try next candidate
      }
    }
    return null;
  }

  private async refreshTokens(
    refreshToken: string,
    fetchImpl: typeof fetch,
  ): Promise<{ accessToken: string; refreshToken: string } | null> {
    try {
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CODEX_OAUTH_CLIENT_ID,
      });
      const res = await fetchImpl(CODEX_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          "User-Agent": "hermes-cli/0.17.6",
        },
        body: body.toString(),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return null;
      const payload = (await res.json()) as { access_token?: string; refresh_token?: string };
      if (!payload.access_token) return null;
      return {
        accessToken: payload.access_token.trim(),
        refreshToken: (payload.refresh_token || refreshToken).trim(),
      };
    } catch {
      return null;
    }
  }

  private async persistRefreshedTokens(
    filePath: string,
    store: AuthStoreShape,
    accessToken: string,
    refreshToken: string,
  ): Promise<void> {
    try {
      if (store.providers?.["openai-codex"]?.tokens) {
        store.providers["openai-codex"].tokens.access_token = accessToken;
        store.providers["openai-codex"].tokens.refresh_token = refreshToken;
        store.providers["openai-codex"].last_refresh = new Date().toISOString();
      } else if (store.tokens) {
        store.tokens.access_token = accessToken;
        store.tokens.refresh_token = refreshToken;
      }
      const tmp = `${filePath}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
      await fs.rename(tmp, filePath);
    } catch {
      // Best-effort token cache update
    }
  }
}
