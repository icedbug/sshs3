import type { AgentHypothesis } from "@shared/types/aiHub";

const LABEL: Record<AgentHypothesis["status"], string> = {
  open: "open",
  confirmed: "confirmed",
  "ruled-out": "ruled out",
};

/**
 * What the agent thinks might explain the problem, and what the evidence said
 * so far. A cause is only called found when its hypothesis is confirmed with
 * evidence, so this is where to look before trusting a conclusion.
 */
export function HypothesisTree({ hypotheses }: { hypotheses?: AgentHypothesis[] }): JSX.Element | null {
  if (!hypotheses || hypotheses.length === 0) return null;
  const confirmed = hypotheses.filter((h) => h.status === "confirmed");
  const open = hypotheses.filter((h) => h.status === "open").length;
  const ruledOut = hypotheses.filter((h) => h.status === "ruled-out").length;
  const roots = hypotheses.filter((h) => !h.parentId);
  const row = (h: AgentHypothesis, depth: number): JSX.Element => (
    <li key={h.id} data-status={h.status} style={{ marginLeft: depth * 18 }}>
      <div className="ai-hyp-line">
        <span className="ai-hyp-mark" aria-hidden />
        <span className="ai-hyp-text">{h.text}</span>
        <span className="ai-hyp-status">{LABEL[h.status]}</span>
      </div>
      {h.evidence.map((e, i) => (
        <small key={i} className={e.supports ? "ai-hyp-for" : "ai-hyp-against"}>
          {e.supports ? "for" : "against"}: {e.text}
        </small>
      ))}
      {hypotheses.some((c) => c.parentId === h.id) && (
        <ul>{hypotheses.filter((c) => c.parentId === h.id).map((c) => row(c, depth + 1))}</ul>
      )}
    </li>
  );
  return (
    <details className="ai-hyp" data-testid="hypothesis-tree" aria-label="The agent's hypotheses" open={hypotheses.length <= 5}>
      <summary>
        <span className="ai-todos-title">
          Hypotheses · {confirmed.length ? `${confirmed.length} confirmed` : "none confirmed"}
          {open ? ` · ${open} open` : ""}
          {ruledOut ? ` · ${ruledOut} ruled out` : ""}
        </span>
        {confirmed[0] && <span className="ai-todos-current">{confirmed.at(-1)!.text}</span>}
      </summary>
      <ul>{roots.map((h) => row(h, 0))}</ul>
    </details>
  );
}
