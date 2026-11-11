import { useState } from "react";
import {
  type HubSnapshot,
  type KbDocument,
} from "@shared/types/aiHub";
import { type Act } from "./panelShared";

const KB_SEMANTIC_CONCEPTS: Record<string, string[]> = {
  latency_perf: ["latency", "latens", "svarstid", "hög svarstid", "iops", "throughput", "qos", "slow", "långsam"],
  replication_dr: ["snapmirror", "metrocluster", "replication", "replikering", "failover", "switchover", "dr", "sync", "lag"],
  storage_capacity: ["aggregate", "aggr", "volume", "volym", "inode", "full", "utrymme", "capacity", "kapacitet", "tiering", "fabricpool"],
  s3_object: ["s3", "storagegrid", "bucket", "ilm", "erasure", "object", "multipart", "rclone", "lifecycle"],
  multipath_san: ["multipath", "iscsi", "fc", "nvme", "lun", "igrop", "alua", "hba", "path"],
  kubernetes_csi: ["trident", "csi", "pvc", "pv", "kubernetes", "k8s", "pod", "mount", "storageclass"],
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
  const [title, setTitle] = useState("");
  const [collection, setCollection] = useState("netapp-ontap");
  const [cluster, setCluster] = useState("");
  const [tags, setTags] = useState("");
  const [content, setContent] = useState("");
  const [folderPath, setFolderPath] = useState("");
  const [searchFilter, setSearchFilter] = useState("");
  const [showAddDoc, setShowAddDoc] = useState(false);
  const [expandedDocId, setExpandedDocId] = useState<string | null>(null);

  const activeConcepts = searchFilter.trim()
    ? Object.entries(KB_SEMANTIC_CONCEPTS)
        .filter(([, terms]) =>
          terms.some((term) => searchFilter.toLowerCase().includes(term) || term.includes(searchFilter.toLowerCase())),
        )
        .map(([concept]) => concept)
    : [];

  const getDocMatchedConcepts = (d: KbDocument): string[] => {
    const hay = `${d.title} ${d.collection ?? ""} ${d.cluster ?? ""} ${(d.tags ?? []).join(" ")} ${d.content}`.toLowerCase();
    return activeConcepts.filter((concept) =>
      (KB_SEMANTIC_CONCEPTS[concept] ?? []).some((term) => hay.includes(term)),
    );
  };

  const docs = (hub.kbDocuments ?? []).filter((d) => {
    if (!searchFilter.trim()) return true;
    const q = searchFilter.toLowerCase();
    const directMatch =
      d.title.toLowerCase().includes(q) ||
      (d.collection ?? d.cluster ?? "").toLowerCase().includes(q) ||
      d.content.toLowerCase().includes(q) ||
      (d.tags ?? []).some((t: string) => t.toLowerCase().includes(q));
    if (directMatch) return true;
    return getDocMatchedConcepts(d).length > 0;
  });

  const totalChunks = (hub.kbDocuments ?? []).reduce(
    (sum, d) => sum + (d.chunks?.length ?? 1),
    0,
  );

  return (
    <div className="ai-scroll">
      <div className="ai-stat-grid">
        <div className="ai-stat-box">
          <strong>{(hub.kbDocuments ?? []).length}</strong>
          <small>📚 Runbooks & Docs</small>
        </div>
        <div className="ai-stat-box">
          <strong>{totalChunks}</strong>
          <small>🧩 Indexed BM25 Chunks</small>
        </div>
        <div className="ai-stat-box">
          <strong>BM25 + synonyms{hub.config.provider === "openai-compatible" && hub.config.embeddingModel ? ` + embeddings (${hub.config.embeddingModel})` : ""}</strong>
          <small>⚡ Orama Retrieval Engine</small>
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <h2>📚 Knowledge Base ({(hub.kbDocuments ?? []).length} docs)</h2>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            onClick={() =>
              void act({
                action: "kb-ingest-s3",
                s3ProfileId: "sg-fabricpool-dc1",
                prefix: "runbooks/",
                cluster: "NetApp-StorageGRID-S3",
              })
            }
          >
            ☁️ Sync S3 Runbooks
          </button>
          <button className="ai-btn-accent" onClick={() => setShowAddDoc((v) => !v)}>
            {showAddDoc ? "Close Editor" : "+ Add Runbook / Doc"}
          </button>
        </div>
      </div>
      <p className="ai-hint">
        Store NetApp ONTAP, StorageGRID, Ceph, ZFS, and Kubernetes runbooks, CLI cheat-sheets, and architecture docs. Documents are automatically chunked and indexed for Hybrid BM25 + Bilingual Semantic Concept RAG via <code>sshs3_kb_search</code> and synced with your S3 Team Workspace.
      </p>

      <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
        <input
          style={{ flex: 1 }}
          data-testid="kb-hybrid-search-input"
          placeholder="Search runbooks (e.g. 'high latency', 'replication lag', 'pvc multipath')…"
          value={searchFilter}
          onChange={(e) => setSearchFilter(e.target.value)}
        />
        {searchFilter && (
          <button onClick={() => setSearchFilter("")}>Rensa</button>
        )}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 10, alignItems: "center" }}>
        <small style={{ opacity: 0.75 }}>🧠 Orama Concept Clusters:</small>
        {[
          { label: "⚡ Latency / QoS", q: "high latency" },
          { label: "🔄 SnapMirror / DR", q: "replication" },
          { label: "☁️ StorageGRID S3", q: "storagegrid ilm" },
          { label: "☸️ Trident CSI / PVC", q: "trident pvc" },
          { label: "🔌 SAN Multipath", q: "multipath alua" },
        ].map((chip) => (
          <button
            key={chip.label}
            type="button"
            onClick={() => setSearchFilter(searchFilter === chip.q ? "" : chip.q)}
            style={{
              padding: "2px 8px",
              fontSize: 11,
              borderRadius: 999,
              border: searchFilter === chip.q ? "1px solid #38bdf8" : "1px solid rgba(148,163,184,0.25)",
              background: searchFilter === chip.q ? "rgba(56,189,248,0.18)" : "rgba(15,23,42,0.5)",
            }}
          >
            {chip.label}
          </button>
        ))}
        {activeConcepts.length > 0 && (
          <span className="ai-badge ai-badge-purple" data-testid="kb-active-semantic-concepts">
            🧠 Semantisk expansion: {activeConcepts.join(", ")}
          </span>
        )}
      </div>

      {showAddDoc && (
        <form
          className="ai-form ai-card"
          onSubmit={(e) => {
            e.preventDefault();
            if (!title.trim() || !content.trim()) return;
            void act({
              action: "kb-save",
              doc: {
                title: title.trim(),
                collection: collection.trim() || "general",
                cluster: cluster.trim() || undefined,
                tags: tags
                  .split(",")
                  .map((t) => t.trim())
                  .filter(Boolean),
                content: content.trim(),
                sourceType: "manual",
              },
            }).then(() => {
              setTitle("");
              setContent("");
              setTags("");
              setShowAddDoc(false);
            });
          }}
        >
          <strong>Add KB Document / Runbook</strong>
          <label>
            Title
            <input
              required
              placeholder="e.g. NetApp ONTAP Aggregate Relocation SOP"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label>
            Collection
            <input
              placeholder="netapp-ontap, storagegrid, ceph, kubernetes"
              value={collection}
              onChange={(e) => setCollection(e.target.value)}
            />
          </label>
          <label>
            Cluster Binding (optional)
            <input
              placeholder="e.g. NetApp MetroCluster Stockholm"
              value={cluster}
              onChange={(e) => setCluster(e.target.value)}
            />
          </label>
          <label>
            Tags (comma-separated)
            <input
              placeholder="ontap, snapmirror, qos, failover"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
            />
          </label>
          <label>
            Markdown / Runbook Content
            <textarea
              required
              rows={6}
              placeholder="# Runbook Title&#10;&#10;Paste CLI commands, troubleshooting steps, and architecture notes…"
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
          </label>
          <button type="submit">Save & Index Document</button>
        </form>
      )}

      <form
        className="ai-form ai-card"
        onSubmit={(e) => {
          e.preventDefault();
          if (!folderPath.trim()) return;
          void act({
            action: "kb-ingest-folder",
            folderPath: folderPath.trim(),
            collection: collection.trim() || "folder-sync",
            cluster: cluster.trim() || undefined,
          }).then(() => setFolderPath(""));
        }}
      >
        <strong>Ingest Local Runbook Folder</strong>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            style={{ flex: 1 }}
            placeholder="e.g. C:\Runbooks\NetApp-ONTAP (.md, .txt, .yaml, .conf)"
            value={folderPath}
            onChange={(e) => setFolderPath(e.target.value)}
          />
          <button type="submit">Sync Folder</button>
        </div>
      </form>

      {docs.map((doc: KbDocument) => {
        const matchedConcepts = getDocMatchedConcepts(doc);
        return (
          <article className="ai-card" key={doc.id}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <strong>📄 {doc.title}</strong>
                  {matchedConcepts.map((mc) => (
                    <span key={mc} className="ai-badge ai-badge-purple">
                      🧠 {mc}
                    </span>
                  ))}
                </div>
                <div>
                  <small>
                    Collection: <code>{doc.collection || doc.cluster || "general"}</code> · {doc.chunks.length} chunk(s)
                    {doc.cluster ? ` · Cluster: ${doc.cluster}` : ""}
                  </small>
                </div>
              </div>
              <small>{new Date(doc.updatedAt).toLocaleDateString()}</small>
            </div>
            {(doc.tags ?? []).length > 0 && (
              <small style={{ display: "block", marginTop: 4 }}>
                🏷️ {(doc.tags ?? []).join(", ")}
              </small>
            )}
            {expandedDocId === doc.id ? (
              <pre style={{ marginTop: 8, maxHeight: 280, overflow: "auto", whiteSpace: "pre-wrap" }}>
                {doc.content}
              </pre>
            ) : (
              <p style={{ marginTop: 6 }}>
                {doc.content.slice(0, 200)}
                {doc.content.length > 200 ? "…" : ""}
              </p>
            )}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
              {onRunRunbook && (
                <button
                  className="ai-btn-accent"
                  onClick={() => onRunRunbook(doc)}
                >
                  🚀 Run this runbook in chat
                </button>
              )}
              <button onClick={() => onAttachDoc(doc)}>
                📎 Attach to Chat (@kb)
              </button>
              <button
                onClick={() =>
                  setExpandedDocId(expandedDocId === doc.id ? null : doc.id)
                }
              >
                {expandedDocId === doc.id ? "Hide Content" : "Read Full Runbook"}
              </button>
              <button
                onClick={() => void act({ action: "kb-delete", id: doc.id })}
              >
                Delete
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );
}
