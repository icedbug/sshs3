import type { AgentBotIdentity } from '../../../shared/types/aiHub';
import { ChatError, slackText } from '../../ai/hub/ChatSources';
import type { GuardOptions } from '../../ai/hub/Notifier';
import { safeError } from '../../ai/hub/privacy';
import { connectWs, WsError, type WsClient, type WsClose, type WsConnector } from '../../net/wsClient';
import { SLACK_EVENT_ID, SLACK_ID, SLACK_TS, type AgentBotApi, type AgentSlackAuth } from './AgentBotApi';
import { backoffDelay, deliver, RecentIds, STEADY_MS, type AgentEvent, type AgentSocketStatus, type BackoffOptions } from './agentSocket';

/**
 * The agent bot's line to Slack: Socket Mode. The server opens the connection outwards, so no
 * public address is needed to hear mentions, direct messages and button presses.
 *
 * Slack wants every envelope acknowledged within three seconds or it sends it again, so each one is
 * acknowledged the moment it arrives, before anything else is done with it, and what was already
 * handed on is dropped when it comes again. Slack asks for a new socket now and then; the new one is
 * opened first and the old one closed after, so nothing said in between is lost.
 */

export interface SlackSocketOptions {
  api: AgentBotApi;
  /** The agent bot's tokens, asked for at each connect so a saved change is used. */
  auth: () => AgentSlackAuth | undefined;
  guard: () => GuardOptions;
  /** Who the bot is, when already known. Otherwise asked of Slack once. */
  identity?: AgentBotIdentity;
  /** For tests: opens the socket instead of connectWs, and then any host is taken. */
  connect?: WsConnector;
  onEvent: (event: AgentEvent) => unknown;
  onStatus?: (status: AgentSocketStatus) => unknown;
  /** Told when Slack said who the bot is, so it can be kept. */
  onIdentity?: (identity: AgentBotIdentity) => unknown;
  backoff?: BackoffOptions;
  /** How long a new socket may take to say hello. */
  helloTimeoutMs?: number;
}

interface SlackEnvelope {
  type?: string;
  envelope_id?: string;
  reason?: string;
  payload?: {
    event_id?: string;
    authorizations?: { user_id?: string }[];
    event?: SlackEvent;
    type?: string;
    user?: { id?: string };
    channel?: { id?: string };
    container?: { channel_id?: string; message_ts?: string; thread_ts?: string };
    message?: { ts?: string; thread_ts?: string };
    actions?: { action_id?: string; value?: string; type?: string }[];
  };
}

interface SlackEvent {
  type?: string;
  subtype?: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  bot_profile?: unknown;
  text?: string;
  ts?: string;
  thread_ts?: string;
}

const MAX_MESSAGE_BYTES = 1024 * 1024;
/** Slack takes up to 40,000 characters. Far less is enough for a question to the agent. */
const MAX_TEXT = 16_000;
/** Slack caps a button's value at 2,000 characters and an action id at 255. */
const MAX_VALUE = 2000;
const MAX_ACTION_ID = 255;
const LINK_DISABLED = "Socket Mode was turned off for the agent bot's Slack app.";

/** A Slack id of the given shape, or nothing. What does not look like Slack's is not kept or handed on. */
const shaped = (value: unknown, shape: RegExp): string | undefined => (typeof value === 'string' && shape.test(value) ? value : undefined);

export class SlackSocket {
  private stopped = true;
  /** The socket that said hello last: the one in use. */
  private active?: WsClient;
  private readonly sockets = new Set<WsClient>();
  /** A connect is under way, up to the new socket's hello. */
  private opening = false;
  private attempt = 0;
  private timer?: NodeJS.Timeout;
  /**
   * Counts the starts and stops. A connect still under way when stop() came belongs to an older
   * count: it then ends quietly, and what it opened is closed, so it cannot hold up the next start.
   */
  private generation = 0;
  /** Slack said Socket Mode was turned off: the next wait is a long one, and says why. */
  private disabled = false;
  private identity?: AgentBotIdentity;
  private readonly envelopes = new RecentIds();
  private readonly eventIds = new RecentIds();
  private readonly messages = new RecentIds();

  constructor(private readonly options: SlackSocketOptions) {
    this.identity = options.identity;
  }

  get connected(): boolean {
    return Boolean(this.active?.isOpen);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    void this.open();
  }

  /** Closes every socket and stops reconnecting. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.generation++;
    this.opening = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    const closing = [...this.sockets].map(
      (ws) =>
        new Promise<void>((resolve) => {
          ws.on('close', () => resolve());
          ws.close(1000, 'stopped');
          setTimeout(resolve, 2000).unref?.();
        }),
    );
    this.sockets.clear();
    this.active = undefined;
    await Promise.all(closing);
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
      if (!auth?.botToken || !auth.appToken) throw new ChatError("The agent bot's Slack tokens are not saved.", 401);
      if (!this.identity) {
        const identity = await this.options.api.slackAuthTest(auth);
        if (this.gone(generation)) return;
        this.identity = identity;
        deliver(this.options.onIdentity, { ...this.identity });
      }
      const url = await this.options.api.slackOpenSocket(auth);
      if (this.gone(generation)) return;
      if (!this.options.connect) {
        const where = new URL(url);
        // The address comes from Slack's answer; only Slack's own hosts are taken.
        if (where.protocol !== 'wss:' || !where.hostname.toLowerCase().endsWith('.slack.com'))
          throw new ChatError("Slack gave a socket address that is not Slack's.", 400);
      }
      ws = (this.options.connect ?? connectWs)(url, { guard: this.options.guard(), maxMessageBytes: MAX_MESSAGE_BYTES, timeoutMs: 15_000 });
      this.watch(ws, generation);
      await ws.ready;
      if (this.gone(generation)) ws.close(1000, 'stopped');
    } catch (error) {
      if (ws) this.sockets.delete(ws);
      if (this.gone(generation)) return;
      this.opening = false;
      this.retry(error);
    }
  }

  private watch(ws: WsClient, generation: number): void {
    this.sockets.add(ws);
    let helloed = false;
    let opened = false;
    let helloAt = 0;
    ws.on('open', () => (opened = true));
    const helloTimer = setTimeout(() => {
      if (!helloed) ws.close(4000, 'no hello');
    }, this.options.helloTimeoutMs ?? 30_000);
    helloTimer.unref?.();
    ws.on('message', (text) => {
      // A socket of before a stop() is being closed: Slack sends what it did not hear acknowledged again.
      if (this.gone(generation)) return;
      let envelope: SlackEnvelope;
      try {
        envelope = JSON.parse(text) as SlackEnvelope;
      } catch {
        return;
      }
      if (envelope.type === 'hello') {
        if (helloed) return;
        helloed = true;
        helloAt = Date.now();
        clearTimeout(helloTimer);
        this.promote(ws, generation);
        return;
      }
      if (envelope.type === 'disconnect') return this.disconnectAsked(ws, envelope.reason);
      // An id of any other shape is not Slack's: it is neither echoed nor kept.
      const envelopeId = shaped(envelope.envelope_id, SLACK_EVENT_ID);
      if (!envelopeId) return;
      // At once, before anything else: Slack sends an envelope again if it is not acknowledged in three seconds.
      try {
        ws.send(JSON.stringify({ envelope_id: envelopeId }));
      } catch {
        // The socket closed under us: Slack sends it again on the next one, and it is handled there.
        return;
      }
      if (!this.envelopes.first(envelopeId)) return;
      this.handle(envelope);
    });
    ws.on('close', (info) => {
      clearTimeout(helloTimer);
      this.sockets.delete(ws);
      if (this.gone(generation)) return;
      // A socket that never opened is a connect that failed: open() hears of it from `ready` and tries again there.
      if (!opened) return;
      const steady = helloed && Date.now() - helloAt >= (this.options.backoff?.steadyMs ?? STEADY_MS);
      this.closed(ws, info, helloed, steady);
    });
  }

  /** A new socket said hello: it is the one in use now, and the one it replaces is closed. */
  private promote(ws: WsClient, generation: number): void {
    if (this.gone(generation)) return void ws.close(1000, 'stopped');
    const old = this.active;
    this.active = ws;
    this.opening = false;
    this.disabled = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (old && old !== ws) {
      this.sockets.delete(old);
      old.close(1000, 'replaced');
    }
    this.status({ state: 'open' });
  }

  private disconnectAsked(ws: WsClient, reason: string | undefined): void {
    if (ws !== this.active) return;
    if (reason === 'link_disabled') {
      // Socket Mode was turned off for the app: trying again at once would only be refused.
      this.disabled = true;
      this.status({ state: 'waiting', error: LINK_DISABLED });
      return;
    }
    // refresh_requested and warning: the old socket ends soon. A new one is opened first.
    void this.open();
  }

  /**
   * A socket that had opened is closed. The wait starts over only after one that stayed open a while:
   * one dropped right after hello counts as a failed connect, so the wait keeps growing.
   */
  private closed(ws: WsClient, info: WsClose, helloed: boolean, steady: boolean): void {
    const why = (fallback: string): Error => info.error ?? new Error(info.reason || fallback);
    if (ws === this.active) {
      this.active = undefined;
      if (this.disabled) this.attempt = Math.max(this.attempt, 6);
      else if (steady) this.attempt = 0;
      if (!this.opening) this.retry(this.disabled ? new Error(LINK_DISABLED) : why('The socket to Slack closed.'));
      return;
    }
    // A socket that never said hello was a connect that failed.
    if (!helloed && this.opening) {
      this.opening = false;
      this.retry(why('The socket to Slack closed before it was ready.'));
    }
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

  private handle(envelope: SlackEnvelope): void {
    const payload = envelope.payload ?? {};
    if (envelope.type === 'events_api') {
      if (payload.event_id !== undefined && !shaped(payload.event_id, SLACK_EVENT_ID)) return;
      if (!this.eventIds.first(payload.event_id)) return;
      const botUser = this.identity?.userId ?? shaped(payload.authorizations?.[0]?.user_id, SLACK_ID) ?? '';
      const event = payload.event;
      if (event) this.message(event, botUser);
      return;
    }
    if (envelope.type === 'interactive' && payload.type === 'block_actions') {
      const userId = shaped(payload.user?.id, SLACK_ID);
      const channelId = shaped(payload.channel?.id ?? payload.container?.channel_id, SLACK_ID);
      const messageId = shaped(payload.container?.message_ts ?? payload.message?.ts, SLACK_TS);
      const threadId = shaped(payload.message?.thread_ts ?? payload.container?.thread_ts ?? messageId, SLACK_TS);
      if (!userId || !channelId || !messageId || !threadId) return;
      for (const action of (Array.isArray(payload.actions) ? payload.actions : []).slice(0, 25)) {
        if (typeof action?.value !== 'string' || action.value.length > MAX_VALUE) continue;
        deliver(this.options.onEvent, {
          kind: 'action',
          service: 'slack',
          userId,
          channelId,
          threadId,
          messageId,
          value: action.value,
          actionId: typeof action.action_id === 'string' ? action.action_id.slice(0, MAX_ACTION_ID) : '',
        });
      }
    }
    // Slash commands and anything else the app was not set up for: acknowledged, and nothing more.
  }

  /** A mention in a channel, or a direct message. Not the bot's own, not another bot's, not an edit or a join. */
  private message(event: SlackEvent, botUser: string): void {
    const isMention = event.type === 'app_mention';
    const isDirect = event.type === 'message' && event.channel_type === 'im';
    if (!isMention && !isDirect) return;
    if (event.subtype || event.bot_id || event.bot_profile) return;
    const user = shaped(event.user, SLACK_ID);
    const channel = shaped(event.channel, SLACK_ID);
    const ts = shaped(event.ts, SLACK_TS);
    if (!user || !channel || !ts || user === botUser) return;
    if (event.thread_ts !== undefined && !shaped(event.thread_ts, SLACK_TS)) return;
    // A message can come as a mention and as a direct message: it is handed on once.
    if (!this.messages.first(`${channel}:${ts}`)) return;
    // Cut before the patterns run, so a very long text costs no more than a long question.
    const raw = (typeof event.text === 'string' ? event.text : '').slice(0, MAX_TEXT);
    const own = botUser ? new RegExp(`<@${botUser.replace(/[^A-Z0-9]/gi, '')}(?:\\|[^>]*)?>`, 'g') : undefined;
    const mentioned = isMention || Boolean(botUser && raw.includes(`<@${botUser}`));
    const text = slackText(own ? raw.replace(own, ' ') : raw, new Map())
      .replace(/^[ \t]+|[ \t]+$/gm, '')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
    deliver(this.options.onEvent, {
      kind: 'message',
      service: 'slack',
      channelId: channel,
      channelType: isDirect || event.channel_type === 'im' ? 'im' : 'channel',
      threadId: event.thread_ts || ts,
      messageId: ts,
      userId: user,
      text,
      mentioned,
    });
  }
}
