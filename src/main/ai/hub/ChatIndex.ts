import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ChatMessage, ChatService } from "./ChatSources";
import { maskContext } from "./privacy";

/** A channel the bot is in, and how far it has been read. */
export interface IndexedChannel {
  service: ChatService;
  id: string;
  name: string;
  private: boolean;
  team?: string;
  /** Whether it is read. A channel is listed when the bot is in it, and read only when a person chose it. */
  selected: boolean;
  /** The newest message taken, in milliseconds: the next read asks for what came after. */
  readTo?: number;
  /** The oldest message taken, and the service's own name for that point. */
  oldest?: { cursor: string; at: number };
  /** Stretches still to read, going back in time. */
  gaps?: { afterMs: number; before?: string }[];
  count: number;
  lastReadAt?: number;
  /** Reads in a row that failed, and why the last one did. */
  failures?: number;
  error?: string;
  /** Not before this time: a pause the service asked for, or a wait after failures. */
  notBefore?: number;
  /** Slack: when the last two days were last looked over for messages that have since got replies. */
  rescannedAt?: number;
  /** Slack: threads that may still get replies: the newest reply taken, and when replies were last asked for. */
  threads?: Record<string, { latest: number; checked: number }>;
}

/** One stored message. Its text is masked before it is written. */
export type StoredMessage = ChatMessage & { service: ChatService };

export interface ChatSearchQuery {
  query: string;
  /** A channel's name or id. */
  channel?: string;
  sinceMs?: number;
  untilMs?: number;
  author?: string;
  limit?: number;
}

export interface ChatThreadHit {
  service: ChatService;
  channelId: string;
  channel: string;
  threadId: string;
  /** When the best matching message was written. */
  at: number;
  link: string;
  /** How many messages the thread has in the index. */
  total: number;
  /** The messages that matched, with one before and one after each, oldest first. */
  messages: Pick<StoredMessage, "id" | "at" | "author" | "text" | "link">[];
  score: number;
}

const safe = (id: string): string => id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "channel";
const month = (at: number): string => new Date(at).toISOString().slice(0, 7);
const key = (service: ChatService, channelId: string): string => `${service}:${channelId}`;

/** Words of a text as they are matched: lowercase, letters and digits kept together with the signs names are written with. */
export function chatTerms(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._-]*[\p{L}\p{N}]|[\p{L}\p{N}]/gu) ?? []).filter((w) => w.length > 1 || /\d/.test(w));
}

/**
 * The team's chat as the hub keeps it: the messages of the channels a person
 * chose, in files of its own beside the hub's store.
 *
 * Kept apart from the store on purpose. The store is rewritten whole on every
 * save; this is a copy of what people wrote to each other, so the index is
 * kept on the installation the bot is connected to (on a team server: the
 * server, for all its accounts), is readable by the owner only, and has what
 * looks like a secret masked before it reaches the disk. The index is never
 * put in the team bucket. Pieces of it do leave: the excerpts put on an
 * alert's ticket, a thread a person puts into the knowledge base, and what an
 * agent is given when it searches. One file per channel and month, added to
 * at the end: a busy channel is not rewritten for every message. A month's
 * file is written anew only when a message in it was edited or deleted in the
 * service, so that the old words are not left on the disk.
 */
export class ChatIndex {
  private channels = new Map<string, IndexedChannel>();
  private readonly messages = new Map<string, StoredMessage[]>();
  /** Each channel's kept messages by id: the same objects as in `messages`. */
  private readonly seen = new Map<string, Map<string, StoredMessage>>();
  private loading?: Promise<void>;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string) {}

  private file(channel: Pick<IndexedChannel, "service" | "id">, at: number): string {
    return path.join(this.dir, "messages", `${channel.service}-${safe(channel.id)}`, `${month(at)}.jsonl`);
  }

  load(): Promise<void> {
    return (this.loading ??= (async () => {
      try {
        const raw = JSON.parse(await fs.readFile(path.join(this.dir, "channels.json"), "utf8")) as { channels?: IndexedChannel[] };
        for (const c of raw.channels ?? []) if (c?.id && (c.service === "slack" || c.service === "mattermost")) this.channels.set(key(c.service, c.id), { ...c, count: 0 });
      } catch {
        // Nothing kept yet.
      }
      for (const channel of this.channels.values()) {
        const folder = path.join(this.dir, "messages", `${channel.service}-${safe(channel.id)}`);
        const list: StoredMessage[] = [];
        for (const name of (await fs.readdir(folder).catch(() => [] as string[])).filter((n) => n.endsWith(".jsonl")).sort()) {
          const text = await fs.readFile(path.join(folder, name), "utf8").catch(() => "");
          for (const line of text.split("\n")) {
            if (!line) continue;
            try {
              list.push(JSON.parse(line) as StoredMessage);
            } catch {
              // A line cut off by a crash: the rest of the file is still good.
            }
          }
        }
        const byId = new Map<string, StoredMessage>();
        for (const m of list) if (m?.id && !byId.has(m.id)) byId.set(m.id, m);
        const unique = [...byId.values()];
        unique.sort((a, b) => a.at - b.at);
        this.messages.set(key(channel.service, channel.id), unique);
        this.seen.set(key(channel.service, channel.id), byId);
        channel.count = unique.length;
      }
    })());
  }

  list(service?: ChatService): IndexedChannel[] {
    return [...this.channels.values()].filter((c) => !service || c.service === service).sort((a, b) => a.name.localeCompare(b.name));
  }

  channel(service: ChatService, id: string): IndexedChannel | undefined {
    return this.channels.get(key(service, id));
  }

  /**
   * The channels the bot is in now. One it was in before keeps what was read
   * and whether it was chosen; one it has left is kept (with its messages)
   * but can no longer be read.
   */
  setChannels(service: ChatService, found: Pick<IndexedChannel, "id" | "name" | "private" | "team">[]): void {
    for (const c of found) {
      const had = this.channels.get(key(service, c.id));
      this.channels.set(key(service, c.id), { ...(had ?? { selected: false, count: 0 }), service, id: c.id, name: c.name, private: c.private, team: c.team });
    }
  }

  /**
   * Adds messages that are not there yet, masked. Returns how many were new. A message that is kept
   * and comes again with other words was edited in the service: the kept one takes the new words, and
   * the month's file is written anew, so the old words are not kept on the disk either.
   */
  async add(service: ChatService, channelId: string, incoming: ChatMessage[]): Promise<number> {
    const channel = this.channels.get(key(service, channelId));
    if (!channel || !incoming.length) return 0;
    const k = key(service, channelId);
    const byId = this.seen.get(k) ?? new Map<string, StoredMessage>();
    const list = this.messages.get(k) ?? [];
    this.seen.set(k, byId);
    this.messages.set(k, list);
    const fresh: StoredMessage[] = [];
    const edited = new Set<string>();
    for (const m of incoming) {
      if (!m.id) continue;
      // Masked here, once, so that neither the file nor anything read from it holds what looked like a secret.
      const text = maskContext(m.text).slice(0, 8000);
      const author = maskContext(m.author).slice(0, 120);
      const had = byId.get(m.id);
      if (!had) {
        const stored: StoredMessage = { ...m, service, channelId, text, author };
        byId.set(m.id, stored);
        fresh.push(stored);
      } else if (had.text !== text || had.author !== author) {
        had.text = text;
        had.author = author;
        edited.add(month(had.at));
      }
    }
    if (!fresh.length && !edited.size) return 0;
    list.push(...fresh);
    list.sort((a, b) => a.at - b.at);
    channel.count = list.length;
    const byFile = new Map<string, string[]>();
    // A month that is written anew holds its new messages already.
    for (const m of fresh) {
      if (edited.has(month(m.at))) continue;
      const file = this.file(channel, m.at);
      byFile.set(file, [...(byFile.get(file) ?? []), JSON.stringify(m)]);
    }
    const write = async (): Promise<void> => {
      for (const [file, lines] of byFile) {
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await fs.appendFile(file, `${lines.join("\n")}\n`, { mode: 0o600 });
      }
    };
    this.writes = this.writes.then(write, write);
    await this.writes;
    if (edited.size) await this.rewrite(channel, edited);
    return fresh.length;
  }

  /**
   * Removes kept messages that the service no longer has. `covers` says which kept messages the
   * stretch that was read again covers, and `present` is what the service had in it: a kept message
   * the stretch covers that is not among them was deleted there. Only for a stretch that was read
   * whole. Returns how many were removed, from memory and from the disk.
   */
  async dropGone(service: ChatService, channelId: string, covers: (kept: StoredMessage) => boolean, present: Pick<ChatMessage, "id">[]): Promise<number> {
    const channel = this.channels.get(key(service, channelId));
    const k = key(service, channelId);
    const list = this.messages.get(k);
    const byId = this.seen.get(k);
    if (!channel || !list || !byId) return 0;
    const there = new Set(present.map((m) => m.id));
    const gone = list.filter((m) => covers(m) && !there.has(m.id));
    if (!gone.length) return 0;
    const removed = new Set(gone);
    this.messages.set(k, list.filter((m) => !removed.has(m)));
    for (const m of gone) byId.delete(m.id);
    channel.count = this.messages.get(k)!.length;
    await this.rewrite(channel, new Set(gone.map((m) => month(m.at))));
    return gone.length;
  }

  /** Writes the files of the months given anew from what is kept: what was replaced or removed is then not on the disk either. */
  private rewrite(channel: IndexedChannel, months: Set<string>): Promise<void> {
    const write = async (): Promise<void> => {
      const kept = this.messages.get(key(channel.service, channel.id)) ?? [];
      const folder = path.join(this.dir, "messages", `${channel.service}-${safe(channel.id)}`);
      for (const name of months) {
        const file = path.join(folder, `${name}.jsonl`);
        const lines = kept.filter((m) => month(m.at) === name).map((m) => JSON.stringify(m));
        if (!lines.length) {
          await fs.rm(file, { force: true });
          continue;
        }
        await fs.mkdir(folder, { recursive: true, mode: 0o700 });
        // Written beside it and moved into place: a crash leaves the old file or the new one, never half of one.
        const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
        await fs.writeFile(temporary, `${lines.join("\n")}\n`, { mode: 0o600 });
        await fs.rename(temporary, file);
      }
    };
    this.writes = this.writes.then(write, write);
    return this.writes;
  }

  /** Writes how far each channel has been read. */
  save(): Promise<void> {
    const content = JSON.stringify({ version: 1, channels: [...this.channels.values()] });
    const write = async (): Promise<void> => {
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
      const file = path.join(this.dir, "channels.json");
      const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
      await fs.writeFile(temporary, content, { mode: 0o600 });
      await fs.rename(temporary, file);
    };
    this.writes = this.writes.then(write, write);
    return this.writes;
  }

  /** Removes what was read of one channel, from memory and from the disk, and stops reading it. */
  async forget(service: ChatService, channelId: string): Promise<void> {
    const channel = this.channels.get(key(service, channelId));
    if (!channel) return;
    this.messages.delete(key(service, channelId));
    this.seen.delete(key(service, channelId));
    Object.assign(channel, { selected: false, count: 0, readTo: undefined, oldest: undefined, gaps: undefined, threads: undefined, rescannedAt: undefined, error: undefined, failures: undefined, notBefore: undefined });
    await this.writes.catch(() => undefined);
    await fs.rm(path.join(this.dir, "messages", `${service}-${safe(channelId)}`), { recursive: true, force: true });
    await this.save();
  }

  /** Removes everything of one service: its channels and all that was read of them. */
  async forgetService(service: ChatService): Promise<void> {
    for (const c of this.list(service)) {
      await this.forget(service, c.id);
      this.channels.delete(key(service, c.id));
    }
    await this.save();
  }

  /** Drops what is older than `days` days. Off unless a person set a number. */
  async prune(days: number, now = Date.now()): Promise<number> {
    if (!(days > 0)) return 0;
    const cutoff = now - days * 86_400_000;
    let dropped = 0;
    for (const channel of this.channels.values()) {
      const k = key(channel.service, channel.id);
      const list = this.messages.get(k) ?? [];
      const kept = list.filter((m) => m.at >= cutoff);
      if (kept.length === list.length) continue;
      dropped += list.length - kept.length;
      this.messages.set(k, kept);
      this.seen.set(k, new Map(kept.map((m) => [m.id, m])));
      channel.count = kept.length;
      // The files are rewritten from what is kept: a month wholly before the cutoff goes, the month it falls in is cut.
      await this.writes.catch(() => undefined);
      const folder = path.join(this.dir, "messages", `${channel.service}-${safe(channel.id)}`);
      await fs.rm(folder, { recursive: true, force: true });
      const byFile = new Map<string, string[]>();
      for (const m of kept) byFile.set(this.file(channel, m.at), [...(byFile.get(this.file(channel, m.at)) ?? []), JSON.stringify(m)]);
      for (const [file, lines] of byFile) {
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await fs.writeFile(file, `${lines.join("\n")}\n`, { mode: 0o600 });
      }
    }
    return dropped;
  }

  /** A whole thread, oldest first. */
  thread(service: ChatService, channelId: string, threadId: string): StoredMessage[] {
    return (this.messages.get(key(service, channelId)) ?? []).filter((m) => m.threadId === threadId);
  }

  /**
   * Threads that say what is asked about, best first. A thread is what is
   * found and shown, not a lone message: "restarted it, fixed" means nothing
   * without the question above it. Every word asked for that a thread has
   * counts, rare words more than common ones, a thread that has them all
   * more than one that has some, and a recent thread a little more than an
   * old one.
   */
  search(q: ChatSearchQuery, now = Date.now()): ChatThreadHit[] {
    const terms = [...new Set(chatTerms(q.query))];
    if (!terms.length) return [];
    const wantedChannel = q.channel?.trim().replace(/^#/, "").toLowerCase();
    const wantedAuthor = q.author?.trim().replace(/^@/, "").toLowerCase();
    interface Thread {
      channel: IndexedChannel;
      messages: StoredMessage[];
    }
    const threads: Thread[] = [];
    for (const channel of this.channels.values()) {
      if (wantedChannel && channel.name.toLowerCase() !== wantedChannel && channel.id.toLowerCase() !== wantedChannel) continue;
      const byThread = new Map<string, StoredMessage[]>();
      for (const m of this.messages.get(key(channel.service, channel.id)) ?? []) byThread.set(m.threadId, [...(byThread.get(m.threadId) ?? []), m]);
      for (const messages of byThread.values()) threads.push({ channel, messages });
    }
    // How many threads have each word: a word in every thread tells nothing.
    const termsOf = new Map<StoredMessage, Set<string>>();
    const has = (m: StoredMessage): Set<string> => {
      let set = termsOf.get(m);
      if (!set) termsOf.set(m, (set = new Set(chatTerms(`${m.text} ${m.author}`))));
      return set;
    };
    const inThreads = new Map<string, number>();
    for (const t of threads) for (const term of terms) if (t.messages.some((m) => has(m).has(term))) inThreads.set(term, (inThreads.get(term) ?? 0) + 1);
    const weight = (term: string): number => Math.log(1 + threads.length / (1 + (inThreads.get(term) ?? 0)));

    const hits: ChatThreadHit[] = [];
    for (const t of threads) {
      const inRange = t.messages.filter(
        (m) => (q.sinceMs === undefined || m.at >= q.sinceMs) && (q.untilMs === undefined || m.at <= q.untilMs) && (!wantedAuthor || m.author.toLowerCase().includes(wantedAuthor)),
      );
      if (!inRange.length) continue;
      const matched = terms.filter((term) => inRange.some((m) => has(m).has(term)));
      if (!matched.length) continue;
      const scored = inRange
        .map((m) => ({ m, score: terms.reduce((sum, term) => sum + (has(m).has(term) ? weight(term) : 0), 0) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || b.m.at - a.m.at);
      const best = scored[0].m;
      const all = matched.length === terms.length ? 1.5 : matched.length / terms.length;
      const ageDays = Math.max(0, (now - best.at) / 86_400_000);
      const score = matched.reduce((sum, term) => sum + weight(term), 0) * all * (1 + 0.25 / (1 + ageDays / 14));
      // What matched, with the message before and after each, so an answer has its question.
      const show = new Set<number>();
      for (const { m } of scored.slice(0, 3)) {
        const at = t.messages.indexOf(m);
        for (const i of [at - 1, at, at + 1]) if (i >= 0 && i < t.messages.length) show.add(i);
      }
      // A thread's first message says what it is about.
      show.add(0);
      hits.push({
        service: t.channel.service,
        channelId: t.channel.id,
        channel: t.channel.name,
        threadId: best.threadId,
        at: best.at,
        link: best.link,
        total: t.messages.length,
        messages: [...show]
          .sort((a, b) => a - b)
          .slice(0, 7)
          .map((i) => t.messages[i])
          .map((m) => ({ id: m.id, at: m.at, author: m.author, text: m.text, link: m.link })),
        score,
      });
    }
    return hits.sort((a, b) => b.score - a.score || b.at - a.at).slice(0, Math.max(1, Math.min(20, q.limit ?? 5)));
  }

  /** How much is kept in all. */
  total(): number {
    let n = 0;
    for (const list of this.messages.values()) n += list.length;
    return n;
  }
}
