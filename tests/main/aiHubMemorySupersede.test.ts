import { describe, expect, it } from "vitest";
import { KnowledgeBaseService, capMemories, liveMemories } from "../../src/main/ai/hub/KnowledgeBaseService";
import { SelfLearningService } from "../../src/main/ai/hub/SelfLearningService";
import { scopedMemory } from "../../src/main/ai/hub/ContextService";
import type { MemoryEntry } from "../../src/shared/types/aiHub";

const kb = new KnowledgeBaseService();
const learning = new SelfLearningService(kb);
const failure = { command: "systemctl restart app", snippet: "Job for app.service failed", exitCode: 1, label: "web1" };
const base = { kind: "memory" as const, scope: "workspace", title: "Postgres connections" };

describe("a memory that a newer one replaces", () => {
  it("is kept as history with the newer one's id, and is hidden from agents and search", () => {
    const first = kb.deduplicateOrMergeMemory([], { ...base, text: "max_connections is 150" });
    const second = kb.deduplicateOrMergeMemory(first.memories, { ...base, id: first.saved.id, text: "max_connections is 300", supersede: true });
    expect(second.saved.id).not.toBe(first.saved.id);
    expect(second.superseded).toMatchObject({ id: first.saved.id, text: "max_connections is 150", supersededBy: second.saved.id });
    expect(second.superseded!.supersededAt).toBeTypeOf("number");
    expect(second.memories.map((m) => m.text)).toEqual(["max_connections is 300", "max_connections is 150"]);

    // Not given to an agent, not found by search, not matched by the next save.
    expect(scopedMemory(second.memories, "workspace", false).map((m) => m.id)).toEqual([second.saved.id]);
    expect(kb.rankMemories(second.memories, "max_connections").map((m) => m.id)).toEqual([second.saved.id]);
    expect(liveMemories(second.memories)).toHaveLength(1);
    const third = kb.deduplicateOrMergeMemory(second.memories, { ...base, text: "max_connections is 400", supersede: true });
    expect(third.superseded?.id).toBe(second.saved.id);
    expect(third.memories.filter((m) => !m.supersededBy).map((m) => m.text)).toEqual(["max_connections is 400"]);
  });

  it("is written over in place when nobody asked to keep history, or the text did not change", () => {
    const first = kb.deduplicateOrMergeMemory([], { ...base, text: "max_connections is 150" });
    const edited = kb.deduplicateOrMergeMemory(first.memories, { ...base, id: first.saved.id, text: "max_connections is 160" });
    expect(edited.saved.id).toBe(first.saved.id);
    expect(edited.memories).toHaveLength(1);
    const same = kb.deduplicateOrMergeMemory(edited.memories, { ...base, id: first.saved.id, text: "max_connections is 160", supersede: true });
    expect(same.superseded).toBeUndefined();
    expect(same.memories).toHaveLength(1);
  });

  it("keeps the old proven fix as history when a different fix is proven for the same error", () => {
    const a = learning.learnFromCommandResolution({ memories: [], failure, fixCommand: "systemctl reset-failed app && systemctl start app", proven: true });
    // The same fix again is the same advice: no history.
    const again = learning.learnFromCommandResolution({ memories: a.memories, failure: { ...failure, snippet: "Job for app.service failed again" }, fixCommand: "systemctl reset-failed app && systemctl start app", proven: true });
    expect(again.memories.filter((m) => m.supersededBy)).toHaveLength(0);
    const b = learning.learnFromCommandResolution({ memories: again.memories, failure, fixCommand: "systemctl daemon-reload && systemctl start app", proven: true });
    const live = b.memories.filter((m) => !m.supersededBy);
    expect(live).toHaveLength(1);
    expect(live[0].sourceCommand).toBe("systemctl daemon-reload && systemctl start app");
    expect(b.memories.find((m) => m.id === a.learnedSkill!.id)).toMatchObject({ supersededBy: live[0].id, sourceCommand: "systemctl reset-failed app && systemctl start app" });
  });

  it("is the first to go when the store is full, whoever wrote it", () => {
    const entry = (i: number, extra: Partial<MemoryEntry>): MemoryEntry =>
      ({ id: `m${i}`, kind: "memory", scope: "workspace", title: `t${i}`, text: "x", updatedAt: i, ...extra }) as MemoryEntry;
    const learned = Array.from({ length: 290 }, (_, i) => entry(i, { autoLearned: true }));
    const history = Array.from({ length: 20 }, (_, i) => entry(1000 + i, { supersededBy: "m0" }));
    const kept = capMemories([...learned, ...history]);
    expect(kept.filter((m) => m.autoLearned && !m.supersededBy)).toHaveLength(290);
    // Room for ten more learned entries: the ten newest of the history stay.
    expect(kept.filter((m) => m.supersededBy).map((m) => m.id)).toEqual(history.slice(0, 10).map((m) => m.id));
    const full = capMemories([...Array.from({ length: 300 }, (_, i) => entry(i, { autoLearned: true })), ...history]);
    expect(full.filter((m) => m.supersededBy)).toHaveLength(0);
    expect(full).toHaveLength(300);
  });
});
