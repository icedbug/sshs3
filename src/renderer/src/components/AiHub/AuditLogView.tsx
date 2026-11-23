import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AuditEntryView,
  AuditVerificationView,
  HubRequest,
  HubSnapshot,
} from "@shared/types/aiHub";

/**
 * The audit log as a person reads it: every command, change, file write,
 * approval and setting change, newest first, and whether the chain of hashes
 * that ties them together still holds.
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
  integration: "written elsewhere",
};

const OUTCOME_TONE: Record<string, string> = {
  completed: "ai-badge-success",
  "rolled-back": "ai-badge-mode",
  uncertain: "ai-badge-mode",
  failed: "ai-badge-danger",
  denied: "ai-badge-danger",
};

const when = (at: number): string =>
  new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

function csvCell(value: unknown): string {
  const s = value === undefined || value === null ? "" : String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Formats audit entries into an RFC-4180 CSV compliance report. */
export function formatAuditCsv(entries: AuditEntryView[]): string {
  const header = [
    "seq",
    "timestamp",
    "kind",
    "actor",
    "target",
    "what",
    "outcome",
    "exitCode",
    "approvedBy",
    "taskId",
    "changeId",
    "detail",
    "hash",
  ].join(",");
  const rows = entries.map((e) =>
    [
      e.seq,
      new Date(e.at).toISOString(),
      e.kind,
      e.actor,
      e.target ?? "",
      e.what,
      e.outcome ?? "",
      e.exitCode ?? "",
      e.approvedBy ?? "",
      e.taskId ?? "",
      e.changeId ?? "",
      e.detail ?? "",
      e.hash,
    ]
      .map(csvCell)
      .join(","),
  );
  return [header, ...rows].join("\n");
}

function mdCell(value: unknown): string {
  const s = value === undefined || value === null ? "" : String(value);
  return s.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

/** Formats audit entries and chain verification status as a Markdown compliance report. */
export function formatAuditMarkdown(
  entries: AuditEntryView[],
  verification?: AuditVerificationView,
  options?: { title?: string },
): string {
  const title = options?.title ?? "sshs3 Audit Compliance Report";
  const lines: string[] = [
    `# ${title}`,
    "",
    `- **Generated:** ${new Date().toISOString()}`,
    `- **Entries Included:** ${entries.length}`,
  ];
  if (verification) {
    lines.push(
      `- **Hash Chain Status:** ${verification.ok ? "VERIFIED" : `BROKEN at #${verification.problem?.seq ?? "?"}`}`,
      `- **Total Chained Entries:** ${verification.entries}`,
    );
    if (verification.problem?.text) {
      lines.push(`- **Problem Detail:** ${verification.problem.text}`);
    }
    if (verification.anchors) {
      lines.push(
        `- **Team Bucket Anchors:** ${verification.anchors.held}/${verification.anchors.checked} held${
          verification.anchors.coveredSeq !== undefined
            ? ` (covered up to #${verification.anchors.coveredSeq})`
            : ""
        }`,
      );
    }
  }
  lines.push(
    "",
    "| Seq | Timestamp (UTC) | Tool / Kind | Actor | Host / Target | Action | Status | Approved By | SHA-256 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const e of entries) {
    lines.push(
      `| #${e.seq} | ${new Date(e.at).toISOString()} | ${mdCell(KIND_TEXT[e.kind] ?? e.kind)} | ${mdCell(e.actor)} | ${mdCell(e.target ?? "-")} | ${mdCell(e.what)} | ${mdCell(e.outcome ?? "-")}${e.exitCode !== undefined && e.exitCode !== 0 ? ` (exit ${e.exitCode})` : ""} | ${mdCell(e.approvedBy ?? "-")} | \`${e.hash.slice(0, 12)}\` |`,
    );
  }
  return lines.join("\n");
}

/** Triggers a client-side file download from an in-memory string. */
export function downloadTextFile(
  filename: string,
  content: string,
  mime: string,
): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

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
  const [verification, setVerification] = useState<
    AuditVerificationView | undefined
  >();
  const [checkedAt, setCheckedAt] = useState(0);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const [copiedMsg, setCopiedMsg] = useState("");

  const [filter, setFilter] = useState("");
  const [actorFilter, setActorFilter] = useState("");
  const [toolFilter, setToolFilter] = useState("");
  const [hostFilter, setHostFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [limit, setLimit] = useState(200);

  const load = useCallback(async () => {
    setBusy(true);
    setProblem("");
    try {
      const audit = (await request({ action: "audit-read", limit })).reply
        ?.audit;
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
      const bytes = Uint8Array.from(atob(file.dataBase64), (c) =>
        c.charCodeAt(0),
      );
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

  const actors = useMemo(
    () => [...new Set(entries.map((e) => e.actor).filter(Boolean))].sort(),
    [entries],
  );
  const tools = useMemo(
    () => [...new Set(entries.map((e) => e.kind).filter(Boolean))].sort(),
    [entries],
  );
  const hosts = useMemo(
    () =>
      [
        ...new Set(
          entries.map((e) => e.target).filter((x): x is string => Boolean(x)),
        ),
      ].sort(),
    [entries],
  );
  const statuses = useMemo(
    () =>
      [
        ...new Set(
          entries.map((e) => e.outcome).filter((x): x is string => Boolean(x)),
        ),
      ].sort(),
    [entries],
  );

  const q = filter.trim().toLowerCase();
  const shown = entries.filter((e) => {
    if (actorFilter && e.actor !== actorFilter) return false;
    if (toolFilter && e.kind !== toolFilter) return false;
    if (hostFilter && e.target !== hostFilter) return false;
    if (statusFilter && e.outcome !== statusFilter) return false;
    if (
      q &&
      ![
        e.actor,
        e.target,
        e.what,
        e.outcome,
        e.approvedBy,
        e.detail,
        e.kind,
      ].some((x) => x?.toLowerCase().includes(q))
    ) {
      return false;
    }
    return true;
  });

  const hasFilters = Boolean(
    filter || actorFilter || toolFilter || hostFilter || statusFilter,
  );

  const exportCsv = (): void => {
    const day = new Date().toISOString().slice(0, 10);
    downloadTextFile(
      `sshs3-audit-report-${day}.csv`,
      formatAuditCsv(shown),
      "text/csv;charset=utf-8",
    );
  };

  const exportMarkdown = (): void => {
    const day = new Date().toISOString().slice(0, 10);
    downloadTextFile(
      `sshs3-audit-report-${day}.md`,
      formatAuditMarkdown(shown, verification),
      "text/markdown;charset=utf-8",
    );
  };

  const copyMarkdown = async (): Promise<void> => {
    const md = formatAuditMarkdown(shown, verification);
    try {
      await navigator.clipboard?.writeText(md);
      setCopiedMsg("Copied Markdown");
      setTimeout(() => setCopiedMsg(""), 2000);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  };

  const recordingOf = (
    e: AuditEntryView,
  ): { id: string; title: string } | undefined => {
    const task = e.taskId ? hub.tasks.find((t) => t.id === e.taskId) : undefined;
    // The seal of a recording names the recording itself.
    if (e.kind === "recording" && e.changeId)
      return { id: e.changeId, title: task?.title ?? e.what };
    return task?.recordingId
      ? { id: task.recordingId, title: task.title }
      : undefined;
  };
  const when2 = (at: number): string =>
    new Date(at).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

  // Derive SIEM / Webhook / S3 Anchor sink status from hub configuration.
  const webhookSinks = (hub.notifications?.channels ?? []).filter(
    (c) => c.kind === "webhook" && c.enabled,
  );
  const failedSink = webhookSinks.find((c) => c.last?.ok === false);
  const siemBadge =
    webhookSinks.length > 0
      ? {
          text: `SIEM sink: ${webhookSinks.map((c) => c.name).join(", ")}${failedSink ? " (delivery error)" : ""}`,
          tone: failedSink ? "ai-badge-danger" : "ai-badge-success",
        }
      : hub.s3Workspace?.connected
        ? {
            text: `SIEM sink: S3 anchors (${hub.s3Workspace.bucket})`,
            tone: "ai-badge-success",
          }
        : {
            text: "SIEM sink: local only",
            tone: "",
          };

  // A green "verified" over nothing reads as proof. The demo lab writes no
  // audit entries at all, and an empty log has nothing to verify.
  const demo = hub.demoMode === true;
  const emptyLog = verification?.ok === true && verification.entries === 0;
  // A demo log can still hold a few setting changes; then the real verdict is shown with a note.
  const demoEmpty = demo && (!verification || emptyLog);
  const neutral = demoEmpty || emptyLog;
  const noEntries = entries.length === 0;

  return (
    <div className="ai-audit" data-testid="audit-log">
      <div
        className={`ai-audit-verdict ${verification && !neutral ? (verification.ok ? "ai-audit-ok" : "ai-audit-broken") : ""}`}
        role="status"
        data-testid="audit-verdict"
      >
        <div>
          <div className="ai-tags" style={{ marginBottom: 6 }}>
            {!neutral && (
              <span
                className={`ai-badge ${
                  !verification
                    ? ""
                    : verification.ok
                      ? "ai-badge-success"
                      : "ai-badge-danger"
                }`}
                data-testid="audit-chain-badge"
              >
                {!verification
                  ? "Chain verification pending"
                  : verification.ok
                    ? `Chain verified · ${verification.entries} entries`
                    : `Chain broken at #${verification.problem?.seq ?? "?"}`}
              </span>
            )}
            <span className={`ai-badge ${siemBadge.tone}`} data-testid="siem-sink-badge">
              {siemBadge.text}
            </span>
          </div>
          {demoEmpty ? (
            <span data-testid="audit-demo-notice">
              Demo lab: audit entries are recorded locally inside the isolated demo workspace and are never sent outside.
              Run a command or start an incident to see hash-chained entries here.
            </span>
          ) : emptyLog ? (
            <span data-testid="audit-empty-notice">
              The log is empty. There is nothing to verify yet.
            </span>
          ) : !verification ? (
            <span>Checking the log…</span>
          ) : verification.ok ? (
            <span>
              <strong>The log holds.</strong> All {verification.entries} entries
              hash to what they say, each follows the one before it
              {verification.anchors && verification.anchors.checked > 0
                ? `, and all ${verification.anchors.checked} anchors in the team bucket match it and follow each other.`
                : ". There is no team bucket to anchor it in, so a cut from its very end would not show."}
              {verification.anchors?.coveredSeq !== undefined &&
                verification.anchors.lastAt !== undefined && (
                  <>
                    {" "}
                    Entries up to #{verification.anchors.coveredSeq} are
                    anchored (last {when2(verification.anchors.lastAt)})
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
              <strong>The log does not hold.</strong> {verification.problem?.text}{" "}
              Everything before entry {verification.problem?.seq} still checks
              out.
            </span>
          )}
          {demo && !demoEmpty && (
            <span data-testid="audit-demo-notice">
              {" "}
              Demo lab: audit entries are recorded locally inside the isolated demo workspace and are never sent outside.
            </span>
          )}
        </div>
        <span className="ai-audit-actions">
          {checkedAt > 0 && (
            <small>checked {new Date(checkedAt).toLocaleTimeString()}</small>
          )}
          <button
            type="button"
            data-testid="verify-audit-chain"
            aria-label="Verify audit hash chain"
            onClick={() => void load()}
            disabled={busy}
          >
            {busy ? "Verifying…" : "Verify chain"}
          </button>
          <button
            type="button"
            onClick={exportCsv}
            disabled={shown.length === 0}
          >
            Export CSV
          </button>
          <button
            type="button"
            onClick={exportMarkdown}
            disabled={shown.length === 0}
          >
            Export Markdown
          </button>
          <button
            type="button"
            onClick={() => void copyMarkdown()}
            disabled={shown.length === 0}
          >
            {copiedMsg || "Copy Markdown"}
          </button>
          <button
            type="button"
            onClick={() => void exportLog()}
            disabled={noEntries}
          >
            Export JSONL
          </button>
        </span>
      </div>
      {problem && (
        <p role="alert" className="ai-error">
          {problem}
        </p>
      )}

      {entries.length > 0 && (
        <div className="ai-filter-bar" data-testid="audit-filters">
          <input
            type="search"
            aria-label="Filter the audit log"
            placeholder="Filter by who, server, command, outcome…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <select
            aria-label="Filter by actor"
            value={actorFilter}
            onChange={(e) => setActorFilter(e.target.value)}
          >
            <option value="">All actors</option>
            {actors.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by tool"
            value={toolFilter}
            onChange={(e) => setToolFilter(e.target.value)}
          >
            <option value="">All tools / kinds</option>
            {tools.map((t) => (
              <option key={t} value={t}>
                {KIND_TEXT[t] ?? t}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by host"
            value={hostFilter}
            onChange={(e) => setHostFilter(e.target.value)}
          >
            <option value="">All hosts</option>
            {hosts.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">All statuses</option>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          {hasFilters && (
            <button
              type="button"
              onClick={() => {
                setFilter("");
                setActorFilter("");
                setToolFilter("");
                setHostFilter("");
                setStatusFilter("");
              }}
            >
              Reset filters
            </button>
          )}
        </div>
      )}
      {verification && entries.length === 0 && !demo && (
        <p className="ai-empty">
          Nothing has been written to the log yet. Every command an agent runs,
          every change, file write and approval lands here once it has ended.
        </p>
      )}
      {entries.length > 0 && shown.length === 0 && (
        <p className="ai-empty">Nothing matches.</p>
      )}

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
                      <span
                        className="ai-badge ai-badge-danger"
                        title={verification.problem.text}
                      >
                        the chain breaks here
                      </span>
                    )}
                    <span className="ai-badge">
                      {KIND_TEXT[e.kind] ?? e.kind}
                    </span>
                    {e.outcome && (
                      <span
                        className={`ai-badge ${OUTCOME_TONE[e.outcome] ?? ""}`}
                      >
                        {e.outcome}
                        {e.exitCode !== undefined && e.exitCode !== 0
                          ? ` · exit ${e.exitCode}`
                          : ""}
                      </span>
                    )}
                  </span>
                </summary>
                <div className="ai-timeline-more">
                  <pre>{e.what}</pre>
                  {e.approvedBy && <p>Decided by: {e.approvedBy}</p>}
                  {e.detail && <p>{e.detail}</p>}
                  <small
                    className="ai-audit-hash"
                    title="This entry's hash. The next entry carries it."
                  >
                    sha256 {e.hash}
                  </small>
                  <span className="ai-audit-actions">
                    {rec && (
                      <button
                        type="button"
                        onClick={() =>
                          onWatch(
                            rec.id,
                            rec.title,
                            e.kind === "recording" ? undefined : e.what,
                          )
                        }
                      >
                        Watch the terminal recording
                      </button>
                    )}
                    {e.taskId && hub.tasks.some((t) => t.id === e.taskId) && (
                      <button
                        type="button"
                        onClick={() => onOpenTask(e.taskId!)}
                      >
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
        <button
          type="button"
          className="ai-more"
          onClick={() => setLimit(limit + 200)}
        >
          Show older entries
        </button>
      )}
    </div>
  );
}
