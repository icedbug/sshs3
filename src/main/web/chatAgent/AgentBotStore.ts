import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AgentBotIdentity, AgentBotInput, AgentBotView, ChatServiceName } from '../../../shared/types/aiHub';
import { decryptSecretValue, encryptSecretValue } from '../../crypto/SecretFieldCrypto';
import { guardUrl, type GuardOptions } from '../../ai/hub/Notifier';
import { clip } from '../../ai/hub/privacy';
import { writeFileAtomic } from '../../storage/atomicFile';

/**
 * The agent bot's own credentials, in `<dataDir>/chat-agent/connections.json`.
 *
 * The agent bot is not the context bot: it is a Slack app or Mattermost bot account of its own, so
 * its tokens are kept apart from the context bot's file in `team-chat/`, and the context bot never
 * gets a token that can post. Every token is encrypted before it reaches the disk, the file is the
 * server's own (0600) and is written whole through one queue, so a crash leaves the old file or the
 * new one. No view of this store ever holds a token.
 */

interface StoredConnection {
  service: ChatServiceName;
  /** Slack: the bot token. Mattermost: the bot account's token. Encrypted on disk. */
  token: string;
  /** Slack: the app-level token that opens the socket. Encrypted on disk. */
  appToken?: string;
  /** Mattermost: the server's address. */
  baseUrl?: string;
  enabled: boolean;
  identity?: AgentBotIdentity;
  lastError?: string;
  lastErrorAt?: number;
  savedAt?: number;
}

interface ConnectionsFile {
  version: 1;
  connections: StoredConnection[];
}

export interface AgentSlackCredentials {
  botToken: string;
  appToken: string;
}

export interface AgentMattermostCredentials {
  baseUrl: string;
  token: string;
}

const SERVICES: ChatServiceName[] = ['slack', 'mattermost'];
const NAME: Record<ChatServiceName, string> = { slack: 'Slack', mattermost: 'Mattermost' };

export const SLACK_BOT_TOKEN = /^xoxb-\S+$/;
/** Slack's app-level tokens start with xapp-, and the newer rotating kind with xoxe.xapp-. */
export const SLACK_APP_TOKEN = /^(?:xapp-|xoxe\.xapp-)\S+$/;
/** Visible ASCII only: Mattermost's tokens are 26 letters and digits, and the token is sent in a header. */
export const MM_TOKEN = /^[\x21-\x7e]{8,512}$/;

export class AgentBotStore {
  readonly dir: string;
  private readonly file: string;
  private connections: Partial<Record<ChatServiceName, StoredConnection>> = {};
  private loaded?: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  private readonly guard: () => GuardOptions;
  private readonly clock: () => number;

  constructor(dataDir: string, options: { guard: () => GuardOptions; clock?: () => number }) {
    this.dir = path.join(dataDir, 'chat-agent');
    this.file = path.join(this.dir, 'connections.json');
    this.guard = options.guard;
    this.clock = options.clock ?? Date.now;
  }

  initialize(): Promise<void> {
    this.loaded ??= this.load().catch((err) => {
      this.loaded = undefined;
      throw err;
    });
    return this.loaded;
  }

  private async load(): Promise<void> {
    let parsed: unknown;
    try {
      const raw = (await fsp.readFile(this.file, 'utf8')).replace(/^\uFEFF/, '').trim();
      parsed = raw ? JSON.parse(raw) : undefined;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    const list = (parsed as Partial<ConnectionsFile> | undefined)?.connections;
    for (const c of Array.isArray(list) ? list : []) {
      if (!c || !SERVICES.includes(c.service)) continue;
      // A token encrypted on another machine does not decrypt here: it counts as not saved.
      const token = typeof c.token === 'string' ? decryptSecretValue(c.token) : '';
      const appToken = typeof c.appToken === 'string' ? decryptSecretValue(c.appToken) : '';
      this.connections[c.service] = {
        ...c,
        token,
        ...(c.service === 'slack' ? { appToken } : { appToken: undefined }),
        enabled: c.enabled !== false,
      };
    }
  }

  private persist(): Promise<void> {
    const write = async (): Promise<void> => {
      // What is in memory when this write's turn comes, so the last write always holds the latest.
      const content: ConnectionsFile = {
        version: 1,
        connections: Object.values(this.connections).map((c) => ({
          ...c,
          token: encryptSecretValue(c.token),
          ...(c.appToken !== undefined ? { appToken: encryptSecretValue(c.appToken) } : {}),
        })),
      };
      await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
      await writeFileAtomic(this.file, JSON.stringify(content, null, 2), { mode: 0o600 });
    };
    const next = this.writes.then(write, write);
    this.writes = next.catch(() => undefined);
    return next;
  }

  view(): AgentBotView[] {
    return SERVICES.flatMap((service) => {
      const c = this.connections[service];
      if (!c) return [];
      return [
        {
          service,
          enabled: c.enabled,
          hasToken: Boolean(c.token),
          ...(service === 'slack' ? { hasAppToken: Boolean(c.appToken) } : { baseUrl: c.baseUrl }),
          ...(c.identity ? { identity: { ...c.identity } } : {}),
          ...(c.lastError ? { lastError: c.lastError, lastErrorAt: c.lastErrorAt } : {}),
          ...(c.savedAt ? { savedAt: c.savedAt } : {}),
        },
      ];
    });
  }

  /**
   * Saves the connection from the form. A token left empty keeps the one saved, except for
   * Mattermost at a new address: a token is for one server and is not sent to another.
   */
  async save(input: AgentBotInput): Promise<AgentBotView> {
    await this.initialize();
    if (!SERVICES.includes(input.service)) throw new Error('Choose Slack or Mattermost.');
    const had = this.connections[input.service];
    const token = input.token?.trim() ?? '';
    const appToken = input.appToken?.trim() ?? '';
    let next: StoredConnection;
    if (input.service === 'slack') {
      if (token && !SLACK_BOT_TOKEN.test(token))
        throw new Error("That does not look like the agent bot's token. A Slack bot token starts with xoxb-.");
      if (appToken && !SLACK_APP_TOKEN.test(appToken))
        throw new Error('That does not look like an app-level token. It starts with xapp-, and is made in the app\'s Basic Information, under App-Level Tokens.');
      const botToken = token || had?.token || '';
      const app = appToken || had?.appToken || '';
      if (!botToken) throw new Error("The agent bot's token is needed. It starts with xoxb-.");
      if (!app) throw new Error('The app-level token is needed. It starts with xapp-.');
      if (botToken === app) throw new Error('The bot token and the app-level token are two different tokens.');
      const changed = botToken !== had?.token || app !== had?.appToken;
      next = {
        ...(changed ? {} : had),
        service: 'slack',
        token: botToken,
        appToken: app,
        enabled: input.enabled ?? had?.enabled ?? true,
        savedAt: this.clock(),
      };
    } else {
      const baseUrl = (input.baseUrl ?? had?.baseUrl ?? '').trim().replace(/\/+$/, '');
      if (!baseUrl) throw new Error("Mattermost needs the server's address, like https://chat.example.com");
      // Checked now, so an address the server may not call is never saved.
      await guardUrl(baseUrl, this.guard());
      const sameSite = had?.baseUrl === baseUrl;
      const kept = sameSite ? had?.token : '';
      // The token goes in a header of the socket's upgrade, where a line break or other odd character cannot go.
      if (token && !MM_TOKEN.test(token)) throw new Error('That does not look like a Mattermost token. It is a string of letters and digits, without spaces.');
      const mmToken = token || kept || '';
      if (!mmToken)
        throw new Error(had && !sameSite ? 'The address changed, so the token has to be entered again.' : "The bot account's token is needed.");
      const changed = mmToken !== had?.token || !sameSite;
      next = {
        ...(changed ? {} : had),
        service: 'mattermost',
        token: mmToken,
        baseUrl,
        enabled: input.enabled ?? had?.enabled ?? true,
        savedAt: this.clock(),
      };
    }
    if (next.token !== had?.token || next.appToken !== had?.appToken) {
      // Other tokens may be another app or bot: who it is is asked again.
      delete next.identity;
      delete next.lastError;
      delete next.lastErrorAt;
    }
    this.connections[input.service] = next;
    await this.persist();
    return this.view().find((v) => v.service === input.service)!;
  }

  async setEnabled(service: ChatServiceName, enabled: boolean): Promise<void> {
    await this.initialize();
    const c = this.connections[service];
    if (!c) throw new Error(`The agent bot is not connected to ${NAME[service]}.`);
    c.enabled = enabled;
    await this.persist();
  }

  /** Who the bot is, as the service said: its own messages are known by it. */
  async setIdentity(service: ChatServiceName, identity: AgentBotIdentity): Promise<void> {
    await this.initialize();
    const c = this.connections[service];
    if (!c) return;
    c.identity = {
      userId: identity.userId,
      ...(identity.botId ? { botId: identity.botId } : {}),
      ...(identity.username ? { username: clip(identity.username, 64) } : {}),
      ...(identity.name ? { name: clip(identity.name, 120) } : {}),
      ...(identity.team ? { team: clip(identity.team, 120) } : {}),
      ...(identity.teamId ? { teamId: identity.teamId } : {}),
    };
    await this.persist();
  }

  /** What went wrong last, or nothing when it works again. Never a token, even one a service echoed. */
  async setError(service: ChatServiceName, message: string | undefined): Promise<void> {
    await this.initialize();
    const c = this.connections[service];
    if (!c) return;
    if (!message) {
      if (!c.lastError) return;
      delete c.lastError;
      delete c.lastErrorAt;
    } else {
      let text = message;
      for (const secret of [c.token, c.appToken]) if (secret) text = text.split(secret).join('[token]');
      c.lastError = clip(text, 300);
      c.lastErrorAt = this.clock();
    }
    await this.persist();
  }

  async remove(service: ChatServiceName): Promise<void> {
    await this.initialize();
    if (!this.connections[service]) return;
    delete this.connections[service];
    await this.persist();
  }

  /** The Slack tokens, when both are saved and the connection is on. */
  slack(evenIfOff = false): AgentSlackCredentials | undefined {
    const c = this.connections.slack;
    if (!c?.token || !c.appToken || (!c.enabled && !evenIfOff)) return undefined;
    return { botToken: c.token, appToken: c.appToken };
  }

  /** The Mattermost address and token, when saved and the connection is on. */
  mattermost(evenIfOff = false): AgentMattermostCredentials | undefined {
    const c = this.connections.mattermost;
    if (!c?.token || !c.baseUrl || (!c.enabled && !evenIfOff)) return undefined;
    return { baseUrl: c.baseUrl, token: c.token };
  }

  identity(service: ChatServiceName): AgentBotIdentity | undefined {
    const id = this.connections[service]?.identity;
    return id ? { ...id } : undefined;
  }
}
