import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { maskContext, safeError } from "./privacy";

/**
 * Real text embeddings for the knowledge base. The vectors come from the
 * configured OpenAI-compatible endpoint's `/embeddings` (OpenAI, Ollama,
 * LM Studio, vLLM …). Providers without such an endpoint (ChatGPT/Codex
 * sign-in, Anthropic) have none, and search is then lexical only.
 */
export interface Embedder {
  /** Names the vector space: vectors of different models are never compared. */
  model: string;
  embed(texts: string[]): Promise<number[][]>;
}

const MAX_BATCH = 64;
const MAX_INPUT_CHARS = 8000;

export function openAiCompatibleEmbedder(options: {
  baseUrl: string;
  apiKey?: string;
  model: string;
  fetchImpl?: typeof fetch;
}): Embedder {
  const base = options.baseUrl.replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    model: options.model,
    async embed(texts) {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += MAX_BATCH) {
        // Masked like everything else that leaves for a model endpoint.
        const input = texts
          .slice(i, i + MAX_BATCH)
          .map((t) => maskContext(t).slice(0, MAX_INPUT_CHARS) || " ");
        const response = await fetchImpl(`${base}/embeddings`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(options.apiKey
              ? { Authorization: `Bearer ${options.apiKey}` }
              : {}),
          },
          body: JSON.stringify({ model: options.model, input }),
          signal: AbortSignal.timeout(60_000),
        });
        if (!response.ok)
          throw new Error(
            `Embeddings endpoint (${response.status}): ${safeError(await response.text().catch(() => ""))}`,
          );
        const json = (await response.json()) as {
          data?: Array<{ index?: number; embedding?: number[] }>;
        };
        const rows = [...(json.data ?? [])].sort(
          (a, b) => (a.index ?? 0) - (b.index ?? 0),
        );
        if (
          rows.length !== input.length ||
          rows.some((r) => !Array.isArray(r.embedding) || r.embedding.length === 0)
        )
          throw new Error("Embeddings endpoint returned an unexpected response");
        for (const row of rows) out.push(row.embedding!);
      }
      return out;
    },
  };
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/**
 * Reciprocal rank fusion of ranked id lists: an item scores 1/(k+rank) in
 * each list it appears in. It needs no calibration between a BM25 score and
 * a cosine similarity, which are not on a common scale.
 */
export function fuseRanks(lists: string[][], k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists)
    list.forEach((id, rank) =>
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1)),
    );
  return scores;
}

const keyOf = (model: string, text: string): string =>
  crypto.createHash("sha256").update(`${model}\n${text}`).digest("hex");

/**
 * Vectors by content: a chunk is embedded once per model and found again by
 * the hash of its text, so re-indexing after an edit only embeds what changed.
 * Kept in a file beside the hub store; it holds vectors, never text.
 */
export class EmbeddingIndex {
  private vectors = new Map<string, number[]>();
  private loaded = false;
  private writes: Promise<void> = Promise.resolve();
  constructor(
    private readonly file: string,
    private readonly maxEntries = 20_000,
  ) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await fs.readFile(this.file, "utf8")) as {
        version?: number;
        vectors?: Record<string, number[]>;
      };
      if (raw.version === 1 && raw.vectors)
        this.vectors = new Map(Object.entries(raw.vectors));
    } catch {
      // No cache yet, or an unreadable one: vectors are computed again.
    }
  }

  private save(): Promise<void> {
    const write = async (): Promise<void> => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.tmp-${process.pid}-${crypto.randomUUID()}`;
      await fs.writeFile(
        temporary,
        JSON.stringify({
          version: 1,
          vectors: Object.fromEntries(this.vectors),
        }),
        { mode: 0o600 },
      );
      await fs.rename(temporary, this.file);
    };
    this.writes = this.writes.then(write, write);
    return this.writes;
  }

  /** The vector of every text, embedding only those not seen before with this model. */
  async vectorsFor(texts: string[], embedder: Embedder): Promise<number[][]> {
    await this.load();
    const keys = texts.map((t) => keyOf(embedder.model, t));
    const missing = [
      ...new Map(
        keys
          .map((key, i) => [key, texts[i]] as const)
          .filter(([key]) => !this.vectors.has(key)),
      ),
    ];
    if (missing.length > 0) {
      const embedded = await embedder.embed(missing.map(([, text]) => text));
      missing.forEach(([key], i) => this.vectors.set(key, embedded[i]));
      // Oldest entries go first when the cache is full.
      while (this.vectors.size > this.maxEntries) {
        const oldest = this.vectors.keys().next().value;
        if (oldest === undefined) break;
        this.vectors.delete(oldest);
      }
      await this.save().catch(() => {});
    }
    return keys.map((key) => this.vectors.get(key) ?? []);
  }
}
