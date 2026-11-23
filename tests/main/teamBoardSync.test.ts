import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentUsage, MissionAgent, WorkTicket, WorkspaceServerSummary } from "../../src/shared/types/aiHub";
import type { QueueStore } from "../../src/main/ai/hub/LearningQueue";
import { RETIRE_AFTER_MS, RETIRE_REMOVE_AFTER_MS, retiredRemoval, retiredTicket, type Mergeable } from "../../src/main/ai/hub/WorkBoard";
import { WorkSync } from "../../src/main/ai/hub/WorkSync";
import { getBuiltinAgents } from "../../src/main/ai/hub/demoWorkspace";

/**
 * The team's board in its store (a bucket, or a team server's folder): that every item reaches every
 * installation however many there are, and that what is over is let go by one plain rule.
 */

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
});

type CountingStore = QueueStore & { files: Map<string, Buffer>; reads: number; writes: number; lists: number; removes: number; reset(): void };

/** A store in memory that counts what is asked of it. */
function countingStore(): CountingStore {
  const files = new Map<string, Buffer>();
  const b: CountingStore = {
    files,
    reads: 0,
    writes: 0,
    lists: 0,
    removes: 0,
    reset() {
      b.reads = 0;
      b.writes = 0;
      b.lists = 0;
      b.removes = 0;
    },
    list: async (dir: string) => {
      b.lists++;
      return [...files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1)).sort();
    },
    read: async (p: string) => {
      b.reads++;
      return files.get(p);
    },
    write: async (p: string, c: Buffer) => {
      b.writes++;
      files.set(p, Buffer.from(c));
    },
    remove: async (p: string) => {
      b.removes++;
      files.delete(p);
    },
  };
  return b;
}

type Inner = {
  workTick: (now?: number) => Promise<void>;
  lastWorkSync: number;
  workSyncStore?: WorkSync;
  workSyncError?: string;
  s3Workspace: { canUseBucket: () => boolean };
  pullSharedFacts: () => Promise<boolean>;
  factsHeads: Map<string, { collectedAt: number; hash: string }>;
  cachedWorkspaceServers: WorkspaceServerSummary[];
};

async function makeHub(store: QueueStore, host: Record<string, unknown> = {}) {
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(false);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-board-sync-"));
  const hub = new HubService(
    { changed: () => {}, inventoryTargets: async () => [], backgroundChanged: async () => {}, openSchedule: async () => "s1", show: () => {}, aiConfigFilePath: path.join(dir, "ai.json"), ...host } as never,
    dir,
  );
  disposals.push(async () => {
    await hub.dispose();
    setDemoModeForTesting(undefined);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await hub.initialize();
  const inner = hub as unknown as Inner;
  inner.s3Workspace.canUseBucket = () => true;
  Object.defineProperty(inner.s3Workspace, "objects", { value: store });
  inner.workSyncStore = new WorkSync(store);
  return { hub, inner };
}

const sync = async (inner: Inner, now = Date.now()): Promise<void> => {
  inner.lastWorkSync = 0;
  await inner.workTick(now);
  expect(inner.workSyncError).toBeUndefined();
};

const ticket = (id: string, extra: Partial<WorkTicket> = {}): WorkTicket =>
  ({ id, title: `Ticket ${id}`, description: "d", status: "backlog", createdBy: "x", createdAt: 1, updatedAt: 1000, ...extra }) as WorkTicket;
const inStore = (store: CountingStore, prefix: string): string[] => [...store.files.keys()].filter((k) => k.startsWith(prefix));
const DAY = 24 * 60 * 60_000;

describe("a collection with more items than any page of a listing", () => {
  it("reaches a teammate whole, and is not uploaded again by its owner", async () => {
    const store = countingStore();
    const a = await makeHub(store, { defaultActorName: "Anna" });
    const b = await makeHub(store, { defaultActorName: "Sara" });
    const now = Date.now();
    a.hub.store.data.workTickets = Array.from({ length: 520 }, (_, i) => ticket(`t-${String(i).padStart(4, "0")}`, { updatedAt: now - 1000 }));
    await sync(a.inner);
    await sync(b.inner);
    expect(inStore(store, "work/tickets/").length).toBe(520);
    expect(b.hub.store.data.workTickets!.length).toBe(520);
    // The last ones by name are the ones a cap used to leave out.
    expect(b.hub.store.data.workTickets!.some((t) => t.id === "t-0519")).toBe(true);
    store.reset();
    await sync(a.inner);
    expect(store.writes).toBe(0);
  }, 120_000);

  it("is pruned, counted and read whole: marks, other installations' spending and page use", async () => {
    const store = countingStore();
    const work = new WorkSync(store);
    const now = 1_800_000_000_000;
    for (let i = 0; i < 620; i++) store.files.set(`work/notified/m-${i}.json`, Buffer.from(JSON.stringify({ client: "c", at: now - 30 * DAY })));
    store.files.set("work/notified/fresh.json", Buffer.from(JSON.stringify({ client: "c", at: now - DAY })));
    await work.pruneMarks(14 * DAY, now);
    expect(inStore(store, "work/notified/")).toEqual(["work/notified/fresh.json"]);

    const usage: Record<string, AgentUsage> = { ops: { month: "2027-01", tokens: 10, runs: 1 } };
    for (let i = 0; i < 260; i++) {
      store.files.set(`work/usage/client-${i}.json`, Buffer.from(JSON.stringify(usage)));
      store.files.set(`work/pageuse/client-${i}.json`, Buffer.from(JSON.stringify({ p1: { used: 1 } })));
    }
    expect((await work.readOtherUsage("client-0")).length).toBe(259);
    expect((await work.readOtherPageUse("client-0")).length).toBe(259);
  });

  it("takes over a teammate's reading of a shared server past a thousand readings", async () => {
    const store = countingStore();
    const { inner } = await makeHub(store);
    inner.cachedWorkspaceServers = [{ id: "zz-known", name: "pg-01", host: "10.0.0.5", port: 22, username: "ops", shared: true } as WorkspaceServerSummary];
    for (let i = 0; i < 1100; i++) store.files.set(`work/facts/heads/a-${String(i).padStart(5, "0")}.json`, Buffer.from(JSON.stringify({ serverId: `other-${i}`, collectedAt: 5, hash: "h" })));
    store.files.set("work/facts/heads/zz-known.json", Buffer.from(JSON.stringify({ serverId: "zz-known", collectedAt: 77, hash: "h" })));
    await inner.pullSharedFacts();
    expect(inner.factsHeads.get("zz-known")?.collectedAt).toBe(77);
  }, 60_000);
});

describe("what the team's store lets go", () => {
  const now = 1_800_000_000_000;
  const put = (store: CountingStore, collection: string, item: Mergeable): void => void store.files.set(`work/${collection}/${item.id}.json`, Buffer.from(JSON.stringify(item)));

  it("is one rule: a removal's marker not changed for ninety days, and never a ticket that was not removed", () => {
    expect(RETIRE_AFTER_MS).toBe(90 * DAY);
    expect(RETIRE_REMOVE_AFTER_MS).toBe(91 * DAY);
    expect(retiredRemoval({ deleted: true, updatedAt: now - 91 * DAY }, now)).toBe(true);
    expect(retiredRemoval({ deleted: true, updatedAt: now - 89 * DAY }, now)).toBe(false);
    expect(retiredRemoval({ updatedAt: now - 400 * DAY }, now)).toBe(false);
    expect(retiredTicket({ status: "done", deleted: true, updatedAt: now - 91 * DAY }, now)).toBe(true);
    expect(retiredTicket({ status: "todo", deleted: true, updatedAt: now - 89 * DAY }, now)).toBe(false);
    // A ticket nobody removed is never let go, however old: a finished one is the record of what was done.
    for (const status of ["backlog", "todo", "in_progress", "review", "blocked", "done"] as const) expect(retiredTicket({ status, updatedAt: now - 900 * DAY }, now)).toBe(false);
  });

  it("is left out of what comes back, is not uploaded, and is taken out of the store a day later", async () => {
    const store = countingStore();
    const work = new WorkSync(store);
    const old = { id: "gone-old", updatedAt: now - 90 * DAY - 60_000, deleted: true };
    const older = { id: "gone-older", updatedAt: now - 92 * DAY, deleted: true };
    const recent = { id: "gone-recent", updatedAt: now - 10 * DAY, deleted: true };
    const alive = { id: "alive", updatedAt: now - 300 * DAY };
    for (const item of [old, older, recent, alive]) put(store, "goals", item);
    const mine = [{ id: "mine-gone", updatedAt: now - 100 * DAY, deleted: true }, { id: "mine-alive", updatedAt: now - 100 * DAY }];
    const result = await work.reconcile<Mergeable>("goals", mine, undefined, { now, retired: retiredRemoval });
    expect(result.items.map((x) => x.id).sort()).toEqual(["alive", "gone-recent", "mine-alive"]);
    expect(result.changed).toBe(true);
    // Past ninety days it is no longer kept or sent; past ninety-one its object is gone from the store.
    expect(inStore(store, "work/goals/").sort()).toEqual(["work/goals/alive.json", "work/goals/gone-old.json", "work/goals/gone-recent.json", "work/goals/mine-alive.json"]);
    // The next round finds nothing to do.
    store.reset();
    const again = await work.reconcile<Mergeable>("goals", result.items, undefined, { now, retired: retiredRemoval });
    expect(again.changed).toBe(false);
    expect([store.writes, store.removes]).toEqual([0, 0]);
  });

  it("lets a removal that is still in the store stand against an older copy here", async () => {
    const store = countingStore();
    const work = new WorkSync(store);
    // Removed 90 days and a minute ago: retired here, and in the store for one more day.
    put(store, "goals", { id: "g1", updatedAt: now - 90 * DAY - 60_000, deleted: true });
    const stale = [{ id: "g1", updatedAt: now - 200 * DAY }];
    const result = await work.reconcile<Mergeable>("goals", stale, undefined, { now, retired: retiredRemoval });
    expect(result.items).toEqual([]);
    expect(result.changed).toBe(true);
    expect(JSON.parse(store.files.get("work/goals/g1.json")!.toString()).deleted).toBe(true);
    expect(store.writes).toBe(0);
  });

  it("lets go of an old removal on every installation, and keeps every ticket that was not removed, done ones too", async () => {
    const store = countingStore();
    const a = await makeHub(store, { defaultActorName: "Anna" });
    const b = await makeHub(store, { defaultActorName: "Sara" });
    const at = Date.now();
    const tickets = [
      ticket("done-old", { status: "done", updatedAt: at - 95 * DAY }),
      ticket("done-commented", { status: "done", updatedAt: at - 5 * DAY }),
      ticket("open-old", { status: "todo", updatedAt: at - 400 * DAY }),
      ticket("removed-old", { deleted: true, updatedAt: at - 95 * DAY }),
      ticket("removed-recent", { deleted: true, updatedAt: at - 5 * DAY }),
    ];
    // Both have them, and the store has them, as after years of work.
    a.hub.store.data.workTickets = tickets.map((t) => ({ ...t }));
    b.hub.store.data.workTickets = tickets.map((t) => ({ ...t }));
    for (const t of tickets) put(store, "tickets", t);
    await sync(a.inner);
    const kept = ["done-commented", "done-old", "open-old", "removed-recent"];
    expect(a.hub.store.data.workTickets!.map((t) => t.id).sort()).toEqual(kept);
    expect(inStore(store, "work/tickets/").map((k) => path.basename(k, ".json")).sort()).toEqual(kept);
    // The teammate's copy does not bring them back.
    await sync(b.inner);
    expect(b.hub.store.data.workTickets!.map((t) => t.id).sort()).toEqual(kept);
    expect(inStore(store, "work/tickets/").map((k) => path.basename(k, ".json")).sort()).toEqual(kept);
    await sync(a.inner);
    expect(a.hub.store.data.workTickets!.map((t) => t.id).sort()).toEqual(kept);
  }, 60_000);

  it("keeps the removal of a built-in agent, and lets go of the removal of one a person made", async () => {
    const store = countingStore();
    const { hub, inner } = await makeHub(store, { defaultActorName: "Anna" });
    const builtin = getBuiltinAgents()[0].id;
    const at = Date.now();
    hub.store.data.sharedRemoved = { agents: { [builtin]: at - 200 * DAY, "agent-of-ours": at - 200 * DAY, "agent-recent": at - DAY } };
    await sync(inner);
    expect(Object.keys(hub.store.data.sharedRemoved!.agents!).sort()).toEqual([builtin, "agent-recent"].sort());
    const markers = inStore(store, "work/agents/").map((k) => JSON.parse(store.files.get(k)!.toString()) as MissionAgent & { deleted?: boolean });
    expect(markers.filter((m) => m.deleted).map((m) => m.id).sort()).toEqual([builtin, "agent-recent"].sort());
  }, 60_000);
});
