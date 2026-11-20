import type { ChatServiceName } from '../../../shared/types/aiHub';
import { ChatError } from '../../ai/hub/ChatSources';
import type { AgentMattermostAuth, AgentSlackAuth, MattermostAttachment, SlackBlock } from './AgentBotApi';
import type { ChatOut } from './chatFormat';

/**
 * Everything the agent bot posts goes through one queue per channel, so it stays inside what Slack and
 * Mattermost allow: in Slack a new message at most about once a second per channel and an edit every
 * three seconds, in Mattermost a little faster. When a service asks for a pause (Retry-After), the
 * channel waits that long and the message is tried again. A card, an answer or an edit that failed
 * because the connection was lost or the service had a fault is tried again a few times as well.
 *
 * A queue is bounded. When it is full, status edits are dropped first, oldest first, then short notes;
 * a card or a final answer is never dropped. A newer edit of a post replaces an edit of the same post
 * that has not gone out yet, since only the latest is worth showing.
 *
 * Nothing here throws at the caller: a socket's event loop calls in, and a failed post must not stop
 * it. A failure goes to `onError`, and the promise the caller holds resolves to undefined (a post) or
 * false (anything else).
 */

/** What a queued item is, which says whether it may be dropped when the queue is full. */
export type OutboxKind = 'status' | 'note' | 'card' | 'answer';

/** Only what the outbox calls on AgentBotApi, so a test can give its own. */
export interface OutboxApi {
  slackPost(auth: AgentSlackAuth, message: { channel: string; threadTs?: string; text: string; blocks?: SlackBlock[] }): Promise<{ channel: string; ts: string }>;
  slackUpdate(auth: AgentSlackAuth, message: { channel: string; ts: string; text: string; blocks?: SlackBlock[] }): Promise<void>;
  slackEphemeral(auth: AgentSlackAuth, message: { channel: string; user: string; text: string; threadTs?: string; blocks?: SlackBlock[] }): Promise<void>;
  mmPost(auth: AgentMattermostAuth, post: { channelId: string; rootId?: string; message: string; attachments?: MattermostAttachment[] }): Promise<{ id: string }>;
  mmPatch(auth: AgentMattermostAuth, postId: string, patch: { message?: string; attachments?: MattermostAttachment[] }): Promise<void>;
  mmReact(auth: AgentMattermostAuth, reaction: { userId: string; postId: string; emoji: string }): Promise<void>;
}

export interface OutboxGaps {
  /** Least time between two new messages in one channel. */
  postMs: number;
  /** Least time between two edits in one channel. */
  editMs: number;
}

export const OUTBOX_GAPS: Record<ChatServiceName, OutboxGaps> = {
  slack: { postMs: 1100, editMs: 3000 },
  mattermost: { postMs: 250, editMs: 500 },
};
export const OUTBOX_MAX_QUEUE = 40;
/** A pause asked for is honoured up to this long; a longer one is a fault and the item is given up. */
const MAX_PAUSE_MS = 10 * 60_000;
/** How often an item is tried again after a pause was asked for. */
const MAX_TRIES = 4;
/** stop() waits this long for queued items to go out. */
const DRAIN_MS = 10_000;
/** After a lost connection or a fault on the service's side, the first wait before trying again; it doubles each time. */
const TRANSIENT_PAUSE_MS = 2000;

type Op =
  | { op: 'post'; threadId?: string; body: ChatOut }
  | { op: 'edit'; postId: string; body: ChatOut }
  | { op: 'ephemeral'; userId: string; threadId?: string; body: ChatOut }
  | { op: 'react'; postId: string; emoji: string; botUserId: string };

interface Item {
  service: ChatServiceName;
  channelId: string;
  kind: OutboxKind;
  op: Op;
  tries: number;
  /** Everyone waiting for this item: an edit that replaced another answers both. */
  done: Array<(result: string | boolean | undefined) => void>;
}

interface Lane {
  items: Item[];
  busy: boolean;
  lastPostAt: number;
  lastEditAt: number;
  pausedUntil: number;
  timer?: unknown;
  timerAt?: number;
}

export interface OutboxOptions {
  api: OutboxApi;
  /** The agent bot's credentials now: read at each send, so a new token is used at once. */
  auth: { slack(): AgentSlackAuth | undefined; mattermost(): AgentMattermostAuth | undefined };
  onError?: (error: unknown, item: { service: ChatServiceName; channelId: string; kind: OutboxKind; op: Op['op'] }) => void;
  /** An item dropped because its queue was full or the outbox stopped. */
  onDropped?: (item: { service: ChatServiceName; channelId: string; kind: OutboxKind; op: Op['op'] }) => void;
  gaps?: Partial<Record<ChatServiceName, Partial<OutboxGaps>>>;
  maxQueue?: number;
  clock?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const droppable = (kind: OutboxKind): boolean => kind === 'status' || kind === 'note';

/**
 * How long to wait before trying an item again, or undefined to give it up. A pause the service asked for
 * is honoured for every item. A lost connection, a timeout (status 0) or a fault on the service's side
 * (5xx) is tried again, after a short wait, for what must not be lost: a card, an answer, an edit (which
 * shows how a card or a run ended). A short note is not worth the wait.
 */
function pauseFor(error: unknown, item: Item): number | undefined {
  if (!(error instanceof ChatError)) return undefined;
  if (error.status === 429) return error.retryAfterMs ?? 30_000;
  const transient = error.status === 0 || error.status >= 500;
  if (transient && (item.kind === 'card' || item.kind === 'answer' || item.op.op === 'edit')) return TRANSIENT_PAUSE_MS * 2 ** item.tries;
  return undefined;
}

export class ChatOutbox {
  private readonly lanes = new Map<string, Lane>();
  private readonly gaps: Record<ChatServiceName, OutboxGaps>;
  private readonly maxQueue: number;
  private readonly clock: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private stopped = false;
  private idleWaiters: Array<() => void> = [];

  constructor(private readonly options: OutboxOptions) {
    this.gaps = {
      slack: { ...OUTBOX_GAPS.slack, ...options.gaps?.slack },
      mattermost: { ...OUTBOX_GAPS.mattermost, ...options.gaps?.mattermost },
    };
    this.maxQueue = Math.max(2, options.maxQueue ?? OUTBOX_MAX_QUEUE);
    this.clock = options.clock ?? Date.now;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Posts a new message, in a thread when `threadId` is given. Resolves to the post's id, or undefined. */
  post(service: ChatServiceName, channelId: string, body: ChatOut, options: { threadId?: string; kind?: OutboxKind } = {}): Promise<string | undefined> {
    return this.add(service, channelId, options.kind ?? 'note', { op: 'post', threadId: options.threadId, body }) as Promise<string | undefined>;
  }

  /** Changes a post the bot made. A later edit of the same post, queued before this one went out, takes its place. */
  edit(service: ChatServiceName, channelId: string, postId: string, body: ChatOut, options: { kind?: OutboxKind } = {}): Promise<boolean> {
    return this.add(service, channelId, options.kind ?? 'status', { op: 'edit', postId, body }).then(Boolean);
  }

  /** Slack only: a message one person sees. */
  ephemeral(channelId: string, userId: string, body: ChatOut, options: { threadId?: string } = {}): Promise<boolean> {
    return this.add('slack', channelId, 'note', { op: 'ephemeral', userId, threadId: options.threadId, body }).then(Boolean);
  }

  /** Mattermost only: the bot reacts to a post. */
  react(channelId: string, postId: string, emoji: string, botUserId: string): Promise<boolean> {
    return this.add('mattermost', channelId, 'note', { op: 'react', postId, emoji, botUserId }).then(Boolean);
  }

  /** How many items wait in one channel. */
  pending(service: ChatServiceName, channelId: string): number {
    return this.lanes.get(`${service}:${channelId}`)?.items.length ?? 0;
  }

  /**
   * Stops taking new items. `drain`: what is queued still goes out, for at most `drainMs`; then, or
   * without drain, what is left is dropped. Resolves once nothing is being sent.
   */
  async stop(options: { drain?: boolean; drainMs?: number } = {}): Promise<void> {
    this.stopped = true;
    if (options.drain && this.hasWork()) {
      await new Promise<void>((resolve) => {
        const state: { settled: boolean; deadline?: unknown } = { settled: false };
        const finish = (): void => {
          if (state.settled) return;
          state.settled = true;
          if (state.deadline !== undefined) this.clearTimer(state.deadline);
          resolve();
        };
        this.idleWaiters.push(finish);
        state.deadline = this.setTimer(finish, options.drainMs ?? DRAIN_MS);
      });
    }
    for (const lane of this.lanes.values()) {
      if (lane.timer !== undefined) this.clearTimer(lane.timer);
      lane.timer = undefined;
      for (const item of lane.items.splice(0)) this.drop(item);
    }
    // An item already on its way finishes or fails by itself: wait for it, so nothing is sent after this.
    while ([...this.lanes.values()].some((l) => l.busy)) await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private hasWork(): boolean {
    return [...this.lanes.values()].some((l) => l.busy || l.items.length > 0);
  }

  private add(service: ChatServiceName, channelId: string, kind: OutboxKind, op: Op): Promise<string | boolean | undefined> {
    return new Promise((resolve) => {
      const item: Item = { service, channelId, kind, op, tries: 0, done: [resolve] };
      if (this.stopped) {
        this.drop(item);
        return;
      }
      const key = `${service}:${channelId}`;
      let lane = this.lanes.get(key);
      if (!lane) {
        this.forgetIdleLanes();
        lane = { items: [], busy: false, lastPostAt: -Infinity, lastEditAt: -Infinity, pausedUntil: 0 };
        this.lanes.set(key, lane);
      }
      if (op.op === 'edit') {
        const earlier = lane.items.find((i) => i.op.op === 'edit' && i.op.postId === op.postId);
        if (earlier) {
          // The newer text takes the older one's place in the line: only the latest is worth showing.
          earlier.op = op;
          earlier.done.push(resolve);
          if (!droppable(kind)) earlier.kind = kind;
          return;
        }
      }
      lane.items.push(item);
      this.trim(lane);
      this.pump(key, lane);
    });
  }

  /**
   * A lane remembers when its channel was last written to, so it is kept while that still matters. Many
   * channels gone quiet are forgotten, so the map does not grow without end.
   */
  private forgetIdleLanes(): void {
    if (this.lanes.size < 200) return;
    const now = this.clock();
    for (const [key, lane] of this.lanes)
      if (!lane.busy && !lane.items.length && now - Math.max(lane.lastPostAt, lane.lastEditAt, lane.pausedUntil) > 60_000) this.lanes.delete(key);
  }

  /** Over the bound: status edits go first, oldest first, then notes. Cards and answers always stay. */
  private trim(lane: Lane): void {
    const order: Array<(i: Item) => boolean> = [
      (i) => i.kind === 'status' && i.op.op === 'edit',
      (i) => i.kind === 'status',
      (i) => i.kind === 'note',
    ];
    for (const test of order) {
      while (lane.items.length > this.maxQueue) {
        const at = lane.items.findIndex(test);
        if (at < 0) break;
        this.drop(lane.items.splice(at, 1)[0]);
      }
    }
  }

  private drop(item: Item): void {
    this.options.onDropped?.({ service: item.service, channelId: item.channelId, kind: item.kind, op: item.op.op });
    for (const done of item.done) done(item.op.op === 'post' ? undefined : false);
  }

  private nextAt(lane: Lane, item: Item): number {
    const gaps = this.gaps[item.service];
    const gapFrom = item.op.op === 'edit' ? lane.lastEditAt + gaps.editMs : lane.lastPostAt + gaps.postMs;
    return Math.max(gapFrom, lane.pausedUntil);
  }

  private pump(key: string, lane: Lane): void {
    if (lane.busy) return;
    const item = lane.items[0];
    if (!item) {
      this.wakeIdle();
      return;
    }
    const wait = this.nextAt(lane, item) - this.clock();
    if (wait > 0) {
      const at = this.clock() + wait;
      if (lane.timer !== undefined && lane.timerAt === at) return;
      if (lane.timer !== undefined) this.clearTimer(lane.timer);
      lane.timerAt = at;
      lane.timer = this.setTimer(() => {
        lane.timer = undefined;
        lane.timerAt = undefined;
        this.pump(key, lane);
      }, wait);
      return;
    }
    lane.items.shift();
    lane.busy = true;
    void this.send(item).then(
      (result) => {
        this.sent(lane, item);
        for (const done of item.done) done(result);
        this.after(key, lane);
      },
      (error: unknown) => {
        this.sent(lane, item);
        const pause = pauseFor(error, item);
        if (pause !== undefined && pause <= MAX_PAUSE_MS && item.tries + 1 < MAX_TRIES && !this.stopped) {
          // The service asked to be left alone: the channel waits, and this item goes first after.
          item.tries++;
          lane.pausedUntil = this.clock() + pause;
          lane.items.unshift(item);
        } else {
          this.report(error, item);
          for (const done of item.done) done(item.op.op === 'post' ? undefined : false);
        }
        this.after(key, lane);
      },
    );
  }

  private sent(lane: Lane, item: Item): void {
    lane.busy = false;
    const now = this.clock();
    if (item.op.op === 'edit') lane.lastEditAt = now;
    else lane.lastPostAt = now;
  }

  private after(key: string, lane: Lane): void {
    if (this.stopped && lane.items.length === 0) {
      this.wakeIdle();
      return;
    }
    this.pump(key, lane);
  }

  private wakeIdle(): void {
    if (this.hasWork()) return;
    for (const wake of this.idleWaiters.splice(0)) wake();
  }

  private report(error: unknown, item: Item): void {
    try {
      this.options.onError?.(error, { service: item.service, channelId: item.channelId, kind: item.kind, op: item.op.op });
    } catch {
      // A failing error handler must not stop the queue.
    }
  }

  private async send(item: Item): Promise<string | boolean> {
    const { op } = item;
    if (item.service === 'slack') {
      const auth = this.options.auth.slack();
      if (!auth) throw new ChatError('The agent bot is not connected to Slack.', 401);
      if (op.op === 'react') throw new ChatError('Reactions are sent only in Mattermost.', 400);
      if (op.body.service !== 'slack') throw new ChatError('That message was made for Mattermost.', 400);
      const { text, blocks } = op.body;
      if (op.op === 'post') return (await this.options.api.slackPost(auth, { channel: item.channelId, ...(op.threadId ? { threadTs: op.threadId } : {}), text, ...(blocks ? { blocks } : {}) })).ts;
      if (op.op === 'edit') {
        await this.options.api.slackUpdate(auth, { channel: item.channelId, ts: op.postId, text, ...(blocks ? { blocks } : {}) });
        return true;
      }
      await this.options.api.slackEphemeral(auth, {
        channel: item.channelId,
        user: op.userId,
        text,
        ...(op.threadId ? { threadTs: op.threadId } : {}),
        ...(blocks ? { blocks } : {}),
      });
      return true;
    }
    const auth = this.options.auth.mattermost();
    if (!auth) throw new ChatError('The agent bot is not connected to Mattermost.', 401);
    if (op.op === 'react') {
      await this.options.api.mmReact(auth, { userId: op.botUserId, postId: op.postId, emoji: op.emoji });
      return true;
    }
    if (op.op === 'ephemeral') throw new ChatError('Messages only one person sees are sent only in Slack.', 400);
    if (op.body.service !== 'mattermost') throw new ChatError('That message was made for Slack.', 400);
    const { message, attachments } = op.body;
    if (op.op === 'post')
      return (await this.options.api.mmPost(auth, { channelId: item.channelId, ...(op.threadId ? { rootId: op.threadId } : {}), message, ...(attachments ? { attachments } : {}) })).id;
    await this.options.api.mmPatch(auth, op.postId, { message, ...(attachments ? { attachments } : {}) });
    return true;
  }
}
