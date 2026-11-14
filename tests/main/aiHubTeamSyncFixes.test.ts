import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AgentTask,
  EvalCase,
  KbPage,
  MemoryEntry,
  WorkspaceServerSummary,
  WorkTicket,
  WorkforceRun,
} from "../../src/shared/types/aiHub";
import {
  PLAN_WAITS,
  mergeItems,
  mergeTicketCopies,
  ticketAfterRun,
} from "../../src/main/ai/hub/WorkBoard";
import { WorkSync } from "../../src/main/ai/hub/WorkSync";
import type { QueueStore } from "../../src/main/ai/hub/LearningQueue";
import { mergePageCopies, savePageByPerson } from "../../src/main/ai/hub/KbCompile";
import {
  mergeMemoryCopies,
  mergeS3WorkspacePayload,
  type S3WorkspaceRemotePayload,
} from "../../src/main/ai/hub/S3WorkspaceSyncService";
import { caseFromTask, compareRuns, evalRun } from "../../src/main/ai/hub/EvalSuite";
import { parseFacts } from "../../src/main/ai/hub/ServerFacts";
import { demoFactsOutput } from "../../src/main/ai/hub/demoFacts";
import { SelfLearningService } from "../../src/main/ai/hub/SelfLearningService";
import { KnowledgeBaseService } from "../../src/main/ai/hub/KnowledgeBaseService";
import { ProfileStore } from "../../src/main/profile/ProfileStore";

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
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
  settleTickets: () => void;
  lastWorkSync: number;
  clientId: () => string;
  workSyncStore?: WorkSync;
  s3Workspace: { canUseBucket: () => boolean; objects: QueueStore };
  context: { read: (t: AgentTask, q?: string, s?: string, extra?: unknown) => Record<string, unknown> };
  collectExtraContext: () => Promise<Record<string, unknown>>;
  asOfEvalCase: (t: AgentTask, extra: unknown) => Record<string, unknown>;
  appActionHost: () => never;
};

async function makeHub(host: Record<string, unknown> = {}, bucket?: QueueStore) {
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(false);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-teamsync-"));
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
  if (bucket) {
    inner.s3Workspace.canUseBucket = () => true;
    Object.defineProperty(inner.s3Workspace, "objects", { value: bucket });
    inner.workSyncStore = new WorkSync(bucket);
  }
  return { hub, inner, dir };
}
const sync = async (inner: Inner): Promise<void> => {
  inner.lastWorkSync = 0;
  await inner.workTick(Date.now());
};
async function waitFor(check: () => boolean, ms = 8000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const ticket = (id: string, extra: Partial<WorkTicket> = {}): WorkTicket => ({
  id,
  title: id,
  description: "do it",
  status: "todo",
  assigneeAgentId: "a1",
  createdBy: "jacob",
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});
const running = (id: string, extra: Partial<AgentTask> = {}): AgentTask =>
  ({ id, title: "Ticket run", mode: "advice", status: "running", messages: [], changes: [], sources: [], createdAt: 1, updatedAt: 1, ...extra }) as unknown as AgentTask;

// ---- 1. facts readings reach a teammate who has not switched readings on ----------------

describe("a teammate's reading of a shared server", () => {
  it("arrives with the board's sync, also where scheduled readings are off", async () => {
    const bucket = memoryBucket();
    const now = Date.now();
    const facts = parseFacts(demoFactsOutput({ name: "web-prod-01", host: "10.1.1.1" }, now, 0), now);
    // What a teammate's installation wrote after reading the server.
    await bucket.write("work/facts/data/web.json", Buffer.from(JSON.stringify({ serverId: "web", name: "web-prod-01", status: "ok", attemptedAt: now, collectedAt: now, hash: "h1", facts, changes: [] })));
    await bucket.write("work/facts/heads/web.json", Buffer.from(JSON.stringify({ serverId: "web", collectedAt: now, hash: "h1", client: "theirs" })));
    await bucket.write("work/facts/data/own.json", Buffer.from(JSON.stringify({ serverId: "own", name: "laptop", status: "ok", attemptedAt: now, collectedAt: now, hash: "h2", facts, changes: [] })));
    await bucket.write("work/facts/heads/own.json", Buffer.from(JSON.stringify({ serverId: "own", collectedAt: now, hash: "h2", client: "theirs" })));

    const servers = [
      { id: "web", name: "web-prod-01", host: "10.1.1.1", shared: true },
      { id: "own", name: "laptop", host: "10.1.1.2", shared: false },
    ] as WorkspaceServerSummary[];
    const { hub, inner } = await makeHub({ workspaceServers: async () => servers }, bucket);
    let snap = await hub.snapshot();
    // Readings are off here, which is the default.
    expect(snap.serverFacts).toMatchObject({ enabled: false });
    expect(snap.serverFacts!.servers.find((s) => s.serverId === "web")).toMatchObject({ status: "never" });

    await sync(inner);
    snap = await hub.snapshot();
    expect(snap.serverFacts!.servers.find((s) => s.serverId === "web")).toMatchObject({ status: "ok", collectedAt: now });
    expect(snap.serverFacts!.servers.find((s) => s.serverId === "web")!.packages).toBeGreaterThan(2);
    // A reading of somebody's personal server is still not this installation's to see.
    expect(snap.serverFacts!.servers.find((s) => s.serverId === "own")).toMatchObject({ status: "never" });
    expect((await hub.request({ action: "server-facts-read", serverId: "web" })).reply!.serverFacts!.facts).toBeTruthy();
  });
});

// ---- 2. a running ticket stays with its run ------------------------------------------------

describe("two copies of a ticket", () => {
  const claim = { by: "Anna", client: "server", at: 10, seenAt: 10 };
  const mine = ticket("t1", { status: "in_progress", claim, taskId: "run1", updatedAt: 10, comments: [{ id: "c1", at: 5, author: "Anna", text: "first" }] });
  const runningHere = (t: WorkTicket) => t.status === "in_progress" && t.claim?.client === "server";

  it("keeps the run with the installation that runs it when a teammate moved the ticket on an old view", () => {
    const stale = ticket("t1", { status: "backlog", title: "renamed", updatedAt: 20, comments: [{ id: "c2", at: 15, author: "Sara", text: "second" }] });
    const kept = mergeTicketCopies(mine, stale, runningHere);
    expect(kept).toMatchObject({ status: "in_progress", claim, taskId: "run1", title: "renamed" });
    expect(kept.comments!.map((c) => c.id)).toEqual(["c1", "c2"]);
    // Above the teammate's copy, so that it goes back to everyone.
    expect(kept.updatedAt).toBeGreaterThan(stale.updatedAt);
    const merged = mergeItems([mine], [stale], (l, r) => mergeTicketCopies(l, r, runningHere));
    expect(merged.changed).toBe(true);
    expect(merged.newerLocally.map((t) => t.status)).toEqual(["in_progress"]);
    // Without a run here, the newer copy wins as before.
    expect(mergeTicketCopies(mine, stale).status).toBe("backlog");
  });

  it("puts back a ticket that was removed from under its run, and says so on it", () => {
    const removed = { ...ticket("t1", { updatedAt: 30 }), deleted: true } as WorkTicket;
    const kept = mergeTicketCopies(mine, removed, runningHere);
    expect(kept.deleted).toBeUndefined();
    expect(kept).toMatchObject({ status: "in_progress", claim, taskId: "run1" });
    expect(kept.updatedAt).toBeGreaterThan(30);
    expect(kept.comments!.at(-1)!.text).toMatch(/removed on another computer while an agent was running it here/);
  });

  it("keeps both people's comments when they commented at the same time, and both sides end up the same", () => {
    const base = ticket("t1", { updatedAt: 1 });
    const a = { ...base, updatedAt: 5, comments: [{ id: "ca", at: 5, author: "Anna", text: "from Anna" }] };
    const b = { ...base, updatedAt: 6, comments: [{ id: "cb", at: 6, author: "Sara", text: "from Sara" }] };
    const onA = mergeTicketCopies(a, b);
    const onB = mergeTicketCopies(b, a);
    expect(onA.comments!.map((c) => c.id)).toEqual(["ca", "cb"]);
    expect(onB).toEqual(onA);
    // Once both have it, nothing moves any more.
    expect(mergeTicketCopies(onA, b)).toBe(onA);
    expect(mergeTicketCopies(b, onA)).toBe(onA);
    // A plain older copy changes nothing, and is not bumped.
    expect(mergeTicketCopies(onA, base)).toBe(onA);
  });
});

describe("a ticket that another installation is running", () => {
  it("is not moved, removed or decided on an old view, and its run's result reaches it", async () => {
    const bucket = memoryBucket();
    const server = await makeHub({ defaultActorName: "Anna Lind" }, bucket);
    const laptop = await makeHub({ defaultActorName: "Sara Nyberg" }, bucket);
    const client = server.inner.clientId();
    const now = Date.now();

    // Both have the ticket as "to do"; then the server starts a run, and the laptop has not synced yet.
    const todo = ticket("t1", { assigneeAgentId: undefined, updatedAt: now - 60_000 });
    laptop.hub.store.data.workTickets = [todo];
    const run = running("run1", { ticketId: "t1" });
    server.hub.store.data.tasks.push(run);
    server.hub.store.data.workTickets = [{ ...todo, status: "in_progress", claim: { by: "Anna Lind", client, at: now - 30_000, seenAt: now - 30_000 }, taskId: "run1", updatedAt: now - 30_000 }];
    await server.inner.workSyncStore!.claim("t1", { by: "Anna Lind", client }, now - 30_000);

    // The laptop's own copy says "to do", but the bucket knows who runs it.
    await expect(laptop.hub.request({ action: "ticket-move", id: "t1", status: "backlog" })).rejects.toThrow(/Anna Lind is running this ticket on another computer/);
    await expect(laptop.hub.request({ action: "ticket-delete", id: "t1" })).rejects.toThrow(/Anna Lind is running this ticket/);
    // Its text may be changed; its status belongs to the run, and the reply says so.
    const saved = await laptop.hub.request({ action: "ticket-save", ticket: { id: "t1", title: "Clean up /var on db-01", status: "backlog" } } as never);
    expect(saved.reply!.notes!.join(" ")).toMatch(/The status was not changed. Anna Lind is running this ticket/);
    expect(saved.workTickets!.find((t) => t.id === "t1")).toMatchObject({ title: "Clean up /var on db-01", status: "todo" });
    await laptop.hub.request({ action: "ticket-comment", id: "t1", text: "Mind the newest three dumps." });

    // The laptop's newer copy (still "to do", no claim) reaches the bucket; the server keeps its run.
    await sync(laptop.inner);
    await sync(server.inner);
    let mine = server.hub.store.data.workTickets!.find((t) => t.id === "t1")!;
    expect(mine).toMatchObject({ status: "in_progress", taskId: "run1", title: "Clean up /var on db-01", claim: { client } });
    expect(mine.comments!.map((c) => c.text)).toEqual(["Mind the newest three dumps."]);

    // Even a removal that got through (written straight to the bucket) does not take the ticket from the run.
    await bucket.write("work/tickets/t1.json", Buffer.from(JSON.stringify({ ...mine, deleted: true, claim: undefined, updatedAt: Date.now() + 5 })));
    await sync(server.inner);
    mine = server.hub.store.data.workTickets!.find((t) => t.id === "t1")!;
    expect(mine.deleted).toBeUndefined();
    expect(mine.status).toBe("in_progress");
    expect(JSON.parse(bucket.files.get("work/tickets/t1.json")!.toString("utf8"))).toMatchObject({ status: "in_progress", claim: { client } });

    // The run ends: its report goes on the ticket, and the laptop sees it.
    run.status = "completed";
    run.messages.push({ id: "m1", role: "assistant", text: "Removed 24 expired dumps; /var is at 66 %.", at: Date.now() });
    server.inner.settleTickets();
    expect(server.hub.store.data.workTickets!.find((t) => t.id === "t1")).toMatchObject({ status: "review", result: "Removed 24 expired dumps; /var is at 66 %." });
    await sync(server.inner);
    await sync(laptop.inner);
    expect(laptop.hub.store.data.workTickets!.find((t) => t.id === "t1")).toMatchObject({ status: "review", result: "Removed 24 expired dumps; /var is at 66 %." });
    // Released: now the laptop may move it.
    await laptop.hub.request({ action: "ticket-move", id: "t1", status: "todo" });
  });

  it("is not moved or removed from under its own run either, however long the run has been going", async () => {
    const { hub, inner } = await makeHub();
    const old = Date.now() - 30 * 60_000;
    hub.store.data.tasks.push(running("run1", { ticketId: "t1" }));
    // The claim on the ticket is half an hour old: liveness is kept in the claim file, not on the ticket.
    hub.store.data.workTickets = [ticket("t1", { status: "in_progress", claim: { by: "me", client: inner.clientId(), at: old, seenAt: old }, taskId: "run1" })];
    await expect(hub.request({ action: "ticket-move", id: "t1", status: "backlog" })).rejects.toThrow(/Stop the run first/);
    await expect(hub.request({ action: "ticket-delete", id: "t1" })).rejects.toThrow(/Stop the run first/);
    const saved = await hub.request({ action: "ticket-save", ticket: { id: "t1", title: "t1", status: "done" } } as never);
    expect(saved.workTickets![0].status).toBe("in_progress");
    expect(saved.reply!.notes![0]).toMatch(/The status was not changed/);
  });
});

function sse(events: Array<Record<string, unknown>>): Response {
  const text = events.map((e) => `data: ${JSON.stringify(e)}`).join("\n\n") + "\n\n";
  return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } }), { status: 200 });
}
const say = (text: string): Response =>
  sse([
    { type: "message_start", message: { usage: { input_tokens: 700 } } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "message_delta", usage: { output_tokens: 300 } },
  ]);

describe("a ticket whose conversation goes on after its run", () => {
  it("says that a proposed plan waits, and does not count a conversation's tokens twice", () => {
    const base = ticket("t1", { status: "in_progress", tokens: 50 });
    const proposed = running("run1", { status: "completed", plan: { status: "proposed" } as never, usage: { inputTokens: 700, outputTokens: 300 } as never, messages: [{ id: "m", role: "assistant", text: "Plan: delete the expired dumps.", at: 1 }] });
    const first = ticketAfterRun(base, proposed, 100);
    expect(first.status).toBe("review");
    expect(first.result!.startsWith(PLAN_WAITS)).toBe(true);
    expect(first.result).toContain("Plan: delete the expired dumps.");
    expect(first.tokens).toBe(1050);
    // The same conversation runs again (the plan was approved) and has now spent 2500 in all.
    const done = { ...proposed, plan: { status: "approved" } as never, usage: { inputTokens: 2000, outputTokens: 500 } as never, messages: [...proposed.messages, { id: "m2", role: "assistant" as const, text: "Deleted 24 dumps and verified.", at: 2 }] } as AgentTask;
    const second = ticketAfterRun({ ...first, status: "in_progress" }, done, 200);
    expect(second.result).toBe("Deleted 24 dumps and verified.");
    expect(second.tokens).toBe(2550);
    // Another conversation's tokens are added in full.
    expect(ticketAfterRun(second, { ...done, id: "run2" } as AgentTask, 300).tokens).toBe(5050);
  });

  it("is the ticket's run again: the later report replaces the earlier one, and a pending plan cannot be approved as done", async () => {
    const { hub } = await makeHub();
    await hub.request({ action: "configure", config: { enabled: true, provider: "anthropic", model: "claude-opus-5-5", apiKey: "sk-ant-test" }, preferences: { proposeMemories: false } } as never); // pragma: allowlist secret
    let snap = await hub.request({ action: "workforce-template-apply", templateId: "develop-product" });
    const first = snap.workTickets![0];
    const answers = ["Nothing is fixed yet; the outage remains unresolved.", "Fixed: the typo is corrected and verified."];
    vi.stubGlobal("fetch", vi.fn(async () => say(answers.shift() ?? "Nothing more.")));
    snap = await hub.request({ action: "ticket-start", id: first.id });
    const taskId = snap.reply!.started!.taskId;
    const state = () => hub.store.data.workTickets!.find((t) => t.id === first.id)!;
    await waitFor(() => state().status === "review");
    expect(state().result).toContain("remains unresolved");
    const tokensAfterFirst = state().tokens!;

    // While the agent's plan waits, "approve" would call work done that has not started.
    const task = hub.store.data.tasks.find((t) => t.id === taskId)!;
    task.plan = { status: "proposed" } as never;
    await expect(hub.request({ action: "ticket-review", id: first.id, approve: true })).rejects.toThrow(/proposed a plan and has not carried it out/);
    task.plan = undefined;

    // A person answers in the conversation: the ticket is checked out again and gets the new report.
    await hub.request({ action: "reply", taskId, text: "Go ahead and fix the typo." });
    await waitFor(() => state().status === "review" && /Fixed/.test(state().result ?? ""));
    expect(state().result).toBe("Fixed: the typo is corrected and verified.");
    expect(state().claim).toBeUndefined();
    const total = (task.usage?.inputTokens ?? 0) + (task.usage?.outputTokens ?? 0);
    expect(total).toBeGreaterThan(tokensAfterFirst);
    expect(state().tokens).toBe(total);

    // Approved and done: answering once more does not reopen it.
    await hub.request({ action: "ticket-review", id: first.id, approve: true });
    await hub.request({ action: "reply", taskId, text: "Thanks." });
    await waitFor(() => !["queued", "running", "waiting"].includes(task.status));
    expect(state().status).toBe("done");
  });
});

// ---- 3. concurrent edits ---------------------------------------------------------------------

describe("two copies of a page", () => {
  const first = savePageByPerson(undefined, { kind: "procedure" as never, title: "Nginx change procedure", when: "Before changing nginx", body: "Run nginx -t first." }, "Sara", 1000);

  it("keeps the text that lost in the page's history, the same on both installations", () => {
    const sara = savePageByPerson(first, { kind: first.kind, title: first.title, when: first.when, body: "Run nginx -t first. Reload, never restart." }, "Sara", 2000);
    const erik = savePageByPerson(first, { kind: first.kind, title: first.title, when: first.when, body: "Run nginx -t first. Tell the on-call before." }, "Erik", 2500);
    const onSara = mergePageCopies(sara, erik);
    const onErik = mergePageCopies(erik, sara);
    expect(onErik).toEqual(onSara);
    // The newer change is the page.
    expect(onSara.body).toBe(erik.body);
    expect(onSara.updatedAt).toBeGreaterThan(erik.updatedAt);
    expect(onSara.revision).toBeGreaterThan(erik.revision);
    // Sara's text is not gone: it is in the history, named as hers, with what it said.
    const kept = onSara.history.find((h) => h.by === "Sara" && h.at === 2000)!;
    expect(kept.summary).toMatch(/Not in the page: changed at the same time as the newer change by Erik/);
    expect(kept.previous!.body).toBe(sara.body);
    // The newest change stays first, so that undoing takes back what the page shows.
    expect(onSara.history[0]).toMatchObject({ by: "Erik", at: 2500 });
    // Settled: neither copy changes it again, and it travels as one newer copy.
    expect(mergePageCopies(onSara, sara)).toBe(onSara);
    expect(mergePageCopies(onSara, erik)).toBe(onSara);
    expect(mergePageCopies(sara, onSara)).toBe(onSara);
    const merged = mergeItems([sara], [erik], mergePageCopies);
    expect(merged.changed).toBe(true);
    expect(merged.newerLocally).toHaveLength(1);
  });

  it("replaces a copy the newer one was made from, without a note", () => {
    const next = savePageByPerson(first, { kind: first.kind, title: first.title, when: first.when, body: "Run nginx -t first. Then reload." }, "Erik", 3000);
    expect(mergePageCopies(first, next)).toBe(next);
    expect(mergePageCopies(next, first)).toBe(next);
    // A removal is taken as it is.
    const removed = { id: first.id, updatedAt: 9000, deleted: true } as unknown as KbPage & { deleted: boolean };
    expect(mergePageCopies(next as KbPage & { deleted?: boolean }, removed)).toBe(removed);
  });
});

describe("two copies of a shared memory", () => {
  const memory = (extra: Partial<MemoryEntry>): MemoryEntry =>
    ({ id: "m1", kind: "memory", scope: "workspace", title: "nginx change rule", text: "Always nginx -t before reload.", updatedAt: 100, ...extra }) as MemoryEntry;
  const payload = (memories: MemoryEntry[]): S3WorkspaceRemotePayload => ({ version: 1, updatedAt: 1, servers: [], memories, activityLog: [], deletedServerIds: {}, deletedMemoryIds: {} });

  it("keeps both votes when two people voted at about the same time", () => {
    const sara = memory({ votes: { "Sara Nyberg": 1 }, feedbackScore: 1, updatedAt: 200 });
    const erik = memory({ votes: { "Erik Holm": -1 }, feedbackScore: -1, updatedAt: 201 });
    for (const [local, remote] of [[sara, erik], [erik, sara]]) {
      const { merged, changed } = mergeS3WorkspacePayload(payload([local]), payload([remote]));
      expect(merged.memories[0].votes).toEqual({ "Sara Nyberg": 1, "Erik Holm": -1 });
      expect(merged.memories[0].feedbackScore).toBe(0);
      // Written back and applied, whichever side was the newer one.
      expect(changed).toBe(true);
    }
    expect(mergeMemoryCopies(sara, erik).votes).toEqual({ "Sara Nyberg": 1, "Erik Holm": -1 });
    expect(mergeMemoryCopies(erik, sara)).toMatchObject({ updatedAt: 201, feedbackScore: 0 });
    // One person's newer vote replaces their older one.
    expect(mergeMemoryCopies(memory({ votes: { Sara: 1 }, updatedAt: 200 }), memory({ votes: { Sara: -1 }, updatedAt: 300 })).votes).toEqual({ Sara: -1 });
    // Both in step: nothing to do.
    const same = memory({ votes: { Sara: 1 }, updatedAt: 200 });
    expect(mergeS3WorkspacePayload(payload([same]), payload([{ ...same }])).changed).toBe(false);
  });

  it("brings a replaced memory back for teammates when the update that replaced it is undone", () => {
    const hidden = memory({ supersededBy: "m2", supersededAt: 150, updatedAt: 150 });
    // On the installation that undid it, "replaced by" was removed and the memory stamped newer.
    const restored = memory({ updatedAt: 300 });
    const { merged, changed } = mergeS3WorkspacePayload(payload([hidden]), payload([restored]));
    expect(changed).toBe(true);
    expect(merged.memories[0].supersededBy).toBeUndefined();
    expect(merged.memories[0].supersededAt).toBeUndefined();
    expect(mergeMemoryCopies(hidden, restored).supersededBy).toBeUndefined();
    // The other way round (an older copy without it arrives): the newer one's mark stays.
    expect(mergeMemoryCopies(hidden, memory({ updatedAt: 120 })).supersededBy).toBe("m2");
  });
});

// ---- 4. shared servers ------------------------------------------------------------------------

describe("a shared server that arrives from the team", () => {
  it("keeps the time it was changed, so that an unchanged server is not sent back and forth", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-profiles-"));
    disposals.push(() => fs.rm(dir, { recursive: true, force: true }));
    const store = new ProfileStore(path.join(dir, "profiles.json"));
    const changedAt = "2026-11-01T10:00:00.000Z";
    const server = { id: "s1", name: "db-01", host: "10.0.0.5", port: 22, username: "ops", authType: "agent" as const, updatedAt: changedAt };
    await store.saveSSH(server, { keepUpdatedAt: true });
    expect((await store.getProfiles()).ssh[0].updatedAt).toBe(changedAt);
    // A person's own save is a change, and is stamped now.
    await store.saveSSH(server);
    expect(Date.parse((await store.getProfiles()).ssh[0].updatedAt!)).toBeGreaterThan(Date.parse(changedAt));
    // A time that cannot be read is not kept.
    await store.saveSSH({ ...server, updatedAt: "yesterday" }, { keepUpdatedAt: true });
    expect(Number.isFinite(Date.parse((await store.getProfiles()).ssh[0].updatedAt!))).toBe(true);
  });

  it("is saved with the team's time and name, described field by field, and signed by who changed it", async () => {
    const { createHub } = await import("../../src/main/ai/hub/createHub");
    const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
    setDemoModeForTesting(false);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-createhub-"));
    const profileStore = new ProfileStore(path.join(dir, "profiles.json"));
    const bridge = {
      profileStore,
      teamVaultService: { listVaultIds: async () => [], isUnlocked: () => false },
      scheduleAutoSync: () => {},
    };
    const hub = createHub(bridge as never, { backgroundChanged: async () => {}, show: () => {} }, { hubDirectory: dir, aiConfigFilePath: path.join(dir, "ai.json"), s3ConfigFilePath: path.join(dir, "s3.json") });
    disposals.push(async () => {
      await hub.dispose();
      setDemoModeForTesting(undefined);
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });
    const host = (hub as unknown as { host: Record<string, (...args: never[]) => Promise<unknown>> }).host as never as {
      syncSharedServersFromS3: (servers: WorkspaceServerSummary[], deleted: Record<string, string>) => Promise<void>;
      describeServer: (input: Record<string, unknown>) => Promise<void>;
      upsertServer: (input: Record<string, unknown>) => Promise<WorkspaceServerSummary>;
    };
    const only = async () => (await profileStore.getProfiles()).ssh.find((p) => p.id === "s1")!;

    const changedAt = "2026-11-01T10:00:00.000Z";
    const remote = { id: "s1", name: "db-01", host: "10.0.0.5", port: 22, username: "ops", shared: true, description: "Primary database", role: "postgres", tags: ["prod"], updatedAt: changedAt, updatedBy: "Sara Nyberg" } as WorkspaceServerSummary;
    await host.syncSharedServersFromS3([remote], {});
    expect(await only()).toMatchObject({ updatedAt: changedAt, updatedBy: "Sara Nyberg" });
    // The same copy again is not newer than itself: nothing is written, and nothing would be pushed back.
    await host.syncSharedServersFromS3([remote], {});
    expect((await only()).updatedAt).toBe(changedAt);

    // Describing it by its tags leaves its description and role alone, and names who did it.
    await host.describeServer({ profileId: "s1", shared: true, tags: ["db", "prod"], updatedBy: "Erik Holm" });
    expect(await only()).toMatchObject({ description: "Primary database", role: "postgres", tags: ["db", "prod"], updatedBy: "Erik Holm" });
    // An empty text still clears a field: that is what was sent.
    await host.describeServer({ profileId: "s1", description: "", updatedBy: "Erik Holm" });
    expect((await only()).description).toBeUndefined();
    expect(await only()).toMatchObject({ role: "postgres", tags: ["db", "prod"] });

    // Saved by somebody else: theirs is the name on it, not the one before.
    await host.upsertServer({ id: "s1", name: "db-01", host: "10.0.0.5", username: "ops", shared: true, updatedBy: "Anna Lind" });
    expect((await only()).updatedBy).toBe("Anna Lind");
  });
});

// ---- 5. saved differently from what was asked: said in the reply ---------------------------------

describe("a request that is saved differently from what was asked", () => {
  it("does not make a second team of the same names when a template is applied twice", async () => {
    const { hub } = await makeHub();
    let snap = await hub.request({ action: "workforce-template-apply", templateId: "operate-system" });
    expect(snap.reply?.notes).toBeUndefined();
    const team = (snap.agents ?? []).filter((a) => a.id.startsWith("wf-operate-system-"));
    expect(team).toHaveLength(5);
    await hub.request({ action: "agent-delete", id: team.find((a) => a.name === "Reviewer")!.id });

    snap = await hub.request({ action: "workforce-template-apply", templateId: "operate-system", goalTitle: "Keep the lab healthy" });
    const names = (snap.agents ?? []).map((a) => a.name);
    // The four that were there are used as they are; the one that was missing is made, under the same lead.
    for (const name of ["Operations lead", "Watch", "Investigator", "Operator", "Reviewer"]) expect(names.filter((n) => n === name)).toHaveLength(1);
    const lead = snap.agents!.find((a) => a.name === "Operations lead")!;
    expect(lead.id).toBe(team.find((a) => a.name === "Operations lead")!.id);
    expect(snap.agents!.find((a) => a.name === "Reviewer")!.reportsTo).toBe(lead.id);
    expect(snap.reply!.notes![0]).toMatch(/Operations lead, Watch, Investigator, Operator already existed and were kept as they are/);
    // The second goal's tickets go to the agents that exist.
    const goal = snap.workGoals!.find((g) => g.title === "Keep the lab healthy")!;
    const tickets = snap.workTickets!.filter((t) => t.goalId === goal.id);
    expect(tickets).toHaveLength(2);
    expect(tickets.every((t) => snap.agents!.some((a) => a.id === t.assigneeAgentId))).toBe(true);
  });

  it("says when a reporting line, an alert rule, a runner's id or a ticket's links were not saved as sent", async () => {
    const { hub } = await makeHub();
    const save = (agent: Record<string, unknown>) => hub.request({ action: "agent-save", agent: { role: "r", mission: "m", systemPrompt: "", defaultMode: "advice", ...agent } } as never);
    await save({ id: "lead", name: "Lead" });
    let snap = await save({ id: "mid", name: "Mid", reportsTo: "lead" });
    expect(snap.reply?.notes).toBeUndefined();
    expect(snap.agents!.find((a) => a.id === "mid")!.reportsTo).toBe("lead");
    // Lead reporting to Mid would close a circle.
    snap = await save({ id: "lead", name: "Lead", reportsTo: "mid" });
    expect(snap.agents!.find((a) => a.id === "lead")!.reportsTo).toBeUndefined();
    expect(snap.reply!.notes![0]).toMatch(/Mid already reports to this agent.*would close a circle/);
    snap = await save({ id: "mid", name: "Mid", reportsTo: "nobody" });
    expect(snap.reply!.notes![0]).toMatch(/does not exist/);
    snap = await save({ id: "mid", name: "Mid", reportsTo: "mid" });
    expect(snap.reply!.notes![0]).toMatch(/cannot report to itself/);

    snap = await hub.request({ action: "alert-rules-save", rules: [{ match: "db-01", agentId: "lead" }, { match: "web-01", agentId: "gone" }, { match: " ", agentId: "lead" }] });
    expect(snap.alertIntake!.rules).toEqual([{ match: "db-01", agentId: "lead" }]);
    expect(snap.reply!.notes).toEqual(['Not saved, because the agent does not exist: "web-01".', "1 rule with no text to match was left out."]);
    expect((await hub.request({ action: "alert-rules-save", rules: [{ match: "db-01", agentId: "lead" }] })).reply?.notes).toBeUndefined();

    snap = await hub.request({ action: "runner-save", runner: { id: "Eval Fake!", name: "Fake", command: "node" } } as never);
    expect(hub.store.data.externalRunners!.map((r) => r.id)).toEqual(["eval-fake-"]);
    expect(snap.reply!.notes![0]).toMatch(/The id was saved as "eval-fake-"/);
    expect((await hub.request({ action: "runner-save", runner: { id: "claude-code", name: "Claude Code", command: "claude" } } as never)).reply?.notes).toBeUndefined();

    snap = await hub.request({ action: "ticket-save", ticket: { title: "Check the logs", goalId: "no-such-goal", blockedBy: ["t-missing"], status: "in_progress" } } as never);
    expect(snap.reply!.notes).toEqual([
      "The status was not changed: a ticket is in progress while an agent runs it. Start it instead.",
      "The goal does not exist, so the ticket was saved without one.",
      'Left out of "waits for", because it is not on the board: t-missing.',
    ]);
    expect((await hub.request({ action: "ticket-save", ticket: { title: "Plain" } } as never)).reply?.notes).toBeUndefined();
  });
});

// ---- 6. test cases ---------------------------------------------------------------------------------

describe("test cases", () => {
  const finished = (extra: Partial<AgentTask> = {}): AgentTask =>
    ({
      id: "t1",
      title: "Backup runs long",
      mode: "assisted",
      status: "completed",
      agentId: "operator",
      messages: [
        { id: "m1", role: "user", text: "Why is /var full on db-01?", at: 1 },
        { id: "m2", role: "assistant", text: "The retention job has a typo.", at: 2 },
      ],
      changes: [],
      sources: [],
      toolLog: [],
      ...extra,
    }) as unknown as AgentTask;

  it("keep the expectations that were not sent when one is edited", async () => {
    const { hub } = await makeHub();
    hub.store.data.tasks.push(finished());
    let snap = await hub.request({ action: "eval-case-save", fromTaskId: "t1", expect: { mention: ["delte"], notMention: ["restart"], mustNotRun: ["rm -rf"], conclusion: "A typo in the retention job." } });
    const id = snap.evalCases![0].id;
    snap = await hub.request({ action: "eval-case-save", id, expect: { mention: ["delte", "retention"] } } as never);
    expect(snap.evalCases![0].expect).toEqual({ mention: ["delte", "retention"], notMention: ["restart"], mustCall: [], mustNotRun: ["rm -rf"], conclusion: "A typo in the retention job." });
    // What is sent empty is cleared: that is what was asked.
    snap = await hub.request({ action: "eval-case-save", id, expect: { notMention: [], conclusion: "" } } as never);
    expect(snap.evalCases![0].expect).toMatchObject({ mention: ["delte", "retention"], notMention: [], mustNotRun: ["rm -rf"], conclusion: undefined });
  });

  it("record a run that could not take place as that, not as a failed test", () => {
    const outage = evalRun({ task: { status: "failed", error: 'Codex API (400): {"detail":"Unsupported parameter"}', messages: [{ id: "m", role: "user", text: "q", at: 1 }] } as never, checks: [{ name: "mentions “delte”", passed: false }], unrecorded: 0, now: 5 });
    expect(outage).toMatchObject({ passed: false, checks: [], answer: "" });
    expect(outage.inconclusive).toContain("Codex API (400)");
    const ran = (passed: boolean) => evalRun({ task: { status: "completed", messages: [{ id: "m", role: "assistant", text: "x", at: 1 }] } as never, checks: [{ name: "c", passed }], unrecorded: 0, now: 1 });
    expect(ran(true).inconclusive).toBeUndefined();
    // An outage is neither a regression nor a pass: the comparison is between the runs that took place.
    const cases = [
      { title: "was fine, then the model was down", runs: [outage, ran(true)] },
      { title: "really broke", runs: [ran(false), ran(true)] },
      { title: "only ever an outage", runs: [outage] },
    ] as Pick<EvalCase, "title" | "runs">[];
    expect(compareRuns(cases)).toEqual({ passing: 1, total: 2, better: [], worse: ["really broke"] });
  });

  it("replay the agent that answered, not the one the conversation was handed to afterwards", async () => {
    const { hub } = await makeHub();
    const save = (agent: Record<string, unknown>) => hub.request({ action: "agent-save", agent: { role: "r", mission: "m", systemPrompt: "", ...agent } } as never);
    await save({ id: "operator", name: "Operator", defaultMode: "assisted" });
    await save({ id: "reviewer", name: "Reviewer", defaultMode: "advice" });
    hub.store.data.tasks.push(finished({ agentName: "Operator" }));
    await hub.request({ action: "agent-handoff", taskId: "t1", toAgentId: "reviewer" });
    const task = hub.store.data.tasks.find((t) => t.id === "t1")!;
    expect(task).toMatchObject({ agentId: "reviewer", mode: "advice", startedAs: { agentId: "operator", mode: "assisted" } });
    expect(caseFromTask(task, {}, "anna")).toMatchObject({ agentId: "operator", mode: "assisted" });
    // Handed on a second time: still the agent that began.
    await hub.request({ action: "agent-handoff", taskId: "t1", toAgentId: "operator" });
    expect(task.startedAs).toEqual({ agentId: "operator", mode: "assisted" });
    // A conversation that was never handed over is its own agent's.
    expect(caseFromTask(finished(), {}, "anna")).toMatchObject({ agentId: "operator", mode: "assisted" });
  });

  it("are replayed without what is known only now: later activity, the servers' present state, open terminals", async () => {
    const { hub, inner } = await makeHub();
    hub.store.data.tasks.push(finished());
    const snap = await hub.request({ action: "eval-case-save", fromTaskId: "t1" });
    const made = hub.store.data.evalCases!.find((c) => c.id === snap.evalCases![0].id)!;
    made.createdAt = 5000;
    hub.store.data.activityLog = [
      { id: "a1", at: 4000, actor: "Anna", targetLabel: "db-01", kind: "note", summary: "db-01 /var is at 99 %" },
      { id: "a2", at: 9000, actor: "Anna", targetLabel: "db-01", kind: "note", summary: "Fixed: /var is at 66 %" },
    ] as never;
    const extra = { ...(await inner.collectExtraContext()), recentServerChanges: [{ name: "db-01", lines: ["x"] }], serverFactsNow: [{ name: "db-01", collectedAt: 9000, age: "now", lines: ["Disk /var 66 %"] }] };
    const replay = running("replay", { evalCaseId: made.id } as never);
    const given = inner.asOfEvalCase(replay, extra);
    expect(given).toMatchObject({ asOf: 5000, recentServerChanges: [], serverFactsNow: [] });
    const context = inner.context.read(replay, "", undefined, given);
    expect((context.recentTeamActivity as { id: string }[]).map((a) => a.id)).toEqual(["a1"]);
    expect(context.terminals).toEqual([]);
    // An ordinary run is given everything, as before.
    const ordinary = running("chat");
    expect(inner.asOfEvalCase(ordinary, extra)).toBe(extra);
    expect((inner.context.read(ordinary, "", undefined, extra).recentTeamActivity as unknown[]).length).toBe(2);
  });
});

// ---- 7. links nobody confirmed, and whose agent wrote on the board ---------------------------------

describe("what an agent leaves behind", () => {
  it("saves a link found in command output as a proposal, not as a confirmed link", () => {
    const learning = new SelfLearningService(new KnowledgeBaseService());
    const found = learning.discoverTopologyEdges({
      targetLabel: "netapp-aff-01",
      command: "snapmirror show",
      output: "svm_prod:vol_db   XDP  svm_dr:vol_db_dr   Snapmirrored  Idle",
      existingEdges: [],
      servers: [],
    });
    expect(found.added).toBe(1);
    expect(found.edges[0]).toMatchObject({ from: "svm_prod", to: "svm_dr", relation: "replicates_to", proposed: true, proposedBy: "Command output" });
  });

  it("signs a ticket and a comment with the agent and the person it ran for", async () => {
    const { hub, inner } = await makeHub({ defaultActorName: "Sara Nyberg" });
    const { handleAppAction } = await import("../../src/main/ai/hub/AppActions");
    const task = { id: "chat1", agentName: undefined, mode: "assisted", status: "running", changes: [], messages: [], sources: [] } as unknown as AgentTask;
    const call = (payload: Record<string, unknown>) =>
      handleAppAction(inner.appActionHost(), task, { action: "sshs3_tickets", payload } as never, async () => undefined) as Promise<{ ticket: { id: string } }>;
    const made = await call({ operation: "create", title: "db-01: correct statement logging" });
    await call({ operation: "comment", id: made.ticket.id, text: "Reload, not restart." });
    const saved = hub.store.data.workTickets!.find((t) => t.id === made.ticket.id)!;
    expect(saved.createdBy).toBe("Assistant (agent, for Sara Nyberg)");
    expect(saved.comments!.at(-1)!.author).toBe("Assistant (agent, for Sara Nyberg)");
  });
});

// ---- 8. configure, the workforce line, a resolved alert --------------------------------------------

describe("the rest", () => {
  it("changes nothing when configure is refused, and takes preferences without AI settings", async () => {
    const { hub } = await makeHub();
    const before = (await hub.snapshot()).preferences;
    expect(before.autoStart).toBeFalsy();
    await expect(
      hub.request({ action: "configure", config: { enabled: true, provider: "anthropic", model: "claude-opus-5-5", apiKey: "sk-ant-test" }, preferences: { autoStart: true, background: false, retentionDays: 31 } } as never), // pragma: allowlist secret
    ).rejects.toThrow("Autostart requires background mode");
    let snap = await hub.snapshot();
    expect(snap.preferences).toEqual(before);
    // The AI settings sent with it were not applied either.
    expect(snap.config.enabled).toBeFalsy();
    await expect(hub.request({ action: "configure", preferences: { retentionDays: 9999 } } as never)).rejects.toThrow();
    expect((await hub.snapshot()).preferences).toEqual(before);

    snap = await hub.request({ action: "configure", preferences: { autoSaveMemories: false, retentionDays: 31 } } as never);
    expect(snap.preferences).toMatchObject({ autoSaveMemories: false, retentionDays: 31 });
  });

  it("does not call a failed specialist finished", async () => {
    const { renderWorkforceProgress } = await import("../../src/main/ai/hub/HubService");
    const run = (steps: Array<{ status: string; error?: string }>): WorkforceRun =>
      ({ id: "wf", status: "running", steps: steps.map((s, i) => ({ agentId: `a${i}`, agentName: `Agent ${i}`, ...s })) }) as unknown as WorkforceRun;
    expect(renderWorkforceProgress(run([{ status: "failed", error: "Codex API (400)" }]))).toContain("0/1 specialists finished, 1 failed");
    expect(renderWorkforceProgress(run([{ status: "completed" }, { status: "failed" }, { status: "running" }]))).toContain("1/3 specialists finished, 1 failed");
    expect(renderWorkforceProgress(run([{ status: "completed" }, { status: "completed" }]))).toMatch(/2\/2 specialists finished$/m);
  });

  it("takes an alert that resolved before anybody started on it out of the heartbeat's way, and back when it fires again", async () => {
    const { hub } = await makeHub();
    await hub.request({ action: "agent-save", agent: { id: "operator", name: "Operator", role: "r", mission: "m", systemPrompt: "", defaultMode: "advice" } } as never);
    await hub.request({ action: "alert-rules-save", rules: [{ match: "db-01", agentId: "operator" }] });
    const alert = (status: string, startsAt: string) =>
      JSON.stringify({ receiver: "sshs3", status, alerts: [{ status, fingerprint: "f1", startsAt, labels: { alertname: "DiskFull", severity: "critical", instance: "db-01:9100" }, annotations: { summary: "db-01 /var 99% full" } }] });
    const created = await hub.request({ action: "alert-paste", text: alert("firing", "2026-11-14T09:00:00Z") });
    const id = created.reply!.alerts!.created[0];
    const state = () => hub.store.data.workTickets!.find((t) => t.id === id)!;
    expect(state()).toMatchObject({ status: "todo", assigneeName: "Operator" });

    await hub.request({ action: "alert-paste", text: alert("resolved", "2026-11-14T09:00:00Z") });
    expect(state().status).toBe("backlog");
    expect(state().comments!.at(-1)!.text).toMatch(/says this has resolved\. Moved to Backlog: nothing is firing/);
    // Fires again: it is work again.
    await hub.request({ action: "alert-paste", text: alert("firing", "2026-11-14T11:00:00Z") });
    expect(state().status).toBe("todo");
    expect(state().alert!.parked).toBeUndefined();

    // One that a person already took somewhere else is left where it is.
    await hub.request({ action: "ticket-move", id, status: "review" });
    await hub.request({ action: "alert-paste", text: alert("resolved", "2026-11-14T11:00:00Z") });
    expect(state().status).toBe("review");
  });
});
