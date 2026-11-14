import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentTask, KbPage, WorkforceStep } from "../../src/shared/types/aiHub";
import { boundedPrompt, HUB_PROMPT_MAX, PERSON_PROMPT_MAX } from "../../src/main/ai/hub/privacy";
import { buildContradictionPrompt } from "../../src/main/ai/hub/KbLint";
import { parsePageOps } from "../../src/main/ai/hub/KbCompile";
import { synthesisPrompt } from "../../src/main/ai/hub/WorkforceRunner";
import { MAX_PLAN_FIELD, parsePlan } from "../../src/main/ai/hub/PlanMode";

/**
 * Agent runs as the evaluation on the Nordvik lab found them broken: prompts
 * that lost their instructions, runs that never let go, runs nobody sat at
 * that had no terminal, and spending that was counted once per conversation.
 */

vi.mock("electron", () => ({
  app: { getPath: () => os.tmpdir(), quit: () => {} },
  Notification: { isSupported: () => false },
  powerMonitor: { on: vi.fn(), removeListener: vi.fn() },
}));

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const d of disposals.splice(0)) await d();
  vi.unstubAllGlobals();
});

function sse(events: Array<Record<string, unknown>>): Response {
  const text = events.map((e) => `data: ${JSON.stringify(e)}`).join("\n\n") + "\n\n";
  return new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(text));
        c.close();
      },
    }),
    { status: 200 },
  );
}
const say = (text: string): Response =>
  sse([
    { type: "message_start", message: { usage: { input_tokens: 700 } } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "message_delta", usage: { output_tokens: 300 } },
  ]);
const callTool = (name: string, input: Record<string, unknown>): Response =>
  sse([
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name, input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
  ]);

const SERVERS = [{ id: "srv-db01", name: "db-01", host: "db01.internal", port: 22, username: "ops" }];

async function makeHub(host: Record<string, unknown> = {}) {
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(false);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-runs-"));
  const hub = new HubService(
    {
      changed: () => {},
      inventoryTargets: async () => [],
      backgroundChanged: async () => {},
      openSchedule: async () => "s1",
      show: () => {},
      aiConfigFilePath: path.join(dir, "ai.json"),
      workspaceServers: async () => SERVERS,
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
  await hub.request({
    action: "configure",
    config: { enabled: true, provider: "anthropic", model: "claude-opus-5-5", apiKey: "sk-ant-test" }, // pragma: allowlist secret
    preferences: { proposeMemories: false },
  });
  return hub;
}
type Hub = Awaited<ReturnType<typeof makeHub>>;
const inner = (hub: Hub) =>
  hub as unknown as {
    start(input: Record<string, unknown>, schedule?: unknown, tag?: Record<string, unknown>): Promise<AgentTask>;
    stop(task: AgentTask, reason: string): Promise<void>;
    whenSettled(task: AgentTask): Promise<void>;
    runStopGraceMs: number;
    runtimes: Map<string, unknown>;
    openInvestigatorTerminal(parent: AgentTask): Promise<string | undefined>;
    openUnattendedTerminal(target: { profileId: string; shell: string }, label: string): Promise<string>;
  };

/** A terminal that answers the handshake and every command, as a shell at its prompt would. */
function shell(hub: Hub, id: string, label: string, profileId?: string): string[] {
  const ran: string[] = [];
  hub.terminals.register({ id, label, kind: "ssh", profileId }, (data: string) => {
    const n = /SSHS3;([a-f0-9]{32});BEGIN/.exec(data)?.[1];
    if (!n) return;
    ran.push(/\(eval '([^']*)'\)/.exec(data)?.[1] ?? "");
    queueMicrotask(() => hub.terminals.feed(id, `\x1b]777;SSHS3;${n};BEGIN\x07ok\n\x1b]777;SSHS3;${n};END;0;/root\x07ops@${label}:~$ `));
  });
  hub.terminals.feed(id, `ops@${label}:~$ `);
  return ran;
}

const userText = (body: string): string => {
  const first = (JSON.parse(body) as { messages: Array<{ role: string; content: unknown }> }).messages.find((m) => m.role === "user")!;
  return typeof first.content === "string" ? first.content : JSON.stringify(first.content);
};

describe("a prompt that is too long", () => {
  it("loses its middle and says so, never its start or its end", () => {
    const text = `INSTRUCTIONS: answer with JSON only.\n${"data line\n".repeat(4000)}FORMAT: {"ok":true}`;
    const cut = boundedPrompt(text, 16_000);
    expect(cut.length).toBeLessThanOrEqual(16_000);
    expect(cut.startsWith("INSTRUCTIONS: answer with JSON only.")).toBe(true);
    expect(cut.endsWith('FORMAT: {"ok":true}')).toBe(true);
    expect(cut).toMatch(/\[… \d+ characters left out here: the text was too long …\]/);
    // Short enough is left as it is (and still masked).
    expect(boundedPrompt("password=hunter2 and the rest", 100)).toBe("password=[redacted] and the rest");
  });

  it("is sent to the model with what the person asked first, where it used to keep only the end", async () => {
    const hub = await makeHub();
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init?: RequestInit) => (bodies.push(String(init?.body)), say("Done."))));
    const prompt = `Summarise this log and say which unit failed first.\n${"Nov 14 09:00:01 web-01 nginx[812]: worker exited\n".repeat(600)}Answer in three lines.`;
    expect(prompt.length).toBeGreaterThan(PERSON_PROMPT_MAX);
    await hub.request({ action: "start", task: { prompt, mode: "advice" } });
    const task = hub.store.data.tasks[0];
    await vi.waitFor(() => expect(task.status).toBe("completed"));
    expect(task.messages[0].text.startsWith("Summarise this log and say which unit failed first.")).toBe(true);
    expect(task.messages[0].text.endsWith("Answer in three lines.")).toBe(true);
    expect(task.messages[0].text.length).toBeLessThanOrEqual(PERSON_PROMPT_MAX);
    const sent = userText(bodies[0]);
    expect(sent).toContain("Summarise this log and say which unit failed first.");
    expect(sent).not.toContain("[earlier output omitted]");
  });

  it("is passed whole when it is one of the hub's own, whose builders bound the data they quote", async () => {
    const hub = await makeHub();
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init?: RequestInit) => (bodies.push(String(init?.body)), say('{"contradictions":[]}'))));
    const page = (id: string, body: string): KbPage =>
      ({ id, title: `Page ${id}`, when: "x", body, kind: "system", targets: ["db-01"], sources: [], history: [], revision: 1, createdAt: 1, updatedAt: 1 }) as unknown as KbPage;
    const pairs = Array.from({ length: 12 }, (_, i) => [page(`a${i}`, `Keep ${i} days. `.repeat(300)), page(`b${i}`, `Keep ${i + 7} days. `.repeat(300))] as [KbPage, KbPage]);
    const prompt = buildContradictionPrompt(pairs);
    // This is the prompt that failed every time: far over what a person's message may be.
    expect(prompt.length).toBeGreaterThan(PERSON_PROMPT_MAX * 3);
    expect(prompt.length).toBeLessThan(HUB_PROMPT_MAX);
    expect(prompt.startsWith("Below are pairs of pages")).toBe(true);
    expect(prompt.trimEnd().endsWith('{"contradictions":[]} when there is none.')).toBe(true);

    const task = await inner(hub).start({ prompt, mode: "advice", agentName: "Knowledge base" }, undefined, { distillSourceId: "kbx:test", title: "Checking pages", mainModel: true });
    await inner(hub).whenSettled(task);
    expect(task.messages[0].text).toBe(prompt);
    const sent = userText(bodies[0]);
    expect(sent.startsWith("Below are pairs of pages")).toBe(true);
    expect(sent).toContain('Answer with JSON only: {"contradictions"');
    expect(sent).toContain("## Pair 12");
    expect(sent).not.toContain("left out here");
  });

  it("leaves the workforce lead its instructions, before the reports and again after them", () => {
    const steps = Array.from({ length: 3 }, (_, i) => ({ agentName: `Agent ${i}`, role: "r", status: "completed", findings: `finding ${i} `.repeat(1200) })) as unknown as WorkforceStep[];
    const prompt = synthesisPrompt("Is Nordvik prod healthy?", steps);
    expect(prompt.length).toBeGreaterThan(PERSON_PROMPT_MAX);
    expect(boundedPrompt(prompt, HUB_PROMPT_MAX)).toBe(prompt);
    expect(prompt.startsWith("You are the lead of a coordinated review.")).toBe(true);
    expect(prompt.trimEnd().split("\n").at(-1)).toMatch(/Now write the combined result described at the top; do not ask what to do with the reports\./);
  });
});

describe("an answer that cannot be used", () => {
  it("is counted when its pages are not in the format asked for, so the run is a failure and not 'nothing to write'", () => {
    const known = { clusters: [], servers: ["db-01"] };
    // What the model wrote when it had lost the instructions: a good page under names of its own.
    const guessed = JSON.stringify({ pages: [{ type: "system", about: "db-01", text: "PostgreSQL logging standard: 500 ms, daily rotation, keep 7.".repeat(4) }] });
    const unusable = { count: 0 };
    expect(parsePageOps(guessed, [], known, { unusable })).toEqual([]);
    expect(unusable.count).toBe(1);
    // An answer that has nothing to change is still just that.
    const none = { count: 0 };
    expect(parsePageOps('{"pages":[]}', [], known, { unusable: none })).toEqual([]);
    expect(none.count).toBe(0);
  });

  it("fails the compile of a source instead of marking it compiled with no pages", async () => {
    const hub = await makeHub();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => say(JSON.stringify({ pages: [{ type: "system", text: "PostgreSQL logging standard: 500 ms, daily rotation, keep 7.".repeat(4) }] }))),
    );
    const runPageOps = (
      hub as unknown as {
        runPageOps(prompt: string, shown: KbPage[], source: unknown, run: unknown, known: unknown, options: unknown): Promise<number>;
      }
    ).runPageOps.bind(hub);
    await expect(
      runPageOps("Write pages.", [], { docId: "d1", title: "Logging standard" }, { id: "kbc:d1:0", title: "Pages · Logging standard" }, { clusters: [], servers: [] }, { sourceText: "x" }),
    ).rejects.toThrow(/answered with 1 page in a format that could not be read, so nothing was saved/);
  });
});

describe("a plan a person is asked to approve", () => {
  const step = (over: Record<string, unknown>) => ({ action: "Fix shop.conf", risk: "medium", check: "sudo nginx -t", rollback: "cp a.bak a", ...over });

  it("keeps the start of a long text, where it used to show '[earlier output omitted]' and the end", () => {
    const action = `Restore the semicolon on line 23 of shop.conf ${"and keep everything else as it is ".repeat(30)}`;
    const plan = parsePlan({ goal: "The shop answers again", steps: [step({ action })] });
    if ("error" in plan) throw new Error(plan.error);
    expect(plan.steps[0].action.startsWith("Restore the semicolon on line 23 of shop.conf")).toBe(true);
    expect(plan.steps[0].action).not.toContain("[earlier output omitted]");
  });

  it("shows a check, a rollback and a command whole, or is refused: never half of one", () => {
    // The check of the real incident plan was longer than the old 500 characters: it is shown whole now.
    const check = `sudo nginx -t 2>&1; ${"curl -sk --resolve shop.nordvik.lan:443:127.0.0.1 https://shop.nordvik.lan/healthz; ".repeat(8)}expected: 200`;
    expect(check.length).toBeGreaterThan(500);
    const plan = parsePlan({ goal: "g", steps: [step({ check })] });
    if ("error" in plan) throw new Error(plan.error);
    expect(plan.steps[0].check).toBe(check);
    for (const field of ["check", "rollback", "command"]) {
      const refused = parsePlan({ goal: "g", steps: [step({ [field]: `echo ${"x".repeat(MAX_PLAN_FIELD)}` })] });
      expect(refused).toMatchObject({ error: expect.stringMatching(new RegExp(`Step 1: the ${field} is \\d+ characters, and at most ${MAX_PLAN_FIELD} can be shown in full`)) });
    }
  });
});

describe("a run that is stopped while it hangs inside a tool call", () => {
  it("is let go of after a grace period: whoever waits is released and the conversation can go on", async () => {
    const hub = await makeHub();
    let turn = 0;
    vi.stubGlobal("fetch", vi.fn(async () => (turn++ === 0 ? callTool("workspace_context", {}) : say("Went on."))));
    // The tool call that never returns: an SFTP connection that hangs, in the evaluation.
    const invoke = vi.spyOn(hub.broker, "invoke").mockImplementation(() => new Promise(() => {}));
    await hub.request({ action: "start", task: { prompt: "Look at db-01", mode: "advice" } });
    const task = hub.store.data.tasks[0];
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());

    inner(hub).runStopGraceMs = 60;
    let released = false;
    void inner(hub).whenSettled(task).then(() => (released = true));
    const before = task.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    await inner(hub).stop(task, "Run time budget exhausted");
    expect(task.status).toBe("interrupted");
    expect(task.updatedAt).toBeGreaterThan(before);
    // Still held: the runtime has not come back from its tool call.
    expect(inner(hub).runtimes.has(task.id)).toBe(true);
    await expect(hub.request({ action: "resume", taskId: task.id })).rejects.toThrow("Task already running");
    task.messages.pop();

    await vi.waitFor(() => expect(released).toBe(true));
    expect(inner(hub).runtimes.has(task.id)).toBe(false);
    invoke.mockRestore();
    await hub.request({ action: "resume", taskId: task.id });
    await vi.waitFor(() => expect(task.status).toBe("completed"));
    expect(task.messages.at(-1)?.text).toBe("Went on.");
  });
});

describe("what an agent's runs spend", () => {
  it("is counted for every run of a conversation, not only the first", async () => {
    const hub = await makeHub();
    const snap = await hub.request({ action: "workforce-template-apply", templateId: "operate-system" });
    const agent = snap.agents!.find((a) => a.name === "Operations lead")!;
    vi.stubGlobal("fetch", vi.fn(async () => say("Looked.")));
    const spent = () => hub.store.data.agentUsage?.[agent.id]?.tokens ?? 0;

    await hub.request({ action: "start", task: { prompt: "Plan the week", mode: "advice", agentId: agent.id } });
    const task = hub.store.data.tasks[0];
    await vi.waitFor(() => expect(task.status).toBe("completed"));
    await inner(hub).whenSettled(task);
    const first = spent();
    expect(first).toBe(1000);

    // A reply is a second run of the same conversation: its tokens used to be free.
    await hub.request({ action: "reply", taskId: task.id, text: "And next week?" });
    await vi.waitFor(() => expect(task.status).toBe("completed"));
    await inner(hub).whenSettled(task);
    expect(task.usage).toMatchObject({ inputTokens: 1400, outputTokens: 600 });
    expect(spent()).toBe(2000);

    // "Continue" is a third.
    await hub.request({ action: "resume", taskId: task.id });
    await vi.waitFor(() => expect(task.status).toBe("completed"));
    await inner(hub).whenSettled(task);
    expect(spent()).toBe(3000);
    // Counted once each: looking again adds nothing.
    (hub as unknown as { countAgentUsage(t: AgentTask): void }).countAgentUsage(task);
    expect(spent()).toBe(3000);
  });

  it("does not count again what a conversation from before this change had already put down", async () => {
    const hub = await makeHub();
    const snap = await hub.request({ action: "workforce-template-apply", templateId: "operate-system" });
    const agent = snap.agents!.find((a) => a.name === "Operations lead")!;
    vi.stubGlobal("fetch", vi.fn(async () => say("Looked.")));
    await hub.request({ action: "start", task: { prompt: "Plan the week", mode: "advice", agentId: agent.id } });
    const task = hub.store.data.tasks[0];
    await vi.waitFor(() => expect(task.status).toBe("completed"));
    await inner(hub).whenSettled(task);
    // As an older version stored it: counted, without saying how much.
    delete task.usageCountedTokens;
    task.usageCounted = true;
    await hub.request({ action: "reply", taskId: task.id, text: "More." });
    await vi.waitFor(() => expect(task.status).toBe("completed"));
    await inner(hub).whenSettled(task);
    expect(hub.store.data.agentUsage![agent.id].tokens).toBe(2000);
  });
});

describe("a conversation that cannot be started", () => {
  it("gives the error and leaves no failed, empty conversation behind", async () => {
    const hub = await makeHub();
    shell(hub, "t1", "web-01");
    await hub.terminals.arm("t1", "bash");
    hub.terminals.claim("t1", hub.terminals.get("t1")!.generation, "somebody-else");
    vi.stubGlobal("fetch", vi.fn(async () => say("never asked")));
    await expect(hub.request({ action: "start", task: { prompt: "Restart nginx", mode: "assisted", sessionId: "t1" } })).rejects.toThrow(
      "Another task owns this terminal",
    );
    expect(hub.store.data.tasks).toHaveLength(0);
    // The terminal is still the other run's.
    expect(hub.terminals.get("t1")!.owner).toBe("somebody-else");
  });
});

describe("a run nobody sits at", () => {
  function unattended() {
    const opened: string[] = [];
    const closed: string[] = [];
    const ref: { hub?: Hub; fail?: string } = {};
    const host = {
      openServerTerminal: async (profileId: string) => {
        if (ref.fail) throw new Error(ref.fail);
        const id = `own-${opened.length + 1}`;
        opened.push(profileId);
        shell(ref.hub!, id, "db-01", profileId);
        await ref.hub!.terminals.armAtPrompt(id, "bash", 2000);
        return id;
      },
      closeSession: (id: string) => {
        closed.push(id);
        ref.hub!.terminals.invalidate(id, "closed", true);
      },
    };
    return { opened, closed, ref, host };
  }

  async function ticketFor(hub: Hub, target: string) {
    let snap = await hub.request({ action: "workforce-template-apply", templateId: "operate-system" });
    const watch = snap.agents!.find((a) => a.name === "Watch")!;
    snap = await hub.request({ action: "ticket-save", ticket: { title: "db-01 /var 99% full", assigneeAgentId: watch.id, target, status: "todo" } });
    return { watch, ticket: snap.workTickets!.find((t) => t.title === "db-01 /var 99% full")! };
  }

  it("gets a terminal of its own on the server its ticket names, closed when the run ends and opened again when it goes on", async () => {
    const { opened, closed, ref, host } = unattended();
    const hub = (ref.hub = await makeHub(host));
    const { ticket } = await ticketFor(hub, "db-01");
    const tools: string[][] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: unknown, init?: RequestInit) => {
        tools.push(((JSON.parse(String(init?.body)) as { tools?: Array<{ name: string }> }).tools ?? []).map((t) => t.name));
        return say("Looked at /var.");
      }),
    );
    // Started the way the heartbeat starts it: without a terminal.
    await hub.request({ action: "ticket-start", id: ticket.id });
    const task = hub.store.data.tasks.find((t) => t.ticketId === ticket.id)!;
    expect(opened).toEqual(["srv-db01"]);
    expect(task.target).toMatchObject({ sessionId: "own-1", label: "db-01" });
    expect(task.ownTerminal).toMatchObject({ via: "server", profileId: "srv-db01" });
    await vi.waitFor(() => expect(task.status).toBe("completed"));
    await inner(hub).whenSettled(task);
    // It could run commands there, where it used to have no terminal tool at all.
    expect(tools[0]).toEqual(expect.arrayContaining(["terminal_command", "sshs3_change"]));
    // Nobody's tab: closed with the run.
    expect(closed).toEqual(["own-1"]);

    // The conversation goes on (a reply, an approved plan): the terminal is there again.
    await hub.request({ action: "reply", taskId: task.id, text: "Go on with the plan." });
    expect(opened).toEqual(["srv-db01", "srv-db01"]);
    expect(task.target).toMatchObject({ sessionId: "own-2" });
    await vi.waitFor(() => expect(task.status).toBe("completed"));
    await inner(hub).whenSettled(task);
    expect(closed).toEqual(["own-1", "own-2"]);
  });

  it("is told when no terminal could be opened, instead of silently working without one", async () => {
    const { ref, host } = unattended();
    ref.fail = "No terminal could be opened on db-01, so nothing was run there: No shell prompt within 30 seconds. The terminal showed nothing.";
    const hub = (ref.hub = await makeHub(host));
    const { ticket } = await ticketFor(hub, "db-01");
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init?: RequestInit) => (bodies.push(String(init?.body)), say("Could not look."))));
    await hub.request({ action: "ticket-start", id: ticket.id });
    const task = hub.store.data.tasks.find((t) => t.ticketId === ticket.id)!;
    await vi.waitFor(() => expect(task.status).toBe("completed"));
    expect(task.target).toBeUndefined();
    expect(userText(bodies[0])).toContain("No terminal could be opened on db-01 for this run");
  });

  it("opens no terminal for a ticket that names no server of the workspace, or when a person gave one", async () => {
    const { opened, ref, host } = unattended();
    const hub = (ref.hub = await makeHub(host));
    vi.stubGlobal("fetch", vi.fn(async () => say("Done.")));
    const { ticket } = await ticketFor(hub, "the billing system");
    await hub.request({ action: "ticket-start", id: ticket.id });
    await vi.waitFor(() => expect(hub.store.data.tasks.find((t) => t.ticketId === ticket.id)!.status).toBe("completed"));
    expect(opened).toEqual([]);
  });

  it("connects to the terminal it opened only at its prompt, under a label that says what it is, and closes it when it never gets there", async () => {
    const labels: string[] = [];
    const closed: string[] = [];
    const ref: { hub?: Hub; prompt: boolean } = { prompt: true };
    const hub = (ref.hub = await makeHub({
      openSchedule: async (_target: unknown, label: string) => {
        const id = `sched-${labels.length + 1}`;
        labels.push(label);
        if (ref.prompt) shell(ref.hub!, id, "web-01", "srv-web01");
        else ref.hub!.terminals.register({ id, label, kind: "ssh" }, () => undefined);
        return id;
      },
      closeSession: (id: string) => closed.push(id),
    }));
    shell(hub, "person", "web-01", "srv-web01");
    await hub.terminals.arm("person", "bash");
    const parent = { id: "p", title: "Incident", target: { sessionId: "person", generation: hub.terminals.get("person")!.generation, label: "web-01" } } as AgentTask;
    const id = await inner(hub).openInvestigatorTerminal(parent);
    expect(id).toBe("sched-1");
    // Not "Schedule: undefined".
    expect(labels).toEqual(["Investigator: web-01"]);
    expect(hub.terminals.get("sched-1")).toMatchObject({ state: "ready", shell: "bash" });

    // One that never shows a prompt is closed again, and the caller is told what it showed.
    ref.prompt = false;
    vi.spyOn(hub.terminals, "armAtPrompt").mockImplementationOnce((sid, sh) => TerminalRegistryProto.armAtPrompt.call(hub.terminals, sid, sh, 120));
    await expect(inner(hub).openUnattendedTerminal({ profileId: "srv-web01", shell: "bash" }, "Schedule: nightly")).rejects.toThrow(
      /No shell prompt within 0 seconds\. The terminal showed nothing\./,
    );
    expect(closed).toEqual(["sched-2"]);
  });
});

describe("recordings of a run's terminal", () => {
  it("keeps no recording, and seals none in the audit log, for a run that held the terminal and ran nothing", async () => {
    const hub = await makeHub();
    shell(hub, "t1", "web-01");
    await hub.terminals.arm("t1", "bash");
    const task = { id: "run-1", title: "t", mode: "assisted", status: "running", messages: [], changes: [], sources: [], createdAt: 1, updatedAt: 1, maxCommands: 5, maxMinutes: 5, verification: "not-verified" } as unknown as AgentTask;
    hub.store.data.tasks.push(task);
    const recordings = (hub as unknown as { recordings(): { list(): Promise<unknown[]> } }).recordings();
    const sealed = async () => (await hub.request({ action: "audit-read" } as never)).reply?.audit?.entries.filter((e: { kind: string }) => e.kind === "recording") ?? [];

    // First: a run in which a command ran. Its recording is kept and sealed.
    hub.terminals.claim("t1", hub.terminals.get("t1")!.generation, task.id);
    await vi.waitFor(() => expect(task.recordingId).toBeTruthy());
    const real = task.recordingId!;
    await hub.terminals.execute("t1", hub.terminals.get("t1")!.generation, task.id, "uptime");
    hub.terminals.release(task.id);
    await vi.waitFor(async () => expect(await sealed()).toHaveLength(1));

    // Then a resume that is stopped before it runs anything.
    await new Promise((r) => setTimeout(r, 5));
    hub.terminals.claim("t1", hub.terminals.get("t1")!.generation, task.id);
    await vi.waitFor(() => expect(task.recordingId).not.toBe(real));
    hub.terminals.release(task.id);
    // The conversation points at the recording in which something happened again.
    await vi.waitFor(() => expect(task.recordingId).toBe(real));
    expect(await recordings.list()).toHaveLength(1);
    expect(await sealed()).toHaveLength(1);
  });

  it("says that a recording never existed, apart from one that is gone", async () => {
    const hub = await makeHub();
    await expect(hub.request({ action: "recording-read", id: "never-was" } as never)).rejects.toThrow("There is no recording with that id.");
    await expect(hub.request({ action: "recording-read", id: "../../etc/passwd" } as never)).rejects.toThrow("There is no recording with that id.");
    hub.store.data.tasks.push({ id: "old", title: "t", recordingId: "old-rec", messages: [], changes: [], sources: [], status: "completed" } as unknown as AgentTask);
    await expect(hub.request({ action: "recording-read", id: "old-rec" } as never)).rejects.toThrow("That recording is not on this computer any more.");
  });
});

import { TerminalRegistry } from "../../src/main/ai/hub/TerminalRegistry";
const TerminalRegistryProto = TerminalRegistry.prototype;
