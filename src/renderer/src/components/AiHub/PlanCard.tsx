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
  const body = (
    <>
      <ol className="ai-plan-steps">
        {plan.steps.map((step, index) => (
          <li key={index} data-testid={`plan-step-${index + 1}`} data-risk={step.risk}>
            <div className="ai-plan-step-head">
              <span className={RISK_CLASS[step.risk]}>{step.risk} risk</span>
              <span>{step.action}</span>
              {step.target && <small>· {step.target}</small>}
              {step.ranAt && <small>· ran</small>}
            </div>
            {step.command && <code>$ {step.command}</code>}
            <small>Check: {step.check}</small>
            {step.rollback && <small>Undo: {step.rollback}</small>}
          </li>
        ))}
      </ol>

      {plan.assumptions && plan.assumptions.length > 0 && (
        <small>Not checked: {plan.assumptions.join("; ")}</small>
      )}

      <div
        className="ai-plan-review"
        data-testid="plan-review"
        data-verdict={plan.review.verdict}
      >
        <strong>
          {plan.review.verdict === "approve"
            ? "Review: no problems found"
            : plan.review.verdict === "revise"
              ? "Review: problems found"
              : "Not reviewed"}
        </strong>
        {plan.review.findings.length > 0 && (
          <ul>
            {plan.review.findings.map((finding, index) => (
              <li key={index}>{finding}</li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
  const status = (
    <span className="ai-badge" data-testid="plan-status">
      {waiting
        ? "waiting for your decision"
        : plan.status === "approved"
          ? "approved"
          : "not approved"}
    </span>
  );
  const title = (
    <strong>
      Plan{plan.revision > 1 ? ` (version ${plan.revision})` : ""}: {plan.goal}
    </strong>
  );
  // A decided plan folds away: the work is in the task list now.
  if (!waiting)
    return (
      <details
        className="ai-plan"
        data-testid="plan-card"
        data-status={plan.status}
        aria-label="The agent's plan"
      >
        <summary className="ai-plan-head">
          {title}
          {status}
        </summary>
        {body}
      </details>
    );
  return (
    <section
      className="ai-plan ai-plan-waiting"
      data-testid="plan-card"
      data-status={plan.status}
      aria-label="The agent's plan"
    >
      <div className="ai-plan-head">
        {title}
        {status}
      </div>
      {body}

      <div className="ai-plan-decision">
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
          <div className="ai-plan-actions">
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
      </div>
    </section>
  );
}
