import { describe, expect, it } from "vitest";
import { KnowledgeBaseService, capMemories } from "../../src/main/ai/hub/KnowledgeBaseService";
import { SelfLearningService } from "../../src/main/ai/hub/SelfLearningService";
import { scopedMemory } from "../../src/main/ai/hub/ContextService";
import type { AgentTask, MemoryEntry } from "../../src/shared/types/aiHub";

/** What memory may claim, and what it keeps. From the review of feature 7. */

const kb = new KnowledgeBaseService();
const learning = new SelfLearningService(kb);
const failure = { command: "systemctl restart app", snippet: "Job for app.service failed", exitCode: 1, label: "web1" };

describe("learning from a failure", () => {
  it("keeps what merely succeeded next as a low-confidence note, never as a suggested skill", () => {
    const { learnedSkill, memories } = learning.learnFromCommandResolution({ memories: [], failure, fixCommand: "rm -rf /var/lib/app/state" });
    expect(learnedSkill).toMatchObject({ tier: "archival", successCount: 0 });
    expect(learnedSkill!.confidence).toBeLessThan(0.65);
    expect(learning.findBestLearnedCommand(memories, "app restart failed")).toBeUndefined();
  });

  it("keeps a proven fix as one, and a later unproven note does not overwrite it", () => {
    const proven = learning.learnFromCommandResolution({ memories: [], failure, fixCommand: "systemctl reset-failed app && systemctl start app", proven: true });
    expect(proven.learnedSkill).toMatchObject({ tier: "core", successCount: 1 });
    const after = learning.learnFromCommandResolution({ memories: proven.memories, failure, fixCommand: "rm -rf /var/lib/app/state" });
    const fix = after.memories.find((m) => m.id === proven.learnedSkill!.id)!;
    expect(fix.sourceCommand).toBe("systemctl reset-failed app && systemctl start app");
    expect(after.memories).toHaveLength(2);
  });
});

describe("tidying up every night", () => {
  it("reflects on a task once, so confidence and 'worked' do not climb with no new evidence", () => {
    const task = {
      id: "t1",
      title: "check disk",
      status: "completed",
      verification: "not-verified",
      changes: [{ id: "c", kind: "command", command: "df -h", status: "completed", exitCode: 0, target: "web1", description: "", at: 1 }],
      messages: [],
      sources: [],
    } as unknown as AgentTask;
    let memories: MemoryEntry[] = [];
    const counts: Array<[number | undefined, number | undefined]> = [];
    for (let i = 0; i < 4; i++) {
      memories = learning.runReflectionCycle({ memories, tasks: [task], activityLog: [], infraEdges: [], servers: [], lastFailures: {} }).memories;
      const playbook = memories.find((m) => m.title.startsWith("Playbook"));
      counts.push([playbook?.confidence, playbook?.successCount]);
    }
    expect(new Set(counts.map((c) => JSON.stringify(c))).size).toBe(1);
    expect(counts[0][0]).toBeLessThan(0.65);
  });
});

describe("what is kept", () => {
  it("never drops a person's or a personal memory to make room, and keeps long text", () => {
    const person = (i: number): MemoryEntry => ({ id: `p${i}`, kind: "memory", scope: "workspace", title: `note ${i}`, text: "x", updatedAt: i }) as MemoryEntry;
    const learned = (i: number): MemoryEntry => ({ ...person(i), id: `l${i}`, autoLearned: true });
    const all = [...Array.from({ length: 150 }, (_, i) => person(i)), ...Array.from({ length: 400 }, (_, i) => learned(i))];
    const kept = capMemories(all);
    expect(kept.filter((m) => !m.autoLearned)).toHaveLength(150);
    expect(kept.filter((m) => m.autoLearned)).toHaveLength(300);
    const long = "y".repeat(3000);
    expect(kb.deduplicateOrMergeMemory([], { kind: "skill", scope: "workspace", title: "long", text: long }).saved.text).toBe(long);
  });
});

describe("one vote each", () => {
  it("counts a person's vote once, changes it when they change their mind, and does not pin", () => {
    const m = { id: "m", kind: "memory", scope: "workspace", title: "t", text: "x", tier: "archival", confidence: 0.7, updatedAt: 1 } as MemoryEntry;
    let memories = [m];
    for (let i = 0; i < 5; i++) memories = learning.applyMemoryFeedback(memories, "m", 1, "jacob").memories;
    expect(memories[0]).toMatchObject({ feedbackScore: 1, tier: "archival" });
    expect(memories[0].successCount ?? 0).toBe(0);
    memories = learning.applyMemoryFeedback(memories, "m", 1, "erik").memories;
    memories = learning.applyMemoryFeedback(memories, "m", -1, "jacob").memories;
    expect(memories[0].feedbackScore).toBe(0);
  });
});

describe("which memories apply on a server", () => {
  it("matches a server by name exactly: web1 is not web10, prod is not nonprod-db", () => {
    const entries = [
      { id: "a", kind: "memory", scope: "server:prod", title: "a", text: "", updatedAt: 1 },
      { id: "b", kind: "memory", scope: "server:web1", title: "b", text: "", updatedAt: 1 },
    ] as MemoryEntry[];
    expect(scopedMemory(entries, "target:p1", false, { targetLabel: "nonprod-db" })).toEqual([]);
    expect(scopedMemory(entries, "target:p1", false, { targetLabel: "web10" })).toEqual([]);
    expect(scopedMemory(entries, "target:p1", false, { targetLabel: "web1" }).map((m) => m.id)).toEqual(["b"]);
  });
});
