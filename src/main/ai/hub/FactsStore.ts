import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  parseMemoryScope,
  type FactChange,
  type MemoryEntry,
  type ServerFacts,
} from "../../../shared/types/aiHub";
import { diffFacts } from "./ServerFacts";

/** What is kept about one server: the latest facts, what they were collected over, and the log of what changed. */
export interface FactsRecord {
  serverId: string;
  name: string;
  status: "ok" | "unsupported" | "failed";
  error?: string;
  /** Attempts in a row that did not get an answer. */
  failures?: number;
  attemptedAt: number;
  collectedAt?: number;
  via?: "open-tab" | "own-connection" | "local" | "demo";
  hash?: string;
  facts?: ServerFacts;
  /** Newest first. */
  changes: FactChange[];
  /** When each present problem was first seen, by its key. */
  problemsSince?: Record<string, number>;
  dismissed?: Record<string, number>;
  /** Initial collection timestamp used to keep baseline demo cert expiry dates fixed across UTC midnight. */
  demoCertAnchorAt?: number;
}

const safeName = (id: string): string => id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "server";

/**
 * Facts live in files of their own, one per server, beside the hub's store.
 * Not in the store itself: a package list is a hundred kilobytes per server,
 * and the store is rewritten whole, and masked, on every save.
 */
export class FactsStore {
  private readonly records = new Map<string, FactsRecord>();
  private loading?: Promise<void>;

  constructor(private readonly dir: string) {}

  load(): Promise<void> {
    return (this.loading ??= (async () => {
      const names = await fs.readdir(this.dir).catch(() => [] as string[]);
      for (const name of names.filter((n) => n.endsWith(".json"))) {
        try {
          const record = JSON.parse(await fs.readFile(path.join(this.dir, name), "utf8")) as FactsRecord;
          if (record?.serverId) this.records.set(record.serverId, { ...record, changes: record.changes ?? [] });
        } catch {
          // A file that cannot be read is collected again.
        }
      }
    })());
  }

  get(serverId: string): FactsRecord | undefined {
    return this.records.get(serverId);
  }

  all(): FactsRecord[] {
    return [...this.records.values()];
  }

  async put(record: FactsRecord): Promise<void> {
    this.records.set(record.serverId, record);
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const file = path.join(this.dir, `${safeName(record.serverId)}.json`);
    const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
    await fs.writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
    await fs.rename(temporary, file);
  }

  async remove(serverId: string): Promise<void> {
    this.records.delete(serverId);
    await fs.rm(path.join(this.dir, `${safeName(serverId)}.json`), { force: true });
  }
}

export const STALE_DRIFT_KINDS = new Set<FactChange["kind"]>([
  "os",
  "kernel",
  "service",
  "port",
  "file",
]);

export interface FlagStaleMemoriesOptions {
  /** Prior server facts snapshot to diff against `factsRecord.facts` via `diffFacts`. */
  prevFacts?: ServerFacts;
  /** Cluster name(s) that this server belongs to, for matching `cluster:<name>` scopes. */
  cluster?: string | string[];
  /** Explicit drift changes instead of deriving from `prevFacts`/`factsRecord.changes`. */
  changes?: FactChange[];
  /** When true, ignore drift changes older than `memory.updatedAt`. */
  onlyNewerChanges?: boolean;
}

function scopeMatchesFactsRecord(
  scope: string,
  factsRecord: FactsRecord,
  cluster?: string | string[],
): boolean {
  const parsed = parseMemoryScope(scope);
  if (!parsed.value) return false;
  const target = parsed.value.trim().toLowerCase();
  if (!target) return false;
  if (parsed.kind === "server") {
    return (
      target === factsRecord.name.trim().toLowerCase() ||
      target === factsRecord.serverId.trim().toLowerCase()
    );
  }
  if (parsed.kind === "cluster") {
    const clusterList = Array.isArray(cluster) ? cluster : cluster ? [cluster] : [];
    const recordCluster = (factsRecord as FactsRecord & { cluster?: string }).cluster;
    if (recordCluster) clusterList.push(recordCluster);
    return clusterList.some((c) => c.trim().toLowerCase() === target);
  }
  return false;
}

function formatStaleReason(changes: FactChange[]): string {
  const uniqueTexts: string[] = [];
  const seen = new Set<string>();
  for (const ch of changes) {
    const line = `${ch.kind}: ${ch.text}`.trim();
    if (!seen.has(line)) {
      seen.add(line);
      uniqueTexts.push(line);
    }
  }
  const summary = `Drift detected (${uniqueTexts.slice(0, 3).join("; ")}${uniqueTexts.length > 3 ? `; +${uniqueTexts.length - 3} more` : ""})`;
  return summary.length > 260 ? `${summary.slice(0, 257)}...` : summary;
}

/**
 * Mark `server:<name>` and `cluster:<name>` memories with `staleReason` when OS, kernel,
 * service, listening port, or watched-file drift is detected.
 * Never deletes any entry (human-authored memories are preserved with `staleReason` flagged).
 */
export function flagStaleMemories(
  memories: readonly MemoryEntry[],
  factsRecord: FactsRecord,
  options?: FlagStaleMemoriesOptions,
): MemoryEntry[] {
  const rawChanges: FactChange[] = options?.changes
    ? options.changes
    : options?.prevFacts && factsRecord.facts && !options.prevFacts.unsupported && !factsRecord.facts.unsupported
      ? diffFacts(options.prevFacts, factsRecord.facts)
      : (factsRecord.changes ?? []);

  const driftChanges = rawChanges.filter((c) => STALE_DRIFT_KINDS.has(c.kind));
  if (driftChanges.length === 0) {
    return memories.map((m) => ({ ...m }));
  }

  return memories.map((memory) => {
    if (memory.supersededBy) return { ...memory };
    if (!scopeMatchesFactsRecord(memory.scope, factsRecord, options?.cluster)) {
      return { ...memory };
    }
    const relevant = driftChanges.filter((change) => {
      if (memory.lastVerifiedAt !== undefined && change.at <= memory.lastVerifiedAt) {
        return false;
      }
      if (options?.onlyNewerChanges && change.at < memory.updatedAt) {
        return false;
      }
      return true;
    });
    if (relevant.length === 0) return { ...memory };
    return {
      ...memory,
      staleReason: formatStaleReason(relevant),
    };
  });
}
