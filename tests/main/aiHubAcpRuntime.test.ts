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

/** The variables the stand-in agent is steered with: a program is given only what its runner names beyond the basics. */
const FAKE_ENV = ["FAKE_ACP", "FAKE_ACP_COMMAND"];
const runner = (extra: Partial<ExternalRunner> = {}): ExternalRunner => ({
  id: "fake",
  name: "Fake agent",
  command: process.execPath,
  args: [FAKE],
  cwd: os.tmpdir(),
  env: FAKE_ENV,
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

  it("hands the agent the basics of the environment and what its runner names, and nothing else", async () => {
    const { childEnv, runnerEnvNames } = await import("../../src/main/ai/hub/AcpRuntime");
    const here = {
      PATH: "/bin", HOME: "/home/maria", LANG: "sv_SE.UTF-8", LC_ALL: "C", TERM: "xterm-256color", TMPDIR: "/tmp",
      HTTPS_PROXY: "http://proxy:3128", no_proxy: "localhost", NODE_EXTRA_CA_CERTS: "/etc/ca.pem",
      SSH_AUTH_SOCK: "/tmp/agent", SSHS3_DATA_DIR: "/x",
      ANTHROPIC_API_KEY: "k", AWS_SECRET_ACCESS_KEY: "aws", GITHUB_TOKEN: "gh", DATABASE_URL: "postgres://u:p@db/x",
    };
    // Cloud keys and tokens that happen to be set where the app was started stay with the app.
    expect(childEnv(here)).toEqual({
      PATH: "/bin", HOME: "/home/maria", LANG: "sv_SE.UTF-8", LC_ALL: "C", TERM: "xterm-256color", TMPDIR: "/tmp",
      HTTPS_PROXY: "http://proxy:3128", no_proxy: "localhost", NODE_EXTRA_CA_CERTS: "/etc/ca.pem",
    });
    // What the runner's settings name is passed too. The SSH agent and sshs3's own are not, whoever names them.
    const named = childEnv(here, ["ANTHROPIC_API_KEY", "SSH_AUTH_SOCK", "SSHS3_DATA_DIR", "NOT_SET"]);
    expect(named.ANTHROPIC_API_KEY).toBe("k");
    expect(named).not.toHaveProperty("SSH_AUTH_SOCK");
    expect(named).not.toHaveProperty("SSHS3_DATA_DIR");
    expect(named).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(runnerEnvNames(["ANTHROPIC_API_KEY", " OPENAI_API_KEY ", "SSH_AUTH_SOCK", "SSHS3_TOKEN", "bad name", "A=B", 7, "ANTHROPIC_API_KEY"])).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
  });

  it("ends the whole tree under a runner on Windows, where the program runs under cmd.exe", async () => {
    const { killRunner } = await import("../../src/main/ai/hub/AcpRuntime");
    const started: Array<{ file: string; args: string[] }> = [];
    const run = ((file: string, args: string[]) => {
      started.push({ file, args });
      return { on: () => undefined };
    }) as never;
    const signals: Array<string | undefined> = [];
    const child = { pid: 4242, kill: (signal?: NodeJS.Signals) => (signals.push(signal), true) };
    killRunner(child, "SIGKILL", "win32", run);
    expect(started).toEqual([{ file: "taskkill", args: ["/pid", "4242", "/T", "/F"] }]);
    expect(signals).toEqual([]);
    // Elsewhere the program is the child itself.
    killRunner(child, "SIGKILL", "linux", run);
    expect(started).toHaveLength(1);
    expect(signals).toEqual(["SIGKILL"]);
    // And when taskkill cannot be started, what can be ended is.
    killRunner(child, undefined, "win32", (() => { throw new Error("ENOENT"); }) as never);
    expect(signals).toEqual(["SIGKILL", undefined]);
  });

  it("saves what the agent says it used", async () => {
    const { events } = await run("usage");
    expect(events.at(-1)).toMatchObject({ type: "run.completed", usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 50 } });
    // An agent that says nothing about it reports no usage: nothing is made up.
    const silent = await run("plain");
    expect(silent.events.at(-1)).not.toHaveProperty("usage");
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

    snap = await hub.request({ action: "runner-save", runner: { id: "fake", name: "Fake agent", command: process.execPath, args: [FAKE], cwd: dir, env: FAKE_ENV } });
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
    await hub.request({ action: "agent-save", agent: { id: "reviewer", name: "Reviewer", role: "Reviewer", systemPrompt: "", defaultMode: "assisted", mission: "Review notes", runnerId: "fake" } });
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
    await hub.request({ action: "runner-save", runner: { id: "fake", name: "Fake agent", command: process.execPath, args: [FAKE], cwd: dir, env: FAKE_ENV } });
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

  it("does not start the agent's program in Advice, and says why", async () => {
    const { hub, dir } = await makeHub();
    process.env.FAKE_ACP = "ask";
    // The program leaves a file behind as soon as it starts: the proof that it did not.
    const started = path.join(dir, "started");
    const script = path.join(dir, "leaves-a-mark.cjs");
    await fs.writeFile(script, `require("node:fs").writeFileSync(${JSON.stringify(started)}, "x"); require(${JSON.stringify(FAKE)});`, "utf8");
    await hub.request({ action: "runner-save", runner: { id: "fake", name: "Fake agent", command: process.execPath, args: [script], cwd: dir, env: FAKE_ENV } });
    await hub.request({ action: "agent-save", agent: { id: "builder", name: "Builder", role: "r", mission: "m", systemPrompt: "", defaultMode: "advice", runnerId: "fake" } as never });
    const snap = await hub.request({ action: "ticket-save", ticket: { title: "Look", assigneeAgentId: "builder" } });
    await expect(hub.request({ action: "ticket-start", id: snap.workTickets![0].id })).rejects.toThrow(
      "Builder runs on an external agent: a program on this computer that runs commands and edits files by itself. In Advice mode nothing may be run or changed, so it was not started. Choose another mode, or an agent that runs on the configured model.",
    );
    await expect(fs.access(started)).rejects.toThrow();
    // In a mode that may act the same program is started.
    await hub.request({ action: "agent-save", agent: { id: "builder", name: "Builder", role: "r", mission: "m", systemPrompt: "", defaultMode: "assisted", runnerId: "fake" } as never });
    await hub.request({ action: "ticket-start", id: snap.workTickets![0].id });
    await waitFor(() => hub.store.data.workTickets![0].status === "review");
    await expect(fs.access(started)).resolves.toBeUndefined();
  });

  it("counts what the agent says it used, and keeps the variables a runner was given when it is saved again without them", async () => {
    const { hub, dir } = await makeHub();
    process.env.FAKE_ACP = "usage";
    await hub.request({ action: "runner-save", runner: { id: "fake", name: "Fake agent", command: process.execPath, args: [FAKE], cwd: dir, env: [...FAKE_ENV, "SSH_AUTH_SOCK", "not a name"] } });
    // The form in the app saves a runner without naming variables: the ones it had stay.
    const snap0 = await hub.request({ action: "runner-save", runner: { id: "fake", name: "Fake agent (renamed)", command: process.execPath, args: [FAKE], cwd: dir } });
    expect(snap0.externalRunners![0]).toMatchObject({ name: "Fake agent (renamed)", env: FAKE_ENV });
    await hub.request({ action: "agent-save", agent: { id: "builder", name: "Builder", role: "r", mission: "m", systemPrompt: "", defaultMode: "assisted", runnerId: "fake" } as never });
    const snap = await hub.request({ action: "ticket-save", ticket: { title: "Count it", assigneeAgentId: "builder" } });
    await hub.request({ action: "ticket-start", id: snap.workTickets![0].id });
    await waitFor(() => hub.store.data.workTickets![0].status === "review");
    const run = hub.store.data.tasks.find((t) => t.ticketId === snap.workTickets![0].id)!;
    expect(run.usage).toMatchObject({ inputTokens: 1200, outputTokens: 300, cacheReadTokens: 50 });
    expect(hub.store.data.agentUsage?.builder?.tokens).toBe(1550);
  });

  it.each(["assisted", "autonomous"] as const)("puts an edit the agent gave no command for to a person, as a file write, in %s", async (mode) => {
    const { hub, dir } = await makeHub();
    process.env.FAKE_ACP = "ask-edit";
    await hub.request({ action: "runner-save", runner: { id: "fake", name: "Fake agent", command: process.execPath, args: [FAKE], cwd: dir, env: FAKE_ENV } });
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
