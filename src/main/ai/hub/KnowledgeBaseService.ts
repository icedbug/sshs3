import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { KbDocument, MemoryEntry } from "../../../shared/types/aiHub";
import type { IStorageProvider } from "../../../shared/types/storage";

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
 * Orama-inspired Hybrid Semantic Concept Dictionary for bilingual (SV/EN) DevOps,
 * Storage (NetApp ONTAP, Ceph, ZFS, S3), Kubernetes, and Linux infrastructure.
 */
const SEMANTIC_CONCEPT_CLUSTERS: Record<string, string[]> = {
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
};

export function extractSemanticConcepts(tokens: string[]): string[] {
  const matched: string[] = [];
  for (const [concept, keywords] of Object.entries(SEMANTIC_CONCEPT_CLUSTERS)) {
    const hit = tokens.some((tok) =>
      keywords.some((kw) => tok === kw || (tok.length >= 4 && kw.startsWith(tok)) || (kw.length >= 4 && tok.startsWith(kw))),
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

export function splitIntoChunks(text: string, maxChunkChars = 1200, overlapChars = 180): string[] {
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

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9åäö_.-]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

export class KnowledgeBaseService {
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
    const content = input.content.slice(0, 250_000);
    const id = input.id || crypto.randomUUID();
    const rawChunks = splitIntoChunks(content);
    const chunks = rawChunks.map((text, idx) => {
      const headingMatch = /^#{1,3}\s+(.+)$/m.exec(text);
      return {
        id: `${id}#${idx}`,
        heading: headingMatch ? headingMatch[1].trim() : undefined,
        text,
      };
    });
    const cluster = input.cluster?.trim() || input.targetCluster?.trim() || undefined;
    const sourceRef = input.sourceRef?.trim() || input.sourceUri?.trim() || undefined;
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
    const query = typeof queryOrOpts === "string" ? queryOrOpts : queryOrOpts.query;
    const opts = typeof queryOrOpts === "string" ? options : queryOrOpts;
    const limit = Math.max(1, Math.min(25, opts?.limit ?? 6));
    const qTokens = tokenize(query);
    const allowedCollections = opts?.collectionIds
      ?.map((c) => c.trim().toLowerCase())
      .filter(Boolean);
    const clusterFilter = (opts?.cluster || opts?.targetCluster)?.trim().toLowerCase();

    const candidateDocs = docs.filter((doc) => {
      if (allowedCollections && allowedCollections.length > 0) {
        const col = (doc.collection || doc.cluster || "").toLowerCase();
        const matchCol =
          allowedCollections.includes(col) ||
          allowedCollections.includes(doc.id.toLowerCase());
        if (!matchCol) return false;
      }
      return true;
    });

    const allChunks: Array<{
      doc: KbDocument;
      chunkIndex: number;
      text: string;
      tokens: string[];
    }> = [];

    for (const doc of candidateDocs) {
      const parts =
        doc.chunks?.length > 0
          ? doc.chunks.map((c) => c.text)
          : splitIntoChunks(doc.content);
      const col = doc.collection || doc.cluster || "General";
      const cl = doc.cluster || doc.targetCluster || "";
      parts.forEach((part, idx) => {
        allChunks.push({
          doc,
          chunkIndex: idx,
          text: part,
          tokens: tokenize(`${doc.title} ${col} ${cl} ${(doc.tags ?? []).join(" ")} ${part}`),
        });
      });
    }

    if (allChunks.length === 0) return [];

    if (qTokens.length === 0) {
      return allChunks.slice(0, limit).map((c) => ({
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

    // BM25 + Hybrid Semantic Concept parameters (Orama pattern)
    const k1 = 1.5;
    const b = 0.75;
    const avgLen =
      allChunks.reduce((acc, c) => acc + c.tokens.length, 0) / allChunks.length || 1;
    const docFreq = new Map<string, number>();
    for (const q of qTokens) {
      let df = 0;
      for (const c of allChunks) {
        if (c.tokens.some((t) => t === q || t.includes(q))) df++;
      }
      docFreq.set(q, df);
    }

    const queryConcepts = extractSemanticConcepts(qTokens);
    const scored: KbChunkResult[] = [];
    const N = allChunks.length;

    for (const c of allChunks) {
      let bm25Score = 0;
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
        bm25Score +=
          idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (len / avgLen))));
      }

      // Semantic concept match + character trigram similarity
      const chunkConcepts = extractSemanticConcepts(c.tokens);
      const matchedConcepts = queryConcepts.filter((qc) =>
        chunkConcepts.includes(qc),
      );
      const conceptBoost = matchedConcepts.length * 1.45;
      const trigramSim = computeTrigramSimilarity(
        query,
        `${c.doc.title} ${c.text.slice(0, 400)}`,
      );
      const semanticScore =
        Math.round((conceptBoost + (trigramSim >= 0.12 ? trigramSim * 1.8 : 0)) * 1000) /
        1000;

      let totalScore = bm25Score + semanticScore;

      const docCluster = (c.doc.cluster || c.doc.targetCluster || "").toLowerCase();
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
          bm25Score: Math.round(bm25Score * 1000) / 1000,
          semanticScore,
          matchedConcepts,
        });
      }
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * Mem0-inspired automatic memory deduplication & semantic consolidation.
   * If a memory with the same scope/kind and high title/concept overlap already exists,
   * merges and updates it in-place rather than creating duplicate entries.
   */
  deduplicateOrMergeMemory(
    existing: MemoryEntry[],
    incoming: Omit<MemoryEntry, "id" | "updatedAt"> & { id?: string },
  ): { memories: MemoryEntry[]; saved: MemoryEntry; merged: boolean } {
    const now = Date.now();
    const normTitle = incoming.title.trim().toLowerCase();
    const incomingTokens = tokenize(`${incoming.title} ${incoming.text}`);

    let matchIdx = -1;
    if (incoming.id) {
      matchIdx = existing.findIndex((m) => m.id === incoming.id);
    }
    if (matchIdx === -1) {
      matchIdx = existing.findIndex((m) => {
        if (m.kind !== incoming.kind || m.scope !== incoming.scope) return false;
        if (m.title.trim().toLowerCase() === normTitle) return true;
        const mTokens = tokenize(`${m.title} ${m.text}`);
        if (incomingTokens.length >= 3 && mTokens.length >= 3) {
          const overlap = incomingTokens.filter((t) => mTokens.includes(t)).length;
          const ratio = overlap / Math.min(incomingTokens.length, mTokens.length);
          if (ratio >= 0.78 && m.title.toLowerCase().slice(0, 14) === normTitle.slice(0, 14)) {
            return true;
          }
        }
        return false;
      });
    }

    if (matchIdx >= 0) {
      const prev = existing[matchIdx];
      const mergedText =
        incoming.text.trim() === prev.text.trim() ||
        incoming.text.includes(prev.text.trim())
          ? incoming.text.trim()
          : `${incoming.text.trim()} (Tidigare notering: ${prev.text.trim().slice(0, 240)})`;
      const updated: MemoryEntry = {
        ...prev,
        ...incoming,
        id: prev.id,
        title: incoming.title.trim() || prev.title,
        text: mergedText.slice(0, 1200),
        tier: incoming.tier ?? prev.tier ?? "archival",
        cluster: incoming.cluster ?? prev.cluster,
        updatedCount: (prev.updatedCount ?? 1) + 1,
        updatedAt: now,
      };
      const next = [...existing];
      next.splice(matchIdx, 1);
      return {
        memories: [updated, ...next].slice(0, 80),
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
      text: incoming.text.trim().slice(0, 1200),
      author: incoming.author,
      updatedCount: 1,
      updatedAt: now,
    };

    return {
      memories: [created, ...existing].slice(0, 80),
      saved: created,
      merged: false,
    };
  }

  /**
   * Hybrid ranking of Memories & Skills against a prompt or cluster context.
   * Core memories are always prioritized first, followed by highest Hybrid BM25 + Semantic matches.
   */
  rankMemories(
    memories: MemoryEntry[],
    query: string,
    cluster?: string,
    limit = 16,
  ): MemoryEntry[] {
    if (memories.length <= limit && !query.trim()) return memories;
    const qTokens = tokenize(query);
    const qConcepts = extractSemanticConcepts(qTokens);
    const clusterNorm = cluster?.trim().toLowerCase();

    return [...memories]
      .map((m) => {
        let score = m.tier === "core" ? 10 : m.tier === "archival" ? 3 : 1;
        if (clusterNorm && m.cluster?.toLowerCase() === clusterNorm) {
          score += 6;
        }
        if (qTokens.length > 0) {
          const mTokens = tokenize(`${m.title} ${m.text} ${m.scope} ${m.cluster ?? ""}`);
          for (const q of qTokens) {
            if (mTokens.some((t) => t === q || t.includes(q))) score += 2.5;
          }
          const mConcepts = extractSemanticConcepts(mTokens);
          const conceptHits = qConcepts.filter((c) => mConcepts.includes(c)).length;
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
    maxFiles = 25,
  ): Promise<KbDocument[]> {
    const collection =
      typeof collectionOrOpts === "string"
        ? collectionOrOpts
        : collectionOrOpts.collection || collectionOrOpts.cluster || "Local Docs";
    const cluster =
      typeof collectionOrOpts === "string"
        ? targetCluster
        : collectionOrOpts.cluster || collectionOrOpts.targetCluster || targetCluster;
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
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full, depth + 1);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (!TEXT_EXTENSIONS.has(ext)) continue;
          try {
            const stat = await fs.stat(full);
            if (stat.size === 0 || stat.size > 200_000) continue;
            const content = await fs.readFile(full, "utf-8");
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
            chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
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
