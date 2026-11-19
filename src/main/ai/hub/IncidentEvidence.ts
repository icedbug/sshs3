import crypto from "node:crypto";
import type { AnswerSourceCall } from "../../../shared/answerSources";
import type { AgentHypothesis, HypothesisEvidence, HypothesisSource } from "../../../shared/types/aiHub";
import { boundedContext } from "./privacy";

export interface HypothesisParseContext {
  at?: number;
  toolCallId?: string;
  author?: string;
  taskId?: string;
  call?: AnswerSourceCall;
  previous?: AgentHypothesis[];
}

function reference(context: HypothesisParseContext, ref: string): HypothesisSource | undefined {
  const call = context.call;
  const item = call?.sources.find(source => source.ref === ref);
  if (!call || !item || item.indexOnly || !context.taskId) return undefined;
  return {
    taskId: context.taskId, callId: call.id, ref, kind: item.kind, digest: item.digest,
    ...(item.revision !== undefined ? { revision: item.revision } : {}),
    ...(item.updatedAt !== undefined ? { updatedAt: item.updatedAt } : {}),
    ...(item.observedAt !== undefined ? { observedAt: item.observedAt } : {}),
  };
}

const observationId = (item: { text: string; supports: boolean }): string =>
  "e-" + crypto.createHash("sha256").update(JSON.stringify([item.supports, item.text])).digest("hex").slice(0, 16);

export function recordEvidence(
  incoming: unknown, previous: readonly HypothesisEvidence[], context: HypothesisParseContext,
): { evidence: HypothesisEvidence[] } | { error: string } {
  if (Array.isArray(incoming) && incoming.length > 64) return { error: "Send up to 64 observations per hypothesis." };
  const history: HypothesisEvidence[] = previous.map(item => ({
    ...item, id: item.id ?? observationId(item), originTaskId: item.originTaskId ?? item.source?.taskId ?? context.taskId,
  }));
  const at = context.at ?? Date.now();
  for (const row of Array.isArray(incoming) ? incoming : []) {
    if (!row || typeof row !== "object" || typeof row.text !== "string") continue;
    const text = boundedContext(row.text.trim(), 400);
    if (!text) continue;
    const supports = row.supports === true;
    if (row.id !== undefined && (typeof row.id !== "string" || !/^[\w.-]{1,64}$/.test(row.id))) return { error: "An observation id must use at most 64 letters, digits, dots, underscores or hyphens." };
    const id = row.id ?? observationId({ supports, text });
    const earlier = history.find(item => item.id === id);
    const ref = typeof row.sourceRef === "string" ? row.sourceRef.trim() : "";
    const replaces = typeof row.supersedes === "string" ? row.supersedes.trim() : "";
    if (earlier) {
      if (earlier.text !== text || earlier.supports !== supports || (replaces && replaces !== earlier.supersedes) ||
        (ref && earlier.source?.ref !== ref))
        return { error: `Observation ${id} already exists. Record a new observation with supersedes to correct it.` };
      continue;
    }
    if (replaces && !history.some(item => item.id === replaces)) return { error: `Unknown earlier observation ${replaces}.` };
    const source = ref ? reference(context, ref) : undefined;
    if (ref && !source) return { error: `Source ${ref} has no source content in this model call. Use a supplied reference to an opened source.` };
    if (history.length >= 64) return { error: "This hypothesis already has 64 observations. Refine it with another hypothesis." };
    history.push({
      supports, text, at,
      ...(context.taskId || row.id ? { id } : {}),
      ...(context.taskId ? { originTaskId: context.taskId } : {}),
      ...(source ? { source } : {}),
      ...(replaces ? { supersedes: replaces } : {}),
      ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
      ...(context.author ? { author: context.author } : {}),
    });
  }
  return { evidence: history };
}
