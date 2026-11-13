import { describe, expect, it } from "vitest";
import { DirectAgentRuntime } from "../../src/main/ai/hub/DirectAgentRuntime";

/**
 * When a run asks itself for a handover note. The review found that a run
 * whose starting conversation was already over the limit asked for a note on
 * every turn until it ran out of turns, and streamed each note into the chat.
 */

type Due = (transcript: unknown[], baseLength: number, fixedChars: number, limit: number) => boolean;

function runtime(): { due: Due; finish: (note: string) => string; state: () => string } {
  const r = new DirectAgentRuntime({} as never) as unknown as {
    handoverDue: Due;
    finishCompaction: (note: string) => string;
    compaction: string;
    discipline: unknown;
    runCalls: unknown[];
  };
  r.discipline = { todos: [], hypotheses: [] };
  r.runCalls = [];
  return { due: r.handoverDue.bind(r), finish: r.finishCompaction.bind(r), state: () => r.compaction };
}

const big = (n: number) => ({ role: "user", content: "x".repeat(n) });

describe("asking a run for a handover note", () => {
  it("does not ask when only the conversation it started from is too big: a note could not make that smaller", () => {
    const { due } = runtime();
    const start = [big(400_000)];
    // The run has barely grown: no note, however big the start is.
    expect(due([...start, big(500)], 1, 0, 100_000)).toBe(false);
  });

  it("asks once the run itself has grown past the limit, and not again until it has grown well past the last note", () => {
    const { due, finish, state } = runtime();
    const start = [big(1000)];
    expect(due([...start, big(120_000)], 1, 0, 100_000)).toBe(true);
    expect(state()).toBe("asked");
    finish("n".repeat(5_000));
    // Right after a note, the transcript is the start plus the note: not asked again.
    expect(due([...start, big(5_000)], 1, 0, 100_000)).toBe(false);
  });

  it("counts the tool definitions sent with every call toward the limit", () => {
    const { due } = runtime();
    expect(due([big(1000), big(60_000)], 1, 0, 100_000)).toBe(false);
    expect(due([big(1000), big(60_000)], 1, 50_000, 100_000)).toBe(true);
  });
});
