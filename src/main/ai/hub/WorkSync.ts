import type { QueueStore } from "./LearningQueue";
import type { AgentUsage } from "../../../shared/types/aiHub";
import { TICKET_CLAIM_TTL_MS, mergeItems, type Mergeable } from "./WorkBoard";

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

export interface TicketClaim {
  by: string;
  client: string;
  at: number;
  seenAt: number;
}

export class WorkSync {
  constructor(private readonly store: QueueStore) {}

  private async readAll<T extends Mergeable>(collection: WorkCollection): Promise<T[]> {
    const names = (await this.store.list(`work/${collection}`)).filter((n) => n.endsWith(".json"));
    const items = await inBatches(names.slice(0, 500), 8, (name) =>
      this.store.read(`work/${collection}/${name}`).then((b) => parse<T>(b)),
    );
    return items.filter((x): x is Awaited<T> => Boolean(x)) as T[];
  }

  /**
   * Brings a local collection and the bucket's copy together: what is newer
   * in the bucket comes back in `items`, what is newer here is uploaded.
   */
  async reconcile<T extends Mergeable>(
    collection: WorkCollection,
    local: T[],
  ): Promise<{ items: T[]; changed: boolean }> {
    const remote = await this.readAll<T>(collection);
    const merged = mergeItems(local, remote);
    await inBatches(merged.newerLocally, 6, (item) => this.put(collection, item));
    return { items: merged.items, changed: merged.changed };
  }

  /**
   * For something that must happen once however many installations see it
   * (telling a channel about a shared ticket). A mark that already exists means
   * someone did it. Otherwise this installation writes its mark, lets the
   * bucket settle, and does it only if the mark is still its own: of two that
   * write at the same moment, both read the same winner. Marks do not expire;
   * `pruneMarks` removes old ones.
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
    await this.store.write(at, Buffer.from(JSON.stringify({ client, at: now }), "utf8"));
    await settle();
    return (await mark())?.client === client;
  }

  async pruneMarks(olderThanMs: number, now = Date.now()): Promise<void> {
    const names = (await this.store.list("work/notified")).filter((n) => n.endsWith(".json"));
    await inBatches(names.slice(0, 500), 8, async (name) => {
      let at = 0;
      try {
        at = (JSON.parse((await this.store.read(`work/notified/${name}`))?.toString("utf8") ?? "{}") as { at?: number }).at ?? 0;
      } catch {
        // An unreadable mark is as good as an old one.
      }
      if (now - at > olderThanMs) await this.store.remove(`work/notified/${name}`);
    });
  }

  async put<T extends Mergeable>(collection: WorkCollection, item: T): Promise<void> {
    await this.store.write(
      `work/${collection}/${safeId(item.id)}.json`,
      Buffer.from(JSON.stringify(item), "utf8"),
    );
  }

  /**
   * Spending is kept per installation and added up, so two computers never
   * overwrite each other's count and a budget holds for the whole team.
   */
  async putUsage(client: string, usage: Record<string, AgentUsage>): Promise<void> {
    await this.store.write(`work/usage/${safeId(client)}.json`, Buffer.from(JSON.stringify(usage), "utf8"));
  }

  /** What every other installation has spent. */
  async readOtherUsage(client: string): Promise<Record<string, AgentUsage>[]> {
    const names = (await this.store.list("work/usage")).filter(
      (n) => n.endsWith(".json") && n !== `${safeId(client)}.json`,
    );
    const all = await inBatches(names.slice(0, 200), 8, (name) => this.store.read(`work/usage/${name}`));
    const out: Record<string, AgentUsage>[] = [];
    for (const buffer of all) {
      if (!buffer || buffer.length > 200_000) continue;
      try {
        const value = JSON.parse(buffer.toString("utf8")) as Record<string, AgentUsage>;
        if (value && typeof value === "object") out.push(value);
      } catch {
        // An unreadable count is left out; it cannot be guessed.
      }
    }
    return out;
  }

  /**
   * How the pages were used is kept the same way: one object per installation,
   * added up by whoever reads. A page is not rewritten because somebody opened it.
   */
  async putPageUse(client: string, use: unknown): Promise<void> {
    await this.store.write(`work/pageuse/${safeId(client)}.json`, Buffer.from(JSON.stringify(use), "utf8"));
  }

  async readOtherPageUse<T>(client: string): Promise<T[]> {
    const names = (await this.store.list("work/pageuse")).filter(
      (n) => n.endsWith(".json") && n !== `${safeId(client)}.json`,
    );
    const all = await inBatches(names.slice(0, 200), 8, (name) => this.store.read(`work/pageuse/${name}`));
    const out: T[] = [];
    for (const buffer of all) {
      if (!buffer || buffer.length > 400_000) continue;
      try {
        const value = JSON.parse(buffer.toString("utf8")) as T;
        if (value && typeof value === "object") out.push(value);
      } catch {
        // An unreadable count is left out; it cannot be guessed.
      }
    }
    return out;
  }

  private claimPath(ticketId: string): string {
    return `work/claims/${safeId(ticketId)}.json`;
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
   * Checks a ticket out. The claim is written and then read back: only the
   * app that still finds its own claim proceeds, so two apps that reach for
   * the same ticket at the same moment normally do not both run it.
   * Returns the claim that holds, which is somebody else's when this failed.
   */
  async claim(ticketId: string, who: { by: string; client: string }, now = Date.now()): Promise<TicketClaim> {
    const existing = await this.readClaim(ticketId);
    if (existing && existing.client !== who.client && now - existing.seenAt < TICKET_CLAIM_TTL_MS)
      return existing;
    const mine: TicketClaim = { ...who, at: existing?.client === who.client ? existing.at : now, seenAt: now };
    await this.store.write(this.claimPath(ticketId), Buffer.from(JSON.stringify(mine), "utf8"));
    return (await this.readClaim(ticketId)) ?? mine;
  }

  /** Says the run is still alive. Without this the claim lapses and the ticket is free again. */
  async refresh(ticketId: string, client: string, now = Date.now()): Promise<void> {
    const existing = await this.readClaim(ticketId);
    if (!existing || existing.client !== client) return;
    await this.store.write(
      this.claimPath(ticketId),
      Buffer.from(JSON.stringify({ ...existing, seenAt: now }), "utf8"),
    );
  }

  async release(ticketId: string, client: string): Promise<void> {
    const existing = await this.readClaim(ticketId);
    if (existing && existing.client !== client) return;
    await this.store.remove(this.claimPath(ticketId));
  }
}
