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
