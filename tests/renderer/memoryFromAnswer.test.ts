import { describe, expect, it } from "vitest";
import { memoryFromAnswer } from "../../src/renderer/src/components/AiHub/panel/memoryFromAnswer";

/**
 * "Save to team memory" on an answer keeps it for the team and for later runs. In the lab the entry got
 * the question as its title cut mid-word ("... One shor"), and kept the answer's "[c1]", which points at a
 * command of that one conversation and means nothing anywhere else.
 */
describe("a memory saved from an answer", () => {
  it("is titled by the conversation, cut at a whole word", () => {
    const { title } = memoryFromAnswer(
      "Answer in one short sentence: what version of nginx runs on web-01, and how many worker processes?",
      "nginx 1.24.0, with 4 workers.",
    );
    expect(title).toBe("Answer in one short sentence: what version of nginx runs on…");
    expect(memoryFromAnswer("Disk use on db-01", "x").title).toBe("Disk use on db-01");
    expect(memoryFromAnswer(undefined, "x").title).toBe("From an AI conversation");
    expect(memoryFromAnswer("   ", "x").title).toBe("From an AI conversation");
  });

  it("keeps what the answer says, without the references to that conversation's commands", () => {
    expect(memoryFromAnswer("t", "web-01 runs nginx 1.24.0 [c1], with 4 workers [c1, c3].").text).toBe(
      "web-01 runs nginx 1.24.0, with 4 workers.",
    );
    // A link or an array in a code block is not a reference.
    expect(memoryFromAnswer("t", "See [the runbook](https://wiki/x) and `a[c1]`.").text).toBe("See [the runbook](https://wiki/x) and `a[c1]`.");
  });

  it("is cut at a whole word when the answer is long", () => {
    const text = memoryFromAnswer("t", `${"word ".repeat(400)}end`).text;
    expect(text.length).toBeLessThanOrEqual(1200);
    expect(text.endsWith("word…")).toBe(true);
  });
});
