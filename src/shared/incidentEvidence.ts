import type { HypothesisEvidence } from "./types/aiHub";

/** Agents choose short ids independently in each investigation. */
export function evidenceKey(item: HypothesisEvidence, id = item.id): string {
  return `${item.originTaskId ?? item.source?.taskId ?? ""}/${id ?? ""}`;
}

/** An observation can be revised repeatedly. The entire history stays in the record. */
export function supersededEvidence(evidence: readonly HypothesisEvidence[]): Set<string> {
  return new Set(evidence.flatMap(item => item.supersedes ? [evidenceKey(item, item.supersedes)] : []));
}
