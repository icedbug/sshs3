import { useState } from "react";
import type { AgentChange, HubRequest, HubSnapshot } from "@shared/types/aiHub";
import { hubRequest } from "../../lib/aiHub";
import { AuditLogView } from "./AuditLogView";
import { ChangeProof } from "./ChangeProof";
import { RecordingPlayer } from "./RecordingPlayer";

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

/** Who let a change through or stopped it, and how, said plainly. */
function decision(c: AgentChange): string {
  const at = (t: number): string => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (c.decidedBy) return `${c.decidedBy.allowed ? "Allowed" : "Refused"} by ${c.decidedBy.name} at ${at(c.decidedBy.at)}`;
  switch (c.decidedHow) {
    case "policy":
      return c.status === "denied" ? "Refused by the safety rules" : "Let through by the safety rules, without asking";
    case "plan":
      return "Let through without asking: an approved plan lists exactly this command";
    case "timeout":
      return "Not allowed: nobody answered in time";
    case "stopped":
      return "Not allowed: the run was stopped before anyone answered";
    default:
      return "";
  }
}

const day = (at: number): string =>
  new Date(at).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
const time = (at: number): string =>
  new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });

/**
 * One timeline of what was changed: what teammates did on the servers (synced
 * through the workspace) and every command or file change the assistant made
 * on this computer, with its result.
 */
export function ChangesView({
  hub,
  onOpenTask,
  request = hubRequest,
}: {
  hub: HubSnapshot;
  onOpenTask: (taskId: string) => void;
  request?: (r: HubRequest) => Promise<HubSnapshot>;
}): JSX.Element {
  const [tab, setTab] = useState<"timeline" | "audit">("timeline");
  const [watching, setWatching] = useState<{
    title: string;
    cast: string;
    sealed?: boolean;
    startAt?: string;
  } | null>(null);
  const [watchProblem, setWatchProblem] = useState("");
  const [source, setSource] = useState<Source>("all");
  const [filter, setFilter] = useState("");
  const [limit, setLimit] = useState(60);

  // This computer's own assistant changes are in the list once, with all they carry, not again as team activity.
  const ownChanges = new Set(hub.tasks.flatMap((t) => t.changes.map((c) => `change-${c.id}`)));
  const entries: Entry[] = [
    ...(hub.activityLog ?? []).filter((ev) => !ownChanges.has(ev.id)).map(
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
      (e) =>
        !q ||
        [e.who, e.target, e.summary, e.command, e.detail].some((x) =>
          x?.toLowerCase().includes(q),
        ),
    );
  const page = shown.slice(0, limit);
  const count = (s: Source): number =>
    s === "all" ? entries.length : entries.filter((e) => e.source === s).length;

  const watch = async (recordingId: string, title: string, startAt?: string): Promise<void> => {
    setWatchProblem("");
    try {
      const rec = (await request({ action: "recording-read", id: recordingId }))
        .reply?.recording;
      if (rec) setWatching({ title, cast: rec.cast, sealed: rec.sealed, startAt });
    } catch (error) {
      setWatchProblem(error instanceof Error ? error.message : String(error));
    }
  };
  const recordingOf = (taskId?: string): string | undefined =>
    taskId ? hub.tasks.find((t) => t.id === taskId)?.recordingId : undefined;

  let lastDay = "";
  return (
    <div className="ai-scroll">
      <header className="ai-view-head">
        <h2>Changes</h2>
        <p className="ai-hint">
          What was changed, where, and by whom: the team&apos;s activity from
          the shared workspace, and every command or file change the assistant
          made from this computer, with its result. The audit log keeps the same
          on this computer in a form that shows when it was tampered with.
        </p>
      </header>

      <div className="ai-view-tabs" role="tablist" aria-label="Changes">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "timeline"}
          className={`ai-chip ${tab === "timeline" ? "ai-chip-on" : ""}`}
          onClick={() => setTab("timeline")}
        >
          Timeline
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "audit"}
          className={`ai-chip ${tab === "audit" ? "ai-chip-on" : ""}`}
          onClick={() => setTab("audit")}
        >
          Audit log
        </button>
      </div>
      {watchProblem && (
        <p role="alert" className="ai-error">
          {watchProblem}
        </p>
      )}
      {watching && (
        <RecordingPlayer
          cast={watching.cast}
          title={watching.title}
          sealed={watching.sealed}
          startAt={watching.startAt}
          onClose={() => setWatching(null)}
        />
      )}

      {tab === "audit" && (
        <AuditLogView
          request={request}
          hub={hub}
          onOpenTask={onOpenTask}
          onWatch={(id, title, at) => void watch(id, title, at)}
        />
      )}

      {tab === "timeline" && entries.length > 0 && (
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
                {s === "all"
                  ? "Everything"
                  : s === "team"
                    ? "Team activity"
                    : "Assistant actions"}{" "}
                · {count(s)}
              </button>
            ))}
          </div>
        </div>
      )}

      {tab === "timeline" && entries.length === 0 && (
        <p className="ai-empty">
          Nothing has been recorded yet. Config edits, service restarts and the
          assistant&apos;s commands appear here as they happen.
        </p>
      )}
      {tab === "timeline" && entries.length > 0 && shown.length === 0 && (
        <p className="ai-empty">Nothing matches.</p>
      )}

      {tab === "timeline" && (
        <div className="ai-timeline">
          {page.map((e) => {
            const heading = day(e.at) !== lastDay ? (lastDay = day(e.at)) : "";
            const c = e.change;
            const hasMore = Boolean(
              e.command ||
              e.detail ||
              c?.output ||
              c?.before ||
              c?.after ||
              c?.check,
            );
            const head = (
              <>
                <time>{time(e.at)}</time>
                <span className="ai-timeline-text">
                  <strong>{e.who}</strong> on <strong>{e.target}</strong>
                  <span>{e.summary}</span>
                </span>
                <span className="ai-tags">
                  {c?.riskLevel && RISK[c.riskLevel] && (
                    <span
                      className={`ai-badge ${RISK[c.riskLevel].tone}`}
                      title={c.riskReason}
                    >
                      {RISK[c.riskLevel].text}
                    </span>
                  )}
                  {c ? (
                    <span className={`ai-badge ${STATUS_TONE[c.status]}`}>
                      {c.rollback?.ran
                        ? c.rollback.exitCode === 0
                          ? "rolled back"
                          : "rollback failed"
                        : c.status}
                      {c.exitCode !== undefined && c.exitCode !== 0
                        ? ` · exit ${c.exitCode}`
                        : ""}
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
                  <details
                    className={`ai-timeline-item ai-timeline-${e.source}`}
                  >
                    <summary>{head}</summary>
                    <div className="ai-timeline-more">
                      {e.command && <pre>{e.command}</pre>}
                      {e.detail && <p>{e.detail}</p>}
                      {c?.kind === "file" && c.diff && (
                      <>
                        <small>What changed</small>
                        <pre className="ai-diff">{c.diff}</pre>
                      </>
                    )}
                    {c?.kind === "file" && !c.diff && c.before !== undefined && (
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
                      {c && decision(c) && <small data-testid="change-decision">{decision(c)}</small>}
                    {c && <ChangeProof change={c} />}
                      {c?.riskReason && (
                        <small>Safety check: {c.riskReason}</small>
                      )}
                      {recordingOf(e.taskId) && (
                        <button
                          type="button"
                          onClick={() =>
                            void watch(
                              recordingOf(e.taskId)!,
                              e.taskTitle ?? e.summary,
                              c?.command,
                            )
                          }
                        >
                          Watch the terminal recording
                        </button>
                      )}
                      {e.taskId && (
                        <button
                          type="button"
                          onClick={() => onOpenTask(e.taskId!)}
                        >
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
      )}
      {tab === "timeline" && shown.length > limit && (
        <button
          type="button"
          className="ai-more"
          onClick={() => setLimit(limit + 60)}
        >
          Show {Math.min(60, shown.length - limit)} more
        </button>
      )}
    </div>
  );
}
