import type { AgentTask } from "../../../shared/types/aiHub";
import type { RunEvent } from "./AgentRuntime";

const outcomes = {
  "run.completed": "completed",
  "run.failed": "failed",
  "run.interrupted": "interrupted",
  "run.cancelled": "cancelled",
} as const satisfies Record<string, AgentTask["status"]>;

export type FinalRunEvent = RunEvent & { type: keyof typeof outcomes };

/** The hub handles the same terminal statuses for every runtime, including external ones. */
export function finalRunStatus(type: string) {
  return Object.hasOwn(outcomes, type) ? outcomes[type as keyof typeof outcomes] : undefined;
}
