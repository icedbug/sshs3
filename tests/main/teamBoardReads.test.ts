import { afterEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import type { KbPage, WorkTicket, WorkspaceServerSummary } from "../../src/shared/types/aiHub";
import type { FileEntry, IStorageProvider } from "../../src/shared/types/storage";
import { FileQueueStore } from "../../src/main/ai/hub/FileQueueStore";
import type { ListedObject, QueueStore } from "../../src/main/ai/hub/LearningQueue";
import { S3WorkspaceSyncService } from "../../src/main/ai/hub/S3WorkspaceSyncService";
import type { Mergeable } from "../../src/main/ai/hub/WorkBoard";
import { WorkSync } from "../../src/main/ai/hub/WorkSync";

/**
 * What a sync of the team's board costs. The store's listing tells for each object whether it changed
 * (its ETag), so a board nobody touched is synced with a listing per collection and no download.
 */

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
});

type CountingStore = QueueStore & { files: Map<string, Buffer>; reads: string[]; writes: string[]; lists: number; reset(): void };

/** A store in memory that counts what is asked of it. With `marks` its listing tells what changed, as a bucket's does. */
function countingStore(marks = true): CountingStore {
  const files = new Map<string, Buffer>();
  const names = (dir: string): string[] => [...files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1)).sort();
  const b: CountingStore = {
    files,
    reads: [],
    writes: [],
    lists: 0,
    reset() {
      b.reads = [];
      b.writes = [];
      b.lists = 0;
    },
    list: async (dir: string) => {
      b.lists++;
      return names(dir);
    },
    ...(marks
      ? {
          listWithMeta: async (dir: string): Promise<ListedObject[]> => {
            b.lists++;
            return names(dir).map((name) => ({ name, version: crypto.createHash("md5").update(files.get(`${dir}/${name}`)!).digest("hex") }));
          },
        }
      : {}),
    read: async (p: string) => {
      b.reads.push(p);
      return files.get(p);
    },
    write: async (p: string, c: Buffer) => {
      b.writes.push(p);
      files.set(p, Buffer.from(c));
    },
    remove: async (p: string) => void files.delete(p),
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-board-reads-"));
  const hub = new HubService({ changed: () => {}, inventoryTargets: async () => [], backgroundChanged: async () => {}, openSchedule: async () => "s1", show: () => {}, aiConfigFilePath: path.join(dir, "ai.json"), ...host } as never, dir);
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

const sync = async (inner: Inner): Promise<void> => {
  inner.lastWorkSync = 0;
  await inner.workTick(Date.now());
  expect(inner.workSyncError).toBeUndefined();
};

const ticket = (id: string, extra: Partial<WorkTicket> = {}): WorkTicket =>
  ({ id, title: `Ticket ${id}`, description: "d", status: "backlog", createdBy: "x", createdAt: 1, updatedAt: Date.now() - 60_000, ...extra }) as WorkTicket;
const page = (id: string): KbPage =>
  ({ id, kind: "troubleshooting", title: `Page ${id}`, when: "When x", body: "b".repeat(200), targets: [], sources: [], revision: 1, createdAt: 1, updatedAt: Date.now() - 60_000, updatedBy: "x", history: [{ at: 1, by: "x", summary: "s" }] }) as KbPage;

describe("a sync of a board nobody touched", () => {
  it("downloads nothing: two idle rounds, and the second reads no object at all", async () => {
    const store = countingStore();
    const a = await makeHub(store, { defaultActorName: "Anna" });
    const b = await makeHub(store, { defaultActorName: "Sara" });
    a.hub.store.data.workTickets = Array.from({ length: 40 }, (_, i) => ticket(`t-${i}`));
    a.hub.store.data.kbPages = Array.from({ length: 30 }, (_, i) => page(`p-${i}`));
    for (let i = 0; i < 20; i++) await a.hub.request({ action: "kb-save", doc: { title: `Doc ${i}`, content: `# Doc ${i}\n` + "text ".repeat(400), sourceType: "note" } } as never);
    await sync(a.inner);
    await sync(b.inner);
    expect(b.hub.store.data.workTickets!.length).toBe(40);
    expect(b.hub.store.data.kbPages!.length).toBe(30);
    const objects = store.files.size;
    expect(objects).toBeGreaterThanOrEqual(90);

    for (const installation of [a, b]) {
      // The first idle round may read once more what this installation wrote itself.
      store.reset();
      await sync(installation.inner);
      expect(store.writes).toEqual([]);
      // The second: listings only.
      store.reset();
      await sync(installation.inner);
      expect(store.reads).toEqual([]);
      expect(store.writes).toEqual([]);
      expect(store.lists).toBeGreaterThan(0);
    }
  }, 120_000);

  it("still reads everything from a store whose listing cannot tell what changed", async () => {
    const store = countingStore(false);
    const a = await makeHub(store, { defaultActorName: "Anna" });
    a.hub.store.data.workTickets = Array.from({ length: 12 }, (_, i) => ticket(`t-${i}`));
    await sync(a.inner);
    await sync(a.inner);
    store.reset();
    await sync(a.inner);
    expect(store.reads.filter((p) => p.startsWith("work/tickets/")).length).toBe(12);
  }, 60_000);
});

describe("a change in the store", () => {
  it("is the one object that is read, and reaches the other installation", async () => {
    const store = countingStore();
    const a = await makeHub(store, { defaultActorName: "Anna" });
    const b = await makeHub(store, { defaultActorName: "Sara" });
    a.hub.store.data.workTickets = Array.from({ length: 25 }, (_, i) => ticket(`t-${i}`));
    for (let i = 0; i < 2; i++) {
      await sync(a.inner);
      await sync(b.inner);
    }
    // Sara renames one ticket.
    await b.hub.request({ action: "ticket-save", ticket: { id: "t-7", title: "Renamed by Sara" } } as never);
    await sync(b.inner);
    store.reset();
    await sync(a.inner);
    expect(store.reads).toEqual(["work/tickets/t-7.json"]);
    expect(a.hub.store.data.workTickets!.find((t) => t.id === "t-7")!.title).toBe("Renamed by Sara");
    // Putting the two copies together made a copy one step above both, which Anna's installation
    // uploaded: that one is read once more, and then nothing again, on either side.
    await sync(a.inner);
    await sync(b.inner);
    for (const installation of [a, b]) {
      store.reset();
      await sync(installation.inner);
      expect(store.reads).toEqual([]);
      expect(store.writes).toEqual([]);
    }
  }, 120_000);

  it("is read once more after this installation wrote it, and not after that", async () => {
    const store = countingStore();
    const a = await makeHub(store, { defaultActorName: "Anna" });
    a.hub.store.data.workTickets = [ticket("t-1"), ticket("t-2")];
    await sync(a.inner);
    await sync(a.inner);
    await a.hub.request({ action: "ticket-save", ticket: { id: "t-2", title: "Anna's own edit" } } as never);
    await sync(a.inner);
    store.reset();
    await sync(a.inner);
    expect(store.reads.every((p) => p === "work/tickets/t-2.json")).toBe(true);
    store.reset();
    await sync(a.inner);
    expect(store.reads).toEqual([]);
  }, 60_000);

  it("taken over here can be changed here without the store's copy changing with it", async () => {
    const store = countingStore();
    const a = await makeHub(store, { defaultActorName: "Anna" });
    const b = await makeHub(store, { defaultActorName: "Sara" });
    a.hub.store.data.workTickets = [ticket("t-1", { comments: [{ id: "c1", at: 1, author: "Anna", text: "first" }] } as Partial<WorkTicket>)];
    await sync(a.inner);
    await sync(b.inner);
    await sync(b.inner);
    // Sara's copy came from the store. It is changed in place, as code that holds a ticket may do.
    const mine = b.hub.store.data.workTickets!.find((t) => t.id === "t-1")!;
    mine.title = "Changed in place";
    mine.comments!.push({ id: "c2", at: 2, author: "Sara", text: "second" });
    mine.updatedAt += 1000;
    store.reset();
    await sync(b.inner);
    // It is newer than the store's copy, so it is uploaded: the copy kept for comparing did not change with it.
    expect(store.writes).toEqual(["work/tickets/t-1.json"]);
    await sync(a.inner);
    const got = a.hub.store.data.workTickets!.find((t) => t.id === "t-1")!;
    expect(got.title).toBe("Changed in place");
    expect(got.comments!.map((c) => c.text)).toEqual(["first", "second"]);
  }, 60_000);

  it("is seen by the plain reconcile too: unchanged items are not read, a changed one is, a removed one is forgotten", async () => {
    const store = countingStore();
    const work = new WorkSync(store);
    const items: Mergeable[] = Array.from({ length: 5 }, (_, i) => ({ id: `g-${i}`, updatedAt: 100 }));
    await work.reconcile("goals", items);
    store.reset();
    let result = await work.reconcile("goals", items);
    expect(store.reads.length).toBe(5);
    store.reset();
    result = await work.reconcile("goals", result.items);
    expect(store.reads).toEqual([]);
    expect(result.changed).toBe(false);
    // Changed by somebody else, and one taken out of the store.
    store.files.set("work/goals/g-3.json", Buffer.from(JSON.stringify({ id: "g-3", updatedAt: 200, title: "theirs" })));
    store.files.delete("work/goals/g-4.json");
    store.reset();
    result = await work.reconcile("goals", result.items);
    expect(store.reads).toEqual(["work/goals/g-3.json"]);
    expect(result.items.find((x) => x.id === "g-3")).toMatchObject({ updatedAt: 200, title: "theirs" });
    // The one that is gone from the store is uploaded again from here, as before.
    expect(store.writes).toEqual(["work/goals/g-4.json"]);
  });

  it("is seen in other installations' counts: spending and page use are read when they change", async () => {
    const store = countingStore();
    const work = new WorkSync(store);
    const month = new Date().toISOString().slice(0, 7);
    await work.putUsage("laptop", { a1: { month, tokens: 600, runs: 1 } });
    await work.putUsage("server", { a1: { month, tokens: 500, runs: 2 } });
    expect(await work.readOtherUsage("laptop")).toEqual([{ a1: { month, tokens: 500, runs: 2 } }]);
    store.reset();
    const again = await work.readOtherUsage("laptop");
    expect(again).toEqual([{ a1: { month, tokens: 500, runs: 2 } }]);
    expect(store.reads).toEqual([]);
    // What is handed out is the caller's own: changing it does not change what is kept.
    again[0].a1.tokens = 1;
    expect(await work.readOtherUsage("laptop")).toEqual([{ a1: { month, tokens: 500, runs: 2 } }]);
    await work.putUsage("server", { a1: { month, tokens: 900, runs: 3 } });
    store.reset();
    expect(await work.readOtherUsage("laptop")).toEqual([{ a1: { month, tokens: 900, runs: 3 } }]);
    expect(store.reads).toEqual(["work/usage/server.json"]);
  });
});

describe("a team server's shared folder", () => {
  it("tells in its listing when a file was replaced, also by one of the same size written at once", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-file-store-"));
    disposals.push(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
    const store = new FileQueueStore(dir);
    await store.write("work/goals/a.json", Buffer.from('{"id":"a","updatedAt":1}'));
    await store.write("work/goals/b.json", Buffer.from('{"id":"b","updatedAt":1}'));
    const first = await store.listWithMeta("work/goals");
    expect(first.map((e) => e.name).sort()).toEqual(["a.json", "b.json"]);
    expect(first.every((e) => typeof e.version === "string" && e.version.length > 0)).toBe(true);
    expect(await store.listWithMeta("work/goals")).toEqual(first);
    // The same number of bytes, written right away.
    await store.write("work/goals/a.json", Buffer.from('{"id":"a","updatedAt":2}'));
    const second = await store.listWithMeta("work/goals");
    const mark = (list: ListedObject[], name: string): string => list.find((e) => e.name === name)!.version!;
    expect(mark(second, "a.json")).not.toBe(mark(first, "a.json"));
    expect(mark(second, "b.json")).toBe(mark(first, "b.json"));
    expect(await store.listWithMeta("work/nothing-here")).toEqual([]);
    // The account's view of the store has the listing too.
    expect((await store.forAccount(() => undefined).listWithMeta!("work/goals")).length).toBe(2);
  });
});

class Bucket implements IStorageProvider {
  readonly id = "mem";
  readonly name = "mem";
  readonly type = "s3" as const;
  readonly reads: string[] = [];
  readonly writes: string[] = [];
  readonly listed: Array<{ dir: string; force?: boolean }> = [];
  constructor(
    readonly objects: Map<string, Buffer>,
    private readonly withEtag = true,
  ) {}
  private n(p: string): string {
    return p.replace(/^\/+|\/+$/g, "");
  }
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async createFolder(): Promise<void> {}
  async rename(): Promise<void> {}
  async list(dir: string, options?: { force?: boolean }): Promise<FileEntry[]> {
    const prefix = this.n(dir);
    this.listed.push({ dir: prefix, force: options?.force });
    return [...this.objects.entries()]
      .filter(([k]) => k.startsWith(`${prefix}/`))
      .map(([k, v]) => ({ name: k.slice(prefix.length + 1), path: k, isDirectory: false, size: v.length, mtime: "m", ...(this.withEtag ? { etag: crypto.createHash("md5").update(v).digest("hex") } : {}) }));
  }
  async stat(p: string): Promise<FileEntry> {
    const v = this.objects.get(this.n(p));
    if (!v) throw Object.assign(new Error("NoSuchKey"), { code: "NoSuchKey" });
    return { name: path.posix.basename(p), path: p, isDirectory: false, size: v.length, mtime: "m" };
  }
  async delete(p: string): Promise<void> {
    this.objects.delete(this.n(p));
  }
  async readFile(p: string): Promise<Buffer> {
    this.reads.push(this.n(p));
    const v = this.objects.get(this.n(p));
    if (!v) throw Object.assign(new Error("NoSuchKey"), { code: "NoSuchKey" });
    return v;
  }
  async writeFile(p: string, data: Buffer | Uint8Array): Promise<void> {
    this.writes.push(this.n(p));
    this.objects.set(this.n(p), Buffer.from(data));
  }
  async createReadStream(p: string): Promise<Readable> {
    return Readable.from(await this.readFile(p));
  }
  async createWriteStream(): Promise<Writable> {
    return new Writable({ write: (_c, _e, cb) => cb() });
  }
}

function bucketService(bucket: Bucket, actor: string, options: Record<string, unknown> = {}) {
  const svc = new S3WorkspaceSyncService(
    path.join(os.tmpdir(), `sshs3-board-reads-${actor}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`),
    {
      getLocalState: async () => ({ actor, clientId: `${actor}-laptop`, servers: [], memories: [], activityLog: [], deletedServerIds: {}, deletedMemoryIds: {}, activeTerminals: [] }),
      applyMergedState: async () => undefined,
      onStateChanged: () => undefined,
    },
    { providerFactory: () => bucket, ...options },
  );
  (svc as unknown as { config: Record<string, unknown> }).config = { enabled: true, region: "r", bucket: "team", prefix: "ws", accessKeyId: "K", secretAccessKey: "S", forcePathStyle: true };
  disposals.push(() => svc.dispose());
  return svc;
}

describe("the bucket's listing and presence", () => {
  it("is asked afresh, and marks an object by its ETag and by nothing less", async () => {
    const objects = new Map<string, Buffer>([["team/ws/work/goals/a.json", Buffer.from("{}")]]);
    const withEtag = new Bucket(objects);
    const marked = await bucketService(withEtag, "anna").objects.listWithMeta("work/goals");
    expect(marked).toEqual([{ name: "a.json", version: `${crypto.createHash("md5").update("{}").digest("hex")}:2` }]);
    // Not the provider's kept listing: a teammate's change has to show.
    expect(withEtag.listed.at(-1)).toEqual({ dir: "team/ws/work/goals", force: true });
    // A size and a time to the second cannot tell a change apart: no mark, so the object is read.
    const unmarked = await bucketService(new Bucket(objects, false), "anna").objects.listWithMeta("work/goals");
    expect(unmarked).toEqual([{ name: "a.json" }]);
  });

  it("is written by one timer: a poll that finds nothing changed writes and reads no presence", async () => {
    const bucket = new Bucket(new Map());
    const svc = bucketService(bucket, "anna");
    await svc.syncNow();
    expect(bucket.writes.filter((p) => p.includes("/presence/")).length).toBe(1);
    bucket.writes.length = 0;
    bucket.reads.length = 0;
    bucket.listed.length = 0;
    await svc.pollOnce();
    await svc.pollOnce();
    expect(bucket.writes).toEqual([]);
    expect(bucket.reads).toEqual([]);
    expect(bucket.listed).toEqual([]);
    // The presence timer's own beat does write it.
    await svc.publishAndRefreshPresence();
    expect(bucket.writes.filter((p) => p.includes("/presence/")).length).toBe(1);
  });

  it("does not download again the file of somebody who is away", async () => {
    const objects = new Map<string, Buffer>();
    const now = Date.now();
    objects.set("team/ws/presence/sara--sara-laptop.json", Buffer.from(JSON.stringify({ actor: "sara", clientId: "sara-laptop", updatedAt: now - 3 * 60 * 60_000, activeTerminals: [] })));
    objects.set("team/ws/presence/omar--omar-laptop.json", Buffer.from(JSON.stringify({ actor: "omar", clientId: "omar-laptop", updatedAt: now, activeTerminals: [] })));
    const bucket = new Bucket(objects);
    const svc = bucketService(bucket, "anna");
    await svc.publishAndRefreshPresence();
    expect(svc.getPresence().map((p) => p.actor).sort()).toEqual(["anna", "omar"]);
    bucket.reads.length = 0;
    await svc.publishAndRefreshPresence();
    expect(bucket.reads).toEqual([]);
    // Sara comes back: her file is another now, and is read.
    objects.set("team/ws/presence/sara--sara-laptop.json", Buffer.from(JSON.stringify({ actor: "sara", clientId: "sara-laptop", updatedAt: Date.now(), activeTerminals: [] })));
    await svc.publishAndRefreshPresence();
    expect(bucket.reads).toEqual(["team/ws/presence/sara--sara-laptop.json"]);
    expect(svc.getPresence().map((p) => p.actor).sort()).toEqual(["anna", "omar", "sara"]);
  });
});

describe("a teammate's readings of the servers", () => {
  it("are looked at when they are new: an idle round downloads none of them", async () => {
    const store = countingStore();
    const { inner } = await makeHub(store);
    inner.cachedWorkspaceServers = [{ id: "s1", name: "pg-01", host: "10.0.0.5", port: 22, username: "ops", shared: true } as WorkspaceServerSummary];
    const head = (serverId: string, collectedAt: number): Buffer => Buffer.from(JSON.stringify({ serverId, collectedAt, hash: `h${collectedAt}` }));
    store.files.set("work/facts/heads/s1.json", head("s1", 10));
    store.files.set("work/facts/heads/s2.json", head("s2", 10));
    await inner.pullSharedFacts();
    expect(inner.factsHeads.get("s1")?.collectedAt).toBe(10);
    expect(inner.factsHeads.has("s2")).toBe(false);
    store.reset();
    await inner.pullSharedFacts();
    expect(store.reads).toEqual([]);
    // A new reading of the one is read; the other is not ours to see and stays unread.
    store.files.set("work/facts/heads/s1.json", head("s1", 20));
    store.reset();
    await inner.pullSharedFacts();
    expect(store.reads.filter((p) => p.startsWith("work/facts/heads/"))).toEqual(["work/facts/heads/s1.json"]);
    expect(inner.factsHeads.get("s1")?.collectedAt).toBe(20);
    // The other server becomes one of ours: its reading is looked at then, though the file is as it was.
    inner.cachedWorkspaceServers = [...inner.cachedWorkspaceServers, { id: "s2", name: "pg-02", host: "10.0.0.6", port: 22, username: "ops", shared: true } as WorkspaceServerSummary];
    store.reset();
    await inner.pullSharedFacts();
    expect(store.reads.filter((p) => p.startsWith("work/facts/heads/"))).toEqual(["work/facts/heads/s2.json"]);
    expect(inner.factsHeads.get("s2")?.collectedAt).toBe(10);
  }, 60_000);
});
