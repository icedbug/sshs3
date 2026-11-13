import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Sshs3WebServer } from "../../src/main/web/WebServer";

const running: Array<{ server: Sshs3WebServer; dir: string }> = [];
afterEach(async () => {
  for (const { server, dir } of running.splice(0)) {
    await server.stop().catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  delete process.env.SSHS3_MCP;
});

async function serve(): Promise<{ base: string; server: Sshs3WebServer; cookie: string; userId: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-mcpweb-"));
  const server = new Sshs3WebServer({ dataDir: dir, port: 0, staticDir: path.join(dir, "no-static") });
  running.push({ server, dir });
  const { port } = await server.start();
  const base = `http://127.0.0.1:${port}`;
  const res = await fetch(`${base}/api/auth/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "jacob", password: "test-pass-123", displayName: "Jacob" }),
  });
  const body = (await res.json()) as { user: { id: string } };
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  return { base, server, cookie, userId: body.user.id };
}

const rpc = (method: string, params?: Record<string, unknown>, id: number = 1): string =>
  JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });

describe("the MCP endpoint on the team server", () => {
  it("makes a key while signed in, and the key then works without a session", async () => {
    const { base, cookie } = await serve();
    const made = await fetch(`${base}/api/mcp-keys`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "My Claude Code", scopes: ["read"] }),
    });
    const { token, key } = (await made.json()) as { token: string; key: { id: string; name: string } };
    expect(token).toMatch(/^s3k_/);
    expect(key.name).toBe("My Claude Code");

    // Listed afterwards without the secret.
    const listed = (await (await fetch(`${base}/api/mcp-keys`, { headers: { cookie } })).json()) as { keys: Array<Record<string, unknown>> };
    expect(listed.keys).toHaveLength(1);
    expect(JSON.stringify(listed.keys)).not.toContain(token.split(".")[2]);

    const answer = await fetch(`${base}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: rpc("initialize", { protocolVersion: "2025-06-18" }),
    });
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as { result: { serverInfo: { name: string } } };
    expect(body.result.serverInfo.name).toBe("sshs3");

    const tools = (await (
      await fetch(`${base}/api/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: rpc("tools/list"),
      })
    ).json()) as { result: { tools: Array<{ name: string }> } };
    expect(tools.result.tools.map((t) => t.name)).toContain("kb_search");
  });

  it("takes no session cookie, and refuses a call that carries an Origin", async () => {
    const { base, cookie } = await serve();
    const signedIn = await fetch(`${base}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: rpc("tools/list"),
    });
    expect(signedIn.status).toBe(401);

    const made = await fetch(`${base}/api/mcp-keys`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "k", scopes: ["read"] }),
    });
    const { token } = (await made.json()) as { token: string };
    const fromBrowser = await fetch(`${base}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, origin: `${base}` },
      body: rpc("tools/list"),
    });
    expect(fromBrowser.status).toBe(403);
  });

  it("revokes a key, and will not let one person revoke another's", async () => {
    const { base, cookie } = await serve();
    const made = await fetch(`${base}/api/mcp-keys`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "k", scopes: ["read", "tickets"] }),
    });
    const { token, key } = (await made.json()) as { token: string; key: { id: string } };
    expect((await fetch(`${base}/api/mcp-keys/${key.id}`, { method: "DELETE" })).status).toBe(401);
    expect((await fetch(`${base}/api/mcp-keys/${key.id}`, { method: "DELETE", headers: { cookie } })).status).toBe(200);
    const after = await fetch(`${base}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: rpc("tools/list"),
    });
    expect(after.status).toBe(401);
  });

  it("will not make a key that may run commands without one server, and refuses an unknown scope", async () => {
    const { base, cookie } = await serve();
    const bad = await fetch(`${base}/api/mcp-keys`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "k", scopes: ["run"] }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain("one server");
    const odd = await fetch(`${base}/api/mcp-keys`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "k", scopes: ["admin"] }),
    });
    expect(((await odd.json()) as { key: { scopes: string[] } }).key.scopes).toEqual(["read"]);
  });

  it("is not there when it is switched off", async () => {
    process.env.SSHS3_MCP = "0";
    const { base, cookie } = await serve();
    const made = await fetch(`${base}/api/mcp-keys`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "k", scopes: ["read"] }),
    });
    const { token } = (await made.json()) as { token: string };
    const res = await fetch(`${base}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: rpc("tools/list"),
    });
    expect(res.status).toBe(404);
  });
});
