import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatError } from '../../src/main/ai/hub/ChatSources';
import { AgentBotApi, type AgentRequest } from '../../src/main/web/chatAgent/AgentBotApi';
import { startFakeSlack, type FakeSlack } from '../helpers/fakeSlack';
import { CHANNEL_OPS, USER_MARIA, startFakeMattermost, type FakeMattermost } from '../helpers/fakeMattermost';

/**
 * The agent bot's own client: each call as Slack and Mattermost expect it, every failure as a plain
 * sentence, and never a token in an error or a log line.
 */

const LOCAL = { server: false, allowPrivate: true };
let slack: FakeSlack;
let mm: FakeMattermost;
let logged: string[];

beforeEach(async () => {
  slack = await startFakeSlack();
  mm = await startFakeMattermost();
  logged = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const)
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await slack.close();
  await mm.close();
});

function api(): AgentBotApi {
  const a = new AgentBotApi({ guard: () => LOCAL });
  a.slackBase = slack.base;
  return a;
}
const SLACK = () => ({ botToken: slack.apps.agent.botToken, appToken: slack.apps.agent.appToken });
const MM = () => ({ baseUrl: mm.base, token: mm.bots.agent.token });
const caught = async (p: Promise<unknown>): Promise<ChatError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ChatError);
  return e as ChatError;
};

describe('AgentBotApi, Slack', () => {
  it('posts in a thread as JSON, without link previews', async () => {
    const got = await api().slackPost(SLACK(), { channel: 'COPS', threadTs: '1763640000.000100', text: 'On it.', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'On it.' } }] });
    expect(got.channel).toBe('COPS');
    const call = slack.calls.at(-1)!;
    expect(call).toMatchObject({ app: 'agent', method: 'chat.postMessage', httpMethod: 'POST', contentType: 'application/json; charset=utf-8', authorization: `Bearer ${slack.apps.agent.botToken}` });
    expect(call.params).toEqual({
      channel: 'COPS',
      thread_ts: '1763640000.000100',
      text: 'On it.',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'On it.' } }],
      unfurl_links: false,
      unfurl_media: false,
      link_names: false,
    });
    expect(slack.posts).toEqual([expect.objectContaining({ app: 'agent', channel: 'COPS', ts: got.ts, thread_ts: '1763640000.000100' })]);
  });

  it('changes a message and posts one only a person sees', async () => {
    const a = api();
    await a.slackUpdate(SLACK(), { channel: 'COPS', ts: '1763640000.000200', text: 'Done.' });
    expect(slack.calls.at(-1)).toMatchObject({ method: 'chat.update', contentType: 'application/json; charset=utf-8' });
    expect(slack.calls.at(-1)!.params).toEqual({ channel: 'COPS', ts: '1763640000.000200', text: 'Done.', blocks: [], link_names: false });
    await a.slackEphemeral(SLACK(), { channel: 'COPS', user: 'U2OMAR', text: 'Link your account first.', threadTs: '1763640000.000100' });
    expect(slack.calls.at(-1)!.params).toEqual({ channel: 'COPS', user: 'U2OMAR', text: 'Link your account first.', thread_ts: '1763640000.000100', link_names: false });
    expect(slack.ephemerals).toEqual([expect.objectContaining({ user: 'U2OMAR', text: 'Link your account first.' })]);
  });

  it('asks who it is, who a person is, and which channels it is in', async () => {
    const a = api();
    expect(await a.slackAuthTest(SLACK())).toEqual({ userId: 'UAGENT', botId: 'BAGENT', name: 'agent-bot', team: 'Acme', teamId: 'TACME' });
    expect(await a.slackUser(SLACK(), 'U1MARIA')).toEqual({ id: 'U1MARIA', name: 'Maria', isBot: false, deleted: false });
    expect(slack.calls.at(-1)).toMatchObject({ method: 'users.info', contentType: 'application/x-www-form-urlencoded', params: { user: 'U1MARIA' } });
    expect((await a.slackChannels(SLACK())).map((c) => c.name)).toEqual(['ops', 'ops-db']);
    expect(slack.calls.at(-1)!.params).toMatchObject({ types: 'public_channel,private_channel', exclude_archived: 'true' });
  });

  it('opens the socket with the app-level token, not the bot token', async () => {
    const url = await api().slackOpenSocket(SLACK());
    expect(url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/link\/\?ticket=/);
    expect(slack.calls.at(-1)).toMatchObject({ method: 'apps.connections.open', authorization: `Bearer ${slack.apps.agent.appToken}` });
    await expect(api().slackOpenSocket({ botToken: slack.apps.agent.botToken })).rejects.toThrow('app-level token is needed');
    const refused = await caught(api().slackOpenSocket({ botToken: slack.apps.agent.botToken, appToken: 'xapp-1-unknown-token' }));
    expect(refused.status).toBe(401);
    expect(refused.message).toMatch(/refused the app-level token/);
  });

  it('says what went wrong in plain sentences', async () => {
    const a = api();
    const cases: [string, string, RegExp, number][] = [
      ['chat.postMessage', 'msg_too_long', /too long for Slack/, 400],
      ['chat.postMessage', 'invalid_blocks', /did not take the message's layout/, 400],
      ['chat.postMessage', 'channel_not_found', /channel is gone/, 400],
      ['chat.postMessage', 'invalid_auth', /refused the agent bot's token/, 401],
      ['chat.postMessage', 'something_new', /Slack said: something_new/, 400],
    ];
    for (const [method, error, message, status] of cases) {
      slack.failNext(method, { error });
      const e = await caught(a.slackPost(SLACK(), { channel: 'COPS', text: 'x' }));
      expect(e.message).toMatch(message);
      expect(e.status).toBe(status);
    }
    const notIn = await caught(a.slackPost(SLACK(), { channel: 'CQUIET', text: 'x' }));
    expect(notIn.message).toBe('The agent bot is not in that channel. Invite it there first.');
    slack.failNext('chat.postMessage', { error: 'missing_scope', needed: 'chat:write' });
    const scope = await caught(a.slackPost(SLACK(), { channel: 'COPS', text: 'x' }));
    expect(scope.message).toBe("The agent bot's Slack app lacks the permission chat:write. Add it, then install the app again.");
    expect(scope.status).toBe(403);
  });

  it('waits as long as Slack asks', async () => {
    const a = api();
    slack.failNext('chat.update', { status: 429, retryAfter: 12 });
    const limited = await caught(a.slackUpdate(SLACK(), { channel: 'COPS', ts: '1763640000.000200', text: 'x' }));
    expect(limited.status).toBe(429);
    expect(limited.retryAfterMs).toBe(12_000);
    expect(limited.message).toMatch(/pause of 12 seconds/);
    slack.failNext('chat.postMessage', { error: 'ratelimited', retryAfter: 3 });
    expect((await caught(a.slackPost(SLACK(), { channel: 'COPS', text: 'x' }))).retryAfterMs).toBe(3000);
    slack.failNext('chat.postMessage', { error: 'ratelimited' });
    expect((await caught(a.slackPost(SLACK(), { channel: 'COPS', text: 'x' }))).retryAfterMs).toBe(30_000);
  });

  it('puts nothing that is not an id in a call', async () => {
    const a = api();
    await expect(a.slackPost(SLACK(), { channel: 'COPS&x=1', text: 'x' })).rejects.toThrow('not a Slack channel');
    await expect(a.slackUpdate(SLACK(), { channel: 'COPS', ts: 'nope', text: 'x' })).rejects.toThrow('not a Slack message time');
    expect(slack.calls).toHaveLength(0);
  });

  it('never puts a token in an error or a log line', async () => {
    const a = api();
    const token = slack.apps.agent.botToken;
    // A service, or a proxy, that echoes what it was sent.
    slack.failNext('chat.postMessage', { error: token });
    const echoed = await caught(a.slackPost(SLACK(), { channel: 'COPS', text: 'x' }));
    expect(echoed.message).not.toContain(token);
    // A transport that fails with the request in its message.
    a.transport = async (r: AgentRequest) => {
      throw new Error(`could not send ${JSON.stringify(r.headers)}`);
    };
    const failed = await caught(a.slackPost(SLACK(), { channel: 'COPS', text: 'x' }));
    expect(failed.message).not.toContain(token);
    expect(failed.message).toContain('[token]');
    const mmFailed = await caught(a.mmPost(MM(), { channelId: CHANNEL_OPS, message: 'x' }));
    expect(mmFailed.message).not.toContain(mm.bots.agent.token);
    expect(logged.join('\n')).not.toContain(token);
    expect(logged.join('\n')).not.toContain(mm.bots.agent.token);
  });

  it('goes through the address check', async () => {
    const a = new AgentBotApi({ guard: () => ({ server: true, allowPrivate: false }) });
    a.slackBase = slack.base;
    await expect(a.slackAuthTest(SLACK())).rejects.toThrow('A shared server does not call itself.');
    expect(slack.calls).toHaveLength(0);
  });
});

describe('AgentBotApi, Mattermost', () => {
  it('asks who it is', async () => {
    expect(await api().mmMe(MM())).toEqual({ userId: mm.bots.agent.userId, username: 'agentbot', name: 'agentbot', team: `127.0.0.1:${mm.port}` });
    expect(mm.calls.at(-1)).toMatchObject({ bot: 'agent', method: 'GET', path: '/users/me', authorization: `Bearer ${mm.bots.agent.token}` });
  });

  it('posts in a thread with buttons, changes the post, and reacts', async () => {
    const a = api();
    const root = mm.post(CHANNEL_OPS, '@agentbot restart nginx');
    const attachments = [{ text: 'Restart nginx on web-1', actions: [{ id: 'approve', name: 'Approve' }] }];
    const { id } = await a.mmPost(MM(), { channelId: CHANNEL_OPS, rootId: root.id, message: 'A change needs approval.', attachments });
    expect(mm.calls.at(-1)).toMatchObject({ method: 'POST', path: '/posts', contentType: 'application/json; charset=utf-8' });
    expect(mm.calls.at(-1)!.body).toEqual({ channel_id: CHANNEL_OPS, root_id: root.id, message: 'A change needs approval.', props: { attachments } });
    expect(mm.created).toEqual([expect.objectContaining({ bot: 'agent', id, root_id: root.id })]);

    await a.mmPatch(MM(), id, { message: 'Approved by Maria.', attachments: [] });
    expect(mm.calls.at(-1)).toMatchObject({ method: 'PUT', path: `/posts/${id}/patch` });
    expect(mm.patches).toEqual([{ bot: 'agent', id, body: { message: 'Approved by Maria.', props: { attachments: [] } } }]);

    await a.mmReact(MM(), { userId: mm.bots.agent.userId, postId: root.id, emoji: 'eyes' });
    expect(mm.calls.at(-1)).toMatchObject({ method: 'POST', path: '/reactions' });
    expect(mm.reactions[0].body).toEqual({ user_id: mm.bots.agent.userId, post_id: root.id, emoji_name: 'eyes' });
    await expect(a.mmReact(MM(), { userId: mm.bots.agent.userId, postId: root.id, emoji: 'no spaces' })).rejects.toThrow('not an emoji');
  });

  it('looks people and channels up, and opens a direct message', async () => {
    const a = api();
    expect(await a.mmUsers(MM(), [USER_MARIA, USER_MARIA, 'not-an-id'])).toEqual([{ id: USER_MARIA, name: 'maria', isBot: false, deleted: false }]);
    expect(mm.calls.at(-1)).toMatchObject({ method: 'POST', path: '/users/ids', body: [USER_MARIA] });
    const teams = await a.mmTeams(MM());
    expect(teams).toEqual([{ id: mm.teamId, name: 'Acme' }]);
    expect((await a.mmChannels(MM(), mm.teamId)).map((c) => c.name)).toEqual(['ops']);
    expect(mm.calls.at(-1)).toMatchObject({ method: 'GET', path: `/users/me/teams/${mm.teamId}/channels` });
    const dm = await a.mmDirect(MM(), mm.bots.agent.userId, USER_MARIA);
    expect(dm).toMatch(/^[a-z0-9]{26}$/);
    expect(mm.calls.at(-1)).toMatchObject({ method: 'POST', path: '/channels/direct', body: [mm.bots.agent.userId, USER_MARIA] });
  });

  it('says what went wrong in plain sentences', async () => {
    const a = api();
    const statuses: [number, RegExp][] = [
      [401, /refused the agent bot's token/],
      [403, /may not do that/],
      [404, /Not found/],
      [413, /too long for Mattermost/],
      [500, /Mattermost said: boom/],
    ];
    for (const [status, message] of statuses) {
      a.transport = async () => ({ status, body: JSON.stringify({ message: 'boom' }) });
      const e = await caught(a.mmPost(MM(), { channelId: CHANNEL_OPS, message: 'x' }));
      expect(e.message).toMatch(message);
      expect(e.status).toBe(status);
    }
    a.transport = async () => ({ status: 429, body: '{}', headers: { 'retry-after': '9' } });
    const limited = await caught(a.mmPost(MM(), { channelId: CHANNEL_OPS, message: 'x' }));
    expect(limited.retryAfterMs).toBe(9000);
    a.transport = undefined;
    const wrong = await caught(a.mmMe({ baseUrl: mm.base, token: 'mm-wrong-token-0000' }));
    expect(wrong.status).toBe(401);
    expect(wrong.message).not.toContain('mm-wrong-token-0000');
  });
});
