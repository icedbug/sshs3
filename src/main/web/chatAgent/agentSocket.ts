import type { ChatServiceName } from '../../../shared/types/aiHub';

/**
 * What the agent bot's sockets hand on, the same shape for Slack and Mattermost, and the two things
 * both sockets need: a wait that grows between reconnects, and a short memory of what was already
 * handed on, because both services may send the same event twice.
 */

/** Somebody wrote to the agent bot: a mention in a channel, or a direct message. */
export interface AgentMessageEvent {
  kind: 'message';
  service: ChatServiceName;
  channelId: string;
  /** "im" for a direct message with the bot; everything else is a channel. */
  channelType: 'channel' | 'im';
  /** The thread's first message: the message itself when it starts one. */
  threadId: string;
  messageId: string;
  userId: string;
  /** Mattermost names the sender with the event. */
  userName?: string;
  /** The text, with the bot's own mention taken out. */
  text: string;
  /** The bot was named in it. In a channel the bot answers only then. */
  mentioned: boolean;
}

/** Somebody pressed a button on a message of the bot's. */
export interface AgentActionEvent {
  kind: 'action';
  service: ChatServiceName;
  userId: string;
  channelId: string;
  threadId: string;
  /** The message the button is on. */
  messageId: string;
  /** What the button carries: the signed token. */
  value: string;
  actionId: string;
}

/** Somebody reacted to a post (Mattermost): how a card is answered when buttons cannot reach sshs3. */
export interface AgentReactionEvent {
  kind: 'reaction';
  service: ChatServiceName;
  userId: string;
  postId: string;
  emoji: string;
  channelId?: string;
}

export type AgentEvent = AgentMessageEvent | AgentActionEvent | AgentReactionEvent;

/** How a socket is doing, for the administrator's status line. */
export interface AgentSocketStatus {
  state: 'connecting' | 'open' | 'waiting' | 'stopped';
  /** Why it is waiting. Never a token. */
  error?: string;
  /** When it tries again. */
  retryAt?: number;
}

export interface BackoffOptions {
  minMs?: number;
  maxMs?: number;
  random?: () => number;
  /**
   * How long a socket must stay open before the wait starts over at the shortest. A server that says
   * hello and drops the socket at once would otherwise be called again every second without end.
   */
  steadyMs?: number;
}

/** A minute open counts as working again. */
export const STEADY_MS = 60_000;

/**
 * How long to wait before reconnect number `attempt` (0 for the first): one second, doubling up to a
 * minute, with jitter so that many servers dropped at once do not all come back at once. Never
 * sooner than the service asked.
 */
export function backoffDelay(attempt: number, options: BackoffOptions = {}, retryAfterMs?: number): number {
  const min = options.minMs ?? 1000;
  const max = options.maxMs ?? 60_000;
  const random = options.random ?? Math.random;
  const base = Math.min(max, min * 2 ** Math.max(0, Math.min(attempt, 30)));
  const jittered = Math.max(min, Math.round(base * (0.5 + random() * 0.5)));
  return Math.max(jittered, retryAfterMs ?? 0);
}

/** A short memory of ids already handed on. Old ones are forgotten after `ttlMs`, and at most `max` are kept. */
export class RecentIds {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly max = 5000,
    private readonly clock: () => number = Date.now,
  ) {}

  /** True the first time an id is given within the time kept, false after. An empty id is never a repeat. */
  first(id: string | undefined): boolean {
    if (!id) return true;
    const now = this.clock();
    for (const [key, at] of this.seen) {
      if (now - at < this.ttlMs && this.seen.size < this.max) break;
      this.seen.delete(key);
    }
    if (this.seen.has(id)) return false;
    this.seen.set(id, now);
    return true;
  }
}

/** Calls a listener without letting it break the socket: a listener that throws or fails is its own problem. */
export function deliver<T>(listener: ((value: T) => unknown) | undefined, value: T): void {
  if (!listener) return;
  try {
    const result = listener(value);
    if (result && typeof (result as Promise<unknown>).catch === 'function') (result as Promise<unknown>).catch(() => undefined);
  } catch {
    // As above.
  }
}
