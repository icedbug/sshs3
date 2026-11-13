import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AgentTask, WorkTicket } from "../../src/shared/types/aiHub";
import type { InboxItem } from "../../src/shared/aiHubInbox";
import {
  addressClass,
  channelWants,
  deliver,
  diffInbox,
  guardUrl,
  renderNotification,
  standardWebhookHeaders,
  verifyStandardWebhook,
  type NotifyChannel,
  type NotifyItem,
} from "../../src/main/ai/hub/Notifier";
import { WorkSync } from "../../src/main/ai/hub/WorkSync";
import type { QueueStore } from "../../src/main/ai/hub/LearningQueue";

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const channel = (extra: Partial<NotifyChannel> = {}): NotifyChannel => ({
  id: "c",
  kind: "slack",
  name: "ops",
  url: "https://hooks.slack.com/services/T0/B0/secret-part",
  enabled: true,
  events: ["approval", "plan", "question", "blocked", "alert", "review", "report"],
  includeCommand: true,
  ...extra,
});
const approval: NotifyItem = {
  id: "approval:c1",
  kind: "approval",
  title: "Restart pgbouncer",
  command: "systemctl restart pgbouncer",
  from: "DBA",
  target: "pg-01",
  risk: "modify",
  reason: "restarts a service",
  check: "pg_isready",
  rollback: "systemctl start pgbouncer",
  waitsMinutes: 20,
  link: "https://sshs3.example.com/?view=Inbox&item=approval%3Ac1",
};

describe("what counts as new in the inbox", () => {
  const item = (id: string, since: number): InboxItem => ({ id, kind: "approval", title: id, at: since, since });

  it("tells about what is new, not what was already old when first seen, and again when something comes back", () => {
    const first = diffInbox([item("a", NOW - MIN), item("old", NOW - 60 * MIN)], {}, NOW);
    expect(first.fresh.map((i) => i.id)).toEqual(["a"]);
    expect(Object.keys(first.seen).sort()).toEqual(["a", "old"]);

    const second = diffInbox([item("a", NOW - MIN), item("b", NOW)], first.seen, NOW + 1000);
    expect(second.fresh.map((i) => i.id)).toEqual(["b"]);
    expect(Object.keys(second.seen).sort()).toEqual(["a", "b"]);

    // "a" was answered and is asked again later: that is news.
    const third = diffInbox([item("a", NOW + 5 * MIN)], diffInbox([], second.seen, NOW + 2000).seen, NOW + 5 * MIN);
    expect(third.fresh.map((i) => i.id)).toEqual(["a"]);
  });

  it("lets a channel choose its events and how severe an alert has to be", () => {
    expect(channelWants(channel({ events: ["alert"] }), approval)).toBe(false);
    expect(channelWants(channel({ enabled: false }), approval)).toBe(false);
    const strict = channel({ alertMinSeverity: "critical" });
    expect(channelWants(strict, { kind: "alert", risk: "warning" })).toBe(false);
    expect(channelWants(strict, { kind: "alert", risk: "critical" })).toBe(true);
    expect(channelWants(strict, approval)).toBe(true);
  });
});

describe("what a channel is sent", () => {
  it("gives Slack what a person needs to decide, with nothing that pings or breaks out", () => {
    const sent = renderNotification(channel(), [{ ...approval, title: "Restart <!channel> & co", command: "echo ```x``` > /tmp/a" }], { owner: "Jacob" });
    expect(sent.url).toBe("https://hooks.slack.com/services/T0/B0/secret-part");
    const body = JSON.parse(sent.body) as { text: string; blocks: Array<{ type: string; text?: { text: string }; elements?: Array<{ url: string }> }> };
    expect(body.text).toBe("Approval needed — DBA on pg-01");
    const text = body.blocks[0].text!.text;
    expect(text).toContain("*Approval needed — DBA on pg-01*");
    expect(text).toContain("Restart &lt;!channel&gt; &amp; co");
    expect(text).not.toContain("<!channel>");
    expect(text).toContain("echo '''x''' &gt; /tmp/a");
    expect(text).toContain("Risk: changes the system (restarts a service)");
    expect(text).toContain("Check: pg_isready");
    expect(text).toContain("Way back: systemctl start pgbouncer");
    expect(text).toContain("The agent waits 20 min for Jacob.");
    expect(body.blocks[1].elements![0].url).toBe(approval.link);
  });

  it("leaves the command out for a channel that may not have it, and masks what looks like a secret", () => {
    const quiet = JSON.parse(renderNotification(channel({ includeCommand: false }), [{ ...approval, title: approval.command! }]).body) as { blocks: Array<{ text?: { text: string } }> };
    expect(quiet.blocks[0].text!.text).not.toContain("systemctl");
    expect(quiet.blocks[0].text!.text).toContain("its text is not sent to this channel");
    expect(quiet.blocks[0].text!.text).not.toContain("pg_isready");
    const masked = renderNotification(channel(), [{ ...approval, command: "curl -H 'Authorization: Bearer abcdef123456' https://api" }]).body;
    expect(masked).not.toContain("abcdef123456");
  });

  it("speaks ntfy, Teams and a signed webhook", () => {
    const ntfy = renderNotification(channel({ kind: "ntfy", url: "https://ntfy.example.com/team-ops", secret: "tk_x" }), [approval]);
    expect(ntfy.url).toBe("https://ntfy.example.com/");
    expect(ntfy.headers.Authorization).toBe("Bearer tk_x");
    expect(JSON.parse(ntfy.body)).toMatchObject({ topic: "team-ops", title: "Approval needed — DBA on pg-01", priority: 4, tags: ["lock"], click: approval.link, actions: [{ action: "view", url: approval.link }] });
    expect(JSON.parse(renderNotification(channel({ kind: "ntfy", url: "https://ntfy.sh/t" }), [{ id: "alert:1", kind: "alert", title: "Disk full", risk: "critical" }]).body).priority).toBe(5);

    const teams = JSON.parse(renderNotification(channel({ kind: "teams", url: "https://x.webhook.office.com/y" }), [approval]).body) as { attachments: Array<{ contentType: string; content: { body: Array<{ text: string }>; actions: Array<{ url: string }> } }> };
    expect(teams.attachments[0].contentType).toBe("application/vnd.microsoft.card.adaptive");
    expect(teams.attachments[0].content.body.map((b) => b.text)).toContain("systemctl restart pgbouncer");
    expect(teams.attachments[0].content.actions[0].url).toBe(approval.link);

    const hook = renderNotification(channel({ kind: "webhook", url: "https://example.com/in", secret: "k" }), [approval, { id: "blocked:t1", kind: "blocked", title: "Fix replication" }]);
    expect(hook.headers["X-Sshs3-Signature"]).toBe(`sha256=${crypto.createHmac("sha256", "k").update(hook.body).digest("hex")}`);
    const parsed = JSON.parse(hook.body) as { title: string; items: Array<{ id: string; command?: string }> };
    expect(parsed.title).toBe("2 things are waiting in sshs3");
    expect(parsed.items.map((i) => i.id)).toEqual(["approval:c1", "blocked:t1"]);
    expect(parsed.items[0].command).toBe("systemctl restart pgbouncer");
  });

  it("signs a webhook the Standard Webhooks way, new id each message, and keeps the old header", () => {
    const hookChannel = channel({ kind: "webhook", url: "https://example.com/in", secret: "k" });
    const now = Math.floor(Date.now() / 1000);
    const first = renderNotification(hookChannel, [approval]);
    const second = renderNotification(hookChannel, [approval]);
    expect(first.headers["X-Sshs3-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(first.headers["webhook-id"]).toMatch(/^msg_[0-9a-f]{32}$/);
    expect(second.headers["webhook-id"]).not.toBe(first.headers["webhook-id"]);
    const ts = Number(first.headers["webhook-timestamp"]);
    expect(Math.abs(ts - now)).toBeLessThanOrEqual(2);
    const expected = crypto.createHmac("sha256", "k").update(`${first.headers["webhook-id"]}.${ts}.${first.body}`).digest("base64");
    expect(first.headers["webhook-signature"]).toBe(`v1,${expected}`);
    // No key, no signature headers; other kinds never get them.
    expect(renderNotification(channel({ kind: "webhook", url: "https://example.com/in" }), [approval]).headers["webhook-signature"]).toBeUndefined();
    expect(renderNotification(channel({ secret: "k" }), [approval]).headers["webhook-id"]).toBeUndefined();
  });

  it("checks a signed message: key, body, age and the whsec_ key form", () => {
    const body = JSON.stringify({ a: 1 });
    const h = standardWebhookHeaders("k", body, "msg_1", 1_700_000_000);
    const given = { id: h["webhook-id"], timestamp: h["webhook-timestamp"], signature: h["webhook-signature"] };
    expect(verifyStandardWebhook("k", given, body, 1_700_000_000)).toEqual({ ok: true });
    expect(verifyStandardWebhook("k", { ...given, signature: `v1,bogus ${given.signature}` }, body, 1_700_000_000)).toEqual({ ok: true });
    expect(verifyStandardWebhook("other", given, body, 1_700_000_000).ok).toBe(false);
    expect(verifyStandardWebhook("k", given, `${body} `, 1_700_000_000).ok).toBe(false);
    expect(verifyStandardWebhook("k", { ...given, id: "msg_2" }, body, 1_700_000_000).ok).toBe(false);
    expect(verifyStandardWebhook("k", given, body, 1_700_000_000 + 301)).toEqual({ ok: false, reason: "The webhook-timestamp is more than 5 minutes off." });
    expect(verifyStandardWebhook("k", given, body, 1_700_000_000 - 301).ok).toBe(false);
    expect(verifyStandardWebhook("k", { id: "msg_1" }, body).ok).toBe(false);
    // A whsec_ key signs with its decoded bytes, as the Standard Webhooks libraries do.
    const key = Buffer.from("raw-key-bytes");
    const ws = standardWebhookHeaders(`whsec_${key.toString("base64")}`, body, "msg_x", 1_700_000_000);
    expect(ws["webhook-signature"]).toBe(`v1,${crypto.createHmac("sha256", key).update(`msg_x.1700000000.${body}`).digest("base64")}`);
  });
});

describe("where a notification may go", () => {
  it("knows what kind of place an address is", () => {
    expect(addressClass("127.0.0.1")).toBe("loopback");
    expect(addressClass("::1")).toBe("loopback");
    expect(addressClass("169.254.169.254")).toBe("link-local");
    expect(addressClass("fe80::1")).toBe("link-local");
    expect(addressClass("10.1.2.3")).toBe("private");
    expect(addressClass("172.20.0.4")).toBe("private");
    expect(addressClass("::ffff:192.168.1.1")).toBe("private");
    expect(addressClass("fd00::1")).toBe("private");
    expect(addressClass("0.0.0.0")).toBe("never");
    expect(addressClass("8.8.8.8")).toBe("public");
  });

  it("refuses what a shared server must not call, and fixes the address it checked", async () => {
    const lookup = (address: string) => async () => [{ address, family: 4 }];
    const server = { server: true, allowPrivate: false };
    await expect(guardUrl("ftp://x", server)).rejects.toThrow("Only http and https");
    await expect(guardUrl("https://user:pw@example.com/x", server)).rejects.toThrow("its own field");
    await expect(guardUrl("http://127.0.0.1:9/x", server)).rejects.toThrow("does not call itself");
    await expect(guardUrl("https://metadata.example/x", { ...server, lookup: lookup("169.254.169.254") })).rejects.toThrow("never calls");
    await expect(guardUrl("https://ntfy.lan/t", { ...server, lookup: lookup("10.0.0.7") })).rejects.toThrow("SSHS3_ALLOW_PRIVATE_ADDRESSES=1");
    await expect(guardUrl("http://example.com/x", { ...server, lookup: lookup("93.184.216.34") })).rejects.toThrow("has to be https");
    await expect(guardUrl("https://gone.example/x", { ...server, lookup: async () => { throw new Error("ENOTFOUND"); } })).rejects.toThrow("could not be found");

    expect(await guardUrl("http://ntfy.lan/t", { server: true, allowPrivate: true, lookup: lookup("10.0.0.7") })).toMatchObject({ address: "10.0.0.7", family: 4 });
    // On a person's own computer, their own machine and network are theirs to notify.
    expect((await guardUrl("http://127.0.0.1:8080/t", { server: false, allowPrivate: false })).address).toBe("127.0.0.1");
    await expect(guardUrl("http://169.254.169.254/latest", { server: false, allowPrivate: true })).rejects.toThrow("never calls");
  });

  it("tries again when the other side is down, and not when it refuses", async () => {
    const request = { url: "http://127.0.0.1:1/x", headers: {}, body: "{}" };
    const guard = { server: false, allowPrivate: false };
    const answers = [503, 200];
    const send = vi.fn(async () => answers.shift()!);
    expect(await deliver(request, guard, { send, sleep: async () => {} })).toEqual({ ok: true, status: 200 });
    expect(send).toHaveBeenCalledTimes(2);

    const refused = vi.fn(async () => 404);
    expect(await deliver(request, guard, { send: refused, sleep: async () => {} })).toMatchObject({ ok: false, status: 404 });
    expect(refused).toHaveBeenCalledTimes(1);

    const down = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    expect(await deliver(request, guard, { send: down, sleep: async () => {} })).toMatchObject({ ok: false, error: "ECONNREFUSED" });
    expect(down).toHaveBeenCalledTimes(3);
    expect(await deliver({ ...request, url: "nope" }, guard, { send })).toMatchObject({ ok: false, error: expect.stringContaining("not an address") });
  });
});

// ---- in the hub ---------------------------------------------------------------

interface Got { url: string; headers: http.IncomingHttpHeaders; body: string }
async function receiver(status: number | (() => number) = 200, location?: string): Promise<{ url: string; got: Got[] }> {
  const got: Got[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      got.push({ url: req.url ?? "", headers: req.headers, body });
      res.writeHead(typeof status === "function" ? status() : status, location ? { Location: location } : {}).end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  disposals.push(() => new Promise((r) => server.close(() => r(undefined))));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, got };
}
function memoryBucket(): QueueStore {
  const files = new Map<string, Buffer>();
  return {
    list: async (dir) => [...files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1)),
    read: async (p) => files.get(p),
    write: async (p, c) => void files.set(p, c),
    remove: async (p) => void files.delete(p),
  };
}
type Inner = {
  flushInbox: (now?: number) => Promise<void>;
  notifySettle: () => Promise<void>;
  notifyWaits: number[];
  workSyncStore?: WorkSync;
  s3Workspace: { canUseBucket: () => boolean };
};
async function makeHub(host: Record<string, unknown> = {}) {
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(false);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-notify-"));
  const hub = new HubService(
    { changed: () => {}, inventoryTargets: async () => [], backgroundChanged: async () => {}, openSchedule: async () => "s1", show: () => {}, aiConfigFilePath: path.join(dir, "ai.json"), ...host } as never,
    dir,
  );
  disposals.push(async () => { await hub.dispose(); setDemoModeForTesting(undefined); await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  await hub.initialize();
  const inner = hub as unknown as Inner;
  inner.notifySettle = async () => {};
  inner.notifyWaits = [];
  return { hub, inner, dir };
}
const waiting = (id = "t1", at = Date.now()): AgentTask =>
  ({
    id, title: "Fix the pool", agentName: "DBA", mode: "assisted", status: "waiting", messages: [], sources: [], createdAt: at, updatedAt: at, maxCommands: 10, maxMinutes: 15, verification: "not-verified",
    target: { sessionId: "s", generation: "g", label: "pg-01" },
    changes: [{ id: `${id}-c1`, kind: "command", target: "pg-01", description: "Restart pgbouncer", command: "systemctl restart pgbouncer", status: "pending", riskLevel: "modify", riskReason: "restarts a service", at }],
  }) as unknown as AgentTask;
const ALL = ["approval", "plan", "question", "blocked", "alert", "review", "report"] as const;

describe("notifications from the hub", () => {
  it("tells a channel once when an approval starts to wait, reminds once, and never shows the address", async () => {
    const { hub, inner, dir } = await makeHub();
    const slack = await receiver();
    const address = `${slack.url}/services/T0/B0/very-secret-path`;
    await hub.request({ action: "notify-settings-save", publicUrl: "https://sshs3.example.com/", reminderMinutes: 5 });
    await hub.request({ action: "configure", config: {}, preferences: { approvalWaitMinutes: 30 } } as never);
    let snap = await hub.request({ action: "notify-channel-save", channel: { kind: "slack", name: "ops", url: address, enabled: true, events: [...ALL], includeCommand: true } });
    expect(snap.notifications).toMatchObject({ publicUrl: "https://sshs3.example.com", publicUrlFixed: false, reminderMinutes: 5, channels: [{ kind: "slack", name: "ops", host: new URL(slack.url).host, enabled: true }] });
    expect(JSON.stringify(snap)).not.toContain("very-secret-path");

    hub.store.data.tasks.push(waiting());
    await inner.flushInbox();
    expect(slack.got).toHaveLength(1);
    expect(slack.got[0].url).toBe("/services/T0/B0/very-secret-path");
    const text = (JSON.parse(slack.got[0].body) as { blocks: Array<{ text?: { text: string }; elements?: Array<{ url: string }> }> }).blocks;
    expect(text[0].text!.text).toContain("Approval needed — DBA on pg-01");
    expect(text[0].text!.text).toContain("systemctl restart pgbouncer");
    expect(text[0].text!.text).toContain("The agent waits 30 min.");
    expect(text[1].elements![0].url).toBe("https://sshs3.example.com/?view=Inbox&item=approval%3At1-c1");

    await inner.flushInbox();
    expect(slack.got).toHaveLength(1);
    await inner.flushInbox(Date.now() + 6 * MIN);
    expect(slack.got).toHaveLength(2);
    expect(slack.got[1].body).toContain("Still waiting: Approval needed");
    await inner.flushInbox(Date.now() + 12 * MIN);
    expect(slack.got).toHaveLength(2);

    snap = await hub.snapshot();
    expect(snap.notifications!.channels[0].last).toMatchObject({ ok: true, status: 200 });
    await hub.store.save();
    expect(await fs.readFile(path.join(dir, "hub.json"), "utf8")).not.toContain("very-secret-path");
    // The address is kept, and comes back after a restart, without being in what the interface gets.
    expect(await fs.readFile(path.join(dir, "notify.json"), "utf8")).toContain("ops");
    const mode = (await fs.stat(path.join(dir, "notify.json"))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("does not push what already waited when a channel is added, and tests a channel on request", async () => {
    const { hub, inner } = await makeHub();
    hub.store.data.tasks.push(waiting());
    const hook = await receiver();
    const snap = await hub.request({ action: "notify-channel-save", channel: { kind: "webhook", name: "siem", url: `${hook.url}/in`, secret: "k", enabled: true, events: [...ALL], includeCommand: false } });
    await inner.flushInbox();
    expect(hook.got).toHaveLength(0);

    const tested = await hub.request({ action: "notify-channel-test", id: snap.notifications!.channels[0].id });
    expect(tested.reply!.notifyTest).toEqual({ ok: true, status: 200 });
    expect(hook.got).toHaveLength(1);
    expect(hook.got[0].headers["x-sshs3-signature"]).toBe(`sha256=${crypto.createHmac("sha256", "k").update(hook.got[0].body).digest("hex")}`);
    expect(JSON.parse(hook.got[0].body).title).toBe("A test from sshs3");

    // Keeps the address when the form is saved without one; refuses a wrong one in words a person can act on.
    const again = await hub.request({ action: "notify-channel-save", channel: { id: snap.notifications!.channels[0].id, kind: "webhook", name: "siem 2", enabled: false, events: ["alert"], includeCommand: false } });
    expect(again.notifications!.channels).toMatchObject([{ name: "siem 2", enabled: false, hasSecret: true, events: ["alert"] }]);
    await expect(hub.request({ action: "notify-channel-save", channel: { kind: "ntfy", name: "n", url: "http://127.0.0.1:9", enabled: true, events: [...ALL], includeCommand: true } })).rejects.toThrow("ends with the topic");
    await expect(hub.request({ action: "notify-channel-save", channel: { kind: "slack", name: "n", url: "http://169.254.169.254/x", enabled: true, events: [...ALL], includeCommand: true } })).rejects.toThrow("never calls");
    expect((await hub.request({ action: "notify-channel-delete", id: snap.notifications!.channels[0].id })).notifications!.channels).toEqual([]);
  });

  it("does not follow a redirect and reports a channel that refuses", async () => {
    const { hub, inner } = await makeHub();
    const hop = await receiver(302, "http://169.254.169.254/latest/meta-data");
    await hub.request({ action: "notify-channel-save", channel: { kind: "webhook", name: "hop", url: `${hop.url}/in`, enabled: true, events: [...ALL], includeCommand: true } });
    hub.store.data.tasks.push(waiting());
    await inner.flushInbox();
    expect(hop.got).toHaveLength(1);
    expect((await hub.snapshot()).notifications!.channels[0].last).toMatchObject({ ok: false, status: 302 });
  });

  it("on a shared server, never sends to the server itself and says whose answer is awaited", async () => {
    const { hub } = await makeHub({ alertHookOwner: "u1", defaultActorName: "Jacob" });
    const local = await receiver();
    await expect(hub.request({ action: "notify-channel-save", channel: { kind: "slack", name: "x", url: `${local.url}/x`, enabled: true, events: [...ALL], includeCommand: true } })).rejects.toThrow("does not call itself");
    vi.stubEnv("SSHS3_PUBLIC_URL", "https://team.example.com");
    const snap = await hub.request({ action: "notify-settings-save", publicUrl: "https://evil.example.com" });
    expect(snap.notifications).toMatchObject({ publicUrl: "https://team.example.com", publicUrlFixed: true });
  });

  it("tells a shared channel once about a ticket that two installations both see", async () => {
    const hook = await receiver();
    const bucket = memoryBucket();
    const review: WorkTicket = { id: "tk1", title: "Rotate certificates", description: "", status: "review", assigneeName: "SRE", statusAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now() } as WorkTicket;
    const hubs = [await makeHub(), await makeHub()];
    for (const { hub, inner } of hubs) {
      inner.s3Workspace.canUseBucket = () => true;
      inner.workSyncStore = new WorkSync(bucket);
      await hub.request({ action: "notify-channel-save", channel: { kind: "webhook", name: "team", url: `${hook.url}/in`, enabled: true, events: [...ALL], includeCommand: true } });
      hub.store.data.workTickets = [review];
      // An approval is this installation's own: both may tell about theirs.
      hub.store.data.tasks.push(waiting(`own-${hubs.indexOf(hubs.find((h) => h.hub === hub)!)}`));
    }
    await Promise.all(hubs.map(({ inner }) => inner.flushInbox()));
    const ids = hook.got.flatMap((g) => (JSON.parse(g.body) as { items: Array<{ id: string }> }).items.map((i) => i.id));
    expect(ids.filter((id) => id === "review:tk1")).toHaveLength(1);
    expect(ids.filter((id) => id.startsWith("approval:"))).toHaveLength(2);

    // The ticket goes back and comes to review again: that is a new event, told once more.
    for (const { hub, inner } of hubs) {
      hub.store.data.workTickets = [];
      await inner.flushInbox();
      hub.store.data.workTickets = [{ ...review, statusAt: review.statusAt! + 5000 }];
    }
    await Promise.all(hubs.map(({ inner }) => inner.flushInbox()));
    const after = hook.got.flatMap((g) => (JSON.parse(g.body) as { items: Array<{ id: string }> }).items.map((i) => i.id));
    expect(after.filter((id) => id === "review:tk1")).toHaveLength(2);
  });

  it("sends nothing in demo mode, and notices a change made while a save is pending", async () => {
    const { hub, inner } = await makeHub();
    const hook = await receiver();
    await hub.request({ action: "notify-channel-save", channel: { kind: "webhook", name: "h", url: `${hook.url}/in`, enabled: true, events: [...ALL], includeCommand: true } });
    const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
    setDemoModeForTesting(true);
    hub.store.data.tasks.push(waiting("demo"));
    await inner.flushInbox();
    expect(hook.got).toHaveLength(0);
    setDemoModeForTesting(false);

    hub.changed(); // a save is now pending
    hub.store.data.tasks.push(waiting("late"));
    hub.changed(); // must still reach the inbox
    await vi.waitFor(() => expect(hook.got.length).toBeGreaterThan(0), { timeout: 6000, interval: 100 });
    expect(hook.got[0].body).toContain("approval:late-c1");
  }, 12_000);
});

describe("waiting for a person", () => {
  it("gives the time spent waiting back to the run, so a late approval still finds it alive", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { ToolBroker } = await import("../../src/main/ai/hub/ToolBroker");
    const waited: number[] = [];
    const broker = new ToolBroker({} as never, {
      context: async () => ({ ok: true }),
      memory: async () => ({}),
      file: async () => ({}),
      changed: () => {},
      approvalWaitMs: () => 30 * MIN,
      waited: (_task, ms) => waited.push(ms),
    });
    disposals.push(() => (broker as unknown as { dispose?: () => unknown }).dispose?.());
    const task = { ...waiting("b1"), status: "running", changes: [] } as unknown as AgentTask;
    const { key } = await broker.issue(task);
    const change = { id: "x1", kind: "command", target: "pg-01", description: "d", status: "pending", at: Date.now() } as never;
    const asked = broker.askApproval(task, change);
    await vi.advanceTimersByTimeAsync(20 * MIN); // longer than the run's 15 minutes
    broker.approve(task.id, "x1", true);
    expect(await asked).toBe(true);
    expect(waited).toEqual([20 * MIN]);
    // The capability moved with the wait: it is still good.
    expect(await broker.invoke(key, { action: "context" } as never)).toEqual({ ok: true });

    // And with nobody answering, it gives up after the wait that was set.
    const second = broker.askApproval(task, { id: "x2", kind: "command", target: "pg-01", description: "d", status: "pending", at: Date.now() } as never);
    await vi.advanceTimersByTimeAsync(31 * MIN);
    expect(await second).toBe(false);
  });
});
