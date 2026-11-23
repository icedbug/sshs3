import { afterEach, describe, expect, it, vi } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HubService } from "../../src/main/ai/hub/HubService";
import type { RunEvent } from "../../src/main/ai/hub/AgentRuntime";
import type { AgentTask } from "../../src/shared/types/aiHub";
import { fakeOpenAi, type FakeModelRequest, type FakeModelStep } from "../helpers/fakeOpenAi";

/**
 * What the hub makes of the events a run sends while it works (`RunsPart.event`): the text of the
 * answer as it is kept in the conversation.
 */

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
});

async function hubWithRun(): Promise<{ hub: HubService; task: AgentTask; send: (event: RunEvent) => void; pieces: Array<Record<string, unknown>> }> {
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(false);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "run-events-"));
  const pieces: Array<Record<string, unknown>> = [];
  const hub: HubService = new HubService(
    {
      changed: () => {},
      inventoryTargets: async () => [],
      backgroundChanged: async () => {},
      openSchedule: async () => "s1",
      show: () => {},
      aiConfigFilePath: path.join(dir, "ai.json"),
      workspaceServers: async () => [],
      delta: (piece: Record<string, unknown>) => pieces.push(piece),
    } as never,
    dir,
  );
  disposals.push(async () => {
    await hub.dispose();
    setDemoModeForTesting(undefined);
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await hub.initialize();
  const task = {
    id: "run-1",
    title: "t",
    mode: "advice",
    status: "running",
    messages: [{ id: "m1", role: "user", text: "Why is nginx slow?", at: 1 }],
    changes: [],
    sources: [],
    createdAt: 1,
    updatedAt: 1,
    maxCommands: 0,
    maxMinutes: 0,
    verification: "not-verified",
  } as unknown as AgentTask;
  hub.store.data.tasks.push(task);
  return { hub, task, send: (event) => hub.event(task, event), pieces };
}

const answer = (task: AgentTask): string | undefined => {
  const last = task.messages.at(-1);
  return last?.role === "assistant" ? last.text : undefined;
};

describe("an answer that broke off and is written again", () => {
  it("takes back what was shown of it, and only that", async () => {
    const { task, send } = await hubWithRun();
    send({ type: "message.delta", delta: "First I looked at the log.\n\n" });
    send({ type: "message.delta", delta: "The pool is scr" });
    send({ type: "message.retract", text: "The pool is scr" });
    expect(answer(task)).toBe("First I looked at the log.\n\n");
    send({ type: "message.delta", delta: "The pool is scrubbing." });
    expect(answer(task)).toBe("First I looked at the log.\n\nThe pool is scrubbing.");
    expect(task.messages).toHaveLength(2);
  });

  it("leaves no empty answer behind when everything shown is taken back", async () => {
    const { task, send } = await hubWithRun();
    send({ type: "message.delta", delta: "The pool is scr" });
    send({ type: "message.retract", text: "The pool is scr" });
    expect(task.messages.map((m) => m.role)).toEqual(["user"]);
    send({ type: "message.delta", delta: "The pool is scrubbing." });
    send({ type: "run.completed", output: "The pool is scrubbing." });
    expect(task.messages.map((m) => m.text)).toEqual(["Why is nginx slow?", "The pool is scrubbing."]);
    expect(task.status).toBe("completed");
  });
});

// ------------------------------------------------------------------ a whole run, with a model at an address

async function hubWithModel(script: (request: FakeModelRequest) => FakeModelStep) {
  const model = await fakeOpenAi(script);
  const { hub } = await hubWithRun();
  disposals.push(() => model.close());
  await hub.request({
    action: "configure",
    config: { enabled: true, provider: "openai-compatible", model: "fake-1", baseUrl: model.url, apiKey: "not-a-real-key" }, // pragma: allowlist secret
    preferences: { proposeMemories: false },
  } as never);
  const ended = async (task: AgentTask): Promise<void> => {
    await vi.waitFor(() => expect(["completed", "failed", "interrupted"]).toContain(task.status), { timeout: 15_000 });
    await hub.whenSettled(task);
  };
  const start = async (prompt: string): Promise<AgentTask> => {
    const started = await hub.request({ action: "start", task: { prompt, mode: "advice" } } as never);
    const id = (started as { reply?: { started?: { taskId: string } } }).reply!.started!.taskId;
    return hub.store.data.tasks.find((t) => t.id === id)!;
  };
  return { hub, model, ended, start };
}

describe("what is kept of the answer when the agent is sent back to its task list", () => {
  const REPORT =
    "REPORT: nginx on web-01 was slow because worker_connections was 512 and the upstream pool was exhausted. " +
    "What I checked: the error log, the upstream timings and the connection counts. What is left: raising the limit, which you did not ask for.";

  it("keeps the report in the conversation when a short closing line follows it", async () => {
    const { model, ended, start } = await hubWithModel((request) => {
      const tools = request.messages.filter((m) => m.role === "tool").length;
      const nudged = JSON.stringify(request.messages).includes("item(s) of your task list are still open");
      if (tools === 0) return { tool: "todo_write", args: { todos: [{ id: "t1", content: "Find why nginx is slow", status: "in_progress" }] } };
      if (!nudged) return { text: REPORT };
      if (tools === 1) return { tool: "todo_write", args: { todos: [{ id: "t1", content: "Find why nginx is slow", status: "completed", note: "error log showed it" }] } };
      return { text: "All items are complete." };
    });
    const task = await start("Why is nginx slow on web-01?");
    await ended(task);
    expect(task.status).toBe("completed");
    expect(model.requests).toHaveLength(4);
    const answers = task.messages.filter((m) => m.role === "assistant").map((m) => m.text);
    expect(answers).toEqual([`${REPORT}\n\nAll items are complete.`]);
  }, 30_000);
});

describe("a message sent while the last turn is being written", () => {
  it("reaches the model and is answered before the run ends", async () => {
    let sent: Promise<unknown> | undefined;
    const holder: { hub?: HubService } = {};
    const { hub, model, ended } = await hubWithModel((request) => {
      const task = holder.hub?.store.data.tasks.find((t) => t.id !== "run-1");
      if (!sent && holder.hub && task) {
        // The person types while the model writes what would have been its last turn.
        expect(task.status).toBe("running");
        sent = holder.hub.request({ action: "reply", taskId: task.id, text: "STEERED: also check app-02 before you finish" } as never);
      }
      return JSON.stringify(request.messages).includes("STEERED")
        ? { text: "app-02 answers in 12 ms: it is not the cause." }
        : { text: "It was the upstream pool." };
    });
    holder.hub = hub;
    const pending = hub.request({ action: "start", task: { prompt: "Why is nginx slow on web-01?", mode: "advice" } } as never);
    await vi.waitFor(() => expect(hub.store.data.tasks.some((t) => t.id !== "run-1")).toBe(true));
    const task = hub.store.data.tasks.find((t) => t.id !== "run-1")!;
    await pending;
    await ended(task);
    await sent;
    expect(task.status).toBe("completed");
    expect(model.requests).toHaveLength(2);
    expect(JSON.stringify(model.requests[1])).toContain("STEERED: also check app-02 before you finish");
    expect(task.messages.map((m) => `${m.role}: ${m.text}`)).toEqual([
      "user: Why is nginx slow on web-01?",
      "user: STEERED: also check app-02 before you finish",
      "assistant: It was the upstream pool.\n\napp-02 answers in 12 ms: it is not the cause.",
    ]);
  }, 30_000);
});

describe("an agent's monthly token budget while it runs", () => {
  const agent = { id: "dba", name: "DBA", role: "Database lead", icon: "", mission: "Keep the databases healthy", systemPrompt: "", defaultMode: "advice", enabled: true };
  // Twelve steps, then an answer. Every request reports 1,240 tokens.
  const script = (request: FakeModelRequest): FakeModelStep => {
    const done = request.messages.filter((m) => m.role === "tool").length;
    return done < 12
      ? { tool: "todo_write", args: { todos: [{ id: "t1", content: `Check database ${done + 1}`, status: "in_progress" }] } }
      : { text: "All twelve checked." };
  };

  it("stops the run when the budget is used up, and says so", async () => {
    const { hub, model, ended } = await hubWithModel(script);
    await hub.request({ action: "agent-save", agent: { ...agent, monthlyTokenBudget: 5_000 } } as never);
    const started = await hub.request({ action: "start", task: { prompt: "Check the databases", mode: "advice", agentId: "dba" } } as never);
    const id = (started as { reply?: { started?: { taskId: string } } }).reply!.started!.taskId;
    const task = hub.store.data.tasks.find((t) => t.id === id)!;
    await ended(task);
    expect(task.status).toBe("interrupted");
    expect(task.error).toBe("DBA has used its token budget for this month (5,000 tokens), so this run was stopped. Raise the budget or wait for the new month.");
    // 1,240 tokens a request: the fifth takes it over 5,000. Not all thirteen were made.
    expect(model.requests.length).toBeGreaterThanOrEqual(5);
    expect(model.requests.length).toBeLessThanOrEqual(6);
    // What was spent is on the agent's month, and a new run is refused until the budget is raised.
    expect(hub.store.data.agentUsage?.dba?.tokens ?? 0).toBeGreaterThanOrEqual(5_000);
    await expect(hub.request({ action: "start", task: { prompt: "Again", mode: "advice", agentId: "dba" } } as never)).rejects.toThrow(
      "DBA has used its token budget for this month",
    );
  }, 30_000);

  it("lets a run finish that stays within the budget, and one of an agent without a budget", async () => {
    for (const budget of [500_000, undefined]) {
      const { hub, model, ended } = await hubWithModel(script);
      await hub.request({ action: "agent-save", agent: { ...agent, ...(budget ? { monthlyTokenBudget: budget } : {}) } } as never);
      const started = await hub.request({ action: "start", task: { prompt: "Check the databases", mode: "advice", agentId: "dba" } } as never);
      const id = (started as { reply?: { started?: { taskId: string } } }).reply!.started!.taskId;
      const task = hub.store.data.tasks.find((t) => t.id === id)!;
      await ended(task);
      expect(task.status).toBe("completed");
      // All twelve steps and the answer (asked for again while the list still had an open item).
      expect(model.requests.length).toBeGreaterThanOrEqual(13);
      expect(task.messages.at(-1)?.text).toBe("All twelve checked.");
    }
  }, 30_000);
});

describe("masking the answer while it streams", () => {
  const pieces = (text: string, size: number): string[] => text.match(new RegExp(`[\\s\\S]{1,${size}}`, "g")) ?? [];
  const KEY = ["-----BEGIN OPENSSH PRIVATE KEY-----", ...Array.from({ length: 40 }, (_, i) => `b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB${String(i).padStart(4, "0")}AAAA`), "-----END OPENSSH PRIVATE KEY-----"].join("\n");
  const WITH_SECRETS = [
    "The service file sets its credentials inline.",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCDEF",
    "password=hunter2-correct-horse-battery",
    "The key that is deployed there:",
    KEY,
    "After the key the unit goes on with ExecStart=/usr/bin/shop --port 8080.",
    "Line of ordinary text. ".repeat(400),
  ].join("\n");

  it("keeps exactly what masking the whole answer gives once the run has ended, however the pieces were cut", async () => {
    const { boundedContext } = await import("../../src/main/ai/hub/privacy");
    const whole = boundedContext(WITH_SECRETS, 128_000);
    // The secrets are of a kind the masking knows: the comparison below means something.
    expect(whole).not.toBe(WITH_SECRETS);
    expect(whole).not.toContain("hunter2");
    expect(whole).not.toContain("b3BlbnNzaC1rZXktdjE");
    for (const size of [1, 7, 24, 333, 5000]) {
      for (const ending of [{ type: "run.failed", error: "connection lost" }, { type: "run.completed" }] as RunEvent[]) {
        const { task, send } = await hubWithRun();
        for (const piece of pieces(WITH_SECRETS, size)) send({ type: "message.delta", delta: piece });
        send(ending);
        expect(answer(task)).toBe(whole);
      }
    }
  }, 60_000);

  it("keeps it too when a person stops the run, and when the answer was cut in two by a message of theirs", async () => {
    const { boundedContext } = await import("../../src/main/ai/hub/privacy");
    const stopped = await hubWithRun();
    for (const piece of pieces(WITH_SECRETS, 24)) stopped.send({ type: "message.delta", delta: piece });
    await stopped.hub.stop(stopped.task, "Stopped by the user");
    expect(stopped.task.status).toBe("interrupted");
    expect(answer(stopped.task)).toBe(boundedContext(WITH_SECRETS, 128_000));

    const split = await hubWithRun();
    const all = pieces(WITH_SECRETS, 24);
    const half = Math.floor(all.length / 2);
    for (const piece of all.slice(0, half)) split.send({ type: "message.delta", delta: piece });
    split.task.messages.push({ id: "steer", role: "user", text: "also check app-02", at: 5 });
    for (const piece of all.slice(half)) split.send({ type: "message.delta", delta: piece });
    split.send({ type: "run.failed", error: "connection lost" });
    const answers = split.task.messages.filter((m) => m.role === "assistant").map((m) => m.text);
    expect(answers).toEqual([boundedContext(all.slice(0, half).join(""), 128_000), boundedContext(all.slice(half).join(""), 128_000)]);
  });

  it("does not show a secret that arrived in two pieces, already while the answer streams", async () => {
    const { task, send } = await hubWithRun();
    send({ type: "message.delta", delta: "The unit file has password=hunter2-cor" });
    send({ type: "message.delta", delta: "rect-horse-battery in it, and Authorization: Bearer abcdefghijklmnop" });
    send({ type: "message.delta", delta: "qrstuvwxyz0123456789ABCDEF as well." });
    send({ type: "message.delta", delta: " More follows." });
    expect(answer(task)).not.toContain("rect-horse-battery");
    expect(answer(task)).not.toContain("qrstuvwxyz0123456789ABCDEF");
    expect(answer(task)).toContain("More follows.");
  });

  it("masks a long answer in time that grows with its length, not with its square", async () => {
    const { boundedContext } = await import("../../src/main/ai/hub/privacy");
    const piece = "The pool is scrubbing and ";
    const count = 5000;
    const { task, send } = await hubWithRun();
    const started = performance.now();
    for (let i = 0; i < count; i++) send({ type: "message.delta", delta: piece });
    const took = performance.now() - started;
    send({ type: "run.failed", error: "x" });
    expect(answer(task)).toBe(boundedContext(piece.repeat(count), 128_000));
    // 130,000 characters in 5,000 pieces. Masking the whole answer for each piece took about 26
    // seconds here; masking its end takes about one. The bound leaves room for a busy machine.
    expect(took).toBeLessThan(10_000);
  }, 60_000);
});

describe("what a run read, when it ends without an answer", () => {
  const call = { id: "call-1", at: 5, sources: [{ ref: "S1", kind: "server-reading" as const, id: "web-01:/etc/nginx/acme.conf", label: "web-01:/etc/nginx/acme.conf", digest: "d1", excerpt: "proxy_read_timeout 60s;" }] };

  it("is kept, so that an observation that names it still finds it", async () => {
    const { hub, task, send } = await hubWithRun();
    // The run recorded a hypothesis from a file it read, then failed before it wrote anything.
    send({ type: "run.failed", error: "The model connection was lost.", sourceCalls: [call] });
    expect(task.status).toBe("failed");
    expect(task.messages.map((m) => m.role)).toEqual(["user"]);
    const found = await hub.request({ action: "task-read", taskId: task.id, detail: "evidence-source", callId: "call-1", ref: "S1", digest: "d1" } as never);
    expect((found as { reply?: { evidenceSource?: { source: { id: string } } } }).reply?.evidenceSource?.source.id).toBe("web-01:/etc/nginx/acme.conf");
  });

  it("stays with the answer when there is one, and with an answer that was taken back whole", async () => {
    const answered = await hubWithRun();
    answered.send({ type: "message.delta", delta: "The timeout is 60s [S1]." });
    answered.send({ type: "run.completed", output: "The timeout is 60s [S1].", sourceCalls: [call] });
    expect(answered.task.messages.at(-1)).toMatchObject({ role: "assistant", sourceCalls: [expect.objectContaining({ id: "call-1" })] });

    const retried = await hubWithRun();
    retried.send({ type: "message.delta", delta: "The timeout", sourceCalls: [call] });
    retried.send({ type: "message.retract", text: "The timeout" });
    // Nothing is left of the text, but the message holds what was read: it stays.
    expect(retried.task.messages.at(-1)).toMatchObject({ role: "assistant", text: "", sourceCalls: [expect.objectContaining({ id: "call-1" })] });
  });
});
