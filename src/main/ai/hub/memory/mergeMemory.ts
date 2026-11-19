import crypto from "node:crypto";
import type { MemoryEntry } from "../../../../shared/types/aiHub";
import { tokenize } from "../searchTokens";

/** How long a memory's text may be: what the distiller writes (4,000), not less. */
export const MAX_MEMORY_TEXT = 4000;
/** How many learned (automatic) memories are kept; the newest stay. What a person wrote is never dropped by this. */
const MAX_LEARNED = 300;

/**
 * The store with its learned entries capped, newest first. What a person
 * wrote, and personal notes, are never dropped to make room: they used to
 * fall off silently once there were a hundred entries of any kind.
 * Replaced (superseded) entries are history: they count toward the same cap
 * whoever wrote them, and are the first to go.
 */
export function capMemories(memories: MemoryEntry[]): MemoryEntry[] {
  const liveLearned = memories.filter((m) => !m.supersededBy && m.autoLearned).length;
  let history = Math.max(0, MAX_LEARNED - liveLearned);
  let learned = 0;
  return memories.filter((m) =>
    m.supersededBy ? history-- > 0 : !m.autoLearned || ++learned <= MAX_LEARNED,
  );
}

/** What agents are given and search finds: not the entries a newer one replaced. */
export function liveMemories(memories: MemoryEntry[]): MemoryEntry[] {
  return memories.filter((m) => !m.supersededBy);
}

export type MemoryMergeInput = Omit<MemoryEntry, "id" | "updatedAt"> & {
  id?: string;
  /** Keep the previous entry as history when the advice changes. */
  supersede?: boolean;
};

export function deduplicateOrMergeMemory(
  existing: MemoryEntry[],
  input: MemoryMergeInput,
): { memories: MemoryEntry[]; saved: MemoryEntry; merged: boolean; superseded?: MemoryEntry } {
  const { supersede, ...incoming } = input;
  const now = Date.now();
  const normTitle = incoming.title.trim().toLowerCase();
  const incomingTokens = tokenize(`${incoming.title} ${incoming.text}`);

  let matchIdx = -1;
  if (incoming.id) {
    matchIdx = existing.findIndex((m) => m.id === incoming.id);
  }
  if (matchIdx === -1) {
    matchIdx = existing.findIndex((m) => {
      if (m.supersededBy) return false;
      if (m.kind !== incoming.kind || m.scope !== incoming.scope) return false;
      if (m.title.trim().toLowerCase() === normTitle) return true;
      if (
        incoming.errorSignature &&
        m.errorSignature &&
        incoming.errorSignature === m.errorSignature
      ) {
        return true;
      }
      const mTokens = tokenize(`${m.title} ${m.text}`);
      if (incomingTokens.length >= 3 && mTokens.length >= 3) {
        const overlap = incomingTokens.filter((t) =>
          mTokens.includes(t),
        ).length;
        const ratio =
          overlap / Math.min(incomingTokens.length, mTokens.length);
        if (
          ratio >= 0.78 &&
          m.title.toLowerCase().slice(0, 14) === normTitle.slice(0, 14)
        ) {
          return true;
        }
      }
      return false;
    });
  }

  if (matchIdx >= 0) {
    const prev = existing[matchIdx];
    // Saving a memory by its id is an edit: the new text replaces the old.
    // Only a new note that merely resembles an existing one keeps a trace
    // of what it was merged into.
    const editedById = Boolean(incoming.id) && incoming.id === prev.id;
    const mergedText =
      editedById ||
      incoming.text.trim() === prev.text.trim() ||
      incoming.text.includes(prev.text.trim())
        ? incoming.text.trim()
        : `${incoming.text.trim()} (Earlier note: ${prev.text.trim().slice(0, 240)})`;
    // Saying the same thing again is not evidence that it is true: no confidence for repeating it.
    const prevConfidence = prev.confidence ?? 0.78;
    const nextConfidence = editedById
      ? (incoming.confidence ?? prevConfidence)
      : Math.min(0.99, Math.max(incoming.confidence ?? prevConfidence, prevConfidence));
    const updated: MemoryEntry = {
      ...prev,
      ...incoming,
      id: prev.id,
      // Whoever wrote it stays its author; a teammate who changes it is named beside them.
      author: prev.author ?? incoming.author,
      editedBy: prev.author && incoming.author && incoming.author !== prev.author ? incoming.author : undefined,
      title: incoming.title.trim() || prev.title,
      text: mergedText.slice(0, MAX_MEMORY_TEXT),
      tier: incoming.tier ?? prev.tier ?? "archival",
      cluster: incoming.cluster ?? prev.cluster,
      updatedCount: (prev.updatedCount ?? 1) + 1,
      confidence: nextConfidence,
      // Only what a verified run counted: being learned again is not working again.
      successCount: incoming.successCount ?? prev.successCount ?? 0,
      failureCount: incoming.failureCount ?? prev.failureCount ?? 0,
      usageCount: incoming.usageCount ?? (prev.usageCount ?? 0) + 1,
      feedbackScore: incoming.feedbackScore ?? prev.feedbackScore ?? 0,
      autoLearned: incoming.autoLearned ?? prev.autoLearned,
      sourceCommand: incoming.sourceCommand ?? prev.sourceCommand,
      errorSignature: incoming.errorSignature ?? prev.errorSignature,
      updatedAt: now,
    };
    const next = [...existing];
    if (
      supersede &&
      incoming.text.trim() !== prev.text.trim() &&
      !(incoming.sourceCommand && prev.sourceCommand && incoming.sourceCommand === prev.sourceCommand)
    ) {
      // A new entry says it now; the old one stays, marked, where it was.
      const replacement: MemoryEntry = {
        ...updated,
        id: crypto.randomUUID(),
        // A new entry that says it now is the new writer's own.
        author: incoming.author ?? updated.author,
        editedBy: undefined,
        text: incoming.text.trim().slice(0, MAX_MEMORY_TEXT),
        // What the old text earned is not the new text's.
        successCount: incoming.successCount ?? 0,
        failureCount: incoming.failureCount ?? 0,
        feedbackScore: incoming.feedbackScore ?? 0,
      };
      delete replacement.votes;
      delete replacement.supersededBy;
      delete replacement.supersededAt;
      const old: MemoryEntry = { ...prev, supersededBy: replacement.id, supersededAt: now, updatedAt: now };
      next[matchIdx] = old;
      return {
        memories: capMemories([replacement, ...next]),
        saved: replacement,
        merged: true,
        superseded: old,
      };
    }
    next.splice(matchIdx, 1);
    return {
      memories: capMemories([updated, ...next]),
      saved: updated,
      merged: true,
    };
  }

  const created: MemoryEntry = {
    id: incoming.id || crypto.randomUUID(),
    kind: incoming.kind,
    tier: incoming.tier ?? (incoming.kind === "skill" ? "core" : "archival"),
    cluster: incoming.cluster,
    scope: incoming.scope.trim().slice(0, 80) || "workspace",
    title: incoming.title.trim().slice(0, 120),
    text: incoming.text.trim().slice(0, MAX_MEMORY_TEXT),
    author: incoming.author,
    updatedCount: 1,
    confidence: incoming.confidence ?? (incoming.kind === "skill" ? 0.85 : 0.78),
    successCount: incoming.successCount ?? 0,
    failureCount: incoming.failureCount ?? 0,
    usageCount: incoming.usageCount ?? 1,
    feedbackScore: incoming.feedbackScore ?? 0,
    autoLearned: incoming.autoLearned,
    sourceCommand: incoming.sourceCommand,
    errorSignature: incoming.errorSignature,
    ...(incoming.lastVerifiedAt !== undefined ? { lastVerifiedAt: incoming.lastVerifiedAt } : {}),
    ...(incoming.staleReason !== undefined ? { staleReason: incoming.staleReason } : {}),
    ...(incoming.validUntil !== undefined ? { validUntil: incoming.validUntil } : {}),
    ...(incoming.commandTemplate !== undefined ? { commandTemplate: incoming.commandTemplate } : {}),
    ...(incoming.preconditions !== undefined ? { preconditions: incoming.preconditions } : {}),
    ...(incoming.verifyCommand !== undefined ? { verifyCommand: incoming.verifyCommand } : {}),
    ...(incoming.proven !== undefined ? { proven: incoming.proven } : {}),
    ...(incoming.sourceTrust !== undefined ? { sourceTrust: incoming.sourceTrust } : {}),
    updatedAt: now,
  };

  return {
    memories: capMemories([created, ...existing]),
    saved: created,
    merged: false,
  };
}
