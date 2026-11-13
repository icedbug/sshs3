import type { AgentTask, HubSnapshot } from "./types/aiHub";

/** A conversation of the user's own, not one of the hub's runs (specialists, readings for memory and pages, test cases). */
export const isConversation = (t: Pick<AgentTask, "workforceRunId" | "distillSourceId" | "evalCaseId">): boolean =>
  !t.workforceRunId && !t.distillSourceId && !t.evalCaseId;

export type InboxKind = "approval" | "plan" | "question" | "review" | "blocked" | "alert" | "health" | "knowledge" | "report";

/** One thing that is waiting for a person. */
export interface InboxItem {
  id: string;
  kind: InboxKind;
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
  ticketId?: string;
  findingId?: string;
  /** A server with problems of its own (disk, certificate, failed service). */
  serverId?: string;
  risk?: string;
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
  Partial<Pick<HubSnapshot, "workTickets" | "kbFindings" | "dailyReport">> & {
    serverFacts?: Pick<NonNullable<HubSnapshot["serverFacts"]>, "servers">;
  };

export function inboxItems(hub: InboxInput): InboxItem[] {
  const out: InboxItem[] = [];
  for (const task of hub.tasks) {
    if (!isConversation(task)) continue;
    const live = ["running", "waiting", "queued"].includes(task.status);
    if (!live) continue;
    const who = task.agentName || "Assistant";
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
          risk: change.riskLevel,
        });
    if (task.plan?.status === "proposed")
      out.push({
        id: `plan:${task.plan.id}`,
        kind: "plan",
        title: task.plan.goal,
        detail: `${task.plan.steps.length} step${task.plan.steps.length === 1 ? "" : "s"}${task.plan.review.verdict === "revise" ? " · the reviewer has objections" : ""}`,
        from: who,
        at: task.plan.createdAt,
        since: task.plan.createdAt,
        target: task.target?.label,
        taskId: task.id,
      });
    else if (task.status === "waiting" && !task.changes.some((c) => c.status === "pending"))
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
    else if (t.alert && !t.alert.resolvedAt && (t.status === "backlog" || (t.status === "todo" && !t.assigneeAgentId)))
      out.push({
        id: `alert:${t.id}`,
        kind: "alert",
        title: t.title,
        detail: `Nobody has it${t.alert.count > 1 ? ` · fired ${t.alert.count} times` : ""}`,
        from: t.alert.source,
        at: t.alert.lastAt,
        since: t.alert.firstAt,
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
  if (hub.dailyReport && !hub.dailyReport.readAt)
    out.push({ id: `report:${hub.dailyReport.day}`, kind: "report", title: `What happened ${hub.dailyReport.day}`, detail: hub.dailyReport.text.slice(0, 240), at: hub.dailyReport.at, since: hub.dailyReport.at });
  const rank: Record<InboxKind, number> = { approval: 0, plan: 0, question: 0, alert: 1, blocked: 1, health: 2, review: 2, report: 3, knowledge: 4 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind] || b.at - a.at);
}
