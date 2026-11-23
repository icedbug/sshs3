import fsp from 'node:fs/promises';
import path from 'node:path';
import type {
  ChatAnsweringInput,
  ChatAnsweringLimits,
  ChatAnsweringSettings,
  ChatAnsweringView,
  ChatChannelRule,
  ChatDmRule,
  ChatFence,
  ChatReach,
  ChatServiceName,
} from '../../../shared/types/aiHub';
import { writeFileAtomic } from '../../storage/atomicFile';
import { MM_ID, SLACK_ID } from './AgentBotApi';

/**
 * Where and how far the agent bot answers in chat, in `<dataDir>/chat-agent/answering.json`: the
 * channels an administrator chose and the fence of each, direct messages, the limits per hour, and the
 * month's token budget with what was used of it. The file is the server's own (0600) and is written
 * whole through one queue, so a crash leaves the old file or the new one.
 *
 * The counts per hour are kept in memory only: a restart forgets them, which lets at most one more
 * hour through, and keeps a busy channel from writing the disk at every message. The budget is kept on
 * disk, since a month is long.
 */

const SERVICES: ChatServiceName[] = ['slack', 'mattermost'];
const REACHES: ChatReach[] = ['read', 'ask', 'plan'];
const HOUR_MS = 3600_000;

export const DEFAULT_CHAT_LIMITS: ChatAnsweringLimits = {
  personNewPerHour: 10,
  personMessagesPerHour: 30,
  channelPerHour: 30,
  concurrentRuns: 4,
};

/** The least and most an administrator may set, so a typo cannot open the gates or shut them by accident. */
export const CHAT_LIMIT_BOUNDS: Record<keyof ChatAnsweringLimits, { min: number; max: number; what: string }> = {
  personNewPerHour: { min: 1, max: 100, what: 'New conversations per person in an hour' },
  personMessagesPerHour: { min: 1, max: 500, what: 'Messages per person in an hour' },
  channelPerHour: { min: 1, max: 1000, what: 'Messages per channel in an hour' },
  concurrentRuns: { min: 1, max: 16, what: 'Answers at the same time' },
};
export const DEFAULT_CHAT_BUDGET = 2_000_000;
export const CHAT_BUDGET_BOUNDS = { min: 10_000, max: 10_000_000_000 };
export const DEFAULT_CHAT_APPROVAL_WAIT = 60;
/** A button is good for a day (chatActionToken), so a change does not wait longer than that. */
export const CHAT_APPROVAL_WAIT_BOUNDS = { min: 1, max: 1440 };
const MAX_CHANNELS = 200;
const MAX_NAMES = 200;
const MAX_HISTORY = 50;

/**
 * What is counted per hour. `off-reply`: the one reply an hour that a channel is not turned on, and the
 * like. `short-reply`: a few plain replies an hour per person and kind ("I am still working", "I do not
 * answer direct messages"), so one person cannot fill a channel's queue ahead of cards and answers.
 */
export type ChatRateKind = 'person-new' | 'person-message' | 'channel' | 'off-reply' | 'short-reply';
/** Plain replies a person gets per kind in an hour. */
export const SHORT_REPLIES_PER_HOUR = 5;

interface AnsweringFile {
  version: 1;
  settings: ChatAnsweringSettings;
  usage: { month: string; tokens: number };
  changedBy?: string;
  changedAt?: number;
}

export function defaultChatAnswering(): ChatAnsweringSettings {
  return {
    enabled: false,
    channels: { slack: [], mattermost: [] },
    dms: { enabled: false, unlinked: 'off', servers: [], clusters: [] },
    limits: { ...DEFAULT_CHAT_LIMITS },
    monthlyTokenBudget: DEFAULT_CHAT_BUDGET,
    approvalWaitMinutes: DEFAULT_CHAT_APPROVAL_WAIT,
  };
}

/** The month a time falls in, in UTC: "2026-11". */
export const monthOf = (at: number): string => new Date(at).toISOString().slice(0, 7);

const plain = (value: unknown, max: number): string =>
  typeof value === 'string'
    ? value
        // eslint-disable-next-line no-control-regex -- control characters have no place in a name
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .trim()
        .slice(0, max)
    : '';

function nameList(value: unknown, what: string, allowAll: boolean): string[] | '*' {
  if (allowAll && value === '*') return '*';
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${what} must be a list${allowAll ? ', or * for all' : ''}.`);
  const out: string[] = [];
  for (const v of value) {
    const name = plain(v, 200);
    if (allowAll && name === '*') return '*';
    if (name && !out.includes(name)) out.push(name);
  }
  if (out.length > MAX_NAMES) throw new Error(`${what}: at most ${MAX_NAMES}.`);
  return out;
}

function channelIdOk(service: ChatServiceName, id: string): boolean {
  return service === 'slack' ? SLACK_ID.test(id) : MM_ID.test(id);
}

function checkRule(service: ChatServiceName, raw: Partial<ChatChannelRule>): ChatChannelRule {
  const channelId = plain(raw.channelId, 64);
  if (!channelIdOk(service, channelId)) throw new Error(`That is not a ${service === 'slack' ? 'Slack' : 'Mattermost'} channel id: ${channelId || 'empty'}.`);
  const channelName = plain(raw.channelName, 120).replace(/^#/, '') || channelId;
  const reach = raw.reach ?? 'read';
  if (!REACHES.includes(reach)) throw new Error(`For #${channelName}, choose read, ask or plan.`);
  const approvers = raw.approvers ?? 'linked';
  if (approvers !== 'linked' && approvers !== 'admins') throw new Error(`For #${channelName}, choose who may approve: linked people or administrators.`);
  const agentId = raw.agentId === undefined || raw.agentId === '' ? undefined : plain(raw.agentId, 100);
  if (agentId !== undefined && !/^[A-Za-z0-9._:-]{1,100}$/.test(agentId)) throw new Error(`For #${channelName}, that is not an agent id.`);
  const history: string[] = [];
  for (const id of Array.isArray(raw.historyFrom) ? raw.historyFrom : []) {
    const clean = plain(id, 64);
    if (!channelIdOk(service, clean)) throw new Error(`For #${channelName}, a channel to search is not a channel id: ${clean || 'empty'}.`);
    if (!history.includes(clean)) history.push(clean);
  }
  if (history.length > MAX_HISTORY) throw new Error(`For #${channelName}, at most ${MAX_HISTORY} channels to search.`);
  return {
    channelId,
    channelName,
    servers: nameList(raw.servers, `Servers for #${channelName}`, true),
    clusters: nameList(raw.clusters, `Clusters for #${channelName}`, false) as string[],
    reach,
    ...(agentId ? { agentId } : {}),
    approvers,
    historyFrom: history,
  };
}

function checkDms(raw: Partial<ChatDmRule>, had: ChatDmRule): ChatDmRule {
  const unlinked = raw.unlinked ?? had.unlinked;
  if (unlinked !== 'read' && unlinked !== 'off') throw new Error('For direct messages from people who are not linked, choose commands only or off.');
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : had.enabled,
    unlinked,
    servers: raw.servers !== undefined ? nameList(raw.servers, 'Servers for direct messages', true) : had.servers,
    clusters: raw.clusters !== undefined ? (nameList(raw.clusters, 'Clusters for direct messages', false) as string[]) : had.clusters,
  };
}

function bounded(value: unknown, bounds: { min: number; max: number }, what: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < bounds.min || n > bounds.max)
    throw new Error(`${what} must be a whole number from ${bounds.min} to ${bounds.max}.`);
  return n;
}

function checkLimits(raw: Partial<ChatAnsweringLimits>, had: ChatAnsweringLimits): ChatAnsweringLimits {
  const out = { ...had };
  for (const key of Object.keys(CHAT_LIMIT_BOUNDS) as (keyof ChatAnsweringLimits)[])
    if (raw[key] !== undefined) out[key] = bounded(raw[key], CHAT_LIMIT_BOUNDS[key], CHAT_LIMIT_BOUNDS[key].what);
  return out;
}

/** The fence of every conversation started in a channel: its servers, reach, and who may approve, copied. */
export function fenceFromRule(rule: ChatChannelRule): ChatFence {
  return {
    servers: rule.servers === '*' ? '*' : [...rule.servers],
    clusters: [...rule.clusters],
    reach: rule.reach,
    // Empty means the channel it was asked in, and only that one.
    historyFrom: rule.historyFrom.length ? [...rule.historyFrom] : [rule.channelId],
    approvers: rule.approvers,
  };
}

/**
 * The fence of a direct message. A linked person's runs in their own hub, on their own servers, and
 * every change card waits for them. An unlinked person's runs in the chat agent's hub, with reach "read", inside the
 * servers the administrator set for direct messages. Neither searches the team chat: a direct message
 * is not a channel the team reads.
 */
export function dmFence(dms: ChatDmRule, linked: boolean): ChatFence {
  if (linked) return { servers: '*', clusters: [], reach: 'ask', historyFrom: [], approvers: 'linked' };
  return {
    servers: dms.servers === '*' ? '*' : [...dms.servers],
    clusters: [...dms.clusters],
    reach: 'read',
    historyFrom: [],
    approvers: 'linked',
  };
}

export class ChatAnsweringStore {
  readonly dir: string;
  private readonly file: string;
  private data: AnsweringFile;
  private loaded?: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  private readonly clock: () => number;
  /** Times of what was counted, per kind and key, within the last hour. */
  private readonly windows = new Map<string, number[]>();

  constructor(dataDir: string, options: { clock?: () => number } = {}) {
    this.dir = path.join(dataDir, 'chat-agent');
    this.file = path.join(this.dir, 'answering.json');
    this.clock = options.clock ?? Date.now;
    this.data = { version: 1, settings: defaultChatAnswering(), usage: { month: monthOf(this.clock()), tokens: 0 } };
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
    const file = (parsed && typeof parsed === 'object' ? parsed : {}) as Partial<AnsweringFile>;
    const s = (file.settings ?? {}) as Partial<ChatAnsweringSettings>;
    const base = defaultChatAnswering();
    // What was saved is read through the same checks as a save: a rule that no longer passes is left
    // out (its channel is then not answered), never let through as it was.
    const channels: ChatAnsweringSettings['channels'] = { slack: [], mattermost: [] };
    for (const service of SERVICES) {
      for (const rule of Array.isArray(s.channels?.[service]) ? s.channels[service] : []) {
        try {
          const ok = checkRule(service, rule);
          if (!channels[service].some((r) => r.channelId === ok.channelId)) channels[service].push(ok);
        } catch {
          // Left out, as said above.
        }
      }
    }
    const keep = <T>(read: () => T, fallback: T): T => {
      try {
        return read();
      } catch {
        return fallback;
      }
    };
    this.data = {
      version: 1,
      settings: {
        enabled: s.enabled === true,
        channels,
        dms: keep(() => checkDms(s.dms ?? {}, base.dms), base.dms),
        limits: { ...base.limits, ...keep(() => checkLimits(s.limits ?? {}, base.limits), base.limits) },
        monthlyTokenBudget: keep(() => bounded(s.monthlyTokenBudget ?? DEFAULT_CHAT_BUDGET, CHAT_BUDGET_BOUNDS, 'budget'), DEFAULT_CHAT_BUDGET),
        approvalWaitMinutes: keep(
          () => bounded(s.approvalWaitMinutes ?? DEFAULT_CHAT_APPROVAL_WAIT, CHAT_APPROVAL_WAIT_BOUNDS, 'wait'),
          DEFAULT_CHAT_APPROVAL_WAIT,
        ),
      },
      usage:
        file.usage && typeof file.usage.month === 'string' && Number.isFinite(file.usage.tokens) && file.usage.tokens >= 0
          ? { month: file.usage.month, tokens: file.usage.tokens }
          : { month: monthOf(this.clock()), tokens: 0 },
      ...(typeof file.changedBy === 'string' ? { changedBy: file.changedBy } : {}),
      ...(Number.isFinite(file.changedAt) ? { changedAt: file.changedAt } : {}),
    };
  }

  private persist(): Promise<void> {
    const write = async (): Promise<void> => {
      // What is in memory when this write's turn comes, so the last write always holds the latest.
      await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
      await writeFileAtomic(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    };
    const next = this.writes.then(write, write);
    this.writes = next.catch(() => undefined);
    return next;
  }

  /** A new month starts from nothing. */
  private rollMonth(): void {
    const month = monthOf(this.clock());
    if (this.data.usage.month !== month) this.data.usage = { month, tokens: 0 };
  }

  settings(): ChatAnsweringSettings {
    return structuredClone(this.data.settings);
  }

  view(): ChatAnsweringView {
    this.rollMonth();
    return {
      ...structuredClone(this.data.settings),
      usage: { ...this.data.usage },
      ...(this.data.changedBy ? { changedBy: this.data.changedBy } : {}),
      ...(this.data.changedAt ? { changedAt: this.data.changedAt } : {}),
    };
  }

  /**
   * Saves what an administrator changed. Only the fields given change; a service's channel list given
   * replaces the whole list. Everything is checked first, and nothing is saved when one part is wrong.
   */
  async save(input: ChatAnsweringInput, by: string): Promise<ChatAnsweringView> {
    await this.initialize();
    const had = this.data.settings;
    const next: ChatAnsweringSettings = structuredClone(had);
    if (input.enabled !== undefined) next.enabled = input.enabled === true;
    for (const service of SERVICES) {
      const list = input.channels?.[service];
      if (list === undefined) continue;
      if (!Array.isArray(list)) throw new Error('The channels must be a list.');
      if (list.length > MAX_CHANNELS) throw new Error(`At most ${MAX_CHANNELS} channels.`);
      const rules: ChatChannelRule[] = [];
      for (const raw of list) {
        const rule = checkRule(service, raw ?? {});
        if (rules.some((r) => r.channelId === rule.channelId)) throw new Error(`#${rule.channelName} is in the list twice.`);
        rules.push(rule);
      }
      next.channels[service] = rules;
    }
    if (input.dms !== undefined) next.dms = checkDms(input.dms, had.dms);
    if (input.limits !== undefined) next.limits = checkLimits(input.limits, had.limits);
    if (input.monthlyTokenBudget !== undefined)
      next.monthlyTokenBudget = bounded(input.monthlyTokenBudget, CHAT_BUDGET_BOUNDS, 'The monthly token budget');
    if (input.approvalWaitMinutes !== undefined)
      next.approvalWaitMinutes = bounded(input.approvalWaitMinutes, CHAT_APPROVAL_WAIT_BOUNDS, 'The wait for an answer, in minutes,');
    this.data.settings = next;
    this.data.changedBy = plain(by, 120) || undefined;
    this.data.changedAt = this.clock();
    await this.persist();
    return this.view();
  }

  /** The rule of a channel the administrator chose, or nothing. */
  channelRule(service: ChatServiceName, channelId: string): ChatChannelRule | undefined {
    const rule = this.data.settings.channels[service]?.find((r) => r.channelId === channelId);
    return rule ? structuredClone(rule) : undefined;
  }

  /**
   * The fence of a new conversation, or nothing when it may not be had: answering is off, the channel
   * was not chosen, direct messages are off, or they are off for people who did not link.
   */
  fenceFor(service: ChatServiceName, place: { kind: 'channel'; channelId: string } | { kind: 'dm'; linked: boolean }): ChatFence | undefined {
    const s = this.data.settings;
    if (!s.enabled) return undefined;
    if (place.kind === 'channel') {
      const rule = s.channels[service]?.find((r) => r.channelId === place.channelId);
      return rule ? fenceFromRule(rule) : undefined;
    }
    if (!s.dms.enabled) return undefined;
    if (!place.linked && s.dms.unlinked === 'off') return undefined;
    return dmFence(s.dms, place.linked);
  }

  limits(): ChatAnsweringLimits {
    return { ...this.data.settings.limits };
  }

  // ---- counts per hour ---------------------------------------------------------------------------

  private limitOf(kind: ChatRateKind): number {
    const l = this.data.settings.limits;
    switch (kind) {
      case 'person-new':
        return l.personNewPerHour;
      case 'person-message':
        return l.personMessagesPerHour;
      case 'channel':
        return l.channelPerHour;
      case 'off-reply':
        return 1;
      case 'short-reply':
        return SHORT_REPLIES_PER_HOUR;
    }
  }

  private recent(kind: ChatRateKind, key: string): number[] {
    const now = this.clock();
    const id = `${kind}\u0000${key}`;
    const times = (this.windows.get(id) ?? []).filter((t) => now - t < HOUR_MS);
    if (times.length) this.windows.set(id, times);
    else this.windows.delete(id);
    return times;
  }

  /** Whether one more of this kind fits in the last hour for this person or channel. */
  may(kind: ChatRateKind, key: string): boolean {
    return this.recent(kind, key).length < this.limitOf(kind);
  }

  /** Counts one. */
  count(kind: ChatRateKind, key: string): void {
    const times = this.recent(kind, key);
    times.push(this.clock());
    this.windows.set(`${kind}\u0000${key}`, times);
    if (this.windows.size > 5000) {
      const now = this.clock();
      for (const [id, list] of this.windows) if (!list.some((t) => now - t < HOUR_MS)) this.windows.delete(id);
    }
  }

  /** Counts one when it fits, and says whether it did. */
  take(kind: ChatRateKind, key: string): boolean {
    if (!this.may(kind, key)) return false;
    this.count(kind, key);
    return true;
  }

  // ---- the month's budget ------------------------------------------------------------------------

  /** Tokens left this month. */
  budgetLeft(): number {
    this.rollMonth();
    return Math.max(0, this.data.settings.monthlyTokenBudget - this.data.usage.tokens);
  }

  /** Whether a new answer may start: some of this month's budget is left. */
  withinBudget(): boolean {
    return this.budgetLeft() > 0;
  }

  /** What a settled run used, counted against this month. */
  async addUsage(tokens: number): Promise<void> {
    await this.initialize();
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    this.rollMonth();
    this.data.usage.tokens += Math.round(tokens);
    await this.persist();
  }
}
