import fsp from 'node:fs/promises';
import path from 'node:path';
import type {
  AgentBotInput,
  ChatAnsweringInput,
  ChatAnsweringRequest,
  ChatAnsweringSnapshot,
  ChatRunItem,
  ChatServiceName,
  ChatTaskView,
  ChatTryResult,
  HubReply,
} from '../../../shared/types/aiHub';
import type { AiEgressPolicy } from '../../../shared/types/ai';
import { validateChatEgress } from '../../../shared/dataDestination';
import { AiConfigStore } from '../../ai/AiConfigStore';
import { getBuiltinAgents } from '../../ai/hub/demoWorkspace';
import type { HubService } from '../../ai/hub/HubService';
import type { GuardOptions } from '../../ai/hub/Notifier';
import { clip, safeError } from '../../ai/hub/privacy';
import { chatServiceLabel, splitChatMessage } from '../../ai/hub/chatFence';
import { writeFileAtomic } from '../../storage/atomicFile';
import type { PeerAccount, WebUserPublic } from '../WebAuthService';
import type { ChatAnsweringBackend, UserTenant, WebTenantManager } from '../WebTenantManager';
import { AgentBotApi } from './AgentBotApi';
import { AgentBotStore, MM_TOKEN, SLACK_APP_TOKEN, SLACK_BOT_TOKEN } from './AgentBotStore';
import { ChatAgentService, DM_THREAD, socketTransports, type ChatTransportFactory } from './ChatAgentService';
import { ChatAgentStore } from './ChatAgentStore';
import { ChatAnsweringStore } from './ChatAnsweringStore';
import { loadChatActionSecret } from './chatActionToken';
import { SimChat, blockTexts } from './simChat';

/**
 * The agent bot in chat as the web server keeps it, for everybody on the server: its settings, its
 * connection to Slack and Mattermost, the service that answers (ChatAgentService), and the requests
 * people make about it from the app.
 *
 * Every request names who asks (the server put their id in, see WebTenantManager), and each one checks
 * what that account may do: an administrator sets the bot up, anybody links their own chat account,
 * and an answer to a change is checked by the same rules as one given from chat.
 */

const SERVICES: ChatServiceName[] = ['slack', 'mattermost'];
/** How long "try it" waits for the run to answer before it returns what was posted so far. */
const TRY_WAIT_MS = 20_000;
const TRY_PEOPLE = { me: 'USIMME', guest: 'USIMGUEST' } as const;
const ZERO_GAPS = { slack: { postMs: 0, editMs: 0 }, mattermost: { postMs: 0, editMs: 0 } };

export interface ChatAnsweringOptions {
  dataDir: string;
  /** Links, codes, threads and cards: the server's own store (WebServer.chatAgent). */
  links: ChatAgentStore;
  tenants: WebTenantManager;
  /** The server's accounts now. */
  accounts(): PeerAccount[];
  user(id: string): Promise<WebUserPublic | null>;
  /** The server's own audit log: who changed the agent bot, and who linked. */
  audit(entry: { actor: string; what: string }): Promise<void>;
  guard(): GuardOptions;
  demo(): boolean;
  publicUrl(): string | undefined;
  /**
   * The addresses Mattermost's server posts button presses from (SSHS3_MATTERMOST_ACTION_FROM). Without
   * them a press cannot be told from one made up by anybody who saw a card's token, so Mattermost cards
   * get no buttons and are answered with reactions.
   */
  mattermostActionFrom?(): string[];
  /** For tests: how the agent bot reaches the chat services, and its lines to them. */
  api?: AgentBotApi;
  transport?: ChatTransportFactory;
  /** For tests: how long "try it" waits for an answer. */
  tryWaitMs?: number;
  /** For tests: the gaps between posts and edits, which keep to Slack's and Mattermost's limits otherwise. */
  outboxGaps?: ConstructorParameters<typeof ChatAgentService>[0]['outboxGaps'];
}

interface Trial {
  chat: SimChat;
  service: ChatAgentService;
  links: ChatAgentStore;
  /** Events handed to the service and not handled yet: "try it" waits for them. */
  pending: Set<Promise<unknown>>;
}

const runActive = (status: string | undefined): boolean => status === 'queued' || status === 'running' || status === 'waiting';

export class ChatAnswering implements ChatAnsweringBackend {
  readonly bots: AgentBotStore;
  readonly answering: ChatAnsweringStore;
  readonly api: AgentBotApi;
  readonly service: ChatAgentService;
  private readonly agentConfig: AiConfigStore;
  private readonly trials = new Map<ChatServiceName, Promise<Trial>>();
  private started = false;
  private changedTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly o: ChatAnsweringOptions) {
    this.bots = new AgentBotStore(o.dataDir, { guard: o.guard });
    this.answering = new ChatAnsweringStore(o.dataDir);
    this.api = o.api ?? new AgentBotApi({ guard: o.guard });
    // Read from its file, so the bot's data policy is known without starting the chat agent's hub.
    this.agentConfig = new AiConfigStore(path.join(o.tenants.getChatAgentDir(), 'ai-config.json'));
    this.service = this.makeService({
      links: o.links,
      api: this.api,
      bots: this.bots,
      transport: o.transport ?? socketTransports({ api: this.api, bots: this.bots, guard: o.guard }),
      policyOf: (owner) => this.policyOf(owner),
      ...(o.outboxGaps ? { outboxGaps: o.outboxGaps } : {}),
      readsThreads: true,
      changed: () => this.changedSoon(),
    });
  }

  /** Whether Mattermost cards get buttons: a public address, and the addresses presses may come from. */
  private mattermostButtons(): boolean {
    return Boolean(this.o.publicUrl()) && (this.o.mattermostActionFrom?.() ?? []).length > 0;
  }

  /**
   * What the app shows of the agent bot changed (a change waits for an answer, one was answered, a person
   * linked): every account's windows read their snapshot again, at most twice a second.
   */
  private changedSoon(): void {
    if (this.changedTimer) return;
    this.changedTimer = setTimeout(() => {
      this.changedTimer = undefined;
      this.o.tenants.chatAnsweringChanged();
    }, 500);
    this.changedTimer.unref?.();
  }

  /**
   * Who may answer in the channel a conversation of the chat agent's was asked in, as the administrator
   * set it now. An answer, in the app or in chat, holds to the stricter of this and the run's own fence.
   */
  currentApprovers(origin: { service: ChatServiceName; channelId: string; kind: 'channel' | 'dm' }): 'linked' | 'admins' | undefined {
    if (origin.kind !== 'channel') return undefined;
    return this.answering.channelRule(origin.service, origin.channelId)?.approvers;
  }

  private makeService(parts: {
    links: ChatAgentStore;
    api: ConstructorParameters<typeof ChatAgentService>[0]['api'];
    bots: ConstructorParameters<typeof ChatAgentService>[0]['bots'];
    transport: ChatTransportFactory;
    policyOf: ConstructorParameters<typeof ChatAgentService>[0]['policyOf'];
    outboxGaps?: ConstructorParameters<typeof ChatAgentService>[0]['outboxGaps'];
    /** Whether threads are read through the context bot: not for a simulated chat, whose threads are not real. */
    readsThreads: boolean;
    changed?: () => void;
  }): ChatAgentService {
    const { o } = this;
    const { readsThreads, ...rest } = parts;
    return new ChatAgentService({
      ...rest,
      answering: this.answering,
      // The context bot is only asked to read a thread now. Nothing is written through it.
      ...(readsThreads
        ? { contextBot: { readThreadNow: (service: ChatServiceName, channelId: string, threadId: string) => o.tenants.contextBot().readThreadNow(service, channelId, threadId) } }
        : {}),
      hubs: {
        agent: async () => (await this.agentTenant()).hub,
        person: async (accountId) => (await this.personTenant(accountId))?.hub,
      },
      accounts: {
        get: (id) => {
          const a = this.account(id);
          return a ? { name: a.displayName || a.username, role: a.role, ...(a.disabled ? { disabled: true } : {}) } : undefined;
        },
      },
      answerForChatAgent: (approver, answer) => o.tenants.answerForChatAgent(approver, answer),
      actionSecret: () => loadChatActionSecret(o.links.dir),
      publicUrl: () => o.publicUrl(),
      mattermostButtons: () => this.mattermostButtons(),
      audit: (what, link) => {
        const who = this.account(link.accountId);
        const name = who ? who.displayName || who.username : link.accountId;
        void o
          .audit({ actor: clip(name, 80), what: `${what === 'link' ? 'linked' : 'unlinked'} the ${chatServiceLabel(link.service)} account ${clip(link.chatName, 80)} from chat` })
          .catch(() => undefined);
      },
    });
  }

  async start(): Promise<void> {
    await Promise.all([this.bots.initialize(), this.answering.initialize(), this.o.links.initialize()]);
    await this.service.start();
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.changedTimer) clearTimeout(this.changedTimer);
    this.changedTimer = undefined;
    const trials = [...this.trials.values()];
    this.trials.clear();
    await Promise.allSettled(trials.map(async (t) => (await t).service.stop()));
    await this.service.stop();
  }

  // ---- whose hub ------------------------------------------------------------------------------------

  private account(id: string): PeerAccount | undefined {
    return this.o.accounts().find((a) => a.id === id);
  }

  /** The chat agent's tenant, with the wait for an answer the administrator set. */
  private async agentTenant(): Promise<UserTenant> {
    const tenant = await this.o.tenants.getChatAgentTenant();
    await this.applyWait(tenant);
    return tenant;
  }

  private async applyWait(tenant: UserTenant): Promise<void> {
    const wait = this.answering.settings().approvalWaitMinutes;
    const prefs = tenant.hub.store.data.preferences;
    if (prefs.approvalWaitMinutes === wait) return;
    prefs.approvalWaitMinutes = wait;
    await tenant.hub.store.save().catch(() => undefined);
  }

  /** A linked person's own tenant, or nothing when the account is gone or turned off. */
  private async personTenant(accountId: string): Promise<UserTenant | undefined> {
    const user = await this.o.user(accountId);
    if (!user || user.disabled) return undefined;
    return this.o.tenants.getOrCreateTenant(user);
  }

  /** The data policy of the chat agent, or of a person whose own hub answers their direct messages. */
  private async policyOf(owner: 'agent' | string): Promise<{ policy?: AiEgressPolicy; euAllowedHosts?: string[] } | undefined> {
    const config = owner === 'agent' ? await this.agentConfig.getConfig() : await (await this.personTenant(owner))?.hub.config.getConfig();
    if (!config) return undefined;
    const eu = (config as { euAllowedHosts?: unknown }).euAllowedHosts;
    return {
      ...(config.egressPolicy ? { policy: config.egressPolicy } : {}),
      ...(Array.isArray(eu) ? { euAllowedHosts: eu.filter((h): h is string => typeof h === 'string') } : {}),
    };
  }

  /** The services the agent bot is connected to and switched on for. */
  private connected(): ChatServiceName[] {
    return SERVICES.filter((s) => (s === 'slack' ? this.bots.slack() : this.bots.mattermost()));
  }

  /** What the chat agent's data policy says of each service the agent bot is connected to. */
  private async policyChecks(services: ChatServiceName[]): Promise<Array<{ service: ChatServiceName; allowed: boolean; errors: string[]; warnings: string[] }>> {
    let policy: Awaited<ReturnType<ChatAnswering['policyOf']>>;
    try {
      policy = await this.policyOf('agent');
    } catch (error) {
      // Not known is not allowed: the same rule the service holds to before each answer.
      return services.map((service) => ({ service, allowed: false, errors: [`The chat agent's data policy could not be read: ${safeError(error)}`], warnings: [] }));
    }
    return services.map((service) => {
      const check = validateChatEgress(policy?.policy, service, service === 'mattermost' ? this.bots.mattermost(true)?.baseUrl : undefined, {
        euAllowedHosts: policy?.euAllowedHosts,
      });
      return { service, allowed: check.allowed, errors: check.errors, warnings: check.warnings };
    });
  }

  // ---- what a person sees ----------------------------------------------------------------------------

  async view(userId: string): Promise<ChatAnsweringSnapshot> {
    const me = this.account(userId);
    const settings = this.answering.settings();
    const snapshot: ChatAnsweringSnapshot = {
      enabled: settings.enabled,
      services: this.connected(),
      links: this.o.links.linksOf(userId).map((l) => ({ service: l.service, chatName: l.chatName, linkedAt: l.linkedAt })),
      waiting: this.o.tenants.chatAgentWaitingFor(userId),
    };
    if (!me || me.disabled || me.role !== 'admin') return snapshot;
    const bots = this.bots.view();
    const status = this.service.connectionStatus();
    const names = new Map(this.o.accounts().map((a) => [a.id, a.displayName || a.username]));
    // Read, never made here: a snapshot does not create the chat agent's key. Connecting the bot does.
    const publicKey = await fsp
      .readFile(path.join(this.o.tenants.getChatAgentDir(), '.ssh', 'id_ed25519.pub'), 'utf8')
      .then((k) => k.trim() || undefined)
      .catch(() => undefined);
    snapshot.admin = {
      settings: this.answering.view(),
      bots,
      status: Object.fromEntries(
        Object.entries(status).map(([service, s]) => [service, { state: s.state, ...(s.error ? { error: s.error } : {}), ...(s.retryAt ? { retryAt: s.retryAt } : {}) }]),
      ),
      linked: this.o.links.allLinks().map((l) => ({ ...l, accountName: names.get(l.accountId) ?? 'a removed account' })),
      ...(publicKey ? { publicKey } : {}),
      mattermostAnswers: this.mattermostButtons() ? 'buttons' : 'reactions',
      dataPolicy: await this.policyChecks(bots.map((b) => b.service)),
      canTry: this.mayTry(),
      agents: this.chatAgentAgents().map((a) => ({ id: a.id, name: a.name })),
      model: await this.chatAgentModel(),
    };
    return snapshot;
  }

  /**
   * The agents a channel row may choose: the chat agent's own, since its hub runs the conversation.
   * Read without starting it: before it was started it has only the built-in ones. External runners
   * are left out, as a conversation from chat runs on the chat agent's model.
   */
  private chatAgentAgents(): Array<{ id: string; name: string; runnerId?: string }> {
    const hub = this.o.tenants.chatAgentIfStarted()?.hub;
    return (hub ? hub.getAgentsList() : getBuiltinAgents()).filter((a) => !a.runnerId);
  }

  /** Whether the chat agent has a model, from its own settings file. Its name only, never a key. */
  private async chatAgentModel(): Promise<{ set: boolean; name?: string }> {
    try {
      const config = await this.agentConfig.getConfig('primary');
      if (!config.enabled || !config.model) return { set: false };
      const profile = config.profileId ? config.profiles?.find((p) => p.id === config.profileId) : undefined;
      return { set: true, name: clip(profile?.name ? `${profile.name} (${config.model})` : config.model, 120) };
    } catch {
      return { set: false };
    }
  }

  private mayTry(): boolean {
    return this.o.demo() || this.connected().length === 0;
  }

  // ---- requests ----------------------------------------------------------------------------------------

  async request(userId: string, request: ChatAnsweringRequest): Promise<HubReply | undefined> {
    const me = this.account(userId);
    if (!me || me.disabled) throw new Error('Your account cannot do this.');
    const name = me.displayName || me.username;
    const admin = (): void => {
      if (me.role !== 'admin') throw new Error('Only an administrator of this server can set up the agent bot.');
    };
    switch (request.action) {
      case 'chat-answering-save': {
        admin();
        return this.save(userId, name, request.input);
      }
      case 'chat-answering-connect': {
        admin();
        return this.connect(userId, name, request.input);
      }
      case 'chat-answering-disconnect': {
        admin();
        const service = serviceOf(request.service);
        await this.bots.remove(service);
        await this.service.refresh();
        await this.o.audit({ actor: name, what: `disconnected the agent bot from ${chatServiceLabel(service)}` }).catch(() => undefined);
        this.o.tenants.chatAnsweringChanged(userId);
        return undefined;
      }
      case 'chat-answering-rotate-key': {
        admin();
        const publicKey = await this.o.tenants.rotateChatAgentKey();
        await this.o.audit({ actor: name, what: "made a new SSH key for the chat agent. Its old key stays on servers until it is removed there" }).catch(() => undefined);
        this.o.tenants.chatAnsweringChanged(userId);
        return { chatAgentKey: { publicKey } };
      }
      case 'chat-answering-copy-model': {
        admin();
        return this.copyModel(userId, name);
      }
      case 'chat-link-code': {
        const service = serviceOf(request.service);
        const made = await this.o.links.linkCode(userId, service);
        return { chatLinkCode: { service, code: made.code, expiresAt: made.expiresAt } };
      }
      case 'chat-unlink': {
        const service = serviceOf(request.service);
        const someone = typeof request.chatUserId === 'string' && request.chatUserId.trim() ? request.chatUserId.trim() : undefined;
        if (someone) admin();
        const link = someone ? this.o.links.allLinks().find((l) => l.service === service && l.chatUserId === someone) : this.o.links.linksOf(userId).find((l) => l.service === service);
        const done = await this.o.links.unlink(someone ? { service, chatUserId: someone } : { service, accountId: userId }, { accountId: userId, admin: me.role === 'admin' });
        if (!done || !link) throw new Error(someone ? 'That chat account is not linked.' : `Your ${chatServiceLabel(service)} account is not linked.`);
        await this.o
          .audit({ actor: name, what: `unlinked the ${chatServiceLabel(service)} account ${clip(link.chatName, 80)}${link.accountId === userId ? '' : ` of ${this.account(link.accountId)?.username ?? 'a removed account'}`}` })
          .catch(() => undefined);
        // The person's own windows and an administrator's list of linked people show it.
        this.changedSoon();
        return undefined;
      }
      case 'chat-answering-runs': {
        admin();
        return { chatRuns: await this.runs() };
      }
      case 'chat-answering-task': {
        admin();
        return { chatTask: await this.task(String(request.taskId ?? '')) };
      }
      case 'chat-answering-answer': {
        if (request.kind !== 'change' && request.kind !== 'plan') throw new Error('Say whether it is a change or a plan.');
        const answer = await this.o.tenants.answerForChatAgent(userId, {
          taskId: String(request.taskId ?? ''),
          id: String(request.id ?? ''),
          kind: request.kind,
          approved: request.approved === true,
          ...(typeof request.note === 'string' && request.note.trim() ? { note: clip(request.note.trim(), 1000) } : {}),
        });
        // Every approver's list of what waits changes with an answer, not only this person's.
        this.changedSoon();
        return { chatAnswer: answer };
      }
      case 'chat-answering-try': {
        admin();
        return { chatTry: await this.tryIt(userId, name, request) };
      }
    }
  }

  private async save(userId: string, name: string, input: ChatAnsweringInput): Promise<HubReply | undefined> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Nothing to save.');
    const before = this.answering.settings();
    // Switched on only where the data policy lets answers go: a chat is a place data goes, like any other.
    if (input.enabled === true && !before.enabled) {
      const services = this.connected();
      const refused = (await this.policyChecks(services)).filter((c) => !c.allowed);
      if (refused.length)
        throw new Error(`Answering in chat stays off. ${refused.map((c) => `${chatServiceLabel(c.service)}: ${c.errors.join(' ')}`).join(' ')}`);
    }
    // A channel row's agent is one of the chat agent's own: its hub runs the conversation, and an agent it
    // does not have would leave the run on the default prompt without a word.
    for (const service of SERVICES) {
      for (const rule of input.channels?.[service] ?? []) {
        const agentId = typeof rule?.agentId === 'string' ? rule.agentId.trim() : '';
        if (!agentId) continue;
        const known = (await this.agentTenant()).hub.getAgentsList().find((a) => a.id === agentId);
        const where = `#${String(rule.channelName || rule.channelId || '').replace(/^#/, '')}`;
        if (!known) throw new Error(`For ${where}, that agent is not one the chat agent has.`);
        if (known.runnerId) throw new Error(`For ${where}, that agent runs outside sshs3. A conversation from chat runs on the chat agent's model.`);
      }
    }
    const view = await this.answering.save(input, name);
    const agent = this.o.tenants.chatAgentIfStarted();
    if (agent) await this.applyWait(agent);
    const turned = before.enabled !== view.enabled ? (view.enabled ? 'switched answering in chat on' : 'switched answering in chat off') : 'changed how the agent bot answers in chat';
    await this.o.audit({ actor: name, what: turned }).catch(() => undefined);
    this.o.tenants.chatAnsweringChanged(userId);
    return undefined;
  }

  /**
   * The agent bot's own Slack app or Mattermost bot account. It is tried before it is saved, and the
   * context bot's token is refused: that bot only reads, and must stay a separate app.
   */
  private async connect(userId: string, name: string, input: AgentBotInput): Promise<HubReply> {
    if (!input || typeof input !== 'object') throw new Error('Nothing to save.');
    const service = serviceOf(input.service);
    const token = typeof input.token === 'string' ? input.token.trim() : '';
    const appToken = typeof input.appToken === 'string' ? input.appToken.trim() : '';
    const notes: string[] = [];
    let identity: Awaited<ReturnType<AgentBotApi['slackAuthTest']>>;
    if (service === 'slack') {
      if (token && !SLACK_BOT_TOKEN.test(token)) throw new Error("That does not look like the agent bot's token. A Slack bot token starts with xoxb-.");
      if (appToken && !SLACK_APP_TOKEN.test(appToken)) throw new Error('That does not look like an app-level token. It starts with xapp-.');
      const had = this.bots.slack(true);
      const botToken = token || had?.botToken || '';
      const app = appToken || had?.appToken || '';
      if (!botToken) throw new Error("The agent bot's token is needed. It starts with xoxb-.");
      if (!app) throw new Error('The app-level token is needed. It starts with xapp-.');
      if (await this.o.tenants.contextBot().usesToken('slack', botToken))
        throw new Error('That is the context bot\'s token. The agent bot needs a Slack app of its own, so the context bot stays one that only reads.');
      identity = await this.api.slackAuthTest({ botToken }).catch((error: unknown) => {
        throw new Error(`Slack did not take the bot token: ${safeError(error)}`);
      });
      await this.api.slackOpenSocket({ botToken, appToken: app }).catch((error: unknown) => {
        throw new Error(`Slack did not take the app-level token: ${safeError(error)}`);
      });
    } else {
      if (token && !MM_TOKEN.test(token)) throw new Error('That does not look like a Mattermost token. It is a string of letters and digits, without spaces.');
      const had = this.bots.mattermost(true);
      const baseUrl = (typeof input.baseUrl === 'string' && input.baseUrl.trim() ? input.baseUrl : (had?.baseUrl ?? '')).trim().replace(/\/+$/, '');
      if (!baseUrl) throw new Error("Mattermost needs the server's address, like https://chat.example.com");
      const mmToken = token || (had?.baseUrl === baseUrl ? had.token : '');
      if (!mmToken) throw new Error(had && had.baseUrl !== baseUrl ? 'The address changed, so the token has to be entered again.' : "The bot account's token is needed.");
      if (await this.o.tenants.contextBot().usesToken('mattermost', mmToken))
        throw new Error('That is the context bot\'s token. The agent bot needs a bot account of its own, so the context bot stays one that only reads.');
      identity = await this.api.mmMe({ baseUrl, token: mmToken }).catch((error: unknown) => {
        throw new Error(`Mattermost did not take the token: ${safeError(error)}`);
      });
      if (!this.o.publicUrl())
        notes.push('The server has no public address (SSHS3_PUBLIC_URL), so Mattermost cards are answered with reactions, not buttons.');
      else if (!this.mattermostButtons())
        notes.push(
          "Mattermost cards are answered with reactions. For buttons, set SSHS3_MATTERMOST_ACTION_FROM to the address Mattermost's server posts from: without it, a press cannot be proved to come from Mattermost.",
        );
    }
    if (this.answering.settings().enabled) {
      // Answering is on: a service the data policy does not allow is not connected at all.
      const [check] = await this.policyChecksFor(service, input.baseUrl);
      if (check && !check.allowed) throw new Error(`The agent bot was not connected. ${check.errors.join(' ')}`);
    }
    await this.bots.save(input);
    await this.bots.setIdentity(service, identity);
    // The chat agent's SSH key is made now, so the administrator sees what to put on the servers it may reach.
    await this.o.tenants.chatAgentPublicKey().catch(() => undefined);
    await this.service.refresh();
    await this.o.audit({ actor: name, what: `connected the agent bot to ${chatServiceLabel(service)}${identity.team ? ` (${clip(identity.team, 80)})` : ''}` }).catch(() => undefined);
    this.o.tenants.chatAnsweringChanged(userId);
    return {
      chatAgentConnect: {
        service,
        bot: clip(identity.name || identity.username || identity.userId, 120),
        ...(identity.team ? { team: clip(identity.team, 120) } : {}),
        notes,
      },
    };
  }

  /** The policy check of one service, at the address about to be saved. */
  private async policyChecksFor(service: ChatServiceName, baseUrl?: string): Promise<Array<{ allowed: boolean; errors: string[] }>> {
    const policy = await this.policyOf('agent').catch(() => undefined);
    if (!policy) return [{ allowed: false, errors: ["The chat agent's data policy could not be read."] }];
    const address = service === 'mattermost' ? (baseUrl?.trim() || this.bots.mattermost(true)?.baseUrl) : undefined;
    const check = validateChatEgress(policy.policy, service, address, { euAllowedHosts: policy.euAllowedHosts });
    return [{ allowed: check.allowed, errors: check.errors }];
  }

  /** The chat agent uses the administrator's model settings: the file is copied whole, keys sealed as they were. */
  private async copyModel(userId: string, name: string): Promise<HubReply> {
    const user = await this.o.user(userId);
    if (!user) throw new Error('Your account cannot do this.');
    const mine = await this.o.tenants.getOrCreateTenant(user);
    let content: string;
    try {
      content = await fsp.readFile(path.join(mine.userDir, 'ai-config.json'), 'utf8');
    } catch {
      throw new Error('You have not set up a model yet. Set one up in your own settings first.');
    }
    const agent = await this.agentTenant();
    await fsp.mkdir(agent.userDir, { recursive: true, mode: 0o700 });
    await writeFileAtomic(path.join(agent.userDir, 'ai-config.json'), content, { mode: 0o600 });
    await this.o.audit({ actor: name, what: 'gave the chat agent the same model settings as their own' }).catch(() => undefined);
    this.o.tenants.chatAnsweringChanged(userId);
    return { notes: ['The chat agent now uses the same model settings as you. A later change to yours is not copied: copy again.'] };
  }

  // ---- reading the chat agent's conversations ------------------------------------------------------------

  private async runs(): Promise<ChatRunItem[]> {
    const hub = (await this.agentTenant()).hub;
    return hub.store.data.tasks
      .filter((t) => t.chat)
      .map((t) => {
        const chat = t.chat!;
        const tokens = (t.usage?.inputTokens ?? 0) + (t.usage?.outputTokens ?? 0);
        return {
          taskId: t.id,
          title: t.title,
          status: t.status,
          service: chat.service,
          channelId: chat.channelId,
          channelName: chat.channelName,
          kind: chat.kind,
          threadId: chat.threadId,
          askedBy: chat.askedBy.name,
          reach: chat.fence.reach,
          waiting: t.changes.filter((c) => c.status === 'pending').length + (t.plan?.status === 'proposed' ? 1 : 0),
          ...(tokens ? { tokens } : {}),
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
        };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 200);
  }

  private async task(taskId: string): Promise<ChatTaskView> {
    const hub: HubService = (await this.agentTenant()).hub;
    const task = hub.store.data.tasks.find((t) => t.id === taskId && t.chat);
    if (!task?.chat) throw new Error('That conversation is not one of the chat agent\'s.');
    const tokens = (task.usage?.inputTokens ?? 0) + (task.usage?.outputTokens ?? 0);
    return structuredClone({
      taskId: task.id,
      title: task.title,
      status: task.status,
      chat: task.chat,
      // What the person asked, apart from what the agent was told with it (who asked, how far it may go,
      // what the team wrote before): the read view shows the question, and the rest folded away.
      messages: task.messages.map((m) => {
        if (m.role !== 'user') return m;
        const split = splitChatMessage(task.chat, m.text);
        return split.told ? { ...m, text: split.asked, told: split.told } : m;
      }),
      changes: task.changes,
      ...(task.plan ? { plan: task.plan } : {}),
      ...(tokens ? { tokens } : {}),
    });
  }

  // ---- try it ------------------------------------------------------------------------------------------

  /** A chat that lives in this process, answered by a service of its own with the administrator's rules. */
  private trial(service: ChatServiceName): Promise<Trial> {
    let made = this.trials.get(service);
    if (!made) {
      made = (async () => {
        const chat = new SimChat({ service });
        // Its own links and threads: nothing tried here is a real chat's.
        const links = new ChatAgentStore(path.join(this.o.dataDir, 'chat-agent-try'), {
          usable: (id) => Boolean(this.account(id) && !this.account(id)?.disabled),
        });
        await links.initialize();
        const pending = new Set<Promise<unknown>>();
        const trial: Trial = {
          chat,
          links,
          pending,
          service: this.makeService({
            links,
            api: chat.api,
            bots: chat.bots,
            transport: (s, options) =>
              chat.transport(s, {
                ...options,
                onEvent: (event) => {
                  const handled = Promise.resolve(options.onEvent(event));
                  pending.add(handled);
                  void handled.finally(() => pending.delete(handled));
                  return handled;
                },
              }),
            // Nothing leaves this process: no data policy stops a simulated chat.
            policyOf: async () => ({ policy: 'standard' }),
            outboxGaps: ZERO_GAPS,
            readsThreads: false,
          }),
        };
        await trial.service.start();
        return trial;
      })();
      made.catch(() => this.trials.delete(service));
      this.trials.set(service, made);
    }
    return made;
  }

  private async tryIt(userId: string, name: string, request: Extract<ChatAnsweringRequest, { action: 'chat-answering-try' }>): Promise<ChatTryResult> {
    if (!this.started) throw new Error('The agent bot is not running.');
    if (!this.mayTry()) throw new Error('"Try it" is for the demo, or for before the agent bot is connected. Now ask the agent bot in your chat.');
    const interaction = request.interaction;
    const text = typeof request.text === 'string' ? request.text.trim() : '';
    if (!text && !interaction) throw new Error('Write something for the agent bot.');
    const dm = request.channel === 'dm';
    const channelId = dm ? '' : String(request.channel ?? '').trim();
    if (!dm && !/^[A-Za-z0-9_-]{1,64}$/.test(channelId)) throw new Error('Choose a channel the agent bot answers in, or "dm" for a direct message.');
    const settings = this.answering.settings();
    const service: ChatServiceName = !dm && settings.channels.mattermost.some((r) => r.channelId === channelId) && !settings.channels.slack.some((r) => r.channelId === channelId) ? 'mattermost' : 'slack';
    const trial = await this.trial(service);
    const as = request.as === 'me' ? 'me' : 'guest';
    const chatUser = TRY_PEOPLE[as];
    trial.chat.people[chatUser] = as === 'me' ? name : 'A guest';
    // "me" is the administrator, linked; "guest" is somebody who did not link.
    const linked = trial.links.linkOf(service, chatUser);
    if (as === 'me' && linked?.accountId !== userId) {
      const { code } = await trial.links.linkCode(userId, service);
      const done = await trial.links.redeem(service, chatUser, name, code);
      if (!done.ok) throw new Error(done.message);
    }
    const channel = dm ? trial.chat.dmChannel(chatUser) : channelId;
    const thread = typeof request.thread === 'string' && request.thread.trim() ? request.thread.trim() : undefined;
    if (thread && !trial.chat.posts.get(thread)) throw new Error('That thread is not in the tried chat. Start a new one.');
    const from = trial.chat.log.length;
    let said: string | undefined;
    if (interaction) {
      const targetPost = trial.chat.posts.get(interaction.postId);
      if (!targetPost) throw new Error('That card or message is not in the tried chat.');
      if (interaction.kind === 'click') {
        trial.chat.click(interaction.postId, interaction.action, chatUser);
      } else {
        trial.chat.react(interaction.postId, interaction.emoji, chatUser);
      }
      said = targetPost.threadId ?? targetPost.id;
    } else {
      said = trial.chat.say(channel, chatUser, clip(text, 4000), { dm, ...(thread && !dm ? { thread } : {}) });
    }
    // The message or interaction is handed on after this turn, as a socket would: wait for it to be handled.
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.allSettled([...trial.pending]);
    const threadId = dm ? DM_THREAD : (thread ?? said);
    const settled = await this.waitForAnswer(trial, service, channel, threadId);
    const ids = new Set<string>();
    const privateNotes: string[] = [];
    for (const entry of trial.chat.log.slice(from)) {
      if (entry.op === 'post') ids.add(entry.post.id);
      else if (entry.op === 'edit') ids.add(entry.postId);
      else if (entry.op === 'ephemeral' && entry.userId === chatUser) privateNotes.push(entry.text);
    }
    // The cards in the thread that still wait for an answer: the page says how they are answered.
    const cards = Object.values(trial.links.thread(service, channel, threadId)?.cards ?? {});
    const waitingCards = new Set(cards.filter((c) => !c.final).map((c) => c.post));
    const posts = [...ids].flatMap((id) => {
      const p = trial.chat.posts.get(id);
      if (!p) return [];
      const buttons = (p.blocks ?? []).some((b) => b.type === 'actions') || (p.attachments ?? []).some((a) => Array.isArray(a.actions) && a.actions.length > 0);
      // What a person reads: in Slack the blocks, as the post's own text is only the short line a notification shows.
      const text = p.blocks?.length ? blockTexts(p.blocks).join('\n\n') || p.text : p.text;
      return [{ id: p.id, ...(p.threadId ? { threadId: p.threadId } : {}), text, edits: p.edits, buttons, ...(waitingCards.has(p.id) ? { waitingCard: true } : {}) }];
    });
    return { channelId: channel, thread: dm ? DM_THREAD : (thread ?? said), settled, posts, privateNotes };
  }

  /** Waits until the run the message started has answered, waits for a person, or the wait is over. */
  private async waitForAnswer(trial: Trial, service: ChatServiceName, channelId: string, threadId: string): Promise<boolean> {
    const end = Date.now() + (this.o.tryWaitMs ?? TRY_WAIT_MS);
    for (;;) {
      const thread = trial.links.thread(service, channelId, threadId);
      if (!thread) return true;
      const tenant = thread.owner === 'agent' ? this.o.tenants.chatAgentIfStarted() : await this.personTenant(thread.owner.slice('user:'.length)).catch(() => undefined);
      const task = tenant?.hub.store.data.tasks.find((t) => t.id === thread.taskId);
      if (!task) return true;
      if (!runActive(task.status) && thread.statusDone) return true;
      // A card waits for a person: what was posted so far is the answer for now.
      if (task.status === 'waiting' && Object.values(thread.cards).some((c) => !c.final)) return false;
      if (Date.now() > end) return false;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

function serviceOf(value: unknown): ChatServiceName {
  if (value === 'slack' || value === 'mattermost') return value;
  throw new Error('Choose Slack or Mattermost.');
}
