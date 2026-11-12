import { useEffect, useRef, useState } from "react";
import {
  type HubRequest,
  type HubSnapshot,
  type KbDocument,
  type KbPage,
  type KbSearchHit,
} from "@shared/types/aiHub";
import { hubRequest } from "../../lib/aiHub";
import { isWebBrowserMode } from "../../lib/webClientBridge";
import { ConfirmButton } from "./ConfirmButton";
import { KbPages, KbReview } from "./KbPagesView";
import { emptyPage, type PageDraft } from "./kbPageDraft";
import { type Act } from "./panelShared";
import { RichMarkdownContent } from "./RichMarkdownContent";

interface DocDraft {
  id?: string;
  title: string;
  collection: string;
  cluster: string;
  tags: string;
  content: string;
  sourceType?: KbDocument["sourceType"];
  sourceRef?: string;
}

/** One thing that was dropped in, and what became of it. */
interface InboxItem {
  key: string;
  name: string;
  state: "reading" | "added" | "duplicate" | "failed";
  note?: string;
}

const emptyDoc: DocDraft = { title: "", collection: "", cluster: "", tags: "", content: "" };
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES_AT_ONCE = 300;

const SOURCES: Record<string, string> = {
  folder: "from a folder",
  s3: "from S3",
  url: "from a link",
  upload: "uploaded",
  paste: "pasted",
};

/** The first lines of a text as plain words, for a card that has no summary yet. */
function excerpt(content: string): string {
  const text = content
    .split("\n")
    .map((line) => line.replace(/^#{1,6}\s+/, "").replace(/[`*_>]/g, "").trim())
    .filter(Boolean)
    .slice(1, 4)
    .join(" · ");
  return text.length > 220 ? `${text.slice(0, 220)}…` : text;
}

async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

interface DroppedEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (ok: (f: File) => void, fail: (e: unknown) => void) => void;
  createReader?: () => { readEntries: (ok: (entries: DroppedEntry[]) => void, fail: (e: unknown) => void) => void };
}

/** The files of a drop, folders opened: a dropped folder gives its files, not nothing. */
async function filesOfDrop(data: DataTransfer): Promise<File[]> {
  const entries = Array.from(data.items ?? [])
    .map((item) => (item as unknown as { webkitGetAsEntry?: () => DroppedEntry | null }).webkitGetAsEntry?.())
    .filter((e): e is DroppedEntry => Boolean(e));
  if (entries.length === 0) return Array.from(data.files ?? []);
  const out: File[] = [];
  const walk = async (entry: DroppedEntry, depth: number): Promise<void> => {
    if (out.length >= MAX_FILES_AT_ONCE || depth > 6 || entry.name.startsWith(".") || entry.name === "node_modules") return;
    if (entry.isFile && entry.file) {
      const file = await new Promise<File | undefined>((resolve) => entry.file!(resolve, () => resolve(undefined)));
      if (file) out.push(file);
    } else if (entry.isDirectory && entry.createReader) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise<DroppedEntry[]>((resolve) => reader.readEntries(resolve, () => resolve([])));
        if (batch.length === 0) break;
        for (const child of batch) await walk(child, depth + 1);
      }
    }
  };
  for (const entry of entries) await walk(entry, 0);
  return out;
}

export function KnowledgeBaseView({
  hub,
  act,
  onAttachDoc,
  onRunRunbook,
  request = hubRequest,
}: {
  hub: HubSnapshot;
  act: Act;
  onAttachDoc: (doc: KbDocument) => void;
  onRunRunbook?: (doc: KbDocument) => void;
  /** Requests whose own answer or error this view shows itself. */
  request?: (r: HubRequest) => Promise<HubSnapshot>;
}): JSX.Element {
  const [draft, setDraft] = useState<DocDraft | undefined>();
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [pasted, setPasted] = useState("");
  const [dragging, setDragging] = useState(false);
  const [folderPath, setFolderPath] = useState("");
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<number | undefined>();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<{ query: string; hits: KbSearchHit[]; byMeaning: boolean } | undefined>();
  const [collectionFilter, setCollectionFilter] = useState("");
  const [open, setOpen] = useState<KbDocument | undefined>();
  const [problem, setProblem] = useState("");
  const [limit, setLimit] = useState(40);
  const [tab, setTab] = useState<"pages" | "sources" | "review">(
    (hub.kbPages ?? []).length > 0 ? "pages" : "sources",
  );
  const [pageDraft, setPageDraft] = useState<PageDraft | undefined>();
  const [openPage, setOpenPage] = useState<KbPage | undefined>();
  const picker = useRef<HTMLInputElement>(null);
  const searchSeq = useRef(0);

  const all = hub.kbDocuments ?? [];
  const collections = Array.from(new Set(all.map((d) => d.collection).filter((c): c is string => Boolean(c)))).sort();
  const clusters = Array.from(
    new Set((hub.workspaceServers ?? []).map((s) => s.cluster).filter((c): c is string => Boolean(c))),
  );
  const reading = hub.kbReading;
  const embeddings = hub.config.provider === "openai-compatible" && Boolean(hub.config.embeddingModel);
  const docs = all
    .filter((d) => !collectionFilter || d.collection === collectionFilter)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  // The search the assistant uses, a moment after typing stops.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setHits(undefined);
      return;
    }
    const seq = ++searchSeq.current;
    const timer = setTimeout(() => {
      request({ action: "kb-search", query: q, limit: 8 })
        .then((snap) => {
          if (seq === searchSeq.current) setHits(snap.reply?.kbSearch);
        })
        .catch(() => undefined);
    }, 280);
    return () => clearTimeout(timer);
  }, [query, request]);

  const setItem = (key: string, patch: Partial<InboxItem>): void =>
    setInbox((old) => old.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  const ingest = async (key: string, r: HubRequest): Promise<void> => {
    try {
      const result = (await request(r)).reply?.ingest;
      if (result?.added.length) setItem(key, { state: "added", note: result.added.join(", ") });
      else if (result?.duplicates.length)
        setItem(key, { state: "duplicate", note: `Already here as "${result.duplicates[0]}"` });
      else setItem(key, { state: "failed", note: "Nothing was added." });
    } catch (error) {
      setItem(key, { state: "failed", note: error instanceof Error ? error.message : String(error) });
    }
  };

  const addFiles = async (files: File[]): Promise<void> => {
    const batch = files.slice(0, MAX_FILES_AT_ONCE);
    const items: InboxItem[] = batch.map((f, i) => ({ key: `${Date.now()}-${i}-${f.name}`, name: f.name, state: "reading" }));
    setInbox((old) => [...items, ...old].slice(0, 400));
    for (let i = 0; i < batch.length; i++) {
      const file = batch[i];
      if (file.size > MAX_FILE_BYTES) {
        setItem(items[i].key, { state: "failed", note: "Larger than 10 MB." });
        continue;
      }
      if (file.size === 0) {
        setItem(items[i].key, { state: "failed", note: "The file is empty." });
        continue;
      }
      await ingest(items[i].key, {
        action: "kb-ingest-file",
        name: file.name,
        mime: file.type || undefined,
        dataBase64: await toBase64(file),
      });
    }
  };

  const addPasted = async (): Promise<void> => {
    const text = pasted.trim();
    if (!text) return;
    const isLink = /^https?:\/\/\S+$/i.test(text);
    const key = `${Date.now()}-paste`;
    setInbox((old) => [{ key, name: isLink ? text : `${text.split("\n")[0].slice(0, 60)}…`, state: "reading" as const }, ...old]);
    setPasted("");
    await ingest(key, isLink ? { action: "kb-ingest-url", url: text } : { action: "kb-ingest-text", text });
  };

  /** The whole document: the list only carries the beginning of each text. */
  const whole = async (doc: KbDocument): Promise<KbDocument | undefined> => {
    setProblem("");
    try {
      return (await request({ action: "kb-read", id: doc.id })).reply?.kbDocument;
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  };

  const download = async (doc: KbDocument): Promise<void> => {
    setProblem("");
    try {
      const file = (await request({ action: "kb-original", id: doc.id })).reply?.download;
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

  const showSource = (docId: string): void => {
    const doc = all.find((d) => d.id === docId);
    setTab("sources");
    setCollectionFilter("");
    if (doc) void whole(doc).then((full) => full && setOpen(full));
  };
  const showPage = (id: string): void => {
    setTab("pages");
    setProblem("");
    request({ action: "kb-page-read", id })
      .then((snap) => setOpenPage(snap.reply?.kbPage))
      .catch((error) => setProblem(error instanceof Error ? error.message : String(error)));
  };
  const findings = hub.kbFindings ?? [];

  const busy = inbox.filter((x) => x.state === "reading").length;

  return (
    <div
      className={`ai-scroll ai-kb ${dragging ? "ai-kb-dragging" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer?.types?.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer?.types?.includes("Files")) return;
        e.preventDefault();
        setDragging(false);
        void filesOfDrop(e.dataTransfer).then(addFiles);
      }}
    >
      <header className="ai-view-head">
        <h2>Knowledge base</h2>
        <p className="ai-hint">
          What your agents know about your systems. Drop in what the team has (runbooks, vendor manuals, wiki pages,
          config files, incident notes); the assistant works it into pages on how things are set up, how to do things
          and how to troubleshoot, and keeps them up to date from finished work.
        </p>
      </header>

      <section className="ai-dropzone" data-testid="kb-dropzone" aria-label="Add material">
        <div className="ai-dropzone-main">
          <strong>Drop files or folders here</strong>
          <small>PDF, Word, web pages, Markdown, logs, config files, CSV — up to 10 MB each.</small>
          <div className="ai-card-actions">
            <button type="button" className="ai-btn-accent" onClick={() => picker.current?.click()}>
              Choose files
            </button>
            <button type="button" onClick={() => setDraft(draft ? undefined : { ...emptyDoc })}>
              {draft && !draft.id ? "Close" : "Write one"}
            </button>
          </div>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            data-testid="kb-file-input"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              void addFiles(files);
            }}
          />
        </div>
        <form
          className="ai-dropzone-paste"
          onSubmit={(e) => {
            e.preventDefault();
            void addPasted();
          }}
        >
          <textarea
            aria-label="Paste text or a link"
            data-testid="kb-paste"
            rows={3}
            placeholder="…or paste a link to a page, or any text: a chat thread, an email, terminal output."
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
          />
          <button type="submit" disabled={!pasted.trim()}>
            {/^https?:\/\/\S+$/i.test(pasted.trim()) ? "Fetch the page" : "Add"}
          </button>
        </form>
      </section>

      {(reading?.waiting || reading?.failed || reading?.needsModel) ? (
        <p className={`ai-reading ${reading.waiting && !reading.needsModel ? "ai-reading-on" : ""}`} data-testid="kb-reading" role="status">
          {reading.needsModel && reading.waiting
            ? `${reading.waiting} document${reading.waiting === 1 ? " is" : "s are"} waiting to be read: connect a model in Settings. They are searchable already.`
            : reading.waiting
              ? `Reading ${reading.reading ? `“${reading.reading}”` : "…"} · ${reading.waiting} to go. Documents are searchable while they wait; reading gives them a title, a summary and tags.`
              : ""}
          {reading.failed ? ` ${reading.failed} could not be described (still searchable).` : ""}
        </p>
      ) : null}

      {inbox.length > 0 && (
        <details className="ai-fold ai-inbox" open={busy > 0 || inbox.some((x) => x.state === "failed")}>
          <summary>
            {busy > 0 ? `Taking in ${busy} of ${inbox.length}…` : `Taken in: ${inbox.filter((x) => x.state === "added").length} added`}
            {inbox.some((x) => x.state === "duplicate") ? ` · ${inbox.filter((x) => x.state === "duplicate").length} already here` : ""}
            {inbox.some((x) => x.state === "failed") ? ` · ${inbox.filter((x) => x.state === "failed").length} not readable` : ""}
          </summary>
          <ul data-testid="kb-inbox">
            {inbox.map((item) => (
              <li key={item.key} className={`ai-inbox-${item.state}`}>
                <span>{item.name}</span>
                <small>
                  {item.state === "reading" ? "taking in…" : item.state === "added" ? `added${item.note && item.note !== item.name ? ` as “${item.note}”` : ""}` : item.note}
                </small>
              </li>
            ))}
          </ul>
          {busy === 0 && (
            <button type="button" className="ai-chip" onClick={() => setInbox([])}>
              Clear the list
            </button>
          )}
        </details>
      )}

      <div className="ai-filter-bar">
        <input
          type="search"
          data-testid="kb-hybrid-search-input"
          aria-label="Search the knowledge base"
          placeholder="Ask it something: what an agent would find for these words…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {hits && (
        <section className="ai-hits" data-testid="kb-hits">
          <small>
            {hits.hits.length === 0
              ? `Nothing found for “${hits.query}”. An agent would not find anything either: this is a gap.`
              : `What an agent finds for “${hits.query}”, pages first${hits.byMeaning || embeddings ? "" : " (matched by wording)"}:`}
          </small>
          {hits.hits.map((h, i) => (
            <button
              key={`${h.docId}-${i}`}
              type="button"
              className={`ai-hit ${h.pageId ? "ai-hit-page" : ""}`}
              onClick={() => (h.pageId ? showPage(h.pageId) : showSource(h.docId))}
            >
              <strong>
                {h.pageId ? <em>page</em> : <em>source</em>} {h.title}
                {h.heading && h.heading !== h.title ? <span> › {h.heading.replace(`${h.title} › `, "")}</span> : null}
              </strong>
              <span>{h.snippet.replace(/\s+/g, " ").slice(0, 260)}</span>
            </button>
          ))}
        </section>
      )}

      <div className="ai-tabs ai-kb-tabs" role="tablist">
        {(
          [
            ["pages", `Pages · ${(hub.kbPages ?? []).length}`],
            ["sources", `Sources · ${all.length}`],
            ["review", `To review · ${findings.length}`],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`${tab === key ? "ai-tab-on" : ""} ${key === "review" && findings.length ? "ai-tab-alert" : ""}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {problem && <p className="ai-error">{problem}</p>}

      {tab === "pages" && (
        <KbPages
          hub={hub}
          act={act}
          request={request}
          draft={pageDraft}
          setDraft={setPageDraft}
          open={openPage}
          setOpen={setOpenPage}
          onOpenSource={showSource}
        />
      )}
      {tab === "review" && (
        <KbReview
          hub={hub}
          act={act}
          onOpenPage={showPage}
          onOpenSource={showSource}
          onWritePage={(title) => {
            setTab("pages");
            setPageDraft(emptyPage("troubleshooting", title));
          }}
        />
      )}

      {tab === "sources" && (
        <>
      {draft && (
        <form
          className="ai-form ai-card"
          data-testid="kb-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft.title.trim() || !draft.content.trim()) return;
            void act({
              action: "kb-save",
              doc: {
                id: draft.id,
                title: draft.title.trim(),
                collection: draft.collection.trim() || "General",
                cluster: draft.cluster.trim() || undefined,
                tags: draft.tags
                  .split(",")
                  .map((t) => t.trim())
                  .filter(Boolean),
                content: draft.content,
                sourceType: draft.sourceType ?? "manual",
                sourceRef: draft.sourceRef,
              },
            }).then((next) => {
              if (next) {
                setDraft(undefined);
                setOpen(undefined);
              }
            });
          }}
        >
          <strong>{draft.id ? "Edit document" : "Write a document"}</strong>
          <label>
            Title
            <input
              required
              autoFocus
              placeholder="Replacing a failed disk in the backup pool"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </label>
          <label>
            Text (Markdown)
            <textarea
              required
              rows={12}
              className="ai-mono"
              placeholder={"# When to use this\n\n## Steps\n1. …\n\nHeadings split the document into the sections search returns."}
              value={draft.content}
              onChange={(e) => setDraft({ ...draft, content: e.target.value })}
            />
          </label>
          <datalist id="ai-kb-collections">
            {collections.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <datalist id="ai-kb-clusters">
            {clusters.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <div className="ai-form-row">
            <label>
              Collection
              <input
                list="ai-kb-collections"
                placeholder="General"
                value={draft.collection}
                onChange={(e) => setDraft({ ...draft, collection: e.target.value })}
              />
            </label>
            <label>
              Applies to cluster (optional)
              <input
                list="ai-kb-clusters"
                placeholder="Any"
                value={draft.cluster}
                onChange={(e) => setDraft({ ...draft, cluster: e.target.value })}
              />
            </label>
          </div>
          <label>
            Tags (comma-separated)
            <input
              placeholder="backup, zfs, disk"
              value={draft.tags}
              onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
            />
          </label>
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

      {!isWebBrowserMode() || hub.demoMode ? (
        <details className="ai-fold" data-testid="kb-import-folder">
          <summary>Import a folder by its path</summary>
          <form
            className="ai-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!folderPath.trim() || importing) return;
              const before = all.length;
              setImporting(true);
              setImported(undefined);
              void act({ action: "kb-ingest-folder", folderPath: folderPath.trim() })
                .then((next) => {
                  if (next) setImported((next.kbDocuments ?? []).length - before);
                })
                .finally(() => setImporting(false));
            }}
          >
            <p className="ai-hint">
              Reads the documents in a folder on this computer, up to 300 files. Importing the same folder again
              takes in what changed.
            </p>
            <div className="ai-inline-form">
              <input
                aria-label="Folder path"
                className="ai-mono"
                placeholder="~/runbooks"
                value={folderPath}
                onChange={(e) => setFolderPath(e.target.value)}
              />
              <button type="submit" disabled={importing || !folderPath.trim()}>
                {importing ? "Importing…" : "Import"}
              </button>
            </div>
            {imported !== undefined && (
              <p className="ai-hint">
                {imported > 0
                  ? `${imported} new document${imported === 1 ? "" : "s"}.`
                  : "No new documents: nothing readable was found, or it was all here already."}
              </p>
            )}
            {hub.demoMode && (
              <button
                type="button"
                onClick={() =>
                  void act({
                    action: "kb-ingest-s3",
                    s3ProfileId: "sg-fabricpool-dc1",
                    prefix: "runbooks/",
                    cluster: "NetApp-StorageGRID-S3",
                  })
                }
              >
                Load demo runbooks from S3
              </button>
            )}
          </form>
        </details>
      ) : null}

      <div className="ai-section-head">
        <h3>
          Sources <span className="ai-count">{all.length}</span>
        </h3>
      </div>

      {collections.length > 1 && (
        <div className="ai-tags ai-kb-chips">
          {["", ...collections].map((c) => (
            <button
              key={c || "all"}
              type="button"
              className={`ai-chip ${collectionFilter === c ? "ai-chip-on" : ""}`}
              aria-pressed={collectionFilter === c}
              onClick={() => setCollectionFilter(c)}
            >
              {c || "All"}
            </button>
          ))}
        </div>
      )}

      {all.length === 0 && !draft && (
        <p className="ai-empty">
          Nothing here yet. Drop in the folder where your team keeps its runbooks, the vendor manuals you keep
          opening, or the notes from the last incident.
        </p>
      )}

      {docs.slice(0, limit).map((doc: KbDocument) => {
        const isOpen = open?.id === doc.id;
        const state = doc.reading?.state;
        return (
          <article className="ai-card" key={doc.id} data-testid={`kb-doc-${doc.id}`}>
            <div className="ai-card-head">
              <div>
                <strong>{doc.title}</strong>
                <small>
                  {doc.collection || "General"}
                  {doc.cluster && doc.cluster !== doc.collection ? ` · ${doc.cluster}` : ""}
                  {doc.kind ? ` · ${doc.kind}` : ""} · {doc.chunkCount ?? 1} section{(doc.chunkCount ?? 1) === 1 ? "" : "s"}
                  {doc.pages ? ` · ${doc.pages} page${doc.pages === 1 ? "" : "s"}` : ""}
                  {SOURCES[doc.sourceType ?? ""] ? ` · ${SOURCES[doc.sourceType ?? ""]}` : ""}
                  {doc.author ? ` by ${doc.author}` : ""} · {new Date(doc.updatedAt).toLocaleDateString()}
                </small>
              </div>
              <div className="ai-tags">
                {(state === "queued" || state === "reading") && (
                  <span className="ai-badge" title="Waiting to be given a title, a summary and tags. Searchable already.">
                    {state === "reading" ? "being read" : "waiting to be read"}
                  </span>
                )}
                {state === "failed" && (
                  <span className="ai-badge ai-badge-danger" title={doc.reading?.error}>
                    not described
                  </span>
                )}
                {(doc.tags ?? []).slice(0, 4).map((t) => (
                  <button key={t} type="button" className="ai-chip" onClick={() => setQuery(t)}>
                    {t}
                  </button>
                ))}
              </div>
            </div>
            {isOpen ? (
              <div className="ai-doc-body">
                {open.summary && <p className="ai-doc-summary">{open.summary}</p>}
                <RichMarkdownContent text={open.content} />
              </div>
            ) : (
              <p className="ai-doc-excerpt">{doc.summary || excerpt(doc.content)}</p>
            )}
            {doc.compiled && (
              <small className="ai-last-run">
                {doc.compiled.pages > 0
                  ? `Worked into ${doc.compiled.pages} page${doc.compiled.pages === 1 ? "" : "s"}.`
                  : "Read; led to no page."}
              </small>
            )}
            {doc.reading?.state === "done" && doc.reading.error && (
              <small className="ai-last-run">{doc.reading.error}</small>
            )}
            {doc.sourceType === "url" && doc.sourceRef && (
              <small className="ai-last-run ai-mono">{doc.sourceRef}</small>
            )}
            <div className="ai-card-actions">
              {onRunRunbook && (doc.kind === "runbook" || !doc.kind) && (
                <button
                  type="button"
                  className="ai-btn-emerald"
                  onClick={() => void whole(doc).then((full) => full && onRunRunbook(full))}
                >
                  Follow in chat
                </button>
              )}
              <button
                type="button"
                className="ai-btn-accent"
                onClick={() => void whole(doc).then((full) => full && onAttachDoc(full))}
              >
                Attach to chat
              </button>
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => (isOpen ? setOpen(undefined) : void whole(doc).then((full) => full && setOpen(full)))}
              >
                {isOpen ? "Fold" : "Read"}
              </button>
              <button
                type="button"
                onClick={() =>
                  void whole(doc).then(
                    (full) =>
                      full &&
                      setDraft({
                        id: full.id,
                        title: full.title,
                        collection: full.collection ?? "",
                        cluster: full.cluster ?? "",
                        tags: (full.tags ?? []).join(", "),
                        content: full.content,
                        sourceType: full.sourceType,
                        sourceRef: full.sourceRef,
                      }),
                  )
                }
              >
                Edit
              </button>
              {doc.original && (
                <button type="button" title={`${doc.original.name} · ${Math.max(1, Math.round(doc.original.size / 1024))} kB`} onClick={() => void download(doc)}>
                  Original file
                </button>
              )}
              {(state === "failed" || state === "done") && (
                <button type="button" onClick={() => void act({ action: "kb-reread", id: doc.id })}>
                  {state === "failed" ? "Try reading again" : "Describe again"}
                </button>
              )}
              <span className="ai-spacer" />
              <ConfirmButton
                label="Delete"
                confirmLabel="Delete this document?"
                onConfirm={() => void act({ action: "kb-delete", id: doc.id })}
              />
            </div>
          </article>
        );
      })}
      {docs.length > limit && (
        <button type="button" className="ai-more" onClick={() => setLimit(limit + 40)}>
          Show {Math.min(40, docs.length - limit)} more
        </button>
      )}
        </>
      )}
    </div>
  );
}
