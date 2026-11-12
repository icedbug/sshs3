import { lazy, Suspense, useState } from "react";
import type {
  HubSnapshot,
  MissionAgent,
  WorkGoal,
  WorkTicket,
  WorkTicketStatus,
} from "@shared/types/aiHub";
import { ConfirmButton } from "./ConfirmButton";
import { type Act, modes } from "./panelShared";
import { RichMarkdownContent } from "./RichMarkdownContent";
import { COLUMNS, agentsLive, goalProgress, tokens, type AgentLive } from "./workforceModel";

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

export function WorkforceView({
  hub,
  act,
  onOpenTask,
}: {
  hub: HubSnapshot;
  act: Act;
  onOpenTask: (taskId: string) => void;
}): JSX.Element {
  const [tab, setTab] = useState<"board" | "team">("board");
  const [goalFilter, setGoalFilter] = useState("");
  const [draft, setDraft] = useState<TicketDraft | undefined>();
  const [goalDraft, setGoalDraft] = useState<{ id?: string; title: string; description: string } | undefined>();
  const [openTicketId, setOpenTicketId] = useState("");
  const [agentId, setAgentId] = useState<string | undefined>();
  const [note, setNote] = useState("");
  const [comment, setComment] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [dragId, setDragId] = useState("");
  const [busy, setBusy] = useState("");

  const goals = hub.workGoals ?? [];
  const tickets = hub.workTickets ?? [];
  const agents = hub.agents ?? [];
  const team = agentsLive(hub);
  const sessions = hub.sessions.filter((s) => s.state !== "disconnected");
  const shown = tickets.filter((t) => !goalFilter || t.goalId === goalFilter);
  const openTicket = tickets.find((t) => t.id === openTicketId);
  const selectedAgent = team.find((t) => t.agent.id === agentId);
  const empty = goals.length === 0 && tickets.length === 0;
  const heartbeat = hub.preferences.workforceAutopilot === true;
  const sync = hub.workBoardSync;

  const run = (key: string, request: Parameters<Act>[0]): Promise<HubSnapshot | undefined> => {
    setBusy(key);
    return act(request).finally(() => setBusy(""));
  };
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
        Outcome
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
          Concerns (optional)
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
            also build your own: add a goal and tickets here, and agents under Agents &amp; MCP.
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
            <span className={heartbeat ? "ai-heartbeat-on" : ""}>Heartbeat</span>
          </label>
          <button type="button" onClick={() => setGoalDraft(goalDraft ? undefined : { title: "", description: "" })}>
            New goal
          </button>
          <button
            type="button"
            className="ai-btn-accent"
            onClick={() =>
              setDraft(
                draft
                  ? undefined
                  : { title: "", description: "", goalId: goalFilter || goals[0]?.id || "", assigneeAgentId: "", target: "" },
              )
            }
          >
            New ticket
          </button>
        </div>
      </div>
      <small className="ai-sync-note">
        {sync?.shared
          ? `Shared with the team${sync.lastSyncAt ? ` · read ${ago(sync.lastSyncAt)}` : ""}${sync.error ? ` · last sync failed: ${sync.error}` : ""}`
          : "Only on this computer. Connect a team bucket to share the board."}
        {heartbeat ? " · Heartbeat on: this app starts tickets by itself." : ""}
      </small>

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
      {ticketForm}

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
                  {g.title} · {p.done}/{p.total}
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

      {tab === "board" && (
        <div className="ai-board" data-testid="workforce-board">
          {COLUMNS.map((col) => {
            const cards = shown
              .filter((t) => t.status === col.status)
              .sort((a, b) => (col.status === "done" ? b.updatedAt - a.updatedAt : a.createdAt - b.createdAt));
            const droppable = col.status !== "in_progress";
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
                    void act({ action: "ticket-move", id: moved.id, status: col.status });
                }}
              >
                <header title={col.hint}>
                  <span>{col.title}</span>
                  <span className="ai-count">{cards.length}</span>
                </header>
                {cards.slice(0, col.status === "done" ? 12 : 60).map((t) => (
                  <article
                    key={t.id}
                    className={`ai-ticket ${t.status === "in_progress" ? "ai-ticket-live" : ""} ${openTicketId === t.id ? "ai-ticket-open" : ""}`}
                    data-testid={`ticket-${t.id}`}
                    draggable={t.status !== "in_progress"}
                    onDragStart={() => setDragId(t.id)}
                    onDragEnd={() => setDragId("")}
                    onClick={() => {
                      setOpenTicketId(openTicketId === t.id ? "" : t.id);
                      setNote("");
                      setComment("");
                    }}
                  >
                    <strong>{t.title}</strong>
                    <div className="ai-ticket-meta">
                      <span>{t.assigneeName ?? "Unassigned"}</span>
                      {t.target && <span>{t.target}</span>}
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
                ))}
                {cards.length === 0 && <p className="ai-column-empty">{col.hint || "Nothing yet"}</p>}
              </section>
            );
          })}
        </div>
      )}

      {tab === "team" && (
        <div className={`ai-team ${selectedAgent ? "ai-team-split" : ""}`}>
          {agents.length === 0 ? (
            <p className="ai-empty">No agents yet. Set up a team above, or add agents under Agents &amp; MCP.</p>
          ) : (
            <Suspense fallback={<p className="ai-empty">Loading the team…</p>}>
              <TeamGraph team={team} selectedId={agentId} onSelect={setAgentId} />
            </Suspense>
          )}
          {selectedAgent && (
            <AgentPanel
              live={selectedAgent}
              agents={agents}
              tickets={tickets.filter((t) => t.assigneeAgentId === selectedAgent.agent.id)}
              act={act}
              onOpenTask={onOpenTask}
              onOpenTicket={(id) => {
                setTab("board");
                setOpenTicketId(id);
              }}
            />
          )}
        </div>
      )}

      {openTicket && tab === "board" && (
        <article className="ai-card ai-ticket-detail" data-testid="ticket-detail">
          <div className="ai-card-head">
            <div>
              <strong>{openTicket.title}</strong>
              <small>
                {openTicket.id} · {COLUMNS.find((c) => c.status === openTicket.status)?.title} ·{" "}
                {openTicket.assigneeName ?? "unassigned"}
                {goals.find((g) => g.id === openTicket.goalId) ? ` · ${goals.find((g) => g.id === openTicket.goalId)!.title}` : ""}
                {openTicket.tokens ? ` · ${tokens(openTicket.tokens)} tokens` : ""} · by {openTicket.createdBy}
              </small>
            </div>
            <button type="button" aria-label="Close ticket" onClick={() => setOpenTicketId("")}>
              Close
            </button>
          </div>
          {openTicket.description && <p className="ai-memory-text">{openTicket.description}</p>}
          {openTicket.result && (
            <div className="ai-doc-body">
              <small>{openTicket.status === "blocked" ? "Why it stopped" : "The agent's report"}</small>
              <RichMarkdownContent text={openTicket.result} />
            </div>
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
              <button
                type="button"
                className="ai-btn-emerald"
                onClick={() => {
                  void act({ action: "ticket-review", id: openTicket.id, approve: true, note });
                  setNote("");
                }}
              >
                {openTicket.status === "review" ? "Approve: done" : "Mark done anyway"}
              </button>
              <button
                type="button"
                disabled={openTicket.status === "review" && !note.trim()}
                onClick={() => {
                  void act({ action: "ticket-review", id: openTicket.id, approve: false, note });
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
              <button type="button" className="ai-btn-accent" onClick={() => onOpenTask(openTicket.taskId!)}>
                {openTicket.status === "in_progress" ? "Watch the run" : "Open the conversation"}
              </button>
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
                <select
                  aria-label="Move to"
                  value={openTicket.status}
                  onChange={(e) =>
                    void act({ action: "ticket-move", id: openTicket.id, status: e.target.value as WorkTicketStatus })
                  }
                >
                  {COLUMNS.filter((c) => c.status !== "in_progress").map((c) => (
                    <option key={c.status} value={c.status}>
                      {c.status === openTicket.status ? c.title : `Move to ${c.title}`}
                    </option>
                  ))}
                </select>
              </>
            )}
            <span className="ai-spacer" />
            {openTicket.status !== "in_progress" && (
              <ConfirmButton
                label="Delete"
                confirmLabel={sync?.shared ? "Delete for the whole team?" : "Delete this ticket?"}
                onConfirm={() => {
                  setOpenTicketId("");
                  void act({ action: "ticket-delete", id: openTicket.id });
                }}
              />
            )}
          </div>
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
    </div>
  );
}

function AgentPanel({
  live,
  agents,
  tickets,
  act,
  onOpenTask,
  onOpenTicket,
}: {
  live: AgentLive;
  agents: MissionAgent[];
  tickets: WorkTicket[];
  act: Act;
  onOpenTask: (taskId: string) => void;
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
          <button type="button" className="ai-btn-accent" onClick={() => onOpenTask(live.task!.id)}>
            Watch it work
          </button>
        </div>
      )}
    </article>
  );
}
