import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { KbPage, WorkGoal, WorkTicket } from "../../src/shared/types/aiHub";
import { mergeCopies, mergeItems, mergeTicketCopies, stampChange, withComment } from "../../src/main/ai/hub/WorkBoard";
import { WorkSync } from "../../src/main/ai/hub/WorkSync";
import type { QueueStore } from "../../src/main/ai/hub/LearningQueue";
import { mergePageCopies, savePageByPerson } from "../../src/main/ai/hub/KbCompile";

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
});

function memoryBucket(): QueueStore & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  return {
    files,
    list: async (dir) => [...files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1)),
    read: async (p) => files.get(p),
    write: async (p, c) => void files.set(p, c),
    remove: async (p) => void files.delete(p),
  };
}

type Inner = {
  workTick: (now?: number) => Promise<void>;
  lastWorkSync: number;
  clientId: () => string;
  workSyncStore?: WorkSync;
  s3Workspace: { canUseBucket: () => boolean; objects: QueueStore };
};

async function makeHub(host: Record<string, unknown>, bucket: QueueStore) {
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(false);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-teamsync3-"));
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
  Object.defineProperty(inner.s3Workspace, "objects", { value: bucket });
  inner.workSyncStore = new WorkSync(bucket);
  return { hub, inner };
}
const sync = async (inner: Inner): Promise<void> => {
  inner.lastWorkSync = 0;
  await inner.workTick(Date.now());
};
/** Lets the uploads a request starts without waiting for them reach the bucket. */
const settle = () => new Promise((r) => setTimeout(r, 20));
const inBucket = (bucket: { files: Map<string, Buffer> }, id: string): WorkTicket =>
  JSON.parse(bucket.files.get(`work/tickets/${id}.json`)!.toString("utf8"));

const ticket = (id: string, extra: Partial<WorkTicket> = {}): WorkTicket => ({
  id,
  title: id,
  description: "do it",
  status: "todo",
  createdBy: "jacob",
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});

describe("two edits of one ticket at about the same time", () => {
  const base = ticket("t1", { title: "Check disk", updatedAt: 100 });

  it("keep a title change and a teammate's comment, the same on both sides", () => {
    // Sara renames it; 100 ms later Anna, whose copy is still the old one, comments.
    const sara = stampChange(base, { ...base, title: "Check disk on db-01", updatedAt: 200 });
    const anna = stampChange(base, withComment(base, "Anna", "Looking at it.", 300));
    const onSara = mergeTicketCopies(sara, anna);
    const onAnna = mergeTicketCopies(anna, sara);
    expect(onSara).toEqual(onAnna);
    expect(onSara.title).toBe("Check disk on db-01");
    expect(onSara.comments!.map((c) => c.text)).toEqual(["Looking at it."]);
    // Settled: neither copy changes it again.
    expect(mergeTicketCopies(onSara, sara)).toBe(onSara);
    expect(mergeTicketCopies(anna, onSara)).toBe(onSara);
    // Before, the comment's copy was newer and its old title won.
    expect(onSara.updatedAt).toBeGreaterThan(anna.updatedAt);
  });

  it("take the later value of a field both changed, and keep a run's fields together", () => {
    const a = stampChange(base, { ...base, title: "A", updatedAt: 200 });
    const b = stampChange(base, { ...base, title: "B", description: "longer", updatedAt: 300 });
    expect(mergeTicketCopies(a, b)).toMatchObject({ title: "B", description: "longer" });
    // A teammate's later title edit does not take back the run's status, claim and result.
    const ran = stampChange(base, { ...base, status: "review", result: "done it", taskId: "run1", updatedAt: 250 });
    const renamed = stampChange(base, { ...base, title: "Renamed", updatedAt: 400 });
    const merged = mergeTicketCopies(renamed, ran);
    expect(merged).toMatchObject({ title: "Renamed", status: "review", result: "done it", taskId: "run1" });
    expect(mergeTicketCopies(ran, renamed)).toEqual(merged);
  });

  it("goals too: two people's changes of different fields both stay", () => {
    const goal: WorkGoal = { id: "g1", title: "Keep it up", status: "active", createdAt: 1, updatedAt: 100 };
    const a = stampChange(goal, { ...goal, title: "Keep it healthy", updatedAt: 200 });
    const b = stampChange(goal, { ...goal, status: "done" as const, updatedAt: 300 });
    const merged = mergeItems([a], [b]).items[0];
    expect(merged).toMatchObject({ title: "Keep it healthy", status: "done" });
    expect(mergeItems([b], [a]).items[0]).toEqual(merged);
    expect(mergeCopies(merged, b)).toBe(merged);
  });
});

describe("an edit made on a view from before a removal", () => {
  it("does not bring a ticket back; a removal known to the editor does not hold it back", () => {
    const base = ticket("t1", { updatedAt: 100 });
    const removed = stampChange(base, { ...base, deleted: true, deletedBy: "Sara Nyberg", updatedAt: 200 });
    const lateEdit = stampChange(base, { ...base, title: "edited", updatedAt: 300 });
    const onSara = mergeTicketCopies(removed, lateEdit);
    const onAnna = mergeTicketCopies(lateEdit, removed);
    expect(onSara).toEqual(onAnna);
    expect(onSara).toMatchObject({ deleted: true, deletedBy: "Sara Nyberg" });
    // Above the edit, so that it reaches the installation that made it.
    expect(onSara.updatedAt).toBeGreaterThan(lateEdit.updatedAt);
    expect(mergeTicketCopies(lateEdit, onSara)).toBe(onSara);
    // Made again by somebody who saw the removal: that stands.
    const remade = stampChange(removed, { ...removed, deleted: undefined, title: "back", updatedAt: 400 });
    expect(mergeTicketCopies(removed, remade)).toBe(remade);
  });

  it("does not bring a page back either", () => {
    const first = savePageByPerson(undefined, { kind: "procedure" as never, title: "Nginx", when: "Before nginx changes", body: "Run nginx -t." }, "Sara", 1000);
    const removal = { id: first.id, updatedAt: 2000, deleted: true } as unknown as KbPage & { deleted?: boolean };
    const edit = { ...savePageByPerson(first, { kind: first.kind, title: first.title, when: first.when, body: "Run nginx -t, then reload." }, "Erik", 3000), baseAt: first.updatedAt };
    const onErik = mergePageCopies(edit as KbPage & { deleted?: boolean }, removal);
    expect(onErik.deleted).toBe(true);
    expect(mergePageCopies(removal, edit as KbPage & { deleted?: boolean })).toEqual(onErik);
  });
});

describe("the board on two installations", () => {
  it("refuses an edit of a ticket a teammate removed, says by whom, and the ticket stays removed", async () => {
    const bucket = memoryBucket();
    const anna = await makeHub({ defaultActorName: "Anna Lind" }, bucket);
    const sara = await makeHub({ defaultActorName: "Sara Nyberg" }, bucket);
    const made = await anna.hub.request({ action: "ticket-save", ticket: { title: "Rotate logs on web-01" } } as never);
    const id = made.workTickets![0].id;
    await settle();
    await sync(sara.inner);
    await sara.hub.request({ action: "ticket-delete", id });
    await settle();

    // Anna's board has not synced: it still shows the ticket.
    expect(anna.hub.store.data.workTickets!.find((t) => t.id === id)!.deleted).toBeUndefined();
    await expect(
      anna.hub.request({ action: "ticket-save", ticket: { id, title: "Rotate logs on web-01 and web-02" } } as never),
    ).rejects.toThrow(/removed by Sara Nyberg/);
    await expect(anna.hub.request({ action: "ticket-comment", id, text: "On it" })).rejects.toThrow(/removed by Sara Nyberg/);
    await settle();
    await sync(anna.inner);
    await sync(sara.inner);
    expect(inBucket(bucket, id).deleted).toBe(true);
    expect(anna.hub.store.data.workTickets!.filter((t) => !t.deleted)).toHaveLength(0);
    expect(sara.hub.store.data.workTickets!.filter((t) => !t.deleted)).toHaveLength(0);
  });

  it("an edit that got to the bucket before it heard of the removal is undone by the next sync", async () => {
    const bucket = memoryBucket();
    const anna = await makeHub({ defaultActorName: "Anna Lind" }, bucket);
    const sara = await makeHub({ defaultActorName: "Sara Nyberg" }, bucket);
    const made = await anna.hub.request({ action: "ticket-save", ticket: { title: "Rotate logs" } } as never);
    const id = made.workTickets![0].id;
    await settle();
    await sync(sara.inner);
    // Sara removes it while offline; Anna edits her copy and it reaches the bucket first.
    sara.inner.s3Workspace.canUseBucket = () => false;
    await sara.hub.request({ action: "ticket-delete", id });
    sara.inner.s3Workspace.canUseBucket = () => true;
    await new Promise((r) => setTimeout(r, 5));
    await anna.hub.request({ action: "ticket-save", ticket: { id, title: "Rotate logs on web-01" } } as never);
    await settle();
    expect(inBucket(bucket, id).deleted).toBeUndefined();

    await sync(sara.inner);
    await sync(anna.inner);
    expect(inBucket(bucket, id)).toMatchObject({ deleted: true, deletedBy: "Sara Nyberg" });
    expect(anna.hub.store.data.workTickets!.find((t) => t.id === id)!.deleted).toBe(true);
    expect(sara.hub.store.data.workTickets!.find((t) => t.id === id)!.deleted).toBe(true);
  });

  it("keeps a title change and a comment made within one sync of each other", async () => {
    const bucket = memoryBucket();
    const anna = await makeHub({ defaultActorName: "Anna Lind" }, bucket);
    const sara = await makeHub({ defaultActorName: "Sara Nyberg" }, bucket);
    const made = await anna.hub.request({ action: "ticket-save", ticket: { title: "Check disk" } } as never);
    const id = made.workTickets![0].id;
    await settle();
    await sync(sara.inner);
    // Neither sees the other's change before making their own.
    const pull = WorkSync.prototype.readItem;
    WorkSync.prototype.readItem = async () => undefined;
    try {
      await sara.hub.request({ action: "ticket-save", ticket: { id, title: "Check disk on db-01" } } as never);
      await new Promise((r) => setTimeout(r, 5));
      await anna.hub.request({ action: "ticket-comment", id, text: "Looking at it." });
    } finally {
      WorkSync.prototype.readItem = pull;
    }
    await settle();
    for (let i = 0; i < 2; i++) {
      await sync(sara.inner);
      await sync(anna.inner);
    }
    for (const side of [anna, sara]) {
      const t = side.hub.store.data.workTickets!.find((x) => x.id === id)!;
      expect(t.title).toBe("Check disk on db-01");
      expect(t.comments!.map((c) => c.text)).toEqual(["Looking at it."]);
    }
  });

  it("shows a teammate's run on the board as soon as an action is refused for it", async () => {
    const bucket = memoryBucket();
    const server = await makeHub({ defaultActorName: "Anna Lind" }, bucket);
    const laptop = await makeHub({ defaultActorName: "Sara Nyberg" }, bucket);
    const now = Date.now();
    const todo = ticket("t1", { updatedAt: now - 60_000 });
    laptop.hub.store.data.workTickets = [todo];
    const client = server.inner.clientId();
    const runningCopy = { ...todo, status: "in_progress" as const, claim: { by: "Anna Lind", client, at: now - 30_000, seenAt: now - 30_000 }, taskId: "run1", updatedAt: now - 30_000 };
    await server.inner.workSyncStore!.put("tickets", runningCopy);
    await server.inner.workSyncStore!.claim("t1", { by: "Anna Lind", client }, now - 30_000);

    await expect(laptop.hub.request({ action: "ticket-move", id: "t1", status: "done" })).rejects.toThrow(/Anna Lind is running this ticket/);
    expect(laptop.hub.store.data.workTickets!.find((t) => t.id === "t1")).toMatchObject({ status: "in_progress", claim: { by: "Anna Lind" } });
  });
});
