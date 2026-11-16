import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChatIndex, chatTerms } from "../../src/main/ai/hub/ChatIndex";
import { ChatError, mattermostApi, slackApi, slackText, type ChatAuth, type ChatMessage, type ChatRequest, type ChatTransport } from "../../src/main/ai/hub/ChatSources";

/** The team's chat as a source: what is asked of Slack and Mattermost, and what the index keeps and finds. */

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const slackAuth: ChatAuth = { service: "slack", token: "xoxb-test" };
const mmAuth: ChatAuth = { service: "mattermost", baseUrl: "https://chat.example.com/", token: "mm-token" };

function service(routes: Record<string, (url: URL, r: ChatRequest) => { status?: number; body: unknown; headers?: Record<string, string> }>) {
  const asked: ChatRequest[] = [];
  const transport: ChatTransport = async (r) => {
    asked.push(r);
    const url = new URL(r.url);
    const hit = routes[url.pathname];
    if (!hit) return { status: 404, body: "{}" };
    const out = hit(url, r);
    return { status: out.status ?? 200, body: JSON.stringify(out.body), headers: out.headers };
  };
  return { transport, asked };
}

describe("Slack", () => {
  it("lists only channels the bot is in, and never asks for direct messages", async () => {
    const s = service({
      "/api/users.conversations": () => ({
        body: { ok: true, channels: [{ id: "C2", name: "ops" }, { id: "C1", name: "alerts", is_private: true }, { id: "D9", name: "dm", is_im: true }] },
      }),
    });
    expect(await slackApi.channels(s.transport, slackAuth)).toEqual([
      { id: "C1", name: "alerts", private: true },
      { id: "C2", name: "ops", private: false },
    ]);
    expect(new URL(s.asked[0].url).searchParams.get("types")).toBe("public_channel,private_channel");
    expect(s.asked[0].headers.Authorization).toBe("Bearer xoxb-test");
  });

  it("reads a stretch of a channel oldest first, with names, links and the threads that have replies", async () => {
    const s = service({
      "/api/conversations.history": (url) => {
        expect(url.searchParams.get("oldest")).toBe("1700000000.000000");
        return {
          body: {
            ok: true,
            messages: [
              { ts: "1700000300.000200", user: "U2", text: "restarted it &amp; it is fine <https://grafana.example.com/d/1|dashboard>" },
              { ts: "1700000200.000100", user: "U1", text: "<@U2> pg-01 is slow again", reply_count: 2, latest_reply: "1700000400.000300", thread_ts: "1700000200.000100" },
              { ts: "1700000100.000000", subtype: "channel_join", user: "U3", text: "<@U3> has joined the channel" },
            ],
          },
        };
      },
      "/api/users.info": (url) => ({ body: { ok: true, user: { profile: { display_name: url.searchParams.get("user") === "U1" ? "Sara" : "Erik" } } } }),
    });
    const names = new Map<string, string>();
    const read = await slackApi.history(s.transport, slackAuth, { id: "C1" }, { afterMs: 1_700_000_000_000 }, "https://acme.slack.com", names);
    expect(read.messages).toEqual([
      { id: "1700000200.000100", channelId: "C1", at: 1_700_000_200_000, author: "Sara", text: "@Erik pg-01 is slow again", threadId: "1700000200.000100", link: "https://acme.slack.com/archives/C1/p1700000200000100" },
      { id: "1700000300.000200", channelId: "C1", at: 1_700_000_300_000, author: "Erik", text: "restarted it & it is fine dashboard (https://grafana.example.com/d/1)", threadId: "1700000300.000200", link: "https://acme.slack.com/archives/C1/p1700000300000200" },
    ]);
    expect(read.threads).toEqual([{ id: "1700000200.000100", latestAt: 1_700_000_400_000 }]);
    expect(read).toMatchObject({ more: false, oldest: { cursor: "1700000100.000000" } });
  });

  it("says when a read was cut short and where to go on from, and reads replies without repeating the first message", async () => {
    const page = (from: number) => Array.from({ length: 200 }, (_x, i) => ({ ts: `${1_700_010_000 - from - i}.000000`, user: "U1", text: `m${from + i}` }));
    const s = service({
      "/api/conversations.history": (url) => ({ body: { ok: true, messages: page(url.searchParams.get("cursor") ? 200 : 0), has_more: true, response_metadata: { next_cursor: "next" } } }),
      "/api/conversations.replies": () => ({ body: { ok: true, messages: [{ ts: "1700000200.000100", user: "U1", text: "first" }, { ts: "1700000400.000300", user: "U1", text: "a reply" }] } }),
      "/api/users.info": () => ({ body: { ok: true, user: { real_name: "Sara" } } }),
    });
    const read = await slackApi.history(s.transport, slackAuth, { id: "C1" }, { afterMs: 0 }, "", new Map(), 400);
    expect(read.more).toBe(true);
    expect(read.messages).toHaveLength(400);
    expect(read.oldest).toEqual({ cursor: "1700009601.000000", at: 1_700_009_601_000 });
    const replies = await slackApi.replies(s.transport, slackAuth, { id: "C1" }, "1700000200.000100", 0, "https://acme.slack.com", new Map());
    expect(replies.map((m) => [m.text, m.threadId, m.link])).toEqual([["a reply", "1700000200.000100", "https://acme.slack.com/archives/C1/p1700000400000300?thread_ts=1700000200.000100&cid=C1"]]);
  });

  it("says what is wrong in words, and passes on a pause the service asks for", async () => {
    const refused = service({ "/api/auth.test": () => ({ body: { ok: false, error: "invalid_auth" } }) });
    await expect(slackApi.identity(refused.transport, slackAuth)).rejects.toThrow("Slack refused the token");
    const scope = service({ "/api/users.conversations": () => ({ body: { ok: false, error: "missing_scope" } }) });
    await expect(slackApi.channels(scope.transport, slackAuth)).rejects.toThrow("channels:history, groups:history, channels:read, groups:read and users:read");
    const busy = service({ "/api/conversations.history": () => ({ status: 429, body: {}, headers: { "retry-after": "17" } }) });
    const error = await slackApi.history(busy.transport, slackAuth, { id: "C1" }, { afterMs: 0 }, "", new Map()).catch((e) => e);
    expect(error).toBeInstanceOf(ChatError);
    expect(error).toMatchObject({ status: 429, retryAfterMs: 17_000 });
  });

  it("turns Slack's own marks into plain words", () => {
    const names = new Map([["U1", "Sara"]]);
    expect(slackText("<!here> <@U1> see <#C9|ops> and <https://x.example/y> &lt;b&gt;", names)).toBe("@here @Sara see #ops and https://x.example/y <b>");
  });
});

describe("Mattermost", () => {
  const TEAM = "t".repeat(26);
  const CH = "c".repeat(26);
  it("lists open and private channels of the bot's teams, and no direct or group messages", async () => {
    const s = service({
      "/api/v4/users/me/teams": () => ({ body: [{ id: TEAM, name: "acme" }] }),
      [`/api/v4/users/me/teams/${TEAM}/channels`]: () => ({ body: [{ id: CH, display_name: "Operations", type: "O" }, { id: "d".repeat(26), type: "D" }, { id: "g".repeat(26), type: "G" }, { id: "p".repeat(26), display_name: "Secret", type: "P" }] }),
    });
    expect(await mattermostApi.channels(s.transport, mmAuth)).toEqual([
      { id: CH, name: "Operations", private: false, team: "acme" },
      { id: "p".repeat(26), name: "Secret", private: true, team: "acme" },
    ]);
    expect(s.asked[0].url).toBe("https://chat.example.com/api/v4/users/me/teams");
  });

  it("reads posts with their threads and links, leaves out what was deleted and the server's own notices", async () => {
    const post = (n: number, extra: Record<string, unknown> = {}) => ({ id: String(n).padStart(26, "a"), create_at: 1_700_000_000_000 + n * 1000, user_id: "u".repeat(26), message: `post ${n}`, ...extra });
    const posts = [post(3, { root_id: post(1).id }), post(2, { delete_at: 5 }), post(1), post(0, { type: "system_join_channel" })];
    const s = service({
      [`/api/v4/channels/${CH}/posts`]: () => ({ body: { order: posts.map((p) => p.id), posts: Object.fromEntries(posts.map((p) => [p.id, p])) } }),
      "/api/v4/users/ids": () => ({ body: [{ id: "u".repeat(26), first_name: "Linnea", last_name: "Berg" }] }),
    });
    const read = await mattermostApi.history(s.transport, mmAuth, { id: CH, team: "acme" }, { afterMs: 1_700_000_000_000 }, new Map());
    expect(read.messages.map((m) => [m.text, m.author, m.threadId === m.id, m.link])).toEqual([
      ["post 1", "Linnea Berg", true, `https://chat.example.com/acme/pl/${post(1).id}`],
      ["post 3", "Linnea Berg", false, `https://chat.example.com/acme/pl/${post(3).id}`],
    ]);
    expect(read.more).toBe(false);
    await expect(mattermostApi.history(s.transport, mmAuth, { id: "../../admin" }, { afterMs: 0 }, new Map())).rejects.toThrow("That is not a Mattermost id.");
  });
});

describe("the index", () => {
  const at = Date.parse("2026-11-10T08:00:00Z");
  const msg = (id: string, text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, channelId: "C1", at: at + Number(id) * 60_000, author: "Sara", text, threadId: id, link: `https://acme.slack.com/p${id}`, ...extra });
  async function index() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-chat-"));
    dirs.push(dir);
    const made = new ChatIndex(dir);
    await made.load();
    made.setChannels("slack", [{ id: "C1", name: "ops", private: false }, { id: "C2", name: "random", private: false }]);
    return { dir, index: made };
  }

  it("keeps what looks like a secret out of the files, adds a message once, and reads it all back", async () => {
    const { dir, index: first } = await index();
    expect(await first.add("slack", "C1", [msg("1", "the db password is password=Sup3rS3cretValue99 for now"), msg("2", "ok")])).toBe(2);
    expect(await first.add("slack", "C1", [msg("2", "ok"), msg("3", "thanks")])).toBe(1);
    await first.save();
    const files = await fs.readdir(path.join(dir, "messages", "slack-C1"));
    expect(files).toEqual(["2026-11.jsonl"]);
    const onDisk = await fs.readFile(path.join(dir, "messages", "slack-C1", files[0]), "utf8");
    expect(onDisk).not.toContain("Sup3rS3cretValue99");
    expect(onDisk.trim().split("\n")).toHaveLength(3);
    if (process.platform !== "win32") expect((await fs.stat(path.join(dir, "messages", "slack-C1", files[0]))).mode & 0o777).toBe(0o600);

    const again = new ChatIndex(dir);
    await again.load();
    expect(again.channel("slack", "C1")).toMatchObject({ name: "ops", count: 3 });
    expect(again.total()).toBe(3);
  });

  it("finds threads, not lone messages: an answer comes with its question", async () => {
    const { index: i } = await index();
    await i.add("slack", "C1", [
      msg("1", "pg-01 is slow again, replication lag is growing"),
      msg("2", "restarted pgbouncer, fixed", { threadId: "1", author: "Erik" }),
      msg("3", "lunch?"),
      msg("4", "ceph-osd-nvme-01 nearfull, who is on call"),
    ]);
    await i.add("slack", "C2", [msg("9", "pgbouncer jokes", { channelId: "C2" })]);
    const [hit] = i.search({ query: "pgbouncer restart pg-01" }, at + 3_600_000);
    expect(hit).toMatchObject({ channel: "ops", threadId: "1", total: 2 });
    expect(hit.messages.map((m) => `${m.author}: ${m.text}`)).toEqual(["Sara: pg-01 is slow again, replication lag is growing", "Erik: restarted pgbouncer, fixed"]);

    expect(i.search({ query: "pgbouncer", channel: "#random" }).map((h) => h.channel)).toEqual(["random"]);
    expect(i.search({ query: "pgbouncer", author: "erik" }).map((h) => h.threadId)).toEqual(["1"]);
    expect(i.search({ query: "pgbouncer", sinceMs: at + 5 * 60_000 }).map((h) => h.channel)).toEqual(["random"]);
    expect(i.search({ query: "nothing-like-this" })).toEqual([]);
    expect(i.search({ query: "   " })).toEqual([]);
    expect(i.thread("slack", "C1", "1").map((m) => m.id)).toEqual(["1", "2"]);
  });

  it("matches names as they are written", () => {
    expect(chatTerms("pg-01 is DOWN (10.0.0.5), see /etc/pg_hba.conf")).toEqual(["pg-01", "is", "down", "10.0.0.5", "see", "etc", "pg_hba.conf"]);
  });

  it("forgets a channel for good, and drops old messages only when asked to", async () => {
    const { dir, index: i } = await index();
    await i.add("slack", "C1", [msg("1", "old one", { at: at - 100 * 86_400_000 }), msg("2", "new one")]);
    expect(await i.prune(0, at)).toBe(0);
    expect(await i.prune(30, at + 86_400_000)).toBe(1);
    expect(i.search({ query: "one" }).flatMap((h) => h.messages.map((m) => m.text))).toEqual(["new one"]);
    expect(await fs.readdir(path.join(dir, "messages", "slack-C1"))).toEqual(["2026-11.jsonl"]);

    i.channel("slack", "C1")!.selected = true;
    await i.forget("slack", "C1");
    expect(i.channel("slack", "C1")).toMatchObject({ selected: false, count: 0 });
    expect(i.search({ query: "one" })).toEqual([]);
    await expect(fs.readdir(path.join(dir, "messages", "slack-C1"))).rejects.toThrow();
  });
});
