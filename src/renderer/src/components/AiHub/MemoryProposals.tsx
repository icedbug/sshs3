import { useState } from "react";
import type {
  HubRequest,
  HubSnapshot,
  MemoryProposal,
} from "@shared/types/aiHub";

/** The panel's request helper: it reports a failed request in the panel itself and resolves with nothing. */
type Act = (request: HubRequest) => Promise<HubSnapshot | undefined>;

const scopeLabel = (scope: string): string =>
  scope === "workspace"
    ? "the whole workspace"
    : scope.startsWith("server:")
      ? `server ${scope.slice("server:".length)}`
      : scope.startsWith("cluster:")
        ? `cluster ${scope.slice("cluster:".length)}`
        : scope;

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
  const proposals = hub.memoryProposals ?? [];
  const last = hub.lastMemoryDistill;
  const [reading, setReading] = useState(false);
  const busy = reading || hub.memoryDistillRunning === true;

  const readActivity = (): void => {
    setReading(true);
    void act({ action: "memory-distill-activity" }).finally(() =>
      setReading(false),
    );
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
          <strong>Suggested by the assistant ({proposals.length})</strong>
          <div style={{ marginTop: 2 }}>
            <small>
              After a finished session the assistant reads it once more and
              suggests what the team should remember. A suggestion is not used
              and not shared until somebody accepts it.
            </small>
          </div>
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

      {last && proposals.length === 0 && (
        <p className="ai-hint" data-testid="memory-distill-status">
          {last.error
            ? `The latest reading (${last.sourceTitle}) failed: ${last.error}`
            : `The latest reading (${last.sourceTitle}) found ${last.proposed === 0 ? "nothing new to remember" : `${last.proposed} suggestion(s)`}.`}
        </p>
      )}

      {proposals.map((proposal) => (
        <ProposalRow key={proposal.id} proposal={proposal} act={act} />
      ))}
    </article>
  );
}

function ProposalRow({
  proposal,
  act,
}: {
  proposal: MemoryProposal;
  act: Act;
}): JSX.Element {
  const [text, setText] = useState(proposal.text);
  const [title, setTitle] = useState(proposal.title);
  const [busy, setBusy] = useState(false);

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
          {proposal.op === "update"
            ? "Update an existing memory"
            : proposal.kind === "skill"
              ? "New skill"
              : "New memory"}
        </span>
        <small>Applies to {scopeLabel(proposal.scope)}</small>
        <small style={{ opacity: 0.75 }}>· from {proposal.sourceTitle}</small>
      </div>
      <input
        aria-label="Title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        disabled={busy}
      />
      <textarea
        aria-label="Text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        disabled={busy}
      />
      {proposal.previousText && (
        <small data-testid="memory-proposal-previous">
          Replaces: <span style={{ opacity: 0.8 }}>{proposal.previousText}</span>
        </small>
      )}
      <small>
        Evidence: <span style={{ opacity: 0.8 }}>{proposal.evidence}</span>
      </small>
      <div style={{ display: "flex", gap: 6 }}>
        <button
          type="button"
          className="ai-btn-emerald"
          disabled={busy || !text.trim() || !title.trim()}
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
          disabled={busy}
          onClick={() =>
            decide({ action: "memory-proposal-reject", id: proposal.id })
          }
        >
          Reject
        </button>
      </div>
    </section>
  );
}
