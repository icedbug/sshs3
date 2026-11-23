import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AgentTask } from "../../src/shared/types/aiHub";
import { renderNotification, type NotifyChannel, type NotifyItem } from "../../src/main/ai/hub/Notifier";
import { MAX_HELD_NOTICES, NotifyStore, type HeldNotice, type NotifyData } from "../../src/main/ai/hub/NotifyStore";

/**
 * Quiet hours and the hourly limit used to drop what they held back: nobody was told, then or later.
 * Now it is kept, on the disk, and told in one message when the quiet hours end or the hour has room.
 */

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
});

interface Got {
  url: string;
  body: string;
}
async function receiver(): Promise<{ url: string; got: Got[] }> {
  const got: Got[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      got.push({ url: req.url ?? "", body });
      res.writeHead(200).end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  disposals.push(() => new Promise((r) => server.close(() => r(undefined))));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, got };
}

type Inner = {
  flushInbox: (now?: number) => Promise<void>;
  notifySettle: () => Promise<void>;
  notifyWaits: number[];
  notifyStore: { data: NotifyData };
};

async function makeHub(dir?: string) {
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(false);
  const made = dir ?? (await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-held-")));
  const hub = new HubService({ changed: () => {}, inventoryTargets: async () => [], backgroundChanged: async () => {}, openSchedule: async () => "s1", show: () => {}, aiConfigFilePath: path.join(made, "ai.json") } as never, made);
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await hub.dispose();
  };
  disposals.push(async () => {
    await close();
    setDemoModeForTesting(undefined);
    if (!dir) await fs.rm(made, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await hub.initialize();
  const inner = hub as unknown as Inner;
  inner.notifySettle = async () => {};
  inner.notifyWaits = [];
  return { hub, inner, dir: made, close };
}

/** A run that waits for an approval, as of `at`. */
const waiting = (id: string, at: number, what = "Restart pgbouncer"): AgentTask =>
  ({
    id,
    title: "Fix the pool",
    agentName: "DBA",
    mode: "assisted",
    status: "waiting",
    messages: [],
    sources: [],
    createdAt: at,
    updatedAt: at,
    maxCommands: 10,
    maxMinutes: 15,
    verification: "not-verified",
    target: { sessionId: "s", generation: "g", label: "pg-01" },
    changes: [{ id: `${id}-c1`, kind: "command", target: "pg-01", description: what, command: "systemctl restart pgbouncer", status: "pending", at }],
  }) as unknown as AgentTask;

const text = (body: string): string => (JSON.parse(body) as { blocks: Array<{ text?: { text: string } }> }).blocks[0].text!.text;
const HOUR = 3_600_000;
const MIN = 60_000;
const NIGHT = Date.parse("2026-11-23T23:00:00Z");
const MORNING = Date.parse("2026-11-24T07:01:00Z");
const QUIET = { enabled: true, startHour: 22, endHour: 7, timezone: "UTC", allowCritical: true };

describe("what quiet hours held back", () => {
  it("is kept on the disk and told in one message when the quiet hours are over", async () => {
    const { hub, inner, dir } = await makeHub();
    const slack = await receiver();
    await hub.request({ action: "notify-channel-save", channel: { kind: "slack", name: "ops", url: `${slack.url}/services/x`, enabled: true, events: ["approval"], includeCommand: true } });
    inner.notifyStore.data.quietHours = QUIET;
    await inner.flushInbox(NIGHT - MIN);

    hub.store.data.tasks.push(waiting("n1", NIGHT, "Restart pgbouncer"), waiting("n2", NIGHT, "Rotate the logs"), waiting("n3", NIGHT, "Vacuum the orders table"));
    await inner.flushInbox(NIGHT);
    expect(slack.got).toHaveLength(0);
    expect(inner.notifyStore.data.held!.map((h) => h.id).sort()).toEqual(["approval:n1-c1", "approval:n2-c1", "approval:n3-c1"]);
    // On the disk, as a line each: not the command.
    const file = (await fs.readdir(dir, { recursive: true })).map((f) => path.join(dir, String(f))).find((f) => path.basename(f).startsWith("notif"))!;
    const stored = JSON.parse(await fs.readFile(file, "utf8")) as { held: HeldNotice[] };
    expect(stored.held).toHaveLength(3);
    expect(stored.held[0]).toMatchObject({ kind: "approval", title: "Restart pgbouncer", from: "DBA", target: "pg-01", at: NIGHT });
    expect(JSON.stringify(stored.held)).not.toContain("systemctl");

    // Still quiet: nothing is told, however often it is looked at.
    await inner.flushInbox(NIGHT + HOUR);
    await inner.flushInbox(MORNING - 2 * MIN);
    expect(slack.got).toHaveLength(0);
    // One of them is answered in the night.
    hub.store.data.tasks.find((t) => t.id === "n2")!.status = "completed";
    hub.store.data.tasks.find((t) => t.id === "n2")!.changes[0].status = "completed";

    await inner.flushInbox(MORNING);
    expect(slack.got).toHaveLength(1);
    const said = text(slack.got[0].body);
    expect(said.split("\n")[0]).toBe("*3 things happened while notifications were quiet*");
    expect(said).toContain("• Approval needed — DBA on pg-01: Restart pgbouncer");
    expect(said).toContain("• Approval needed — DBA on pg-01: Rotate the logs (no longer waiting)");
    expect(said).toContain("• Approval needed — DBA on pg-01: Vacuum the orders table");
    expect(said).not.toContain("systemctl");
    // Told once.
    expect(inner.notifyStore.data.held).toEqual([]);
    expect((JSON.parse(await fs.readFile(file, "utf8")) as { held: HeldNotice[] }).held).toEqual([]);
    await inner.flushInbox(MORNING + 10_000);
    await inner.flushInbox(MORNING + HOUR);
    expect(slack.got).toHaveLength(1);
  }, 60_000);

  it("is still told after the app was closed in the night", async () => {
    const first = await makeHub();
    const slack = await receiver();
    await first.hub.request({ action: "notify-channel-save", channel: { kind: "slack", name: "ops", url: `${slack.url}/services/x`, enabled: true, events: ["approval"], includeCommand: true } });
    first.inner.notifyStore.data.quietHours = QUIET;
    await first.inner.flushInbox(NIGHT - MIN);
    first.hub.store.data.tasks.push(waiting("n1", NIGHT));
    await first.inner.flushInbox(NIGHT);
    expect(slack.got).toHaveLength(0);
    await first.hub.store.save();
    await first.close();

    const second = await makeHub(first.dir);
    expect(second.inner.notifyStore.data.held!.map((h) => h.id)).toEqual(["approval:n1-c1"]);
    await second.inner.flushInbox(MORNING);
    expect(slack.got).toHaveLength(1);
    expect(text(slack.got[0].body).split("\n")[0]).toBe("*1 thing happened while notifications were quiet*");
    await fs.rm(first.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }, 60_000);

  it("is told only to the channels that want that kind of thing", async () => {
    const { hub, inner } = await makeHub();
    const approvals = await receiver();
    const alerts = await receiver();
    await hub.request({ action: "notify-channel-save", channel: { kind: "slack", name: "ops", url: `${approvals.url}/services/a`, enabled: true, events: ["approval"], includeCommand: true } });
    await hub.request({ action: "notify-channel-save", channel: { kind: "slack", name: "alerts", url: `${alerts.url}/services/b`, enabled: true, events: ["alert"], includeCommand: true } });
    inner.notifyStore.data.quietHours = QUIET;
    await inner.flushInbox(NIGHT - MIN);
    hub.store.data.tasks.push(waiting("n1", NIGHT));
    await inner.flushInbox(NIGHT);
    await inner.flushInbox(MORNING);
    expect(approvals.got).toHaveLength(1);
    expect(alerts.got).toHaveLength(0);
  }, 60_000);
});

describe("what the hourly limit held back", () => {
  it("is told in one message when the hour has room again, and that message counts", async () => {
    const { hub, inner } = await makeHub();
    const slack = await receiver();
    await hub.request({ action: "notify-channel-save", channel: { kind: "slack", name: "ops", url: `${slack.url}/services/x`, enabled: true, events: ["approval"], includeCommand: true } });
    inner.notifyStore.data.noiseBudgetPerHour = 1;
    const start = Date.parse("2026-11-24T12:00:00Z");
    await inner.flushInbox(start - MIN);

    hub.store.data.tasks.push(waiting("d1", start, "First"));
    await inner.flushInbox(start);
    expect(slack.got).toHaveLength(1);
    expect(text(slack.got[0].body)).toContain("Approval needed");
    // Two more within the hour: over the limit. So is the reminder that the first still waits.
    hub.store.data.tasks.push(waiting("d2", start + 5 * MIN, "Second"), waiting("d3", start + 5 * MIN, "Third"));
    await inner.flushInbox(start + 5 * MIN);
    await inner.flushInbox(start + 30 * MIN);
    expect(slack.got).toHaveLength(1);
    expect(inner.notifyStore.data.held!.map((h) => [h.title, h.reminder ?? false])).toEqual([["Second", false], ["Third", false], ["First", true]]);

    // An hour after the first message there is room for one: they are told together.
    await inner.flushInbox(start + 61 * MIN);
    expect(slack.got).toHaveLength(2);
    const said = text(slack.got[1].body);
    expect(said.split("\n")[0]).toBe("*3 things happened while notifications were quiet*");
    expect(said).toContain("• Still waiting: Approval needed — DBA on pg-01: First");
    expect(said).toContain("• Approval needed — DBA on pg-01: Second");
    expect(said).toContain("• Approval needed — DBA on pg-01: Third");
    // That message used the hour's room: the next thing waits its turn, and is told an hour later.
    hub.store.data.tasks.push(waiting("d4", start + 62 * MIN, "Fourth"));
    await inner.flushInbox(start + 62 * MIN);
    expect(slack.got).toHaveLength(2);
    await inner.flushInbox(start + 122 * MIN);
    expect(slack.got).toHaveLength(3);
    expect(text(slack.got[2].body)).toContain("*1 thing happened while notifications were quiet*");
  }, 60_000);
});

describe("the list of what is held", () => {
  const notice = (i: number): HeldNotice => ({ id: `approval:c${i}`, kind: "approval", title: `Thing ${i}`, at: i, since: i });

  it("is bounded: past fifty the oldest are let go and counted, and one item is kept once", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-held-store-"));
    disposals.push(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
    const file = path.join(dir, "notify.json");
    const store = new NotifyStore(file);
    await store.load();
    store.hold(Array.from({ length: 30 }, (_, i) => notice(i)));
    store.hold(Array.from({ length: 40 }, (_, i) => notice(i + 20)));
    expect(MAX_HELD_NOTICES).toBe(50);
    expect(store.data.held).toHaveLength(50);
    expect(store.data.heldMore).toBe(10);
    expect(store.data.held![0].id).toBe("approval:c10");
    await store.save();

    // Read back as what it must be: a broken or foreign entry is left out, and the bound holds.
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as { held: unknown[] };
    raw.held.push({ id: "x", kind: "not-a-kind", title: "no" }, { id: 7, kind: "approval", title: "no" }, null);
    await fs.writeFile(file, JSON.stringify(raw));
    const again = new NotifyStore(file);
    await again.load();
    expect(again.data.held).toHaveLength(50);
    expect(again.data.heldMore).toBe(10);
    expect(again.takeHeld()).toMatchObject({ more: 10 });
    expect(again.data.held).toEqual([]);
    expect(again.data.heldMore).toBeUndefined();
  });

  it("is told as a list under its own heading, also for one item, with how many more there were", () => {
    const channel: NotifyChannel = { id: "c", kind: "slack", name: "ops", url: "https://hooks.example.com/x", enabled: true, events: ["approval"], includeCommand: true };
    const items: NotifyItem[] = Array.from({ length: 14 }, (_, i) => ({ id: `approval:c${i}`, kind: "approval", title: `Thing ${i}`, from: "DBA" }));
    const many = text(renderNotification(channel, items, { heading: "24 things happened while notifications were quiet", more: 10 }).body);
    expect(many.split("\n")[0]).toBe("*24 things happened while notifications were quiet*");
    expect(many.split("\n").filter((l) => l.startsWith("• ")).length).toBe(13);
    expect(many).toContain("• …and 12 more");
    const one = text(renderNotification(channel, items.slice(0, 1), { heading: "1 thing happened while notifications were quiet" }).body);
    expect(one).toBe("*1 thing happened while notifications were quiet*\n• Approval needed — DBA: Thing 0");
    // Without a heading one item is told in full, as before.
    expect(text(renderNotification(channel, items.slice(0, 1)).body).split("\n")[0]).toBe("*Approval needed — DBA*");
  });
});
