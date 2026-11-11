import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  EmbeddingIndex,
  cosine,
  fuseRanks,
  openAiCompatibleEmbedder,
  type Embedder,
} from "../../src/main/ai/hub/EmbeddingIndex";
import { KnowledgeBaseService } from "../../src/main/ai/hub/KnowledgeBaseService";
import type { KbDocument } from "../../src/shared/types/aiHub";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});
const tmp = async (): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-emb-"));
  dirs.push(dir);
  return dir;
};

/**
 * A stand-in vector space with two directions: "the machine cannot take more
 * load" and "certificates". Texts about the same thing point the same way
 * although they share no word.
 */
const AXES: Array<[RegExp, number[]]> = [
  [/overloaded|saturat|out of capacity|no headroom|run queue/i, [1, 0]],
  [/certificate|tls|x509|expired cert/i, [0, 1]],
];
const fakeVector = (text: string): number[] => {
  const v = [0.01, 0.01];
  for (const [re, axis] of AXES) if (re.test(text)) axis.forEach((x, i) => (v[i] += x));
  return v;
};
function fakeEmbedder(model = "fake-embed"): Embedder & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    model,
    calls,
    async embed(texts) {
      calls.push(texts);
      return texts.map(fakeVector);
    },
  };
}

const kb = new KnowledgeBaseService();
const doc = (id: string, title: string, content: string): KbDocument =>
  kb.createDocument({ id, title, content, collection: "ops" });
const docs = [
  doc("d-load", "Scheduler notes", "When the run queue stays above core count there is no headroom left; add nodes."),
  doc("d-cert", "Ingress renewal", "Renew the x509 material with cert-manager before it lapses."),
  doc("d-other", "Office wifi", "The guest network password rotates monthly."),
];

describe("vector helpers", () => {
  it("cosine compares direction and refuses mismatched vectors", () => {
    expect(cosine([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([1, 0], [1, 0, 0])).toBe(0);
    expect(cosine([0, 0], [1, 0])).toBe(0);
  });

  it("rank fusion puts an item both lists agree on above one that tops a single list", () => {
    const fused = fuseRanks([
      ["a", "b", "c"],
      ["d", "b", "a"],
    ]);
    const order = [...fused.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id);
    expect(order.slice(0, 2).sort()).toEqual(["a", "b"]);
    expect(fused.get("b")!).toBeGreaterThan(fused.get("d")!);
    expect(fused.get("c")!).toBeLessThan(fused.get("d")!);
  });
});

describe("openAiCompatibleEmbedder", () => {
  it("posts masked text to /embeddings with the key and returns vectors in input order", async () => {
    let seen: { url: string; headers: Record<string, string>; body: { model: string; input: string[] } } | undefined;
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      seen = {
        url: String(url),
        headers: init!.headers as Record<string, string>,
        body: JSON.parse(String(init!.body)),
      };
      return new Response(
        JSON.stringify({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] }),
        { status: 200 },
      );
    });
    const embedder = openAiCompatibleEmbedder({
      baseUrl: "http://localhost:11434/v1/",
      apiKey: "k",
      model: "nomic-embed-text",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const vectors = await embedder.embed(["first password=hunter2secret", "second"]); // pragma: allowlist secret
    expect(seen!.url).toBe("http://localhost:11434/v1/embeddings");
    expect(seen!.headers.Authorization).toBe("Bearer k");
    expect(seen!.body.model).toBe("nomic-embed-text");
    expect(seen!.body.input[0]).not.toContain("hunter2secret");
    expect(vectors).toEqual([[1, 0], [0, 1]]);
  });

  it("fails with the endpoint's status, and on a response that does not match the input", async () => {
    const bad = openAiCompatibleEmbedder({
      baseUrl: "http://x/v1",
      model: "m",
      fetchImpl: (async () => new Response("model not found", { status: 404 })) as unknown as typeof fetch,
    });
    await expect(bad.embed(["a"])).rejects.toThrow(/404/);
    const short = openAiCompatibleEmbedder({
      baseUrl: "http://x/v1",
      model: "m",
      fetchImpl: (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch,
    });
    await expect(short.embed(["a"])).rejects.toThrow(/unexpected response/);
  });
});

describe("EmbeddingIndex", () => {
  it("embeds a text once per model, across instances, and stores no text", async () => {
    const file = path.join(await tmp(), "kb-embeddings.json");
    const embedder = fakeEmbedder();
    const first = new EmbeddingIndex(file);
    await first.vectorsFor(["run queue is long", "tls expired cert"], embedder);
    await first.vectorsFor(["run queue is long", "a new text"], embedder);
    expect(embedder.calls).toEqual([["run queue is long", "tls expired cert"], ["a new text"]]);

    const second = new EmbeddingIndex(file);
    const again = await second.vectorsFor(["tls expired cert"], embedder);
    expect(embedder.calls).toHaveLength(2);
    expect(again[0]).toEqual(fakeVector("tls expired cert"));
    expect(await fs.readFile(file, "utf8")).not.toContain("run queue");

    // Another model is another vector space.
    const other = fakeEmbedder("other-model");
    await second.vectorsFor(["tls expired cert"], other);
    expect(other.calls).toEqual([["tls expired cert"]]);
  });
});

describe("KnowledgeBaseService.searchHybrid", () => {
  it("finds the runbook that means the same although it shares no word with the query, which lexical search misses", async () => {
    const query = "servers are overloaded";
    const lexical = kb.search(docs, { query, limit: 3 });
    expect(lexical.map((m) => m.docId)).not.toContain("d-load");

    const index = new EmbeddingIndex(path.join(await tmp(), "e.json"));
    const found = await kb.searchHybrid(docs, { query, limit: 2 }, fakeEmbedder(), index);
    expect(found.retrieval).toBe("hybrid");
    expect(found.embeddingModel).toBe("fake-embed");
    expect(found.matches[0].docId).toBe("d-load");
    expect(found.matches[0].semanticScore).toBeGreaterThan(0.9);
    expect(found.matches.find((m) => m.docId === "d-cert")?.semanticScore ?? 0).toBeLessThan(0.2);
  });

  it("is lexical, and says so, without an embedder or when the embeddings cannot be had", async () => {
    const index = new EmbeddingIndex(path.join(await tmp(), "e.json"));
    const none = await kb.searchHybrid(docs, { query: "wifi password", limit: 2 }, undefined, index);
    expect(none.retrieval).toBe("lexical");
    expect(none.matches[0].docId).toBe("d-other");

    const broken: Embedder = {
      model: "m",
      embed: async () => {
        throw new Error("Embeddings endpoint (404): model not found");
      },
    };
    const failed = await kb.searchHybrid(docs, { query: "wifi password", limit: 2 }, broken, index);
    expect(failed.retrieval).toBe("lexical");
    expect(failed.embeddingError).toContain("404");
    expect(failed.matches[0].docId).toBe("d-other");
  });

  it("only ranks chunks of the allowed collections", async () => {
    const mixed = [...docs, kb.createDocument({ id: "d-hr", title: "HR", content: "Staff are overloaded in December.", collection: "hr" })];
    const index = new EmbeddingIndex(path.join(await tmp(), "e.json"));
    const found = await kb.searchHybrid(
      mixed,
      { query: "overloaded", collectionIds: ["ops"], limit: 5 },
      fakeEmbedder(),
      index,
    );
    expect(found.matches.map((m) => m.docId)).not.toContain("d-hr");
    expect(found.matches[0].docId).toBe("d-load");
  });
});

describe("HubService embedding configuration", () => {
  it("uses embeddings only for an OpenAI-compatible endpoint with an embedding model, and forgets the model when cleared", async () => {
    const { HubService } = await import("../../src/main/ai/hub/HubService");
    const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
    setDemoModeForTesting(false);
    const dir = await tmp();
    const hub = new HubService(
      {
        changed: () => {},
        inventoryTargets: async () => [],
        backgroundChanged: async () => {},
        openSchedule: async () => "s1",
        show: () => {},
        aiConfigFilePath: path.join(dir, "ai-config.json"),
      },
      dir,
    );
    const embedder = (): Promise<Embedder | undefined> =>
      (hub as unknown as { kbEmbedder(): Promise<Embedder | undefined> }).kbEmbedder();
    try {
      await hub.initialize();
      expect(await embedder()).toBeUndefined();

      const snap = await hub.request({
        action: "configure",
        config: {
          enabled: true,
          provider: "openai-compatible",
          baseUrl: "http://localhost:11434/v1",
          model: "llama3",
          embeddingModel: "  nomic-embed-text ",
        },
      });
      expect(snap.config.embeddingModel).toBe("nomic-embed-text");
      expect((await embedder())?.model).toBe("nomic-embed-text");

      // Anthropic has no embeddings endpoint: the setting is not used there.
      await hub.request({
        action: "configure",
        config: { provider: "anthropic", apiKey: "sk-ant-test" }, // pragma: allowlist secret
      });
      expect(await embedder()).toBeUndefined();

      const cleared = await hub.request({
        action: "configure",
        config: { provider: "openai-compatible", embeddingModel: "" },
      });
      expect(cleared.config.embeddingModel).toBeUndefined();
      expect(await embedder()).toBeUndefined();
    } finally {
      await hub.dispose();
      setDemoModeForTesting(undefined);
    }
  });
});
