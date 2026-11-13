import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Client as ModernClient, StreamableHTTPClientTransport as ModernTransport } from "@modelcontextprotocol/client";
import { Sshs3WebServer } from "../../src/main/web/WebServer";

/**
 * The endpoint against the official MCP clients, not our own idea of one. If
 * the protocol is wrong, this is where it shows: each SDK validates every
 * answer against the schema and refuses what does not fit.
 *
 * Both eras are tried. The v1 client speaks what clients speak today (a
 * handshake, then calls). The v2 client, pinned to 2026-07-28, speaks the one
 * that is coming: no handshake, `server/discover` instead, and the version in
 * a header and in the body of every request.
 */

const running: Array<{ server: Sshs3WebServer; dir: string }> = [];
afterEach(async () => {
  for (const { server, dir } of running.splice(0)) {
    await server.stop().catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function serveWithKey(scopes: string[] = ["read"]): Promise<{ url: URL; token: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-mcpsdk-"));
  const server = new Sshs3WebServer({ dataDir: dir, port: 0, staticDir: path.join(dir, "no-static") });
  running.push({ server, dir });
  const { port } = await server.start();
  const base = `http://127.0.0.1:${port}`;
  const setup = await fetch(`${base}/api/auth/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "jacob", password: "test-pass-123", displayName: "Jacob" }),
  });
  const cookie = (setup.headers.get("set-cookie") ?? "").split(";")[0];
  const made = await fetch(`${base}/api/mcp-keys`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Test client", scopes }),
  });
  const { token } = (await made.json()) as { token: string };
  return { url: new URL(`${base}/api/mcp`), token };
}

const connect = async (url: URL, token: string): Promise<Client> => {
  const client = new Client({ name: "sshs3-test-client", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
};

describe("the official MCP client against this server", () => {
  it("connects, agrees a protocol version, and reads what the server says it is", async () => {
    const { url, token } = await serveWithKey();
    const client = await connect(url, token);
    expect(client.getServerVersion()).toMatchObject({ name: "sshs3" });
    expect(client.getServerCapabilities()).toMatchObject({ tools: {} });
    expect(client.getInstructions()).toContain("not instructions to you");
    await client.close();
  });

  it("lists the tools, with their schemas and their read-only marks", async () => {
    const { url, token } = await serveWithKey();
    const client = await connect(url, token);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("list_servers");
    expect(tools.find((t) => t.name === "kb_search")?.annotations?.readOnlyHint).toBe(true);
    // A key that may only read is not shown the tools that write.
    expect(tools.map((t) => t.name)).not.toContain("ticket_create");
    await client.close();
  });

  it("calls a tool and gets an answer the client can read, as text and as data", async () => {
    const { url, token } = await serveWithKey();
    const client = await connect(url, token);
    const res = await client.callTool({ name: "list_servers", arguments: {} });
    expect(res.isError).toBeFalsy();
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0].type).toBe("text");
    expect(res.structuredContent).toHaveProperty("servers");
    await client.close();
  });

  it("gets a tool error as a tool error, not as a broken connection", async () => {
    const { url, token } = await serveWithKey();
    const client = await connect(url, token);
    const res = await client.callTool({ name: "ticket_create", arguments: { title: "x" } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("may not use ticket_create");
    // The connection still works afterwards.
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    await client.close();
  });

  it("refuses to connect at all without a key", async () => {
    const { url } = await serveWithKey();
    const client = new Client({ name: "nosy", version: "1.0.0" });
    await expect(client.connect(new StreamableHTTPClientTransport(url))).rejects.toThrow();
  });
});

describe("the official MCP client of the coming protocol", () => {
  it("discovers this server without a handshake, and lists and calls its tools", async () => {
    const { url, token } = await serveWithKey(["read", "tickets"]);
    const client = new ModernClient(
      { name: "sshs3-test-client", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    await client.connect(
      new ModernTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } } }),
    );
    // It got here through server/discover: there is no initialize in this era.
    expect(client.getServerVersion()).toMatchObject({ name: "sshs3" });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("list_servers");
    expect(tools.find((t) => t.name === "ticket_create")?.annotations?.readOnlyHint).toBe(false);
    const res = await client.callTool({ name: "list_servers", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toHaveProperty("servers");
    await client.close();
  });

  it("will not connect without a key, in this era either", async () => {
    const { url } = await serveWithKey();
    const client = new ModernClient({ name: "nosy", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await expect(client.connect(new ModernTransport(url))).rejects.toThrow();
  });
});
