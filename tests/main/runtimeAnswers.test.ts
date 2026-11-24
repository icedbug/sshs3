// What a run ends with, and what the person is left with in the conversation, when its turns do not
// go the plain way: a spare model takes over, a report is restated, a last turn says nothing.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DirectAgentRuntime, resetCircuitBreakers, retryPolicy, type DirectRuntimeOptions } from "../../src/main/ai/hub/DirectAgentRuntime";
import type { RunEvent } from "../../src/main/ai/hub/AgentRuntime";
import type { AgentTask } from "../../src/shared/types/aiHub";
import { PROTOCOLS, scriptedModel, type Protocol, type ScriptedModel, type ScriptedRequest, type ScriptedStep } from "../helpers/scriptedModel";

beforeEach(() => {
  retryPolicy.attempts = 0;
  retryPolicy.baseDelayMs = 1;
  resetCircuitBreakers();
});
afterEach(() => {
  retryPolicy.attempts = 3;
  retryPolicy.baseDelayMs = 1000;
});

const task = (extra: Partial<AgentTask> = {}): AgentTask =>
  ({
    id: "t1",
    title: "t",
    mode: "assisted",
    status: "running",
    target: { sessionId: "s1", generation: 1, label: "web-01" },
    messages: [{ id: "m", role: "user", text: "Why is nginx slow on web-01?", at: 100 }],
    changes: [],
    sources: [],
    createdAt: 1,
    updatedAt: 1,
    maxCommands: 0,
    maxMinutes: 0,
    verification: "not-verified",
    ...extra,
  }) as AgentTask;

interface Ran {
  events: RunEvent[];
  end: RunEvent | undefined;
  streamed: string;
  model: ScriptedModel;
}

async function run(
  protocol: Protocol,
  script: (request: ScriptedRequest, runtime: DirectAgentRuntime) => ScriptedStep | Promise<ScriptedStep>,
  options: {
    task?: AgentTask;
    onEvent?: (event: RunEvent, runtime: DirectAgentRuntime) => void;
    runtimeOptions?: DirectRuntimeOptions;
    maxRequests?: number;
  } = {},
): Promise<Ran> {
  const holder: { runtime?: DirectAgentRuntime } = {};
  const model = scriptedModel(protocol, (request) => script(request, holder.runtime!), { maxRequests: options.maxRequests ?? 60 });
  const broker = async (req: Record<string, unknown>) => (req.action === "context" ? {} : { exitCode: 0, output: "load average: 0.10" });
  const events: RunEvent[] = [];
  const runtime = (holder.runtime = new DirectAgentRuntime(broker as never, undefined, model.fetch, options.runtimeOptions));
  await runtime.start(options.task ?? task(), model.config(), (event) => {
    options.onEvent?.(event, runtime);
    events.push(event);
  });
  return {
    events,
    end: events.find((e) => /^run\.(completed|failed|cancelled)$/.test(e.type)),
    streamed: events.filter((e) => e.type === "message.delta").map((e) => e.delta ?? "").join(""),
    model,
  };
}

const look = (command = "uptime"): ScriptedStep => ({ calls: [{ name: "terminal_command", args: { command, description: "look" } }] });

/** The conversation as the hub keeps it (areas/runs.ts `event`): pieces, take-backs, the person's messages, the final answer. */
function conversationAsKept(events: RunEvent[], userMessages: Map<number, string> = new Map()): Array<{ role: "assistant" | "user"; text: string }> {
  const conversation: Array<{ role: "assistant" | "user"; text: string }> = [];
  events.forEach((event, i) => {
    if (event.type === "message.delta" && event.delta) {
      const last = conversation.at(-1);
      if (last?.role === "assistant") last.text += event.delta;
      else conversation.push({ role: "assistant", text: event.delta });
    }
    if (event.type === "message.retract") {
      const takeBack = (at: number, text: string): boolean => {
        const message = conversation[at];
        expect(message.role).toBe("assistant");
        expect(message.text.endsWith(text)).toBe(true);
        message.text = message.text.slice(0, message.text.length - text.length);
        if (message.text) return false;
        conversation.splice(at, 1);
        return true;
      };
      let at = conversation.length - 1;
      if (event.text && takeBack(at, event.text)) at--;
      // What was shown before each message the person sent during the turn stands just before it.
      for (const part of [...(event.earlier ?? [])].reverse()) {
        while (at >= 0 && conversation[at].role !== "user") at--;
        at--;
        if (part && takeBack(at, part)) at--;
      }
    }
    if (event.type === "run.completed" && event.output) {
      const last = conversation.at(-1);
      if (last?.role === "assistant") last.text = event.output;
      else conversation.push({ role: "assistant", text: event.output });
    }
    const said = userMessages.get(i);
    if (said !== undefined) conversation.push({ role: "user", text: said });
  });
  return conversation;
}

describe("a spare model takes over after the first one failed (chat)", () => {
  it("keeps nothing of what the failed model wrote, in the answer or on the screen", async () => {
    const spare = { kind: "custom", model: "spare-model", apiKey: "", baseUrl: "http://127.0.0.1:11434/v1" };
    const { end, events, model } = await run(
      "chat",
      (request) => {
        if (request.body.model === "spare-model") return { text: "Load is fine." };
        if (request.n === 1) return { text: "The pool is degraded.\nIt is ", cutAtLimit: true };
        if (request.n === 2) return { text: "scrubbing.\nA second paragraph.\nIt goes ", cutAtLimit: true };
        return { status: 503, errorBody: "overloaded" };
      },
      { runtimeOptions: { fallbackModels: [spare as never] } },
    );
    expect(events.some((e) => e.type === "run.degraded")).toBe(true);
    // The spare model was asked from the start of the conversation.
    expect(JSON.stringify(model.requests.at(-1)!.items)).not.toContain("The pool is");
    expect(end?.type).toBe("run.completed");
    expect(end?.output).toBe("Load is fine.");
    // What the failed model showed over both of its turns was taken back.
    expect(conversationAsKept(events)).toEqual([{ role: "assistant", text: "Load is fine." }]);
  });
});

const todo = (status: string): ScriptedStep => ({
  calls: [{ name: "todo_write", args: { todos: [{ id: "t1", content: "Find why nginx is slow", status, ...(status === "completed" ? { note: "error log showed it" } : {}) }] } }],
});
const nudged = (request: ScriptedRequest): boolean => request.raw.includes("item(s) of your task list are still open");

describe.each(PROTOCOLS)("a report said again after the run was sent back (%s)", (protocol) => {
  const REPORT = "REPORT: nginx on web-01 was slow because worker_connections was 512 and the upstream pool was exhausted.";
  const sentBack = (last: string) => (request: ScriptedRequest): ScriptedStep => {
    if (request.toolResults === 0) return todo("in_progress");
    if (!nudged(request)) return { text: REPORT };
    if (request.toolResults === 1) return todo("completed");
    return { text: last };
  };

  it("is in the answer once when the last turn says it again under a line of its own", async () => {
    const { end } = await run(protocol, sentBack(`All items are complete.\n\n${REPORT}`));
    expect(end?.output).toBe(`All items are complete.\n\n${REPORT}`);
  });

  it("is in the answer once when the last turn says it word for word", async () => {
    const { end } = await run(protocol, sentBack(REPORT));
    expect(end?.output).toBe(REPORT);
  });

  it("is kept with the line under it when the last turn says something else", async () => {
    const { end } = await run(protocol, sentBack("All items are complete."));
    expect(end?.output).toBe(`${REPORT}\n\nAll items are complete.`);
  });

  it("is in the answer once when it was cut at the output limit and said again", async () => {
    const half = REPORT.slice(0, 40);
    const { end } = await run(protocol, (request) => {
      if (request.toolResults === 0) return todo("in_progress");
      if (request.n === 2) return { text: half, cutAtLimit: true };
      if (request.n === 3) return { text: REPORT.slice(40) };
      if (request.toolResults === 1) return todo("completed");
      return { text: `All items are complete.\n\n${REPORT}` };
    });
    expect(end?.output).toBe(`All items are complete.\n\n${REPORT}`);
  });
});

describe.each(PROTOCOLS)("a last turn that says nothing (%s)", (protocol) => {
  it("fails with a plain message when no turn gave an answer: what was said before a tool call is not one", async () => {
    const withPreamble = await run(protocol, (request) => (request.n === 1 ? { text: "Let me look at the load first.", ...look() } : {}));
    const bare = await run(protocol, (request) => (request.n === 1 ? look() : {}));
    for (const ran of [withPreamble, bare]) {
      expect(ran.end?.type).toBe("run.failed");
      expect(ran.end?.error).toBe("The model finished without an answer. Ask it again, or ask what it found.");
    }
  });

  it("ends with the answer an earlier turn gave", async () => {
    const { end } = await run(protocol, (request) => {
      if (request.toolResults === 0) return todo("in_progress");
      if (!nudged(request)) return { text: "It was the upstream pool." };
      if (request.toolResults === 1) return todo("completed");
      return {};
    });
    expect(end?.type).toBe("run.completed");
    expect(end?.output).toBe("It was the upstream pool.");
  });
});

describe.each(PROTOCOLS)("the person writes while an answer streams, then the stream breaks (%s)", (protocol) => {
  it("takes back what was shown before the message too: the answer is written again after it", async () => {
    const broken = "The pool is scrubbing, and that is what slows the upstream down for every request.\n".repeat(5);
    const userAt = new Map<number, string>();
    let steered = false;
    let seen = 0;
    const { end, events, model } = await run(
      protocol,
      (request) => (request.n === 1 ? { text: broken, breakStream: "reset" } : { text: "app-02 is fine." }),
      {
        onEvent: (event, runtime) => {
          if (event.type === "message.delta" && event.delta && !steered) {
            steered = true;
            void runtime.steer("STEERED: also check app-02");
            // The hub adds the person's message after this piece of the answer.
            userAt.set(seen, "STEERED: also check app-02");
          }
          seen++;
        },
      },
    );
    expect(end?.type).toBe("run.completed");
    expect(end?.output).toBe("app-02 is fine.");
    // The turn asked again carries the person's message.
    expect(model.requests[1].raw).toContain("STEERED: also check app-02");
    expect(conversationAsKept(events, userAt)).toEqual([
      { role: "user", text: "STEERED: also check app-02" },
      { role: "assistant", text: "app-02 is fine." },
    ]);
  });
});

describe.each(PROTOCOLS)("a message sent before the run's first request (%s)", (protocol) => {
  it("reaches the model once", async () => {
    const model = scriptedModel(protocol, () => ({ text: "ok" }));
    let release!: () => void;
    const contextAsked = new Promise<void>((resolve) => (release = resolve));
    let contextStarted!: () => void;
    const started = new Promise<void>((resolve) => (contextStarted = resolve));
    const broker = async (req: Record<string, unknown>) => {
      if (req.action === "context") {
        contextStarted();
        await contextAsked;
        return {};
      }
      return { exitCode: 0, output: "" };
    };
    const t = task();
    const runtime = new DirectAgentRuntime(broker as never, undefined, model.fetch);
    const done = runtime.start(t, model.config(), () => {});
    await started;
    // What the hub does for a reply while the run is active (areas/conversations.ts "reply"): steer, then add the message.
    await runtime.steer("STEERED: do not restart nginx");
    t.messages.push({ id: "s", role: "user", text: "STEERED: do not restart nginx", at: 200 });
    release();
    await done;
    expect(model.requests[0].raw.split("STEERED: do not restart nginx")).toHaveLength(2);
    expect(model.requests).toHaveLength(1);
  });
});

describe("a message sent while the first model fails (chat)", () => {
  it("reaches the spare model once when it starts the run again", async () => {
    const spare = { kind: "custom", model: "spare-model", apiKey: "", baseUrl: "http://127.0.0.1:11434/v1" };
    const t = task();
    const { model } = await run(
      "chat",
      async (request, runtime) => {
        if (request.body.model === "spare-model") return { text: "ok" };
        await runtime.steer("STEERED: do not restart nginx");
        t.messages.push({ id: "s", role: "user", text: "STEERED: do not restart nginx", at: 200 });
        return { status: 503, errorBody: "overloaded" };
      },
      { task: t, runtimeOptions: { fallbackModels: [spare as never] } },
    );
    expect(model.requests.at(-1)!.body.model).toBe("spare-model");
    expect(model.requests.at(-1)!.raw.split("STEERED: do not restart nginx")).toHaveLength(2);
  });
});
