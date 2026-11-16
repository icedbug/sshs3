import { useState } from "react";
import type {
  HubRequest,
  HubSnapshot,
  KbFinding,
  KbPage,
  KbPageKind,
} from "@shared/types/aiHub";
import { ConfirmButton } from "./ConfirmButton";
import { PublishToConfluence } from "./ConfluenceSources";
import { KINDS, emptyPage, type PageDraft } from "./kbPageDraft";
import { type Act } from "./panelShared";
import { decodeFileRefHref, extractFileRefs, linkFileRefs, type FileRef } from "./reportRefs";
import { RichMarkdownContent } from "./RichMarkdownContent";

export interface KbPageStarterTemplate {
  id: string;
  label: string;
  description: string;
  kind: KbPageKind;
  title: string;
  when: string;
  keys: string[];
  body: string;
}

export const KB_PAGE_STARTER_TEMPLATES: KbPageStarterTemplate[] = [
  {
    id: "linux-incident-runbook",
    label: "Linux Incident Runbook",
    description: "Triage CPU, RAM/OOM, disk saturation, and failing systemd units.",
    kind: "procedure",
    title: "Linux Incident Triage Runbook",
    when: "When a Linux host shows high load, OOM kills, disk saturation, or failed systemd units",
    keys: ["oom-killer", "journalctl -p err", "ENOSPC", "systemctl --failed"],
    body: [
      "## When to use this",
      "Use when an alert fires for CPU saturation, memory pressure, disk full, or a crashed service.",
      "",
      "## Steps",
      "1. Check failed services and recent errors: `systemctl --failed` and `journalctl -p err -n 100 --no-pager`",
      "2. Inspect kernel OOM and hardware events: `dmesg -T | grep -i -E 'oom|error|warn' | tail -n 50`",
      "3. Check filesystem and inode usage: `df -hT && df -Pi`",
      "4. Inspect listening sockets and logs in `/var/log/syslog:1`",
      "",
      "## Verify",
      "- `systemctl is-active <service>` reports `active`",
      "- PSI pressure in `/proc/pressure/memory:1` stabilizes below threshold",
      "",
      "## Do not",
      "- Do not restart stateful databases without checking replication lag first.",
    ].join("\n"),
  },
  {
    id: "postgres-failover-sop",
    label: "PostgreSQL Failover SOP",
    description: "Verify primary health, check replication lag, and safely promote a standby.",
    kind: "procedure",
    title: "PostgreSQL Failover SOP",
    when: "When the PostgreSQL primary is unreachable or failover/promotion is required",
    keys: ["pg_isready", "pg_stat_replication", "patroni", "failover"],
    body: [
      "## When to use this",
      "Follow this procedure before promoting a standby or failing over PostgreSQL traffic.",
      "",
      "## Steps",
      "1. Check primary reachability: `pg_isready -h pg-primary -p 5432`",
      "2. Inspect Patroni / cluster state and `/etc/postgresql/16/main/postgresql.conf:1`",
      "3. Verify replica replay lag before promotion: `SELECT now() - pg_last_xact_replay_timestamp();`",
      "4. Promote healthy replica or run `patronictl switchover` after confirming fencing.",
      "",
      "## Verify",
      "- Confirm read/write queries succeed on the new primary and old primary is fenced.",
      "",
      "## Do not",
      "- Never force-promote without fencing the old primary (split-brain risk).",
    ].join("\n"),
  },
  {
    id: "cluster-architecture-map",
    label: "Cluster Architecture Map",
    description: "Document hosts, VIPs, storage mounts, and upstream service dependencies.",
    kind: "system",
    title: "Cluster Architecture Map",
    when: "When orienting on cluster topology, ingress VIPs, databases, and storage dependencies",
    keys: ["topology", "vip", "ingress", "dependencies"],
    body: [
      "## What it is",
      "Reference map of cluster nodes, network ingress, and stateful backends.",
      "",
      "## Where it runs",
      "- Ingress / Reverse proxy: `/etc/nginx/nginx.conf:1`",
      "- Application tier: systemd units under `/etc/systemd/system`",
      "",
      "## What depends on it",
      "- Upstream APIs -> PostgreSQL primary/replica -> Shared block/S3 storage",
      "",
      "## What normal looks like",
      "- All VIPs bound, zero failed systemd units, replication lag < 1s.",
    ].join("\n"),
  },
];

const ago = (at: number): string => {
  const mins = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} d ago`;
};

const LINT_FINDING_KINDS = new Set<KbFinding["kind"]>([
  "stale",
  "dead-target",
  "lost-source",
  "source-changed",
  "source-unreachable",
  "unused",
]);

/** The pages agents read: what the assistant wrote from the sources and from finished work, and what people wrote. */
export function KbPages({
  hub,
  act,
  request,
  draft,
  setDraft,
  open,
  setOpen,
  onOpenSource,
  onOpenFileRef,
  onImportMarkdown,
}: {
  hub: HubSnapshot;
  act: Act;
  request: (r: HubRequest) => Promise<HubSnapshot>;
  draft: PageDraft | undefined;
  setDraft: (d: PageDraft | undefined) => void;
  open: KbPage | undefined;
  setOpen: (p: KbPage | undefined) => void;
  onOpenSource: (docId: string) => void;
  onOpenFileRef?: (ref: FileRef) => void;
  onImportMarkdown?: () => void;
}): JSX.Element {
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState("");
  const [openedRefNotice, setOpenedRefNotice] = useState<string>("");
  const pages = hub.kbPages ?? [];
  const findings = hub.kbFindings ?? [];
  const names = Array.from(
    new Set((hub.workspaceServers ?? []).flatMap((s) => [s.cluster, s.name]).filter((x): x is string => Boolean(x))),
  );
  const whole = async (id: string): Promise<KbPage | undefined> => {
    setProblem("");
    try {
      return (await request({ action: "kb-page-read", id })).reply?.kbPage;
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  };

  const handleFileRefClick = (ref: FileRef): void => {
    setOpenedRefNotice(ref.raw);
    onOpenFileRef?.(ref);
  };

  const pageHealthSummary = (() => {
    let healthy = 0;
    let unverified = 0;
    let lintWarnings = 0;
    for (const p of pages) {
      const pFindings = findings.filter((f) => f.pageId === p.id || f.otherPageId === p.id);
      if (p.unverified) unverified++;
      if (pFindings.length > 0) lintWarnings++;
      if (!p.unverified && pFindings.length === 0) healthy++;
    }
    return { healthy, unverified, lintWarnings };
  })();

  return (
    <>
      <div className="ai-section-head">
        <h3>
          Pages <span className="ai-count">{pages.length}</span>
        </h3>
        <button type="button" className="ai-btn-accent" onClick={() => setDraft(draft ? undefined : emptyPage())}>
          {draft ? "Close" : "Write a page"}
        </button>
      </div>
      <p className="ai-hint">
        This is what agents read. Every agent carries the list of pages and opens the one that covers what it is about
        to do. The assistant writes them from the sources you drop in and from what was confirmed in finished work;
        a page you edit yourself is added to from then on, never rewritten.
      </p>
      {pages.length > 0 && (
        <div className="ai-tags" data-testid="kb-pages-health" style={{ marginBottom: 8 }}>
          <span className="ai-badge ai-badge-success">
            {pageHealthSummary.healthy} healthy
          </span>
          {pageHealthSummary.unverified > 0 && (
            <span className="ai-badge ai-badge-danger">
              {pageHealthSummary.unverified} unverified
            </span>
          )}
          {pageHealthSummary.lintWarnings > 0 && (
            <span className="ai-badge ai-badge-mode">
              {pageHealthSummary.lintWarnings} lint notice{pageHealthSummary.lintWarnings === 1 ? "" : "s"}
            </span>
          )}
        </div>
      )}
      {openedRefNotice && (
        <p className="ai-hint" role="status" data-testid="kb-page-ref-status">
          Opened reference: <code className="ai-mono">{openedRefNotice}</code>
        </p>
      )}
      {problem && <p className="ai-error">{problem}</p>}

      {draft && (
        <form
          className="ai-form ai-card"
          data-testid="kb-page-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft.title.trim() || !draft.when.trim() || !draft.body.trim()) return;
            void act({
              action: "kb-page-save",
              page: {
                id: draft.id,
                kind: draft.kind,
                title: draft.title,
                when: draft.when,
                body: draft.body,
                targets: draft.targets
                  .split(",")
                  .map((t) => t.trim())
                  .filter(Boolean),
                keys: draft.keys
                  .split(/[,\n]/)
                  .map((k) => k.trim())
                  .filter(Boolean),
              },
            }).then((next) => {
              if (next) {
                setDraft(undefined);
                setOpen(undefined);
              }
            });
          }}
        >
          <strong>{draft.id ? "Edit page" : "Write a page"}</strong>
          <div className="ai-form-row">
            <label>
              Kind
              <select
                value={draft.kind}
                disabled={Boolean(draft.id)}
                onChange={(e) => {
                  const kind = e.target.value as KbPageKind;
                  const untouched = KINDS.some((k) => k.template === draft.body) || !draft.body.trim();
                  setDraft({ ...draft, kind, body: untouched ? KINDS.find((k) => k.kind === kind)!.template : draft.body });
                }}
              >
                {KINDS.map((k) => (
                  <option key={k.kind} value={k.kind}>
                    {k.title} — {k.hint}
                  </option>
                ))}
              </select>
            </label>
            <label>
              About (clusters or servers, comma-separated)
              <input
                list="ai-kb-page-targets"
                placeholder="Empty: general"
                value={draft.targets}
                onChange={(e) => setDraft({ ...draft, targets: e.target.value })}
              />
              <datalist id="ai-kb-page-targets">
                {names.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
            </label>
          </div>
          <label>
            Title
            <input
              required
              autoFocus
              placeholder="Nightly backup runs long"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </label>
          <label>
            When should an agent open this?
            <input
              required
              placeholder="When the nightly backup is still running in the morning"
              value={draft.when}
              onChange={(e) => setDraft({ ...draft, when: e.target.value })}
            />
            <small>This one line is all an agent sees until it opens the page. Start with the situation.</small>
          </label>
          <label>
            Search phrases (optional, comma-separated)
            <input
              placeholder="ENOSPC, aggr is full, df shows 100%"
              value={draft.keys}
              onChange={(e) => setDraft({ ...draft, keys: e.target.value })}
            />
            <small>
              What an agent would type when it needs this page: an error message as it appears, the name of a command, a
              file or a service. A search for one of these finds the page even when its title says it differently.
            </small>
          </label>
          <label>
            Page (Markdown)
            <textarea
              required
              rows={14}
              className="ai-mono"
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            />
          </label>
          <div className="ai-card-actions">
            <button type="submit" className="ai-btn-emerald">
              {draft.id ? "Save changes" : "Save page"}
            </button>
            <button type="button" onClick={() => setDraft(undefined)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {pages.length === 0 && !draft && (
        <section className="ai-card" data-testid="kb-pages-starters" aria-label="Knowledge base page starter templates">
          <strong>Start with a 1-click knowledge page</strong>
          <p className="ai-hint">
            Agents read these pages before acting. Pick a starter template to create your first page immediately, or
            import existing Markdown runbooks.
          </p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
              gap: 8,
              marginTop: 8,
            }}
          >
            {KB_PAGE_STARTER_TEMPLATES.map((tpl) => (
              <div
                key={tpl.id}
                style={{
                  padding: 10,
                  borderRadius: 8,
                  border: "1px solid var(--ai-line, rgba(148, 163, 184, 0.2))",
                  display: "grid",
                  gap: 6,
                }}
              >
                <div>
                  <strong>{tpl.label}</strong>
                  <p className="ai-hint" style={{ margin: "4px 0 0" }}>
                    {tpl.description}
                  </p>
                </div>
                <button
                  type="button"
                  className="ai-btn-accent"
                  data-testid={`kb-page-starter-${tpl.id}`}
                  onClick={() =>
                    void act({
                      action: "kb-page-save",
                      page: {
                        kind: tpl.kind,
                        title: tpl.title,
                        when: tpl.when,
                        body: tpl.body,
                        targets: [],
                        keys: tpl.keys,
                      },
                    })
                  }
                >
                  Use {tpl.label}
                </button>
              </div>
            ))}
            <div
              style={{
                padding: 10,
                borderRadius: 8,
                border: "1px dashed var(--ai-line-strong, rgba(148, 163, 184, 0.35))",
                display: "grid",
                gap: 6,
              }}
            >
              <div>
                <strong>Import Markdown</strong>
                <p className="ai-hint" style={{ margin: "4px 0 0" }}>
                  Upload local `.md` runbooks or start a blank page from a template.
                </p>
              </div>
              <button
                type="button"
                data-testid="kb-page-starter-import-markdown"
                onClick={() => (onImportMarkdown ? onImportMarkdown() : setDraft(emptyPage()))}
              >
                Import Markdown
              </button>
            </div>
          </div>
        </section>
      )}

      {KINDS.map((group) => {
        const list = pages.filter((p) => p.kind === group.kind).sort((a, b) => a.title.localeCompare(b.title));
        if (list.length === 0) return null;
        return (
          <section key={group.kind} className="ai-group" data-testid={`kb-pages-${group.kind}`}>
            <h4>
              {group.title} <span className="ai-count">{list.length}</span>
            </h4>
            {list.map((p) => {
              const isOpen = open?.id === p.id;
              const last = p.history[0];
              const canUndo = last && (Boolean(last.previous) || (p.revision === 1 && p.history.length === 1));
              const docSources = p.sources.filter((s) => !s.docId.startsWith("task:"));
              const pageFindings = findings.filter((f) => f.pageId === p.id || f.otherPageId === p.id);
              const hasContradiction = pageFindings.some((f) => f.kind === "contradiction");
              const hasRollback = pageFindings.some((f) => f.kind === "rolled-back");
              const lintFinding = pageFindings.find((f) => LINT_FINDING_KINDS.has(f.kind));
              const openFileRefs = isOpen ? extractFileRefs(open.body) : [];
              return (
                <article className="ai-card ai-page" key={p.id} data-testid={`kb-page-${p.id}`}>
                  <div className="ai-card-head">
                    <div>
                      <strong>{p.title}</strong>
                      <small className="ai-page-when">{p.when}</small>
                    </div>
                    <div className="ai-tags">
                      {p.targets.map((t) => (
                        <span key={t} className="ai-badge ai-badge-cluster">
                          {t}
                        </span>
                      ))}
                      {p.editedByPerson && (
                        <span className="ai-badge" title="A person edited this page: the assistant adds to it and does not rewrite it">
                          hand-edited
                        </span>
                      )}
                      {p.proven ? (
                        <span
                          className="ai-badge ai-badge-ok"
                          title={`A run that worked from this page made a change that passed its own check, ${ago(p.lastProvenAt ?? p.updatedAt)}`}
                        >
                          held up ×{p.proven}
                        </span>
                      ) : null}
                      {p.opens ? (
                        <span className="ai-badge" title={`Last opened by an agent ${ago(p.lastOpenedAt ?? p.updatedAt)}`}>
                          opened ×{p.opens}
                        </span>
                      ) : null}
                      {p.unverified ? (
                        <span
                          className="ai-badge ai-badge-danger"
                          title="Lines on this page were in none of its sources: the assistant may have written them itself"
                        >
                          unverified
                        </span>
                      ) : null}
                      {hasContradiction && (
                        <span className="ai-badge ai-badge-danger" title="Another page states something incompatible">
                          contradiction
                        </span>
                      )}
                      {hasRollback && (
                        <span className="ai-badge ai-badge-danger" title="A run using this page had to be rolled back">
                          rolled back
                        </span>
                      )}
                      {lintFinding && (
                        <span className="ai-badge ai-badge-mode" title={lintFinding.text}>
                          lint: {lintFinding.kind}
                        </span>
                      )}
                      {!p.unverified && pageFindings.length === 0 && (
                        <span
                          className="ai-badge ai-badge-success"
                          data-testid={`kb-page-health-${p.id}`}
                          title="No lint or verification issues found"
                        >
                          healthy
                        </span>
                      )}
                      {(p.alerts ?? []).map((a) => (
                        <span key={a} className="ai-badge" title="The page a run worked from on a ticket for this alert">
                          alert: {a}
                        </span>
                      ))}
                    </div>
                  </div>
                  {isOpen ? (
                    <div
                      className="ai-doc-body"
                      onClick={(e) => {
                        const target = e.target as HTMLElement | null;
                        const anchor = target?.closest?.('a[href^="#file-"]');
                        if (!anchor) return;
                        const decoded = decodeFileRefHref(anchor.getAttribute("href") ?? undefined);
                        if (!decoded) return;
                        e.preventDefault();
                        handleFileRefClick(decoded);
                      }}
                    >
                      {open.unverified && (
                        <p className="ai-error" data-testid={`kb-unverified-${p.id}`}>
                          {open.unverified.commands.length > 0 && (
                            <>
                              These lines are in none of the page&apos;s sources:{" "}
                              {open.unverified.commands.map((c) => (
                                <code key={c}>{c}</code>
                              ))}
                              .{" "}
                            </>
                          )}
                          {open.unverified.citations.length > 0 && (
                            <>The page names {open.unverified.citations.join(", ")}, which it does not rest on. </>
                          )}
                          Check them against the system; agents are told about this when they open the page.
                        </p>
                      )}
                      <RichMarkdownContent text={linkFileRefs(open.body)} />
                      {openFileRefs.length > 0 && (
                        <div className="ai-tags" data-testid={`kb-page-refs-${p.id}`} style={{ marginTop: 8 }}>
                          <small className="ai-muted">Refs:</small>
                          {openFileRefs.map((ref) => (
                            <button
                              key={ref.raw}
                              type="button"
                              className="ai-chip ai-mono"
                              title={ref.host ? `Open ${ref.path} on ${ref.host}` : `Open ${ref.path}`}
                              onClick={() => handleFileRefClick(ref)}
                            >
                              {ref.raw}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : null}
                  {(p.keys ?? []).length > 0 && (
                    <small className="ai-muted">Also found by: {(p.keys ?? []).join(" · ")}</small>
                  )}
                  <small className="ai-last-run">
                    {p.sources.length > 0 ? "Rests on " : "Written by hand"}
                    {p.sources.map((s, i) => (
                      <span key={s.docId}>
                        {i ? ", " : ""}
                        {s.docId.startsWith("task:") ? (
                          s.title
                        ) : (
                          <button type="button" className="ai-linklike" onClick={() => onOpenSource(s.docId)}>
                            {s.title}
                          </button>
                        )}
                      </span>
                    ))}
                    {last ? ` · ${last.by === "assistant" ? "the assistant" : last.by}, ${ago(last.at)}: ${last.summary}` : ""}
                  </small>
                  <div className="ai-card-actions">
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      onClick={() => (isOpen ? setOpen(undefined) : void whole(p.id).then((full) => full && setOpen(full)))}
                    >
                      {isOpen ? "Fold" : "Read"}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void whole(p.id).then(
                          (full) =>
                            full &&
                            setDraft({
                              id: full.id,
                              kind: full.kind,
                              title: full.title,
                              when: full.when,
                              targets: full.targets.join(", "),
                              keys: (full.keys ?? []).join(", "),
                              body: full.body,
                            }),
                        )
                      }
                    >
                      Edit
                    </button>
                    {canUndo && last.by === "assistant" && (
                      <button
                        type="button"
                        title={last.previous ? "Takes back the assistant's latest change" : "Removes the page the assistant created"}
                        onClick={() => void act({ action: "kb-page-undo", id: p.id }).then(() => setOpen(undefined))}
                      >
                        {last.previous ? "Undo the last change" : "Undo (remove the page)"}
                      </button>
                    )}
                    {docSources.length > 0 && (
                      <button
                        type="button"
                        disabled={busy === p.id || (hub.kbWork?.rebuilding ?? []).includes(p.id)}
                        title="Has the assistant read the page's sources again and update the page"
                        onClick={() => {
                          setBusy(p.id);
                          void act({ action: "kb-page-rebuild", id: p.id }).finally(() => setBusy(""));
                        }}
                      >
                        {busy === p.id || (hub.kbWork?.rebuilding ?? []).includes(p.id) ? "Reading its sources…" : "Update from its sources"}
                      </button>
                    )}
                    {hub.kbWork?.rebuilt?.[p.id] && !(hub.kbWork?.rebuilding ?? []).includes(p.id) && (
                      <small
                        className={hub.kbWork.rebuilt[p.id].error ? "ai-bad" : "ai-muted"}
                        role="status"
                        data-testid={`kb-rebuilt-${p.id}`}
                      >
                        {hub.kbWork.rebuilt[p.id].error
                          ? `Could not be read again: ${hub.kbWork.rebuilt[p.id].error}`
                          : hub.kbWork.rebuilt[p.id].changed
                            ? "Read again and updated."
                            : "Read again; the page already said what its sources say."}
                      </small>
                    )}
                    <PublishToConfluence page={p} hub={hub} act={act} />
                    <span className="ai-spacer" />
                    <ConfirmButton
                      label="Delete"
                      confirmLabel="Delete this page for the team?"
                      onConfirm={() =>
                        void act({ action: "kb-page-delete", id: p.id }).then((next) => {
                          if (next && open?.id === p.id) setOpen(undefined);
                        })
                      }
                    />
                  </div>
                </article>
              );
            })}
          </section>
        );
      })}
    </>
  );
}

const FINDING: Record<KbFinding["kind"], string> = {
  "dead-target": "About something that is gone",
  "lost-source": "Its source was removed",
  "source-changed": "Its source has changed",
  "source-unreachable": "Its source could not be fetched",
  stale: "Not changed in a long time",
  unused: "Never opened",
  "unused-source": "No page rests on it",
  gap: "A gap",
  contradiction: "Pages disagree",
  unverified: "Not found in its sources",
  "rolled-back": "A run from it was taken back",
};

/** What a person should look at: gaps, pages that disagree, pages about what no longer exists. */
export function KbReview({
  hub,
  act,
  onOpenPage,
  onOpenSource,
  onWritePage,
}: {
  hub: HubSnapshot;
  act: Act;
  onOpenPage: (id: string) => void;
  onOpenSource: (docId: string) => void;
  onWritePage: (title: string) => void;
}): JSX.Element {
  const [checking, setChecking] = useState(false);
  const [answering, setAnswering] = useState("");
  const findings = hub.kbFindings ?? [];
  const pages = hub.kbPages ?? [];
  return (
    <>
      <div className="ai-section-head">
        <h3>
          To review <span className="ai-count">{findings.length}</span>
        </h3>
        <button
          type="button"
          disabled={checking || hub.kbWork?.checkingContradictions || pages.length < 2}
          title="Compares pages about the same systems and lists where they state things that cannot both be true"
          onClick={() => {
            setChecking(true);
            void act({ action: "kb-check-contradictions" }).finally(() => setChecking(false));
          }}
        >
          {checking || hub.kbWork?.checkingContradictions ? "Comparing pages…" : "Check for contradictions"}
        </button>
        {!hub.kbWork?.checkingContradictions && hub.kbWork?.lastCheck && (
          <small className={hub.kbWork.lastCheck.error ? "ai-bad" : "ai-muted"} role="status" data-testid="kb-last-check">
            {hub.kbWork.lastCheck.error
              ? `The last comparison did not finish: ${hub.kbWork.lastCheck.error}`
              : hub.kbWork.lastCheck.found
                ? `The last comparison read ${hub.kbWork.lastCheck.compared ?? 0} of ${hub.kbWork.lastCheck.of ?? 0} pairs of pages and found ${hub.kbWork.lastCheck.found} place${hub.kbWork.lastCheck.found === 1 ? "" : "s"} where they disagree.`
                : `The last comparison read ${hub.kbWork.lastCheck.compared ?? 0} of ${hub.kbWork.lastCheck.of ?? 0} pairs of pages and found none that disagree.${(hub.kbWork.lastCheck.of ?? 0) > (hub.kbWork.lastCheck.compared ?? 0) ? " Check again to go on with the next pairs." : ""}`}
          </small>
        )}
      </div>
      <p className="ai-hint">
        What agents asked and found nothing on, pages about systems that are gone, pages nothing backs any more.
        Agents act on the pages, so what is wrong here goes wrong there.
      </p>
      {findings.length === 0 && (
        <div className="ai-card" data-testid="kb-review-healthy">
          <div className="ai-tags">
            <span className="ai-badge ai-badge-success">All checks passing</span>
            <small className="ai-muted">No gaps, contradictions, stale pages, or broken sources to review right now.</small>
          </div>
        </div>
      )}
      <div className="ai-rows" data-testid="kb-findings" hidden={findings.length === 0}>
        {findings.map((f) => (
          <div className="ai-row ai-finding" key={f.id} data-testid={`kb-finding-${f.kind}`}>
            <div>
              <strong>{f.text}</strong>
              <small>
                {FINDING[f.kind]}
                {f.detail ? ` · ${f.detail}` : ""}
              </small>
            </div>
            <div className="ai-tags">
              {f.kind === "gap" && (
                <>
                  <button
                    type="button"
                    className="ai-btn-accent"
                    onClick={() => onWritePage(/“(.+?)”/.exec(f.text)?.[1] ?? "")}
                  >
                    Write the page
                  </button>
                  {answering === f.id ? (
                    <select
                      autoFocus
                      aria-label="The page that answers this"
                      defaultValue=""
                      onChange={(e) => {
                        const pageId = e.target.value;
                        setAnswering("");
                        if (pageId) void act({ action: "kb-gap-answered", id: f.id, pageId });
                      }}
                    >
                      <option value="">Which page answers it?</option>
                      {pages.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.title}
                        </option>
                      ))}
                    </select>
                  ) : (
                    pages.length > 0 && (
                      <button
                        type="button"
                        title="The question's own words become one of that page's search phrases, so the same question finds it next time"
                        onClick={() => setAnswering(f.id)}
                      >
                        A page answers this
                      </button>
                    )
                  )}
                </>
              )}
              {f.kind === "unverified" && f.pageId && (
                <button
                  type="button"
                  className="ai-btn-emerald"
                  title="The lines are right: the page stops calling them unverified and agents are no longer warned"
                  onClick={() => void act({ action: "kb-finding-dismiss", id: f.id })}
                >
                  I checked them, they are right
                </button>
              )}
              {f.kind === "source-changed" && f.pageId && (
                <button type="button" onClick={() => void act({ action: "kb-page-rebuild", id: f.pageId! })}>
                  Update the page from its sources
                </button>
              )}
              {f.pageId && (
                <button type="button" onClick={() => onOpenPage(f.pageId!)}>
                  Open the page
                </button>
              )}
              {f.otherPageId && (
                <button type="button" onClick={() => onOpenPage(f.otherPageId!)}>
                  Open the other
                </button>
              )}
              {f.docId && (
                <button type="button" onClick={() => onOpenSource(f.docId!)}>
                  Open the source
                </button>
              )}
              {f.kind === "unused-source" && f.docId && (
                <button type="button" onClick={() => void act({ action: "kb-reread", id: f.docId! })}>
                  Read it again
                </button>
              )}
            </div>
            {f.kind !== "unverified" && (
              <button type="button" title="Hide this" onClick={() => void act({ action: "kb-finding-dismiss", id: f.id })}>
                Dismiss
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
