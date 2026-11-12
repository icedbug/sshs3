import { useState } from "react";
import {
  type HubSnapshot,
} from "@shared/types/aiHub";
import { MemoryProposals } from "./MemoryProposals";
import { type Act } from "./panelShared";

export function Memory({
  hub,
  act,
  suggestion,
}: {
  hub: HubSnapshot;
  act: Act;
  suggestion: string;
}): JSX.Element {
  const [id, setId] = useState<string>();
  const [title, setTitle] = useState("");
  const [text, setText] = useState(suggestion);
  const [scope, setScope] = useState("personal");
  const [kind, setKind] = useState<"memory" | "skill">(
    suggestion ? "skill" : "memory",
  );
  const [tier, setTier] = useState<"core" | "archival" | "episodic">("core");
  const [reflecting, setReflecting] = useState(false);
  const sl = hub.selfLearning;

  return (
    <div className="ai-scroll">
      <h2>Memory & skills</h2>
      <p className="ai-hint">
        What the team has chosen to remember about its infrastructure. Agents read these when they work; team-scoped entries are shared through the workspace sync. A note that closely resembles an existing one is merged into it.
      </p>

      <MemoryProposals hub={hub} act={act} />

      {sl && (
        <article className="ai-card" data-testid="self-learning-engine-card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <div>
              <strong>Learning from the terminal</strong>
              <div style={{ marginTop: 2 }}>
                <small>
                  Fixes are noted when a failed command is followed by one that works, and your feedback adjusts how memories are ranked.
                </small>
              </div>
            </div>
            <button
              type="button"
              className="ai-btn-emerald"
              disabled={reflecting}
              data-testid="run-self-reflection-btn"
              onClick={() => {
                setReflecting(true);
                void act({ action: "self-learn-reflect" }).finally(() =>
                  setReflecting(false),
                );
              }}
            >
              {reflecting
                ? "⏳ Reflekterar…"
                : "🧬 Consolidate memories"}
            </button>
          </div>

          <div className="ai-stat-grid" style={{ marginTop: 10 }}>
            <div className="ai-stat-box">
              <strong>{sl.totalLearnedSkills}</strong>
              <small>Skills ({sl.failureToFixPatterns} learned from a fix)</small>
            </div>
            <div className="ai-stat-box">
              <strong>{Math.round(sl.averageConfidence * 100)}%</strong>
              <small>Average confidence</small>
            </div>
            <div className="ai-stat-box">
              <strong>{sl.oramaIndexedChunks}</strong>
              <small>Indexed runbook sections</small>
            </div>
          </div>

          {sl.recentEvents.length > 0 && (
            <details style={{ marginTop: 10 }} open>
              <summary style={{ cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
                📈 Recent learning events ({sl.recentEvents.length})
              </summary>
              <div style={{ display: "grid", gap: 6, marginTop: 6 }}>
                {sl.recentEvents.slice(0, 5).map((ev) => (
                  <div
                    key={ev.id}
                    style={{
                      padding: "6px 8px",
                      borderRadius: 6,
                      background: "rgba(15, 23, 42, 0.55)",
                      fontSize: 12,
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
                      <strong>{ev.title}</strong>
                      <span className="ai-badge ai-badge-success">
                        🎯 {Math.round(ev.confidence * 100)}%
                      </span>
                    </div>
                    <small style={{ display: "block", opacity: 0.85 }}>{ev.summary}</small>
                  </div>
                ))}
              </div>
            </details>
          )}
        </article>
      )}

      {/* The list is what one comes for; adding by hand is the exception. */}
      <details className="ai-fold" data-testid="memory-add-form" open={Boolean(id || suggestion)}>
        <summary>{id ? "Edit this entry" : "Add a memory or a skill by hand"}</summary>
      <form
        className="ai-form"
        onSubmit={(e) => {
          e.preventDefault();
          void act({
            action: "memory-save",
            entry: { id, title, text, scope, kind, tier },
          }).then((result) => {
            if (result) {
              setId(undefined);
              setTitle("");
              setText("");
            }
          });
        }}
      >
        <label>
          Title
          <input
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label>
          Type
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            <option value="memory">Memory</option>
            <option value="skill">Skill</option>
          </select>
        </label>
        <label>
          Tier
          <select
            value={tier}
            onChange={(e) => setTier(e.target.value as typeof tier)}
          >
            <option value="core">📌 Core Memory (Always pinned in context)</option>
            <option value="archival">📚 Archival Memory (Hybrid RAG retrieved)</option>
            <option value="episodic">⚡ Episodic Incident Note</option>
          </select>
        </label>
        <label>
          Scope
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="workspace">Shared Workspace (Team Vault)</option>
            <option value="personal">Personal</option>
            {hub.inventory.map((i) => (
              <option key={i.id} value={`target:${i.id}`}>
                {i.label}
              </option>
            ))}
            <option value="target:local">Local machine</option>
          </select>
        </label>
        <label>
          Instructions / facts
          <textarea
            required
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <button>Save</button>
      </form>
      </details>
      {hub.memories.map((m) => (
        <article className="ai-card" key={m.id}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <div>
              <strong>{m.title}</strong>
              <small>
                {" "}
                · {m.kind} · {m.scope}
              </small>
            </div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {m.autoLearned && (
                <span className="ai-badge ai-badge-purple" title="Syntetiserad automatiskt av SelfLearningService">
                  🧬 Auto-Learned
                </span>
              )}
              <span
                className="ai-badge ai-badge-success"
                title={`Reinforcement Confidence · Successes: ${m.successCount ?? 0} · Feedback: ${m.feedbackScore ?? 0}`}
              >
                🎯 {Math.round((m.confidence ?? 0.78) * 100)}%
              </span>
              <span className="ai-badge ai-badge-mode">
                {m.tier === "archival"
                  ? "📚 Archival"
                  : m.tier === "episodic"
                    ? "⚡ Episodic"
                    : "📌 Core"}
              </span>
              {(m.updatedCount ?? 1) > 1 && (
                <span className="ai-badge ai-badge-success" title="How many times this memory was merged with a similar note">
                  🔄 merged ×{m.updatedCount}
                </span>
              )}
            </div>
          </div>
          <p>{m.text}</p>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <button
              type="button"
              title="Mark as useful: ranks this memory higher"
              data-testid={`memory-upvote-${m.id}`}
              onClick={() =>
                void act({ action: "memory-feedback", id: m.id, delta: 1 })
              }
            >
              👍 Bra ({m.feedbackScore ?? 0})
            </button>
            <button
              type="button"
              title="Nedprioritera detta minne/skill (-Confidence)"
              data-testid={`memory-downvote-${m.id}`}
              onClick={() =>
                void act({ action: "memory-feedback", id: m.id, delta: -1 })
              }
            >
              👎 Mindre relevant
            </button>
            <button
              onClick={() => {
                setId(m.id);
                setTitle(m.title);
                setText(m.text);
                setScope(m.scope);
                setKind(m.kind);
                setTier(m.tier ?? "core");
              }}
            >
              Edit
            </button>
            <button
              onClick={() => void act({ action: "memory-delete", id: m.id })}
            >
              Delete
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}
