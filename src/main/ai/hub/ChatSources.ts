/**
 * Slack and Mattermost, read only: which channels a bot is in, and what was
 * said in them.
 *
 * Nothing here keeps state. These are the calls, once per service, and the
 * conversion of their messages to one shape. Every call goes through a
 * transport the caller gives, which is where the address is checked and
 * where tests stand in for the service. Nothing is ever posted to a channel.
 */

export type ChatService = "slack" | "mattermost";

export interface ChatAuth {
  service: ChatService;
  /** Mattermost: the server's address. Slack has one address for everybody. */
  baseUrl?: string;
  /** A bot's token: it reads what the bot was invited to. */
  token: string;
}

export interface ChatRequest {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: string;
}
export type ChatTransport = (request: ChatRequest) => Promise<{ status: number; body: string; headers?: Record<string, string | string[] | undefined> }>;

export class ChatError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The service asked to be left alone for this long. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ChatError";
  }
}

export interface ChatChannel {
  id: string;
  name: string;
  private: boolean;
  /** Mattermost: the team the channel is in, for its links. */
  team?: string;
}

/** One message as the index keeps it. */
export interface ChatMessage {
  id: string;
  channelId: string;
  /** Milliseconds. */
  at: number;
  author: string;
  text: string;
  /** The message that started the thread this one is in; its own id when it started one or stands alone. */
  threadId: string;
  link: string;
}

/** A stretch of a channel to read: everything after a time, and, when going back in time, before a point already reached. */
export interface ChatRange {
  afterMs: number;
  /** Where an earlier read stopped, as the service names it (a Slack timestamp, a Mattermost post id). */
  before?: string;
}

/**
 * What a read brought. A channel is listed newest first by both services, so
 * a read that hits its limit holds the newest part of the range: `more` says
 * older messages of the range are still unread, and `oldest` is where to go
 * on from.
 */
export interface ChatRead {
  /** Oldest first. */
  messages: ChatMessage[];
  /** Threads that had replies, for a service that lists replies apart (Slack). */
  threads: { id: string; latestAt: number }[];
  more: boolean;
  oldest?: { cursor: string; at: number };
}

export interface ChatIdentity {
  /** The bot's own name. */
  name: string;
  /** The workspace or server it is in. */
  workspace: string;
}

const SLACK = "https://slack.com/api";

/** How long a service asked to be left alone, from its Retry-After header, at most ten minutes. */
export function retryAfter(headers: Record<string, string | string[] | undefined> | undefined): number | undefined {
  const raw = headers?.["retry-after"] ?? headers?.["Retry-After"];
  const seconds = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 600) * 1000 : undefined;
}

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

/** What Slack's error codes mean to the person who set the bot up. */
const SLACK_SAYS: Record<string, string> = {
  invalid_auth: "Slack refused the token: check that it is the bot token (it starts with xoxb-).",
  not_authed: "Slack refused the token: check that it is the bot token (it starts with xoxb-).",
  account_inactive: "The Slack app was removed or its token was revoked.",
  token_revoked: "The Slack app was removed or its token was revoked.",
  missing_scope: "The Slack app lacks a permission it needs. It needs channels:history, groups:history, channels:read, groups:read and users:read.",
  not_in_channel: "The bot is no longer in that channel. Invite it again, or stop following the channel.",
  channel_not_found: "The channel is gone, or the bot can no longer see it.",
  ratelimited: "Slack asked for a pause; it is tried again later.",
};

async function slack<T extends { ok?: boolean; error?: string }>(
  t: ChatTransport,
  auth: ChatAuth,
  method: string,
  params: Record<string, string | number | undefined> = {},
): Promise<T> {
  const query = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  const answer = await t({
    method: "GET",
    url: `${SLACK}/${method}${query ? `?${query}` : ""}`,
    headers: { Authorization: `Bearer ${auth.token}`, Accept: "application/json" },
  });
  if (answer.status === 429) throw new ChatError(SLACK_SAYS.ratelimited, 429, retryAfter(answer.headers) ?? 30_000);
  if (answer.status < 200 || answer.status >= 300) throw new ChatError(`Slack answered ${answer.status}.`, answer.status);
  let parsed: T;
  try {
    parsed = JSON.parse(answer.body) as T;
  } catch {
    throw new ChatError("The answer was not what Slack sends.", answer.status);
  }
  if (!parsed.ok) {
    const code = String(parsed.error ?? "unknown");
    throw new ChatError(SLACK_SAYS[code] ?? `Slack said: ${code.slice(0, 80)}`, code === "ratelimited" ? 429 : 400, code === "ratelimited" ? 30_000 : undefined);
  }
  return parsed;
}

/** A Slack timestamp ("1712345678.000200") as milliseconds. */
export const slackTime = (ts: string): number => Math.round(Number(ts) * 1000);
/** Milliseconds as the `oldest` Slack takes. */
export const slackOldest = (ms: number): string => (ms / 1000).toFixed(6);

/**
 * A Slack message's text as plain text: `<@U1>` as the person's name,
 * `<#C1|ops>` as #ops, `<https://x|label>` as "label (https://x)", and the
 * three characters Slack escapes put back.
 */
export function slackText(text: string, names: Map<string, string>): string {
  // No part matches "<": Slack escapes it in what people type, and a run of unclosed "<http:" would
  // otherwise make each one scan to the end of the text, which grows with the square of its length.
  /* eslint-disable security/detect-unsafe-regex -- each optional group is bounded by the closing > and holds no repetition of its own */
  return text
    .replace(/<@([A-Z0-9]+)(?:\|([^<>]*))?>/g, (_m, id: string, label?: string) => `@${label || names.get(id) || id}`)
    .replace(/<#([A-Z0-9]+)(?:\|([^<>]*))?>/g, (_m, id: string, label?: string) => `#${label || id}`)
    .replace(/<!(here|channel|everyone)(?:\|[^<>]*)?>/g, "@$1")
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^<>]*))?>/g, (_m, label?: string) => label || "@group")
    .replace(/<((?:https?|mailto):[^|<>]+)\|([^<>]+)>/g, (_m, url: string, label: string) => `${label} (${url})`)
    .replace(/<((?:https?|mailto):[^<>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  /* eslint-enable security/detect-unsafe-regex */
}

interface SlackMessage {
  ts?: string;
  user?: string;
  username?: string;
  bot_id?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  latest_reply?: string;
  subtype?: string;
}

/** Joins, leaves, renames and the like: the channel's housekeeping, not something somebody said. */
const SLACK_NOISE = new Set([
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "channel_archive",
  "channel_unarchive",
  "group_join",
  "group_leave",
  "pinned_item",
  "unpinned_item",
  "bot_add",
  "bot_remove",
]);

export const slackApi = {
  async identity(t: ChatTransport, auth: ChatAuth): Promise<ChatIdentity & { url: string }> {
    const me = await slack<{ ok: boolean; url?: string; team?: string; user?: string }>(t, auth, "auth.test");
    return { name: me.user ?? "the bot", workspace: me.team ?? "Slack", url: (me.url ?? "").replace(/\/+$/, "") };
  },

  /** The channels the bot is a member of. Never direct messages or group chats: they are not asked for. */
  async channels(t: ChatTransport, auth: ChatAuth): Promise<ChatChannel[]> {
    const out: ChatChannel[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const got = await slack<{ ok: boolean; channels?: { id?: string; name?: string; is_private?: boolean; is_im?: boolean; is_mpim?: boolean }[]; response_metadata?: { next_cursor?: string } }>(
        t,
        auth,
        "users.conversations",
        { types: "public_channel,private_channel", exclude_archived: "true", limit: 200, cursor },
      );
      for (const c of got.channels ?? [])
        if (c.id && c.name && !c.is_im && !c.is_mpim) out.push({ id: c.id, name: c.name, private: Boolean(c.is_private) });
      cursor = got.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  },

  /** Display names for user ids, asked for one by one and only for those not known yet. */
  async names(t: ChatTransport, auth: ChatAuth, ids: string[], known: Map<string, string>): Promise<void> {
    for (const id of [...new Set(ids)].filter((i) => i && !known.has(i)).slice(0, 40)) {
      try {
        const got = await slack<{ ok: boolean; user?: { name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } } }>(t, auth, "users.info", { user: id });
        known.set(id, got.user?.profile?.display_name || got.user?.profile?.real_name || got.user?.real_name || got.user?.name || id);
      } catch (error) {
        if (error instanceof ChatError && error.status === 429) throw error;
        known.set(id, id);
      }
    }
  },

  /** What was said in a stretch of a channel, and the threads that had replies. */
  async history(
    t: ChatTransport,
    auth: ChatAuth,
    channel: Pick<ChatChannel, "id">,
    range: ChatRange,
    site: string,
    names: Map<string, string>,
    limit = 1000,
  ): Promise<ChatRead> {
    const raw: SlackMessage[] = [];
    let cursor: string | undefined;
    let more = false;
    for (let page = 0; page < 50; page++) {
      const got = await slack<{ ok: boolean; messages?: SlackMessage[]; has_more?: boolean; response_metadata?: { next_cursor?: string } }>(t, auth, "conversations.history", {
        channel: channel.id,
        oldest: slackOldest(range.afterMs),
        latest: range.before,
        inclusive: "false",
        limit: 200,
        cursor,
      });
      raw.push(...(got.messages ?? []));
      cursor = got.has_more ? got.response_metadata?.next_cursor || undefined : undefined;
      if (!cursor) break;
      if (raw.length >= limit) {
        more = true;
        break;
      }
    }
    const taken = raw.filter((m) => m.ts).sort((a, b) => Number(a.ts) - Number(b.ts));
    await slackApi.names(t, auth, taken.map((m) => m.user ?? ""), names);
    return {
      messages: taken.map((m) => slackMessage(m, channel.id, site, names)).filter((m): m is ChatMessage => Boolean(m)),
      threads: taken.filter((m) => m.ts && (m.reply_count ?? 0) > 0).map((m) => ({ id: m.ts!, latestAt: slackTime(m.latest_reply ?? m.ts!) })),
      more,
      ...(taken.length ? { oldest: { cursor: taken[0].ts!, at: slackTime(taken[0].ts!) } } : {}),
    };
  },

  /**
   * The replies in one thread after `sinceMs`, oldest first. The message that started it is not
   * repeated, unless `withStart` asks for the whole thread.
   */
  async replies(
    t: ChatTransport,
    auth: ChatAuth,
    channel: Pick<ChatChannel, "id">,
    threadId: string,
    sinceMs: number,
    site: string,
    names: Map<string, string>,
    withStart = false,
  ): Promise<ChatMessage[]> {
    const raw: SlackMessage[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const got = await slack<{ ok: boolean; messages?: SlackMessage[]; has_more?: boolean; response_metadata?: { next_cursor?: string } }>(t, auth, "conversations.replies", {
        channel: channel.id,
        ts: threadId,
        oldest: slackOldest(sinceMs),
        inclusive: "false",
        limit: 200,
        cursor,
      });
      raw.push(...(got.messages ?? []));
      cursor = got.has_more ? got.response_metadata?.next_cursor || undefined : undefined;
      if (!cursor) break;
    }
    const replies = raw.filter((m) => m.ts && (withStart || m.ts !== threadId));
    await slackApi.names(t, auth, replies.map((m) => m.user ?? ""), names);
    return replies
      .map((m) => slackMessage({ ...m, thread_ts: threadId }, channel.id, site, names))
      .filter((m): m is ChatMessage => Boolean(m))
      .sort((a, b) => a.at - b.at);
  },
};

function slackMessage(m: SlackMessage, channelId: string, site: string, names: Map<string, string>): ChatMessage | undefined {
  if (!m.ts || SLACK_NOISE.has(m.subtype ?? "")) return undefined;
  const text = slackText(m.text ?? "", names).trim();
  if (!text) return undefined;
  const threadId = m.thread_ts ?? m.ts;
  const compact = m.ts.replace(".", "");
  return {
    id: m.ts,
    channelId,
    at: slackTime(m.ts),
    author: (m.user && names.get(m.user)) || m.username || (m.bot_id ? "a bot" : "somebody"),
    text,
    threadId,
    link: site ? `${site}/archives/${channelId}/p${compact}${threadId !== m.ts ? `?thread_ts=${threadId}&cid=${channelId}` : ""}` : "",
  };
}

// ---------------------------------------------------------------------------
// Mattermost
// ---------------------------------------------------------------------------

const mmBase = (auth: ChatAuth): string => `${(auth.baseUrl ?? "").trim().replace(/\/+$/, "")}/api/v4`;
const mmSite = (auth: ChatAuth): string => (auth.baseUrl ?? "").trim().replace(/\/+$/, "");
const mmId = (id: string): string => {
  if (!/^[a-z0-9]{20,32}$/.test(id)) throw new Error("That is not a Mattermost id.");
  return id;
};

async function mattermost<T>(t: ChatTransport, auth: ChatAuth, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const answer = await t({
    method,
    url: `${mmBase(auth)}${path}`,
    headers: { Authorization: `Bearer ${auth.token}`, Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (answer.status === 429) throw new ChatError("Mattermost asked for a pause; it is tried again later.", 429, retryAfter(answer.headers) ?? 30_000);
  if (answer.status === 401) throw new ChatError("Mattermost refused the token: check that it is the bot account's access token.", 401);
  if (answer.status === 403) throw new ChatError("The bot may not read that. Add it to the channel, or stop following the channel.", 403);
  if (answer.status === 404) throw new ChatError("Not found: the channel is gone, or this is not a Mattermost server's address.", 404);
  if (answer.status < 200 || answer.status >= 300) throw new ChatError(`Mattermost answered ${answer.status}.`, answer.status);
  try {
    return JSON.parse(answer.body) as T;
  } catch {
    throw new ChatError("The answer was not what Mattermost sends: is this the right address?", answer.status);
  }
}

interface MmPost {
  id?: string;
  channel_id?: string;
  create_at?: number;
  delete_at?: number;
  user_id?: string;
  message?: string;
  root_id?: string;
  type?: string;
}

export const mattermostApi = {
  async identity(t: ChatTransport, auth: ChatAuth): Promise<ChatIdentity> {
    const me = await mattermost<{ username?: string; nickname?: string }>(t, auth, "GET", "/users/me");
    return { name: me.nickname || me.username || "the bot", workspace: new URL(mmSite(auth)).host };
  },

  /** The open and private channels the bot is in, across its teams. Direct and group messages are left out. */
  async channels(t: ChatTransport, auth: ChatAuth): Promise<ChatChannel[]> {
    const teams = await mattermost<{ id?: string; name?: string }[]>(t, auth, "GET", "/users/me/teams");
    const out: ChatChannel[] = [];
    for (const team of (Array.isArray(teams) ? teams : []).slice(0, 20)) {
      if (!team.id || !team.name) continue;
      const channels = await mattermost<{ id?: string; name?: string; display_name?: string; type?: string; delete_at?: number }[]>(
        t,
        auth,
        "GET",
        `/users/me/teams/${mmId(team.id)}/channels`,
      );
      for (const c of Array.isArray(channels) ? channels : [])
        if (c.id && (c.type === "O" || c.type === "P") && !c.delete_at)
          out.push({ id: c.id, name: c.display_name || c.name || c.id, private: c.type === "P", team: team.name });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  },

  async names(t: ChatTransport, auth: ChatAuth, ids: string[], known: Map<string, string>): Promise<void> {
    const wanted = [...new Set(ids)].filter((i) => i && !known.has(i)).slice(0, 200);
    if (!wanted.length) return;
    try {
      const users = await mattermost<{ id?: string; username?: string; nickname?: string; first_name?: string; last_name?: string }[]>(t, auth, "POST", "/users/ids", wanted);
      for (const u of Array.isArray(users) ? users : [])
        if (u.id) known.set(u.id, u.nickname || [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || u.id);
    } catch (error) {
      if (error instanceof ChatError && error.status === 429) throw error;
    }
    for (const id of wanted) if (!known.has(id)) known.set(id, id);
  },

  /** What was said in a stretch of a channel. Replies come with it: a post names the thread it is in. */
  async history(
    t: ChatTransport,
    auth: ChatAuth,
    channel: Pick<ChatChannel, "id" | "team">,
    range: ChatRange,
    names: Map<string, string>,
    limit = 1000,
  ): Promise<ChatRead> {
    const posts: MmPost[] = [];
    let more = false;
    const before = range.before ? `&before=${mmId(range.before)}` : "";
    // Newest first, a page at a time, until the posts are older than what is asked for.
    for (let page = 0; page < 50; page++) {
      const got = await mattermost<{ order?: string[]; posts?: Record<string, MmPost> }>(t, auth, "GET", `/channels/${mmId(channel.id)}/posts?page=${page}&per_page=200${before}`);
      const batch = (got.order ?? []).map((id) => got.posts?.[id]).filter((p): p is MmPost => Boolean(p));
      const fresh = batch.filter((p) => (p.create_at ?? 0) > range.afterMs);
      posts.push(...fresh);
      if (fresh.length < batch.length || batch.length < 200) break;
      if (posts.length >= limit) {
        more = true;
        break;
      }
    }
    const taken = posts.filter((p) => p.id).sort((a, b) => (a.create_at ?? 0) - (b.create_at ?? 0));
    await mattermostApi.names(t, auth, taken.map((p) => p.user_id ?? ""), names);
    return {
      messages: mmMessages(taken, channel, mmSite(auth), names),
      threads: [],
      more,
      ...(taken.length ? { oldest: { cursor: taken[0].id!, at: taken[0].create_at ?? 0 } } : {}),
    };
  },

  /**
   * One whole thread, oldest first. Mattermost finds a thread by its post id alone, whatever the
   * channel: only posts of the channel asked about are kept, so a thread of another channel is
   * never read in as this one's.
   */
  async thread(t: ChatTransport, auth: ChatAuth, channel: Pick<ChatChannel, "id" | "team">, threadId: string, names: Map<string, string>): Promise<ChatMessage[]> {
    const got = await mattermost<{ order?: string[]; posts?: Record<string, MmPost> }>(t, auth, "GET", `/posts/${mmId(threadId)}/thread`);
    const posts = Object.values(got.posts ?? {})
      .filter((p) => p?.id && p.channel_id === channel.id && (p.id === threadId || p.root_id === threadId))
      .sort((a, b) => (a.create_at ?? 0) - (b.create_at ?? 0));
    await mattermostApi.names(t, auth, posts.map((p) => p.user_id ?? ""), names);
    return mmMessages(posts, channel, mmSite(auth), names);
  },
};

function mmMessages(posts: MmPost[], channel: Pick<ChatChannel, "id" | "team">, site: string, names: Map<string, string>): ChatMessage[] {
  return posts
    .filter((p) => p.id && !p.delete_at && !(p.type ?? "").startsWith("system_") && (p.message ?? "").trim())
    .map((p) => ({
      id: p.id!,
      channelId: channel.id,
      at: p.create_at ?? 0,
      author: names.get(p.user_id ?? "") || "somebody",
      text: (p.message ?? "").trim(),
      threadId: p.root_id || p.id!,
      link: channel.team ? `${site}/${channel.team}/pl/${p.id}` : `${site}/_redirect/pl/${p.id}`,
    }));
}
