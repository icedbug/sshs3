import { boardSharedWith } from "@shared/sharingText";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentTask,
  HubRequest,
  HubSnapshot,
  MissionAgent,
  WorkGoal,
  WorkTicket,
  WorkTicketStatus,
  WorkforceRun,
} from "@shared/types/aiHub";
import { ConfirmButton } from "./ConfirmButton";
import { AtlassianCard } from "./AtlassianCard";
import { ChatThread } from "./TeamChatCard";
import { ScenariosCard } from "./ScenariosCard";
import { HypothesisTree } from "./HypothesisTree";
import { type Act, formatTokenUsage, modes, TABULAR_NUMS_STYLE } from "./panelShared";
import { RichMarkdownContent } from "./RichMarkdownContent";
import { useFullTask } from "../../lib/aiHubTasks";
import { isWebBrowserMode } from "../../lib/webClientBridge";
import {
  COLUMNS,
  agentsLive,
  compareTicketsByPriority,
  goalProgress,
  groupCorrelatedAlerts,
  ticketPriorityLevel,
  ticketSlaInfo,
  tokens,
  type AgentLive,
} from "./workforceModel";

// The graph library is only loaded when the team tab is opened.
const TeamGraph = lazy(() => import("./TeamGraph").then((m) => ({ default: m.TeamGraph })));

interface TicketDraft {
  id?: string;
  title: string;
  description: string;
  goalId: string;
  assigneeAgentId: string;
  target: string;
}

const ago = (at: number): string => {
  const mins = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} d ago`;
};

const SEVERITY_BADGE: Record<"critical" | "warning" | "info", string> = {
  critical: "ai-badge ai-badge-danger",
  warning: "ai-badge ai-badge-mode",
  info: "ai-badge ai-badge-cluster",
};

const SLA_STYLE: Record<"normal" | "warn" | "breach", React.CSSProperties> = {
  normal: TABULAR_NUMS_STYLE,
  warn: { ...TABULAR_NUMS_STYLE, color: "#fbbf24", borderColor: "rgba(251, 191, 36, 0.45)" },
  breach: { ...TABULAR_NUMS_STYLE, color: "#f87171", borderColor: "rgba(248, 113, 113, 0.55)" },
};

/** Opens the Agents & MCP view. The panel shows it even while it is hidden from the menu. */
const openAgentsView = (): void => {
  window.dispatchEvent(new CustomEvent("sshs3:ai-open", { detail: { view: "Agents & MCP", mode: "hub" } }));
};

const DEMO_RUN_LABEL = "Example from the demo data. Not the current state.";

/**
 * A run whose findings are scripted: the seeded example (its id starts with
 * "demo-") or a demo-mode run that called no model. It must not read as a
 * fresh look at the servers.
 */
const isDemoRun = (run: WorkforceRun): boolean => run.simulated === true || run.id.startsWith("demo-");

function matchesTicketFilter(
  ticket: WorkTicket,
  query: string,
  severityFilter: "all" | "alerts" | "critical",
  assigneeFilter: string,
): boolean {
  if (assigneeFilter && ticket.assigneeAgentId !== assigneeFilter) return false;
  const prio = ticketPriorityLevel(ticket);
  const hasAlerts = Boolean(ticket.alert || (ticket.correlatedAlerts && ticket.correlatedAlerts.length > 0));
  if (severityFilter === "alerts" && !hasAlerts) return false;
  if (severityFilter === "critical" && prio !== "critical") return false;
  if (!query) return true;
  const q = query.toLowerCase();
  const fields = [
    ticket.id,
    ticket.title,
    ticket.description,
    ticket.target,
    ticket.assigneeName,
    ticket.alert?.name,
    ticket.alert?.source,
    ticket.alert?.fingerprint,
    ticket.external?.key,
    ...(ticket.correlatedAlerts ?? []).map((c) => c.summary),
  ];
  return fields.some((f) => Boolean(f && f.toLowerCase().includes(q)));
}

export function WorkforceView({
  hub,
  act,
  onOpenTask,
  openTicketId: askedTicketId,
}: {
  hub: HubSnapshot;
  act: Act;
  onOpenTask: (taskId: string) => void;
  /** A ticket to open, asked for from another view. */
  openTicketId?: string;
}): JSX.Element {
  const [tab, setTab] = useState<"board" | "team">("board");
  const [goalFilter, setGoalFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [severityFilter, setSeverityFilter] = useState<"all" | "alerts" | "critical">("all");
  const [assigneeFilter, setAssigneeFilter] = useState("");
  const [draft, setDraft] = useState<TicketDraft | undefined>();
  const [goalDraft, setGoalDraft] = useState<{ id?: string; title: string; description: string } | undefined>();
  const [openTicketId, setOpenTicketId] = useState(askedTicketId ?? "");
  const [report, setReport] = useState("");
  // What was just done to a ticket, and the request that takes it back.
  const [notice, setNotice] = useState<{ text: string; undo: HubRequest } | undefined>();
  // The status picked in the detail. It is applied with the Move button, not on change.
  const [moveTo, setMoveTo] = useState<{ id: string; status: WorkTicketStatus } | undefined>();
  const [showAll, setShowAll] = useState<Partial<Record<WorkTicketStatus, boolean>>>({});
  const detailRef = useRef<HTMLElement | null>(null);
  const [agentId, setAgentId] = useState<string | undefined>();
  const [note, setNote] = useState("");
  const [comment, setComment] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [dragId, setDragId] = useState("");
  const [busy, setBusy] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [inspectedTaskId, setInspectedTaskId] = useState<string | undefined>();
  const [inspectedRunId, setInspectedRunId] = useState<string | undefined>();

  const goals = hub.workGoals ?? [];
  const tickets = useMemo(() => hub.workTickets ?? [], [hub.workTickets]);
  const agents = hub.agents ?? [];
  const team = agentsLive(hub);
  const sessions = hub.sessions.filter((s) => s.state !== "disconnected");
  const workforcePaused = hub.workforcePaused === true;
  const heartbeat = hub.preferences.workforceAutopilot === true;
  const sync = hub.workBoardSync;

  const trimmedQuery = searchQuery.trim();
  const hasBoardFilter = Boolean(trimmedQuery || severityFilter !== "all" || assigneeFilter || goalFilter);

  const shown = useMemo(
    () =>
      tickets.filter(
        (t) =>
          (!goalFilter || t.goalId === goalFilter) &&
          matchesTicketFilter(t, trimmedQuery, severityFilter, assigneeFilter),
      ),
    [tickets, goalFilter, trimmedQuery, severityFilter, assigneeFilter],
  );

  const openTicket = tickets.find((t) => t.id === openTicketId);

  useEffect(() => {
    if (!askedTicketId) return;
    setTab("board");
    setOpenTicketId(askedTicketId);
  }, [askedTicketId]);

  // The detail is below the board: bring it into view when a ticket is opened.
  const detailShown = Boolean(openTicket) && tab === "board";
  useEffect(() => {
    if (!detailShown) return;
    detailRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [detailShown, openTicketId]);
  // The banner is at the top: bring it into view when the workforce becomes paused, not on every render.
  const pausedRef = useRef<HTMLDivElement | null>(null);
  const wasPaused = useRef(workforcePaused);
  useEffect(() => {
    if (workforcePaused && !wasPaused.current) pausedRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    wasPaused.current = workforcePaused;
  }, [workforcePaused]);
  const openTicketTask = openTicket?.taskId ? hub.tasks.find((t) => t.id === openTicket.taskId) : undefined;
  const openTicketHypotheses = openTicket
    ? openTicket.hypotheses?.length
      ? openTicket.hypotheses
      : openTicketTask?.hypotheses
    : undefined;
  const openTicketAlertGroup = useMemo(
    () => (openTicket ? groupCorrelatedAlerts(openTicket) : undefined),
    [openTicket],
  );
  const openTicketCmdRefs = useMemo(() => {
    const refs = new Set<string>();
    for (const c of openTicketTask?.changes ?? []) {
      if (c.ref) refs.add(c.ref);
    }
    return refs.size > 0 ? refs : undefined;
  }, [openTicketTask]);

  const selectedAgent = team.find((t) => t.agent.id === agentId);
  const empty = goals.length === 0 && tickets.length === 0;

  const activeTasks = useMemo(
    () => hub.tasks.filter((t) => t.status === "running" || t.status === "waiting"),
    [hub.tasks],
  );
  const activeRuns = useMemo(
    () => (hub.workforceRuns ?? []).filter((r) => r.status === "running"),
    [hub.workforceRuns],
  );
  const liveRunCount = activeTasks.length + activeRuns.length;

  const openRunDrawerForTask = (taskId?: string): void => {
    setInspectedRunId(undefined);
    setInspectedTaskId(taskId);
    setDrawerOpen(true);
  };

  const run = (key: string, request: Parameters<Act>[0]): Promise<HubSnapshot | undefined> => {
    setBusy(key);
    return act(request).finally(() => setBusy(""));
  };
  const columnTitle = (status: WorkTicketStatus): string => COLUMNS.find((c) => c.status === status)?.title ?? status;
  /** Changes a ticket's status and offers to take it back. */
  const changeStatus = (t: WorkTicket, request: HubRequest): void => {
    const before = t.status;
    void act(request).then((next) => {
      const after = next?.workTickets?.find((x) => x.id === t.id)?.status;
      // in_progress cannot be moved back to: nothing to undo there.
      if (!after || after === before || before === "in_progress") return;
      setNotice({
        text: `Moved "${t.title}" to ${columnTitle(after)}.`,
        undo: { action: "ticket-move", id: t.id, status: before },
      });
    });
  };
  const removeTicket = (t: WorkTicket): void => {
    setOpenTicketId("");
    void act({ action: "ticket-delete", id: t.id }).then((next) => {
      if (!next || (next.workTickets ?? []).some((x) => x.id === t.id && !x.deleted)) return;
      setNotice({ text: `Removed "${t.title}".`, undo: { action: "ticket-restore", id: t.id } });
    });
  };
  const moveChoice = openTicket && moveTo?.id === openTicket.id ? moveTo.status : openTicket?.status;
  const editingOpen = Boolean(draft?.id && draft.id === openTicket?.id);
  const canStart = (t: WorkTicket): boolean =>
    Boolean(t.assigneeAgentId) && ["backlog", "todo", "blocked"].includes(t.status);

  const ticketForm = draft && (
    <form
      className="ai-form ai-card"
      data-testid="ticket-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!draft.title.trim()) return;
        void act({
          action: "ticket-save",
          ticket: {
            id: draft.id,
            title: draft.title.trim(),
            description: draft.description,
            goalId: draft.goalId || undefined,
            assigneeAgentId: draft.assigneeAgentId || undefined,
            target: draft.target || undefined,
          },
        }).then((next) => {
          if (next) setDraft(undefined);
        });
      }}
    >
      <strong>{draft.id ? "Edit ticket" : "New ticket"}</strong>
      <label>
        Title: the result you want
        <input
          required
          autoFocus
          placeholder="The backup job finishes within the night window"
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
        />
      </label>
      <label>
        What to do, and what done looks like
        <textarea
          rows={4}
          placeholder="Find out why it runs long, propose the change, and show the timing after it."
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        />
      </label>
      <div className="ai-form-row ai-form-row-3up">
        <label>
          Agent
          <select
            value={draft.assigneeAgentId}
            onChange={(e) => setDraft({ ...draft, assigneeAgentId: e.target.value })}
          >
            <option value="">Nobody yet (backlog)</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Goal
          <select value={draft.goalId} onChange={(e) => setDraft({ ...draft, goalId: e.target.value })}>
            <option value="">No goal</option>
            {goals.map((g) => (
              <option key={g.id} value={g.id}>
                {g.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          About (optional)
          <input
            placeholder="A cluster or server"
            value={draft.target}
            onChange={(e) => setDraft({ ...draft, target: e.target.value })}
          />
        </label>
      </div>
      <div className="ai-card-actions">
        <button type="submit" className="ai-btn-emerald">
          {draft.id ? "Save changes" : "Add ticket"}
        </button>
        <button type="button" onClick={() => setDraft(undefined)}>
          Cancel
        </button>
      </div>
    </form>
  );

  return (
    <div className="ai-scroll ai-workforce">
      {/* First in the view: an emergency stop must show that it took, wherever the page was scrolled to. */}
      {workforcePaused && (
        <div
          ref={pausedRef}
          className="ai-card"
          data-testid="workforce-paused-banner"
          role="status"
          style={{
            marginBottom: 8,
            borderColor: "rgba(248, 113, 113, 0.55)",
            background: "rgba(248, 113, 113, 0.08)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            padding: "8px 12px",
          }}
        >
          <span>
            <strong>Workforce paused:</strong> autonomous heartbeat and queued ticket dispatch are halted.
          </span>
          <button
            type="button"
            className="ai-btn-emerald"
            disabled={busy === "workforce-pause"}
            onClick={() => void run("workforce-pause", { action: "workforce-pause", paused: false })}
          >
            Resume Workforce
          </button>
        </div>
      )}

      <header className="ai-view-head">
        <h2>Workforce</h2>
        <p className="ai-hint">
          A team of agents working towards goals. Work is a ticket; an agent is woken for a ticket, does it, and
          reports. You decide what is done.
        </p>
      </header>

      {empty && (
        <>
          <h3 className="ai-subhead">Start with a team</h3>
          <div className="ai-preset-grid" data-testid="workforce-templates">
            {(hub.workforceTemplates ?? []).map((t) => (
              <article key={t.id} className="ai-card">
                <div>
                  <strong>{t.title}</strong>
                  <p>{t.description}</p>
                  <small>{t.roles.join(" · ")}</small>
                </div>
                <button
                  type="button"
                  className="ai-btn-emerald"
                  disabled={busy === t.id}
                  data-testid={`workforce-template-${t.id}`}
                  onClick={() => void run(t.id, { action: "workforce-template-apply", templateId: t.id })}
                >
                  {busy === t.id ? "Setting up…" : "Set up this team"}
                </button>
              </article>
            ))}
          </div>
          <p className="ai-hint ai-footnote">
            A template adds its agents, one goal and the first tickets. Nothing runs until you start a ticket. You can
            also build your own: add a goal and tickets here, and agents under{" "}
            <button type="button" className="ai-chip" data-testid="open-agents-view" onClick={openAgentsView}>
              Agents &amp; MCP
            </button>
          </p>
        </>
      )}

      <div className="ai-section-head">
        <div className="ai-tabs" role="tablist">
          {(["board", "team"] as const).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className={tab === key ? "ai-tab-on" : ""}
              onClick={() => setTab(key)}
            >
              {key === "board" ? "Board" : "Team, live"}
            </button>
          ))}
        </div>
        <div className="ai-tags">
          <label
            className="ai-heartbeat"
            title="When on, this app takes the next ticket in To do that has an agent and runs it, one at a time. It only runs while sshS3 is running."
          >
            <input
              type="checkbox"
              checked={heartbeat}
              onChange={(e) =>
                void act({
                  action: "configure",
                  config: {},
                  preferences: { workforceAutopilot: e.target.checked },
                })
              }
            />
            <span className={heartbeat ? "ai-heartbeat-on" : ""}>Start tickets by itself</span>
          </label>
          <button
            type="button"
            className={workforcePaused ? "ai-btn-emerald" : "ai-btn-danger"}
            data-testid="workforce-pause-all"
            disabled={busy === "workforce-pause"}
            onClick={() => void run("workforce-pause", { action: "workforce-pause", paused: !workforcePaused })}
          >
            {workforcePaused ? "Resume Workforce" : "Pause All"}
          </button>
          <button
            type="button"
            className={drawerOpen ? "ai-btn-accent" : ""}
            data-testid="run-drawer-toggle"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen((v) => !v)}
          >
            What is running{liveRunCount > 0 ? ` (${liveRunCount})` : ""}
          </button>
          <button type="button" onClick={() => setGoalDraft(goalDraft ? undefined : { title: "", description: "" })}>
            New goal
          </button>
          <button
            type="button"
            className="ai-btn-accent"
            onClick={() =>
              setDraft(
                draft && !draft.id
                  ? undefined
                  : { title: "", description: "", goalId: goalFilter || goals[0]?.id || "", assigneeAgentId: "", target: "" },
              )
            }
          >
            New ticket
          </button>
        </div>
      </div>

      <small className="ai-sync-note" data-testid="board-shared-with">
        {sync?.shared
          ? `${boardSharedWith({ server: sync.via === "server", bucket: sync.via === "bucket" })}${sync.lastSyncAt ? ` · read ${ago(sync.lastSyncAt)}` : ""}${sync.error ? ` · last sync failed: ${sync.error}` : ""}`
          : hub.demoMode
            ? `${boardSharedWith({ server: false, bucket: false, demo: true })}.`
            : isWebBrowserMode()
              ? "The board is not shared: it is kept for your account only."
              : `${boardSharedWith({ server: false, bucket: false })}.`}
        {heartbeat ? " · On: this app starts tickets by itself, one at a time." : ""}
      </small>

      <ScenariosCard
        hub={hub}
        act={act}
        onOpenTicket={(id) => {
          // The detail is only on the board.
          setTab("board");
          setOpenTicketId(id);
        }}
      />
      <AtlassianCard product="jira" hub={hub} act={act} />

      {drawerOpen && (
        <RunInspectionDrawer
          hub={hub}
          act={act}
          selectedTaskId={inspectedTaskId}
          defaultTaskId={openTicket?.taskId}
          selectedRunId={inspectedRunId}
          onSelectTask={(id) => {
            setInspectedRunId(undefined);
            setInspectedTaskId(id);
          }}
          onSelectRun={(id) => {
            setInspectedRunId(id);
            setInspectedTaskId(undefined);
          }}
          onOpenTask={onOpenTask}
          onClose={() => setDrawerOpen(false)}
        />
      )}

      {goalDraft && (
        <form
          className="ai-form ai-card"
          data-testid="goal-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!goalDraft.title.trim()) return;
            void act({ action: "goal-save", goal: goalDraft }).then((next) => {
              if (next) setGoalDraft(undefined);
            });
          }}
        >
          <strong>{goalDraft.id ? "Edit goal" : "New goal"}</strong>
          <label>
            Goal
            <input
              required
              autoFocus
              placeholder="Storage alerts are handled within the hour"
              value={goalDraft.title}
              onChange={(e) => setGoalDraft({ ...goalDraft, title: e.target.value })}
            />
          </label>
          <label>
            Why, and what reaching it looks like
            <textarea
              rows={3}
              value={goalDraft.description}
              onChange={(e) => setGoalDraft({ ...goalDraft, description: e.target.value })}
            />
          </label>
          <p className="ai-hint">Every agent working a ticket under this goal is given this text.</p>
          <div className="ai-card-actions">
            <button type="submit" className="ai-btn-emerald">
              Save goal
            </button>
            <button type="button" onClick={() => setGoalDraft(undefined)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {draft && !draft.id && ticketForm}

      {goals.length > 0 && (
        <div className="ai-goals">
          <button
            type="button"
            className={`ai-chip ${goalFilter === "" ? "ai-chip-on" : ""}`}
            aria-pressed={goalFilter === ""}
            onClick={() => setGoalFilter("")}
          >
            All goals
          </button>
          {goals.map((g: WorkGoal) => {
            const p = goalProgress(g, tickets);
            return (
              <span key={g.id} className="ai-goal">
                <button
                  type="button"
                  className={`ai-chip ${goalFilter === g.id ? "ai-chip-on" : ""}`}
                  aria-pressed={goalFilter === g.id}
                  title={g.description}
                  onClick={() => setGoalFilter(goalFilter === g.id ? "" : g.id)}
                >
                  {g.title} · {p.done} of {p.total} tickets done
                </button>
                {goalFilter === g.id && (
                  <>
                    <button
                      type="button"
                      className="ai-chip"
                      onClick={() => setGoalDraft({ id: g.id, title: g.title, description: g.description ?? "" })}
                    >
                      Edit
                    </button>
                    <ConfirmButton
                      label="Remove"
                      confirmLabel="Remove goal?"
                      className="ai-chip"
                      onConfirm={() => {
                        setGoalFilter("");
                        void act({ action: "goal-delete", id: g.id });
                      }}
                    />
                  </>
                )}
              </span>
            );
          })}
        </div>
      )}

      {tab === "board" && tickets.length > 0 && (
        <div
          className="ai-filter-bar"
          data-testid="workforce-filter"
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 8,
            margin: "8px 0 10px",
          }}
        >
          <input
            type="search"
            aria-label="Search tickets"
            placeholder="Filter tickets by title, target, agent, or alert…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{ flex: "1 1 220px", minWidth: 180 }}
          />
          <div style={{ display: "inline-flex", gap: 4 }}>
            {(
              [
                { id: "all", label: "All" },
                { id: "alerts", label: "Alerts" },
                { id: "critical", label: "Critical" },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={`ai-chip ${severityFilter === opt.id ? "ai-chip-on" : ""}`}
                aria-pressed={severityFilter === opt.id}
                onClick={() => setSeverityFilter(opt.id)}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {agents.length > 0 && (
            <select
              aria-label="Filter by agent"
              value={assigneeFilter}
              onChange={(e) => setAssigneeFilter(e.target.value)}
            >
              <option value="">All agents</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
          {hasBoardFilter && (
            <button
              type="button"
              className="ai-chip"
              onClick={() => {
                setGoalFilter("");
                setSearchQuery("");
                setSeverityFilter("all");
                setAssigneeFilter("");
              }}
            >
              Clear filters ({shown.length} of {tickets.length} shown)
            </button>
          )}
        </div>
      )}

      {tab === "board" && (
        <div className="ai-board" data-testid="workforce-board">
          {COLUMNS.map((col) => {
            const cards = shown
              .filter((t) => t.status === col.status)
              .sort((a, b) =>
                col.status === "done" ? b.updatedAt - a.updatedAt : compareTicketsByPriority(a, b),
              );
            const droppable = col.status !== "in_progress";
            const cardLimit = col.status === "done" ? 12 : 60;
            return (
              <section
                key={col.status}
                className={`ai-column ai-column-${col.status}`}
                data-testid={`column-${col.status}`}
                onDragOver={(e) => {
                  if (droppable && dragId) e.preventDefault();
                }}
                onDrop={() => {
                  if (!droppable || !dragId) return;
                  const moved = tickets.find((t) => t.id === dragId);
                  setDragId("");
                  if (moved && moved.status !== col.status)
                    changeStatus(moved, { action: "ticket-move", id: moved.id, status: col.status });
                }}
              >
                <header title={col.hint}>
                  <span>{col.title}</span>
                  <span className="ai-count">{cards.length}</span>
                </header>
                {(showAll[col.status] ? cards : cards.slice(0, cardLimit)).map((t) => {
                  const prio = ticketPriorityLevel(t);
                  const sla = ticketSlaInfo(t);
                  const corr = groupCorrelatedAlerts(t);
                  return (
                    <article
                      key={t.id}
                      className={`ai-ticket ${t.status === "in_progress" ? "ai-ticket-live" : ""} ${openTicketId === t.id ? "ai-ticket-open" : ""}`}
                      data-testid={`ticket-${t.id}`}
                      data-priority={prio}
                      draggable={t.status !== "in_progress"}
                      onDragStart={() => setDragId(t.id)}
                      onDragEnd={() => setDragId("")}
                      onClick={() => {
                        setOpenTicketId(openTicketId === t.id ? "" : t.id);
                        setNote("");
                        setComment("");
                        setReport("");
                        // An edit belongs to the ticket that was open.
                        if (draft?.id) setDraft(undefined);
                      }}
                    >
                      {/* The click is the card's: the button says it opens and closes, and takes the keyboard. */}
                      <button
                        type="button"
                        className="ai-ticket-title"
                        aria-expanded={openTicketId === t.id}
                        title={openTicketId === t.id ? "Close this ticket" : "Open this ticket"}
                      >
                        <strong>{t.title}</strong>
                      </button>
                      <div className="ai-ticket-meta">
                        <span>{t.assigneeName ?? "Unassigned"}</span>
                        {t.target && <span>{t.target}</span>}
                        {prio !== "normal" && (
                          <span className={SEVERITY_BADGE[prio]} data-testid={`ticket-priority-${t.id}`}>
                            {prio}
                          </span>
                        )}
                        {corr.items.length > 1 && (
                          <span className="ai-badge" title={`${corr.total} alerts about the same thing`}>
                            {corr.items.length} alerts
                          </span>
                        )}
                        {t.external && (
                          <span
                            className="ai-badge"
                            data-testid={`ticket-jira-${t.id}`}
                            title={`${t.external.key} in Jira: ${t.external.status}${t.external.error ? ` · ${t.external.error}` : ""}`}
                            style={t.external.error ? { borderColor: "rgba(248, 113, 113, 0.6)" } : undefined}
                          >
                            {t.external.key} · {t.external.status}
                          </span>
                        )}
                        {t.status !== "done" && (
                          <span
                            className="ai-badge"
                            data-testid={`ticket-sla-${t.id}`}
                            data-sla-level={sla.level}
                            style={SLA_STYLE[sla.level]}
                            title={`Open for ${sla.label}. It changes colour the longer it waits, sooner for a critical alert.`}
                          >
                            {sla.label}
                          </span>
                        )}
                        {(t.blockedBy ?? []).some((b) => tickets.some((x) => x.id === b && x.status !== "done")) && (
                          <span className="ai-ticket-waits">waits</span>
                        )}
                      </div>
                      {t.status === "in_progress" && (
                        <small>
                          <span className="ai-org-dot" /> {t.claim?.by ?? "somebody"} · started {ago(t.claim?.at ?? t.updatedAt)}
                        </small>
                      )}
                      {canStart(t) && (
                        <button
                          type="button"
                          className="ai-btn-emerald"
                          disabled={busy === t.id}
                          data-testid={`ticket-start-${t.id}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            void run(t.id, { action: "ticket-start", id: t.id });
                          }}
                        >
                          {busy === t.id ? "Starting…" : t.status === "blocked" ? "Try again" : "Start"}
                        </button>
                      )}
                    </article>
                  );
                })}
                {cards.length > cardLimit && !showAll[col.status] && (
                  <button
                    type="button"
                    data-testid={`column-show-all-${col.status}`}
                    onClick={() => setShowAll({ ...showAll, [col.status]: true })}
                  >
                    Show all ({cards.length})
                  </button>
                )}
                {cards.length === 0 && <p className="ai-column-empty">{col.hint || "Nothing yet"}</p>}
              </section>
            );
          })}
        </div>
      )}

      {tab === "team" && (
        <div className={`ai-team ${selectedAgent ? "ai-team-split" : ""}`}>
          {agents.length === 0 ? (
            <p className="ai-empty">
              No agents yet. Set up a team above, or add agents under{" "}
              <button type="button" className="ai-chip" data-testid="open-agents-view" onClick={openAgentsView}>
                Agents &amp; MCP
              </button>
            </p>
          ) : (
            <Suspense fallback={<p className="ai-empty">Loading the team…</p>}>
              <TeamGraph
                team={team}
                selectedId={agentId}
                workforcePaused={workforcePaused}
                onSelect={setAgentId}
              />
            </Suspense>
          )}
          {selectedAgent && (
            <AgentPanel
              live={selectedAgent}
              agents={agents}
              tickets={tickets.filter((t) => t.assigneeAgentId === selectedAgent.agent.id)}
              act={act}
              onOpenTask={onOpenTask}
              onInspectRun={openRunDrawerForTask}
              onOpenTicket={(id) => {
                setTab("board");
                setOpenTicketId(id);
              }}
            />
          )}
        </div>
      )}

      {openTicket && tab === "board" && (
        <article ref={detailRef} className="ai-card ai-ticket-detail" data-testid="ticket-detail">
          <div className="ai-card-head">
            <div>
              <strong>{openTicket.title}</strong>
              <small>
                {openTicket.id} · {COLUMNS.find((c) => c.status === openTicket.status)?.title} ·{" "}
                {openTicket.assigneeName ?? "unassigned"}
                {goals.find((g) => g.id === openTicket.goalId) ? ` · ${goals.find((g) => g.id === openTicket.goalId)!.title}` : ""}
                {openTicket.tokens ? ` · ${tokens(openTicket.tokens)} tokens` : ""} · open for{" "}
                {ticketSlaInfo(openTicket).label} · by {openTicket.createdBy}
              </small>
            </div>
            <button type="button" aria-label="Close ticket" onClick={() => setOpenTicketId("")}>
              Close
            </button>
          </div>
          {openTicket.external && (
            <p className="ai-hint" data-testid="ticket-jira">
              Mirrors{" "}
              <a href={openTicket.external.url} target="_blank" rel="noreferrer noopener">
                {openTicket.external.key}
              </a>{" "}
              in Jira, where it is “{openTicket.external.status}”. Its text and comments follow the issue; your decision here
              is written there.
              {openTicket.external.error && (
                <span role="alert" className="ai-error">
                  {" "}
                  {openTicket.external.error}
                </span>
              )}
            </p>
          )}
          {openTicket.description && <p className="ai-memory-text">{openTicket.description}</p>}
          {(openTicket.kbPages ?? []).length > 0 && (
            <div className="ai-tags" data-testid="ticket-kb-pages" style={{ alignItems: "center" }}>
              <small className="ai-muted">Related knowledge base pages:</small>
              {openTicket.kbPages!.map((page) => {
                const inLocalKb = Boolean(page.known) || (hub.kbPages ?? []).some((p) => p.id === page.id);
                return inLocalKb ? (
                  <button
                    key={page.id}
                    type="button"
                    className="ai-chip"
                    data-testid={`ticket-kb-page-${page.id}`}
                    title={`Open "${page.title}" in Knowledge Base`}
                    onClick={() =>
                      window.dispatchEvent(
                        new CustomEvent("sshs3:ai-open", {
                          detail: { view: "Knowledge Base", mode: "hub", kbTab: "pages", pageId: page.id },
                        }),
                      )
                    }
                  >
                    {page.title}
                  </button>
                ) : (
                  <span
                    key={page.id}
                    className="ai-chip"
                    data-testid={`ticket-kb-page-${page.id}`}
                    title="Page is referenced by the alert but not in the local knowledge base"
                  >
                    {page.title} (not in local KB)
                  </span>
                );
              })}
            </div>
          )}
          {(openTicket.chatRefs ?? []).length > 0 && (
            <div data-testid="ticket-chat">
              <small>Said in chat (what people wrote about this lately; not checked)</small>
              {openTicket.chatRefs!.map((r) => (
                <ChatThread key={`${r.channelId}:${r.threadId}`} hit={{ ...r, lines: r.excerpt.split("\n") }} act={act} />
              ))}
            </div>
          )}

          {openTicketAlertGroup && openTicketAlertGroup.items.length > 0 && (
            <div
              className="ai-correlated-alerts"
              data-testid="ticket-correlated-alerts"
              style={{ display: "grid", gap: 6, margin: "8px 0" }}
            >
              <small className="ai-muted">
                Alerts on this ticket ({openTicketAlertGroup.total} in all, of {openTicketAlertGroup.items.length} kind
                {openTicketAlertGroup.items.length === 1 ? "" : "s"})
              </small>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {openTicketAlertGroup.items.map((item, idx) => (
                  <span
                    key={item.key}
                    className="ai-pill"
                    data-testid={`correlated-alert-${idx}`}
                    data-severity={item.severity}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "3px 8px",
                      borderRadius: 999,
                      border: "1px solid var(--ai-line-strong, rgba(148,163,184,0.3))",
                      fontSize: 11.5,
                    }}
                  >
                    <span className={SEVERITY_BADGE[item.severity]}>{item.severity}</span>
                    <span>{item.summary}</span>
                    {item.count > 1 && <strong style={TABULAR_NUMS_STYLE}>×{item.count}</strong>}
                    {item.source && <small style={{ opacity: 0.75 }}>{item.source}</small>}
                    <small style={{ opacity: 0.7 }}>{ago(item.at)}</small>
                  </span>
                ))}
              </div>
            </div>
          )}

          {openTicketHypotheses && openTicketHypotheses.length > 0 && (
            <HypothesisTree
              hypotheses={openTicketHypotheses}
              refs={openTicketCmdRefs}
              onOpenRef={() => {
                if (openTicketTask) openRunDrawerForTask(openTicketTask.id);
              }}
            />
          )}

          {openTicket.result && (
            <div className="ai-doc-body" data-testid="ticket-report">
              {/* The ticket does not say who wrote the report, so it is not called the agent's. */}
              <small>{openTicket.status === "blocked" ? "Why it stopped" : "Report"}</small>
              <RichMarkdownContent text={openTicket.result} />
            </div>
          )}
          {openTicket.status !== "in_progress" && (
            <form
              className="ai-form"
              data-testid="ticket-report-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (!report.trim()) return;
                void act({ action: "ticket-result", id: openTicket.id, result: report.trim() }).then((next) => {
                  if (next) setReport("");
                });
              }}
            >
              <label>
                Your report
                <textarea rows={3} value={report} onChange={(e) => setReport(e.target.value)} />
              </label>
              <small className="ai-hint">
                What was wrong and what you did. A scenario&apos;s last check reads this.
                {openTicket.result ? " Saving replaces the report above." : ""}
              </small>
              <div className="ai-card-actions">
                <button type="submit" disabled={!report.trim()}>
                  Save report
                </button>
              </div>
            </form>
          )}
          {(openTicket.comments ?? []).length > 0 && (
            <div className="ai-link-list">
              {(openTicket.comments ?? []).map((c) => (
                <div key={c.id} className="ai-link">
                  <div>
                    <strong>{c.author}</strong> <span>{ago(c.at)}</span>
                    <small>{c.text}</small>
                  </div>
                </div>
              ))}
            </div>
          )}

          {(openTicket.status === "review" || openTicket.status === "blocked") && (
            <div className="ai-review" data-testid="ticket-review">
              <input
                aria-label="Note for the agent"
                placeholder={
                  openTicket.status === "review"
                    ? "Note (needed to send it back: what is missing?)"
                    : "Note for the next try (optional)"
                }
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              {openTicket.status === "review" ? (
                <button
                  type="button"
                  className="ai-btn-emerald"
                  onClick={() => {
                    changeStatus(openTicket, { action: "ticket-review", id: openTicket.id, approve: true, note });
                    setNote("");
                  }}
                >
                  Approve: done
                </button>
              ) : (
                // The agent stopped: calling it done over that asks twice.
                <ConfirmButton
                  label="Mark done anyway"
                  confirmLabel="Mark it done?"
                  className="ai-btn-emerald"
                  onConfirm={() => {
                    changeStatus(openTicket, { action: "ticket-review", id: openTicket.id, approve: true, note });
                    setNote("");
                  }}
                />
              )}
              <button
                type="button"
                disabled={openTicket.status === "review" && !note.trim()}
                onClick={() => {
                  changeStatus(openTicket, { action: "ticket-review", id: openTicket.id, approve: false, note });
                  setNote("");
                }}
              >
                {openTicket.status === "review" ? "Send back" : "Back to To do"}
              </button>
            </div>
          )}

          <div className="ai-card-actions">
            {canStart(openTicket) && (
              <>
                <select aria-label="Terminal for the run" value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
                  <option value="">No terminal (the agent opens one if it needs it)</option>
                  {sessions.map((s) => (
                    <option key={s.id} value={s.id}>
                      In {s.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="ai-btn-emerald"
                  disabled={busy === openTicket.id}
                  onClick={() =>
                    void run(openTicket.id, { action: "ticket-start", id: openTicket.id, sessionId: sessionId || undefined })
                  }
                >
                  Start
                </button>
              </>
            )}
            {openTicket.taskId && hub.tasks.some((t) => t.id === openTicket.taskId) && (
              <>
                <button
                  type="button"
                  data-testid="inspect-ticket-run"
                  onClick={() => openRunDrawerForTask(openTicket.taskId)}
                >
                  Inspect run
                </button>
                <button type="button" className="ai-btn-accent" onClick={() => onOpenTask(openTicket.taskId!)}>
                  {openTicket.status === "in_progress" ? "Watch the run" : "Open the conversation"}
                </button>
              </>
            )}
            {openTicket.status !== "in_progress" && (
              <>
                <button
                  type="button"
                  onClick={() =>
                    setDraft({
                      id: openTicket.id,
                      title: openTicket.title,
                      description: openTicket.description,
                      goalId: openTicket.goalId ?? "",
                      assigneeAgentId: openTicket.assigneeAgentId ?? "",
                      target: openTicket.target ?? "",
                    })
                  }
                >
                  Edit
                </button>
                <span className="ai-move">
                  <select
                    aria-label="Move to"
                    value={moveChoice}
                    onChange={(e) => setMoveTo({ id: openTicket.id, status: e.target.value as WorkTicketStatus })}
                  >
                    {COLUMNS.filter((c) => c.status !== "in_progress").map((c) => (
                      <option key={c.status} value={c.status}>
                        {c.status === openTicket.status ? c.title : `Move to ${c.title}`}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    data-testid="ticket-move-apply"
                    disabled={!moveChoice || moveChoice === openTicket.status}
                    onClick={() => {
                      if (!moveChoice || moveChoice === openTicket.status) return;
                      setMoveTo(undefined);
                      // Done from review is an approval: the same request as "Approve: done", so its checks run.
                      changeStatus(
                        openTicket,
                        moveChoice === "done" && openTicket.status === "review"
                          ? { action: "ticket-review", id: openTicket.id, approve: true, note }
                          : { action: "ticket-move", id: openTicket.id, status: moveChoice },
                      );
                      if (moveChoice === "done" && openTicket.status === "review") setNote("");
                    }}
                  >
                    Move
                  </button>
                </span>
              </>
            )}
            <span className="ai-spacer" />
            {openTicket.status !== "in_progress" && (
              <ConfirmButton
                label="Delete"
                confirmLabel={sync?.shared ? "Delete for the whole team?" : "Delete this ticket?"}
                onConfirm={() => removeTicket(openTicket)}
              />
            )}
          </div>
          {editingOpen && ticketForm}
          <form
            className="ai-inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!comment.trim()) return;
              void act({ action: "ticket-comment", id: openTicket.id, text: comment.trim() });
              setComment("");
            }}
          >
            <input
              aria-label="Add a note"
              placeholder="Add a note. The agent reads the notes when it is woken for this ticket."
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
            <button type="submit" disabled={!comment.trim()}>
              Add note
            </button>
          </form>
        </article>
      )}

      {/* Last, and stuck to the bottom of the view: seen wherever the page is scrolled to. */}
      {notice && (
        <div className="ai-undo-notice" role="status" data-testid="workforce-notice">
          <span>{notice.text}</span>
          <span className="ai-spacer" />
          <button
            type="button"
            className="ai-btn-accent"
            onClick={() => {
              const undo = notice.undo;
              setNotice(undefined);
              void act(undo);
            }}
          >
            Undo
          </button>
          <button type="button" aria-label="Dismiss this notice" onClick={() => setNotice(undefined)}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

function RunInspectionDrawer({
  hub,
  act,
  selectedTaskId,
  defaultTaskId,
  selectedRunId,
  onSelectTask,
  onSelectRun,
  onOpenTask,
  onClose,
}: {
  hub: HubSnapshot;
  act: Act;
  selectedTaskId?: string;
  /** The open ticket's run: shown when nothing else was picked. */
  defaultTaskId?: string;
  selectedRunId?: string;
  onSelectTask: (id: string) => void;
  onSelectRun: (id: string) => void;
  onOpenTask: (taskId: string) => void;
  onClose: () => void;
}): JSX.Element {
  const tasks = useMemo(() => {
    const score = (t: AgentTask): number =>
      t.status === "running" ? 0 : t.status === "waiting" ? 1 : t.ticketId || t.workforceRunId || t.parentTaskId ? 2 : 3;
    // Only what is going on now, and runs of tickets and of the team. Plain conversations are not listed.
    const ofTickets = new Set((hub.workTickets ?? []).map((t) => t.taskId));
    return hub.tasks
      .filter((t) => score(t) < 3 || ofTickets.has(t.id) || t.id === selectedTaskId)
      .sort((a, b) => score(a) - score(b) || b.updatedAt - a.updatedAt);
  }, [hub.tasks, hub.workTickets, selectedTaskId]);

  const runs: WorkforceRun[] = useMemo(() => hub.workforceRuns ?? [], [hub.workforceRuns]);

  const activeRun = selectedRunId ? runs.find((r) => r.id === selectedRunId) : undefined;
  const activeTask = activeRun
    ? undefined
    : (selectedTaskId ? tasks.find((t) => t.id === selectedTaskId) : undefined) ??
      (defaultTaskId ? tasks.find((t) => t.id === defaultTaskId) : undefined) ??
      tasks[0];

  const childSubagents = useMemo(
    () => (activeTask ? tasks.filter((t) => t.parentTaskId === activeTask.id) : []),
    [activeTask, tasks],
  );

  const taskUsage = activeTask?.runUsage ?? activeTask?.usage;
  const toolSteps = activeTask?.toolLog ?? [];
  const scratchpadTodos = activeTask?.todos ?? [];
  // What the agent said last, from the whole conversation: a snapshot carries only the last few messages of a long one.
  const activeWhole = useFullTask(activeTask);
  const liveMessages = useMemo(
    () => (activeWhole?.messages ?? []).filter((m) => m.role === "assistant").slice(-3),
    [activeWhole],
  );
  const cmdRefs = useMemo(() => {
    const refs = new Set<string>();
    for (const c of activeTask?.changes ?? []) {
      if (c.ref) refs.add(c.ref);
    }
    return refs.size > 0 ? refs : undefined;
  }, [activeTask]);

  return (
    <aside
      className="ai-card ai-run-drawer"
      data-testid="run-inspection-drawer"
      role="region"
      aria-label="What is running"
      style={{
        marginTop: 10,
        marginBottom: 12,
        padding: 12,
        borderColor: "var(--ai-accent, #2dd4bf)",
        display: "grid",
        gap: 10,
      }}
    >
      <div className="ai-card-head">
        <div>
          <strong>What is running</strong>
          <small>
            Each run's steps, its task list, the runs it started, and its text as it comes.
          </small>
        </div>
        <button type="button" aria-label="Close run drawer" onClick={onClose}>
          Close
        </button>
      </div>

      {tasks.length === 0 && runs.length === 0 ? (
        <p className="ai-empty">Nothing is running and nothing ran lately. Start a ticket to see its steps here.</p>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(200px, 260px) minmax(0, 1fr)",
            gap: 12,
            alignItems: "start",
          }}
        >
          <div style={{ display: "grid", gap: 6, minWidth: 0 }} data-testid="run-drawer-list">
            {tasks.slice(0, 12).map((t) => {
              const isSelected = activeTask?.id === t.id && !activeRun;
              return (
                <button
                  key={t.id}
                  type="button"
                  data-testid={`run-drawer-task-${t.id}`}
                  aria-pressed={isSelected}
                  className={`ai-chip ai-run-list-item ${isSelected ? "ai-chip-on" : ""}`}
                  title={t.title}
                  onClick={() => onSelectTask(t.id)}
                >
                  <span style={{ fontWeight: 600, fontSize: 12 }}>
                    {t.parentTaskId ? "↳ " : ""}
                    {t.title}
                  </span>
                  <small style={{ opacity: 0.8, fontSize: 11 }}>
                    {t.status} · {t.agentName ?? "Assistant"}
                    {t.investigator ? " · subagent" : ""}
                    {t.toolLog?.length ? ` · ${t.toolLog.length} steps` : ""}
                  </small>
                </button>
              );
            })}
            {runs.slice(0, 6).map((r) => {
              const isSelected = activeRun?.id === r.id;
              return (
                <button
                  key={r.id}
                  type="button"
                  data-testid={`run-drawer-workforce-${r.id}`}
                  aria-pressed={isSelected}
                  className={`ai-chip ai-run-list-item ${isSelected ? "ai-chip-on" : ""}`}
                  onClick={() => onSelectRun(r.id)}
                >
                  <span style={{ fontWeight: 600, fontSize: 12 }}>⚡ {r.title}</span>
                  {isDemoRun(r) && <span className="ai-badge">Example</span>}
                  <small style={{ opacity: 0.8, fontSize: 11 }}>
                    {r.status} · {r.leadAgentName} · {r.steps.length} specialists
                  </small>
                </button>
              );
            })}
          </div>

          <div style={{ display: "grid", gap: 10, minWidth: 0 }}>
            {activeTask && (
              <>
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                  <strong>{activeTask.title}</strong>
                  <span
                    className={`ai-badge ${activeTask.status === "running" ? "ai-badge-success" : activeTask.status === "waiting" ? "ai-badge-mode" : activeTask.status === "failed" ? "ai-badge-danger" : ""}`}
                  >
                    {activeTask.status}
                  </span>
                  {activeTask.investigator && <span className="ai-badge ai-badge-purple">subagent</span>}
                  {activeTask.target?.label && <span className="ai-badge">{activeTask.target.label}</span>}
                  {taskUsage && (
                    <span className="ai-badge" style={TABULAR_NUMS_STYLE}>
                      {formatTokenUsage(taskUsage.inputTokens, taskUsage.outputTokens, taskUsage.costUsd)}
                    </span>
                  )}
                  <span className="ai-spacer" />
                  {(activeTask.status === "running" || activeTask.status === "waiting") && (
                    <button
                      type="button"
                      className="ai-btn-danger"
                      onClick={() => void act({ action: "stop", taskId: activeTask.id })}
                    >
                      Stop run
                    </button>
                  )}
                  <button type="button" className="ai-btn-accent" onClick={() => onOpenTask(activeTask.id)}>
                    Open full chat
                  </button>
                </div>

                {childSubagents.length > 0 && (
                  <div data-testid="run-drawer-subagents" style={{ display: "grid", gap: 6 }}>
                    <small className="ai-muted">Runs it started ({childSubagents.length})</small>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {childSubagents.map((sub) => (
                        <button
                          key={sub.id}
                          type="button"
                          className="ai-chip"
                          onClick={() => onSelectTask(sub.id)}
                        >
                          {sub.agentName ?? sub.title} · {sub.status} ({sub.toolLog?.length ?? 0} steps)
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div data-testid="run-drawer-scratchpad" style={{ display: "grid", gap: 6 }}>
                  <small className="ai-muted">Scratchpad &amp; plan steps ({scratchpadTodos.length})</small>
                  {scratchpadTodos.length === 0 ? (
                    <small style={{ opacity: 0.7 }}>No scratchpad items recorded yet.</small>
                  ) : (
                    <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 3, fontSize: 12 }}>
                      {scratchpadTodos.map((todo) => (
                        <li key={todo.id}>
                          <span className="ai-badge" style={{ marginRight: 6 }}>
                            {todo.status}
                          </span>
                          <span>{todo.content}</span>
                          {todo.note && <small style={{ marginLeft: 6, opacity: 0.75 }}>({todo.note})</small>}
                        </li>
                      ))}
                    </ul>
                  )}
                  {activeTask.hypotheses && activeTask.hypotheses.length > 0 && (
                    <HypothesisTree
                      hypotheses={activeTask.hypotheses}
                      refs={cmdRefs}
                    />
                  )}
                </div>

                <div data-testid="run-drawer-tool-steps" style={{ display: "grid", gap: 6 }}>
                  <small className="ai-muted">Tool steps ({toolSteps.length})</small>
                  {toolSteps.length === 0 ? (
                    <small style={{ opacity: 0.7 }}>No tool calls logged yet.</small>
                  ) : (
                    <div style={{ display: "grid", gap: 6, maxHeight: 220, overflowY: "auto" }}>
                      {toolSteps.map((step, i) => (
                        <div
                          key={`${step.name}-${step.at}-${i}`}
                          style={{
                            padding: "6px 8px",
                            borderRadius: 8,
                            border: "1px solid var(--ai-line, rgba(148,163,184,0.22))",
                            background: "rgba(0,0,0,0.16)",
                            fontSize: 11.5,
                            display: "grid",
                            gap: 3,
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                            <strong>{step.name}</strong>
                            {step.target && <span className="ai-badge">{step.target}</span>}
                            {step.durationMs !== undefined && (
                              <span className="ai-badge" style={TABULAR_NUMS_STYLE}>
                                {step.durationMs}ms
                              </span>
                            )}
                            {step.exitCode !== undefined && (
                              <span className={`ai-badge ${step.exitCode === 0 ? "ai-badge-success" : "ai-badge-danger"}`}>
                                exit {step.exitCode}
                              </span>
                            )}
                            {step.ok === false && <span className="ai-badge ai-badge-danger">error</span>}
                          </div>
                          {step.input && (
                            <code style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", opacity: 0.85 }}>
                              {step.input}
                            </code>
                          )}
                          {step.output && (
                            <pre
                              style={{
                                margin: 0,
                                maxHeight: 90,
                                overflow: "auto",
                                whiteSpace: "pre-wrap",
                                opacity: 0.8,
                              }}
                            >
                              {step.output}
                            </pre>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div data-testid="run-drawer-live-output" style={{ display: "grid", gap: 6 }}>
                  <small className="ai-muted">Live output</small>
                  {liveMessages.length === 0 && !activeTask.error ? (
                    <small style={{ opacity: 0.7 }}>Waiting for agent output…</small>
                  ) : (
                    <div
                      style={{
                        maxHeight: 200,
                        overflowY: "auto",
                        padding: "8px 10px",
                        borderRadius: 8,
                        border: "1px solid var(--ai-line, rgba(148,163,184,0.22))",
                        background: "rgba(0,0,0,0.14)",
                      }}
                    >
                      {activeTask.error && (
                        <p className="ai-badge ai-badge-danger" style={{ marginBottom: 6 }}>
                          {activeTask.error}
                        </p>
                      )}
                      {liveMessages.map((msg) => (
                        <RichMarkdownContent key={msg.id} text={msg.text} refs={cmdRefs} />
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}

            {activeRun && (
              <div data-testid="run-drawer-workforce-detail" style={{ display: "grid", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <strong>{activeRun.title}</strong>
                  <span className={`ai-badge ${activeRun.status === "running" ? "ai-badge-success" : activeRun.status === "failed" ? "ai-badge-danger" : ""}`}>
                    {activeRun.status}
                  </span>
                  <small>Lead: {activeRun.leadAgentName}</small>
                </div>
                {isDemoRun(activeRun) && (
                  <small className="ai-muted" data-testid="run-drawer-demo-label">
                    {DEMO_RUN_LABEL}
                  </small>
                )}
                {activeRun.steps.map((step) => (
                  <div
                    key={step.id}
                    style={{
                      padding: "8px 10px",
                      borderRadius: 8,
                      border: "1px solid var(--ai-line, rgba(148,163,184,0.22))",
                      display: "grid",
                      gap: 4,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <strong>{step.agentName}</strong>
                      <small>{step.role}</small>
                      <span className="ai-badge">{step.status}</span>
                      {step.taskId && (
                        <button
                          type="button"
                          className="ai-chip"
                          style={{ marginLeft: "auto" }}
                          onClick={() => onSelectTask(step.taskId!)}
                        >
                          Inspect task
                        </button>
                      )}
                    </div>
                    <small>{step.subTask}</small>
                    {step.findings && <RichMarkdownContent text={step.findings} />}
                    {step.error && <small className="ai-badge ai-badge-danger">{step.error}</small>}
                  </div>
                ))}
                {activeRun.synthesis && (
                  <div data-testid="run-drawer-live-output">
                    <small className="ai-muted">Synthesis</small>
                    <RichMarkdownContent text={activeRun.synthesis} />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}

function AgentPanel({
  live,
  agents,
  tickets,
  act,
  onOpenTask,
  onInspectRun,
  onOpenTicket,
}: {
  live: AgentLive;
  agents: MissionAgent[];
  tickets: WorkTicket[];
  act: Act;
  onOpenTask: (taskId: string) => void;
  onInspectRun: (taskId: string) => void;
  onOpenTicket: (ticketId: string) => void;
}): JSX.Element {
  const { agent } = live;
  const [budget, setBudget] = useState(String(agent.monthlyTokenBudget ? Math.round(agent.monthlyTokenBudget / 1000) : ""));
  const save = (patch: Partial<MissionAgent>): void => void act({ action: "agent-save", agent: { ...agent, ...patch } });
  // Reporting to somebody below you would close a circle.
  const below = new Set<string>([agent.id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const a of agents)
      if (a.reportsTo && below.has(a.reportsTo) && !below.has(a.id)) {
        below.add(a.id);
        grew = true;
      }
  }
  return (
    <article className="ai-card" data-testid="agent-panel" key={agent.id}>
      <div className="ai-card-head">
        <div>
          <strong>{agent.name}</strong>
          <small>
            {agent.role} · {modes[agent.defaultMode] ?? agent.defaultMode}
            {live.spent ? ` · ${tokens(live.spent)} tokens this month` : ""}
          </small>
        </div>
        <button
          type="button"
          className={agent.enabled === false ? "ai-btn-emerald" : ""}
          onClick={() => void act({ action: "agent-pause", id: agent.id, paused: agent.enabled !== false })}
        >
          {agent.enabled === false ? "Resume" : "Pause"}
        </button>
      </div>
      {live.doing && <p className="ai-doc-excerpt">{live.doing}</p>}
      <div className="ai-form ai-form-row">
        <label>
          Reports to
          <select value={agent.reportsTo ?? ""} onChange={(e) => save({ reportsTo: e.target.value || undefined })}>
            <option value="">Nobody (top of the team)</option>
            {agents
              .filter((a) => !below.has(a.id))
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          Token budget per month (thousands, empty: no limit)
          <input
            type="number"
            min={0}
            placeholder="No limit"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            onBlur={() => {
              const next = Math.max(0, Number(budget) || 0) * 1000;
              if (next !== (agent.monthlyTokenBudget ?? 0)) save({ monthlyTokenBudget: next || undefined });
            }}
          />
        </label>
      </div>
      {tickets.filter((t) => t.status !== "done").length > 0 && (
        <div className="ai-link-list">
          {tickets
            .filter((t) => t.status !== "done")
            .map((t) => (
              <div key={t.id} className="ai-link">
                <div>
                  <strong>{t.title}</strong> <span>{COLUMNS.find((c) => c.status === t.status)?.title}</span>
                </div>
                <button type="button" onClick={() => onOpenTicket(t.id)}>
                  Open
                </button>
              </div>
            ))}
        </div>
      )}
      {live.task && (
        <div className="ai-card-actions">
          <button type="button" onClick={() => onInspectRun(live.task!.id)}>
            Inspect run
          </button>
          <button type="button" className="ai-btn-accent" onClick={() => onOpenTask(live.task!.id)}>
            Watch it work
          </button>
        </div>
      )}
    </article>
  );
}
