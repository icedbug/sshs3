import type { AgentBotIdentity } from '../../../shared/types/aiHub';
import { ChatError } from '../../ai/hub/ChatSources';
import type { GuardOptions } from '../../ai/hub/Notifier';
import { safeError } from '../../ai/hub/privacy';
import { connectWs, WsError, type WsClient, type WsClose, type WsConnector } from '../../net/wsClient';
import { MM_EMOJI, MM_ID, type AgentBotApi, type AgentMattermostAuth } from './AgentBotApi';
import { backoffDelay, deliver, RecentIds, STEADY_MS, type AgentEvent, type AgentSocketStatus, type BackoffOptions } from './agentSocket';

/**
 * The agent bot's line to Mattermost: the server's own WebSocket, opened outwards as the bot account.
 *
 * The token goes in the Authorization header of the upgrade. A server, or a proxy in front of it, that
 * does not take it there still opens the socket and waits: then the token is sent once more as an
 * authentication challenge, the way Mattermost's own apps do it. Posts and reactions are handed on
 * in one shape with Slack's; each event's sequence number is kept, so that a reconnect can ask the
 * server for what was missed while the socket was down.
 *
 * A server that takes a connection back says no hello: it goes on counting where it was, and sends
 * nothing at all when nothing was missed. So on such a reconnect the bot asks a small question at
 * once. An answer, or any counted event, shows the socket is signed in; a refusal means the header
 * was not taken, and the token is offered as a challenge.
 */

export interface MattermostSocketOptions {
  api: AgentBotApi;
  auth: () => AgentMattermostAuth | undefined;
  guard: () => GuardOptions;
  /** Who the bot is, when already known. Without a user name it is asked of Mattermost once, to take mentions out of the text. */
  identity?: AgentBotIdentity;
  /** For tests: opens the socket instead of connectWs. */
  connect?: WsConnector;
  onEvent: (event: AgentEvent) => unknown;
  onStatus?: (status: AgentSocketStatus) => unknown;
  onIdentity?: (identity: AgentBotIdentity) => unknown;
  backoff?: BackoffOptions;
  /** How long to wait for hello before the token is sent as a challenge, and again after. */
  helloWaitMs?: number;
}

interface MmEvent {
  event?: string;
  seq?: number;
  seq_reply?: number;
  status?: string;
  error?: { message?: string };
  data?: Record<string, unknown>;
  broadcast?: { channel_id?: string };
}

interface MmPost {
  id?: string;
  channel_id?: string;
  user_id?: string;
  root_id?: string;
  message?: string;
  type?: string;
  props?: Record<string, unknown>;
  file_ids?: unknown[];
}

const MAX_MESSAGE_BYTES = 1024 * 1024;

/** A Mattermost id, or nothing. What does not look like Mattermost's is not kept or handed on. */
const shaped = (value: unknown, shape: RegExp): string | undefined => (typeof value === 'string' && shape.test(value) ? value : undefined);

export class MattermostSocket {
  private stopped = true;
  private ws?: WsClient;
  private opening = false;
  private attempt = 0;
  private timer?: NodeJS.Timeout;
  /** Counts the starts and stops, so a connect from before a stop() cannot hold up the next start. */
  private generation = 0;
  private identity?: AgentBotIdentity;
  /** The server's id for this connection, and the next sequence number expected from it. */
  private connectionId = '';
  private expectedSeq = 0;
  /** Sequence numbers this bot's own actions use. */
  private actionSeq = 0;
  /** Events the server's sequence numbers show were missed, for the status line. */
  missed = 0;
  private readonly posts = new RecentIds();
  private readonly reactions = new RecentIds();

  constructor(private readonly options: MattermostSocketOptions) {
    this.identity = options.identity;
  }

  get connected(): boolean {
    return Boolean(this.ws?.isOpen);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    void this.open();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.generation++;
    this.opening = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    const ws = this.ws;
    this.ws = undefined;
    if (ws)
      await new Promise<void>((resolve) => {
        ws.on('close', () => resolve());
        ws.close(1000, 'stopped');
        setTimeout(resolve, 2000).unref?.();
      });
    this.status({ state: 'stopped' });
  }

  private status(status: AgentSocketStatus): void {
    deliver(this.options.onStatus, status);
  }

  /** A connect of an older start, or one after stop(): it must not touch the state of the current one. */
  private gone(generation: number): boolean {
    return this.stopped || generation !== this.generation;
  }

  private async open(): Promise<void> {
    if (this.stopped || this.opening) return;
    this.opening = true;
    const generation = this.generation;
    this.status({ state: 'connecting' });
    let ws: WsClient | undefined;
    try {
      const auth = this.options.auth();
      if (!auth?.token || !auth.baseUrl) throw new ChatError("The agent bot's Mattermost token is not saved.", 401);
      // The user name is what people type to mention the bot, and it is taken out of the text.
      if (!this.identity?.username) {
        const identity = await this.options.api.mmMe(auth);
        if (this.gone(generation)) return;
        this.identity = identity;
        deliver(this.options.onIdentity, { ...this.identity });
      }
      if (this.gone(generation)) return;
      const where = new URL(`${auth.baseUrl.trim().replace(/\/+$/, '')}/api/v4/websocket`);
      where.protocol = where.protocol === 'https:' ? 'wss:' : 'ws:';
      // Asks the server to send again what this connection missed, when it still has it.
      const resuming = Boolean(this.connectionId);
      if (resuming) {
        where.searchParams.set('connection_id', this.connectionId);
        where.searchParams.set('sequence_number', String(this.expectedSeq));
      }
      ws = (this.options.connect ?? connectWs)(where.toString(), {
        headers: { Authorization: `Bearer ${auth.token}` },
        guard: this.options.guard(),
        maxMessageBytes: MAX_MESSAGE_BYTES,
        timeoutMs: 15_000,
      });
      this.ws = ws;
      this.watch(ws, auth.token, generation, resuming);
      await ws.ready;
      if (this.gone(generation)) ws.close(1000, 'stopped');
    } catch (error) {
      if (ws && this.ws === ws) this.ws = undefined;
      if (this.gone(generation)) return;
      this.opening = false;
      this.retry(error);
    }
  }

  private watch(ws: WsClient, token: string, generation: number, resuming: boolean): void {
    /** Signed in and in use: hello came, or the server took the old connection back. */
    let ready = false;
    let readyAt = 0;
    let opened = false;
    let challengeSeq = 0;
    let probeSeq = 0;
    let refused = '';
    const wait = this.options.helloWaitMs ?? 3000;
    let timer: NodeJS.Timeout | undefined;
    const signedIn = (): void => {
      if (ready) return;
      ready = true;
      readyAt = Date.now();
      clearTimeout(timer);
      this.opening = false;
      this.status({ state: 'open' });
    };
    // The header was not taken: the token is offered the way Mattermost's own apps do.
    const challenge = (): void => {
      if (ready || challengeSeq) return;
      clearTimeout(timer);
      challengeSeq = ++this.actionSeq;
      try {
        ws.send(JSON.stringify({ seq: challengeSeq, action: 'authentication_challenge', data: { token } }));
      } catch {
        return;
      }
      timer = setTimeout(() => {
        if (!ready) {
          refused ||= "Mattermost did not take the agent bot's token on the socket.";
          ws.close(4000, 'no hello');
        }
      }, wait * 2);
      timer.unref?.();
    };
    ws.on('open', () => {
      opened = true;
      if (this.gone(generation)) return;
      if (resuming) {
        // Only a signed in socket answers this; one that is not answers with an error at once.
        probeSeq = ++this.actionSeq;
        try {
          ws.send(JSON.stringify({ seq: probeSeq, action: 'get_statuses_by_ids', data: { user_ids: [this.identity?.userId ?? ''] } }));
        } catch {
          return;
        }
      }
      timer = setTimeout(challenge, wait);
      timer.unref?.();
    });
    ws.on('message', (text) => {
      if (this.gone(generation)) return;
      let msg: MmEvent;
      try {
        msg = JSON.parse(text) as MmEvent;
      } catch {
        return;
      }
      if (typeof msg.seq_reply === 'number') {
        if (challengeSeq && msg.seq_reply === challengeSeq) {
          if (msg.status === 'OK') signedIn();
          else {
            refused = "Mattermost refused the agent bot's token on the socket.";
            ws.close(4001, 'refused');
          }
        } else if (probeSeq && msg.seq_reply === probeSeq) {
          if (msg.status === 'OK') signedIn();
          else challenge();
        }
        return;
      }
      if (msg.event === 'hello') {
        // Hello starts a connection's count, a new one or the old one started over.
        this.connectionId = shaped(msg.data?.connection_id, MM_ID) ?? '';
        this.expectedSeq = typeof msg.seq === 'number' ? msg.seq + 1 : 0;
        signedIn();
        return;
      }
      if (typeof msg.seq === 'number') {
        // Only a signed in socket is sent events: one without hello is the old connection taken back.
        signedIn();
        if (msg.seq > this.expectedSeq) this.missed += msg.seq - this.expectedSeq;
        this.expectedSeq = msg.seq + 1;
      }
      if (msg.event === 'posted') this.posted(msg);
      else if (msg.event === 'reaction_added') this.reacted(msg);
    });
    ws.on('close', (info: WsClose) => {
      clearTimeout(timer);
      if (this.ws === ws) this.ws = undefined;
      if (this.gone(generation)) return;
      // A socket that never opened is a connect that failed: open() hears of it from `ready` and tries again there.
      if (!opened) return;
      // The old connection could not be taken back: the next connect asks for a new one.
      if (resuming && !ready) this.connectionId = '';
      // The wait starts over only after a socket that stayed open a while, not one dropped right after hello.
      if (ready && Date.now() - readyAt >= (this.options.backoff?.steadyMs ?? STEADY_MS)) this.attempt = 0;
      const wasOpening = this.opening;
      this.opening = false;
      if (ready || wasOpening) this.retry(refused ? new Error(refused) : (info.error ?? new Error(info.reason || 'The socket to Mattermost closed.')));
    });
  }

  private retry(error: unknown): void {
    if (this.stopped || this.timer || this.opening) return;
    const asked = error instanceof ChatError || error instanceof WsError ? error.retryAfterMs : undefined;
    const delay = backoffDelay(this.attempt++, this.options.backoff, asked);
    this.status({ state: 'waiting', error: safeError(error).slice(0, 300), retryAt: Date.now() + delay });
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.open();
    }, delay);
    this.timer.unref?.();
  }

  /** A new post. Not the bot's own, not a system message, not another bot's or an integration's. */
  private posted(msg: MmEvent): void {
    const data = msg.data ?? {};
    let post: MmPost;
    try {
      post = JSON.parse(String(data.post ?? '')) as MmPost;
    } catch {
      return;
    }
    const botUser = this.identity?.userId ?? '';
    const id = shaped(post?.id, MM_ID);
    const channelId = shaped(post?.channel_id, MM_ID);
    const userId = shaped(post?.user_id, MM_ID);
    if (!id || !channelId || !userId || userId === botUser) return;
    const rootId = post.root_id ? shaped(post.root_id, MM_ID) : '';
    if (rootId === undefined) return;
    if ((post.type ?? '').startsWith('system_')) return;
    // Bots and webhooks answering each other would never stop.
    if (post.props?.from_bot === 'true' || post.props?.from_webhook === 'true') return;
    if (!this.posts.first(id)) return;
    let mentions: unknown;
    try {
      mentions = typeof data.mentions === 'string' ? JSON.parse(data.mentions) : (data.mentions ?? []);
    } catch {
      mentions = [];
    }
    const mentioned = Array.isArray(mentions) && Boolean(botUser) && mentions.includes(botUser);
    const username = this.identity?.username ?? '';
    let text = String(post.message ?? '');
    if (username) {
      const tag = `@${username.toLowerCase()}`;
      text = text
        .split(/(\s+)/)
        .filter((word) => word.toLowerCase().replace(/[.,:;!?]+$/, '') !== tag)
        .join('');
    }
    const sender = typeof data.sender_name === 'string' ? data.sender_name.replace(/^@/, '').slice(0, 120) : undefined;
    deliver(this.options.onEvent, {
      kind: 'message',
      service: 'mattermost',
      channelId,
      channelType: data.channel_type === 'D' ? 'im' : 'channel',
      threadId: rootId || id,
      messageId: id,
      userId,
      ...(sender ? { userName: sender } : {}),
      text: text.replace(/[ \t]{2,}/g, ' ').trim(),
      mentioned,
      ...(Array.isArray(post.file_ids) && post.file_ids.length ? { files: Math.min(post.file_ids.length, 100) } : {}),
    });
  }

  private reacted(msg: MmEvent): void {
    let reaction: { user_id?: string; post_id?: string; emoji_name?: string; channel_id?: string; create_at?: number };
    try {
      const raw = msg.data?.reaction;
      reaction = (typeof raw === 'string' ? JSON.parse(raw) : raw) as typeof reaction;
    } catch {
      return;
    }
    const userId = shaped(reaction?.user_id, MM_ID);
    const postId = shaped(reaction?.post_id, MM_ID);
    const emoji = shaped(reaction?.emoji_name, MM_EMOJI);
    const at = reaction?.create_at;
    if (!userId || !postId || !emoji || typeof at !== 'number' || !Number.isFinite(at)) return;
    if (userId === this.identity?.userId) return;
    if (!this.reactions.first(`${userId}:${postId}:${emoji}:${at}`)) return;
    const channelId = shaped(reaction.channel_id, MM_ID) ?? shaped(msg.broadcast?.channel_id, MM_ID);
    deliver(this.options.onEvent, {
      kind: 'reaction',
      service: 'mattermost',
      userId,
      postId,
      emoji,
      ...(channelId ? { channelId } : {}),
    });
  }
}
