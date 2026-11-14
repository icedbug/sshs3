import type {
  AgentTask,
  AgentUsage,
  MissionAgent,
  WorkGoal,
  WorkTicket,
  WorkTicketComment,
  WorkTicketStatus,
  WorkforceTemplateSummary,
} from "../../../shared/types/aiHub";
import { clip } from "./privacy";

/**
 * The team's board: goals, tickets hanging on them, and agents that take
 * tickets. Everything here is plain data and rules; reading and writing the
 * bucket is WorkSync, starting runs is the hub.
 *
 * The model follows what Paperclip (MIT) made familiar: work is a ticket that
 * one worker checks out, a worker is woken for work instead of running all
 * the time, every ticket carries the goal it serves, and a worker has a
 * budget that stops it.
 */

export const TICKET_STATUSES: WorkTicketStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "review",
  "blocked",
  "done",
];

/** A run that stops reporting frees its ticket after this. */
export const TICKET_CLAIM_TTL_MS = 4 * 60_000;

export const monthKey = (now = Date.now()): string => new Date(now).toISOString().slice(0, 7);

export interface Mergeable {
  id: string;
  updatedAt: number;
  deleted?: boolean;
  /** The `updatedAt` of the copy this one was edited from: what its author had seen. */
  baseAt?: number;
  /** When each field was last changed, where that is kept: two edits of different fields both stay. */
  fieldAt?: Record<string, number>;
}

/**
 * A value as text that is the same for the same content, whatever order its keys were written in
 * (and with what is undefined left out, as JSON does). Two installations build the same object in
 * different orders; comparing the plain JSON would call them different for ever.
 */
export function canonicalJson(value: unknown): string {
  const sorted = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sorted);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v as object).sort()) {
        const inner = (v as Record<string, unknown>)[key];
        if (inner !== undefined) out[key] = sorted(inner);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(sorted(value)) ?? "null";
}

/** What says when and from what a copy was made, not what it holds. */
const META = new Set(["id", "updatedAt", "baseAt", "fieldAt"]);

/**
 * A copy as it is saved here: each field that differs from the copy it was made from (`had`) is
 * marked with the time of this change, and the copy remembers which version it was made from. A
 * merge then keeps a teammate's change of one field and this change of another, and a removal made
 * after the version this edit started from wins over the edit.
 */
export function stampChange<T extends Mergeable>(had: T | undefined, next: T): T {
  if (!had) return next;
  const fieldAt: Record<string, number> = { ...(had.fieldAt ?? {}), ...(next.fieldAt ?? {}) };
  const a = had as unknown as Record<string, unknown>;
  const b = next as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
    if (!META.has(key) && canonicalJson(a[key]) !== canonicalJson(b[key])) fieldAt[key] = next.updatedAt;
  return { ...next, fieldAt, baseAt: had.updatedAt };
}

/**
 * A removal and an edit of the same item, where the edit is the newer copy but was made on a view
 * from before the removal (its base is older than the removal): the removal stands. The edit's author
 * had not seen it, and "newer wins" brought the item back without a word. The result is one step
 * above the edit, the same on both sides, so that it reaches the installation that made the edit.
 * Undefined where this rule does not decide.
 */
export function removalWins<T extends Mergeable>(a: T, b: T): T | undefined {
  const [removal, edit] = a.deleted && !b.deleted ? [a, b] : b.deleted && !a.deleted ? [b, a] : [undefined, undefined];
  if (!removal || !edit || edit.updatedAt <= removal.updatedAt) return undefined;
  if (edit.baseAt === undefined || edit.baseAt >= removal.updatedAt) return undefined;
  return { ...removal, updatedAt: edit.updatedAt + 1, baseAt: edit.updatedAt };
}

/**
 * The same rule where a removal is kept as a time per id (team memories and servers) rather than as a
 * copy: the time the removal stands at over `item`, or undefined where the item stays. A removal at or
 * after the item's time stands as it is; one made after the version the item's edit started from
 * stands one step above the edit (removalWins), so that it also reaches the installation that made it.
 */
export function removalStandsAt(
  removedAt: number | undefined,
  item: { id: string; updatedAt: number; baseAt?: number },
): number | undefined {
  if (!removedAt) return undefined;
  if (removedAt >= item.updatedAt) return removedAt;
  return removalWins<Mergeable>({ id: item.id, updatedAt: removedAt, deleted: true }, { id: item.id, updatedAt: item.updatedAt, baseAt: item.baseAt })
    ?.updatedAt;
}

/** What to tell somebody whose change was not saved because what they changed was removed: by whom and when, where known. */
export function removedMessage(what: string, by: string | undefined, at: number | undefined, then = "so nothing was changed."): string {
  const when = at ? ` at ${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC` : "";
  return `${what} was removed${by ? ` by ${by}` : ""}${when}, ${then}`;
}

/**
 * Two live copies with different times, put together field by field: of each field (or group of
 * fields that only make sense together) the copy that changed it last gives the value; where neither
 * says when it changed it, the newer copy does. The result is the newer copy itself when nothing of
 * the older one is kept, and otherwise one step above it, the same on both sides.
 */
export function mergeFields<T extends Mergeable>(
  local: T,
  remote: T,
  groups: readonly (readonly string[])[] = [],
  skip: readonly string[] = [],
): T {
  const [newer, older] = remote.updatedAt > local.updatedAt ? [remote, local] : [local, remote];
  const n = newer as unknown as Record<string, unknown>;
  const o = older as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { ...n };
  const keys = new Set(
    [...Object.keys(n), ...Object.keys(o), ...Object.keys(newer.fieldAt ?? {}), ...Object.keys(older.fieldAt ?? {})].filter(
      (k) => !META.has(k) && k !== "deleted" && !skip.includes(k),
    ),
  );
  const units: string[][] = groups.map((g) => g.filter((k) => keys.has(k)));
  for (const k of keys) if (!groups.some((g) => g.includes(k))) units.push([k]);
  const at = (copy: T, unit: string[]): number => Math.max(0, ...unit.map((k) => copy.fieldAt?.[k] ?? 0));
  const fieldAt: Record<string, number> = { ...(older.fieldAt ?? {}) };
  for (const [k, t] of Object.entries(newer.fieldAt ?? {})) fieldAt[k] = Math.max(t, fieldAt[k] ?? 0);
  for (const unit of units) {
    if (!unit.length || at(older, unit) <= at(newer, unit)) continue;
    for (const k of unit) {
      if (k in o && o[k] !== undefined) out[k] = o[k];
      else delete out[k];
    }
  }
  if (Object.keys(fieldAt).length) out.fieldAt = fieldAt;
  return out as unknown as T;
}

/** Whether two copies hold the same, apart from when they were made. */
const sameContent = (a: object, b: object): boolean =>
  canonicalJson({ ...a, updatedAt: 0, baseAt: 0 }) === canonicalJson({ ...b, updatedAt: 0, baseAt: 0 });

/**
 * The default for two copies of an item: a removal made after the edit's view stands (removalWins);
 * two live copies that say when their fields changed are put together field by field; otherwise the
 * newer copy wins.
 */
export function mergeCopies<T extends Mergeable>(local: T, remote: T, groups: readonly (readonly string[])[] = []): T {
  if (local.updatedAt === remote.updatedAt) return local;
  const removal = removalWins(local, remote);
  if (removal) return removal;
  const newer = remote.updatedAt > local.updatedAt ? remote : local;
  if (local.deleted || remote.deleted || (!local.fieldAt && !remote.fieldAt)) return newer;
  const merged = mergeFields(local, remote, groups);
  return sameContent(merged, newer) ? newer : { ...merged, updatedAt: newer.updatedAt + 1, baseAt: newer.updatedAt };
}

/**
 * Two copies of a collection become one: per id the newer copy wins (see
 * mergeCopies for where it does not), and a removal is a copy like any other.
 * `changed` tells whether the result differs from `local`.
 *
 * `resolve` decides for an item both sides have, where "the newer copy wins"
 * would lose something: it gets both copies and returns the one to keep, or a
 * new one made of both. A copy it makes must carry an `updatedAt` above both,
 * so that it travels to everyone, and must come out the same whichever side
 * makes it.
 */
export function mergeItems<T extends Mergeable>(
  local: T[],
  remote: T[],
  resolve?: (local: T, remote: T) => T,
): { items: T[]; changed: boolean; newerLocally: T[] } {
  const byId = new Map(local.map((x) => [x.id, x]));
  const remoteById = new Map(remote.map((x) => [x.id, x]));
  let changed = false;
  for (const r of remote) {
    const l = byId.get(r.id);
    const kept = !l ? r : resolve ? resolve(l, r) : mergeCopies(l, r);
    if (kept !== l) {
      byId.set(r.id, kept);
      changed = true;
    }
  }
  const items = [...byId.values()];
  const newerLocally = items.filter((l) => {
    const r = remoteById.get(l.id);
    return !r || l.updatedAt > r.updatedAt;
  });
  return { items, changed, newerLocally };
}

/**
 * Two copies of one ticket, put together field by field (mergeFields), with
 * the cases "newer wins" used to get wrong:
 *
 * - Comments are kept from both: two people who comment at the same time
 *   both keep their comment, and a comment does not take back a teammate's
 *   edit of the title made at the same time.
 * - A removal made after the view an edit was made on stands (removalWins).
 * - The installation that is running the ticket decides about the run. A
 *   teammate who moved, edited or removed the ticket on a view that did not
 *   show the run yet does not take it away: their other changes are taken,
 *   the run's state stays, and a removal is put back with a note, so that the
 *   run's result has somewhere to go.
 */
export function mergeTicketCopies(
  local: WorkTicket,
  remote: WorkTicket,
  runningHere: (ticket: WorkTicket) => boolean = () => false,
): WorkTicket {
  if (local.updatedAt === remote.updatedAt) return local;
  const [newer, older] = remote.updatedAt > local.updatedAt ? [remote, local] : [local, remote];
  if (newer === remote && runningHere(local)) {
    const sameRun = remote.status === "in_progress" && remote.claim?.client === local.claim?.client && !remote.deleted;
    if (!sameRun) {
      const at = remote.updatedAt + 1;
      // Made knowing the teammate's copy: its base is that copy, so the teammate's side takes it.
      const run = { status: local.status, statusAt: local.statusAt, claim: local.claim, taskId: local.taskId, result: local.result, baseAt: remote.updatedAt };
      if (remote.deleted)
        return {
          ...withComment(
            local,
            "sshS3",
            "This ticket was removed on another computer while an agent was running it here. It was kept so that the run's result is not lost; remove it again when the run has ended.",
            at,
          ),
          ...run,
        };
      return { ...remote, ...run, comments: allComments(local, remote), updatedAt: at };
    }
  }
  // Removed after the view the edit was made on: the removal stands.
  const removal = removalWins(local, remote);
  if (removal) return removal;
  if (newer.deleted || older.deleted) return newer;
  // Field by field: a teammate's comment on an older copy does not take back this copy's new title.
  const merged = { ...mergeFields(local, remote, TICKET_RUN_FIELDS, ["comments"]), comments: allComments(local, remote) };
  if (sameContent(merged, newer)) return newer;
  // One above the newer copy: the same on both sides, so the two installations agree at once.
  return { ...merged, updatedAt: newer.updatedAt + 1, baseAt: newer.updatedAt };
}

/** A ticket's run: these change together, and come from the same copy. */
const TICKET_RUN_FIELDS = [["status", "statusAt", "claim", "taskId", "result", "tokens", "settledRun"]] as const;

function allComments(a: WorkTicket, b: WorkTicket): WorkTicketComment[] {
  const byId = new Map<string, WorkTicketComment>();
  for (const c of [...(a.comments ?? []), ...(b.comments ?? [])]) if (c?.id) byId.set(c.id, c);
  return [...byId.values()].sort((x, y) => x.at - y.at || x.id.localeCompare(y.id)).slice(-40);
}

/** What to tell somebody who acts on a ticket that was removed, or undefined when it was not. */
export function ticketRemovedMessage(tickets: WorkTicket[] | undefined, id: string): string | undefined {
  const gone = (tickets ?? []).find((t) => t.id === id && t.deleted);
  if (!gone) return undefined;
  return removedMessage("This ticket", gone.deletedBy, gone.updatedAt);
}

/** What is shown and worked: removals are kept in the data only so they travel. */
export const live = <T extends Mergeable>(items: T[] | undefined): T[] =>
  (items ?? []).filter((x) => !x.deleted);

export function claimIsFresh(ticket: WorkTicket, now = Date.now()): boolean {
  return Boolean(ticket.claim && now - ticket.claim.seenAt < TICKET_CLAIM_TTL_MS);
}

export function tokensLeft(
  agent: MissionAgent,
  usage: Record<string, AgentUsage> | undefined,
  now = Date.now(),
): number {
  if (!agent.monthlyTokenBudget || agent.monthlyTokenBudget <= 0) return Number.POSITIVE_INFINITY;
  const u = usage?.[agent.id];
  const spent = u && u.month === monthKey(now) ? u.tokens : 0;
  return Math.max(0, agent.monthlyTokenBudget - spent);
}

/** Why a ticket cannot be started right now, or undefined when it can. */
export function whyNotRunnable(
  ticket: WorkTicket,
  ctx: {
    tickets: WorkTicket[];
    agents: MissionAgent[];
    usage?: Record<string, AgentUsage>;
    /** The external runners set up on THIS installation. Undefined: not checked. */
    runners?: string[];
    client: string;
    now?: number;
  },
): string | undefined {
  const now = ctx.now ?? Date.now();
  if (ticket.deleted) return "The ticket was removed.";
  if (ticket.status === "done") return "The ticket is done.";
  if (ticket.status === "review") return "The ticket is waiting for review.";
  if (claimIsFresh(ticket, now) && ticket.claim!.client !== ctx.client)
    return `${ticket.claim!.by} is running it.`;
  const agent = ctx.agents.find((a) => a.id === ticket.assigneeAgentId);
  if (!agent) return "No agent is assigned.";
  if (agent.enabled === false) return `${agent.name} is paused.`;
  // A runner is a command and a folder on one computer, and is never shared. A ticket for
  // an agent whose runner is not set up here belongs to whoever has it; otherwise this
  // installation takes it, fails, and takes it again for ever.
  if (agent.runnerId && ctx.runners && !ctx.runners.includes(agent.runnerId))
    return `${agent.name} runs with an external agent that is not set up on this computer.`;
  if (tokensLeft(agent, ctx.usage, now) <= 0)
    return `${agent.name} has used its token budget for this month.`;
  const open = (ticket.blockedBy ?? [])
    .map((id) => ctx.tickets.find((t) => t.id === id && !t.deleted))
    .filter((t): t is WorkTicket => Boolean(t) && t!.status !== "done");
  if (open.length > 0) return `Waiting for: ${open.map((t) => t.title).join(", ")}.`;
  return undefined;
}

/** How soon a ticket should be taken: a firing alert before ordinary work, a critical one first. */
function urgency(t: WorkTicket): number {
  if (!t.alert || t.alert.resolvedAt) return 3;
  return t.alert.severity === "critical" ? 0 : t.alert.severity === "warning" ? 1 : 2;
}

/** The ticket the heartbeat should start next: alerts first (critical before the rest), then the oldest "todo" that can run. */
export function nextForHeartbeat(ctx: {
  tickets: WorkTicket[];
  agents: MissionAgent[];
  usage?: Record<string, AgentUsage>;
  runners?: string[];
  client: string;
  now?: number;
}): WorkTicket | undefined {
  return live(ctx.tickets)
    .filter((t) => t.status === "todo")
    .sort((a, b) => urgency(a) - urgency(b) || a.createdAt - b.createdAt)
    .find((t) => whyNotRunnable(t, ctx) === undefined);
}

/** What the agent is told when it is woken for a ticket. */
export function ticketPrompt(
  ticket: WorkTicket,
  goal: WorkGoal | undefined,
  ctx: { tickets: WorkTicket[]; agents: MissionAgent[]; agent: MissionAgent },
): string {
  const boss = ctx.agents.find((a) => a.id === ctx.agent.reportsTo);
  const reports = ctx.agents.filter((a) => a.reportsTo === ctx.agent.id);
  const parent = ctx.tickets.find((t) => t.id === ticket.parentId);
  const notes = (ticket.comments ?? []).slice(-6);
  return [
    `You were woken to work one ticket from the team's board. Ticket ${ticket.id}: ${ticket.title}`,
    "",
    goal
      ? `It serves this goal: ${goal.title}${goal.description ? ` — ${clip(goal.description, 800)}` : ""}`
      : "It is not tied to a goal.",
    parent ? `It was split off from the ticket "${parent.title}".` : "",
    ticket.target ? `It concerns: ${ticket.target}` : "",
    "",
    "## What to do",
    clip(ticket.description || ticket.title, 6000),
    notes.length ? "\n## Notes on the ticket (oldest first)" : "",
    ...notes.map((n) => `- ${n.author}: ${clip(n.text, 800)}`),
    "",
    "## How to work it",
    `You are ${ctx.agent.name}${boss ? `, reporting to ${boss.name}` : ""}.`,
    reports.length
      ? `These agents report to you: ${reports.map((r) => `${r.name} (${r.role})`).join("; ")}. If part of the work is theirs, create a ticket for them with sshs3_tickets (operation=create, assignee=<their name>, parent=${ticket.id}) instead of doing it yourself, and say in your report what you handed out.`
      : "If part of the work belongs to somebody else, create a ticket for it with sshs3_tickets (operation=create) and say so in your report.",
    "Do this ticket and nothing beside it. When you are done, end with a report a person can review: what you did, what you verified and how, and what is left. If you cannot finish, say exactly what stopped you.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * The ticket after its run ended. A finished run goes to review: a person
 * (or the agent's lead) decides whether it is done. A run that failed or was
 * stopped leaves the ticket blocked with the reason.
 */
export function ticketAfterRun(ticket: WorkTicket, task: AgentTask, now = Date.now()): WorkTicket {
  const report = [...task.messages].reverse().find((m) => m.role === "assistant" && m.text.trim())?.text;
  const used = (task.usage?.inputTokens ?? 0) + (task.usage?.outputTokens ?? 0);
  const ok = task.status === "completed";
  // A conversation's count grows with every run of it. What an earlier run of the same
  // conversation already put on the ticket is not added a second time.
  const counted = ticket.settledRun?.taskId === task.id ? ticket.settledRun.tokens : 0;
  // The run ends when the agent proposes a plan. Nothing was done yet: the ticket says that it
  // waits for the plan's decision, not that the work is ready for review.
  const waitsForPlan = ok && task.plan?.status === "proposed";
  return {
    ...ticket,
    status: ok ? "review" : "blocked",
    result: clip(
      waitsForPlan
        ? `${PLAN_WAITS} ${report || ""}`.trim()
        : ok
          ? report || "The run ended without a report."
          : `The run ${task.status === "failed" ? "failed" : "stopped"}: ${task.error || report || "no reason was given."}`,
      8000,
    ),
    tokens: Math.max(0, (ticket.tokens ?? 0) - counted) + used,
    settledRun: { taskId: task.id, tokens: used },
    claim: undefined,
    taskId: task.id,
    updatedAt: now,
  };
}

/** How a ticket's result begins while its agent's plan waits for a person. */
export const PLAN_WAITS =
  "The agent proposed a plan and has not carried it out. Approve or reject the plan in the conversation; the ticket continues from there.";

export function withComment(ticket: WorkTicket, author: string, text: string, now = Date.now()): WorkTicket {
  return {
    ...ticket,
    comments: [
      ...(ticket.comments ?? []),
      { id: `c-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`, at: now, author, text: clip(text, 4000) },
    ].slice(-40),
    updatedAt: now,
  };
}

export function addUsage(
  usage: Record<string, AgentUsage>,
  agentId: string,
  tokens: number,
  now = Date.now(),
): Record<string, AgentUsage> {
  const month = monthKey(now);
  const prev = usage[agentId];
  const base = prev && prev.month === month ? prev : { month, tokens: 0, runs: 0 };
  return { ...usage, [agentId]: { month, tokens: base.tokens + tokens, runs: base.runs + 1 } };
}

/** Several installations' counts as one: per agent, this month's tokens and runs added up. */
export function sumUsage(
  parts: Array<Record<string, AgentUsage> | undefined>,
  now = Date.now(),
): Record<string, AgentUsage> {
  const month = monthKey(now);
  const out: Record<string, AgentUsage> = {};
  for (const part of parts)
    for (const [agentId, u] of Object.entries(part ?? {})) {
      if (!u || u.month !== month) continue;
      const prev = out[agentId] ?? { month, tokens: 0, runs: 0 };
      out[agentId] = { month, tokens: prev.tokens + (u.tokens || 0), runs: prev.runs + (u.runs || 0) };
    }
  return out;
}

/**
 * A collection as it is sent to the team: what exists, plus a marker for each
 * removal, so the removal reaches everyone instead of the item coming back.
 */
export function withRemovals<T extends { id: string; updatedAt?: number }>(
  items: T[],
  removed: Record<string, number> | undefined,
  /** Who removed what, where that is known: it travels on the marker. */
  removedBy?: Record<string, string>,
): Array<T & Mergeable> {
  const dead = removed ?? {};
  const alive = items
    .map((x) => ({ ...x, updatedAt: x.updatedAt ?? 0 }))
    .filter((x) => (dead[x.id] ?? -1) < x.updatedAt);
  const markers = Object.entries(dead)
    .filter(([id, at]) => !alive.some((x) => x.id === id && x.updatedAt > at))
    .map(([id, at]) => ({ id, updatedAt: at, deleted: true, ...(removedBy?.[id] ? { deletedBy: removedBy[id] } : {}) }) as unknown as T & Mergeable);
  return [...alive, ...markers];
}

/** The reverse of withRemovals, after merging with the team's copy. */
export function splitRemovals<T extends Mergeable>(
  items: T[],
): { alive: T[]; removed: Record<string, number>; removedBy: Record<string, string> } {
  const removed: Record<string, number> = {};
  const removedBy: Record<string, string> = {};
  const alive: T[] = [];
  for (const item of items) {
    if (item.deleted) {
      removed[item.id] = item.updatedAt;
      const by = (item as { deletedBy?: unknown }).deletedBy;
      if (typeof by === "string" && by) removedBy[item.id] = by.slice(0, 80);
    } else alive.push(item);
  }
  return { alive, removed, removedBy };
}

/** Whether making `agentId` report to `bossId` would close a circle. */
export function wouldCycle(agents: MissionAgent[], agentId: string, bossId: string | undefined): boolean {
  let current = bossId;
  const seen = new Set<string>();
  while (current) {
    if (current === agentId) return true;
    if (seen.has(current)) return true;
    seen.add(current);
    current = agents.find((a) => a.id === current)?.reportsTo;
  }
  return false;
}

interface TemplateRole {
  key: string;
  name: string;
  role: string;
  mission: string;
  systemPrompt: string;
  defaultMode: MissionAgent["defaultMode"];
  reportsTo?: string;
}
interface TemplateTicket {
  title: string;
  description: string;
  role: string;
  status: WorkTicketStatus;
  blockedBy?: number[];
}
export interface WorkforceTemplate extends WorkforceTemplateSummary {
  goal: { title: string; description: string };
  team: TemplateRole[];
  tickets: TemplateTicket[];
}

export const WORKFORCE_TEMPLATES: WorkforceTemplate[] = [
  {
    id: "operate-system",
    title: "Operate a system",
    description:
      "A lead that keeps the board, a watch that looks for trouble, an investigator that finds causes, an operator that makes changes and a reviewer that checks them.",
    roles: ["Operations lead", "Watch", "Investigator", "Operator", "Reviewer"],
    goal: {
      title: "Keep the system healthy",
      description:
        "Notice problems before users do, find the cause instead of the symptom, change production only with a plan and a verified result.",
    },
    team: [
      {
        key: "lead",
        name: "Operations lead",
        role: "Plans the work and hands it out",
        mission: "Look at the board and the team's recent activity, decide what matters most, and split it into tickets for the right agent.",
        systemPrompt:
          "You lead a small operations team. You do not run commands yourself. You read the board, the recent activity and team memory, and you turn what needs doing into small tickets with a clear outcome, each for one agent. Prefer few tickets that matter over many that do not.",
        defaultMode: "advice",
      },
      {
        key: "watch",
        name: "Watch",
        role: "Looks for trouble",
        mission: "Check health, capacity and errors on the systems in scope and report only what needs attention.",
        systemPrompt:
          "You check systems with read-only commands. Report what needs attention with the evidence, and say plainly when everything is fine. When something needs work, create a ticket for the investigator instead of digging yourself.",
        defaultMode: "assisted",
        reportsTo: "lead",
      },
      {
        key: "investigator",
        name: "Investigator",
        role: "Finds the cause",
        mission: "Take a symptom and find what causes it, with evidence.",
        systemPrompt:
          "You find causes. Work from observations: logs, metrics, configuration, what changed recently. State the cause only when the evidence supports it, and say what you could not check. You do not change anything; propose the fix as a ticket for the operator.",
        defaultMode: "assisted",
        reportsTo: "lead",
      },
      {
        key: "operator",
        name: "Operator",
        role: "Makes changes",
        mission: "Carry out an agreed change with a plan, a rollback and a verification.",
        systemPrompt:
          "You make changes to systems. Before anything that changes state, propose a plan with the exact commands, the rollback and how you will verify. After the change, verify and report what you saw.",
        defaultMode: "assisted",
        reportsTo: "lead",
      },
      {
        key: "reviewer",
        name: "Reviewer",
        role: "Checks the work",
        mission: "Review what was done on a ticket: does the evidence support the report, was it verified, is anything left open.",
        systemPrompt:
          "You review other agents' work. Read the ticket, its report and the commands that were run. Say what holds, what is not supported by evidence and what is missing. You change nothing.",
        defaultMode: "advice",
        reportsTo: "lead",
      },
    ],
    tickets: [
      {
        title: "Morning check of the systems in scope",
        description:
          "Check health, capacity and recent errors on the systems this workspace covers. Report only what needs attention; create a ticket for the investigator for anything that needs digging.",
        role: "watch",
        status: "todo",
      },
      {
        title: "What changed in the last week, and what does it put at risk",
        description:
          "Read the team's recent activity and memory. List the changes that could cause trouble and what should be checked for each. Create tickets for the checks.",
        role: "lead",
        status: "backlog",
      },
    ],
  },
  {
    id: "develop-product",
    title: "Develop a product",
    description:
      "A lead that turns the goal into tickets, a designer that writes the plan, a builder that implements it, a tester that tries to break it and a reviewer that reads the result.",
    roles: ["Product lead", "Designer", "Builder", "Tester", "Reviewer"],
    goal: {
      title: "Ship the next version",
      description: "Describe here what the product should do when this goal is reached, and for whom.",
    },
    team: [
      {
        key: "lead",
        name: "Product lead",
        role: "Turns the goal into tickets",
        mission: "Break the goal down into small tickets with a clear outcome and hand them to the right agent.",
        systemPrompt:
          "You lead a small product team. You do not write code. You read the goal, ask what is unclear by commenting on the ticket, and split the work into tickets small enough to finish and review in one sitting, each with what done looks like.",
        defaultMode: "advice",
      },
      {
        key: "designer",
        name: "Designer",
        role: "Writes the plan",
        mission: "For a feature: how it should work, what it touches, what can go wrong.",
        systemPrompt:
          "You design before anything is built. Read the code that is there, then write how the feature should work, which files it touches, the cases that are easy to miss and how it will be tested. Keep it short enough to be read.",
        defaultMode: "advice",
        reportsTo: "lead",
      },
      {
        key: "builder",
        name: "Builder",
        role: "Implements",
        mission: "Implement one ticket in the repository, with tests, and show that they pass.",
        systemPrompt:
          "You implement one ticket at a time in the terminal you were given. Read the surrounding code first and follow its conventions. Write or update tests, run them, and report the result with the output. Do not widen the ticket.",
        defaultMode: "assisted",
        reportsTo: "lead",
      },
      {
        key: "tester",
        name: "Tester",
        role: "Tries to break it",
        mission: "Exercise what was built: the stated behaviour and the cases nobody stated.",
        systemPrompt:
          "You test what was built. Run it. Try the stated behaviour, then empty input, wrong input, twice in a row, and the unhappy paths. Report what failed with the exact steps, and create a ticket for the builder for each failure.",
        defaultMode: "assisted",
        reportsTo: "lead",
      },
      {
        key: "reviewer",
        name: "Reviewer",
        role: "Reads the result",
        mission: "Review the change on a ticket for correctness, simplicity and what it could break.",
        systemPrompt:
          "You review a change. Read the diff and the code around it. Say what is wrong, what is risky and what is unnecessary, each with the place in the code. You change nothing.",
        defaultMode: "advice",
        reportsTo: "lead",
      },
    ],
    tickets: [
      {
        title: "Break the goal down into the first tickets",
        description:
          "Read the goal. Write the three to six tickets that get the first usable slice built, each with what done looks like, and assign them.",
        role: "lead",
        status: "todo",
      },
    ],
  },
];

export const templateSummaries = (): WorkforceTemplateSummary[] =>
  WORKFORCE_TEMPLATES.map(({ id, title, description, roles }) => ({ id, title, description, roles }));
