import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  create as createOrama,
  insertMultiple as insertMultipleOrama,
  search as searchOrama,
  type AnyOrama,
} from "@orama/orama";
import type { KbDocument, MemoryEntry } from "../../../shared/types/aiHub";
import type { IStorageProvider } from "../../../shared/types/storage";
import {
  cosine,
  fuseRanks,
  type Embedder,
  type EmbeddingIndex,
} from "./EmbeddingIndex";
import { MAX_DOC_CHARS, MAX_UPLOAD_BYTES, extractText, splitSections } from "./KbExtract";
import { safeError } from "./privacy";

export interface KbChunkResult {
  docId: string;
  title: string;
  collection: string;
  targetCluster?: string;
  sourceUri?: string;
  chunkIndex: number;
  snippet: string;
  score: number;
  bm25Score?: number;
  semanticScore?: number;
  matchedConcepts?: string[];
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

interface IndexedChunkRecord {
  chunkId: string;
  doc: KbDocument;
  chunkIndex: number;
  text: string;
  tokens: string[];
  concepts: string[];
}

/** A document's text as the pieces search returns, each knowing the headings it sits under. */
export function sectionsOf(docId: string, content: string): KbDocument["chunks"] {
  return splitSections(content).map((section, idx) => ({
    id: `${docId}#${idx}`,
    heading: section.heading,
    text: section.text,
  }));
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

  private ensureOramaIndex(docs: KbDocument[]): void {
    const sig = docs
      .map((d) => `${d.id}:${d.updatedAt}:${d.chunks?.length ?? 0}`)
      .join("|");
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

    for (const doc of docs) {
      const parts =
        doc.chunks?.length > 0
          ? doc.chunks.map((c) => c.text)
          : splitIntoChunks(doc.content);
      const col = doc.collection || doc.cluster || "General";
      const cl = doc.cluster || doc.targetCluster || "";
      const tagStr = (doc.tags ?? []).join(" ");
      parts.forEach((part, idx) => {
        const chunkId = `${doc.id}#${idx}`;
        // A piece is found by the headings it sits under too, not only by its own words.
        const heading = doc.chunks?.[idx]?.heading ?? "";
        const tokens = tokenize(`${doc.title} ${col} ${cl} ${tagStr} ${heading} ${part}`);
        const concepts = extractSemanticConcepts(tokens);
        chunkMap.set(chunkId, {
          chunkId,
          doc,
          chunkIndex: idx,
          text: part,
          tokens,
          concepts,
        });
        oramaRecords.push({
          chunkId,
          docId: doc.id,
          chunkIndex: idx,
          title: doc.title,
          collection: col,
          cluster: cl,
          tags: `${tagStr} ${heading}`.trim(),
          concepts: concepts.join(" "),
          text: part,
        });
      });
    }

    if (oramaRecords.length > 0) {
      insertMultipleOrama(db, oramaRecords);
    }

    this.oramaDb = db;
    this.oramaSignature = sig;
    this.indexedChunks = chunkMap;
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
    queryOrOpts:
      | string
      | {
          query: string;
          collectionIds?: string[];
          targetCluster?: string;
          cluster?: string;
          limit?: number;
        },
    options?: {
      collectionIds?: string[];
      targetCluster?: string;
      cluster?: string;
      limit?: number;
    },
  ): KbChunkResult[] {
    const query =
      typeof queryOrOpts === "string" ? queryOrOpts : queryOrOpts.query;
    const opts = typeof queryOrOpts === "string" ? options : queryOrOpts;
    const limit = Math.max(1, Math.min(25, opts?.limit ?? 6));
    const qTokens = tokenize(query);
    const allowedCollections = opts?.collectionIds
      ?.map((c) => c.trim().toLowerCase())
      .filter(Boolean);
    const clusterFilter = (opts?.cluster || opts?.targetCluster)
      ?.trim()
      .toLowerCase();

    // Ensure the @orama/orama in-memory hybrid index is up to date
    this.ensureOramaIndex(docs);

    const candidateRecords = [...this.indexedChunks.values()].filter((rec) => {
      if (allowedCollections && allowedCollections.length > 0) {
        const col = (rec.doc.collection || rec.doc.cluster || "").toLowerCase();
        const matchCol =
          allowedCollections.includes(col) ||
          allowedCollections.includes(rec.doc.id.toLowerCase());
        if (!matchCol) return false;
      }
      return true;
    });

    if (candidateRecords.length === 0) return [];

    if (qTokens.length === 0) {
      return candidateRecords.slice(0, limit).map((c) => ({
        docId: c.doc.id,
        title: c.doc.title,
        collection: c.doc.collection || c.doc.cluster || "General",
        targetCluster: c.doc.cluster || c.doc.targetCluster,
        sourceUri: c.doc.sourceRef || c.doc.sourceUri,
        chunkIndex: c.chunkIndex,
        snippet: c.text,
        score: 1,
      }));
    }

    // 1. Query @orama/orama full-text BM25 + typo-tolerant index AND hybrid vector index
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
          limit: Math.max(25, limit * 4),
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
        `${c.doc.title} ${c.text.slice(0, 400)}`,
      );
      const semanticScore =
        Math.round(
          (conceptBoost + (trigramSim >= 0.12 ? trigramSim * 1.8 : 0)) * 1000,
        ) / 1000;

      let totalScore = lexicalBm25 + semanticScore;

      const docCluster = (
        c.doc.cluster ||
        c.doc.targetCluster ||
        ""
      ).toLowerCase();
      if (clusterFilter && docCluster && docCluster === clusterFilter) {
        totalScore *= 1.35;
      }
      if (c.doc.title.toLowerCase().includes(query.toLowerCase().trim())) {
        totalScore += 2.0;
      }
      if (totalScore > 0) {
        scored.push({
          docId: c.doc.id,
          title: c.doc.title,
          collection: c.doc.collection || c.doc.cluster || "General",
          targetCluster: c.doc.cluster || c.doc.targetCluster,
          sourceUri: c.doc.sourceRef || c.doc.sourceUri,
          chunkIndex: c.chunkIndex,
          snippet: c.text,
          score: Math.round(totalScore * 1000) / 1000,
          bm25Score: Math.round(lexicalBm25 * 1000) / 1000,
          semanticScore,
          matchedConcepts,
        });
      }
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * Lexical search fused with ranking by meaning. Every chunk of the allowed
   * collections is compared with the query by the cosine of real embeddings;
   * that ranking and the lexical one are combined by reciprocal rank fusion,
   * so a chunk that says the same thing in other words is found although it
   * shares no term with the query. `retrieval` says what was actually used:
   * when the embeddings cannot be had, the lexical result is returned with
   * the reason.
   */
  async searchHybrid(
    docs: KbDocument[],
    opts: {
      query: string;
      collectionIds?: string[];
      cluster?: string;
      limit?: number;
    },
    embedder: Embedder | undefined,
    index: EmbeddingIndex,
  ): Promise<{
    matches: KbChunkResult[];
    retrieval: "hybrid" | "lexical";
    embeddingModel?: string;
    embeddingError?: string;
  }> {
    const limit = Math.max(1, Math.min(25, opts.limit ?? 6));
    const lexical = this.search(docs, { ...opts, limit: 25 });
    if (!embedder || !opts.query.trim())
      return { matches: lexical.slice(0, limit), retrieval: "lexical" };

    const allowed = opts.collectionIds
      ?.map((c) => c.trim().toLowerCase())
      .filter(Boolean);
    const chunks = [...this.indexedChunks.values()].filter((rec) => {
      if (!allowed || allowed.length === 0) return true;
      const col = (rec.doc.collection || rec.doc.cluster || "").toLowerCase();
      return allowed.includes(col) || allowed.includes(rec.doc.id.toLowerCase());
    });
    if (chunks.length === 0) return { matches: [], retrieval: "lexical" };

    let similarities: Array<{ rec: IndexedChunkRecord; similarity: number }>;
    try {
      const [queryVector] = await embedder.embed([opts.query]);
      const vectors = await index.vectorsFor(
        chunks.map((c) => `${c.doc.title}\n${c.text}`),
        embedder,
      );
      similarities = chunks
        .map((rec, i) => ({ rec, similarity: cosine(queryVector, vectors[i]) }))
        .sort((a, b) => b.similarity - a.similarity);
    } catch (error) {
      return {
        matches: lexical.slice(0, limit),
        retrieval: "lexical",
        embeddingModel: embedder.model,
        embeddingError: safeError(error),
      };
    }

    const semanticTop = similarities.slice(0, 25);
    const fused = fuseRanks([
      lexical.map((m) => `${m.docId}#${m.chunkIndex}`),
      semanticTop.map((s) => s.rec.chunkId),
    ]);
    const lexicalById = new Map(
      lexical.map((m) => [`${m.docId}#${m.chunkIndex}`, m]),
    );
    const similarityById = new Map(
      similarities.map((s) => [s.rec.chunkId, s.similarity]),
    );
    const matches = [...fused.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([chunkId, score]): KbChunkResult => {
        const rec = this.indexedChunks.get(chunkId)!;
        const lex = lexicalById.get(chunkId);
        return {
          docId: rec.doc.id,
          title: rec.doc.title,
          collection: rec.doc.collection || rec.doc.cluster || "General",
          targetCluster: rec.doc.cluster || rec.doc.targetCluster,
          sourceUri: rec.doc.sourceRef || rec.doc.sourceUri,
          chunkIndex: rec.chunkIndex,
          snippet: rec.text,
          score: Math.round(score * 100_000) / 100_000,
          bm25Score: lex?.bm25Score ?? 0,
          semanticScore:
            Math.round((similarityById.get(chunkId) ?? 0) * 1000) / 1000,
          matchedConcepts: lex?.matchedConcepts ?? [],
        };
      });
    return { matches, retrieval: "hybrid", embeddingModel: embedder.model };
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
   * Combines Letta/MemGPT tier priority, Orama/BM25 lexical + semantic concept matching,
   * and Voyager/Reflexion confidence & reinforcement feedback scores.
   */
  rankMemories(
    memories: MemoryEntry[],
    query: string,
    cluster?: string,
    limit = 16,
  ): MemoryEntry[] {
    memories = liveMemories(memories);
    if (memories.length === 0) return [];
    const qTokens = tokenize(query);
    const qConcepts = extractSemanticConcepts(qTokens);
    const clusterNorm = cluster?.trim().toLowerCase();

    return [...memories]
      .map((m) => {
        let score = m.tier === "core" ? 10 : m.tier === "archival" ? 3.5 : 1;
        if (clusterNorm && m.cluster?.toLowerCase() === clusterNorm) {
          score += 6;
        }
        // Reinforcement learning & confidence weighting
        const confidence = m.confidence ?? (m.kind === "skill" ? 0.82 : 0.75);
        score += (confidence - 0.5) * 4.0;
        score += Math.min(6, (m.successCount ?? 0) * 1.15);
        score += (m.feedbackScore ?? 0) * 2.5;
        score -= Math.min(5, (m.failureCount ?? 0) * 1.5);

        if (qTokens.length > 0) {
          const mTokens = tokenize(
            `${m.title} ${m.text} ${m.scope} ${m.cluster ?? ""} ${m.sourceCommand ?? ""} ${m.errorSignature ?? ""}`,
          );
          for (const q of qTokens) {
            if (mTokens.some((t) => t === q || t.includes(q))) score += 2.5;
          }
          const mConcepts = extractSemanticConcepts(mTokens);
          const conceptHits = qConcepts.filter((c) =>
            mConcepts.includes(c),
          ).length;
          score += conceptHits * 2.0;
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
  ): Promise<KbDocument[]> {
    const out: KbDocument[] = [];
    const entries = await provider.list(remotePrefix || "/");
    for (const entry of entries) {
      if (out.length >= maxFiles) break;
      if (entry.isDirectory) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!TEXT_EXTENSIONS.has(ext)) continue;
      if (entry.size > 200_000) continue;
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
      } catch {
        // skip unreadable object
      }
    }
    return out;
  }
}
