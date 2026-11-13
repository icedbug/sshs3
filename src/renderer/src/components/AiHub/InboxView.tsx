import { useEffect, useRef, useState } from "react";
import type { HubSnapshot } from "@shared/types/aiHub";
import { ChangeProof } from "./ChangeProof";
import { type Act } from "./panelShared";
import { RichMarkdownContent } from "./RichMarkdownContent";
import { inboxItems, type InboxItem, type InboxKind } from "./workforceModel";

const KIND: Record<InboxKind, { label: string; tone: string }> = {
  approval: { label: "Wants to run", tone: "ai-inbox-now" },
  plan: { label: "Plan to decide", tone: "ai-inbox-now" },
  question: { label: "Asks you", tone: "ai-inbox-now" },
  alert: { label: "Alert", tone: "ai-inbox-warn" },
  blocked: { label: "Stopped", tone: "ai-inbox-warn" },
  health: { label: "Server", tone: "ai-inbox-warn" },
  review: { label: "To review", tone: "" },
  report: { label: "Report", tone: "" },
  knowledge: { label: "Knowledge base", tone: "" },
};

const ago = (at: number): string => {
  const mins = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} d ago`;
};

/** Everything that is waiting for a person, in one place, each with what can be done about it right here. */
export function InboxView({
  hub,
  act,
  onOpenTask,
  onOpenView,
  focusItemId,
}: {
  hub: HubSnapshot;
  act: Act;
  onOpenTask: (taskId: string) => void;
  onOpenView: (view: "Workforce" | "Knowledge Base" | "Infrastructure") => void;
  /** The item a notification's link pointed at: shown first, or said to be handled if it is gone. */
  focusItemId?: string;
}): JSX.Element {
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [address, setAddress] = useState("");
  const [pasted, setPasted] = useState("");
  const [rules, setRules] = useState<{ match: string; agentId: string }[] | undefined>();
  const items = inboxItems(hub);
  const focused = useRef<HTMLElement | null>(null);
  const focusPresent = Boolean(focusItemId && items.some((i) => i.id === focusItemId));
  useEffect(() => {
    if (focusPresent) focused.current?.scrollIntoView?.({ block: "center" });
  }, [focusPresent, focusItemId]);
  const intake = hub.alertIntake;
  const agents = hub.agents ?? [];
  const shownRules = rules ?? intake?.rules ?? [];
  const note = (id: string): string => notes[id] ?? "";

  const actions = (item: InboxItem): JSX.Element => {
    switch (item.kind) {
      case "approval":
        return (
          <>
            <button
              type="button"
              className="ai-btn-emerald"
              onClick={() => void act({ action: "approve", taskId: item.taskId!, changeId: item.changeId!, approved: true })}
            >
              Approve
            </button>
            <button
              type="button"
              className="ai-btn-danger"
              onClick={() => void act({ action: "approve", taskId: item.taskId!, changeId: item.changeId!, approved: false })}
            >
              Deny
            </button>
            <button type="button" onClick={() => onOpenTask(item.taskId!)}>
              Open
            </button>
          </>
        );
      case "plan":
        return (
          <>
            <button
              type="button"
              className="ai-btn-emerald"
              onClick={() => void act({ action: "plan-decide", taskId: item.taskId!, approved: true })}
            >
              Approve the plan
            </button>
            <button type="button" onClick={() => onOpenTask(item.taskId!)}>
              Read it
            </button>
          </>
        );
      case "question":
        return (
          <button type="button" className="ai-btn-accent" onClick={() => onOpenTask(item.taskId!)}>
            Answer
          </button>
        );
      case "review":
      case "blocked":
        return (
          <>
            <input
              aria-label="Note for the agent"
              placeholder={item.kind === "review" ? "Note (needed to send it back)" : "Note for the next try"}
              value={note(item.id)}
              onChange={(e) => setNotes({ ...notes, [item.id]: e.target.value })}
            />
            <button
              type="button"
              className="ai-btn-emerald"
              onClick={() => void act({ action: "ticket-review", id: item.ticketId!, approve: true, note: note(item.id) })}
            >
              {item.kind === "review" ? "Approve: done" : "Mark done"}
            </button>
            <button
              type="button"
              disabled={item.kind === "review" && !note(item.id).trim()}
              onClick={() => void act({ action: "ticket-review", id: item.ticketId!, approve: false, note: note(item.id) })}
            >
              {item.kind === "review" ? "Send back" : "Try again"}
            </button>
            {item.taskId && hub.tasks.some((t) => t.id === item.taskId) && (
              <button type="button" onClick={() => onOpenTask(item.taskId!)}>
                Open
              </button>
            )}
          </>
        );
      case "alert":
        return (
          <button type="button" className="ai-btn-accent" onClick={() => onOpenView("Workforce")}>
            Assign it
          </button>
        );
      case "health":
        return (
          <>
            <button type="button" onClick={() => onOpenView("Infrastructure")}>
              Look at the server
            </button>
            <button type="button" onClick={() => void act({ action: "facts-problem-dismiss", serverId: item.serverId! })}>
              Dismiss
            </button>
          </>
        );
      case "knowledge":
        return (
          <>
            <button type="button" onClick={() => onOpenView("Knowledge Base")}>
              Look at it
            </button>
            <button type="button" onClick={() => void act({ action: "kb-finding-dismiss", id: item.findingId! })}>
              Dismiss
            </button>
          </>
        );
      case "report":
        return (
          <button type="button" onClick={() => void act({ action: "daily-report-read" })}>
            Mark read
          </button>
        );
    }
  };

  return (
    <div className="ai-scroll">
      <header className="ai-view-head">
        <h2>Inbox</h2>
        <p className="ai-hint">
          Everything that is waiting for you: commands agents want to run, plans, questions, finished tickets, runs
          that stopped, alerts nobody has. What blocks a running agent comes first.
        </p>
      </header>

      {focusItemId && !focusPresent && (
        <p className="ai-note" role="status" data-testid="inbox-handled">
          What that notification was about no longer waits: it has been answered, or the agent stopped waiting.
        </p>
      )}
      {items.length === 0 && (
        <p className="ai-empty" data-testid="inbox-empty">
          Nothing is waiting for you.
        </p>
      )}
      <div className="ai-inbox-list" data-testid="inbox-list">
        {items.map((item) => (
          <article
            key={item.id}
            ref={item.id === focusItemId ? focused : undefined}
            className={`ai-card ai-inbox-item ${KIND[item.kind].tone}${item.id === focusItemId ? " ai-inbox-focus" : ""}`}
            data-testid={`inbox-${item.kind}`}
          >
            <div className="ai-card-head">
              <div>
                <small className="ai-inbox-kind">
                  {KIND[item.kind].label}
                  {item.from ? ` · ${item.from}` : ""}
                  {item.target && !item.from?.includes(item.target) ? ` · ${item.target}` : ""} · {ago(item.at)}
                </small>
                <strong>{item.title}</strong>
              </div>
              {item.risk && (
                <span className={`ai-badge ${item.risk === "destructive" || item.risk === "critical" ? "ai-badge-danger" : item.risk === "safe" ? "ai-badge-success" : "ai-badge-mode"}`}>
                  {item.risk === "safe" ? "read-only" : item.risk === "modify" ? "changes state" : item.risk}
                </span>
              )}
            </div>
            {item.kind === "approval" && item.detail ? (
              <>
                <pre className="ai-terminal-peek">{item.detail}</pre>
                {(() => {
                  const change = hub.tasks.find((t) => t.id === item.taskId)?.changes.find((c) => c.id === item.changeId);
                  return change ? <ChangeProof change={change} /> : null;
                })()}
              </>
            ) : item.kind === "report" && hub.dailyReport ? (
              <div className="ai-doc-body">
                <RichMarkdownContent text={hub.dailyReport.text} />
              </div>
            ) : item.detail ? (
              <p className="ai-doc-excerpt">{item.detail}</p>
            ) : null}
            <div className="ai-card-actions">{actions(item)}</div>
          </article>
        ))}
      </div>

      <details className="ai-fold ai-set-fold" data-testid="alerts-in">
        <summary>
          Alerts in{intake?.enabled ? ` · on, ${intake.received} received` : " · off"}
        </summary>
        <div className="ai-form">
          <p className="ai-hint">
            An alert becomes a ticket on the board: the same alert firing again is counted on its ticket, and with the
            heartbeat on an agent starts looking before anyone is awake. The alert&apos;s text is given to the agent
            as data, never as an instruction.
          </p>
          {intake?.canReceive ? (
            <>
              <div className="ai-card-actions">
                <button
                  type="button"
                  className="ai-btn-accent"
                  onClick={() =>
                    void act({ action: "alert-hook-create" }).then((snap) => {
                      const path = snap?.reply?.alertHook?.path;
                      if (path) setAddress(`${window.location.origin}${path}`);
                    })
                  }
                >
                  {intake.enabled ? "Replace the address" : "Create an address to post to"}
                </button>
                {intake.enabled && (
                  <button type="button" onClick={() => void act({ action: "alert-hook-disable" }).then(() => setAddress(""))}>
                    Turn off
                  </button>
                )}
              </div>
              {address && (
                <label>
                  Post alerts here (Alertmanager webhook, Grafana contact point, PagerDuty webhook, or any JSON). Shown
                  once: it is the key.
                  <input readOnly className="ai-mono" data-testid="alert-address" value={address} onFocus={(e) => e.target.select()} />
                </label>
              )}
            </>
          ) : (
            <p className="ai-hint">
              The desktop app has no address a monitoring system can reach. Run sshS3 as a server
              (docs/workforce-server.md) to receive alerts; here you can paste one.
            </p>
          )}
          <fieldset className="ai-checks ai-alert-rules">
            <legend>Who gets which alert (first match wins; otherwise the agent bound to the cluster, then a team&apos;s lead)</legend>
            {shownRules.map((rule, i) => (
              <div key={i} className="ai-inline-form">
                <input
                  aria-label="Alert contains"
                  placeholder="disk, postgres, DB-Prod…"
                  value={rule.match}
                  onChange={(e) => setRules(shownRules.map((r, j) => (j === i ? { ...r, match: e.target.value } : r)))}
                />
                <select
                  aria-label="Goes to"
                  value={rule.agentId}
                  onChange={(e) => setRules(shownRules.map((r, j) => (j === i ? { ...r, agentId: e.target.value } : r)))}
                >
                  <option value="">Choose an agent</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                <button type="button" onClick={() => setRules(shownRules.filter((_, j) => j !== i))}>
                  Remove
                </button>
              </div>
            ))}
            <div className="ai-card-actions">
              <button type="button" onClick={() => setRules([...shownRules, { match: "", agentId: "" }])}>
                Add a rule
              </button>
              {rules && (
                <button
                  type="button"
                  className="ai-btn-emerald"
                  onClick={() => void act({ action: "alert-rules-save", rules }).then(() => setRules(undefined))}
                >
                  Save rules
                </button>
              )}
            </div>
          </fieldset>
          <label>
            Paste an alert (the JSON a monitoring system would post, or just its text)
            <textarea rows={3} data-testid="alert-paste" value={pasted} onChange={(e) => setPasted(e.target.value)} />
          </label>
          <div className="ai-card-actions">
            <button
              type="button"
              disabled={!pasted.trim()}
              onClick={() => void act({ action: "alert-paste", text: pasted }).then((snap) => snap && setPasted(""))}
            >
              Make a ticket of it
            </button>
          </div>
        </div>
      </details>
    </div>
  );
}
