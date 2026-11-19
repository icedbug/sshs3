// Constants and small functions the hub's methods share: moved here from HubService.ts as they were,
// so the files the hub's methods are kept in (./areas) can use them too.
import type {
  AgentMode,
  AgentChange,
  AgentTask,
  HubRequest,
  InlineCommandSuggestion,
  MissionAgent,
  WorkforceRun,
  WorkTicket,
} from "../../../shared/types/aiHub";
import { messageForView } from "./answerSourceRead";
import { SNAPSHOT_TAIL_CHARS, SNAPSHOT_TAIL_MESSAGES } from "../../../shared/types/aiHub";
import { analyzeCommandSafety } from "./CommandSafetyService";
import { lowerMode } from "./AppGuard";
import { boundedContext, clip } from "./privacy";
import { createLogger } from "../../log";

export const log = createLogger("ai-hub");
/** Run events the windows are sent as they happen (host.delta): each changes the conversation it belongs to and nothing else. */
export const STREAMED_EVENTS: ReadonlySet<string> = new Set(["message.delta", "usage.updated", "tool.result", "run.retrying"]);
/** How often, at most, the windows are told to fetch everything again while a run streams. */
export const STREAM_REFRESH_MS = 1000;

/** A conversation is sent whole in every snapshot while it is no larger than this. */
export const SNAPSHOT_WHOLE_MESSAGES = 6;
export const SNAPSHOT_WHOLE_CHARS = 2000;

/** A change's long parts travel in a snapshot while together they are no longer than this. */
export const SNAPSHOT_CHANGE_CHARS = 600;
/** Of a longer output: this much of its start, as a preview. */
export const SNAPSHOT_OUTPUT_PREVIEW = 120;

/**
 * A change as a snapshot carries it. What it ran, on what, how it ended and who answered are always
 * there. Its long parts (the output, a file's contents and diff, a dry run's output, the snapshot
 * taken before it) are left out once they are long, and the change says so (`partial`): the row that
 * shows them asks for the conversation whole. A change that waits for an answer is never cut: the
 * person deciding sees all of it.
 */
export function changeForSnapshot(change: AgentChange): AgentChange {
  const { partial: _stored, ...whole } = change;
  if (change.status === "pending") return whole;
  const long = [change.output, change.before, change.after, change.diff, change.dryRunOutput, change.preflightSnapshot];
  let chars = 0;
  for (const part of long) if (typeof part === "string") chars += part.length;
  if (chars <= SNAPSHOT_CHANGE_CHARS) return whole;
  const { before: _before, after: _after, diff: _diff, dryRunOutput: _dry, preflightSnapshot: _pre, output, ...rest } = whole;
  return {
    ...rest,
    ...(typeof output === "string" ? { output: output.length > SNAPSHOT_OUTPUT_PREVIEW ? output.slice(0, SNAPSHOT_OUTPUT_PREVIEW) : output } : {}),
    partial: true,
  };
}

/**
 * A conversation as every window is sent it with every snapshot. Every change anywhere sends all of
 * them again, so a long one travels by its last messages only (enough for a list and a preview), with
 * what the whole of it is in `messagesTail`, and its changes without their long parts. The window that
 * shows the conversation fetches it whole with `task-read` and keeps it current from the stream.
 * Pictures are never in the tail.
 */
export function taskForSnapshot(task: AgentTask): AgentTask {
  const { toolLog: _toolLog, messagesTail: _stored, ...kept } = task;
  const count = task.toolStepCount ?? _toolLog?.length;
  const rest = { ...kept, ...(count === undefined ? {} : { toolStepCount: count }), changes: task.changes.map(changeForSnapshot) };
  const messages = task.messages;
  let chars = 0;
  let pictures = false;
  for (const m of messages) {
    chars += m.text.length;
    if (m.images?.length) pictures = true;
  }
  if (!pictures && messages.length <= SNAPSHOT_WHOLE_MESSAGES && chars <= SNAPSHOT_WHOLE_CHARS)
    return { ...rest, messages: messages.map(messageForView) };
  const last = messages.at(-1);
  return {
    ...rest,
    messages: messages.slice(-SNAPSHOT_TAIL_MESSAGES).map((m) => ({
      id: m.id,
      role: m.role,
      text: m.text.length > SNAPSHOT_TAIL_CHARS ? m.text.slice(-SNAPSHOT_TAIL_CHARS) : m.text,
      at: m.at,
      ...(m.sourceCalls ? { sourceCallCount: m.sourceCalls.length } : {}),
    })),
    messagesTail: {
      count: messages.length,
      users: messages.reduce((n, m) => n + (m.role === "user" ? 1 : 0), 0),
      ...(last ? { lastId: last.id } : {}),
      lastChars: last?.text.length ?? 0,
    },
  };
}

/**
 * Requests that only read. They answer in `reply` and change nothing, so the
 * store is not rewritten and no window is told to refetch: a search that runs
 * as a person types must not cost a save and a broadcast per keystroke.
 */
export const READ_ONLY_ACTIONS: ReadonlySet<HubRequest["action"]> = new Set<HubRequest["action"]>([
  "task-read",
  // The answer goes to another member's hub: nothing of this one's is written.
  "peer-approve",
  "audit-read",
  "audit-export",
  "recording-read",
  "kb-search",
  "kb-read",
  "kb-page-read",
  "kb-original",
  "server-facts-read",
  "inline-suggest",
  "chat-search",
  "runner-test",
]);
/**
 * An agent as it arrives from the team bucket, made safe to take: whoever can
 * write to the bucket must not be able to make an agent on this computer freer
 * than a person here made it. A known agent keeps the stricter of the two
 * modes, and its tool and MCP lists cannot widen; a new one arrives at most
 * assisted (a person here raises it); a date in the future is not believed;
 * and its texts are bounded as a person's save would bound them.
 */
export const incomingAgentForTesting = (remote: MissionAgent, local: MissionAgent | undefined): MissionAgent => incomingAgent(remote, local);

/** An agent's fields that only make sense together: of two people's edits, one copy gives them all. */
export const AGENT_FIELD_GROUPS = [["modelOverride", "modelProvider"]] as const;

export function incomingAgent(remote: MissionAgent, local: MissionAgent | undefined, now = Date.now()): MissionAgent {
  const modes: AgentMode[] = ["advice", "plan", "assisted", "autonomous"];
  const mode = modes.includes(remote.defaultMode) ? remote.defaultMode : "assisted";
  const narrower = (mine: string[] | undefined, theirs: string[] | undefined): string[] | undefined =>
    mine === undefined ? (theirs ? theirs.slice(0, 40) : undefined) : (theirs ?? mine).filter((x) => mine.includes(x));
  return {
    ...remote,
    name: clip(remote.name ?? "Agent", 120),
    role: clip(remote.role ?? "", 160),
    mission: clip(remote.mission ?? "", 4000),
    systemPrompt: clip(remote.systemPrompt ?? "", 8000),
    defaultMode: local ? lowerMode(local.defaultMode, mode) : lowerMode("assisted", mode),
    allowedTools: local ? narrower(local.allowedTools, remote.allowedTools) : remote.allowedTools?.slice(0, 40),
    mcpServerIds: local ? narrower(local.mcpServerIds, remote.mcpServerIds) : remote.mcpServerIds?.slice(0, 40),
    updatedAt: Math.min(remote.updatedAt, now + 5 * 60_000),
  };
}

/** The safety policy's boolean switches as the screen names them. */
export const BOOLEAN_POLICY_NAMES: Record<
  | "autoApproveSafeReadOnly"
  | "requireApprovalOnProdTags"
  | "blockDestructiveWithoutConfirm"
  | "requirePeerApprovalOnProd",
  string
> = {
  autoApproveSafeReadOnly: "run read-only commands without asking",
  requireApprovalOnProdTags: "always ask before a change on production",
  blockDestructiveWithoutConfirm: "stop destructive commands until a person says yes",
  requirePeerApprovalOnProd: "require peer approval for changes on production",
};
/**
 * A suggested command made fit to put in a terminal. Text from a model is not
 * trusted to be one command: control characters (an escape that ends a
 * bracketed paste early) are taken out, a second line is not run by
 * pressing Enter on the first, and the command is classified like any other.
 * Only a single-line command classified read-only may run with one key; the
 * rest is pasted for the person to read and press Enter themselves.
 */
export const checkedSuggestionForTesting = (s: InlineCommandSuggestion): InlineCommandSuggestion => checkedSuggestion(s);

export function checkedSuggestion(s: InlineCommandSuggestion): InlineCommandSuggestion {
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  const cleaned = s.command.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u0080-\u009f]/g, "").replace(/\r\n?/g, "\n").trim().slice(0, 4000);
  const lines = cleaned.split("\n").filter((l) => l.trim());
  const safety = analyzeCommandSafety(cleaned);
  return {
    ...s,
    command: lines.join("\n"),
    riskLevel: safety.riskLevel,
    riskReason: safety.riskReason,
    multiline: lines.length > 1 || undefined,
    runnable: safety.riskLevel === "safe" && lines.length === 1,
  };
}

/** How a change was let through or stopped when no person decided it, said for the log. */
export const DECIDED_HOW: Record<NonNullable<AgentChange["decidedHow"]>, string> = {
  person: "a person",
  policy: "the safety policy, without asking",
  plan: "an approved plan that lists it",
  timeout: "nobody: the question timed out",
  stopped: "nobody: the run was stopped",
};
export const active = (t: AgentTask): boolean =>
  ["queued", "running", "waiting"].includes(t.status);
/**
 * A ticket's result with the commands of its run that waited for a person's
 * approval and got no answer (`since`: when the run took the ticket). Said by
 * sshs3 itself, with each command, whatever the agent's report says: the
 * person reading the ticket has to know what still waits for them.
 */
export function withUnanswered(ticket: WorkTicket, task: AgentTask, since: number): WorkTicket {
  const waited = task.changes.filter((c) => c.decidedHow === "timeout" && (c.at ?? 0) >= since);
  if (waited.length === 0) return ticket;
  const note = [
    `Waited for approval and nobody answered, so ${waited.length === 1 ? "this did" : "these did"} not run:`,
    ...waited.map((c) => `- ${c.ref ? `${c.ref} ` : ""}on ${c.target}: ${clip(c.command ?? c.description, 600)}`),
  ].join("\n");
  return { ...ticket, result: `${clip(ticket.result ?? "", Math.max(1000, 8000 - note.length - 2))}\n\n${note}`.trim() };
}

/** The line a conversation ends with when its run used its command or time budget. */
export function budgetStopLine(stop: NonNullable<AgentTask["budgetStop"]>): string {
  const n = stop.limit;
  return stop.kind === "commands"
    ? `Stopped after ${n} ${n === 1 ? "command" : "commands"}, the limit for this conversation. Continue to give it ${n} more.`
    : `Stopped after ${n} ${n === 1 ? "minute" : "minutes"}, the time limit for this conversation. Continue to give it ${n} more.`;
}
/**
 * How long the model is given for a one-line command suggestion. Five seconds
 * was less than a reasoning model takes, so the answer was always the canned
 * one, after a five-second wait.
 */
export const INLINE_SUGGEST_TIMEOUT_MS = 15_000;
/** How long a stopped run is given to end by itself before the hub lets go of it. */
export const RUN_STOP_GRACE_MS = 10_000;
/**
 * How often the board and shared setup (agents, runbooks, links) poll the team bucket on the
 * 10s background tick, aligned with S3WorkspaceSyncService's 10s poll cadence.
 */
export const WORK_SYNC_INTERVAL_MS = 8_000;
/** A run the hub started itself (workforce specialist, memory proposals). */
export const isBackgroundRun = (t: AgentTask | undefined): boolean =>
  Boolean(t?.workforceRunId || t?.distillSourceId || t?.evalCaseId);

export function investigatorPrompt(
  question: string,
  scope: string | undefined,
  job: string,
): string {
  return [
    "You are an investigator working for another agent on one question. Find the answer, read-only, and report it. You do not fix anything.",
    `The job this is part of: ${boundedContext(job, 300)}`,
    `Your question: ${boundedContext(question, 2000)}`,
    ...(scope ? [`Where to look: ${boundedContext(scope, 500)}`] : []),
    "",
    "Use `workspace_context` (team activity, servers, team memory), `sshs3_kb_search` (runbooks) and `sshs3_storage_ops` (list and read files and logs on the servers, diff a file between two servers). Whether you can also run read-only commands is said at the end.",
    "Report: first the answer in one or two sentences; then the evidence, each item with its source (server and file with the relevant lines, activity entry with who and when, runbook title); then what you could not determine from here. Do not go beyond the evidence, and do not answer a different question.",
  ].join("\n");
}

/** The workforce conversation's message: per-specialist status, then the combined result. */
export function renderWorkforceProgress(run: WorkforceRun): string {
  const done = run.steps.filter((s) => s.status === "completed").length;
  const failed = run.steps.filter((s) => s.status === "failed").length;
  const lines = run.steps.map((s) => {
    // Words, as everywhere else in the hub: a mark means nothing to a screen reader or a log.
    const mark = s.status === "completed" ? "done" : s.status === "failed" ? "failed" : s.status === "running" ? "running" : "waiting";
    const where = s.targetCluster ? ` (${s.targetCluster})` : "";
    const time =
      s.durationMs === undefined ? "" : ` — ${Math.round(s.durationMs / 1000)} s`;
    const problem = s.error ? ` — ${s.error}` : "";
    return `- **${s.agentName}**${where}: ${mark}${time}${problem}`;
  });
  const status = [
    `**Workforce** — ${done}/${run.steps.length} specialists finished${failed ? `, ${failed} failed` : ""}`,
    ...lines,
  ].join("\n");
  if (run.status === "running") return status;
  if (run.status === "failed")
    return `${status}\n\nThe run failed: ${run.error ?? "unknown error"}`;
  return `${run.synthesis}\n\n---\n${status}`;
}
