import { sourceCallsForDisplay } from "../../../shared/answerSources";
import type { AgentMessage, AgentTask, HubReply } from "../../../shared/types/aiHub";

/** Ordinary snapshots and conversation reads carry availability, never the captured excerpts. */
export function messageForView(message: AgentMessage): AgentMessage {
  if (!message.sourceCalls) return message;
  const { sourceCalls, ...rest } = message;
  return { ...rest, sourceCallCount: sourceCalls.length };
}

/** Source markers are explicit citations in prose. Examples in code and Markdown links are excluded. */
function citedRefs(text: string): string[] {
  const cited = new Set<string>();
  let fence = "";
  for (const line of text.split("\n")) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (delimiter?.startsWith(fence) && line.trim() === delimiter) fence = "";
      continue;
    }
    if (delimiter) { fence = delimiter; continue; }
    if (/^( {4}|\t)/.test(line)) continue;
    const prose = line.replace(/(`+)[\s\S]*?\1/g, "");
    for (const match of prose.matchAll(/(?<!\\)\[([^[\]\n]{1,160})\](?![([])/g)) {
      const refs = match[1].split(",").map(ref => ref.trim());
      if (refs.every(ref => /^S\d{1,9}$/.test(ref))) for (const ref of refs) cited.add(ref);
    }
  }
  return [...cited];
}

export function answerSourceReply(task: AgentTask, messageId: string): HubReply {
  const message = task.messages.find(m => m.id === messageId && m.role === "assistant");
  if (!message) throw new Error("Answer not found");
  if (!message.sourceCalls) return {};
  const calls = sourceCallsForDisplay(message.sourceCalls);
  // Mark one occurrence for each citation. A repeated ref takes its meaning from the latest request.
  const latest = new Map<string, string>();
  for (const call of calls) for (const source of call.sources) latest.set(source.ref, call.id);
  const citations = citedRefs(message.text).flatMap(ref => {
    const callId = latest.get(ref);
    return callId ? [{ callId, ref }] : [];
  });
  return { answerSources: { messageId, calls, citations } };
}

export function evidenceSourceReply(task: AgentTask, locator: { callId: string; ref: string; digest: string }): HubReply {
  for (const message of task.messages) {
    const call = message.sourceCalls?.find(call => call.id === locator.callId);
    const source = call?.sources.find(s => s.ref === locator.ref && s.digest === locator.digest);
    if (call && source) {
      const expanded = source.kind === "terminal" && !source.segments
        ? sourceCallsForDisplay(message.sourceCalls!).find(item => item.id === call.id)?.sources.find(s => s.ref === source.ref && s.digest === source.digest)
        : source;
      if (expanded) return { evidenceSource: { callId: call.id, source: expanded } };
    }
  }
  return {};
}
