import { useState } from "react";
import {
  parseMemoryScope,
  type HubRequest,
  type HubSnapshot,
  type MemoryProposal,
} from "@shared/types/aiHub";
import { DiffViewer } from "./DiffViewer";

/** The panel's request helper: it reports a failed request in the panel itself and resolves with nothing. */
type Act = (request: HubRequest) => Promise<HubSnapshot | undefined>;

export type ProposalRiskLevel = "safe" | "medium" | "high";

export type MemoryProposalView = MemoryProposal & {
  sourceTaskId?: string;
  evidenceCount?: number;
  risk?: ProposalRiskLevel | "low" | "critical" | "destructive";
  previousValue?: string;
  proposedValue?: string;
};

const HIGH_RISK_RE =
  /\b(rm\s+-rf|mkfs|dd\s+if=|drop\s+(table|database)|chmod\s+777|kill\s+-9|shutdown|reboot|format-volume|clear-disk)\b|--force\b/i;

/** Classifies a proposal's operational risk for batch-approval and badge display. */
export function assessProposalRisk(proposal: MemoryProposalView): ProposalRiskLevel {
  if (proposal.risk === "critical" || proposal.risk === "destructive" || proposal.risk === "high") {
    return "high";
  }
  if (proposal.risk === "medium") return "medium";
  if (proposal.risk === "safe" || proposal.risk === "low") return "safe";

  const content = `${proposal.title}\n${proposal.proposedValue ?? proposal.text}`;
  if (HIGH_RISK_RE.test(content)) return "high";
  if (proposal.op === "update" || proposal.kind === "skill") return "medium";
  return "safe";
}

/** True when a proposal is safe for one-click batch approval. */
export function isProposalSafe(proposal: MemoryProposalView): boolean {
  return assessProposalRisk(proposal) === "safe";
}

function deriveSourceTaskId(proposal: MemoryProposalView): string | undefined {
  if (proposal.sourceTaskId?.trim()) return proposal.sourceTaskId.trim();
  if (proposal.sourceId.startsWith("task:")) {
    const id = proposal.sourceId.slice("task:".length).trim();
    return id || undefined;
  }
  return undefined;
}

function deriveEvidenceCount(proposal: MemoryProposalView): number {
  if (typeof proposal.evidenceCount === "number" && Number.isFinite(proposal.evidenceCount)) {
    return Math.max(0, proposal.evidenceCount);
  }
  const raw = proposal.evidence?.trim();
  if (!raw) return 0;
  return raw
    .split(/[;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean).length;
}

const scopeLabel = (scope: string): string => {
  const trimmed = scope.trim();
  if (trimmed === "workspace" || trimmed === "workspace:all") return "the whole workspace";
  if (trimmed.toLowerCase().startsWith("host:")) return `host ${trimmed.slice(5).trim()}`;
  const parsed = parseMemoryScope(trimmed);
  switch (parsed.kind) {
    case "server":
      return `server ${parsed.value ?? ""}`;
    case "cluster":
      return `cluster ${parsed.value ?? ""}`;
    case "target":
      return `target ${parsed.value ?? ""}`;
    case "tag":
      return `tag ${parsed.value ?? ""}`;
    case "env":
      return `env ${parsed.value ?? ""}`;
    case "personal":
      return "personal";
    default:
      return trimmed;
  }
};

/**
 * Memories the assistant suggests after reading a finished session or the
 * team's recent activity. Nothing here is used by agents or shared with the
 * team until it is accepted; the text can be corrected first.
 */
export function MemoryProposals({
  hub,
  act,
}: {
  hub: HubSnapshot;
  act: Act;
}): JSX.Element {
  const proposals = (hub.memoryProposals ?? []) as MemoryProposalView[];
  const autoSave = hub.preferences?.autoSaveMemories !== false;
  const last = hub.lastMemoryDistill;
  const [reading, setReading] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const busy = reading || hub.memoryDistillRunning === true;

  const pending = proposals.filter((p) => !p.appliedMemoryId);
  const safePending = pending.filter((p) => {
    const proposedText = (p.proposedValue ?? p.text).trim();
    return isProposalSafe(p) && Boolean(p.title.trim()) && Boolean(proposedText);
  });

  const readActivity = (): void => {
    setReading(true);
    void act({ action: "memory-distill-activity" }).finally(() =>
      setReading(false),
    );
  };

  const approveSafeBatch = async (): Promise<void> => {
    if (safePending.length === 0 || batchBusy) return;
    setBatchBusy(true);
    try {
      for (const p of safePending) {
        await act({
          action: "memory-proposal-accept",
          id: p.id,
          title: p.title.trim(),
          text: (p.proposedValue ?? p.text).trim(),
        });
      }
    } finally {
      setBatchBusy(false);
    }
  };

  const rejectAllPending = async (): Promise<void> => {
    if (pending.length === 0 || batchBusy) return;
    setBatchBusy(true);
    try {
      for (const p of pending) {
        await act({ action: "memory-proposal-reject", id: p.id });
      }
    } finally {
      setBatchBusy(false);
    }
  };

  return (
    <article className="ai-card" data-testid="memory-proposals-card">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <div>
          <strong>
            {autoSave ? "Learned by the assistant" : "Suggested by the assistant"} (
            {proposals.length})
          </strong>
          <div style={{ marginTop: 2 }}>
            <small>
              {autoSave
                ? "After a finished session, and from your own activity, the assistant saves what the team should remember and shares it at once. What would replace something a person wrote, or comes only from the assistant's own answer, waits here until somebody accepts it. Undo anything that is wrong."
                : "After a finished session the assistant suggests what the team should remember. A suggestion is not used and not shared until somebody accepts it."}
            </small>
          </div>
          <label
            style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 4 }}
          >
            <input
              type="checkbox"
              data-testid="memory-autosave-toggle"
              checked={autoSave}
              onChange={(e) =>
                void act({
                  action: "configure",
                  config: {},
                  preferences: { autoSaveMemories: e.target.checked },
                })
              }
            />
            <small>Save and share what the assistant learns automatically</small>
          </label>
        </div>
        <button
          type="button"
          className="ai-btn-accent"
          data-testid="memory-distill-activity-btn"
          disabled={busy}
          onClick={readActivity}
        >
          {busy ? "Reading…" : "Read the team's recent activity"}
        </button>
      </div>

      {pending.length > 0 && (
        <div
          className="ai-card-actions"
          data-testid="memory-proposals-batch"
          style={{ marginTop: 8 }}
        >
          <button
            type="button"
            className="ai-btn-emerald"
            data-testid="memory-approve-safe-btn"
            disabled={batchBusy || safePending.length === 0}
            onClick={() => void approveSafeBatch()}
          >
            Approve safe ({safePending.length})
          </button>
          <button
            type="button"
            data-testid="memory-reject-all-btn"
            disabled={batchBusy}
            onClick={() => void rejectAllPending()}
          >
            Reject all ({pending.length})
          </button>
        </div>
      )}

      {last && proposals.length === 0 && (
        <p className="ai-hint" data-testid="memory-distill-status">
          {last.error
            ? `The latest reading (${last.sourceTitle}) failed: ${last.error}`
            : `The latest reading (${last.sourceTitle}) found ${last.proposed === 0 ? "nothing new to remember" : `${last.proposed} suggestion(s)`}.`}
        </p>
      )}

      {last?.pagesError && (
        <p className="ai-hint" data-testid="memory-distill-pages-error">
          {`What the latest reading (${last.sourceTitle}) established was not added to the knowledge base pages: ${last.pagesError}`}
        </p>
      )}

      {proposals.map((proposal) => (
        <ProposalRow key={proposal.id} proposal={proposal} act={act} batchBusy={batchBusy} />
      ))}
    </article>
  );
}

function ProposalRow({
  proposal,
  act,
  batchBusy,
}: {
  proposal: MemoryProposalView;
  act: Act;
  batchBusy: boolean;
}): JSX.Element {
  const initialProposed = proposal.proposedValue ?? proposal.text;
  const previousValue = proposal.previousValue ?? proposal.previousText;
  const [text, setText] = useState(initialProposed);
  const [title, setTitle] = useState(proposal.title);
  const [busy, setBusy] = useState(false);
  // Already saved by the assistant: a record of what was learned, which can be undone.
  const applied = Boolean(proposal.appliedMemoryId);
  const risk = assessProposalRisk(proposal);
  const sourceTaskId = deriveSourceTaskId(proposal);
  const evidenceCount = deriveEvidenceCount(proposal);
  const disabled = busy || batchBusy;

  const decide = (request: HubRequest): void => {
    setBusy(true);
    void act(request).finally(() => setBusy(false));
  };

  return (
    <section
      data-testid={`memory-proposal-${proposal.id}`}
      style={{
        marginTop: 10,
        padding: "8px 10px",
        borderRadius: 8,
        border: "1px solid rgba(56, 189, 248, 0.25)",
        background: "rgba(15, 23, 42, 0.55)",
        display: "grid",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <span className="ai-badge">
          {applied
            ? proposal.op === "update"
              ? "Updated a memory"
              : proposal.kind === "skill"
                ? "Learned a skill"
                : "Learned a memory"
            : proposal.op === "update"
              ? "Update an existing memory"
              : proposal.kind === "skill"
                ? "New skill"
                : "New memory"}
        </span>
        <span
          className={`ai-badge ${
            risk === "high"
              ? "ai-badge-danger"
              : risk === "medium"
                ? "ai-badge-mode"
                : "ai-badge-success"
          }`}
          data-testid={`memory-proposal-risk-${proposal.id}`}
        >
          risk: {risk}
        </span>
        <small>Applies to {scopeLabel(proposal.scope)}</small>
        <small style={{ opacity: 0.75 }}>· from {proposal.sourceTitle}</small>
      </div>
      <div
        className="ai-tags"
        data-testid={`memory-proposal-provenance-${proposal.id}`}
      >
        {sourceTaskId && (
          <span className="ai-badge">task:{sourceTaskId}</span>
        )}
        <span className="ai-badge">
          {evidenceCount} evidence
        </span>
        <small className="ai-muted">
          {new Date(proposal.createdAt).toLocaleString()}
        </small>
      </div>
      <input
        aria-label="Title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        disabled={disabled || applied}
      />
      <textarea
        aria-label="Text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        disabled={disabled || applied}
      />
      <div data-testid={`memory-proposal-diff-${proposal.id}`}>
        {previousValue !== undefined && (
          <small data-testid="memory-proposal-previous">
            {applied ? "Replaced" : "Replaces"}:{" "}
            <span className="sr-only">{previousValue}</span>
          </small>
        )}
        <DiffViewer
          before={previousValue ?? ""}
          after={text}
          filePath={title || proposal.title}
          defaultMode="unified"
        />
      </div>
      <small>
        Evidence: <span style={{ opacity: 0.8 }}>{proposal.evidence}</span>
      </small>
      {applied ? (
        <div style={{ display: "flex", gap: 6 }}>
          <button
            type="button"
            disabled={disabled}
            onClick={() =>
              decide({ action: "memory-proposal-undo", id: proposal.id })
            }
          >
            Undo
          </button>
          <button
            type="button"
            disabled={disabled}
            title="Keep the memory and remove this entry from the list"
            onClick={() =>
              decide({ action: "memory-proposal-reject", id: proposal.id })
            }
          >
            Keep
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 6 }}>
          <button
            type="button"
            className="ai-btn-emerald"
            disabled={disabled || !text.trim() || !title.trim()}
            onClick={() =>
              decide({
                action: "memory-proposal-accept",
                id: proposal.id,
                title: title.trim(),
                text: text.trim(),
              })
            }
          >
            Accept and share with the team
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() =>
              decide({ action: "memory-proposal-reject", id: proposal.id })
            }
          >
            Reject
          </button>
        </div>
      )}
    </section>
  );
}
