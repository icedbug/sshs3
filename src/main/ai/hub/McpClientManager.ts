import { spawn, type ChildProcess } from "node:child_process";
import type { McpServerConfig, McpToolSummary } from "../../../shared/types/aiHub";

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

export interface McpDiscoveredTool extends McpToolSummary {
  serverId: string;
  serverName: string;
  qualifiedName: string;
}

export const MCP_PREFIX = "mcp__";
/** How much of one answer is kept. A server cannot fill a model's context. */
export const MAX_RESULT_CHARS = 40_000;
const MAX_DESCRIPTION_CHARS = 2000;
const MAX_STDIO_BYTES = 8 * 1024 * 1024;
/** A preset runs `npx -y …`, which fetches the package the first time. */
const DISCOVER_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 60_000;
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

export interface McpCallResult {
  ok: boolean;
  output?: unknown;
  error?: string;
}

export class McpClientManager {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  /** Every child this manager started and has not seen end. */
  private readonly children = new Set<ChildProcess>();

  async testAndDiscover(
    server: McpServerConfig,
    timeoutMs = DISCOVER_TIMEOUT_MS,
  ): Promise<{ ok: boolean; tools: McpToolSummary[]; error?: string }> {
    try {
      const tools =
        server.transport === "http"
          ? await this.discoverHttp(server, timeoutMs)
          : await this.discoverStdio(server, timeoutMs);
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
    try {
      const output =
        server.transport === "http"
          ? await this.callHttp(server, toolName, args, timeoutMs)
          : await this.callStdio(server, toolName, args, timeoutMs);
      return readToolResult(output);
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
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
        out.push({
          ...tool,
          description: clamp(tool.description ?? "", MAX_DESCRIPTION_CHARS),
          serverId: srv.id,
          serverName: srv.name,
          qualifiedName: `${prefix}${sanitizeId(tool.name)}`,
        });
      }
    }
    return out;
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

  /** Ends every server this manager started. Called when the app closes or a run is cancelled. */
  stopAll(): void {
    for (const child of [...this.children]) endChild(child);
    this.children.clear();
  }

  // ---- HTTP ----------------------------------------------------------------

  /**
   * One HTTP conversation: initialize, then the request. The session the
   * server hands back is carried on every later request of the same
   * conversation, and an answer that comes as an event stream is read as one.
   */
  private async httpSession(
    server: McpServerConfig,
    request: { id: number; method: string; params: unknown },
    timeoutMs: number,
  ): Promise<unknown> {
    const url = server.url?.trim();
    if (!url) throw new Error("This MCP server has no address.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const base: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": PROTOCOL_VERSION,
        ...(server.headers ?? {}),
      };
      const post = async (body: unknown, headers: Record<string, string>): Promise<Response> =>
        this.fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });

      const hello = await post(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "sshs3", version: "1.0.0" },
          },
        },
        base,
      );
      if (!hello.ok) throw new Error(httpError(hello));
      const session = hello.headers.get("mcp-session-id") ?? "";
      await readRpc(hello); // read it, so the connection is free and errors are seen
      const withSession = session ? { ...base, "Mcp-Session-Id": session } : base;

      // Telling the server the handshake is done is a notification: no answer is expected.
      await post({ jsonrpc: "2.0", method: "notifications/initialized" }, withSession).catch(() => undefined);

      const resp = await post({ jsonrpc: "2.0", ...request }, withSession);
      if (!resp.ok) throw new Error(httpError(resp));
      const answer = await readRpc(resp);
      if (answer?.error) throw new Error(String(answer.error.message || "The MCP server returned an error."));
      return answer?.result;
    } finally {
      clearTimeout(timer);
    }
  }

  private async discoverHttp(server: McpServerConfig, timeoutMs: number): Promise<McpToolSummary[]> {
    const result = (await this.httpSession(server, { id: 2, method: "tools/list", params: {} }, timeoutMs)) as
      | { tools?: Array<Record<string, unknown>> }
      | undefined;
    return readTools(result?.tools, server.name);
  }

  private callHttp(
    server: McpServerConfig,
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    return this.httpSession(server, { id: 2, method: "tools/call", params: { name: toolName, arguments: args } }, timeoutMs);
  }

  // ---- stdio ---------------------------------------------------------------

  private async discoverStdio(server: McpServerConfig, timeoutMs: number): Promise<McpToolSummary[]> {
    const res = (await this.runStdioSession(server, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, timeoutMs)) as {
      tools?: Array<Record<string, unknown>>;
    };
    return readTools(res?.tools, server.name);
  }

  private callStdio(
    server: McpServerConfig,
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    return this.runStdioSession(
      server,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: toolName, arguments: args } },
      timeoutMs,
    );
  }

  private runStdioSession(
    server: McpServerConfig,
    requestMsg: { jsonrpc: string; id: number; method: string; params: unknown },
    timeoutMs: number,
  ): Promise<unknown> {
    const cmd = server.command?.trim();
    if (!cmd) throw new Error("This MCP server has no command to start.");
    return new Promise((resolve, reject) => {
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
      let settled = false;
      let stdoutBuf = "";
      let stderrBuf = "";

      const finish = (err?: Error, result?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.children.delete(child);
        endChild(child);
        if (err) reject(err);
        else resolve(result);
      };

      const timer = setTimeout(() => {
        finish(new Error(`The MCP server did not answer within ${Math.round(timeoutMs / 1000)}s${stderrBuf ? `: ${clamp(stderrBuf, 300)}` : "."}`));
      }, timeoutMs);

      child.on("error", (err) => finish(err));
      child.stderr.on("data", (chunk: Buffer) => {
        // Kept only as far as it is useful in a message.
        if (stderrBuf.length < 4000) stderrBuf += chunk.toString("utf-8");
      });

      let sentTargetRequest = false;
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString("utf-8");
        if (stdoutBuf.length > MAX_STDIO_BYTES) {
          finish(new Error("The MCP server sent more than this can take in one answer."));
          return;
        }
        const lines = stdoutBuf.split(/\r?\n/);
        stdoutBuf = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("{")) continue;
          try {
            const msg = JSON.parse(trimmed) as { id?: number; result?: unknown; error?: { message?: string } };
            if (msg.id === 1 && !sentTargetRequest) {
              sentTargetRequest = true;
              child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
              child.stdin.write(JSON.stringify(requestMsg) + "\n");
            } else if (msg.id === requestMsg.id) {
              if (msg.error?.message) finish(new Error(msg.error.message));
              else finish(undefined, msg.result ?? msg);
            }
          } catch {
            // Not JSON: a server writing something else on stdout is ignored.
          }
        }
      });

      child.on("exit", (code) => {
        this.children.delete(child);
        if (!settled)
          finish(new Error(`The MCP server stopped with code ${code ?? -1}${stderrBuf ? `: ${clamp(stderrBuf, 300)}` : "."}`));
      });

      child.stdin.on("error", () => finish(new Error("The MCP server closed before it could be asked anything.")));
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "sshs3", version: "1.0.0" },
          },
        }) + "\n",
      );
    });
  }
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

const httpError = (resp: Response): string =>
  resp.status === 401 || resp.status === 403
    ? `The MCP server refused this (${resp.status}). Its address may need a token in a header.`
    : `The MCP server answered ${resp.status} ${resp.statusText}.`;

/**
 * One JSON-RPC answer, whether it came as JSON or as an event stream. A
 * Streamable HTTP server may answer a POST either way.
 */
async function readRpc(resp: Response): Promise<{ result?: unknown; error?: { message?: string } } | undefined> {
  const type = resp.headers.get("content-type") ?? "";
  const text = await resp.text();
  if (!text.trim()) return undefined;
  if (type.includes("text/event-stream")) {
    for (const block of text.split(/\n\n/)) {
      const data = block
        .split(/\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("");
      if (!data) continue;
      try {
        const msg = JSON.parse(data) as { id?: unknown; result?: unknown; error?: { message?: string } };
        if (msg.result !== undefined || msg.error) return msg;
      } catch {
        // A comment or a keep-alive line.
      }
    }
    return undefined;
  }
  try {
    return JSON.parse(text) as { result?: unknown; error?: { message?: string } };
  } catch {
    throw new Error("The MCP server's answer was not JSON.");
  }
}

function readTools(raw: Array<Record<string, unknown>> | undefined, serverName: string): McpToolSummary[] {
  return (raw ?? []).slice(0, 200).map((t) => {
    const annotations = (t.annotations ?? {}) as { readOnlyHint?: unknown };
    return {
      name: String(t.name || "tool"),
      description: clamp(String(t.description || `A tool of ${serverName}`), MAX_DESCRIPTION_CHARS),
      inputSchema:
        t.inputSchema && typeof t.inputSchema === "object"
          ? (t.inputSchema as Record<string, unknown>)
          : { type: "object", properties: {}, additionalProperties: true },
      // The server's own word about its tool: used to decide whether to ask a person first.
      readOnly: annotations.readOnlyHint === true,
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
