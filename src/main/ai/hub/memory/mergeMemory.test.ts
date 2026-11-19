import { describe, expect, it } from "vitest";
import type { MemoryEntry } from "../../../../shared/types/aiHub";
import { capMemories, deduplicateOrMergeMemory, liveMemories } from "./mergeMemory";

const base = { kind: "memory" as const, scope: "workspace", title: "Postgres connections" };

it("merges similar notes within a scope and preserves the original author and evidence", () => {
  const first = deduplicateOrMergeMemory([], {
    ...base, id: "guide", text: "pool connection limit", author: "Alex", confidence: 0.9, successCount: 3,
  });
  const update = {
    ...base, title: "Postgres connections guide", text: "pool connection limit observed", author: "Robin", confidence: 0.6,
  };
  expect(deduplicateOrMergeMemory(first.memories, update)).toMatchObject({
    merged: true, saved: { id: "guide", author: "Alex", editedBy: "Robin", confidence: 0.9, successCount: 3 },
  });
  expect(deduplicateOrMergeMemory(first.memories, { ...update, scope: "personal" }).merged).toBe(false);
});

describe("a memory that a newer one replaces", () => {
  it("is kept as history with the newer one's id, and remains excluded from future matches", () => {
    const first = deduplicateOrMergeMemory([], { ...base, text: "max_connections is 150" });
    const second = deduplicateOrMergeMemory(first.memories, { ...base, id: first.saved.id, text: "max_connections is 300", supersede: true });
    expect(second.saved.id).not.toBe(first.saved.id);
    expect(second.superseded).toMatchObject({ id: first.saved.id, text: "max_connections is 150", supersededBy: second.saved.id });
    expect(second.superseded!.supersededAt).toBeTypeOf("number");
    expect(second.memories.map((m) => m.text)).toEqual(["max_connections is 300", "max_connections is 150"]);

    expect(liveMemories(second.memories)).toHaveLength(1);
    const third = deduplicateOrMergeMemory(second.memories, { ...base, text: "max_connections is 400", supersede: true });
    expect(third.superseded?.id).toBe(second.saved.id);
    expect(third.memories.filter((m) => !m.supersededBy).map((m) => m.text)).toEqual(["max_connections is 400"]);
  });

  it("is written over in place when nobody asked to keep history, or the text did not change", () => {
    const first = deduplicateOrMergeMemory([], { ...base, text: "max_connections is 150" });
    const edited = deduplicateOrMergeMemory(first.memories, { ...base, id: first.saved.id, text: "max_connections is 160" });
    expect(edited.saved.id).toBe(first.saved.id);
    expect(edited.memories).toHaveLength(1);
    const same = deduplicateOrMergeMemory(edited.memories, { ...base, id: first.saved.id, text: "max_connections is 160", supersede: true });
    expect(same.superseded).toBeUndefined();
    expect(same.memories).toHaveLength(1);
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

describe("what is kept", () => {
  it("never drops a person's or a personal memory to make room, and keeps long text", () => {
    const person = (i: number): MemoryEntry => ({ id: `p${i}`, kind: "memory", scope: "workspace", title: `note ${i}`, text: "x", updatedAt: i }) as MemoryEntry;
    const learned = (i: number): MemoryEntry => ({ ...person(i), id: `l${i}`, autoLearned: true });
    const all = [...Array.from({ length: 150 }, (_, i) => person(i)), ...Array.from({ length: 400 }, (_, i) => learned(i))];
    const kept = capMemories(all);
    expect(kept.filter((m) => !m.autoLearned)).toHaveLength(150);
    expect(kept.filter((m) => m.autoLearned)).toHaveLength(300);
    const long = "y".repeat(3000);
    expect(deduplicateOrMergeMemory([], { kind: "skill", scope: "workspace", title: "long", text: long }).saved.text).toBe(long);
  });
});
