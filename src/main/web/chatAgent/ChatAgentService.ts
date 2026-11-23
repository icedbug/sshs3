import crypto from 'node:crypto';
import type {
  AgentBotIdentity,
  AgentChange,
  AgentTask,
  ChatChannelRule,
  ChatFence,
  ChatOrigin,
  ChatServiceName,
  HubRequest,
  StartAgentTask,
} from '../../../shared/types/aiHub';
import type { AiEgressPolicy } from '../../../shared/types/ai';
import { validateChatEgress } from '../../../shared/dataDestination';
import type { HubRunEvent, RunView } from '../../ai/hub/areas/chatRuns';
import type { HubService } from '../../ai/hub/HubService';
import type { StoredMessage } from '../../ai/hub/ChatIndex';
import { chatServiceLabel, THREAD_CONTEXT_HEADS } from '../../ai/hub/chatFence';
import { isProdTag } from '../../ai/hub/safetyPolicy';
import { spotlightUntrustedData } from '../../ai/hub/ContextService';
import type { GuardOptions } from '../../ai/hub/Notifier';
import { clip, safeError } from '../../ai/hub/privacy';
import { createLogger } from '../../log';
import type { WsConnector } from '../../net/wsClient';
import type { ChatAgentAnswer } from '../WebTenantManager';
import type { AgentBotApi, AgentMattermostAuth, AgentSlackAuth, ChatPerson } from './AgentBotApi';
import type { AgentActionEvent, AgentEvent, AgentMessageEvent, AgentReactionEvent, AgentSocketStatus, BackoffOptions } from './agentSocket';
import type { ChatAgentStore, ChatLink, ChatThread, ChatThreadCard } from './ChatAgentStore';
import type { ChatAnsweringStore } from './ChatAnsweringStore';
import { signChatAction, verifyChatAction } from './chatActionToken';
import {
  changeCard,
  chatText,
  formatAnswer,
  note,
  planCard,
  REACTION_APPROVE,
  REACTION_DENY,
  RESTARTED_TEXT,
  statusText,
  type CardButtons,
  type CardChange,
  type CardOut,
  type CardOutcome,
  type ChatLimitKind,
  type ChatOut,
} from './chatFormat';
import { ChatOutbox, type OutboxApi, type OutboxGaps } from './ChatOutbox';
import { MattermostSocket } from './MattermostSocket';
import { SlackSocket } from './SlackSocket';

/**
 * The agent bot at work: it hears what people write to it in Slack and Mattermost, starts or goes on
 * with a conversation in the right hub, follows the run, and posts what the run says, its cards and
 * its answer back in the thread.
 *
 * Who may ask is the channel's rule: in a channel an administrator chose, anybody who mentions the bot;
 * in a direct message, every message. Who may answer a card is the link: only a person who linked their
 * chat account, and only what that account may approve in the app. What the chat says is the person's
 * question, and what the team wrote in the thread before is data put in front of the agent as such,
 * never instructions.
 *
 * Everything posted goes through one outbox (ChatOutbox), made from what the hub stored and masked
 * (runView), never from pieces of the model's stream. The context bot is only read from
 * (readThreadNow): nothing here writes through it.
 */

const log = createLogger('chat-agent');

/** The one conversation of a direct message: every message there goes on with it. */
export const DM_THREAD = 'dm';
/** The status post is edited at most this often while a run goes on. */
export const STATUS_EVERY_MS = 15_000;
/** At most this much of what the team wrote in a thread is given to the agent. */
const CONTEXT_MAX_CHARS = 8000;
const CONTEXT_MAX_MESSAGES = 50;
const NAME_TTL_MS = 3600_000;
const PRUNE_EVERY_MS = 24 * 3600_000;
const SERVICES: ChatServiceName[] = ['slack', 'mattermost'];

/** What the service asks of a hub. HubService is one; a test may give its own. */
export interface ChatHub {
  startFromChat(input: Omit<StartAgentTask, 'sessionId'>, origin: ChatOrigin): Promise<AgentTask>;
  replyFromChat(taskId: string, text: string): Promise<void>;
  onRun(listener: (event: HubRunEvent) => void): () => void;
  runView(taskId: string): RunView;
  chatApprovalSubject(taskId: string, id: string): ReturnType<HubService['chatApprovalSubject']>;
  request(asked: HubRequest): Promise<unknown>;
  store: { data: { tasks: AgentTask[] } };
}

/** Whose hub a conversation runs in. */
export type ChatOwner = 'agent' | `user:${string}`;

/** The agent bot's tokens and who it is, as AgentBotStore keeps them. */
export interface ChatBots {
  slack(): { botToken: string; appToken: string } | undefined;
  mattermost(): { baseUrl: string; token: string } | undefined;
  identity(service: ChatServiceName): AgentBotIdentity | undefined;
  setIdentity(service: ChatServiceName, identity: AgentBotIdentity): Promise<void>;
  setError(service: ChatServiceName, message: string | undefined): Promise<void>;
}

/** What the outbox calls, and the two reads that give a person's name. */
export type ChatAgentApi = OutboxApi & {
  slackUser?(auth: AgentSlackAuth, userId: string): Promise<ChatPerson>;
  mmUsers?(auth: AgentMattermostAuth, ids: string[]): Promise<ChatPerson[]>;
};

/** A line to a chat service that hands on what was said to the bot: a socket, or the simulated chat. */
export interface ChatTransport {
  start(): void;
  stop(): Promise<void>;
}

export interface ChatTransportOptions {
  identity?: AgentBotIdentity;
  onEvent: (event: AgentEvent) => unknown;
  onStatus: (status: AgentSocketStatus) => unknown;
  onIdentity: (identity: AgentBotIdentity) => unknown;
}

export type ChatTransportFactory = (service: ChatServiceName, options: ChatTransportOptions) => ChatTransport;

/** The real lines: Slack's Socket Mode and Mattermost's websocket. */
export function socketTransports(deps: {
  api: AgentBotApi;
  bots: Pick<ChatBots, 'slack' | 'mattermost'>;
  guard: () => GuardOptions;
  connect?: WsConnector;
  backoff?: BackoffOptions;
}): ChatTransportFactory {
  return (service, options) =>
    service === 'slack'
      ? new SlackSocket({ api: deps.api, auth: () => deps.bots.slack(), guard: deps.guard, connect: deps.connect, backoff: deps.backoff, ...options })
      : new MattermostSocket({ api: deps.api, auth: () => deps.bots.mattermost(), guard: deps.guard, connect: deps.connect, backoff: deps.backoff, ...options });
}

/** An sshs3 account as the service needs to know it. */
export interface ChatAccount {
  name: string;
  role: 'admin' | 'member';
  disabled?: boolean;
}

export interface ChatAgentServiceOptions {
  bots: ChatBots;
  api: ChatAgentApi;
  transport: ChatTransportFactory;
  /** Links, codes, threads and cards. */
  links: ChatAgentStore;
  /** The administrator's rules, the limits and the budget. */
  answering: ChatAnsweringStore;
  /** The context bot, only to read a thread now. Absent: the agent sees only what was written to the agent bot. */
  contextBot?: { readThreadNow(service: ChatServiceName, channelId: string, threadId: string): Promise<StoredMessage[] | undefined> };
  hubs: {
    /** The chat agent's own hub (svc_chat-agent). */
    agent(): Promise<ChatHub>;
    /** A linked person's own hub. Undefined when the account cannot be had. */
    person(accountId: string): Promise<ChatHub | undefined>;
  };
  accounts: { get(accountId: string): ChatAccount | undefined };
  answerForChatAgent(
    approverUserId: string,
    answer: { taskId: string; id: string; kind: 'change' | 'plan'; approved: boolean; note?: string; via: ChatServiceName; approvers?: 'linked' | 'admins' },
  ): Promise<ChatAgentAnswer>;
  /** The data policy of the chat agent ("agent") or of an account. */
  policyOf(owner: 'agent' | string): Promise<{ policy?: AiEgressPolicy; euAllowedHosts?: string[] } | undefined>;
  /** The key the buttons are signed with (loadChatActionSecret). */
  actionSecret(): Promise<Buffer>;
  /** The server's public address, for links into sshs3. */
  publicUrl?: () => string | undefined;
  /**
   * Whether Mattermost cards get buttons, which need the public address too. Mattermost's server posts a
   * press to that address, and only the address it comes from proves who pressed, so the server says
   * yes only when it knows that address (SSHS3_MATTERMOST_ACTION_FROM). Otherwise, and when this is
   * absent, people answer with a reaction, which reaches the bot over its own socket.
   */
  mattermostButtons?: () => boolean;
  /** Told when what waits for an answer in the chat agent's hub, or a link, changed: the app shows both. */
  changed?: () => void;
  /** Where a conversation is opened in sshs3. Default: the public address. */
  linkFor?: (owner: ChatOwner, taskId: string) => string | undefined;
  /** Told when a person linked or unlinked from chat, for the server's audit log. */
  audit?: (what: 'link' | 'unlink', link: ChatLink) => void;
  clock?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  statusEveryMs?: number;
  /** For tests: the outbox's gaps between posts. */
  outboxGaps?: Partial<Record<ChatServiceName, Partial<OutboxGaps>>>;
}

/** A conversation's place: the service, the channel, and the thread (DM_THREAD in a direct message). */
interface Place {
  service: ChatServiceName;
  channelId: string;
  threadId: string;
}

/** A run being followed. */
interface Followed {
  owner: ChatOwner;
  taskId: string;
  place: Place;
  lastEditAt: number;
  timer?: unknown;
  /** A status edit is queued already: another one waits for its turn instead of joining the line. */
  editQueued?: boolean;
  /** When the run that is followed now started: what it did is told, not what earlier runs did. */
  since: number;
  noted: Set<string>;
  /**
   * The run going on now was asked for from chat (a message, or an answer to one of its cards), or a
   * card of it still waits there. A run started in the app on the same conversation is not posted in
   * the chat, and is not counted against the chat's budget.
   */
  fromChat: boolean;
  /** Tokens of this conversation already counted against the month's budget. */
  counted: number;
  /** A hash of the last answer posted, so the same answer is not posted twice. */
  answered?: string;
}

interface Press {
  place: Place;
  owner: ChatOwner;
  taskId: string;
  cardId: string;
  kind: 'change' | 'plan';
  post: string;
  approved: boolean;
  userId: string;
  /** How it was given: a button carries a signed token; a reaction only names the post. */
  via: 'button' | 'reaction';
}

type Reply = (text: string, refusal: boolean) => Promise<void>;

const keyOf = (p: Place): string => `${p.service}:${p.channelId}:${p.threadId}`;
const followKey = (owner: ChatOwner, taskId: string): string => `${owner}|${taskId}`;
/** Where in the chat a conversation's posts go: in its thread, or straight into the direct message. */
const postThread = (p: Place): string | undefined => (p.threadId === DM_THREAD ? undefined : p.threadId);
const runActive = (task: AgentTask | undefined): boolean => Boolean(task && ['queued', 'running', 'waiting'].includes(task.status));
const ownerAccount = (owner: ChatOwner): string | undefined => (owner === 'agent' ? undefined : owner.slice('user:'.length));
const sha = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');
/** Words that could be a link code: eight letters and digits of the code's alphabet, maybe with a dash. */
const CODE_WORD = /(?:^|[^A-Za-z0-9])([A-Za-z2-7]{4}-?[A-Za-z2-7]{4})(?![A-Za-z0-9])/g;
const APPROVED_STATES: ReadonlySet<AgentChange['status']> = new Set(['approved', 'running', 'completed', 'failed', 'uncertain']);
/** stop() waits this long for work under way (a start, a redraw) before it lets the hubs go. */
const STOP_WAIT_MS = 2000;
const REACH_RANK: Record<ChatFence['reach'], number> = { read: 0, ask: 1, plan: 2 };
/** A fence written the same way whatever order its lists came in, to see whether it changed. */
const fenceKey = (f: ChatFence | undefined): string =>
  JSON.stringify(
    f
      ? {
          servers: f.servers === '*' ? '*' : [...f.servers].sort(),
          clusters: [...(f.clusters ?? [])].sort(),
          reach: f.reach,
          historyFrom: [...(f.historyFrom ?? [])].sort(),
          approvers: f.approvers ?? 'linked',
        }
      : null,
  );
/**
 * Whether a card may still be answered under a fence: a channel with reach "read" answers none.
 * A plan is answered in an "ask" channel too: a run there proposes one for a risky change, and approving
 * it is a person's answer like any other.
 */
const reachAllows = (fence: ChatFence): boolean => REACH_RANK[fence.reach] >= REACH_RANK.ask;
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

export class ChatAgentService {
  private outbox: ChatOutbox;
  private readonly clock: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly statusEveryMs: number;
  private running = false;
  private stopping = false;
  private refreshing: Promise<void> = Promise.resolve();
  private readonly transports = new Map<ChatServiceName, { fingerprint: string; transport: ChatTransport }>();
  private readonly statuses: Partial<Record<ChatServiceName, AgentSocketStatus>> = {};
  /** Who the bot is, as the line last said: known at once, before the store has written it. */
  private readonly identities: Partial<Record<ChatServiceName, AgentBotIdentity>> = {};
  private readonly followed = new Map<string, Followed>();
  /** Runs going on, over every hub: at most `concurrentRuns` at once. */
  private readonly active = new Set<string>();
  private readonly hubs = new Map<ChatOwner, { hub: ChatHub; stop: () => void }>();
  /** A start under way in a hub: events of a run not known yet wait for it. */
  private readonly starting = new Map<ChatOwner, number>();
  private readonly early = new Map<ChatOwner, HubRunEvent[]>();
  /** One message at a time per conversation, and one drawing at a time per thread. */
  private readonly messageLanes = new Map<string, Promise<void>>();
  private readonly drawLanes = new Map<string, Promise<void>>();
  private readonly names = new Map<string, { name: string; at: number }>();
  private pruneTimer?: ReturnType<typeof setInterval>;
  /** Redrawing what a restart cut off, in the background: the server does not wait for the chat. */
  private recovering: Promise<void> = Promise.resolve();
  private outboxStopped = false;

  constructor(private readonly options: ChatAgentServiceOptions) {
    this.clock = options.clock ?? Date.now;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.statusEveryMs = options.statusEveryMs ?? STATUS_EVERY_MS;
    this.outbox = this.newOutbox();
  }

  private newOutbox(): ChatOutbox {
    const { api, bots, outboxGaps } = this.options;
    return new ChatOutbox({
      api,
      auth: { slack: () => bots.slack(), mattermost: () => bots.mattermost() },
      onError: (error, item) => log.warn('The agent bot could not post', { service: item.service, op: item.op, kind: item.kind, error: safeError(error) }),
      gaps: outboxGaps,
      clock: this.clock,
    });
  }

  // ---- lifecycle ----------------------------------------------------------------------------------

  /**
   * Starts the lines to the chat services the agent bot has tokens for, after threads nobody wrote in
   * for 30 days are forgotten. Then, in the background, cards and status posts of runs a restart cut off
   * are drawn as stopped.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    if (this.outboxStopped) {
      // A stopped outbox takes nothing more: a start after a stop gets a new one.
      this.outbox = this.newOutbox();
      this.outboxStopped = false;
    }
    await Promise.all([this.options.links.initialize(), this.options.answering.initialize()]);
    await this.options.links.pruneThreads().catch((error) => log.warn('Old chat threads could not be pruned', safeError(error)));
    await this.refresh();
    // Not waited for: each redraw waits its turn in the chat's limits, and a slow chat must not keep
    // the server from starting.
    this.recovering = this.recover().catch((error) => log.warn('Chat threads cut off by a restart could not be redrawn', safeError(error)));
    this.pruneTimer = setInterval(() => void this.options.links.pruneThreads().catch(() => undefined), PRUNE_EVERY_MS);
    this.pruneTimer.unref?.();
  }

  /**
   * Starts, restarts or stops each line so it matches the saved tokens and on/off switches. Called
   * after the administrator saves the agent bot's connection; a line whose tokens did not change is left
   * as it is.
   */
  refresh(): Promise<void> {
    const run = async (): Promise<void> => {
      for (const service of SERVICES) {
        const creds = this.stopping || !this.running ? undefined : service === 'slack' ? this.options.bots.slack() : this.options.bots.mattermost();
        const fingerprint = creds ? sha(JSON.stringify(creds)) : '';
        const current = this.transports.get(service);
        if ((current?.fingerprint ?? '') === fingerprint) continue;
        if (current) {
          this.transports.delete(service);
          await current.transport.stop().catch(() => undefined);
          this.statuses[service] = { state: 'stopped' };
        }
        if (!fingerprint) continue;
        const transport = this.options.transport(service, {
          identity: this.options.bots.identity(service),
          onEvent: (event) => this.handleEvent(event),
          onStatus: (status) => this.onStatus(service, status),
          onIdentity: (identity) => {
            this.identities[service] = { ...identity };
            void this.options.bots.setIdentity(service, identity).catch(() => undefined);
          },
        });
        this.transports.set(service, { fingerprint, transport });
        transport.start();
      }
    };
    const next = this.refreshing.then(run, run);
    this.refreshing = next.catch(() => undefined);
    return next;
  }

  /** How each line is doing, for the administrator. */
  connectionStatus(): Partial<Record<ChatServiceName, AgentSocketStatus>> {
    return { ...this.statuses };
  }

  /**
   * Closes the lines, lets what is queued go out for a short while, and stops following runs. Bounded
   * in time: the outbox is stopped first, so a post that waits on a pause the chat asked for gives up at
   * once, and work still under way (a start that opens a terminal) is waited for only briefly.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.stopping = true;
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = undefined;
    await this.refresh();
    this.running = false;
    for (const f of this.followed.values()) if (f.timer !== undefined) this.clearTimer(f.timer);
    await this.outbox.stop({ drain: true, drainMs: 3000 });
    this.outboxStopped = true;
    await Promise.race([Promise.allSettled([this.recovering, ...this.messageLanes.values(), ...this.drawLanes.values()]), delay(STOP_WAIT_MS)]);
    // Only now: work that was under way finds its hub without starting to listen to it again.
    this.followed.clear();
    for (const { stop } of this.hubs.values()) stop();
    this.hubs.clear();
    this.active.clear();
  }

  private onStatus(service: ChatServiceName, status: AgentSocketStatus): void {
    this.statuses[service] = { ...status };
    if (status.state === 'open') void this.options.bots.setError(service, undefined).catch(() => undefined);
    else if (status.state === 'waiting' && status.error) void this.options.bots.setError(service, status.error).catch(() => undefined);
  }

  // ---- what the chat says ------------------------------------------------------------------------

  /** One event from a line. Never throws: a failure is logged, and the line goes on. */
  async handleEvent(event: AgentEvent): Promise<void> {
    if (!this.running || this.stopping) return;
    try {
      if (event.kind === 'message') await this.onMessage(event);
      else if (event.kind === 'action') await this.onAction(event);
      else await this.onReaction(event);
    } catch (error) {
      log.warn('A chat event could not be handled', { kind: event.kind, service: event.service, error: safeError(error) });
    }
  }

  private async onMessage(e: AgentMessageEvent): Promise<void> {
    const dm = e.channelType === 'im';
    const text = e.text.trim();
    if (!dm) {
      // A link code written where others can read it is turned off at once, mentioned or not.
      const voided = await this.voidCodes(e.service, text);
      const asksToLink = e.mentioned && /^link\b/i.test(text);
      // A code that was live is always said to be turned off; "link" asked again and again is answered a few times an hour.
      if (voided || (asksToLink && this.mayReply('link', e))) {
        await this.say({ service: e.service, channelId: e.channelId, threadId: e.threadId }, chatText.codeInChannel());
        return;
      }
      if (asksToLink) return;
      // In a channel the bot answers only when it is named, in its own thread too.
      if (!e.mentioned) return;
    }
    const place: Place = { service: e.service, channelId: e.channelId, threadId: dm ? DM_THREAD : e.threadId };
    await this.serial(this.messageLanes, keyOf(place), () => this.message(e, place, text));
  }

  private async voidCodes(service: ChatServiceName, text: string): Promise<boolean> {
    let voided = false;
    let count = 0;
    for (const match of text.matchAll(CODE_WORD)) {
      if (++count > 20) break;
      if (await this.options.links.voidCode(service, match[1])) voided = true;
    }
    return voided;
  }

  private async message(e: AgentMessageEvent, place: Place, text: string): Promise<void> {
    const { links, answering } = this.options;
    const dm = place.threadId === DM_THREAD;
    if (dm && (await this.command(e, place, text))) return;

    let rule: ChatChannelRule | undefined;
    let fence: ChatFence | undefined;
    const link = links.linkOf(e.service, e.userId);
    if (!dm) {
      fence = answering.fenceFor(e.service, { kind: 'channel', channelId: e.channelId });
      rule = answering.channelRule(e.service, e.channelId);
      if (!fence || !rule) {
        // Once an hour per channel: a bot that answers every mention with "not here" would be noise.
        if (answering.take('off-reply', `off:${e.service}:${e.channelId}`)) await this.say(place, chatText.channelOff());
        return;
      }
    } else {
      fence = answering.fenceFor(e.service, { kind: 'dm', linked: Boolean(link) });
      if (!fence) {
        const s = answering.settings();
        if (this.mayReply('dm-off', e)) await this.say(place, !s.enabled || !s.dms.enabled ? chatText.dmsOff() : chatText.dmsLinkedOnly());
        return;
      }
    }
    // A direct message from a linked person runs in their own hub; everything else in the chat agent's.
    const owner: ChatOwner = dm && link ? `user:${link.accountId}` : 'agent';

    if (e.files && this.mayReply('files', e)) await this.say(place, chatText.attachmentsNotRead());
    if (!text) {
      if (!e.files && this.mayReply('help', e)) await this.say(place, chatText.help());
      return;
    }

    const hub = await this.hubOf(owner);
    if (!hub) {
      await this.say(place, chatText.runFailed('Your sshs3 account could not be opened.'));
      return;
    }
    let thread = links.thread(e.service, e.channelId, place.threadId);
    // A thread is gone on with only where it belongs now: the same hub, the same person in a direct message, a task still there.
    if (
      thread &&
      (thread.owner !== owner ||
        (owner !== 'agent' && thread.askedBy.chatUserId !== e.userId) ||
        !hub.store.data.tasks.some((t) => t.id === thread!.taskId))
    )
      thread = undefined;
    const task = thread ? hub.store.data.tasks.find((t) => t.id === thread!.taskId) : undefined;
    if (thread && runActive(task)) {
      if (this.mayReply('busy', e)) await this.say(place, chatText.busy());
      return;
    }
    // A conversation holds to the fence it started with. When an administrator changed the channel's
    // rule since, it is not gone on with: a new one starts under the rule as it is now.
    const fenceChanged = Boolean(thread && fenceKey(task?.chat?.fence) !== fenceKey(fence));
    if (fenceChanged) thread = undefined;

    const over = this.overLimit(e, !thread);
    if (over) {
      if (answering.take('off-reply', `limit:${over.kind}:${over.key}`)) await this.say(place, chatText.rateLimited(over.kind, over.limit));
      return;
    }
    if (!answering.withinBudget()) {
      if (answering.take('off-reply', `budget:${e.service}:${e.channelId}`)) await this.say(place, chatText.budgetSpent());
      return;
    }
    if (!(await this.egressAllowed(owner, e.service))) {
      if (this.mayReply('policy', e)) await this.say(place, chatText.dataPolicy(chatServiceLabel(e.service)));
      return;
    }
    // Checked and held in one step, so two threads asking at once cannot both take the last place.
    if (this.activeCount() >= answering.limits().concurrentRuns) {
      if (this.mayReply('runs', e)) await this.say(place, chatText.rateLimited('runs'));
      return;
    }
    const slot = `starting:${crypto.randomUUID()}`;
    this.active.add(slot);
    try {
      this.countLimits(e, !thread);
      if (fenceChanged) await this.say(place, chatText.fenceChanged());
      const name = await this.nameOf(e.service, e.userId, e.userName);
      const context = !dm && e.threadId !== e.messageId ? await this.threadContext(e, thread?.seenAt) : '';
      if (thread) await this.goOn(hub, owner, place, thread, name, text, context, slot);
      else await this.begin(hub, owner, place, e, { rule, fence, link, name, text, context }, slot);
    } finally {
      this.active.delete(slot);
    }
  }

  /**
   * Whether a plain reply of this kind may go to this person now: a few an hour, so one person writing
   * again and again cannot fill the channel's queue ahead of the cards and answers of others.
   */
  private mayReply(kind: string, e: { service: ChatServiceName; userId: string }): boolean {
    return this.options.answering.take('short-reply', `${kind}:${e.service}:${e.userId}`);
  }

  /** link, unlink and help in a direct message. Says whether the message was one of them. */
  private async command(e: AgentMessageEvent, place: Place, text: string): Promise<boolean> {
    const { links } = this.options;
    if (/^help[.!?]*$/i.test(text)) {
      await this.say(place, chatText.help());
      return true;
    }
    if (/^unlink[.!?]*$/i.test(text)) {
      const link = links.linkOf(e.service, e.userId);
      const done = link ? await links.unlink({ service: e.service, chatUserId: e.userId }, { accountId: link.accountId, admin: false }) : false;
      if (done && link) {
        this.options.audit?.('unlink', link);
        this.changed();
      }
      await this.say(place, done ? chatText.unlinkDone() : chatText.unlinkNone());
      return true;
    }
    const asked = /^link(?:\s+(.+))?$/is.exec(text);
    if (!asked) return false;
    const code = asked[1]?.trim();
    if (!code) {
      await this.say(place, chatText.help());
      return true;
    }
    const name = await this.nameOf(e.service, e.userId, e.userName);
    const result = await links.redeem(e.service, e.userId, name, code);
    if (result.ok) {
      this.options.audit?.('link', result.link);
      this.changed();
      await this.say(place, chatText.linkDone(this.options.accounts.get(result.link.accountId)?.name ?? ''));
    } else await this.say(place, result.message);
    return true;
  }

  private overLimit(e: AgentMessageEvent, isNew: boolean): { kind: ChatLimitKind; key: string; limit: number } | undefined {
    const { answering } = this.options;
    const limits = answering.limits();
    const person = `${e.service}:${e.userId}`;
    if (isNew && !answering.may('person-new', person)) return { kind: 'person-new', key: person, limit: limits.personNewPerHour };
    if (!answering.may('person-message', person)) return { kind: 'person-messages', key: person, limit: limits.personMessagesPerHour };
    const channel = `${e.service}:${e.channelId}`;
    if (e.channelType !== 'im' && !answering.may('channel', channel)) return { kind: 'channel', key: channel, limit: limits.channelPerHour };
    return undefined;
  }

  private countLimits(e: AgentMessageEvent, isNew: boolean): void {
    const { answering } = this.options;
    const person = `${e.service}:${e.userId}`;
    if (isNew) answering.count('person-new', person);
    answering.count('person-message', person);
    if (e.channelType !== 'im') answering.count('channel', `${e.service}:${e.channelId}`);
  }

  /** Runs going on now, over every hub. One whose hub says it ended is no longer counted. */
  private activeCount(): number {
    for (const key of [...this.active]) {
      const [owner, taskId] = key.split('|') as [ChatOwner, string];
      const hub = this.hubs.get(owner)?.hub;
      const task = hub?.store.data.tasks.find((t) => t.id === taskId);
      if (hub && !runActive(task)) this.active.delete(key);
    }
    return this.active.size;
  }

  /** Whether answers may go to this chat service under the data policy of whose hub runs it. */
  private async egressAllowed(owner: ChatOwner, service: ChatServiceName): Promise<boolean> {
    let policy: { policy?: AiEgressPolicy; euAllowedHosts?: string[] } | undefined;
    try {
      policy = await this.options.policyOf(ownerAccount(owner) ?? 'agent');
    } catch {
      // Not known is not allowed.
      return false;
    }
    const baseUrl = service === 'mattermost' ? this.options.bots.mattermost()?.baseUrl : undefined;
    return validateChatEgress(policy?.policy, service, baseUrl, { euAllowedHosts: policy?.euAllowedHosts }).allowed;
  }

  /**
   * What the team wrote in this thread before the agent was asked, from the context bot, when it reads
   * this channel. Framed as data: the agent is told it is not instructions, and it is wrapped so text in
   * it cannot pass for the conversation's own.
   */
  private async threadContext(e: AgentMessageEvent, after: number | undefined): Promise<string> {
    const reader = this.options.contextBot;
    if (!reader) return '';
    let messages: StoredMessage[] | undefined;
    try {
      messages = await reader.readThreadNow(e.service, e.channelId, e.threadId);
    } catch {
      return '';
    }
    const earlier = (messages ?? [])
      .filter((m) => m.id !== e.messageId && (after === undefined || m.at > after))
      .sort((a, b) => a.at - b.at)
      .slice(-CONTEXT_MAX_MESSAGES);
    if (!earlier.length) return '';
    const lines = earlier.map((m) => `${clip(m.author || 'somebody', 80)} (${new Date(m.at).toISOString().slice(0, 16).replace('T', ' ')} UTC): ${m.text}`);
    return [
      after === undefined ? THREAD_CONTEXT_HEADS.before : THREAD_CONTEXT_HEADS.since,
      spotlightUntrustedData(lines.join('\n'), 'team chat thread', { maxChars: CONTEXT_MAX_CHARS }),
    ].join('\n');
  }

  private async begin(
    hub: ChatHub,
    owner: ChatOwner,
    place: Place,
    e: AgentMessageEvent,
    asked: { rule?: ChatChannelRule; fence: ChatFence; link?: ChatLink; name: string; text: string; context: string },
    slot: string,
  ): Promise<void> {
    const dm = place.threadId === DM_THREAD;
    if (dm && !asked.link) await this.say(place, chatText.unlinkedReadOnly());
    const statusPost = await this.outbox.post(place.service, place.channelId, note(place.service, statusText({ status: 'queued', pending: [] })), {
      threadId: postThread(place),
      kind: 'status',
    });
    const origin: ChatOrigin = {
      service: place.service,
      channelId: place.channelId,
      channelName: dm ? 'direct message' : asked.rule?.channelName || place.channelId,
      threadId: place.threadId,
      kind: dm ? 'dm' : 'channel',
      askedBy: { chatUserId: e.userId, name: asked.name, ...(asked.link ? { accountId: asked.link.accountId } : {}) },
      // A copy: what the run holds to does not change when the administrator edits the channel later.
      fence: structuredClone(asked.fence),
    };
    const prompt = asked.context ? `${asked.text}\n\n${asked.context}` : asked.text;
    this.starting.set(owner, (this.starting.get(owner) ?? 0) + 1);
    let task: AgentTask;
    try {
      task = await hub.startFromChat({ prompt, mode: 'assisted', ...(asked.rule?.agentId ? { agentId: asked.rule.agentId } : {}) }, origin);
    } catch (error) {
      this.doneStarting(owner);
      if (statusPost) await this.outbox.edit(place.service, place.channelId, statusPost, note(place.service, chatText.runFailed(safeError(error))));
      else await this.say(place, chatText.runFailed(safeError(error)));
      return;
    }
    try {
      await this.options.links.setThread(place.service, place.channelId, place.threadId, {
        owner,
        taskId: task.id,
        ...(statusPost ? { statusPost } : {}),
        cards: {},
        askedBy: { chatUserId: e.userId, name: asked.name },
        seenAt: this.clock(),
        counted: 0,
      });
      const f = this.follow(owner, task.id, place);
      f.fromChat = true;
      // The run takes the place its start held: counted once.
      this.active.add(followKey(owner, task.id));
      this.active.delete(slot);
    } finally {
      this.doneStarting(owner, task.id);
    }
  }

  private async goOn(hub: ChatHub, owner: ChatOwner, place: Place, thread: ChatThread, name: string, text: string, context: string, slot: string): Promise<void> {
    const statusPost = await this.outbox.post(place.service, place.channelId, note(place.service, statusText({ status: 'queued', pending: [] })), {
      threadId: postThread(place),
      kind: 'status',
    });
    await this.options.links.patchThread(place.service, place.channelId, place.threadId, (t) => {
      if (statusPost) t.statusPost = statusPost;
      t.statusDone = false;
      t.seenAt = this.clock();
    });
    const f = this.follow(owner, thread.taskId, place);
    f.since = this.clock();
    f.lastEditAt = this.clock();
    f.fromChat = true;
    // The run takes the place the message held: counted once.
    this.active.add(followKey(owner, thread.taskId));
    this.active.delete(slot);
    // Who wrote it is said, so the agent can tell people in one thread apart. It goes on in the same run only.
    const said = `${clip(name, 80)} wrote: ${text}${context ? `\n\n${context}` : ''}`;
    try {
      await hub.replyFromChat(thread.taskId, said);
    } catch (error) {
      this.active.delete(followKey(owner, thread.taskId));
      if (statusPost) await this.outbox.edit(place.service, place.channelId, statusPost, note(place.service, chatText.runFailed(safeError(error))));
      else await this.say(place, chatText.runFailed(safeError(error)));
    }
  }

  // ---- following runs ------------------------------------------------------------------------------

  private async hubOf(owner: ChatOwner): Promise<ChatHub | undefined> {
    let hub: ChatHub | undefined;
    try {
      hub = owner === 'agent' ? await this.options.hubs.agent() : await this.options.hubs.person(ownerAccount(owner)!);
    } catch (error) {
      log.warn('A hub for the chat could not be had', safeError(error));
      return undefined;
    }
    if (!hub) return undefined;
    const known = this.hubs.get(owner);
    // While stopping, work still under way gets its hub, but nothing starts listening to it again.
    if (known?.hub !== hub && !this.stopping) {
      known?.stop();
      const stop = hub.onRun((event) => this.onRun(owner, event));
      this.hubs.set(owner, { hub, stop });
    }
    return hub;
  }

  private follow(owner: ChatOwner, taskId: string, place: Place): Followed {
    const key = followKey(owner, taskId);
    let f = this.followed.get(key);
    if (!f) {
      // What was counted and answered is the thread's, while the thread is still this conversation's.
      const thread = this.threadOf(place);
      const mine = thread && thread.taskId === taskId && thread.owner === owner ? thread : undefined;
      f = {
        owner,
        taskId,
        place,
        lastEditAt: this.clock(),
        since: this.clock(),
        noted: new Set(),
        fromChat: false,
        counted: mine?.counted ?? 0,
        ...(mine?.answered ? { answered: mine.answered } : {}),
      };
      this.followed.set(key, f);
    }
    return f;
  }

  /** The thread at a run's place, only while it is still that run's conversation. */
  private ownThread(f: { owner: ChatOwner; taskId: string; place: Place }): ChatThread | undefined {
    const thread = this.threadOf(f.place);
    return thread && thread.taskId === f.taskId && thread.owner === f.owner ? thread : undefined;
  }

  /** The app shows what waits for an answer and who linked: it is told to read them again. */
  private changed(): void {
    try {
      this.options.changed?.();
    } catch {
      // Telling the app must never stop the chat.
    }
  }

  private doneStarting(owner: ChatOwner, taskId?: string): void {
    const left = (this.starting.get(owner) ?? 1) - 1;
    if (left > 0) this.starting.set(owner, left);
    else this.starting.delete(owner);
    const waiting = this.early.get(owner) ?? [];
    const keep = left > 0 ? waiting.filter((e) => e.taskId !== taskId) : [];
    if (keep.length) this.early.set(owner, keep);
    else this.early.delete(owner);
    if (taskId) for (const event of waiting.filter((e) => e.taskId === taskId)) this.onRun(owner, event);
  }

  /** A hub told what a run did. Only runs this service started or goes on with are followed. */
  private onRun(owner: ChatOwner, event: HubRunEvent): void {
    if (!this.running || this.stopping) return;
    // What waits for an answer in the chat agent's hub is listed in the app too.
    if (owner === 'agent' && event.type !== 'progress') this.changed();
    const f = this.followed.get(followKey(owner, event.taskId));
    if (!f) {
      // A run just started may say something before its start returns: kept until it is known.
      if (this.starting.get(owner)) {
        const list = this.early.get(owner) ?? [];
        if (list.length < 200) list.push(event);
        this.early.set(owner, list);
      }
      return;
    }
    void this.serial(this.drawLanes, keyOf(f.place), () => this.runEvent(f, event)).catch((error) =>
      log.warn('A chat run could not be followed', safeError(error)),
    );
  }

  private async runEvent(f: Followed, event: HubRunEvent): Promise<void> {
    const hub = this.hubs.get(f.owner)?.hub;
    if (!hub) return;
    switch (event.type) {
      case 'progress': {
        // A run started in the app on this conversation is not told in the chat.
        if (!f.fromChat) return;
        // A run an answer started (a plan approved, a change answered) counts as one going on, like any other.
        if (runActive(hub.store.data.tasks.find((t) => t.id === f.taskId))) this.active.add(followKey(f.owner, f.taskId));
        this.statusSoon(f);
        return;
      }
      case 'asking':
        if (!f.fromChat) return;
        await this.drawCard(f.place, f.owner, f.taskId, event.changeId, 'change', true);
        this.statusSoon(f);
        return;
      case 'answered':
        // A card already in the chat shows how it was answered, wherever the answer came from.
        await this.drawCard(f.place, f.owner, f.taskId, event.changeId, 'change', false);
        return;
      case 'plan': {
        // A newer plan replaces an older card's.
        const thread = this.ownThread(f);
        for (const [id, card] of Object.entries(thread?.cards ?? {}))
          if (card.kind === 'plan' && id !== event.planId && !card.final) await this.drawCard(f.place, f.owner, f.taskId, id, 'plan', false);
        await this.drawCard(f.place, f.owner, f.taskId, event.planId, 'plan', f.fromChat && event.status === 'proposed');
        return;
      }
      case 'settled':
        await this.settle(f, hub);
        return;
    }
  }

  private threadOf(place: Place): ChatThread | undefined {
    return this.options.links.thread(place.service, place.channelId, place.threadId);
  }

  /**
   * The status post is edited at most every 15 seconds while a run goes on. One edit at a time waits in
   * the thread's line: progress told while it waits does not queue another.
   */
  private statusSoon(f: Followed): void {
    if (f.timer !== undefined || f.editQueued) return;
    const wait = f.lastEditAt + this.statusEveryMs - this.clock();
    const queue = (): void => {
      f.editQueued = true;
      void this.serial(this.drawLanes, keyOf(f.place), () => this.editStatus(f).then(() => undefined));
    };
    if (wait <= 0) {
      queue();
      return;
    }
    f.timer = this.setTimer(() => {
      f.timer = undefined;
      if (this.followed.get(followKey(f.owner, f.taskId)) !== f) return;
      queue();
    }, wait);
  }

  /**
   * Edits the status post of the run's own thread, and says whether the edit went out. A thread that
   * is another conversation's now is not touched, nor one whose answers the data policy keeps out of
   * this chat now.
   */
  private async editStatus(f: Followed, text?: string): Promise<boolean> {
    f.editQueued = false;
    const hub = this.hubs.get(f.owner)?.hub;
    const post = this.ownThread(f)?.statusPost;
    if (!hub || !post) return false;
    let line = text;
    if (line === undefined) {
      try {
        line = statusText(hub.runView(f.taskId));
      } catch {
        return false;
      }
    }
    f.lastEditAt = this.clock();
    if (!(await this.mayPost(f.owner, f.place))) return false;
    return this.outbox.edit(f.place.service, f.place.channelId, post, note(f.place.service, line), { kind: 'status' });
  }

  /**
   * A run ended: the status post shows how, cards no one can answer any more show their outcome, a
   * change a freeze stopped is said, and the answer is posted: the stored text, masked again. What the
   * run used is counted against the month's budget.
   *
   * Only for a run asked for from chat. One started in the app on the same conversation is not posted
   * and not counted; only the chat's own cards are drawn as they end.
   */
  private async settle(f: Followed, hub: ChatHub): Promise<void> {
    if (f.timer !== undefined) this.clearTimer(f.timer);
    f.timer = undefined;
    this.active.delete(followKey(f.owner, f.taskId));
    const task = hub.store.data.tasks.find((t) => t.id === f.taskId);
    if (!task) return;
    const { place } = f;
    let view: RunView;
    try {
      view = hub.runView(f.taskId);
    } catch {
      return;
    }
    // The conversation's own, and what the background runs it asked for (a plan's reviewer, investigators) used.
    const used = (task.usage?.inputTokens ?? 0) + (task.usage?.outputTokens ?? 0) + (task.chatBackgroundTokens ?? 0);
    const fromChat = f.fromChat;
    if (fromChat && used > f.counted) await this.options.answering.addUsage(used - f.counted).catch(() => undefined);
    f.counted = Math.max(used, f.counted);

    let statusDone = false;
    let answered = f.answered;
    if (fromChat && (await this.mayPost(f.owner, place))) {
      statusDone = await this.editStatus(f, statusText(view));
      for (const change of task.changes) {
        if (f.noted.has(change.id) || change.decidedHow !== 'policy' || (change.at ?? 0) < f.since - 1000) continue;
        if (!/change freeze/i.test(change.output ?? '')) continue;
        f.noted.add(change.id);
        const until = Date.parse(/until (\S+?)\.(?:\s|$)/.exec(change.output ?? '')?.[1] ?? '');
        await this.say(place, chatText.freeze(change.target, Number.isFinite(until) ? until : undefined));
      }
      if (view.status === 'failed') await this.say(place, chatText.runFailed(view.error));
      else if (view.status !== 'cancelled' && view.text?.trim()) {
        // The answer is the conversation's last message from the agent: one posted already is not posted
        // again, but the same words in a later message (a second "Done.") are a new answer.
        const said = [...task.messages].reverse().find((m) => m.role === 'assistant');
        const hash = sha(`${said?.id ?? ''}\n${view.text}`);
        if (hash !== answered) {
          const link = this.linkOf(f.owner, f.taskId);
          let all = true;
          for (const part of formatAnswer(place.service, view.text, link ? { link: { url: link, label: 'Open in sshs3' } } : {}))
            if (!(await this.outbox.post(place.service, place.channelId, part, { threadId: postThread(place), kind: 'answer' }))) all = false;
          // Kept as posted only when every part went out: one that did not is posted again at the next end.
          if (all) answered = hash;
        }
      }
    }
    f.answered = answered;
    const own = this.ownThread(f);
    for (const [id, card] of Object.entries(own?.cards ?? {}))
      if (!card.final) await this.drawCard(place, f.owner, f.taskId, id, card.kind, false);
    if (!own) {
      // The thread is another conversation's now: nothing more of this one is the chat's.
      f.fromChat = false;
      return;
    }
    await this.options.links.patchThread(place.service, place.channelId, place.threadId, (t) => {
      if (t.taskId !== f.taskId || t.owner !== f.owner) return;
      if (statusDone) t.statusDone = true;
      t.counted = Math.max(f.counted, t.counted ?? 0);
      if (answered) t.answered = answered;
    });
    // While a card of the chat's still waits (a plan waits without a run), what answering it starts is the chat's.
    f.fromChat = Object.values(this.ownThread(f)?.cards ?? {}).some((c) => !c.final);
  }

  /**
   * Whether data may be posted in this place now, under the data policy of whose hub the conversation
   * runs in. Checked before every post or edit that carries what a run did, not only when it started:
   * a run can wait a day for an answer, and the policy can change meanwhile. When it may not, the
   * thread is told so once an hour, and the conversation is left to be answered in sshs3.
   */
  private async mayPost(owner: ChatOwner, place: Place): Promise<boolean> {
    if (await this.egressAllowed(owner, place.service)) return true;
    if (this.options.answering.take('off-reply', `policy:${keyOf(place)}`)) await this.say(place, chatText.dataPolicy(chatServiceLabel(place.service)));
    return false;
  }

  // ---- cards ---------------------------------------------------------------------------------------

  private linkOf(owner: ChatOwner, taskId: string): string | undefined {
    if (this.options.linkFor) return this.options.linkFor(owner, taskId);
    const base = this.options.publicUrl?.()?.trim().replace(/\/+$/, '');
    return base ? `${base}/` : undefined;
  }

  /** Mattermost cards get buttons only with a public address the server also knows presses come from. */
  private mattermostButtonsOn(): boolean {
    return Boolean(this.options.publicUrl?.()?.trim() && this.options.mattermostButtons?.());
  }

  private async buttons(place: Place, owner: ChatOwner, taskId: string, id: string, kind: 'change' | 'plan', post: string): Promise<CardButtons | undefined> {
    try {
      const secret = await this.options.actionSecret();
      const now = this.clock();
      const base = { svc: place.service, ch: place.channelId, th: place.threadId, card: post, hub: owner, task: taskId, id, kind } as const;
      const url = this.options.publicUrl?.()?.trim().replace(/\/+$/, '');
      return {
        approve: signChatAction(secret, { ...base, act: 'approve' }, now),
        deny: signChatAction(secret, { ...base, act: 'deny' }, now),
        ...(place.service === 'mattermost' && url && this.mattermostButtonsOn() ? { mattermostUrl: `${url}/api/chat/mattermost/action` } : {}),
      };
    } catch (error) {
      // No buttons, then: the card says to answer in sshs3.
      log.warn('Buttons for a chat card could not be made', safeError(error));
      return undefined;
    }
  }

  /** How a card drawn this way can be answered in its chat, or undefined when it cannot be there at all. */
  private answerMode(place: Place, out: CardOut): ChatThreadCard['answer'] {
    if (!out.answerable[place.service]) return undefined;
    return place.service === 'mattermost' && !this.mattermostButtonsOn() ? 'reactions' : 'buttons';
  }

  /** The card as it stands now: live with buttons while it waits, or its outcome once it does not. */
  private async cardNow(
    hub: ChatHub,
    place: Place,
    owner: ChatOwner,
    taskId: string,
    id: string,
    kind: 'change' | 'plan',
    post: string | undefined,
  ): Promise<{ out: CardOut; final: boolean; buttons: boolean } | undefined> {
    const task = hub.store.data.tasks.find((t) => t.id === taskId);
    if (!task) return undefined;
    const approvers = task.chat?.fence.approvers === 'admins' ? 'admins' : 'linked';
    const link = this.linkOf(owner, taskId);
    let production = false;
    let waiting = false;
    try {
      const subject = hub.chatApprovalSubject(taskId, id);
      production = subject.targetTags.some(isProdTag);
      waiting = subject.waiting;
    } catch {
      // Not answerable from chat, or gone: drawn without buttons.
    }
    if (kind === 'change') {
      const change = task.changes.find((c) => c.id === id);
      if (!change) return undefined;
      const outcome = changeOutcome(task, change);
      const buttons = !outcome && waiting && post ? await this.buttons(place, owner, taskId, id, kind, post) : undefined;
      const out = changeCard(cardChange(change), { approvers, production, ...(link ? { link } : {}), ...(buttons ? { buttons } : {}), ...(outcome ? { final: outcome } : {}) });
      return { out, final: Boolean(outcome), buttons: Boolean(buttons) };
    }
    let plan: RunView['plan'];
    try {
      plan = hub.runView(taskId).plan;
    } catch {
      plan = undefined;
    }
    if (!plan) return undefined;
    const outcome: CardOutcome | undefined = plan.id !== id ? { state: 'replaced' } : planOutcome(task);
    const buttons = !outcome && waiting && post ? await this.buttons(place, owner, taskId, id, kind, post) : undefined;
    const out = planCard(plan, { approvers, production, ...(link ? { link } : {}), ...(buttons ? { buttons } : {}), ...(outcome ? { final: outcome } : {}) });
    return { out, final: Boolean(outcome), buttons: Boolean(buttons) };
  }

  /**
   * Posts a card, or draws it again as it stands. A new card is posted first without buttons: a button
   * carries the card's own post, which is known only once it is posted. Then it is edited to have them.
   *
   * How the card can be answered (buttons, a reaction, or not in the chat at all) is kept with it before
   * each drawing goes out, so a press never finds a card more answerable than what the chat shows: a
   * card too long to show whole is never approved from a part of it.
   */
  private async drawCard(place: Place, owner: ChatOwner, taskId: string, id: string, kind: 'change' | 'plan', create: boolean): Promise<void> {
    const hub = this.hubs.get(owner)?.hub ?? (await this.hubOf(owner));
    const thread = this.threadOf(place);
    if (!hub || !thread || thread.taskId !== taskId || thread.owner !== owner) return;
    const card = thread.cards[id];
    if (card?.final || (!card && !create)) return;
    if (!(await this.mayPost(owner, place))) return;
    const pick = (out: CardOut): ChatOut => (place.service === 'slack' ? out.slack : out.mattermost);
    const patchCard = (change: (c: ChatThreadCard) => void): Promise<boolean> =>
      this.options.links.patchThread(place.service, place.channelId, place.threadId, (t) => {
        if (t.cards[id]) change(t.cards[id]);
      });
    const setAnswer = (answer: ChatThreadCard['answer']): Promise<boolean> =>
      patchCard((c) => {
        if (answer) c.answer = answer;
        else delete c.answer;
      });
    if (!card) {
      const first = await this.cardNow(hub, place, owner, taskId, id, kind, undefined);
      if (!first) return;
      const post = await this.outbox.post(place.service, place.channelId, pick(first.out), { threadId: postThread(place), kind: 'card' });
      if (!post) {
        // The change still waits: it is said where it can be answered, so nobody waits on a card that never came.
        const link = this.linkOf(owner, taskId);
        await this.say(place, chatText.cardNotPosted(), link ? { url: link, label: 'Open in sshs3' } : undefined);
        return;
      }
      await this.options.links.patchThread(place.service, place.channelId, place.threadId, (t) => {
        t.cards[id] = { post, kind, answered: {}, ...(first.final ? { final: true } : {}) };
      });
      if (first.final) return;
      const live = await this.cardNow(hub, place, owner, taskId, id, kind, post);
      if (!live) return;
      const mode = this.answerMode(place, live.out);
      await setAnswer(mode);
      const shown = await this.outbox.edit(place.service, place.channelId, post, pick(live.out), { kind: 'card' });
      if (!shown) {
        // The chat still shows the first drawing, which has no buttons: it takes no answer.
        await setAnswer(undefined);
        return;
      }
      if (live.final) await patchCard((c) => void (c.final = true));
      else if (mode === 'reactions') {
        // Without buttons people answer with a reaction: the bot puts both there to click.
        const bot = (this.identities.mattermost ?? this.options.bots.identity('mattermost'))?.userId;
        if (bot) {
          await this.outbox.react(place.channelId, post, REACTION_APPROVE, bot);
          await this.outbox.react(place.channelId, post, REACTION_DENY, bot);
        }
      }
      return;
    }
    const now = await this.cardNow(hub, place, owner, taskId, id, kind, card.post);
    if (!now) {
      await patchCard((c) => {
        c.final = true;
        delete c.answer;
      });
      return;
    }
    await setAnswer(this.answerMode(place, now.out));
    const shown = await this.outbox.edit(place.service, place.channelId, card.post, pick(now.out), { kind: 'card' });
    // Final only once the chat shows it: a drawing that did not go out is tried again at the next end or restart.
    if (now.final && shown) await patchCard((c) => void (c.final = true));
  }

  // ---- answers from chat ---------------------------------------------------------------------------

  /** A Slack button. Its value is the signed token; it must name the channel, thread and post it was pressed on. */
  private async onAction(e: AgentActionEvent): Promise<void> {
    const threadId = e.threadId && e.threadId !== e.messageId ? e.threadId : DM_THREAD;
    const reply = this.privateReply(e.service, { service: e.service, channelId: e.channelId, threadId }, e.userId);
    const check = verifyChatAction(await this.options.actionSecret(), e.value, this.clock());
    if (!check.ok) {
      await reply(check.message, true);
      return;
    }
    const p = check.payload;
    if (p.svc !== e.service || p.ch !== e.channelId || p.card !== e.messageId || p.th !== threadId) {
      await reply('That button is not one of ours.', true);
      return;
    }
    await this.press(
      {
        place: { service: p.svc, channelId: p.ch, threadId: p.th },
        owner: p.hub,
        taskId: p.task,
        cardId: p.id,
        kind: p.kind,
        post: p.card,
        approved: p.act === 'approve',
        userId: e.userId,
        via: 'button',
      },
      reply,
    );
  }

  /**
   * A reaction on a card, in Mattermost: ✅ approves, ❌ denies, on a card drawn to be answered that way
   * only. Any other reaction, one on another post, or one on a card drawn with buttons or too long to
   * show whole, is nothing.
   */
  private async onReaction(e: AgentReactionEvent): Promise<void> {
    const approved = e.emoji === REACTION_APPROVE ? true : e.emoji === REACTION_DENY ? false : undefined;
    if (approved === undefined) return;
    const found = this.options.links.cardByPost(e.service, e.postId);
    if (!found || (e.channelId && e.channelId !== found.channelId)) return;
    const card = found.thread.cards[found.cardId];
    if (card.answer !== 'reactions') return;
    const place: Place = { service: found.service, channelId: found.channelId, threadId: found.threadId };
    const name = await this.nameOf(e.service, e.userId);
    // A reaction has no private answer: refusals are said in the thread, to the person by name, and repeat
    // nothing of the card. The same refusal is said to a person once an hour on a card, however often they react.
    const reply: Reply = async (text, refusal) => {
      if (refusal && this.options.answering.take('off-reply', `react:${e.service}:${e.userId}:${e.postId}:${sha(text)}`)) await this.say(place, `${name}: ${text}`);
    };
    await this.press(
      {
        place,
        owner: found.thread.owner,
        taskId: found.thread.taskId,
        cardId: found.cardId,
        kind: card.kind,
        post: card.post,
        approved,
        userId: e.userId,
        via: 'reaction',
      },
      reply,
    );
  }

  /**
   * A Mattermost button press, as the server's action route hands it on. Answers with the text the
   * person alone sees as soon as the answer is decided; the card itself is edited after, in its turn.
   */
  async mattermostAction(input: { userId: string; channelId?: string; postId: string; token: unknown }): Promise<{ ephemeralText: string }> {
    const said: string[] = [];
    const reply: Reply = async (text) => void said.push(text);
    if (!this.running || this.stopping) return { ephemeralText: 'The agent bot is not running.' };
    const check = verifyChatAction(await this.options.actionSecret(), input.token, this.clock());
    if (!check.ok) return { ephemeralText: check.message };
    const p = check.payload;
    if (p.svc !== 'mattermost' || p.card !== input.postId || (input.channelId && p.ch !== input.channelId))
      return { ephemeralText: 'That button is not one of ours.' };
    await this.press(
      {
        place: { service: 'mattermost', channelId: p.ch, threadId: p.th },
        owner: p.hub,
        taskId: p.task,
        cardId: p.id,
        kind: p.kind,
        post: p.card,
        approved: p.act === 'approve',
        userId: input.userId,
        via: 'button',
      },
      reply,
    );
    return { ephemeralText: said.join(' ') };
  }

  /**
   * One person's answer to one card. Only a card drawn to be answered this way in the chat takes one;
   * only while answering is on and the channel's rule as it is now still lets a card of this kind be
   * answered; only from a linked person, and only once; for a conversation in a person's own hub, only
   * from that person. A claim given and then refused is given back, so the person can answer once it
   * can be given.
   */
  private async press(p: Press, reply: Reply): Promise<void> {
    const { links, answering } = this.options;
    const thread = links.thread(p.place.service, p.place.channelId, p.place.threadId);
    const card = thread?.cards[p.cardId];
    if (!thread || !card || thread.taskId !== p.taskId || thread.owner !== p.owner || card.post !== p.post || card.kind !== p.kind) {
      await reply('That is not waiting any more: it was answered, or its run was stopped.', true);
      return;
    }
    if (card.final) {
      await reply(chatText.alreadyAnswered(), true);
      return;
    }
    // A card too long to show whole, or answered only in the app, takes no answer here, by any way.
    if (card.answer !== (p.via === 'reaction' ? 'reactions' : 'buttons')) {
      await reply(chatText.notAnswerableHere(), true);
      return;
    }
    // The rule as it is now: answering switched off, a channel taken off the list, or a reach lowered
    // since the card was drawn leaves it to be answered in sshs3.
    const dm = p.place.threadId === DM_THREAD;
    const current = dm
      ? answering.fenceFor(p.place.service, { kind: 'dm', linked: p.owner !== 'agent' })
      : answering.fenceFor(p.place.service, { kind: 'channel', channelId: p.place.channelId });
    if (!current) {
      await reply(chatText.answeringOff(), true);
      return;
    }
    if (!reachAllows(current)) {
      await reply(chatText.rulesChanged(), true);
      return;
    }
    const link = links.linkOf(p.place.service, p.userId);
    if (!link) {
      await reply(chatText.notLinked(), true);
      return;
    }
    if (p.owner !== 'agent' && p.owner !== `user:${link.accountId}`) {
      await reply(chatText.notYours(), true);
      return;
    }
    if (!(await links.claimCard(p.place.service, p.place.channelId, p.place.threadId, p.cardId, p.userId))) {
      await reply(chatText.youAnswered(), true);
      return;
    }
    let refused = false;
    let message: string | undefined;
    try {
      if (p.owner === 'agent') {
        const answer = await this.options.answerForChatAgent(link.accountId, {
          taskId: p.taskId,
          id: p.cardId,
          kind: p.kind,
          approved: p.approved,
          via: p.place.service,
          ...(current.approvers ? { approvers: current.approvers } : {}),
        });
        refused = answer.outcome === 'refused';
        message = refused ? chatText.notAllowed(answer.message) : answer.message;
      } else {
        // A conversation in the person's own hub is answered as they would in the app, by that hub's own rules.
        const hub = await this.hubOf(p.owner);
        const task = hub?.store.data.tasks.find((t) => t.id === p.taskId);
        if (!hub || !task) throw new Error('That conversation is not there any more.');
        if (p.kind === 'plan') {
          if (task.plan?.id !== p.cardId || task.plan.status !== 'proposed') throw new Error('That plan is not waiting any more.');
          await hub.request({ action: 'plan-decide', taskId: p.taskId, approved: p.approved });
        } else {
          const change = task.changes.find((c) => c.id === p.cardId);
          if (change?.status !== 'pending') throw new Error('That change is not waiting any more.');
          if (change.kind === 'setting') throw new Error(chatText.settingInApp());
          await hub.request({ action: 'approve', taskId: p.taskId, changeId: p.cardId, approved: p.approved });
        }
        message = p.approved ? 'You approved it.' : 'You denied it. It does not run.';
      }
    } catch (error) {
      refused = true;
      message = chatText.notAllowed(safeError(error));
    }
    if (refused) await links.releaseCard(p.place.service, p.place.channelId, p.place.threadId, p.cardId, p.userId).catch(() => undefined);
    else {
      // What the answer lets run was asked for from chat: its end is posted there.
      this.follow(p.owner, p.taskId, p.place).fromChat = true;
      if (p.owner === 'agent') this.changed();
    }
    if (message) await reply(message, refused);
    // Not waited for: the person hears at once, and the card is drawn again in its turn, behind what
    // else waits in the thread (Mattermost gives up on a press that takes longer than 30 seconds).
    void this.serial(this.drawLanes, keyOf(p.place), () => this.drawCard(p.place, p.owner, p.taskId, p.cardId, p.kind, false)).catch((error) =>
      log.warn('A chat card could not be drawn again', safeError(error)),
    );
  }

  /** What only the person who pressed sees: a Slack message only they see in a channel; in a direct message, a plain reply. */
  private privateReply(service: ChatServiceName, place: Place, userId: string): Reply {
    return async (text) => {
      if (place.threadId === DM_THREAD || service !== 'slack') await this.say(place, text);
      else await this.outbox.ephemeral(place.channelId, userId, note('slack', text), { threadId: place.threadId });
    };
  }

  // ---- after a restart -----------------------------------------------------------------------------

  /**
   * Threads whose run a restart cut off: their status post and their open cards are drawn as stopped
   * ("Reply to go on"). A card that can still be answered (a plan, which waits without a run) keeps its
   * buttons. Runs of the chat agent's hub are followed again, so an answer given in the app is posted.
   * Something that did not go out (the chat could not be reached) is tried again at the next start.
   */
  private async recover(): Promise<void> {
    for (const entry of this.options.links.threadList()) {
      if (this.stopping) return;
      const { thread } = entry;
      const place: Place = { service: entry.service, channelId: entry.channelId, threadId: entry.threadId };
      const open = Object.values(thread.cards ?? {}).some((c) => !c.final);
      const unfinished = Boolean(thread.statusPost && !thread.statusDone);
      if (thread.owner !== 'agent' && !open && !unfinished) continue;
      // A person's own conversation is redrawn only while their link holds.
      if (thread.owner !== 'agent' && !this.threadOf(place)) continue;
      const hub = await this.hubOf(thread.owner);
      const task = hub?.store.data.tasks.find((t) => t.id === thread.taskId);
      if (!hub || !task) continue;
      const f = this.follow(thread.owner, thread.taskId, place);
      // A card that still waits there was the chat's: what answering it starts is posted there.
      f.fromChat = open;
      if (!open && !unfinished) continue;
      await this.serial(this.drawLanes, keyOf(place), async () => {
        if (this.stopping || !(await this.mayPost(thread.owner, place))) return;
        if (unfinished && !runActive(task)) {
          const text = task.status === 'interrupted' ? RESTARTED_TEXT : statusText(hub.runView(task.id));
          if (await this.outbox.edit(place.service, place.channelId, thread.statusPost!, note(place.service, text), { kind: 'status' }))
            await this.options.links.patchThread(place.service, place.channelId, place.threadId, (t) => {
              if (t.taskId === thread.taskId) t.statusDone = true;
            });
        }
        for (const [id, card] of Object.entries(thread.cards ?? {}))
          if (!card.final) await this.drawCard(place, thread.owner, thread.taskId, id, card.kind, false);
      });
    }
  }

  // ---- small helpers -------------------------------------------------------------------------------

  /** A short reply in the conversation's place, with a link into sshs3 when one is given. */
  private async say(place: Place, text: string, link?: { url: string; label: string }): Promise<void> {
    await this.outbox.post(place.service, place.channelId, note(place.service, text, link), { threadId: postThread(place), kind: 'note' });
  }

  /** A person's name as the chat shows it, asked once an hour at most. */
  private async nameOf(service: ChatServiceName, userId: string, given?: string): Promise<string> {
    const key = `${service}:${userId}`;
    const now = this.clock();
    const kept = this.names.get(key);
    if (kept && now - kept.at < NAME_TTL_MS) return kept.name;
    let name = given?.trim();
    if (!name) {
      try {
        if (service === 'slack') {
          const auth = this.options.bots.slack();
          if (auth && this.options.api.slackUser) name = (await this.options.api.slackUser(auth, userId)).name;
        } else {
          const auth = this.options.bots.mattermost();
          if (auth && this.options.api.mmUsers) name = (await this.options.api.mmUsers(auth, [userId]))[0]?.name;
        }
      } catch {
        name = undefined;
      }
    }
    const clean = clip((name || userId).replace(/[\r\n]+/g, ' ').trim(), 80);
    if (this.names.size > 2000) this.names.clear();
    this.names.set(key, { name: clean, at: now });
    return clean;
  }

  private serial(lanes: Map<string, Promise<void>>, key: string, work: () => Promise<void>): Promise<void> {
    const before = lanes.get(key) ?? Promise.resolve();
    const run = before.then(work, work);
    const settled = run.catch(() => undefined);
    lanes.set(key, settled);
    void settled.then(() => {
      if (lanes.get(key) === settled) lanes.delete(key);
    });
    return run;
  }
}

/** A change as a card shows it, from the conversation as stored. The card masks every text again. */
function cardChange(change: AgentChange): CardChange {
  return {
    id: change.id,
    kind: change.kind,
    target: change.target,
    description: change.description,
    ...(change.command !== undefined ? { command: change.command } : {}),
    ...(change.hiddenValues ? { hiddenValues: true } : {}),
    ...(change.check ? { check: { command: change.check.command, expected: change.check.expected } } : {}),
    ...(change.rollback ? { rollback: change.rollback.command } : {}),
    ...(change.diff ? { diff: change.diff } : {}),
    ...(change.blastRadius ? { blastRadius: change.blastRadius } : {}),
    requiredApprovals: Math.max(1, change.requiredApprovals ?? 1),
    approvals: (change.approvals ?? []).map((a) => ({ actor: a.actor, allowed: a.allowed, at: a.at, ...(a.via ? { via: a.via } : {}) })),
  };
}

/** How a change's card ends, or undefined while it waits. */
function changeOutcome(task: AgentTask, change: AgentChange): CardOutcome | undefined {
  if (change.status === 'pending') return task.status === 'interrupted' ? { state: 'restarted' } : undefined;
  const votes = change.approvals ?? [];
  const yes = votes.filter((v) => v.allowed);
  const no = votes.filter((v) => !v.allowed);
  if (APPROVED_STATES.has(change.status)) {
    const by = yes.map((v) => v.actor);
    return { state: 'approved', by: by.length ? by : [change.decidedBy?.name ?? 'sshs3'], ...(yes.at(-1)?.via ? { via: yes.at(-1)!.via } : {}) };
  }
  if (change.decidedHow === 'timeout') return { state: 'expired' };
  // A restart turns what waited into "denied" with nobody's answer, or "stopped" when the server stopped
  // the run on its way down: either way the run was cut off, and a reply goes on with it.
  if ((!change.decidedHow || change.decidedHow === 'stopped') && !no.length && task.status === 'interrupted') return { state: 'restarted' };
  if (change.decidedHow === 'stopped') return { state: 'stopped' };
  if (change.decidedHow === 'policy') return { state: 'denied', by: ["sshs3's rules"] };
  const by = no.map((v) => v.actor);
  return { state: 'denied', by: by.length ? by : [change.decidedBy?.name ?? 'somebody'], ...(no.at(-1)?.via ? { via: no.at(-1)!.via } : {}) };
}

/** How a plan's card ends, or undefined while it waits. */
function planOutcome(task: AgentTask): CardOutcome | undefined {
  const plan = task.plan;
  if (!plan || plan.status === 'proposed') return undefined;
  const votes = plan.approvals ?? [];
  const yes = votes.filter((v) => v.allowed);
  const no = votes.filter((v) => !v.allowed);
  if (plan.status === 'approved') return { state: 'approved', by: yes.length ? yes.map((v) => v.actor) : ['sshs3'], ...(yes.at(-1)?.via ? { via: yes.at(-1)!.via } : {}) };
  return no.length ? { state: 'denied', by: no.map((v) => v.actor), ...(no.at(-1)?.via ? { via: no.at(-1)!.via } : {}) } : { state: 'stopped' };
}
