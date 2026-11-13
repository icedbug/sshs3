import { afterEach, describe, expect, it } from "vitest";
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
