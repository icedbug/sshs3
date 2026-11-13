import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { FactChange, ServerFacts } from "../../../shared/types/aiHub";

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
