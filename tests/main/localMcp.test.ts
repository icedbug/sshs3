import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * The desktop app as an MCP server: off until switched on, loopback only, and
 * nothing without one of this person's own keys.
 */

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const d of disposals.splice(0)) await d();
});

async function makeHub() {
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(false);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-localmcp-"));
  const hub = new HubService(
    { changed: () => {}, inventoryTargets: async () => [], backgroundChanged: async () => {}, openSchedule: async () => "s1", show: () => {}, aiConfigFilePath: path.join(dir, "ai.json") } as never,
    dir,
  );
  disposals.push(async () => {
    await hub.dispose();
    setDemoModeForTesting(undefined);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await hub.initialize();
  return { hub, dir };
}

describe("the app answering this person's own agent", () => {
  it("is off until it is switched on, and then says where it answers", async () => {
    const { hub } = await makeHub();
    expect((await hub.snapshot()).localMcp).toMatchObject({ enabled: false, keys: [] });
    const on = await hub.request({ action: "mcp-local-set", enabled: true } as never);
    expect(on.localMcp!.enabled).toBe(true);
    // Loopback and nothing else.
    expect(on.localMcp!.address).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const off = await hub.request({ action: "mcp-local-set", enabled: false } as never);
    expect(off.localMcp!.address).toBeUndefined();
  });

  it("answers the official client with one of this person's keys, and nothing without one", async () => {
    const { hub } = await makeHub();
    const started = await hub.request({ action: "mcp-local-set", enabled: true } as never);
    const url = new URL(started.localMcp!.address!);
    const made = await hub.request({ action: "mcp-key-create", name: "My Claude Code", scopes: ["read"] } as never);
    const token = (made.reply!.mcpKey as { token: string }).token;
    expect(token).toMatch(/^s3k_local\./);
    // Listed afterwards without the secret.
    expect(JSON.stringify((await hub.snapshot()).localMcp!.keys)).not.toContain(token.split(".")[2]);

    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    expect(client.getServerVersion()).toMatchObject({ name: "sshs3" });
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("list_servers");
    await client.close();

    // Without a key it cannot connect at all.
    const nosy = new Client({ name: "nosy", version: "1.0.0" });
    await expect(nosy.connect(new StreamableHTTPClientTransport(url))).rejects.toThrow();

    // And a key that was taken back stops working.
    const keys = (await hub.snapshot()).localMcp!.keys as Array<{ id: string }>;
    await hub.request({ action: "mcp-key-revoke", id: keys[0].id } as never);
    const after = new Client({ name: "again", version: "1.0.0" });
    await expect(
      after.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } } })),
    ).rejects.toThrow();
  });

  it("gives a launched ACP agent only its selected workspace tools and omits the bridge for unsupported selections", async () => {
    const { hub, dir } = await makeHub();
    await hub.request({ action: "configure", config: { enabled: true }, preferences: { proposeMemories: false } });
    await hub.request({ action: "mcp-local-set", enabled: true, port: 0 });
    const script = path.join(dir, "list-workspace-tools.cjs");
    // This synthetic runner reports only the tool names supplied through ACP's session/new.
    await fs.writeFile(script, String.raw`
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
let report = "no workspace bridge";
require("node:readline").createInterface({ input: process.stdin }).on("line", async (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === "initialize") return send({ id, result: { protocolVersion: 1, agentCapabilities: {} } });
  if (method === "session/new") {
    const server = params.mcpServers.find((entry) => entry.name === "sshs3");
    if (server) {
      if (new URL(server.url).hostname !== "127.0.0.1") throw new Error("Expected the local test listener");
      const headers = Object.fromEntries(server.headers.map(({ name, value }) => [name, value]));
      const res = await fetch(server.url, { method: "POST", headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
      const rpc = await res.json();
      report = "workspace tools: " + rpc.result.tools.map((tool) => tool.name).sort().join(", ");
    }
    return send({ id, result: { sessionId: "local-list" } });
  }
  if (method === "session/prompt") {
    send({ method: "session/update", params: { sessionId: "local-list",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: report } } } });
    send({ id, result: { stopReason: "end_turn" } });
  }
});
`);
    await hub.request({ action: "runner-save", runner: { id: "list", name: "List local tools", command: process.execPath, args: [script], cwd: dir } });
    const createKey = vi.spyOn(hub.mcpTokens(), "create");
    for (const [id, allowedTools, expected] of [
      ["limited", ["kb_search", "file_write"], "workspace tools: kb_search"],
      ["unsupported", ["file_write"], "no workspace bridge"],
    ] as const) {
      await hub.request({ action: "agent-save", agent: { id, name: id, role: "Reader", mission: "List available tools", systemPrompt: "", defaultMode: "advice", runnerId: "list", allowedTools: [...allowedTools] } });
      const snap = await hub.request({ action: "ticket-save", ticket: { title: id, assigneeAgentId: id } });
      const ticketId = snap.workTickets!.find(ticket => ticket.title === id)!.id;
      await hub.request({ action: "ticket-start", id: ticketId });
      await vi.waitFor(() => {
        const ticket = hub.store.data.workTickets?.find(ticket => ticket.id === ticketId);
        expect(ticket?.status).toBe("review");
        expect(ticket?.result).toBe(expected);
      }, { timeout: 8000 });
    }
    expect(createKey).toHaveBeenCalledTimes(1);
    expect(createKey.mock.calls[0][0]).toMatchObject({ scopes: ["read"], tools: ["kb_search"] });
  });

  it("refuses a call that carries an Origin, so a page on this machine gets nowhere", async () => {
    const { hub } = await makeHub();
    const started = await hub.request({ action: "mcp-local-set", enabled: true } as never);
    const made = await hub.request({ action: "mcp-key-create", name: "k", scopes: ["read"] } as never);
    const token = (made.reply!.mcpKey as { token: string }).token;
    const res = await fetch(started.localMcp!.address!, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, origin: "http://evil.example" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(403);
  });
});
