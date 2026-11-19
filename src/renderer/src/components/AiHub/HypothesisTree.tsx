import { Fragment, useMemo, useState } from "react";
import type { AgentHypothesis } from "@shared/types/aiHub";
import { encodeFileRefHref, tokenizeReportRefs, type FileRef } from "./reportRefs";
import { evidenceKey, supersededEvidence } from "@shared/incidentEvidence";
import { HypothesisSourceDetails } from "./HypothesisSourceDetails";
import { buildHypothesisTree, type HypothesisTreeNode } from "./workforceModel";

const LABEL: Record<AgentHypothesis["status"], string> = {
  open: "open",
  confirmed: "confirmed",
  "ruled-out": "ruled out",
};

const STATUS_BADGE: Record<AgentHypothesis["status"], string> = {
  open: "ai-badge ai-badge-mode ai-hyp-status",
  confirmed: "ai-badge ai-badge-success ai-hyp-status",
  "ruled-out": "ai-badge ai-hyp-status",
};

function deriveConfidence(h: AgentHypothesis): {
  level: "high" | "likely" | "mixed" | "weak" | "ruled-out" | "untested";
  label: string;
} {
  let forCount = 0;
  let againstCount = 0;
  const superseded = supersededEvidence(h.evidence);
  for (const e of h.evidence) {
    if (e.id && superseded.has(evidenceKey(e))) continue;
    if (e.supports) forCount += 1;
    else againstCount += 1;
  }
  if (h.status === "confirmed") {
    return {
      level: "high",
      label: forCount > 0 ? `high · ${forCount} for` : "high",
    };
  }
  if (h.status === "ruled-out") {
    return {
      level: "ruled-out",
      label: againstCount > 0 ? `0% · ${againstCount} against` : "ruled out",
    };
  }
  if (forCount > 0 && againstCount === 0) {
    return { level: "likely", label: `likely · ${forCount} for` };
  }
  if (forCount > 0 && againstCount > 0) {
    return { level: "mixed", label: `mixed · ${forCount} for / ${againstCount} against` };
  }
  if (againstCount > 0) {
    return { level: "weak", label: `weak · ${againstCount} against` };
  }
  return { level: "untested", label: "untested" };
}

function extractInlineCmdRefs(text: string): Set<string> {
  const found = new Set<string>();
  const re = /\[(c\d+(?:\s*,\s*c\d+)*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    for (const part of m[1].split(/\s*,\s*/)) {
      if (part) found.add(part);
    }
  }
  return found;
}

function EvidenceText({
  text,
  refs,
  onOpenRef,
  onOpenFileRef,
}: {
  text: string;
  refs?: ReadonlySet<string>;
  onOpenRef?: (ref: string) => void;
  onOpenFileRef?: (fileRef: FileRef) => void;
}): JSX.Element {
  const effectiveRefs = useMemo(() => {
    if (refs) return refs;
    if (onOpenRef) return extractInlineCmdRefs(text);
    return undefined;
  }, [refs, onOpenRef, text]);

  const segments = useMemo(() => tokenizeReportRefs(text, effectiveRefs), [text, effectiveRefs]);

  return (
    <>
      {segments.map((seg, idx) => {
        if (seg.kind === "cmd") {
          return (
            <button
              key={idx}
              type="button"
              className="ai-ref ai-hyp-ref"
              data-cmd-ref={seg.ref}
              title={`Show command ${seg.ref}`}
              onClick={() => onOpenRef?.(seg.ref)}
            >
              {seg.text}
            </button>
          );
        }
        if (seg.kind === "file") {
          return (
            <a
              key={idx}
              href={encodeFileRefHref(seg.fileRef)}
              className="ai-ref ai-hyp-file-ref"
              data-file-ref={seg.fileRef.raw}
              title={`Open ${seg.fileRef.raw}`}
              onClick={(ev) => {
                if (onOpenFileRef) {
                  ev.preventDefault();
                  onOpenFileRef(seg.fileRef);
                }
              }}
            >
              {seg.text}
            </a>
          );
        }
        return <Fragment key={idx}>{seg.text}</Fragment>;
      })}
    </>
  );
}

/**
 * What the agent thinks might explain the problem, and what the evidence said
 * so far. A cause is only called found when its hypothesis is confirmed with
 * evidence, so this is where to look before trusting a conclusion.
 */
export function HypothesisTree({
  hypotheses,
  refs,
  onOpenRef,
  onOpenFileRef,
}: {
  hypotheses?: AgentHypothesis[];
  refs?: ReadonlySet<string>;
  onOpenRef?: (ref: string) => void;
  onOpenFileRef?: (fileRef: FileRef) => void;
}): JSX.Element | null {
  const [hideRuledOut, setHideRuledOut] = useState(false);

  const list = useMemo(() => hypotheses ?? [], [hypotheses]);
  const tree = useMemo(() => buildHypothesisTree(list), [list]);

  if (list.length === 0) return null;

  const confirmed = list.filter((h) => h.status === "confirmed");
  const open = list.filter((h) => h.status === "open").length;
  const ruledOut = list.filter((h) => h.status === "ruled-out").length;

  const renderNode = (node: HypothesisTreeNode): JSX.Element | null => {
    const h = node.hypothesis;
    if (hideRuledOut && h.status === "ruled-out") {
      return null;
    }
    const confidence = deriveConfidence(h);
    const superseded = supersededEvidence(h.evidence);
    const visibleChildren = node.children.filter((c) => !(hideRuledOut && c.hypothesis.status === "ruled-out"));

    return (
      <li key={h.id} data-status={h.status} data-depth={node.depth} data-testid={`hyp-node-${h.id}`}>
        <div className="ai-hyp-line">
          <span className="ai-hyp-mark" aria-hidden />
          <span className="ai-hyp-text">{h.text}</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span
              className="ai-badge ai-hyp-confidence"
              data-confidence={confidence.level}
              title="Evidence confidence"
            >
              {confidence.label}
            </span>
            <span className={STATUS_BADGE[h.status]}>{LABEL[h.status]}</span>
          </span>
        </div>

        {h.evidence.map((e, i) => (
          <div
            key={e.id ? evidenceKey(e) : i}
            className={`ai-hyp-evidence ${e.supports ? "ai-hyp-for" : "ai-hyp-against"}`}
            data-evidence-kind={e.supports ? "for" : "against"}
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 6,
              margin: "3px 0 0 20px",
              fontSize: 11.5,
              lineHeight: 1.45,
            }}
          >
            <span
              className={e.supports ? "ai-badge ai-badge-success ai-hyp-for" : "ai-badge ai-badge-danger ai-hyp-against"}
              style={
                e.supports
                  ? undefined
                  : {
                      color: "var(--ai-danger, #f87171)",
                      borderColor: "rgba(248, 113, 113, 0.35)",
                      background: "rgba(248, 113, 113, 0.1)",
                    }
              }
            >
              {e.supports ? "for" : "against"}
            </span>
            <div>
              <EvidenceText text={e.text} refs={refs} onOpenRef={onOpenRef} onOpenFileRef={onOpenFileRef} />
              {e.at !== undefined && Number.isFinite(new Date(e.at).getTime()) && (
                <small className="ai-muted"> · <time dateTime={new Date(e.at).toISOString()}>{new Date(e.at).toLocaleString()}</time></small>
              )}
              {e.id && superseded.has(evidenceKey(e)) && <small className="ai-muted"> · Superseded</small>}
              {e.supersedes && <small className="ai-muted"> · Revises “{h.evidence.find(item => evidenceKey(item) === evidenceKey(e, e.supersedes))?.text ?? e.supersedes}”</small>}
              {e.source && <HypothesisSourceDetails key={e.source.callId + e.source.ref + e.source.digest} pointer={e.source} />}
            </div>
          </div>
        ))}

        {node.cycleTargets.map((cycle, idx) => (
          <div
            key={`cycle-${h.id}-${cycle.id}-${idx}`}
            className="ai-hyp-cycle ai-badge ai-badge-danger"
            data-testid="hypothesis-cycle"
            style={{ margin: "4px 0 0 20px", display: "inline-flex", gap: 6 }}
          >
            Cycle detected → {cycle.text} ({cycle.id})
          </div>
        ))}

        {visibleChildren.length > 0 && (
          <ul
            className="ai-hyp-branch"
            data-depth={node.depth + 1}
            style={{
              margin: "6px 0 0 12px",
              padding: "0 0 0 12px",
              borderLeft: "1px solid var(--ai-line, rgba(148, 163, 184, 0.25))",
            }}
          >
            {visibleChildren.map((child) => renderNode(child))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <details
      className="ai-hyp"
      data-testid="hypothesis-tree"
      aria-label="The agent's hypotheses"
      open={list.length <= 5 || tree.cycleCount > 0}
    >
      <summary>
        <span className="ai-todos-title">
          Hypotheses · {confirmed.length ? `${confirmed.length} confirmed` : "none confirmed"}
          {open ? ` · ${open} open` : ""}
          {ruledOut ? ` · ${ruledOut} ruled out` : ""}
          {tree.cycleCount > 0 ? ` · ${tree.cycleCount} cycle${tree.cycleCount === 1 ? "" : "s"} broken` : ""}
        </span>
        {confirmed[0] && <span className="ai-todos-current">{confirmed.at(-1)!.text}</span>}
        {ruledOut > 0 && (
          <button
            type="button"
            className="ai-chip"
            data-testid="hypothesis-toggle-ruled-out"
            style={{ marginLeft: "auto" }}
            onClick={(ev) => {
              ev.preventDefault();
              setHideRuledOut((v) => !v);
            }}
          >
            {hideRuledOut ? `Show ruled out (${ruledOut})` : "Hide ruled out"}
          </button>
        )}
      </summary>
      <ul>{tree.roots.map((root) => renderNode(root))}</ul>
    </details>
  );
}
