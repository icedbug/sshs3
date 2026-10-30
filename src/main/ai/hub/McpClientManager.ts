import { spawn } from "node:child_process";
import type { McpServerConfig, McpToolSummary } from "../../../shared/types/aiHub";

export interface McpDiscoveredTool extends McpToolSummary {
  serverId: string;
  serverName: string;
  qualifiedName: string;
}

function sanitizeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40) || "mcp";
}

export class McpClientManager {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async testAndDiscover(
    server: McpServerConfig,
    timeoutMs = 8000,
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
    timeoutMs = 15000,
  ): Promise<{ ok: boolean; output?: unknown; error?: string }> {
    try {
      const output =
        server.transport === "http"
          ? await this.callHttp(server, toolName, args, timeoutMs)
          : await this.callStdio(server, toolName, args, timeoutMs);
      return { ok: true, output };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  listQualifiedTools(
    servers: McpServerConfig[],
    allowedServerIds?: string[],
  ): McpDiscoveredTool[] {
    const out: McpDiscoveredTool[] = [];
    for (const srv of servers) {
      if (!srv.enabled) continue;
      if (
        allowedServerIds &&
        allowedServerIds.length > 0 &&
        !allowedServerIds.includes(srv.id) &&
        !allowedServerIds.includes(srv.name)
      ) {
        continue;
      }
      const prefix = `mcp__${sanitizeId(srv.id)}__`;
      for (const tool of srv.discoveredTools ?? []) {
        out.push({
          ...tool,
          serverId: srv.id,
          serverName: srv.name,
          qualifiedName: `${prefix}${sanitizeId(tool.name)}`,
        });
      }
    }
    return out;
  }

  resolveQualifiedCall(
    first: string | McpServerConfig[],
    second: McpServerConfig[] | string,
  ): { server: McpServerConfig; toolName: string } | undefined {
    const qualifiedName = typeof first === "string" ? first : (second as string);
    const servers = Array.isArray(first) ? first : (second as McpServerConfig[]);
    if (!qualifiedName.startsWith("mcp__")) return undefined;
    for (const srv of servers) {
      const prefix = `mcp__${sanitizeId(srv.id)}__`;
      if (qualifiedName.startsWith(prefix)) {
        const suffix = qualifiedName.slice(prefix.length);
        const matched = (srv.discoveredTools ?? []).find(
          (t) => sanitizeId(t.name) === suffix || t.name === suffix,
        );
        return {
          server: srv,
          toolName: matched?.name || suffix,
        };
      }
    }
    return undefined;
  }

  private async discoverHttp(
    server: McpServerConfig,
    timeoutMs: number,
  ): Promise<McpToolSummary[]> {
    const url = server.url?.trim();
    if (!url) throw new Error("MCP HTTP URL is required");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(server.headers ?? {}),
      };
      // Optional initialize handshake
      await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "sshs3-ai-hub", version: "1.0.0" },
          },
        }),
        signal: controller.signal,
      }).catch(() => {});

      const resp = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        throw new Error(`MCP HTTP ${resp.status}: ${resp.statusText}`);
      }
      const json = (await resp.json()) as {
        result?: { tools?: Array<Record<string, unknown>> };
        tools?: Array<Record<string, unknown>>;
        error?: { message?: string };
      };
      if (json.error?.message) throw new Error(json.error.message);
      const rawTools = json.result?.tools ?? json.tools ?? [];
      return rawTools.map((t) => ({
        name: String(t.name || "tool"),
        description: String(t.description || `MCP tool from ${server.name}`),
        inputSchema:
          t.inputSchema && typeof t.inputSchema === "object"
            ? (t.inputSchema as Record<string, unknown>)
            : { type: "object", properties: {}, additionalProperties: true },
      }));
    } finally {
      clearTimeout(timer);
    }
  }

  private async callHttp(
    server: McpServerConfig,
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    const url = server.url?.trim();
    if (!url) throw new Error("MCP HTTP URL is required");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(server.headers ?? {}),
      };
      const resp = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method: "tools/call",
          params: {
            name: toolName,
            arguments: args,
          },
        }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        throw new Error(`MCP HTTP ${resp.status}: ${resp.statusText}`);
      }
      const json = (await resp.json()) as {
        result?: unknown;
        error?: { message?: string };
      };
      if (json.error?.message) throw new Error(json.error.message);
      return json.result ?? json;
    } finally {
      clearTimeout(timer);
    }
  }

  private async discoverStdio(
    server: McpServerConfig,
    timeoutMs: number,
  ): Promise<McpToolSummary[]> {
    const res = (await this.runStdioSession(
      server,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      },
      timeoutMs,
    )) as { tools?: Array<Record<string, unknown>> };
    const rawTools = res?.tools ?? [];
    return rawTools.map((t) => ({
      name: String(t.name || "tool"),
      description: String(t.description || `MCP tool from ${server.name}`),
      inputSchema:
        t.inputSchema && typeof t.inputSchema === "object"
          ? (t.inputSchema as Record<string, unknown>)
          : { type: "object", properties: {}, additionalProperties: true },
    }));
  }

  private async callStdio(
    server: McpServerConfig,
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    return this.runStdioSession(
      server,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: toolName,
          arguments: args,
        },
      },
      timeoutMs,
    );
  }

  private runStdioSession(
    server: McpServerConfig,
    requestMsg: { jsonrpc: string; id: number; method: string; params: unknown },
    timeoutMs: number,
  ): Promise<unknown> {
    const cmd = server.command?.trim();
    if (!cmd) throw new Error("MCP stdio command is required");
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, server.args ?? [], {
        env: { ...process.env, ...(server.env ?? {}) },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let settled = false;
      let stdoutBuf = "";
      let stderrBuf = "";

      const finish = (err?: Error, result?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          child.kill();
        } catch {
          // ignore
        }
        if (err) reject(err);
        else resolve(result);
      };

      const timer = setTimeout(() => {
        finish(
          new Error(
            `MCP stdio timeout after ${timeoutMs}ms${stderrBuf ? `: ${stderrBuf.slice(0, 200)}` : ""}`,
          ),
        );
      }, timeoutMs);

      child.on("error", (err) => finish(err));
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString("utf-8");
      });

      let sentTargetRequest = false;
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString("utf-8");
        const lines = stdoutBuf.split(/\r?\n/);
        stdoutBuf = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("{")) continue;
          try {
            const msg = JSON.parse(trimmed) as {
              id?: number;
              result?: unknown;
              error?: { message?: string };
            };
            if (msg.id === 1 && !sentTargetRequest) {
              sentTargetRequest = true;
              child.stdin.write(
                JSON.stringify({
                  jsonrpc: "2.0",
                  method: "notifications/initialized",
                }) + "\n",
              );
              child.stdin.write(JSON.stringify(requestMsg) + "\n");
            } else if (msg.id === requestMsg.id) {
              if (msg.error?.message) {
                finish(new Error(msg.error.message));
              } else {
                finish(undefined, msg.result ?? msg);
              }
            }
          } catch {
            // ignore non-JSON lines
          }
        }
      });

      child.on("exit", (code) => {
        if (!settled) {
          finish(
            new Error(
              `MCP process exited with code ${code ?? -1}${stderrBuf ? `: ${stderrBuf.slice(0, 200)}` : ""}`,
            ),
          );
        }
      });

      // Send initialize request first
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "sshs3-ai-hub", version: "1.0.0" },
          },
        }) + "\n",
      );
    });
  }
}
