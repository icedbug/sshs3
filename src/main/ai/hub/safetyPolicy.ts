import type { SafetyPolicyConfig } from "../../../shared/types/aiHub";

/**
 * The rules a workspace starts with.
 *
 * A command an agent runs is not looked at and nobody is asked about it. What waits for a person is a
 * change card, a file write, a plan and a guarded settings change (see `isPlainCommand` in
 * shared/types/aiHub.ts and ToolBroker.authorize). These rules say when those wait.
 */
export const DEFAULT_SAFETY_POLICY: SafetyPolicyConfig = {
  requireApprovalOnProdTags: true,
};

/** The tags that mark a server as one where a change card waits for a person (see `requireApprovalOnProdTags`). */
export function isProdTag(tag: string): boolean {
  const t = tag.toLowerCase();
  return t === "prod" || t === "production" || t === "critical";
}
