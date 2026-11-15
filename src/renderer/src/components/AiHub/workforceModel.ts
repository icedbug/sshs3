import type {
  AgentHypothesis,
  AgentTask,
  AgentUsage,
  HubSnapshot,
  InfraGraphEdge,
  MissionAgent,
  WorkGoal,
  WorkTicket,
  WorkTicketStatus,
  WorkspaceServerSummary,
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
  const workforcePaused = hub.workforcePaused === true;
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
    } else if (workforcePaused) {
      state = "paused";
      doing = "Workforce paused";
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

// ---- Priority sorting, SLA age, and correlated-alert grouping -------------

export type TicketPriorityLevel = "critical" | "warning" | "info" | "normal";
export type SlaLevel = "normal" | "warn" | "breach";

function normalizeSeverity(raw?: string): "critical" | "warning" | "info" {
  const s = (raw ?? "").toLowerCase();
  if (s === "critical" || s === "crit" || s === "sev1" || s === "p1" || s === "high") return "critical";
  if (s === "warning" || s === "warn" || s === "sev2" || s === "p2" || s === "medium") return "warning";
  return "info";
}

const SEVERITY_RANK: Record<"critical" | "warning" | "info", number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

const PRIORITY_RANK: Record<TicketPriorityLevel, number> = {
  critical: 0,
  warning: 1,
  info: 2,
  normal: 3,
};

export interface CorrelatedAlertItem {
  key: string;
  fingerprint?: string;
  summary: string;
  severity: "critical" | "warning" | "info";
  at: number;
  count: number;
  source?: string;
  primary?: boolean;
}

export interface CorrelatedAlertGroup {
  total: number;
  highestSeverity?: "critical" | "warning" | "info";
  items: CorrelatedAlertItem[];
}

/**
 * Groups the primary alert and `correlatedAlerts` on a `WorkTicket`,
 * deduplicating by fingerprint/summary and sorting highest severity / newest first.
 */
export function groupCorrelatedAlerts(ticket: WorkTicket): CorrelatedAlertGroup {
  const map = new Map<string, CorrelatedAlertItem>();
  if (ticket.alert) {
    const key = ticket.alert.fingerprint || ticket.alert.name || ticket.title;
    map.set(key, {
      key,
      fingerprint: ticket.alert.fingerprint,
      summary: ticket.alert.name || ticket.title,
      severity: ticket.alert.severity,
      at: ticket.alert.lastAt || ticket.alert.firstAt,
      count: Math.max(1, ticket.alert.count ?? 1),
      source: ticket.alert.source,
      primary: true,
    });
  }
  for (const ref of ticket.correlatedAlerts ?? []) {
    const key = ref.fingerprint || ref.summary;
    const sev = normalizeSeverity(ref.severity);
    const existing = map.get(key);
    if (existing) {
      existing.count += 1;
      if (ref.at > existing.at) existing.at = ref.at;
      if (SEVERITY_RANK[sev] < SEVERITY_RANK[existing.severity]) {
        existing.severity = sev;
      }
    } else {
      map.set(key, {
        key,
        fingerprint: ref.fingerprint,
        summary: ref.summary,
        severity: sev,
        at: ref.at,
        count: 1,
      });
    }
  }
  const items = [...map.values()].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.at - a.at,
  );
  const total = items.reduce((sum, item) => sum + item.count, 0);
  return {
    total,
    highestSeverity: items[0]?.severity,
    items,
  };
}

/** Priority level derived from active/correlated alerts on a ticket. */
export function ticketPriorityLevel(ticket: WorkTicket): TicketPriorityLevel {
  if (ticket.alert && !ticket.alert.resolvedAt) {
    return ticket.alert.severity;
  }
  const correlated = ticket.correlatedAlerts ?? [];
  if (correlated.length > 0) {
    let best: "critical" | "warning" | "info" = "info";
    for (const c of correlated) {
      const sev = normalizeSeverity(c.severity);
      if (SEVERITY_RANK[sev] < SEVERITY_RANK[best]) best = sev;
    }
    return best;
  }
  return "normal";
}

export function ticketPriorityRank(ticket: WorkTicket): number {
  return PRIORITY_RANK[ticketPriorityLevel(ticket)];
}

export function ticketAnchorAt(ticket: WorkTicket): number {
  return ticket.alert?.firingSince ?? ticket.alert?.firstAt ?? ticket.statusAt ?? ticket.createdAt;
}

/** Comparator putting critical & firing alert tickets first, then correlated count, then oldest SLA age. */
export function compareTicketsByPriority(a: WorkTicket, b: WorkTicket): number {
  const rankDiff = ticketPriorityRank(a) - ticketPriorityRank(b);
  if (rankDiff !== 0) return rankDiff;
  const corrDiff = (b.correlatedAlerts?.length ?? 0) - (a.correlatedAlerts?.length ?? 0);
  if (corrDiff !== 0) return corrDiff;
  const countDiff = (b.alert?.count ?? 0) - (a.alert?.count ?? 0);
  if (countDiff !== 0) return countDiff;
  const ageDiff = ticketAnchorAt(a) - ticketAnchorAt(b);
  if (ageDiff !== 0) return ageDiff;
  return a.createdAt - b.createdAt;
}

export function sortTicketsByPriority(tickets: readonly WorkTicket[]): WorkTicket[] {
  return [...tickets].sort(compareTicketsByPriority);
}

export function formatSlaAge(ageMs: number): string {
  const safe = Math.max(0, ageMs);
  const mins = Math.floor(safe / 60_000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const remMins = mins % 60;
    return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

export interface TicketSlaInfo {
  ageMs: number;
  label: string;
  level: SlaLevel;
  anchorAt: number;
}

/** Computes SLA age and breach status based on ticket alert severity and open duration. */
export function ticketSlaInfo(ticket: WorkTicket, now = Date.now()): TicketSlaInfo {
  const anchorAt = ticketAnchorAt(ticket);
  const ageMs = Math.max(0, now - anchorAt);
  const label = formatSlaAge(ageMs);
  if (ticket.status === "done") {
    return { ageMs, label, level: "normal", anchorAt };
  }
  const prio = ticketPriorityLevel(ticket);
  const warnMs = prio === "critical" ? 15 * 60_000 : prio === "warning" ? 60 * 60_000 : 4 * 3_600_000;
  const breachMs = prio === "critical" ? 60 * 60_000 : prio === "warning" ? 4 * 3_600_000 : 24 * 3_600_000;
  const level: SlaLevel = ageMs >= breachMs ? "breach" : ageMs >= warnMs ? "warn" : "normal";
  return { ageMs, label, level, anchorAt };
}

// ---- Cycle-proof Hypothesis Tree Builder -----------------------------------

export interface HypothesisCycleRef {
  id: string;
  text: string;
}

export interface HypothesisTreeNode {
  hypothesis: AgentHypothesis;
  depth: number;
  children: HypothesisTreeNode[];
  cycleTargets: HypothesisCycleRef[];
}

export interface HypothesisTreeGraph {
  roots: HypothesisTreeNode[];
  cycleCount: number;
  total: number;
}

/**
 * Builds a cycle-proof hypothesis forest.
 * - Uses an ancestor `visiting` set per DFS branch so any self-loop or N-node cycle
 *   emits a `cycleTargets` indicator instead of looping forever.
 * - Tracks `placed` nodes globally so detached cycles (e.g. `h1 <-> h2` with no
 *   parentless root) are still surfaced as roots rather than dropped.
 */
export function buildHypothesisTree(hypotheses: readonly AgentHypothesis[]): HypothesisTreeGraph {
  if (hypotheses.length === 0) {
    return { roots: [], cycleCount: 0, total: 0 };
  }
  const byId = new Map<string, AgentHypothesis>();
  for (const h of hypotheses) {
    if (!byId.has(h.id)) byId.set(h.id, h);
  }
  const childrenMap = new Map<string, AgentHypothesis[]>();
  const naturalRoots: AgentHypothesis[] = [];
  for (const h of hypotheses) {
    if (!h.parentId || h.parentId === h.id || !byId.has(h.parentId)) {
      naturalRoots.push(h);
    } else {
      const list = childrenMap.get(h.parentId);
      if (list) list.push(h);
      else childrenMap.set(h.parentId, [h]);
    }
  }

  const placed = new Set<string>();
  let cycleCount = 0;

  const visit = (h: AgentHypothesis, depth: number, ancestors: Set<string>): HypothesisTreeNode => {
    placed.add(h.id);
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(h.id);
    const children: HypothesisTreeNode[] = [];
    const cycleTargets: HypothesisCycleRef[] = [];

    if (h.parentId === h.id) {
      cycleCount += 1;
      cycleTargets.push({ id: h.id, text: h.text });
    }

    for (const child of childrenMap.get(h.id) ?? []) {
      if (nextAncestors.has(child.id)) {
        cycleCount += 1;
        cycleTargets.push({ id: child.id, text: child.text });
        continue;
      }
      if (placed.has(child.id)) {
        continue;
      }
      children.push(visit(child, depth + 1, nextAncestors));
    }

    return { hypothesis: h, depth, children, cycleTargets };
  };

  const roots: HypothesisTreeNode[] = [];
  for (const root of naturalRoots) {
    if (!placed.has(root.id)) {
      roots.push(visit(root, 0, new Set()));
    }
  }
  // Detached cycles (every node has a valid parentId inside the cycle): break cleanly from the first unplaced node.
  for (const h of hypotheses) {
    if (!placed.has(h.id)) {
      roots.push(visit(h, 0, new Set()));
    }
  }

  return { roots, cycleCount, total: hypotheses.length };
}

// ---- Cycle-proof Infrastructure Topology & Blast-Radius Builder ------------

export interface TopologyNode {
  id: string;
  label: string;
  tier: number;
  incoming: InfraGraphEdge[];
  outgoing: InfraGraphEdge[];
  /** Downstream nodes impacted if this node fails (transitive, cycle-safe, excludes self). */
  downstreamIds: string[];
  /** Upstream nodes this node depends on (transitive, cycle-safe, excludes self). */
  upstreamIds: string[];
  blastRadius: number;
  hasCycle: boolean;
}

export interface DependencyTopology {
  nodes: TopologyNode[];
  edges: InfraGraphEdge[];
  proposedEdges: InfraGraphEdge[];
  cycles: string[][];
}

function impactDirection(edge: InfraGraphEdge): { provider: string; consumer: string } | null {
  if (edge.from === edge.to) return null;
  switch (edge.relation) {
    case "depends_on":
    case "mounts_storage":
    case "ssh_tunnel":
      // `from` depends on `to` -> failure in `to` impacts `from`.
      return { provider: edge.to, consumer: edge.from };
    case "replicates_to":
    case "routes_to":
      // `from` feeds/routes to `to` -> failure in `from` impacts `to`.
      return { provider: edge.from, consumer: edge.to };
    case "monitors":
      // Monitoring does not propagate operational failure blast radius.
      return null;
  }
}

function bfsReachable(start: string, adj: Map<string, Set<string>>): string[] {
  const visited = new Set<string>([start]);
  const queue: string[] = [start];
  const out: string[] = [];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const next of adj.get(cur) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        out.push(next);
        queue.push(next);
      }
    }
  }
  return out;
}

/**
 * Builds a cycle-proof dependency topology from `InfraGraphEdge[]` and optional workspace servers.
 * Computes directional blast-radius counts, upstream/downstream reachability, topological tiers,
 * and safely detects cycles without infinite recursion.
 */
export function buildDependencyTopology(
  allEdges: readonly InfraGraphEdge[],
  servers?: readonly Pick<WorkspaceServerSummary, "id" | "name" | "cluster">[],
): DependencyTopology {
  const edges = allEdges.filter((e) => !e.proposed);
  const proposedEdges = allEdges.filter((e) => e.proposed);

  const nodeIds = new Set<string>();
  for (const e of edges) {
    nodeIds.add(e.from);
    nodeIds.add(e.to);
  }
  // Include servers referenced only by proposed edges when no confirmed edges reference them? Keep confirmed + edge endpoints; also include known server names if edges exist or if passed?
  // Only include nodes that participate in confirmed edges so empty graphs stay empty.
  void servers;

  const incoming = new Map<string, InfraGraphEdge[]>();
  const outgoing = new Map<string, InfraGraphEdge[]>();
  const impactForward = new Map<string, Set<string>>();
  const impactReverse = new Map<string, Set<string>>();
  const cycleNodes = new Set<string>();
  const cycles: string[][] = [];

  for (const id of nodeIds) {
    incoming.set(id, []);
    outgoing.set(id, []);
    impactForward.set(id, new Set());
    impactReverse.set(id, new Set());
  }

  for (const e of edges) {
    outgoing.get(e.from)!.push(e);
    incoming.get(e.to)!.push(e);
    if (e.from === e.to) {
      cycleNodes.add(e.from);
      cycles.push([e.from, e.to]);
      continue;
    }
    const dir = impactDirection(e);
    if (dir) {
      impactForward.get(dir.provider)!.add(dir.consumer);
      impactReverse.get(dir.consumer)!.add(dir.provider);
    }
  }

  // Detect cycles safely with 3-color iterative/recursive DFS over all directed edges (`from -> to`).
  const directedAdj = new Map<string, string[]>();
  for (const id of nodeIds) directedAdj.set(id, []);
  for (const e of edges) {
    if (e.from !== e.to) directedAdj.get(e.from)!.push(e.to);
  }
  const color = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const seenCycleKeys = new Set<string>();
  const dfsCycle = (u: string): void => {
    color.set(u, 1);
    stack.push(u);
    for (const v of directedAdj.get(u) ?? []) {
      const c = color.get(v) ?? 0;
      if (c === 1) {
        const idx = stack.indexOf(v);
        const loop = idx >= 0 ? [...stack.slice(idx), v] : [u, v];
        const key = loop.join("->");
        if (!seenCycleKeys.has(key)) {
          seenCycleKeys.add(key);
          cycles.push(loop);
        }
        for (const n of loop) cycleNodes.add(n);
      } else if (c === 0) {
        dfsCycle(v);
      }
    }
    stack.pop();
    color.set(u, 2);
  };
  for (const id of nodeIds) {
    if ((color.get(id) ?? 0) === 0) dfsCycle(id);
  }

  // Topological tier assignment over impactForward (foundational providers at tier 0, impacted consumers higher).
  const tier = new Map<string, number>();
  const inDegree = new Map<string, number>();
  for (const id of nodeIds) {
    inDegree.set(id, impactReverse.get(id)!.size);
    tier.set(id, 0);
  }
  const q: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) q.push(id);
  }
  const processed = new Set<string>();
  while (q.length > 0) {
    const u = q.shift()!;
    processed.add(u);
    const nextTier = (tier.get(u) ?? 0) + 1;
    for (const v of impactForward.get(u) ?? []) {
      if (nextTier > (tier.get(v) ?? 0)) tier.set(v, nextTier);
      const nextDeg = (inDegree.get(v) ?? 1) - 1;
      inDegree.set(v, nextDeg);
      if (nextDeg === 0) q.push(v);
    }
  }
  // Any nodes locked in cycles get placed cleanly without looping.
  for (const id of nodeIds) {
    if (!processed.has(id)) {
      let maxUpstream = 0;
      for (const up of impactReverse.get(id) ?? []) {
        if (processed.has(up)) maxUpstream = Math.max(maxUpstream, (tier.get(up) ?? 0) + 1);
      }
      tier.set(id, maxUpstream);
    }
  }

  const nodes: TopologyNode[] = [...nodeIds]
    .map((id) => {
      const downstreamIds = bfsReachable(id, impactForward);
      const upstreamIds = bfsReachable(id, impactReverse);
      return {
        id,
        label: id,
        tier: tier.get(id) ?? 0,
        incoming: incoming.get(id) ?? [],
        outgoing: outgoing.get(id) ?? [],
        downstreamIds,
        upstreamIds,
        blastRadius: downstreamIds.length,
        hasCycle: cycleNodes.has(id),
      };
    })
    .sort((a, b) => a.tier - b.tier || b.blastRadius - a.blastRadius || a.id.localeCompare(b.id));

  return { nodes, edges, proposedEdges, cycles };
}

export { inboxItems, isConversation } from "@shared/aiHubInbox";
export type { InboxInput, InboxItem, InboxKind } from "@shared/aiHubInbox";
