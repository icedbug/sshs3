import { useState } from "react";
import type { AgentPlan, HubRequest, HubSnapshot } from "@shared/types/aiHub";

type Act = (request: HubRequest) => Promise<HubSnapshot | undefined>;

const RISK_CLASS: Record<AgentPlan["steps"][number]["risk"], string> = {
  low: "ai-badge ai-badge-success",
  medium: "ai-badge ai-badge-mode",
  high: "ai-badge ai-badge-danger",
};

/**
 * The plan an agent proposed, with its review, for the user to decide on.
 * Until it is approved the agent cannot change anything; once approved, the
 * commands it lists run without asking again (destructive ones still ask).
 */
export function PlanCard({
  taskId,
  plan,
  busy,
  act,
}: {
  taskId: string;
  plan?: AgentPlan;
  /** The agent is still working: the decision waits until it has stopped. */
  busy: boolean;
  act: Act;
}): JSX.Element | null {
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  if (!plan) return null;
  const decide = (approved: boolean): void => {
    setSending(true);
    void act({
      action: "plan-decide",
      taskId,
      approved,
      ...(note.trim() ? { note: note.trim() } : {}),
    }).finally(() => setSending(false));
  };
  const waiting = plan.status === "proposed";
  const listed = plan.steps.filter((s) => s.command).length;
  return (
    <section
      className="ai-card"
      data-testid="plan-card"
      aria-label="The agent's plan"
      style={{ margin: "8px 0", padding: "10px 12px", display: "grid", gap: 8 }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 13 }}>
          Plan{plan.revision > 1 ? ` (version ${plan.revision})` : ""}: {plan.goal}
        </strong>
        <span className="ai-badge" data-testid="plan-status">
          {waiting
            ? "waiting for your decision"
            : plan.status === "approved"
              ? "approved"
              : "not approved"}
        </span>
      </div>

      <ol style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6, fontSize: 12 }}>
        {plan.steps.map((step, index) => (
          <li key={index} data-testid={`plan-step-${index + 1}`}>
            <span className={RISK_CLASS[step.risk]} style={{ marginRight: 6 }}>
              {step.risk} risk
            </span>
            {step.action}
            {step.target && <small style={{ opacity: 0.8 }}> · {step.target}</small>}
            {step.ranAt && <small style={{ opacity: 0.8 }}> · ran</small>}
            {step.command && (
              <code style={{ display: "block", marginTop: 2, whiteSpace: "pre-wrap" }}>
                $ {step.command}
              </code>
            )}
            <small style={{ display: "block", opacity: 0.85 }}>Check: {step.check}</small>
            {step.rollback && (
              <small style={{ display: "block", opacity: 0.85 }}>Undo: {step.rollback}</small>
            )}
          </li>
        ))}
      </ol>

      {plan.assumptions && plan.assumptions.length > 0 && (
        <small>Not checked: {plan.assumptions.join("; ")}</small>
      )}

      <div data-testid="plan-review" style={{ fontSize: 12 }}>
        <strong>
          {plan.review.verdict === "approve"
            ? "Review: no problems found"
            : plan.review.verdict === "revise"
              ? "Review: problems found"
              : "Not reviewed"}
        </strong>
        {plan.review.findings.length > 0 && (
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {plan.review.findings.map((finding, index) => (
              <li key={index}>{finding}</li>
            ))}
          </ul>
        )}
      </div>

      {waiting && (
        <>
          <input
            aria-label="Note to the agent"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note, or what to change…"
            disabled={sending || busy}
          />
          <small>
            {busy
              ? "The agent is still working; you can decide when it has stopped."
              : listed > 0
                ? `Approving lets the agent carry the plan out. The ${listed} command(s) listed above run without asking you again; anything else, and anything destructive, still asks.`
                : "Approving lets the agent carry the plan out; commands that change something still ask."}
          </small>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              className="ai-btn-emerald"
              data-testid="plan-approve-btn"
              disabled={sending || busy}
              onClick={() => decide(true)}
            >
              Approve and run
            </button>
            <button
              type="button"
              data-testid="plan-reject-btn"
              disabled={sending || busy}
              onClick={() => decide(false)}
            >
              {note.trim() ? "Send back with this note" : "Don't run it"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
