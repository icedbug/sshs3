import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { decryptSecretValue, encryptSecretValue } from "../../crypto/SecretFieldCrypto";
import { ChatIndex, type ChatSearchQuery, type ChatThreadHit, type IndexedChannel, type StoredMessage } from "./ChatIndex";
import { ChatError, mattermostApi, slackApi, type ChatAuth, type ChatMessage, type ChatRead, type ChatService, type ChatTransport } from "./ChatSources";
import { guardUrl, request, type GuardOptions } from "./Notifier";
import { clip, safeError } from "./privacy";
import type { ChatConnectionInput, ChatConnectionView } from "../../../shared/types/aiHub";

/** The bot's connection to one service. */
export interface ChatConnection {
  service: ChatService;
  /** Mattermost: the server's address. */
  baseUrl?: string;
  /** A secret: it reads every channel the bot is in. */
  token: string;
  enabled: boolean;
  /** The bot's name and where it is, as last told by the service. */
  bot?: string;
  workspace?: string;
  /** Slack: the workspace's address, for links to messages. */
  site?: string;
  channelsAt?: number;
  lastError?: string;
  /** Put there by the demo lab's simulation: there is no service behind it, and nothing is ever asked of one. */
  simulated?: boolean;
}

export interface ChatBridgeDeps {
  guard(): GuardOptions;
}

/** What a change to the bot did, for whoever asked for it to write down: the bridge may serve several hubs and keeps no log of its own. */
export interface ChatDone {
  target: string;
  what: string;
}

/** How often a channel is asked what is new. */
export const CHAT_READ_INTERVAL_MS = 2 * 60_000;
/** How far back a channel is read when it is first chosen. */
export const CHAT_FIRST_READ_DAYS = 90;
/** Slack lists replies apart: threads this young are asked again for new ones. */
const THREAD_WATCH_MS = 7 * 86_400_000;
const THREAD_RECHECK_MS = 10 * 60_000;
/** How far back a channel is looked over for messages that got their first reply later. */
const THREAD_RESCAN_MS = 2 * 86_400_000;
const SERVICES: ChatService[] = ["slack", "mattermost"];
const NAME: Record<ChatService, string> = { slack: "Slack", mattermost: "Mattermost" };

/**
 * The team's bot in Slack and Mattermost: the connection, which channels are
 * read, the reading itself, and the search over what was read.
 *
 * The token is the team's, not a person's: it is set up once where the bot
 * should run, kept encrypted in a file of its own, and never put in the team
 * bucket. Only channels the bot is a member of can be chosen, and only chosen
 * channels are read. Nothing is ever posted.
 *
 * On a shared server one bridge serves every account: one reader, one index.
 */
export class ChatBridge {
  readonly index: ChatIndex;
  private connections: Partial<Record<ChatService, ChatConnection>> = {};
  private readonly names: Record<ChatService, Map<string, string>> = { slack: new Map(), mattermost: new Map() };
  private readonly listeners = new Set<() => void>();
  private loading?: Promise<void>;
  private running: Promise<unknown> = Promise.resolve();
  private writes: Promise<void> = Promise.resolve();
  /** Kept for how long, in days. Nothing: for good. */
  retentionDays?: number;
  private lastPrune = 0;
  /** Replaced in tests: how a call reaches the service. */
  transport?: ChatTransport;

  constructor(
    private readonly dir: string,
    private readonly deps: ChatBridgeDeps,
  ) {
    this.index = new ChatIndex(dir);
  }

  /** Told when what the interface shows has changed. Returns how to stop being told. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  private readonly send: ChatTransport = async (r) => {
    if (this.transport) return this.transport(r);
    const target = await guardUrl(r.url, this.deps.guard());
    const answer = await request(target, { method: r.method, headers: r.headers, body: r.body });
    return { status: answer.status, body: answer.body, headers: answer.headers as Record<string, string | string[] | undefined> };
  };

  load(): Promise<void> {
    return (this.loading ??= (async () => {
      try {
        const raw = JSON.parse(await fs.readFile(path.join(this.dir, "connections.json"), "utf8")) as { connections?: ChatConnection[]; retentionDays?: number };
        for (const c of raw.connections ?? [])
          if (c && SERVICES.includes(c.service)) this.connections[c.service] = { ...c, token: decryptSecretValue(c.token ?? ""), enabled: c.enabled !== false };
        if (typeof raw.retentionDays === "number" && raw.retentionDays > 0) this.retentionDays = Math.floor(raw.retentionDays);
      } catch {
        // Not set up yet.
      }
      await this.index.load();
    })());
  }

  private persist(): Promise<void> {
    const content = JSON.stringify({
      version: 1,
      retentionDays: this.retentionDays,
      // A simulated connection is the lab's, for as long as its scenario runs: it is not kept.
      connections: Object.values(this.connections)
        .filter((c) => !c.simulated)
        .map((c) => ({ ...c, token: encryptSecretValue(c.token) })),
    });
    const write = async (): Promise<void> => {
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
      const file = path.join(this.dir, "connections.json");
      const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
      await fs.writeFile(temporary, content, { mode: 0o600 });
      await fs.rename(temporary, file);
    };
    this.writes = this.writes.then(write, write);
    return this.writes;
  }

  private auth(service: ChatService, evenIfOff = false): ChatAuth | undefined {
    const c = this.connections[service];
    if (!c?.token || c.simulated || (!c.enabled && !evenIfOff)) return undefined;
    if (service === "mattermost" && !c.baseUrl) return undefined;
    return { service, baseUrl: c.baseUrl, token: c.token };
  }

  /** Whether any channel is read: what decides if agents are offered the tool at all. */
  active(): boolean {
    return SERVICES.some((s) => this.connections[s]?.enabled && this.index.list(s).some((c) => c.selected || c.count > 0));
  }

  view(): ChatConnectionView[] {
    return SERVICES.flatMap((service) => {
      const c = this.connections[service];
      if (!c) return [];
      return [
        {
          service,
          baseUrl: c.baseUrl,
          hasToken: Boolean(c.token),
          enabled: c.enabled,
          bot: c.bot,
          workspace: c.workspace,
          lastError: c.lastError,
          ...(c.simulated ? { simulated: true } : {}),
          channels: this.index.list(service).map((ch) => ({
            id: ch.id,
            name: ch.name,
            private: ch.private,
            selected: ch.selected,
            count: ch.count,
            lastReadAt: ch.lastReadAt,
            oldestAt: ch.oldest?.at,
            readingBack: Boolean(ch.gaps?.length),
            error: ch.error,
          })),
        },
      ];
    });
  }

  async save(input: ChatConnectionInput): Promise<ChatDone> {
    if (!SERVICES.includes(input.service)) throw new Error("Unknown chat service");
    const had = this.connections[input.service];
    let baseUrl: string | undefined;
    if (input.service === "mattermost") {
      baseUrl = (input.baseUrl ?? "").trim().replace(/\/+$/, "");
      if (!baseUrl) throw new Error("Mattermost needs the server's address, like https://chat.example.com");
      await guardUrl(baseUrl, this.deps.guard());
    }
    const sameSite = had ? (had.baseUrl ?? "") === (baseUrl ?? "") : false;
    // A token is for one place: at another address it is not sent along.
    const token = input.token?.trim() || (sameSite ? had?.token : "") || "";
    if (!token) throw new Error(had && !sameSite ? "The address changed, so the token has to be entered again." : "The bot's token is needed.");
    if (input.service === "slack" && input.token?.trim() && !/^xox[be]-/.test(token))
      throw new Error("That does not look like a Slack bot token (it starts with xoxb-). A person's own token is not used: the bot reads only what it was invited to.");
    this.connections[input.service] = { ...(sameSite ? had : {}), service: input.service, baseUrl, token, enabled: input.enabled !== false, lastError: undefined };
    await this.persist();
    this.changed();
    return { target: NAME[input.service], what: `Team chat: the bot's connection to ${NAME[input.service]} was saved` };
  }

  /** Removes the connection. What was read stays unless it is to be forgotten too. */
  async disconnect(service: ChatService, forget: boolean): Promise<ChatDone> {
    delete this.connections[service];
    if (forget) await this.index.forgetService(service);
    else for (const c of this.index.list(service)) c.selected = false;
    await this.index.save();
    await this.persist();
    this.changed();
    return { target: NAME[service], what: `Team chat: disconnected from ${NAME[service]}${forget ? ", and everything read from it was removed" : ""}` };
  }

  /** Signs in as the bot and lists the channels it is in. */
  async test(service: ChatService, now = Date.now()): Promise<{ ok: boolean; bot?: string; workspace?: string; channels?: number; error?: string }> {
    const auth = this.auth(service, true);
    const connection = this.connections[service];
    if (!auth || !connection) return { ok: false, error: "Save the token first." };
    try {
      if (service === "slack") {
        const me = await slackApi.identity(this.send, auth);
        Object.assign(connection, { bot: me.name, workspace: me.workspace, site: me.url });
      } else {
        const me = await mattermostApi.identity(this.send, auth);
        Object.assign(connection, { bot: me.name, workspace: me.workspace });
      }
      const channels = await this.refreshChannels(service, auth, now);
      connection.lastError = undefined;
      await this.persist();
      this.changed();
      return { ok: true, bot: connection.bot, workspace: connection.workspace, channels };
    } catch (error) {
      return { ok: false, error: clip(safeError(error), 300) };
    }
  }

  private async refreshChannels(service: ChatService, auth: ChatAuth, now = Date.now()): Promise<number> {
    const found = service === "slack" ? await slackApi.channels(this.send, auth) : await mattermostApi.channels(this.send, auth);
    this.index.setChannels(service, found);
    // A channel the bot was taken out of is no longer read; what was read of it stays until it is forgotten.
    const here = new Set(found.map((c) => c.id));
    for (const c of this.index.list(service)) if (!here.has(c.id) && c.selected) Object.assign(c, { selected: false, error: "The bot is no longer in this channel." });
    this.connections[service]!.channelsAt = now;
    await this.index.save();
    return found.length;
  }

  /** Starts or stops reading a channel. Only a channel the bot is in can be chosen. */
  async select(service: ChatService, channelId: string, on: boolean): Promise<ChatDone> {
    const channel = this.index.channel(service, channelId);
    if (!channel) throw new Error("The bot is not in that channel. Invite it there first, then test the connection again.");
    channel.selected = on;
    if (on) Object.assign(channel, { error: undefined, failures: undefined, notBefore: undefined });
    await this.index.save();
    this.changed();
    return { target: `${NAME[service]} #${channel.name}`, what: on ? "Team chat: the channel is now read and kept" : "Team chat: the channel is no longer read (what was read is kept)" };
  }

  /** Reads a channel further back than it has been. */
  async readBack(service: ChatService, channelId: string, days: number): Promise<void> {
    const channel = this.index.channel(service, channelId);
    if (!channel?.selected) throw new Error("Choose the channel first.");
    const from = (channel.oldest?.at ?? Date.now()) - Math.max(1, Math.min(3650, Math.floor(days))) * 86_400_000;
    channel.gaps = [...(channel.gaps ?? []), { afterMs: from, before: channel.oldest?.cursor }];
    channel.notBefore = undefined;
    await this.index.save();
    this.changed();
  }

  async forget(service: ChatService, channelId: string | undefined): Promise<ChatDone> {
    let done: ChatDone;
    if (channelId) {
      const name = this.index.channel(service, channelId)?.name ?? channelId;
      await this.index.forget(service, channelId);
      done = { target: `${NAME[service]} #${name}`, what: "Team chat: everything read from the channel was removed" };
    } else {
      for (const c of this.index.list(service)) await this.index.forget(service, c.id);
      done = { target: NAME[service], what: "Team chat: everything read from every channel was removed" };
    }
    this.changed();
    return done;
  }

  async setRetention(days: number | undefined): Promise<void> {
    this.retentionDays = days && days > 0 ? Math.min(3650, Math.floor(days)) : undefined;
    await this.persist();
    this.changed();
  }

  /**
   * Puts a chat in place that no service is behind: the demo lab's scenarios
   * say what the team wrote, and it is searched and shown like the real thing.
   * It is kept in memory and on this lab's disk only, and replaces what a
   * scenario put there before.
   */
  async simulate(workspace: string, channels: { id: string; name: string }[], messages: ChatMessage[]): Promise<void> {
    await this.load();
    if (this.connections.slack && !this.connections.slack.simulated) throw new Error("A real Slack bot is connected here: the simulation does not replace it.");
    await this.index.forgetService("slack");
    this.connections.slack = { service: "slack", token: "simulated", enabled: true, bot: "sshs3-bot", workspace, site: "https://acme.slack.com", simulated: true, channelsAt: Date.now() };
    this.index.setChannels("slack", channels.map((c) => ({ ...c, private: false })));
    for (const c of channels) {
      this.index.channel("slack", c.id)!.selected = true;
      await this.index.add("slack", c.id, messages.filter((m) => m.channelId === c.id));
      this.index.channel("slack", c.id)!.lastReadAt = Date.now();
    }
    await this.index.save();
    this.changed();
  }

  /** Takes a simulated chat away again. A real connection is left alone. */
  async endSimulation(): Promise<void> {
    if (!this.connections.slack?.simulated) return;
    delete this.connections.slack;
    await this.index.forgetService("slack");
    this.changed();
  }

  search(query: ChatSearchQuery, now = Date.now()): ChatThreadHit[] {
    return this.index.search(query, now);
  }

  thread(service: ChatService, channelId: string, threadId: string): StoredMessage[] {
    return this.index.thread(service, channelId, threadId);
  }

  /**
   * Reads one thread now, for the agent bot when it is mentioned in it: what the team wrote before
   * it was asked. Only when this bot is connected and the channel is one an administrator chose for
   * it to read; anything else gives nothing, so the agent bot never sees more through this than it
   * could find in the index later. The thread is kept in the index like any other read, masked, and
   * is returned as the index keeps it. When the service cannot be reached now, what was read before
   * is returned. Like everything here, this only reads.
   */
  async readThreadNow(service: ChatService, channelId: string, threadId: string): Promise<StoredMessage[] | undefined> {
    if (!SERVICES.includes(service)) return undefined;
    await this.load();
    const auth = this.auth(service);
    const connection = this.connections[service];
    const channel = this.index.channel(service, channelId);
    if (!auth || !connection || !channel?.selected) return undefined;
    const valid = service === "slack" ? /^\d{6,12}\.\d{1,8}$/.test(threadId) : /^[a-z0-9]{20,32}$/.test(threadId);
    if (!valid) return undefined;
    try {
      const messages =
        service === "slack"
          ? await slackApi.replies(this.send, auth, channel, threadId, 0, connection.site ?? "", this.names.slack, true)
          : await mattermostApi.thread(this.send, auth, channel, threadId, this.names.mattermost);
      await this.index.add(service, channelId, messages);
    } catch {
      // The service could not be asked now: what was read before is still worth having.
    }
    return this.index.thread(service, channelId, threadId);
  }

  /**
   * Whether a token is the context bot's own. The token is only compared here, never handed out: the
   * agent bot must be a separate app or bot account, so this bot stays the one that only reads.
   */
  async usesToken(service: ChatService, token: string): Promise<boolean> {
    await this.load();
    const own = this.connections[service]?.token;
    if (!own || !token || this.connections[service]?.simulated) return false;
    const a = crypto.createHash("sha256").update(own).digest();
    const b = crypto.createHash("sha256").update(token).digest();
    return crypto.timingSafeEqual(a, b);
  }

  /** One round: each chosen channel that is due is asked what is new, one at a time. Failures are kept on the channel, never thrown. */
  tick(now = Date.now()): Promise<void> {
    const run = this.running.then(async () => {
      await this.load();
      let touched = false;
      for (const service of SERVICES) {
        const auth = this.auth(service);
        const connection = this.connections[service];
        if (!auth || !connection) continue;
        if (now - (connection.channelsAt ?? 0) > 30 * 60_000 && this.index.list(service).some((c) => c.selected)) {
          await this.refreshChannels(service, auth, now).catch((error) => (connection.lastError = clip(safeError(error), 300)));
          touched = true;
        }
        for (const channel of this.index.list(service)) {
          if (!channel.selected || (channel.notBefore ?? 0) > now) continue;
          if (now - (channel.lastReadAt ?? 0) < CHAT_READ_INTERVAL_MS && !channel.gaps?.length) continue;
          touched = true;
          try {
            await this.readChannel(service, auth, connection, channel, now);
            Object.assign(channel, { lastReadAt: now, error: undefined, failures: undefined, notBefore: undefined });
            connection.lastError = undefined;
          } catch (error) {
            const failures = (channel.failures ?? 0) + 1;
            const pause = error instanceof ChatError && error.retryAfterMs ? error.retryAfterMs : Math.min(60, 2 ** failures) * 60_000;
            Object.assign(channel, { failures, error: clip(safeError(error), 300), notBefore: now + pause });
            // The service asked for a pause: the other channels of it wait too.
            if (error instanceof ChatError && error.status === 429) break;
            // A token that was refused is refused for every channel.
            if (error instanceof ChatError && error.status === 401) {
              connection.lastError = channel.error;
              break;
            }
          }
        }
      }
      if (this.retentionDays && now - this.lastPrune > 24 * 3_600_000) {
        this.lastPrune = now;
        await this.index.prune(this.retentionDays, now).catch(() => undefined);
      }
      if (touched) {
        await this.index.save().catch(() => undefined);
        await this.persist().catch(() => undefined);
        this.changed();
      }
    });
    this.running = run.catch(() => undefined);
    return run;
  }

  private history(service: ChatService, auth: ChatAuth, connection: ChatConnection, channel: IndexedChannel, range: { afterMs: number; before?: string }, limit: number): Promise<ChatRead> {
    return service === "slack"
      ? slackApi.history(this.send, auth, channel, range, connection.site ?? "", this.names.slack, limit)
      : mattermostApi.history(this.send, auth, channel, range, this.names.mattermost, limit);
  }

  private async readChannel(service: ChatService, auth: ChatAuth, connection: ChatConnection, channel: IndexedChannel, now: number): Promise<void> {
    const note = (read: ChatRead): void => {
      if (read.oldest && (!channel.oldest || read.oldest.at < channel.oldest.at)) channel.oldest = read.oldest;
      const newest = read.messages.length ? read.messages[read.messages.length - 1].at : 0;
      if (newest > (channel.readTo ?? 0)) channel.readTo = newest;
      if (service === "slack") {
        channel.threads ??= {};
        for (const t of read.threads) channel.threads[t.id] ??= { latest: 0, checked: 0 };
      }
    };
    // What is new. The first time, that is the last ninety days: its newest part now, the rest going back.
    const afterMs = channel.readTo ?? now - CHAT_FIRST_READ_DAYS * 86_400_000;
    const forward = await this.history(service, auth, connection, channel, { afterMs }, 1000);
    await this.index.add(service, channel.id, forward.messages);
    note(forward);
    if (channel.readTo === undefined) channel.readTo = now;
    if (forward.more && forward.oldest) channel.gaps = [...(channel.gaps ?? []), { afterMs, before: forward.oldest.cursor }];
    // One stretch further back, when there is one to read.
    const gap = channel.gaps?.[0];
    const withReplies = [...forward.threads];
    if (gap) {
      const back = await this.history(service, auth, connection, channel, gap, 600);
      await this.index.add(service, channel.id, back.messages);
      note(back);
      withReplies.push(...back.threads);
      if (back.more && back.oldest) gap.before = back.oldest.cursor;
      else channel.gaps = channel.gaps!.slice(1);
      if (!channel.gaps?.length) channel.gaps = undefined;
    }
    if (service === "slack") {
      // A first reply to an earlier message does not show among what is new: the last two days are
      // looked over now and then, and a message that has got replies since is found there.
      if (now - (channel.rescannedAt ?? 0) >= THREAD_RECHECK_MS) {
        const recent = await this.history(service, auth, connection, channel, { afterMs: now - THREAD_RESCAN_MS }, 400);
        await this.index.add(service, channel.id, recent.messages);
        withReplies.push(...recent.threads);
        channel.threads ??= {};
        for (const t of recent.threads) channel.threads[t.id] ??= { latest: 0, checked: 0 };
        channel.rescannedAt = now;
      }
      await this.readSlackThreads(auth, connection, channel, withReplies, now);
    }
  }

  /**
   * Slack lists a thread's replies apart from the channel, and a reply to an
   * older message does not show among what is new. So: threads seen with
   * replies are read, and threads younger than a week are asked again now and
   * then. Not seen: a reply to a thread older than a week, and a first reply
   * to a message older than two days.
   */
  private async readSlackThreads(auth: ChatAuth, connection: ChatConnection, channel: IndexedChannel, seen: { id: string; latestAt: number }[], now: number): Promise<void> {
    const threads = (channel.threads ??= {});
    // Older than a week and read at least once: no longer asked.
    for (const [id, state] of Object.entries(threads)) if (now - Number(id) * 1000 > THREAD_WATCH_MS && state.checked > 0) delete threads[id];
    const due = new Set<string>(seen.filter((t) => t.latestAt > (threads[t.id]?.latest ?? 0)).map((t) => t.id));
    for (const [id, state] of Object.entries(threads).sort((a, b) => a[1].checked - b[1].checked)) {
      if (due.size >= 12) break;
      if (now - state.checked >= THREAD_RECHECK_MS) due.add(id);
    }
    for (const id of due) {
      const state = (threads[id] ??= { latest: 0, checked: 0 });
      const replies = await slackApi.replies(this.send, auth, channel, id, state.latest, connection.site ?? "", this.names.slack);
      await this.index.add("slack", channel.id, replies);
      if (replies.length) state.latest = replies[replies.length - 1].at;
      state.checked = now;
    }
  }
}
