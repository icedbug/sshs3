import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DirectAgentRuntime, resetCircuitBreakers, retryPolicy } from "../../src/main/ai/hub/DirectAgentRuntime";
import { HANDOVER_REQUEST } from "../../src/main/ai/hub/AgentDiscipline";
import type { RunEvent } from "../../src/main/ai/hub/AgentRuntime";
import { CONTEXT_WINDOW_CHOICES, DEFAULT_CONTEXT_WINDOW, tooSmallForAgents } from "../../src/shared/contextWindow";
import type { AgentTask } from "../../src/shared/types/aiHub";
import { scriptedModel, type ScriptedStep } from "../helpers/scriptedModel";

/**
 * The AI settings offer a list of context windows. Every one of them has to hold an acting agent:
 * its tool list and instructions take a little over 18,000 tokens before the conversation, and a
 * window that cannot hold them ends the run at once. 16k was on the list and could not.
 */

const task = (): AgentTask =>
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
  }) as unknown as AgentTask;

const NOTE = "Goal: find why nginx is slow. Found so far: upstream timeouts in the error log, worker_connections at 512. ".repeat(14);

/** An agent that looks with one command a turn, writes its note when asked, and answers after `calls` commands. */
async function run(windowTokens: number, calls: number): Promise<{ kinds: string; end: RunEvent | undefined; requests: number }> {
  const kinds: string[] = [];
  let made = 0;
  const model = scriptedModel(
    "chat",
    (request): ScriptedStep => {
      if (request.last.includes(HANDOVER_REQUEST.slice(8, 60))) {
        kinds.push("n");
        return { text: NOTE };
      }
      if (made >= calls) {
        kinds.push("a");
        return { text: "It was the upstream pool." };
      }
      kinds.push("t");
      made++;
      return { calls: [{ name: "terminal_command", args: { command: `journalctl -u nginx --since -${made}h | tail -40`, description: `look ${made}` } }] };
    },
    { maxRequests: 150 },
  );
  const broker = async (req: { action: string }) =>
    req.action === "context"
      ? { workspaceServers: [{ name: "web-01", host: "10.0.0.5" }] }
      : { exitCode: 0, ref: `c${made}`, output: `line ${made} `.padEnd(1800, "x upstream timed out (110: Connection timed out) while reading response header ") };
  const events: RunEvent[] = [];
  const direct = new DirectAgentRuntime(broker as never, undefined, model.fetch);
  await direct.start(task(), model.config({ contextWindowTokens: windowTokens }), (event) => events.push(event));
  return { kinds: kinds.join(""), end: events.find((e) => /^run\.(completed|failed|cancelled)$/.test(e.type)), requests: model.requests.length };
}

describe("the context windows the AI settings offer", () => {
  beforeEach(() => {
    retryPolicy.attempts = 0;
    retryPolicy.baseDelayMs = 1;
    resetCircuitBreakers();
  });
  afterEach(() => {
    retryPolicy.attempts = 3;
    retryPolicy.baseDelayMs = 1000;
  });

  it("are in rising order, hold the default, and do not hold 16k", () => {
    expect([...CONTEXT_WINDOW_CHOICES].sort((a, b) => a - b)).toEqual([...CONTEXT_WINDOW_CHOICES]);
    expect(CONTEXT_WINDOW_CHOICES).toContain(DEFAULT_CONTEXT_WINDOW);
    expect(CONTEXT_WINDOW_CHOICES).not.toContain(16384);
    expect(tooSmallForAgents(16384)).toBe(true);
    expect(tooSmallForAgents(CONTEXT_WINDOW_CHOICES[0])).toBe(false);
  });

  it("an agent works in the smallest one: it runs its commands, writes notes in between and answers", async () => {
    const { kinds, end } = await run(CONTEXT_WINDOW_CHOICES[0], 24);
    expect(end?.type).toBe("run.completed");
    expect(end?.output).toBe("It was the upstream pool.");
    expect(kinds.match(/t/g)).toHaveLength(24);
    // Never a note right after a note: every one follows new work.
    expect(kinds).not.toMatch(/nn/);
  }, 60_000);

  it("an agent cannot start in 16k, the choice that was taken out: no request is made", async () => {
    const { end, requests } = await run(16384, 3);
    expect(requests).toBe(0);
    expect(end?.type).toBe("run.failed");
    expect(end?.error).toMatch(/^This conversation does not fit in the context window that is set \(16,384 tokens\)\./);
  }, 60_000);
});
