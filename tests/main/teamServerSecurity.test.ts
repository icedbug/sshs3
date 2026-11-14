import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpClientManager } from "../../src/main/ai/hub/McpClientManager";
import type { QueueStore } from "../../src/main/ai/hub/LearningQueue";
import { WorkSync } from "../../src/main/ai/hub/WorkSync";
import { WebAuthService } from "../../src/main/web/WebAuthService";
import type { McpServerConfig, WorkspaceServerSummary } from "../../src/shared/types/aiHub";

/**
 * What one signed-in person can reach on a shared server, and what a teammate
 * is handed through the team bucket. From the evaluation of the team server.
 */

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const d of disposals.splice(0).reverse()) await d();
  vi.unstubAllEnvs();
});

type Inner = {
  s3Workspace: { canUseBucket: () => boolean; objects: QueueStore };
  syncSharedSetup: (sync: WorkSync) => Promise<boolean>;
  kbNetwork?: { fetchImpl: typeof fetch; lookup: (host: string) => Promise<{ address: string; family: number }[]> };
};

async function makeHub(host: Record<string, unknown> = {}) {
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(false);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-teamsec-"));
  const hub = new HubService(
    {
      changed: () => {},
      inventoryTargets: async () => [],
      backgroundChanged: async () => {},
      openSchedule: async () => "s1",
      show: () => {},
      aiConfigFilePath: path.join(dir, "ai.json"),
      workspaceServers: async () => [],
      ...host,
    } as never,
    dir,
  );
  disposals.push(async () => {
    await hub.dispose();
    setDemoModeForTesting(undefined);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await hub.initialize();
  return { hub, dir, inner: hub as unknown as Inner };
}

const member = { alertHookOwner: "u2", teamAdmin: () => false, defaultActorName: "Erik Holm" };
const admin = { alertHookOwner: "u1", teamAdmin: () => true, defaultActorName: "Anna Lind" };

function memoryBucket(): QueueStore & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  return {
    files,
    list: async (dir) => [...files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1)),
    read: async (p) => files.get(p),
    write: async (p, c) => void files.set(p, c),
    remove: async (p) => void files.delete(p),
  };
}

const settle = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("an MCP server that runs as a program, on a shared server", () => {
  const program = (marker: string): McpServerConfig =>
    ({
      id: "x",
      name: "x",
      transport: "stdio",
      command: process.execPath,
      args: ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran")`],
      enabled: true,
      status: "unknown",
      discoveredTools: [],
    }) as McpServerConfig;

  it("is not added by a member, by hand or from a preset", async () => {
    const { hub } = await makeHub(member);
    await expect(hub.request({ action: "mcp-save", server: program("unused") })).rejects.toThrow(/Only an administrator/);
    await expect(hub.request({ action: "mcp-install-preset", presetId: "preset-mcp-kubernetes" })).rejects.toThrow(/Only an administrator/);
    expect(hub.store.data.mcpServers ?? []).toHaveLength(0);
    // One with an address is a member's to add.
    const snap = await hub.request({ action: "mcp-save", server: { name: "Docs", transport: "http", url: "https://mcp.example.com/mcp" } as never });
    expect(snap.mcpServers).toHaveLength(1);
  });

  it("is not started for a member, even when one was saved before the rule existed", async () => {
    const { hub, dir } = await makeHub(member);
    const marker = path.join(dir, "ran.txt");
    hub.store.data.mcpServers = [program(marker)];
    const snap = await hub.request({ action: "mcp-test", id: "x" });
    expect(snap.mcpServers![0]).toMatchObject({ status: "error" });
    expect(snap.mcpServers![0].lastError).toMatch(/Only an administrator/);
    // Nor when a run calls one of its tools.
    const called = await hub.mcp.callTool(hub.store.data.mcpServers[0], "anything", {});
    expect(called).toMatchObject({ ok: false });
    await settle(300);
    expect(existsSync(marker)).toBe(false);
  });

  it("is an administrator's to add, and anybody's on their own computer", async () => {
    for (const host of [admin, {}]) {
      const { hub } = await makeHub(host);
      const snap = await hub.request({ action: "mcp-save", server: { ...program("unused"), enabled: false } });
      expect(snap.mcpServers![0]).toMatchObject({ transport: "stdio" });
    }
  });

  it("does not let a member open the local MCP listener on the server's host", async () => {
    const { hub } = await makeHub(member);
    await expect(hub.request({ action: "mcp-local-set", enabled: true, port: 0 })).rejects.toThrow(/Only an administrator/);
    expect(hub.store.data.preferences.localMcp?.enabled ?? false).toBe(false);
  });
});

describe("an external agent's runner, on a shared server", () => {
  const runner = (marker: string) => ({
    id: "stand-in",
    name: "Stand-in",
    command: process.execPath,
    args: ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran")`],
    cwd: os.tmpdir(),
  });

  it("is not saved by a member", async () => {
    const { hub } = await makeHub(member);
    await expect(hub.request({ action: "runner-save", runner: runner("unused") } as never)).rejects.toThrow(/Only an administrator/);
    expect(hub.store.data.externalRunners ?? []).toHaveLength(0);
  });

  it("is not started for a member, even when one was saved before the rule existed", async () => {
    const { hub, dir } = await makeHub(member);
    await hub.request({ action: "configure", config: { enabled: true } });
    const marker = path.join(dir, "ran.txt");
    hub.store.data.externalRunners = [{ ...runner(marker), updatedAt: Date.now() }];
    await hub.request({ action: "agent-save", agent: { name: "Stand-in agent", role: "x", mission: "x", defaultMode: "assisted", runnerId: "stand-in" } } as never);
    const agent = hub.store.data.agents!.find((a) => a.name === "Stand-in agent")!;
    await expect(hub.request({ action: "start", task: { prompt: "do nothing", mode: "assisted", agentId: agent.id, agentName: agent.name } } as never)).rejects.toThrow(/Only an administrator/);
    await settle(300);
    expect(existsSync(marker)).toBe(false);
  });

  it("is an administrator's to save, and anybody's on their own computer", async () => {
    for (const host of [admin, {}]) {
      const { hub } = await makeHub(host);
      await hub.request({ action: "runner-save", runner: runner("unused") } as never);
      expect(hub.store.data.externalRunners).toHaveLength(1);
    }
  });
});

describe("how a runner's program is started on Windows", () => {
  it("runs a program directly, and a .cmd through cmd.exe with every word quoted for it", async () => {
    const { runnerSpawn } = await import("../../src/main/ai/hub/AcpRuntime");
    const env = { PATH: "C:\\Program Files\\nodejs;C:\\Windows", PATHEXT: ".com;.exe;.bat;.cmd", ComSpec: "C:\\Windows\\system32\\cmd.exe" };
    const files = new Set(["C:\\Program Files\\nodejs\\node.exe", "C:\\Program Files\\nodejs\\npx.cmd"]);
    const exists = (f: string): boolean => files.has(f);
    // An .exe: no shell, so a space in its path or an & in an argument is nothing special.
    expect(runnerSpawn("node", ["x & calc"], "win32", env, exists)).toEqual({ file: "C:\\Program Files\\nodejs\\node.exe", args: ["x & calc"], verbatim: false });
    expect(runnerSpawn("C:\\Program Files\\nodejs\\node.exe", ["a"], "win32", env, exists).file).toBe("C:\\Program Files\\nodejs\\node.exe");
    // A .cmd: cmd.exe, and what would be an operator to it is escaped.
    const npx = runnerSpawn("npx", ["-y", "pkg & calc", 'say "hi"'], "win32", env, exists);
    expect(npx.file).toBe("C:\\Windows\\system32\\cmd.exe");
    expect(npx.verbatim).toBe(true);
    expect(npx.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    const line = npx.args[3];
    expect(line).toContain("C:\\Program^ Files\\nodejs\\npx.cmd");
    expect(line).not.toMatch(/[^^]&/);
    expect(line).toContain("^^^&");
    // Elsewhere nothing changes.
    expect(runnerSpawn("npx", ["-y", "a b"], "linux")).toEqual({ file: "npx", args: ["-y", "a b"], verbatim: false });
  });
});

describe("an MCP server with an address", () => {
  const http = (over: Partial<McpServerConfig> = {}): McpServerConfig =>
    ({ id: "h", name: "h", transport: "http", url: "https://mcp.example.com/mcp", enabled: true, status: "unknown", discoveredTools: [], ...over }) as McpServerConfig;
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("is not connected just because something answered with JSON", async () => {
    // A status page: 200 and JSON, to every request.
    const page = new McpClientManager((async () => json({ status: "ok", uptime: 12 })) as unknown as typeof fetch);
    expect(await page.testAndDiscover(http())).toMatchObject({ ok: false, error: expect.stringMatching(/not as an MCP server/) });
    // It greets like one, and then has no list of tools to give.
    const half = new McpClientManager((async (_u: unknown, init?: RequestInit) =>
      (JSON.parse(String(init?.body)) as { method?: string }).method === "initialize" ? json({ jsonrpc: "2.0", id: 1, result: {} }) : json({ ok: true })) as unknown as typeof fetch);
    expect(await half.testAndDiscover(http())).toMatchObject({ ok: false, error: expect.stringMatching(/not as an MCP server/) });
    // A real one with no tools is connected, with none.
    const real = new McpClientManager((async (_u: unknown, init?: RequestInit) =>
      (JSON.parse(String(init?.body)) as { method?: string }).method === "initialize"
        ? json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {} } })
        : json({ jsonrpc: "2.0", id: 2, result: { tools: [] } })) as unknown as typeof fetch);
    expect(await real.testAndDiscover(http())).toEqual({ ok: true, tools: [] });
  });

  it("is not followed to wherever it redirects", async () => {
    const seen: Array<RequestInit | undefined> = [];
    const mcp = new McpClientManager((async (_u: unknown, init?: RequestInit) => {
      seen.push(init);
      return new Response("", { status: 302, headers: { location: "http://127.0.0.1:2299/status" } });
    }) as unknown as typeof fetch);
    const result = await mcp.testAndDiscover(http());
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/redirects elsewhere/) });
    expect(seen[0]?.redirect).toBe("manual");
  });

  it("asks before every start and every call whether the server may be reached", async () => {
    const fetchImpl = vi.fn(async () => json({}));
    const mcp = new McpClientManager(fetchImpl as unknown as typeof fetch, () => {
      throw new Error("not from here");
    });
    expect(await mcp.testAndDiscover(http())).toEqual({ ok: false, tools: [], error: "not from here" });
    expect(await mcp.callTool(http(), "t", {})).toEqual({ ok: false, error: "not from here" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("on a shared server is not the server itself or the network around it", async () => {
    const { hub, inner } = await makeHub(member);
    inner.kbNetwork = { fetchImpl: fetch, lookup: async () => [{ address: "93.184.216.34", family: 4 }] };
    for (const [url, why] of [
      ["http://127.0.0.1:2299/status", /does not call itself/],
      ["http://169.254.169.254/latest/meta-data", /never calls/],
      ["http://10.20.0.31:9000/mcp", /private network/],
      ["http://mcp.example.com/mcp", /has to be https/],
    ] as const) {
      hub.store.data.mcpServers = [http({ url })];
      const snap = await hub.request({ action: "mcp-test", id: "h" });
      expect(snap.mcpServers![0].status).toBe("error");
      expect(snap.mcpServers![0].lastError).toMatch(why);
    }
  });

  it("on a person's own computer may be one on that computer", async () => {
    const { hub } = await makeHub();
    // Nothing listens there: the point is that it is tried, not refused.
    hub.store.data.mcpServers = [http({ url: "http://127.0.0.1:1/mcp" })];
    const snap = await hub.request({ action: "mcp-test", id: "h" });
    expect(snap.mcpServers![0].status).toBe("error");
    expect(snap.mcpServers![0].lastError).not.toMatch(/does not call itself/);
  });
});

describe("the original file of a knowledge base document", () => {
  const upload = (name: string, text: string) => ({ action: "kb-ingest-file" as const, name, mime: "text/plain", dataBase64: Buffer.from(text).toString("base64") });
  const SECRET = "REPL_PASSWORD=hunter2hunter2-Zx9\nREPL_HOST=db-01.nordvik.lan\nREPL_USER=replicator\n";

  it("stays with the person who added it when its text needed masking, and the text is masked here too", async () => {
    const { hub, inner } = await makeHub({ defaultActorName: "Sara Nyberg" });
    const bucket = memoryBucket();
    inner.s3Workspace.canUseBucket = () => true;
    Object.assign(inner.s3Workspace.objects, bucket);

    await hub.request(upload("db01-replication.env", SECRET));
    await hub.request(upload("runbook.md", "# Restart nginx\n\nReload the service and check the status page afterwards.\n"));
    await settle();
    const [env, runbook] = hub.store.data.kbDocuments!.slice(-2);
    expect(env.content).toContain("db-01.nordvik.lan");
    expect(env.content).not.toContain("hunter2hunter2");
    expect(env.original).toMatchObject({ name: "db01-replication.env", keptLocal: true });
    expect(runbook.original?.keptLocal).toBeUndefined();
    // Only the file that held nothing to mask went to the team.
    expect([...bucket.files.keys()]).toEqual([`kb/originals/${runbook.id}/runbook.md`]);
    // The person who added it still has their own file.
    const mine = await hub.request({ action: "kb-original", id: env.id });
    expect(Buffer.from(mine.reply!.download!.dataBase64, "base64").toString()).toBe(SECRET);

    // A teammate has the masked text and is told why there is no file.
    const mate = await makeHub({ defaultActorName: "Erik Holm" });
    mate.inner.s3Workspace.canUseBucket = () => true;
    Object.assign(mate.inner.s3Workspace.objects, bucket);
    mate.hub.store.data.kbDocuments = [{ ...env, chunks: [] }, { ...runbook, chunks: [] }];
    await expect(mate.hub.request({ action: "kb-original", id: env.id })).rejects.toThrow(/was not shared with the team\. Sara Nyberg has it/);
    const shared = await mate.hub.request({ action: "kb-original", id: runbook.id });
    expect(Buffer.from(shared.reply!.download!.dataBase64, "base64").toString()).toContain("Restart nginx");
  });

  it("is removed from a teammate's computer when the document is removed", async () => {
    const bucket = memoryBucket();
    const a = await makeHub({ defaultActorName: "Sara Nyberg" });
    const b = await makeHub({ defaultActorName: "Erik Holm" });
    for (const { inner } of [a, b]) {
      inner.s3Workspace.canUseBucket = () => true;
      Object.assign(inner.s3Workspace.objects, bucket);
    }
    await a.hub.request(upload("runbook.md", "# Restart nginx\n\nReload the service and check the status page afterwards.\n"));
    await settle();
    const doc = a.hub.store.data.kbDocuments!.at(-1)!;
    await a.inner.syncSharedSetup(new WorkSync(bucket));
    await b.inner.syncSharedSetup(new WorkSync(bucket));
    // The teammate opens the original: it is fetched and kept on their computer.
    await b.hub.request({ action: "kb-original", id: doc.id });
    const kept = path.join(b.dir, "kb-originals", doc.id, "runbook.md");
    expect(existsSync(kept)).toBe(true);

    await settle(5);
    await a.hub.request({ action: "kb-delete", id: doc.id });
    await a.inner.syncSharedSetup(new WorkSync(bucket));
    await b.inner.syncSharedSetup(new WorkSync(bucket));
    await settle();
    expect((b.hub.store.data.kbDocuments ?? []).some((d) => d.id === doc.id)).toBe(false);
    expect(existsSync(kept)).toBe(false);
  });

  it("stays removed when a teammate's computer writes it again after the removal, and takes its pages along", async () => {
    const bucket = memoryBucket();
    const a = await makeHub({ defaultActorName: "Sara Nyberg" });
    const b = await makeHub({ defaultActorName: "Erik Holm" });
    const c = await makeHub({ defaultActorName: "Anna Lind" });
    for (const { inner } of [a, b, c]) {
      inner.s3Workspace.canUseBucket = () => true;
      Object.assign(inner.s3Workspace.objects, bucket);
    }
    await a.hub.request(upload("orders-api.md", "# Orders API\n\nThe orders API listens on 8443 and reads its settings from /etc/orders.\n"));
    await settle();
    const doc = a.hub.store.data.kbDocuments!.at(-1)!;
    await a.inner.syncSharedSetup(new WorkSync(bucket));
    await b.inner.syncSharedSetup(new WorkSync(bucket));
    // Erik's computer is reading the document, and writes a page from it.
    const page = { id: "p-orders", kind: "runbook", title: "Orders API", when: "orders", body: "listens on 8443", targets: [], sources: [{ docId: doc.id, title: doc.title }], revision: 1, createdAt: Date.now(), updatedAt: Date.now(), updatedBy: "Knowledge base", history: [] };
    b.hub.store.data.kbPages = [page as never];
    await b.inner.syncSharedSetup(new WorkSync(bucket));
    await a.inner.syncSharedSetup(new WorkSync(bucket));
    expect(a.hub.store.data.kbPages?.map((p) => p.id)).toEqual(["p-orders"]);

    // Sara removes it; Erik's reading finishes after that, stamping his copy newer than the removal.
    await settle(5);
    await a.hub.request({ action: "kb-delete", id: doc.id });
    await a.inner.syncSharedSetup(new WorkSync(bucket));
    await settle(5);
    const late = b.hub.store.data.kbDocuments!.find((d) => d.id === doc.id)!;
    late.summary = "Read after it was removed";
    late.updatedAt = Date.now();
    for (let round = 0; round < 2; round++)
      for (const x of [b, a, c]) await x.inner.syncSharedSetup(new WorkSync(bucket));
    for (const x of [a, b, c]) {
      expect((x.hub.store.data.kbDocuments ?? []).some((d) => d.id === doc.id)).toBe(false);
      expect((x.hub.store.data.kbPages ?? []).some((p) => p.id === "p-orders")).toBe(false);
    }
  });
});

describe("whose name is on a memory and a vote, on a server with accounts", () => {
  it("is the signed-in person's, whatever the request says", async () => {
    const { hub } = await makeHub({ alertHookOwner: "u3", defaultActorName: "Sara Nyberg" });
    await hub.request({ action: "memory-save", entry: { id: "m1", kind: "memory", scope: "workspace", title: "Backups", text: "Backups of db-01 run at 02:00.", author: "Anna Lind" } } as never);
    expect(hub.store.data.memories.find((m) => m.id === "m1")!.author).toBe("Sara Nyberg");
    for (const voter of ["ghost-1", "ghost-2", "ghost-3", undefined])
      await hub.request({ action: "memory-feedback", id: "m1", delta: 1, voter } as never);
    const voted = hub.store.data.memories.find((m) => m.id === "m1")!;
    expect(voted.votes).toEqual({ "Sara Nyberg": 1 });
    expect(voted.feedbackScore).toBe(1);
  });

  it("is still what the app itself passes on a person's own computer", async () => {
    const { hub } = await makeHub({ defaultActorName: "Sara Nyberg" });
    await hub.request({ action: "memory-save", entry: { id: "m1", kind: "memory", scope: "workspace", title: "Backups", text: "Backups of db-01 run at 02:00.", author: "Imported runbook" } } as never);
    expect(hub.store.data.memories.find((m) => m.id === "m1")!.author).toBe("Imported runbook");
  });
});

describe("the safety policy", () => {
  it("takes only on or off, and refuses the whole request otherwise", async () => {
    const { hub } = await makeHub();
    const before = { ...(await hub.snapshot()).safetyPolicy };
    for (const policy of [{ blockDestructiveWithoutConfirm: "no" }, { requireApprovalOnProdTags: 0 }, { autoApproveSafeReadOnly: null }, { requireApprovalOnProdTags: false, blockDestructiveWithoutConfirm: "false" }])
      await expect(hub.request({ action: "safety-policy-save", policy } as never)).rejects.toThrow(/either on \(true\) or off \(false\)/);
    expect((await hub.snapshot()).safetyPolicy).toEqual(before);
    expect(hub.store.data.safetyPolicyChanged).toBeUndefined();

    const snap = await hub.request({ action: "safety-policy-save", policy: { requireApprovalOnProdTags: false } });
    expect(snap.safetyPolicy).toEqual({ ...before, requireApprovalOnProdTags: false });
  });

  it("reads a value an earlier version stored as text for what it did", async () => {
    const { hub } = await makeHub();
    hub.store.data.safetyPolicy = { autoApproveSafeReadOnly: true, requireApprovalOnProdTags: true, blockDestructiveWithoutConfirm: "no" as never };
    const snap = await hub.request({ action: "safety-policy-save", policy: { autoApproveSafeReadOnly: false } });
    expect(snap.safetyPolicy).toEqual({ autoApproveSafeReadOnly: false, requireApprovalOnProdTags: true, blockDestructiveWithoutConfirm: true });
  });

  it("on a shared server is a floor: a member tightens their own rules, only an administrator loosens them", async () => {
    const { hub } = await makeHub(member);
    for (const policy of [{ requireApprovalOnProdTags: false }, { blockDestructiveWithoutConfirm: false }, { requireApprovalOnProdTags: false, blockDestructiveWithoutConfirm: false }])
      await expect(hub.request({ action: "safety-policy-save", policy })).rejects.toThrow(/Only an administrator/);
    // Asking for every read-only command is stricter, and a member's own choice.
    let snap = await hub.request({ action: "safety-policy-save", policy: { autoApproveSafeReadOnly: false } });
    expect(snap.safetyPolicy).toEqual({ autoApproveSafeReadOnly: false, requireApprovalOnProdTags: true, blockDestructiveWithoutConfirm: true });
    snap = await hub.request({ action: "safety-policy-save", policy: { autoApproveSafeReadOnly: true } });
    expect(snap.safetyPolicy?.autoApproveSafeReadOnly).toBe(true);
    // Rules a member switched off before this held count as on.
    hub.store.data.safetyPolicy = { autoApproveSafeReadOnly: true, requireApprovalOnProdTags: false, blockDestructiveWithoutConfirm: false };
    expect((await hub.snapshot()).safetyPolicy).toEqual({ autoApproveSafeReadOnly: true, requireApprovalOnProdTags: true, blockDestructiveWithoutConfirm: true });

    const anna = await makeHub(admin);
    snap = await anna.hub.request({ action: "safety-policy-save", policy: { requireApprovalOnProdTags: false } });
    expect(snap.safetyPolicy?.requireApprovalOnProdTags).toBe(false);
  });
});

describe("the AI endpoint's address", () => {
  it("on a shared server is not the server itself or its private network, when set or when a run starts", async () => {
    const { hub } = await makeHub(member);
    for (const baseUrl of ["http://127.0.0.1:2299/v1", "http://localhost:8080/v1", "http://169.254.169.254/latest", "http://10.0.0.5:11434/v1"])
      await expect(hub.request({ action: "configure", config: { baseUrl } } as never)).rejects.toThrow(/does not call itself|never calls|private/);
    expect((await hub.snapshot()).config?.baseUrl ?? "").toBe("");
    // One saved before the rule existed is not called either.
    await (hub as unknown as { config: { update: (c: object) => Promise<void> } }).config.update({ enabled: true, baseUrl: "http://127.0.0.1:2299/v1" });
    const fetchSpy = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchSpy);
    await expect(hub.request({ action: "start", task: { prompt: "hello", mode: "advice" } } as never)).rejects.toThrow(/does not call itself/);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("on a person's own computer may be one on that computer", async () => {
    const { hub } = await makeHub();
    const snap = await hub.request({ action: "configure", config: { baseUrl: "http://127.0.0.1:11434/v1" } } as never);
    expect(snap.config?.baseUrl).toBe("http://127.0.0.1:11434/v1");
  });
});

describe("the servers a team shares, on a shared server", () => {
  const iso = (offset = 0): string => new Date(Date.now() + offset).toISOString();
  const team = (): WorkspaceServerSummary =>
    ({ id: "db", name: "db-01", host: "10.20.0.31", port: 22, username: "ops", shared: true, tags: ["prod", "postgres"], description: "Primary database", updatedAt: iso(-60_000) }) as WorkspaceServerSummary;
  const own = (): WorkspaceServerSummary =>
    ({ id: "mine", name: "annas-laptop-vm", host: "192.0.2.15", port: 22, username: "anna", shared: false, description: "anna's personal box", updatedAt: iso(-60_000) }) as WorkspaceServerSummary;

  function hostWith(servers: WorkspaceServerSummary[], extra: Record<string, unknown> = {}) {
    const calls = { upsert: vi.fn(), describe: vi.fn(), remove: vi.fn() };
    return {
      calls,
      host: {
        workspaceServers: async () => servers,
        upsertServer: async (input: WorkspaceServerSummary) => {
          calls.upsert(input);
          return { ...input, id: input.id ?? "new" };
        },
        describeServer: async (input: unknown) => void calls.describe(input),
        deleteServer: async (id: string) => {
          calls.remove(id);
          const at = servers.findIndex((s) => s.id === id);
          if (at >= 0) servers.splice(at, 1);
        },
        ...extra,
      },
    };
  }

  it("are not re-pointed, renamed, taken out of the team or removed by a member", async () => {
    const { host, calls } = hostWith([team()]);
    const { hub } = await makeHub({ ...member, ...host });
    const same = { id: "db", name: "db-01", host: "10.20.0.31", port: 22, username: "ops", tags: ["prod", "postgres"] };
    for (const change of [{ host: "192.0.2.99" }, { port: 2222 }, { username: "root" }, { name: "web-01" }, { shared: false }, { tags: ["postgres"] }])
      await expect(hub.request({ action: "server-upsert", server: { ...same, ...change } } as never)).rejects.toThrow(/Only an administrator/);
    // Leaving the port and the user name out would save them as 22 and root.
    await expect(hub.request({ action: "server-upsert", server: { id: "db", name: "db-01", host: "10.20.0.31", tags: ["prod"] } } as never)).rejects.toThrow(/Only an administrator/);
    await expect(hub.request({ action: "server-describe", profileId: "db", shared: false })).rejects.toThrow(/Only an administrator/);
    await expect(hub.request({ action: "server-describe", profileId: "db", tags: ["postgres"] })).rejects.toThrow(/tag "prod"/);
    await expect(hub.request({ action: "server-delete", profileId: "db" })).rejects.toThrow(/Only an administrator/);
    expect(calls.upsert).not.toHaveBeenCalled();
    expect(calls.describe).not.toHaveBeenCalled();
    expect(calls.remove).not.toHaveBeenCalled();
    expect(hub.store.data.deletedServerIds?.db).toBeUndefined();
  });

  it("are still described and tagged by a member, who also adds new ones and sets their own sign-in", async () => {
    const { host, calls } = hostWith([team()]);
    const { hub } = await makeHub({ ...member, ...host });
    await hub.request({ action: "server-describe", profileId: "db", description: "Primary database, replica is db-02", tags: ["prod", "postgres", "pg16"] });
    await hub.request({ action: "server-upsert", server: { id: "db", name: "db-01", host: "10.20.0.31", port: 22, username: "ops", tags: ["prod", "postgres"], description: "Primary", localUsername: "erik" } } as never);
    await hub.request({ action: "server-local-override", override: { profileId: "db", username: "erik" } } as never);
    await hub.request({ action: "server-upsert", server: { name: "cache-01", host: "10.20.0.40", username: "ops" } } as never);
    expect(calls.describe).toHaveBeenCalledTimes(1);
    expect(calls.upsert).toHaveBeenCalledTimes(2);
  });

  it("are an administrator's to change, and anybody's where there is no shared server", async () => {
    for (const who of [admin, {}]) {
      const { host, calls } = hostWith([team()]);
      const { hub } = await makeHub({ ...who, ...host });
      await hub.request({ action: "server-upsert", server: { id: "db", name: "db-01", host: "10.20.0.32", port: 22, username: "ops", tags: [] } } as never);
      await hub.request({ action: "server-delete", profileId: "db" });
      expect(calls.upsert).toHaveBeenCalledTimes(1);
      expect(calls.remove).toHaveBeenCalledWith("db");
      expect(hub.store.data.deletedServerIds?.db).toBeTruthy();
    }
  });

  it("do not include a person's own server: nothing about it goes to the team", async () => {
    const servers: WorkspaceServerSummary[] = [];
    const { host } = hostWith(servers);
    const { hub } = await makeHub({ ...admin, ...host });
    const mine = own();
    await hub.request({ action: "server-upsert", server: { ...mine } } as never);
    servers.push(mine);
    await hub.request({ action: "server-describe", profileId: "mine", shared: false, description: "anna's personal box, rebuilt" });
    const told = JSON.stringify([hub.store.data.activityLog ?? [], hub.store.data.memories.filter((m) => m.scope !== "personal"), hub.store.data.s3SyncedServers ?? []]);
    expect(told).not.toContain("annas-laptop-vm");
    expect(told).not.toContain("192.0.2.15");
    expect(told).not.toContain("personal box");
    // Removing it leaves no removal mark and no log entry for the team either.
    await hub.request({ action: "server-delete", profileId: "mine" });
    expect(servers).toHaveLength(0);
    expect(hub.store.data.deletedServerIds?.mine).toBeUndefined();
    expect(JSON.stringify(hub.store.data.activityLog ?? [])).not.toContain("mine");
  });

  it("cannot be used to hide a teammate's own server: an id alone removes nothing", async () => {
    // Erik sends the id of Anna's personal server, and one that does not exist.
    const erik = await makeHub({ ...member, ...hostWith([team()]).host });
    for (const id of ["mine", "no-such-server"]) await expect(erik.hub.request({ action: "server-delete", profileId: id })).rejects.toThrow("Server not found");
    expect(erik.hub.store.data.deletedServerIds ?? {}).toEqual({});
    expect(JSON.stringify(erik.hub.store.data.activityLog ?? [])).not.toContain("Removed node");

    // A removal mark that did reach Anna (from an older version, or another installation) does not hide her server.
    const anna = await makeHub({ ...admin, ...hostWith([team(), own()]).host });
    anna.hub.store.data.deletedServerIds = { mine: iso(60_000), db: iso(60_000) };
    const seen = ((await anna.hub.snapshot()).workspaceServers ?? []).map((s) => s.id);
    expect(seen).toEqual(["mine"]);

    // The same through the file the accounts of one server share.
    const file = path.join(anna.dir, "shared-workspace.json");
    await fs.writeFile(file, JSON.stringify({ version: 1, servers: [], deletedServerIds: { mine: iso(60_000), db: iso(60_000) } }));
    const merged = await anna.hub.store.syncSharedFile(file, [team(), own()]);
    expect(merged.servers.map((s) => s.id)).toEqual(["mine"]);
    expect(JSON.parse(await fs.readFile(file, "utf8")).deletedServerIds).toMatchObject({ mine: expect.any(String), db: expect.any(String) });
    expect(await fs.readFile(file, "utf8")).not.toContain("annas-laptop-vm");
  });

  it("cannot take over a teammate's own server by its id, and an unknown id changes nothing", async () => {
    const erik = await makeHub({ ...member, ...hostWith([team()]).host });
    await expect(erik.hub.request({ action: "server-upsert", server: { id: "mine", name: "x", host: "192.0.2.66", username: "erik", shared: true } } as never)).rejects.toThrow("Server not found");
    await expect(erik.hub.request({ action: "server-describe", profileId: "no-such-server", shared: true, description: "x" })).rejects.toThrow("Server not found");
    await expect(erik.hub.request({ action: "server-local-override", override: { profileId: "no-such-server", username: "erik" } } as never)).rejects.toThrow("Server not found");
    expect(JSON.stringify(erik.hub.store.data.activityLog ?? [])).not.toContain("no-such-server");

    // A team copy under the id of Anna's own server (sent before this rule, or by an administrator) does not re-point it for her.
    const anna = await makeHub({ ...member, ...hostWith([team(), own()]).host });
    anna.hub.store.data.s3SyncedServers = [{ ...own(), host: "192.0.2.66", username: "erik", shared: true, updatedAt: iso(60_000) }];
    const mine = ((await anna.hub.snapshot()).workspaceServers ?? []).find((s) => s.id === "mine");
    expect(mine).toMatchObject({ host: "192.0.2.15", username: "anna", shared: false });
  });

  it("are held to the same rule through the ordinary connection editor", async () => {
    const { registerProfileHandlers } = await import("../../src/main/ipc/profileHandlers");
    const servers = [team(), own()];
    const { host } = hostWith(servers);
    for (const who of [member, admin]) {
      const { hub } = await makeHub({ ...who, ...host });
      const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
      const store = { saveSSH: vi.fn(async () => {}), deleteSSH: vi.fn(async () => {}), deleteFolder: vi.fn(async () => {}), getProfiles: async () => ({ ssh: [{ id: "db", group: "Databases" }], s3: [] }) };
      registerProfileHandlers({
        aiHub: hub,
        profileStore: store,
        profileSyncService: { autoSyncLocalSshConfig: async () => {} },
        registerHandler: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => void handlers.set(channel, fn),
        scheduleAutoSync: () => {},
        storageRegistry: { disconnect: async () => {} },
      } as never);
      const call = (channel: string, ...args: unknown[]): Promise<unknown> => handlers.get(channel)!({}, ...args);
      const { IPC_CHANNELS } = await import("../../src/shared/types/ipc");
      const db = { id: "db", name: "db-01", host: "10.20.0.31", port: 22, username: "ops", authType: "agent", tags: ["prod", "postgres"] };
      const refused = [
        () => call(IPC_CHANNELS.PROFILES_SAVE_SSH, { ...db, host: "192.0.2.88" }),
        () => call(IPC_CHANNELS.PROFILES_SAVE_SSH, { ...db, shared: false }),
        () => call(IPC_CHANNELS.PROFILES_SAVE_SSH, { ...db, tags: ["postgres"] }),
        () => call(IPC_CHANNELS.PROFILES_DELETE_SSH, "db"),
        () => call(IPC_CHANNELS.PROFILES_DELETE_FOLDER, "Databases", true),
      ];
      if (who === member) {
        for (const r of refused) await expect(r()).rejects.toThrow(/Only an administrator/);
        expect(store.saveSSH).not.toHaveBeenCalled();
        expect(store.deleteSSH).not.toHaveBeenCalled();
        expect(store.deleteFolder).not.toHaveBeenCalled();
        // One's own key for it, one's own server, and a folder removed without its servers stay free.
        await call(IPC_CHANNELS.PROFILES_SAVE_SSH, { ...db, privateKeyPath: "/home/erik/.ssh/id_ed25519" });
        await call(IPC_CHANNELS.PROFILES_SAVE_SSH, { ...own(), host: "192.0.2.16" });
        await call(IPC_CHANNELS.PROFILES_DELETE_SSH, "mine");
        await call(IPC_CHANNELS.PROFILES_DELETE_FOLDER, "Databases", false);
        expect(store.saveSSH).toHaveBeenCalledTimes(2);
        expect(store.deleteSSH).toHaveBeenCalledWith("mine");
      } else {
        for (const r of refused) await r();
        expect(store.saveSSH).toHaveBeenCalledTimes(3);
      }
    }
  });
});

describe("a web server with one account", () => {
  it("counts its accounts", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-auth-"));
    disposals.push(() => fs.rm(dir, { recursive: true, force: true }));
    const auth = new WebAuthService(dir);
    await auth.initialize();
    expect(auth.userCount()).toBe(0);
    await auth.setupInitialAdmin({ username: "jacob", password: "test-pass-123", displayName: "Jacob" } as never);
    expect(auth.userCount()).toBe(1);
    await auth.createUserByAdmin({ username: "erik", password: "test-pass-456", displayName: "Erik", role: "member" });
    expect(auth.userCount()).toBe(2);
  });

  it("is its one person's own machine: a folder and its own addresses may be read, as in the desktop app", async () => {
    const { hub, dir } = await makeHub({ ...admin, soleUser: () => true });
    const folder = path.join(dir, "runbooks");
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, "nginx.md"), "# Restart nginx\n\nReload the service and check the status page afterwards.\n");
    await hub.request({ action: "kb-ingest-folder", folderPath: folder });
    expect(hub.store.data.kbDocuments!.some((d) => d.content.includes("Restart nginx"))).toBe(true);
    // Nothing listens there: it is tried, and fails for that reason.
    await expect(hub.request({ action: "kb-ingest-url", url: "http://127.0.0.1:1/x" })).rejects.not.toThrow(/does not call itself/);
    // The name is still the account's, and the server's own paths are still the server's.
    await hub.request({ action: "workspace-s3-configure", config: { actorName: "The Boss" } } as never);
    const snap = await hub.request({ action: "configure", config: {}, preferences: { sharedWorkspacePath: "/etc/shadow" } } as never);
    expect(snap.config.actorName ?? "").not.toBe("The Boss");
    expect(snap.preferences.sharedWorkspacePath).toBeUndefined();
  });

  it("is a shared server again as soon as there is a second account", async () => {
    let accounts = 1;
    const { hub } = await makeHub({ ...admin, soleUser: () => accounts === 1 });
    accounts = 2;
    await expect(hub.request({ action: "kb-ingest-folder", folderPath: "/root/.ssh" })).rejects.toThrow("cannot be read into the knowledge base from the browser");
    await expect(hub.request({ action: "kb-ingest-url", url: "http://127.0.0.1:1/x" })).rejects.toThrow("does not call itself");
  });
});

describe("a bucket read into the knowledge base, on a shared server", () => {
  const profiles = (endpoint?: string) => ({
    extraAppContext: async () => ({ folders: [], snippets: [], s3Profiles: [{ id: "p1", name: "km-runbooks", endpoint, bucket: "nordvik-runbooks" }] }),
  });

  it("is checked like a link: not the server itself, not its private network", async () => {
    for (const [endpoint, why] of [
      ["http://127.0.0.1:9000", /does not call itself/],
      ["http://10.20.0.50:9000", /private network/],
      ["169.254.169.254", /never calls/],
    ] as const) {
      const resolveStorageProvider = vi.fn(async () => undefined);
      const { hub } = await makeHub({ ...member, ...profiles(endpoint), resolveStorageProvider });
      for (const ref of ["p1", "s3-p1", "km-runbooks", "runbooks"])
        await expect(hub.request({ action: "kb-ingest-s3", s3ProfileId: ref, prefix: "runbooks/" })).rejects.toThrow(why);
      expect(resolveStorageProvider).not.toHaveBeenCalled();
    }
  });

  it("is read when it is somewhere a link could be, and the private network when the administrator allows it", async () => {
    const resolveStorageProvider = vi.fn(async () => undefined);
    const pub = await makeHub({ ...member, ...profiles("https://s3.example.com"), resolveStorageProvider });
    pub.inner.kbNetwork = { fetchImpl: fetch, lookup: async () => [{ address: "93.184.216.34", family: 4 }] };
    await expect(pub.hub.request({ action: "kb-ingest-s3", s3ProfileId: "p1" })).rejects.toThrow(/not found/);
    // No endpoint is the provider's own (AWS).
    const aws = await makeHub({ ...member, ...profiles(undefined), resolveStorageProvider });
    await expect(aws.hub.request({ action: "kb-ingest-s3", s3ProfileId: "p1" })).rejects.toThrow(/not found/);
    vi.stubEnv("SSHS3_ALLOW_PRIVATE_ADDRESSES", "1");
    const lan = await makeHub({ ...member, ...profiles("http://10.20.0.50:9000"), resolveStorageProvider });
    await expect(lan.hub.request({ action: "kb-ingest-s3", s3ProfileId: "p1" })).rejects.toThrow(/not found/);
    expect(resolveStorageProvider).toHaveBeenCalledTimes(3);
  });

  it("is not checked on a person's own computer", async () => {
    const resolveStorageProvider = vi.fn(async () => undefined);
    const { hub } = await makeHub({ ...profiles("http://127.0.0.1:9000"), resolveStorageProvider });
    await expect(hub.request({ action: "kb-ingest-s3", s3ProfileId: "p1" })).rejects.toThrow(/not found/);
    expect(resolveStorageProvider).toHaveBeenCalledTimes(1);
  });
});
