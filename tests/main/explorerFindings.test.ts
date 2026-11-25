import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentTask, HubRequest } from "../../src/shared/types/aiHub";
import { inboxItems } from "../../src/shared/aiHubInbox";
import { buildDailyReport } from "../../src/main/ai/hub/DailyReport";
import { buildLearnPrompt } from "../../src/main/ai/hub/KbCompile";

/**
 * What the exploring testers of the feature test found in the hub, one test per finding: a person in a
 * role used the product in a real browser, and what misled them is pinned here.
 */

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const d of disposals.splice(0)) await d();
});

async function makeHub() {
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(false);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-explorer-hub-"));
  const hub = new HubService(
    {
      changed: () => {},
      inventoryTargets: async () => [],
      backgroundChanged: async () => {},
      openSchedule: async () => "s1",
      show: () => {},
      aiConfigFilePath: path.join(dir, "ai.json"),
      workspaceServers: async () => [],
    } as never,
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

type Broker = { issue: (t: AgentTask) => Promise<{ key: string }>; invoke: (key: string, request: { action: string; payload?: unknown }) => Promise<unknown> };

/** A run of an agent, and its tool calls as the broker takes them. */
async function startRun(hub: Awaited<ReturnType<typeof makeHub>>) {
  const task = { id: `run-${Math.random().toString(36).slice(2, 8)}`, title: "A run", agentName: "Operator", mode: "advice", status: "running", messages: [], changes: [], sources: [], createdAt: Date.now(), updatedAt: Date.now(), maxCommands: 20, maxMinutes: 15 } as unknown as AgentTask;
  hub.store.data.tasks.push(task);
  const broker = (hub as unknown as { broker: Broker }).broker;
  const { key } = await broker.issue(task);
  return { task, call: (action: string, payload: Record<string, unknown>) => broker.invoke(key, { action, payload }) };
}

describe("what the exploring testers found", () => {
  // E2: an agent was shown only the person's own alert address ("enabled: false, received: 0") and told
  // Omar that an alert on the team's board had not come through the alert intake and could not be traced;
  // it had come in through a teammate's address. That conclusion went into a page of the knowledge base.
  it("tells an agent that the alert address it sees is the person's own, and what alerts the team's board has", async () => {
    const hub = await makeHub();
    hub.store.data.workTickets = [
      ...(hub.store.data.workTickets ?? []),
      {
        id: "t-alert",
        title: "Alert (critical): LabNginxDown",
        description: "",
        status: "todo",
        createdAt: 1,
        updatedAt: 1,
        alert: { fingerprint: "f", source: "Alertmanager", severity: "critical", firstAt: 1, lastAt: 1, count: 1 },
      },
      { id: "t-plain", title: "Rotate the logs", description: "", status: "todo", createdAt: 1, updatedAt: 1 },
    ] as never;
    const run = await startRun(hub);
    const status = (await run.call("sshs3_manage_alerts_and_integrations", { operation: "status" })) as {
      alertIntake: { enabled: boolean; scope: string; onTheTeamsBoard: { open: number; sources: string[] } };
    };
    expect(status.alertIntake.enabled).toBe(false);
    expect(status.alertIntake.scope).toMatch(/your own alert address/i);
    expect(status.alertIntake.scope).toMatch(/another member's address/i);
    expect(status.alertIntake.onTheTeamsBoard).toEqual({ open: 1, sources: ["Alertmanager"] });
  });

  // E3: the team's agents read the audit log, which named only the last of two people who allowed a
  // change on production, and reported that no second approval was recorded.
  it("names each person of a two-person approval in the audit log, the second marked", async () => {
    const hub = await makeHub();
    const task = {
      id: "t-two",
      title: "Create a test file on web-01",
      agentName: "Assistant",
      mode: "assisted",
      status: "completed",
      messages: [],
      sources: [],
      changes: [
        {
          id: "c-two",
          kind: "command",
          target: "web-01",
          description: "Create test file /tmp/x on web-01 (production)",
          command: "printf '%s' x > /tmp/x",
          status: "completed",
          at: 1000,
          exitCode: 0,
          requiredApprovals: 2,
          approvals: [
            { actor: "Omar", actorId: "user:o", at: 1000, allowed: true },
            { actor: "Maria", actorId: "user:m", at: 2000, allowed: true, peer: true },
          ],
          decidedBy: { name: "Maria", at: 2000, allowed: true },
          decidedHow: "person",
        },
      ],
      createdAt: 1000,
      updatedAt: 2000,
      maxCommands: 10,
      maxMinutes: 10,
    } as unknown as AgentTask;
    hub.store.data.tasks.push(task);
    hub.auditFinishedChanges();
    const read = async () => (await hub.request({ action: "audit-read" } as HubRequest)).reply!.audit!.entries.find((e) => e.changeId === "c-two");
    await vi.waitFor(async () => expect(await read()).toBeDefined());
    expect((await read())!.approvedBy).toBe("Omar (allowed), Maria (second person, allowed)");
    // The mode a person chose is named as they know it: "assisted" is the code's word for "Ask first".
    expect((await read())!.actor).toBe("Assistant (run t-two, Ask first)");
  });

  // E5: a critical alert in the inbox said "With Operations lead, not started yet" for more than half an
  // hour while "Start tickets by itself" was off: nothing was going to start it, and nothing said so.
  it("says whether an alert an agent has will start by itself or waits for a person", () => {
    const ticket = {
      id: "t1",
      title: "Alert (critical): Disk almost full",
      description: "",
      status: "todo",
      assigneeAgentId: "ops",
      assigneeName: "Operations lead",
      createdAt: 1,
      updatedAt: 1,
      alert: { fingerprint: "f", source: "Alertmanager", severity: "critical", firstAt: 1, lastAt: 1, count: 1 },
    };
    const detail = (extra: object) => inboxItems({ tasks: [], workTickets: [ticket], ...extra } as never).find((i) => i.id === "alert:t1")?.detail;
    expect(detail({})).toBe("With Operations lead; it waits for a person to start it");
    expect(detail({ preferences: { workforceAutopilot: false } })).toBe("With Operations lead; it waits for a person to start it");
    expect(detail({ preferences: { workforceAutopilot: true } })).toBe("With Operations lead; it starts by itself, critical alerts first");
    expect(detail({ preferences: { workforceAutopilot: true }, workforcePaused: true })).toBe("With Operations lead; the Workforce is paused, so it waits");
  });

  // E4: the inbox showed "What happened 2026-11-25 — Since Tue, Nov 24, 05:50 PM. Nothing was recorded"
  // under a critical alert from that day: the report was made when the workspace started, and said
  // since when it counted but not up to when, so it read as "today was quiet".
  it("says the daily report's whole period, up to when it was made", () => {
    const now = Date.UTC(2026, 10, 25, 17, 50);
    const text = buildDailyReport({ since: now - 24 * 3_600_000, now, activity: [], tickets: [], tasks: [], pages: [], memories: [], findings: [] });
    expect(text).toMatch(/^From .+ to .+\. Nothing was recorded/);
    expect(text).not.toMatch(/^Since /);
  });

  // E1: a page said nginx ran 2 workers; a later health check's own output showed 4 and the agent told
  // Omar the page was out of date. What was learned from that conversation added only a note, and the
  // page kept the old value, marked healthy: learning from work had no rule for a page the work showed
  // wrong, as learning from a source has.
  it("asks what is learned from work to correct a page the work showed to be no longer so", () => {
    const prompt = buildLearnPrompt({ title: "Session: Check the shop's health", transcript: "Command on web-01 → exit 0\n  output: 4 nginx workers" }, [], { servers: ["web-01"], clusters: [] }, []);
    expect(prompt).toMatch(/no longer so/);
    expect(prompt).toMatch(/do not leave the old value standing beside the new one/);
  });
});
