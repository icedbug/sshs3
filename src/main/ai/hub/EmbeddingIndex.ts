import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AiPiiScrubbingMode } from "../../../shared/types/ai";
import { maskProviderText, safeError } from "./privacy";

/**
 * Real text embeddings for the knowledge base. The vectors come from the
 * configured OpenAI-compatible endpoint's `/embeddings` (OpenAI, Ollama,
 * LM Studio, vLLM …). Providers without such an endpoint (ChatGPT/Codex
 * sign-in, Anthropic) have none, and search is then lexical only.
 */
export interface Embedder {
  /** Names the vector space: vectors of different models are never compared. */
  model: string;
  /** Distinguishes endpoints that serve different vectors under the same model name. */
  cacheKey?: string;
  embed(texts: string[]): Promise<number[][]>;
}

const MAX_BATCH = 64;
const MAX_INPUT_CHARS = 8000;

export function openAiCompatibleEmbedder(options: {
  baseUrl: string;
  apiKey?: string;
  model: string;
  fetchImpl?: typeof fetch;
  piiMode?: AiPiiScrubbingMode;
  hosts?: ReadonlySet<string>;
}): Embedder {
  const base = options.baseUrl.replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    model: options.model,
    cacheKey: JSON.stringify([base, options.model]),
    async embed(texts) {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += MAX_BATCH) {
        // Masked like everything else that leaves for a model endpoint.
        const input = texts
          .slice(i, i + MAX_BATCH)
          .map((t) => maskProviderText(t, options.piiMode, options.hosts).slice(0, MAX_INPUT_CHARS) || " ");
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

export const LOCAL_FALLBACK_MODEL = "local-ngram-v1";
export const LOCAL_EMBEDDING_DIMS = 384;

function fnv1a32(input: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const LOCAL_STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "when", "what",
  "where", "which", "your", "their", "there", "here", "are", "was", "were",
  "been", "have", "has", "had", "not", "but", "can", "will", "would", "should",
]);

function lightStem(word: string): string {
  if (word.length < 5) return word;
  if (word.endsWith("ies") && word.length > 5) return `${word.slice(0, -3)}y`;
  for (const suffix of ["ization", "ation", "ments", "ment", "ness", "ings", "ing", "ers", "ed", "es", "ly", "s"]) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}

function splitSubwords(token: string): string[] {
  const spaced = token.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return spaced
    .split(/[_\-./:]+/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 2);
}

/** Tokenizes text into normalized words and subwords for local vector projection. */
export function tokenizeLocalEmbedding(text: string): string[] {
  const raw = text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}_./:-]+/u)
    .map((t) => t.replace(/^[._:/-]+|[._:/-]+$/g, ""))
    .filter((t) => t.length >= 2 && !LOCAL_STOPWORDS.has(t));
  return raw;
}

function addHashedFeature(vec: Float64Array, feature: string, weight: number, dims: number): void {
  const h1 = fnv1a32(feature, 0x811c9dc5);
  const h2 = fnv1a32(feature, 0x9e3779b1);
  const idx = h1 % dims;
  const sign = (h2 & 1) === 0 ? 1 : -1;
  vec[idx] += sign * weight;
}

/**
 * Zero-dependency deterministic local embedding via signed feature hashing over
 * word unigrams, stems, subword splits, word bigrams, and character n-grams.
 * Gives Anthropic/Codex/OAuth users real fuzzy and morphological recall with
 * no external embedding endpoint.
 */
export function embedTextLocal(text: string, dims = LOCAL_EMBEDDING_DIMS): number[] {
  // The same texts (pages, memories, chunks) are ranked again on every
  // question: their vectors are kept in memory, never on disk, where they
  // would cost more to write than to compute.
  const key = `${dims}:${crypto.createHash("sha1").update(text.slice(0, MAX_INPUT_CHARS)).digest("base64")}`;
  const cached = localVectorMemo.get(key);
  if (cached) {
    localVectorMemo.delete(key);
    localVectorMemo.set(key, cached);
    return cached;
  }
  const vector = Object.freeze(computeLocalVector(text, dims)) as number[];
  localVectorMemo.set(key, vector);
  while (localVectorMemo.size > LOCAL_MEMO_MAX) {
    const oldest = localVectorMemo.keys().next().value;
    if (oldest === undefined) break;
    localVectorMemo.delete(oldest);
  }
  return vector;
}

const LOCAL_MEMO_MAX = 6000;
const localVectorMemo = new Map<string, number[]>();

/** For tests: how many local vectors are held in memory. */
export function localVectorMemoSize(): number {
  return localVectorMemo.size;
}

function computeLocalVector(text: string, dims: number): number[] {
  const safeDims = Math.max(32, Math.floor(dims));
  const vec = new Float64Array(safeDims);
  const words = tokenizeLocalEmbedding(text.slice(0, MAX_INPUT_CHARS));
  if (words.length === 0) return new Array(safeDims).fill(0);

  const stems: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const tfDecay = 1 / (1 + 0.1 * Math.floor(i / 40));
    addHashedFeature(vec, `w:${w}`, 2.2 * tfDecay, safeDims);

    const stem = lightStem(w);
    stems.push(stem);
    if (stem !== w) {
      addHashedFeature(vec, `s:${stem}`, 1.6 * tfDecay, safeDims);
    }

    const parts = splitSubwords(w);
    if (parts.length > 1) {
      for (const part of parts) {
        if (part !== w && !LOCAL_STOPWORDS.has(part)) {
          addHashedFeature(vec, `sub:${part}`, 1.4 * tfDecay, safeDims);
          const subStem = lightStem(part);
          if (subStem !== part) addHashedFeature(vec, `s:${subStem}`, 1.0 * tfDecay, safeDims);
        }
      }
    }

    if (i > 0) {
      addHashedFeature(vec, `bg:${stems[i - 1]}_${stem}`, 1.7 * tfDecay, safeDims);
    }

    if (w.length >= 3) {
      const padded = `<${w}>`;
      for (let j = 0; j <= padded.length - 3; j++) {
        addHashedFeature(vec, `c3:${padded.slice(j, j + 3)}`, 0.55 * tfDecay, safeDims);
      }
      for (let j = 0; j <= padded.length - 4; j++) {
        addHashedFeature(vec, `c4:${padded.slice(j, j + 4)}`, 0.75 * tfDecay, safeDims);
      }
    }
  }

  let normSq = 0;
  for (let i = 0; i < safeDims; i++) normSq += vec[i] * vec[i];
  if (normSq === 0) return new Array(safeDims).fill(0);
  const invNorm = 1 / Math.sqrt(normSq);
  const out = new Array<number>(safeDims);
  for (let i = 0; i < safeDims; i++) out[i] = vec[i] * invNorm;
  return out;
}

/** Deterministic zero-dependency local fallback embedder. */
export function localFallbackEmbedder(options?: { dims?: number; model?: string }): Embedder {
  const dims = options?.dims ?? LOCAL_EMBEDDING_DIMS;
  return {
    model: options?.model ?? LOCAL_FALLBACK_MODEL,
    async embed(texts) {
      return texts.map((t) => embedTextLocal(t, dims));
    },
  };
}

/** Lightweight sparse TF vector over words, stems, subwords, and bigrams. */
export function sparseTermVector(text: string): Map<string, number> {
  const weights = new Map<string, number>();
  const words = tokenizeLocalEmbedding(text.slice(0, MAX_INPUT_CHARS));
  const add = (key: string, w: number): void => {
    weights.set(key, (weights.get(key) ?? 0) + w);
  };
  let prevStem = "";
  for (const w of words) {
    add(`w:${w}`, 1.5);
    const stem = lightStem(w);
    if (stem !== w) add(`s:${stem}`, 1.1);
    for (const part of splitSubwords(w)) {
      if (part !== w && !LOCAL_STOPWORDS.has(part)) add(`sub:${part}`, 0.9);
    }
    if (prevStem) add(`bg:${prevStem}_${stem}`, 1.2);
    prevStem = stem;
  }
  return weights;
}

/** Cosine similarity between two sparse term vectors. */
export function sparseCosine(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const va of a.values()) na += va * va;
  for (const vb of b.values()) nb += vb * vb;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const [k, v] of small) {
    const other = large.get(k);
    if (other !== undefined) dot += v * other;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
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
export function fuseRanks(lists: string[][], k = 60, weights?: number[]): Map<string, number> {
  const scores = new Map<string, number>();
  lists.forEach((list, listIdx) => {
    const weight = weights?.[listIdx] ?? 1;
    list.forEach((id, rank) =>
      scores.set(id, (scores.get(id) ?? 0) + weight / (k + rank + 1)),
    );
  });
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
    // Local vectors are cheap to compute and held in memory by embedTextLocal:
    // stored here they would grow the file and push out vectors an endpoint was paid for.
    if (embedder.model === LOCAL_FALLBACK_MODEL) return embedder.embed(texts);
    await this.load();
    const keys = texts.map((t) => keyOf(embedder.cacheKey ?? embedder.model, t));
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
