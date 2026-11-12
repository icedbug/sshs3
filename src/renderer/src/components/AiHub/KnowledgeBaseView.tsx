import { useState } from "react";
import { type HubSnapshot, type KbDocument } from "@shared/types/aiHub";
import { isWebBrowserMode } from "../../lib/webClientBridge";
import { ConfirmButton } from "./ConfirmButton";
import { type Act } from "./panelShared";
import { RichMarkdownContent } from "./RichMarkdownContent";

interface DocDraft {
  id?: string;
  title: string;
  collection: string;
  cluster: string;
  tags: string;
  content: string;
}

const emptyDoc: DocDraft = { title: "", collection: "", cluster: "", tags: "", content: "" };

/** The first lines of a document as plain text, for the folded card. */
function excerpt(content: string): string {
  const text = content
    .split("\n")
    .map((line) => line.replace(/^#{1,6}\s+/, "").replace(/[`*_>]/g, "").trim())
    .filter(Boolean)
    .slice(1, 4)
    .join(" · ");
  return text.length > 220 ? `${text.slice(0, 220)}…` : text;
}

const SOURCES: Record<string, string> = {
  folder: "from a folder",
  s3: "from S3",
  url: "from a URL",
};

export function KnowledgeBaseView({
  hub,
  act,
  onAttachDoc,
  onRunRunbook,
}: {
  hub: HubSnapshot;
  act: Act;
  onAttachDoc: (doc: KbDocument) => void;
  onRunRunbook?: (doc: KbDocument) => void;
}): JSX.Element {
  const [draft, setDraft] = useState<DocDraft | undefined>();
  const [folderPath, setFolderPath] = useState("");
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<number | undefined>();
  const [filter, setFilter] = useState("");
  const [collectionFilter, setCollectionFilter] = useState("");
  const [openId, setOpenId] = useState("");

  const all = hub.kbDocuments ?? [];
  const collections = Array.from(new Set(all.map((d) => d.collection).filter((c): c is string => Boolean(c)))).sort();
  const clusters = Array.from(
    new Set((hub.workspaceServers ?? []).map((s) => s.cluster).filter((c): c is string => Boolean(c))),
  );
  const q = filter.trim().toLowerCase();
  const docs = all
    .filter((d) => !collectionFilter || d.collection === collectionFilter)
    .filter(
      (d) =>
        !q ||
        d.title.toLowerCase().includes(q) ||
        (d.tags ?? []).some((t) => t.toLowerCase().includes(q)) ||
        d.content.toLowerCase().includes(q),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const embeddings = hub.config.provider === "openai-compatible" && Boolean(hub.config.embeddingModel);

  return (
    <div className="ai-scroll">
      <header className="ai-view-head">
        <h2>Knowledge base</h2>
        <p className="ai-hint">
          Runbooks, command references and notes about your systems. The assistant searches them on its own while it
          works{embeddings ? ", by wording and by meaning" : ", by wording and a table of related terms"}; you can
          also hand it one directly.
          {!embeddings && " Set an embedding model in Settings to rank by meaning as well."}
        </p>
      </header>

      <div className="ai-section-head">
        <h3>
          Documents <span className="ai-count">{all.length}</span>
        </h3>
        <div className="ai-tags">
          {hub.demoMode && (
            <button
              type="button"
              title="Demo lab: loads invented runbooks as if they came from an S3 bucket"
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
          <button
            type="button"
            className="ai-btn-accent"
            onClick={() => setDraft(draft ? undefined : { ...emptyDoc })}
          >
            {draft ? "Close" : "Write a document"}
          </button>
        </div>
      </div>

      {draft && (
        <form
          className="ai-form ai-card"
          data-testid="kb-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft.title.trim() || !draft.content.trim()) return;
            const existing = all.find((d) => d.id === draft.id);
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
                sourceType: existing?.sourceType ?? "manual",
                sourceRef: existing?.sourceRef,
              },
            }).then((next) => {
              if (next) setDraft(undefined);
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

      <details className="ai-fold" data-testid="kb-import-folder">
        <summary>Import a folder of runbooks</summary>
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
            Reads the text files in a folder
            {isWebBrowserMode() ? " on the sshS3 server" : " on this computer"} (.md, .txt, .yaml, .conf and similar),
            one document per file, at most 25 files at a time. Importing the same folder again updates the documents.
          </p>
          <div className="ai-inline-form">
            <input
              aria-label="Folder path"
              className="ai-mono"
              placeholder={isWebBrowserMode() ? "/srv/runbooks" : "~/runbooks"}
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
                : "No new documents: the folder had no readable text files, or they were already imported."}
            </p>
          )}
        </form>
      </details>

      {all.length > 0 && (
        <div className="ai-filter-bar">
          <input
            type="search"
            data-testid="kb-hybrid-search-input"
            aria-label="Filter documents"
            placeholder="Filter by title, tag or text…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {collections.length > 1 && (
            <div className="ai-tags">
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
        </div>
      )}

      {all.length === 0 && !draft && (
        <p className="ai-empty">
          Nothing here yet. Write down the procedure you looked up last time, or import the folder where your team
          already keeps its runbooks.
        </p>
      )}
      {all.length > 0 && docs.length === 0 && <p className="ai-empty">No document matches.</p>}

      {docs.map((doc: KbDocument) => {
        const open = openId === doc.id;
        return (
          <article className="ai-card" key={doc.id} data-testid={`kb-doc-${doc.id}`}>
            <div className="ai-card-head">
              <div>
                <strong>{doc.title}</strong>
                <small>
                  {doc.collection || "General"}
                  {doc.cluster && doc.cluster !== doc.collection ? ` · ${doc.cluster}` : ""} ·{" "}
                  {doc.chunks.length} section{doc.chunks.length === 1 ? "" : "s"}
                  {SOURCES[doc.sourceType ?? ""] ? ` · ${SOURCES[doc.sourceType ?? ""]}` : ""} · updated{" "}
                  {new Date(doc.updatedAt).toLocaleDateString()}
                </small>
              </div>
              {(doc.tags ?? []).length > 0 && (
                <div className="ai-tags">
                  {(doc.tags ?? []).slice(0, 5).map((t) => (
                    <button key={t} type="button" className="ai-chip" onClick={() => setFilter(t)}>
                      {t}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {open ? (
              <div className="ai-doc-body">
                <RichMarkdownContent text={doc.content} />
              </div>
            ) : (
              <p className="ai-doc-excerpt">{excerpt(doc.content)}</p>
            )}
            <div className="ai-card-actions">
              {onRunRunbook && (
                <button type="button" className="ai-btn-emerald" onClick={() => onRunRunbook(doc)}>
                  Follow in chat
                </button>
              )}
              <button type="button" className="ai-btn-accent" onClick={() => onAttachDoc(doc)}>
                Attach to chat
              </button>
              <button type="button" aria-expanded={open} onClick={() => setOpenId(open ? "" : doc.id)}>
                {open ? "Fold" : "Read"}
              </button>
              <button
                type="button"
                onClick={() =>
                  setDraft({
                    id: doc.id,
                    title: doc.title,
                    collection: doc.collection ?? "",
                    cluster: doc.cluster ?? "",
                    tags: (doc.tags ?? []).join(", "),
                    content: doc.content,
                  })
                }
              >
                Edit
              </button>
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
    </div>
  );
}
