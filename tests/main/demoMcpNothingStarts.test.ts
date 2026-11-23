import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEMO_MCP_REFUSAL, isDemoTarget, setDemoModeForTesting } from "../../src/main/demo/demoMode";
import { HubService, type HubHost } from "../../src/main/ai/hub/HubService";
import { deleteDemoMcpServer, getDemoServers, mcpCatalog } from "../../src/main/ai/hub/demoWorkspace";
import { stopScenario } from "../../src/main/sim/lab";
import { setSimWorld } from "../../src/main/sim/SimWorld";
import type { AgentTask, McpServerConfig } from "../../src/shared/types/aiHub";

/**
 * The demo lab's MCP servers are invented. Adding one, testing it and calling its tools must never
 * start a program on this machine or call an address: these tests fail the moment the real MCP
 * client is asked to do either.
 */

const dirs: string[] = [];
const hubs: HubService[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const hub of hubs.splice(0)) hub.dispose();
  await new Promise((r) => setTimeout(r, 30));
  for (const server of servers.splice(0)) await new Promise((r) => server.close(r));
  stopScenario();
  setSimWorld(undefined);
  // What a test added to the demo's own list of MCP servers (kept for the whole process) is taken out again.
  setDemoModeForTesting(true);
  for (const id of [...mcpCatalog().map((p) => p.id), "typed-in-by-hand"]) deleteDemoMcpServer(id);
  setDemoModeForTesting(false);
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

async function makeHub(demo: boolean, seed?: (dir: string) => Promise<void>): Promise<{ hub: HubService; dir: string }> {
  setDemoModeForTesting(demo);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-demo-mcp-"));
  dirs.push(dir);
  await seed?.(dir);
  const host: HubHost = {
    changed: () => undefined,
    inventoryTargets: async () => [],
    openSchedule: async () => "sched",
    workspaceServers: async () => (demo ? getDemoServers() : []),
    backgroundChanged: async () => undefined,
    show: () => undefined,
    aiConfigFilePath: path.join(dir, "ai-config.json"),
  };
  const hub = new HubService(host, dir);
  await hub.initialize();
  hubs.push(hub);
  return { hub, dir };
}

/** Fails the test when the real MCP client is used at all. */
function forbidRealClient(hub: HubService) {
  const refuse = (what: string) => async (): Promise<never> => {
    throw new Error(`the real MCP client was asked to ${what}`);
  };
  return {
    test: vi.spyOn(hub.mcp, "testAndDiscover").mockImplementation(refuse("start or reach a server")),
    call: vi.spyOn(hub.mcp, "callTool").mockImplementation(refuse("call a tool")),
    oauth: vi.spyOn(hub.mcp, "discoverOAuthMetadata").mockImplementation(refuse("look up sign-in details")),
  };
}

function task(id: string): AgentTask {
  return {
    id,
    title: "Demo MCP",
    mode: "assisted",
    status: "running",
    messages: [],
    changes: [],
    sources: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    maxCommands: 20,
    maxMinutes: 5,
    verification: "not-verified",
  };
}

/** Calls a tool as a run would, and approves the call when a person is asked. */
async function callApproved(hub: HubService, run: AgentTask, key: string, action: string): Promise<{ ok: boolean; output?: unknown }> {
  const before = run.changes.length;
  const pending = hub.broker.invoke(key, { action, payload: { query: "up" } }) as Promise<{ ok: boolean; output?: unknown }>;
  // The error is looked at where the result is awaited; a refusal must not be an unhandled rejection meanwhile.
  pending.catch(() => undefined);
  await vi.waitFor(() => expect(run.changes.length).toBe(before + 1));
  await hub.request({ action: "approve", taskId: run.id, changeId: run.changes[before].id, approved: true });
  return pending;
}

/** A server whose program leaves a file behind the moment it starts. */
function markerServer(marker: string): McpServerConfig {
  return {
    id: "typed-in-by-hand",
    name: "Typed in by hand",
    transport: "stdio",
    command: process.execPath,
    args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'started')", marker],
    enabled: true,
    discoveredTools: [{ name: "probe_tool", description: "A tool somebody typed in." }],
  };
}

const exists = (file: string): Promise<boolean> => fs.access(file).then(() => true, () => false);

describe("MCP servers in the demo lab", () => {
  it("gives every preset of the demo catalog an id the simulation recognises", () => {
    setDemoModeForTesting(true);
    const catalog = mcpCatalog();
    expect(catalog.length).toBeGreaterThan(5);
    for (const preset of catalog) expect(isDemoTarget(preset.id), preset.id).toBe(true);
    // Outside the demo the catalog is the real one, and nothing in it is a demo target.
    setDemoModeForTesting(false);
    for (const preset of mcpCatalog()) expect(preset.id.startsWith("demo-")).toBe(false);
  });

  it("adds, tests and calls every demo preset without the real MCP client being asked for anything", async () => {
    const { hub } = await makeHub(true);
    const real = forbidRealClient(hub);
    const presets = mcpCatalog();

    for (const preset of presets) {
      const added = await hub.request({ action: "mcp-install-preset", presetId: preset.id });
      const server = added.mcpServers?.find((s) => s.id === preset.id);
      expect(server, preset.id).toBeDefined();
      expect(server).toMatchObject({ demo: true, status: "connected", enabled: true });
      expect(server?.discoveredTools?.map((t) => t.name)).toEqual(preset.defaultTools.map((t) => t.name));
      // Added means it left the list of what can be added.
      expect(isDemoTarget(server!.id)).toBe(true);

      const tested = await hub.request({ action: "mcp-test", id: preset.id });
      expect(tested.reply?.notes?.[0]).toMatch(/is a demo server\. Its \d+ tools? are simulated/);
      expect(tested.mcpServers?.find((s) => s.id === preset.id)).toMatchObject({ demo: true, status: "connected" });

      const run = task(`task-${preset.id}`);
      hub.store.data.tasks.push(run);
      const cap = await hub.broker.issue(run);
      for (const tool of preset.defaultTools) {
        const res = await callApproved(hub, run, cap.key, `mcp__${preset.id}__${tool.name}`);
        expect(res.ok, `${preset.id} ${tool.name}`).toBe(true);
        expect(JSON.parse(String(res.output)), `${preset.id} ${tool.name}`).toMatchObject({ simulated: true });
      }
      expect(run.changes.every((c) => c.status === "completed")).toBe(true);
      hub.broker.revoke(run.id);
    }

    expect(real.test).not.toHaveBeenCalled();
    expect(real.call).not.toHaveBeenCalled();
    expect(real.oauth).not.toHaveBeenCalled();
  });

  it("still finds a demo preset by the id it had before, and keeps it under its demo id", async () => {
    const { hub } = await makeHub(true);
    const real = forbidRealClient(hub);
    const added = await hub.request({ action: "mcp-install-preset", presetId: "preset-mcp-prometheus" });
    expect(added.mcpServers?.some((s) => s.id === "preset-mcp-prometheus")).toBe(false);
    expect(added.mcpServers?.find((s) => s.id === "demo-mcp-prometheus")).toMatchObject({ demo: true, status: "connected" });
    expect(real.test).not.toHaveBeenCalled();
  });

  it("gives a preset an earlier version stored under its old id its demo id when the demo starts", async () => {
    const { hub } = await makeHub(true, async (dir) => {
      // What "Add" left in the demo's store before: an id the simulation did not recognise, said to be connected.
      const first = new HubService(
        { changed: () => undefined, inventoryTargets: async () => [], openSchedule: async () => "s", backgroundChanged: async () => undefined, show: () => undefined, aiConfigFilePath: path.join(dir, "ai-config.json") },
        dir,
      );
      await first.initialize();
      first.store.data.mcpServers = [
        { id: "preset-mcp-prometheus", name: "Prometheus & Alertmanager MCP", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-prometheus"], enabled: true, status: "connected", discoveredTools: [{ name: "prometheus_query_range", description: "PromQL" }] },
      ];
      first.store.data.agents = [{ id: "agent-1", name: "Watcher", role: "SRE", mission: "Watch", systemPrompt: "", defaultMode: "assisted", updatedAt: 1, mcpServerIds: ["preset-mcp-prometheus", "something-else"] }];
      await first.store.save();
      first.dispose();
    });
    const real = forbidRealClient(hub);
    const snap = await hub.snapshot();
    expect(snap.mcpServers?.some((s) => s.id === "preset-mcp-prometheus")).toBe(false);
    expect(snap.mcpServers?.find((s) => s.id === "demo-mcp-prometheus")).toMatchObject({ demo: true });
    expect(hub.store.data.agents?.find((a) => a.id === "agent-1")?.mcpServerIds).toEqual(["demo-mcp-prometheus", "something-else"]);

    const run = task("task-legacy");
    hub.store.data.tasks.push(run);
    const cap = await hub.broker.issue(run);
    const res = await callApproved(hub, run, cap.key, "mcp__demo-mcp-prometheus__prometheus_query_range");
    expect(JSON.parse(String(res.output))).toMatchObject({ simulated: true, server: "demo-mcp-prometheus" });
    expect(real.test).not.toHaveBeenCalled();
    expect(real.call).not.toHaveBeenCalled();
  });

  it("does not start a program somebody typed in: Test says so, a tool call is refused before anyone is asked", async () => {
    const { hub, dir } = await makeHub(true);
    const marker = path.join(dir, "started.txt");
    const typed = markerServer(marker);
    const saved = await hub.request({ action: "mcp-save", server: typed });
    expect(saved.mcpServers?.find((s) => s.id === typed.id)?.demo).toBeUndefined();

    const tested = await hub.request({ action: "mcp-test", id: typed.id });
    expect(tested.reply?.notes).toEqual([`Typed in by hand was not tested. ${DEMO_MCP_REFUSAL}`]);
    const shown = tested.mcpServers?.find((s) => s.id === typed.id);
    // Not tested is not "connected", not "failed", and has no time of a test.
    expect(shown?.status).toBe("unknown");
    expect(shown?.lastTestedAt).toBeUndefined();

    const run = task("task-typed");
    hub.store.data.tasks.push(run);
    const cap = await hub.broker.issue(run);
    await expect(hub.broker.invoke(cap.key, { action: "mcp__typed-in-by-hand__probe_tool", payload: {} })).rejects.toThrow(DEMO_MCP_REFUSAL);
    // Nobody was asked to approve a call that would not be made.
    expect(run.changes).toEqual([]);

    await new Promise((r) => setTimeout(r, 300));
    expect(await exists(marker)).toBe(false);
  });

  it("refuses in the MCP client itself, whatever asks: no program is started and no address is called", async () => {
    let requests = 0;
    const server = http.createServer((_req, res) => {
      requests++;
      res.writeHead(404).end();
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    const byAddress: McpServerConfig = { id: "typed-address", name: "Typed address", transport: "http", url, enabled: true, discoveredTools: [{ name: "probe_tool", description: "" }] };

    const { hub, dir } = await makeHub(true);
    const marker = path.join(dir, "started.txt");
    const byProgram = markerServer(marker);
    // A demo id makes no difference here: the client itself is never the way to a demo server.
    const demoNamed: McpServerConfig = { ...markerServer(marker), id: "demo-mcp-prometheus" };

    for (const config of [byProgram, demoNamed, byAddress]) {
      expect(await hub.mcp.testAndDiscover(config)).toEqual({ ok: false, tools: [], error: DEMO_MCP_REFUSAL });
      expect(await hub.mcp.callTool(config, "probe_tool", {})).toEqual({ ok: false, error: DEMO_MCP_REFUSAL });
    }
    await expect(hub.mcp.discoverOAuthMetadata(byAddress)).rejects.toThrow(DEMO_MCP_REFUSAL);
    await new Promise((r) => setTimeout(r, 300));
    expect(await exists(marker)).toBe(false);
    expect(requests).toBe(0);

    // The same two servers outside the demo are started and called: the checks above can fail.
    const real = await makeHub(false);
    const realMarker = path.join(real.dir, "started.txt");
    await real.hub.mcp.testAndDiscover(markerServer(realMarker), 5_000);
    await vi.waitFor(async () => expect(await exists(realMarker)).toBe(true), { timeout: 5_000 });
    await real.hub.mcp.testAndDiscover(byAddress, 5_000);
    expect(requests).toBeGreaterThan(0);
  });
});
