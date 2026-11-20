import type { AgentBotIdentity } from '../../../shared/types/aiHub';
import { ChatError, retryAfter, type ChatChannel } from '../../ai/hub/ChatSources';
import { guardUrl, request, type GuardOptions } from '../../ai/hub/Notifier';

/**
 * The agent bot's own client for Slack and Mattermost: the calls that post, edit and react, and the
 * few it needs to know who it is and who wrote to it.
 *
 * It is apart from the context bot's client (ChatSources) on purpose: that one only reads, and its
 * token can only read. This one holds the agent bot's own tokens and borrows only the pure helpers.
 * Every call goes through guardUrl and the pinned request, like every other address sshs3 calls, and
 * no token is ever put in an error: a service that echoes one back gets it blanked out.
 */

export interface AgentRequest {
  method: 'GET' | 'POST' | 'PUT';
  url: string;
  headers: Record<string, string>;
  body?: string;
}
export type AgentTransport = (
  request: AgentRequest,
) => Promise<{ status: number; body: string; headers?: Record<string, string | string[] | undefined> }>;

export interface AgentSlackAuth {
  /** xoxb-: everything but opening the socket. */
  botToken: string;
  /** xapp-: opens the socket. */
  appToken?: string;
}

export interface AgentMattermostAuth {
  baseUrl: string;
  token: string;
}

/** A Slack Block Kit block, passed through as given. */
export type SlackBlock = Record<string, unknown>;

/** A Mattermost message attachment, which is where its buttons go. */
export type MattermostAttachment = Record<string, unknown>;

export interface ChatPerson {
  id: string;
  name: string;
  isBot: boolean;
  /** Gone from the workspace or server. */
  deleted: boolean;
}

export const SLACK_API = 'https://slack.com/api';

/** What Slack's error codes mean to the administrator who set the agent bot up. */
const SLACK_SAYS: Record<string, string> = {
  invalid_auth: "Slack refused the agent bot's token. Check the bot token, which starts with xoxb-.",
  not_authed: "Slack refused the agent bot's token. Check the bot token, which starts with xoxb-.",
  account_inactive: "The agent bot's Slack app was removed, or its token was revoked.",
  token_revoked: "The agent bot's Slack app was removed, or its token was revoked.",
  token_expired: "The agent bot's token has expired. Save a new one.",
  not_allowed_token_type: 'That token cannot do this. The socket needs the app-level token (xapp-), and everything else the bot token (xoxb-).',
  msg_too_long: 'The message was too long for Slack.',
  invalid_blocks: "Slack did not take the message's layout.",
  invalid_blocks_format: "Slack did not take the message's layout.",
  not_in_channel: 'The agent bot is not in that channel. Invite it there first.',
  channel_not_found: 'The channel is gone, or the agent bot cannot see it.',
  is_archived: 'The channel is archived.',
  message_not_found: 'The message to change is gone.',
  cant_update_message: 'The agent bot may only change messages it posted itself.',
  edit_window_closed: 'The message is too old to be changed.',
  user_not_found: 'Slack does not know that person.',
  user_not_in_channel: 'That person is not in the channel.',
  restricted_action: 'A workspace setting stops the agent bot from posting there.',
};

/**
 * Ids as the services write them: anything else is not put in an address. The sockets check what
 * they are sent against these too, before an id is kept, acknowledged or handed on.
 */
export const SLACK_ID = /^[A-Z0-9]{2,32}$/;
export const SLACK_TS = /^\d{6,12}\.\d{1,8}$/;
/** Slack's envelope and event ids. */
export const SLACK_EVENT_ID = /^[A-Za-z0-9._-]{1,128}$/;
export const MM_ID = /^[a-z0-9]{26}$/;
export const MM_EMOJI = /^[a-z0-9_+-]{1,64}$/;

function slackId(id: string, what = 'Slack id'): string {
  if (!SLACK_ID.test(id)) throw new ChatError(`That is not a ${what}.`, 400);
  return id;
}
function slackTs(ts: string): string {
  if (!SLACK_TS.test(ts)) throw new ChatError('That is not a Slack message time.', 400);
  return ts;
}
function mmId(id: string): string {
  if (!MM_ID.test(id)) throw new ChatError('That is not a Mattermost id.', 400);
  return id;
}

/** Puts a blank where a token would be: a service may echo what it was sent, and an error may be shown or kept. */
function scrub(text: string, secrets: (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join('[token]');
  return out.replace(/\b(?:xox[a-z]|xapp)-[A-Za-z0-9-]{6,}/g, '[token]');
}

function rethrowScrubbed(error: unknown, secrets: (string | undefined)[]): never {
  if (error instanceof ChatError) throw new ChatError(scrub(error.message, secrets), error.status, error.retryAfterMs);
  throw new ChatError(scrub(error instanceof Error ? error.message : String(error), secrets), 0);
}

const form = (params: Record<string, string | number | boolean | undefined>): string =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');

export class AgentBotApi {
  /** Replaced in tests: how a call reaches the service. */
  transport?: AgentTransport;
  /** Replaced in tests: where Slack's Web API is. */
  slackBase = SLACK_API;

  constructor(private readonly deps: { guard(): GuardOptions }) {}

  private readonly send: AgentTransport = async (r) => {
    if (this.transport) return this.transport(r);
    const target = await guardUrl(r.url, this.deps.guard());
    const answer = await request(target, { method: r.method, headers: r.headers, body: r.body }, 2 * 1024 * 1024, 20_000);
    return { status: answer.status, body: answer.body, headers: answer.headers as Record<string, string | string[] | undefined> };
  };

  // -------------------------------------------------------------------------------------------------
  // Slack
  // -------------------------------------------------------------------------------------------------

  /**
   * One Web API call. Calls that write take JSON; calls that only read take a form, which is what
   * Slack documents for them (it ignores a JSON body there).
   */
  private async slack<T extends { ok?: boolean; error?: string; needed?: string }>(
    token: string,
    method: string,
    params: Record<string, unknown>,
    as: 'json' | 'form',
  ): Promise<T> {
    let answer: Awaited<ReturnType<AgentTransport>>;
    try {
      answer = await this.send({
        method: 'POST',
        url: `${this.slackBase}/${method}`,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'Content-Type': as === 'json' ? 'application/json; charset=utf-8' : 'application/x-www-form-urlencoded',
        },
        body: as === 'json' ? JSON.stringify(params) : form(params as Record<string, string | number | boolean | undefined>),
      });
    } catch (error) {
      rethrowScrubbed(error, [token]);
    }
    if (answer.status === 429) {
      const wait = retryAfter(answer.headers) ?? 30_000;
      throw new ChatError(`Slack asked for a pause of ${Math.ceil(wait / 1000)} seconds.`, 429, wait);
    }
    if (answer.status < 200 || answer.status >= 300) throw new ChatError(`Slack answered ${answer.status}.`, answer.status);
    let parsed: T;
    try {
      parsed = JSON.parse(answer.body) as T;
    } catch {
      throw new ChatError('The answer was not what Slack sends.', answer.status);
    }
    if (!parsed.ok) {
      const code = String(parsed.error ?? 'unknown').slice(0, 80);
      if (code === 'ratelimited') {
        const wait = retryAfter(answer.headers) ?? 30_000;
        throw new ChatError(`Slack asked for a pause of ${Math.ceil(wait / 1000)} seconds.`, 429, wait);
      }
      if (code === 'missing_scope') {
        const needed = String(parsed.needed ?? '').replace(/[^a-z:._,-]/g, '').slice(0, 120);
        throw new ChatError(
          needed
            ? `The agent bot's Slack app lacks the permission ${needed}. Add it, then install the app again.`
            : "The agent bot's Slack app lacks a permission it needs. Add it, then install the app again.",
          403,
        );
      }
      const status = code === 'invalid_auth' || code === 'not_authed' || code === 'account_inactive' || code === 'token_revoked' || code === 'token_expired' ? 401 : 400;
      throw new ChatError(scrub(SLACK_SAYS[code] ?? `Slack said: ${code}`, [token]), status);
    }
    return parsed;
  }

  /** Who the bot is: its user id, which its own messages and mentions of it carry, and its bot id. */
  async slackAuthTest(auth: AgentSlackAuth): Promise<AgentBotIdentity> {
    const me = await this.slack<{ ok: boolean; user_id?: string; bot_id?: string; user?: string; team?: string; team_id?: string }>(
      auth.botToken,
      'auth.test',
      {},
      'form',
    );
    if (!me.user_id) throw new ChatError('Slack did not say who the agent bot is.', 400);
    return {
      userId: me.user_id,
      ...(me.bot_id ? { botId: me.bot_id } : {}),
      ...(me.user ? { name: me.user } : {}),
      ...(me.team ? { team: me.team } : {}),
      ...(me.team_id ? { teamId: me.team_id } : {}),
    };
  }

  /**
   * Posts a message, in a thread when `threadTs` is given. Links are not unfurled: a preview could
   * show what a link leads to in a channel where not everybody may see it.
   */
  async slackPost(
    auth: AgentSlackAuth,
    message: { channel: string; threadTs?: string; text: string; blocks?: SlackBlock[] },
  ): Promise<{ channel: string; ts: string }> {
    const got = await this.slack<{ ok: boolean; channel?: string; ts?: string }>(
      auth.botToken,
      'chat.postMessage',
      {
        channel: slackId(message.channel, 'Slack channel'),
        ...(message.threadTs ? { thread_ts: slackTs(message.threadTs) } : {}),
        text: message.text,
        ...(message.blocks ? { blocks: message.blocks } : {}),
        unfurl_links: false,
        unfurl_media: false,
        link_names: false,
      },
      'json',
    );
    if (!got.ts) throw new ChatError('Slack did not say where the message went.', 400);
    return { channel: got.channel ?? message.channel, ts: got.ts };
  }

  /** Changes a message the bot posted. */
  async slackUpdate(auth: AgentSlackAuth, message: { channel: string; ts: string; text: string; blocks?: SlackBlock[] }): Promise<void> {
    await this.slack(
      auth.botToken,
      'chat.update',
      {
        channel: slackId(message.channel, 'Slack channel'),
        ts: slackTs(message.ts),
        text: message.text,
        // An empty list takes old buttons away; leaving the field out would keep them.
        blocks: message.blocks ?? [],
        link_names: false,
      },
      'json',
    );
  }

  /** A message only one person in the channel sees, such as why their button did nothing. */
  async slackEphemeral(
    auth: AgentSlackAuth,
    message: { channel: string; user: string; text: string; threadTs?: string; blocks?: SlackBlock[] },
  ): Promise<void> {
    await this.slack(
      auth.botToken,
      'chat.postEphemeral',
      {
        channel: slackId(message.channel, 'Slack channel'),
        user: slackId(message.user, 'Slack user'),
        text: message.text,
        ...(message.threadTs ? { thread_ts: slackTs(message.threadTs) } : {}),
        ...(message.blocks ? { blocks: message.blocks } : {}),
        link_names: false,
      },
      'json',
    );
  }

  async slackUser(auth: AgentSlackAuth, userId: string): Promise<ChatPerson> {
    const got = await this.slack<{
      ok: boolean;
      user?: { id?: string; name?: string; real_name?: string; deleted?: boolean; is_bot?: boolean; profile?: { display_name?: string; real_name?: string } };
    }>(auth.botToken, 'users.info', { user: slackId(userId, 'Slack user') }, 'form');
    const u = got.user ?? {};
    return {
      id: u.id ?? userId,
      name: u.profile?.display_name || u.profile?.real_name || u.real_name || u.name || userId,
      isBot: Boolean(u.is_bot),
      deleted: Boolean(u.deleted),
    };
  }

  /** The channels the agent bot is in: the ones an administrator can let it answer in. */
  async slackChannels(auth: AgentSlackAuth): Promise<ChatChannel[]> {
    const out: ChatChannel[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const got = await this.slack<{
        ok: boolean;
        channels?: { id?: string; name?: string; is_private?: boolean; is_im?: boolean; is_mpim?: boolean; is_archived?: boolean }[];
        response_metadata?: { next_cursor?: string };
      }>(auth.botToken, 'users.conversations', { types: 'public_channel,private_channel', exclude_archived: true, limit: 200, cursor }, 'form');
      for (const c of got.channels ?? [])
        if (c.id && c.name && !c.is_im && !c.is_mpim && !c.is_archived) out.push({ id: c.id, name: c.name, private: Boolean(c.is_private) });
      cursor = got.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The address of a new Socket Mode socket. Asked with the app-level token, and good for one connection. */
  async slackOpenSocket(auth: AgentSlackAuth): Promise<string> {
    if (!auth.appToken) throw new ChatError('The app-level token is needed to open the socket. It starts with xapp-.', 401);
    let got: { ok: boolean; url?: string };
    try {
      got = await this.slack<{ ok: boolean; url?: string }>(auth.appToken, 'apps.connections.open', {}, 'form');
    } catch (error) {
      if (error instanceof ChatError && error.status === 401)
        throw new ChatError('Slack refused the app-level token. Check it starts with xapp- and has the connections:write scope, and that Socket Mode is on.', 401);
      throw error;
    }
    if (!got.url) throw new ChatError('Slack did not give an address for the socket.', 400);
    return got.url;
  }

  // -------------------------------------------------------------------------------------------------
  // Mattermost
  // -------------------------------------------------------------------------------------------------

  private async mattermost<T>(auth: AgentMattermostAuth, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
    const base = `${auth.baseUrl.trim().replace(/\/+$/, '')}/api/v4`;
    let answer: Awaited<ReturnType<AgentTransport>>;
    try {
      answer = await this.send({
        method,
        url: `${base}${path}`,
        headers: {
          Authorization: `Bearer ${auth.token}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      rethrowScrubbed(error, [auth.token]);
    }
    if (answer.status === 429) {
      const wait = retryAfter(answer.headers) ?? 30_000;
      throw new ChatError(`Mattermost asked for a pause of ${Math.ceil(wait / 1000)} seconds.`, 429, wait);
    }
    if (answer.status === 401) throw new ChatError("Mattermost refused the agent bot's token. Check it is the bot account's access token.", 401);
    if (answer.status === 403) throw new ChatError('The agent bot may not do that. Add it to the team or channel, or give it the permission.', 403);
    if (answer.status === 404) throw new ChatError('Not found. The channel or post is gone, or this is not a Mattermost server.', 404);
    if (answer.status === 413) throw new ChatError('The message was too long for Mattermost.', 413);
    if (answer.status < 200 || answer.status >= 300) {
      let said = '';
      try {
        said = String((JSON.parse(answer.body) as { message?: unknown }).message ?? '');
      } catch {
        // Not JSON: the status says enough.
      }
      const text = said ? `Mattermost said: ${said.replace(/\s+/g, ' ').slice(0, 160)}` : `Mattermost answered ${answer.status}.`;
      throw new ChatError(scrub(text, [auth.token]), answer.status);
    }
    try {
      return JSON.parse(answer.body) as T;
    } catch {
      throw new ChatError('The answer was not what Mattermost sends. Is this the right address?', answer.status);
    }
  }

  /** Who the bot account is. */
  async mmMe(auth: AgentMattermostAuth): Promise<AgentBotIdentity & { username: string }> {
    const me = await this.mattermost<{ id?: string; username?: string; nickname?: string; is_bot?: boolean }>(auth, 'GET', '/users/me');
    if (!me.id) throw new ChatError('Mattermost did not say who the agent bot is.', 400);
    return { userId: me.id, username: me.username ?? '', name: me.nickname || me.username || 'the agent bot', team: hostOf(auth.baseUrl) };
  }

  /** Posts a message, in a thread when `rootId` is given. Buttons go in attachments. */
  async mmPost(
    auth: AgentMattermostAuth,
    post: { channelId: string; rootId?: string; message: string; attachments?: MattermostAttachment[] },
  ): Promise<{ id: string }> {
    const got = await this.mattermost<{ id?: string }>(auth, 'POST', '/posts', {
      channel_id: mmId(post.channelId),
      ...(post.rootId ? { root_id: mmId(post.rootId) } : {}),
      message: post.message,
      ...(post.attachments ? { props: { attachments: post.attachments } } : {}),
    });
    if (!got.id) throw new ChatError('Mattermost did not say where the message went.', 400);
    return { id: got.id };
  }

  /** Changes a post the bot made. Attachments given replace the old ones, and an empty list takes buttons away. */
  async mmPatch(auth: AgentMattermostAuth, postId: string, patch: { message?: string; attachments?: MattermostAttachment[] }): Promise<void> {
    await this.mattermost(auth, 'PUT', `/posts/${mmId(postId)}/patch`, {
      ...(patch.message !== undefined ? { message: patch.message } : {}),
      ...(patch.attachments !== undefined ? { props: { attachments: patch.attachments } } : {}),
    });
  }

  /** Reacts to a post as the bot, such as to show a question was seen. */
  async mmReact(auth: AgentMattermostAuth, reaction: { userId: string; postId: string; emoji: string }): Promise<void> {
    if (!MM_EMOJI.test(reaction.emoji)) throw new ChatError('That is not an emoji name.', 400);
    await this.mattermost(auth, 'POST', '/reactions', {
      user_id: mmId(reaction.userId),
      post_id: mmId(reaction.postId),
      emoji_name: reaction.emoji,
    });
  }

  async mmUsers(auth: AgentMattermostAuth, ids: string[]): Promise<ChatPerson[]> {
    const wanted = [...new Set(ids)].filter((id) => MM_ID.test(id)).slice(0, 200);
    if (!wanted.length) return [];
    const users = await this.mattermost<{ id?: string; username?: string; nickname?: string; first_name?: string; last_name?: string; is_bot?: boolean; delete_at?: number }[]>(
      auth,
      'POST',
      '/users/ids',
      wanted,
    );
    return (Array.isArray(users) ? users : [])
      .filter((u) => u.id)
      .map((u) => ({
        id: u.id!,
        name: u.nickname || [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || u.id!,
        isBot: Boolean(u.is_bot),
        deleted: Boolean(u.delete_at),
      }));
  }

  /** The teams the bot is in: channels are listed per team. */
  async mmTeams(auth: AgentMattermostAuth): Promise<{ id: string; name: string }[]> {
    const teams = await this.mattermost<{ id?: string; name?: string; display_name?: string }[]>(auth, 'GET', '/users/me/teams');
    return (Array.isArray(teams) ? teams : []).filter((t) => t.id && MM_ID.test(t.id)).map((t) => ({ id: t.id!, name: t.display_name || t.name || t.id! }));
  }

  /** The open and private channels the bot is in, in one team. Direct and group messages are left out. */
  async mmChannels(auth: AgentMattermostAuth, teamId: string): Promise<ChatChannel[]> {
    const channels = await this.mattermost<{ id?: string; name?: string; display_name?: string; type?: string; delete_at?: number }[]>(
      auth,
      'GET',
      `/users/me/teams/${mmId(teamId)}/channels`,
    );
    return (Array.isArray(channels) ? channels : [])
      .filter((c) => c.id && (c.type === 'O' || c.type === 'P') && !c.delete_at)
      .map((c) => ({ id: c.id!, name: c.display_name || c.name || c.id!, private: c.type === 'P', team: teamId }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The direct message channel between the bot and a person, made when there is none yet. */
  async mmDirect(auth: AgentMattermostAuth, botUserId: string, userId: string): Promise<string> {
    const got = await this.mattermost<{ id?: string }>(auth, 'POST', '/channels/direct', [mmId(botUserId), mmId(userId)]);
    if (!got.id) throw new ChatError('Mattermost did not give the direct message channel.', 400);
    return got.id;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'Mattermost';
  }
}
