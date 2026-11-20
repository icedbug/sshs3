import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ChatServiceName } from '../../../shared/types/aiHub';
import { writeFileAtomic } from '../../storage/atomicFile';
import { claimChatAction } from './chatActionToken';

/**
 * What the agent bot keeps between messages, in `<dataDir>/chat-agent/`: who in chat is who in sshs3
 * (links.json), and which chat thread is which conversation (threads.json). Both files are the
 * server's own (0600) and are written whole, so a crash leaves the old file or the new one.
 *
 * A person links their chat account with a code made in sshs3 and sent to the bot in a direct message.
 * Only the code's hash is kept, it is good for ten minutes, and there is one at a time per account and
 * service. A chat user who sends wrong codes is stopped after five in ten minutes, so the eight
 * characters cannot be guessed.
 *
 * An account that is turned off or removed counts as not linked, everywhere and always: the store is
 * given the check once, when it is made, so no caller can leave it out.
 */

export interface ChatLink {
  service: ChatServiceName;
  chatUserId: string;
  /** The name the chat showed when the link was made. */
  chatName: string;
  accountId: string;
  linkedAt: number;
}

interface LinkCodeRecord {
  /** sha256 of the service and the code: the code itself is never kept. */
  hash: string;
  accountId: string;
  service: ChatServiceName;
  expiresAt: number;
}

interface LinksFile {
  version: 1;
  links: ChatLink[];
  codes: LinkCodeRecord[];
}

/** A card the bot posted in a thread: a change or a plan with buttons. */
export interface ChatThreadCard {
  /** The card's own post. */
  post: string;
  kind: 'change' | 'plan';
  /** Who answered it from chat, by chat user id, and when: one answer per person per card. */
  answered: Record<string, number>;
  /** The card shows its outcome and takes no more answers. */
  final?: boolean;
  /**
   * How the card can be answered in the chat as it was last drawn: with its buttons, or (Mattermost
   * without buttons) with a reaction. Absent: it cannot be answered there at all (it did not fit whole,
   * it is answered only in the app, or it has ended), and a press or a reaction on it changes nothing.
   */
  answer?: 'buttons' | 'reactions';
}

export interface ChatThread {
  /** Whose hub the conversation runs in: the chat agent's, or a linked person's own. */
  owner: 'agent' | `user:${string}`;
  taskId: string;
  /** The post the bot edits to show what the run is doing. */
  statusPost?: string;
  /** By change id or plan id. */
  cards: Record<string, ChatThreadCard>;
  askedBy: { chatUserId: string; name: string };
  lastAt: number;
  /** The status post shows how its run ended: a restart does not need to redraw it. */
  statusDone?: boolean;
  /** Tokens of this conversation already counted against the month's budget. */
  counted?: number;
  /** A hash of the last answer posted, so the same answer is not posted twice. */
  answered?: string;
  /** When the agent was last given what the team wrote in the thread: later messages are new to it. */
  seenAt?: number;
}

/** A thread as listed: where it is, and what it holds. */
export interface ChatThreadEntry {
  service: ChatServiceName;
  channelId: string;
  threadId: string;
  thread: ChatThread;
}

interface ThreadsFile {
  version: 1;
  threads: Record<string, ChatThread>;
}

export type RedeemResult =
  | { ok: true; link: ChatLink; replaced: ChatLink[] }
  | { ok: false; reason: 'limited' | 'wrong' | 'unusable'; message: string };

export const LINK_CODE_TTL_MS = 10 * 60_000;
const WRONG_CODE_WINDOW_MS = 10 * 60_000;
const WRONG_CODES_ALLOWED = 5;
/** A thread nobody wrote in for this long is forgotten: a new mention starts a new conversation. */
export const THREAD_IDLE_MS = 30 * 24 * 3600_000;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** How a thread is found again: the service, the channel and the thread's first post. */
export const threadKey = (service: ChatServiceName, channelId: string, threadId: string): string =>
  `${service}:${channelId}:${threadId}`;

/** Spaces, dashes and letter case are not part of a code: people copy it in many ways. */
const normalizeCode = (code: string): string => code.toUpperCase().replace(/[\s-]+/g, '');
const codeHash = (service: ChatServiceName, code: string): string =>
  crypto.createHash('sha256').update(`${service}:${normalizeCode(code)}`).digest('hex');

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

const isService = (value: unknown): value is ChatServiceName => value === 'slack' || value === 'mattermost';

/** A thread key taken apart. Channel ids hold no colon; a thread id may. */
function splitKey(key: string): { service: ChatServiceName; channelId: string; threadId: string } | undefined {
  const first = key.indexOf(':');
  const second = key.indexOf(':', first + 1);
  if (first < 0 || second < 0) return undefined;
  const service = key.slice(0, first);
  if (!isService(service)) return undefined;
  return { service, channelId: key.slice(first + 1, second), threadId: key.slice(second + 1) };
}

/** Whether a thread ran in a person's own hub through this link: same service, same person, same account. */
const ranThrough = (key: string, thread: ChatThread, link: ChatLink): boolean =>
  key.startsWith(`${link.service}:`) && thread.owner === `user:${link.accountId}` && thread.askedBy?.chatUserId === link.chatUserId;

export class ChatAgentStore {
  readonly dir: string;
  private readonly linksFile: string;
  private readonly threadsFile: string;
  private links: LinksFile = { version: 1, links: [], codes: [] };
  private threads: ThreadsFile = { version: 1, threads: {} };
  private loaded?: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  /** Wrong codes per chat user, in memory: a restart forgets them, and a code lives ten minutes anyway. */
  private wrongCodes = new Map<string, number[]>();
  private readonly usable: (accountId: string) => boolean;
  private readonly clock: () => number;

  /**
   * `usable` says whether an account may still act: it exists and is not turned off. One that may not
   * is never linked, never linked to, and none of its conversations are found again.
   */
  constructor(dataDir: string, options: { usable: (accountId: string) => boolean; clock?: () => number }) {
    this.usable = options.usable;
    this.clock = options.clock ?? Date.now;
    this.dir = path.join(dataDir, 'chat-agent');
    this.linksFile = path.join(this.dir, 'links.json');
    this.threadsFile = path.join(this.dir, 'threads.json');
  }

  initialize(): Promise<void> {
    this.loaded ??= this.load().catch((err) => {
      this.loaded = undefined;
      throw err;
    });
    return this.loaded;
  }

  private async load(): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const read = async (file: string): Promise<Record<string, unknown> | undefined> => {
      try {
        const raw = (await fsp.readFile(file, 'utf8')).replace(/^\uFEFF/, '').trim();
        const parsed: unknown = raw ? JSON.parse(raw) : undefined;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw err;
      }
    };
    const links = await read(this.linksFile);
    if (links) {
      this.links = {
        version: 1,
        links: (Array.isArray(links.links) ? (links.links as ChatLink[]) : []).filter(
          (l) => l && isService(l.service) && typeof l.chatUserId === 'string' && typeof l.accountId === 'string',
        ),
        codes: (Array.isArray(links.codes) ? (links.codes as LinkCodeRecord[]) : []).filter(
          (c) => c && isService(c.service) && typeof c.hash === 'string' && typeof c.accountId === 'string' && Number.isFinite(c.expiresAt),
        ),
      };
    }
    const threads = await read(this.threadsFile);
    if (threads && threads.threads && typeof threads.threads === 'object' && !Array.isArray(threads.threads))
      this.threads = { version: 1, threads: threads.threads as Record<string, ChatThread> };
  }

  private write(file: string, content: () => string): Promise<void> {
    // One write at a time, each of what is in memory when its turn comes.
    const run = async (): Promise<void> => writeFileAtomic(file, content(), { mode: 0o600 });
    const next = this.writes.then(run, run);
    this.writes = next.catch(() => undefined);
    return next;
  }

  private saveLinks(): Promise<void> {
    return this.write(this.linksFile, () => JSON.stringify(this.links, null, 2));
  }

  private saveThreads(): Promise<void> {
    return this.write(this.threadsFile, () => JSON.stringify(this.threads, null, 2));
  }

  // ---- linking ------------------------------------------------------------------------------------

  /**
   * A new code for this account and service: eight letters and digits, good for ten minutes. A code
   * asked for before, for the same account and service, stops working.
   */
  async linkCode(accountId: string, service: ChatServiceName): Promise<{ code: string; expiresAt: number }> {
    await this.initialize();
    if (!accountId) throw new Error('An account is needed to link a chat account.');
    if (!isService(service)) throw new Error('Choose Slack or Mattermost.');
    const now = this.clock();
    let code = '';
    for (let i = 0; i < 8; i++) code += BASE32[crypto.randomInt(BASE32.length)];
    const expiresAt = now + LINK_CODE_TTL_MS;
    this.links.codes = this.links.codes.filter(
      (c) => c.expiresAt > now && !(c.accountId === accountId && c.service === service),
    );
    this.links.codes.push({ hash: codeHash(service, code), accountId, service, expiresAt });
    await this.saveLinks();
    return { code, expiresAt };
  }

  /**
   * A chat user sent a code to the bot in a direct message. A right one links them to the account that
   * asked for it, in place of any link either of them had on this service, and the conversations that
   * ran in a person's own hub through a link that ends here are forgotten. After five wrong codes in
   * ten minutes, codes from this chat user are not even looked at until the ten minutes have passed. A
   * right code does not wipe the wrong ones out: somebody who can make codes of their own could
   * otherwise guess on without end.
   */
  async redeem(service: ChatServiceName, chatUserId: string, chatName: string, code: string): Promise<RedeemResult> {
    await this.initialize();
    const now = this.clock();
    const who = `${service}:${chatUserId}`;
    const recent = (this.wrongCodes.get(who) ?? []).filter((t) => now - t < WRONG_CODE_WINDOW_MS);
    if (recent.length >= WRONG_CODES_ALLOWED)
      return { ok: false, reason: 'limited', message: 'Too many wrong codes. Wait ten minutes, then ask sshs3 for a new code.' };
    const hash = codeHash(service, code);
    const found = this.links.codes.find((c) => c.service === service && c.expiresAt > now && sameHash(c.hash, hash));
    if (!found || !chatUserId) {
      recent.push(now);
      this.wrongCodes.set(who, recent);
      if (this.wrongCodes.size > 2000)
        for (const [key, times] of this.wrongCodes) if (!times.some((t) => now - t < WRONG_CODE_WINDOW_MS)) this.wrongCodes.delete(key);
      return { ok: false, reason: 'wrong', message: 'That code is not valid. Codes work for ten minutes. Ask sshs3 for a new one.' };
    }
    this.links.codes = this.links.codes.filter((c) => c !== found && c.expiresAt > now);
    // A code made before its account was turned off or removed links nobody, and is used up.
    if (!this.usable(found.accountId)) {
      await this.saveLinks();
      return { ok: false, reason: 'unusable', message: 'The sshs3 account that made this code is turned off or removed, so it cannot be linked.' };
    }
    const replaced = this.links.links.filter(
      (l) => l.service === service && (l.chatUserId === chatUserId || l.accountId === found.accountId),
    );
    this.links.links = this.links.links.filter((l) => !replaced.includes(l));
    const ended = replaced.filter((l) => !(l.chatUserId === chatUserId && l.accountId === found.accountId));
    if (this.dropThreads((key, t) => ended.some((l) => ranThrough(key, t, l)))) await this.saveThreads();
    const link: ChatLink = {
      service,
      chatUserId,
      chatName: chatName.trim().slice(0, 120) || chatUserId,
      accountId: found.accountId,
      linkedAt: now,
    };
    this.links.links.push(link);
    await this.saveLinks();
    return { ok: true, link: { ...link }, replaced: replaced.map((l) => ({ ...l })) };
  }

  /**
   * A code that was written where others can read it (a channel) is no good any more. Says whether it
   * was a live code.
   */
  async voidCode(service: ChatServiceName, code: string): Promise<boolean> {
    await this.initialize();
    const hash = codeHash(service, code);
    const before = this.links.codes.length;
    this.links.codes = this.links.codes.filter((c) => !(c.service === service && sameHash(c.hash, hash)));
    if (this.links.codes.length === before) return false;
    await this.saveLinks();
    return true;
  }

  /** The sshs3 account a chat user is linked to. An account that is turned off or removed counts as not linked. */
  linkOf(service: ChatServiceName, chatUserId: string): ChatLink | undefined {
    const link = this.links.links.find((l) => l.service === service && l.chatUserId === chatUserId);
    if (!link || !this.usable(link.accountId)) return undefined;
    return { ...link };
  }

  /** An account's links, one per service at most. None for an account that is turned off or removed. */
  linksOf(accountId: string): ChatLink[] {
    if (!this.usable(accountId)) return [];
    return this.links.links.filter((l) => l.accountId === accountId).map((l) => ({ ...l }));
  }

  /** Every link, for an administrator's list. */
  allLinks(): ChatLink[] {
    return this.links.links.map((l) => ({ ...l }));
  }

  /**
   * Ends a link. A person ends their own; an administrator may end anybody's. Says whether there was one.
   * The conversations that ran in the person's own hub through it are forgotten with it.
   */
  async unlink(
    target: { service: ChatServiceName; chatUserId?: string; accountId?: string },
    by: { accountId: string; admin: boolean },
  ): Promise<boolean> {
    await this.initialize();
    const link = this.links.links.find(
      (l) =>
        l.service === target.service &&
        (target.chatUserId ? l.chatUserId === target.chatUserId : Boolean(target.accountId) && l.accountId === target.accountId),
    );
    if (!link) return false;
    if (link.accountId !== by.accountId && !by.admin) throw new Error('You can only unlink your own chat account.');
    this.links.links = this.links.links.filter((l) => l !== link);
    await this.saveLinks();
    if (this.dropThreads((key, t) => ranThrough(key, t, link))) await this.saveThreads();
    return true;
  }

  /** An account was removed: its links, its codes and the conversations in its own hub go with it. */
  async forgetAccount(accountId: string): Promise<void> {
    await this.initialize();
    const before = this.links.links.length + this.links.codes.length;
    this.links.links = this.links.links.filter((l) => l.accountId !== accountId);
    this.links.codes = this.links.codes.filter((c) => c.accountId !== accountId);
    if (this.links.links.length + this.links.codes.length !== before) await this.saveLinks();
    if (this.dropThreads((_key, t) => t.owner === `user:${accountId}`)) await this.saveThreads();
  }

  // ---- threads ------------------------------------------------------------------------------------

  /**
   * The conversation a thread is. One that runs in a person's own hub is found only while the person who
   * asked is still linked to that account and the account may still act: otherwise it is not found, and
   * the next message starts a new conversation where it belongs now.
   */
  thread(service: ChatServiceName, channelId: string, threadId: string): ChatThread | undefined {
    const found = this.threads.threads[threadKey(service, channelId, threadId)];
    if (!found) return undefined;
    if (found.owner !== 'agent' && this.linkOf(service, found.askedBy?.chatUserId ?? '')?.accountId !== found.owner.slice('user:'.length))
      return undefined;
    return structuredClone(found);
  }

  /** Every thread kept, as copies: the ones a restart cut off are found here. */
  threadList(): ChatThreadEntry[] {
    const out: ChatThreadEntry[] = [];
    for (const [key, thread] of Object.entries(this.threads.threads)) {
      const entry = splitKey(key);
      if (entry) out.push({ ...entry, thread: structuredClone(thread) });
    }
    return out;
  }

  /**
   * The card a post of the bot's is, found by the post alone: a reaction names only the post. Under the
   * same rule as `thread`: a conversation in a person's own hub is found only while their link holds.
   */
  cardByPost(service: ChatServiceName, postId: string): (ChatThreadEntry & { cardId: string }) | undefined {
    if (!postId) return undefined;
    for (const [key, thread] of Object.entries(this.threads.threads)) {
      if (!key.startsWith(`${service}:`)) continue;
      const cardId = Object.keys(thread.cards ?? {}).find((id) => thread.cards[id].post === postId);
      if (!cardId) continue;
      const entry = splitKey(key);
      const found = entry && this.thread(entry.service, entry.channelId, entry.threadId);
      return entry && found ? { ...entry, thread: found, cardId } : undefined;
    }
    return undefined;
  }

  /**
   * Changes a kept thread in place and saves it. Says whether it was there. Used instead of setThread
   * for a thread that exists, so a claim made on one of its cards meanwhile is not written over.
   */
  async patchThread(service: ChatServiceName, channelId: string, threadId: string, change: (thread: ChatThread) => void): Promise<boolean> {
    await this.initialize();
    const thread = this.threads.threads[threadKey(service, channelId, threadId)];
    if (!thread) return false;
    change(thread);
    thread.lastAt = Math.max(thread.lastAt ?? 0, this.clock());
    await this.saveThreads();
    return true;
  }

  /** Removes the threads `drop` names. Says whether there were any. */
  private dropThreads(drop: (key: string, thread: ChatThread) => boolean): boolean {
    let removed = false;
    for (const [key, thread] of Object.entries(this.threads.threads)) {
      if (drop(key, thread)) {
        delete this.threads.threads[key];
        removed = true;
      }
    }
    return removed;
  }

  /** Keeps a thread as given; `lastAt` is now unless the caller set it. */
  async setThread(service: ChatServiceName, channelId: string, threadId: string, value: Omit<ChatThread, 'lastAt'> & { lastAt?: number }): Promise<void> {
    await this.initialize();
    this.threads.threads[threadKey(service, channelId, threadId)] = { ...structuredClone(value), lastAt: value.lastAt ?? this.clock() };
    await this.saveThreads();
  }

  /**
   * One person's answer to one card, counted once. False when this chat user already answered it, the
   * card is final, or the thread or card is not known.
   */
  async claimCard(service: ChatServiceName, channelId: string, threadId: string, cardId: string, chatUserId: string): Promise<boolean> {
    await this.initialize();
    const thread = this.threads.threads[threadKey(service, channelId, threadId)];
    const card = thread?.cards[cardId];
    if (!thread || !card || card.final) return false;
    const now = this.clock();
    if (!claimChatAction(card, chatUserId, now)) return false;
    thread.lastAt = now;
    await this.saveThreads();
    return true;
  }

  /**
   * Gives a person's answer to a card back. The caller claims a card before it answers, so two presses
   * at once are never both counted; when the answer was then refused (answerForChatAgent said
   * "refused", or threw) the caller releases the claim, so the person can still answer once it can be
   * given. Counting one person once is the hub's own rule as well: a vote is kept per account.
   */
  async releaseCard(service: ChatServiceName, channelId: string, threadId: string, cardId: string, chatUserId: string): Promise<void> {
    await this.initialize();
    const card = this.threads.threads[threadKey(service, channelId, threadId)]?.cards[cardId];
    if (!card || !Object.prototype.hasOwnProperty.call(card.answered ?? {}, chatUserId)) return;
    delete card.answered[chatUserId];
    await this.saveThreads();
  }

  /** Forgets threads nobody wrote in for 30 days. Says how many. */
  async pruneThreads(): Promise<number> {
    await this.initialize();
    const cutoff = this.clock() - THREAD_IDLE_MS;
    let removed = 0;
    for (const [key, thread] of Object.entries(this.threads.threads)) {
      if (!(thread.lastAt > cutoff)) {
        delete this.threads.threads[key];
        removed++;
      }
    }
    if (removed) await this.saveThreads();
    return removed;
  }
}
