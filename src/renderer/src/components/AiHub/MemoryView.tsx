import { useState } from "react";
import { type HubSnapshot, type MemoryEntry } from "@shared/types/aiHub";
import { ConfirmButton } from "./ConfirmButton";
import { MemoryProposals } from "./MemoryProposals";
import { type Act } from "./panelShared";

type Show = "all" | "memory" | "skill" | "learned" | "personal";
type Tier = NonNullable<MemoryEntry["tier"]>;

interface Draft {
  id?: string;
  title: string;
  text: string;
  scope: string;
  kind: "memory" | "skill";
  tier: Tier;
}

/** Entries generated from the server list on every snapshot: shown under Infrastructure, not kept here. */
const generated = (m: MemoryEntry): boolean => m.id.startsWith("auto-node:") || m.id.startsWith("auto-cluster:");

const TIERS: Record<Tier, string> = {
  core: "Always considered first",
  archival: "Used when it is relevant",
  episodic: "A note about one incident",
};

function scopeLabel(scope: string, names: Map<string, string>): string {
  if (scope === "personal") return "only you";
  if (scope === "workspace" || scope === "workspace:all") return "team";
  const [kind, ...rest] = scope.split(":");
  const id = rest.join(":");
  if (kind === "target" && id === "local") return "this computer";
  return `${kind === "cluster" ? "cluster" : "server"} ${names.get(id) ?? id}`;
}

export function Memory({
  hub,
  act,
  suggestion,
}: {
  hub: HubSnapshot;
  act: Act;
  suggestion: string;
}): JSX.Element {
  const [draft, setDraft] = useState<Draft | undefined>(
    suggestion ? { title: "", text: suggestion, scope: "workspace", kind: "skill", tier: "core" } : undefined,
  );
  const [show, setShow] = useState<Show>("all");
  const [filter, setFilter] = useState("");
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const [reflecting, setReflecting] = useState(false);
  const [limit, setLimit] = useState(30);

  const names = new Map<string, string>();
  for (const i of hub.inventory) names.set(i.id, i.label);
  for (const s of hub.workspaceServers ?? []) names.set(s.id, s.name);
  const targets = Array.from(names.entries());

  const all = hub.memories.filter((m) => !generated(m));
  const serverCards = hub.memories.length - all.length;
  const is: Record<Show, (m: MemoryEntry) => boolean> = {
    all: () => true,
    memory: (m) => m.kind === "memory",
    skill: (m) => m.kind === "skill",
    learned: (m) => Boolean(m.autoLearned),
    personal: (m) => m.scope === "personal",
  };
  const q = filter.trim().toLowerCase();
  const shown = all
    .filter(is[show])
    .filter((m) => !q || m.title.toLowerCase().includes(q) || m.text.toLowerCase().includes(q));
  const chips: [Show, string][] = [
    ["all", "Everything"],
    ["memory", "Facts"],
    ["skill", "Skills"],
    ["learned", "Learned by the assistant"],
    ["personal", "Only yours"],
  ];

  return (
    <div className="ai-scroll">
      <header className="ai-view-head">
        <h2>Memory &amp; skills</h2>
        <p className="ai-hint">
          What the assistant knows about your systems before you say anything: facts about how things are set up, and
          skills — procedures that worked. Team entries are shared with everyone in the workspace.
        </p>
      </header>

      <MemoryProposals hub={hub} act={act} />

      <div className="ai-section-head">
        <h3>
          Entries <span className="ai-count">{all.length}</span>
        </h3>
        <div className="ai-tags">
          <span data-testid="self-learning-engine-card">
            <button
              type="button"
              disabled={reflecting}
              data-testid="run-self-reflection-btn"
              title="Merges entries that say the same thing and turns repeated incident notes into one entry"
              onClick={() => {
                setReflecting(true);
                void act({ action: "self-learn-reflect" }).finally(() => setReflecting(false));
              }}
            >
              {reflecting ? "Tidying…" : "Tidy up"}
            </button>
          </span>
          <button
            type="button"
            className="ai-btn-accent"
            onClick={() =>
              setDraft(draft ? undefined : { title: "", text: "", scope: "workspace", kind: "memory", tier: "archival" })
            }
          >
            {draft ? "Close" : "Add by hand"}
          </button>
        </div>
      </div>

      {draft && (
        <form
          className="ai-form ai-card"
          data-testid="memory-add-form"
          onSubmit={(e) => {
            e.preventDefault();
            void act({ action: "memory-save", entry: { ...draft, title: draft.title.trim() } }).then((next) => {
              if (next) setDraft(undefined);
            });
          }}
        >
          <strong>{draft.id ? "Edit entry" : "Add by hand"}</strong>
          <label>
            Title
            <input
              required
              autoFocus
              placeholder="Backups of the database cluster run from the replica"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </label>
          <label>
            {draft.kind === "skill" ? "When to use it, and the steps" : "What should be remembered"}
            <textarea
              required
              rows={7}
              placeholder={
                draft.kind === "skill"
                  ? "When the symptom is …\n1. Check …\n2. Run …"
                  : "Write it so it makes sense on its own, months from now."
              }
              value={draft.text}
              onChange={(e) => setDraft({ ...draft, text: e.target.value })}
            />
          </label>
          <div className="ai-form-row ai-form-row-3up">
            <label>
              Kind
              <select
                value={draft.kind}
                onChange={(e) => setDraft({ ...draft, kind: e.target.value as Draft["kind"] })}
              >
                <option value="memory">Fact</option>
                <option value="skill">Skill (a procedure)</option>
              </select>
            </label>
            <label>
              Who and where
              <select value={draft.scope} onChange={(e) => setDraft({ ...draft, scope: e.target.value })}>
                <option value="workspace">The team, everywhere</option>
                <option value="personal">Only me</option>
                {targets.map(([id, label]) => (
                  <option key={id} value={`target:${id}`}>
                    The team, only on {label}
                  </option>
                ))}
                {!targets.some(([id]) => `target:${id}` === draft.scope) &&
                  !["workspace", "personal"].includes(draft.scope) && (
                    <option value={draft.scope}>{scopeLabel(draft.scope, names)}</option>
                  )}
              </select>
            </label>
            <label>
              Weight
              <select value={draft.tier} onChange={(e) => setDraft({ ...draft, tier: e.target.value as Tier })}>
                {(Object.keys(TIERS) as Tier[]).map((t) => (
                  <option key={t} value={t}>
                    {TIERS[t]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="ai-hint">
            Never write passwords, keys or tokens here. An entry that closely resembles an existing one is merged into
            it.
          </p>
          <div className="ai-card-actions">
            <button type="submit" className="ai-btn-emerald">
              {draft.id ? "Save changes" : "Save"}
            </button>
            <button type="button" onClick={() => setDraft(undefined)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {all.length > 0 && (
        <div className="ai-filter-bar">
          <input
            type="search"
            aria-label="Filter entries"
            placeholder="Filter by title or text…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className="ai-tags">
            {chips
              .filter(([key]) => key === "all" || all.some(is[key]))
              .map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={`ai-chip ${show === key ? "ai-chip-on" : ""}`}
                  aria-pressed={show === key}
                  onClick={() => setShow(key)}
                >
                  {label} · {all.filter(is[key]).length}
                </button>
              ))}
          </div>
        </div>
      )}

      {all.length === 0 && !draft && (
        <p className="ai-empty">
          Nothing remembered yet. This fills up by itself as the assistant works and the team makes changes; you can
          also write down what you wish it knew.
        </p>
      )}
      {all.length > 0 && shown.length === 0 && <p className="ai-empty">Nothing matches.</p>}

      {shown.slice(0, limit).map((m) => {
        const long = m.text.length > 320 || m.text.split("\n").length > 5;
        const open = openIds.has(m.id);
        const score = m.feedbackScore ?? 0;
        return (
          <article className="ai-card" key={m.id} data-testid={`memory-${m.id}`}>
            <div className="ai-card-head">
              <div>
                <strong>{m.title}</strong>
                <small>
                  {m.kind === "skill" ? "Skill" : "Fact"} · {scopeLabel(m.scope, names)}
                  {m.author ? ` · ${m.author}` : ""} · {new Date(m.updatedAt).toLocaleDateString()}
                </small>
              </div>
              <div className="ai-tags">
                {m.autoLearned && (
                  <span className="ai-badge ai-badge-purple" title="Written by the assistant from what happened">
                    learned
                  </span>
                )}
                {(m.tier ?? (m.kind === "skill" ? "core" : "archival")) === "core" && (
                  <span className="ai-badge ai-badge-mode" title={TIERS.core}>
                    pinned
                  </span>
                )}
                {(m.successCount ?? 0) > 0 && (
                  <span className="ai-badge ai-badge-success" title="Times a run that used it ended verified">
                    worked ×{m.successCount}
                  </span>
                )}
              </div>
            </div>
            <p className={`ai-memory-text ${long && !open ? "ai-clamped" : ""}`}>{m.text}</p>
            <div className="ai-card-actions">
              {long && (
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => {
                    const next = new Set(openIds);
                    if (open) next.delete(m.id);
                    else next.add(m.id);
                    setOpenIds(next);
                  }}
                >
                  {open ? "Show less" : "Show all"}
                </button>
              )}
              <button
                type="button"
                title="It helped: rank it higher"
                data-testid={`memory-upvote-${m.id}`}
                onClick={() => void act({ action: "memory-feedback", id: m.id, delta: 1 })}
              >
                Useful{score > 0 ? ` · ${score}` : ""}
              </button>
              <button
                type="button"
                title="It was beside the point or wrong: rank it lower"
                data-testid={`memory-downvote-${m.id}`}
                onClick={() => void act({ action: "memory-feedback", id: m.id, delta: -1 })}
              >
                Not useful{score < 0 ? ` · ${-score}` : ""}
              </button>
              <button
                type="button"
                onClick={() =>
                  setDraft({
                    id: m.id,
                    title: m.title,
                    text: m.text,
                    scope: m.scope,
                    kind: m.kind,
                    tier: m.tier ?? (m.kind === "skill" ? "core" : "archival"),
                  })
                }
              >
                Edit
              </button>
              <span className="ai-spacer" />
              <ConfirmButton
                label="Forget"
                confirmLabel={m.scope === "personal" ? "Forget this?" : "Forget for the whole team?"}
                onConfirm={() => void act({ action: "memory-delete", id: m.id })}
              />
            </div>
          </article>
        );
      })}
      {shown.length > limit && (
        <button type="button" className="ai-more" onClick={() => setLimit(limit + 30)}>
          Show {Math.min(30, shown.length - limit)} more
        </button>
      )}
      {serverCards > 0 && (
        <p className="ai-hint ai-footnote">
          The assistant is also given a card for each of the {serverCards} servers in the workspace (name, role, tags
          and latest activity). Those are generated from the server list and shown under Infrastructure.
        </p>
      )}
    </div>
  );
}
