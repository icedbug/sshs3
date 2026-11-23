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

describe("an external agent's request that names only its call", () => {
  it("is asked about with the command the agent announced, and hears how it ended", async () => {
    const settled: Array<[string, { failed: boolean; output: string }]> = [];
    process.env.FAKE_ACP = "ask-by-id";
    const questions: PermissionQuestion[] = [];
    const runtime = new AcpRuntime(runner(), {
      preface: "p",
      ask: async (q) => {
        questions.push(q);
        return true;
      },
      settled: (id, o) => settled.push([id, o]),
    });
    disposals.push(() => runtime.stop());
    await runtime.start(task("x"), undefined, () => undefined);
    expect(questions[0]).toMatchObject({ kind: "execute", command: "rm -rf /srv/data", toolCallId: "c2" });
    expect(settled).toEqual([["c2", { failed: true, output: "rm: permission denied" }]]);
  });

  it("does not hand the agent sshs3's SSH agent or its own settings", async () => {
    const { childEnv } = await import("../../src/main/ai/hub/AcpRuntime");
    const env = childEnv({ PATH: "/bin", SSH_AUTH_SOCK: "/tmp/agent", SSHS3_DATA_DIR: "/x", ANTHROPIC_API_KEY: "k" });
    expect(env).toEqual({ PATH: "/bin", ANTHROPIC_API_KEY: "k" });
  });
});

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

  it.each([
    ["max_tokens", "run.interrupted"],
    ["max_turn_requests", "run.interrupted"],
    ["unknown", "run.interrupted"],
    ["refusal", "run.failed"],
    ["cancelled", "run.cancelled"],
  ])("preserves partial output for %s and reports %s", async (reason, type) => {
    const { events, error } = await run(reason);
    expect(error).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type, output: expect.stringContaining("Add a login form") });
  });

  it("asks before a command and passes the answer on as this once, never as always", async () => {
    const yes = await run("ask", async () => true);
    expect(yes.questions).toMatchObject([{ title: "Run npm test", kind: "execute", command: "npm test" }]);
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

  it("runs on the runner set up on this computer, lets its command run as any command does, and reports for review", async () => {
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
    // Ask first: a command the agent asks to run is a plain command. It is allowed, and nobody is asked.
    await waitFor(() => hub.store.data.workTickets![0].status === "review");
    const run = hub.store.data.tasks.find((t) => t.ticketId === ticketId)!;
    expect(run.changes).toHaveLength(1);
    expect(run.changes[0]).toMatchObject({ description: "Run npm test", command: "npm test", decidedHow: "policy", status: "completed" });
    expect(run.changes[0].decidedBy).toBeUndefined();
    expect(run.changes[0]).not.toHaveProperty("riskLevel");
    const done = hub.store.data.workTickets![0];
    expect(done.result).toContain("Permission: yes.");
    expect(done.result).toContain("Follow the conventions.");
    expect(run.model).toBe("Fake agent");
  });

  it("blocks a ticket and asks for attention when its external agent runs out of tokens", async () => {
    const { hub, dir } = await makeHub();
    const notify = vi.spyOn(hub, "notify");
    process.env.FAKE_ACP = "max_tokens";
    await hub.request({ action: "runner-save", runner: runner({ cwd: dir }) });
    await hub.request({ action: "agent-save", agent: { id: "reviewer", name: "Reviewer", role: "Reviewer", systemPrompt: "", defaultMode: "advice", mission: "Review notes", runnerId: "fake" } });
    const snap = await hub.request({ action: "ticket-save", ticket: { title: "Review notes", assigneeAgentId: "reviewer" } });
    const id = snap.workTickets![0].id;
    await hub.request({ action: "ticket-start", id });
    await waitFor(() => notify.mock.calls.some(([title]) => title === "Task needs attention"));
    expect(hub.store.data.workTickets!.find(t => t.id === id)).toMatchObject({ status: "blocked", result: expect.stringContaining("max_tokens") });
    const run = hub.store.data.tasks.find(t => t.ticketId === id)!;
    expect(run).toMatchObject({ status: "interrupted", verification: "incomplete" });
    expect(run.messages.at(-1)?.text).toContain("Review notes");
    expect(notify.mock.calls.some(([title]) => title === "Task finished")).toBe(false);
  });

  it.each(["assisted", "autonomous", "plan"] as const)("lets a command the agent asks for run without asking, whatever it would do, in %s", async (mode) => {
    const { hub, dir } = await makeHub();
    process.env.FAKE_ACP = "ask";
    process.env.FAKE_ACP_COMMAND = "rm -rf /var/lib/app";
    await hub.request({ action: "runner-save", runner: { id: "fake", name: "Fake agent", command: process.execPath, args: [FAKE], cwd: dir } });
    await hub.request({ action: "agent-save", agent: { id: "builder", name: "Builder", role: "r", mission: "m", systemPrompt: "", defaultMode: mode, runnerId: "fake" } as never });
    const snap = await hub.request({ action: "ticket-save", ticket: { title: "Clean up", assigneeAgentId: "builder" } });
    await hub.request({ action: "ticket-start", id: snap.workTickets![0].id });
    await waitFor(() => hub.store.data.workTickets![0].status === "review");
    expect(hub.store.data.workTickets![0].result).toContain("Permission: yes.");
    const run = hub.store.data.tasks.find((t) => t.ticketId === snap.workTickets![0].id)!;
    // Nobody was asked, and nothing rated the command.
    expect(run.changes).toHaveLength(1);
    expect(run.changes[0]).toMatchObject({ command: "rm -rf /var/lib/app", decidedHow: "policy" });
    expect(run.changes[0].decidedBy).toBeUndefined();
    expect(run.changes[0]).not.toHaveProperty("riskLevel");
  });

  it("refuses a command the agent asks for in Advice", async () => {
    const { hub, dir } = await makeHub();
    process.env.FAKE_ACP = "ask";
    await hub.request({ action: "runner-save", runner: { id: "fake", name: "Fake agent", command: process.execPath, args: [FAKE], cwd: dir } });
    await hub.request({ action: "agent-save", agent: { id: "builder", name: "Builder", role: "r", mission: "m", systemPrompt: "", defaultMode: "advice", runnerId: "fake" } as never });
    const snap = await hub.request({ action: "ticket-save", ticket: { title: "Look", assigneeAgentId: "builder" } });
    await hub.request({ action: "ticket-start", id: snap.workTickets![0].id });
    await waitFor(() => hub.store.data.workTickets![0].status === "review");
    expect(hub.store.data.workTickets![0].result).toContain("Permission: no.");
    const run = hub.store.data.tasks.find((t) => t.ticketId === snap.workTickets![0].id)!;
    expect(run.changes[0]).toMatchObject({ status: "denied", decidedHow: "policy" });
  });

  it.each(["assisted", "autonomous"] as const)("puts an edit the agent gave no command for to a person, as a file write, in %s", async (mode) => {
    const { hub, dir } = await makeHub();
    process.env.FAKE_ACP = "ask-edit";
    await hub.request({ action: "runner-save", runner: { id: "fake", name: "Fake agent", command: process.execPath, args: [FAKE], cwd: dir } });
    await hub.request({ action: "agent-save", agent: { id: "builder", name: "Builder", role: "r", mission: "m", systemPrompt: "", defaultMode: mode, runnerId: "fake" } as never });
    const snap = await hub.request({ action: "ticket-save", ticket: { title: "Add a login form", assigneeAgentId: "builder" } });
    await hub.request({ action: "ticket-start", id: snap.workTickets![0].id });
    await waitFor(() => hub.store.data.tasks.some((t) => t.status === "waiting"));
    const run = hub.store.data.tasks.find((t) => t.status === "waiting")!;
    const pending = run.changes.find((c) => c.status === "pending")!;
    // Not a plain command: it carries what the agent said it would do, and it waits.
    expect(pending).toMatchObject({ description: "Edit src/login.tsx", toolCall: true });
    expect(pending.command).toContain("src/login.tsx");
    await hub.request({ action: "approve", taskId: run.id, changeId: pending.id, approved: false });
    await waitFor(() => hub.store.data.workTickets![0].status === "review");
    expect(hub.store.data.workTickets![0].result).toContain("Permission: no.");
  });
});
