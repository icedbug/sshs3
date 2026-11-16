import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", async () => {
  const shim = await import("../../src/main/web/electronShim");
  return shim;
});

import { setHeadlessUserDataPath } from "../../src/main/web/electronShim";
import { HubService } from "../../src/main/ai/hub/HubService";
import { ContextService } from "../../src/main/ai/hub/ContextService";
import { HubStore } from "../../src/main/ai/hub/HubStore";
import { KnowledgeBaseService } from "../../src/main/ai/hub/KnowledgeBaseService";
import { McpClientManager } from "../../src/main/ai/hub/McpClientManager";
import { TerminalRegistry } from "../../src/main/ai/hub/TerminalRegistry";
import { SnippetStore } from "../../src/main/snippets/SnippetStore";
import { setDemoModeForTesting } from "../../src/main/demo/demoMode";
import { ticketPrompt } from "../../src/main/ai/hub/WorkBoard";
import { savePageByPerson } from "../../src/main/ai/hub/KbCompile";
import { Sshs3WebServer } from "../../src/main/web/WebServer";
import { WorkSync } from "../../src/main/ai/hub/WorkSync";
import type { QueueStore } from "../../src/main/ai/hub/LearningQueue";
import { ProfileStore } from "../../src/main/profile/ProfileStore";
import { createHub } from "../../src/main/ai/hub/createHub";

const disposals: Array<() => Promise<unknown> | unknown> = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const dispose of disposals.splice(0).reverse()) await dispose();
  setDemoModeForTesting(undefined);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function makeHub(options: { demo?: boolean; snippetStore?: SnippetStore } = {}) {
  setDemoModeForTesting(Boolean(options.demo));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-honesty-m1-"));
  const hub = new HubService(
    {
      changed: () => {},
      inventoryTargets: async () => [],
      backgroundChanged: async () => {},
      openSchedule: async () => "s1",
      show: () => {},
      aiConfigFilePath: path.join(dir, "ai.json"),
      alertHookOwner: "u1",
      ...(options.snippetStore
        ? { restoreBuiltinSnippets: () => options.snippetStore!.restoreBuiltins() }
        : {}),
    } as never,
    dir,
  );
  disposals.push(async () => {
    await hub.dispose();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await hub.initialize();
  return { hub, dir };
}

describe("M1 backend honesty & correctness fixes", () => {
  it("mcp-test reports clear plain-English notes and sets lastTestedAt + demo flag across demo, disabled, and live servers", async () => {
    const { hub } = await makeHub({ demo: true });
    // Demo server snapshot has demo: true and mcp-test returns simulated note + updates lastTestedAt
    const initial = await hub.snapshot();
    const demoSrv = initial.mcpServers!.find((m) => m.id === "demo-mcp-netapp-harvest")!;
    expect(demoSrv.demo).toBe(true);

    const demoTest = await hub.request({ action: "mcp-test", id: "demo-mcp-netapp-harvest" });
    expect(demoTest.reply?.notes?.[0]).toContain("demo server");
    expect(demoTest.reply?.notes?.[0]).toContain("not connected to a real network");
    const testedDemo = demoTest.mcpServers!.find((m) => m.id === "demo-mcp-netapp-harvest")!;
    expect(testedDemo.demo).toBe(true);
    expect(testedDemo.lastTestedAt).toBeGreaterThan(demoSrv.lastTestedAt ?? 0);

    // Disabled server is not started and tells the user to turn it on first
    const spy = vi.spyOn(McpClientManager.prototype, "testAndDiscover");
    const savedDisabled = await hub.request({
      action: "mcp-save",
      server: { id: "srv-off", name: "Disabled HTTP", transport: "http", url: "https://mcp.example.com/mcp", enabled: false },
    });
    expect(savedDisabled.mcpServers!.find((m) => m.id === "srv-off")?.demo).toBeUndefined();
    const disabledTest = await hub.request({ action: "mcp-test", id: "srv-off" });
    expect(spy).not.toHaveBeenCalled();
    expect(disabledTest.reply?.notes?.[0]).toContain("turned off");
    expect(disabledTest.mcpServers!.find((m) => m.id === "srv-off")?.lastTestedAt).toBeGreaterThan(0);

    // Live server success reports exact tool count; live server failure reports exact error
    await hub.request({
      action: "mcp-save",
      server: { id: "srv-live", name: "Live HTTP", transport: "http", url: "https://mcp.example.com/mcp", enabled: true },
    });
    spy.mockResolvedValueOnce({
      ok: true,
      tools: [
        { name: "tool_a", description: "a" },
        { name: "tool_b", description: "b" },
      ],
    });
    const liveOk = await hub.request({ action: "mcp-test", id: "srv-live" });
    expect(liveOk.reply?.notes?.[0]).toBe("Connected to Live HTTP: found 2 tools.");
    expect(liveOk.mcpServers!.find((m) => m.id === "srv-live")?.discoveredTools).toHaveLength(2);

    spy.mockResolvedValueOnce({ ok: false, tools: [], error: "HTTP 503" });
    const liveErr = await hub.request({ action: "mcp-test", id: "srv-live" });
    expect(liveErr.reply?.notes?.[0]).toBe("Could not connect to Live HTTP: HTTP 503.");

    spy.mockResolvedValueOnce({ ok: false, tools: [], error: "A shared server does not call itself." });
    const dotErr = await hub.request({ action: "mcp-test", id: "srv-live" });
    expect(dotErr.reply?.notes?.[0]).toBe("Could not connect to Live HTTP: A shared server does not call itself.");
  });

  it("restore-builtins restores dismissed built-ins, sharedRemoved, deletedMemoryIds, demo stores, and SnippetStore hiddenBuiltinIds with exact notes", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-snip-restore-"));
    disposals.push(() => fs.rm(tmp, { recursive: true, force: true }));
    const snippetStore = new SnippetStore(path.join(tmp, "snippets.json"));
    await snippetStore.hideBuiltin("builtin-snip-disk-usage");

    // Normal mode: nothing dismissed except 1 hidden snippet
    const { hub } = await makeHub({ demo: false, snippetStore });
    const noneBefore = await hub.request({ action: "agent-delete", id: "builtin-agent-general" });
    expect(noneBefore.agents!.some((a) => a.id === "builtin-agent-general")).toBe(false);
    expect(hub.store.data.sharedRemoved?.agents?.["builtin-agent-general"]).toBeGreaterThan(0);

    const restored = await hub.request({ action: "restore-builtins" });
    expect(restored.agents!.some((a) => a.id === "builtin-agent-general")).toBe(true);
    expect(hub.store.data.sharedRemoved?.agents?.["builtin-agent-general"]).toBeUndefined();
    expect(restored.reply?.notes?.[0]).toBe("Restored 2 built-in items.");
    expect((await snippetStore.listWithBuiltins([{ id: "builtin-snip-disk-usage", name: "Disk", command: "df -h" }])).length).toBe(1);

    // Calling again when everything is present returns the honest no-op message
    const again = await hub.request({ action: "restore-builtins" });
    expect(again.reply?.notes?.[0]).toBe("All built-in agents, runbooks, and skills are already present.");

    // Demo mode: deleting demo agent, demo KB doc, demo MCP server, and demo skill actually splices demo*Store; restore-builtins brings them all back
    const { hub: demoHub } = await makeHub({ demo: true });
    await demoHub.request({ action: "agent-delete", id: "demo-agent-ontap-architect" });
    await demoHub.request({ action: "kb-delete", id: "demo-kb-ontap-cli-qos" });
    await demoHub.request({ action: "mcp-delete", id: "demo-mcp-netapp-harvest" });
    await demoHub.request({ action: "memory-delete", id: "demo-skill-ontap-latency" });

    const beforeRestore = await demoHub.snapshot();
    expect(beforeRestore.agents!.some((a) => a.id === "demo-agent-ontap-architect")).toBe(false);
    expect(beforeRestore.kbDocuments!.some((d) => d.id === "demo-kb-ontap-cli-qos")).toBe(false);
    expect(beforeRestore.mcpServers!.some((m) => m.id === "demo-mcp-netapp-harvest")).toBe(false);
    expect(beforeRestore.memories.some((m) => m.id === "demo-skill-ontap-latency")).toBe(false);

    const demoRestored = await demoHub.request({ action: "restore-builtins" });
    expect(demoRestored.reply?.notes?.[0]).toBe("Restored 4 built-in items.");
    expect(demoRestored.agents!.some((a) => a.id === "demo-agent-ontap-architect")).toBe(true);
    expect(demoRestored.kbDocuments!.some((d) => d.id === "demo-kb-ontap-cli-qos")).toBe(true);
    expect(demoRestored.mcpServers!.some((m) => m.id === "demo-mcp-netapp-harvest")).toBe(true);
    expect(demoRestored.memories.some((m) => m.id === "demo-skill-ontap-latency")).toBe(true);
  });

  it("alert tickets store kbPages separately without leaking sshs3_kb_search into ticket.description, while ticketPrompt gives page IDs to the agent", async () => {
    const { hub } = await makeHub({ demo: false });
    const page = savePageByPerson(
      undefined,
      {
        kind: "troubleshooting",
        title: "Disk space triage on PostgreSQL",
        when: "DiskFull on pg-01",
        body: "Check WAL archive backlog.",
        targets: ["pg-01"],
        keys: ["DiskFull"],
      },
      "Sara",
    );
    page.alerts = ["DiskFull"];
    hub.store.data.kbPages = [page];

    const created = await hub.request({ action: "alert-hook-create" });
    const secret = created.reply!.alertHook!.path.split(".").pop()!;
    const res = await hub.receiveAlert(secret, {
      alerts: [
        {
          status: "firing",
          fingerprint: "fp-disk-1",
          labels: { alertname: "DiskFull", severity: "critical", instance: "pg-01" },
          annotations: { summary: "Disk full on pg-01", description: "/var/lib/postgresql 95%" },
        },
      ],
    });
    expect(res?.created).toHaveLength(1);
    const ticket = hub.store.data.workTickets!.find((t) => t.id === res!.created[0])!;
    expect(ticket.description).not.toContain("sshs3_kb_search");
    expect(ticket.description).toContain("Disk space triage on PostgreSQL");
    expect(ticket.kbPages).toEqual([{ id: page.id, title: "Disk space triage on PostgreSQL", known: true }]);

    const prompt = ticketPrompt(ticket, undefined, {
      tickets: [ticket],
      agents: [],
      agent: { id: "a1", name: "Operator", role: "SRE", mission: "", systemPrompt: "", defaultMode: "assisted", allowedTools: ["all"], kbDocIds: [], mcpServerIds: [], updatedAt: 1 },
    });
    expect(prompt).toContain(`sshs3_kb_search page=${page.id}`);
  });

  it("demo server facts stay stable across repeated Read all now clicks without fabricating 20 changes, and mark demo: true", async () => {
    const { hub } = await makeHub({ demo: true });
    await hub.request({ action: "facts-configure", enabled: true });
    const first = await hub.request({ action: "facts-collect-now" });
    const second = await hub.request({ action: "facts-collect-now" });

    const nonAppliances = second.serverFacts!.servers.filter((s) => s.status === "ok");
    expect(nonAppliances.length).toBeGreaterThan(0);
    for (const s of second.serverFacts!.servers) {
      expect(s.demo).toBe(true);
    }
    const allChanges = nonAppliances.flatMap((s) => s.changes);
    expect(allChanges).toEqual([]);
    // Collected timestamps still refreshed on the second read
    expect(second.serverFacts!.servers[0].collectedAt).toBeGreaterThanOrEqual(
      first.serverFacts!.servers[0].collectedAt ?? 0,
    );
  });

  it("ContextService.inventory preserves reasonKind ('demo' / 'proxy') on blocked targets", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-ctx-inv-"));
    disposals.push(() => fs.rm(dir, { recursive: true, force: true }));
    const store = new HubStore(path.join(dir, "hub.json"));
    await store.load();
    const kb = new KnowledgeBaseService();
    const terminals = new TerminalRegistry();
    const ctx = new ContextService(
      store,
      terminals,
      async () => [
        { id: "demo-ssh-1", kind: "ssh", label: "demo-node", address: "10.0.0.1", port: 22, blocked: "Simulated demo server", reasonKind: "demo" },
        { id: "proxy-ssh-1", kind: "ssh", label: "bastion-target", address: "10.0.0.2", port: 22, blocked: "Via jump host", reasonKind: "proxy" },
      ],
      kb,
    );
    await ctx.inventory(true);
    const demoEntry = store.data.inventory.find((i) => i.id === "demo-ssh-1")!;
    const proxyEntry = store.data.inventory.find((i) => i.id === "proxy-ssh-1")!;
    expect(demoEntry).toMatchObject({ status: "blocked", reasonKind: "demo" });
    expect(proxyEntry).toMatchObject({ status: "blocked", reasonKind: "proxy" });
  });

  it("WebServer GET /api/auth/status exposes normalized publicUrl from SSHS3_PUBLIC_URL when valid", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-web-puburl-"));
    setHeadlessUserDataPath(tmpDir);
    const staticDir = path.join(tmpDir, "static");
    await fs.mkdir(staticDir, { recursive: true });
    await fs.writeFile(path.join(staticDir, "index.html"), "<!doctype html><html></html>", "utf-8");
    const server = new Sshs3WebServer({ port: 0, host: "127.0.0.1", dataDir: tmpDir, staticDir });
    const info = await server.start();
    disposals.push(async () => {
      await server.stop();
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    vi.stubEnv("SSHS3_PUBLIC_URL", "https://ops.example.com/sshs3///");
    const withEnv = (await (await fetch(`http://127.0.0.1:${info.port}/api/auth/status`)).json()) as {
      publicUrl?: string;
    };
    expect(withEnv.publicUrl).toBe("https://ops.example.com/sshs3");

    vi.stubEnv("SSHS3_PUBLIC_URL", "");
    const withoutEnv = (await (await fetch(`http://127.0.0.1:${info.port}/api/auth/status`)).json()) as {
      publicUrl?: string;
    };
    expect(withoutEnv.publicUrl).toBeUndefined();
  });

  it("demo server facts do not drift bootAt or cert.notAfter across >5 minutes and UTC midnight", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.UTC(2026, 10, 16, 23, 58, 0);
    vi.setSystemTime(t0);

    const { hub } = await makeHub({ demo: true });
    await hub.request({ action: "facts-configure", enabled: true });
    const first = await hub.request({ action: "facts-collect-now" });

    // Advance >5 minutes AND across UTC midnight (would trigger >120s bootAt drift and cert day shift if unanchored)
    const t1 = Date.UTC(2026, 10, 17, 0, 5, 0);
    vi.setSystemTime(t1);
    const second = await hub.request({ action: "facts-collect-now" });

    // Advance another full UTC day to ensure a third read also stays anchored
    const t2 = Date.UTC(2026, 10, 18, 1, 0, 0);
    vi.setSystemTime(t2);
    const third = await hub.request({ action: "facts-collect-now" });

    for (const snap of [second, third]) {
      const nonAppliances = snap.serverFacts!.servers.filter((s) => s.status === "ok");
      expect(nonAppliances.length).toBeGreaterThan(0);
      expect(nonAppliances.flatMap((s) => s.changes)).toEqual([]);
    }
    expect(second.serverFacts!.servers[0].collectedAt).toBe(t1);
    expect(third.serverFacts!.servers[0].collectedAt).toBe(t2);
    expect(third.serverFacts!.servers[0].bootAt).toBe(first.serverFacts!.servers[0].bootAt);
  });

  it("restore-builtins keeps built-in agents alive across WorkSync tombstone reconciliation", async () => {
    const files = new Map<string, Buffer>();
    const bucket: QueueStore = {
      list: async (dir) => [...files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1)),
      read: async (p) => files.get(p),
      write: async (p, c) => void files.set(p, c),
      remove: async (p) => void files.delete(p),
    };

    const makeSyncedHub = async (actor: string) => {
      const { hub } = await makeHub({ demo: false });
      const inner = hub as unknown as {
        workTick: (now?: number) => Promise<void>;
        lastWorkSync: number;
        workSyncStore?: WorkSync;
        s3Workspace: { canUseBucket: () => boolean; objects: QueueStore };
        resolveActorName: () => Promise<string>;
      };
      inner.s3Workspace.canUseBucket = () => true;
      Object.defineProperty(inner.s3Workspace, "objects", { value: bucket });
      inner.workSyncStore = new WorkSync(bucket);
      inner.resolveActorName = async () => actor;
      const syncNow = async () => {
        inner.lastWorkSync = 0;
        await inner.workTick(Date.now());
      };
      return { hub, syncNow };
    };

    const alice = await makeSyncedHub("Alice");
    const bob = await makeSyncedHub("Bob");

    await alice.hub.request({ action: "agent-delete", id: "builtin-agent-general" });
    await alice.syncNow();
    await bob.syncNow();

    expect((await alice.hub.snapshot()).agents!.some((a) => a.id === "builtin-agent-general")).toBe(false);
    expect((await bob.hub.snapshot()).agents!.some((a) => a.id === "builtin-agent-general")).toBe(false);
    expect(JSON.parse(files.get("work/agents/builtin-agent-general.json")!.toString("utf8"))).toMatchObject({
      id: "builtin-agent-general",
      deleted: true,
    });

    const restored = await alice.hub.request({ action: "restore-builtins" });
    expect(restored.agents!.some((a) => a.id === "builtin-agent-general")).toBe(true);

    // Subsequent WorkSync cycles on both peers must NOT re-delete the restored built-in agent
    await alice.syncNow();
    await bob.syncNow();
    await alice.syncNow();

    expect((await alice.hub.snapshot()).agents!.some((a) => a.id === "builtin-agent-general")).toBe(true);
    expect((await bob.hub.snapshot()).agents!.some((a) => a.id === "builtin-agent-general")).toBe(true);
    const bucketCopy = JSON.parse(files.get("work/agents/builtin-agent-general.json")!.toString("utf8")) as {
      id: string;
      deleted?: boolean;
    };
    expect(bucketCopy.id).toBe("builtin-agent-general");
    expect(bucketCopy.deleted).toBeUndefined();
  });

  it("createHub.inventoryTargets ignores disabled proxy configs and marks demo S3 targets as demo", async () => {
    setDemoModeForTesting(false);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-createhub-inv-"));
    const profileStore = new ProfileStore(path.join(dir, "profiles.json"));
    await profileStore.saveSSH({
      id: "ssh-proxy-disabled",
      name: "app-disabled-proxy",
      host: "10.0.1.10",
      port: 22,
      username: "ops",
      authType: "agent",
      proxy: { enabled: false, type: "socks5", host: "127.0.0.1", port: 1080 },
    });
    await profileStore.saveSSH({
      id: "ssh-proxy-enabled",
      name: "app-enabled-proxy",
      host: "10.0.1.11",
      port: 22,
      username: "ops",
      authType: "agent",
      proxy: { enabled: true, type: "socks5", host: "127.0.0.1", port: 1080 },
    });
    await profileStore.saveS3({
      id: "demo-s3-storagegrid-prod",
      name: "Demo StorageGRID",
      endpoint: "https://s3.demo.local:10443",
      region: "eu-north-1",
      accessKeyId: "AKIA_DEMO",
      secretAccessKey: "secret-demo",
    });
    await profileStore.saveS3({
      id: "s3-real-prod",
      name: "Real S3",
      endpoint: "https://s3.example.com",
      region: "us-east-1",
      accessKeyId: "AKIA_REAL",
      secretAccessKey: "secret-real",
    });

    const bridge = {
      profileStore,
      teamVaultService: { listVaultIds: async () => [], isUnlocked: () => false },
      k8sDiscoveryService: { listContexts: async () => [] },
      scheduleAutoSync: () => {},
    };
    const hub = createHub(
      bridge as never,
      { backgroundChanged: async () => {}, show: () => {} },
      {
        hubDirectory: dir,
        aiConfigFilePath: path.join(dir, "ai.json"),
        s3ConfigFilePath: path.join(dir, "s3.json"),
      },
    );
    disposals.push(async () => {
      await hub.dispose();
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });

    const host = (hub as unknown as {
      host: { inventoryTargets: () => Promise<Array<{ id: string; kind: string; blocked?: string; reasonKind?: string }>> };
    }).host;
    const targets = await host.inventoryTargets();

    const sshOff = targets.find((t) => t.id === "ssh-proxy-disabled")!;
    expect(sshOff.blocked).toBeUndefined();
    expect(sshOff.reasonKind).toBeUndefined();

    const sshOn = targets.find((t) => t.id === "ssh-proxy-enabled")!;
    expect(sshOn.reasonKind).toBe("proxy");
    expect(sshOn.blocked).toContain("proxy");

    const realS3 = targets.find((t) => t.id === "s3-real-prod")!;
    expect(realS3.blocked).toBeUndefined();
    expect(realS3.reasonKind).toBeUndefined();

    // Demo target classification is active only in demo mode (isDemoTarget checks isDemoMode())
    setDemoModeForTesting(true);
    const demoTargets = await host.inventoryTargets();
    const demoS3 = demoTargets.find((t) => t.id === "demo-s3-storagegrid-prod")!;
    expect(demoS3.reasonKind).toBe("demo");
    expect(demoS3.blocked).toBe("Simulated demo storage: not probed on a real network.");
  });

  it("createHub.inventoryTargets includes getDemoServers() and getDemoS3Profiles() in demo mode when ProfileStore is empty", async () => {
    setDemoModeForTesting(true);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-createhub-demo-inv-"));
    const profileStore = new ProfileStore(path.join(dir, "profiles.json"));
    const bridge = {
      profileStore,
      teamVaultService: { listVaultIds: async () => [], isUnlocked: () => false },
      k8sDiscoveryService: { listContexts: async () => [] },
      scheduleAutoSync: () => {},
    };
    const hub = createHub(
      bridge as never,
      { backgroundChanged: async () => {}, show: () => {} },
      {
        hubDirectory: dir,
        aiConfigFilePath: path.join(dir, "ai.json"),
        s3ConfigFilePath: path.join(dir, "s3.json"),
      },
    );
    disposals.push(async () => {
      await hub.dispose();
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });

    const host = (hub as unknown as {
      host: { inventoryTargets: () => Promise<Array<{ id: string; kind: string; blocked?: string; reasonKind?: string }>> };
    }).host;
    const targets = await host.inventoryTargets();

    const demoSsh = targets.find((t) => t.id === "demo-netapp-aff-a800-01a");
    expect(demoSsh).toMatchObject({
      id: "demo-netapp-aff-a800-01a",
      kind: "ssh",
      reasonKind: "demo",
      blocked: "Simulated demo server: not probed on a real network.",
    });
    const demoS3 = targets.find((t) => t.id === "demo-s3-storagegrid-prod");
    expect(demoS3).toMatchObject({
      id: "demo-s3-storagegrid-prod",
      kind: "s3",
      reasonKind: "demo",
      blocked: "Simulated demo storage: not probed on a real network.",
    });
  });
});
