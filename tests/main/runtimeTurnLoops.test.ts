import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DirectAgentRuntime, MAX_CUT_TURNS, resetCircuitBreakers, retryPolicy } from "../../src/main/ai/hub/DirectAgentRuntime";
import type { RunEvent } from "../../src/main/ai/hub/AgentRuntime";
import type { AgentTask } from "../../src/shared/types/aiHub";
import { PROTOCOLS, scriptedModel, type Protocol, type ScriptedModel, type ScriptedModelOptions, type ScriptedRequest, type ScriptedStep } from "../helpers/scriptedModel";

/**
 * What the three turn loops (chat completions, the Responses API, Anthropic) do when a turn does not
 * end the way a turn should. Every case runs against all three, with a model that answers from a script.
 */

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
  /** Everything streamed to the person, in order. */
  streamed: string;
  model: ScriptedModel;
  /** The requests the broker was sent, the first (the workspace context) left out. */
  brokerCalls: Array<Record<string, unknown>>;
}

async function run(
  protocol: Protocol,
  script: (request: ScriptedRequest, runtime: DirectAgentRuntime) => ScriptedStep | Promise<ScriptedStep>,
  options: {
    task?: AgentTask;
    tuning?: Record<string, unknown>;
    model?: ScriptedModelOptions;
    broker?: (req: Record<string, unknown>) => unknown;
    /** Called with every event as it comes, before it is recorded: where a test acts in the middle of a run. */
    onEvent?: (event: RunEvent, runtime: DirectAgentRuntime) => void;
  } = {},
): Promise<Ran> {
  const holder: { runtime?: DirectAgentRuntime } = {};
  const model = scriptedModel(protocol, (request) => script(request, holder.runtime!), { maxRequests: 60, ...options.model });
  const brokerCalls: Array<Record<string, unknown>> = [];
  const broker = async (req: Record<string, unknown>) => {
    if (req.action === "context") return {};
    brokerCalls.push(req);
    return options.broker ? options.broker(req) : { exitCode: 0, output: "load average: 0.10" };
  };
  const events: RunEvent[] = [];
  const runtime = (holder.runtime = new DirectAgentRuntime(broker as never, undefined, model.fetch));
  await runtime.start(
    options.task ?? task(),
    model.config(options.tuning),
    (event) => {
      options.onEvent?.(event, runtime);
      events.push(event);
    },
  );
  return {
    events,
    end: events.find((e) => /^run\.(completed|failed|cancelled)$/.test(e.type)),
    streamed: events.filter((e) => e.type === "message.delta").map((e) => e.delta ?? "").join(""),
    model,
    brokerCalls,
  };
}

const look = (command = "uptime"): ScriptedStep => ({ calls: [{ name: "terminal_command", args: { command, description: "look" } }] });

beforeEach(() => {
  retryPolicy.attempts = 0;
  retryPolicy.baseDelayMs = 1;
  resetCircuitBreakers();
});
afterEach(() => {
  retryPolicy.attempts = 3;
  retryPolicy.baseDelayMs = 1000;
});

describe.each(PROTOCOLS)("an answer cut at the output limit (%s)", (protocol) => {
  it("is kept, the model is asked to go on, and the final answer is the whole text", async () => {
    const { end, streamed, model } = await run(protocol, (request) =>
      request.n === 1 ? { text: "The pool is ", cutAtLimit: true } : { text: "scrubbing, which slows the upstream." });
    expect(end?.type).toBe("run.completed");
    expect(end?.output).toBe("The pool is scrubbing, which slows the upstream.");
    // What the person saw as it came is the same text: nothing between the two halves.
    expect(streamed).toBe("The pool is scrubbing, which slows the upstream.");
    expect(model.requests).toHaveLength(2);
    // The second request carries what was written, then the request to go on.
    const sent = model.requests[1].items;
    expect(JSON.stringify(sent.at(-2))).toContain("The pool is ");
    expect(sent.at(-2)?.role).toBe("assistant");
    expect(model.requests[1].last).toContain("Your reply was cut off at the output limit.");
    expect(model.requests[1].last).toContain("Go on exactly where it stopped.");
  });

  it("does not make a tool call that was cut in the middle, and asks for it again", async () => {
    const { end, model, brokerCalls } = await run(protocol, (request) =>
      request.n === 1 ? { ...look("df -h /"), cutAtLimit: true } : request.n === 2 ? look("df -h /") : { text: "Disk is fine." });
    expect(end?.type).toBe("run.completed");
    expect(end?.output).toBe("Disk is fine.");
    expect(model.requests[1].last).toContain("in the middle of a tool call. The call was not made.");
    // Made once: by the turn that was whole.
    expect(brokerCalls.filter((req) => req.action === "command")).toHaveLength(1);
  });

  it("stops asking when the limit is reached again and again, and says what to change", async () => {
    const { end, streamed, model } = await run(protocol, () => ({ text: "more ", cutAtLimit: true }));
    expect(model.requests).toHaveLength(MAX_CUT_TURNS + 1);
    expect(end?.type).toBe("run.failed");
    expect(end?.error).toBe(
      `The model reached its output limit (8,192 tokens) ${MAX_CUT_TURNS + 1} times in a row, so the run was stopped. What it wrote is in the conversation. Raise "Longest answer" in AI settings.`,
    );
    expect(streamed).toBe("more ".repeat(MAX_CUT_TURNS + 1));
  });

  it("asks once more when the output was used up before any text, then fails with what to change", async () => {
    const { end, model } = await run(protocol, () => ({ cutAtLimit: true }));
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1].last).toContain("reached the output limit before you wrote anything");
    expect(end?.type).toBe("run.failed");
    expect(end?.error).toBe(
      'The model reached its output limit (8,192 tokens) twice before it wrote anything. Raise "Longest answer" in AI settings, or lower the reasoning effort there.',
    );
  });

  it("counts cut turns in a row only: a whole turn in between starts the count over", async () => {
    // Cut, cut, a whole turn with a command, then three more cuts: never more than three in a row.
    const steps: ScriptedStep[] = [
      { text: "a ", cutAtLimit: true }, { text: "b ", cutAtLimit: true }, look(),
      { text: "c ", cutAtLimit: true }, { text: "d ", cutAtLimit: true }, { text: "e ", cutAtLimit: true }, { text: "done." },
    ];
    const { end } = await run(protocol, (request) => steps[request.n - 1]);
    expect(end?.type).toBe("run.completed");
    expect(end?.output).toBe("a b c d e done.");
  });
});

/** The conversation's answer text as the hub keeps it: pieces are added, and a taken-back piece is removed from the end. */
function answerAsKept(events: RunEvent[]): string {
  let text = "";
  for (const event of events) {
    if (event.type === "message.delta") text += event.delta ?? "";
    if (event.type === "message.retract") {
      expect(text.endsWith(event.text ?? "")).toBe(true);
      text = text.slice(0, text.length - (event.text ?? "").length);
    }
  }
  return text;
}

describe.each(PROTOCOLS)("a connection that breaks in the middle of an answer (%s)", (protocol) => {
  it.each(["reset", "close"] as const)("asks the turn again after a %s, and the person sees the answer once", async (how) => {
    // Long enough that part of it reaches the person before the break (the last 128 characters are held back for masking).
    const broken = "The pool is scrubbing, and that is what slows the upstream down for every request. ".repeat(5);
    const { end, events, model } = await run(protocol, (request) =>
      request.n === 1 ? { text: broken, breakStream: how } : { text: "The pool is scrubbing." });
    expect(end?.type).toBe("run.completed");
    expect(end?.output).toBe("The pool is scrubbing.");
    expect(model.requests).toHaveLength(2);
    // The second request is the first one again: nothing of the broken answer was sent back.
    expect(model.requests[1].items).toEqual(model.requests[0].items);
    // Some of the broken answer had been shown; it was taken back before the answer was written again.
    const takenBack = events.filter((e) => e.type === "message.retract");
    expect(takenBack).toHaveLength(1);
    expect(broken.startsWith(takenBack[0].text!)).toBe(true);
    expect(takenBack[0].text!.length).toBeGreaterThan(100);
    expect(answerAsKept(events)).toBe("The pool is scrubbing.");
    expect(events.find((e) => e.type === "run.retrying")?.text).toBe(
      "The connection to the model broke in the middle of its answer. Asking again (attempt 1 of 2).",
    );
  });

  it("makes a tool call once when the turn that asked for it broke and was asked again", async () => {
    const { end, brokerCalls } = await run(protocol, (request) =>
      request.n === 1 ? { ...look("df -h /"), breakStream: "reset" } : request.n === 2 ? look("df -h /") : { text: "Disk is fine." });
    expect(end?.type).toBe("run.completed");
    expect(brokerCalls.filter((req) => req.action === "command")).toHaveLength(1);
  });

  it("gives up after two more tries of the same turn, and a later turn gets its own tries", async () => {
    const always = await run(protocol, () => ({ text: "The pool is scrubbing. ".repeat(20), breakStream: "reset" }));
    expect(always.model.requests).toHaveLength(1 + retryPolicy.streamRetries);
    expect(always.end?.type).toBe("run.failed");
    // Nothing of the broken answers is left standing as an answer.
    expect(answerAsKept(always.events.slice(0, always.events.map((e) => e.type).lastIndexOf("run.retrying")))).toBe("");

    // Two breaks, then a command; two more breaks on the next turn, then the answer.
    const steps: ScriptedStep[] = [
      { text: "a", breakStream: "close" }, { text: "a", breakStream: "close" }, look(),
      { text: "b", breakStream: "reset" }, { text: "b", breakStream: "reset" }, { text: "Done." },
    ];
    const recovered = await run(protocol, (request) => steps[request.n - 1]);
    expect(recovered.end?.type).toBe("run.completed");
    expect(recovered.end?.output).toBe("Done.");
  });

  it("does not ask again for an error the provider reported, or one before the answer began", async () => {
    const refused = await run(protocol, () => ({ status: 400, errorBody: "bad request" }));
    expect(refused.model.requests).toHaveLength(1);
    expect(refused.end?.type).toBe("run.failed");
  });
});

describe("the Responses API: the model's reasoning, with nothing stored at the provider", () => {
  it("asks for the encrypted reasoning and sends it back with the tool result", async () => {
    const { end, model } = await run("responses", (request) =>
      request.n === 1 ? { ...look(), reasoning: true } : { text: "Load is fine.", reasoning: true });
    expect(end?.type).toBe("run.completed");
    expect(model.requests).toHaveLength(2);
    for (const request of model.requests) {
      expect(request.body.store).toBe(false);
      expect(request.body.include).toEqual(["reasoning.encrypted_content"]);
    }
    // The stand-in gives the encrypted form only when asked, and refuses a reasoning item without it.
    expect(model.requests[1].items).toContainEqual(expect.objectContaining({ type: "reasoning", encrypted_content: "opaque-1" }));
  });

  it("goes on without it at an endpoint that refuses `include`, and then sends no reasoning item back", async () => {
    const { end, model } = await run(
      "responses",
      (request) => (request.toolResults === 0 ? { ...look(), reasoning: true } : { text: "Load is fine.", reasoning: true }),
      { model: { refusesInclude: true } },
    );
    expect(end?.type).toBe("run.completed");
    expect(end?.output).toBe("Load is fine.");
    // Refused once, asked again without, then the second turn.
    expect(model.requests.map((request) => "include" in request.body)).toEqual([true, false, false]);
    expect(model.requests[2].items.some((item) => item.type === "reasoning")).toBe(false);
    expect(model.requests[2].items.some((item) => item.type === "function_call")).toBe(true);
  });
});

const REPORT =
  "REPORT: nginx on web-01 was slow because worker_connections was 512 and the upstream pool was exhausted. " +
  "What I checked: the error log, the upstream timings and the connection counts. What is left: raising the limit, which you did not ask for.";

describe.each(PROTOCOLS)("a report, then the run is sent back to its task list, then a short closing line (%s)", (protocol) => {
  const todo = (status: string): ScriptedStep => ({
    calls: [{ name: "todo_write", args: { todos: [{ id: "t1", content: "Find why nginx is slow", status, ...(status === "completed" ? { note: "error log showed it" } : {}) }] } }],
  });

  it("keeps the report as the answer: the closing line is added to it, not put in its place", async () => {
    const { end, streamed, model } = await run(protocol, (request) => {
      const nudged = request.raw.includes("item(s) of your task list are still open");
      if (request.toolResults === 0) return todo("in_progress");
      if (!nudged) return { text: REPORT };
      if (request.toolResults === 1) return todo("completed");
      return { text: "All items are complete." };
    });
    expect(model.requests).toHaveLength(4);
    expect(end?.type).toBe("run.completed");
    expect(end?.output).toBe(`${REPORT}\n\nAll items are complete.`);
    // The answer is what the person saw as it came.
    expect(streamed).toBe(`${REPORT}\n\nAll items are complete.`);
  });

  it("does not say the same thing twice when the model repeats itself after being sent back", async () => {
    const { end } = await run(protocol, (request) => {
      const nudged = request.raw.includes("item(s) of your task list are still open");
      if (request.toolResults === 0) return todo("in_progress");
      if (!nudged) return { text: REPORT };
      if (request.toolResults === 1) return todo("completed");
      return { text: REPORT };
    });
    expect(end?.output).toBe(REPORT);

    // Sent back twice with the list still open, it says the same thing three times.
    const stuck = await run(protocol, (request) => (request.toolResults === 0 ? todo("in_progress") : { text: REPORT }));
    expect(stuck.model.requests).toHaveLength(4);
    expect(stuck.end?.output).toBe(REPORT);
  });

  it("leaves out what the model said between tool calls: only what it ended a turn on is the answer", async () => {
    const { end } = await run(protocol, (request) =>
      request.toolResults === 0 ? { text: "Let me look at the load first.", ...look() } : { text: "Load is fine." });
    expect(end?.output).toBe("Load is fine.");
  });
});

describe.each(PROTOCOLS)("a message the person sends while the agent works (%s)", (protocol) => {
  it("reaches the model when it is sent while the last turn is being written, and is answered before the run ends", async () => {
    const { end, model } = await run(protocol, async (request, runtime) => {
      if (request.n === 1) {
        // The person types while the model is writing what would have been its last turn.
        await runtime.steer("STEERED: also check the upstream on app-02 before you finish");
        return { text: "nginx is slow because the upstream pool is exhausted." };
      }
      return { text: "app-02 answers in 12 ms: it is not the cause." };
    });
    expect(model.requests).toHaveLength(2);
    // The second request holds what the model had written, then the person's message.
    expect(JSON.stringify(model.requests[1].items.at(-2))).toContain("nginx is slow because the upstream pool is exhausted.");
    expect(model.requests[1].last).toContain("STEERED: also check the upstream on app-02 before you finish");
    expect(end?.type).toBe("run.completed");
    // The person's message was there before anything was shown: the answer after it is both texts.
    expect(end?.output).toBe("nginx is slow because the upstream pool is exhausted.\n\napp-02 answers in 12 ms: it is not the cause.");
  });

  it("puts the answer where it belongs in the conversation when the message comes in the middle of a turn", async () => {
    // The conversation as the hub keeps it: pieces go to the last answer, or begin one after the person's message.
    const conversation: Array<{ role: "assistant" | "user"; text: string }> = [];
    const first = "nginx is slow because the upstream pool is exhausted. ".repeat(8).trim();
    let steered = false;
    const { end } = await run(
      protocol,
      (request) => (request.n === 1 ? { text: first } : { text: "app-02 is fine." }),
      {
        onEvent: (event, runtime) => {
          if (event.type !== "message.delta" || !event.delta) return;
          const last = conversation.at(-1);
          if (last?.role === "assistant") last.text += event.delta;
          else conversation.push({ role: "assistant", text: event.delta });
          if (!steered) {
            // Sent as soon as the first piece of the answer is on screen: the rest of it follows the message.
            steered = true;
            void runtime.steer("STEERED: also check app-02");
            conversation.push({ role: "user", text: "STEERED: also check app-02" });
          }
        },
      },
    );
    expect(end?.type).toBe("run.completed");
    // When the run ends the hub puts the final answer in place of the last answer's text.
    conversation.at(-1)!.text = end!.output!;
    expect(conversation.map((m) => m.role)).toEqual(["assistant", "user", "assistant"]);
    expect(conversation[0].text.length).toBeGreaterThan(100);
    // Nothing of the first answer is lost or said twice: its start stands before the message, its rest after.
    expect(conversation[0].text + conversation[2].text).toBe(`${first}\n\napp-02 is fine.`);
  });

  it("is kept word for word through a compaction, whatever the handover note says", async () => {
    let commands = 0;
    const { end, model } = await run(
      protocol,
      async (request, runtime) => {
        if (request.n === 1) await runtime.steer("STEERED: do not restart nginx, it serves checkout");
        // A note that does not repeat what the person said.
        if (request.last.includes("write a handover note for yourself")) return { text: "Goal: find why nginx is slow. Found: upstream timeouts. Next: worker_connections." };
        if (commands >= 8) return { text: "Done: it was the upstream pool." };
        commands++;
        return look(`journalctl -u nginx --since -${commands}h`);
      },
      // A small window: the limit is about 41,000 characters and the tool list alone is over it.
      { tuning: { contextWindowTokens: 32_000 }, broker: () => ({ exitCode: 0, output: "y".repeat(6000) }) },
    );
    expect(end?.type).toBe("run.completed");
    const notes = model.requests.filter((request) => request.last.includes("write a handover note for yourself"));
    expect(notes.length).toBeGreaterThan(0);
    const firstNote = model.requests.indexOf(notes[0]);
    // Every request after the first compaction still carries the person's words.
    const after = model.requests.slice(firstNote + 1);
    expect(after.length).toBeGreaterThan(2);
    for (const request of after) expect(request.raw).toContain("STEERED: do not restart nginx, it serves checkout");
    expect(after[0].last).toContain("What the user wrote to you while you worked, word for word. It still applies:");
  });
});

describe.each(PROTOCOLS)("shortening old tool results (%s)", (protocol) => {
  /** For each request after the first: how many of the previous request's items it still begins with, unchanged. */
  const unchangedPrefix = (requests: ScriptedRequest[]): Array<{ same: number; of: number }> =>
    requests.slice(1).map((request, i) => {
      const before = requests[i].items.map((item) => JSON.stringify(item));
      const now = request.items.map((item) => JSON.stringify(item));
      let same = 0;
      while (same < before.length && before[same] === now[same]) same++;
      return { same, of: before.length };
    });

  it("happens in batches: most requests begin with exactly what the request before them sent", async () => {
    let commands = 0;
    const { end, model } = await run(
      protocol,
      () => (commands >= 30 ? { text: "Done." } : look(`sed -n ${++commands}p /var/log/nginx/error.log`)),
      { broker: () => ({ exitCode: 0, output: `line ${commands} `.padEnd(6000, "z") }) },
    );
    expect(end?.type).toBe("run.completed");
    expect(model.requests).toHaveLength(31);
    expect(model.requests.some((request) => request.raw.includes("write a handover note for yourself"))).toBe(false);
    const prefixes = unchangedPrefix(model.requests);
    const edited = prefixes.filter((p) => p.same < p.of);
    // Old results were shortened (the run would not fit otherwise), but in a few batches: a request
    // whose earlier messages were edited is one the provider's cache cannot serve.
    expect(edited.length).toBeGreaterThanOrEqual(1);
    expect(edited.length).toBeLessThanOrEqual(5);
    expect(model.requests.at(-1)!.raw).toContain("[microcompacted stale tool result");
    // Each batch shortens several results at once.
    const shortenedIn = (request: ScriptedRequest): number => request.raw.split("[microcompacted stale tool result").length - 1;
    const steps = model.requests.slice(1).map((request, i) => shortenedIn(request) - shortenedIn(model.requests[i])).filter((n) => n > 0);
    expect(steps.length).toBe(edited.length);
    for (const n of steps) expect(n).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it("leaves a short run alone: nothing is shortened until enough old output has piled up", async () => {
    let commands = 0;
    const { model } = await run(
      protocol,
      () => (commands >= 14 ? { text: "Done." } : look(`sed -n ${++commands}p /var/log/nginx/error.log`)),
      { broker: () => ({ exitCode: 0, output: `line ${commands} `.padEnd(1500, "z") }) },
    );
    expect(model.requests).toHaveLength(15);
    expect(unchangedPrefix(model.requests).every((p) => p.same === p.of)).toBe(true);
    expect(model.requests.at(-1)!.raw).not.toContain("[microcompacted stale tool result");
  }, 30_000);
});

describe("Anthropic: the model's thinking when earlier messages are edited", () => {
  it("is sent back unchanged while the conversation is only added to, and left out once old results were shortened", async () => {
    let commands = 0;
    const { end, model } = await run(
      "anthropic",
      () => (commands >= 30 ? { text: "Done.", reasoning: true } : { ...look(`sed -n ${++commands}p /var/log/nginx/error.log`), reasoning: true }),
      { broker: () => ({ exitCode: 0, output: `line ${commands} `.padEnd(6000, "z") }) },
    );
    expect(end?.type).toBe("run.completed");
    const thinking = (request: ScriptedRequest): number => request.raw.split('"type":"thinking"').length - 1;
    const shortened = (request: ScriptedRequest): boolean => request.raw.includes("[microcompacted stale tool result");
    const firstEdited = model.requests.findIndex(shortened);
    expect(firstEdited).toBeGreaterThan(1);
    // Before any edit every turn's thinking block goes back, signature and all.
    const before = model.requests[firstEdited - 1];
    expect(thinking(before)).toBe(firstEdited - 1);
    expect(before.raw).toContain('"signature":"sig-1"');
    // The request that carries the first edit carries no thinking block: one bound to the conversation
    // as it was would be refused.
    expect(thinking(model.requests[firstEdited])).toBe(0);
    // After it the conversation is only added to again, and thinking goes back again.
    expect(thinking(model.requests[firstEdited + 1])).toBe(1);
  }, 30_000);
});

describe("a ChatGPT sign-in that is refused in the middle of a run", () => {
  const jwt = (name: string, expiresInSeconds = 3600): string => {
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${part({ alg: "none", typ: "JWT" })}.${part({ exp: Math.floor(Date.now() / 1000) + expiresInSeconds, name })}.sig`;
  };
  const OLD = jwt("old");
  const NEW = jwt("new");

  async function signedIn(): Promise<{ dir: string; file: string; stored: () => Promise<{ access_token: string; refresh_token: string }> }> {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-sign-in-"));
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    await fs.mkdir(path.join(dir, "hermes-native"), { recursive: true });
    const file = path.join(dir, "hermes-native", "auth.json");
    await fs.writeFile(file, JSON.stringify({ version: 1, providers: { "openai-codex": { tokens: { access_token: OLD, refresh_token: "refresh-old" } } } }), "utf8");
    return {
      dir,
      file,
      stored: async () => (JSON.parse(await fs.readFile(file, "utf8")) as { providers: { "openai-codex": { tokens: { access_token: string; refresh_token: string } } } }).providers["openai-codex"].tokens,
    };
  }

  /** The model refuses the old sign-in from its second request on; the sign-in service gives a new one (or refuses). */
  async function runSignedIn(options: { dir: string; renewal: "works" | "refused"; refuses?: (token: string, n: number) => boolean; beforeRequest?: (n: number) => Promise<void> }) {
    const model = scriptedModel("responses", (request) => (request.toolResults === 0 ? look() : { text: "Load is fine." }));
    const tokens: string[] = [];
    const renewals: string[] = [];
    const refuses = options.refuses ?? ((token: string, n: number) => n >= 2 && token === OLD);
    const send = (async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("/oauth/token")) {
        renewals.push(String(init?.body));
        return options.renewal === "works"
          ? new Response(JSON.stringify({ access_token: NEW, refresh_token: "refresh-new" }), { status: 200, headers: { "Content-Type": "application/json" } })
          : new Response(JSON.stringify({ error: "invalid_grant", error_description: "Refresh token expired" }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      const token = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /, "");
      tokens.push(token);
      await options.beforeRequest?.(tokens.length);
      if (refuses(token, tokens.length)) return new Response(JSON.stringify({ error: { message: "Your authentication token has expired." } }), { status: 401 });
      return model.fetch(url as string, init);
    }) as typeof fetch;
    const events: RunEvent[] = [];
    await new DirectAgentRuntime((async (req: { action: string }) => (req.action === "context" ? {} : { exitCode: 0, output: "load 0.1" })) as never, options.dir, send)
      .start(task(), { kind: "openai-codex", model: "gpt-6.1-sol" } as never, (event) => events.push(event));
    return { end: events.find((e) => /^run\.(completed|failed)$/.test(e.type)), tokens, renewals, model };
  }

  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it("is renewed once and the turn is asked again with the new sign-in", async () => {
    const { dir, stored } = await signedIn();
    const { end, tokens, renewals } = await runSignedIn({ dir, renewal: "works" });
    expect(end?.type).toBe("run.completed");
    expect(end?.output).toBe("Load is fine.");
    // The first turn, the refused second one, and the second one again with the new sign-in.
    expect(tokens).toEqual([OLD, OLD, NEW]);
    expect(renewals).toHaveLength(1);
    expect(renewals[0]).toContain("refresh_token=refresh-old");
    // The renewed sign-in is kept for the next run.
    expect(await stored()).toEqual({ access_token: NEW, refresh_token: "refresh-new" });
  });

  it("uses the sign-in another program has put in the file in the meantime, and renews nothing", async () => {
    const { dir, file } = await signedIn();
    const fs = await import("node:fs/promises");
    const { end, tokens, renewals } = await runSignedIn({
      dir,
      renewal: "refused",
      // Just before the second request another program (the Codex CLI) writes a new sign-in.
      beforeRequest: async (n) => {
        if (n === 2) await fs.writeFile(file, JSON.stringify({ version: 1, providers: { "openai-codex": { tokens: { access_token: NEW, refresh_token: "refresh-new" } } } }), "utf8");
      },
    });
    expect(end?.type).toBe("run.completed");
    expect(tokens).toEqual([OLD, OLD, NEW]);
    expect(renewals).toHaveLength(0);
  });

  it("fails with what to do when the sign-in cannot be renewed, or the renewed one is refused too", async () => {
    const first = await signedIn();
    const unrenewable = await runSignedIn({ dir: first.dir, renewal: "refused" });
    expect(unrenewable.end?.type).toBe("run.failed");
    expect(unrenewable.end?.error).toMatch(/^The ChatGPT sign-in was refused \(401\)\. Sign in again, or choose another model in AI settings\./);
    expect(unrenewable.renewals).toHaveLength(1);
    expect(unrenewable.tokens).toEqual([OLD, OLD]);

    const second = await signedIn();
    const stillRefused = await runSignedIn({ dir: second.dir, renewal: "works", refuses: (_token, n) => n >= 2 });
    expect(stillRefused.end?.type).toBe("run.failed");
    expect(stillRefused.end?.error).toMatch(/^The ChatGPT sign-in was refused \(401\)\./);
    // Renewed once, tried once more, and no further.
    expect(stillRefused.renewals).toHaveLength(1);
    expect(stillRefused.tokens).toEqual([OLD, OLD, NEW]);
  });
});

describe.each(PROTOCOLS)("a provider's rate limit that says when to ask again (%s)", (protocol) => {
  const limited = (ms: number): ScriptedStep => ({ status: 429, headers: { "retry-after-ms": String(ms) }, errorBody: '{"error":{"message":"Rate limit reached"}}' });
  afterEach(() => {
    retryPolicy.rateLimitMaxWaitMs = 300_000;
  });

  it("is waited out as long as the provider asks, more times than a passing failure is retried, and shown while it lasts", async () => {
    // No retries at all for passing failures in these tests: the waits below are not among them.
    expect(retryPolicy.attempts).toBe(0);
    const started = Date.now();
    const { end, events, model } = await run(protocol, (request) => (request.n <= 4 ? limited(40) : { text: "Load is fine." }));
    expect(end?.type).toBe("run.completed");
    expect(end?.output).toBe("Load is fine.");
    expect(model.requests).toHaveLength(5);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    const notices = events.filter((e) => e.type === "run.retrying");
    expect(notices).toHaveLength(4);
    expect(notices[0].text).toBe("Waiting for the provider's rate limit. Asking again in 1 second.");
  });

  it("gives up when the waits for one answer add up to more than a run waits, and says so", async () => {
    // Every wait counts as a second at least: the third would take the total past 2.5 seconds.
    retryPolicy.rateLimitMaxWaitMs = 2_500;
    const { end, model } = await run(protocol, () => limited(30));
    expect(model.requests).toHaveLength(3);
    expect(end?.type).toBe("run.failed");
    expect(end?.error).toMatch(
      /^The provider's rate limit asks to wait 1 second, after 2 seconds of waiting already\. A run waits 3 seconds at most for one answer\. Try again later, or choose another model in AI settings\. The provider said: .*\(429\).*Rate limit reached/,
    );
  });

  it("does not wait at all for a limit that asks for longer than a run waits", async () => {
    const started = Date.now();
    const { end, model } = await run(protocol, () => ({ status: 429, headers: { "retry-after": "3600" }, errorBody: "slow down" }));
    expect(model.requests).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(end?.error).toMatch(/^The provider's rate limit asks to wait 60 minutes\. A run waits 5 minutes at most for one answer\./);
  });
});

describe("what a provider's answer says about when to ask again", () => {
  it("is read from retry-after-ms, or retry-after in seconds or as a date", async () => {
    const { askedRetryDelayMs, plainDuration } = await import("../../src/main/ai/hub/DirectAgentRuntime");
    const now = Date.parse("2026-11-23T10:00:00Z");
    expect(askedRetryDelayMs(new Headers({ "retry-after": "45" }), now)).toBe(45_000);
    expect(askedRetryDelayMs(new Headers({ "retry-after": "0.5" }), now)).toBe(500);
    expect(askedRetryDelayMs(new Headers({ "retry-after-ms": "1250", "retry-after": "2" }), now)).toBe(1250);
    expect(askedRetryDelayMs(new Headers({ "retry-after": "Mon, 23 Nov 2026 10:01:30 GMT" }), now)).toBe(90_000);
    // A date that has passed means now; nothing said means nothing asked.
    expect(askedRetryDelayMs(new Headers({ "retry-after": "Mon, 23 Nov 2026 09:00:00 GMT" }), now)).toBe(0);
    expect(askedRetryDelayMs(new Headers({}), now)).toBeUndefined();
    expect(askedRetryDelayMs(new Headers({ "retry-after": "soon" }), now)).toBeUndefined();
    expect(plainDuration(45_000)).toBe("45 seconds");
    expect(plainDuration(125_000)).toBe("2 minutes 5 seconds");
    expect(plainDuration(60_000)).toBe("1 minute");
    expect(plainDuration(200)).toBe("1 second");
  });
});

describe("the reasoning effort that is set, with Anthropic", () => {
  it("is sent with every request of the run, and stays the same from turn to turn", async () => {
    const usual = await run("anthropic", (request) => (request.toolResults === 0 ? look() : { text: "Load is fine." }));
    expect(usual.model.requests.map((request) => request.body.output_config)).toEqual([{ effort: "medium" }, { effort: "medium" }]);

    // A command that fails in between does not change it: a change between turns would cost the prompt cache.
    const low = await run(
      "anthropic",
      (request) => (request.toolResults < 2 ? look(`step ${request.toolResults}`) : { text: "Done." }),
      { tuning: { reasoningEffort: "low" }, broker: () => ({ exitCode: 1, output: "command not found" }) },
    );
    expect(low.model.requests.map((request) => request.body.output_config)).toEqual([{ effort: "low" }, { effort: "low" }, { effort: "low" }]);

    // A plan asked for with /plan is thought about harder, for the whole run.
    const planned = await run("anthropic", () => ({ text: "Here is the plan." }), {
      task: task({ messages: [{ id: "m", role: "user", text: "/plan move the database", at: 1 }] }),
      tuning: { reasoningEffort: "low" },
    });
    expect(planned.model.requests[0].body.output_config).toEqual({ effort: "high" });
  });

  it("is left out for the rest of the run at a model or endpoint that refuses it", async () => {
    const { end, model } = await run("anthropic", (request) =>
      "output_config" in request.body
        ? { status: 400, errorBody: '{"type":"error","error":{"type":"invalid_request_error","message":"output_config.effort: this model does not support the effort parameter."}}' }
        : request.toolResults === 0 ? look() : { text: "Load is fine." });
    expect(end?.type).toBe("run.completed");
    expect(model.requests.map((request) => "output_config" in request.body)).toEqual([true, false, false]);
  });
});

describe.each(PROTOCOLS)("a conversation longer than what a run is given (%s)", (protocol) => {
  const long = (n: number) =>
    task({
      messages: Array.from({ length: n }, (_, i) => ({ id: `m${i}`, role: (i % 2 ? "assistant" : "user") as "assistant" | "user", text: `message number ${i + 1}`, at: i + 1 })),
    });

  it("is given its latest 30 messages, and a line first that says the earlier ones were left out", async () => {
    const { model } = await run(protocol, () => ({ text: "ok" }), { task: long(41) });
    const raw = model.requests[0].raw;
    expect(raw).toContain("[sshs3] This conversation is longer than what you are shown: its first 11 messages were left out. What follows are the latest 30.");
    expect(raw).not.toContain("message number 11\"");
    expect(raw).toContain("message number 12");
    expect(raw).toContain("message number 41");
    // The line comes before what it speaks of.
    expect(raw.indexOf("its first 11 messages were left out")).toBeLessThan(raw.indexOf("message number 12"));
    // With one message more than fits, it says so in the singular.
    const one = await run(protocol, () => ({ text: "ok" }), { task: long(31) });
    expect(one.model.requests[0].raw).toContain("its first 1 message was left out");
  });

  it("is given whole, with no such line, when it fits", async () => {
    const { model } = await run(protocol, () => ({ text: "ok" }), { task: long(29) });
    expect(model.requests[0].raw).not.toContain("left out");
    expect(model.requests[0].raw).toContain("message number 1\"");
  });
});

describe("Anthropic: how a conversation opens", () => {
  it("never opens on the assistant's own words", async () => {
    // Thirty kept messages of a conversation of 41 would begin with what the assistant said.
    const cut = await run("anthropic", () => ({ text: "ok" }), {
      task: task({ messages: Array.from({ length: 42 }, (_, i) => ({ id: `m${i}`, role: (i % 2 ? "assistant" : "user") as "assistant" | "user", text: `message number ${i + 1}`, at: i + 1 })) }),
    });
    expect(cut.model.requests[0].items[0].role).toBe("user");
    expect(JSON.stringify(cut.model.requests[0].items[1])).toContain("message number 13");
    expect(cut.model.requests[0].items[1].role).toBe("user");

    // A first question asked again: what the earlier try ran is given first, as the assistant's. A line of the user's goes before it.
    const again = await run("anthropic", () => ({ text: "ok" }), {
      task: task({
        messages: [{ id: "m", role: "user", text: "Why is nginx slow?", at: 100 }],
        toolLog: [{ name: "terminal_command", input: '{"command":"uptime"}', output: "load 0.1", at: 50 }],
      } as never),
    });
    expect(again.model.requests[0].items.map((item) => item.role)).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(again.model.requests[0].items[0])).toContain("[sshs3] The conversation so far:");
  });
});
