import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runLines } from "../../src/main/sim/Scenario";
import { SCENARIOS, stopScenario } from "../../src/main/sim/lab";
import { simWorld } from "../../src/main/sim/SimWorld";
import { getDemoActivityLog, getDemoServers } from "../../src/main/ai/hub/demoWorkspace";

/** A scenario in the hub: starting one puts its story everywhere it belongs, and the hub says how it stands. */

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  stopScenario();
  vi.unstubAllGlobals();
});

async function demoHub(demo = true) {
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(demo);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-sim-"));
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
  return hub;
}

describe("the demo lab's scenarios", () => {
  it("are offered in demo mode only", async () => {
    const real = await demoHub(false);
    expect((await real.snapshot()).simulation).toBeUndefined();
    await expect(real.request({ action: "sim-start", scenarioId: "pg-wal-full" })).rejects.toThrow("Scenarios run in the demo lab only");

    const hub = await demoHub();
    const view = (await hub.snapshot()).simulation!;
    expect(view.running).toBeUndefined();
    expect(view.scenarios.map((s) => s.id)).toEqual(SCENARIOS.map((s) => s.id));
    await expect(hub.request({ action: "sim-start", scenarioId: "nope" })).rejects.toThrow("There is no such scenario.");
  });

  it("put the incident everywhere it belongs: servers, chat, activity, and an alert's ticket that carries the chat", async () => {
    const hub = await demoHub();
    const started = await hub.request({ action: "sim-start", scenarioId: "pg-wal-full" });
    const sim = started.simulation!.running!;
    expect(sim).toMatchObject({ id: "pg-wal-full", target: "pg-prod-db01", total: 4 });
    expect(sim.checks.filter((c) => c.pass).map((c) => c.id)).toEqual(["wal-kept"]);

    // The servers are in the inventory, as servers of the demo lab.
    const servers = getDemoServers().filter((s) => s.name.startsWith("pg-prod-db"));
    expect(servers.map((s) => [s.id, s.host, s.cluster])).toEqual([
      ["demo-ssh-pg-prod-db01", "10.30.60.11", "Postgres-Prod"],
      ["demo-ssh-pg-prod-db02", "10.30.60.12", "Postgres-Prod"],
    ]);

    // What the team wrote is searchable, as from a bot, and nothing is asked of any service.
    expect(started.chatSources!.connections[0]).toMatchObject({ service: "slack", bot: "sshs3-bot", channels: [{ name: "ops", selected: true, count: 4 }] });
    const hits = (await hub.request({ action: "chat-search", query: "sg-gw-01 decommissioned" })).reply!.chatSearch!.hits;
    expect(hits[0].messages.map((m) => m.author)).toEqual(["Erik", "Sara"]);
    expect(hits[0].messages.map((m) => m.text).join(" ")).toContain("sg-gw-01");

    // The alert became a ticket about the right server.
    const ticket = started.workTickets!.find((t) => t.id === sim.ticketId)!;
    expect(ticket).toMatchObject({ title: "Alert (critical): Disk /var/lib/postgresql is 97% full on pg-prod-db01", status: "todo", alert: { name: "DiskAlmostFull", source: "Alertmanager" } });
    // Nothing in the chat names this server, so nothing is put on the ticket: the clue has to be found.
    expect(ticket.chatRefs).toBeUndefined();
    expect(getDemoActivityLog().some((e) => e.summary.includes("Decommissioned the StorageGRID gateway node sg-gw-01"))).toBe(true);
  });

  it("read the servers' facts from their state, so a fix shows as a change", async () => {
    const hub = await demoHub();
    await hub.request({ action: "sim-start", scenarioId: "pg-wal-full" });
    await hub.request({ action: "facts-configure", enabled: true });
    const read = async () => (await hub.request({ action: "facts-collect-now", serverId: "demo-ssh-pg-prod-db01" })).serverFacts!.servers.find((s) => s.serverId === "demo-ssh-pg-prod-db01")!;
    const before = await read();
    expect(before).toMatchObject({ status: "ok", os: "Ubuntu 24.04.1 LTS" });
    expect(before.problems.map((p) => p.text)).toContain("Disk /var/lib/postgresql is 97 % full");

    runLines(simWorld(), ["pg-prod-db01: sudo sed -i 's|https://sg-gw-01.acme.internal:8082|https://s3.storagegrid.acme.internal:10443|' /etc/default/wal-archive"]);
    const after = await read();
    expect(after.changes.map((c) => c.text)).toContain("Disk /var/lib/postgresql is back to 36 %");
    expect(after.problems.map((p) => p.text)).not.toContain("Disk /var/lib/postgresql is 97 % full");
  });

  it("say how the scenario stands as it is worked, and take everything away again when it ends", async () => {
    const hub = await demoHub();
    await hub.request({ action: "sim-start", scenarioId: "pg-wal-full" });
    const scenario = SCENARIOS.find((s) => s.id === "pg-wal-full")!;
    runLines(simWorld(), scenario.solutions.careful);
    const now = (await hub.snapshot()).simulation!.running!;
    expect(now.checks.filter((c) => !c.pass).map((c) => c.id)).toEqual(["report"]);
    expect(now.commands).toBe(scenario.solutions.careful.length);
    expect(now.unsupported).toEqual([]);

    const ended = await hub.request({ action: "sim-reset" });
    expect(ended.simulation!.running).toBeUndefined();
    expect(getDemoServers().some((s) => s.name.startsWith("pg-prod-db"))).toBe(false);
    expect(ended.chatSources!.connections).toEqual([]);
    expect((ended.workTickets ?? []).filter((t) => t.alert)).toEqual([]);
    expect(simWorld().host("pg-prod-db01")).toBeUndefined();
  });

  it("can each be started, worked to green by their careful way, and ended", async () => {
    const hub = await demoHub();
    for (const scenario of SCENARIOS) {
      const started = await hub.request({ action: "sim-start", scenarioId: scenario.id });
      const running = started.simulation!.running!;
      expect(running.id).toBe(scenario.id);
      expect(started.workTickets!.find((t) => t.id === running.ticketId)?.title).toContain(scenario.alert!.summary);
      expect(getDemoServers().filter((s) => scenario.servers.some((x) => x.id === s.id))).toHaveLength(scenario.servers.length);
      runLines(simWorld(), scenario.solutions.careful);
      const now = (await hub.snapshot()).simulation!.running!;
      expect(now.checks.filter((c) => !c.pass).map((c) => c.id), scenario.id).toEqual(["report"]);
    }
    const ended = await hub.request({ action: "sim-reset" });
    expect(ended.simulation!.running).toBeUndefined();
    expect(getDemoServers().filter((s) => SCENARIOS.some((x) => x.servers.some((y) => y.id === s.id)))).toEqual([]);
  });

  it("have the team's page for that kind of trouble in the knowledge base while they run, and it does not give the answer away", async () => {
    const hub = await demoHub();
    for (const scenario of SCENARIOS) {
      const started = await hub.request({ action: "sim-start", scenarioId: scenario.id });
      const page = started.kbPages!.find((p) => p.title === scenario.runbook!.title)!;
      expect(page, scenario.id).toMatchObject({ kind: "troubleshooting", updatedBy: "the team (demo lab)" });
      // Found by what the alert is called.
      const hits = (await hub.request({ action: "kb-search", query: scenario.alert!.name } as never)).reply as { kbSearch?: { hits?: { title?: string }[] } } | undefined;
      expect(JSON.stringify(hits ?? {}), scenario.id).toContain(scenario.runbook!.title);
    }
    // What this incident's own answer is stays out of the page: the old gateway's name, the zone's two names.
    const text = SCENARIOS.map((s) => s.runbook!.body).join("\n");
    for (const giveaway of ["sg-gw-01", "api_limit", "ufw allow 80", "vol_ai_scratch", "ceph balancer on"]) expect(text).not.toContain(giveaway);
    const ended = await hub.request({ action: "sim-reset" });
    expect((ended.kbPages ?? []).filter((p) => SCENARIOS.some((s) => s.runbook!.title === p.title))).toEqual([]);
  });
});
