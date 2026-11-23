import type { ListedObject, QueueStore } from "./LearningQueue";
import type { AgentUsage } from "../../../shared/types/aiHub";
import { RETIRE_REMOVE_AFTER_MS, TICKET_CLAIM_TTL_MS, mergeItems, type Mergeable } from "./WorkBoard";

/**
 * A conditional write that lost: told by the error's status or name only.
 * A message that merely mentions "412" or "if-match" (a timeout, a path, a
 * proxy's page) is another failure and must not read as "someone else won".
 */
export function isPreconditionFailedError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    code?: unknown;
    Code?: unknown;
    name?: unknown;
    status?: unknown;
    statusCode?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  for (const status of [e.$metadata?.httpStatusCode, e.statusCode, e.status, e.code])
    if (status === 412 || status === 409) return true;
  return [e.code, e.Code, e.name].some(
    (v) => v === "PreconditionFailed" || v === "ConditionalRequestConflict" || v === "EEXIST",
  );
}

export interface ConditionalQueueStore extends QueueStore {
  /** True when `write(path, buf, { ifMatch, ifNoneMatch })` enforces S3 conditional preconditions atomically. */
  supportsConditionalWrite?: boolean;
  /**
   * Whether a write that names a condition is really refused when the condition does not hold: tried
   * out on the store itself, once. A bucket takes the headers whether or not it acts on them, so its
   * word is not taken for it. Where this is there it decides, and `supportsConditionalWrite` is not asked.
   */
  conditionalWrites?(): Promise<boolean>;
  readWithMeta?(path: string): Promise<{ buffer: Buffer; etag?: string } | undefined>;
  write(
    path: string,
    content: Buffer,
    options?: { ifMatch?: string; ifNoneMatch?: string },
  ): Promise<void>;
}

/**
 * The board in the team's bucket. There is no server: every app reads and
 * writes the same objects, one per item, so two people changing different
 * tickets never overwrite each other.
 *
 *   work/<collection>/<id>.json   one goal, ticket, agent, runbook or dependency
 *   work/usage/<client>.json      what one installation's runs have spent, per agent
 *   work/pageuse/<client>.json    how one installation's runs used the knowledge base pages
 *   work/claims/<ticketId>.json   who is running the ticket, and since when
 *
 * An item is replaced only by a newer copy of itself (updatedAt), and a
 * removal is a copy marked deleted, so it reaches everyone.
 */

export type WorkCollection = "goals" | "tickets" | "agents" | "kb" | "edges" | "pages" | "evals";

/** A runbook may be long; everything else is small. */
const MAX_ITEM_BYTES = 1_500_000;
const safeId = (id: string): string => id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);

function parse<T extends Mergeable>(buffer: Buffer | undefined): T | undefined {
  if (!buffer || buffer.length > MAX_ITEM_BYTES) return undefined;
  try {
    const value = JSON.parse(buffer.toString("utf8")) as T;
    if (!value || typeof value.id !== "string" || typeof value.updatedAt !== "number") return undefined;
    return value;
  } catch {
    return undefined;
  }
}

async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

/**
 * Which copy of a knowledge base document stands when this installation's and the team's differ.
 *
 * Both there, or both removed: the newer one. One removed and one there: the removal stands, also
 * against a copy that is merely newer (a teammate's computer that finished reading the document after
 * it was removed must not bring it back). A user's document never comes back under its id: a new one
 * gets a new id. A built-in document keeps its id, so it does come back, and only when somebody
 * restored it on purpose after the removal (`restoredAt`, set by restore-builtins).
 */
export function standingKbCopy<T extends { deleted?: boolean; updatedAt: number; restoredAt?: number; republishedAt?: number }>(local: T, remote: T, builtin: boolean): T {
  if (Boolean(local.deleted) === Boolean(remote.deleted)) return remote.updatedAt > local.updatedAt ? remote : local;
  const [gone, kept] = local.deleted ? [local, remote] : [remote, local];
  if ((builtin && (kept.restoredAt ?? 0) > gone.updatedAt) || (kept.republishedAt ?? 0) > gone.updatedAt) return kept;
  return gone.updatedAt > kept.updatedAt ? gone : { ...gone, updatedAt: kept.updatedAt + 1 };
}

export interface TicketClaim {
  by: string;
  client: string;
  at: number;
  seenAt: number;
}

export class WorkSync {
  constructor(private readonly store: QueueStore) {}

  /**
   * What was read of each object, by its path, with the mark the store's listing gave for it. An
   * object whose mark is the same in the next listing has not changed, and is not downloaded again:
   * a sync of a board nobody touched is then a listing per collection and nothing else. Kept while
   * the object is listed. What is kept here is never handed out to be changed (reconcile copies what
   * a caller takes over), or a change made to it here would look like the store's.
   */
  private readonly kept = new Map<string, { version: string; value: unknown }>();

  /**
   * Every object of a folder whose name is wanted, as `read` makes of its bytes. Only what is new
   * or changed since the last time is downloaded, where the store's listing can tell
   * (`listWithMeta`); a store that cannot tell has every object read, as before.
   */
  private async readDir<V>(dir: string, wanted: (name: string) => boolean, read: (buffer: Buffer | undefined) => V | undefined): Promise<V[]> {
    const listed: ListedObject[] = this.store.listWithMeta ? await this.store.listWithMeta(dir) : (await this.store.list(dir)).map((name) => ({ name }));
    const here = new Set<string>();
    const values = await inBatches(
      listed.filter((entry) => wanted(entry.name)),
      8,
      async (entry) => {
        const at = `${dir}/${entry.name}`;
        here.add(at);
        const known = this.kept.get(at);
        if (entry.version && known?.version === entry.version) return known.value as V | undefined;
        // Listed first, read after: what is read is never older than its mark. If the object changed
        // in between, the next listing has another mark and it is read once more.
        const value = read(await this.store.read(at));
        if (entry.version) this.kept.set(at, { version: entry.version, value });
        else this.kept.delete(at);
        return value;
      },
    );
    for (const at of [...this.kept.keys()]) if (at.startsWith(`${dir}/`) && !here.has(at)) this.kept.delete(at);
    return values.filter((value) => value !== undefined) as V[];
  }

  /**
   * Every item of a collection. The store's list gives every name however many there are (it follows
   * the bucket's pages), and every one is taken: a cap here meant that past it the rest never reached a
   * teammate, and was uploaded again by its owner on every sync.
   */
  private readAll<T extends Mergeable>(collection: WorkCollection): Promise<T[]> {
    return this.readDir<T>(`work/${collection}`, (name) => name.endsWith(".json"), (buffer) => parse<T>(buffer));
  }

  /**
   * Brings a local collection and the bucket's copy together: what is newer
   * in the bucket comes back in `items`, what is newer here is uploaded.
   *
   * With `retire`, what the caller's rule calls over and old (WorkBoard: `retiredRemoval`,
   * `retiredTicket`) is left out of `items` and is not uploaded, and a day later its object is taken
   * out of the store. The two copies are merged first, so a removal still in the store stands against
   * an older copy here. The caller drops the same items from its own state with the same rule.
   */
  async reconcile<T extends Mergeable>(
    collection: WorkCollection,
    local: T[],
    /** For an item both sides have, where the newer copy winning would lose something (see mergeItems). */
    resolve?: (local: T, remote: T) => T,
    retire?: { now: number; retired: (item: T, now: number) => boolean },
  ): Promise<{ items: T[]; changed: boolean }> {
    const now = retire?.now ?? 0;
    const remote = await this.readAll<T>(collection);
    const merged = mergeItems(local, remote, resolve);
    const gone = new Map(retire ? merged.items.filter((x) => retire.retired(x, now)).map((x) => [x.id, x]) : []);
    await inBatches(merged.newerLocally.filter((x) => !gone.has(x.id)), 6, (item) => this.put(collection, item));
    const stale = remote.filter((r) => gone.has(r.id) && now - gone.get(r.id)!.updatedAt > RETIRE_REMOVE_AFTER_MS);
    await inBatches(stale, 6, (item) => this.store.remove(`work/${collection}/${safeId(item.id)}.json`));
    const mine = new Map(local.map((x) => [x.id, x]));
    // What the caller takes over from the store is a copy of its own: the store's copy is kept here
    // to be compared with next time, and the caller may change what it holds.
    const items = merged.items.filter((x) => !gone.has(x.id)).map((x) => (mine.get(x.id) === x ? x : structuredClone(x)));
    // Changed for the caller: something of its own is let go, or a kept item is not the copy it gave.
    const changed = local.some((x) => gone.has(x.id)) || items.some((x) => mine.get(x.id) !== x);
    return { items, changed };
  }

  private get conditionalStore(): ConditionalQueueStore {
    return this.store as ConditionalQueueStore;
  }

  /**
   * Whether a write that lost is refused by the store, so that "it was written" means "it is mine".
   * Where it is not (a store that takes the condition and writes anyway), who won is found out by
   * reading back after the store has settled.
   */
  private async refuses(): Promise<boolean> {
    const store = this.conditionalStore;
    return store.conditionalWrites ? store.conditionalWrites() : Boolean(store.supportsConditionalWrite);
  }

  /**
   * For something that must happen once however many installations see it
   * (telling a channel about a shared ticket). Uses `If-None-Match: "*"` when
   * the store really refuses a second write (see `refuses`) so concurrent
   * callers never race; otherwise writes, waits for `settle()` and reads back
   * whose mark stands. Marks do not expire; `pruneMarks` removes old ones.
   */
  async markOnce(key: string, client: string, settle: () => Promise<void>, now = Date.now()): Promise<boolean> {
    const at = `work/notified/${safeId(key)}.json`;
    const mark = async (): Promise<{ client?: string; at?: number } | undefined> => {
      try {
        const buffer = await this.store.read(at);
        return buffer ? (JSON.parse(buffer.toString("utf8")) as { client?: string; at?: number }) : undefined;
      } catch {
        return undefined;
      }
    };
    if (await mark()) return false;
    try {
      await this.conditionalStore.write(
        at,
        Buffer.from(JSON.stringify({ client, at: now }), "utf8"),
        { ifNoneMatch: "*" },
      );
    } catch (err) {
      if (isPreconditionFailedError(err)) return false;
      throw err;
    }
    if (await this.refuses()) return true;
    await settle();
    return (await mark())?.client === client;
  }

  async pruneMarks(olderThanMs: number, now = Date.now()): Promise<void> {
    const names = (await this.store.list("work/notified")).filter((n) => n.endsWith(".json"));
    await inBatches(names, 8, async (name) => {
      let at = 0;
      try {
        at = (JSON.parse((await this.store.read(`work/notified/${name}`))?.toString("utf8") ?? "{}") as { at?: number }).at ?? 0;
      } catch {
        // An unreadable mark is as good as an old one.
      }
      if (now - at > olderThanMs) await this.store.remove(`work/notified/${name}`);
    });
  }

  /** The bucket's copy of one item, when it has one. */
  async readItem<T extends Mergeable>(collection: WorkCollection, id: string): Promise<T | undefined> {
    return parse<T>(await this.store.read(`work/${collection}/${safeId(id)}.json`));
  }

  async put<T extends Mergeable>(collection: WorkCollection, item: T): Promise<void> {
    const at = `work/${collection}/${safeId(item.id)}.json`;
    await this.store.write(at, Buffer.from(JSON.stringify(item), "utf8"));
    // Its mark in the store is another now: it is read once more at the next listing, and kept then.
    this.kept.delete(at);
  }

  /**
   * Spending is kept per installation and added up, so two computers never
   * overwrite each other's count and a budget holds for the whole team.
   */
  async putUsage(client: string, usage: Record<string, AgentUsage>): Promise<void> {
    await this.store.write(`work/usage/${safeId(client)}.json`, Buffer.from(JSON.stringify(usage), "utf8"));
  }

  /** One installation's count, as it is in the store. An unreadable one is left out: it cannot be guessed. */
  private static count<T>(max: number): (buffer: Buffer | undefined) => T | undefined {
    return (buffer) => {
      if (!buffer || buffer.length > max) return undefined;
      try {
        const value = JSON.parse(buffer.toString("utf8")) as T;
        return value && typeof value === "object" ? value : undefined;
      } catch {
        return undefined;
      }
    };
  }

  /** What every other installation has spent. */
  async readOtherUsage(client: string): Promise<Record<string, AgentUsage>[]> {
    const others = await this.readDir("work/usage", (n) => n.endsWith(".json") && n !== `${safeId(client)}.json`, WorkSync.count<Record<string, AgentUsage>>(200_000));
    return others.map((value) => structuredClone(value));
  }

  /**
   * How the pages were used is kept the same way: one object per installation,
   * added up by whoever reads. A page is not rewritten because somebody opened it.
   */
  async putPageUse(client: string, use: unknown): Promise<void> {
    await this.store.write(`work/pageuse/${safeId(client)}.json`, Buffer.from(JSON.stringify(use), "utf8"));
  }

  async readOtherPageUse<T>(client: string): Promise<T[]> {
    const others = await this.readDir("work/pageuse", (n) => n.endsWith(".json") && n !== `${safeId(client)}.json`, WorkSync.count<T>(400_000));
    return others.map((value) => structuredClone(value));
  }

  private claimPath(ticketId: string): string {
    return `work/claims/${safeId(ticketId)}.json`;
  }

  private async readClaimWithMeta(
    ticketId: string,
  ): Promise<{ claim?: TicketClaim; etag?: string }> {
    const target = this.claimPath(ticketId);
    const meta =
      typeof this.conditionalStore.readWithMeta === "function"
        ? await this.conditionalStore.readWithMeta(target)
        : undefined;
    const buffer = meta ? meta.buffer : await this.store.read(target);
    if (!buffer) return {};
    try {
      const value = JSON.parse(buffer.toString("utf8")) as TicketClaim;
      const claim =
        typeof value.client === "string" && typeof value.seenAt === "number"
          ? value
          : undefined;
      return { claim, etag: meta?.etag };
    } catch {
      return { etag: meta?.etag };
    }
  }

  async readClaim(ticketId: string): Promise<TicketClaim | undefined> {
    const buffer = await this.store.read(this.claimPath(ticketId));
    if (!buffer) return undefined;
    try {
      const value = JSON.parse(buffer.toString("utf8")) as TicketClaim;
      return typeof value.client === "string" && typeof value.seenAt === "number" ? value : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Checks a ticket out. Uses `If-None-Match: "*"` on unclaimed tickets (and
   * `If-Match` when taking over a lapsed claim with an ETag) when the store
   * really refuses a write that lost (see `refuses`); otherwise writes, waits
   * for `settle()` and reads back whose claim stands. Returns the claim that
   * holds, which is somebody else's when this failed.
   */
  async claim(
    ticketId: string,
    who: { by: string; client: string },
    now = Date.now(),
    options: {
      /** Whether another installation's claim is still alive. Judged by the caller's own observation, not the other machine's clock. */
      fresh?: (claim: TicketClaim) => boolean;
      /** Waits for the bucket to settle, so that of two writing at once both read the same winner. */
      settle?: () => Promise<void>;
    } = {},
  ): Promise<TicketClaim> {
    const fresh = options.fresh ?? ((c: TicketClaim) => now - c.seenAt < TICKET_CLAIM_TTL_MS);
    const { claim: existing, etag } = await this.readClaimWithMeta(ticketId);
    if (existing && existing.client !== who.client && fresh(existing)) return existing;
    const mine: TicketClaim = { ...who, at: existing?.client === who.client ? existing.at : now, seenAt: now };
    const payload = Buffer.from(JSON.stringify(mine), "utf8");
    // An object that is there, even one that cannot be read, is replaced only
    // as the copy that was read (its etag); "*" is for no object at all.
    const writeOpts = etag
      ? { ifMatch: etag }
      : !existing
        ? { ifNoneMatch: "*" }
        : undefined;
    try {
      await this.conditionalStore.write(this.claimPath(ticketId), payload, writeOpts);
    } catch (err) {
      if (isPreconditionFailedError(err)) {
        // Somebody else wrote first. Never answer with `mine`: the caller would run a ticket it does not hold.
        return (
          (await this.readClaim(ticketId)) ??
          (existing && existing.client !== who.client ? existing : undefined) ?? {
            by: "another installation",
            client: "",
            at: now,
            seenAt: now,
          }
        );
      }
      throw err;
    }
    if (await this.refuses()) {
      return mine;
    }
    await options.settle?.();
    return (await this.readClaim(ticketId)) ?? mine;
  }

  /** Says the run is still alive. False: the claim is not this installation's any more, and the run should stop. */
  async refresh(ticketId: string, client: string, now = Date.now()): Promise<boolean> {
    const { claim: existing, etag } = await this.readClaimWithMeta(ticketId);
    if (!existing || existing.client !== client) return false;
    try {
      await this.conditionalStore.write(
        this.claimPath(ticketId),
        Buffer.from(JSON.stringify({ ...existing, seenAt: now }), "utf8"),
        etag ? { ifMatch: etag } : undefined,
      );
    } catch (err) {
      if (isPreconditionFailedError(err)) return false;
      throw err;
    }
    if (await this.refuses()) return true;
    // The store wrote without looking at the condition: another installation may have taken the
    // ticket over between the read and the write. Whose claim stands now is read back.
    return (await this.readClaim(ticketId))?.client === client;
  }

  async release(ticketId: string, client: string): Promise<void> {
    const existing = await this.readClaim(ticketId);
    if (existing && existing.client !== client) return;
    await this.store.remove(this.claimPath(ticketId));
  }
}
