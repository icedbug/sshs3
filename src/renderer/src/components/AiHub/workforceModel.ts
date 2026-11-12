import type {
  AgentTask,
  AgentUsage,
  HubSnapshot,
  MissionAgent,
  WorkGoal,
  WorkTicket,
  WorkTicketStatus,
} from "@shared/types/aiHub";

export const COLUMNS: { status: WorkTicketStatus; title: string; hint: string }[] = [
  { status: "backlog", title: "Backlog", hint: "Not ready or nobody assigned" },
  { status: "todo", title: "To do", hint: "Ready for its agent" },
  { status: "in_progress", title: "In progress", hint: "An agent is running it" },
  { status: "review", title: "Review", hint: "The agent reported; you decide" },
  { status: "blocked", title: "Blocked", hint: "The run failed or was stopped" },
  { status: "done", title: "Done", hint: "" },
];

export type AgentState = "working" | "waiting" | "paused" | "out-of-budget" | "idle";

export interface AgentLive {
  agent: MissionAgent;
  state: AgentState;
  /** The ticket it is running in this app, or one a teammate's app is running. */
  ticket?: WorkTicket;
  /** The conversation of the run, when it is running here. */
  task?: AgentTask;
  /** One line on what it is doing right now. */
  doing: string;
  open: number;
  spent: number;
  budget?: number;
}

const month = (): string => new Date().toISOString().slice(0, 7);

export function spentThisMonth(usage: Record<string, AgentUsage> | undefined, agentId: string): number {
  const u = usage?.[agentId];
  return u && u.month === month() ? u.tokens : 0;
}

/** What each agent is doing, read from the board and the running conversations. */
export function agentsLive(hub: HubSnapshot): AgentLive[] {
  const tickets = hub.workTickets ?? [];
  return (hub.agents ?? []).map((agent) => {
    const mine = tickets.filter((t) => t.assigneeAgentId === agent.id);
    const running = mine.find((t) => t.status === "in_progress");
    const task = running ? hub.tasks.find((t) => t.id === running.taskId) : undefined;
    const spent = spentThisMonth(hub.agentUsage, agent.id);
    const budget = agent.monthlyTokenBudget || undefined;
    let state: AgentState = "idle";
    let doing = "";
    if (agent.enabled === false) {
      state = "paused";
      doing = "Paused";
    } else if (running) {
      const pending = task?.changes.find((c) => c.status === "pending");
      if (task?.status === "waiting" || pending) {
        state = "waiting";
        doing = pending ? `Waiting for you: ${pending.description}` : "Waiting for your answer";
      } else {
        state = "working";
        const step = (task?.todos ?? []).find((t) => t.status === "in_progress");
        const command = [...(task?.changes ?? [])].reverse().find((c) => c.kind === "command");
        doing = step?.content
          ? step.content
          : command?.command
            ? `$ ${command.command}`
            : task
              ? "Thinking…"
              : `Running on ${running.claim?.by ?? "a teammate"}'s computer`;
      }
    } else if (budget && spent >= budget) {
      state = "out-of-budget";
      doing = "Out of budget this month";
    }
    return {
      agent,
      state,
      ticket: running,
      task,
      doing,
      open: mine.filter((t) => t.status !== "done").length,
      spent,
      budget,
    };
  });
}

export function goalProgress(goal: WorkGoal, tickets: WorkTicket[]): { done: number; total: number } {
  const mine = tickets.filter((t) => t.goalId === goal.id);
  return { done: mine.filter((t) => t.status === "done").length, total: mine.length };
}

export interface OrgNode {
  id: string;
  x: number;
  y: number;
  depth: number;
}

/**
 * Places agents as a tree: whoever reports to nobody is at the top, reports
 * under their lead, each subtree centred under its root. A reporting line to
 * an agent that no longer exists, or one that closes a circle, is ignored.
 */
export function layoutOrg(
  agents: Pick<MissionAgent, "id" | "reportsTo">[],
  size = { w: 250, h: 150, gapX: 28, gapY: 60 },
): OrgNode[] {
  const ids = new Set(agents.map((a) => a.id));
  const parent = new Map<string, string | undefined>();
  for (const a of agents) {
    let boss = a.reportsTo && ids.has(a.reportsTo) && a.reportsTo !== a.id ? a.reportsTo : undefined;
    // Walk up: a circle means this line cannot be drawn.
    const seen = new Set([a.id]);
    let up = boss;
    while (up) {
      if (seen.has(up)) {
        boss = undefined;
        break;
      }
      seen.add(up);
      up = agents.find((x) => x.id === up)?.reportsTo;
      if (up && !ids.has(up)) up = undefined;
    }
    parent.set(a.id, boss);
  }
  const children = new Map<string, string[]>();
  for (const a of agents) {
    const p = parent.get(a.id);
    if (p) children.set(p, [...(children.get(p) ?? []), a.id]);
  }
  const roots = agents.filter((a) => !parent.get(a.id)).map((a) => a.id);
  const leads = roots.filter((r) => (children.get(r)?.length ?? 0) > 0);
  const loners = roots.filter((r) => (children.get(r)?.length ?? 0) === 0);
  const out: OrgNode[] = [];
  let cursor = 0;
  const place = (id: string, depth: number): number => {
    const kids = children.get(id) ?? [];
    let x: number;
    if (kids.length === 0) {
      x = cursor;
      cursor += size.w + size.gapX;
    } else {
      const xs = kids.map((k) => place(k, depth + 1));
      x = (xs[0] + xs[xs.length - 1]) / 2;
    }
    out.push({ id, x, y: depth * (size.h + size.gapY), depth });
    return x;
  };
  for (const r of leads) place(r, 0);
  // Agents outside any team sit in rows under the trees instead of one long line.
  const cell = size.w + size.gapX;
  const perRow = Math.max(4, Math.round(cursor / cell));
  const top = leads.length ? (Math.max(...out.map((n) => n.depth)) + 1) * (size.h + size.gapY) + size.gapY : 0;
  loners.forEach((id, i) =>
    out.push({ id, x: (i % perRow) * cell, y: top + Math.floor(i / perRow) * (size.h + size.gapX), depth: 0 }),
  );
  return out;
}

export const tokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);

export type InboxKind = "approval" | "plan" | "question" | "review" | "blocked" | "alert" | "knowledge" | "report";

/** One thing that is waiting for a person. */
export interface InboxItem {
  id: string;
  kind: InboxKind;
  title: string;
  detail?: string;
  /** Who is asking: an agent, a monitoring system. */
  from?: string;
  at: number;
  taskId?: string;
  changeId?: string;
  ticketId?: string;
  findingId?: string;
  risk?: string;
}

const KB_WORTH_A_LOOK = new Set(["gap", "contradiction", "dead-target", "lost-source"]);

/**
 * Everything that waits for a person, from wherever it sits: a command an
 * agent wants to run, a plan to decide, a question, a ticket to review, a run
 * that stopped, an alert nobody has, a gap in the knowledge base. Most urgent
 * first: what blocks a running agent, then what stopped, then the rest.
 */
export function inboxItems(hub: HubSnapshot): InboxItem[] {
  const out: InboxItem[] = [];
  for (const task of hub.tasks) {
    if (task.workforceRunId || task.distillSourceId) continue;
    const live = ["running", "waiting", "queued"].includes(task.status);
    if (!live) continue;
    const who = task.agentName || "Assistant";
    for (const change of task.changes)
      if (change.status === "pending")
        out.push({
          id: `approval:${change.id}`,
          kind: "approval",
          title: change.description || change.command || "An action",
          detail: change.command && change.command !== change.description ? change.command : undefined,
          from: `${who} on ${change.target}`,
          at: change.at,
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
        taskId: task.id,
      });
  }
  for (const t of hub.workTickets ?? []) {
    if (t.status === "review")
      out.push({ id: `review:${t.id}`, kind: "review", title: t.title, detail: t.result?.slice(0, 240), from: t.assigneeName, at: t.updatedAt, ticketId: t.id, taskId: t.taskId });
    else if (t.status === "blocked")
      out.push({ id: `blocked:${t.id}`, kind: "blocked", title: t.title, detail: t.result?.slice(0, 240), from: t.assigneeName, at: t.updatedAt, ticketId: t.id, taskId: t.taskId });
    else if (t.alert && !t.alert.resolvedAt && (t.status === "backlog" || (t.status === "todo" && !t.assigneeAgentId)))
      out.push({
        id: `alert:${t.id}`,
        kind: "alert",
        title: t.title,
        detail: `Nobody has it${t.alert.count > 1 ? ` · fired ${t.alert.count} times` : ""}`,
        from: t.alert.source,
        at: t.alert.lastAt,
        ticketId: t.id,
        risk: t.alert.severity,
      });
  }
  for (const f of hub.kbFindings ?? [])
    if (KB_WORTH_A_LOOK.has(f.kind))
      out.push({ id: `knowledge:${f.id}`, kind: "knowledge", title: f.text, detail: f.detail, at: f.at, findingId: f.id });
  if (hub.dailyReport && !hub.dailyReport.readAt)
    out.push({ id: `report:${hub.dailyReport.day}`, kind: "report", title: `What happened ${hub.dailyReport.day}`, detail: hub.dailyReport.text.slice(0, 240), at: hub.dailyReport.at });
  const rank: Record<InboxKind, number> = { approval: 0, plan: 0, question: 0, alert: 1, blocked: 1, review: 2, report: 3, knowledge: 4 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind] || b.at - a.at);
}
