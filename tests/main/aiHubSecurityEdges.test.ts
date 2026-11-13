import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fetchUrl } from "../../src/main/ai/hub/KbExtract";
import { keepSecrets } from "../../src/main/ai/hub/hubHelpers";
import { WebAuthService } from "../../src/main/web/WebAuthService";

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
  vi.unstubAllGlobals();
});
const tmp = async (name: string): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `sshs3-${name}-`));
  disposals.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
};

describe("a link for the knowledge base", () => {
  const page = "<html><head><title>Runbook</title></head><body><h1>Failover</h1><p>Promote the replica with pg_ctl promote and then repoint the pooler at it.</p></body></html>";
  const lookup = (address: string) => async () => [{ address, family: 4 }];

  it("is checked before it is called and again at every redirect", async () => {
    const server = { server: true, allowPrivate: false, allowPlainHttp: true };
    const never = vi.fn(async () => new Response(page, { headers: { "content-type": "text/html" } }));
    await expect(fetchUrl("http://169.254.169.254/latest/meta-data/", never as never, server)).rejects.toThrow("never calls");
    await expect(fetchUrl("http://127.0.0.1:8080/admin", never as never, server)).rejects.toThrow("does not call itself");
    await expect(fetchUrl("https://wiki.internal/x", never as never, { ...server, lookup: lookup("10.0.0.8") })).rejects.toThrow("SSHS3_ALLOW_PRIVATE_ADDRESSES=1");
    expect(never).not.toHaveBeenCalled();

    // A public page that redirects into the server's own network is stopped at the redirect.
    const hops: string[] = [];
    const redirecting = vi.fn(async (url: string) => {
      hops.push(url);
      return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/iam" } });
    });
    await expect(fetchUrl("https://docs.example.com/a", redirecting as never, { ...server, lookup: lookup("93.184.216.34") })).rejects.toThrow("never calls");
    expect(hops).toEqual(["https://docs.example.com/a"]);

    // A redirect that is fine is followed, by hand, and the page is read.
    const moved = vi.fn(async (url: string) =>
      url.endsWith("/old") ? new Response(null, { status: 301, headers: { location: "/new" } }) : new Response(page, { headers: { "content-type": "text/html" } }),
    );
    const got = await fetchUrl("https://docs.example.com/old", moved as never, { ...server, lookup: lookup("93.184.216.34") });
    expect(got).toMatchObject({ url: "https://docs.example.com/new", title: "Runbook", format: "html" });
    expect(got.text).toContain("pg_ctl promote");
    // And not for ever.
    const loop = vi.fn(async () => new Response(null, { status: 302, headers: { location: "/again" } }));
    await expect(fetchUrl("https://docs.example.com/x", loop as never, { ...server, lookup: lookup("93.184.216.34") })).rejects.toThrow("redirects too many times");
    await expect(fetchUrl("https://docs.example.com/x", (async () => new Response(null, { status: 302, headers: { location: "file:///etc/passwd" } })) as never, { ...server, lookup: lookup("93.184.216.34") })).rejects.toThrow("Only http and https");
  });

  it("is fetched over the real network from the address that was checked", async () => {
    const seen: string[] = [];
    const web = http.createServer((req, res) => {
      seen.push(req.url ?? "");
      if (req.url === "/old") return void res.writeHead(302, { Location: "/doc" }).end();
      if (req.url === "/away") return void res.writeHead(302, { Location: "http://169.254.169.254/x" }).end();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page);
    });
    await new Promise<void>((r) => web.listen(0, "127.0.0.1", r));
    disposals.push(() => new Promise((r) => web.close(() => r(undefined))));
    const base = `http://127.0.0.1:${(web.address() as { port: number }).port}`;
    // On a person's own computer their own machine is theirs to read from.
    const got = await fetchUrl(`${base}/old`);
    expect(got).toMatchObject({ url: `${base}/doc`, title: "Runbook" });
    expect(seen).toEqual(["/old", "/doc"]);
    await expect(fetchUrl(`${base}/away`)).rejects.toThrow("never calls");
    // The same link typed into a shared server is refused before anything is sent.
    seen.length = 0;
    await expect(fetchUrl(`${base}/doc`, undefined, { server: true, allowPrivate: true, allowPlainHttp: true })).rejects.toThrow("does not call itself");
    expect(seen).toEqual([]);
  });
});

describe("secret values that the interface never sees", () => {
  it("keeps what was not retyped, replaces what was, and drops what was removed", () => {
    const stored = { GITHUB_TOKEN: "ghp_real", REGION: "eu" };
    expect(keepSecrets(stored, undefined)).toEqual(stored);
    expect(keepSecrets(stored, { GITHUB_TOKEN: "", REGION: "us" })).toEqual({ GITHUB_TOKEN: "ghp_real", REGION: "us" });
    expect(keepSecrets(stored, { GITHUB_TOKEN: "" })).toEqual({ GITHUB_TOKEN: "ghp_real" });
    expect(keepSecrets(stored, { NEW: "v", " ": "x", GONE: "" })).toEqual({ NEW: "v" });
    expect(keepSecrets(stored, {})).toBeUndefined();
    expect(keepSecrets(undefined, { A: "" })).toBeUndefined();
  });

  it("holds for MCP servers through the hub: names leave it, values do not", async () => {
    const { HubService } = await import("../../src/main/ai/hub/HubService");
    const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
    setDemoModeForTesting(false);
    const dir = await tmp("mcp");
    const hub = new HubService({ changed: () => {}, inventoryTargets: async () => [], backgroundChanged: async () => {}, openSchedule: async () => "s1", show: () => {}, aiConfigFilePath: path.join(dir, "ai.json") } as never, dir);
    disposals.push(async () => { await hub.dispose(); setDemoModeForTesting(undefined); });
    await hub.initialize();
    let snap = await hub.request({ action: "mcp-save", server: { name: "GitHub", transport: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer ghp_supersecret123456" }, enabled: false } as never });
    const id = snap.mcpServers![0].id;
    expect(snap.mcpServers![0]).toMatchObject({ name: "GitHub", enabled: false, headers: { Authorization: "" } });
    expect(JSON.stringify(snap)).not.toContain("ghp_supersecret123456");
    // What an agent is given about the workspace does not carry it either.
    const extra = await (hub as unknown as { collectExtraContext: () => Promise<unknown> }).collectExtraContext();
    expect(JSON.stringify(extra)).not.toContain("ghp_supersecret123456");
    const stored = (): Record<string, string> | undefined => hub.store.data.mcpServers!.find((m) => m.id === id)!.headers;
    expect(stored()).toEqual({ Authorization: "Bearer ghp_supersecret123456" });

    // The form saves what it was shown: the name with an empty value. The value stays, and so does "switched off".
    snap = await hub.request({ action: "mcp-save", server: { id, name: "GitHub (renamed)", transport: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "" }, env: {} } as never });
    expect(stored()).toEqual({ Authorization: "Bearer ghp_supersecret123456" });
    expect(snap.mcpServers![0]).toMatchObject({ name: "GitHub (renamed)", enabled: false });
    // Enable/disable sends the server back as the interface has it.
    snap = await hub.request({ action: "mcp-save", server: { ...snap.mcpServers![0], enabled: true } });
    expect(stored()).toEqual({ Authorization: "Bearer ghp_supersecret123456" });
    expect(snap.mcpServers![0].enabled).toBe(true);
    // A retyped value replaces; a removed row removes.
    await hub.request({ action: "mcp-save", server: { id, name: "GitHub", transport: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer new", "X-Team": "ops" } } as never });
    expect(stored()).toEqual({ Authorization: "Bearer new", "X-Team": "ops" });
    await hub.request({ action: "mcp-save", server: { id, name: "GitHub", transport: "http", url: "https://mcp.example.com/mcp", headers: {} } as never });
    expect(stored()).toBeUndefined();
  });

  it("on a shared server, takes no path on the server from a signed-in user", async () => {
    const { HubService } = await import("../../src/main/ai/hub/HubService");
    const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
    setDemoModeForTesting(false);
    const dir = await tmp("shared");
    const hub = new HubService({ changed: () => {}, inventoryTargets: async () => [], backgroundChanged: async () => {}, openSchedule: async () => "s1", show: () => {}, aiConfigFilePath: path.join(dir, "ai.json"), alertHookOwner: "u1" } as never, dir);
    disposals.push(async () => { await hub.dispose(); setDemoModeForTesting(undefined); });
    await hub.initialize();
    const snap = await hub.request({ action: "configure", config: {}, preferences: { sharedWorkspacePath: "/etc/shadow" } } as never);
    expect(snap.preferences.sharedWorkspacePath).toBeUndefined();
    await expect(hub.request({ action: "kb-ingest-folder", folderPath: "/root/.ssh" })).rejects.toThrow("cannot be read into the knowledge base from the browser");
    await expect(hub.request({ action: "kb-ingest-url", url: "http://127.0.0.1:1/x" })).rejects.toThrow("does not call itself");
    // A file that is put into the knowledge base from an editor has what looks like a secret masked.
    const saved = await hub.request({ action: "kb-ingest-text", title: "app.conf", text: "db_host = pg-01\ndb_password = hunter2hunter2\nretries = 3\n".repeat(3), mask: true, sourceRef: "sftp:/etc/app.conf" });
    expect(saved.reply!.ingest!.added).toHaveLength(1);
    const doc = hub.store.data.kbDocuments!.at(-1)!;
    expect(doc.content).toContain("db_host = pg-01");
    expect(doc.content).not.toContain("hunter2hunter2");
    expect(doc.sourceRef).toBe("sftp:/etc/app.conf");
  });
});

describe("sign-in on the server", () => {
  async function service() {
    const dir = await tmp("auth");
    const auth = new WebAuthService(dir);
    await auth.initialize();
    const { user, sessionToken } = await auth.setupInitialAdmin({ username: "jacob", password: "test-pass-123", displayName: "Jacob" });
    return { auth, dir, user, sessionToken };
  }

  it("keeps a session by its hash, and a session stored the old way still works", async () => {
    const { auth, dir, user, sessionToken } = await service();
    const file = path.join(dir, "web-users.json");
    expect(await fs.readFile(file, "utf8")).not.toContain(sessionToken);
    expect((await auth.verifySession(sessionToken))?.id).toBe(user.id);
    expect(await auth.verifySession(`${sessionToken.slice(0, -1)}0`)).toBeNull();
    expect(await auth.verifySession("")).toBeNull();

    // A file written by an older version, with the token itself in it.
    const data = JSON.parse(await fs.readFile(file, "utf8")) as { sessions: Array<Record<string, unknown>> };
    data.sessions = [{ token: "a".repeat(64), userId: user.id, createdAt: Date.now(), expiresAt: Date.now() + 60_000 }];
    await fs.writeFile(file, JSON.stringify(data));
    const reopened = new WebAuthService(dir);
    await reopened.initialize();
    expect((await reopened.verifySession("a".repeat(64)))?.id).toBe(user.id);
    await reopened.createSession(user.id);
    expect(await fs.readFile(file, "utf8")).not.toContain("a".repeat(64));
    await reopened.revokeSession("a".repeat(64));
    expect(await reopened.verifySession("a".repeat(64))).toBeNull();
    await expect(reopened.login("jacob", "wrong")).rejects.toThrow("Wrong user name or password");
  });

  it("does not replace a user's key with one it cannot work out the public half of", async () => {
    const { auth, user } = await service();
    const priv = "-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key\n-----END OPENSSH PRIVATE KEY-----";
    await expect(auth.importUserSshKey(user.id, "just some text")).rejects.toThrow("Not a valid private SSH key");
    // Given with its public half, it is taken as given.
    const kept = await auth.importUserSshKey(user.id, priv, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGiven me@host");
    expect(kept.publicKey).toBe("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGiven me@host");
    const before = await fs.readFile(kept.privateKeyPath, "utf8");
    // Without it, a key the public half cannot be derived from is refused, and the key that was there stays.
    await expect(auth.importUserSshKey(user.id, priv.replace("not-a-real-key", "another-broken-key"))).rejects.toThrow("could not be worked out");
    expect(await fs.readFile(kept.privateKeyPath, "utf8")).toBe(before);
    expect((await fs.readdir(path.dirname(kept.privateKeyPath))).filter((n) => n.includes(".import-"))).toEqual([]);
    const pub = (await auth.toPublicUser({ id: user.id } as never).catch(() => undefined)) as { sshPublicKey?: string } | undefined;
    expect(JSON.stringify(pub ?? {})).not.toContain("installerad");
  });
});
