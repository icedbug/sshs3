import { describe, expect, it } from "vitest";
import type { AgentTask } from "../../src/shared/types/aiHub";
import {
  HYPOTHESIS_TOOL,
  continuationMessage,
  newDiscipline,
  operatingInstructions,
  parseHypotheses,
} from "../../src/main/ai/hub/AgentDiscipline";
import { toolsForTask } from "../../src/main/ai/hub/DirectAgentRuntime";
import { taskTranscript } from "../../src/main/ai/hub/MemoryDistiller";

const task = (extra: Partial<AgentTask> = {}): AgentTask =>
  ({ id: "t", title: "Slow", mode: "assisted", status: "running", messages: [], changes: [], sources: [], ...extra }) as unknown as AgentTask;

describe("the hypotheses of an investigation", () => {
  it("takes the list, keeps parents that exist, and refuses a verdict without evidence for it", () => {
    const ok = parseHypotheses({
      hypotheses: [
        { id: "h1", text: "A scrub runs at the same time", status: "confirmed", evidence: [{ supports: true, text: "zpool status shows scrub in progress since 01:00" }] },
        { id: "h2", text: "The snapshot quota is full", status: "ruled-out", evidence: [{ supports: false, text: "zfs get quota: 40% used" }] },
        { id: "h3", text: "The scrub was moved by last week's change", status: "open", parent: "h1" },
        { id: "h4", text: "Orphan", status: "open", parent: "nope" },
      ],
    });
    expect("hypotheses" in ok && ok.hypotheses.map((h) => [h.id, h.status, h.parentId])).toEqual([
      ["h1", "confirmed", undefined],
      ["h2", "ruled-out", undefined],
      ["h3", "open", "h1"],
      ["h4", "open", undefined],
    ]);
    expect(parseHypotheses({ hypotheses: [{ id: "h1", text: "It is the disk", status: "confirmed" }] })).toEqual({ error: expect.stringContaining("confirmed without evidence") });
    expect(parseHypotheses({ hypotheses: [{ id: "h1", text: "It is the disk", status: "ruled-out", evidence: [{ supports: true, text: "x" }] }] })).toEqual({ error: expect.stringContaining("ruled-out without evidence against") });
    expect(parseHypotheses({ hypotheses: [{ id: "a", text: "x", status: "open" }, { id: "a", text: "y", status: "open" }] })).toEqual({ error: expect.stringContaining("share the id") });
    expect(parseHypotheses({})).toEqual({ error: expect.any(String) });
  });

  it("sends the agent back once when it wants to stop with open hypotheses or with none confirmed", () => {
    const state = newDiscipline();
    expect(continuationMessage(state)).toBeUndefined();
    state.hypotheses = [
      { id: "h1", text: "A scrub runs at the same time", status: "open", evidence: [] },
      { id: "h2", text: "Quota full", status: "ruled-out", evidence: [{ supports: false, text: "40%" }] },
    ];
    const nudge = continuationMessage(state)!;
    expect(nudge).toContain("- A scrub runs at the same time");
    expect(nudge).toContain("No hypothesis is confirmed. Do not present a cause as found");
    // Asked once; a run can always end.
    expect(continuationMessage(state)).toBeUndefined();
    const settled = newDiscipline();
    settled.hypotheses = [{ id: "h1", text: "Scrub", status: "confirmed", evidence: [{ supports: true, text: "seen" }] }];
    expect(continuationMessage(settled)).toBeUndefined();
  });

  it("gives every normal run the list, and an investigator a terminal only for looking", () => {
    const names = (t: AgentTask): string[] => toolsForTask(t).map((x) => x.name);
    expect(names(task({ target: { sessionId: "s", generation: "g", label: "host" } }))).toContain(HYPOTHESIS_TOOL.name);
    const investigator = task({ mode: "advice", workforceRunId: "inv-1", investigator: true, target: { sessionId: "s", generation: "g", label: "host" } });
    expect(names(investigator).sort()).toEqual(["sshs3_kb_search", "sshs3_storage_ops", "terminal_command", "workspace_context"]);
    // Without a terminal of its own it cannot run anything.
    expect(names(task({ mode: "advice", workforceRunId: "inv-1", investigator: true }))).not.toContain("terminal_command");
    expect(names(task({ mode: "advice", workforceRunId: "wf-1" }))).not.toContain("terminal_command");
    expect(operatingInstructions({ mode: "assisted", target: null, thorough: false, planFirst: false, agentSection: [] })).toContain("An investigation is a search among possible causes");
  });

  it("hands what was confirmed and what was a red herring on to learning", () => {
    const text = taskTranscript(
      task({
        status: "completed",
        messages: [{ id: "m", role: "user", text: "Why is the backup slow?", at: 1 }],
        hypotheses: [
          { id: "h1", text: "A scrub runs at the same time", status: "confirmed", evidence: [{ supports: true, text: "zpool status: scrub in progress" }] },
          { id: "h2", text: "Quota full", status: "ruled-out", evidence: [{ supports: false, text: "40% used" }] },
        ],
      } as Partial<AgentTask>),
    );
    expect(text).toContain("- [confirmed] A scrub runs at the same time");
    expect(text).toContain("for: zpool status: scrub in progress");
    expect(text).toContain("- [ruled-out] Quota full");
    expect(text).toContain("against: 40% used");
  });
});
