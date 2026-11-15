import { useState } from "react";
import type {
  AgentChange,
  AgentChangeApproval,
  HubRequest,
  HubSnapshot,
} from "@shared/types/aiHub";
import { hubRequest } from "../../lib/aiHub";
import { AuditLogView } from "./AuditLogView";
import { ChangeProof } from "./ChangeProof";
import { AnsiLogView, DiffViewer } from "./DiffViewer";
import { RecordingPlayer } from "./RecordingPlayer";

type Source = "all" | "team" | "assistant";

export interface ChangeTimelineEntry {
  id: string;
  at: number;
  source: "team" | "assistant";
  who: string;
  target: string;
  summary: string;
  kind: string;
  detail?: string;
  command?: string;
  change?: AgentChange & { changeSetId?: string };
  taskId?: string;
  taskTitle?: string;
}

export interface ChangeSetGroup {
  id: string;
  taskId?: string;
  taskTitle?: string;
  changeSetId?: string;
  at: number;
  entries: ChangeTimelineEntry[];
  summary: string;
  targets: string[];
  actors: string[];
  blastRadius: string[];
  approvals: AgentChangeApproval[];
  requiredApprovals?: number;
  restorableChangeId?: string;
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
  const at = (t: number): string =>
    new Date(t).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  if (c.decidedBy) {
    return `${c.decidedBy.allowed ? "Allowed" : "Refused"} by ${c.decidedBy.name} at ${at(c.decidedBy.at)}`;
  }
  switch (c.decidedHow) {
    case "policy":
      return c.status === "denied"
        ? "Refused by the safety rules"
        : "Let through by the safety rules, without asking";
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

export function isRestorableChange(c: AgentChange | undefined): boolean {
  if (!c) return false;
  return Boolean(
    c.before !== undefined ||
      c.beforeHash ||
      (c.kind === "file" && (c.diff || c.after !== undefined)),
  );
}

/** Synthesizes a concise AI change summary for a grouped Change Set. */
export function summarizeChangeSet(
  entries: ChangeTimelineEntry[],
  taskTitle?: string,
): string {
  const fileCount = entries.filter((e) => e.change?.kind === "file").length;
  const cmdCount = entries.filter((e) => e.change?.kind === "command").length;
  const parts: string[] = [];
  if (fileCount > 0) parts.push(`${fileCount} file ${fileCount === 1 ? "edit" : "edits"}`);
  if (cmdCount > 0) parts.push(`${cmdCount} ${cmdCount === 1 ? "command" : "commands"}`);
  if (parts.length === 0) parts.push(`${entries.length} ${entries.length === 1 ? "change" : "changes"}`);
  const counts = parts.join(", ");
  if (taskTitle) return `${taskTitle} (${counts})`;
  const firstSummary = entries[0]?.summary ?? "Change set";
  return entries.length === 1 ? firstSummary : `${firstSummary} (+${entries.length - 1} more · ${counts})`;
}

/** Groups timeline entries into Change Sets by `changeSetId` or `taskId`, newest first. */
export function groupChangeEntries(
  entries: ChangeTimelineEntry[],
): ChangeSetGroup[] {
  const map = new Map<string, ChangeTimelineEntry[]>();
  for (const entry of entries) {
    const csId = entry.change?.changeSetId;
    const key = csId
      ? `changeset:${csId}`
      : entry.taskId
        ? `task:${entry.taskId}`
        : `entry:${entry.id}`;
    const bucket = map.get(key);
    if (bucket) bucket.push(entry);
    else map.set(key, [entry]);
  }

  const groups: ChangeSetGroup[] = [];
  for (const [id, groupEntries] of map.entries()) {
    const sorted = [...groupEntries].sort((a, b) => b.at - a.at);
    const first = sorted[0];
    const taskTitle = sorted.find((e) => e.taskTitle)?.taskTitle;
    const changeSetId = sorted.find((e) => e.change?.changeSetId)?.change?.changeSetId;
    const taskId = sorted.find((e) => e.taskId)?.taskId;
    const targets = [...new Set(sorted.map((e) => e.target).filter(Boolean))];
    const actors = [...new Set(sorted.map((e) => e.who).filter(Boolean))];
    const blastRadius = [
      ...new Set(
        sorted.map((e) => e.change?.blastRadius).filter((x): x is string => Boolean(x)),
      ),
    ];
    const approvals: AgentChangeApproval[] = [];
    let requiredApprovals: number | undefined;
    for (const e of sorted) {
      if (e.change?.approvals) approvals.push(...e.change.approvals);
      if (e.change?.requiredApprovals !== undefined) {
        requiredApprovals = Math.max(requiredApprovals ?? 0, e.change.requiredApprovals);
      }
    }
    // Earliest restorable checkpoint in the task/set so "Rewind Task" restores to before the set.
    const restorable = [...sorted]
      .reverse()
      .find((e) => isRestorableChange(e.change));

    groups.push({
      id,
      taskId,
      taskTitle,
      changeSetId,
      at: first.at,
      entries: sorted,
      summary: summarizeChangeSet(sorted, taskTitle),
      targets,
      actors,
      blastRadius,
      approvals,
      requiredApprovals,
      restorableChangeId: restorable?.change?.id,
    });
  }

  return groups.sort((a, b) => b.at - a.at);
}

function formatApprovalBadge(
  approvals: AgentChangeApproval[] | undefined,
  requiredApprovals: number | undefined,
  decidedBy?: AgentChange["decidedBy"],
): { text: string; tone: string; title: string } | null {
  const list = approvals ?? [];
  if (list.length === 0 && !requiredApprovals && !decidedBy) return null;
  if (list.length > 0 || requiredApprovals) {
    const granted = list.filter((a) => a.allowed);
    const denied = list.filter((a) => !a.allowed);
    const req = requiredApprovals ?? 1;
    const names = list.map(
      (a) => `${a.actor} (${a.allowed ? "approved" : "denied"})`,
    );
    if (denied.length > 0) {
      return {
        text: `Approvals: ${granted.length}/${req} · denied`,
        tone: "ai-badge-danger",
        title: names.join(", "),
      };
    }
    return {
      text: `Approvals: ${granted.length}/${req}`,
      tone: granted.length >= req ? "ai-badge-success" : "ai-badge-mode",
      title: names.join(", ") || "Pending peer approval",
    };
  }
  if (decidedBy) {
    return {
      text: `${decidedBy.allowed ? "Approved" : "Denied"} by ${decidedBy.name}`,
      tone: decidedBy.allowed ? "ai-badge-success" : "ai-badge-danger",
      title: new Date(decidedBy.at).toLocaleString(),
    };
  }
  return null;
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
  const [groupBySet, setGroupBySet] = useState(true);
  const [watching, setWatching] = useState<{
    title: string;
    cast: string;
    sealed?: boolean;
    startAt?: string;
  } | null>(null);
  const [watchProblem, setWatchProblem] = useState("");
  const [restoreState, setRestoreState] = useState<
    Record<string, { busy?: boolean; message?: string; error?: string }>
  >({});
  const [source, setSource] = useState<Source>("all");
  const [filter, setFilter] = useState("");
  const [limit, setLimit] = useState(60);

  // This computer's own assistant changes are in the list once, with all they carry, not again as team activity.
  const ownChanges = new Set(
    hub.tasks.flatMap((t) => t.changes.map((c) => `change-${c.id}`)),
  );
  const entries: ChangeTimelineEntry[] = [
    ...(hub.activityLog ?? [])
      .filter((ev) => !ownChanges.has(ev.id))
      .map(
        (ev): ChangeTimelineEntry => ({
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
        (c): ChangeTimelineEntry => ({
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
        [
          e.who,
          e.target,
          e.summary,
          e.command,
          e.detail,
          e.taskTitle,
          e.change?.blastRadius,
        ].some((x) => x?.toLowerCase().includes(q)),
    );
  const page = shown.slice(0, limit);
  const groupedPage = groupBySet ? groupChangeEntries(page) : null;

  const count = (s: Source): number =>
    s === "all"
      ? entries.length
      : entries.filter((e) => e.source === s).length;

  const watch = async (
    recordingId: string,
    title: string,
    startAt?: string,
  ): Promise<void> => {
    setWatchProblem("");
    try {
      const rec = (await request({ action: "recording-read", id: recordingId }))
        .reply?.recording;
      if (rec)
        setWatching({ title, cast: rec.cast, sealed: rec.sealed, startAt });
    } catch (error) {
      setWatchProblem(error instanceof Error ? error.message : String(error));
    }
  };

  const recordingOf = (taskId?: string): string | undefined => {
    if (!taskId) return undefined;
    const t = hub.tasks.find((x) => x.id === taskId);
    return t?.recordingIds?.[0] ?? t?.recordingId;
  };

  const restoreCheckpoint = async (
    key: string,
    taskId: string,
    changeId: string,
    force = false,
  ): Promise<void> => {
    setRestoreState((prev) => ({ ...prev, [key]: { busy: true } }));
    try {
      await request({
        action: "restore-checkpoint",
        taskId,
        changeId,
        ...(force ? { force: true } : {}),
      });
      setRestoreState((prev) => ({
        ...prev,
        [key]: { busy: false, message: "Checkpoint restored." },
      }));
    } catch (error) {
      setRestoreState((prev) => ({
        ...prev,
        [key]: {
          busy: false,
          error: error instanceof Error ? error.message : String(error),
        },
      }));
    }
  };

  const renderEntry = (e: ChangeTimelineEntry, includeDay: boolean, heading: string) => {
    const c = e.change;
    const hasFileDiff = Boolean(
      c?.kind === "file" &&
        (c.diff || c.before !== undefined || c.after !== undefined),
    );
    const approvalBadge = c
      ? formatApprovalBadge(c.approvals, c.requiredApprovals, c.decidedBy)
      : null;
    const restorable = Boolean(e.taskId && c && isRestorableChange(c));
    const entryRestoreKey = `entry:${e.id}`;
    const entryRestore = restoreState[entryRestoreKey];

    const hasMore = Boolean(
      e.command ||
        e.detail ||
        c?.output ||
        hasFileDiff ||
        c?.check ||
        c?.rollback ||
        c?.structuredCheck ||
        c?.dryRunOutput ||
        c?.preflightSnapshot ||
        c?.status === "uncertain" ||
        restorable,
    );

    const head = (
      <>
        <time>{time(e.at)}</time>
        <span className="ai-timeline-text">
          <strong>{e.who}</strong> on <strong>{e.target}</strong>
          <span>{e.summary}</span>
        </span>
        <span className="ai-tags">
          {c?.turnIndex !== undefined && (
            <span className="ai-badge">turn {c.turnIndex}</span>
          )}
          {c?.blastRadius && (
            <span
              className="ai-badge ai-badge-mode"
              data-testid={`blast-radius-${c.id}`}
              title={`Blast radius: ${c.blastRadius}`}
            >
              {c.blastRadius}
            </span>
          )}
          {approvalBadge && (
            <span
              className={`ai-badge ${approvalBadge.tone}`}
              title={approvalBadge.title}
              data-testid={`approval-badge-${c?.id ?? e.id}`}
            >
              {approvalBadge.text}
            </span>
          )}
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
        {includeDay && heading && <h4 className="ai-timeline-day">{heading}</h4>}
        {hasMore ? (
          <details className={`ai-timeline-item ai-timeline-${e.source}`}>
            <summary>{head}</summary>
            <div className="ai-timeline-more">
              {e.command && <pre>{e.command}</pre>}
              {e.detail && <p>{e.detail}</p>}
              {hasFileDiff && c && (
                <div data-testid={`change-diff-${c.id}`}>
                  <small>What changed</small>
                  <DiffViewer
                    diff={c.diff}
                    before={c.before}
                    after={c.after}
                    filePath={c.target}
                    defaultMode="unified"
                    maxUnchangedCollapsed={6}
                  />
                </div>
              )}
              {c?.output && (
                <div>
                  <small>Output</small>
                  <AnsiLogView text={c.output} maxLines={80} />
                </div>
              )}
              {c && decision(c) && (
                <small data-testid="change-decision">{decision(c)}</small>
              )}
              {c?.decisionNote && (
                <small>Note with the answer: {c.decisionNote}</small>
              )}
              {c && (
                <ChangeProof change={c} taskId={e.taskId} request={request} />
              )}
              {c?.riskReason && <small>Safety check: {c.riskReason}</small>}
              <div className="ai-card-actions">
                {restorable && e.taskId && c && (
                  <button
                    type="button"
                    data-testid={`restore-checkpoint-${c.id}`}
                    disabled={entryRestore?.busy}
                    onClick={() =>
                      void restoreCheckpoint(entryRestoreKey, e.taskId!, c.id)
                    }
                  >
                    {entryRestore?.busy ? "Restoring…" : "Restore Checkpoint"}
                  </button>
                )}
                {entryRestore?.error && e.taskId && c && (
                  <button
                    type="button"
                    className="ai-btn-danger"
                    disabled={entryRestore.busy}
                    onClick={() =>
                      void restoreCheckpoint(
                        entryRestoreKey,
                        e.taskId!,
                        c.id,
                        true,
                      )
                    }
                  >
                    Force Restore
                  </button>
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
              {entryRestore?.message && (
                <small role="status" className="ai-ok">
                  {entryRestore.message}
                </small>
              )}
              {entryRestore?.error && (
                <small role="alert" className="ai-error">
                  {entryRestore.error}
                </small>
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
  };

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
            <button
              type="button"
              className={`ai-chip ${groupBySet ? "ai-chip-on" : ""}`}
              aria-pressed={groupBySet}
              onClick={() => setGroupBySet((v) => !v)}
            >
              Change Sets
            </button>
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

      {tab === "timeline" && !groupedPage && (
        <div className="ai-timeline">
          {page.map((e) => {
            const heading = day(e.at) !== lastDay ? (lastDay = day(e.at)) : "";
            return renderEntry(e, true, heading);
          })}
        </div>
      )}

      {tab === "timeline" && groupedPage && (
        <div className="ai-timeline">
          {groupedPage.map((group) => {
            const heading =
              day(group.at) !== lastDay ? (lastDay = day(group.at)) : "";
            const isSetCard =
              Boolean(group.taskId || group.changeSetId) &&
              (group.entries.length > 1 ||
                group.blastRadius.length > 0 ||
                group.approvals.length > 0 ||
                Boolean(group.restorableChangeId));
            const groupApproval = formatApprovalBadge(
              group.approvals,
              group.requiredApprovals,
            );
            const setRestoreKey = `set:${group.id}`;
            const setRestore = restoreState[setRestoreKey];

            if (!isSetCard) {
              return (
                <div key={group.id}>
                  {heading && <h4 className="ai-timeline-day">{heading}</h4>}
                  {group.entries.map((e) => renderEntry(e, false, ""))}
                </div>
              );
            }

            return (
              <div key={group.id}>
                {heading && <h4 className="ai-timeline-day">{heading}</h4>}
                <section
                  className="ai-card ai-change-set"
                  data-testid={`change-set-${group.id}`}
                >
                  <div className="ai-card-head">
                    <div>
                      <strong>{group.summary}</strong>
                      <small>
                        {group.actors.join(", ")} · {group.targets.join(", ")} ·{" "}
                        {time(group.at)}
                      </small>
                    </div>
                    <div className="ai-tags">
                      <span className="ai-badge">
                        {group.entries.length}{" "}
                        {group.entries.length === 1 ? "change" : "changes"}
                      </span>
                      {group.blastRadius.map((br) => (
                        <span
                          key={br}
                          className="ai-badge ai-badge-mode"
                          title={`Blast radius: ${br}`}
                        >
                          {br}
                        </span>
                      ))}
                      {groupApproval && (
                        <span
                          className={`ai-badge ${groupApproval.tone}`}
                          title={groupApproval.title}
                        >
                          {groupApproval.text}
                        </span>
                      )}
                      {group.taskId && group.restorableChangeId && (
                        <button
                          type="button"
                          data-testid={`rewind-task-${group.taskId}`}
                          disabled={setRestore?.busy}
                          onClick={() =>
                            void restoreCheckpoint(
                              setRestoreKey,
                              group.taskId!,
                              group.restorableChangeId!,
                            )
                          }
                        >
                          {setRestore?.busy ? "Rewinding…" : "Rewind Task"}
                        </button>
                      )}
                      {group.taskId && (
                        <button
                          type="button"
                          onClick={() => onOpenTask(group.taskId!)}
                        >
                          Open conversation
                        </button>
                      )}
                    </div>
                  </div>
                  {setRestore?.message && (
                    <small role="status" className="ai-ok">
                      {setRestore.message}
                    </small>
                  )}
                  {setRestore?.error && (
                    <small role="alert" className="ai-error">
                      {setRestore.error}
                    </small>
                  )}
                  {group.entries.map((e) => renderEntry(e, false, ""))}
                </section>
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
