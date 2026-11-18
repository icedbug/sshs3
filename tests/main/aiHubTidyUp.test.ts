import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MemoryEntry } from "../../src/shared/types/aiHub";

/**
 * "Tidy up" in the team memory says what it did: what it wrote or changed straight away, and what it
 * left as a suggestion for a person. Nothing is changed without the answer saying so.
 */

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
});

async function hub() {
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-tidy-"));
  const service = new HubService(
    { changed: () => {}, inventoryTargets: async () => [], backgroundChanged: async () => {}, openSchedule: async () => "s1", show: () => {}, aiConfigFilePath: path.join(dir, "ai.json") } as never,
    dir,
  );
  disposals.push(async () => {
    await service.dispose();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await service.initialize();
  return service;
}

const recurring = (over: Partial<MemoryEntry> = {}): MemoryEntry =>
  ({
    id: "mem-recurring",
    kind: "memory",
    tier: "episodic",
    scope: "workspace",
    title: "Recent activity on web-01",
    text: "The upstream pool on web-01 is drained before a reload, then put back.",
    author: "Maria Ek",
    createdAt: 1,
    updatedAt: 2,
    updatedCount: 3,
    ...over,
  }) as MemoryEntry;

describe("Tidy up says what it did", () => {
  it("says that it found nothing when there is nothing to tidy", async () => {
    const service = await hub();
    const snap = await service.request({ action: "self-learn-reflect" });
    expect(snap.reply?.notes).toEqual(["Tidy up found nothing to change."]);
  });

  it("names what it changed straight away and counts what waits for a person", async () => {
    const service = await hub();
    service.store.data.memories.push(recurring());
    const before = service.store.data.memories.find((m) => m.id === "mem-recurring")!.text;
    const waitingBefore = (service.store.data.memoryProposals ?? []).filter((p) => !p.appliedMemoryId).length;

    const snap = await service.request({ action: "self-learn-reflect" });
    const notes = snap.reply!.notes!;
    const after = service.store.data.memories.find((m) => m.id === "mem-recurring");
    const changed = !after || after.text !== before || after.tier !== "episodic";
    const waiting = (service.store.data.memoryProposals ?? []).filter((p) => !p.appliedMemoryId).length - waitingBefore;

    // Something recurring was there, so something was done or suggested, and the answer says which.
    expect(changed || waiting > 0).toBe(true);
    if (changed) {
      expect(notes[0]).toBe("Tidy up did this without asking:");
      expect(notes.join(" ")).toMatch(/(Changed|Wrote) 1 (new )?entry: "/);
    } else {
      expect(notes.join(" ")).not.toContain("without asking");
    }
    if (waiting > 0) expect(notes.at(-1)).toBe(`${waiting} suggestion${waiting === 1 ? " waits" : "s wait"} above for you to accept or reject.`);
    else expect(notes.join(" ")).not.toContain("suggestion");
    expect(notes).not.toContain("Tidy up found nothing to change.");

    // Run again with nothing new: it does not claim to have done it twice.
    const again = (await service.request({ action: "self-learn-reflect" })).reply!.notes!;
    expect(again).toEqual(["Tidy up found nothing to change."]);
  });
});
