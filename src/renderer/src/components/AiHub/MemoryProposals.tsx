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
    ? "hela workspacet"
    : scope.startsWith("server:")
      ? `servern ${scope.slice("server:".length)}`
      : scope.startsWith("cluster:")
        ? `klustret ${scope.slice("cluster:".length)}`
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
          <strong>Förslag från assistenten ({proposals.length})</strong>
          <div style={{ marginTop: 2 }}>
            <small>
              Efter en avslutad session läser assistenten den en gång till och
              föreslår vad teamet bör minnas. Ett förslag används inte och
              delas inte förrän någon godkänner det.
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
          {busy ? "Läser…" : "Läs teamets senaste aktivitet"}
        </button>
      </div>

      {last && proposals.length === 0 && (
        <p className="ai-hint" data-testid="memory-distill-status">
          {last.error
            ? `Senaste läsningen (${last.sourceTitle}) misslyckades: ${last.error}`
            : `Senaste läsningen (${last.sourceTitle}) gav ${last.proposed === 0 ? "inget nytt att minnas" : `${last.proposed} förslag`}.`}
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
            ? "Uppdatera befintligt minne"
            : proposal.kind === "skill"
              ? "Ny skill"
              : "Nytt minne"}
        </span>
        <small>Gäller {scopeLabel(proposal.scope)}</small>
        <small style={{ opacity: 0.75 }}>· från {proposal.sourceTitle}</small>
      </div>
      <input
        aria-label="Titel"
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
          Ersätter: <span style={{ opacity: 0.8 }}>{proposal.previousText}</span>
        </small>
      )}
      <small>
        Underlag: <span style={{ opacity: 0.8 }}>{proposal.evidence}</span>
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
          Godkänn och dela med teamet
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            decide({ action: "memory-proposal-reject", id: proposal.id })
          }
        >
          Avvisa
        </button>
      </div>
    </section>
  );
}
