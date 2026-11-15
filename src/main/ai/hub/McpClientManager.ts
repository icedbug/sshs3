import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import { spawn, type ChildProcess } from "node:child_process";
import type { McpServerConfig, McpToolSummary } from "../../../shared/types/aiHub";
import { guardUrl, type GuardOptions, type GuardedTarget } from "./Notifier";

/**
 * Talking to other people's MCP servers.
 *
 * Two things are kept straight here, because getting either wrong lets a
 * server do more than it was given:
 *
 * - The name the model is offered and the name that is run must be built by
 *   the same rule, and a name must resolve to a tool the server actually
 *   said it has. Anything else is a way to call something nobody listed.
 * - A disabled server, and a server this agent was not given, must be
 *   unreachable at the moment of the call, not only absent from the list.
 *
 * What a server sends back is somebody else's text. It is carried as data,
 * capped, and marked as such before it goes anywhere near a model.
 */

export interface McpToolWithHints extends McpToolSummary {
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpDiscoveredTool extends McpToolWithHints {
  serverId: string;
  serverName: string;
  qualifiedName: string;
}

export const MCP_PREFIX = "mcp__";
/** How much of one answer is kept. A server cannot fill a model's context. */
export const MAX_RESULT_CHARS = 40_000;
const MAX_DESCRIPTION_CHARS = 2000;
const MAX_STDIO_BYTES = 8 * 1024 * 1024;
const MAX_LIST_PAGES = 100;
/** A preset runs `npx -y …`, which fetches the package the first time. */
const DISCOVER_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 60_000;
export const DEFAULT_IDLE_TTL_MS = 5 * 60_000;
const PROTOCOL_VERSION = "2025-06-18";

/**
 * The part of a name that stands for a server or a tool. One rule, used both
 * where the name is offered and where it is resolved; `sanitizeId` is
 * exported so that nothing has to copy it.
 */
export function sanitizeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40) || "mcp";
}

const clamp = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

export interface McpElicitationRequest {
  mode: "url";
  serverId: string;
  serverName: string;
  message: string;
  url: string;
  elicitationId?: string;
}

export interface McpElicitationResponse {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

export interface McpCallResult {
  ok: boolean;
  output?: unknown;
  error?: string;
  elicitations?: McpElicitationRequest[];
}

export interface McpClientOptions {
  idleTtlMs?: number;
  /** The rules an address must meet; a function when they change while the app runs (a server gains a second account). */
  guardOptions?: Partial<GuardOptions> | (() => Partial<GuardOptions>);
  lookup?: GuardOptions["lookup"];
  onToolsListChanged?: (serverId: string) => void;
  onElicitation?: (request: McpElicitationRequest) => Promise<McpElicitationResponse | void> | McpElicitationResponse | void;
}

export interface McpSearchOptions {
  query?: string;
  serverId?: string;
  serverIds?: string[];
  readOnlyOnly?: boolean;
  excludeDestructive?: boolean;
  limit?: number;
}

export interface OAuthProtectedResourceMetadata {
  resource: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
  bearer_methods_supported?: string[];
  resource_documentation?: string;
  [key: string]: unknown;
}

export interface OAuthAuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  response_types_supported?: string[];
  code_challenge_methods_supported?: string[];
  [key: string]: unknown;
}

export interface McpOAuthDiscoveryResult {
  resourceUrl: string;
  protectedResourceMetadataUrl: string;
  protectedResource: OAuthProtectedResourceMetadata;
  authorizationServerIssuer: string;
  authorizationServerMetadataUrl: string;
  authorizationServer: OAuthAuthorizationServerMetadata;
  pkceSupported: boolean;
}

/** Deterministic hash of a server's connection/auth config for session pool keying. */
export function serverConfigHash(server: McpServerConfig): string {
  const payload =
    server.transport === "http"
      ? {
          id: server.id,
          transport: "http",
          url: server.url?.trim() ?? "",
          headers: Object.entries(server.headers ?? {}).sort(([a], [b]) => a.localeCompare(b)),
          oauth: server.oauth
            ? {
                enabled: Boolean(server.oauth.enabled),
                clientId: server.oauth.clientId ?? "",
                scopes: [...(server.oauth.scopes ?? [])].sort(),
              }
            : undefined,
        }
      : {
          id: server.id,
          transport: "stdio",
          command: server.command?.trim() ?? "",
          args: server.args ?? [],
          env: Object.entries(server.env ?? {}).sort(([a], [b]) => a.localeCompare(b)),
        };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
}

export function serverSessionKey(server: McpServerConfig): string {
  return `${server.id}:${serverConfigHash(server)}`;
}

/** Deprecated MCP method that must never be exposed or honored. */
export function isDeprecatedSamplingMethod(method: string): boolean {
  return method === "sampling/createMessage";
}

const SECRET_FIELD_PATTERN =
  /(^|[_.-])(pass(word|wd|phrase)?|secret|token|api[_-]?key|private[_-]?key|credential|auth|bearer|cookie|session[_-]?id|client[_-]?secret|access[_-]?key|pin|ssn|cvv)([_.-]|$)/i;

function schemaRequestsSecret(schema: unknown, depth = 0): boolean {
  if (!isRecord(schema) || depth > 8) return false;
  if (typeof schema.format === "string" && schema.format.toLowerCase() === "password") return true;
  const textHint = `${typeof schema.title === "string" ? schema.title : ""} ${typeof schema.description === "string" ? schema.description : ""}`;
  if (schema.writeOnly === true && SECRET_FIELD_PATTERN.test(textHint)) return true;
  if (isRecord(schema.properties)) {
    for (const [key, prop] of Object.entries(schema.properties)) {
      if (SECRET_FIELD_PATTERN.test(key)) return true;
      if (isRecord(prop)) {
        const propText = `${typeof prop.title === "string" ? prop.title : ""} ${typeof prop.description === "string" ? prop.description : ""}`;
        if (SECRET_FIELD_PATTERN.test(propText)) return true;
        if (schemaRequestsSecret(prop, depth + 1)) return true;
      }
    }
  }
  return false;
}

/**
 * Validates an incoming `elicitation/create` request.
 * Only URL-mode elicitation is surfaced; Form-mode requests asking for secrets
 * (or any non-URL form elicitation) are refused.
 */
export function validateElicitationRequest(
  raw: unknown,
): { ok: true; request: Omit<McpElicitationRequest, "serverId" | "serverName"> } | { ok: false; code: number; reason: string } {
  if (!isRecord(raw)) {
    return { ok: false, code: -32602, reason: "Elicitation parameters must be an object." };
  }
  const mode = typeof raw.mode === "string" ? raw.mode.toLowerCase() : raw.url ? "url" : "form";
  const message = typeof raw.message === "string" ? raw.message.trim() : "";
  if (mode === "form") {
    if (schemaRequestsSecret(raw.requestedSchema)) {
      return {
        ok: false,
        code: -32602,
        reason: "Form-mode elicitation is never permitted for secrets; use URL-mode elicitation instead.",
      };
    }
    return {
      ok: false,
      code: -32602,
      reason: "Only URL-mode elicitation is supported by this client.",
    };
  }
  if (mode !== "url") {
    return { ok: false, code: -32602, reason: `Unsupported elicitation mode "${mode}".` };
  }
  const rawUrl = typeof raw.url === "string" ? raw.url.trim() : "";
  if (!rawUrl) {
    return { ok: false, code: -32602, reason: "URL-mode elicitation requires a target url." };
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, code: -32602, reason: "URL-mode elicitation received an invalid url." };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, code: -32602, reason: "URL-mode elicitation only permits http or https URLs." };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, code: -32602, reason: "URL-mode elicitation URL must not embed credentials." };
  }
  return {
    ok: true,
    request: {
      mode: "url",
      message: message || "External authentication or confirmation is required.",
      url: parsed.toString(),
      ...(typeof raw.elicitationId === "string" && raw.elicitationId.trim() ? { elicitationId: raw.elicitationId.trim() } : {}),
    },
  };
}

/** Parses RFC 9728 / MCP `WWW-Authenticate: Bearer resource_metadata="..."` parameters. */
export function parseWwwAuthenticateResourceMetadata(headerValue: string): {
  resourceMetadataUrl?: string;
  scope?: string;
  error?: string;
} {
  const out: { resourceMetadataUrl?: string; scope?: string; error?: string } = {};
  if (!headerValue) return out;
  const paramRegex = /([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = paramRegex.exec(headerValue)) !== null) {
    const key = match[1].toLowerCase();
    const val = match[2].trim();
    if (key === "resource_metadata" && val) out.resourceMetadataUrl = val;
    else if (key === "scope" && val) out.scope = val;
    else if (key === "error" && val) out.error = val;
  }
  return out;
}

/** Computes the RFC 9728 protected-resource metadata well-known URL for an MCP server URL. */
export function protectedResourceMetadataUrl(mcpServerUrl: string, wwwAuthenticate?: string): string {
  if (wwwAuthenticate) {
    const parsedHeader = parseWwwAuthenticateResourceMetadata(wwwAuthenticate);
    if (parsedHeader.resourceMetadataUrl) {
      const explicit = new URL(parsedHeader.resourceMetadataUrl);
      if (explicit.protocol !== "https:" && explicit.protocol !== "http:") {
        throw new Error("OAuth protected resource metadata URL must use http or https.");
      }
      return explicit.toString();
    }
  }
  const u = new URL(mcpServerUrl);
  const pathSuffix = u.pathname && u.pathname !== "/" ? u.pathname.replace(/\/+$/, "") : "";
  return `${u.origin}/.well-known/oauth-protected-resource${pathSuffix}`;
}

/** Computes RFC 8414 (and OIDC fallback) authorization server metadata URLs for an issuer. */
export function authorizationServerMetadataUrls(issuerUrl: string): string[] {
  const u = new URL(issuerUrl);
  const cleanPath = u.pathname && u.pathname !== "/" ? u.pathname.replace(/\/+$/, "") : "";
  if (!cleanPath) {
    return [
      `${u.origin}/.well-known/oauth-authorization-server`,
      `${u.origin}/.well-known/openid-configuration`,
    ];
  }
  return [
    `${u.origin}/.well-known/oauth-authorization-server${cleanPath}`,
    `${u.origin}${cleanPath}/.well-known/oauth-authorization-server`,
    `${u.origin}${cleanPath}/.well-known/openid-configuration`,
  ];
}

/**
 * Discovers OAuth 2.1 protected resource metadata (RFC 9728) and authorization
 * server metadata (RFC 8414) for an HTTP MCP server using SSRF-safe `guardUrl`
 * and `redirect: "manual"`.
 */
export async function discoverOAuthMetadata(
  serverUrl: string,
  options: {
    wwwAuthenticate?: string;
    fetchImpl?: typeof fetch;
    guardOptions?: Partial<GuardOptions>;
    lookup?: GuardOptions["lookup"];
    timeoutMs?: number;
    /** An address already checked for the server's host: calls to that host are pinned to it, not resolved again. */
    pinned?: GuardedTarget;
  } = {},
): Promise<McpOAuthDiscoveryResult> {
  const fetchFn = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const shouldGuard = fetchFn === fetch || Boolean(options.guardOptions) || Boolean(options.lookup);
  const guardOpts: GuardOptions = {
    server: false,
    allowPrivate: true,
    allowPlainHttp: true,
    ...options.guardOptions,
    ...(options.lookup ? { lookup: options.lookup } : {}),
  };

  const fetchJson = async (rawUrl: string): Promise<{ ok: boolean; status: number; data?: unknown }> => {
    const asked = new URL(rawUrl);
    const pinned =
      options.pinned && options.pinned.url.protocol === asked.protocol && options.pinned.url.host === asked.host ? options.pinned : undefined;
    const target = pinned ?? (shouldGuard ? await guardUrl(rawUrl, guardOpts) : undefined);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const init: RequestInit = {
        method: "GET",
        headers: { Accept: "application/json" },
        redirect: "manual",
        signal: controller.signal,
      };
      const resp =
        fetchFn === fetch && target
          ? await pinnedFetch(target, rawUrl, init)
          : await fetchFn(rawUrl, init);
      if (resp.status >= 300 && resp.status < 400) {
        throw new Error(`OAuth metadata address redirects elsewhere (${resp.status}).`);
      }
      if (!resp.ok) return { ok: false, status: resp.status };
      const data = await resp.json().catch(() => undefined);
      return { ok: true, status: resp.status, data };
    } finally {
      clearTimeout(timer);
    }
  };

  const candidates = [protectedResourceMetadataUrl(serverUrl, options.wwwAuthenticate)];
  const originFallback = `${new URL(serverUrl).origin}/.well-known/oauth-protected-resource`;
  if (!candidates.includes(originFallback)) candidates.push(originFallback);

  let prUrl = candidates[0];
  let protectedResource: OAuthProtectedResourceMetadata | undefined;
  for (const candidate of candidates) {
    const res = await fetchJson(candidate);
    if (res.ok && isRecord(res.data)) {
      prUrl = candidate;
      protectedResource = res.data as OAuthProtectedResourceMetadata;
      break;
    }
  }
  if (!protectedResource) {
    throw new Error("Could not fetch OAuth protected resource metadata (RFC 9728).");
  }
  const authServers = Array.isArray(protectedResource.authorization_servers)
    ? protectedResource.authorization_servers.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    : [];
  if (authServers.length === 0) {
    throw new Error("Protected resource metadata did not list any authorization_servers.");
  }

  const issuer = authServers[0].trim();
  const asCandidates = authorizationServerMetadataUrls(issuer);
  let asUrl = asCandidates[0];
  let authorizationServer: OAuthAuthorizationServerMetadata | undefined;
  for (const candidate of asCandidates) {
    const res = await fetchJson(candidate);
    if (res.ok && isRecord(res.data)) {
      asUrl = candidate;
      authorizationServer = res.data as OAuthAuthorizationServerMetadata;
      break;
    }
  }
  if (
    !authorizationServer ||
    typeof authorizationServer.authorization_endpoint !== "string" ||
    typeof authorizationServer.token_endpoint !== "string"
  ) {
    throw new Error("Could not fetch valid OAuth authorization server metadata (RFC 8414).");
  }

  // Validate endpoints against guardUrl rules so an attacker cannot advertise a loopback/metadata endpoint.
  if (shouldGuard) {
    await guardUrl(authorizationServer.authorization_endpoint, guardOpts);
    await guardUrl(authorizationServer.token_endpoint, guardOpts);
  }

  const methods = Array.isArray(authorizationServer.code_challenge_methods_supported)
    ? authorizationServer.code_challenge_methods_supported
    : [];
  return {
    resourceUrl: typeof protectedResource.resource === "string" ? protectedResource.resource : serverUrl,
    protectedResourceMetadataUrl: prUrl,
    protectedResource,
    authorizationServerIssuer: typeof authorizationServer.issuer === "string" ? authorizationServer.issuer : issuer,
    authorizationServerMetadataUrl: asUrl,
    authorizationServer,
    pkceSupported: methods.includes("S256"),
  };
}

export const MCP_SEARCH_TOOL_DEF = {
  name: "mcp_search",
  description:
    "Search and filter available tools across enabled MCP servers by keyword, server, or safety hints (read-only / non-destructive).",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Keywords to match against tool names, descriptions, or parameters." },
      serverId: { type: "string", description: "Optional MCP server id or name to filter to." },
      readOnlyOnly: { type: "boolean", description: "Only return tools marked readOnly." },
      excludeDestructive: { type: "boolean", description: "Exclude tools marked destructiveHint: true." },
      limit: { type: "number", description: "Max tools to return (default 20, max 100)." },
    },
    additionalProperties: false,
  },
} as const;

interface PooledStdioSession {
  kind: "stdio";
  key: string;
  serverId: string;
  serverName: string;
  child: ChildProcess;
  initialized: boolean;
  initializing?: Promise<void>;
  nextId: number;
  pending: Map<number, { resolve: (val: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>;
  earlyMessages: Map<number, { id?: number; result?: unknown; error?: { message?: string } }>;
  stdoutBuf: string;
  stderrBuf: string;
  idleTimer?: NodeJS.Timeout;
  closed: boolean;
  inFlight: number;
  lastUsedAt: number;
}

interface PooledHttpSession {
  kind: "http";
  key: string;
  serverId: string;
  serverName: string;
  url: string;
  sessionId: string;
  protocolVersion: string;
  headers: Record<string, string>;
  target?: GuardedTarget;
  initialized: boolean;
  initializing?: Promise<void>;
  nextId: number;
  idleTimer?: NodeJS.Timeout;
  closed: boolean;
  inFlight: number;
  lastUsedAt: number;
}

type PooledSession = PooledStdioSession | PooledHttpSession;

export class McpClientManager {
  /**
   * `allow` is asked before a server is started or called, every time: it throws when this
   * server may not be reached from here (a program on a shared server's host, an address the
   * server must not call). Saving a server is not what starts it, so the check sits where it is used.
   */
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly allow?: (server: McpServerConfig) => Promise<GuardedTarget | void> | GuardedTarget | void,
    private readonly options: McpClientOptions = {},
  ) {}

  /**
   * The address `allow` checked, by server id. When `allow` answers with the address it checked, that is
   * the one the connection is pinned to: resolving the name a second time, under other rules, would let a
   * name that changed in between (DNS rebinding) lead somewhere that was never checked.
   */
  private readonly checkedTargets = new Map<string, GuardedTarget>();

  private async checkAllowed(server: McpServerConfig): Promise<void> {
    const checked = await this.allow?.(server);
    if (checked && typeof checked === "object" && "address" in checked && checked.url instanceof URL) this.checkedTargets.set(server.id, checked);
    else this.checkedTargets.delete(server.id);
  }

  /** The address to pin to: the one `allow` checked for this very address, or one checked here under the same rules. */
  private async pinTarget(server: McpServerConfig, url: string): Promise<GuardedTarget | undefined> {
    const checked = this.checkedTargets.get(server.id);
    if (checked) {
      const asked = new URL(url);
      if (checked.url.protocol === asked.protocol && checked.url.host === asked.host) return checked;
    }
    return this.shouldGuardHttp() ? await guardUrl(url, this.effectiveGuardOptions()) : undefined;
  }

  private guardOverrides(): Partial<GuardOptions> | undefined {
    const g = this.options.guardOptions;
    return typeof g === "function" ? g() : g;
  }

  /** Every child this manager started and has not seen end. */
  private readonly children = new Set<ChildProcess>();
  /** Persistent session pool keyed by `serverSessionKey(server)`. */
  private readonly sessions = new Map<string, PooledSession>();
  /** Servers whose tool list was invalidated by `notifications/tools/list_changed`. */
  private readonly toolsListDirty = new Set<string>();
  /** Elicitation requests surfaced during the most recent call per server. */
  private readonly recentElicitations = new Map<string, McpElicitationRequest[]>();

  private get idleTtlMs(): number {
    return this.options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  }

  private effectiveGuardOptions(): GuardOptions {
    return {
      server: false,
      allowPrivate: true,
      allowPlainHttp: true,
      ...this.guardOverrides(),
      ...(this.options.lookup ? { lookup: this.options.lookup } : {}),
    };
  }

  private shouldGuardHttp(): boolean {
    return this.fetchImpl === fetch || Boolean(this.options.guardOptions) || Boolean(this.options.lookup);
  }

  async testAndDiscover(
    server: McpServerConfig,
    timeoutMs = DISCOVER_TIMEOUT_MS,
  ): Promise<{ ok: boolean; tools: McpToolWithHints[]; error?: string }> {
    try {
      await this.checkAllowed(server);
      const tools =
        server.transport === "http"
          ? await this.discoverHttp(server, timeoutMs)
          : await this.discoverStdio(server, timeoutMs);
      this.toolsListDirty.delete(server.id);
      return { ok: true, tools };
    } catch (err) {
      return {
        ok: false,
        tools: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async callTool(
    server: McpServerConfig,
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs = CALL_TIMEOUT_MS,
  ): Promise<McpCallResult> {
    this.recentElicitations.delete(server.id);
    try {
      await this.checkAllowed(server);
      const output =
        server.transport === "http"
          ? await this.callHttp(server, toolName, args, timeoutMs)
          : await this.callStdio(server, toolName, args, timeoutMs);
      const res = readToolResult(output);
      const elicitations = this.recentElicitations.get(server.id);
      this.recentElicitations.delete(server.id);
      return elicitations?.length ? { ...res, elicitations } : res;
    } catch (err) {
      const elicitations = this.recentElicitations.get(server.id);
      this.recentElicitations.delete(server.id);
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        ...(elicitations?.length ? { elicitations } : {}),
      };
    }
  }

  /**
   * The tools of the servers a run may use: enabled, and among the ones the
   * agent was given. This is the only place that list is built; what it
   * returns is what may be called.
   */
  listQualifiedTools(
    servers: McpServerConfig[],
    allowedServerIds?: string[],
  ): McpDiscoveredTool[] {
    const out: McpDiscoveredTool[] = [];
    for (const srv of servers) {
      if (!this.mayUse(srv, allowedServerIds)) continue;
      const prefix = `${MCP_PREFIX}${sanitizeId(srv.id)}__`;
      for (const tool of srv.discoveredTools ?? []) {
        const hints = tool as McpToolWithHints;
        out.push({
          ...tool,
          ...(typeof hints.destructiveHint === "boolean" ? { destructiveHint: hints.destructiveHint } : {}),
          ...(typeof hints.idempotentHint === "boolean" ? { idempotentHint: hints.idempotentHint } : {}),
          ...(typeof hints.openWorldHint === "boolean" ? { openWorldHint: hints.openWorldHint } : {}),
          description: clamp(tool.description ?? "", MAX_DESCRIPTION_CHARS),
          serverId: srv.id,
          serverName: srv.name,
          qualifiedName: `${prefix}${sanitizeId(tool.name)}`,
        });
      }
    }
    return out;
  }

  /** Dynamic `mcp_search` helper filtering discovered tools across allowed, enabled servers. */
  searchTools(
    servers: McpServerConfig[],
    searchOptions: McpSearchOptions = {},
    allowedServerIds?: string[],
  ): McpDiscoveredTool[] {
    return searchMcpTools(servers, searchOptions, allowedServerIds);
  }

  /** Discovers OAuth 2.1 metadata (RFC 9728 + RFC 8414) for an HTTP MCP server. */
  async discoverOAuthMetadata(
    serverOrUrl: McpServerConfig | string,
    wwwAuthenticate?: string,
    timeoutMs = DISCOVER_TIMEOUT_MS,
  ): Promise<McpOAuthDiscoveryResult> {
    const url = typeof serverOrUrl === "string" ? serverOrUrl : serverOrUrl.url?.trim() ?? "";
    if (!url) throw new Error("This MCP server has no address.");
    // A configured server is checked like a call to it, and its own host is pinned to what was checked.
    if (typeof serverOrUrl !== "string") await this.checkAllowed(serverOrUrl);
    const checked = typeof serverOrUrl !== "string" ? this.checkedTargets.get(serverOrUrl.id) : undefined;
    return discoverOAuthMetadata(url, {
      wwwAuthenticate,
      fetchImpl: this.fetchImpl,
      guardOptions: this.guardOverrides(),
      lookup: this.options.lookup,
      timeoutMs,
      ...(checked ? { pinned: checked } : {}),
    });
  }

  private mayUse(srv: McpServerConfig, allowedServerIds?: string[]): boolean {
    if (!srv.enabled) return false;
    if (!allowedServerIds || allowedServerIds.length === 0) return true;
    return allowedServerIds.includes(srv.id) || allowedServerIds.includes(srv.name);
  }

  /**
   * The server and tool a qualified name stands for — or undefined, which
   * means the call does not happen. A name resolves only when its server is
   * enabled and allowed here, and only to a tool the server itself listed:
   * a name that was never discovered is not a tool, whatever it looks like.
   */
  resolveQualifiedCall(
    first: string | McpServerConfig[],
    second: McpServerConfig[] | string,
    options: { allowedServerIds?: string[] } = {},
  ): { server: McpServerConfig; toolName: string; tool: McpToolSummary } | undefined {
    const qualifiedName = typeof first === "string" ? first : (second as string);
    const servers = Array.isArray(first) ? first : (second as McpServerConfig[]);
    if (!qualifiedName.startsWith(MCP_PREFIX)) return undefined;
    for (const srv of servers) {
      const prefix = `${MCP_PREFIX}${sanitizeId(srv.id)}__`;
      if (!qualifiedName.startsWith(prefix)) continue;
      if (!this.mayUse(srv, options.allowedServerIds)) return undefined;
      const suffix = qualifiedName.slice(prefix.length);
      const matched = (srv.discoveredTools ?? []).find(
        (t) => sanitizeId(t.name) === suffix || t.name === suffix,
      );
      if (!matched) return undefined;
      return { server: srv, toolName: matched.name, tool: matched };
    }
    return undefined;
  }

  /** Returns true if the server sent `notifications/tools/list_changed` since last discovery. */
  hasToolsChanged(serverId: string): boolean {
    return this.toolsListDirty.has(serverId);
  }

  /** Returns and clears whether `notifications/tools/list_changed` was received for `serverId`. */
  consumeToolsChanged(serverId: string): boolean {
    const had = this.toolsListDirty.has(serverId);
    this.toolsListDirty.delete(serverId);
    return had;
  }

  /** Snapshot of currently pooled sessions for diagnostics/testing. */
  activeSessions(): Array<{ key: string; serverId: string; transport: "stdio" | "http"; sessionId?: string; lastUsedAt: number }> {
    return [...this.sessions.values()]
      .filter((s) => !s.closed)
      .map((s) => ({
        key: s.key,
        serverId: s.serverId,
        transport: s.kind,
        ...(s.kind === "http" && s.sessionId ? { sessionId: s.sessionId } : {}),
        lastUsedAt: s.lastUsedAt,
      }));
  }

  /** Invalidates pooled session(s) immediately, forcing the next call to re-establish. */
  invalidate(serverIdOrKey?: string): void {
    const targets = this.matchingSessions(serverIdOrKey);
    for (const session of targets) {
      this.teardownSessionSync(session);
    }
    if (serverIdOrKey) {
      this.toolsListDirty.add(serverIdOrKey);
    } else {
      this.toolsListDirty.clear();
    }
  }

  /** Gracefully closes pooled session(s) (or all sessions if omitted). */
  async close(serverIdOrKey?: string): Promise<void> {
    const targets = this.matchingSessions(serverIdOrKey);
    await Promise.all(targets.map((s) => this.closeSessionGracefully(s)));
  }

  /** Ends every server this manager started. Called when the app closes or a run is cancelled. */
  stopAll(): void {
    for (const session of [...this.sessions.values()]) {
      this.teardownSessionSync(session);
    }
    for (const child of [...this.children]) endChild(child);
    this.children.clear();
  }

  private matchingSessions(serverIdOrKey?: string): PooledSession[] {
    if (!serverIdOrKey) return [...this.sessions.values()];
    return [...this.sessions.values()].filter((s) => s.key === serverIdOrKey || s.serverId === serverIdOrKey);
  }

  private resetIdleTimer(session: PooledSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.lastUsedAt = Date.now();
    if (session.closed || this.idleTtlMs <= 0) return;
    session.idleTimer = setTimeout(() => {
      if (session.inFlight === 0) {
        void this.closeSessionGracefully(session);
      } else {
        this.resetIdleTimer(session);
      }
    }, this.idleTtlMs);
    session.idleTimer.unref?.();
  }

  private teardownSessionSync(session: PooledSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    if (this.sessions.get(session.key) === session) this.sessions.delete(session.key);
    if (session.closed) return;
    session.closed = true;
    if (session.kind === "stdio") {
      for (const [, p] of session.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("The MCP server session was closed."));
      }
      session.pending.clear();
      this.children.delete(session.child);
      endChild(session.child);
    }
  }

  private async closeSessionGracefully(session: PooledSession): Promise<void> {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    if (this.sessions.get(session.key) === session) this.sessions.delete(session.key);
    if (session.closed) return;
    session.closed = true;

    if (session.kind === "stdio") {
      for (const [, p] of session.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("The MCP server session was closed."));
      }
      session.pending.clear();
      try {
        session.child.stdin?.end();
      } catch {
        // Ignore stdin already closed.
      }
      await new Promise<void>((resolve) => {
        if (session.child.exitCode !== null || session.child.signalCode !== null) {
          this.children.delete(session.child);
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          this.children.delete(session.child);
          endChild(session.child);
          resolve();
        }, 200);
        timer.unref?.();
        session.child.once("exit", () => {
          clearTimeout(timer);
          this.children.delete(session.child);
          resolve();
        });
      });
      return;
    }

    if (session.sessionId) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      timer.unref?.();
      try {
        const headers = { ...session.headers, "Mcp-Session-Id": session.sessionId };
        const init: RequestInit = { method: "DELETE", headers, redirect: "manual", signal: controller.signal };
        if (this.fetchImpl === fetch && session.target) {
          await pinnedFetch(session.target, session.url, init);
        } else {
          await this.fetchImpl(session.url, init);
        }
      } catch {
        // Best-effort DELETE per MCP Streamable HTTP spec.
      } finally {
        clearTimeout(timer);
      }
    }
  }

  private handleToolsListChanged(serverId: string): void {
    this.toolsListDirty.add(serverId);
    this.options.onToolsListChanged?.(serverId);
  }

  private recordElicitation(server: { id: string; name: string }, raw: unknown): { ok: true; request: McpElicitationRequest } | { ok: false; code: number; reason: string } {
    const validated = validateElicitationRequest(raw);
    if (!validated.ok) return validated;
    const req: McpElicitationRequest = {
      ...validated.request,
      serverId: server.id,
      serverName: server.name,
    };
    const list = this.recentElicitations.get(server.id) ?? [];
    list.push(req);
    this.recentElicitations.set(server.id, list);
    return { ok: true, request: req };
  }

  private async handleServerInitiatedMessage(
    msg: Record<string, unknown>,
    server: { id: string; name: string },
    reply?: (payload: Record<string, unknown>) => void,
  ): Promise<void> {
    const method = typeof msg.method === "string" ? msg.method : "";
    const hasId = msg.id !== undefined && msg.id !== null;

    if (method === "notifications/tools/list_changed") {
      this.handleToolsListChanged(server.id);
      return;
    }

    if (isDeprecatedSamplingMethod(method)) {
      if (hasId && reply) {
        reply({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: "sampling/createMessage is deprecated and disabled for security." },
        });
      }
      return;
    }

    if (method === "elicitation/create") {
      const checked = this.recordElicitation(server, msg.params);
      if (!checked.ok) {
        if (hasId && reply) {
          reply({ jsonrpc: "2.0", id: msg.id, error: { code: checked.code, message: checked.reason } });
        }
        return;
      }
      if (hasId && reply) {
        try {
          const decision = await this.options.onElicitation?.(checked.request);
          reply({
            jsonrpc: "2.0",
            id: msg.id,
            result: decision ?? { action: "accept" },
          });
        } catch (err) {
          reply({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
          });
        }
      } else {
        void Promise.resolve(this.options.onElicitation?.(checked.request)).catch(() => undefined);
      }
    }
  }

  // ---- HTTP ----------------------------------------------------------------

  private async acquireHttpSession(server: McpServerConfig, timeoutMs: number): Promise<PooledHttpSession> {
    const url = server.url?.trim();
    if (!url) throw new Error("This MCP server has no address.");

    const key = serverSessionKey(server);
    // Close any stale session for the same server id with an older config hash.
    for (const [existingKey, existing] of [...this.sessions.entries()]) {
      if (existing.serverId === server.id && existingKey !== key) {
        this.teardownSessionSync(existing);
      }
    }

    const existing = this.sessions.get(key);
    if (existing && existing.kind === "http" && !existing.closed) {
      if (existing.initializing) await existing.initializing;
      if (!existing.closed && existing.initialized) {
        this.resetIdleTimer(existing);
        return existing;
      }
    }

    const baseHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
      ...(server.headers ?? {}),
    };

    const target = await this.pinTarget(server, url);

    const session: PooledHttpSession = {
      kind: "http",
      key,
      serverId: server.id,
      serverName: server.name,
      url,
      sessionId: "",
      protocolVersion: PROTOCOL_VERSION,
      headers: baseHeaders,
      target,
      initialized: false,
      nextId: 2,
      closed: false,
      inFlight: 0,
      lastUsedAt: Date.now(),
    };
    this.sessions.set(key, session);

    session.initializing = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const hello = await this.httpPost(
          session,
          {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: { elicitation: { url: {} } },
              clientInfo: { name: "sshs3", version: "1.0.0" },
            },
          },
          baseHeaders,
          controller.signal,
        );
        if (!hello.ok) throw new Error(httpError(hello));
        session.sessionId = hello.headers.get("mcp-session-id") ?? "";
        const greeting = await this.readHttpRpc(hello, server);
        if (greeting?.error) throw new Error(this.formatRpcError(greeting.error, server));
        if (!isRecord(greeting?.result)) throw new Error(NOT_MCP);
        if (typeof greeting.result.protocolVersion === "string" && greeting.result.protocolVersion.trim()) {
          session.protocolVersion = greeting.result.protocolVersion.trim();
        }
        session.headers = {
          ...baseHeaders,
          "MCP-Protocol-Version": session.protocolVersion,
          ...(session.sessionId ? { "Mcp-Session-Id": session.sessionId } : {}),
        };
        await this.httpPost({ ...session }, { jsonrpc: "2.0", method: "notifications/initialized" }, session.headers, controller.signal).catch(
          () => undefined,
        );
        session.initialized = true;
        this.resetIdleTimer(session);
      } catch (err) {
        this.teardownSessionSync(session);
        throw err;
      } finally {
        clearTimeout(timer);
        session.initializing = undefined;
      }
    })();

    await session.initializing;
    return session;
  }

  private async httpPost(
    session: Pick<PooledHttpSession, "url" | "target">,
    body: unknown,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<Response> {
    const init: RequestInit = {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
      // A redirect is not followed: the address that was checked is the one that is called.
      redirect: "manual",
    };
    if (this.fetchImpl === fetch && session.target) {
      return pinnedFetch(session.target, session.url, init);
    }
    return this.fetchImpl(session.url, init);
  }

  private async readHttpRpc(
    resp: Response,
    server: { id: string; name: string },
  ): Promise<{ result?: unknown; error?: { code?: number; message?: string; data?: unknown } } | undefined> {
    const type = resp.headers.get("content-type") ?? "";
    const text = await resp.text();
    if (!text.trim()) return undefined;
    if (type.includes("text/event-stream")) {
      let rpcMsg: { result?: unknown; error?: { code?: number; message?: string; data?: unknown } } | undefined;
      for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("");
        if (!data) continue;
        try {
          const msg = JSON.parse(data) as Record<string, unknown>;
          if (typeof msg.method === "string") {
            await this.handleServerInitiatedMessage(msg, server);
          } else if (msg.result !== undefined || msg.error) {
            rpcMsg = msg as { result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
          }
        } catch {
          // A comment or keep-alive line.
        }
      }
      return rpcMsg;
    }
    try {
      return JSON.parse(text) as { result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
    } catch {
      throw new Error("The MCP server's answer was not JSON.");
    }
  }

  private formatRpcError(
    error: { code?: number; message?: string; data?: unknown },
    server: { id: string; name: string },
  ): string {
    // MCP URL-mode elicitation required (-32042) surfaces structured URL elicitations.
    if (error.code === -32042 && isRecord(error.data) && Array.isArray(error.data.elicitations)) {
      for (const item of error.data.elicitations) {
        const recorded = this.recordElicitation(server, item);
        if (recorded.ok) {
          void Promise.resolve(this.options.onElicitation?.(recorded.request)).catch(() => undefined);
        }
      }
    }
    return String(error.message || "The MCP server returned an error.");
  }

  private async httpSession(
    server: McpServerConfig,
    request: { id?: number; method: string; params: unknown },
    timeoutMs: number,
  ): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const hadExisting = Boolean(this.sessions.get(serverSessionKey(server)));
      const session = await this.acquireHttpSession(server, timeoutMs);
      session.inFlight++;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const id = request.id ?? session.nextId++;
        const resp = await this.httpPost(
          session,
          { jsonrpc: "2.0", id, method: request.method, params: request.params },
          session.headers,
          controller.signal,
        );
        // An expired session (404/410 when carrying Mcp-Session-Id) is invalidated and retried once.
        if ((resp.status === 404 || resp.status === 410) && session.sessionId && hadExisting && attempt === 0) {
          this.teardownSessionSync(session);
          continue;
        }
        if (!resp.ok) {
          if (resp.status >= 500 || resp.status === 401 || resp.status === 403) {
            this.teardownSessionSync(session);
          }
          throw new Error(httpError(resp));
        }
        const answer = await this.readHttpRpc(resp, server);
        if (answer?.error) throw new Error(this.formatRpcError(answer.error, server));
        this.resetIdleTimer(session);
        return answer?.result;
      } catch (err) {
        if (err instanceof Error && err.message === NOT_MCP) {
          this.teardownSessionSync(session);
        }
        throw err;
      } finally {
        clearTimeout(timer);
        session.inFlight = Math.max(0, session.inFlight - 1);
      }
    }
    throw new Error("The MCP server session expired.");
  }

  private async discoverHttp(server: McpServerConfig, timeoutMs: number): Promise<McpToolWithHints[]> {
    const rawTools: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const params = cursor ? { cursor } : {};
      const result = (await this.httpSession(server, { id: page === 0 ? 2 : undefined, method: "tools/list", params }, timeoutMs)) as
        | { tools?: Array<Record<string, unknown>>; nextCursor?: unknown }
        | undefined;
      if (!Array.isArray(result?.tools)) {
        await this.close(server.id);
        throw new Error(NOT_MCP);
      }
      rawTools.push(...result.tools);
      const next = typeof result.nextCursor === "string" && result.nextCursor.length > 0 ? result.nextCursor : undefined;
      if (!next || seenCursors.has(next)) break;
      seenCursors.add(next);
      cursor = next;
    }
    return readTools(rawTools, server.name);
  }

  private callHttp(
    server: McpServerConfig,
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    return this.httpSession(server, { method: "tools/call", params: { name: toolName, arguments: args } }, timeoutMs);
  }

  // ---- stdio ---------------------------------------------------------------

  private async acquireStdioSession(server: McpServerConfig, timeoutMs: number): Promise<PooledStdioSession> {
    const cmd = server.command?.trim();
    if (!cmd) throw new Error("This MCP server has no command to start.");

    const key = serverSessionKey(server);
    for (const [existingKey, existing] of [...this.sessions.entries()]) {
      if (existing.serverId === server.id && existingKey !== key) {
        this.teardownSessionSync(existing);
      }
    }

    const existing = this.sessions.get(key);
    if (existing && existing.kind === "stdio" && !existing.closed) {
      if (existing.initializing) await existing.initializing;
      if (!existing.closed && existing.initialized) {
        this.resetIdleTimer(existing);
        return existing;
      }
    }

    const child = spawn(cmd, server.args ?? [], {
      // Only what this server was given. The app's own environment — which holds
      // the model's API key among other things — is not handed to somebody else's program.
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...(server.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // Its own group, so that what it starts in turn goes down with it.
      detached: process.platform !== "win32",
    });
    this.children.add(child);

    const session: PooledStdioSession = {
      kind: "stdio",
      key,
      serverId: server.id,
      serverName: server.name,
      child,
      initialized: false,
      nextId: 2,
      pending: new Map(),
      earlyMessages: new Map(),
      stdoutBuf: "",
      stderrBuf: "",
      closed: false,
      inFlight: 0,
      lastUsedAt: Date.now(),
    };
    this.sessions.set(key, session);

    const writeStdin = (payload: Record<string, unknown>): void => {
      if (session.closed || !child.stdin?.writable) return;
      child.stdin.write(JSON.stringify(payload) + "\n");
    };

    const failAllPending = (err: Error): void => {
      for (const [, entry] of session.pending) {
        clearTimeout(entry.timer);
        entry.reject(err);
      }
      session.pending.clear();
    };

    child.on("error", (err) => {
      session.closed = true;
      this.children.delete(child);
      if (this.sessions.get(key) === session) this.sessions.delete(key);
      failAllPending(err);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      // Kept only as far as it is useful in a message.
      if (session.stderrBuf.length < 4000) session.stderrBuf += chunk.toString("utf-8");
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      session.stdoutBuf += chunk.toString("utf-8");
      if (session.stdoutBuf.length > MAX_STDIO_BYTES) {
        this.teardownSessionSync(session);
        failAllPending(new Error("The MCP server sent more than this can take in one answer."));
        return;
      }
      const lines = session.stdoutBuf.split(/\r?\n/);
      session.stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        try {
          const msg = JSON.parse(trimmed) as Record<string, unknown>;
          if (typeof msg.method === "string") {
            void this.handleServerInitiatedMessage(msg, server, writeStdin);
            continue;
          }
          if (typeof msg.id === "number") {
            const waiting = session.pending.get(msg.id);
            if (waiting) {
              clearTimeout(waiting.timer);
              session.pending.delete(msg.id);
              const errObj = msg.error as { code?: number; message?: string; data?: unknown } | undefined;
              if (errObj) waiting.reject(new Error(this.formatRpcError(errObj, server)));
              else waiting.resolve(msg.result ?? msg);
            } else if (session.earlyMessages.size < 64) {
              session.earlyMessages.set(msg.id, msg as { id?: number; result?: unknown; error?: { message?: string } });
            }
          }
        } catch {
          // Not JSON: a server writing something else on stdout is ignored.
        }
      }
    });

    child.on("exit", (code) => {
      session.closed = true;
      this.children.delete(child);
      if (this.sessions.get(key) === session) this.sessions.delete(key);
      // One-shot script printed a direct response (e.g. id: 2) without answering initialize (id: 1).
      const initWaiting = session.pending.get(1);
      if (initWaiting && session.earlyMessages.size > 0 && (code === 0 || code === null)) {
        clearTimeout(initWaiting.timer);
        session.pending.delete(1);
        initWaiting.resolve(undefined);
      }
      failAllPending(
        new Error(
          `The MCP server stopped with code ${code ?? -1}${session.stderrBuf ? `: ${clamp(session.stderrBuf, 300)}` : "."}`,
        ),
      );
    });

    child.stdin?.on("error", () => {
      if (!session.closed) {
        failAllPending(new Error("The MCP server closed before it could be asked anything."));
        this.teardownSessionSync(session);
      }
    });

    session.initializing = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(1);
        const msg = `The MCP server did not answer within ${Math.round(timeoutMs / 1000)}s${session.stderrBuf ? `: ${clamp(session.stderrBuf, 300)}` : "."}`;
        this.teardownSessionSync(session);
        reject(new Error(msg));
      }, timeoutMs);
      session.pending.set(1, {
        timer,
        resolve: () => {
          if (!session.closed) {
            writeStdin({ jsonrpc: "2.0", method: "notifications/initialized" });
            session.initialized = true;
            this.resetIdleTimer(session);
          }
          resolve();
        },
        reject: (err) => {
          this.teardownSessionSync(session);
          reject(err);
        },
      });
      writeStdin({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { elicitation: { url: {} } },
          clientInfo: { name: "sshs3", version: "1.0.0" },
        },
      });
    }).finally(() => {
      session.initializing = undefined;
    });

    await session.initializing;
    return session;
  }

  private async stdioRequest(
    server: McpServerConfig,
    method: string,
    params: unknown,
    timeoutMs: number,
    explicitId?: number,
  ): Promise<unknown> {
    const session = await this.acquireStdioSession(server, timeoutMs);
    const id = explicitId ?? session.nextId++;
    if (explicitId !== undefined && session.nextId <= explicitId) {
      session.nextId = explicitId + 1;
    }

    const early = session.earlyMessages.get(id);
    if (early) {
      session.earlyMessages.delete(id);
      if (early.error?.message) throw new Error(early.error.message);
      return early.result ?? early;
    }
    if (session.closed) {
      throw new Error("The MCP server closed before it could be asked anything.");
    }

    session.inFlight++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(id);
        const msg = `The MCP server did not answer within ${Math.round(timeoutMs / 1000)}s${session.stderrBuf ? `: ${clamp(session.stderrBuf, 300)}` : "."}`;
        this.teardownSessionSync(session);
        reject(new Error(msg));
      }, timeoutMs);

      session.pending.set(id, {
        timer,
        resolve: (val) => {
          this.resetIdleTimer(session);
          resolve(val);
        },
        reject,
      });

      try {
        session.child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      } catch {
        clearTimeout(timer);
        session.pending.delete(id);
        reject(new Error("The MCP server closed before it could be asked anything."));
      }
    }).finally(() => {
      session.inFlight = Math.max(0, session.inFlight - 1);
    });
  }

  private async discoverStdio(server: McpServerConfig, timeoutMs: number): Promise<McpToolWithHints[]> {
    const rawTools: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const params = cursor ? { cursor } : {};
      const res = (await this.stdioRequest(server, "tools/list", params, timeoutMs, page === 0 ? 2 : undefined)) as {
        tools?: Array<Record<string, unknown>>;
        nextCursor?: unknown;
      };
      if (Array.isArray(res?.tools)) rawTools.push(...res.tools);
      const next = typeof res?.nextCursor === "string" && res.nextCursor.length > 0 ? res.nextCursor : undefined;
      if (!next || seenCursors.has(next)) break;
      seenCursors.add(next);
      cursor = next;
    }
    return readTools(rawTools, server.name);
  }

  private callStdio(
    server: McpServerConfig,
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    return this.stdioRequest(server, "tools/call", { name: toolName, arguments: args }, timeoutMs);
  }
}

/**
 * Dynamic `mcp_search` tool filter helper across enabled, allowed MCP servers.
 */
export function searchMcpTools(
  servers: McpServerConfig[],
  options: McpSearchOptions = {},
  allowedServerIds?: string[],
): McpDiscoveredTool[] {
  const manager = new McpClientManager();
  let pool = manager.listQualifiedTools(servers, allowedServerIds);

  if (options.serverId) {
    const want = options.serverId.trim().toLowerCase();
    pool = pool.filter(
      (t) => t.serverId.toLowerCase() === want || t.serverName.toLowerCase() === want,
    );
  }
  if (options.serverIds && options.serverIds.length > 0) {
    const wanted = new Set(options.serverIds.map((s) => s.trim().toLowerCase()));
    pool = pool.filter(
      (t) => wanted.has(t.serverId.toLowerCase()) || wanted.has(t.serverName.toLowerCase()),
    );
  }
  if (options.readOnlyOnly) {
    pool = pool.filter((t) => t.readOnly === true);
  }
  if (options.excludeDestructive) {
    pool = pool.filter((t) => t.destructiveHint !== true);
  }

  const limit = Math.max(1, Math.min(100, options.limit ?? 20));
  const query = options.query?.trim().toLowerCase() ?? "";
  if (!query) return pool.slice(0, limit);

  const tokens = query.split(/\s+/).filter(Boolean);
  const scored: Array<{ tool: McpDiscoveredTool; score: number }> = [];
  for (const tool of pool) {
    const name = tool.name.toLowerCase();
    const qual = tool.qualifiedName.toLowerCase();
    const desc = (tool.description ?? "").toLowerCase();
    const srv = tool.serverName.toLowerCase();
    const props = isRecord(tool.inputSchema?.properties)
      ? Object.keys(tool.inputSchema.properties).join(" ").toLowerCase()
      : "";
    let score = 0;
    let matchedAll = true;
    for (const tok of tokens) {
      let tokScore = 0;
      if (name === tok || qual === tok) tokScore += 10;
      else if (name.includes(tok)) tokScore += 6;
      else if (qual.includes(tok)) tokScore += 4;
      if (srv.includes(tok)) tokScore += 2;
      if (desc.includes(tok)) tokScore += 3;
      if (props.includes(tok)) tokScore += 2;
      if (tokScore === 0) {
        matchedAll = false;
        break;
      }
      score += tokScore;
    }
    if (matchedAll && score > 0) scored.push({ tool, score });
  }
  scored.sort((a, b) => b.score - a.score || a.tool.qualifiedName.localeCompare(b.tool.qualifiedName));
  return scored.slice(0, limit).map((s) => s.tool);
}

/**
 * IP-pinned HTTP/HTTPS request using Node `http`/`https` with `lookup` fixed to
 * `target.address` and `redirect: "manual"` (never following 3xx), eliminating DNS TOCTOU.
 */
function pinnedFetch(target: GuardedTarget, rawUrl: string, init: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const url = new URL(rawUrl);
    const lib = url.protocol === "https:" ? https : http;
    const headers: Record<string, string> = {};
    if (init.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => {
          headers[k] = v;
        });
      } else if (Array.isArray(init.headers)) {
        for (const [k, v] of init.headers) headers[k] = v;
      } else {
        Object.assign(headers, init.headers as Record<string, string>);
      }
    }
    const bodyText = typeof init.body === "string" ? init.body : undefined;
    if (bodyText !== undefined && !Object.keys(headers).some((k) => k.toLowerCase() === "content-length")) {
      headers["Content-Length"] = String(Buffer.byteLength(bodyText, "utf8"));
    }

    let settled = false;
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: init.method ?? "GET",
        headers,
        // Pin the exact IP address validated by guardUrl, while keeping hostname for Host/SNI.
        lookup: (_host, options, callback) => {
          if (options && typeof options === "object" && (options as { all?: boolean }).all) {
            (callback as unknown as (e: Error | null, addresses: Array<{ address: string; family: number }>) => void)(
              null,
              [{ address: target.address, family: target.family }],
            );
          } else {
            (callback as (e: Error | null, address: string, family: number) => void)(null, target.address, target.family);
          }
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          if (settled) return;
          settled = true;
          const status = res.statusCode ?? 0;
          const respHeaders = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (v === undefined) continue;
            if (Array.isArray(v)) {
              for (const item of v) respHeaders.append(k, item);
            } else {
              respHeaders.set(k, v);
            }
          }
          const noBody = status === 204 || status === 304 || (status >= 300 && status < 400);
          resolve(
            new Response(noBody ? null : new Uint8Array(Buffer.concat(chunks)), {
              status,
              statusText: res.statusMessage ?? "",
              headers: respHeaders,
            }),
          );
        });
        res.on("error", (err) => {
          if (settled) return;
          settled = true;
          reject(err);
        });
      },
    );

    const onAbort = (): void => {
      if (!settled) {
        settled = true;
        req.destroy(new Error("The request timed out or was aborted."));
        reject(new Error("The request timed out or was aborted."));
      }
    };
    if (init.signal) {
      if (init.signal.aborted) {
        onAbort();
        return;
      }
      init.signal.addEventListener("abort", onAbort, { once: true });
      req.once("close", () => init.signal?.removeEventListener("abort", onAbort));
    }

    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });

    if (bodyText !== undefined) req.end(bodyText);
    else req.end();
  });
}

/** Ends a child and the group it started, without waiting for it to agree. */
function endChild(child: ChildProcess): void {
  const pid = child.pid;
  const signal = (sig: NodeJS.Signals): void => {
    try {
      if (pid && process.platform !== "win32") process.kill(-pid, sig);
      else child.kill(sig);
    } catch {
      // Already gone.
    }
  };
  signal("SIGTERM");
  const hard = setTimeout(() => signal("SIGKILL"), 2000);
  hard.unref?.();
  child.once("exit", () => clearTimeout(hard));
}

const NOT_MCP = "This address answered, but not as an MCP server.";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const httpError = (resp: Response): string => {
  if (resp.status === 401 || resp.status === 403) {
    const wwwAuth = resp.headers.get("www-authenticate");
    const parsed = wwwAuth ? parseWwwAuthenticateResourceMetadata(wwwAuth) : {};
    if (parsed.resourceMetadataUrl) {
      return `The MCP server refused this (${resp.status}). Its address may need a token in a header (OAuth discovery: ${parsed.resourceMetadataUrl}).`;
    }
    return `The MCP server refused this (${resp.status}). Its address may need a token in a header.`;
  }
  return resp.status >= 300 && resp.status < 400
    ? `The MCP server's address redirects elsewhere (${resp.status}). Use the address it leads to.`
    : `The MCP server answered ${resp.status} ${resp.statusText}.`;
};

function readTools(raw: Array<Record<string, unknown>> | undefined, serverName: string): McpToolWithHints[] {
  return (raw ?? []).map((t) => {
    const annotations = (t.annotations ?? {}) as {
      readOnlyHint?: unknown;
      destructiveHint?: unknown;
      idempotentHint?: unknown;
      openWorldHint?: unknown;
    };
    return {
      name: String(t.name || "tool"),
      description: clamp(String(t.description || `A tool of ${serverName}`), MAX_DESCRIPTION_CHARS),
      inputSchema:
        t.inputSchema && typeof t.inputSchema === "object"
          ? (t.inputSchema as Record<string, unknown>)
          : { type: "object", properties: {}, additionalProperties: true },
      // The server's own word about its tool: used to decide whether to ask a person first.
      readOnly: annotations.readOnlyHint === true,
      ...(typeof annotations.destructiveHint === "boolean" ? { destructiveHint: annotations.destructiveHint } : {}),
      ...(typeof annotations.idempotentHint === "boolean" ? { idempotentHint: annotations.idempotentHint } : {}),
      ...(typeof annotations.openWorldHint === "boolean" ? { openWorldHint: annotations.openWorldHint } : {}),
    };
  });
}

/**
 * What a tool answered. MCP reports a tool's own failure inside a successful
 * response (`isError`), which is not the same as the call having worked.
 */
export function readToolResult(output: unknown): McpCallResult {
  const result = (output ?? {}) as { isError?: unknown; content?: unknown };
  const text = textOf(result.content);
  if (result.isError === true) return { ok: false, error: clamp(text || "The tool reported an error.", 4000) };
  const kept = JSON.stringify(output ?? null);
  return { ok: true, output: kept.length > MAX_RESULT_CHARS ? { truncated: true, text: clamp(text || kept, MAX_RESULT_CHARS) } : output };
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
    .filter(Boolean)
    .join("\n");
}
