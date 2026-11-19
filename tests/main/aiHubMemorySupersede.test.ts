import { describe, expect, it } from "vitest";
import { KnowledgeBaseService } from "../../src/main/ai/hub/KnowledgeBaseService";
import { SelfLearningService } from "../../src/main/ai/hub/SelfLearningService";
import { scopedMemory } from "../../src/main/ai/hub/ContextService";

const kb = new KnowledgeBaseService();
const learning = new SelfLearningService(kb);
const failure = { command: "systemctl restart app", snippet: "Job for app.service failed", exitCode: 1, label: "web1" };
const base = { kind: "memory" as const, scope: "workspace", title: "Postgres connections" };

describe("a memory that a newer one replaces", () => {
  it("keeps replaced memories out of agent context and ranking through the knowledge service", () => {
    const first = kb.deduplicateOrMergeMemory([], { ...base, text: "max_connections is 150" });
    const second = kb.deduplicateOrMergeMemory(first.memories, { ...base, id: first.saved.id, text: "max_connections is 300", supersede: true });
    expect(scopedMemory(second.memories, "workspace", false).map((m) => m.id)).toEqual([second.saved.id]);
    expect(kb.rankMemories(second.memories, "max_connections").map((m) => m.id)).toEqual([second.saved.id]);
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
});
