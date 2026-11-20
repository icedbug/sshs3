import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { acceptUpgrade, until, type ServerSocket } from './wsServer';

/**
 * A Mattermost on 127.0.0.1 for tests: the REST calls the two bots make under /api/v4, and the
 * WebSocket at /api/v4/websocket with posted and reaction_added events. It can hold several bot
 * accounts at once and records every call with the bot that made it.
 *
 * Like the real server it keeps each connection's events after its socket drops. A socket that comes
 * back with the connection's id and a sequence number still held is given the missed events with
 * their own numbers and no hello; otherwise it gets hello with a new connection id, counting from 0.
 */

export interface FakeMattermostBot {
  name: string;
  token: string;
  userId: string;
  username: string;
}

export interface FakeMmPost {
  id: string;
  channel_id: string;
  user_id: string;
  root_id: string;
  message: string;
  create_at: number;
  type: string;
  props: Record<string, unknown>;
}

export interface FakeMmCall {
  bot: string;
  method: string;
  path: string;
  body: unknown;
  authorization: string;
  contentType: string;
}

export interface FakeMmSocket {
  bot: string;
  socket: ServerSocket;
  connectionId: string;
  authed: boolean;
  /** The connection was taken back: no hello was sent. */
  resumed: boolean;
}

/** One connection as the server keeps it: every event sent on it, by its sequence number. */
interface FakeMmConnection {
  id: string;
  bot: string;
  seq: number;
  sent: string[];
}

/** An id as Mattermost makes them: 26 lowercase letters and digits. */
export const mmId = (): string => {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 26; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
};

const fixed = (word: string): string => word.padEnd(26, '0').slice(0, 26);

export interface FakeMattermost {
  base: string;
  port: number;
  bots: Record<string, FakeMattermostBot>;
  users: Record<string, string>;
  teamId: string;
  channels: { id: string; name: string; type: 'O' | 'P' | 'D'; members: string[] }[];
  posts: Record<string, FakeMmPost>;
  calls: FakeMmCall[];
  created: (FakeMmPost & { bot: string })[];
  patches: { bot: string; id: string; body: unknown }[];
  reactions: { bot: string; body: unknown }[];
  upgrades: { authorization: string; query: Record<string, string> }[];
  /** The open sockets of a bot, newest last. */
  sockets(bot?: string): FakeMmSocket[];
  waitForSocket(count: number, bot?: string): Promise<FakeMmSocket>;
  /** Somebody posts; the bots' sockets are told. */
  post(channelId: string, text: string, options?: { user?: string; root?: string; type?: string; props?: Record<string, unknown> }): FakeMmPost;
  react(user: string, postId: string, emoji: string): void;
  /** The direct message channel between a person and a bot. */
  dm(user: string, bot?: string): string;
  /** Ends every socket without a close frame. */
  drop(): void;
  /** Forgets every connection, as after a restart: the next socket gets hello with a new id. */
  forgetConnections(): void;
  /** Counts the next event of each of the bot's connections without sending it, as if it were lost. */
  loseNext(bot?: string): void;
  /** Refuses the next socket upgrades with this status. */
  refuseSockets(count: number, status?: number, retryAfter?: number): void;
  /** Whether the server takes the token in the upgrade header, or only as a challenge. */
  headerAuth: boolean;
  close(): Promise<void>;
}

export const CHANNEL_OPS = fixed('chopsxxxxxxxx');
export const CHANNEL_QUIET = fixed('chquietxxxxxx');
export const USER_MARIA = fixed('umariaxxxxxxx');
export const USER_OMAR = fixed('uomarxxxxxxxx');

const DEFAULT_BOTS: FakeMattermostBot[] = [
  { name: 'agent', token: 'mm-agent-token-0001', userId: fixed('uagentbotxxxx'), username: 'agentbot' },
  { name: 'context', token: 'mm-context-token-0002', userId: fixed('ucontextbotxx'), username: 'contextbot' },
];

export async function startFakeMattermost(bots: FakeMattermostBot[] = DEFAULT_BOTS): Promise<FakeMattermost> {
  const byName = Object.fromEntries(bots.map((b) => [b.name, b]));
  const users: Record<string, string> = { [USER_MARIA]: 'maria', [USER_OMAR]: 'omar' };
  for (const b of bots) users[b.userId] = b.username;
  const teamId = fixed('teamacmexxxxx');
  const names = bots.map((b) => b.name);
  const channels: FakeMattermost['channels'] = [
    { id: CHANNEL_OPS, name: 'ops', type: 'O', members: names },
    { id: CHANNEL_QUIET, name: 'quiet', type: 'O', members: ['context'] },
  ];
  const posts: Record<string, FakeMmPost> = {};
  const calls: FakeMmCall[] = [];
  const created: FakeMattermost['created'] = [];
  const patches: FakeMattermost['patches'] = [];
  const reactions: FakeMattermost['reactions'] = [];
  const upgrades: FakeMattermost['upgrades'] = [];
  const live: FakeMmSocket[] = [];
  const connections = new Map<string, FakeMmConnection>();
  const losing = new Set<string>();
  let refuse = { count: 0, status: 503, retryAfter: 0 };
  let clock = Date.parse('2026-11-20T12:00:00Z');

  const botFor = (auth: string): FakeMattermostBot | undefined => bots.find((b) => `Bearer ${b.token}` === auth);
  /** Numbers the event on the connection, keeps it, and sends it to the connection's open socket. */
  const emit = (c: FakeMmConnection, event: string, data: Record<string, unknown>, broadcast: Record<string, unknown> = {}): void => {
    const text = JSON.stringify({ event, data, broadcast, seq: c.seq });
    c.sent[c.seq++] = text;
    if (losing.delete(c.bot)) return;
    for (const s of live) if (s.connectionId === c.id && s.authed && !s.socket.isClosed()) s.socket.send(text);
  };
  const fresh = (s: FakeMmSocket): void => {
    const c: FakeMmConnection = { id: mmId(), bot: s.bot, seq: 0, sent: [] };
    connections.set(c.id, c);
    s.connectionId = c.id;
    emit(c, 'hello', { server_version: '10.0.0', connection_id: c.id }, { user_id: byName[s.bot].userId });
  };
  /** A signed in socket: the old connection taken back when it can be, a new one otherwise. */
  const attach = (s: FakeMmSocket, query: URLSearchParams): void => {
    const old = connections.get(query.get('connection_id') ?? '');
    const from = Number(query.get('sequence_number'));
    if (old && old.bot === s.bot && Number.isInteger(from) && from >= 0 && from <= old.seq) {
      s.connectionId = old.id;
      s.resumed = true;
      for (let n = from; n < old.seq; n++) s.socket.send(old.sent[n]);
      return;
    }
    if (old) connections.delete(old.id);
    fresh(s);
  };
  const open = (bot?: string): FakeMmSocket[] => live.filter((s) => !s.socket.isClosed() && s.authed && (!bot || s.bot === bot));
  /** A post goes to every connection of a bot in the channel, the poster's own included, kept for one that is down. */
  const announce = (channel: FakeMattermost['channels'][number], post: FakeMmPost): void => {
    for (const c of connections.values()) {
      const bot = byName[c.bot];
      if (!channel.members.includes(c.bot)) continue;
      const mentions = new RegExp(`(^|\\s)@${bot.username}\\b`, 'i').test(post.message) ? [bot.userId] : channel.type === 'D' ? [bot.userId] : [];
      emit(
        c,
        'posted',
        {
          channel_display_name: channel.name,
          channel_name: channel.name,
          channel_type: channel.type,
          post: JSON.stringify(post),
          sender_name: `@${users[post.user_id] ?? 'somebody'}`,
          team_id: teamId,
          ...(mentions.length ? { mentions: JSON.stringify(mentions) } : {}),
        },
        { channel_id: channel.id },
      );
    }
  };

  const fake: FakeMattermost = {
    base: '',
    port: 0,
    bots: byName,
    users,
    teamId,
    channels,
    posts,
    calls,
    created,
    patches,
    reactions,
    upgrades,
    headerAuth: true,
    sockets: (bot = 'agent') => open(bot),
    async waitForSocket(count, bot = 'agent') {
      await until(() => live.filter((s) => s.bot === bot && s.authed).length >= count, 3000, `socket ${count} of ${bot}`);
      return live.filter((s) => s.bot === bot && s.authed)[count - 1];
    },
    post(channelId, text, options = {}) {
      const channel = channels.find((c) => c.id === channelId);
      if (!channel) throw new Error(`No channel ${channelId}`);
      const post: FakeMmPost = {
        id: mmId(),
        channel_id: channelId,
        user_id: options.user ?? USER_MARIA,
        root_id: options.root ?? '',
        message: text,
        create_at: ++clock,
        type: options.type ?? '',
        props: options.props ?? {},
      };
      posts[post.id] = post;
      announce(channel, post);
      return post;
    },
    react(user, postId, emoji) {
      const post = posts[postId];
      const reaction = { user_id: user, post_id: postId, emoji_name: emoji, create_at: ++clock, channel_id: post?.channel_id };
      for (const c of connections.values()) emit(c, 'reaction_added', { reaction: JSON.stringify(reaction) }, { channel_id: post?.channel_id });
    },
    drop() {
      for (const s of live) s.socket.drop();
    },
    forgetConnections() {
      connections.clear();
    },
    loseNext(bot = 'agent') {
      losing.add(bot);
    },
    refuseSockets(count, status = 503, retryAfter = 0) {
      refuse = { count, status, retryAfter };
    },
    dm(user, bot = 'agent') {
      const b = byName[bot];
      const id = `${b.userId.slice(0, 13)}${user.slice(0, 13)}`;
      if (!channels.some((c) => c.id === id)) channels.push({ id, name: `${b.username}__${users[user] ?? user}`, type: 'D', members: [bot] });
      return id;
    },
    async close() {
      for (const s of live) s.socket.drop();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const path = url.pathname.replace(/^\/api\/v4/, '');
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      const authorization = String(req.headers.authorization ?? '');
      const bot = botFor(authorization);
      calls.push({ bot: bot?.name ?? '?', method: req.method ?? '', path: `${path}${url.search}`, body, authorization, contentType: String(req.headers['content-type'] ?? '') });
      const answer = (value: unknown, status = 200): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
      };
      if (!bot) return answer({ id: 'api.context.session_expired.app_error', message: 'Invalid or expired session, please login again.', status_code: 401 }, 401);
      const m = req.method;
      let match: RegExpExecArray | null;
      if (m === 'GET' && path === '/users/me') return answer({ id: bot.userId, username: bot.username, nickname: '', is_bot: true });
      if (m === 'GET' && path === '/users/me/teams') return answer([{ id: teamId, name: 'acme', display_name: 'Acme' }]);
      if (m === 'GET' && (match = /^\/users\/me\/teams\/([a-z0-9]+)\/channels$/.exec(path)))
        return answer(channels.filter((c) => c.members.includes(bot.name) && c.type !== 'D').map((c) => ({ id: c.id, name: c.name, display_name: c.name, type: c.type, team_id: match![1] })));
      if (m === 'POST' && path === '/users/ids')
        return answer((Array.isArray(body) ? (body as string[]) : []).filter((id) => users[id]).map((id) => ({ id, username: users[id] })));
      if (m === 'POST' && path === '/posts') {
        const b = body as { channel_id: string; root_id?: string; message: string; props?: Record<string, unknown> };
        const channel = channels.find((c) => c.id === b.channel_id);
        if (!channel?.members.includes(bot.name)) return answer({ message: 'You do not have the appropriate permissions.' }, 403);
        const post: FakeMmPost = { id: mmId(), channel_id: b.channel_id, user_id: bot.userId, root_id: b.root_id ?? '', message: b.message, create_at: ++clock, type: '', props: { ...(b.props ?? {}), from_bot: 'true' } };
        posts[post.id] = post;
        created.push({ ...post, bot: bot.name });
        // As Mattermost does: the new post goes to every member's socket, the poster's own too.
        announce(channel, post);
        return answer(post, 201);
      }
      if (m === 'PUT' && (match = /^\/posts\/([a-z0-9]+)\/patch$/.exec(path))) {
        const post = posts[match[1]];
        if (!post) return answer({ message: 'Unable to find the existing post or comment to update.' }, 404);
        patches.push({ bot: bot.name, id: match[1], body });
        const b = body as { message?: string; props?: Record<string, unknown> };
        if (b.message !== undefined) post.message = b.message;
        if (b.props) post.props = { ...post.props, ...b.props };
        return answer(post);
      }
      if (m === 'POST' && path === '/reactions') {
        reactions.push({ bot: bot.name, body });
        return answer({ ...(body as object), create_at: ++clock }, 201);
      }
      if (m === 'POST' && path === '/channels/direct') {
        const ids = (Array.isArray(body) ? body : []) as string[];
        const other = ids.find((id) => id !== bot.userId) ?? bot.userId;
        const id = `${bot.userId.slice(0, 13)}${other.slice(0, 13)}`;
        if (!channels.some((c) => c.id === id)) channels.push({ id, name: `${bot.username}__${users[other] ?? other}`, type: 'D', members: [bot.name] });
        return answer({ id, type: 'D' }, 201);
      }
      if (m === 'GET' && (match = /^\/posts\/([a-z0-9]+)\/thread$/.exec(path))) {
        const root = posts[match[1]];
        if (!root) return answer({ message: 'not found' }, 404);
        const rootId = root.root_id || root.id;
        const list = Object.values(posts).filter((p) => p.id === rootId || p.root_id === rootId);
        return answer({ order: list.map((p) => p.id), posts: Object.fromEntries(list.map((p) => [p.id, p])) });
      }
      if (m === 'GET' && (match = /^\/channels\/([a-z0-9]+)\/posts$/.exec(path))) {
        const list = Object.values(posts)
          .filter((p) => p.channel_id === match![1])
          .sort((a, b) => b.create_at - a.create_at);
        return answer({ order: list.map((p) => p.id), posts: Object.fromEntries(list.map((p) => [p.id, p])) });
      }
      return answer({ message: 'not found' }, 404);
    });
  });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const authorization = String(req.headers.authorization ?? '');
    upgrades.push({ authorization, query: Object.fromEntries(url.searchParams) });
    if (refuse.count > 0) {
      refuse.count--;
      acceptUpgrade(req, socket, head, { status: refuse.status, headers: refuse.retryAfter ? { 'Retry-After': String(refuse.retryAfter) } : {} });
      return;
    }
    if (url.pathname !== '/api/v4/websocket') {
      acceptUpgrade(req, socket, head, { status: 404 });
      return;
    }
    const s = acceptUpgrade(req, socket, head)!;
    const byHeader = fake.headerAuth ? botFor(authorization) : undefined;
    const entry: FakeMmSocket = { bot: byHeader?.name ?? '', socket: s, connectionId: '', authed: Boolean(byHeader), resumed: false };
    live.push(entry);
    if (byHeader) attach(entry, url.searchParams);
    const notSignedIn = (seq: number): void =>
      s.send(JSON.stringify({ status: 'FAIL', seq_reply: seq, error: { id: 'api.web_socket_router.not_authenticated.app_error', message: 'not authenticated' } }));
    s.onMessage((text) => {
      const msg = JSON.parse(text) as { seq: number; action: string; data?: { token?: string } };
      if (msg.action !== 'authentication_challenge') {
        // As the real router: a socket not signed in is refused anything else, a signed in one answered.
        if (!entry.authed) return notSignedIn(msg.seq);
        s.send(JSON.stringify({ status: 'OK', seq_reply: msg.seq, data: {} }));
        return;
      }
      // A signed in socket is not answered: the real server ignores a second challenge.
      if (entry.authed) return;
      const bot = bots.find((b) => b.token === msg.data?.token);
      if (!bot) return notSignedIn(msg.seq);
      Object.assign(entry, { bot: bot.name, authed: true });
      s.send(JSON.stringify({ status: 'OK', seq_reply: msg.seq }));
      fresh(entry);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  fake.port = port;
  fake.base = `http://127.0.0.1:${port}`;
  return fake;
}
