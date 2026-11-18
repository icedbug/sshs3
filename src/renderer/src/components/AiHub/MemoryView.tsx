import { useState } from "react";
import {
  formatMemoryScope,
  parseMemoryScope,
  type HubRequest,
  type HubSnapshot,
  type MemoryEntry,
} from "@shared/types/aiHub";
import { ConfirmButton } from "./ConfirmButton";
import { MemoryProposals } from "./MemoryProposals";
import { type Act } from "./panelShared";

type Show = "all" | "memory" | "skill" | "learned" | "personal" | "needs-check";
export type ScopeFilterCategory = "all" | "global" | "host" | "cluster" | "tag" | "env" | "personal";
type Tier = NonNullable<MemoryEntry["tier"]>;

export type MemoryEntryView = MemoryEntry & {
  sourceTaskId?: string;
  agentName?: string;
  agentId?: string;
};

interface Draft {
  id?: string;
  title: string;
  text: string;
  scope: string;
  kind: "memory" | "skill";
  tier: Tier;
}

export const MEMORY_VERIFY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export const MEMORY_SCOPE_CATEGORIES: ReadonlyArray<{ id: ScopeFilterCategory; label: string }> = [
  { id: "all", label: "All scopes" },
  { id: "global", label: "global" },
  { id: "host", label: "host:" },
  { id: "cluster", label: "cluster:" },
  { id: "tag", label: "tag:" },
  { id: "env", label: "env:" },
  { id: "personal", label: "personal" },
];

/** Entries generated from the server list on every snapshot: shown under Infrastructure, not kept here. */
const generated = (m: MemoryEntry): boolean => m.id.startsWith("auto-node:") || m.id.startsWith("auto-cluster:");

const TIERS: Record<Tier, string> = {
  core: "Always considered first",
  archival: "Used when it is relevant",
  episodic: "A note about one incident",
};

/**
 * Text that reads like an instruction about approvals. Approvals are enforced
 * in code whatever a memory says; the badge tells the reader so.
 */
export const MEMORY_RULE_LIKE =
  /\b(skip|bypass|without|no)\b.{0,30}\b(approval|confirm|review)|always approve|disable.{0,20}safety/i;

/** Checks whether a memory/skill needs verification due to `staleReason`, expiry, or old verification age. */
export function isMemoryStale(
  entry: MemoryEntry,
  now = Date.now(),
): { stale: boolean; reason?: string } {
  if (entry.staleReason?.trim()) {
    return { stale: true, reason: entry.staleReason.trim() };
  }
  if (entry.validUntil !== undefined && entry.validUntil <= now) {
    return { stale: true, reason: "Verification window expired" };
  }
  if (entry.lastVerifiedAt !== undefined && now - entry.lastVerifiedAt > MEMORY_VERIFY_MAX_AGE_MS) {
    return { stale: true, reason: "Last verified over 30 days ago" };
  }
  return { stale: false };
}

/** Normalizes and formats a `MemoryScope` string using `parseMemoryScope` and `formatMemoryScope`. */
export function describeMemoryScope(
  scope: string,
  names: Map<string, string> = new Map(),
): {
  category: Exclude<ScopeFilterCategory, "all">;
  badgeText: string;
  label: string;
  canonicalScope: string;
  value?: string;
} {
  const trimmed = scope.trim();
  const parsed = parseMemoryScope(trimmed);

  // Accept explicit `host:<name>` prefix as host scope alongside `server:` / `target:`.
  if (parsed.kind === "unknown" && trimmed.toLowerCase().startsWith("host:")) {
    const val = trimmed.slice(5).trim();
    const display = names.get(val) ?? val;
    return {
      category: "host",
      badgeText: `host:${display}`,
      label: `host ${display}`,
      canonicalScope: val ? formatMemoryScope("server", val) : trimmed,
      value: val,
    };
  }

  switch (parsed.kind) {
    case "workspace":
    case "workspace:all":
      return {
        category: "global",
        badgeText: "global",
        label: "team",
        canonicalScope: parsed.kind,
      };
    case "personal":
      return {
        category: "personal",
        badgeText: "personal",
        label: "only you",
        canonicalScope: "personal",
      };
    case "server":
    case "target": {
      const val = parsed.value ?? "";
      if (parsed.kind === "target" && val === "local") {
        return {
          category: "host",
          badgeText: "host:local",
          label: "this computer",
          canonicalScope: formatMemoryScope("target", "local"),
          value: "local",
        };
      }
      const display = names.get(val) ?? val;
      return {
        category: "host",
        badgeText: `host:${display}`,
        label: `server ${display}`,
        canonicalScope: formatMemoryScope(parsed.kind, val),
        value: val,
      };
    }
    case "cluster": {
      const val = parsed.value ?? "";
      return {
        category: "cluster",
        badgeText: `cluster:${val}`,
        label: `cluster ${val}`,
        canonicalScope: formatMemoryScope("cluster", val),
        value: val,
      };
    }
    case "tag": {
      const val = parsed.value ?? "";
      return {
        category: "tag",
        badgeText: `tag:${val}`,
        label: `tag ${val}`,
        canonicalScope: formatMemoryScope("tag", val),
        value: val,
      };
    }
    case "env": {
      const val = parsed.value ?? "";
      return {
        category: "env",
        badgeText: `env:${val}`,
        label: `env ${val}`,
        canonicalScope: formatMemoryScope("env", val),
        value: val,
      };
    }
    default:
      return {
        category: "global",
        badgeText: trimmed || "global",
        label: trimmed || "team",
        canonicalScope: trimmed || "workspace",
      };
  }
}

function scopeBadgeClass(category: Exclude<ScopeFilterCategory, "all">): string {
  switch (category) {
    case "cluster":
      return "ai-badge ai-badge-cluster";
    case "env":
      return "ai-badge ai-badge-mode";
    case "tag":
      return "ai-badge ai-badge-purple";
    case "host":
      return "ai-badge ai-badge-success";
    default:
      return "ai-badge";
  }
}

export function Memory({
  hub,
  act,
  request,
  suggestion,
  onOpenTask,
}: {
  hub: HubSnapshot;
  act: Act;
  request?: (request: HubRequest) => Promise<HubSnapshot>;
  suggestion: string;
  onOpenTask?: (taskId: string) => void;
}): JSX.Element {
  const [draft, setDraft] = useState<Draft | undefined>(
    suggestion ? { title: "", text: suggestion, scope: "workspace", kind: "skill", tier: "core" } : undefined,
  );
  const [customScopeKind, setCustomScopeKind] = useState<"server" | "cluster" | "tag" | "env">("tag");
  const [customScopeValue, setCustomScopeValue] = useState("");
  const [show, setShow] = useState<Show>("all");
  const [scopeCategory, setScopeCategory] = useState<ScopeFilterCategory>("all");
  const [scopeExact, setScopeExact] = useState<string>("");
  const [filter, setFilter] = useState("");
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const [inlineEditId, setInlineEditId] = useState<string | null>(null);
  const [inlineTitle, setInlineTitle] = useState("");
  const [inlineText, setInlineText] = useState("");
  const [reflecting, setReflecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState("");
  const [hiddenNote, setHiddenNote] = useState("");
  const [limit, setLimit] = useState(30);
  // Forget has no undo on the backend, so the forgotten entry is kept here to save it again.
  const [forgotten, setForgotten] = useState<MemoryEntry | undefined>();
  const [undoing, setUndoing] = useState(false);

  const forget = async (m: MemoryEntry): Promise<void> => {
    const next = await act({ action: "memory-delete", id: m.id });
    if (next) setForgotten(m);
  };

  const undoForget = async (): Promise<void> => {
    if (!forgotten || undoing) return;
    setUndoing(true);
    try {
      // Saved as a new entry: the backend refuses to write back under the id of a removed team memory.
      const next = await act({
        action: "memory-save",
        entry: {
          kind: forgotten.kind,
          scope: forgotten.scope,
          title: forgotten.title,
          text: forgotten.text,
          tier: forgotten.tier,
          cluster: forgotten.cluster,
          author: forgotten.author,
          sourceCommand: forgotten.sourceCommand,
          confidence: forgotten.confidence,
        },
      });
      if (next) setForgotten(undefined);
    } finally {
      setUndoing(false);
    }
  };

  const missingEntry = Boolean(draft?.id && !hub.memories.some((m) => m.id === draft.id));

  // A password or key in the text is masked before it is kept: said, so nobody wonders what was stored.
  const noteHidden = (next: HubSnapshot | undefined): void => {
    if (!draft || /\[redacted\]/.test(`${draft.title} ${draft.text}`)) return setHiddenNote("");
    const title = draft.title.trim();
    const kept = next?.memories.find((m) => (draft.id ? m.id === draft.id : m.title === title));
    setHiddenNote(kept && /\[redacted\]/.test(`${kept.title} ${kept.text}`) ? `A password, key or token in "${title}" was hidden before it was saved. Only "[redacted]" is kept.` : "");
  };

  const saveDraft = async (asNew = false): Promise<void> => {
    if (!draft || saving) return;
    setSaveError("");
    setSaving(true);
    const entry = {
      ...draft,
      id: asNew ? undefined : draft.id,
      title: draft.title.trim(),
    };
    try {
      if (request) {
        noteHidden(await request({ action: "memory-save", entry }));
        setDraft(undefined);
      } else {
        const next = await act({ action: "memory-save", entry });
        if (next) {
          noteHidden(next);
          setDraft(undefined);
        } else setSaveError("Could not save this entry.");
      }
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const mutateEntry = async (m: MemoryEntry, patch: Partial<MemoryEntry>): Promise<void> => {
    setBusyId(m.id);
    try {
      await act({
        action: "memory-save",
        entry: {
          ...m,
          ...patch,
          id: m.id,
        },
      });
    } finally {
      setBusyId(null);
    }
  };

  const names = new Map<string, string>();
  for (const i of hub.inventory) names.set(i.id, i.label);
  for (const s of hub.workspaceServers ?? []) names.set(s.id, s.name);
  const targets = Array.from(names.entries());

  const listed = hub.memories.filter((m) => !generated(m));
  const serverCards = hub.memories.length - listed.length;
  // What a newer memory replaced is not an entry of its own: it is shown, greyed, under the newer one.
  const all = listed.filter((m) => !m.supersededBy);
  const replacedBy = new Map<string, MemoryEntry[]>();
  for (const m of listed)
    if (m.supersededBy) replacedBy.set(m.supersededBy, [...(replacedBy.get(m.supersededBy) ?? []), m]);
  const historyOf = (id: string): MemoryEntry[] => {
    const out: MemoryEntry[] = [];
    const seen = new Set<string>([id]);
    for (let next = replacedBy.get(id) ?? []; next.length > 0; ) {
      const older: MemoryEntry[] = [];
      for (const h of next) {
        if (seen.has(h.id)) continue;
        seen.add(h.id);
        out.push(h);
        older.push(...(replacedBy.get(h.id) ?? []));
      }
      next = older;
    }
    return out;
  };
  const is: Record<Show, (m: MemoryEntry) => boolean> = {
    all: () => true,
    memory: (m) => m.kind === "memory",
    skill: (m) => m.kind === "skill",
    learned: (m) => Boolean(m.autoLearned),
    personal: (m) => m.scope === "personal",
    "needs-check": (m) => isMemoryStale(m).stale,
  };
  const q = filter.trim().toLowerCase();
  const shown = all
    .filter(is[show])
    .filter((m) => {
      const desc = describeMemoryScope(m.scope, names);
      if (scopeCategory !== "all" && desc.category !== scopeCategory) return false;
      if (scopeExact && desc.badgeText !== scopeExact) return false;
      return true;
    })
    .filter((m) => {
      if (!q) return true;
      const desc = describeMemoryScope(m.scope, names);
      return (
        m.title.toLowerCase().includes(q) ||
        m.text.toLowerCase().includes(q) ||
        desc.badgeText.toLowerCase().includes(q)
      );
    });
  const chips: [Show, string][] = [
    ["all", "Everything"],
    ["memory", "Facts"],
    ["skill", "Skills"],
    ["learned", "Learned by the assistant"],
    ["personal", "Only yours"],
    ["needs-check", "Needs Check"],
  ];

  const isPresetScope = (scope: string): boolean =>
    scope === "workspace" || scope === "personal" || targets.some(([id]) => `target:${id}` === scope);

  return (
    <div className="ai-scroll">
      <header className="ai-view-head">
        <h2>Memory &amp; skills</h2>
        <p className="ai-hint">
          What the assistant knows about your systems before you say anything: facts about how things are set up, and
          skills — procedures that worked. Team entries are shared with everyone in the workspace.
        </p>
        <p className="ai-hint" data-testid="memory-legend">
          <strong>pinned</strong>: always read first. <strong>global</strong>: for the team, on every server.{" "}
          <strong>Useful</strong> and <strong>Not useful</strong> rank an entry higher or lower when the assistant
          chooses what to read. <strong>Tidy up</strong> looks for entries that say the same thing and for finished
          runs not written down yet: what it finds is listed above the entries for you to accept or reject.
        </p>
      </header>

      <MemoryProposals hub={hub} act={act} />
      {hiddenNote && (
        <p className="ai-hint" role="status" data-testid="memory-hidden-note">
          {hiddenNote}
        </p>
      )}

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
              title="Merges entries that say the same thing, turns repeated incident notes into one entry, writes down the steps of finished runs not looked at yet, notes a read-only check for open failures, and adds links it finds between servers. What it writes is shared with the team."
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
            onClick={() => {
              setSaveError("");
              setDraft(draft ? undefined : { title: "", text: "", scope: "workspace", kind: "memory", tier: "archival" });
            }}
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
            void saveDraft(missingEntry);
          }}
        >
          <strong>{draft.id ? "Edit entry" : "Add by hand"}</strong>
          {(saveError || missingEntry) && (
            <p className="ai-error" role="alert" data-testid="memory-form-error">
              {saveError ||
                "This entry was removed while you were editing it. Save it as a new entry to keep your text, or cancel."}
            </p>
          )}
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
                <option value="workspace">The team, everywhere (global)</option>
                <option value="personal">Only me</option>
                {targets.map(([id, label]) => (
                  <option key={id} value={`target:${id}`}>
                    The team, only on {label}
                  </option>
                ))}
                {!isPresetScope(draft.scope) && (
                  <option value={draft.scope}>{describeMemoryScope(draft.scope, names).badgeText}</option>
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
          <div className="ai-inline-form" data-testid="memory-scope-builder">
            <select
              aria-label="Scoped prefix"
              value={customScopeKind}
              onChange={(e) => setCustomScopeKind(e.target.value as "server" | "cluster" | "tag" | "env")}
            >
              <option value="tag">tag:</option>
              <option value="env">env:</option>
              <option value="cluster">cluster:</option>
              <option value="server">host:</option>
            </select>
            <input
              aria-label="Scope value"
              placeholder="prod, postgres, k8s-eu, web-01…"
              value={customScopeValue}
              onChange={(e) => setCustomScopeValue(e.target.value)}
            />
            <button
              type="button"
              disabled={!customScopeValue.trim()}
              onClick={() => {
                setDraft({ ...draft, scope: formatMemoryScope(customScopeKind, customScopeValue) });
                setCustomScopeValue("");
              }}
            >
              Apply scope
            </button>
          </div>
          <p className="ai-hint" data-testid="memory-approval-hint">
            Memories are background for the assistant. They never change what needs approval: that is set in AI
            settings, Command safety.
          </p>
          <p className="ai-hint">
            Never write passwords, keys or tokens here. An entry that closely resembles an existing one is merged into
            it.
          </p>
          <div className="ai-card-actions">
            <button type="submit" className="ai-btn-emerald" disabled={saving}>
              {saving ? "Saving…" : missingEntry ? "Save as new" : draft.id ? "Save changes" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => {
                setSaveError("");
                setDraft(undefined);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {forgotten && (
        <p className="ai-hint" role="status" data-testid="memory-forgot-notice">
          Forgot &quot;{forgotten.title}&quot;.{" "}
          <button type="button" disabled={undoing} onClick={() => void undoForget()}>
            {undoing ? "Restoring…" : "Undo"}
          </button>
        </p>
      )}

      {all.length > 0 && (
        <div className="ai-filter-bar">
          <input
            type="search"
            aria-label="Filter entries"
            placeholder="Filter by title, text, or scope…"
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
          <div className="ai-tags" data-testid="memory-scope-filters" aria-label="Filter by scope">
            {MEMORY_SCOPE_CATEGORIES.map((cat) => {
              const count =
                cat.id === "all"
                  ? all.length
                  : all.filter((m) => describeMemoryScope(m.scope, names).category === cat.id).length;
              return (
                <button
                  key={cat.id}
                  type="button"
                  className={`ai-chip ${scopeCategory === cat.id && !scopeExact ? "ai-chip-on" : ""}`}
                  aria-pressed={scopeCategory === cat.id && !scopeExact}
                  data-testid={`memory-scope-filter-${cat.id}`}
                  onClick={() => {
                    setScopeCategory(cat.id);
                    setScopeExact("");
                  }}
                >
                  {cat.label}
                  {cat.id !== "all" ? ` · ${count}` : ""}
                </button>
              );
            })}
            {scopeExact && (
              <button
                type="button"
                className="ai-chip ai-chip-on"
                onClick={() => setScopeExact("")}
                title="Clear exact scope filter"
              >
                {scopeExact} ×
              </button>
            )}
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

      {shown.slice(0, limit).map((rawEntry) => {
        const m = rawEntry as MemoryEntryView;
        const long = m.text.length > 320 || m.text.split("\n").length > 5;
        const open = openIds.has(m.id);
        const score = m.feedbackScore ?? 0;
        const stale = isMemoryStale(m);
        const scopeInfo = describeMemoryScope(m.scope, names);
        const isPinned = (m.tier ?? (m.kind === "skill" ? "core" : "archival")) === "core";
        const isInlineEditing = inlineEditId === m.id;
        const agentLabel = m.agentName ?? m.author ?? (m.autoLearned ? "assistant" : undefined);

        return (
          <article className="ai-card" key={m.id} data-testid={`memory-${m.id}`}>
            <div className="ai-card-head">
              <div>
                <strong>{m.title}</strong>
                <small>
                  {m.kind === "skill" ? "Skill" : "Fact"} · {scopeInfo.label}
                  {m.author ? ` · ${m.author}` : ""} · {new Date(m.updatedAt).toLocaleDateString()}
                </small>
              </div>
              <div className="ai-tags">
                <button
                  type="button"
                  className={scopeBadgeClass(scopeInfo.category)}
                  data-testid={`memory-scope-${m.id}`}
                  title="Filter by this scope"
                  onClick={() => {
                    setScopeCategory(scopeInfo.category);
                    setScopeExact((prev) => (prev === scopeInfo.badgeText ? "" : scopeInfo.badgeText));
                  }}
                >
                  {scopeInfo.badgeText}
                </button>
                {stale.stale && (
                  <span
                    className="ai-badge ai-badge-mode"
                    data-testid={`memory-stale-${m.id}`}
                    title={stale.reason}
                  >
                    Needs Check
                  </span>
                )}
                {MEMORY_RULE_LIKE.test(`${m.title}\n${m.text}`) && (
                  <span
                    className="ai-badge ai-badge-mode"
                    data-testid={`memory-rule-like-${m.id}`}
                    title="Approvals are set in AI settings, Command safety. A memory cannot switch them off."
                  >
                    Reads like a rule: it does not change approvals
                  </span>
                )}
                {m.autoLearned && (
                  <span className="ai-badge ai-badge-purple" title="Written by the assistant from what happened">
                    learned
                  </span>
                )}
                {isPinned && (
                  <span className="ai-badge ai-badge-mode" title={TIERS.core} data-testid={`memory-pinned-${m.id}`}>
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

            {stale.stale && stale.reason && (
              <small className="ai-muted" data-testid={`memory-stale-reason-${m.id}`}>
                Verification notice: {stale.reason}
              </small>
            )}

            {isInlineEditing ? (
              <form
                className="ai-form"
                data-testid={`memory-inline-form-${m.id}`}
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!inlineTitle.trim() || !inlineText.trim()) return;
                  void mutateEntry(m, {
                    title: inlineTitle.trim(),
                    text: inlineText.trim(),
                  }).then(() => setInlineEditId(null));
                }}
              >
                <input
                  aria-label="Inline title"
                  value={inlineTitle}
                  onChange={(e) => setInlineTitle(e.target.value)}
                />
                <textarea
                  aria-label="Inline text"
                  rows={4}
                  value={inlineText}
                  onChange={(e) => setInlineText(e.target.value)}
                />
                <div className="ai-card-actions">
                  <button type="submit" className="ai-btn-emerald" disabled={busyId === m.id}>
                    {busyId === m.id ? "Saving…" : "Save inline"}
                  </button>
                  <button type="button" onClick={() => setInlineEditId(null)}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <p className={`ai-memory-text ${long && !open ? "ai-clamped" : ""}`}>{m.text}</p>
            )}

            <div className="ai-tags" data-testid={`memory-provenance-${m.id}`} style={{ marginTop: 4 }}>
              {m.sourceTaskId && (
                onOpenTask ? (
                  <button
                    type="button"
                    className="ai-linklike"
                    onClick={() => onOpenTask(m.sourceTaskId!)}
                  >
                    task:{m.sourceTaskId}
                  </button>
                ) : (
                  <small className="ai-muted">task:{m.sourceTaskId}</small>
                )
              )}
              {agentLabel && <small className="ai-muted">by {agentLabel}</small>}
              {m.editedBy && m.editedBy !== agentLabel && (
                <small className="ai-muted">· edited by {m.editedBy}</small>
              )}
              <small className="ai-muted">· updated {new Date(m.updatedAt).toLocaleString()}</small>
              {m.lastVerifiedAt && (
                <small className="ai-muted">· verified {new Date(m.lastVerifiedAt).toLocaleDateString()}</small>
              )}
              {m.sourceTrust && <span className="ai-badge">{m.sourceTrust}</span>}
            </div>

            {historyOf(m.id).map((h) => (
              <div key={h.id} className="ai-hint" style={{ opacity: 0.6 }} data-testid={`memory-replaced-${h.id}`}>
                <small>Replaced {new Date(h.supersededAt ?? h.updatedAt).toLocaleDateString()}</small>
                <p className="ai-memory-text">{h.text}</p>
              </div>
            ))}

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
              {stale.stale && (
                <button
                  type="button"
                  className="ai-btn-accent"
                  data-testid={`memory-reverify-${m.id}`}
                  disabled={busyId === m.id}
                  onClick={() =>
                    void mutateEntry(m, {
                      staleReason: undefined,
                      lastVerifiedAt: Date.now(),
                    })
                  }
                >
                  Re-verify
                </button>
              )}
              <button
                type="button"
                data-testid={`memory-pin-${m.id}`}
                disabled={busyId === m.id}
                onClick={() =>
                  void mutateEntry(m, {
                    tier: isPinned ? "archival" : "core",
                  })
                }
              >
                {isPinned ? "Unpin" : "Pin"}
              </button>
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
                data-testid={`memory-inline-edit-${m.id}`}
                onClick={() => {
                  if (isInlineEditing) {
                    setInlineEditId(null);
                  } else {
                    setInlineEditId(m.id);
                    setInlineTitle(m.title);
                    setInlineText(m.text);
                  }
                }}
              >
                {isInlineEditing ? "Close inline" : "Quick edit"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setSaveError("");
                  setDraft({
                    id: m.id,
                    title: m.title,
                    text: m.text,
                    scope: m.scope,
                    kind: m.kind,
                    tier: m.tier ?? (m.kind === "skill" ? "core" : "archival"),
                  });
                }}
              >
                Edit
              </button>
              <span className="ai-spacer" />
              <ConfirmButton
                label="Forget"
                confirmLabel={m.scope === "personal" ? "Forget this?" : "Forget for the whole team?"}
                onConfirm={() => void forget(m)}
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
