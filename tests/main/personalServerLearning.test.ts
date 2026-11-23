import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentTask, WorkspaceServerSummary } from "../../src/shared/types/aiHub";
import type { QueueStore } from "../../src/main/ai/hub/LearningQueue";

/**
 * What is learned from a finished conversation becomes team memory and shared pages, and with a team
 * bucket the conversation is uploaded for a teammate's app to read. A conversation about a server its
 * owner marked personal is not the team's: it is neither uploaded nor learned from.
 */

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
});

const servers = [
  { id: "s1", name: "pg-01", host: "10.0.0.5", port: 22, username: "root", cluster: "DB-Prod", shared: true },
  { id: "p1", name: "my-homelab", host: "192.168.1.7", port: 22, username: "me", shared: false },
] as WorkspaceServerSummary[];

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
  s3Workspace: { canUseBucket: () => boolean };
  recoverUnreadSessions: (now?: number) => Promise<void>;
  recoveredSessions: boolean;
  queueForLearning: (source: { id: string; title: string; transcript: string }, query: string, about?: AgentTask) => Promise<void>;
  proposeMemoriesFrom: (...args: unknown[]) => Promise<unknown>;
  onPersonalServer: (task: AgentTask) => boolean;
  event: (task: AgentTask, event: { type: string; output?: string }) => void;
};

async function makeHub(withBucket = true) {
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(false);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-personal-learn-"));
  const hub = new HubService(
    { changed: () => {}, inventoryTargets: async () => [], backgroundChanged: async () => {}, openSchedule: async () => "s1", show: () => {}, aiConfigFilePath: path.join(dir, "ai.json"), workspaceServers: async () => servers, defaultActorName: "Anna" } as never,
    dir,
  );
  disposals.push(async () => {
    await hub.dispose();
    setDemoModeForTesting(undefined);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await hub.initialize();
  const inner = hub as unknown as Inner;
  const bucket = memoryBucket();
  if (withBucket) {
    inner.s3Workspace.canUseBucket = () => true;
    Object.defineProperty(inner.s3Workspace, "objects", { value: bucket });
  }
  // The reading itself needs a model: here it is only noted that it was asked for.
  const read = vi.spyOn(inner, "proposeMemoriesFrom").mockResolvedValue(undefined);
  const queued = (): string[] => [...bucket.files.entries()].filter(([k]) => k.startsWith("learn/pending/")).map(([, v]) => v.toString("utf8"));
  return { hub, inner, queued, read };
}

let n = 0;
const conversation = (extra: Partial<AgentTask> & { on?: string; commandOn?: string }): AgentTask => {
  const { on, commandOn, ...rest } = extra;
  const now = Date.now();
  const target = commandOn ?? on;
  return {
    id: `run-${++n}`,
    title: "why is it slow",
    mode: "assisted",
    status: "completed",
    ...(on ? { target: { sessionId: `gone-${n}`, generation: "1", label: on } } : {}),
    messages: [
      { id: "m1", role: "user", text: "it is slow, my partner's backup job runs at night", at: now },
      { id: "m2", role: "assistant", text: "Looked at it. ".repeat(60), at: now },
    ],
    changes: target ? [{ id: "c1", kind: "command", target, description: "top", command: "top -bn1 | head", status: "completed", exitCode: 0, output: "load average: 9.1", at: now }] : [],
    sources: [],
    createdAt: now,
    updatedAt: now,
    maxCommands: 5,
    maxMinutes: 5,
    verification: "not-verified",
    ...rest,
  } as unknown as AgentTask;
};

describe("a finished conversation about a personal server", () => {
  it("is not uploaded to the team's learning queue, and one about a shared server is", async () => {
    const { hub, inner, queued, read } = await makeHub();
    const personal = conversation({ on: "my-homelab" });
    const shared = conversation({ on: "pg-01" });
    hub.store.data.tasks.push(personal, shared);
    await inner.recoverUnreadSessions(Date.now());
    const records = queued();
    expect(records).toHaveLength(1);
    expect(records[0]).toContain("Target: pg-01");
    expect(records.join("\n")).not.toContain("my-homelab");
    // Nor is it read here: what is learned would be team memory.
    expect(read).not.toHaveBeenCalled();
    // It is not looked at again at the next start.
    expect(hub.store.data.distilledSourceIds).toContain(`task:${personal.id}`);
    expect(hub.store.data.queuedSourceIds).toEqual([`task:${shared.id}`]);
    inner.recoveredSessions = false;
    await inner.recoverUnreadSessions(Date.now());
    expect(queued()).toHaveLength(1);
  }, 60_000);

  it("is told by its address, by a command it ran there, and by a terminal it was shown", async () => {
    const { hub, inner, queued } = await makeHub();
    const cases = [
      conversation({ on: "192.168.1.7" }),
      conversation({ on: "ME@192.168.1.7" }),
      // Its own terminal was a shared server; it ran a command on the personal one.
      conversation({ on: "pg-01", commandOn: "my-homelab" }),
      // No server of its own; the personal server's terminal was put before it.
      conversation({ sources: [{ id: "terminal:gone-x", label: "My-Homelab", text: "load average: 9.1", observedAt: 1, kind: "terminal" }] } as Partial<AgentTask>),
    ];
    for (const task of cases) expect(inner.onPersonalServer(task), JSON.stringify([task.target?.label, task.changes[0]?.target, task.sources[0]?.label])).toBe(true);
    hub.store.data.tasks.push(...cases);
    await inner.recoverUnreadSessions(Date.now());
    expect(queued()).toEqual([]);
    // A setting changed in a conversation is not a server, and a shared server is not personal.
    expect(inner.onPersonalServer(conversation({ on: "pg-01" }))).toBe(false);
    expect(inner.onPersonalServer(conversation({}))).toBe(false);
    expect(inner.onPersonalServer(conversation({ changes: [{ id: "c", kind: "setting", target: "my-homelab", description: "d", status: "completed", at: 1 }] } as Partial<AgentTask>))).toBe(false);
  }, 60_000);

  it("is told by the terminal's own server while it is open, whatever the terminal is called", async () => {
    const { hub, inner, queued } = await makeHub();
    hub.terminals.register({ id: "live-1", label: "a tab somebody renamed", kind: "ssh", profileId: "p1" }, () => undefined);
    hub.terminals.register({ id: "live-2", label: "another tab", kind: "ssh", profileId: "s1" }, () => undefined);
    const personal = conversation({ target: { sessionId: "live-1", generation: "1", label: "a tab somebody renamed" } } as Partial<AgentTask>);
    const shared = conversation({ target: { sessionId: "live-2", generation: "1", label: "another tab" } } as Partial<AgentTask>);
    expect(inner.onPersonalServer(personal)).toBe(true);
    expect(inner.onPersonalServer(shared)).toBe(false);
    hub.store.data.tasks.push(personal, shared);
    await inner.recoverUnreadSessions(Date.now());
    expect(queued()).toHaveLength(1);
    expect(queued()[0]).toContain("another tab");
  }, 60_000);

  it("is left out when its run ends, as it is at the next start", async () => {
    const { hub, inner, queued, read } = await makeHub();
    const personal = conversation({ on: "my-homelab", status: "running" });
    const shared = conversation({ on: "pg-01", status: "running" });
    hub.store.data.tasks.push(personal, shared);
    inner.event(personal, { type: "run.completed", output: "Looked at it. ".repeat(60) });
    inner.event(shared, { type: "run.completed", output: "Looked at it. ".repeat(60) });
    await vi.waitFor(() => expect(queued()).toHaveLength(1));
    await vi.waitFor(() => expect(hub.store.data.distilledSourceIds).toContain(`task:${personal.id}`));
    expect(queued()[0]).toContain("Target: pg-01");
    expect(read).not.toHaveBeenCalled();
  }, 60_000);

  it("is not learned from where there is no team bucket either, and a shared one is read here", async () => {
    const { hub, inner, read } = await makeHub(false);
    const personal = conversation({ on: "my-homelab" });
    const shared = conversation({ on: "pg-01" });
    hub.store.data.tasks.push(personal, shared);
    await inner.recoverUnreadSessions(Date.now());
    expect(read).toHaveBeenCalledTimes(1);
    expect((read.mock.calls[0][0] as { id: string }).id).toBe(`task:${shared.id}`);
  }, 60_000);

  it("leaves a record that is not a conversation's as it was", async () => {
    const { inner, queued } = await makeHub();
    await inner.queueForLearning({ id: "activity:e1", title: "My recent activity", transcript: "Restarted nginx on pg-01." }, "pg-01 nginx");
    expect(queued()).toHaveLength(1);
  }, 60_000);
});
