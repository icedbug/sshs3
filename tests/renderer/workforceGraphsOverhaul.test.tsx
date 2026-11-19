// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  AgentHypothesis,
  AgentTask,
  HubSnapshot,
  InfraGraphEdge,
  MissionAgent,
  WorkTicket,
} from "../../src/shared/types/aiHub";
import { taskForSnapshot } from "../../src/main/ai/hub/hubShared";
import { DependencyLinks } from "../../src/renderer/src/components/AiHub/DependencyLinks";
import { HypothesisTree } from "../../src/renderer/src/components/AiHub/HypothesisTree";
import { TeamGraph } from "../../src/renderer/src/components/AiHub/TeamGraph";
import { WorkforceView } from "../../src/renderer/src/components/AiHub/WorkforceView";
import {
  agentsLive,
  buildDependencyTopology,
  buildHypothesisTree,
  groupCorrelatedAlerts,
  sortTicketsByPriority,
  ticketSlaInfo,
} from "../../src/renderer/src/components/AiHub/workforceModel";

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class ResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const makeAgent = (id: string, extra: Partial<MissionAgent> = {}): MissionAgent => ({
  id,
  name: id,
  role: "SRE",
  mission: "Keep prod healthy",
  systemPrompt: "",
  defaultMode: "assisted",
  updatedAt: 1,
  ...extra,
});

const makeTicket = (id: string, extra: Partial<WorkTicket> = {}): WorkTicket => ({
  id,
  title: `Ticket ${id}`,
  description: "",
  status: "todo",
  assigneeAgentId: "lead",
  assigneeName: "lead",
  createdBy: "jacob",
  createdAt: 1000,
  updatedAt: 1000,
  ...extra,
});

const makeHub = (extra: Partial<HubSnapshot> = {}): HubSnapshot =>
  ({
    tasks: [],
    sessions: [],
    agents: [],
    workGoals: [],
    workTickets: [],
    agentUsage: {},
    workforceTemplates: [],
    workBoardSync: { shared: false },
    preferences: {},
    ...extra,
  }) as unknown as HubSnapshot;

describe("workforceModel helpers", () => {
  it("sorts critical and alert tickets ahead of normal tickets and computes SLA levels", () => {
    const now = 10_000_000;
    const normal = makeTicket("normal", { createdAt: now - 10 * 60_000 });
    const warn = makeTicket("warn", {
      createdAt: now - 2 * 3_600_000,
      alert: {
        fingerprint: "fp-warn",
        name: "High CPU",
        source: "prometheus",
        severity: "warning",
        firstAt: now - 2 * 3_600_000,
        lastAt: now - 60_000,
        count: 2,
      },
    });
    const critOld = makeTicket("crit-old", {
      createdAt: now - 90 * 60_000,
      alert: {
        fingerprint: "fp-crit-old",
        name: "Disk Full",
        source: "prometheus",
        severity: "critical",
        firstAt: now - 90 * 60_000,
        lastAt: now - 30_000,
        count: 4,
      },
      correlatedAlerts: [{ summary: "DB read-only", severity: "critical", at: now - 120_000 }],
    });
    const critNew = makeTicket("crit-new", {
      createdAt: now - 5 * 60_000,
      alert: {
        fingerprint: "fp-crit-new",
        name: "API 502",
        source: "prometheus",
        severity: "critical",
        firstAt: now - 5 * 60_000,
        lastAt: now - 10_000,
        count: 1,
      },
    });

    const sorted = sortTicketsByPriority([normal, warn, critNew, critOld]);
    expect(sorted.map((t) => t.id)).toEqual(["crit-old", "crit-new", "warn", "normal"]);

    expect(ticketSlaInfo(critOld, now).level).toBe("breach");
    expect(ticketSlaInfo(critNew, now).level).toBe("normal");
    expect(ticketSlaInfo(warn, now).level).toBe("warn");
    expect(ticketSlaInfo(makeTicket("done", { status: "done", createdAt: 0 }), now).level).toBe("normal");
  });

  it("groups primary and correlated alerts by fingerprint/summary", () => {
    const ticket = makeTicket("t-corr", {
      alert: {
        fingerprint: "fp-1",
        name: "Primary outage",
        source: "alertmanager",
        severity: "warning",
        firstAt: 100,
        lastAt: 200,
        count: 2,
      },
      correlatedAlerts: [
        { fingerprint: "fp-1", summary: "Primary outage", severity: "critical", at: 300 },
        { fingerprint: "fp-2", summary: "Downstream 503", severity: "warning", at: 250 },
      ],
    });
    const grouped = groupCorrelatedAlerts(ticket);
    expect(grouped.total).toBe(4);
    expect(grouped.highestSeverity).toBe("critical");
    expect(grouped.items).toHaveLength(2);
    expect(grouped.items[0]).toMatchObject({ fingerprint: "fp-1", severity: "critical", count: 3 });
  });

  it("breaks cycles safely in hypothesis tree and dependency topology builders", () => {
    const cyclicHyps: AgentHypothesis[] = [
      { id: "h1", text: "Loop A", status: "open", parentId: "h2", evidence: [] },
      { id: "h2", text: "Loop B", status: "open", parentId: "h1", evidence: [] },
    ];
    const hTree = buildHypothesisTree(cyclicHyps);
    expect(hTree.total).toBe(2);
    expect(hTree.cycleCount).toBe(1);
    expect(hTree.roots).toHaveLength(1);
    expect(hTree.roots[0].children[0].cycleTargets[0].id).toBe("h1");

    const edges: InfraGraphEdge[] = [
      { id: "e1", from: "web", to: "api", relation: "depends_on", updatedAt: 1 },
      { id: "e2", from: "api", to: "db", relation: "depends_on", updatedAt: 1 },
      { id: "e3", from: "db", to: "api", relation: "replicates_to", updatedAt: 1 },
    ];
    const topo = buildDependencyTopology(edges);
    expect(topo.cycles.length).toBeGreaterThan(0);
    const byId = new Map(topo.nodes.map((n) => [n.id, n]));
    expect(byId.get("db")!.blastRadius).toBe(2);
    expect(byId.get("db")!.downstreamIds.sort()).toEqual(["api", "web"]);
    expect(byId.get("web")!.blastRadius).toBe(0);
    expect(byId.get("api")!.hasCycle).toBe(true);
  });
});

describe("TeamGraph", () => {
  it("renders minimap, legend, fit controls, distinct states, and does not remount on selection change", () => {
    const hub = makeHub({
      agents: [
        makeAgent("lead"),
        makeAgent("worker", { reportsTo: "lead" }),
        makeAgent("snoozer", { reportsTo: "lead", enabled: false }),
      ],
      workTickets: [
        makeTicket("t1", { status: "in_progress", assigneeAgentId: "worker", taskId: "task1" }),
      ],
      tasks: [
        {
          id: "task1",
          title: "Check disk",
          mode: "assisted",
          status: "running",
          messages: [],
          changes: [{ id: "c1", kind: "command", command: "df -h", status: "running", description: "", target: "prod", at: 1 }],
          sources: [],
          todos: [],
          createdAt: 1,
          updatedAt: 1,
          maxCommands: 5,
          maxMinutes: 5,
          verification: "not-verified",
        },
      ],
    });
    const team = agentsLive(hub);
    const onSelect = vi.fn();

    const { rerender } = render(
      <TeamGraph team={team} selectedId={undefined} workforcePaused={false} onSelect={onSelect} />,
    );

    const flowEl = document.querySelector(".react-flow");
    expect(flowEl).toBeInTheDocument();
    expect(screen.getByTestId("team-graph-legend")).toBeVisible();
    expect(screen.getByTestId("team-graph-fit")).toBeVisible();
    expect(document.querySelector(".react-flow__minimap")).toBeInTheDocument();
    expect(document.querySelector(".react-flow__controls")).toBeInTheDocument();

    expect(screen.getByTestId("team-node-worker")).toHaveAttribute("data-state", "working");
    expect(screen.getByTestId("team-node-snoozer")).toHaveAttribute("data-state", "paused");
    expect(screen.getByTestId("team-node-lead")).toHaveAttribute("data-state", "idle");

    rerender(<TeamGraph team={team} selectedId="worker" workforcePaused={true} onSelect={onSelect} />);
    expect(document.querySelector(".react-flow")).toBe(flowEl);
    expect(screen.getByTestId("team-graph-paused-badge")).toBeVisible();
  });
});

describe("HypothesisTree", () => {
  it("opens the pinned observation and shows the original evidence it superseded", async () => {
    const pointer = { kind: "kb-page" as const, taskId: "t", callId: "call", ref: "S1", digest: "abc", revision: 3 };
    const read = vi.fn().mockResolvedValue({ reply: { evidenceSource: {
      callId: "call", source: { ...pointer, id: "kb-1", label: "Storage runbook" },
    } } });
    vi.stubGlobal("multissh", { aiHubRequest: read });
    render(<HypothesisTree hypotheses={[{
      id: "h", text: "Storage issue", status: "open",
      evidence: [{ id: "a", originTaskId: "t", at: 1, supports: true, text: "Initial sample" },
        { id: "b", originTaskId: "t", at: 2, supports: false, text: "Follow-up sample", supersedes: "a", source: pointer }],
    }]} />);
    expect(read).not.toHaveBeenCalled();
    expect(screen.getByText(/Superseded/)).toBeVisible();
    expect(screen.getByText(/Revises.*Initial sample/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "KB page v3 · S1" }));
    expect(await screen.findByText("Storage runbook")).toBeVisible();
    expect(read).toHaveBeenCalledWith({ action: "task-read", taskId: "t", detail: "evidence-source", callId: "call", ref: "S1", digest: "abc" });
  });

  it("renders cycles safely, includes .ai-hyp-against, confidence badges, and clickable report refs", () => {
    const onOpenRef = vi.fn();
    const onOpenFileRef = vi.fn();
    const hypotheses: AgentHypothesis[] = [
      {
        id: "root",
        text: "Root cause in storage",
        status: "open",
        evidence: [
          { supports: true, text: "Checked [c1] and prod-01:/etc/multipath.conf:42" },
          { supports: false, text: "Network MTU fine on /var/log/syslog:10" },
        ],
      },
      {
        id: "child-a",
        text: "LUN queue full",
        status: "confirmed",
        parentId: "root",
        evidence: [{ supports: true, text: "Queue depth saturated" }],
      },
      {
        id: "cyc-1",
        text: "Detached cycle X",
        status: "ruled-out",
        parentId: "cyc-2",
        evidence: [{ supports: false, text: "Ruled out by telemetry" }],
      },
      {
        id: "cyc-2",
        text: "Detached cycle Y",
        status: "open",
        parentId: "cyc-1",
        evidence: [],
      },
    ];

    render(
      <HypothesisTree
        hypotheses={hypotheses}
        refs={new Set(["c1"])}
        onOpenRef={onOpenRef}
        onOpenFileRef={onOpenFileRef}
      />,
    );

    expect(screen.getByTestId("hypothesis-tree")).toBeVisible();
    expect(screen.getByTestId("hyp-node-cyc-1")).toBeVisible();
    expect(screen.getByTestId("hyp-node-cyc-2")).toBeVisible();
    expect(screen.getByTestId("hypothesis-cycle")).toHaveTextContent(/Cycle detected/i);
    expect(document.querySelector(".ai-hyp-against")).toBeInTheDocument();
    expect(document.querySelector(".ai-hyp-for")).toBeInTheDocument();
    expect(document.querySelector(".ai-hyp-branch")).toBeInTheDocument();
    expect(screen.getByTestId("hyp-node-child-a")).toHaveTextContent("confirmed");

    fireEvent.click(screen.getByRole("button", { name: "[c1]" }));
    expect(onOpenRef).toHaveBeenCalledWith("c1");

    fireEvent.click(screen.getByRole("link", { name: "prod-01:/etc/multipath.conf:42" }));
    expect(onOpenFileRef).toHaveBeenCalledWith(
      expect.objectContaining({ host: "prod-01", path: "/etc/multipath.conf", line: 42 }),
    );
  });
});

describe("DependencyLinks", () => {
  it("renders visual topology with blast-radius counts, click-to-filter, and open host", () => {
    const act = vi.fn(async () => undefined);
    const onOpenHost = vi.fn();
    const hub = makeHub({
      infraEdges: [
        { id: "e1", from: "web-01", to: "api-01", relation: "depends_on", updatedAt: 1 },
        { id: "e2", from: "api-01", to: "pg-primary", relation: "depends_on", updatedAt: 1 },
      ],
      inventory: [
        { id: "i1", label: "pg-primary", kind: "ssh", address: "10.0.0.5", status: "reachable", detail: "ok", observedAt: 1 },
      ],
    });

    render(<DependencyLinks hub={hub} act={act} onOpenHost={onOpenHost} />);

    expect(screen.getByTestId("dependency-topology")).toBeVisible();
    expect(screen.getByTestId("blast-radius-pg-primary")).toHaveTextContent("2 depend on it");
    expect(screen.getByTestId("blast-radius-api-01")).toHaveTextContent("1 depends on it");
    expect(screen.getByTestId("blast-radius-web-01")).toHaveTextContent("0 depend on it");

    fireEvent.click(screen.getByTestId("topo-node-web-01"));
    expect(screen.getByTestId("dependency-filter-bar")).toBeVisible();
    expect(within(screen.getByTestId("confirmed-links")).getByTestId("dep-edge-e1")).toBeInTheDocument();
    expect(within(screen.getByTestId("confirmed-links")).queryByTestId("dep-edge-e2")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("open-host-web-01"));
    expect(onOpenHost).toHaveBeenCalledWith("web-01");

    fireEvent.click(screen.getByTestId("dependency-clear-filter"));
    expect(within(screen.getByTestId("confirmed-links")).getByTestId("dep-edge-e2")).toBeInTheDocument();
  });
});

describe("WorkforceView overhaul", () => {
  it("supports Pause All / Resume Workforce, ticket search, embedded HypothesisTree, correlated alerts, and Run Inspection Drawer", async () => {
    const act = vi.fn(async () => undefined);
    const onOpenTask = vi.fn();

    const parentTask: AgentTask = {
      id: "task-main",
      title: "Investigate DB latency",
      agentId: "lead",
      agentName: "Lead SRE",
      target: { sessionId: "s1", generation: "1", label: "prod-db-01" },
      mode: "assisted",
      status: "running",
      messages: [{ id: "m1", role: "assistant", text: "Found lock contention on orders table.", at: 100 }],
      changes: [],
      sources: [],
      toolLog: [
        { name: "sshs3_terminal_exec", input: "psql -c 'SELECT * FROM pg_stat_activity'", output: "3 waiting", at: 90, durationMs: 120, exitCode: 0, ok: true, target: "prod-db-01" },
      ],
      todos: [{ id: "td1", content: "Inspect pg_locks", status: "completed" }],
      hypotheses: [
        { id: "h1", text: "Unindexed vacuum lock", status: "confirmed", evidence: [{ supports: true, text: "Saw ShareUpdateExclusiveLock" }] },
      ],
      usage: { inputTokens: 1200, outputTokens: 300, costUsd: 0.012 },
      createdAt: 50,
      updatedAt: 100,
      maxCommands: 10,
      maxMinutes: 10,
      verification: "not-verified",
    };

    const childTask: AgentTask = {
      ...parentTask,
      id: "task-sub",
      title: "Check replica lag",
      parentTaskId: "task-main",
      investigator: true,
      toolLog: [{ name: "sshs3_terminal_exec", input: "pg_stat_replication", output: "lag 0s", at: 95, ok: true }],
      todos: [],
      hypotheses: [],
      messages: [{ id: "m2", role: "assistant", text: "Replica is healthy.", at: 96 }],
    };

    const ticket1 = makeTicket("inc-1", {
      title: "DB latency spike",
      status: "in_progress",
      target: "prod-db-01",
      taskId: "task-main",
      alert: {
        fingerprint: "fp-db",
        name: "PG Lock Wait",
        source: "prometheus",
        severity: "critical",
        firstAt: Date.now() - 30 * 60_000,
        lastAt: Date.now() - 60_000,
        count: 2,
      },
      correlatedAlerts: [
        { fingerprint: "fp-api", summary: "API timeout on /orders", severity: "warning", at: Date.now() - 120_000 },
      ],
      hypotheses: parentTask.hypotheses,
    });
    const ticket2 = makeTicket("inc-2", {
      title: "Rotate staging cert",
      status: "todo",
      target: "staging-web",
    });

    const baseHub = makeHub({
      agents: [makeAgent("lead")],
      workTickets: [ticket1, ticket2],
      tasks: [parentTask, childTask].map(taskForSnapshot),
      workforcePaused: false,
    });

    const readDetails = vi.fn(async (request: { taskId: string; detail?: string }) => {
      const stored = [parentTask, childTask].find(task => task.id === request.taskId)!;
      return { reply: { taskTools: { id: stored.id, count: stored.toolLog!.length, entries: stored.toolLog } } };
    });
    vi.stubGlobal("multissh", { aiHubRequest: readDetails });
    const { rerender } = render(<WorkforceView hub={baseHub} act={act} onOpenTask={onOpenTask} />);

    // Pause All
    fireEvent.click(screen.getByTestId("workforce-pause-all"));
    await waitFor(() => expect(act).toHaveBeenCalledWith({ action: "workforce-pause", paused: true }));

    // Resume Workforce state
    rerender(<WorkforceView hub={{ ...baseHub, workforcePaused: true }} act={act} onOpenTask={onOpenTask} />);
    expect(screen.getByTestId("workforce-paused-banner")).toBeVisible();
    await waitFor(() =>
      expect(within(screen.getByTestId("workforce-paused-banner")).getByRole("button", { name: "Resume Workforce" })).toBeEnabled(),
    );
    fireEvent.click(within(screen.getByTestId("workforce-paused-banner")).getByRole("button", { name: "Resume Workforce" }));
    await waitFor(() => expect(act).toHaveBeenCalledWith({ action: "workforce-pause", paused: false }));

    // Search filter
    fireEvent.change(screen.getByLabelText("Search tickets"), { target: { value: "latency" } });
    expect(screen.getByTestId("ticket-inc-1")).toBeInTheDocument();
    expect(screen.queryByTestId("ticket-inc-2")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search tickets"), { target: { value: "" } });

    // Ticket detail embeds HypothesisTree + correlated alerts pills
    fireEvent.click(screen.getByTestId("ticket-inc-1"));
    const detail = screen.getByTestId("ticket-detail");
    expect(within(detail).getByTestId("hypothesis-tree")).toBeVisible();
    expect(within(detail).getByTestId("ticket-correlated-alerts")).toHaveTextContent("API timeout on /orders");
    expect(within(detail).getByTestId("ticket-correlated-alerts")).toHaveTextContent("PG Lock Wait");

    // Open Run Inspection Drawer from ticket detail
    fireEvent.click(within(detail).getByTestId("inspect-ticket-run"));
    const drawer = screen.getByTestId("run-inspection-drawer");
    expect(drawer).toBeVisible();
    expect(readDetails).toHaveBeenCalledWith({ action: "task-read", taskId: parentTask.id, detail: "tools" });
    expect(readDetails).not.toHaveBeenCalledWith(expect.objectContaining({ taskId: childTask.id }));
    await waitFor(() => expect(within(drawer).getByTestId("run-drawer-tool-steps")).toHaveTextContent("sshs3_terminal_exec"));
    expect(within(drawer).getByTestId("run-drawer-tool-steps")).toHaveTextContent("Tool steps (1)");
    expect(within(drawer).getByTestId("run-drawer-scratchpad")).toHaveTextContent("Inspect pg_locks");
    expect(within(drawer).getByTestId("run-drawer-live-output")).toHaveTextContent("Found lock contention on orders table.");
    expect(within(drawer).getByTestId("run-drawer-subagents")).toHaveTextContent("Lead SRE");

    // Switch to child subagent inside drawer
    fireEvent.click(within(drawer).getByTestId("run-drawer-task-task-sub"));
    expect(within(drawer).getByTestId("run-drawer-live-output")).toHaveTextContent("Replica is healthy.");
    await waitFor(() => expect(within(drawer).getByTestId("run-drawer-tool-steps")).toHaveTextContent("lag 0s"));
  });
});
