import type { AgentTask, HubSnapshot } from "./types/aiHub";

/** A conversation of the user's own, not one of the hub's runs (specialists, readings for memory and pages, test cases). */
export const isConversation = (t: Pick<AgentTask, "workforceRunId" | "distillSourceId" | "evalCaseId" | "quietScheduleResult">): boolean =>
  !t.workforceRunId && !t.distillSourceId && !t.evalCaseId && !t.quietScheduleResult;

export type InboxKind = "approval" | "peer" | "plan" | "question" | "review" | "blocked" | "alert" | "health" | "knowledge" | "report";

export type InboxPriorityBucket = "blocking" | "incident" | "review";

const BUCKET_BY_KIND: Record<InboxKind, InboxPriorityBucket> = {
  approval: "blocking",
  // Another member's run is held up until a second person answers.
  peer: "blocking",
  plan: "blocking",
  question: "blocking",
  alert: "incident",
  blocked: "incident",
  health: "incident",
  review: "review",
  report: "review",
  knowledge: "review",
};

/** Maps an inbox item kind to its priority triage bucket (`blocking`, `incident`, or `review`). */
export function inboxPriorityBucket(kind: InboxKind): InboxPriorityBucket {
  return BUCKET_BY_KIND[kind];
}

/** One thing that is waiting for a person. */
export interface InboxItem {
  id: string;
  kind: InboxKind;
  bucket?: InboxPriorityBucket;
  title: string;
  detail?: string;
  /** Who is asking: an agent, a monitoring system. */
  from?: string;
  at: number;
  /** When it started to wait. Unlike `at`, this does not move while it waits. */
  since?: number;
  /** The server or cluster it is about. */
  target?: string;
  taskId?: string;
  changeId?: string;
  /** With `peer`: whose run the change is in. The task and the change are theirs, not this member's. */
  ownerId?: string;
  ticketId?: string;
  findingId?: string;
  /** A server with problems of its own (disk, certificate, failed service). */
  serverId?: string;
  risk?: string;
  /** Epoch ms until which this item is snoozed from active triage. */
  snoozedUntil?: number;
  /** Epoch ms when this item was acknowledged by a person. */
  acknowledgedAt?: number;
  /** Convenience flag indicating the item is currently snoozed at evaluation time. */
  snoozed?: boolean;
}

const KB_WORTH_A_LOOK = new Set(["gap", "contradiction", "dead-target", "lost-source"]);

/**
 * Everything that waits for a person, from wherever it sits: a command an
 * agent wants to run, a plan to decide, a question, a ticket to review, a run
 * that stopped, an alert nobody has, a gap in the knowledge base. Most urgent
 * first: what blocks a running agent, then what stopped, then the rest.
 */
/** What the inbox is built from: the same on screen and where notifications are sent from. */
export type InboxInput = Pick<HubSnapshot, "tasks"> &
  Partial<Pick<HubSnapshot, "workTickets" | "kbFindings" | "dailyReport" | "inboxState" | "peerApprovals">> & {
    serverFacts?: Pick<NonNullable<HubSnapshot["serverFacts"]>, "servers">;
  };

export interface InboxFilterOptions {
  /** Include items whose `snoozedUntil` is in the future. Ignored if `snoozeFilter` is specified. */
  includeSnoozed?: boolean;
  /** Filter by snooze state: `"active"` (default), `"snoozed"`, or `"all"`. */
  snoozeFilter?: "active" | "snoozed" | "all";
  /** Optional priority bucket filter. */
  bucket?: InboxPriorityBucket;
  /** Reference timestamp in epoch ms used to evaluate `snoozedUntil` (defaults to `Date.now()`). */
  now?: number;
}

/** Returns true if an inbox item is currently snoozed as of `now`. */
export function isInboxItemSnoozed(
  item: Pick<InboxItem, "snoozedUntil" | "snoozed">,
  now = Date.now(),
): boolean {
  if (typeof item.snoozedUntil === "number") return item.snoozedUntil > now;
  return item.snoozed === true;
}

/** Filters inbox items by snooze state and optional priority bucket. */
export function filterInboxItems(items: InboxItem[], options?: InboxFilterOptions): InboxItem[] {
  const now = options?.now ?? Date.now();
  const mode = options?.snoozeFilter ?? (options?.includeSnoozed ? "all" : "active");
  return items.filter((item) => {
    if (options?.bucket) {
      const bucket = item.bucket ?? inboxPriorityBucket(item.kind);
      if (bucket !== options.bucket) return false;
    }
    const snoozed = isInboxItemSnoozed(item, now);
    if (mode === "active") return !snoozed;
    if (mode === "snoozed") return snoozed;
    return true;
  });
}

/** How long a plan nobody has answered stays in the inbox. It can still be answered in its conversation after that. */
export const PLAN_WAITS_MS = 7 * 86_400_000;

/** What is said about the people who have to approve a plan, when it takes more than one. */
export function planPeopleLine(plan: Pick<NonNullable<AgentTask["plan"]>, "approvals" | "requiredApprovals" | "status">): string | undefined {
  const needs = plan.requiredApprovals ?? 1;
  if (needs < 2) return undefined;
  const yes = (plan.approvals ?? []).filter((a) => a.allowed);
  const others = yes.filter((a) => a.peer).map((a) => a.actor);
  const mine = yes.some((a) => !a.peer);
  if (plan.status === "approved") return `Approved by ${yes.map((a) => (a.peer ? a.actor : "you")).join(" and ")}.`;
  if (plan.status !== "proposed") return undefined;
  if (mine) return `You approved. It waits for ${needs - yes.length > 1 ? `${needs - yes.length} more people` : "one more person"}: the others who may approve are asked in their inbox.`;
  if (others.length > 0) return `Approved by ${others.join(" and ")}. It waits for your own answer.`;
  return `${needs === 2 ? "Two" : needs} people have to approve this plan: you and ${needs === 2 ? "one more" : `${needs - 1} more`}. The others who may approve are asked in their inbox.`;
}

export function inboxItems(hub: InboxInput, options?: InboxFilterOptions): InboxItem[] {
  const out: InboxItem[] = [];
  const now = options?.now ?? Date.now();
  for (const task of hub.tasks) {
    if (!isConversation(task)) continue;
    const live = ["running", "waiting", "queued"].includes(task.status);
    const who = task.agentName || "Assistant";
    // A plan is answered when the agent has stopped, so that is when it has to be here.
    const plan = task.plan?.status === "proposed" && (live || now - task.plan.createdAt < PLAN_WAITS_MS) ? task.plan : undefined;
    if (plan) {
      const people = planPeopleLine(plan);
      out.push({
        id: `plan:${plan.id}`,
        kind: "plan",
        title: plan.goal,
        detail: `${plan.steps.length} step${plan.steps.length === 1 ? "" : "s"}${plan.review.verdict === "revise" ? " · the reviewer has objections" : ""}${people ? ` · ${people}` : ""}`,
        from: who,
        at: plan.createdAt,
        since: plan.createdAt,
        target: task.target?.label,
        taskId: task.id,
      });
    }
    if (!live) continue;
    for (const change of task.changes)
      if (change.status === "pending")
        out.push({
          id: `approval:${change.id}`,
          kind: "approval",
          title: change.description || change.command || "An action",
          // A file change shows what changes in it; a command shows the command.
          detail: change.diff ?? (change.command && change.command !== change.description ? change.command : undefined),
          from: `${who} on ${change.target}`,
          at: change.at,
          since: change.at,
          target: change.target,
          taskId: task.id,
          changeId: change.id,
        });
    if (!plan && task.status === "waiting" && !task.changes.some((c) => c.status === "pending"))
      out.push({
        id: `question:${task.id}`,
        kind: "question",
        title: task.title,
        detail: [...task.messages].reverse().find((m) => m.role === "assistant")?.text.slice(0, 240),
        from: who,
        at: task.updatedAt,
        since: task.updatedAt,
        target: task.target?.label,
        taskId: task.id,
      });
  }
  for (const t of hub.workTickets ?? []) {
    if (t.status === "review")
      out.push({ id: `review:${t.id}`, kind: "review", title: t.title, detail: t.result?.slice(0, 240), from: t.assigneeName, at: t.updatedAt, since: t.statusAt ?? t.updatedAt, target: t.target, ticketId: t.id, taskId: t.taskId });
    else if (t.status === "blocked")
      out.push({ id: `blocked:${t.id}`, kind: "blocked", title: t.title, detail: t.result?.slice(0, 240), from: t.assigneeName, at: t.updatedAt, since: t.statusAt ?? t.updatedAt, target: t.target, ticketId: t.id, taskId: t.taskId });
    // An alert waits for a person until a run has taken it: assigned to an agent is not the same as being worked.
    else if (t.alert && !t.alert.resolvedAt && (t.status === "backlog" || t.status === "todo"))
      out.push({
        id: `alert:${t.id}`,
        kind: "alert",
        title: t.title,
        detail: `${t.assigneeAgentId ? `With ${t.assigneeName ?? "an agent"}, not started yet` : "Nobody has it"}${t.alert.count > 1 ? ` · fired ${t.alert.count} times` : ""}`,
        from: t.alert.source,
        at: t.alert.lastAt,
        // The current firing: one that comes back after it had resolved is news again.
        since: t.alert.firingSince ?? t.alert.firstAt,
        target: t.target,
        ticketId: t.id,
        risk: t.alert.severity,
      });
  }
  // One item per server, however many things are wrong with it: thirty servers must not be ninety items.
  for (const server of hub.serverFacts?.servers ?? []) {
    const wrong = server.problems;
    if (!wrong.length) continue;
    out.push({
      id: `health:${server.serverId}`,
      kind: "health",
      title: wrong.length === 1 ? wrong[0].text : `${wrong.length} things need attention`,
      detail: wrong.length === 1 ? undefined : wrong.map((p) => p.text).join(" · "),
      from: server.name,
      target: server.name,
      at: server.collectedAt ?? 0,
      since: Math.min(...wrong.map((p) => p.since ?? server.collectedAt ?? 0)),
      serverId: server.serverId,
      risk: wrong.some((p) => p.severity === "critical") ? "critical" : "warning",
    });
  }
  for (const f of hub.kbFindings ?? [])
    if (KB_WORTH_A_LOOK.has(f.kind))
      out.push({ id: `knowledge:${f.id}`, kind: "knowledge", title: f.text, detail: f.detail, at: f.at, findingId: f.id });
  // Another member's change that needs a second person, and that this member may answer.
  for (const peer of hub.peerApprovals ?? [])
    out.push({
      id: `peer:${peer.ownerId}:${peer.changeId}`,
      kind: "peer",
      title: peer.plan ? `Plan: ${peer.description}` : peer.description || peer.command || "An action",
      // A plan is read whole before it is approved: every step, with its command and where it runs.
      detail: peer.plan
        ? peer.plan.steps
            .map((step, i) => `${i + 1}. [${step.risk} risk] ${step.action}${step.target ? ` (on ${step.target})` : ""}${step.command ? `\n   $ ${step.command}` : ""}`)
            .join("\n")
        : peer.command && peer.command !== peer.description
          ? peer.command
          : undefined,
      from: `${peer.ownerName}${peer.agentName ? ` (${peer.agentName})` : ""}${peer.target ? ` on ${peer.target}` : ""}`,
      at: peer.at,
      since: peer.at,
      target: peer.target,
      taskId: peer.taskId,
      changeId: peer.changeId,
      ownerId: peer.ownerId,
    });
  if (hub.dailyReport && !hub.dailyReport.readAt)
    out.push({ id: `report:${hub.dailyReport.day}`, kind: "report", title: `What happened ${hub.dailyReport.day}`, detail: hub.dailyReport.text.slice(0, 240), at: hub.dailyReport.at, since: hub.dailyReport.at });
  const rank: Record<InboxKind, number> = { approval: 0, peer: 0, plan: 0, question: 0, alert: 1, blocked: 1, health: 2, review: 2, report: 3, knowledge: 4 };
  const stateMap = hub.inboxState;
  const enriched = out.map((item): InboxItem => {
    const bucket = inboxPriorityBucket(item.kind);
    const state = stateMap?.[item.id];
    const snoozedUntil = state?.snoozedUntil ?? item.snoozedUntil;
    const acknowledgedAt = state?.acknowledgedAt ?? item.acknowledgedAt;
    const snoozed = typeof snoozedUntil === "number" && snoozedUntil > now;
    return {
      ...item,
      bucket,
      ...(snoozedUntil !== undefined ? { snoozedUntil } : {}),
      ...(acknowledgedAt !== undefined ? { acknowledgedAt } : {}),
      ...(snoozed ? { snoozed: true } : {}),
    };
  });
  const sorted = enriched.sort((a, b) => rank[a.kind] - rank[b.kind] || b.at - a.at);
  return filterInboxItems(sorted, { ...options, now });
}

/**
 * Counts urgent, active inbox items (`blocking` and `incident` buckets) that are
 * neither currently snoozed nor acknowledged. Used for unread/urgent inbox badges.
 */
export function countUrgentInboxItems(
  hubOrItems: InboxInput | InboxItem[],
  options?: { now?: number },
): number {
  const now = options?.now ?? Date.now();
  const items = Array.isArray(hubOrItems) ? hubOrItems : inboxItems(hubOrItems, { now });
  let count = 0;
  for (const item of items) {
    if (isInboxItemSnoozed(item, now)) continue;
    if (item.acknowledgedAt !== undefined) continue;
    const bucket = item.bucket ?? inboxPriorityBucket(item.kind);
    if (bucket === "blocking" || bucket === "incident") count++;
  }
  return count;
}

/**
 * How many items still wait for a person: the number for the Inbox tab.
 * A snoozed item does not count, and neither does an alert somebody has
 * acknowledged: it stays in the list with its badge, but it is no longer news.
 * An acknowledged approval, plan or question still counts: an agent is held up by it.
 */
export function countWaitingInboxItems(
  hubOrItems: InboxInput | InboxItem[],
  options?: { now?: number },
): number {
  const now = options?.now ?? Date.now();
  const items = Array.isArray(hubOrItems) ? hubOrItems : inboxItems(hubOrItems, { now });
  return items.filter(
    (item) => !isInboxItemSnoozed(item, now) && !(item.kind === "alert" && item.acknowledgedAt !== undefined),
  ).length;
}
