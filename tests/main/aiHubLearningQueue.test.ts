import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CLAIM_TTL_MS,
  LearningQueue,
  recordName,
  type LearningRecord,
  type QueueStore,
} from "../../src/main/ai/hub/LearningQueue";
import type { FileEntry, IStorageProvider } from "../../src/shared/types/storage";
import type { MemoryEntry, WorkspaceActivityEvent } from "../../src/shared/types/aiHub";
import {
  ACTIVITY_GRACE_MS,
  ACTIVITY_SLOT_MS,
  firstActivityCursor,
  nextActivityBatch,
} from "../../src/main/ai/hub/ActivityBatcher";

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function memoryStore(): QueueStore & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    list: async (dir) =>
      [...objects.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1)),
    read: async (p) => objects.get(p),
    write: async (p, content) => void objects.set(p, content),
    remove: async (p) => void objects.delete(p),
  };
}

const record = (id: string, createdAt: number, extra: Partial<LearningRecord> = {}): LearningRecord => ({
  v: 1,
  id,
  title: `Session ${id}`,
  transcript: `User: about ${id}`,
  query: id,
  actor: "erik",
  createdAt,
  attempts: 0,
  ...extra,
});

describe("LearningQueue", () => {
  it("hands out the oldest record, and a record somebody is reading is skipped until that claim is stale", async () => {
    const store = memoryStore();
    const queue = new LearningQueue(store);
    await queue.enqueue(record("task:b", 2000));
    await queue.enqueue(record("task:a", 1000));
    expect(await queue.pendingCount()).toBe(2);

    const now = 10_000;
    const first = await queue.claimNext("sara", now);
    expect(first!.record.id).toBe("task:a");
    // Another app gets the next one, not the one Sara is reading.
    expect((await queue.claimNext("jacob", now + 1))!.record.id).toBe("task:b");
    expect(await queue.claimNext("mia", now + 2)).toBeUndefined();
    // Sara's computer went away: after the claim's lifetime the record is free again.
    expect((await queue.claimNext("mia", now + CLAIM_TTL_MS + 1))!.record.id).toBe("task:a");
  });

  it("removes a record once it has been read", async () => {
    const store = memoryStore();
    const queue = new LearningQueue(store);
    await queue.enqueue(record("task:a", 1000));
    const claimed = (await queue.claimNext("sara", 5000))!;
    await queue.complete(claimed.name);
    expect(store.objects.size).toBe(0);
    expect(await queue.claimNext("jacob", 6000)).toBeUndefined();
  });

  it("puts a record back when its reader fails, and drops it after three failures", async () => {
    const store = memoryStore();
    const queue = new LearningQueue(store);
    await queue.enqueue(record("task:a", 1000));
    for (const [reader, stillQueued] of [["sara", true], ["jacob", true], ["mia", false]] as const) {
      const claimed = (await queue.claimNext(reader, 5000))!;
      expect(claimed.record.id).toBe("task:a");
      expect(await queue.release(claimed)).toBe(stillQueued);
    }
    expect(store.objects.size).toBe(0);
  });

  it("uploading the same source twice leaves one record", async () => {
    const store = memoryStore();
    const queue = new LearningQueue(store);
    const r = record("task:a", 1000);
    expect(await queue.enqueue(r)).toBe(await queue.enqueue(r));
    expect(await queue.pendingCount()).toBe(1);
    expect(recordName(r)).toMatch(/^000000000001000-[0-9a-f]{16}\.json$/);
  });

  it("lets only the reader whose claim is the one in the bucket proceed", async () => {
    // Jacob's claim lands between Sara's write and her look back at it.
    const store = memoryStore();
    const queue = new LearningQueue(store);
    await queue.enqueue(record("task:a", 1000));
    const write = store.write;
    store.write = async (p, content) => {
      await write(p, content);
      if (p.startsWith("learn/claims/") && content.toString().includes('"sara"'))
        await write(p, Buffer.from(JSON.stringify({ reader: "jacob", at: 5000 })));
    };
    expect(await queue.claimNext("sara", 5000)).toBeUndefined();
  });

  it("clears out a record it cannot parse instead of stopping at it", async () => {
    const store = memoryStore();
    const queue = new LearningQueue(store);
    store.objects.set("learn/pending/000000000000500-bad.json", Buffer.from("{not json"));
    await queue.enqueue(record("task:a", 1000));
    expect((await queue.claimNext("sara", 5000))!.record.id).toBe("task:a");
    expect([...store.objects.keys()].some((k) => k.includes("-bad.json"))).toBe(false);
  });
});

/** A bucket shared by every hub of a test: only what the sync service calls. */
function bucketProvider(objects: Map<string, Buffer>): IStorageProvider {
  const norm = (p: string): string => p.replace(/^\/+|\/+$/g, "");
  const missing = (key: string): Error => Object.assign(new Error(`NoSuchKey: ${key}`), { code: "NoSuchKey" });
  return {
    id: "mem-s3",
    name: "bucket",
    type: "s3",
    connect: async () => {},
    disconnect: async () => {},
    createFolder: async () => {},
    list: async (dir: string): Promise<FileEntry[]> => {
      const prefix = `${norm(dir)}/`;
      return [...objects.entries()]
        .filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
        .map(([k, v]) => ({ name: k.slice(prefix.length), path: k, isDirectory: false, size: v.length, mtime: "2026-01-01T00:00:00Z" }));
    },
    stat: async (p: string): Promise<FileEntry> => {
      const v = objects.get(norm(p));
      if (!v) throw missing(p);
      return { name: path.basename(p), path: norm(p), isDirectory: false, size: v.length, mtime: `${v.length}` };
    },
    readFile: async (p: string) => {
      const v = objects.get(norm(p));
      if (!v) throw missing(p);
      return v;
    },
    writeFile: async (p: string, content: Buffer) => void objects.set(norm(p), Buffer.from(content)),
    delete: async (p: string) => void objects.delete(norm(p)),
  } as unknown as IStorageProvider;
}

function sseResponse(text: string): Response {
  const sse = [
    `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}`,
    'data: {"type":"message_delta","usage":{"output_tokens":3}}',
    "",
  ].join("\n\n");
  return new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(sse));
        c.close();
      },
    }),
    { status: 200 },
  );
}

async function makeHub(name: string, bucket: Map<string, Buffer>, saved: MemoryEntry[] = []) {
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(false);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `sshs3-queue-${name}-`));
  const hub = new HubService(
    {
      changed: () => {},
      inventoryTargets: async () => [],
      backgroundChanged: async () => {},
      openSchedule: async () => "s1",
      show: () => {},
      aiConfigFilePath: path.join(dir, "ai-config.json"),
      defaultActorName: name,
      s3ProviderFactory: () => bucketProvider(bucket),
      saveWorkspaceMemory: async (entry: MemoryEntry) => void saved.push(entry),
    },
    dir,
  );
  disposals.push(async () => {
    await hub.dispose();
    setDemoModeForTesting(undefined);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await hub.initialize();
  await hub.request({
    action: "configure",
    config: { enabled: true, provider: "anthropic", model: "claude-test", apiKey: "sk-ant-test", actorName: name }, // pragma: allowlist secret
  });
  await hub.request({
    action: "workspace-s3-configure",
    config: { enabled: true, region: "eu-north-1", bucket: "team", prefix: "ws", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "x" }, // pragma: allowlist secret
  });
  return hub;
}

type Internals = {
  readLearningQueue(now?: number): Promise<void>;
  recoverUnreadSessions(now?: number): Promise<void>;
  queueTeamActivity(now?: number): Promise<void>;
};
const internals = (hub: unknown): Internals => hub as Internals;
const pending = (bucket: Map<string, Buffer>): string[] => [...bucket.keys()].filter((k) => k.startsWith("team/ws/learn/pending/"));

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("learning through the team bucket", () => {
  it("uploads a finished session at once without reading it, and a teammate's app reads it: what a conversation alone gave waits for a person", async () => {
    const bucket = new Map<string, Buffer>();
    const erik = await makeHub("erik", bucket);
    const saraSaved: MemoryEntry[] = [];
    const sara = await makeHub("sara", bucket, saraSaved);

    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const first = JSON.stringify((JSON.parse(String(init?.body)) as { messages: unknown[] }).messages[0]);
        if (first.includes("long-term memory")) {
          calls.push("learn");
          return sseResponse(
            JSON.stringify({ proposals: [{ op: "add", scope: "cluster:prod", title: "Drain before reboot", text: "Drain a prod node before rebooting it.", evidence: "Drained and rebooted" }] }),
          );
        }
        calls.push("session");
        return sseResponse(`Drained and rebooted node 3. ${"Details. ".repeat(80)}`);
      }),
    );

    // Erik finishes a session; his app only uploads the record (he may close the lid now).
    await erik.request({ action: "start", task: { prompt: "Reboot node 3 safely", mode: "advice" } });
    await waitFor(() => pending(bucket).length === 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual(["session"]);
    expect(erik.store.data.memories).toHaveLength(0);
    const queued = JSON.parse(bucket.get(pending(bucket)[0])!.toString()) as { actor: string; title: string; transcript: string };
    expect(queued).toMatchObject({ actor: "erik", title: "Session: Reboot node 3 safely" });
    expect(queued.transcript).toContain("Reboot node 3 safely");

    // Sara's app is running: it reads the record with its own model. Nothing was run in that session,
    // so what the model drew from the assistant's answer is a proposal, not a memory.
    await internals(sara).readLearningQueue(Date.now() + 60_000);
    expect(calls).toEqual(["session", "learn"]);
    expect(sara.store.data.memories).toHaveLength(0);
    expect(saraSaved).toHaveLength(0);
    expect(sara.store.data.memoryProposals![0].sourceTitle).toBe("Session: Reboot node 3 safely (erik)");
    expect(sara.store.data.memoryProposals![0].appliedMemoryId).toBeUndefined();
    // A person accepts it: now it is the team's.
    await sara.request({ action: "memory-proposal-accept", id: sara.store.data.memoryProposals![0].id });
    expect(sara.store.data.memories.map((m) => m.title)).toEqual(["Drain before reboot"]);
    expect(saraSaved).toHaveLength(1);
    // Read once: the record is gone, so Erik's app does not read it again.
    expect(pending(bucket)).toHaveLength(0);
    await internals(erik).readLearningQueue(Date.now() + 120_000);
    expect(calls).toEqual(["session", "learn"]);
  });

  it("leaves the record for another app when the reader's model fails", async () => {
    const bucket = new Map<string, Buffer>();
    const erik = await makeHub("erik", bucket);
    const sara = await makeHub("sara", bucket);
    await new LearningQueue(erik.s3Workspace.objects).enqueue(record("task:x", Date.now()));

    // A 529 is retried a few times first; do not wait out the real delays here.
    const { retryPolicy } = await import("../../src/main/ai/hub/DirectAgentRuntime");
    const realDelay = retryPolicy.baseDelayMs;
    retryPolicy.baseDelayMs = 1;
    disposals.push(() => void (retryPolicy.baseDelayMs = realDelay));
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":"overloaded"}', { status: 529 })));
    await internals(sara).readLearningQueue(Date.now() + 60_000);
    expect(pending(bucket)).toHaveLength(1);
    expect(JSON.parse(bucket.get(pending(bucket)[0])!.toString()).attempts).toBe(1);
    expect([...bucket.keys()].some((k) => k.includes("/learn/claims/"))).toBe(false);

    vi.stubGlobal("fetch", vi.fn(async () => sseResponse('{"proposals":[]}')));
    await internals(erik).readLearningQueue(Date.now() + 120_000);
    expect(pending(bucket)).toHaveLength(0);
  });

  it("uploads, at the next start, a finished session the app never got to hand over", async () => {
    const bucket = new Map<string, Buffer>();
    const erik = await makeHub("erik", bucket);
    const now = Date.now();
    erik.store.data.tasks.push({
      id: "t-old",
      title: "Fix the SSE timeout",
      mode: "assisted",
      status: "completed",
      messages: [{ id: "u", role: "user", text: "SSE drops after 60s", at: now - 5000 }],
      changes: [{ id: "c", kind: "command", target: "prod-api", description: "", command: "nginx -t", status: "completed", exitCode: 0, at: now - 4000 }],
      sources: [],
      createdAt: now - 5000,
      updatedAt: now - 4000,
      maxCommands: 5,
      maxMinutes: 5,
      verification: "not-verified",
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await internals(erik).recoverUnreadSessions(now);
    expect(pending(bucket)).toHaveLength(1);
    expect(JSON.parse(bucket.get(pending(bucket)[0])!.toString()).id).toBe("task:t-old");
    expect(fetchSpy).not.toHaveBeenCalled();
    // Handing over is once per source: a second start does not upload it again.
    bucket.clear();
    (erik as unknown as { recoveredSessions: boolean }).recoveredSessions = false;
    await internals(erik).recoverUnreadSessions(now);
    expect(pending(bucket)).toHaveLength(0);
  });
});

const HOUR = ACTIVITY_SLOT_MS;
const T0 = 500_000 * HOUR; // an hour boundary
const change = (id: string, at: number, actor = "erik"): WorkspaceActivityEvent => ({
  id,
  actor,
  kind: "config-edit",
  targetLabel: "prod-db",
  summary: `change ${id}`,
  at,
});
const changes = (n: number, from: number, actor = "erik"): WorkspaceActivityEvent[] =>
  Array.from({ length: n }, (_, i) => change(`${actor}-${from}-${String(i).padStart(3, "0")}`, from + i * 1000, actor));

describe("nextActivityBatch", () => {
  it("cuts everything since the cursor up to the last hour boundary that is past the grace time", () => {
    const log = [...changes(8, T0 + 60_000), change("late", T0 + HOUR + 5 * 60_000)];
    // 20 minutes past the boundary: teammates' changes may still be syncing in.
    expect(nextActivityBatch(log, T0, T0 + HOUR + 20 * 60_000)).toBeUndefined();
    const batch = nextActivityBatch(log, T0, T0 + HOUR + ACTIVITY_GRACE_MS + 1)!;
    expect(batch).toMatchObject({ id: `activity:${T0}-${T0 + HOUR}`, from: T0, through: T0 + HOUR });
    expect(batch.events).toHaveLength(8);
    expect(batch.events.map((e) => e.id)).not.toContain("late");
  });

  it("gives every app the same batch, whenever in the hour and in whatever order it holds the log", () => {
    const log = [...changes(5, T0 + 1000, "erik"), ...changes(5, T0 + 1500, "sara")];
    const a = nextActivityBatch(log, T0, T0 + HOUR + ACTIVITY_GRACE_MS + 1)!;
    const b = nextActivityBatch([...log].reverse(), T0, T0 + 2 * HOUR + ACTIVITY_GRACE_MS - 1)!;
    expect(b.id).toBe(a.id);
    expect(b.events.map((e) => e.id)).toEqual(a.events.map((e) => e.id));
  });

  it("waits while few changes are new, and hands them over anyway once the oldest is six hours old", () => {
    const log = changes(3, T0 + 1000);
    expect(nextActivityBatch(log, T0, T0 + 2 * HOUR)).toBeUndefined();
    expect(nextActivityBatch(log, T0, T0 + 5 * HOUR)).toBeUndefined();
    const batch = nextActivityBatch(log, T0, T0 + 6 * HOUR + 2000)!;
    expect(batch.events).toHaveLength(3);
    expect(batch.through).toBe(T0 + 5 * HOUR);
  });

  it("moves the cursor past a quiet stretch without a record, and does nothing before a new boundary", () => {
    expect(nextActivityBatch([], T0, T0 + HOUR + ACTIVITY_GRACE_MS + 1)).toMatchObject({ through: T0 + HOUR, events: [] });
    expect(nextActivityBatch(changes(20, T0 + 1000), T0 + HOUR, T0 + HOUR + ACTIVITY_GRACE_MS + 1)).toBeUndefined();
  });

  it("splits a large backlog at a change, keeps changes of one instant together, and continues from there", () => {
    const log = [...changes(80, T0 + 1000), change("same-instant", T0 + 1000 + 79 * 1000), ...changes(30, T0 + 200_000)];
    const now = T0 + HOUR + ACTIVITY_GRACE_MS + 1;
    const first = nextActivityBatch(log, T0, now)!;
    expect(first.events).toHaveLength(81);
    expect(first.through).toBe(T0 + 1000 + 79 * 1000);
    const second = nextActivityBatch(log, first.through, now)!;
    expect(second.events).toHaveLength(30);
    expect(second.through).toBe(T0 + HOUR);
    expect(new Set([...first.events, ...second.events].map((e) => e.id)).size).toBe(111);
  });

  it("starts a new workspace a day back, on an hour boundary", () => {
    const start = firstActivityCursor(T0 + 12_345);
    expect(start % HOUR).toBe(0);
    expect(T0 - start).toBe(24 * HOUR);
  });
});

describe("team activity through the bucket", () => {
  it("lets a running app hand over and read a closed colleague's changes, once, whoever looks", async () => {
    const bucket = new Map<string, Buffer>();
    const sara = await makeHub("sara", bucket);
    const jacob = await makeHub("jacob", bucket);
    const now = Date.now();
    const slot = Math.floor((now - ACTIVITY_GRACE_MS) / HOUR) * HOUR;
    // Erik made ten changes two hours ago and closed his computer; they are in everyone's synced log.
    const eriks = changes(10, slot - 2 * HOUR + 1000, "erik");
    for (const hub of [sara, jacob]) hub.store.data.activityLog = [...eriks];

    let prompt = "";
    const fetchSpy = vi.fn(async (_url: unknown, init?: RequestInit) => {
      prompt = JSON.stringify((JSON.parse(String(init?.body)) as { messages: unknown }).messages);
      return sseResponse(
        JSON.stringify({ proposals: [{ op: "add", scope: "server:prod-db", title: "Config lives in conf.d", text: "prod-db keeps its settings in conf.d.", evidence: "change erik" }] }),
      );
    });
    vi.stubGlobal("fetch", fetchSpy);

    // Both apps look in the same hour: one record, not two.
    await internals(sara).queueTeamActivity(now);
    await internals(jacob).queueTeamActivity(now);
    expect(pending(bucket)).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    const cursor = JSON.parse(bucket.get("team/ws/learn/activity-cursor.json")!.toString()) as { through: number };
    expect(cursor.through).toBe(slot);

    await internals(jacob).readLearningQueue(now + 60_000);
    expect(prompt).toContain("erik on prod-db (config-edit): change erik-");
    expect(jacob.store.data.memories.map((m) => m.title)).toEqual(["Config lives in conf.d"]);
    expect(pending(bucket)).toHaveLength(0);

    // Later looks find nothing new: the cursor is past Erik's changes.
    (sara as unknown as { lastActivityCheck: number }).lastActivityCheck = 0;
    await internals(sara).queueTeamActivity(now + 10 * 60_000);
    expect(pending(bucket)).toHaveLength(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not move the shared cursor back when a slower app writes later", async () => {
    const bucket = new Map<string, Buffer>();
    const sara = await makeHub("sara", bucket);
    const now = Date.now();
    const slot = Math.floor((now - ACTIVITY_GRACE_MS) / HOUR) * HOUR;
    sara.store.data.activityLog = changes(10, slot - 3 * HOUR + 1000);
    const cursorKey = "team/ws/learn/activity-cursor.json";
    bucket.set(cursorKey, Buffer.from(JSON.stringify({ through: slot - 4 * HOUR })));
    // While Sara's app is uploading, a faster app moves the cursor further.
    const objects = sara.s3Workspace.objects;
    const write = objects.write;
    objects.write = async (p, content) => {
      await write(p, content);
      if (p.startsWith("learn/pending/")) bucket.set(cursorKey, Buffer.from(JSON.stringify({ through: slot + HOUR })));
    };
    await internals(sara).queueTeamActivity(now);
    expect(JSON.parse(bucket.get(cursorKey)!.toString()).through).toBe(slot + HOUR);
  });
});
