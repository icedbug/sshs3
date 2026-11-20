import crypto from 'node:crypto';
import type { AgentBotIdentity, ChatServiceName } from '../../../shared/types/aiHub';
import type { AgentMattermostAuth, AgentSlackAuth, ChatPerson, MattermostAttachment, SlackBlock } from './AgentBotApi';
import type { AgentEvent } from './agentSocket';
import type { ChatAgentApi, ChatBots, ChatTransport, ChatTransportFactory, ChatTransportOptions } from './ChatAgentService';
import {
  MATTERMOST_APPROVE_ACTION,
  MATTERMOST_DENY_ACTION,
  REACTION_APPROVE,
  REACTION_DENY,
  SLACK_APPROVE_ACTION,
  SLACK_DENY_ACTION,
} from './chatFormat';

/**
 * A chat that lives inside the process: no Slack, no Mattermost, no network. It has the shape the
 * agent bot's service talks to (a line that hands on what people say, and the calls that post, edit
 * and react), so the whole service can be tried with it. The server uses it in the demo for "try it",
 * and tests use it to drive the service.
 *
 * People speak with `say`, press a card's buttons with `click`, and react with `react`. Everything
 * the bot posts, edits, reacts with or shows to one person only is in `log`, and the posts as they
 * stand now are in `posts`.
 */

export interface SimPost {
  id: string;
  channelId: string;
  /** The thread it is in. Absent: straight in the channel or the direct message. */
  threadId?: string;
  /** Who wrote it: the bot, or a person. */
  userId: string;
  text: string;
  blocks?: SlackBlock[];
  attachments?: MattermostAttachment[];
  /** How often the bot edited it. */
  edits: number;
  reactions: Array<{ userId: string; emoji: string }>;
}

export type SimLogEntry =
  | { op: 'post'; post: SimPost }
  | { op: 'edit'; postId: string; text: string; blocks?: SlackBlock[]; attachments?: MattermostAttachment[] }
  | { op: 'ephemeral'; channelId: string; userId: string; threadId?: string; text: string }
  | { op: 'react'; postId: string; emoji: string };

export interface SimSayOptions {
  /** The thread to write in: the id of its first post. */
  thread?: string;
  /** A direct message with the bot. */
  dm?: boolean;
  /** Whether the bot is named. In a direct message it does not matter; in a channel it is so unless false. */
  mention?: boolean;
  /** How many files come with it. */
  files?: number;
}

export interface SimChatOptions {
  service?: ChatServiceName;
  /** Names of people, by user id. */
  people?: Record<string, string>;
  /** The Mattermost address the simulated chat says it is at. A private one, so every data policy allows it. */
  baseUrl?: string;
}

const BOT_USER: Record<ChatServiceName, string> = { slack: 'USIMBOT', mattermost: 'simbotuserxxxxxxxxxxxxxxxx' };

export class SimChat {
  readonly service: ChatServiceName;
  readonly log: SimLogEntry[] = [];
  readonly posts = new Map<string, SimPost>();
  readonly people: Record<string, string>;
  readonly identity: AgentBotIdentity;
  private readonly lines = new Set<SimLine>();
  private counter = 0;
  private readonly baseUrl: string;

  constructor(options: SimChatOptions = {}) {
    this.service = options.service ?? 'slack';
    this.people = { ...options.people };
    this.baseUrl = options.baseUrl ?? 'http://127.0.0.1:8065';
    this.identity = {
      userId: BOT_USER[this.service],
      ...(this.service === 'slack' ? { botId: 'BSIMBOT' } : { username: 'sshs3' }),
      name: 'sshs3',
      team: 'Try it',
    };
  }

  /** An id of the service's own shape: a Slack timestamp, or a Mattermost id. */
  private nextId(): string {
    this.counter++;
    if (this.service === 'slack') return `1700000000.${String(this.counter).padStart(6, '0')}`;
    return crypto.createHash('sha256').update(`sim:${this.counter}:${Math.random()}`).digest('hex').replace(/[^a-z0-9]/g, '').slice(0, 26).padEnd(26, 'a');
  }

  /** The direct message channel between a person and the bot. */
  dmChannel(userId: string): string {
    return this.service === 'slack' ? `D${userId.replace(/[^A-Z0-9]/gi, '').toUpperCase()}`.slice(0, 32) : `dm${userId}`.slice(0, 26).padEnd(26, 'd');
  }

  /** The credentials and who the bot is, as the agent bot's store would give them. Nothing is kept. */
  readonly bots: ChatBots = {
    slack: () => (this.service === 'slack' ? { botToken: 'xoxb-sim', appToken: 'xapp-sim' } : undefined),
    mattermost: () => (this.service === 'mattermost' ? { baseUrl: this.baseUrl, token: 'sim-token' } : undefined),
    identity: (service) => (service === this.service ? { ...this.identity } : undefined),
    setIdentity: async () => undefined,
    setError: async () => undefined,
  };

  /** What the bot calls to post: every call is put in the log. */
  readonly api: ChatAgentApi = {
    slackPost: async (_auth: AgentSlackAuth, m) => ({ channel: m.channel, ts: this.botPost(m.channel, m.threadTs, m.text, m.blocks, undefined).id }),
    slackUpdate: async (_auth: AgentSlackAuth, m) => this.botEdit(m.ts, m.text, m.blocks ?? [], undefined),
    slackEphemeral: async (_auth: AgentSlackAuth, m) => void this.log.push({ op: 'ephemeral', channelId: m.channel, userId: m.user, ...(m.threadTs ? { threadId: m.threadTs } : {}), text: m.text }),
    mmPost: async (_auth: AgentMattermostAuth, p) => ({ id: this.botPost(p.channelId, p.rootId, p.message, undefined, p.attachments).id }),
    mmPatch: async (_auth: AgentMattermostAuth, postId, patch) => this.botEdit(postId, patch.message, undefined, patch.attachments),
    mmReact: async (_auth: AgentMattermostAuth, r) => {
      this.posts.get(r.postId)?.reactions.push({ userId: r.userId, emoji: r.emoji });
      this.log.push({ op: 'react', postId: r.postId, emoji: r.emoji });
    },
    slackUser: async (_auth: AgentSlackAuth, userId: string): Promise<ChatPerson> => ({ id: userId, name: this.people[userId] ?? userId, isBot: false, deleted: false }),
    mmUsers: async (_auth: AgentMattermostAuth, ids: string[]): Promise<ChatPerson[]> =>
      ids.map((id) => ({ id, name: this.people[id] ?? id, isBot: false, deleted: false })),
  };

  /** Lines to this chat, the shape of the real sockets. Only the simulated service is served. */
  readonly transport: ChatTransportFactory = (service, options) => {
    const line = new SimLine(this, service === this.service ? options : undefined);
    return line;
  };

  /** @internal */
  attach(line: SimLine): void {
    this.lines.add(line);
  }

  /** @internal */
  detach(line: SimLine): void {
    this.lines.delete(line);
  }

  /** Whether a line to the bot is open. */
  get connected(): boolean {
    return this.lines.size > 0;
  }

  private botPost(channelId: string, threadId: string | undefined, text: string, blocks: SlackBlock[] | undefined, attachments: MattermostAttachment[] | undefined): SimPost {
    const post: SimPost = {
      id: this.nextId(),
      channelId,
      ...(threadId ? { threadId } : {}),
      userId: this.identity.userId,
      text,
      ...(blocks ? { blocks } : {}),
      ...(attachments ? { attachments } : {}),
      edits: 0,
      reactions: [],
    };
    this.posts.set(post.id, post);
    this.log.push({ op: 'post', post: structuredClone(post) });
    return post;
  }

  private botEdit(postId: string, text: string | undefined, blocks: SlackBlock[] | undefined, attachments: MattermostAttachment[] | undefined): void {
    const post = this.posts.get(postId);
    if (!post) throw new Error('No such post.');
    if (text !== undefined) post.text = text;
    if (blocks !== undefined) post.blocks = blocks;
    if (attachments !== undefined) post.attachments = attachments;
    post.edits++;
    this.log.push({ op: 'edit', postId, ...(text !== undefined ? { text } : { text: post.text }), ...(blocks ? { blocks } : {}), ...(attachments ? { attachments } : {}) });
  }

  private emit(event: AgentEvent): void {
    for (const line of this.lines) line.deliver(event);
  }

  /**
   * A person writes. In a channel the bot is named unless `mention` is false; in a direct message
   * (`dm`, or a channel made with dmChannel) it does not need to be. A Slack channel message that does
   * not name the bot never reaches it, as with the real socket. Returns the new post's id.
   */
  say(channelId: string, userId: string, text: string, options: SimSayOptions = {}): string {
    const dm = options.dm ?? channelId === this.dmChannel(userId);
    const id = this.nextId();
    const mentioned = dm ? Boolean(options.mention) : options.mention !== false;
    this.posts.set(id, { id, channelId, ...(options.thread ? { threadId: options.thread } : {}), userId, text, edits: 0, reactions: [] });
    // As the real lines do: Slack hands on a channel message only when it names the bot (app_mention);
    // Mattermost hands on every post, and says whether the bot was named.
    if (this.service === 'slack' && !dm && !mentioned) return id;
    this.emit({
      kind: 'message',
      service: this.service,
      channelId,
      channelType: dm ? 'im' : 'channel',
      threadId: options.thread ?? id,
      messageId: id,
      userId,
      ...(this.people[userId] ? { userName: this.people[userId] } : {}),
      text,
      mentioned,
      ...(options.files ? { files: options.files } : {}),
    });
    return id;
  }

  /** A person presses Approve or Deny on a card. Throws when the post has no such button. */
  click(postId: string, action: 'approve' | 'deny', userId: string): void {
    const post = this.posts.get(postId);
    if (!post) throw new Error('No such post.');
    const value = buttonValue(post, action);
    if (!value) throw new Error(`That post has no ${action} button.`);
    this.emit({
      kind: 'action',
      service: this.service,
      userId,
      channelId: post.channelId,
      threadId: post.threadId ?? post.id,
      messageId: post.id,
      value,
      actionId: this.service === 'slack' ? (action === 'approve' ? SLACK_APPROVE_ACTION : SLACK_DENY_ACTION) : action === 'approve' ? MATTERMOST_APPROVE_ACTION : MATTERMOST_DENY_ACTION,
    });
  }

  /** A person reacts to a post. On a card in Mattermost, ✅ approves and ❌ denies. */
  react(postId: string, emoji: string, userId: string): void {
    const post = this.posts.get(postId);
    if (!post) throw new Error('No such post.');
    post.reactions.push({ userId, emoji });
    this.emit({ kind: 'reaction', service: this.service, userId, postId, emoji, channelId: post.channelId });
  }

  /** The approve or deny reaction's name, for `react`. */
  static reaction(action: 'approve' | 'deny'): string {
    return action === 'approve' ? REACTION_APPROVE : REACTION_DENY;
  }

  /** What the bot posted, oldest first, as the posts stand now. */
  botPosts(channelId?: string): SimPost[] {
    return [...this.posts.values()].filter((p) => p.userId === this.identity.userId && (!channelId || p.channelId === channelId));
  }

  /** Everything the bot posted and edited, as text with the text of its blocks, for a test to search. */
  transcript(): string {
    const shown = (text: string, blocks?: SlackBlock[]): string => [text, ...blockTexts(blocks)].join('\n');
    return this.log
      .map((e) => (e.op === 'post' ? shown(e.post.text, e.post.blocks) : e.op === 'edit' ? shown(e.text, e.blocks) : e.op === 'ephemeral' ? e.text : e.emoji))
      .join('\n');
  }
}

/** The text a person reads in Slack blocks. */
function blockTexts(blocks: SlackBlock[] | undefined): string[] {
  const out: string[] = [];
  for (const block of blocks ?? []) {
    const text = (block.text as { text?: unknown } | undefined)?.text;
    if (typeof text === 'string') out.push(text);
  }
  return out;
}

/** A card's button value, from Slack blocks or Mattermost attachments. */
function buttonValue(post: SimPost, action: 'approve' | 'deny'): string | undefined {
  for (const block of post.blocks ?? []) {
    if (block.type !== 'actions') continue;
    for (const el of (block.elements as Array<{ action_id?: string; value?: string }>) ?? [])
      if (el.action_id === (action === 'approve' ? SLACK_APPROVE_ACTION : SLACK_DENY_ACTION)) return el.value;
  }
  for (const attachment of post.attachments ?? []) {
    for (const a of (attachment.actions as Array<{ id?: string; integration?: { context?: { t?: string } } }>) ?? [])
      if (a.id === (action === 'approve' ? MATTERMOST_APPROVE_ACTION : MATTERMOST_DENY_ACTION)) return a.integration?.context?.t;
  }
  return undefined;
}

/** One line to the simulated chat. Events are handed on after the call that made them returns, as a socket would. */
class SimLine implements ChatTransport {
  private open = false;

  constructor(
    private readonly chat: SimChat,
    private readonly options: ChatTransportOptions | undefined,
  ) {}

  start(): void {
    if (this.open || !this.options) return;
    this.open = true;
    this.chat.attach(this);
    void Promise.resolve().then(() => {
      this.options?.onStatus({ state: 'open' });
      this.options?.onIdentity({ ...this.chat.identity });
    });
  }

  async stop(): Promise<void> {
    this.open = false;
    this.chat.detach(this);
    this.options?.onStatus({ state: 'stopped' });
  }

  deliver(event: AgentEvent): void {
    if (!this.open) return;
    setImmediate(() => {
      if (this.open) void this.options?.onEvent(event);
    });
  }
}
