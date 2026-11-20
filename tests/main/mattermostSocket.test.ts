import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectWs } from '../../src/main/net/wsClient';
import { AgentBotApi } from '../../src/main/web/chatAgent/AgentBotApi';
import { MattermostSocket } from '../../src/main/web/chatAgent/MattermostSocket';
import type { AgentEvent, AgentSocketStatus } from '../../src/main/web/chatAgent/agentSocket';
import { CHANNEL_OPS, USER_MARIA, USER_OMAR, mmId, startFakeMattermost, type FakeMattermost } from '../helpers/fakeMattermost';
import { until } from '../helpers/wsServer';

/**
 * The agent bot's line to Mattermost: signed in with the bot's token, posts and reactions handed on
 * in the same shape as Slack's, and a socket that comes back by itself and asks for what it missed.
 */

const LOCAL = { server: false, allowPrivate: true };
let mm: FakeMattermost;
let sockets: MattermostSocket[];

beforeEach(async () => {
  mm = await startFakeMattermost();
  sockets = [];
});
afterEach(async () => {
  for (const s of sockets) await s.stop();
  await mm.close();
});

type Timed = AgentSocketStatus & { at: number };

function start(extra: Partial<ConstructorParameters<typeof MattermostSocket>[0]> = {}, token = () => mm.bots.agent.token) {
  const events: AgentEvent[] = [];
  const statuses: Timed[] = [];
  const api = new AgentBotApi({ guard: () => LOCAL });
  const socket = new MattermostSocket({
    api,
    auth: () => ({ baseUrl: mm.base, token: token() }),
    guard: () => LOCAL,
    connect: (url, options) => connectWs(url, { ...options, pingEveryMs: 0 }),
    onEvent: (e) => void events.push(e),
    onStatus: (s) => void statuses.push({ ...s, at: Date.now() }),
    backoff: { minMs: 20, maxMs: 200 },
    helloWaitMs: 50,
    ...extra,
  });
  sockets.push(socket);
  socket.start();
  return { socket, events, statuses, api };
}

const opened = (statuses: AgentSocketStatus[]): number => statuses.filter((s) => s.state === 'open').length;
const waits = (statuses: Timed[]): Timed[] => statuses.filter((s) => s.state === 'waiting' && s.retryAt);
const delays = (statuses: Timed[]): number[] => waits(statuses).map((s) => s.retryAt! - s.at);
const STEP = { minMs: 20, maxMs: 200, random: () => 1 };
const near = (value: number, expected: number): void => expect(Math.abs(value - expected)).toBeLessThanOrEqual(2);

describe('MattermostSocket', () => {
  it('signs in with the token in the header and hands on a mention and a reply in its thread', async () => {
    const { events, statuses } = start();
    await until(() => opened(statuses) === 1);
    expect(mm.upgrades[0].authorization).toBe(`Bearer ${mm.bots.agent.token}`);
    // The header was taken: the token is not sent over the socket as well.
    await new Promise((r) => setTimeout(r, 120));
    expect(mm.sockets()[0].socket.messages).toEqual([]);
    const root = mm.post(CHANNEL_OPS, '@agentbot why is web-1 slow?');
    const reply = mm.post(CHANNEL_OPS, '@AgentBot, and web-2?', { user: USER_OMAR, root: root.id });
    const chatter = mm.post(CHANNEL_OPS, 'lunch?');
    await until(() => events.length === 3);
    expect(events[0]).toEqual({
      kind: 'message',
      service: 'mattermost',
      channelId: CHANNEL_OPS,
      channelType: 'channel',
      threadId: root.id,
      messageId: root.id,
      userId: USER_MARIA,
      userName: 'maria',
      text: 'why is web-1 slow?',
      mentioned: true,
    });
    expect(events[1]).toMatchObject({ threadId: root.id, messageId: reply.id, userId: USER_OMAR, text: 'and web-2?', mentioned: true });
    // Said in a channel without naming the bot: handed on, and marked so.
    expect(events[2]).toMatchObject({ messageId: chatter.id, mentioned: false });
  });

  it('knows a direct message', async () => {
    const { events, statuses } = start();
    await until(() => opened(statuses) === 1);
    const dm = mm.dm(USER_MARIA);
    const post = mm.post(dm, 'link ABCD2345');
    await until(() => events.length === 1);
    expect(events[0]).toMatchObject({ channelId: dm, channelType: 'im', threadId: post.id, text: 'link ABCD2345', mentioned: true });
  });

  it('skips its own posts, system messages and other bots', async () => {
    const { events, statuses } = start();
    await until(() => opened(statuses) === 1);
    mm.post(CHANNEL_OPS, '@agentbot echo', { user: mm.bots.agent.userId });
    mm.post(CHANNEL_OPS, 'maria joined the channel', { type: 'system_join_channel' });
    mm.post(CHANNEL_OPS, '@agentbot from a webhook', { props: { from_webhook: 'true' } });
    mm.post(CHANNEL_OPS, '@agentbot from a bot', { props: { from_bot: 'true' } });
    const real = mm.post(CHANNEL_OPS, '@agentbot real question');
    await until(() => events.length === 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ messageId: real.id });
  });

  it('hands on a reaction, not its own', async () => {
    const { events, statuses } = start();
    await until(() => opened(statuses) === 1);
    const card = mm.post(CHANNEL_OPS, 'card');
    await until(() => events.length === 1);
    mm.react(mm.bots.agent.userId, card.id, 'eyes');
    mm.react(USER_MARIA, card.id, 'white_check_mark');
    await until(() => events.length === 2);
    expect(events[1]).toEqual({ kind: 'reaction', service: 'mattermost', userId: USER_MARIA, postId: card.id, emoji: 'white_check_mark', channelId: CHANNEL_OPS });
  });

  it('offers the token as a challenge when the header is not taken', async () => {
    mm.headerAuth = false;
    const { events, statuses } = start();
    await until(() => opened(statuses) === 1);
    const s = mm.sockets()[0];
    const challenge = JSON.parse(s.socket.messages[0]) as { action: string; seq: number; data: { token: string } };
    expect(challenge).toMatchObject({ action: 'authentication_challenge', data: { token: mm.bots.agent.token } });
    mm.post(CHANNEL_OPS, '@agentbot hello');
    await until(() => events.length === 1);
  });

  it('says so when the token is refused, and tries again later', async () => {
    mm.headerAuth = false;
    // Who the bot is was kept from before, so the socket is the first thing to refuse the token.
    const wrong = start({ identity: { userId: mm.bots.agent.userId, username: 'agentbot' } }, () => 'mm-wrong-token');
    await until(() => wrong.statuses.some((s) => s.state === 'waiting'));
    expect(wrong.statuses.find((s) => s.state === 'waiting')?.error).toBe("Mattermost refused the agent bot's token on the socket.");
    expect(JSON.stringify(wrong.statuses)).not.toContain('mm-wrong-token');
  });

  it('comes back after a drop and is given what it missed', async () => {
    const { events, statuses } = start();
    await until(() => opened(statuses) === 1);
    const first = mm.sockets()[0];
    mm.post(CHANNEL_OPS, '@agentbot one');
    mm.post(CHANNEL_OPS, '@agentbot two');
    await until(() => events.length === 2);
    mm.drop();
    const missed = mm.post(CHANNEL_OPS, '@agentbot while down');
    await until(() => opened(statuses) === 2, 5000, 'the socket back');
    expect(statuses.some((s) => s.state === 'waiting')).toBe(true);
    // Hello was 0, the posts 1 and 2: the next one expected is 3.
    expect(mm.upgrades[1].query).toEqual({ connection_id: first.connectionId, sequence_number: '3' });
    await until(() => events.length === 3);
    expect(events[2]).toMatchObject({ messageId: missed.id, text: 'while down' });
    const resumed = mm.sockets()[0];
    expect(resumed.resumed).toBe(true);
    expect(resumed.connectionId).toBe(first.connectionId);
    // It stays open, and never offers the token on the socket.
    await new Promise((r) => setTimeout(r, 4 * 50));
    expect(resumed.socket.isClosed()).toBe(false);
    expect(resumed.socket.messages.some((m) => m.includes('authentication_challenge'))).toBe(false);
    expect(statuses.filter((s) => s.state === 'waiting')).toHaveLength(1);
    expect(mm.upgrades).toHaveLength(2);
    mm.post(CHANNEL_OPS, '@agentbot three');
    await until(() => events.length === 4);
    expect(events.filter((e) => e.kind === 'message' && e.messageId === missed.id)).toHaveLength(1);
  });

  it('comes back after a drop when nothing was missed', async () => {
    const { events, statuses } = start();
    await until(() => opened(statuses) === 1);
    mm.drop();
    await until(() => opened(statuses) === 2, 5000, 'the socket back');
    await new Promise((r) => setTimeout(r, 4 * 50));
    expect(mm.sockets()[0].resumed).toBe(true);
    expect(mm.sockets()[0].socket.isClosed()).toBe(false);
    expect(mm.upgrades).toHaveLength(2);
    mm.post(CHANNEL_OPS, '@agentbot after');
    await until(() => events.length === 1);
  });

  it('comes back after a drop when the header is not taken, offering the token once more', async () => {
    mm.headerAuth = false;
    const { events, statuses } = start();
    await until(() => opened(statuses) === 1);
    mm.drop();
    await until(() => opened(statuses) === 2, 5000, 'the socket back');
    const again = mm.sockets()[0];
    // The question was refused, so the token was offered, and the server started a new connection.
    expect(again.socket.messages.map((m) => (JSON.parse(m) as { action: string }).action)).toEqual(['get_statuses_by_ids', 'authentication_challenge']);
    expect(statuses.filter((s) => s.state === 'waiting')).toHaveLength(1);
    mm.post(CHANNEL_OPS, '@agentbot after');
    await until(() => events.length === 1);
  });

  it('starts counting over when the server could not take the connection back', async () => {
    const { events, statuses } = start();
    await until(() => opened(statuses) === 1);
    const first = mm.sockets()[0];
    mm.post(CHANNEL_OPS, '@agentbot one');
    await until(() => events.length === 1);
    mm.forgetConnections();
    mm.drop();
    await until(() => opened(statuses) === 2, 5000, 'the socket back');
    const second = mm.sockets()[0];
    expect(second.resumed).toBe(false);
    expect(second.connectionId).not.toBe(first.connectionId);
    mm.post(CHANNEL_OPS, '@agentbot two');
    await until(() => events.length === 2);
    mm.drop();
    await until(() => opened(statuses) === 3, 5000, 'the socket back again');
    // Hello on the new connection was 0 and the post 1: the next one expected is 2.
    expect(mm.upgrades[2].query).toEqual({ connection_id: second.connectionId, sequence_number: '2' });
  });

  it('counts events the server numbered but never sent', async () => {
    const { socket, events, statuses } = start();
    await until(() => opened(statuses) === 1);
    mm.loseNext();
    mm.post(CHANNEL_OPS, '@agentbot lost');
    mm.post(CHANNEL_OPS, '@agentbot kept');
    await until(() => events.length === 1);
    expect(socket.missed).toBe(1);
  });

  it('never opens the socket again sooner than Mattermost asked', async () => {
    const { statuses } = start();
    await until(() => opened(statuses) === 1);
    mm.refuseSockets(1, 429, 1);
    mm.drop();
    await until(() => statuses.some((s) => s.state === 'waiting' && /answered 429/.test(s.error ?? '')));
    const refused = statuses.find((s) => s.state === 'waiting' && /answered 429/.test(s.error ?? ''))!;
    expect(refused.retryAt! - refused.at).toBeGreaterThanOrEqual(1000);
    await until(() => opened(statuses) === 2, 4000, 'the socket back');
    const next = statuses.filter((s) => s.state === 'connecting' && s.at >= refused.at)[0];
    expect(next.at - refused.at).toBeGreaterThanOrEqual(995);
    expect(mm.upgrades).toHaveLength(3);
  });

  it('waits longer each time it fails, and starts over after a while open', async () => {
    const { statuses } = start({ backoff: { ...STEP, steadyMs: 40 } });
    await until(() => opened(statuses) === 1);
    mm.refuseSockets(2, 503);
    mm.drop();
    await until(() => opened(statuses) === 2, 5000, 'the socket back');
    const [a, b, c] = delays(statuses);
    near(a, 20);
    near(b, 40);
    near(c, 80);
    await new Promise((r) => setTimeout(r, 60));
    mm.drop();
    await until(() => waits(statuses).length === 4);
    near(delays(statuses)[3], 20);
  });

  it('keeps waiting longer when the server drops the socket right after it opens', async () => {
    const { statuses } = start({ backoff: STEP });
    for (let n = 1; n <= 3; n++) {
      await until(() => opened(statuses) === n, 3000, `open ${n}`);
      mm.drop();
      await until(() => waits(statuses).length === n, 3000, `wait ${n}`);
    }
    const [a, b, c] = delays(statuses);
    near(a, 20);
    near(b, 40);
    near(c, 80);
  });

  it('starts again after a stop that came before hello', async () => {
    mm.headerAuth = false;
    const { socket, statuses } = start({ helloWaitMs: 200 });
    await until(() => mm.upgrades.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    await socket.stop();
    socket.start();
    await until(() => mm.upgrades.length === 2, 3000, 'a second upgrade');
    await until(() => opened(statuses) === 1, 3000, 'open');
    expect(statuses.map((s) => s.state)).toEqual(['connecting', 'stopped', 'connecting', 'open']);
  });

  it('does not hand on its own reply when Mattermost sends it back', async () => {
    const { events, statuses, api } = start();
    await until(() => opened(statuses) === 1);
    const dm = mm.dm(USER_MARIA);
    const echoes = mm.sockets()[0].socket;
    await api.mmPost({ baseUrl: mm.base, token: mm.bots.agent.token }, { channelId: dm, message: 'Here is the answer.' });
    mm.post(dm, 'thanks');
    await until(() => events.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ text: 'thanks', userId: USER_MARIA });
    expect(mm.created).toHaveLength(1);
    expect(echoes.isClosed()).toBe(false);
  });

  it('takes the mention out of the text also when who the bot is was kept without its user name', async () => {
    const { events, statuses } = start({ identity: { userId: mm.bots.agent.userId, name: 'agentbot' } });
    await until(() => opened(statuses) === 1);
    mm.post(CHANNEL_OPS, '@agentbot why is web-1 slow?');
    await until(() => events.length === 1);
    expect(events[0]).toMatchObject({ text: 'why is web-1 slow?', mentioned: true });
    expect(mm.calls.filter((c) => c.path === '/users/me')).toHaveLength(1);
  });

  it('hands on nothing with ids that are not of Mattermost\'s shape', async () => {
    const { events, statuses } = start();
    await until(() => opened(statuses) === 1);
    const raw = mm.sockets()[0].socket;
    const good = { id: mmId(), channel_id: CHANNEL_OPS, user_id: USER_MARIA, root_id: '', message: 'ok', type: '', props: {} };
    const posted = (post: object) => raw.send(JSON.stringify({ event: 'posted', data: { channel_type: 'O', post: JSON.stringify(post) } }));
    posted({ ...good, id: 'x'.repeat(100_000) });
    posted({ ...good, id: mmId(), channel_id: 'not-a-channel' });
    posted({ ...good, id: mmId(), root_id: 'y'.repeat(30) });
    const reacted = (reaction: object) => raw.send(JSON.stringify({ event: 'reaction_added', data: { reaction: JSON.stringify(reaction) } }));
    reacted({ user_id: USER_MARIA, post_id: good.id, emoji_name: 'z'.repeat(5000), create_at: 1 });
    reacted({ user_id: USER_MARIA, post_id: good.id, emoji_name: 'eyes', create_at: 'later' });
    posted(good);
    await until(() => events.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ messageId: good.id });
  });

  it('stops for good', async () => {
    const { socket, statuses } = start();
    await until(() => opened(statuses) === 1);
    const s = mm.sockets()[0];
    await socket.stop();
    await until(() => s.socket.isClosed());
    await new Promise((r) => setTimeout(r, 100));
    expect(mm.upgrades).toHaveLength(1);
    expect(statuses.at(-1)?.state).toBe('stopped');
  });
});
