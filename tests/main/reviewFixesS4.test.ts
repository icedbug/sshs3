import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  EmbeddingIndex,
  LOCAL_FALLBACK_MODEL,
  embedTextLocal,
  localFallbackEmbedder,
  localVectorMemoSize,
} from "../../src/main/ai/hub/EmbeddingIndex";
import { KnowledgeBaseService, documentRevisedBy } from "../../src/main/ai/hub/KnowledgeBaseService";
import { WorkSync, isPreconditionFailedError, type ConditionalQueueStore } from "../../src/main/ai/hub/WorkSync";
import { compareVersion, mergeItems, type Mergeable } from "../../src/main/ai/hub/WorkBoard";
import type { KbDocument, MemoryEntry } from "../../src/shared/types/aiHub";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
const tmp = async (): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-s4-"));
  dirs.push(dir);
  return dir;
};
const exists = (file: string): Promise<boolean> =>
  fs.stat(file).then(
    () => true,
    () => false,
  );

describe("local embeddings stay in memory", () => {
  it("search without an embedding endpoint writes nothing to the persisted index", async () => {
    const kb = new KnowledgeBaseService();
    const docs = [
      kb.createDocument({ id: "d1", title: "Disk full", content: "When /var is full, rotate the logs with logrotate -f.", collection: "ops" }),
      kb.createDocument({ id: "d2", title: "Certificates", content: "Renew the certificate with certbot renew.", collection: "ops" }),
    ];
    const file = path.join(await tmp(), "kb-embeddings.json");
    const found = await kb.searchHybrid(docs, { query: "disk is full", limit: 2 }, undefined, new EmbeddingIndex(file));
    expect(found.usedLocalFallback).toBe(true);
    expect(found.matches[0].docId).toBe("d1");
    expect(await exists(file)).toBe(false);
  });

  it("the index does not store local vectors even when asked to", async () => {
    const file = path.join(await tmp(), "kb-embeddings.json");
    const vectors = await new EmbeddingIndex(file).vectorsFor(["a text", "another text"], localFallbackEmbedder());
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toHaveLength(384);
    expect(await exists(file)).toBe(false);
    expect(localFallbackEmbedder().model).toBe(LOCAL_FALLBACK_MODEL);
  });

  it("a text is embedded once and its vector reused (memoised, read-only)", () => {
    const text = `memo test ${Math.random()}`;
    const first = embedTextLocal(text);
    expect(embedTextLocal(text)).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(embedTextLocal(text, 64)).toHaveLength(64);
  });

  it("ranking memories twice embeds nothing new the second time", () => {
    const kb = new KnowledgeBaseService();
    const memories: MemoryEntry[] = Array.from({ length: 20 }, (_, i) => ({
      id: `m${i}`,
      kind: "memory" as const,
      scope: "workspace",
      title: `Memory ${i} ${Math.random()}`,
      text: `nginx reload number ${i}`,
      updatedAt: 1_000 + i,
    }));
    kb.rankMemories(memories, "reload nginx");
    const after = localVectorMemoSize();
    kb.rankMemories(memories, "reload nginx");
    expect(localVectorMemoSize()).toBe(after);
  });
});

describe("WorkSync.claim over an unreadable claim", () => {
  function store(initial: string, etag: string) {
    const files = new Map<string, Buffer>([["work/claims/t1.json", Buffer.from(initial)]]);
    const writes: Array<{ ifMatch?: string; ifNoneMatch?: string } | undefined> = [];
    const s: ConditionalQueueStore & { writes: typeof writes } = {
      supportsConditionalWrite: true,
      writes,
      list: async () => [],
      read: async (p) => files.get(p),
      readWithMeta: async (p) => (files.has(p) ? { buffer: files.get(p)!, etag } : undefined),
      remove: async (p) => {
        files.delete(p);
      },
      write: async (p, content, options) => {
        writes.push(options);
        if (options?.ifNoneMatch === "*" && files.has(p))
          throw Object.assign(new Error("At least one of the pre-conditions you specified did not hold"), {
            name: "PreconditionFailed",
            $metadata: { httpStatusCode: 412 },
          });
        if (options?.ifMatch && options.ifMatch !== etag)
          throw Object.assign(new Error("precondition"), { $metadata: { httpStatusCode: 412 } });
        files.set(p, Buffer.from(content));
      },
    };
    return s;
  }

  it("replaces it as the copy that was read (If-Match), and holds the claim", async () => {
    const s = store("{not json", '"e1"');
    const held = await new WorkSync(s).claim("t1", { by: "anna", client: "c-a" }, 1_000);
    expect(s.writes).toEqual([{ ifMatch: '"e1"' }]);
    expect(held.client).toBe("c-a");
  });

  it("does not answer with its own claim when its write lost", async () => {
    const s = store("{not json", '"e1"');
    // Somebody else replaced it between the read and the write: the etag no longer matches.
    s.readWithMeta = async () => ({ buffer: Buffer.from("{not json"), etag: '"stale"' });
    const held = await new WorkSync(s).claim("t1", { by: "anna", client: "c-a" }, 1_000);
    expect(held.client).not.toBe("c-a");
  });
});

describe("isPreconditionFailedError", () => {
  it("is told by status or name, not by words in a message", () => {
    expect(isPreconditionFailedError(Object.assign(new Error("x"), { $metadata: { httpStatusCode: 412 } }))).toBe(true);
    expect(isPreconditionFailedError(Object.assign(new Error("x"), { name: "PreconditionFailed" }))).toBe(true);
    expect(isPreconditionFailedError(Object.assign(new Error("x"), { statusCode: 412 }))).toBe(true);
    expect(isPreconditionFailedError(Object.assign(new Error("x"), { code: "EEXIST" }))).toBe(true);
    expect(isPreconditionFailedError(new Error("Request timed out after 412 ms"))).toBe(false);
    expect(isPreconditionFailedError(new Error("proxy rejected header if-match"))).toBe(false);
    expect(isPreconditionFailedError(new Error("Precondition Failed"))).toBe(false);
    expect(isPreconditionFailedError(undefined)).toBe(false);
  });
});

describe("two copies with the same updatedAt", () => {
  type Item = Mergeable & { title: string };
  it("both installations keep the same one", () => {
    const a: Item = { id: "t1", updatedAt: 500, title: "Restart nginx" };
    const b: Item = { id: "t1", updatedAt: 500, title: "Reload nginx" };
    const here = mergeItems([a], [b]).items[0];
    const there = mergeItems([b], [a]).items[0];
    expect(here).toEqual(there);
    expect(Math.sign(compareVersion(a, b))).toBe(-Math.sign(compareVersion(b, a)));
    expect(compareVersion(a, { ...a })).toBe(0);
  });
});

describe("pasted texts under one source name", () => {
  const doc = (id: string, title: string, sourceType: KbDocument["sourceType"], sourceRef?: string): KbDocument => ({
    id,
    title,
    sourceType,
    sourceRef,
    content: title,
    chunks: [],
    updatedAt: 1,
  });
  const docs = [doc("d1", "Incident command runbook", "paste", "anna"), doc("d2", "Status page", "url", "https://x.test/status")];

  it("a text with another title is a new document, and the reply says so", () => {
    const r = documentRevisedBy(docs, { sourceType: "paste", sourceRef: "anna" }, "On-call policy", 1);
    expect(r.earlier).toBeUndefined();
    expect(r.notes?.[0]).toMatch(/"On-call policy" was added as a new document: "Incident command runbook" already has the source "anna"/);
  });

  it("the same title revises the document", () => {
    expect(documentRevisedBy(docs, { sourceType: "paste", sourceRef: "anna" }, " incident command RUNBOOK ", 1).earlier?.id).toBe("d1");
  });

  it("an address is the same source whatever its title; a split text is always new", () => {
    expect(documentRevisedBy(docs, { sourceType: "url", sourceRef: "https://x.test/status" }, "Other", 1).earlier?.id).toBe("d2");
    expect(documentRevisedBy(docs, { sourceType: "url", sourceRef: "https://x.test/status" }, "Other", 3)).toEqual({});
    expect(documentRevisedBy(docs, { sourceType: "upload", sourceRef: "anna" }, "x", 1)).toEqual({});
    expect(documentRevisedBy(docs, { sourceType: "paste" }, "x", 1)).toEqual({});
  });
});
