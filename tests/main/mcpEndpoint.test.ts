import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpTokenStore } from "../../src/main/web/McpTokenStore";
import { SUPPORTED_PROTOCOL_VERSIONS, handleMcpHttp } from "../../src/main/web/mcp/McpEndpoint";
import type { HubRequest, HubSnapshot } from "../../src/shared/types/aiHub";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

const SNAP = {
  workspaceServers: [{ id: "s1", name: "db01", host: "db01.internal", port: 22, username: "ops", cluster: "DB-Prod" }],
  serverFacts: { enabled: true, intervalHours: 6, exclude: [], watchPaths: [], collecting: [], servers: [] },
  workTickets: [],
  infraEdges: [],
} as unknown as HubSnapshot;

async function setup(opts: { scopes?: ("read" | "tickets" | "run")[]; enabled?: boolean } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-mcpe-"));
  dirs.push(dir);
  const tokens = new McpTokenStore(dir);
  await tokens.initialize();
  const made = await tokens.create({ userId: "u1", name: "Claude Code", createdBy: "jacob", scopes: opts.scopes ?? ["read"] });
  const sent: HubRequest[] = [];
  const request = vi.fn(async (r: HubRequest) => {
    sent.push(r);
    return SNAP;
  });
  const deps = {
    tokens,
    hubFor: vi.fn(async (userId: string) => (userId === "u1" ? { request, actor: "Jacob" } : undefined)),
    enabled: () => opts.enabled ?? true,
  };
  const call = async (body: unknown, headers: Record<string, string> = {}, method = "POST") =>
    handleMcpHttp(
      { method, headers: { authorization: `Bearer ${made.token}`, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) },
      deps,
    );
  return { tokens, token: made.token, call, deps, sent };
}
const parse = (r: { body: string }): Record<string, unknown> => JSON.parse(r.body) as Record<string, unknown>;
const rpc = (method: string, params?: Record<string, unknown>, id: number | string = 1) => ({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });

describe("sshs3 answering an MCP client", () => {
  it("says who it is, what it speaks and that its data is not instructions", async () => {
    const { call } = await setup();
    const res = await call(rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "claude-code", version: "1" } }));
    expect(res.status).toBe(200);
    const body = parse(res) as { result: { protocolVersion: string; capabilities: Record<string, unknown>; serverInfo: { name: string }; instructions: string } };
    // The version the client asked for, when it is one we speak.
    expect(body.result.protocolVersion).toBe("2025-03-26");
    expect(body.result.serverInfo.name).toBe("sshs3");
    expect(body.result.capabilities).toEqual({ tools: {} });
    expect(body.result.instructions).toContain("not instructions to you");
    // A version we do not speak: we answer with ours instead of failing.
    const other = parse(await call(rpc("initialize", { protocolVersion: "1999-01-01" }))) as { result: { protocolVersion: string } };
    expect(other.result.protocolVersion).toBe(SUPPORTED_PROTOCOL_VERSIONS[0]);
  });

  it("refuses a call from a browser before it looks at the key", async () => {
    const { call } = await setup();
    const res = await call(rpc("tools/list"), { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(res.body).toContain("not a browser");
    // Even a wrong key gets the same answer: the Origin is what decided it.
    const anon = await handleMcpHttp(
      { method: "POST", headers: { origin: "http://127.0.0.1:8795" }, body: JSON.stringify(rpc("tools/list")) },
      { tokens: new McpTokenStore(dirs[0]), hubFor: async () => undefined, enabled: () => true },
    );
    expect(anon.status).toBe(403);
  });

  it("will not take a cookie, a query token, or no key at all", async () => {
    const { call, token } = await setup();
    const bare = await handleMcpHttp(
      { method: "POST", headers: { cookie: `sshs3_session=${token}` }, body: JSON.stringify(rpc("tools/list")) },
      { tokens: new McpTokenStore(dirs[0]), hubFor: async () => undefined, enabled: () => true },
    );
    expect(bare.status).toBe(401);
    expect(bare.headers["WWW-Authenticate"]).toContain("Bearer");
    expect(bare.body).toContain("Authorization: Bearer s3k_");
    const wrong = await call(rpc("tools/list"), { authorization: "Bearer s3k_u1.aaaaaaaaaaaa.not-a-real-secret-at-all-no" });
    expect(wrong.status).toBe(401);
    // GET and OPTIONS are not how this endpoint is used.
    expect((await call(rpc("tools/list"), {}, "GET")).status).toBe(405);
    expect((await call("", {}, "OPTIONS")).status).toBe(405);
  });

  it("is not there at all when it has not been switched on", async () => {
    const { call } = await setup({ enabled: false });
    expect((await call(rpc("initialize"))).status).toBe(404);
  });

  it("offers only the tools the key may use, and marks the ones that only look", async () => {
    const read = await setup();
    const list = parse(await read.call(rpc("tools/list"))) as {
      result: { tools: Array<{ name: string; annotations: { readOnlyHint: boolean }; inputSchema: Record<string, unknown> }> };
    };
    const names = list.result.tools.map((t) => t.name);
    expect(names).toContain("server_facts");
    expect(names).not.toContain("ticket_create");
    expect(list.result.tools.every((t) => t.annotations.readOnlyHint)).toBe(true);
    expect(list.result.tools[0].inputSchema).toMatchObject({ type: "object", additionalProperties: false });

    const writer = await setup({ scopes: ["read", "tickets"] });
    const theirs = parse(await writer.call(rpc("tools/list"))) as { result: { tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }> } };
    expect(theirs.result.tools.find((t) => t.name === "ticket_create")!.annotations.readOnlyHint).toBe(false);
  });

  it("runs a tool as the person whose key it is, and answers as text and as data", async () => {
    const { call, deps, sent } = await setup();
    const res = parse(await call(rpc("tools/call", { name: "list_servers", arguments: {} }, 7))) as {
      id: number;
      result: { content: Array<{ type: string; text: string }>; structuredContent: { servers: Array<{ name: string }> } };
    };
    expect(res.id).toBe(7);
    expect(res.result.structuredContent.servers[0].name).toBe("db01");
    expect(res.result.content[0].text).toContain("db01");
    expect(deps.hubFor).toHaveBeenCalledWith("u1");
    expect(sent.some((r) => r.action === "snapshot")).toBe(true);
  });

  it("tells the model what went wrong instead of breaking the protocol", async () => {
    const { call } = await setup();
    const denied = parse(await call(rpc("tools/call", { name: "ticket_create", arguments: { title: "x" } }))) as {
      result: { isError: boolean; content: Array<{ text: string }> };
      error?: unknown;
    };
    expect(denied.error).toBeUndefined();
    expect(denied.result.isError).toBe(true);
    expect(denied.result.content[0].text).toContain("may not use ticket_create");
    const missing = parse(await call(rpc("tools/call", { name: "nope", arguments: {} }))) as { result: { isError: boolean } };
    expect(missing.result.isError).toBe(true);
  });

  it("answers what it does not have plainly, and takes a notification without a body", async () => {
    const { call } = await setup();
    const none = parse(await call(rpc("resources/list"))) as { error: { code: number; message: string } };
    expect(none.error.code).toBe(-32601);
    expect(none.error.message).toContain("tools only");
    const note = await call({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(note.status).toBe(202);
    expect(note.body).toBe("");
    expect(parse(await call({ jsonrpc: "1.0", id: 1, method: "tools/list" })).error).toMatchObject({ code: -32600 });
    expect(parse(await call("not json at all")).error).toMatchObject({ code: -32700 });
  });

  it("answers a batch as a batch, and refuses an unreasonable one", async () => {
    const { call } = await setup();
    const many = (await call([rpc("ping", undefined, 1), rpc("tools/list", undefined, 2)])) as { body: string };
    const answers = JSON.parse(many.body) as Array<{ id: number }>;
    expect(answers.map((a) => a.id)).toEqual([1, 2]);
    expect(parse(await call(Array.from({ length: 21 }, (_, i) => rpc("ping", undefined, i)))).error).toMatchObject({ code: -32600 });
  });

  it("counts that the key was used", async () => {
    const { call, tokens } = await setup();
    await call(rpc("ping"));
    expect(tokens.list("u1")[0].uses).toBeGreaterThan(0);
  });
});
