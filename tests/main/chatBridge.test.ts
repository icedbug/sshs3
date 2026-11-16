import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChatBridge, CHAT_READ_INTERVAL_MS } from "../../src/main/ai/hub/ChatBridge";
import type { ChatRequest, ChatTransport } from "../../src/main/ai/hub/ChatSources";

/** The team's bot: what it is allowed to read, how it reads, and what it keeps. */

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const NOW = Date.parse("2026-11-12T12:00:00Z");
const ts = (ms: number): string => (ms / 1000).toFixed(6);

interface SlackMsg {
  ts: string;
  user: string;
  text: string;
  thread_ts?: string;
  reply_count?: number;
  latest_reply?: string;
}

/** A Slack with channels and messages, that remembers what it was asked. */
function fakeSlack() {
  const channels: { id: string; name: string; is_private?: boolean; member: boolean }[] = [
    { id: "C1", name: "ops", member: true },
    { id: "C2", name: "random", member: true },
    { id: "C3", name: "management", is_private: true, member: false },
  ];
  const messages: Record<string, SlackMsg[]> = { C1: [], C2: [], C3: [] };
  const asked: ChatRequest[] = [];
  let limited = 0;
  const say = (channel: string, at: number, text: string, thread?: string): string => {
    const id = ts(at);
    messages[channel].push({ ts: id, user: "U1", text, ...(thread ? { thread_ts: thread } : {}) });
    if (thread) {
      const parent = messages[channel].find((m) => m.ts === thread)!;
      parent.reply_count = (parent.reply_count ?? 0) + 1;
      parent.latest_reply = id;
      parent.thread_ts = thread;
    }
    return id;
  };
  const transport: ChatTransport = async (r) => {
    asked.push(r);
    const url = new URL(r.url);
    const q = url.searchParams;
    const ok = (body: Record<string, unknown>) => ({ status: 200, body: JSON.stringify({ ok: true, ...body }) });
    if (r.headers.Authorization !== "Bearer xoxb-good") return { status: 200, body: JSON.stringify({ ok: false, error: "invalid_auth" }) };
    if (limited > 0) {
      limited--;
      return { status: 429, body: "{}", headers: { "retry-after": "45" } };
    }
    switch (url.pathname) {
      case "/api/auth.test":
        return ok({ url: "https://acme.slack.com/", team: "Acme", user: "sshs3-bot" });
      case "/api/users.conversations":
        return ok({ channels: channels.filter((c) => c.member) });
      case "/api/users.info":
        return ok({ user: { profile: { display_name: "Sara" } } });
      case "/api/conversations.history": {
        const list = messages[q.get("channel")!]
          .filter((m) => !m.thread_ts || m.thread_ts === m.ts)
          .filter((m) => Number(m.ts) > Number(q.get("oldest")) && (!q.get("latest") || Number(m.ts) < Number(q.get("latest"))))
          .sort((a, b) => Number(b.ts) - Number(a.ts));
        const from = Number(q.get("cursor") ?? 0);
        const rest = list.length > from + 200;
        return ok({ messages: list.slice(from, from + 200), has_more: rest, response_metadata: { next_cursor: rest ? String(from + 200) : "" } });
      }
      case "/api/conversations.replies":
        return ok({ messages: messages[q.get("channel")!].filter((m) => (m.ts === q.get("ts") || m.thread_ts === q.get("ts")) && Number(m.ts) > Number(q.get("oldest"))) });
      default:
        return { status: 404, body: "{}" };
    }
  };
  return { channels, messages, say, transport, asked, limit: (n: number) => (limited = n) };
}

async function bridge() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-chatbridge-"));
  dirs.push(dir);
  const made = new ChatBridge(dir, { guard: () => ({ server: false, allowPrivate: true }) });
  const slack = fakeSlack();
  made.transport = slack.transport;
  await made.load();
  return { dir, bridge: made, slack };
}

async function connected() {
  const made = await bridge();
  await made.bridge.save({ service: "slack", token: "xoxb-good", enabled: true });
  expect(await made.bridge.test("slack", NOW)).toEqual({ ok: true, bot: "sshs3-bot", workspace: "Acme", channels: 2 });
  return made;
}

describe("connecting the bot", () => {
  it("takes a bot token only, keeps it out of what the interface is told, and offers the channels the bot is in", async () => {
    const { bridge: b, dir } = await bridge();
    await expect(b.save({ service: "slack", token: "xoxp-a-persons-token", enabled: true })).rejects.toThrow("That does not look like a Slack bot token");
    await expect(b.save({ service: "slack", enabled: true })).rejects.toThrow("The bot's token is needed.");
    await b.save({ service: "slack", token: "xoxb-good", enabled: true });
    await b.test("slack");
    const [view] = b.view();
    expect(view).toMatchObject({ service: "slack", hasToken: true, bot: "sshs3-bot", workspace: "Acme" });
    expect(view.channels.map((c) => [c.name, c.selected])).toEqual([["ops", false], ["random", false]]);
    expect(JSON.stringify(b.view())).not.toContain("xoxb-good");
    if (process.platform !== "win32") expect((await fs.stat(path.join(dir, "connections.json"))).mode & 0o777).toBe(0o600);

    const wrong = await bridge();
    await wrong.bridge.save({ service: "slack", token: "xoxb-bad", enabled: true });
    expect(await wrong.bridge.test("slack")).toMatchObject({ ok: false, error: expect.stringContaining("Slack refused the token") });
  });

  it("reads nothing until a channel is chosen, and cannot be made to read one the bot is not in", async () => {
    const { bridge: b, slack } = await connected();
    slack.say("C1", NOW - 60_000, "pg-01 is slow");
    const before = slack.asked.length;
    await b.tick(NOW);
    expect(slack.asked.slice(before).filter((r) => r.url.includes("conversations.history"))).toEqual([]);
    expect(b.active()).toBe(false);
    await expect(b.select("slack", "C3", true)).rejects.toThrow("The bot is not in that channel.");
  });
});

describe("reading", () => {
  it("takes the last ninety days of a chosen channel, then only what is new, and never a message twice", async () => {
    const { bridge: b, slack } = await connected();
    slack.say("C1", NOW - 100 * 86_400_000, "older than the first read");
    slack.say("C1", NOW - 10 * 86_400_000, "ceph nearfull last week");
    slack.say("C1", NOW - 60_000, "pg-01 is slow");
    slack.say("C2", NOW - 60_000, "lunch?");
    expect(await b.select("slack", "C1", true)).toEqual({ target: "Slack #ops", what: "Team chat: the channel is now read and kept" });
    await b.tick(NOW);
    expect(b.view()[0].channels.find((c) => c.name === "ops")).toMatchObject({ selected: true, count: 2, lastReadAt: NOW, readingBack: false });
    expect(b.view()[0].channels.find((c) => c.name === "random")).toMatchObject({ count: 0 });
    expect(b.active()).toBe(true);

    // Not due yet: nothing is asked.
    const calls = slack.asked.length;
    await b.tick(NOW + 30_000);
    expect(slack.asked).toHaveLength(calls);

    slack.say("C1", NOW + 60_000, "restarted pgbouncer");
    await b.tick(NOW + CHAT_READ_INTERVAL_MS);
    await b.tick(NOW + 2 * CHAT_READ_INTERVAL_MS);
    expect(b.view()[0].channels.find((c) => c.name === "ops")!.count).toBe(3);
    expect(b.search({ query: "pgbouncer" }, NOW).map((h) => h.messages.map((m) => `${m.author}: ${m.text}`))).toEqual([["Sara: restarted pgbouncer"]]);
    expect(b.search({ query: "lunch" })).toEqual([]);
  });

  it("goes back in stretches through a busy channel without skipping, and further back when asked", async () => {
    const { bridge: b, slack } = await connected();
    for (let i = 0; i < 1500; i++) slack.say("C1", NOW - 80 * 86_400_000 + i * 60_000, `message ${i}`);
    slack.say("C1", NOW - 200 * 86_400_000, "from long ago");
    await b.select("slack", "C1", true);
    await b.tick(NOW);
    expect(b.view()[0].channels[0]).toMatchObject({ readingBack: false, count: 1500 });

    await b.readBack("slack", "C1", 365);
    expect(b.view()[0].channels[0].readingBack).toBe(true);
    await b.tick(NOW + 1000);
    expect(b.view()[0].channels[0]).toMatchObject({ readingBack: false, count: 1501 });
    expect(b.search({ query: "long ago" })).toHaveLength(1);
  });

  it("keeps a thread together, also when a reply comes to an earlier message", async () => {
    const { bridge: b, slack } = await connected();
    const question = slack.say("C1", NOW - 3600_000, "why is replication lagging on pg-02");
    await b.select("slack", "C1", true);
    await b.tick(NOW);
    slack.say("C1", NOW + 60_000, "the WAL disk was full, cleaned it up", question);
    // Looked over again after ten minutes: the message that has got a reply since is found.
    await b.tick(NOW + 11 * 60_000);
    const [hit] = b.search({ query: "WAL disk" }, NOW);
    expect(hit.messages.map((m) => m.text)).toEqual(["why is replication lagging on pg-02", "the WAL disk was full, cleaned it up"]);
    expect(b.thread("slack", "C1", question)).toHaveLength(2);
  });

  it("waits when the service asks it to, says why a channel failed, and stops reading a channel the bot left", async () => {
    const { bridge: b, slack } = await connected();
    slack.say("C1", NOW - 60_000, "hello");
    await b.select("slack", "C1", true);
    slack.limit(1);
    await b.tick(NOW);
    expect(b.view()[0].channels[0]).toMatchObject({ count: 0, error: expect.stringContaining("Slack asked for a pause") });
    const calls = slack.asked.length;
    await b.tick(NOW + 30_000);
    expect(slack.asked).toHaveLength(calls);
    await b.tick(NOW + 46_000);
    expect(b.view()[0].channels[0]).toMatchObject({ count: 1, error: undefined });

    slack.channels[0].member = false;
    await b.tick(NOW + 46_000 + 31 * 60_000);
    expect(b.view()[0].channels.find((c) => c.name === "ops")).toMatchObject({ selected: false, count: 1, error: "The bot is no longer in this channel." });
  });
});

describe("what is kept", () => {
  it("survives a restart, is forgotten on request, and goes with the connection only when asked", async () => {
    const { bridge: b, slack, dir } = await connected();
    slack.say("C1", NOW - 60_000, "pg-01 is slow");
    slack.say("C2", NOW - 60_000, "lunch?");
    await b.select("slack", "C1", true);
    await b.select("slack", "C2", true);
    await b.tick(NOW);

    const again = new ChatBridge(dir, { guard: () => ({ server: false, allowPrivate: true }) });
    await again.load();
    expect(again.view()[0]).toMatchObject({ hasToken: true, bot: "sshs3-bot" });
    expect(again.search({ query: "pg-01" })).toHaveLength(1);

    expect(await b.forget("slack", "C1")).toEqual({ target: "Slack #ops", what: "Team chat: everything read from the channel was removed" });
    expect(b.search({ query: "pg-01" })).toEqual([]);
    expect(b.view()[0].channels.find((c) => c.name === "ops")).toMatchObject({ selected: false, count: 0 });

    await b.disconnect("slack", false);
    expect(b.view()).toEqual([]);
    expect(b.search({ query: "lunch" })).toHaveLength(1);
    await b.save({ service: "slack", token: "xoxb-good", enabled: true });
    await b.disconnect("slack", true);
    expect(b.search({ query: "lunch" })).toEqual([]);
    expect(await fs.readdir(path.join(dir, "messages")).catch(() => [])).toEqual([]);
  });
});
