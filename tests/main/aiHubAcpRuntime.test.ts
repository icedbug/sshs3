import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentTask, ExternalRunner } from "../../src/shared/types/aiHub";
import { AcpRuntime, type PermissionQuestion } from "../../src/main/ai/hub/AcpRuntime";
import type { RunEvent } from "../../src/main/ai/hub/AgentRuntime";

const FAKE = path.resolve(__dirname, "../fixtures/fakeAcpAgent.cjs");
const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  delete process.env.FAKE_ACP;
  delete process.env.FAKE_ACP_COMMAND;
  vi.unstubAllGlobals();
});

const runner = (extra: Partial<ExternalRunner> = {}): ExternalRunner => ({
  id: "fake",
  name: "Fake agent",
  command: process.execPath,
  args: [FAKE],
  cwd: os.tmpdir(),
  updatedAt: 1,
  ...extra,
});
const task = (text: string): AgentTask =>
  ({ id: "t", messages: [{ id: "m1", role: "user", text, at: 1 }], changes: [], mode: "assisted" }) as unknown as AgentTask;

async function run(mode: string, ask: (q: PermissionQuestion) => Promise<boolean> = async () => true, r = runner()) {
  process.env.FAKE_ACP = mode;
  const events: RunEvent[] = [];
  const questions: PermissionQuestion[] = [];
  const runtime = new AcpRuntime(r, {
    preface: "You are the Builder.",
    ask: async (q) => {
      questions.push(q);
      return ask(q);
    },
  });
  disposals.push(() => runtime.stop());
  let error: Error | undefined;
  await runtime.start(task("Add a login form"), undefined, (e) => events.push(e)).catch((e: Error) => (error = e));
  return { events, questions, error, runtime };
}

describe("an external agent over ACP", () => {
  it("sends the prompt with who the agent is, shows its plan and text, and refuses file access it does not offer", async () => {
    const { events, error } = await run("plain");
    expect(error).toBeUndefined();
    expect(events.find((e) => e.type === "todos.updated")!.todos).toEqual([
      { id: "p1", content: "Read the code", status: "completed" },
      { id: "p2", content: "Run the tests", status: "in_progress" },
    ]);
    const done = events.at(-1)!;
    expect(done.type).toBe("run.completed");
    expect(done.output).toContain("You are the Builder.");
    expect(done.output).toContain("Add a login form");
    expect(done.output).toContain("File read through the client: refused");
  });

  it("asks before a command and passes the answer on as this once, never as always", async () => {
    const yes = await run("ask", async () => true);
    expect(yes.questions).toEqual([{ title: "Run npm test", kind: "execute", command: "npm test" }]);
    expect(yes.events.at(-1)!.output).toContain("Permission: yes.");
    expect(yes.events.find((e) => e.type === "tool.result")!.tool).toMatchObject({ name: "Run npm test", output: "12 passed" });

    const no = await run("ask", async () => false);
    expect(no.events.at(-1)!.output).toContain("Permission: no.");
    expect(no.events.find((e) => e.type === "tool.result")!.tool!.output).toBe("(failed) not run");
  });

  it("says what is wrong when the agent is not signed in, crashes, cannot be started or has no folder", async () => {
    expect((await run("auth")).error!.message).toMatch(/not signed in on this computer/);
    expect((await run("crash")).error!.message).toMatch(/ended unexpectedly \(exit 3\)/);
    expect((await run("plain", undefined, runner({ command: "/no/such/program-xyz", args: [] }))).error!.message).toMatch(/Could not start/);
    expect((await run("plain", undefined, runner({ cwd: "" }))).error!.message).toMatch(/no working folder/);
    expect((await run("old")).error!.message).toMatch(/protocol version 0/);
  });

  it("stops a run that is under way", async () => {
    process.env.FAKE_ACP = "hang";
    const events: RunEvent[] = [];
    const runtime = new AcpRuntime(runner(), { preface: "", ask: async () => true });
    const done = runtime.start(task("Wait"), undefined, (e) => events.push(e)).catch((e: Error) => e);
    const until = Date.now() + 4000;
    while (!events.some((e) => e.type === "message.delta") && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    await runtime.stop();
    await done;
    expect(events.at(-1)!.type === "run.cancelled" || events.every((e) => e.type !== "run.completed")).toBe(true);
  });
});

describe("a ticket for an external agent", () => {
  async function makeHub() {
    const { HubService } = await import("../../src/main/ai/hub/HubService");
    const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
    setDemoModeForTesting(false);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-acp-"));
    const hub = new HubService(
      { changed: () => {}, inventoryTargets: async () => [], backgroundChanged: async () => {}, openSchedule: async () => "s1", show: () => {}, aiConfigFilePath: path.join(dir, "ai.json") },
      dir,
    );
    disposals.push(async () => {
      await hub.dispose();
      setDemoModeForTesting(undefined);
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });
    await hub.initialize();
    // No model is configured: the external agent brings its own.
    await hub.request({ action: "configure", config: { enabled: true }, preferences: { proposeMemories: false } });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no model call expected"); }));
    return { hub, dir };
  }
  const waitFor = async (check: () => boolean, ms = 8000): Promise<void> => {
    const until = Date.now() + ms;
    while (!check()) {
      if (Date.now() > until) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 15));
    }
  };

  it("runs on the runner set up on this computer, asks through the same approval as any command, and reports for review", async () => {
    const { hub, dir } = await makeHub();
    process.env.FAKE_ACP = "ask";
    await hub.request({ action: "agent-save", agent: { id: "builder", name: "Builder", role: "Implements", mission: "Build", systemPrompt: "Follow the conventions.", defaultMode: "assisted", runnerId: "fake" } as never });
    let snap = await hub.request({ action: "ticket-save", ticket: { title: "Add a login form", assigneeAgentId: "builder" } });
    const ticketId = snap.workTickets![0].id;
    // The runner is not set up here yet: the ticket does not start, and says why.
    await expect(hub.request({ action: "ticket-start", id: ticketId })).rejects.toThrow(/not set up on this computer/);
    expect(hub.store.data.workTickets![0].status).toBe("todo");

    snap = await hub.request({ action: "runner-save", runner: { id: "fake", name: "Fake agent", command: process.execPath, args: [FAKE], cwd: dir } });
    expect(snap.externalRunners!.map((r) => r.id)).toEqual(["fake"]);
    await hub.request({ action: "ticket-start", id: ticketId });
    // Assisted: the agent's command waits for the person.
    await waitFor(() => hub.store.data.tasks.some((t) => t.ticketId === ticketId && t.status === "waiting"));
    const run = hub.store.data.tasks.find((t) => t.ticketId === ticketId && t.status === "waiting")!;
    const pending = run.changes.find((c) => c.status === "pending")!;
    expect(pending).toMatchObject({ description: "Run npm test", command: "npm test" });
    await hub.request({ action: "approve", taskId: run.id, changeId: pending.id, approved: true });
    await waitFor(() => hub.store.data.workTickets![0].status === "review");
    const done = hub.store.data.workTickets![0];
    expect(done.result).toContain("Permission: yes.");
    expect(done.result).toContain("Follow the conventions.");
    expect(run.model).toBe("Fake agent");
  });

  it("stops a destructive command for approval even when the agent runs on its own", async () => {
    const { hub, dir } = await makeHub();
    process.env.FAKE_ACP = "ask";
    process.env.FAKE_ACP_COMMAND = "rm -rf /var/lib/app";
    await hub.request({ action: "runner-save", runner: { id: "fake", name: "Fake agent", command: process.execPath, args: [FAKE], cwd: dir } });
    await hub.request({ action: "agent-save", agent: { id: "builder", name: "Builder", role: "r", mission: "m", systemPrompt: "", defaultMode: "autonomous", runnerId: "fake" } as never });
    const snap = await hub.request({ action: "ticket-save", ticket: { title: "Clean up", assigneeAgentId: "builder" } });
    await hub.request({ action: "ticket-start", id: snap.workTickets![0].id });
    await waitFor(() => hub.store.data.tasks.some((t) => t.status === "waiting"));
    const run = hub.store.data.tasks.find((t) => t.status === "waiting")!;
    const pending = run.changes.find((c) => c.status === "pending")!;
    expect(pending.riskLevel).toBe("destructive");
    await hub.request({ action: "approve", taskId: run.id, changeId: pending.id, approved: false });
    await waitFor(() => hub.store.data.workTickets![0].status === "review");
    expect(hub.store.data.workTickets![0].result).toContain("Permission: no.");
  });
});
