import { useState } from "react";
import type { AgentChange, HubSnapshot } from "@shared/types/aiHub";
import { ChangeProof } from "./ChangeProof";

type Source = "all" | "team" | "assistant";

interface Entry {
  id: string;
  at: number;
  source: "team" | "assistant";
  who: string;
  target: string;
  summary: string;
  kind: string;
  detail?: string;
  command?: string;
  change?: AgentChange;
  taskId?: string;
  taskTitle?: string;
}

const KINDS: Record<string, string> = {
  "config-edit": "config edit",
  "service-action": "service",
  service: "service",
  "package-change": "packages",
  deploy: "deploy",
  command: "command",
  "ai-action": "assistant",
  "profile-update": "server settings",
  note: "note",
};

const RISK: Record<string, { text: string; tone: string }> = {
  safe: { text: "read-only", tone: "ai-badge-success" },
  modify: { text: "changes state", tone: "ai-badge-mode" },
  destructive: { text: "destructive", tone: "ai-badge-danger" },
};

const STATUS_TONE: Record<AgentChange["status"], string> = {
  completed: "ai-badge-success",
  approved: "ai-badge-success",
  failed: "ai-badge-danger",
  denied: "ai-badge-danger",
  uncertain: "ai-badge-mode",
  pending: "",
  running: "",
};

const day = (at: number): string =>
  new Date(at).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
const time = (at: number): string =>
  new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/**
 * One timeline of what was changed: what teammates did on the servers (synced
 * through the workspace) and every command or file change the assistant made
 * on this computer, with its result.
 */
export function ChangesView({
  hub,
  onOpenTask,
}: {
  hub: HubSnapshot;
  onOpenTask: (taskId: string) => void;
}): JSX.Element {
  const [source, setSource] = useState<Source>("all");
  const [filter, setFilter] = useState("");
  const [limit, setLimit] = useState(60);

  const entries: Entry[] = [
    ...(hub.activityLog ?? []).map(
      (ev): Entry => ({
        id: `team-${ev.id}`,
        at: ev.at,
        source: "team",
        who: ev.actor,
        target: ev.targetLabel,
        summary: ev.summary,
        kind: KINDS[ev.kind] ?? ev.kind,
        detail: ev.detail ?? ev.details,
        command: ev.commandOrPath,
      }),
    ),
    ...hub.tasks.flatMap((task) =>
      task.changes.map(
        (c): Entry => ({
          id: `task-${task.id}-${c.id}`,
          at: c.at,
          source: "assistant",
          who: task.agentName || "Assistant",
          target: c.target,
          summary: c.description,
          kind: c.kind === "file" ? "file" : "command",
          command: c.command,
          change: c,
          taskId: task.id,
          taskTitle: task.title,
        }),
      ),
    ),
  ].sort((a, b) => b.at - a.at);

  const q = filter.trim().toLowerCase();
  const shown = entries
    .filter((e) => source === "all" || e.source === source)
    .filter(
      (e) => !q || [e.who, e.target, e.summary, e.command, e.detail].some((x) => x?.toLowerCase().includes(q)),
    );
  const page = shown.slice(0, limit);
  const count = (s: Source): number => (s === "all" ? entries.length : entries.filter((e) => e.source === s).length);

  let lastDay = "";
  return (
    <div className="ai-scroll">
      <header className="ai-view-head">
        <h2>Changes</h2>
        <p className="ai-hint">
          What was changed, where, and by whom: the team&apos;s activity from the shared workspace, and every command
          or file change the assistant made from this computer, with its result.
        </p>
      </header>

      {entries.length > 0 && (
        <div className="ai-filter-bar">
          <input
            type="search"
            aria-label="Filter changes"
            placeholder="Filter by server, person, command…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className="ai-tags">
            {(["all", "team", "assistant"] as Source[]).map((s) => (
              <button
                key={s}
                type="button"
                className={`ai-chip ${source === s ? "ai-chip-on" : ""}`}
                aria-pressed={source === s}
                onClick={() => setSource(s)}
              >
                {s === "all" ? "Everything" : s === "team" ? "Team activity" : "Assistant actions"} · {count(s)}
              </button>
            ))}
          </div>
        </div>
      )}

      {entries.length === 0 && (
        <p className="ai-empty">
          Nothing has been recorded yet. Config edits, service restarts and the assistant&apos;s commands appear here
          as they happen.
        </p>
      )}
      {entries.length > 0 && shown.length === 0 && <p className="ai-empty">Nothing matches.</p>}

      <div className="ai-timeline">
        {page.map((e) => {
          const heading = day(e.at) !== lastDay ? (lastDay = day(e.at)) : "";
          const c = e.change;
          const hasMore = Boolean(e.command || e.detail || c?.output || c?.before || c?.after || c?.check);
          const head = (
            <>
              <time>{time(e.at)}</time>
              <span className="ai-timeline-text">
                <strong>{e.who}</strong> on <strong>{e.target}</strong>
                <span>{e.summary}</span>
              </span>
              <span className="ai-tags">
                {c?.riskLevel && RISK[c.riskLevel] && (
                  <span className={`ai-badge ${RISK[c.riskLevel].tone}`} title={c.riskReason}>
                    {RISK[c.riskLevel].text}
                  </span>
                )}
                {c ? (
                  <span className={`ai-badge ${STATUS_TONE[c.status]}`}>
                    {c.rollback?.ran ? (c.rollback.exitCode === 0 ? "rolled back" : "rollback failed") : c.status}
                    {c.exitCode !== undefined && c.exitCode !== 0 ? ` · exit ${c.exitCode}` : ""}
                  </span>
                ) : (
                  <span className="ai-badge">{e.kind}</span>
                )}
              </span>
            </>
          );
          return (
            <div key={e.id}>
              {heading && <h4 className="ai-timeline-day">{heading}</h4>}
              {hasMore ? (
                <details className={`ai-timeline-item ai-timeline-${e.source}`}>
                  <summary>{head}</summary>
                  <div className="ai-timeline-more">
                    {e.command && <pre>{e.command}</pre>}
                    {e.detail && <p>{e.detail}</p>}
                    {c?.kind === "file" && c.before !== undefined && (
                      <>
                        <small>Before</small>
                        <pre>{c.before}</pre>
                        <small>After</small>
                        <pre>{c.after}</pre>
                      </>
                    )}
                    {c?.output && (
                      <>
                        <small>Output</small>
                        <pre>{c.output}</pre>
                      </>
                    )}
                    {c && <ChangeProof change={c} />}
                    {c?.riskReason && <small>Safety check: {c.riskReason}</small>}
                    {e.taskId && (
                      <button type="button" onClick={() => onOpenTask(e.taskId!)}>
                        Open the conversation: {e.taskTitle}
                      </button>
                    )}
                  </div>
                </details>
              ) : (
                <div className={`ai-timeline-item ai-timeline-${e.source}`}>
                  <div className="ai-timeline-flat">{head}</div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {shown.length > limit && (
        <button type="button" className="ai-more" onClick={() => setLimit(limit + 60)}>
          Show {Math.min(60, shown.length - limit)} more
        </button>
      )}
    </div>
  );
}
