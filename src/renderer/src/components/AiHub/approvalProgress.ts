import type { AgentChange } from "@shared/types/aiHub";

/**
 * What a change that needs more than one person says while it waits: who has approved so far, and that the
 * others who may are asked in their inbox. Shown alike in the conversation, on the terminal's bar and in the
 * inbox. Nothing for a change one person decides, or one already decided.
 */
export function approvalProgress(change: Pick<AgentChange, "status" | "approvals" | "requiredApprovals">): string | undefined {
  const needs = change.requiredApprovals ?? 1;
  if (needs < 2 || change.status !== "pending") return undefined;
  const by = [...new Set((change.approvals ?? []).filter((a) => a.allowed).map((a) => a.actor))];
  return by.length > 0
    ? `Approved so far by ${by.join(", ")}. ${needs} different people have to approve: the others who may are asked in their inbox.`
    : `${needs} different people have to approve. Your approval counts as one; the others who may are asked in their inbox.`;
}
