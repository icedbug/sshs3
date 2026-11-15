import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  McpClientManager,
  authorizationServerMetadataUrls,
  discoverOAuthMetadata,
  isDeprecatedSamplingMethod,
  parseWwwAuthenticateResourceMetadata,
  protectedResourceMetadataUrl,
  searchMcpTools,
  serverConfigHash,
  serverSessionKey,
  validateElicitationRequest,
} from "../../src/main/ai/hub/McpClientManager";
import { LocalMcpServer } from "../../src/main/ai/hub/LocalMcpServer";
import { McpTokenStore } from "../../src/main/web/McpTokenStore";
import { callBudget, handleMcpHttp } from "../../src/main/web/mcp/McpEndpoint";
import { isSafeKbResourceUri } from "../../src/main/web/mcp/mcpTools";
import type { HubRequest, HubSnapshot, McpServerConfig } from "../../src/shared/types/aiHub";

const tmpDirs: string[] = [];
const managers: McpClientManager[] = [];
const httpServers: http.Server[] = [];
const localServers: LocalMcpServer[] = [];

afterEach(async () => {
  for (const m of managers.splice(0)) m.stopAll();
  for (const l of localServers.splice(0)) await l.stop();
  for (const s of httpServers.splice(0)) {
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  for (const d of tmpDirs.splice(0)) {
    await fs.rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

const makeHttpServerConfig = (over: Partial<McpServerConfig> = {}): McpServerConfig =>
  ({
    id: "srv-http",
    name: "HTTP Server",
    transport: "http",
    url: "https://mcp.example.com/mcp",
    enabled: true,
    discoveredTools: [],
    ...over,
  }) as McpServerConfig;

describe("McpClientManager — session pooling, pagination, hints & notifications", () => {
  it("pools and reuses persistent stdio sessions across calls and invalidates on config change or close()", async () => {
    // Persistent Node MCP stdio server that counts initialize calls and supports tools/list + tools/call.
    const script = `
      const rl = require("readline").createInterface({ input: process.stdin });
      let inits = 0;
      let calls = 0;
      rl.on("line", (line) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        if (msg.method === "initialize") {
          inits++;
          console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {} } }));
        } else if (msg.method === "tools/list") {
          console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "ping_count", description: "count", annotations: { readOnlyHint: true, destructiveHint: false } }] } }));
        } else if (msg.method === "tools/call") {
          calls++;
          if (msg.params?.arguments?.triggerListChanged) {
            console.log(JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }));
          }
          console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify({ pid: process.pid, inits, calls }) }] } }));
        }
      });
    `;

    const changedServers: string[] = [];
    const mcp = new McpClientManager(fetch, undefined, {
      onToolsListChanged: (id) => changedServers.push(id),
    });
    managers.push(mcp);

    const cfg: McpServerConfig = {
      id: "stdio-pool",
      name: "Pooled Stdio",
      transport: "stdio",
      command: process.execPath,
      args: ["-e", script],
      enabled: true,
      discoveredTools: [],
    };

    const disc = await mcp.testAndDiscover(cfg, 8000);
    expect(disc.ok).toBe(true);
    expect(disc.tools[0]).toMatchObject({ name: "ping_count", readOnly: true, destructiveHint: false });
    expect(mcp.activeSessions()).toHaveLength(1);

    const r1 = await mcp.callTool(cfg, "ping_count", {}, 8000);
    const r2 = await mcp.callTool(cfg, "ping_count", { triggerListChanged: true }, 8000);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    const p1 = JSON.parse(((r1.output as { content: { text: string }[] }).content[0]).text) as { pid: number; inits: number; calls: number };
    const p2 = JSON.parse(((r2.output as { content: { text: string }[] }).content[0]).text) as { pid: number; inits: number; calls: number };
    // Reused the exact same child process and initialized only once!
    expect(p1.pid).toBe(p2.pid);
    expect(p1.inits).toBe(1);
    expect(p2.inits).toBe(1);
    expect(p1.calls).toBe(1);
    expect(p2.calls).toBe(2);

    // notifications/tools/list_changed invalidated tool list cache / flagged dirty.
    expect(changedServers).toEqual(["stdio-pool"]);
    expect(mcp.hasToolsChanged("stdio-pool")).toBe(true);
    expect(mcp.consumeToolsChanged("stdio-pool")).toBe(true);
    expect(mcp.hasToolsChanged("stdio-pool")).toBe(false);

    // Config change (env) yields a different session key and replaces the old session.
    const updatedCfg: McpServerConfig = { ...cfg, env: { EXTRA: "1" } };
    expect(serverSessionKey(updatedCfg)).not.toBe(serverSessionKey(cfg));
    const r3 = await mcp.callTool(updatedCfg, "ping_count", {}, 8000);
    expect(r3.ok).toBe(true);
    const p3 = JSON.parse(((r3.output as { content: { text: string }[] }).content[0]).text) as { pid: number; calls: number };
    expect(p3.pid).not.toBe(p1.pid);
    expect(p3.calls).toBe(1);

    await mcp.close("stdio-pool");
    expect(mcp.activeSessions()).toHaveLength(0);
  });

  it("reaps idle pooled sessions after idleTtlMs", async () => {
    const script = `
      const rl = require("readline").createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        if (msg.method === "initialize") console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18" } }));
        if (msg.method === "tools/list") console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } }));
      });
    `;
    const mcp = new McpClientManager(fetch, undefined, { idleTtlMs: 80 });
    managers.push(mcp);
    const cfg: McpServerConfig = {
      id: "ttl-srv",
      name: "TTL",
      transport: "stdio",
      command: process.execPath,
      args: ["-e", script],
      enabled: true,
    };
    expect((await mcp.testAndDiscover(cfg, 5000)).ok).toBe(true);
    expect(mcp.activeSessions()).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 220));
    expect(mcp.activeSessions()).toHaveLength(0);
  });

  it("pools HTTP sessions, sends DELETE on close(), and retries once on expired 404 session", async () => {
    let initCount = 0;
    let deletedSession = "";
    let expireNext = false;
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        deletedSession = (init.headers as Record<string, string>)["Mcp-Session-Id"] ?? "";
        return new Response(null, { status: 204 });
      }
      const body = JSON.parse(String(init?.body)) as { id?: number; method: string };
      if (body.method === "initialize") {
        initCount++;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } }), {
          status: 200,
          headers: { "content-type": "application/json", "mcp-session-id": `s-${initCount}` },
        });
      }
      if (body.method === "notifications/initialized") {
        return new Response("", { status: 202 });
      }
      if (expireNext) {
        expireNext = false;
        return new Response("expired", { status: 404 });
      }
      if (body.method === "tools/list") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "t1", description: "d1" }] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "ok" }] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const mcp = new McpClientManager(fetchImpl as unknown as typeof fetch);
    managers.push(mcp);
    const cfg = makeHttpServerConfig();

    expect((await mcp.testAndDiscover(cfg)).ok).toBe(true);
    expect((await mcp.callTool(cfg, "t1", {})).ok).toBe(true);
    // Session reused: initialize called only once across discover + callTool!
    expect(initCount).toBe(1);

    // Simulate expired session on server: automatically invalidates and re-initializes once.
    expireNext = true;
    expect((await mcp.callTool(cfg, "t1", {})).ok).toBe(true);
    expect(initCount).toBe(2);

    await mcp.close(cfg.id);
    expect(deletedSession).toBe("s-2");
    expect(mcp.activeSessions()).toHaveLength(0);
  });

  it("supports nextCursor pagination without 200-tool silent truncation and parses destructiveHint", async () => {
    const allTools = Array.from({ length: 245 }, (_, i) => ({
      name: `tool_${i}`,
      description: `Tool ${i}`,
      annotations: {
        readOnlyHint: i % 2 === 0,
        destructiveHint: i % 5 === 0,
      },
    }));

    const fetchImpl = vi.fn(async (_u: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id?: number; method: string; params?: { cursor?: string } };
      if (body.method === "initialize") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (body.method === "tools/list") {
        const offset = Number(body.params?.cursor ?? 0);
        const page = allTools.slice(offset, offset + 100);
        const nextCursor = offset + 100 < allTools.length ? String(offset + 100) : undefined;
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: page, ...(nextCursor ? { nextCursor } : {}) } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("", { status: 202 });
    });

    const mcp = new McpClientManager(fetchImpl as unknown as typeof fetch);
    managers.push(mcp);
    const res = await mcp.testAndDiscover(makeHttpServerConfig());
    expect(res.ok).toBe(true);
    expect(res.tools).toHaveLength(245);
    expect(res.tools[0]).toMatchObject({ name: "tool_0", readOnly: true, destructiveHint: true });
    expect(res.tools[1]).toMatchObject({ name: "tool_1", readOnly: false, destructiveHint: false });
    expect(res.tools[244].name).toBe("tool_244");
  });

  it("handles notifications/tools/list_changed over HTTP SSE stream", async () => {
    const dirtyEvents: string[] = [];
    const fetchImpl = vi.fn(async (_u: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id?: number; method: string };
      if (body.method === "initialize") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (body.method === "tools/call") {
        const sse = [
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}`,
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "done" }] } })}`,
          "",
        ].join("\n\n");
        return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response("", { status: 202 });
    });

    const mcp = new McpClientManager(fetchImpl as unknown as typeof fetch, undefined, {
      onToolsListChanged: (id) => dirtyEvents.push(id),
    });
    managers.push(mcp);
    const out = await mcp.callTool(makeHttpServerConfig(), "t1", {});
    expect(out.ok).toBe(true);
    expect(dirtyEvents).toEqual(["srv-http"]);
    expect(mcp.hasToolsChanged("srv-http")).toBe(true);
  });
});

describe("McpClientManager — IP-pinned guardUrl SSRF protection, OAuth 2.1, Elicitation & mcp_search", () => {
  it("pins the resolved IP from guardUrl (preventing DNS rebinding TOCTOU) and blocks redirects", async () => {
    const srv = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: number; method: string };
        if (body.method === "initialize") {
          res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "pin-1" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } }));
          return;
        }
        if (body.method === "notifications/initialized") {
          res.writeHead(202);
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "pinned_ok", description: "ok" }] } }));
      });
    });
    httpServers.push(srv);
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = (srv.address() as { port: number }).port;

    // First lookup returns 127.0.0.1; a second lookup would return metadata IP (TOCTOU attack).
    let lookups = 0;
    const lookup = vi.fn(async () => {
      lookups++;
      return lookups === 1
        ? [{ address: "127.0.0.1", family: 4 }]
        : [{ address: "169.254.169.254", family: 4 }];
    });

    const mcp = new McpClientManager(fetch, undefined, {
      lookup,
      guardOptions: { server: false, allowPrivate: true, allowPlainHttp: true },
    });
    managers.push(mcp);

    const cfg = makeHttpServerConfig({ id: "pinned", url: `http://rebind.example.test:${port}/mcp` });
    const disc = await mcp.testAndDiscover(cfg, 5000);
    expect(disc.ok).toBe(true);
    expect(disc.tools[0].name).toBe("pinned_ok");
    // DNS was checked once and pinned for initialize + notification + tools/list!
    expect(lookups).toBe(1);

    // In shared server mode, loopback/metadata/private/plain-http are blocked by guardUrl.
    const strictMcp = new McpClientManager(fetch, undefined, {
      guardOptions: { server: true, allowPrivate: false, allowPlainHttp: false },
    });
    managers.push(strictMcp);
    expect((await strictMcp.testAndDiscover(makeHttpServerConfig({ url: `http://127.0.0.1:${port}/mcp` }))).error).toMatch(
      /does not call itself/,
    );
    expect((await strictMcp.testAndDiscover(makeHttpServerConfig({ url: "https://169.254.169.254/mcp" }))).error).toMatch(
      /never calls/,
    );
  });

  it("discovers RFC 9728 + RFC 8414 OAuth 2.1 metadata and rejects SSRF-unsafe authorization endpoints", async () => {
    expect(parseWwwAuthenticateResourceMetadata('Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", scope="mcp:read"')).toEqual({
      resourceMetadataUrl: "https://mcp.example.com/.well-known/oauth-protected-resource",
      scope: "mcp:read",
    });
    expect(protectedResourceMetadataUrl("https://mcp.example.com/v1/mcp")).toBe(
      "https://mcp.example.com/.well-known/oauth-protected-resource/v1/mcp",
    );
    expect(authorizationServerMetadataUrls("https://auth.example.com/tenant")).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server/tenant",
      "https://auth.example.com/tenant/.well-known/oauth-authorization-server",
      "https://auth.example.com/tenant/.well-known/openid-configuration",
    ]);

    const mockFetch = vi.fn(async (url: unknown) => {
      const s = String(url);
      if (s === "https://mcp.example.com/.well-known/oauth-protected-resource/mcp") {
        return new Response(
          JSON.stringify({
            resource: "https://mcp.example.com/mcp",
            authorization_servers: ["https://auth.example.com"],
            scopes_supported: ["read", "tools"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (s === "https://auth.example.com/.well-known/oauth-authorization-server") {
        return new Response(
          JSON.stringify({
            issuer: "https://auth.example.com",
            authorization_endpoint: "https://auth.example.com/authorize",
            token_endpoint: "https://auth.example.com/token",
            code_challenge_methods_supported: ["S256"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
    const meta = await discoverOAuthMetadata("https://mcp.example.com/mcp", {
      fetchImpl: mockFetch as unknown as typeof fetch,
      guardOptions: { server: true, allowPrivate: false, allowPlainHttp: false },
      lookup,
    });
    expect(meta.pkceSupported).toBe(true);
    expect(meta.authorizationServer.authorization_endpoint).toBe("https://auth.example.com/authorize");
    expect(meta.protectedResource.scopes_supported).toEqual(["read", "tools"]);

    // SSRF check: if auth server metadata returns a loopback/metadata token endpoint on a shared server, reject it!
    const evilFetch = vi.fn(async (url: unknown) => {
      if (String(url).includes("oauth-protected-resource")) {
        return new Response(JSON.stringify({ resource: "https://mcp.example.com/mcp", authorization_servers: ["https://auth.example.com"] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          issuer: "https://auth.example.com",
          authorization_endpoint: "https://auth.example.com/auth",
          token_endpoint: "http://169.254.169.254/latest/meta-data",
        }),
        { status: 200 },
      );
    });
    await expect(
      discoverOAuthMetadata("https://mcp.example.com/mcp", {
        fetchImpl: evilFetch as unknown as typeof fetch,
        guardOptions: { server: true, allowPrivate: false },
        lookup,
      }),
    ).rejects.toThrow(/never calls/);
  });

  it("surfaces URL-mode elicitation, blocks Form-mode secrets, and rejects deprecated sampling/createMessage", async () => {
    expect(isDeprecatedSamplingMethod("sampling/createMessage")).toBe(true);

    expect(
      validateElicitationRequest({
        mode: "url",
        message: "Authorize GitHub access",
        url: "https://github.com/login/oauth/authorize?client_id=123",
        elicitationId: "el-1",
      }),
    ).toEqual({
      ok: true,
      request: {
        mode: "url",
        message: "Authorize GitHub access",
        url: "https://github.com/login/oauth/authorize?client_id=123",
        elicitationId: "el-1",
      },
    });

    // Never Form-mode for secrets!
    const secretForm = validateElicitationRequest({
      mode: "form",
      message: "Enter your API key",
      requestedSchema: {
        type: "object",
        properties: { api_key: { type: "string" } },
      },
    });
    expect(secretForm.ok).toBe(false);
    if (!secretForm.ok) expect(secretForm.reason).toContain("never permitted for secrets");

    // Never non-http(s) URLs in URL-mode elicitation!
    expect(validateElicitationRequest({ mode: "url", message: "x", url: "javascript:alert(1)" }).ok).toBe(false);

    // End-to-end stdio server sending sampling/createMessage (rejected) + form secret elicitation (rejected) + URL elicitation (surfaced).
    const script = `
      const rl = require("readline").createInterface({ input: process.stdin });
      let samplingReply = null;
      let formReply = null;
      let urlReply = null;
      rl.on("line", (line) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        if (msg.method === "initialize") {
          console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18" } }));
        } else if (msg.method === "tools/call") {
          console.log(JSON.stringify({ jsonrpc: "2.0", id: 901, method: "sampling/createMessage", params: { messages: [] } }));
          console.log(JSON.stringify({ jsonrpc: "2.0", id: 902, method: "elicitation/create", params: { mode: "form", message: "pw", requestedSchema: { type: "object", properties: { password: { type: "string", format: "password" } } } } }));
          console.log(JSON.stringify({ jsonrpc: "2.0", id: 903, method: "elicitation/create", params: { mode: "url", message: "Sign in", url: "https://idp.example.com/auth", elicitationId: "e-903" } }));
        } else if (msg.id === 901) {
          samplingReply = msg;
        } else if (msg.id === 902) {
          formReply = msg;
        } else if (msg.id === 903) {
          urlReply = msg;
          console.log(JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            result: { content: [{ type: "text", text: JSON.stringify({ samplingReply, formReply, urlReply }) }] }
          }));
        }
      });
    `;

    const surfaced: Array<{ mode: string; url: string; elicitationId?: string }> = [];
    const mcp = new McpClientManager(fetch, undefined, {
      onElicitation: (req) => {
        surfaced.push(req);
        return { action: "accept" };
      },
    });
    managers.push(mcp);
    const res = await mcp.callTool(
      {
        id: "el-srv",
        name: "Elicit",
        transport: "stdio",
        command: process.execPath,
        args: ["-e", script],
        enabled: true,
      },
      "auth_needed",
      {},
      8000,
    );
    expect(res.ok).toBe(true);
    expect(res.elicitations).toHaveLength(1);
    expect(res.elicitations![0]).toMatchObject({ mode: "url", url: "https://idp.example.com/auth", elicitationId: "e-903" });
    expect(surfaced).toHaveLength(1);

    const replies = JSON.parse(((res.output as { content: { text: string }[] }).content[0]).text) as {
      samplingReply: { error: { code: number } };
      formReply: { error: { code: number; message: string } };
      urlReply: { result: { action: string } };
    };
    expect(replies.samplingReply.error.code).toBe(-32601);
    expect(replies.formReply.error.code).toBe(-32602);
    expect(replies.formReply.error.message).toContain("never permitted for secrets");
    expect(replies.urlReply.result.action).toBe("accept");
  });

  it("provides mcp_search dynamic tool filtering respecting enabled/allowed servers and safety hints", () => {
    const servers: McpServerConfig[] = [
      makeHttpServerConfig({
        id: "k8s",
        name: "Kubernetes",
        discoveredTools: [
          { name: "get_pods", description: "List pods in a namespace", readOnly: true, destructiveHint: false } as never,
          { name: "delete_pod", description: "Delete a pod", readOnly: false, destructiveHint: true } as never,
        ],
      }),
      makeHttpServerConfig({
        id: "disabled",
        name: "Disabled",
        enabled: false,
        discoveredTools: [{ name: "get_pods_secret", description: "Should never appear", readOnly: true }],
      }),
    ];

    expect(searchMcpTools(servers, { query: "pod" }).map((t) => t.qualifiedName).sort()).toEqual([
      "mcp__k8s__delete_pod",
      "mcp__k8s__get_pods",
    ]);
    expect(searchMcpTools(servers, { query: "pod", readOnlyOnly: true }).map((t) => t.name)).toEqual(["get_pods"]);
    expect(searchMcpTools(servers, { query: "pod", excludeDestructive: true }).map((t) => t.name)).toEqual(["get_pods"]);
    expect(searchMcpTools(servers, { query: "pods" }, ["other-srv"])).toEqual([]);
    expect(serverConfigHash(servers[0])).toHaveLength(16);
  });
});

describe("LocalMcpServer, McpEndpoint & mcpTools — resources/* and prompts/*", () => {
  const SNAP = {
    workspaceServers: [{ id: "s1", name: "db01", host: "db01.internal", port: 22, username: "ops", cluster: "prod" }],
    kbPages: [
      {
        id: "pg-pg16",
        kind: "procedure",
        title: "PostgreSQL 16 Vacuum Runbook",
        when: "When autovacuum falls behind",
        body: "Run `VACUUM (VERBOSE, ANALYZE)` during low traffic.",
        targets: ["db01"],
        sources: [{ docId: "d1", title: "DBA Notes" }],
        revision: 2,
        createdAt: 1000,
        updatedAt: 2000,
        updatedBy: "alice",
        history: [],
      },
    ],
    runbooks: [
      {
        id: "rb-failover",
        name: "Primary Failover",
        description: "Controlled failover procedure",
        inputs: [{ name: "cluster", type: "string", required: true, description: "Target cluster" }],
        steps: [{ id: "st1", title: "Check replication lag", kind: "check", command: "pg_stat_replication", expected: "0" }],
      },
    ],
    memories: [
      {
        id: "sk-oom",
        kind: "skill",
        scope: "cluster:prod",
        title: "Diagnose OOM kill",
        text: "Check dmesg -T and systemd journal for oom-killer events.",
        commandTemplate: "dmesg -T | grep -i oom",
        updatedAt: 2000,
      },
    ],
    workTickets: [],
    infraEdges: [],
  } as unknown as HubSnapshot;

  async function setupEndpoint(scopes: ("read" | "tickets" | "run")[] = ["read"]) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-mcpo-"));
    tmpDirs.push(dir);
    const tokens = new McpTokenStore(dir);
    await tokens.initialize();
    const { token } = await tokens.create({ userId: "u1", name: "Test Client", createdBy: "jacob", scopes });
    const audited: unknown[] = [];
    const deps = {
      tokens,
      hubFor: async (uid: string) =>
        uid === "u1"
          ? {
              request: async (req: HubRequest) => {
                if (req.action === "kb-page-read") {
                  return { ...SNAP, reply: { kbPage: SNAP.kbPages!.find((p) => p.id === req.id) } };
                }
                return SNAP;
              },
              actor: "Jacob",
              audit: async (e: unknown) => audited.push(e),
            }
          : undefined,
      enabled: () => true,
      rate: callBudget(),
    };
    return { token, tokens, deps, audited };
  }

  it("validates safe read-only sshs3://kb/... URIs and rejects traversal/other schemes", () => {
    expect(isSafeKbResourceUri("sshs3://kb/page/pg-pg16")).toBe(true);
    expect(isSafeKbResourceUri("sshs3://kb/runbook/rb-failover")).toBe(true);
    expect(isSafeKbResourceUri("sshs3://kb/pg-pg16")).toBe(true);

    expect(isSafeKbResourceUri("file:///etc/passwd")).toBe(false);
    expect(isSafeKbResourceUri("http://169.254.169.254/latest")).toBe(false);
    expect(isSafeKbResourceUri("sshs3://secrets/keys")).toBe(false);
    expect(isSafeKbResourceUri("sshs3://kb/../etc/passwd")).toBe(false);
    expect(isSafeKbResourceUri("sshs3://kb/page/%2e%2e")).toBe(false);
    expect(isSafeKbResourceUri("sshs3://kb/page/foo?bar=1")).toBe(false);
  });

  it("exposes KB pages & runbooks via resources/list & resources/read and starter/skill templates via prompts/list & prompts/get", async () => {
    const { token, deps, audited } = await setupEndpoint();
    const call = (body: unknown, extraHeaders: Record<string, string> = {}) =>
      handleMcpHttp(
        { method: "POST", headers: { authorization: `Bearer ${token}`, ...extraHeaders }, body: JSON.stringify(body) },
        deps,
      );

    // Advertises tools, resources, and prompts capabilities.
    const init = JSON.parse((await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).body);
    expect(init.result.capabilities).toEqual({ tools: {}, resources: {}, prompts: {} });

    // resources/list
    const rList = JSON.parse((await call({ jsonrpc: "2.0", id: 2, method: "resources/list" })).body);
    const uris = (rList.result.resources as Array<{ uri: string }>).map((r) => r.uri);
    expect(uris).toContain("sshs3://kb/page/pg-pg16");
    expect(uris).toContain("sshs3://kb/runbook/rb-failover");

    // resources/read (page + runbook)
    const rPage = JSON.parse(
      (await call({ jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: "sshs3://kb/page/pg-pg16" } })).body,
    );
    expect(rPage.result.contents[0].text).toContain("VACUUM (VERBOSE, ANALYZE)");
    expect(rPage.result.contents[0].mimeType).toBe("text/markdown");

    const rRb = JSON.parse(
      (await call({ jsonrpc: "2.0", id: 4, method: "resources/read", params: { uri: "sshs3://kb/runbook/rb-failover" } })).body,
    );
    expect(rRb.result.contents[0].text).toContain("pg_stat_replication");
    expect(audited.length).toBeGreaterThanOrEqual(2);

    // Unsafe URI rejected with -32602; missing valid URI returns -32002; unknown method still 404/-32601.
    const badUri = await call({ jsonrpc: "2.0", id: 5, method: "resources/read", params: { uri: "file:///etc/passwd" } });
    expect(badUri.status).toBe(200);
    expect(JSON.parse(badUri.body).error.code).toBe(-32602);

    const missingUri = await call({ jsonrpc: "2.0", id: 6, method: "resources/read", params: { uri: "sshs3://kb/page/does-not-exist" } });
    expect(JSON.parse(missingUri.body).error.code).toBe(-32002);

    const unknownMethod = await call({ jsonrpc: "2.0", id: 7, method: "subscriptions/listen" });
    expect(unknownMethod.status).toBe(404);
    expect(JSON.parse(unknownMethod.body).error.code).toBe(-32601);

    // prompts/list & prompts/get (starter, skill, runbook)
    const pList = JSON.parse((await call({ jsonrpc: "2.0", id: 8, method: "prompts/list" })).body);
    const promptNames = (pList.result.prompts as Array<{ name: string }>).map((p) => p.name);
    expect(promptNames).toContain("cluster-health-check");
    expect(promptNames).toContain("kb-runbook-lookup");
    expect(promptNames).toContain("skill:sk-oom");
    expect(promptNames).toContain("runbook:rb-failover");

    const pStarter = JSON.parse(
      (await call({ jsonrpc: "2.0", id: 9, method: "prompts/get", params: { name: "kb-runbook-lookup", arguments: { symptom: "autovacuum" } } })).body,
    );
    expect(pStarter.result.messages[0].content.text).toContain("autovacuum");

    const pSkill = JSON.parse(
      (await call({ jsonrpc: "2.0", id: 10, method: "prompts/get", params: { name: "skill:sk-oom", arguments: { target: "db01" } } })).body,
    );
    expect(pSkill.result.messages[0].content.text).toContain("dmesg -T | grep -i oom");

    const missingRequired = JSON.parse(
      (await call({ jsonrpc: "2.0", id: 11, method: "prompts/get", params: { name: "kb-runbook-lookup", arguments: {} } })).body,
    );
    expect(missingRequired.error.code).toBe(-32602);
  });

  it("enforces Origin, Host, and Bearer checks on LocalMcpServer while serving resources & prompts over loopback", async () => {
    const { token, deps } = await setupEndpoint();
    const local = new LocalMcpServer({
      tokens: deps.tokens,
      hubFor: deps.hubFor,
    });
    localServers.push(local);
    const addr = await local.set(true, 0);
    expect(addr).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

    // Origin header rejected with 403
    const browserRes = await fetch(addr!, {
      method: "POST",
      headers: { Origin: "https://evil.example", Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/list" }),
    });
    expect(browserRes.status).toBe(403);

    // Missing Bearer rejected with 401
    const unauthRes = await fetch(addr!, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "prompts/list" }),
    });
    expect(unauthRes.status).toBe(401);

    // Valid Bearer succeeds for resources/list and prompts/list
    const okRes = await fetch(addr!, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "resources/list" }),
    });
    expect(okRes.status).toBe(200);
    const okBody = (await okRes.json()) as { result: { resources: Array<{ uri: string }> } };
    expect(okBody.result.resources.some((r) => r.uri === "sshs3://kb/page/pg-pg16")).toBe(true);
  });
});
