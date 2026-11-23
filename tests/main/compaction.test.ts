import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DirectAgentRuntime,
  IMAGE_CHARS,
  MAX_TIGHT_HANDOVERS,
  resetCircuitBreakers,
  retryPolicy,
  transcriptChars,
} from "../../src/main/ai/hub/DirectAgentRuntime";
import { HANDOVER_REQUEST } from "../../src/main/ai/hub/AgentDiscipline";
import type { RunEvent } from "../../src/main/ai/hub/AgentRuntime";
import type { AgentTask } from "../../src/shared/types/aiHub";
import { PROTOCOLS, scriptedModel, type Protocol, type ScriptedRequest, type ScriptedStep } from "../helpers/scriptedModel";

/**
 * When a run asks itself for a handover note, and when it gives up instead.
 *
 * A review found that a run whose starting point was already over the compaction limit wrote note
 * after note, each a paid request, and never worked again. Three things set it off: a screenshot in
 * the conversation (its bytes were counted as text), a small context window (the tool list alone
 * is over the smallest limit) and a medium window with long earlier messages.
 */

type Tuning = { compactAtChars: number; windowChars: number; contextWindowTokens: number };
type Due = (transcript: unknown[], baseLength: number, fixedChars: number, tuning: Tuning) => boolean;

function runtime(): { due: Due; finish: (note: string) => string; state: () => string; results: (n: number) => void; noTools: () => void } {
  const r = new DirectAgentRuntime({} as never) as unknown as {
    handoverDue: Due;
    finishCompaction: (note: string) => string;
    compaction: string;
    discipline: unknown;
    runCalls: unknown[];
    resultsSinceHandover: number;
    offered: Set<string>;
  };
  r.discipline = { todos: [], hypotheses: [] };
  r.runCalls = [];
  r.offered = new Set(["terminal_command"]);
  return {
    due: r.handoverDue.bind(r),
    finish: r.finishCompaction.bind(r),
    state: () => r.compaction,
    results: (n) => { r.resultsSinceHandover += n; },
    noTools: () => { r.offered = new Set(); },
  };
}

const big = (n: number) => ({ role: "user", content: "x".repeat(n) });
const tuning = (compactAtChars: number, windowChars = 2_000_000): Tuning => ({ compactAtChars, windowChars, contextWindowTokens: windowChars / 4 });

describe("asking a run for a handover note", () => {
  it("does not ask when only the conversation it started from is too big: a note could not make that smaller", () => {
    const { due, results } = runtime();
    results(1);
    // The run has barely grown: no note, however big the start is.
    expect(due([big(400_000), big(500)], 1, 0, tuning(100_000))).toBe(false);
  });

  it("asks once the run has grown past the limit, and then not until it has added enough again", () => {
    const { due, finish, state, results } = runtime();
    const start = [big(1000)];
    results(3);
    expect(due([...start, big(120_000)], 1, 0, tuning(100_000))).toBe(true);
    expect(state()).toBe("asked");
    const handover = { role: "user", content: finish("n".repeat(5_000)) };
    // Right after a note the run continues from the start plus the handover: nothing new, nothing asked.
    expect(due([...start, handover], 1, 0, tuning(100_000))).toBe(false);
    // The handover does not count as growth of its own, even when it is long and the start is over the limit.
    results(1);
    expect(due([big(200_000), { role: "user", content: finish("n".repeat(30_000)) }, big(2_000)], 1, 0, tuning(100_000))).toBe(false);
  });

  it("does not ask for a second note before a tool has returned something new", () => {
    const { due, finish, results } = runtime();
    results(2);
    expect(due([big(200_000), big(20_000)], 1, 0, tuning(100_000))).toBe(true);
    const handover = { role: "user", content: finish("note") };
    // Plenty added since (a long message from the person), but no tool result: a note would record nothing.
    expect(due([big(200_000), handover, big(60_000)], 1, 0, tuning(100_000))).toBe(false);
    results(1);
    expect(due([big(200_000), handover, big(60_000)], 1, 0, tuning(100_000))).toBe(true);
  });

  it("counts the tool definitions and instructions sent with every call toward the limit", () => {
    const { due, results } = runtime();
    results(1);
    expect(due([big(1000), big(60_000)], 1, 0, tuning(100_000))).toBe(false);
    expect(due([big(1000), big(60_000)], 1, 50_000, tuning(100_000))).toBe(true);
  });

  it("counts an image as a picture, not as the bytes of its data", () => {
    const data = "iVBORw0KGgoAAAANSUhEUgAA".repeat(12_500);
    const openAi = [{ role: "user", content: [{ type: "text", text: "see" }, { type: "image_url", image_url: { url: `data:image/png;base64,${data}` } }] }];
    const responses = [{ type: "message", role: "user", content: [{ type: "input_text", text: "see" }, { type: "input_image", image_url: `data:image/png;base64,${data}` }] }];
    const anthropic = [{ role: "user", content: [{ type: "text", text: "see" }, { type: "image", source: { type: "base64", media_type: "image/png", data } }] }];
    for (const transcript of [openAi, responses, anthropic]) {
      expect(JSON.stringify(transcript).length).toBeGreaterThan(300_000);
      const counted = transcriptChars(transcript);
      expect(counted).toBeGreaterThan(IMAGE_CHARS);
      expect(counted).toBeLessThan(IMAGE_CHARS + 400);
    }
    // Text that merely looks long is still counted in full.
    expect(transcriptChars([big(50_000)])).toBeGreaterThan(50_000);
  });

  it("ends the run instead of asking when the window cannot hold what no note can shrink", () => {
    const { due, noTools } = runtime();
    expect(() => due([big(70_000)], 1, 0, tuning(40_000, 64_000))).toThrow(
      /does not fit in the context window that is set \(16,000 tokens\)\. The tools and the conversation so far take an estimated 18,000 tokens before the agent has done anything, which leaves no room to work in\./,
    );
    // A run without tools is one request: it is sent, and the provider decides whether it fits.
    noTools();
    expect(due([big(70_000)], 1, 0, tuning(40_000, 64_000))).toBe(false);
  });
});

// ------------------------------------------------------------------ whole runs, on all three protocols

const NOTE = "Goal: find why nginx is slow. Found so far: upstream timeouts in the error log, worker_connections at 512. ".repeat(14);

function task(extra: Partial<AgentTask> = {}): AgentTask {
  return {
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
  } as AgentTask;
}

/** A model that looks with one command per turn, writes the note when asked, and answers after `calls` commands. */
async function run(
  protocol: Protocol,
  options: { task: AgentTask; windowTokens?: number; calls: number; outputChars?: number },
): Promise<{ kinds: string; end: RunEvent | undefined; requests: ScriptedRequest[] }> {
  const kinds: string[] = [];
  let made = 0;
  const model = scriptedModel(protocol, (request): ScriptedStep => {
    if (request.last.includes(HANDOVER_REQUEST.slice(8, 60))) {
      kinds.push("n");
      return { text: NOTE };
    }
    if (made >= options.calls) {
      kinds.push("a");
      return { text: "It was the upstream pool." };
    }
    kinds.push("t");
    made++;
    return { calls: [{ name: "terminal_command", args: { command: `journalctl -u nginx --since -${made}h | tail -40`, description: `look ${made}` } }] };
  }, { maxRequests: 150 });
  const broker = async (req: { action: string }) =>
    req.action === "context"
      ? { workspaceServers: [{ name: "web-01", host: "10.0.0.5" }] }
      : { exitCode: 0, ref: `c${made}`, output: `line ${made} `.padEnd(options.outputChars ?? 1800, "x upstream timed out (110: Connection timed out) while reading response header ") };
  const events: RunEvent[] = [];
  const direct = new DirectAgentRuntime(broker as never, undefined, model.fetch);
  await direct.start(
    options.task,
    model.config(options.windowTokens ? { contextWindowTokens: options.windowTokens } : undefined),
    (event) => events.push(event),
  );
  return { kinds: kinds.join(""), end: events.find((e) => /^run\.(completed|failed|cancelled)$/.test(e.type)), requests: model.requests };
}

const screenshot = () =>
  task({
    messages: [{
      id: "m", role: "user", text: "Why is nginx slow on web-01? Screenshot attached.", at: 100,
      images: [{ label: "grafana.png", mimeType: "image/png", dataUrl: "data:image/png;base64," + "iVBORw0KGgoAAAANSUhEUgAA".repeat(12_500) }],
    }],
  } as never);

const longHistory = () =>
  task({
    messages: [
      ...Array.from({ length: 6 }, (_, i) => ({
        id: `h${i}`,
        role: (i % 2 ? "assistant" : "user") as "assistant" | "user",
        text: `earlier ${i} `.padEnd(14_000, "what we looked at before and what it showed. "),
        at: i + 1,
      })),
      { id: "m", role: "user" as const, text: "Why is nginx slow on web-01?", at: 100 },
    ],
  });

describe.each(PROTOCOLS)("a run that starts over the compaction limit (%s)", (protocol) => {
  beforeEach(() => {
    retryPolicy.attempts = 0;
    retryPolicy.baseDelayMs = 1;
    resetCircuitBreakers();
  });
  afterEach(() => {
    retryPolicy.attempts = 3;
    retryPolicy.baseDelayMs = 1000;
  });

  it("works on with a 300 KB screenshot in the conversation at the default window: no note is asked for", async () => {
    const { kinds, end } = await run(protocol, { task: screenshot(), calls: 30 });
    expect(end?.type).toBe("run.completed");
    expect(end?.output).toBe("It was the upstream pool.");
    expect(kinds).toBe(`${"t".repeat(30)}a`);
  }, 60_000);

  it("ends at once, before any paid request, when the window that is set cannot hold the tool list and the conversation", async () => {
    const { kinds, end, requests } = await run(protocol, { task: task(), windowTokens: 16_000, calls: 30 });
    expect(requests).toHaveLength(0);
    expect(kinds).toBe("");
    expect(end?.type).toBe("run.failed");
    expect(end?.error).toMatch(/^This conversation does not fit in the context window that is set \(16,000 tokens\)\./);
    expect(end?.error).toMatch(/Raise the context window in AI settings, choose a model with a larger one, or start a new conversation\.$/);
  }, 60_000);

  it("counts the instructions as well as the tool list, in every protocol", async () => {
    // The tool list is about 64,500 characters and the instructions about 8,000. A window of 19,000
    // tokens (76,000 characters) holds the tool list and the least a run needs (8,000), but not the
    // instructions on top: only a loop that counts them sees that the window is too small.
    const { end, requests } = await run(protocol, { task: task(), windowTokens: 19_000, calls: 3 });
    expect(requests).toHaveLength(0);
    expect(end?.type).toBe("run.failed");
    expect(end?.error).toMatch(/does not fit in the context window that is set \(19,000 tokens\)\. The tools and the conversation so far take an estimated 1[89],000 tokens before the agent has done anything, which leaves no room to work in\./);
  }, 60_000);

  it("keeps working in a 48k window, where the tool list alone is near the limit: a note only after new work, never two in a row", async () => {
    const { kinds, end } = await run(protocol, { task: task(), windowTokens: 48_000, calls: 40 });
    expect(end?.type).toBe("run.completed");
    expect(kinds.endsWith("a")).toBe(true);
    expect(kinds.match(/t/g)).toHaveLength(40);
    expect(kinds).not.toMatch(/nn/);
    // Every note follows at least two commands, and notes stay a small share of what is paid for.
    expect(kinds).not.toMatch(/(^|n)t?n/);
    expect((kinds.match(/n/g) ?? []).length).toBeLessThanOrEqual(10);
  }, 60_000);

  it("keeps working in a 64k window with six long earlier messages", async () => {
    const { kinds, end } = await run(protocol, { task: longHistory(), windowTokens: 64_000, calls: 40 });
    expect(end?.type).toBe("run.completed");
    expect(kinds.match(/t/g)).toHaveLength(40);
    expect(kinds).not.toMatch(/nn/);
    expect(kinds).not.toMatch(/(^|n)t?n/);
    expect((kinds.match(/n/g) ?? []).length).toBeLessThanOrEqual(10);
  }, 60_000);

  it("ends with a plain message when every step fills the window again, instead of paying for a note after each one", async () => {
    const { kinds, end } = await run(protocol, { task: longHistory(), windowTokens: 64_000, calls: 40, outputChars: 30_000 });
    expect(end?.type).toBe("run.failed");
    expect(end?.error).toMatch(/^This run stopped because the context window that is set \(64,000 tokens\) is too small to work in: after every step the agent had to write its notes again\./);
    // One command, one note, and so on: stopped where the next note would have been the third in a row.
    expect(kinds).toBe("tn".repeat(MAX_TIGHT_HANDOVERS - 1) + "t");
  }, 60_000);
});
