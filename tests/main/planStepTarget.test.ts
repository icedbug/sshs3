import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentPlanStep, AgentTask } from "../../src/shared/types/aiHub";

/**
 * Which terminal a step of a proposed plan runs on, from what its target says. An approved plan's change
 * card runs without a second question only on that terminal (planCoversCommand), so a step that is not
 * tied to one is asked about again. In the lab, Opus wrote "web-02 (staging): /tmp/<dir>/note.txt" as the
 * target, the step was never tied to web-02's terminal, and the approved plan asked again.
 */

vi.mock("electron", () => ({
  app: { getPath: () => os.tmpdir(), quit: () => {} },
  Notification: { isSupported: () => false },
  powerMonitor: { on: vi.fn(), removeListener: vi.fn() },
}));

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const d of disposals.splice(0)) await d();
});

const SERVERS = [
  { id: "srv-web01", name: "web-01", host: "10.0.0.11", port: 22, username: "ops" },
  { id: "srv-web02", name: "web-02", host: "10.0.0.12", port: 22, username: "ops" },
  { id: "srv-db01", name: "db-01", host: "10.0.0.21", port: 22, username: "ops" },
];

async function makeHub() {
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(false);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-plan-target-"));
  const hub = new HubService(
    {
      changed: () => {},
      inventoryTargets: async () => [],
      backgroundChanged: async () => {},
      openSchedule: async () => "s1",
      show: () => {},
      aiConfigFilePath: path.join(dir, "ai.json"),
      workspaceServers: async () => SERVERS,
    } as never,
    dir,
  );
  disposals.push(async () => {
    await hub.dispose();
    setDemoModeForTesting(undefined);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await hub.initialize();
  // The servers the workspace knows are read before a run starts; a plan is proposed during one.
  await (hub as unknown as { collectExtraContext(): Promise<unknown> }).collectExtraContext();
  const open = (id: string, server: (typeof SERVERS)[number]) => {
    hub.terminals.register({ id, label: server.name, kind: "ssh", profileId: server.id }, () => {});
    return JSON.stringify([id, hub.terminals.get(id)!.generation]);
  };
  return { hub, open };
}

/** A conversation in Plan on the given terminal, whose agent just proposed a step for each target. */
function proposed(hub: Awaited<ReturnType<typeof makeHub>>["hub"], terminal: string, targets: Array<string | undefined>): AgentTask {
  const session = hub.terminals.get(terminal)!;
  const steps: AgentPlanStep[] = targets.map((target, i) => ({
    action: `Step ${i + 1}`,
    ...(target === undefined ? {} : { target }),
    command: `touch /tmp/step-${i + 1}`,
    commandHash: `${i}`.repeat(64).slice(0, 64),
    risk: "low",
    check: `test -f /tmp/step-${i + 1}`,
  }));
  const task = {
    id: `plan-${terminal}`,
    title: "A plan",
    mode: "plan",
    status: "waiting",
    messages: [{ id: "u", role: "user", text: "Make the files", at: 1 }],
    changes: [],
    sources: [],
    createdAt: 1,
    updatedAt: 1,
    maxCommands: 0,
    maxMinutes: 0,
    verification: "not-verified",
    target: { sessionId: session.id, generation: session.generation, label: session.label },
    plan: { id: "p1", goal: "The files exist", steps, assumptions: [], status: "proposed", revision: 1, createdAt: 1 },
  } as unknown as AgentTask;
  hub.store.data.tasks.push(task);
  hub.planProposed(task);
  return task;
}

describe("the terminal a plan step runs on", () => {
  it("is the server its target names, also with more words after the name", async () => {
    const { hub, open } = await makeHub();
    const web02 = open("t-web02", SERVERS[1]);
    const web01 = open("t-web01", SERVERS[0]);
    const task = proposed(hub, "t-web02", ["web-02 (staging): /tmp/labdir/note.txt", "web-02", "nginx on web-01", "ops@10.0.0.12:/etc/hosts", "WEB-02"]);
    expect(task.plan!.steps.map((s) => s.approvedTarget)).toEqual([web02, web02, web01, web02, web02]);
  });

  it("is the conversation's own terminal for a step with no target, or whose target is only a path", async () => {
    const { hub, open } = await makeHub();
    const web02 = open("t-web02", SERVERS[1]);
    open("t-web01", SERVERS[0]);
    const task = proposed(hub, "t-web02", [undefined, "/etc/nginx/nginx.conf", "~/notes/today.txt"]);
    expect(task.plan!.steps.map((s) => s.approvedTarget)).toEqual([web02, web02, web02]);
  });

  it("is the conversation's own one when the server the step names is open in two tabs", async () => {
    const { hub, open } = await makeHub();
    open("t-web02-a", SERVERS[1]);
    const second = open("t-web02-b", SERVERS[1]);
    const task = proposed(hub, "t-web02-b", ["web-02", "web-02: /etc/hosts"]);
    expect(task.plan!.steps.map((s) => s.approvedTarget)).toEqual([second, second]);
  });

  it("follows the server its target names to a terminal opened again there, and only that server", async () => {
    const { hub, open } = await makeHub();
    open("t-web02", SERVERS[1]);
    const web01 = open("t-web01", SERVERS[0]);
    const task = proposed(hub, "t-web02", ["web-02 (staging): /tmp/labdir/note.txt", "web-01: /etc/hosts"]);
    // The hub closes a terminal it opened itself at the end of a run, and opens a new one when the
    // conversation goes on (reviveOwnTerminal).
    hub.terminals.forget("t-web02");
    const reopened = open("t-web02-new", SERVERS[1]);
    hub.rebindPlanSteps(task, "srv-web02", "t-web02-new");
    expect(task.plan!.steps.map((s) => s.approvedTarget)).toEqual([reopened, web01]);
  });

  it("is none, so the change is asked about again, when the target names no open terminal, two servers, or another host", async () => {
    const { hub, open } = await makeHub();
    open("t-web02", SERVERS[1]);
    open("t-web01", SERVERS[0]);
    const task = proposed(hub, "t-web02", [
      "db-01",
      "web-01 and web-02",
      "web-02 and db-01",
      "web-020",
      "web-02.example.com",
      "/etc/nginx/nginx.conf on db-01",
      "nginx",
    ]);
    expect(task.plan!.steps.map((s) => s.approvedTarget)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
  });
});
