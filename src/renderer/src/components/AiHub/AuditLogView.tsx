import { useCallback, useEffect, useState } from "react";
import type { AuditEntryView, AuditVerificationView, HubRequest, HubSnapshot } from "@shared/types/aiHub";

/**
 * The audit log as a person reads it: every command, change, file write,
 * approval and setting change, newest first, and whether the chain of hashes
 * that ties them together still holds. "Check it" walks the whole chain and
 * the anchors in the team bucket; "Export" hands over the file as it is on
 * disk, with what the check found, for somebody who wants to check it
 * themselves.
 */

const KIND_TEXT: Record<string, string> = {
  command: "command",
  change: "change",
  "file-write": "file",
  approval: "approval",
  setting: "setting",
  mcp: "MCP",
  "sign-in": "sign-in",
  recording: "recording",
};

const OUTCOME_TONE: Record<string, string> = {
  completed: "ai-badge-success",
  "rolled-back": "ai-badge-mode",
  uncertain: "ai-badge-mode",
  failed: "ai-badge-danger",
  denied: "ai-badge-danger",
};

const when = (at: number): string =>
  new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function AuditLogView({
  request,
  hub,
  onOpenTask,
  onWatch,
}: {
  request: (r: HubRequest) => Promise<HubSnapshot>;
  hub: HubSnapshot;
  onOpenTask: (taskId: string) => void;
  onWatch: (recordingId: string, title: string, startAt?: string) => void;
}): JSX.Element {
  const [entries, setEntries] = useState<AuditEntryView[]>([]);
  const [verification, setVerification] = useState<AuditVerificationView | undefined>();
  const [checkedAt, setCheckedAt] = useState(0);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const [limit, setLimit] = useState(200);

  const load = useCallback(async () => {
    setBusy(true);
    setProblem("");
    try {
      const audit = (await request({ action: "audit-read", limit })).reply?.audit;
      if (audit) {
        setEntries(audit.entries);
        setVerification(audit.verification);
        setCheckedAt(Date.now());
      }
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [request, limit]);

  useEffect(() => {
    void load();
  }, [load]);

  const exportLog = async (): Promise<void> => {
    setProblem("");
    try {
      const file = (await request({ action: "audit-export" })).reply?.download;
      if (!file) return;
      const bytes = Uint8Array.from(atob(file.dataBase64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: file.mime }));
      const a = document.createElement("a");
      a.href = url;
      a.download = file.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  };

  const recordingOf = (e: AuditEntryView): { id: string; title: string } | undefined => {
    const task = e.taskId ? hub.tasks.find((t) => t.id === e.taskId) : undefined;
    // The seal of a recording names the recording itself.
    if (e.kind === "recording" && e.changeId) return { id: e.changeId, title: task?.title ?? e.what };
    return task?.recordingId ? { id: task.recordingId, title: task.title } : undefined;
  };
  const when2 = (at: number): string =>
    new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  const q = filter.trim().toLowerCase();
  const shown = entries.filter(
    (e) => !q || [e.actor, e.target, e.what, e.outcome, e.approvedBy, e.detail, e.kind].some((x) => x?.toLowerCase().includes(q)),
  );

  return (
    <div className="ai-audit" data-testid="audit-log">
      <div
        className={`ai-audit-verdict ${verification ? (verification.ok ? "ai-audit-ok" : "ai-audit-broken") : ""}`}
        role="status"
        data-testid="audit-verdict"
      >
        {!verification ? (
          <span>Checking the log…</span>
        ) : verification.ok ? (
          <span>
            <strong>The log holds.</strong> All {verification.entries} entries hash to what they say, each follows the one
            before it
            {verification.anchors && verification.anchors.checked > 0
              ? `, and all ${verification.anchors.checked} anchors in the team bucket match it and follow each other.`
              : ". There is no team bucket to anchor it in, so a cut from its very end would not show."}
            {verification.anchors?.coveredSeq !== undefined && verification.anchors.lastAt !== undefined && (
              <>
                {" "}
                Entries up to #{verification.anchors.coveredSeq} are anchored (last {when2(verification.anchors.lastAt)})
                {verification.entries > verification.anchors.coveredSeq
                  ? `; the ${verification.entries - verification.anchors.coveredSeq} after it are only chained until the next anchor.`
                  : "."}
              </>
            )}
            {(verification.anchors?.gaps?.length ?? 0) > 0 && (
              <span className="ai-audit-gaps">
                {" "}
                No anchor was written between{" "}
                {verification.anchors!.gaps!.slice(-3).map((g, i) => (
                  <span key={g.from}>
                    {i > 0 ? ", " : ""}
                    {when2(g.from)} and {when2(g.to)}
                  </span>
                ))}
                : this computer was off then, or anchors were removed.
              </span>
            )}
          </span>
        ) : (
          <span>
            <strong>The log does not hold.</strong> {verification.problem?.text} Everything before entry{" "}
            {verification.problem?.seq} still checks out.
          </span>
        )}
        <span className="ai-audit-actions">
          {checkedAt > 0 && <small>checked {new Date(checkedAt).toLocaleTimeString()}</small>}
          <button type="button" onClick={() => void load()} disabled={busy}>
            {busy ? "Checking…" : "Check it again"}
          </button>
          <button type="button" onClick={() => void exportLog()}>
            Export
          </button>
        </span>
      </div>
      {problem && (
        <p role="alert" className="ai-error">
          {problem}
        </p>
      )}

      {entries.length > 0 && (
        <div className="ai-filter-bar">
          <input
            type="search"
            aria-label="Filter the audit log"
            placeholder="Filter by who, server, command, outcome…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      )}
      {verification && entries.length === 0 && (
        <p className="ai-empty">
          Nothing has been written to the log yet. Every command an agent runs, every change, file write and approval
          lands here once it has ended.
        </p>
      )}
      {entries.length > 0 && shown.length === 0 && <p className="ai-empty">Nothing matches.</p>}

      <ol className="ai-audit-list">
        {shown.map((e) => {
          const rec = recordingOf(e);
          return (
            <li key={e.seq} className="ai-audit-entry">
              <details>
                <summary>
                  <span className="ai-audit-seq">#{e.seq}</span>
                  <time>{when(e.at)}</time>
                  <span className="ai-audit-text">
                    <strong>{e.actor}</strong>
                    {e.target && (
                      <>
                        {" "}
                        on <strong>{e.target}</strong>
                      </>
                    )}
                    <code>{e.what}</code>
                  </span>
                  <span className="ai-tags">
                    {verification?.problem?.seq === e.seq && (
                      <span className="ai-badge ai-badge-danger" title={verification.problem.text}>
                        the chain breaks here
                      </span>
                    )}
                    <span className="ai-badge">{KIND_TEXT[e.kind] ?? e.kind}</span>
                    {e.outcome && (
                      <span className={`ai-badge ${OUTCOME_TONE[e.outcome] ?? ""}`}>
                        {e.outcome}
                        {e.exitCode !== undefined && e.exitCode !== 0 ? ` · exit ${e.exitCode}` : ""}
                      </span>
                    )}
                  </span>
                </summary>
                <div className="ai-timeline-more">
                  <pre>{e.what}</pre>
                  {e.approvedBy && <p>Decided by: {e.approvedBy}</p>}
                  {e.detail && <p>{e.detail}</p>}
                  <small className="ai-audit-hash" title="This entry's hash. The next entry carries it.">
                    sha256 {e.hash}
                  </small>
                  <span className="ai-audit-actions">
                    {rec && (
                      <button type="button" onClick={() => onWatch(rec.id, rec.title, e.kind === "recording" ? undefined : e.what)}>
                        Watch the terminal recording
                      </button>
                    )}
                    {e.taskId && hub.tasks.some((t) => t.id === e.taskId) && (
                      <button type="button" onClick={() => onOpenTask(e.taskId!)}>
                        Open the conversation
                      </button>
                    )}
                  </span>
                </div>
              </details>
            </li>
          );
        })}
      </ol>
      {entries.length >= limit && (
        <button type="button" className="ai-more" onClick={() => setLimit(limit + 200)}>
          Show older entries
        </button>
      )}
    </div>
  );
}
