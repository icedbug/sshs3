import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpTokenStore, parseMcpToken } from "../../src/main/web/McpTokenStore";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});
async function store(): Promise<McpTokenStore> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-mcpk-"));
  dirs.push(dir);
  const s = new McpTokenStore(dir);
  await s.initialize();
  return s;
}

describe("keys that let somebody's own agent reach this sshs3", () => {
  it("shows the key once and keeps only its hash", async () => {
    const s = await store();
    const { token, view } = await s.create({ userId: "u1", name: "My Claude Code", createdBy: "jacob", scopes: ["read", "tickets"] });
    expect(token).toMatch(/^s3k_u1\.[0-9a-f]{12}\.[A-Za-z0-9_-]{40,}$/);
    expect(view).toMatchObject({ name: "My Claude Code", scopes: ["read", "tickets"], uses: 0, expired: false });
    expect(JSON.stringify(view)).not.toContain(token.split(".")[2]);
    const file = JSON.parse(await fs.readFile(path.join(dirs[0], "mcp-tokens.json"), "utf8")) as { tokens: Array<Record<string, unknown>> };
    expect(JSON.stringify(file)).not.toContain(token.split(".")[2]);
    expect(file.tokens[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(s.list("u1").map((t) => t.name)).toEqual(["My Claude Code"]);
    expect(s.list("u2")).toEqual([]);
  });

  it("takes the right key and nothing else", async () => {
    const s = await store();
    const { token, view } = await s.create({ userId: "u1", name: "k", createdBy: "jacob", scopes: ["read"] });
    expect(s.verify(token)?.id).toBe(view.id);
    const [head, id, secret] = token.split(".");
    expect(s.verify(`${head}.${id}.${secret.slice(0, -1)}x`)).toBeUndefined();
    expect(s.verify(`s3k_u2.${id}.${secret}`)).toBeUndefined();
    expect(s.verify(`${head}.ffffffffffff.${secret}`)).toBeUndefined();
    expect(s.verify(secret)).toBeUndefined();
    expect(s.verify(undefined)).toBeUndefined();
    expect(s.verify("s3k_u1.deadbeef")).toBeUndefined();
    expect(parseMcpToken("s3k_u1.abc.short")).toBeUndefined();
  });

  it("stops taking a key that was revoked, that ran out, or whose person was removed", async () => {
    const s = await store();
    const a = await s.create({ userId: "u1", name: "a", createdBy: "jacob", scopes: ["read"] });
    const b = await s.create({ userId: "u1", name: "b", createdBy: "jacob", scopes: ["read"], expiresInDays: 1 });
    expect(await s.revoke("u2", a.view.id)).toBe(false);
    expect(await s.revoke("u1", a.view.id)).toBe(true);
    expect(s.verify(a.token)).toBeUndefined();
    expect(s.list("u1").map((t) => t.name)).toEqual(["b"]);
    const later = Date.now() + 2 * 24 * 3600_000;
    expect(s.verify(b.token, later)).toBeUndefined();
    expect(s.list("u1", later)[0].expired).toBe(true);
    await s.forgetUser("u1");
    expect(s.verify(b.token)).toBeUndefined();
    expect(s.list("u1")).toEqual([]);
  });

  it("will not make a key that may run commands without naming the one server", async () => {
    const s = await store();
    await expect(s.create({ userId: "u1", name: "k", createdBy: "jacob", scopes: ["run"] })).rejects.toThrow(/one server/);
    const ok = await s.create({ userId: "u1", name: "k", createdBy: "jacob", scopes: ["run"], serverId: "srv-1" });
    expect(ok.view).toMatchObject({ scopes: ["read", "run"], serverId: "srv-1" });
    // Reading is always allowed; a scope nobody has heard of is not.
    const plain = await s.create({ userId: "u1", name: "p", createdBy: "jacob", scopes: ["sudo" as never] });
    expect(plain.view.scopes).toEqual(["read"]);
  });

  it("counts use, and a second store on the same folder sees the same keys", async () => {
    const s = await store();
    const { token, view } = await s.create({ userId: "u1", name: "k", createdBy: "jacob", scopes: ["read"] });
    await s.noteUse(view.id, 1_000_000);
    await s.noteUse(view.id, 1_000_500);
    expect(s.list("u1")[0]).toMatchObject({ uses: 2, lastUsedAt: 1_000_500 });
    const again = new McpTokenStore(dirs[0]);
    await again.initialize();
    expect(again.verify(token)?.name).toBe("k");
  });

  it("will not let one person keep an endless pile of keys", async () => {
    const s = await store();
    for (let i = 0; i < 20; i++) await s.create({ userId: "u1", name: `k${i}`, createdBy: "jacob", scopes: ["read"] });
    await expect(s.create({ userId: "u1", name: "one too many", createdBy: "jacob", scopes: ["read"] })).rejects.toThrow(/Revoke one/);
    // Somebody else is not affected, and revoking makes room again.
    await s.create({ userId: "u2", name: "theirs", createdBy: "ada", scopes: ["read"] });
    await s.revoke("u1", s.list("u1")[0].id);
    await s.create({ userId: "u1", name: "room again", createdBy: "jacob", scopes: ["read"] });
  });
});
