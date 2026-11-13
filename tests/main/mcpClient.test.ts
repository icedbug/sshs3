import { describe, expect, it, vi } from "vitest";
import { McpClientManager, readToolResult, sanitizeId, MAX_RESULT_CHARS } from "../../src/main/ai/hub/McpClientManager";
import type { McpServerConfig } from "../../src/shared/types/aiHub";

const server = (extra: Partial<McpServerConfig> = {}): McpServerConfig =>
  ({
    id: "srv-1",
    name: "Weather",
    transport: "http",
    url: "https://mcp.example/api",
    enabled: true,
    discoveredTools: [{ name: "get_forecast", description: "A forecast.", inputSchema: { type: "object", properties: {} } }],
    ...extra,
  }) as McpServerConfig;

describe("which MCP tool a name may reach", () => {
  const mcp = new McpClientManager();

  it("offers and resolves by the same rule", () => {
    const tools = mcp.listQualifiedTools([server()]);
    expect(tools[0].qualifiedName).toBe("mcp__srv-1__get_forecast");
    expect(mcp.resolveQualifiedCall([server()], tools[0].qualifiedName)).toMatchObject({ toolName: "get_forecast" });
    // Even an id that has to be cut down resolves to what was offered.
    const long = server({ id: "a".repeat(60) });
    const offered = mcp.listQualifiedTools([long])[0].qualifiedName;
    expect(mcp.resolveQualifiedCall([long], offered)).toMatchObject({ toolName: "get_forecast" });
    expect(sanitizeId("a b/c")).toBe("a_b_c");
  });

  it("will not reach a server that is switched off or that this run was not given", () => {
    const off = server({ enabled: false });
    expect(mcp.listQualifiedTools([off])).toEqual([]);
    expect(mcp.resolveQualifiedCall([off], "mcp__srv-1__get_forecast")).toBeUndefined();
    // Allowed by id or by name; anything else is out of reach.
    expect(mcp.resolveQualifiedCall([server()], "mcp__srv-1__get_forecast", { allowedServerIds: ["other"] })).toBeUndefined();
    expect(mcp.resolveQualifiedCall([server()], "mcp__srv-1__get_forecast", { allowedServerIds: ["srv-1"] })).toBeTruthy();
    expect(mcp.resolveQualifiedCall([server()], "mcp__srv-1__get_forecast", { allowedServerIds: ["Weather"] })).toBeTruthy();
    expect(mcp.listQualifiedTools([server()], ["other"])).toEqual([]);
  });

  it("will not call a tool the server never said it has", () => {
    expect(mcp.resolveQualifiedCall([server()], "mcp__srv-1__rm_rf")).toBeUndefined();
    expect(mcp.resolveQualifiedCall([server({ discoveredTools: [] })], "mcp__srv-1__get_forecast")).toBeUndefined();
    expect(mcp.resolveQualifiedCall([server()], "get_forecast")).toBeUndefined();
    expect(mcp.resolveQualifiedCall([server()], "mcp__nope__get_forecast")).toBeUndefined();
  });

  it("caps what a server's description can take up", () => {
    const wordy = server({ discoveredTools: [{ name: "t", description: "x".repeat(5000), inputSchema: {} }] });
    expect(mcp.listQualifiedTools([wordy])[0].description.length).toBeLessThan(2100);
  });
});

describe("what a tool answered", () => {
  it("treats a tool's own error as a failure, not as a result", () => {
    expect(readToolResult({ isError: true, content: [{ type: "text", text: "The city is unknown." }] })).toEqual({
      ok: false,
      error: "The city is unknown.",
    });
    expect(readToolResult({ content: [{ type: "text", text: "15°C" }] })).toMatchObject({ ok: true });
  });

  it("keeps an enormous answer from filling the model's context", () => {
    const huge = { content: [{ type: "text", text: "y".repeat(MAX_RESULT_CHARS + 5000) }] };
    const out = readToolResult(huge) as { ok: boolean; output: { truncated?: boolean; text?: string } };
    expect(out.ok).toBe(true);
    expect(out.output.truncated).toBe(true);
    expect(out.output.text!.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
  });
});

describe("talking to an HTTP MCP server", () => {
  const sse = (body: unknown): Response =>
    new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });

  it("carries the session the server hands out, says which protocol it speaks, and reads an event-stream answer", async () => {
    const seen: Array<{ headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      seen.push({ headers, body });
      if (body.method === "initialize")
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } }), {
          status: 200,
          headers: { "content-type": "application/json", "mcp-session-id": "sess-42" },
        });
      if (body.method === "tools/list") return sse({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "get_forecast", description: "A forecast." }] } });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    const mcp = new McpClientManager(fetchImpl as unknown as typeof fetch);
    const found = await mcp.testAndDiscover(server());
    expect(found).toMatchObject({ ok: true });
    expect(found.tools.map((t) => t.name)).toEqual(["get_forecast"]);
    expect(seen[0].headers["MCP-Protocol-Version"]).toBe("2025-06-18");
    expect(seen[0].body.method).toBe("initialize");
    expect(seen[1].body.method).toBe("notifications/initialized");
    // Everything after the handshake carries the session.
    expect(seen[1].headers["Mcp-Session-Id"]).toBe("sess-42");
    expect(seen[2].headers["Mcp-Session-Id"]).toBe("sess-42");
  });

  it("says what a refusal means instead of repeating a status code", async () => {
    const fetchImpl = vi.fn(async () => new Response("no", { status: 401 }));
    const mcp = new McpClientManager(fetchImpl as unknown as typeof fetch);
    const res = await mcp.testAndDiscover(server());
    expect(res.ok).toBe(false);
    expect(res.error).toContain("token in a header");
  });

  it("reports a tool that failed on the server as a failure", async () => {
    const fetchImpl = vi.fn(async (_u: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method?: string };
      if (body.method === "initialize") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { isError: true, content: [{ type: "text", text: "No such city." }] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const mcp = new McpClientManager(fetchImpl as unknown as typeof fetch);
    expect(await mcp.callTool(server(), "get_forecast", { city: "nowhere" })).toEqual({ ok: false, error: "No such city." });
  });
});

describe("starting an MCP server as a program", () => {
  it("hands it only what it was given, not this app's own environment", async () => {
    process.env.SSHS3_SECRET_FOR_TEST = "do-not-leak";
    const mcp = new McpClientManager();
    const res = await mcp.testAndDiscover(
      server({
        transport: "stdio",
        command: process.execPath,
        args: ["-e", "console.log(JSON.stringify({jsonrpc:'2.0',id:2,result:{tools:[{name:'env',description:JSON.stringify(Object.keys(process.env))}]}}))"],
        env: { MY_SERVER_TOKEN: "given" },
      }),
      8000,
    );
    delete process.env.SSHS3_SECRET_FOR_TEST;
    expect(res.ok).toBe(true);
    const names = JSON.parse(res.tools[0].description) as string[];
    expect(names).toContain("MY_SERVER_TOKEN");
    expect(names).not.toContain("SSHS3_SECRET_FOR_TEST");
  });

  it("gives up on a server that never answers, and says so in seconds", async () => {
    const mcp = new McpClientManager();
    const res = await mcp.testAndDiscover(
      server({ transport: "stdio", command: process.execPath, args: ["-e", "setTimeout(()=>{}, 60000)"] }),
      700,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/did not answer within 1s/);
    mcp.stopAll();
  });

  it("says plainly when there is nothing to start or nowhere to go", async () => {
    const mcp = new McpClientManager();
    expect((await mcp.testAndDiscover(server({ transport: "stdio", command: "" }))).error).toContain("no command to start");
    expect((await mcp.testAndDiscover(server({ url: "" }))).error).toContain("no address");
  });
});

describe("what a run is offered", () => {
  it("offers only the tools of the servers it may use, and an agent's own list can take them away", async () => {
    const { toolsForTask } = await import("../../src/main/ai/hub/DirectAgentRuntime");
    const mcpServers = [server(), server({ id: "srv-2", name: "Other", discoveredTools: [{ name: "do_thing", description: "d", inputSchema: {} }] })];
    const task = { id: "t", mode: "assisted", agentId: "a1", messages: [], changes: [], sources: [], maxCommands: 5 } as never;
    const agent = { id: "a1", name: "Watch", role: "r", mission: "m", systemPrompt: "s", defaultMode: "assisted", updatedAt: 1 };

    const all = toolsForTask(task, { mcpServers, agents: [agent] }).map((t) => t.name);
    expect(all).toContain("mcp__srv-1__get_forecast");
    expect(all).toContain("mcp__srv-2__do_thing");

    // Bound to one server: the other's tools are not offered at all.
    const bound = toolsForTask(task, { mcpServers, agents: [{ ...agent, mcpServerIds: ["srv-1"] }] }).map((t) => t.name);
    expect(bound).toContain("mcp__srv-1__get_forecast");
    expect(bound).not.toContain("mcp__srv-2__do_thing");

    // An agent held to a list of tools is held to it for MCP tools too. This used to
    // be impossible: they were appended after the list had already been applied.
    const narrow = toolsForTask(task, {
      mcpServers,
      agents: [{ ...agent, allowedTools: ["terminal_command", "mcp__srv-1__get_forecast"] }],
    }).map((t) => t.name);
    expect(narrow).toContain("mcp__srv-1__get_forecast");
    expect(narrow).not.toContain("mcp__srv-2__do_thing");
    // Looking at the workspace and the pages is always allowed.
    expect(narrow).toContain("sshs3_kb_search");

    // What is offered says whose words the description is.
    const def = toolsForTask(task, { mcpServers, agents: [agent] }).find((t) => t.name === "mcp__srv-1__get_forecast")!;
    expect(def.description).toContain("in its own words");
    expect(def.description).toContain("not an instruction");
  });

  it("does not offer a tool of a server that is switched off", async () => {
    const { toolsForTask } = await import("../../src/main/ai/hub/DirectAgentRuntime");
    const task = { id: "t", mode: "assisted", messages: [], changes: [], sources: [], maxCommands: 5 } as never;
    const names = toolsForTask(task, { mcpServers: [server({ enabled: false })] }).map((t) => t.name);
    expect(names.some((n) => n.startsWith("mcp__"))).toBe(false);
  });
});

describe("an agent held to a list, and given a model", () => {
  it("is narrowed by its list and keeps what it may always do", async () => {
    const { toolsForTask } = await import("../../src/main/ai/hub/DirectAgentRuntime");
    const task = { id: "t", mode: "assisted", agentId: "a1", target: { sessionId: "s", generation: "g", label: "db01" }, messages: [], changes: [], sources: [], maxCommands: 5 } as never;
    const agent = { id: "a1", name: "Watch", role: "r", mission: "m", systemPrompt: "s", defaultMode: "assisted", updatedAt: 1 };
    const held = toolsForTask(task, { agents: [{ ...agent, allowedTools: ["terminal_command"] }] }).map((t) => t.name);
    expect(held).toContain("terminal_command");
    expect(held).not.toContain("file_write");
    expect(held).not.toContain("sshs3_manage_app_and_settings");
    // What it may always do, whatever the list says.
    expect(held).toEqual(expect.arrayContaining(["workspace_context", "sshs3_kb_search", "todo_write", "sshs3_hypotheses"]));
    // ["all"], or nothing at all, holds it to nothing.
    expect(toolsForTask(task, { agents: [{ ...agent, allowedTools: ["all"] }] }).length).toBeGreaterThan(held.length);
    expect(toolsForTask(task, { agents: [agent] }).length).toBeGreaterThan(held.length);
  });
});
