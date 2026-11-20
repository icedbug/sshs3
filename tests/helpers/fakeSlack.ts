import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { guardUrl, request } from '../../src/main/ai/hub/Notifier';
import type { AgentRequest } from '../../src/main/web/chatAgent/AgentBotApi';
import { acceptUpgrade, until, type ServerSocket } from './wsServer';

/**
 * A Slack on 127.0.0.1 for tests: the Web API calls the two bots make, and Socket Mode on a raw
 * WebSocket upgrade. It can be several Slack apps at once (the context bot and the agent bot are two),
 * and records every call with the app that made it, so a test can show which app wrote and which only
 * read.
 */

export interface FakeSlackApp {
  name: string;
  botToken: string;
  appToken: string;
  botUserId: string;
  botId: string;
}

export interface FakeSlackCall {
  app: string;
  method: string;
  params: Record<string, unknown>;
  contentType: string;
  authorization: string;
  httpMethod: string;
}

export interface FakeSlackPost {
  app: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  text: string;
  blocks?: unknown;
  unfurl_links?: unknown;
  unfurl_media?: unknown;
}

interface HistoryMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  text: string;
  thread_ts?: string;
  reply_count?: number;
  latest_reply?: string;
}

/** Calls a read-only app must never make: they post, change, join, or open a socket that takes commands. */
export const SLACK_WRITE_METHODS = new Set([
  'chat.postMessage',
  'chat.update',
  'chat.postEphemeral',
  'chat.delete',
  'chat.scheduleMessage',
  'chat.meMessage',
  'reactions.add',
  'reactions.remove',
  'files.upload',
  'files.uploadV2',
  'conversations.join',
  'conversations.invite',
  'conversations.open',
  'pins.add',
  'apps.connections.open',
]);

export interface FakeSlack {
  base: string;
  port: number;
  apps: Record<string, FakeSlackApp>;
  channels: { id: string; name: string; is_private?: boolean; members: string[] }[];
  users: Record<string, string>;
  calls: FakeSlackCall[];
  posts: FakeSlackPost[];
  updates: FakeSlackPost[];
  ephemerals: (FakeSlackPost & { user: string })[];
  acks: { app: string; envelope_id: string; payload?: unknown }[];
  opened: { app: string; ticket: string }[];
  history: Record<string, HistoryMessage[]>;
  /** The open sockets of an app, newest last. */
  sockets(app?: string): ServerSocket[];
  waitForSocket(count: number, app?: string): Promise<ServerSocket>;
  /** Somebody writes to the bot. Kept in the channel's history too, for the context bot to read. */
  say(channel: string, text: string, options?: { thread?: string; user?: string; im?: boolean; app?: string; mention?: boolean }): { ts: string; envelope: SlackEnvelopeOut };
  click(channel: string, messageTs: string, options: { user: string; value: string; actionId?: string; thread?: string; app?: string }): SlackEnvelopeOut;
  /** Sends to the newest open socket of the app, or to the socket given. */
  send(envelope: SlackEnvelopeOut, app?: string, socket?: ServerSocket): void;
  disconnect(reason: string, app?: string): void;
  /** While set, a new socket is not said hello to until hello() is called, as when Slack is slow. */
  holdHello: boolean;
  hello(socket: ServerSocket): void;
  failNext(method: string, failure: { error?: string; status?: number; retryAfter?: number; needed?: string }): void;
  /** Refuses the next socket upgrades with this status. */
  refuseSockets(count: number, status?: number, retryAfter?: number): void;
  /** How a call reaches this Slack over real HTTP, for a client whose Slack address cannot be changed. */
  transport(request: AgentRequest): Promise<{ status: number; body: string; headers?: Record<string, string | string[] | undefined> }>;
  close(): Promise<void>;
}

export interface SlackEnvelopeOut {
  envelope_id: string;
  type: string;
  payload: Record<string, unknown>;
  accepts_response_payload?: boolean;
  retry_attempt?: number;
}

const DEFAULT_APPS: FakeSlackApp[] = [
  { name: 'agent', botToken: 'xoxb-agent-token-0001', appToken: 'xapp-1-agent-app-token', botUserId: 'UAGENT', botId: 'BAGENT' },
  { name: 'context', botToken: 'xoxb-context-token-0002', appToken: 'xapp-1-context-app-token', botUserId: 'UCONTEXT', botId: 'BCONTEXT' },
];

export async function startFakeSlack(apps: FakeSlackApp[] = DEFAULT_APPS): Promise<FakeSlack> {
  const byName: Record<string, FakeSlackApp> = Object.fromEntries(apps.map((a) => [a.name, a]));
  const calls: FakeSlackCall[] = [];
  const posts: FakeSlackPost[] = [];
  const updates: FakeSlackPost[] = [];
  const ephemerals: (FakeSlackPost & { user: string })[] = [];
  const acks: FakeSlack['acks'] = [];
  const opened: FakeSlack['opened'] = [];
  const tickets = new Map<string, string>();
  const live: { app: string; socket: ServerSocket }[] = [];
  const failures = new Map<string, { error?: string; status?: number; retryAfter?: number; needed?: string }>();
  let refuse = { count: 0, status: 503, retryAfter: 0 };
  const appOf = new Map<ServerSocket, string>();
  const names = apps.map((a) => a.name);
  const channels: FakeSlack['channels'] = [
    { id: 'COPS', name: 'ops', members: names },
    { id: 'CDB', name: 'ops-db', members: names },
    { id: 'CQUIET', name: 'quiet', members: ['context'] },
  ];
  const users: Record<string, string> = { U1MARIA: 'Maria', U2OMAR: 'Omar', U3LINA: 'Lina' };
  const history: Record<string, HistoryMessage[]> = {};
  let clock = 1763640000;
  const nextTs = (): string => `${++clock}.000100`;

  const appFor = (auth: string): { app?: FakeSlackApp; kind?: 'bot' | 'app' } => {
    const token = auth.replace(/^Bearer /, '');
    for (const a of apps) {
      if (a.botToken === token) return { app: a, kind: 'bot' };
      if (a.appToken === token) return { app: a, kind: 'app' };
    }
    return {};
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const method = url.pathname.replace(/^\/api\//, '');
      const contentType = String(req.headers['content-type'] ?? '');
      const raw = Buffer.concat(chunks).toString('utf8');
      let params: Record<string, unknown> = Object.fromEntries(url.searchParams);
      if (raw) {
        if (contentType.startsWith('application/json')) params = { ...params, ...(JSON.parse(raw) as Record<string, unknown>) };
        else params = { ...params, ...Object.fromEntries(new URLSearchParams(raw)) };
      }
      const authorization = String(req.headers.authorization ?? '');
      const { app, kind } = appFor(authorization);
      calls.push({ app: app?.name ?? '?', method, params, contentType, authorization, httpMethod: req.method ?? '' });
      const answer = (body: Record<string, unknown>, status = 200, headers: Record<string, string> = {}): void => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(body));
      };
      const ok = (body: Record<string, unknown> = {}): void => answer({ ok: true, ...body });
      if (!app) return answer({ ok: false, error: 'invalid_auth' });
      const failure = failures.get(method);
      if (failure) {
        failures.delete(method);
        if (failure.status) return answer({ ok: false, error: 'ratelimited' }, failure.status, failure.retryAfter ? { 'Retry-After': String(failure.retryAfter) } : {});
        return answer({ ok: false, error: failure.error, ...(failure.needed ? { needed: failure.needed } : {}) }, 200, failure.retryAfter ? { 'Retry-After': String(failure.retryAfter) } : {});
      }
      if (method === 'apps.connections.open') {
        if (kind !== 'app') return answer({ ok: false, error: 'not_allowed_token_type' });
        const ticket = crypto.randomBytes(8).toString('hex');
        tickets.set(ticket, app.name);
        opened.push({ app: app.name, ticket });
        return ok({ url: `ws://127.0.0.1:${port}/link/?ticket=${ticket}` });
      }
      if (kind !== 'bot') return answer({ ok: false, error: 'not_allowed_token_type' });
      const member = (id: string): boolean => channels.find((c) => c.id === id)?.members.includes(app.name) ?? id.startsWith('D');
      switch (method) {
        case 'auth.test':
          return ok({ url: 'https://acme.slack.com/', team: 'Acme', team_id: 'TACME', user: `${app.name}-bot`, user_id: app.botUserId, bot_id: app.botId });
        case 'chat.postMessage': {
          const channel = String(params.channel ?? '');
          if (!member(channel)) return answer({ ok: false, error: 'not_in_channel' });
          const ts = nextTs();
          const thread = params.thread_ts ? String(params.thread_ts) : undefined;
          posts.push({ app: app.name, channel, ts, thread_ts: thread, text: String(params.text ?? ''), blocks: params.blocks, unfurl_links: params.unfurl_links, unfurl_media: params.unfurl_media });
          (history[channel] ??= []).push({ ts, bot_id: app.botId, text: String(params.text ?? ''), ...(thread ? { thread_ts: thread } : {}) });
          // As Slack does: the bot's own message in a direct message comes back to it as a message.im event.
          if (channel.startsWith('D') && sockets(app.name).length) {
            const event = { type: 'message', channel, channel_type: 'im', user: app.botUserId, bot_id: app.botId, bot_profile: { id: app.botId, name: app.name }, text: String(params.text ?? ''), ts, ...(thread ? { thread_ts: thread } : {}) };
            send(eventEnvelope(app, event), app.name);
          }
          return ok({ channel, ts });
        }
        case 'chat.update':
          updates.push({ app: app.name, channel: String(params.channel), ts: String(params.ts), text: String(params.text ?? ''), blocks: params.blocks });
          return ok({ channel: params.channel, ts: params.ts });
        case 'chat.postEphemeral':
          ephemerals.push({ app: app.name, channel: String(params.channel), ts: nextTs(), user: String(params.user), text: String(params.text ?? ''), thread_ts: params.thread_ts as string | undefined });
          return ok({ message_ts: nextTs() });
        case 'users.info': {
          const id = String(params.user ?? '');
          if (!users[id]) return answer({ ok: false, error: 'user_not_found' });
          return ok({ user: { id, name: users[id].toLowerCase(), profile: { display_name: users[id] } } });
        }
        case 'users.conversations':
          return ok({ channels: channels.filter((c) => c.members.includes(app.name)).map((c) => ({ id: c.id, name: c.name, is_private: Boolean(c.is_private) })), response_metadata: { next_cursor: '' } });
        case 'conversations.history': {
          const list = (history[String(params.channel)] ?? [])
            .filter((m) => !m.thread_ts || m.thread_ts === m.ts)
            .filter((m) => Number(m.ts) > Number(params.oldest ?? 0))
            .sort((a, b) => Number(b.ts) - Number(a.ts));
          return ok({ messages: list, has_more: false });
        }
        case 'conversations.replies': {
          const ts = String(params.ts);
          const list = (history[String(params.channel)] ?? []).filter((m) => (m.ts === ts || m.thread_ts === ts) && Number(m.ts) > Number(params.oldest ?? 0));
          return ok({ messages: list, has_more: false });
        }
        default:
          return answer({ ok: false, error: 'unknown_method' });
      }
    });
  });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const app = tickets.get(url.searchParams.get('ticket') ?? '');
    if (refuse.count > 0) {
      refuse.count--;
      acceptUpgrade(req, socket, head, { status: refuse.status, headers: refuse.retryAfter ? { 'Retry-After': String(refuse.retryAfter) } : {} });
      return;
    }
    if (url.pathname !== '/link/' || !app) {
      acceptUpgrade(req, socket, head, { status: 401 });
      return;
    }
    // A ticket opens one socket.
    tickets.delete(url.searchParams.get('ticket') ?? '');
    const s = acceptUpgrade(req, socket, head)!;
    live.push({ app, socket: s });
    appOf.set(s, app);
    s.onMessage((text) => {
      const parsed = JSON.parse(text) as { envelope_id: string; payload?: unknown };
      acks.push({ app, envelope_id: parsed.envelope_id, ...(parsed.payload !== undefined ? { payload: parsed.payload } : {}) });
    });
    if (!fake.holdHello) hello(s);
  });
  const hello = (s: ServerSocket): void => {
    const app = appOf.get(s) ?? '';
    s.send(JSON.stringify({ type: 'hello', num_connections: live.filter((l) => l.app === app && !l.socket.isClosed()).length, debug_info: { host: 'fake' } }));
  };
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}/api`;

  const sockets = (app = 'agent'): ServerSocket[] => live.filter((l) => l.app === app && !l.socket.isClosed()).map((l) => l.socket);
  const send = (envelope: SlackEnvelopeOut, app = 'agent', socket?: ServerSocket): void => {
    if (socket) return socket.send(JSON.stringify(envelope));
    const open = sockets(app);
    if (!open.length) throw new Error(`No socket of ${app} is open`);
    open[open.length - 1].send(JSON.stringify(envelope));
  };
  const envelopeId = (): string => crypto.randomUUID();
  const eventEnvelope = (app: FakeSlackApp, event: Record<string, unknown>): SlackEnvelopeOut => ({
    envelope_id: envelopeId(),
    type: 'events_api',
    accepts_response_payload: false,
    retry_attempt: 0,
    payload: {
      type: 'event_callback',
      team_id: 'TACME',
      event_id: `Ev${crypto.randomBytes(5).toString('hex').toUpperCase()}`,
      event_time: clock,
      authorizations: [{ user_id: app.botUserId, is_bot: true }],
      event,
    },
  });

  const fake: FakeSlack = {
    base,
    port,
    apps: byName,
    channels,
    users,
    calls,
    posts,
    updates,
    ephemerals,
    acks,
    opened,
    history,
    sockets,
    async waitForSocket(count, app = 'agent') {
      await until(() => live.filter((l) => l.app === app).length >= count, 3000, `socket ${count} of ${app}`);
      return live.filter((l) => l.app === app)[count - 1].socket;
    },
    say(channel, text, options = {}) {
      const app = byName[options.app ?? 'agent'];
      const user = options.user ?? 'U1MARIA';
      const ts = nextTs();
      const im = options.im ?? channel.startsWith('D');
      const shown = im && !options.mention ? text : `<@${app.botUserId}> ${text}`;
      (history[channel] ??= []).push({ ts, user, text: shown, ...(options.thread ? { thread_ts: options.thread } : {}) });
      if (options.thread) {
        const parent = history[channel].find((m) => m.ts === options.thread);
        if (parent) Object.assign(parent, { reply_count: (parent.reply_count ?? 0) + 1, latest_reply: ts, thread_ts: options.thread });
      }
      const event: Record<string, unknown> = im
        ? { type: 'message', channel, channel_type: 'im', user, text: shown, ts, ...(options.thread ? { thread_ts: options.thread } : {}) }
        : { type: 'app_mention', channel, user, text: shown, ts, ...(options.thread ? { thread_ts: options.thread } : {}) };
      const envelope = eventEnvelope(app, event);
      // With no socket open the message is only in the channel, as when the bot is not connected.
      if (sockets(app.name).length) send(envelope, app.name);
      return { ts, envelope };
    },
    click(channel, messageTs, options) {
      const envelope: SlackEnvelopeOut = {
        envelope_id: envelopeId(),
        type: 'interactive',
        accepts_response_payload: false,
        payload: {
          type: 'block_actions',
          user: { id: options.user },
          channel: { id: channel },
          container: { type: 'message', channel_id: channel, message_ts: messageTs, ...(options.thread ? { thread_ts: options.thread } : {}) },
          message: { ts: messageTs, ...(options.thread ? { thread_ts: options.thread } : {}) },
          actions: [{ action_id: options.actionId ?? 'approve', block_id: 'card', type: 'button', value: options.value, action_ts: `${clock}.5` }],
        },
      };
      send(envelope, options.app ?? 'agent');
      return envelope;
    },
    send,
    holdHello: false,
    hello,
    disconnect(reason, app = 'agent') {
      for (const s of sockets(app)) s.send(JSON.stringify({ type: 'disconnect', reason, debug_info: { host: 'fake' } }));
    },
    failNext(method, failure) {
      failures.set(method, failure);
    },
    refuseSockets(count, status = 503, retryAfter = 0) {
      refuse = { count, status, retryAfter };
    },
    async transport(r) {
      const url = r.url.replace(/^https:\/\/slack\.com\/api/, base);
      const target = await guardUrl(url, { server: false, allowPrivate: true });
      const got = await request(target, { method: r.method, headers: r.headers, body: r.body });
      return { status: got.status, body: got.body, headers: got.headers as Record<string, string | string[] | undefined> };
    },
    async close() {
      for (const l of live) l.socket.drop();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
  return fake;
}
