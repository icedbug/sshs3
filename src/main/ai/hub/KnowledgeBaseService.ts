import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  create as createOrama,
  insertMultiple as insertMultipleOrama,
  search as searchOrama,
  type AnyOrama,
} from "@orama/orama";
import type { KbDocument, KbPage, KbPageUse, MemoryEntry } from "../../../shared/types/aiHub";
import type { IStorageProvider } from "../../../shared/types/storage";
import {
  cosine,
  embedTextLocal,
  fuseRanks,
  sparseCosine,
  sparseTermVector,
  type Embedder,
  type EmbeddingIndex,
} from "./EmbeddingIndex";
import { MAX_DOC_CHARS, MAX_UPLOAD_BYTES, extractText, splitSections } from "./KbExtract";
import { safeError } from "./privacy";

export interface KbChunkResult {
  docId: string;
  pageId?: string;
  title: string;
  collection: string;
  targetCluster?: string;
  sourceUri?: string;
  heading?: string;
  chunkIndex: number;
  snippet: string;
  score: number;
  bm25Score?: number;
  semanticScore?: number;
  rerankScore?: number;
  proven?: number;
  matchedConcepts?: string[];
}

export interface KbSearchOptions {
  query: string;
  collectionIds?: string[];
  targetCluster?: string;
  cluster?: string;
  limit?: number;
  /**
   * Optional KB pages to index and rank alongside document chunks. Not passed
   * by the app's own callers yet (kb-search, sshs3_kb_search): they rank pages
   * apart with searchPages (KbCompile), so `pages`, `pageUse` and
   * `staleReasons` only take effect for a caller that sets them.
   */
  pages?: KbPage[];
  /** Optional usage stats (proven counts, rollbacks) keyed by page/doc id. Not passed by the app's callers yet. */
  pageUse?: Record<string, KbPageUse>;
  /** Optional explicit stale reasons keyed by page/doc id. Not passed by the app's callers yet. */
  staleReasons?: Record<string, string>;
  /** Reference timestamp for recency and rollback decay (defaults to Date.now()). */
  now?: number;
  /** Cross-candidate rerank window over fused results (clamped to 30..50, default 40). */
  rerankTopK?: number;
}

export interface KbHybridSearchResult {
  matches: KbChunkResult[];
  retrieval: "hybrid" | "lexical";
  embeddingModel?: string;
  embeddingError?: string;
  usedLocalFallback?: boolean;
}

/**
 * Bilingual (SV/EN) DevOps, Storage (NetApp ONTAP, Ceph, ZFS, S3), Kubernetes,
 * Security, Database, Observability, and Linux infrastructure concept clusters.
 * Used to tag chunks and to expand a query with related terms in both
 * languages. This is a hand-written synonym table, not an embedding: ranking
 * by meaning comes from real embeddings (see searchHybrid / EmbeddingIndex).
 */
export const SEMANTIC_CONCEPT_CLUSTERS: Record<string, string[]> = {
  storage_capacity: [
    "full",
    "disk",
    "utrymme",
    "lagring",
    "slut",
    "capacity",
    "enospc",
    "space",
    "autosize",
    "aggr",
    "aggregate",
    "volume",
    "volym",
    "quota",
    "df",
    "overprovisioned",
    "thin",
    "thick",
  ],
  storage_latency_qos: [
    "långsam",
    "seg",
    "svarstid",
    "latens",
    "latency",
    "iops",
    "throughput",
    "qos",
    "adaptive",
    "wafl",
    "nvme",
    "bottleneck",
    "flaskhals",
    "performance",
    "prestanda",
    "queue",
  ],
  replication_dr: [
    "replikering",
    "katastrof",
    "backup",
    "failover",
    "snapmirror",
    "broken-off",
    "resync",
    "lag",
    "dr",
    "mirror",
    "sync",
    "asynkron",
    "rpo",
    "rto",
  ],
  multipath_io: [
    "multipath",
    "pathen",
    "vägar",
    "iscsi",
    "nvme-of",
    "fc",
    "san",
    "lun",
    "dm-multipath",
    "round-robin",
    "alua",
    "hba",
    "dead",
    "flapping",
  ],
  ceph_zfs_health: [
    "ceph",
    "zfs",
    "zpool",
    "osd",
    "pg",
    "degraded",
    "scrub",
    "heala",
    "trasig",
    "corrupt",
    "checksum",
    "arc",
    "l2arc",
    "zil",
    "slog",
    "bluestore",
  ],
  k8s_csi_volumes: [
    "kubernetes",
    "k8s",
    "pod",
    "pvc",
    "pv",
    "trident",
    "csi",
    "mountvolume",
    "attachvolume",
    "storageclass",
    "statefulset",
    "stuck",
    "containercreating",
    "terminating",
  ],
  s3_object_ilm: [
    "s3",
    "bucket",
    "objekt",
    "object",
    "storagegrid",
    "ilm",
    "lifecycle",
    "erasure",
    "replication",
    "cors",
    "presigned",
    "minio",
    "r2",
  ],
  network_ssh_tunnel: [
    "nätverk",
    "tunnel",
    "port",
    "forwarding",
    "proxyjump",
    "bastion",
    "socks",
    "mtu",
    "vlan",
    "bgp",
    "firewall",
    "brandvägg",
    "timeout",
    "connection",
    "unreachable",
  ],
  security_audit_cve: [
    "cve",
    "trivy",
    "falco",
    "sshd",
    "cert",
    "tls",
    "rbac",
    "sudo",
    "root",
    "selinux",
    "apparmor",
    "sårbarhet",
    "säkerhet",
    "audit",
    "unauthorized",
    "permission",
  ],
  database_postgres_redis: [
    "postgres",
    "postgresql",
    "pg_stat",
    "wal",
    "deadlock",
    "vacuum",
    "redis",
    "mysql",
    "mariadb",
    "databas",
    "connection_pool",
    "pgbouncer",
  ],
  observability_prometheus_logs: [
    "prometheus",
    "grafana",
    "loki",
    "alertmanager",
    "metric",
    "oom",
    "memory_leak",
    "cpu",
    "load",
    "journalctl",
    "dmesg",
    "syslog",
    "övervakning",
    "larm",
  ],
  gitops_ci_deploy: [
    "argocd",
    "flux",
    "helm",
    "terraform",
    "ansible",
    "gitops",
    "pipeline",
    "deploy",
    "rollback",
    "drift",
    "kustomize",
    "release",
  ],
  linux_systemd_kernel: [
    "systemd",
    "systemctl",
    "service",
    "unit",
    "kernel",
    "sysctl",
    "ulimit",
    "oom-killer",
    "zombie",
    "process",
    "cron",
    "cgroup",
  ],
  backup_snapshot_restore: [
    "snapshot",
    "restic",
    "borg",
    "veeam",
    "velero",
    "restore",
    "återställning",
    "kopia",
    "retention",
    "immutable",
  ],
  gpu_ai_inference: [
    "gpu",
    "nvidia",
    "cuda",
    "vllm",
    "ollama",
    "tensor",
    "vram",
    "rocm",
    "nccl",
    "inference",
    "llm",
    "triton",
  ],
  dns_loadbalancer_ingress: [
    "dns",
    "coredns",
    "bind",
    "nginx",
    "haproxy",
    "envoy",
    "traefik",
    "ingress",
    "loadbalancer",
    "vip",
    "keepalived",
    "cert-manager",
  ],
};


export function extractSemanticConcepts(tokens: string[]): string[] {
  const matched: string[] = [];
  for (const [concept, keywords] of Object.entries(SEMANTIC_CONCEPT_CLUSTERS)) {
    const hit = tokens.some((tok) =>
      keywords.some(
        (kw) =>
          tok === kw ||
          (tok.length >= 4 && kw.startsWith(tok)) ||
          (kw.length >= 4 && tok.startsWith(kw)),
      ),
    );
    if (hit) matched.push(concept);
  }
  return matched;
}

function computeTrigramSimilarity(a: string, b: string): number {
  const cleanA = a.toLowerCase().replace(/\s+/g, " ").trim();
  const cleanB = b.toLowerCase().replace(/\s+/g, " ").trim();
  if (!cleanA || !cleanB) return 0;

  const trigrams = (s: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i <= s.length - 3; i++) {
      set.add(s.slice(i, i + 3));
    }
    return set;
  };

  const setA = trigrams(cleanA);
  const setB = trigrams(cleanB);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const tri of setA) {
    if (setB.has(tri)) intersection++;
  }
  return intersection / Math.sqrt(setA.size * setB.size);
}

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".conf",
  ".cfg",
  ".ini",
  ".log",
  ".sh",
  ".ps1",
  ".toml",
  ".xml",
  ".csv",
]);

export function splitIntoChunks(
  text: string,
  maxChunkChars = 1200,
  overlapChars = 180,
): string[] {
  const cleaned = text.replace(/\r\n/g, "\n").trim();
  if (!cleaned) return [];
  if (cleaned.length <= maxChunkChars) return [cleaned];

  const paragraphs = cleaned.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    if ((current + "\n\n" + para).length <= maxChunkChars) {
      current = current ? `${current}\n\n${para}` : para;
    } else {
      if (current) {
        chunks.push(current);
        const tail = current.slice(-overlapChars);
        current = tail ? `${tail}\n\n${para}` : para;
      } else {
        current = para;
      }
      while (current.length > maxChunkChars) {
        chunks.push(current.slice(0, maxChunkChars));
        current = current.slice(maxChunkChars - overlapChars);
      }
    }
  }
  if (current.trim()) {
    chunks.push(current.trim());
  }
  return chunks;
}

export function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9åäö_.-]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

const DAY_MS = 24 * 60 * 60_000;
const ROLLBACK_DECAY_DAYS = 60;
const STALE_PAGE_DAYS = 180;
const RERANK_MIN_K = 30;
const RERANK_MAX_K = 50;

/** Extracts markdown headings from a page or document body, stripped of syntax markers. */
export function extractMarkdownHeadings(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
    const clean = match[1].replace(/[*`]/g, "").trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

/** Prepends heading, cluster, collection, and title context to a document chunk. */
export function formatChunkContext(
  doc: Pick<KbDocument, "title" | "collection" | "cluster" | "targetCluster" | "tags">,
  heading: string | undefined,
  text: string,
): string {
  const collection = doc.collection || doc.cluster || "General";
  const cluster = doc.cluster || doc.targetCluster || "";
  const tags = (doc.tags ?? []).join(", ");
  const headerParts = [
    heading ? `Section: ${heading}` : "",
    cluster ? `Cluster: ${cluster}` : "",
    collection ? `Collection: ${collection}` : "",
    doc.title ? `Title: ${doc.title}` : "",
    tags ? `Tags: ${tags}` : "",
  ].filter(Boolean);
  return headerParts.length > 0 ? `[${headerParts.join(" | ")}]\n${text}` : text;
}

/** Formats a KbPage for hybrid indexing using title, when, keys, targets, headings, and body. */
export function formatPageContext(page: KbPage): string {
  const headings = extractMarkdownHeadings(page.body);
  const parts = [
    `Title: ${page.title}`,
    `Kind: ${page.kind}`,
    page.when ? `When: ${page.when}` : "",
    page.keys?.length ? `Keys: ${page.keys.join(", ")}` : "",
    page.targets.length ? `Targets: ${page.targets.join(", ")}` : "",
    headings.length ? `Headings: ${headings.join(" > ")}` : "",
  ].filter(Boolean);
  return `[${parts.join(" | ")}]\n${page.body}`;
}

interface IndexedChunkRecord {
  chunkId: string;
  kind: "chunk" | "page";
  doc?: KbDocument;
  page?: KbPage;
  docId: string;
  pageId?: string;
  title: string;
  collection: string;
  targetCluster?: string;
  clusters: string[];
  sourceUri?: string;
  heading?: string;
  keys?: string[];
  when?: string;
  chunkIndex: number;
  text: string;
  contextualText: string;
  tokens: string[];
  concepts: string[];
  unverified: boolean;
  staleReason?: string;
  updatedAt: number;
  provenCount: number;
}

/** A document's text as the pieces search returns, each knowing the headings it sits under. */
export function sectionsOf(docId: string, content: string): KbDocument["chunks"] {
  return splitSections(content).map((section, idx) => ({
    id: `${docId}#${idx}`,
    heading: section.heading,
    text: section.text,
  }));
}

/**
 * Which document a newly added text revises, if any. An address (`url`) names
 * one thing: fetched again with a new text, it is the same source revised. A
 * pasted text's source name is only a label a person chose, often the same for
 * several texts: it is the same document only when the title is the same too.
 * Otherwise the text becomes a new document, the one that had the name keeps
 * its text (and the pages compiled from it), and `notes` says so. A text that
 * is split into parts is always added as new documents.
 */
export function documentRevisedBy(
  docs: readonly KbDocument[],
  source: { sourceType: KbDocument["sourceType"]; sourceRef?: string },
  title: string,
  parts: number,
): { earlier?: KbDocument; notes?: string[] } {
  // A page in a wiki is named by its address too: read again with a new text, it is that page revised.
  const named = source.sourceType === "url" || source.sourceType === "confluence";
  if (!source.sourceRef || (!named && source.sourceType !== "paste")) return {};
  const sameRef = docs.filter((d) => d.sourceRef === source.sourceRef && d.sourceType === source.sourceType);
  if (sameRef.length === 0) return {};
  const wanted = title.trim().toLowerCase();
  const earlier =
    parts !== 1
      ? undefined
      : named
        ? sameRef[0]
        : sameRef.find((d) => d.title.trim().toLowerCase() === wanted);
  if (earlier) return { earlier };
  if (source.sourceType !== "paste") return {};
  return {
    notes: [
      `"${title}" was added as a new document: "${sameRef[0].title}" already has the source "${source.sourceRef}" and was left as it was. Give each text its own source name, or the same title to revise it.`,
    ],
  };
}

/** How long a memory's text may be: what the distiller writes (4,000), not less. */
export const MAX_MEMORY_TEXT = 4000;
/** How many learned (automatic) memories are kept; the newest stay. What a person wrote is never dropped by this. */
const MAX_LEARNED = 300;

/**
 * The store with its learned entries capped, newest first. What a person
 * wrote, and personal notes, are never dropped to make room: they used to
 * fall off silently once there were a hundred entries of any kind.
 * Replaced (superseded) entries are history: they count toward the same cap
 * whoever wrote them, and are the first to go.
 */
export function capMemories(memories: MemoryEntry[]): MemoryEntry[] {
  const liveLearned = memories.filter((m) => !m.supersededBy && m.autoLearned).length;
  let history = Math.max(0, MAX_LEARNED - liveLearned);
  let learned = 0;
  return memories.filter((m) =>
    m.supersededBy ? history-- > 0 : !m.autoLearned || ++learned <= MAX_LEARNED,
  );
}

/** What agents are given and search finds: not the entries a newer one replaced. */
export function liveMemories(memories: MemoryEntry[]): MemoryEntry[] {
  return memories.filter((m) => !m.supersededBy);
}

export class KnowledgeBaseService {
  private oramaDb?: AnyOrama;
  private oramaSignature = "";
  private indexedChunks = new Map<string, IndexedChunkRecord>();

  getIndexedChunkCount(): number {
    return this.indexedChunks.size;
  }

  private ensureOramaIndex(docs: KbDocument[], pages: KbPage[] = []): void {
    const docSig = docs
      .map((d) => `${d.id}:${d.updatedAt}:${d.chunks?.length ?? 0}:${d.cluster ?? d.targetCluster ?? ""}:${d.collection ?? ""}`)
      .join("|");
    const pageSig = pages
      .map((p) => `${p.id}:${p.revision}:${p.updatedAt}:${p.proven ?? 0}:${p.unverified?.commands.length ?? 0}:${p.unverified?.citations.length ?? 0}`)
      .join("|");
    const sig = `${docSig}::${pageSig}`;
    if (this.oramaDb && this.oramaSignature === sig) {
      return;
    }

    const db = createOrama({
      schema: {
        chunkId: "string",
        docId: "string",
        chunkIndex: "number",
        title: "string",
        collection: "string",
        cluster: "string",
        tags: "string",
        concepts: "string",
        text: "string",
      },
    });

    const chunkMap = new Map<string, IndexedChunkRecord>();
    const oramaRecords: Array<Record<string, unknown>> = [];
    const pageProvenByDoc = new Map<string, number>();
    for (const p of pages) {
      if ((p.proven ?? 0) > 0) {
        for (const s of p.sources) {
          pageProvenByDoc.set(s.docId, Math.max(pageProvenByDoc.get(s.docId) ?? 0, p.proven ?? 0));
        }
      }
    }

    for (const doc of docs) {
      const parts =
        doc.chunks?.length > 0
          ? doc.chunks.map((c) => c.text)
          : splitIntoChunks(doc.content);
      const col = doc.collection || doc.cluster || "General";
      const cl = doc.cluster || doc.targetCluster || "";
      const tagStr = (doc.tags ?? []).join(" ");
      const clusters = [cl, doc.targetCluster ?? ""].filter(Boolean);
      const docStaleReason = (doc as KbDocument & { staleReason?: string }).staleReason;
      const docProven = pageProvenByDoc.get(doc.id) ?? 0;

      parts.forEach((part, idx) => {
        const chunkId = `${doc.id}#${idx}`;
        // A piece is found by the headings it sits under too, plus cluster & collection context.
        const heading = doc.chunks?.[idx]?.heading;
        const contextualText = formatChunkContext(doc, heading, part);
        const tokens = tokenize(contextualText);
        const concepts = extractSemanticConcepts(tokens);
        chunkMap.set(chunkId, {
          chunkId,
          kind: "chunk",
          doc,
          docId: doc.id,
          title: doc.title,
          collection: col,
          targetCluster: cl || undefined,
          clusters,
          sourceUri: doc.sourceRef || doc.sourceUri,
          heading,
          chunkIndex: idx,
          text: part,
          contextualText,
          tokens,
          concepts,
          unverified: false,
          staleReason: docStaleReason,
          updatedAt: doc.updatedAt,
          provenCount: docProven,
        });
        oramaRecords.push({
          chunkId,
          docId: doc.id,
          chunkIndex: idx,
          title: doc.title,
          collection: col,
          cluster: cl,
          tags: `${tagStr} ${heading ?? ""}`.trim(),
          concepts: concepts.join(" "),
          text: contextualText,
        });
      });
    }

    for (const page of pages) {
      const chunkId = `page:${page.id}`;
      const headings = extractMarkdownHeadings(page.body);
      const heading = headings.join(" › ") || page.when;
      const contextualText = formatPageContext(page);
      const tokens = tokenize(contextualText);
      const concepts = extractSemanticConcepts(tokens);
      const unverified = Boolean(
        page.unverified && (page.unverified.commands.length > 0 || page.unverified.citations.length > 0),
      );
      const pageStaleReason = (page as KbPage & { staleReason?: string }).staleReason;
      const snippet = page.body.trim().slice(0, 500) || page.when;

      chunkMap.set(chunkId, {
        chunkId,
        kind: "page",
        page,
        docId: page.id,
        pageId: page.id,
        title: page.title,
        collection: page.kind,
        targetCluster: page.targets[0],
        clusters: [...page.targets],
        heading,
        keys: page.keys,
        when: page.when,
        chunkIndex: 0,
        text: snippet,
        contextualText,
        tokens,
        concepts,
        unverified,
        staleReason: pageStaleReason,
        updatedAt: Math.max(page.updatedAt, page.lastProvenAt ?? 0),
        provenCount: page.proven ?? 0,
      });
      oramaRecords.push({
        chunkId,
        docId: page.id,
        chunkIndex: 0,
        title: page.title,
        collection: page.kind,
        cluster: page.targets.join(" "),
        tags: `${(page.keys ?? []).join(" ")} ${headings.join(" ")} ${page.when}`.trim(),
        concepts: concepts.join(" "),
        text: contextualText,
      });
    }

    if (oramaRecords.length > 0) {
      insertMultipleOrama(db, oramaRecords);
    }

    this.oramaDb = db;
    this.oramaSignature = sig;
    this.indexedChunks = chunkMap;
  }

  private filterCandidates(
    records: Iterable<IndexedChunkRecord>,
    allowedCollections?: string[],
  ): IndexedChunkRecord[] {
    const out: IndexedChunkRecord[] = [];
    for (const rec of records) {
      if (allowedCollections && allowedCollections.length > 0) {
        const col = rec.collection.toLowerCase();
        const cl = (rec.targetCluster ?? "").toLowerCase();
        const matchCol =
          allowedCollections.includes(col) ||
          (cl && allowedCollections.includes(cl)) ||
          allowedCollections.includes(rec.docId.toLowerCase());
        if (!matchCol) continue;
      }
      out.push(rec);
    }
    return out;
  }

  private qualityMultiplier(
    rec: IndexedChunkRecord,
    opts: {
      clusterFilter?: string;
      pageUse?: Record<string, KbPageUse>;
      staleReasons?: Record<string, string>;
      now: number;
    },
  ): number {
    let factor = 1;
    if (opts.clusterFilter) {
      const hasMatch = rec.clusters.some((c) => c.toLowerCase() === opts.clusterFilter);
      if (hasMatch) factor *= 1.35;
      else if (rec.clusters.length > 0) factor *= 0.78;
    }

    const use = opts.pageUse?.[rec.docId];
    const provenCount = Math.max(rec.provenCount, use?.proven ?? 0);
    if (provenCount > 0) {
      factor *= 1 + Math.min(0.35, Math.log1p(provenCount) * 0.12);
    }

    const rollbacks = use?.rolledBack ?? [];
    if (rollbacks.length > 0) {
      const recent = rollbacks.filter((r) => opts.now - r.at < ROLLBACK_DECAY_DAYS * DAY_MS);
      const count = recent.length || rollbacks.length;
      factor *= Math.max(0.4, 1 - count * 0.22);
    }

    if (rec.unverified) {
      factor *= 0.76;
    }

    const staleReason = rec.staleReason || opts.staleReasons?.[rec.docId];
    if (staleReason) {
      factor *= 0.52;
    } else if (rec.kind === "page" && provenCount === 0 && opts.now - rec.updatedAt > STALE_PAGE_DAYS * DAY_MS) {
      factor *= 0.88;
    }

    return factor;
  }

  private toChunkResult(
    rec: IndexedChunkRecord,
    scores: {
      score: number;
      bm25Score?: number;
      semanticScore?: number;
      rerankScore?: number;
      matchedConcepts?: string[];
    },
    opts?: { pageUse?: Record<string, KbPageUse> },
  ): KbChunkResult {
    const proven = Math.max(rec.provenCount, opts?.pageUse?.[rec.docId]?.proven ?? 0) || undefined;
    return {
      docId: rec.docId,
      ...(rec.pageId ? { pageId: rec.pageId } : {}),
      title: rec.title,
      collection: rec.collection,
      targetCluster: rec.targetCluster,
      sourceUri: rec.sourceUri,
      ...(rec.heading ? { heading: rec.heading } : {}),
      chunkIndex: rec.chunkIndex,
      snippet: rec.text,
      score: scores.score,
      ...(scores.bm25Score !== undefined ? { bm25Score: scores.bm25Score } : {}),
      ...(scores.semanticScore !== undefined ? { semanticScore: scores.semanticScore } : {}),
      ...(scores.rerankScore !== undefined ? { rerankScore: scores.rerankScore } : {}),
      ...(proven !== undefined ? { proven } : {}),
      ...(scores.matchedConcepts ? { matchedConcepts: scores.matchedConcepts } : {}),
    };
  }

  private proximityAndFieldScore(query: string, qTokens: string[], rec: IndexedChunkRecord): {
    coverage: number;
    proximity: number;
    fieldBoost: number;
  } {
    if (qTokens.length === 0) return { coverage: 0, proximity: 0, fieldBoost: 0 };
    const matched = qTokens.filter((q) => rec.tokens.some((t) => t === q || t.includes(q)));
    const coverage = matched.length / qTokens.length;

    const cleanQuery = query.toLowerCase().trim();
    const titleLower = rec.title.toLowerCase();
    const headingLower = (rec.heading ?? "").toLowerCase();
    const whenLower = (rec.when ?? "").toLowerCase();
    const keysLower = (rec.keys ?? []).map((k) => k.toLowerCase());

    let fieldBoost = 0;
    if (cleanQuery.length >= 3) {
      if (titleLower.includes(cleanQuery)) fieldBoost += 0.22;
      if (headingLower.includes(cleanQuery)) fieldBoost += 0.16;
      if (whenLower.includes(cleanQuery)) fieldBoost += 0.14;
      if (keysLower.some((k) => k.includes(cleanQuery) || cleanQuery.includes(k))) fieldBoost += 0.25;
    }
    const titleTokens = tokenize(`${rec.title} ${rec.heading ?? ""} ${rec.when ?? ""} ${(rec.keys ?? []).join(" ")}`);
    if (titleTokens.length > 0) {
      const headHits = qTokens.filter((q) => titleTokens.some((t) => t === q || t.includes(q))).length;
      fieldBoost += 0.18 * (headHits / qTokens.length);
    }

    let proximity = 0;
    if (matched.length >= 2) {
      const bodyLower = rec.contextualText.toLowerCase();
      const positions: Array<{ pos: number; term: string }> = [];
      for (const term of matched) {
        const idx = bodyLower.indexOf(term);
        if (idx >= 0) positions.push({ pos: idx, term });
      }
      if (positions.length >= 2) {
        positions.sort((a, b) => a.pos - b.pos);
        const span = positions[positions.length - 1].pos - positions[0].pos;
        if (span <= 240) proximity = 0.16 * (1 - span / 280);
      }
    }

    return {
      coverage,
      proximity,
      fieldBoost: Math.min(0.45, fieldBoost),
    };
  }

  createDocument(input: {
    id?: string;
    collection?: string;
    title: string;
    sourceType?: KbDocument["sourceType"];
    sourceUri?: string;
    sourceRef?: string;
    targetCluster?: string;
    cluster?: string;
    tags?: string[];
    shared?: boolean;
    content: string;
    author?: string;
  }): KbDocument {
    const content = input.content.slice(0, MAX_DOC_CHARS);
    const id = input.id || crypto.randomUUID();
    const chunks = sectionsOf(id, content);
    const cluster =
      input.cluster?.trim() || input.targetCluster?.trim() || undefined;
    const sourceRef =
      input.sourceRef?.trim() || input.sourceUri?.trim() || undefined;
    return {
      id,
      collection: input.collection?.trim() || cluster || "General",
      title: input.title.trim().slice(0, 200) || "Untitled Document",
      sourceType: input.sourceType || "manual",
      sourceUri: sourceRef,
      sourceRef,
      targetCluster: cluster,
      cluster,
      tags: input.tags?.filter(Boolean) ?? [],
      content,
      chunks,
      chunkCount: Math.max(1, chunks.length),
      shared: input.shared ?? true,
      updatedAt: Date.now(),
      author: input.author?.trim() || undefined,
    };
  }

  search(
    docs: KbDocument[],
    queryOrOpts: string | KbSearchOptions,
    options?: Omit<KbSearchOptions, "query">,
  ): KbChunkResult[] {
    const opts = typeof queryOrOpts === "string" ? { ...options, query: queryOrOpts } : queryOrOpts;
    const limit = Math.max(1, Math.min(25, opts.limit ?? 6));
    return this.searchInternal(docs, opts, limit);
  }

  private searchInternal(
    docs: KbDocument[],
    opts: KbSearchOptions,
    limit: number,
  ): KbChunkResult[] {
    const query = opts.query;
    const now = opts.now ?? Date.now();
    const qTokens = tokenize(query);
    const allowedCollections = opts.collectionIds
      ?.map((c) => c.trim().toLowerCase())
      .filter(Boolean);
    const clusterFilter = (opts.cluster || opts.targetCluster)
      ?.trim()
      .toLowerCase();

    // Ensure the @orama/orama in-memory hybrid index is up to date (both docs & optional pages)
    this.ensureOramaIndex(docs, opts.pages ?? []);

    const candidateRecords = this.filterCandidates(this.indexedChunks.values(), allowedCollections);
    if (candidateRecords.length === 0) return [];

    if (qTokens.length === 0) {
      return candidateRecords.slice(0, limit).map((c) =>
        this.toChunkResult(c, { score: 1 }, opts),
      );
    }

    // 1. Query @orama/orama full-text BM25 + typo-tolerant index
    const oramaScores = new Map<string, number>();
    const queryConcepts = extractSemanticConcepts(qTokens);
    if (this.oramaDb) {
      try {
        const expandedTerm = [query, ...queryConcepts].join(" ").trim();
        const ftResults = searchOrama(this.oramaDb, {
          term: expandedTerm,
          properties: [
            "title",
            "text",
            "collection",
            "cluster",
            "tags",
            "concepts",
          ],
          boost: {
            title: 2.5,
            concepts: 2.0,
            tags: 1.8,
            cluster: 1.5,
            text: 1.0,
          },
          tolerance: 1,
          limit: Math.max(40, limit * 4),
        });
        if (ftResults && "hits" in ftResults && Array.isArray(ftResults.hits)) {
          for (const hit of ftResults.hits) {
            const doc = hit.document as { chunkId?: string };
            if (doc?.chunkId && Number.isFinite(hit.score)) {
              oramaScores.set(doc.chunkId, hit.score * 2.2);
            }
          }
        }
      } catch {
        // Fallback cleanly if Orama query parser encounters unusual syntax
      }
    }

    // 2. Combine @orama/orama BM25 scores with compound-token BM25, matched synonym concepts, and trigram similarity
    const k1 = 1.5;
    const b = 0.75;
    const avgLen =
      candidateRecords.reduce((acc, c) => acc + c.tokens.length, 0) /
        candidateRecords.length || 1;
    const docFreq = new Map<string, number>();
    for (const q of qTokens) {
      let df = 0;
      for (const c of candidateRecords) {
        if (c.tokens.some((t) => t === q || t.includes(q))) df++;
      }
      docFreq.set(q, df);
    }

    const scored: KbChunkResult[] = [];
    const N = candidateRecords.length;

    for (const c of candidateRecords) {
      let lexicalBm25 = oramaScores.get(c.chunkId) ?? 0;
      const len = c.tokens.length || 1;
      for (const q of qTokens) {
        let tf = 0;
        for (const t of c.tokens) {
          if (t === q) tf += 1;
          else if (t.includes(q)) tf += 0.5;
        }
        if (tf === 0) continue;
        const df = docFreq.get(q) ?? 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        lexicalBm25 +=
          idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (len / avgLen))));
      }

      const matchedConcepts = queryConcepts.filter((qc) =>
        c.concepts.includes(qc),
      );
      const conceptBoost = matchedConcepts.length * 1.45;
      const trigramSim = computeTrigramSimilarity(
        query,
        `${c.title} ${c.heading ?? ""} ${c.text.slice(0, 400)}`,
      );
      const semanticScore =
        Math.round(
          (conceptBoost + (trigramSim >= 0.12 ? trigramSim * 1.8 : 0)) * 1000,
        ) / 1000;

      let totalScore = lexicalBm25 + semanticScore;

      if (c.title.toLowerCase().includes(query.toLowerCase().trim())) {
        totalScore += 2.0;
      }
      totalScore *= this.qualityMultiplier(c, {
        clusterFilter,
        pageUse: opts.pageUse,
        staleReasons: opts.staleReasons,
        now,
      });

      if (totalScore > 0) {
        scored.push(
          this.toChunkResult(
            c,
            {
              score: Math.round(totalScore * 1000) / 1000,
              bm25Score: Math.round(lexicalBm25 * 1000) / 1000,
              semanticScore,
              matchedConcepts,
            },
            opts,
          ),
        );
      }
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * Lexical search fused with ranking by meaning. Every chunk and page of the
   * allowed collections is compared with the query by cosine similarity (using
   * the configured embedder or the deterministic local n-gram fallback embedder
   * when none is configured/available), fused with BM25 via reciprocal rank
   * fusion, and cross-reranked over the top 30-50 fused candidates.
   */
  async searchHybrid(
    docs: KbDocument[],
    opts: KbSearchOptions,
    embedder: Embedder | undefined,
    index: EmbeddingIndex,
  ): Promise<KbHybridSearchResult> {
    const limit = Math.max(1, Math.min(25, opts.limit ?? 6));
    const rerankWindow = Math.max(RERANK_MIN_K, Math.min(RERANK_MAX_K, opts.rerankTopK ?? 40));
    const now = opts.now ?? Date.now();
    const clusterFilter = (opts.cluster || opts.targetCluster)?.trim().toLowerCase();
    const lexical = this.searchInternal(docs, opts, rerankWindow);

    if (!opts.query.trim()) {
      return { matches: lexical.slice(0, limit), retrieval: "lexical" };
    }

    const allowed = opts.collectionIds
      ?.map((c) => c.trim().toLowerCase())
      .filter(Boolean);
    const chunks = this.filterCandidates(this.indexedChunks.values(), allowed);
    if (chunks.length === 0) return { matches: [], retrieval: "lexical" };

    let usedExternalEmbedder = Boolean(embedder);
    const embeddingModel: string | undefined = embedder?.model;
    let embeddingError: string | undefined;
    let usedLocalFallback = false;
    let similarities: Array<{ rec: IndexedChunkRecord; similarity: number }> = [];

    if (embedder) {
      try {
        const [queryVector] = await embedder.embed([opts.query]);
        const vectors = await index.vectorsFor(
          chunks.map((c) => c.contextualText),
          embedder,
        );
        similarities = chunks
          .map((rec, i) => ({ rec, similarity: cosine(queryVector, vectors[i]) }))
          .sort((a, b) => b.similarity - a.similarity);
      } catch (error) {
        usedExternalEmbedder = false;
        embeddingError = safeError(error);
      }
    }

    if (!usedExternalEmbedder) {
      usedLocalFallback = true;
      // Local vectors stay in memory (embedTextLocal keeps them): the
      // persisted index is for vectors an endpoint computed.
      const queryVector = embedTextLocal(opts.query);
      const vectors = chunks.map((c) => embedTextLocal(c.contextualText));
      similarities = chunks
        .map((rec, i) => ({ rec, similarity: cosine(queryVector, vectors[i]) }))
        .sort((a, b) => b.similarity - a.similarity);
    }

    const chunkIdOf = (m: KbChunkResult): string =>
      m.pageId ? `page:${m.pageId}` : `${m.docId}#${m.chunkIndex}`;

    const semanticTop = similarities.slice(0, rerankWindow);
    const fused = fuseRanks([
      lexical.map(chunkIdOf),
      semanticTop.map((s) => s.rec.chunkId),
    ]);
    const lexicalById = new Map(lexical.map((m) => [chunkIdOf(m), m]));
    const similarityById = new Map(similarities.map((s) => [s.rec.chunkId, s.similarity]));

    const fusedTop = [...fused.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, rerankWindow);

    const maxRrf = fusedTop[0]?.[1] || 1;
    const maxBm25 = lexical.reduce((acc, m) => Math.max(acc, m.bm25Score ?? 0), 0) || 1;
    const qTokens = tokenize(opts.query);
    const queryLocalVec = embedTextLocal(opts.query);
    const querySparse = sparseTermVector(opts.query);

    const reranked: Array<{ rec: IndexedChunkRecord; result: KbChunkResult }> = [];
    for (const [chunkId, rrfScore] of fusedTop) {
      const rec = this.indexedChunks.get(chunkId);
      if (!rec) continue;
      const lex = lexicalById.get(chunkId);
      const bm25Raw = lex?.bm25Score ?? 0;
      const embedSim = Math.max(0, similarityById.get(chunkId) ?? 0);
      const localSim = usedLocalFallback
        ? embedSim
        : Math.max(0, cosine(queryLocalVec, embedTextLocal(rec.contextualText)));
      const sparseSim = sparseCosine(querySparse, sparseTermVector(rec.contextualText));
      const { coverage, proximity, fieldBoost } = this.proximityAndFieldScore(
        opts.query,
        qTokens,
        rec,
      );

      if (
        usedLocalFallback &&
        bm25Raw === 0 &&
        coverage === 0 &&
        embedSim < 0.14 &&
        sparseSim < 0.12
      ) {
        continue;
      }

      const rrfNorm = rrfScore / maxRrf;
      const bm25Norm = bm25Raw / maxBm25;
      const rawRerank =
        0.28 * rrfNorm +
        0.22 * bm25Norm +
        0.24 * embedSim +
        0.12 * Math.max(localSim, sparseSim) +
        0.14 * coverage +
        proximity +
        fieldBoost;
      const quality = this.qualityMultiplier(rec, {
        clusterFilter,
        pageUse: opts.pageUse,
        staleReasons: opts.staleReasons,
        now,
      });
      const rerankScore = Math.round(rawRerank * quality * 100_000) / 100_000;

      reranked.push({
        rec,
        result: this.toChunkResult(
          rec,
          {
            score: rerankScore,
            rerankScore,
            bm25Score: bm25Raw,
            semanticScore: Math.round((similarityById.get(chunkId) ?? 0) * 1000) / 1000,
            matchedConcepts: lex?.matchedConcepts ?? [],
          },
          opts,
        ),
      });
    }

    const matches = reranked
      .sort((a, b) => b.result.score - a.result.score)
      .slice(0, limit)
      .map((x) => x.result);

    if (!usedExternalEmbedder) {
      return {
        matches,
        retrieval: "lexical",
        ...(embeddingModel ? { embeddingModel } : {}),
        ...(embeddingError ? { embeddingError } : {}),
        usedLocalFallback,
      };
    }

    return {
      matches,
      retrieval: "hybrid",
      embeddingModel,
    };
  }

  /**
   * Mem0 + Voyager inspired automatic memory deduplication, semantic consolidation,
   * and confidence/reinforcement score tracking.
   */
  deduplicateOrMergeMemory(
    existing: MemoryEntry[],
    input: Omit<MemoryEntry, "id" | "updatedAt"> & {
      id?: string;
      /**
       * The new text takes the place of what the matched memory said: the old
       * entry is kept as history (`supersededBy`) instead of being written over
       * or merged into. Not when both name the same command: that is the same advice.
       */
      supersede?: boolean;
    },
  ): { memories: MemoryEntry[]; saved: MemoryEntry; merged: boolean; superseded?: MemoryEntry } {
    const { supersede, ...incoming } = input;
    const now = Date.now();
    const normTitle = incoming.title.trim().toLowerCase();
    const incomingTokens = tokenize(`${incoming.title} ${incoming.text}`);

    let matchIdx = -1;
    if (incoming.id) {
      matchIdx = existing.findIndex((m) => m.id === incoming.id);
    }
    if (matchIdx === -1) {
      matchIdx = existing.findIndex((m) => {
        if (m.supersededBy) return false;
        if (m.kind !== incoming.kind || m.scope !== incoming.scope) return false;
        if (m.title.trim().toLowerCase() === normTitle) return true;
        if (
          incoming.errorSignature &&
          m.errorSignature &&
          incoming.errorSignature === m.errorSignature
        ) {
          return true;
        }
        const mTokens = tokenize(`${m.title} ${m.text}`);
        if (incomingTokens.length >= 3 && mTokens.length >= 3) {
          const overlap = incomingTokens.filter((t) =>
            mTokens.includes(t),
          ).length;
          const ratio =
            overlap / Math.min(incomingTokens.length, mTokens.length);
          if (
            ratio >= 0.78 &&
            m.title.toLowerCase().slice(0, 14) === normTitle.slice(0, 14)
          ) {
            return true;
          }
        }
        return false;
      });
    }

    if (matchIdx >= 0) {
      const prev = existing[matchIdx];
      // Saving a memory by its id is an edit: the new text replaces the old.
      // Only a new note that merely resembles an existing one keeps a trace
      // of what it was merged into.
      const editedById = Boolean(incoming.id) && incoming.id === prev.id;
      const mergedText =
        editedById ||
        incoming.text.trim() === prev.text.trim() ||
        incoming.text.includes(prev.text.trim())
          ? incoming.text.trim()
          : `${incoming.text.trim()} (Earlier note: ${prev.text.trim().slice(0, 240)})`;
      // Saying the same thing again is not evidence that it is true: no confidence for repeating it.
      const prevConfidence = prev.confidence ?? 0.78;
      const nextConfidence = editedById
        ? (incoming.confidence ?? prevConfidence)
        : Math.min(0.99, Math.max(incoming.confidence ?? prevConfidence, prevConfidence));
      const updated: MemoryEntry = {
        ...prev,
        ...incoming,
        id: prev.id,
        // Whoever wrote it stays its author; a teammate who changes it is named beside them.
        author: prev.author ?? incoming.author,
        editedBy: prev.author && incoming.author && incoming.author !== prev.author ? incoming.author : undefined,
        title: incoming.title.trim() || prev.title,
        text: mergedText.slice(0, MAX_MEMORY_TEXT),
        tier: incoming.tier ?? prev.tier ?? "archival",
        cluster: incoming.cluster ?? prev.cluster,
        updatedCount: (prev.updatedCount ?? 1) + 1,
        confidence: nextConfidence,
        // Only what a verified run counted: being learned again is not working again.
        successCount: incoming.successCount ?? prev.successCount ?? 0,
        failureCount: incoming.failureCount ?? prev.failureCount ?? 0,
        usageCount: incoming.usageCount ?? (prev.usageCount ?? 0) + 1,
        feedbackScore: incoming.feedbackScore ?? prev.feedbackScore ?? 0,
        autoLearned: incoming.autoLearned ?? prev.autoLearned,
        sourceCommand: incoming.sourceCommand ?? prev.sourceCommand,
        errorSignature: incoming.errorSignature ?? prev.errorSignature,
        updatedAt: now,
      };
      const next = [...existing];
      if (
        supersede &&
        incoming.text.trim() !== prev.text.trim() &&
        !(incoming.sourceCommand && prev.sourceCommand && incoming.sourceCommand === prev.sourceCommand)
      ) {
        // A new entry says it now; the old one stays, marked, where it was.
        const replacement: MemoryEntry = {
          ...updated,
          id: crypto.randomUUID(),
          // A new entry that says it now is the new writer's own.
          author: incoming.author ?? updated.author,
          editedBy: undefined,
          text: incoming.text.trim().slice(0, MAX_MEMORY_TEXT),
          // What the old text earned is not the new text's.
          successCount: incoming.successCount ?? 0,
          failureCount: incoming.failureCount ?? 0,
          feedbackScore: incoming.feedbackScore ?? 0,
        };
        delete replacement.votes;
        delete replacement.supersededBy;
        delete replacement.supersededAt;
        const old: MemoryEntry = { ...prev, supersededBy: replacement.id, supersededAt: now, updatedAt: now };
        next[matchIdx] = old;
        return {
          memories: capMemories([replacement, ...next]),
          saved: replacement,
          merged: true,
          superseded: old,
        };
      }
      next.splice(matchIdx, 1);
      return {
        memories: capMemories([updated, ...next]),
        saved: updated,
        merged: true,
      };
    }

    const created: MemoryEntry = {
      id: incoming.id || crypto.randomUUID(),
      kind: incoming.kind,
      tier: incoming.tier ?? (incoming.kind === "skill" ? "core" : "archival"),
      cluster: incoming.cluster,
      scope: incoming.scope.trim().slice(0, 80) || "workspace",
      title: incoming.title.trim().slice(0, 120),
      text: incoming.text.trim().slice(0, MAX_MEMORY_TEXT),
      author: incoming.author,
      updatedCount: 1,
      confidence: incoming.confidence ?? (incoming.kind === "skill" ? 0.85 : 0.78),
      successCount: incoming.successCount ?? 0,
      failureCount: incoming.failureCount ?? 0,
      usageCount: incoming.usageCount ?? 1,
      feedbackScore: incoming.feedbackScore ?? 0,
      autoLearned: incoming.autoLearned,
      sourceCommand: incoming.sourceCommand,
      errorSignature: incoming.errorSignature,
      ...(incoming.lastVerifiedAt !== undefined ? { lastVerifiedAt: incoming.lastVerifiedAt } : {}),
      ...(incoming.staleReason !== undefined ? { staleReason: incoming.staleReason } : {}),
      ...(incoming.validUntil !== undefined ? { validUntil: incoming.validUntil } : {}),
      ...(incoming.commandTemplate !== undefined ? { commandTemplate: incoming.commandTemplate } : {}),
      ...(incoming.preconditions !== undefined ? { preconditions: incoming.preconditions } : {}),
      ...(incoming.verifyCommand !== undefined ? { verifyCommand: incoming.verifyCommand } : {}),
      ...(incoming.proven !== undefined ? { proven: incoming.proven } : {}),
      ...(incoming.sourceTrust !== undefined ? { sourceTrust: incoming.sourceTrust } : {}),
      updatedAt: now,
    };

    return {
      memories: capMemories([created, ...existing]),
      saved: created,
      merged: false,
    };
  }

  /**
   * Hybrid ranking of Memories & Skills against a prompt or cluster context.
   * Combines Letta/MemGPT tier priority, BM25/local-semantic matching,
   * Voyager/Reflexion confidence & reinforcement feedback, staleReason decay,
   * and recency half-life modulated by lastVerifiedAt & successCount while
   * sparing human-pinned `core` invariants from recency decay.
   */
  rankMemories(
    memories: MemoryEntry[],
    query: string,
    cluster?: string,
    limit = 16,
    now = Date.now(),
  ): MemoryEntry[] {
    memories = liveMemories(memories);
    if (memories.length === 0) return [];
    const qTokens = tokenize(query);
    const qConcepts = extractSemanticConcepts(qTokens);
    const qVec = query.trim() ? embedTextLocal(query) : undefined;
    const clusterNorm = cluster?.trim().toLowerCase();

    return [...memories]
      .map((m) => {
        const isCoreInvariant =
          m.tier === "core" && (!m.autoLearned || m.sourceTrust === "human");
        const baseTier = m.tier === "core" ? 10 : m.tier === "archival" ? 3.5 : 1;

        // Reinforcement learning & confidence weighting
        const confidence = m.confidence ?? (m.kind === "skill" ? 0.82 : 0.75);
        const reinforcement =
          (confidence - 0.5) * 4.0 +
          Math.min(6, (m.successCount ?? 0) * 1.15) +
          (m.feedbackScore ?? 0) * 2.5 -
          Math.min(5, (m.failureCount ?? 0) * 1.5) +
          (m.proven ? 2.0 : 0) +
          (m.sourceTrust === "human" ? 1.0 : m.sourceTrust === "untrusted" ? -3.0 : 0);

        // Recency half-life modulated by lastVerifiedAt and successCount (sparing core invariants)
        const refAt = Math.max(m.lastVerifiedAt ?? 0, m.updatedAt || 0);
        const ageDays = refAt > 0 ? Math.max(0, (now - refAt) / DAY_MS) : 0;
        const baseHalfLife = m.tier === "episodic" ? 14 : 45;
        const halfLifeDays =
          baseHalfLife *
          (1 +
            Math.min(4, (m.successCount ?? 0) * 0.5) +
            (m.proven ? 1.0 : 0) +
            (m.lastVerifiedAt ? 0.5 : 0));
        const decayFactor = isCoreInvariant ? 1 : Math.pow(0.5, ageDays / halfLifeDays);

        let score =
          (baseTier + reinforcement) * (isCoreInvariant ? 1 : 0.4 + 0.6 * decayFactor) +
          3.0 * decayFactor;

        if (clusterNorm && m.cluster?.toLowerCase() === clusterNorm) {
          score += 6;
        }

        const entryText = `${m.title} ${m.text} ${m.scope} ${m.cluster ?? ""} ${m.sourceCommand ?? ""} ${m.errorSignature ?? ""}`;
        if (qTokens.length > 0) {
          const mTokens = tokenize(entryText);
          for (const q of qTokens) {
            if (mTokens.some((t) => t === q || t.includes(q))) score += 2.5;
          }
          const mConcepts = extractSemanticConcepts(mTokens);
          const conceptHits = qConcepts.filter((c) =>
            mConcepts.includes(c),
          ).length;
          score += conceptHits * 2.0;
        }
        if (qVec) {
          const sim = cosine(qVec, embedTextLocal(entryText));
          if (sim >= 0.16) score += sim * 4.5;
        }

        if (m.staleReason) {
          score = score * 0.45 - 4.0;
        }
        if (m.validUntil && now > m.validUntil) {
          score = score * 0.65 - 2.0;
        }

        return { m, score };
      })
      .sort((a, b) => b.score - a.score || b.m.updatedAt - a.m.updatedAt)
      .slice(0, limit)
      .map((x) => x.m);
  }

  async ingestLocalFolder(
    folderPath: string,
    collectionOrOpts:
      | string
      | {
          collection?: string;
          cluster?: string;
          targetCluster?: string;
          tags?: string[];
        } = "Local Docs",
    targetCluster?: string,
    maxFiles = 300,
  ): Promise<KbDocument[]> {
    const collection =
      typeof collectionOrOpts === "string"
        ? collectionOrOpts
        : collectionOrOpts.collection ||
          collectionOrOpts.cluster ||
          "Local Docs";
    const cluster =
      typeof collectionOrOpts === "string"
        ? targetCluster
        : collectionOrOpts.cluster ||
          collectionOrOpts.targetCluster ||
          targetCluster;
    const tags =
      typeof collectionOrOpts === "string" ? undefined : collectionOrOpts.tags;
    const out: KbDocument[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 3 || out.length >= maxFiles) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (out.length >= maxFiles) break;
        if (entry.name.startsWith(".") || entry.name === "node_modules")
          continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full, depth + 1);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (!TEXT_EXTENSIONS.has(ext) && ![".pdf", ".docx", ".html", ".htm", ".log", ".csv"].includes(ext))
            continue;
          try {
            const stat = await fs.stat(full);
            if (stat.size === 0 || stat.size > MAX_UPLOAD_BYTES) continue;
            const content = (await extractText({ name: entry.name, data: await fs.readFile(full) })).text;
            out.push(
              this.createDocument({
                id: `kb-folder-${crypto.createHash("sha1").update(full).digest("hex").slice(0, 14)}`,
                collection,
                title: path.relative(folderPath, full) || entry.name,
                sourceType: "folder",
                sourceUri: full,
                sourceRef: full,
                targetCluster: cluster,
                cluster,
                tags,
                content,
              }),
            );
          } catch {
            // ignore unreadable file
          }
        }
      }
    };
    await walk(folderPath, 0);
    return out;
  }

  async ingestFromStorageProvider(
    provider: IStorageProvider,
    remotePrefix: string,
    collection = "S3 Docs",
    targetCluster?: string,
    maxFiles = 20,
    /** Where to put down the files that were left out, and why. */
    details: { failed?: { name: string; error: string }[] } = {},
  ): Promise<KbDocument[]> {
    const out: KbDocument[] = [];
    const entries = await provider.list(remotePrefix || "/");
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!TEXT_EXTENSIONS.has(ext)) continue;
      if (out.length >= maxFiles) {
        details.failed?.push({ name: entry.name, error: `Left out: at most ${maxFiles} files are read at a time.` });
        continue;
      }
      if (entry.size > 200_000) {
        details.failed?.push({ name: entry.name, error: "Larger than 200 kB." });
        continue;
      }
      try {
        let text = "";
        if (typeof provider.readFile === "function") {
          const buf = await provider.readFile(entry.path);
          text = buf.toString("utf-8");
        } else {
          const stream = await provider.createReadStream(entry.path);
          const chunks: Buffer[] = [];
          for await (const chunk of stream as AsyncIterable<Buffer | string>) {
            chunks.push(
              typeof chunk === "string" ? Buffer.from(chunk) : chunk,
            );
          }
          text = Buffer.concat(chunks).toString("utf-8");
        }
        if (text.trim()) {
          out.push(
            this.createDocument({
              id: `kb-s3-${crypto.createHash("sha1").update(`${provider.id}:${entry.path}`).digest("hex").slice(0, 14)}`,
              collection,
              title: entry.name,
              sourceType: "s3",
              sourceUri: `${provider.name}:${entry.path}`,
              targetCluster,
              content: text,
            }),
          );
        }
      } catch (error) {
        // An object that cannot be read is left out, and said to be.
        details.failed?.push({ name: entry.name, error: (error instanceof Error ? error.message : String(error)).slice(0, 200) });
      }
    }
    return out;
  }
}
