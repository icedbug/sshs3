import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentTask, InfraGraphEdge, WorkTicket } from "../../src/shared/types/aiHub";
import { buildDailyReport } from "../../src/main/ai/hub/DailyReport";
import { neighbours } from "../../src/main/ai/hub/ContextService";
import { nextRef } from "../../src/main/ai/hub/ToolBroker";

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

const NOW = new Date(2026, 4, 12, 4, 0, 0).getTime();
const HOUR = 60 * 60_000;

describe("the daily report", () => {
  it("says what changed, what went wrong and what waits, from the records only", () => {
    const tasks = [
      {
        agentName: "DBA",
        changes: [
          { id: "1", target: "pg-01", description: "Raise max_connections", status: "completed", riskLevel: "modify", at: NOW - HOUR, check: { command: "pg_isready", after: { exitCode: 0, output: "ok", at: NOW } } },
          { id: "2", target: "pg-01", description: "Restart pgbouncer", status: "failed", riskLevel: "modify", at: NOW - 2 * HOUR, rollback: { command: "systemctl start pgbouncer", ran: true, exitCode: 0 } },
          { id: "3", target: "pg-01", description: "df -h", status: "completed", riskLevel: "safe", at: NOW - HOUR },
          { id: "4", target: "pg-01", description: "Old change", status: "completed", riskLevel: "modify", at: NOW - 30 * HOUR },
        ],
      },
    ] as unknown as AgentTask[];
    const tickets = [
      { id: "t1", title: "Alert (critical): Disk almost full on pg-01", status: "in_progress", assigneeName: "DBA", updatedAt: NOW - HOUR, alert: { lastAt: NOW - HOUR, count: 3 } },
      { id: "t2", title: "Rotate certificates", status: "done", updatedAt: NOW - HOUR },
      { id: "t3", title: "Upgrade kernel", status: "review", updatedAt: NOW - 40 * HOUR },
      { id: "t4", title: "Fix replication", status: "blocked", result: "No access to the replica", updatedAt: NOW - HOUR },
    ] as unknown as WorkTicket[];
    const text = buildDailyReport({
      since: NOW - 24 * HOUR,
      now: NOW,
      activity: [{ id: "a", at: NOW - HOUR, actor: "Ana", kind: "command", targetLabel: "web-01", summary: "Reloaded nginx" }] as never,
      tickets,
      tasks,
      pages: [{ id: "p", title: "Postgres", updatedBy: "assistant", updatedAt: NOW - HOUR, history: [{ summary: "Added the pgbouncer restart pitfall" }] }] as never,
      memories: [],
      findings: [{ id: "f", kind: "gap", title: "x" }] as never,
    });
    expect(text).toContain("### Alerts");
    expect(text).toContain("Disk almost full on pg-01 — still firing, fired 3 times; ticket is in progress (DBA)");
    expect(text).toContain("Restart pgbouncer — its check failed and it was rolled back");
    expect(text).toContain("Ticket “Fix replication” stopped: No access to the replica");
    expect(text).toContain("DBA on pg-01: Raise max_connections (check passed)");
    expect(text).not.toContain("df -h");
    expect(text).not.toContain("Old change");
    expect(text).toContain("Ana on web-01: Reloaded nginx");
    expect(text).toContain("- Rotate certificates");
    expect(text).toContain("Page “Postgres”: Added the pgbouncer restart pitfall");
    expect(text).toContain("1 ticket to review");
    expect(text).toContain("1 run that stopped");
    expect(text).toContain("1 question agents found nothing on");
    expect(buildDailyReport({ since: NOW - 24 * HOUR, now: NOW, activity: [], tickets: [], tasks: [], pages: [], memories: [], findings: [] })).toContain("Nothing was recorded");
  });
});

describe("the dependency map", () => {
  const edges = [
    { id: "1", from: "DB-Prod", to: "Backup-ZFS", relation: "replicates_to", label: "lag under 5 min", updatedAt: 1 },
    { id: "2", from: "web-01", to: "DB-Prod", relation: "depends_on", updatedAt: 1 },
    { id: "3", from: "DB-Prod", to: "vault", relation: "depends_on", proposed: true, updatedAt: 1 },
    { id: "4", from: "a", to: "b", relation: "monitors", updatedAt: 1 },
  ] as InfraGraphEdge[];

  it("names what the target leans on and what leans on it, and leaves suggestions out", () => {
    expect(neighbours(edges, ["pg-01", "db-prod"])).toEqual([
      "Upstream: DB-Prod replicates to Backup-ZFS (lag under 5 min). A fault here may start there.",
      "Downstream: web-01 depends on DB-Prod. A change here can reach it.",
    ]);
    expect(neighbours(edges, ["", ""])).toEqual([]);
    expect(neighbours(edges, ["nothing"])).toEqual([]);
  });

  it("numbers commands c1, c2 … within a conversation", () => {
    const task = { changes: [] } as unknown as AgentTask;
    expect(nextRef(task)).toBe("c1");
    task.changes.push({ ref: "c1" } as never, { ref: "c7" } as never, {} as never);
    expect(nextRef(task)).toBe("c8");
  });
});

describe("in the hub", () => {
  async function makeHub() {
    const { HubService } = await import("../../src/main/ai/hub/HubService");
    const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
    setDemoModeForTesting(false);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-nightly-"));
    const hub = new HubService(
      { changed: () => {}, inventoryTargets: async () => [], backgroundChanged: async () => {}, openSchedule: async () => "s1", show: () => {}, aiConfigFilePath: path.join(dir, "ai.json") } as never,
      dir,
    );
    disposals.push(async () => { await hub.dispose(); setDemoModeForTesting(undefined); await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
    await hub.initialize();
    return hub;
  }

  it("keeps an agent's link as a suggestion until a person confirms it", async () => {
    const hub = await makeHub();
    await hub.request({ action: "infra-edge-save", edge: { from: "web-01", to: "DB-Prod", relation: "depends_on", proposed: true, evidence: "ss -tnp shows a connection to 10.0.0.5:5432", proposedBy: "SRE" } });
    let snap = await hub.snapshot();
    const edge = snap.infraEdges![0];
    expect(edge).toMatchObject({ proposed: true, evidence: "ss -tnp shows a connection to 10.0.0.5:5432", proposedBy: "SRE" });
    const task = { id: "t", changes: [], messages: [], sources: [] } as unknown as AgentTask;
    const context = (hub as unknown as { context: { read: (t: AgentTask) => { infraDependencyGraph: InfraGraphEdge[] } } }).context;
    expect(context.read(task).infraDependencyGraph).toEqual([]);

    snap = await hub.request({ action: "infra-edge-confirm", id: edge.id });
    expect(snap.infraEdges![0].proposed).toBeUndefined();
    expect(context.read(task).infraDependencyGraph).toHaveLength(1);

    // The same link suggested again does not turn the confirmed one back into a suggestion.
    snap = await hub.request({ action: "infra-edge-save", edge: { from: "web-01", to: "DB-Prod", relation: "depends_on", proposed: true } });
    expect(snap.infraEdges).toHaveLength(1);
    expect(snap.infraEdges![0].proposed).toBeUndefined();
    await expect(hub.request({ action: "infra-edge-confirm", id: "nope" })).rejects.toThrow("Link not found");
  });

  it("writes the report once a day, after three, and not while a person's run is going", async () => {
    const hub = await makeHub();
    const nightly = (now: number): Promise<void> => (hub as unknown as { nightly: (n: number) => Promise<void> }).nightly(now);
    await hub.request({ action: "ticket-save", ticket: { title: "Rotate certificates", status: "review" } } as never);

    await nightly(new Date(2026, 4, 12, 1, 0).getTime());
    expect(hub.store.data.dailyReport).toBeUndefined();

    await nightly(NOW);
    const report = hub.store.data.dailyReport!;
    expect(report.day).toBe("2026-05-12");
    expect(report.text).toContain("1 ticket to review");
    expect((await hub.snapshot()).dailyReport).toMatchObject({ day: "2026-05-12" });

    report.text = "kept";
    await nightly(NOW + HOUR);
    expect(hub.store.data.dailyReport!.text).toBe("kept");

    await hub.request({ action: "daily-report-read" });
    expect(hub.store.data.dailyReport!.readAt).toBeGreaterThan(0);
    await nightly(NOW + 24 * HOUR);
    expect(hub.store.data.dailyReport!.day).toBe("2026-05-13");
    expect(hub.store.data.dailyReport!.readAt).toBeUndefined();
  });
});
