import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { app } from "electron";
import { DEFAULT_PROVIDER_MODELS } from "../../shared/types/ai";
import { isLoopbackHttpUrl } from "../ca/loopbackUrl";
import {
  buildRedirectUri,
  generatePkce,
  generateState,
  parseCallback,
  sanitizeServerText,
  startCallbackServer,
  statesEqual,
} from "../oauth/loopbackAuth";

export const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_OAUTH_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CODEX_OAUTH_DEFAULT_SCOPE = "openid profile email offline_access";
export const CODEX_OAUTH_CALLBACK_PATH = "/auth/callback";
const REFRESH_SKEW_SECONDS = 120;
const PKCE_LOGIN_TIMEOUT_MS = 180_000;
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;

export interface CodexCredentials {
  accessToken: string;
  refreshToken: string;
  baseUrl: string;
  accountId?: string;
  email?: string;
  residency?: string;
  defaultModel?: string;
}

export interface CodexRefreshErrorInfo {
  message: string;
  statusCode?: number;
  oauthError?: string;
  retryable: boolean;
  timestamp: number;
}

export type CodexRefreshResult =
  | { ok: true; credentials: CodexCredentials }
  | { ok: false; error: string; statusCode?: number; oauthError?: string; retryable: boolean };

export interface CodexPkceLoginOptions {
  openBrowser?: (url: string) => Promise<void>;
  signal?: AbortSignal;
  timeoutMs?: number;
  requestedPort?: number;
  fallbackToEphemeral?: boolean;
  callbackPath?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  clientId?: string;
  scope?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  allowHttpForTests?: boolean;
}

export interface CodexWebPkceStartOptions {
  redirectUri: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  authorizeUrl?: string;
  tokenUrl?: string;
  clientId?: string;
  scope?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  allowHttpForTests?: boolean;
}

export interface CodexWebPkceStart {
  state: string;
  authorizationUrl: string;
  redirectUri: string;
  expiresAt: number;
  completion: Promise<CodexCredentials>;
}

export interface CodexWebCallbackInput {
  state?: string | null;
  code?: string | null;
  error?: string | null;
  error_description?: string | null;
}

export type CodexWebCallbackResult =
  | { ok: true; credentials: CodexCredentials }
  | { ok: false; error: string };

interface PendingCodexWebFlow {
  state: string;
  expiresAt: number;
  resolveCode: (code: string) => void;
  rejectCode: (err: Error) => void;
  completion: Promise<CodexCredentials>;
  cleanup: () => void;
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

function validateOAuthEndpointUrl(rawUrl: string, label: string, allowHttpForTests = false): URL {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error(`Invalid Codex ${label} URL`);
  }
  if (url.username || url.password) {
    throw new Error(`Codex ${label} URL must not contain embedded credentials`);
  }
  const allowLoopback = isLoopbackHttpUrl(url.toString());
  if (url.protocol !== "https:" && !allowLoopback && !(allowHttpForTests && url.protocol === "http:")) {
    throw new Error(`Codex ${label} URL must use https (got ${url.protocol})`);
  }
  return url;
}

function validateRedirectUri(rawUrl: string, allowHttpForTests = false): string {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error("Invalid Codex OAuth redirect_uri");
  }
  if (url.username || url.password || url.hash) {
    throw new Error("Codex OAuth redirect_uri must not contain credentials or fragments");
  }
  if (url.protocol !== "https:" && !isLoopbackHttpUrl(url.toString()) && !(allowHttpForTests && url.protocol === "http:")) {
    throw new Error("Codex OAuth redirect_uri must use https or loopback http");
  }
  return url.toString();
}

function parseOAuthErrorBody(payload: unknown, statusCode: number): { message: string; oauthError?: string; retryable: boolean } {
  const obj = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : undefined;
  const rawErr =
    typeof obj?.error === "string"
      ? obj.error
      : obj?.error && typeof obj.error === "object" && typeof (obj.error as Record<string, unknown>).code === "string"
        ? String((obj.error as Record<string, unknown>).code)
        : undefined;
  const rawDesc =
    typeof obj?.error_description === "string"
      ? obj.error_description
      : obj?.error && typeof obj.error === "object" && typeof (obj.error as Record<string, unknown>).message === "string"
        ? String((obj.error as Record<string, unknown>).message)
        : typeof obj?.message === "string"
          ? obj.message
          : undefined;

  const oauthError = rawErr ? sanitizeServerText(rawErr) : undefined;
  const desc = rawDesc ? sanitizeServerText(rawDesc) : undefined;
  const summary = desc && oauthError && desc !== oauthError
    ? `${oauthError}: ${desc}`
    : desc || oauthError || `HTTP ${statusCode}`;

  const nonRetryableOAuth = new Set(["invalid_grant", "invalid_client", "unauthorized_client", "access_denied"]);
  const retryable =
    (!oauthError || !nonRetryableOAuth.has(oauthError)) &&
    (statusCode === 429 || statusCode === 408 || statusCode >= 500 || statusCode === 0);

  return {
    message: `Codex OAuth token request failed (${summary})`,
    oauthError,
    retryable,
  };
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
  private lastRefreshError?: CodexRefreshErrorInfo;
  private pendingWebFlows = new Map<string, PendingCodexWebFlow>();

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

  public getLastRefreshError(): CodexRefreshErrorInfo | undefined {
    return this.lastRefreshError ? { ...this.lastRefreshError } : undefined;
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

  private localAuthFilePath(): string {
    return path.join(this.baseDir, "ai-auth.json");
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
          const refreshed = await this.refreshTokensWithDiagnostics(
            refreshToken,
            fetchImpl,
            CODEX_OAUTH_TOKEN_URL,
          );
          if (refreshed.ok) {
            accessToken = refreshed.accessToken;
            refreshToken = refreshed.refreshToken;
            this.lastRefreshError = undefined;
            await this.persistRefreshedTokens(file, parsed, accessToken, refreshToken);
          } else {
            this.lastRefreshError = {
              message: refreshed.error,
              statusCode: refreshed.statusCode,
              oauthError: refreshed.oauthError,
              retryable: refreshed.retryable,
              timestamp: Date.now(),
            };
            if (isTokenExpiring(accessToken, 0)) {
              // This sign-in has run out and could not be renewed: it is of no use, and a later
              // file (a newer `codex login`, say) may hold one that works.
              continue;
            }
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

  /**
   * Explicitly refreshes the current Codex session's tokens and returns structured diagnostics
   * on failure (HTTP status, OAuth error code, retryability).
   */
  async refreshNow(
    fetchImpl: typeof fetch = fetch,
    tokenUrl = CODEX_OAUTH_TOKEN_URL,
    allowHttpForTests = false,
  ): Promise<CodexRefreshResult> {
    try {
      validateOAuthEndpointUrl(tokenUrl, "token", allowHttpForTests);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg, retryable: false };
    }

    for (const file of this.candidateAuthPaths()) {
      try {
        const raw = (await fs.readFile(file, "utf8")).replace(/^\uFEFF/, "");
        const parsed = JSON.parse(raw) as AuthStoreShape;
        const tokens = parsed.providers?.["openai-codex"]?.tokens ?? parsed.tokens;
        if (!tokens?.refresh_token) continue;

        const refreshed = await this.refreshTokensWithDiagnostics(
          tokens.refresh_token.trim(),
          fetchImpl,
          tokenUrl,
          allowHttpForTests,
        );
        if (!refreshed.ok) {
          this.lastRefreshError = {
            message: refreshed.error,
            statusCode: refreshed.statusCode,
            oauthError: refreshed.oauthError,
            retryable: refreshed.retryable,
            timestamp: Date.now(),
          };
          return {
            ok: false,
            error: refreshed.error,
            statusCode: refreshed.statusCode,
            oauthError: refreshed.oauthError,
            retryable: refreshed.retryable,
          };
        }

        this.lastRefreshError = undefined;
        await this.persistRefreshedTokens(file, parsed, refreshed.accessToken, refreshed.refreshToken);
        const claims = extractCodexClaims(refreshed.accessToken);
        const defaultModel = await this.readConfiguredModel();
        return {
          ok: true,
          credentials: {
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            baseUrl: DEFAULT_CODEX_BASE_URL,
            ...claims,
            defaultModel,
          },
        };
      } catch {
        // try next candidate
      }
    }
    return {
      ok: false,
      error: "No Codex refresh token is available. Sign in with ChatGPT / Codex first.",
      retryable: false,
    };
  }

  /**
   * In-app OAuth 2.0 PKCE login using a local loopback callback server (no external `codex login` CLI needed).
   */
  async loginWithPkce(options: CodexPkceLoginOptions = {}): Promise<CodexCredentials> {
    const signal = options.signal ?? new AbortController().signal;
    if (signal.aborted) {
      throw new Error("Codex sign-in was cancelled");
    }

    const allowHttpForTests = Boolean(options.allowHttpForTests);
    const authorizeUrl = validateOAuthEndpointUrl(
      options.authorizeUrl ?? CODEX_OAUTH_AUTHORIZE_URL,
      "authorize",
      allowHttpForTests,
    );
    const tokenUrl = validateOAuthEndpointUrl(
      options.tokenUrl ?? CODEX_OAUTH_TOKEN_URL,
      "token",
      allowHttpForTests,
    );
    const clientId = options.clientId?.trim() || CODEX_OAUTH_CLIENT_ID;
    const scope = options.scope?.trim() || CODEX_OAUTH_DEFAULT_SCOPE;
    const callbackPath = options.callbackPath ?? CODEX_OAUTH_CALLBACK_PATH;

    const pkce = generatePkce();
    const state = generateState();

    const startServer = async (port?: number) =>
      startCallbackServer({
        requestedPort: port,
        state,
        signal,
        timeoutMs: options.timeoutMs ?? PKCE_LOGIN_TIMEOUT_MS,
        callbackPath,
        providerName: "ChatGPT / Codex",
        successMessage: "ChatGPT / Codex sign-in complete. You can close this tab and return to sshs3.",
        onCancelError: () => new Error("Codex sign-in was cancelled"),
        timeoutMessage: "Timed out waiting for ChatGPT / Codex browser sign-in. Please try again.",
      });

    let callbackServer;
    try {
      callbackServer = await startServer(options.requestedPort);
    } catch (err) {
      const canFallback = options.requestedPort && options.fallbackToEphemeral !== false;
      if (canFallback && err instanceof Error && err.message.includes("already in use")) {
        callbackServer = await startServer(0);
      } else {
        throw err;
      }
    }

    let redirectUri: string;
    let code: string;
    try {
      redirectUri = buildRedirectUri(callbackServer.host, callbackServer.port, callbackPath);

      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", clientId);
      authorizeUrl.searchParams.set("redirect_uri", redirectUri);
      authorizeUrl.searchParams.set("scope", scope);
      authorizeUrl.searchParams.set("state", state);
      authorizeUrl.searchParams.set("code_challenge", pkce.challenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");
      authorizeUrl.searchParams.set("id_token_add_organizations", "true");
      authorizeUrl.searchParams.set("codex_cli_simplified_flow", "true");

      await this.openInBrowser(authorizeUrl.toString(), options.openBrowser);
      code = await callbackServer.waitForCode();
    } finally {
      callbackServer.close();
    }

    return this.exchangeAndPersistCode({
      code,
      redirectUri,
      codeVerifier: pkce.verifier,
      clientId,
      tokenUrl: tokenUrl.toString(),
      baseUrl: options.baseUrl ?? DEFAULT_CODEX_BASE_URL,
      fetchImpl: options.fetchImpl ?? fetch,
      signal,
    });
  }

  /**
   * Starts a web/headless OAuth 2.0 PKCE login where the callback is delivered to an HTTP endpoint
   * (e.g. `/api/ai/codex/callback`) and routed to `handleWebPkceCallback`.
   */
  async startWebPkceLogin(options: CodexWebPkceStartOptions): Promise<CodexWebPkceStart> {
    const allowHttpForTests = Boolean(options.allowHttpForTests);
    const redirectUri = validateRedirectUri(options.redirectUri, allowHttpForTests);
    const authorizeUrl = validateOAuthEndpointUrl(
      options.authorizeUrl ?? CODEX_OAUTH_AUTHORIZE_URL,
      "authorize",
      allowHttpForTests,
    );
    const tokenUrl = validateOAuthEndpointUrl(
      options.tokenUrl ?? CODEX_OAUTH_TOKEN_URL,
      "token",
      allowHttpForTests,
    );
    const clientId = options.clientId?.trim() || CODEX_OAUTH_CLIENT_ID;
    const scope = options.scope?.trim() || CODEX_OAUTH_DEFAULT_SCOPE;
    const ttlMs = Math.max(10_000, options.timeoutMs ?? PKCE_LOGIN_TIMEOUT_MS);

    const pkce = generatePkce();
    const state = generateState();

    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("scope", scope);
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("code_challenge", pkce.challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("id_token_add_organizations", "true");
    authorizeUrl.searchParams.set("codex_cli_simplified_flow", "true");

    let settled = false;
    let resolveCode!: (code: string) => void;
    let rejectCode!: (err: Error) => void;
    const codePromise = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });
    codePromise.catch(() => {});

    const expiresAt = Date.now() + ttlMs;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectCode(new Error("Timed out waiting for ChatGPT / Codex web sign-in."));
    }, ttlMs);

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectCode(new Error("Codex sign-in was cancelled"));
    };

    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      this.pendingWebFlows.delete(state);
    };

    if (options.signal?.aborted) {
      cleanup();
      throw new Error("Codex sign-in was cancelled");
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const flowEntry: PendingCodexWebFlow = {
      state,
      expiresAt,
      resolveCode: (code: string) => {
        if (settled) return;
        settled = true;
        resolveCode(code);
      },
      rejectCode: (err: Error) => {
        if (settled) return;
        settled = true;
        rejectCode(err);
      },
      completion: Promise.resolve({} as CodexCredentials),
      cleanup,
    };
    this.pendingWebFlows.set(state, flowEntry);

    const completion = (async (): Promise<CodexCredentials> => {
      try {
        const code = await codePromise;
        return await this.exchangeAndPersistCode({
          code,
          redirectUri,
          codeVerifier: pkce.verifier,
          clientId,
          tokenUrl: tokenUrl.toString(),
          baseUrl: options.baseUrl ?? DEFAULT_CODEX_BASE_URL,
          fetchImpl: options.fetchImpl ?? fetch,
          signal: options.signal,
        });
      } finally {
        cleanup();
      }
    })();

    flowEntry.completion = completion;

    return {
      state,
      authorizationUrl: authorizeUrl.toString(),
      redirectUri,
      expiresAt,
      completion,
    };
  }

  /** Delivers a web-relayed callback query/payload to a pending `startWebPkceLogin` flow. */
  async handleWebPkceCallback(
    input: string | URLSearchParams | CodexWebCallbackInput,
  ): Promise<CodexWebCallbackResult> {
    const rawState = this.extractStateFromInput(input);
    const pending = rawState ? this.findPendingWebFlow(rawState) : undefined;
    if (!pending) {
      return { ok: false, error: "Invalid or expired Codex OAuth state" };
    }
    if (Date.now() > pending.expiresAt) {
      pending.cleanup();
      const err = new Error("Timed out waiting for ChatGPT / Codex web sign-in.");
      pending.rejectCode(err);
      return { ok: false, error: err.message };
    }

    const searchStr =
      typeof input === "string"
        ? input
        : input instanceof URLSearchParams
          ? input.toString()
          : new URLSearchParams(
              Object.entries(input)
                .filter(([, v]) => typeof v === "string")
                .map(([k, v]) => [k, v as string]),
            ).toString();

    const outcome = parseCallback(searchStr, pending.state, "ChatGPT / Codex");
    if (outcome.kind === "state-mismatch") {
      return { ok: false, error: "Invalid or expired Codex OAuth state" };
    }
    if (outcome.kind === "error") {
      pending.cleanup();
      pending.rejectCode(new Error(outcome.message));
      await pending.completion.catch(() => {});
      return { ok: false, error: outcome.message };
    }

    pending.cleanup();
    pending.resolveCode(outcome.code);
    try {
      const credentials = await pending.completion;
      return { ok: true, credentials };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  cancelPendingWebLogin(state?: string): void {
    if (state) {
      const entry = this.findPendingWebFlow(state);
      if (entry) {
        entry.cleanup();
        entry.rejectCode(new Error("Codex sign-in was cancelled"));
      }
      return;
    }
    for (const entry of [...this.pendingWebFlows.values()]) {
      entry.cleanup();
      entry.rejectCode(new Error("Codex sign-in was cancelled"));
    }
  }

  async signOut(): Promise<void> {
    this.cancelPendingWebLogin();
    this.lastRefreshError = undefined;
    try {
      await fs.unlink(this.localAuthFilePath());
    } catch {
      // ignore if absent
    }
  }

  private extractStateFromInput(input: string | URLSearchParams | CodexWebCallbackInput): string | null {
    if (typeof input === "string") {
      return new URLSearchParams(input.startsWith("?") ? input.slice(1) : input).get("state");
    }
    if (input instanceof URLSearchParams) {
      return input.get("state");
    }
    return input.state ?? null;
  }

  private findPendingWebFlow(candidateState: string): PendingCodexWebFlow | undefined {
    let matched: PendingCodexWebFlow | undefined;
    for (const entry of this.pendingWebFlows.values()) {
      if (statesEqual(candidateState, entry.state)) {
        matched = entry;
      }
    }
    return matched;
  }

  private async openInBrowser(url: string, openBrowser?: (url: string) => Promise<void>): Promise<void> {
    if (openBrowser) {
      await openBrowser(url);
      return;
    }
    const { shell } = await import("electron");
    await shell.openExternal(url);
  }

  private async exchangeAndPersistCode(params: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
    clientId: string;
    tokenUrl: string;
    baseUrl: string;
    fetchImpl: typeof fetch;
    signal?: AbortSignal;
  }): Promise<CodexCredentials> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: params.clientId,
      code: params.code,
      redirect_uri: params.redirectUri,
      code_verifier: params.codeVerifier,
    });

    const timeoutSignal = AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS);
    const signal = params.signal ? AbortSignal.any([params.signal, timeoutSignal]) : timeoutSignal;

    const res = await params.fetchImpl(params.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": "hermes-cli/0.17.6",
      },
      body: body.toString(),
      signal,
    });

    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      payload = undefined;
    }

    if (!res.ok) {
      const parsedErr = parseOAuthErrorBody(payload, res.status);
      throw new Error(parsedErr.message);
    }

    const tokens = payload as { access_token?: string; refresh_token?: string };
    const accessToken = typeof tokens?.access_token === "string" ? tokens.access_token.trim() : "";
    const refreshToken = typeof tokens?.refresh_token === "string" ? tokens.refresh_token.trim() : "";
    if (!accessToken || !refreshToken) {
      throw new Error("Codex OAuth token response missing access_token or refresh_token");
    }

    await this.saveLocalTokens(accessToken, refreshToken);
    this.lastRefreshError = undefined;
    const claims = extractCodexClaims(accessToken);
    const defaultModel = await this.readConfiguredModel();
    return {
      accessToken,
      refreshToken,
      baseUrl: params.baseUrl,
      ...claims,
      defaultModel,
    };
  }

  private async saveLocalTokens(accessToken: string, refreshToken: string): Promise<void> {
    const filePath = this.localAuthFilePath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const store: AuthStoreShape = {
      version: 1,
      active_provider: "openai-codex",
      providers: {
        "openai-codex": {
          tokens: {
            access_token: accessToken,
            refresh_token: refreshToken,
          },
          last_refresh: new Date().toISOString(),
          auth_mode: "pkce",
        },
      },
    };
    const tmp = `${filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmp, filePath);
    try {
      await fs.chmod(filePath, 0o600);
    } catch {
      // Ignore chmod failures on non-POSIX filesystems
    }
  }

  private async refreshTokensWithDiagnostics(
    refreshToken: string,
    fetchImpl: typeof fetch,
    tokenUrl: string,
    allowHttpForTests = false,
  ): Promise<
    | { ok: true; accessToken: string; refreshToken: string }
    | { ok: false; error: string; statusCode?: number; oauthError?: string; retryable: boolean }
  > {
    try {
      validateOAuthEndpointUrl(tokenUrl, "token", allowHttpForTests);
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CODEX_OAUTH_CLIENT_ID,
      });
      const res = await fetchImpl(tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          "User-Agent": "hermes-cli/0.17.6",
        },
        body: body.toString(),
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
      });

      let payload: unknown;
      try {
        payload = await res.json();
      } catch {
        payload = undefined;
      }

      if (!res.ok) {
        const parsedErr = parseOAuthErrorBody(payload, res.status);
        return {
          ok: false,
          error: parsedErr.message,
          statusCode: res.status,
          oauthError: parsedErr.oauthError,
          retryable: parsedErr.retryable,
        };
      }

      const tokens = payload as { access_token?: string; refresh_token?: string };
      if (!tokens?.access_token || typeof tokens.access_token !== "string") {
        return {
          ok: false,
          error: "Codex OAuth refresh response missing access_token",
          statusCode: res.status,
          retryable: false,
        };
      }
      return {
        ok: true,
        accessToken: tokens.access_token.trim(),
        refreshToken:
          typeof tokens.refresh_token === "string" && tokens.refresh_token.trim()
            ? tokens.refresh_token.trim()
            : refreshToken,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        retryable: true,
      };
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
