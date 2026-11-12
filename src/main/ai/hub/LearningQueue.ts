import crypto from "node:crypto";

/**
 * Records waiting to be read for team memory (a finished session, a stretch
 * of somebody's activity), kept in the team's bucket instead of on the
 * computer that produced them. Nobody runs a server for the workspace, so the
 * computer that did the work may be closed seconds later: the record is
 * written at once, which is one small upload, and whichever teammate's app is
 * running reads it with its own model when it gets to it.
 *
 * Layout under the workspace prefix:
 *   learn/pending/<createdAt>-<hash>.json   the record
 *   learn/claims/<same name>                who is reading it, and since when
 */

/** The part of the bucket the queue uses; paths are relative to the workspace prefix. */
export interface QueueStore {
  list(dir: string): Promise<string[]>;
  /** undefined when the object does not exist. */
  read(path: string): Promise<Buffer | undefined>;
  write(path: string, content: Buffer): Promise<void>;
  /** Deleting what is already gone is not an error. */
  remove(path: string): Promise<void>;
}

export interface LearningRecord {
  v: 1;
  /** Source id (`task:<id>`, `activity:<event id>`): one record per source. */
  id: string;
  title: string;
  transcript: string;
  /** Words used to find the memories that already cover the subject. */
  query: string;
  /** Whose session or activity this is. */
  actor: string;
  createdAt: number;
  /** How many times a reader gave up on it. */
  attempts: number;
}

export interface ClaimedRecord {
  name: string;
  record: LearningRecord;
}

const PENDING = "learn/pending";
const CLAIMS = "learn/claims";
/** A reader that went away (closed laptop, lost network) frees its record after this. */
export const CLAIM_TTL_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 3;
const MAX_RECORD_BYTES = 256_000;

/** Stable object name for a source: sorts by time, and enqueuing twice overwrites. */
export function recordName(record: Pick<LearningRecord, "id" | "createdAt">): string {
  const hash = crypto.createHash("sha256").update(record.id).digest("hex").slice(0, 16);
  return `${String(record.createdAt).padStart(15, "0")}-${hash}.json`;
}

function parseRecord(buffer: Buffer | undefined): LearningRecord | undefined {
  if (!buffer || buffer.length > MAX_RECORD_BYTES) return undefined;
  try {
    const value = JSON.parse(buffer.toString("utf8")) as Partial<LearningRecord>;
    if (
      value.v !== 1 ||
      typeof value.id !== "string" ||
      typeof value.title !== "string" ||
      typeof value.transcript !== "string" ||
      !value.transcript.trim()
    )
      return undefined;
    return {
      v: 1,
      id: value.id,
      title: value.title,
      transcript: value.transcript,
      query: typeof value.query === "string" ? value.query : value.title,
      actor: typeof value.actor === "string" ? value.actor : "teammate",
      createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
      attempts: typeof value.attempts === "number" ? value.attempts : 0,
    };
  } catch {
    return undefined;
  }
}

export class LearningQueue {
  constructor(private readonly store: QueueStore) {}

  async enqueue(record: LearningRecord): Promise<string> {
    const name = recordName(record);
    await this.store.write(
      `${PENDING}/${name}`,
      Buffer.from(JSON.stringify(record), "utf8"),
    );
    return name;
  }

  async pendingCount(): Promise<number> {
    return (await this.store.list(PENDING)).filter((n) => n.endsWith(".json")).length;
  }

  /**
   * Takes the oldest record nobody is reading. A claim is a small object
   * naming the reader; after writing it the reader looks again and proceeds
   * only if the claim is still its own, so two apps that start at the same
   * moment normally do not both read the record. (If they do, the memory
   * comparison and merging absorb the repeat.) An unreadable record is
   * removed so it cannot block the queue.
   */
  async claimNext(reader: string, now = Date.now()): Promise<ClaimedRecord | undefined> {
    const names = (await this.store.list(PENDING))
      .filter((n) => n.endsWith(".json"))
      .sort();
    for (const name of names) {
      const claim = await this.readClaim(name);
      if (claim && claim.reader !== reader && now - claim.at < CLAIM_TTL_MS) continue;
      const record = parseRecord(await this.store.read(`${PENDING}/${name}`));
      if (!record) {
        await this.complete(name);
        continue;
      }
      await this.store.write(
        `${CLAIMS}/${name}`,
        Buffer.from(JSON.stringify({ reader, at: now }), "utf8"),
      );
      const mine = await this.readClaim(name);
      if (mine?.reader !== reader) continue;
      return { name, record };
    }
    return undefined;
  }

  /** The record has been read: nobody needs to read it again. */
  async complete(name: string): Promise<void> {
    await this.store.remove(`${PENDING}/${name}`);
    await this.store.remove(`${CLAIMS}/${name}`);
  }

  /**
   * The reader could not finish (its model failed, it is shutting down): the
   * record goes back for somebody else, until it has failed too often.
   * Returns whether it is still in the queue.
   */
  async release(claimed: ClaimedRecord): Promise<boolean> {
    const attempts = claimed.record.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await this.complete(claimed.name);
      return false;
    }
    await this.store.write(
      `${PENDING}/${claimed.name}`,
      Buffer.from(JSON.stringify({ ...claimed.record, attempts }), "utf8"),
    );
    await this.store.remove(`${CLAIMS}/${claimed.name}`);
    return true;
  }

  private async readClaim(
    name: string,
  ): Promise<{ reader: string; at: number } | undefined> {
    try {
      const raw = await this.store.read(`${CLAIMS}/${name}`);
      if (!raw) return undefined;
      const value = JSON.parse(raw.toString("utf8")) as { reader?: unknown; at?: unknown };
      return typeof value.reader === "string" && typeof value.at === "number"
        ? { reader: value.reader, at: value.at }
        : undefined;
    } catch {
      return undefined;
    }
  }
}
