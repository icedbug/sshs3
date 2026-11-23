import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { KbPage } from "../../src/shared/types/aiHub";
import type { IncomingAlert } from "../../src/main/ai/hub/AlertIntake";
import type { QueueStore } from "../../src/main/ai/hub/LearningQueue";
import { WorkSync } from "../../src/main/ai/hub/WorkSync";

/**
 * What a person keeps private in the knowledge base stays theirs: a private page's title is not put on a
 * ticket of the team's board, and making an uploaded document private does not need team storage that
 * the file was never in.
 */

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
});

function memoryBucket(): QueueStore & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  return {
    files,
    list: async (dir: string) => [...files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1)).sort(),
    read: async (p: string) => files.get(p),
    write: async (p: string, c: Buffer) => void files.set(p, Buffer.from(c)),
    remove: async (p: string) => void files.delete(p),
  };
}

type Inner = {
  workTick: (now?: number) => Promise<void>;
  lastWorkSync: number;
  workSyncStore?: WorkSync;
  workSyncOn?: unknown;
  workSyncError?: string;
  s3Workspace: { canUseBucket: () => boolean };
  takeAlerts: (alerts: IncomingAlert[]) => Promise<{ created: string[]; updated: string[] }>;
};

async function makeHub(host: Record<string, unknown> = {}) {
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(false);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-private-kb-"));
  const hub = new HubService({ changed: () => {}, inventoryTargets: async () => [], backgroundChanged: async () => {}, openSchedule: async () => "s1", show: () => {}, aiConfigFilePath: path.join(dir, "ai.json"), defaultActorName: "Anna", ...host } as never, dir);
  disposals.push(async () => {
    await hub.dispose();
    setDemoModeForTesting(undefined);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await hub.initialize();
  const inner = hub as unknown as Inner;
  /** A team bucket is connected from now on. */
  const connect = (bucket: QueueStore): void => {
    inner.s3Workspace.canUseBucket = () => true;
    Object.defineProperty(inner.s3Workspace, "objects", { value: bucket, configurable: true });
    inner.workSyncStore = new WorkSync(bucket);
    inner.workSyncOn = bucket;
  };
  const sync = async (): Promise<void> => {
    inner.lastWorkSync = 0;
    await inner.workTick(Date.now());
    expect(inner.workSyncError).toBeUndefined();
  };
  return { hub, inner, dir, connect, sync };
}

const page = (id: string, extra: Partial<KbPage> = {}): KbPage =>
  ({ id, kind: "troubleshooting", title: `Page ${id}`, when: "When replication lag on pg-01 is high", body: "replication lag pg-01 payroll ".repeat(20), targets: [], sources: [], revision: 1, createdAt: 1, updatedAt: Date.now(), updatedBy: "x", history: [{ at: 1, by: "x", summary: "s" }], ...extra }) as KbPage;
const alert = (extra: Partial<IncomingAlert> = {}): IncomingAlert => ({ fingerprint: `f-${Math.random().toString(36).slice(2)}`, title: "ReplicationLag", severity: "warning", status: "firing", subjects: ["pg-01"], text: "replication lag on pg-01", source: "Alertmanager", labels: { alertname: "ReplicationLag" }, ...extra });

describe("a private page and an alert's ticket", () => {
  it("is not named on the ticket, by its alert or by its words, and does not reach the team's board", async () => {
    const bucket = memoryBucket();
    const { hub, inner, connect, sync } = await makeHub();
    connect(bucket);
    const SECRET_TITLE = "Payroll database failover (private notes)";
    // One private page bound to the alert by name, one private page that only matches its words, and one
    // that is private because the document it was written from is.
    hub.store.data.kbDocuments = [{ id: "d-priv", title: "My notes", sourceType: "note", content: "x", chunks: [], collection: "General", tags: [], updatedAt: 1, shared: false } as never];
    hub.store.data.kbPages = [
      page("p-bound", { title: SECRET_TITLE, private: true, alerts: ["ReplicationLag"] }),
      page("p-words", { title: "Replication lag on pg-01 (my own way)", private: true }),
      page("p-source", { title: "Replication lag, from my notes", alerts: ["ReplicationLag"], sources: [{ docId: "d-priv", title: "My notes" }] as never }),
    ];
    const res = await inner.takeAlerts([alert()]);
    const ticket = hub.store.data.workTickets!.find((t) => t.id === res.created[0])!;
    expect(ticket.kbPages).toBeUndefined();
    for (const title of [SECRET_TITLE, "my own way", "from my notes"]) expect(ticket.description).not.toContain(title);
    expect(ticket.description).toContain("open the knowledge base page for this symptom if there is one");
    await sync();
    const inBucket = [...bucket.files.entries()].filter(([k]) => k.startsWith("work/tickets/")).map(([, v]) => v.toString("utf8")).join("\n");
    expect(inBucket).toContain("ReplicationLag");
    for (const title of [SECRET_TITLE, "my own way", "from my notes"]) expect(inBucket).not.toContain(title);
  }, 60_000);

  it("leaves a shared page named as before", async () => {
    const { hub, inner } = await makeHub();
    hub.store.data.kbPages = [page("p-shared", { title: "Replication lag on a standby", alerts: ["ReplicationLag"] }), page("p-priv", { title: "Private twin", private: true, alerts: ["ReplicationLag"] })];
    const res = await inner.takeAlerts([alert()]);
    const ticket = hub.store.data.workTickets!.find((t) => t.id === res.created[0])!;
    expect(ticket.kbPages).toEqual([{ id: "p-shared", title: "Replication lag on a standby", known: true }]);
    expect(ticket.description).toContain("“Replication lag on a standby”");
    expect(ticket.description).not.toContain("Private twin");
  }, 60_000);
});

describe("making an uploaded document private", () => {
  const upload = { action: "kb-ingest-file", name: "notes.txt", mime: "text/plain", dataBase64: Buffer.from("How the staging database is restored after a failed upgrade. ".repeat(5)).toString("base64") } as never;
  const originalKey = (id: string): string => `kb/originals/${id}/notes.txt`;

  it("needs no team storage when there is none: the file was never uploaded", async () => {
    const { hub } = await makeHub();
    await hub.request(upload);
    const doc = hub.store.data.kbDocuments!.find((d) => d.original)!;
    expect(doc.shared).not.toBe(false);
    await hub.request({ action: "kb-save", doc: { id: doc.id, title: doc.title, content: doc.content, sourceType: doc.sourceType, shared: false } } as never);
    const saved = hub.store.data.kbDocuments!.find((d) => d.id === doc.id)!;
    expect(saved.shared).toBe(false);
    expect(saved.original).toMatchObject({ name: "notes.txt", keptLocal: true, withdraw: true });
    // The file is still here for its owner.
    const download = (await hub.request({ action: "kb-original", id: doc.id })).reply!.download!;
    expect(Buffer.from(download.dataBase64, "base64").toString("utf8")).toContain("staging database");
  }, 60_000);

  it("takes a copy out of a team store that is connected later, once", async () => {
    const { hub, connect, sync } = await makeHub();
    await hub.request(upload);
    const doc = hub.store.data.kbDocuments!.find((d) => d.original)!;
    await hub.request({ action: "kb-save", doc: { id: doc.id, title: doc.title, content: doc.content, sourceType: doc.sourceType, shared: false } } as never);
    // A bucket that still holds the file from an earlier time, and somebody else's file.
    const bucket = memoryBucket();
    bucket.files.set(originalKey(doc.id), Buffer.from("an old copy"));
    bucket.files.set("kb/originals/other/readme.txt", Buffer.from("a teammate's"));
    const removes = vi.spyOn(bucket, "remove");
    connect(bucket);
    await sync();
    expect(bucket.files.has(originalKey(doc.id))).toBe(false);
    expect(bucket.files.has("kb/originals/other/readme.txt")).toBe(true);
    const after = hub.store.data.kbDocuments!.find((d) => d.id === doc.id)!;
    expect(after.original).toEqual({ name: "notes.txt", mime: "text/plain", size: after.original!.size, keptLocal: true });
    // Nothing of the private document went up, and it is not asked for again.
    expect([...bucket.files.keys()].some((k) => k.includes(doc.id) && !k.startsWith("work/kb/"))).toBe(false);
    const asked = removes.mock.calls.filter(([key]) => key === originalKey(doc.id)).length;
    await sync();
    expect(removes.mock.calls.filter(([key]) => key === originalKey(doc.id)).length).toBe(asked);
  }, 60_000);

  it("withdraws the file from the team store at once when one is connected", async () => {
    const bucket = memoryBucket();
    const { hub, connect } = await makeHub();
    connect(bucket);
    await hub.request(upload);
    const doc = hub.store.data.kbDocuments!.find((d) => d.original)!;
    await vi.waitFor(() => expect(bucket.files.has(originalKey(doc.id))).toBe(true));
    await hub.request({ action: "kb-save", doc: { id: doc.id, title: doc.title, content: doc.content, sourceType: doc.sourceType, shared: false } } as never);
    expect(bucket.files.has(originalKey(doc.id))).toBe(false);
    const saved = hub.store.data.kbDocuments!.find((d) => d.id === doc.id)!;
    expect(saved.original).toMatchObject({ keptLocal: true });
    expect(saved.original!.withdraw).toBeUndefined();
  }, 60_000);

  it("says why when the file is not on this computer and there is no store to fetch it from", async () => {
    const { hub, dir } = await makeHub();
    await hub.request(upload);
    const doc = hub.store.data.kbDocuments!.find((d) => d.original)!;
    // As for a document a teammate added: its file is in the team's store, not here.
    await fs.rm(path.join(dir, "kb-originals"), { recursive: true, force: true });
    await expect(hub.request({ action: "kb-save", doc: { id: doc.id, title: doc.title, content: doc.content, sourceType: doc.sourceType, shared: false } } as never)).rejects.toThrow(
      "The original file is not on this computer, because a teammate added it. Connect to your team storage to make this original private.",
    );
    expect(hub.store.data.kbDocuments!.find((d) => d.id === doc.id)!.shared).not.toBe(false);
  }, 60_000);
});
