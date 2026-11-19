import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { AgentChange, AgentTask } from "../../src/shared/types/aiHub";
import type { AiHubDeltaEvent } from "../../src/shared/ipc/createMultiSSHApi";
import { changeForSnapshot, taskForSnapshot } from "../../src/main/ai/hub/HubService";

/**
 * What every window is sent with every change. A snapshot carries every conversation, so a long one
 * travels by its last messages and its changes without their long parts; the window that shows it
 * asks for it whole. And while a run streams its answer, the windows are sent the pieces, not told to
 * fetch everything again for each one.
 */

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
});

const words = (n: number, seed: string): string => `${seed} lorem ipsum dolor sit amet consectetur `.repeat(Math.ceil(n / 30)).slice(0, n);

const conversation = (over: Partial<AgentTask> = {}): AgentTask =>
  ({
    id: "t1",
    title: "A conversation",
    mode: "assisted",
    status: "completed",
    messages: [],
    changes: [],
    sources: [],
    createdAt: 1,
    updatedAt: 2,
    maxCommands: 0,
    maxMinutes: 0,
    verification: "not-verified",
    ...over,
  }) as AgentTask;

const change = (over: Partial<AgentChange> = {}): AgentChange =>
  ({ id: "c1", kind: "command", target: "web-01", description: "Look", command: "journalctl -u nginx", status: "completed", exitCode: 0, at: 1, ...over }) as AgentChange;

describe("a conversation in a snapshot", () => {
  it("is sent whole while it is small, and without the tool log", () => {
    const task = conversation({
      messages: [
        { id: "u1", role: "user", text: "Why is nginx down?", at: 1 },
        { id: "a1", role: "assistant", text: "Its configuration does not load.", at: 2 },
      ],
      toolLog: [{ name: "terminal_command", input: "{}", output: "ok", at: 2 }],
    });
    const sent = taskForSnapshot(task);
    expect(sent.messages).toEqual(task.messages);
    expect(sent.messagesTail).toBeUndefined();
    expect(sent).not.toHaveProperty("toolLog");
  });

  it("is sent by its last messages once it is long, with what the whole of it is", () => {
    const messages = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? ("assistant" as const) : ("user" as const), text: words(i % 2 ? 1500 : 200, `m${i}`), at: i }));
    const sent = taskForSnapshot(conversation({ messages }));
    expect(sent.messages.map((m) => m.id)).toEqual(["m38", "m39"]);
    // The end of each, not its start: that is where a conversation is read from.
    expect(sent.messages[1].text).toBe(messages[39].text.slice(-800));
    expect(sent.messagesTail).toEqual({ count: 40, users: 20, lastId: "m39", lastChars: 1500 });
    expect(JSON.stringify(sent).length).toBeLessThan(2500);
  });

  it("never carries a picture in a snapshot", () => {
    const picture = `data:image/png;base64,${"A".repeat(50_000)}`;
    const sent = taskForSnapshot(conversation({ messages: [{ id: "u1", role: "user", text: "Look at this", images: [{ label: "shot", dataUrl: picture }], at: 1 }] }));
    expect(JSON.stringify(sent)).not.toContain("AAAA");
    expect(sent.messagesTail).toMatchObject({ count: 1, users: 1 });
  });
});

describe("a change in a snapshot", () => {
  it("is whole while its long parts are short", () => {
    const short = change({ output: "active (running)" });
    expect(changeForSnapshot(short)).toEqual(short);
  });

  it("is sent without its long parts once they are long, and says so", () => {
    const long = change({ output: words(6000, "log"), dryRunOutput: words(500, "dry") });
    const sent = changeForSnapshot(long);
    expect(sent.partial).toBe(true);
    expect(sent.output).toBe(long.output!.slice(0, 120));
    expect(sent).not.toHaveProperty("dryRunOutput");
    // What it ran, where, and how it ended are all still there.
    expect(sent).toMatchObject({ id: "c1", command: "journalctl -u nginx", target: "web-01", status: "completed", exitCode: 0 });
  });

  it("drops a file's contents and diff the same way", () => {
    const file = change({ kind: "file", target: "/etc/nginx/nginx.conf", command: undefined, before: words(3000, "before"), after: words(3000, "after"), diff: words(700, "diff") });
    const sent = changeForSnapshot(file);
    expect(sent.partial).toBe(true);
    for (const part of ["before", "after", "diff"]) expect(sent).not.toHaveProperty(part);
  });

  it("is never cut while it waits for an answer: the person deciding sees all of it", () => {
    const waiting = change({ kind: "file", status: "pending", before: words(3000, "before"), after: words(3000, "after"), diff: words(900, "diff"), dryRunOutput: words(2000, "plan") });
    expect(changeForSnapshot(waiting)).toEqual(waiting);
  });
});

async function hubWith(host: Record<string, unknown> = {}) {
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-snapshot-"));
  const hub = new HubService(
    { changed: () => {}, inventoryTargets: async () => [], backgroundChanged: async () => {}, openSchedule: async () => "s1", show: () => {}, aiConfigFilePath: path.join(dir, "ai.json"), ...host } as never,
    dir,
  );
  disposals.push(async () => {
    await hub.dispose();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await hub.initialize();
  return hub;
}

describe("asking for a conversation whole", () => {
  it("returns every message and every change as they are, and changes nothing", async () => {
    const hub = await hubWith();
    const messages = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? ("assistant" as const) : ("user" as const), text: words(900, `m${i}`), at: i }));
    const changes = [change({ output: words(5000, "log") })];
    hub.store.data.tasks.push(conversation({ messages, changes }));

    const listed = (await hub.request({ action: "snapshot" })).tasks.find((t) => t.id === "t1")!;
    expect(listed.messages).toHaveLength(2);
    expect(listed.changes[0].partial).toBe(true);

    const read = await hub.request({ action: "task-read", taskId: "t1" });
    expect(read.reply?.task).toEqual({ id: "t1", messages, changes });
    // The stored conversation carries no mark of how it was sent.
    expect(hub.store.data.tasks[0]).not.toHaveProperty("messagesTail");
    expect(hub.store.data.tasks[0].changes[0]).not.toHaveProperty("partial");
    await expect(hub.request({ action: "task-read", taskId: "nope" })).rejects.toThrow("Task not found");
  });
});

/** A model that streams one answer in many small pieces. */
async function streamingModel(pieces: number): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      let i = 0;
      const tick = (): void => {
        for (let k = 0; k < 25 && i < pieces; k++, i++) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `w${i} ` } }] })}\n\n`);
        if (i < pieces) return void setTimeout(tick, 4);
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
        res.end("data: [DONE]\n\n");
      };
      tick();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe("a streamed answer", () => {
  it("is sent to the windows piece by piece, each saying where it belongs, without a refetch of everything for each", async () => {
    const pieces = 600;
    const model = await streamingModel(pieces);
    disposals.push(() => model.close());
    let refetches = 0;
    const deltas: AiHubDeltaEvent[] = [];
    const hub = await hubWith({ changed: () => void refetches++, delta: (d: AiHubDeltaEvent) => void deltas.push(d) });
    await hub.request({ action: "configure", config: { enabled: true, provider: "openai-compatible", model: "fake-1", baseUrl: model.url, apiKey: "not-a-real-key" }, preferences: { proposeMemories: false } });

    refetches = 0;
    const started = Date.now();
    const id = (await hub.request({ action: "start", task: { prompt: "Say a lot.", mode: "advice" } })).reply!.started!.taskId;
    const task = hub.store.data.tasks.find((t) => t.id === id)!;
    while (!["completed", "failed"].includes(task.status)) await new Promise((r) => setTimeout(r, 10));
    const seconds = (Date.now() - started) / 1000;

    expect(task.status).toBe("completed");
    const text = deltas.filter((d) => d.type === "message.delta");
    expect(text.length).toBeGreaterThan(pieces * 0.9);
    expect(new Set(text.map((d) => d.messageId))).toEqual(new Set([task.messages.at(-1)!.id]));
    // Each piece says how long the message is with it: a window can tell a repeat from a gap.
    let length = 0;
    for (const d of text) {
      length += d.delta!.length;
      expect(d.length).toBe(length);
    }
    expect(task.messages.at(-1)!.text.length).toBe(length);
    // Before, every piece told every window to fetch everything: hundreds of times a second.
    expect(refetches).toBeLessThan(10 + 2 * seconds);
  }, 30_000);

  it("still tells a host that takes no pieces about every event, as before", async () => {
    const model = await streamingModel(60);
    disposals.push(() => model.close());
    let refetches = 0;
    const hub = await hubWith({ changed: () => void refetches++ });
    await hub.request({ action: "configure", config: { enabled: true, provider: "openai-compatible", model: "fake-1", baseUrl: model.url, apiKey: "not-a-real-key" }, preferences: { proposeMemories: false } });
    refetches = 0;
    const id = (await hub.request({ action: "start", task: { prompt: "Say a little.", mode: "advice" } })).reply!.started!.taskId;
    const task = hub.store.data.tasks.find((t) => t.id === id)!;
    while (!["completed", "failed"].includes(task.status)) await new Promise((r) => setTimeout(r, 10));
    // About one for every piece that came through (the runtime hands on some pieces together).
    expect(refetches).toBeGreaterThan(15);
  }, 30_000);
});

describe("a large workspace", () => {
  it("has a snapshot within its budget: 300 long conversations, 2000 memories, 500 documents, 200 tickets", async () => {
    const hub = await hubWith();
    const now = Date.now();
    const data = hub.store.data;
    for (let t = 0; t < 300; t++)
      data.tasks.push(
        conversation({
          id: `task-${t}`,
          title: `Conversation ${t}`,
          messages: Array.from({ length: 40 }, (_, m) => ({ id: `m-${t}-${m}`, role: m % 2 ? ("assistant" as const) : ("user" as const), text: words(m % 2 ? 1200 : 200, `t${t}m${m}`), at: now + m })),
          // What real commands print: a few lines to a few thousand characters, and a file change.
          changes: [
            ...Array.from({ length: 14 }, (_, c) => change({ id: `c-${t}-${c}`, output: words([120, 400, 1500, 3000, 6000][c % 5], "out"), at: now })),
            change({ id: `c-${t}-file`, kind: "file", target: "/etc/nginx/conf.d/shop.conf", command: undefined, before: words(3000, "before"), after: words(3000, "after"), diff: words(600, "diff"), at: now }),
          ],
          createdAt: now,
          updatedAt: now,
        }),
      );
    for (let i = 0; i < 2000; i++)
      data.memories.push({ id: `mem-${i}`, kind: i % 5 ? "memory" : "skill", tier: "archival", scope: "workspace", title: `Memory ${i}`, text: words(300, `mem${i}`), author: "Maria Ek", createdAt: now, updatedAt: now } as never);
    data.kbDocuments = Array.from({ length: 500 }, (_, i) => ({ id: `doc-${i}`, title: `Document ${i}`, content: words(4000, `doc${i}`), cluster: "Web-Prod", tags: [], chunks: [], createdAt: now, updatedAt: now, author: "Maria Ek" })) as never;
    data.workTickets = Array.from({ length: 200 }, (_, i) => ({ id: `t-${i}`, title: `Ticket ${i}`, description: words(600, `tick${i}`), status: "todo", createdAt: now, updatedAt: now, createdBy: "Maria Ek", comments: [] })) as never;

    const whole = JSON.stringify(data.tasks).length;
    await hub.snapshot();
    const times: number[] = [];
    let bytes = 0;
    let conversations = 0;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const snap = await hub.snapshot();
      const json = JSON.stringify(snap);
      times.push(performance.now() - t0);
      bytes = json.length;
      conversations = JSON.stringify(snap.tasks).length;
    }
    const median = times.sort((a, b) => a - b)[2];
    // The conversations as stored are some 20 MB here. What a snapshot carries of them is a tenth of that.
    expect(whole).toBeGreaterThan(15_000_000);
    expect(conversations).toBeLessThan(whole / 8);
    expect(bytes).toBeLessThan(5_000_000);
    // Generous: this is a guard against a snapshot that copies everything again, not a benchmark.
    expect(median).toBeLessThan(400);
  }, 60_000);
});
