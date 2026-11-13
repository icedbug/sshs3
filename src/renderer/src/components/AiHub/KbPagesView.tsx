import { useState } from "react";
import type {
  HubRequest,
  HubSnapshot,
  KbFinding,
  KbPage,
  KbPageKind,
} from "@shared/types/aiHub";
import { ConfirmButton } from "./ConfirmButton";
import { KINDS, emptyPage, type PageDraft } from "./kbPageDraft";
import { type Act } from "./panelShared";
import { RichMarkdownContent } from "./RichMarkdownContent";

const ago = (at: number): string => {
  const mins = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} d ago`;
};

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
}: {
  hub: HubSnapshot;
  act: Act;
  request: (r: HubRequest) => Promise<HubSnapshot>;
  draft: PageDraft | undefined;
  setDraft: (d: PageDraft | undefined) => void;
  open: KbPage | undefined;
  setOpen: (p: KbPage | undefined) => void;
  onOpenSource: (docId: string) => void;
}): JSX.Element {
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState("");
  const pages = hub.kbPages ?? [];
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
        <p className="ai-empty">
          No pages yet. Drop in what your team already has and the assistant writes the first ones: how a system is
          set up, a procedure, how to troubleshoot a symptom. Or write one yourself.
        </p>
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
                      {p.opens ? (
                        <span className="ai-badge" title={`Last opened by an agent ${ago(p.lastOpenedAt ?? p.updatedAt)}`}>
                          opened ×{p.opens}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  {isOpen ? (
                    <div className="ai-doc-body">
                      <RichMarkdownContent text={open.body} />
                    </div>
                  ) : null}
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
                    <span className="ai-spacer" />
                    <ConfirmButton
                      label="Delete"
                      confirmLabel="Delete this page for the team?"
                      onConfirm={() => void act({ action: "kb-page-delete", id: p.id })}
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
  stale: "Not changed in a long time",
  unused: "Never opened",
  "unused-source": "Led to no page",
  gap: "A gap",
  contradiction: "Pages disagree",
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
                ? `The last comparison found ${hub.kbWork.lastCheck.found} place${hub.kbWork.lastCheck.found === 1 ? "" : "s"} where pages disagree.`
                : "The last comparison found no pages that disagree."}
          </small>
        )}
      </div>
      <p className="ai-hint">
        What agents asked and found nothing on, pages about systems that are gone, pages nothing backs any more.
        Agents act on the pages, so what is wrong here goes wrong there.
      </p>
      {findings.length === 0 && <p className="ai-empty">Nothing to look at right now.</p>}
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
                <button
                  type="button"
                  className="ai-btn-accent"
                  onClick={() => onWritePage(/“(.+?)”/.exec(f.text)?.[1] ?? "")}
                >
                  Write the page
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
            <button type="button" title="Hide this" onClick={() => void act({ action: "kb-finding-dismiss", id: f.id })}>
              Dismiss
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
