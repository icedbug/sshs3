import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { KbDocument } from "../../../shared/types/aiHub";
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

    // BM25 parameters
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

    const scored: KbChunkResult[] = [];
    const N = allChunks.length;

    for (const c of allChunks) {
      let score = 0;
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
        score +=
          idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (len / avgLen))));
      }
      const docCluster = (c.doc.cluster || c.doc.targetCluster || "").toLowerCase();
      if (clusterFilter && docCluster && docCluster === clusterFilter) {
        score *= 1.35;
      }
      if (c.doc.title.toLowerCase().includes(query.toLowerCase().trim())) {
        score += 2.0;
      }
      if (score > 0) {
        scored.push({
          docId: c.doc.id,
          title: c.doc.title,
          collection: c.doc.collection || c.doc.cluster || "General",
          targetCluster: c.doc.cluster || c.doc.targetCluster,
          sourceUri: c.doc.sourceRef || c.doc.sourceUri,
          chunkIndex: c.chunkIndex,
          snippet: c.text,
          score: Math.round(score * 1000) / 1000,
        });
      }
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
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
