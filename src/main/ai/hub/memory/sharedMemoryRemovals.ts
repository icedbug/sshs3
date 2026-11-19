import type { MemoryEntry } from "../../../../shared/types/aiHub";
import { removalStandsAt } from "../WorkBoard";

interface MemoryCopies {
  memories?: MemoryEntry[];
  deletedMemoryIds?: Record<string, number>;
}

/** Resolve the deletion against both histories before either transport chooses which live copy to keep. */
export function sharedMemoryRemovals(local: MemoryCopies, remote: MemoryCopies) {
  const deleted = { ...local.deletedMemoryIds };
  let changed = false;
  for (const [id, at] of Object.entries(remote.deletedMemoryIds ?? {})) {
    if (id && typeof at === "number" && at > (deleted[id] ?? 0)) {
      deleted[id] = at;
      changed = true;
    }
  }
  const edits: MemoryEntry[] = [];
  for (const copies of [local.memories, remote.memories]) {
    if (!Array.isArray(copies)) continue;
    for (const memory of copies) {
      if (memory?.scope !== "personal" && memory?.baseAt !== undefined && deleted[memory.id]) edits.push(memory);
    }
  }
  // An offline edit can advance the tombstone past a later edit's base. Visit older edits first on both peers.
  edits.sort((a, b) => a.updatedAt - b.updatedAt);
  for (const memory of edits) {
    const at = removalStandsAt(deleted[memory.id], memory);
    if (at !== undefined && at > deleted[memory.id]) {
      deleted[memory.id] = at;
      changed = true;
    }
  }
  const removed = (memory: MemoryEntry): boolean => (deleted[memory.id] ?? 0) >= (memory.updatedAt ?? 0);
  return { deleted, changed, removed };
}
