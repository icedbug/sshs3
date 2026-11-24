import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChatBridge } from "../../src/main/ai/hub/ChatBridge";
import type { ChatRequest, ChatTransport } from "../../src/main/ai/hub/ChatSources";

/** The context bot's upkeep: what it asks the service again, how often, and what it does with the answer. */

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const NOW = Date.parse("2026-11-12T12:00:00Z");
const MIN = 60_000;
const ts = (ms: number): string => (ms / 1000).toFixed(6);

interface SlackMsg {
  ts: string;
  user: string;
  text: string;
  thread_ts?: string;
  reply_count?: number;
  latest_reply?: string;
}

/** A Slack with one channel the bot is in, whose answers a test can change. */
function fakeSlack() {
  const messages: SlackMsg[] = [];
  const asked: ChatRequest[] = [];
  const state = { listFails: false, retryAfter: 0 };
  const transport: ChatTransport = async (r) => {
    asked.push(r);
    const url = new URL(r.url);
    const q = url.searchParams;
    const ok = (body: Record<string, unknown>) => ({ status: 200, body: JSON.stringify({ ok: true, ...body }) });
    switch (url.pathname) {
      case "/api/auth.test":
        return ok({ url: "https://acme.slack.com/", team: "Acme", user: "sshs3-bot" });
      case "/api/users.conversations":
        if (state.retryAfter) return { status: 429, body: "{}", headers: { "retry-after": String(state.retryAfter) } };
        if (state.listFails) return { status: 500, body: "{}" };
        return ok({ channels: [{ id: "C1", name: "ops" }] });
      case "/api/users.info":
        return ok({ user: { profile: { display_name: "Sara" } } });
      case "/api/conversations.history": {
        const list = messages
          .filter((m) => !m.thread_ts || m.thread_ts === m.ts)
          .filter((m) => Number(m.ts) > Number(q.get("oldest")) && (!q.get("latest") || Number(m.ts) < Number(q.get("latest"))))
          .sort((a, b) => Number(b.ts) - Number(a.ts));
        // Two hundred at a time, as Slack gives them.
        const from = Number(q.get("cursor") ?? 0);
        const rest = list.length > from + 200;
        return ok({ messages: list.slice(from, from + 200), has_more: rest, response_metadata: { next_cursor: rest ? String(from + 200) : "" } });
      }
      case "/api/conversations.replies":
        return ok({ messages: messages.filter((m) => (m.ts === q.get("ts") || m.thread_ts === q.get("ts")) && Number(m.ts) > Number(q.get("oldest"))) });
      default:
        return { status: 404, body: "{}" };
    }
  };
  const say = (at: number, text: string, thread?: string): string => {
    const id = ts(at);
    messages.push({ ts: id, user: "U1", text, ...(thread ? { thread_ts: thread } : {}) });
    if (thread) {
      const parent = messages.find((m) => m.ts === thread)!;
      parent.reply_count = (parent.reply_count ?? 0) + 1;
      parent.latest_reply = id;
      parent.thread_ts = thread;
    }
    return id;
  };
  const lists = (): number => asked.filter((r) => r.url.includes("users.conversations")).length;
  return { messages, asked, state, transport, say, lists };
}

async function connected() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-chat-upkeep-"));
  dirs.push(dir);
  const bridge = new ChatBridge(dir, { guard: () => ({ server: false, allowPrivate: true }) });
  const slack = fakeSlack();
  bridge.transport = slack.transport;
  await bridge.load();
  await bridge.save({ service: "slack", token: "xoxb-good", enabled: true });
  expect(await bridge.test("slack", NOW)).toMatchObject({ ok: true, channels: 1 });
  await bridge.select("slack", "C1", true);
  return { bridge, slack, dir };
}

describe("the list of the bot's channels", () => {
  it("is not asked for again at every tick while it fails: the wait doubles, up to an hour", async () => {
    const { bridge, slack } = await connected();
    await bridge.tick(NOW);
    const base = slack.lists();
    // Half an hour later the list is due, and the service fails.
    slack.state.listFails = true;
    let at = NOW + 31 * MIN;
    await bridge.tick(at);
    expect(slack.lists()).toBe(base + 1);
    // The hub ticks every ten seconds. For two minutes nothing more is asked.
    for (let s = 10; s < 120; s += 10) await bridge.tick(at + s * 1000);
    expect(slack.lists()).toBe(base + 1);
    // Then once more, and then not for four minutes, then eight.
    const waits = [2, 4, 8, 16, 32, 60, 60];
    let expected = base + 1;
    for (const wait of waits) {
      await bridge.tick(at + wait * MIN - 1000);
      expect(slack.lists(), `just before ${wait} minutes`).toBe(expected);
      at += wait * MIN;
      await bridge.tick(at);
      expected++;
      expect(slack.lists(), `after ${wait} minutes`).toBe(expected);
    }
    // It answers again: the list is taken, and is next due in half an hour as before.
    slack.state.listFails = false;
    at += 60 * MIN;
    await bridge.tick(at);
    expect(slack.lists()).toBe(expected + 1);
    for (let m = 1; m <= 29; m += 7) await bridge.tick(at + m * MIN);
    expect(slack.lists()).toBe(expected + 1);
    await bridge.tick(at + 31 * MIN);
    expect(slack.lists()).toBe(expected + 2);
  });

  it("waits as long as the service says, and is asked at once when a person tests the connection", async () => {
    const { bridge, slack } = await connected();
    await bridge.tick(NOW);
    const base = slack.lists();
    slack.state.retryAfter = 600;
    const at = NOW + 31 * MIN;
    await bridge.tick(at);
    expect(slack.lists()).toBe(base + 1);
    await bridge.tick(at + 9 * MIN);
    expect(slack.lists()).toBe(base + 1);
    // A person presses Test: that asks now, whatever the wait.
    slack.state.retryAfter = 0;
    expect(await bridge.test("slack", at + 9 * MIN)).toMatchObject({ ok: true });
    expect(slack.lists()).toBe(base + 2);
    // And the wait is over with it.
    await bridge.tick(at + 9 * MIN + 31 * MIN);
    expect(slack.lists()).toBe(base + 3);
  });

  it("is said to have failed until it is read again, also while the channels themselves answer", async () => {
    const { bridge, slack } = await connected();
    await bridge.tick(NOW);
    const error = (): string | undefined => bridge.view().find((c) => c.service === "slack")?.lastError;
    slack.state.listFails = true;
    // The list fails and the channel is read in the same round: the list's failure stays.
    let at = NOW + 31 * MIN;
    slack.say(at - MIN, "disk is full on db-1");
    await bridge.tick(at);
    expect(slack.asked.some((r) => r.url.includes("conversations.history"))).toBe(true);
    expect(error()).toBeTruthy();
    // And in the rounds after it, while the list waits to be asked again.
    at += 6 * MIN;
    await bridge.tick(at);
    expect(error()).toBeTruthy();
    // The list answers again: the failure is gone.
    slack.state.listFails = false;
    at += 60 * MIN;
    await bridge.tick(at);
    expect(error()).toBeUndefined();
  });
});

const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Everything on the disk under a folder, as one text. */
async function onDisk(dir: string): Promise<string> {
  const files = (await fs.readdir(dir, { recursive: true, withFileTypes: true })).filter((f) => f.isFile());
  return (await Promise.all(files.map((f) => fs.readFile(path.join(f.parentPath, f.name), "utf8")))).join("\n");
}

describe("a message that was edited or deleted in Slack", () => {
  it("takes its new words here, and is removed here, when the last two days are looked over again", async () => {
    const { bridge, slack, dir } = await connected();
    const mistake = slack.say(NOW - 3 * HOUR, "the customer list is at http://intra/customers.xlsx, call Mr Olsson on 070-1234567");
    const typo = slack.say(NOW - 2 * HOUR, "restart pg-01 at ten");
    const kept = slack.say(NOW - HOUR, "ceph is nearfull again");
    await bridge.tick(NOW);
    expect(bridge.search({ query: "Olsson customers" }, NOW)).toHaveLength(1);
    expect(await onDisk(dir)).toContain("Mr Olsson");

    // The author deletes the one and corrects the other.
    slack.messages.splice(slack.messages.findIndex((m) => m.ts === mistake), 1);
    slack.messages.find((m) => m.ts === typo)!.text = "restart pg-02 at eleven";
    // Before the stretch is looked over again (ten minutes), nothing has been asked.
    await bridge.tick(NOW + 3 * MIN);
    expect(bridge.search({ query: "Olsson customers" }, NOW)).toHaveLength(1);
    await bridge.tick(NOW + 11 * MIN);
    expect(bridge.search({ query: "Olsson customers" }, NOW)).toEqual([]);
    expect(bridge.thread("slack", "C1", mistake)).toEqual([]);
    expect(bridge.thread("slack", "C1", typo).map((m) => m.text)).toEqual(["restart pg-02 at eleven"]);
    expect(bridge.thread("slack", "C1", kept).map((m) => m.text)).toEqual(["ceph is nearfull again"]);
    expect(bridge.view()[0].channels[0].count).toBe(2);
    // Not on the disk either, and not after the next start.
    const disk = await onDisk(dir);
    expect(disk).not.toContain("Mr Olsson");
    expect(disk).not.toContain("at ten");
    expect(disk).toContain("restart pg-02 at eleven");
    const again = new ChatBridge(dir, { guard: () => ({ server: false, allowPrivate: true }) });
    await again.load();
    expect(again.search({ query: "Olsson customers" }, NOW)).toEqual([]);
    expect(again.thread("slack", "C1", typo).map((m) => m.text)).toEqual(["restart pg-02 at eleven"]);
  });

  it("covers a thread's replies too, when the thread is next asked for them", async () => {
    const { bridge, slack } = await connected();
    const root = slack.say(NOW - 5 * HOUR, "pg-01 is slow, anyone?");
    const wrong = slack.say(NOW - 4 * HOUR, "the door code is 4711 and the alarm is off", root);
    const fixed = slack.say(NOW - 3 * HOUR, "restarting it", root);
    await bridge.tick(NOW);
    expect(bridge.thread("slack", "C1", root).map((m) => m.text)).toEqual(["pg-01 is slow, anyone?", "the door code is 4711 and the alarm is off", "restarting it"]);
    slack.messages.splice(slack.messages.findIndex((m) => m.ts === wrong), 1);
    slack.messages.find((m) => m.ts === fixed)!.text = "restarted it, fixed";
    await bridge.tick(NOW + 11 * MIN);
    expect(bridge.thread("slack", "C1", root).map((m) => m.text)).toEqual(["pg-01 is slow, anyone?", "restarted it, fixed"]);
  });

  it("is left as it was read once it is older than two days: the stretch looked over again ends there", async () => {
    const { bridge, slack } = await connected();
    const old = slack.say(NOW - 3 * DAY, "an old decision about the proxy");
    await bridge.tick(NOW);
    slack.messages.splice(slack.messages.findIndex((m) => m.ts === old), 1);
    await bridge.tick(NOW + 11 * MIN);
    expect(bridge.thread("slack", "C1", old).map((m) => m.text)).toEqual(["an old decision about the proxy"]);
  });

  it("is not taken for deleted when the stretch could not be read whole", async () => {
    const { bridge, slack } = await connected();
    // More in two days than one look takes (400): the look is not the whole stretch.
    for (let i = 0; i < 450; i++) slack.say(NOW - DAY + i * 1000, `line ${i} about nothing`);
    const victim = slack.say(NOW - 2 * HOUR, "this one is deleted later");
    await bridge.tick(NOW);
    await bridge.tick(NOW + 3 * MIN);
    slack.messages.splice(slack.messages.findIndex((m) => m.ts === victim), 1);
    await bridge.tick(NOW + 14 * MIN);
    expect(bridge.thread("slack", "C1", victim)).toHaveLength(1);
  });
});

/** A Mattermost with one team and one channel the bot is in. Posts can be edited and deleted by a test. */
function fakeMattermost() {
  const TEAM = "teamteamteamteamteamteam01";
  const CHANNEL = "chanchanchanchanchanchan01";
  const USER = "useruseruseruseruseruser01";
  const posts: { id: string; create_at: number; delete_at?: number; message: string; root_id?: string }[] = [];
  let n = 0;
  const transport: ChatTransport = async (r) => {
    const url = new URL(r.url);
    const p = url.pathname.replace(/^\/api\/v4/, "");
    const ok = (body: unknown) => ({ status: 200, body: JSON.stringify(body) });
    const shown = (list: typeof posts) => ({ order: list.map((x) => x.id), posts: Object.fromEntries(list.map((x) => [x.id, { ...x, channel_id: CHANNEL, user_id: USER }])) });
    if (p === "/users/me") return ok({ username: "sshs3-bot" });
    if (p === "/users/me/teams") return ok([{ id: TEAM, name: "acme" }]);
    if (p === `/users/me/teams/${TEAM}/channels`) return ok([{ id: CHANNEL, name: "ops", display_name: "ops", type: "O" }]);
    if (p === "/users/ids") return ok([{ id: USER, username: "sara" }]);
    if (p === `/channels/${CHANNEL}/posts`) {
      const page = Number(url.searchParams.get("page") ?? 0);
      const per = Number(url.searchParams.get("per_page") ?? 200);
      return ok(shown([...posts].sort((a, b) => b.create_at - a.create_at).slice(page * per, page * per + per)));
    }
    const thread = /^\/posts\/([a-z0-9]+)\/thread$/.exec(p)?.[1];
    if (thread) {
      const list = posts.filter((x) => x.id === thread || x.root_id === thread);
      return list.length ? ok(shown(list)) : { status: 404, body: "{}" };
    }
    return { status: 404, body: "{}" };
  };
  const say = (at: number, message: string, root?: string): string => {
    const id = `post${String(++n).padStart(22, "0")}`;
    posts.push({ id, create_at: at, message, ...(root ? { root_id: root } : {}) });
    return id;
  };
  return { posts, transport, say, CHANNEL };
}

describe("a message that was edited or deleted in Mattermost", () => {
  it("is brought in line the same way, replies included", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-chat-upkeep-mm-"));
    dirs.push(dir);
    const bridge = new ChatBridge(dir, { guard: () => ({ server: false, allowPrivate: true, allowPlainHttp: true, lookup: async () => [{ address: "93.184.216.34", family: 4 }] }) });
    const mm = fakeMattermost();
    bridge.transport = mm.transport;
    await bridge.load();
    await bridge.save({ service: "mattermost", baseUrl: "https://chat.example.com", token: "mm-bot-token", enabled: true });
    expect(await bridge.test("mattermost", NOW)).toMatchObject({ ok: true, channels: 1 });
    await bridge.select("mattermost", mm.CHANNEL, true);
    const root = mm.say(NOW - 5 * HOUR, "who has the staging database password?");
    const leak = mm.say(NOW - 4 * HOUR, "the door code is 4711 and the alarm is off", root);
    const answer = mm.say(NOW - 3 * HOUR, "it is in the valut", root);
    await bridge.tick(NOW);
    expect(bridge.thread("mattermost", mm.CHANNEL, root).map((m) => m.text)).toEqual(["who has the staging database password?", "the door code is 4711 and the alarm is off", "it is in the valut"]);

    // Deleted in Mattermost is a mark on the post; edited is the post's new text.
    mm.posts.find((x) => x.id === leak)!.delete_at = NOW;
    mm.posts.find((x) => x.id === answer)!.message = "it is in the vault";
    await bridge.tick(NOW + 11 * MIN);
    expect(bridge.thread("mattermost", mm.CHANNEL, root).map((m) => m.text)).toEqual(["who has the staging database password?", "it is in the vault"]);
    expect(await onDisk(dir)).not.toContain("4711");
  });

  it("is removed at once from a thread the agent bot asks for whole, whatever its age", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-chat-upkeep-mm-"));
    dirs.push(dir);
    const bridge = new ChatBridge(dir, { guard: () => ({ server: false, allowPrivate: true, allowPlainHttp: true, lookup: async () => [{ address: "93.184.216.34", family: 4 }] }) });
    const mm = fakeMattermost();
    bridge.transport = mm.transport;
    await bridge.load();
    await bridge.save({ service: "mattermost", baseUrl: "https://chat.example.com", token: "mm-bot-token", enabled: true });
    await bridge.test("mattermost", NOW);
    await bridge.select("mattermost", mm.CHANNEL, true);
    const old = mm.say(NOW - 5 * DAY, "an old thread");
    const oldReply = mm.say(NOW - 5 * DAY + MIN, "with a reply that is deleted later", old);
    await bridge.tick(NOW);
    expect(bridge.thread("mattermost", mm.CHANNEL, old)).toHaveLength(2);
    mm.posts.find((x) => x.id === oldReply)!.delete_at = NOW;
    // The look over the last two days does not reach it.
    await bridge.tick(NOW + 11 * MIN);
    expect(bridge.thread("mattermost", mm.CHANNEL, old)).toHaveLength(2);
    expect((await bridge.readThreadNow("mattermost", mm.CHANNEL, old))!.map((m) => m.text)).toEqual(["an old thread"]);
  });
});
