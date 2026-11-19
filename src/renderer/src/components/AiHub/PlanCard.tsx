import { useState } from "react";
import { Check, Pencil, Play } from "lucide-react";
import type { AgentPlan, HubRequest, HubSnapshot } from "@shared/types/aiHub";
import { planPeopleLine } from "@shared/aiHubInbox";
import { HighlightedCode } from "./DiffViewer";

type Act = (request: HubRequest) => Promise<HubSnapshot | undefined>;

export interface PlanCardProps {
  taskId: string;
  plan?: AgentPlan;
  /** The agent is still working: the decision waits until it has stopped. */
  busy: boolean;
  act: Act;
  /** Optional callback invoked when the user saves an in-progress feedback draft locally. */
  onSaveDraft?: (note: string) => void;
}

// How the line under a plan starts: alone, your yes starts the agent. Where two people are needed, it does not.
const ONE_START = "Approving lets the agent carry the plan out";
const TWO_START = "The agent carries the plan out when you and a second person have both approved";

const RISK_CLASS: Record<AgentPlan["steps"][number]["risk"], string> = {
  low: "ai-badge ai-badge-success",
  medium: "ai-badge ai-badge-mode",
  high: "ai-badge ai-badge-danger",
};

/**
 * The plan an agent proposed, with its review, for the user to decide on.
 * Until it is approved the agent cannot change anything; once approved, the
 * commands it lists run without asking again (destructive ones still ask),
 * unless the plan or the person approving it says that each change asks.
 */
export function PlanCard({
  taskId,
  plan,
  busy,
  act,
  onSaveDraft,
}: PlanCardProps): JSX.Element | null {
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState(false);
  const [draftSaved, setDraftSaved] = useState(false);
  const [sending, setSending] = useState(false);
  /** Explicit per-step approval toggle; never silently flipped by writing feedback. */
  const [askChoice, setAskChoice] = useState<boolean | undefined>(undefined);

  if (!plan) return null;

  const waiting = plan.status === "proposed";
  const listed = plan.steps.filter((s) => s.command).length;
  const promised = plan.askEach === "plan";
  // Where a plan takes two people: who has approved, and whether this person's own answer is in.
  const people = planPeopleLine(plan);
  const gaveMine = waiting && Boolean(people) && (plan.approvals ?? []).some((a) => a.allowed && !a.peer);
  // Once this person has approved, what they chose about each command is written on the plan.
  const asksEach = waiting && !gaveMine ? promised || Boolean(askChoice) : Boolean(plan.askEach);

  const decide = (approved: boolean, overrideNote?: string): void => {
    const trimmed = (overrideNote ?? note).trim();
    setSending(true);
    void act({
      action: "plan-decide",
      taskId,
      approved,
      ...(trimmed ? { note: trimmed } : {}),
      ...(approved && askChoice !== undefined && !promised ? { askEach: askChoice } : {}),
    })
      .then(() => {
        if (!approved) {
          setEditing(false);
          setDraftSaved(false);
        }
      })
      .finally(() => setSending(false));
  };

  const handleSaveDraft = (): void => {
    setDraftSaved(true);
    onSaveDraft?.(note);
  };

  const body = (
    <>
      <ol className="ai-plan-steps">
        {plan.steps.map((step, index) => (
          <li
            key={index}
            data-testid={`plan-step-${index + 1}`}
            data-risk={step.risk}
            data-ran={step.ranAt ? "true" : undefined}
          >
            <div className="ai-plan-step-head">
              <span className="ai-plan-step-check" aria-hidden="true">
                {step.ranAt ? <Check size={12} /> : null}
              </span>
              <span className={RISK_CLASS[step.risk]}>{step.risk} risk</span>
              <span>{step.action}</span>
              {step.target && <small>· {step.target}</small>}
              {step.ranAt && <small>· ran</small>}
            </div>
            {step.command && <HighlightedCode code={`$ ${step.command}`} lang="bash" />}
            <small>Check: {step.check}</small>
            {step.rollback && <small>Undo: {step.rollback}</small>}
          </li>
        ))}
      </ol>

      {plan.assumptions && plan.assumptions.length > 0 && (
        <small>Not checked: {plan.assumptions.join("; ")}</small>
      )}
      {!waiting && plan.status === "approved" && listed > 0 && (
        <small data-testid="plan-covers">
          {plan.askEach
            ? "Approved with every changing command asking first, also the ones listed."
            : "Approved: the listed commands run without asking again; destructive ones still ask."}
        </small>
      )}
      {!waiting && people && <small data-testid="plan-people">{people}</small>}

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
        ? gaveMine
          ? "waiting for a second person"
          : "waiting for your decision"
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
  if (!waiting) {
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
  }

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
        {listed > 0 && (
          <label className="ai-plan-ask-each">
            <input
              type="checkbox"
              data-testid="plan-ask-each"
              checked={asksEach}
              disabled={sending || busy || promised || gaveMine}
              onChange={(e) => setAskChoice(e.target.checked)}
            />
            Ask me before each command that changes something
          </label>
        )}
        <small data-testid="plan-covers">
          {busy
            ? "The agent is still working; you can decide when it has stopped."
            : listed === 0
              ? `${people ? TWO_START : ONE_START}; commands that change something still ask.`
              : asksEach
                ? `${people ? TWO_START : ONE_START}. Every command that changes something asks you before it runs, also the ${listed} listed above${promised ? " (the plan says so)" : ""}.`
                : `${people ? TWO_START : ONE_START}. ${listed === 1 ? "The command listed above runs" : `The ${listed} commands listed above run`} without asking you again; anything else, and anything destructive, still asks.`}
        </small>
        {people && (
          <small data-testid="plan-people" role="status">
            {people}
          </small>
        )}

        <div className="ai-plan-actions">
          {!gaveMine && (
            <button
              type="button"
              className="ai-btn-emerald"
              data-testid="plan-approve-btn"
              disabled={sending || busy}
              onClick={() => decide(true)}
            >
              <Play size={13} aria-hidden="true" />
              {people ? "Approve" : <>Approve &amp; Execute</>}
            </button>
          )}
          <button
            type="button"
            data-testid="plan-edit-btn"
            aria-expanded={editing}
            disabled={sending || busy}
            onClick={() => setEditing((open) => !open)}
          >
            <Pencil size={13} aria-hidden="true" />
            Edit Plan
          </button>
          {draftSaved && !editing && (
            <span className="ai-badge" data-testid="plan-draft-badge">
              Draft saved
            </span>
          )}
        </div>

        {editing && (
          <div className="ai-plan-feedback" data-testid="plan-feedback-panel">
            <textarea
              rows={2}
              aria-label="Note to the agent"
              value={note}
              onChange={(e) => {
                setNote(e.target.value);
                if (draftSaved) setDraftSaved(false);
              }}
              placeholder="Describe what to change in this plan…"
              disabled={sending || busy}
            />
            <div className="ai-plan-actions">
              <button
                type="button"
                className="ai-btn-accent"
                data-testid="plan-reject-btn"
                disabled={sending || busy || !note.trim()}
                onClick={() => decide(false)}
              >
                Send Revision
              </button>
              <button
                type="button"
                data-testid="plan-save-draft-btn"
                disabled={sending || busy}
                onClick={handleSaveDraft}
              >
                Save Draft
              </button>
              <button
                type="button"
                className="ai-btn-danger"
                data-testid="plan-dismiss-btn"
                disabled={sending || busy}
                onClick={() => decide(false, "")}
              >
                Reject Plan
              </button>
              <button
                type="button"
                disabled={sending}
                onClick={() => setEditing(false)}
              >
                Cancel
              </button>
              {draftSaved && (
                <span className="ai-badge" role="status" data-testid="plan-draft-badge">
                  Draft saved
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
