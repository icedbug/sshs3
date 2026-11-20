import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectWs } from '../../src/main/net/wsClient';
import { AgentBotApi } from '../../src/main/web/chatAgent/AgentBotApi';
import { SlackSocket } from '../../src/main/web/chatAgent/SlackSocket';
import { backoffDelay, RecentIds, type AgentEvent, type AgentSocketStatus } from '../../src/main/web/chatAgent/agentSocket';
import { startFakeSlack, type FakeSlack } from '../helpers/fakeSlack';
import { until } from '../helpers/wsServer';

/**
 * The agent bot's Socket Mode line to Slack: every envelope acknowledged at once, each event handed on
 * once and in one shape, only what was said to the bot, and a socket that comes back by itself.
 */

const LOCAL = { server: false, allowPrivate: true };
let slack: FakeSlack;
let sockets: SlackSocket[];

beforeEach(async () => {
  slack = await startFakeSlack();
  sockets = [];
});
afterEach(async () => {
  for (const s of sockets) await s.stop();
  await slack.close();
});

type Timed = AgentSocketStatus & { at: number };

function makeApi(): AgentBotApi {
  const api = new AgentBotApi({ guard: () => LOCAL });
  api.slackBase = slack.base;
  return api;
}

function start(extra: Partial<ConstructorParameters<typeof SlackSocket>[0]> = {}) {
  const api = makeApi();
  const events: AgentEvent[] = [];
  const statuses: Timed[] = [];
  const socket = new SlackSocket({
    api,
    auth: () => ({ botToken: slack.apps.agent.botToken, appToken: slack.apps.agent.appToken }),
    guard: () => LOCAL,
    connect: (url, options) => connectWs(url, { ...options, pingEveryMs: 0 }),
    onEvent: (e) => void events.push(e),
    onStatus: (s) => void statuses.push({ ...s, at: Date.now() }),
    backoff: { minMs: 20, maxMs: 200 },
    ...extra,
  });
  sockets.push(socket);
  socket.start();
  return { socket, events, statuses, api };
}

const opened = (statuses: AgentSocketStatus[]): number => statuses.filter((s) => s.state === 'open').length;
const waits = (statuses: Timed[]): Timed[] => statuses.filter((s) => s.state === 'waiting' && s.retryAt);
/** How long each wait was: when it said it would try again, less when it said so. */
const delays = (statuses: Timed[]): number[] => waits(statuses).map((s) => s.retryAt! - s.at);
const STEP = { minMs: 20, maxMs: 200, random: () => 1 };

describe('SlackSocket', () => {
  it('acknowledges every envelope and hands on a mention and a direct message', async () => {
    const { events, statuses } = start();
    await until(() => opened(statuses) === 1);
    const mention = slack.say('COPS', 'restart nginx on web-1');
    const reply = slack.say('COPS', 'and web-2 too', { thread: mention.ts, user: 'U2OMAR' });
    const direct = slack.say('DLINA', 'what is the load on db-1?', { user: 'U3LINA', im: true });
    await until(() => events.length === 3);
    // The server reads an acknowledgement a moment after the client sent it.
    await until(() => slack.acks.length === 3);
    expect(slack.acks.map((a) => a.envelope_id)).toEqual([mention.envelope.envelope_id, reply.envelope.envelope_id, direct.envelope.envelope_id]);
    expect(events).toEqual([
      { kind: 'message', service: 'slack', channelId: 'COPS', channelType: 'channel', threadId: mention.ts, messageId: mention.ts, userId: 'U1MARIA', text: 'restart nginx on web-1', mentioned: true },
      { kind: 'message', service: 'slack', channelId: 'COPS', channelType: 'channel', threadId: mention.ts, messageId: reply.ts, userId: 'U2OMAR', text: 'and web-2 too', mentioned: true },
      { kind: 'message', service: 'slack', channelId: 'DLINA', channelType: 'im', threadId: direct.ts, messageId: direct.ts, userId: 'U3LINA', text: 'what is the load on db-1?', mentioned: false },
    ]);
  });

  it('hands an event on once, however often Slack sends it', async () => {
    const { events, statuses } = start();
    await until(() => opened(statuses) === 1);
    const first = slack.say('COPS', 'check disk');
    // The same envelope again, as Slack does when an acknowledgement is late.
    slack.send({ ...first.envelope, retry_attempt: 1 });
    // The same event in a new envelope.
    slack.send({ ...first.envelope, envelope_id: 'another-envelope' });
    // The same message as a direct message event (a mention in a DM can come both ways).
    const asMessage = { ...first.envelope, envelope_id: 'third-envelope', payload: { ...first.envelope.payload, event_id: 'EvOTHER', event: { ...(first.envelope.payload.event as object), type: 'message', channel_type: 'im' } } };
    slack.send(asMessage);
    await until(() => slack.acks.length === 4);
    await new Promise((r) => setTimeout(r, 30));
    expect(events).toHaveLength(1);
    expect(slack.acks.map((a) => a.envelope_id)).toEqual([first.envelope.envelope_id, first.envelope.envelope_id, 'another-envelope', 'third-envelope']);
  });

  it('skips its own messages, other bots, edits and channel messages it was not named in', async () => {
    const { events, statuses } = start();
    await until(() => opened(statuses) === 1);
    const base = slack.say('DMARIA', 'hello', { im: true }).envelope;
    await until(() => events.length === 1);
    const variant = (id: string, event: Record<string, unknown>) =>
      slack.send({ ...base, envelope_id: `env-${id}`, payload: { ...base.payload, event_id: `Ev-${id}`, event: { ...(base.payload.event as object), ts: `176364${id}.000100`, ...event } } });
    variant('0001', { user: 'UAGENT' });
    variant('0002', { bot_id: 'BOTHER' });
    variant('0003', { subtype: 'message_changed' });
    variant('0004', { channel_type: 'channel', channel: 'COPS' });
    variant('0005', { type: 'reaction_added' });
    variant('0006', { text: 'hey <@UAGENT> look', user: 'U2OMAR' });
    await until(() => slack.acks.length === 7);
    await until(() => events.length === 2);
    expect(events[1]).toMatchObject({ channelType: 'im', userId: 'U2OMAR', text: 'hey look', mentioned: true });
  });

  it('hands on a message with a file, saying how many came, but no other kind of changed message', async () => {
    const { events, statuses } = start();
    await until(() => opened(statuses) === 1);
    const base = slack.say('DMARIA', 'hello', { im: true }).envelope;
    await until(() => events.length === 1);
    const variant = (id: string, event: Record<string, unknown>) =>
      slack.send({ ...base, envelope_id: `env-${id}`, payload: { ...base.payload, event_id: `Ev-${id}`, event: { ...(base.payload.event as object), ts: `176365${id}.000100`, ...event } } });
    variant('0001', { subtype: 'file_share', text: 'see the log', files: [{ id: 'F1' }, { id: 'F2' }] });
    variant('0002', { subtype: 'message_deleted' });
    await until(() => slack.acks.length === 3);
    await until(() => events.length === 2);
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ kind: 'message', text: 'see the log', files: 2 });
    expect(events[0]).not.toHaveProperty('files');
  });

  it('hands on a button press', async () => {
    const { events, statuses } = start();
    await until(() => opened(statuses) === 1);
    const env = slack.click('COPS', '1763640005.000100', { user: 'U1MARIA', value: 'signed.token', actionId: 'approve', thread: '1763640001.000100' });
    await until(() => events.length === 1);
    await until(() => slack.acks.some((a) => a.envelope_id === env.envelope_id));
    expect(slack.acks.at(-1)?.envelope_id).toBe(env.envelope_id);
    expect(events[0]).toEqual({ kind: 'action', service: 'slack', userId: 'U1MARIA', channelId: 'COPS', threadId: '1763640001.000100', messageId: '1763640005.000100', value: 'signed.token', actionId: 'approve' });
    slack.send(env);
    await until(() => slack.acks.length === 2);
    expect(events).toHaveLength(1);
  });

  it('opens the new socket before it closes the old one when Slack asks for a refresh', async () => {
    const { events, statuses } = start();
    await until(() => opened(statuses) === 1);
    const old = await slack.waitForSocket(1);
    slack.holdHello = true;
    slack.disconnect('refresh_requested');
    const fresh = await slack.waitForSocket(2);
    await new Promise((r) => setTimeout(r, 30));
    // Until the new socket says hello, the old one stays open and in use.
    expect(old.isClosed()).toBe(false);
    expect(old.frames.some((f) => f.opcode === 0x8)).toBe(false);
    const during = slack.say('COPS', 'said during the refresh');
    expect(slack.sockets().at(-1)).toBe(fresh);
    slack.send(during.envelope, 'agent', old);
    await until(() => events.length === 1);
    await until(() => slack.acks.some((a) => a.envelope_id === during.envelope.envelope_id));
    expect(events[0]).toMatchObject({ text: 'said during the refresh' });
    slack.holdHello = false;
    slack.hello(fresh);
    await until(() => opened(statuses) === 2);
    await until(() => old.isClosed());
    expect(old.frames.some((f) => f.opcode === 0x8)).toBe(true);
    expect(fresh.isClosed()).toBe(false);
    expect(slack.opened).toHaveLength(2);
    slack.say('COPS', 'after the refresh');
    await until(() => events.length === 2);
    expect(events[1]).toMatchObject({ text: 'after the refresh' });

    // A warning works the same way.
    slack.disconnect('warning');
    await slack.waitForSocket(3);
    await until(() => opened(statuses) === 3);
    await until(() => fresh.isClosed());
  });

  it('comes back after the connection drops, waiting longer each time it fails', async () => {
    const { statuses } = start({ backoff: { ...STEP, steadyMs: 40 } });
    await until(() => opened(statuses) === 1);
    slack.refuseSockets(2, 503);
    (await slack.waitForSocket(1)).drop();
    await until(() => opened(statuses) === 2, 5000, 'the socket back');
    expect(waits(statuses)).toHaveLength(3);
    expect(waits(statuses)[1].error).toMatch(/answered 503/);
    const [a, b, c] = delays(statuses);
    expect(Math.abs(a - 20)).toBeLessThanOrEqual(2);
    expect(Math.abs(b - 40)).toBeLessThanOrEqual(2);
    expect(Math.abs(c - 80)).toBeLessThanOrEqual(2);
    // Open for longer than steadyMs: the wait starts over at the shortest.
    await new Promise((r) => setTimeout(r, 60));
    (await slack.waitForSocket(2)).drop();
    await until(() => waits(statuses).length === 4);
    expect(Math.abs(delays(statuses)[3] - 20)).toBeLessThanOrEqual(2);
  });

  it('keeps waiting longer when Slack drops the socket right after hello', async () => {
    const { statuses } = start({ backoff: STEP });
    for (let n = 1; n <= 3; n++) {
      await until(() => opened(statuses) === n, 3000, `open ${n}`);
      (await slack.waitForSocket(n)).drop();
      await until(() => waits(statuses).length === n, 3000, `wait ${n}`);
    }
    const [a, b, c] = delays(statuses);
    expect(Math.abs(a - 20)).toBeLessThanOrEqual(2);
    expect(Math.abs(b - 40)).toBeLessThanOrEqual(2);
    expect(Math.abs(c - 80)).toBeLessThanOrEqual(2);
  });

  it('never opens the socket again sooner than Slack asked when it refuses the upgrade', async () => {
    const { statuses } = start();
    await until(() => opened(statuses) === 1);
    slack.refuseSockets(1, 429, 1);
    (await slack.waitForSocket(1)).drop();
    await until(() => statuses.some((s) => s.state === 'waiting' && /answered 429/.test(s.error ?? '')));
    const refused = statuses.find((s) => s.state === 'waiting' && /answered 429/.test(s.error ?? ''))!;
    expect(refused.retryAt! - refused.at).toBeGreaterThanOrEqual(1000);
    await until(() => opened(statuses) === 2, 4000, 'the socket back');
    const next = statuses.filter((s) => s.state === 'connecting' && s.at >= refused.at)[0];
    expect(next.at - refused.at).toBeGreaterThanOrEqual(995);
    expect(slack.opened).toHaveLength(3);
  });

  it('gives up on a socket that never says hello, and opens another', async () => {
    slack.holdHello = true;
    const { statuses } = start({ helloTimeoutMs: 50 });
    const first = await slack.waitForSocket(1);
    await until(() => first.frames.some((f) => f.opcode === 0x8));
    expect(first.frames.find((f) => f.opcode === 0x8)!.payload.readUInt16BE(0)).toBe(4000);
    await until(() => slack.opened.length >= 2);
    expect(opened(statuses)).toBe(0);
    expect(waits(statuses).length).toBeGreaterThanOrEqual(1);
  });

  it('starts again after a stop that came before hello', async () => {
    slack.holdHello = true;
    const { socket, statuses } = start();
    const first = await slack.waitForSocket(1);
    await socket.stop();
    await until(() => first.isClosed());
    socket.start();
    const second = await slack.waitForSocket(2);
    slack.hello(second);
    // The first socket saying hello late changes nothing.
    slack.hello(first);
    await until(() => opened(statuses) === 1);
    expect(socket.connected).toBe(true);
    expect(statuses.map((s) => s.state)).toEqual(['connecting', 'stopped', 'connecting', 'open']);
  });

  it('waits long, and says why, after Slack turns Socket Mode off', async () => {
    const { statuses } = start({ backoff: STEP });
    await until(() => opened(statuses) === 1);
    slack.disconnect('link_disabled');
    await until(() => statuses.some((s) => s.state === 'waiting' && !s.retryAt));
    (await slack.waitForSocket(1)).drop();
    await until(() => waits(statuses).length === 1);
    expect(delays(statuses)[0]).toBeGreaterThanOrEqual(198);
    expect(delays(statuses)[0]).toBeLessThanOrEqual(202);
    expect(waits(statuses)[0].error).toBe("Socket Mode was turned off for the agent bot's Slack app.");
  });

  it('never tries again sooner than Slack asked', async () => {
    const { statuses } = start();
    await until(() => opened(statuses) === 1);
    slack.failNext('apps.connections.open', { status: 429, retryAfter: 1 });
    const before = Date.now();
    (await slack.waitForSocket(1)).drop();
    await until(() => statuses.some((s) => s.state === 'waiting' && /pause/.test(s.error ?? '')));
    const wait = statuses.find((s) => /pause/.test(s.error ?? ''))!;
    expect(wait.retryAt! - before).toBeGreaterThanOrEqual(1000);
    await until(() => opened(statuses) === 2, 4000, 'the socket back');
    expect(Date.now() - before).toBeGreaterThanOrEqual(1000);
  });

  it('stops: every socket closed, and no reconnect after', async () => {
    const { socket, statuses } = start();
    await until(() => opened(statuses) === 1);
    const s = await slack.waitForSocket(1);
    await socket.stop();
    await until(() => s.isClosed());
    expect(statuses.at(-1)?.state).toBe('stopped');
    await new Promise((r) => setTimeout(r, 100));
    expect(slack.opened).toHaveLength(1);
    expect(socket.connected).toBe(false);
  });

  it('takes a socket address only on Slack, unless a test opens the socket', async () => {
    const { statuses } = start({ connect: undefined });
    await until(() => statuses.some((s) => s.state === 'waiting'));
    expect(statuses.find((s) => s.state === 'waiting')?.error).toBe("Slack gave a socket address that is not Slack's.");
    expect(slack.sockets()).toHaveLength(0);
  });

  it("takes only Slack's own hosts for the socket", async () => {
    for (const url of ['wss://wss-primary.slack.com.evil.example/link/?ticket=x', 'wss://evilslack.com/link/?ticket=x', 'ws://wss-primary.slack.com/link/']) {
      const api = makeApi();
      api.slackOpenSocket = async () => url;
      const { statuses } = start({ api, connect: undefined });
      await until(() => statuses.some((s) => s.state === 'waiting'), 3000, url);
      expect(statuses.find((s) => s.state === 'waiting')?.error).toBe("Slack gave a socket address that is not Slack's.");
    }
    // Slack's own host passes the check and goes on to be looked up.
    const looked: string[] = [];
    const api = makeApi();
    api.slackOpenSocket = async () => 'wss://wss-primary.slack.com/link/?ticket=x';
    const guard = () => ({
      server: false,
      allowPrivate: true,
      lookup: async (host: string) => {
        looked.push(host);
        throw new Error('not here');
      },
    });
    const { statuses } = start({ api, connect: undefined, guard });
    await until(() => statuses.some((s) => s.state === 'waiting'));
    expect(looked).toEqual(['wss-primary.slack.com']);
    expect(statuses.find((s) => s.state === 'waiting')?.error).not.toBe("Slack gave a socket address that is not Slack's.");
  });

  it('does not hand on its own reply in a direct message when Slack sends it back', async () => {
    const { events, statuses, api } = start();
    await until(() => opened(statuses) === 1);
    await api.slackPost({ botToken: slack.apps.agent.botToken, appToken: slack.apps.agent.appToken }, { channel: 'DMARIA', text: 'Here is the answer.' });
    await until(() => slack.acks.length === 1);
    slack.say('DMARIA', 'thanks', { im: true });
    await until(() => events.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ text: 'thanks', userId: 'U1MARIA' });
  });

  it('neither acknowledges nor keeps ids that are not of Slack\'s shape', async () => {
    const { events, statuses } = start();
    await until(() => opened(statuses) === 1);
    const base = slack.say('DMARIA', 'first', { im: true }).envelope;
    await until(() => events.length === 1);
    slack.send({ ...base, envelope_id: 'x'.repeat(5000) });
    const event = base.payload.event as Record<string, unknown>;
    slack.send({ ...base, envelope_id: 'bad-channel', payload: { ...base.payload, event_id: 'EvBAD1', event: { ...event, ts: '1763649999.000100', channel: 'D<script>' } } });
    slack.send({ ...base, envelope_id: 'bad-thread', payload: { ...base.payload, event_id: 'EvBAD2', event: { ...event, ts: '1763649998.000100', thread_ts: 'y'.repeat(300) } } });
    slack.send({ ...base, envelope_id: 'bad-event-id', payload: { ...base.payload, event_id: 'Ev BAD 3', event: { ...event, ts: '1763649997.000100' } } });
    const last = slack.say('DMARIA', 'last', { im: true });
    await until(() => events.length === 2);
    await until(() => slack.acks.some((a) => a.envelope_id === last.envelope.envelope_id));
    expect(slack.acks.map((a) => a.envelope_id)).toEqual([base.envelope_id, 'bad-channel', 'bad-thread', 'bad-event-id', last.envelope.envelope_id]);
    expect(events[1]).toMatchObject({ text: 'last' });
  });

  it('cuts a very long message before reading it', async () => {
    const { events, statuses } = start();
    await until(() => opened(statuses) === 1);
    slack.say('DMARIA', `${'<http:'.repeat(5000)} ${'a'.repeat(20_000)}`, { im: true });
    await until(() => events.length === 1);
    expect((events[0] as { text: string }).text.length).toBeLessThanOrEqual(16_000);
  });

  it('learns who the bot is once, from Slack', async () => {
    const identities: unknown[] = [];
    const { statuses } = start({ onIdentity: (i) => void identities.push(i) });
    await until(() => opened(statuses) === 1);
    expect(identities).toEqual([{ userId: 'UAGENT', botId: 'BAGENT', name: 'agent-bot', team: 'Acme', teamId: 'TACME' }]);
    slack.disconnect('refresh_requested');
    await until(() => opened(statuses) === 2);
    expect(slack.calls.filter((c) => c.method === 'auth.test')).toHaveLength(1);
  });
});

describe('backoff and repeats', () => {
  it('waits one second, doubling up to a minute, with jitter, and never less than asked', () => {
    const low = (attempt: number) => backoffDelay(attempt, { random: () => 0 });
    const high = (attempt: number) => backoffDelay(attempt, { random: () => 1 });
    expect(high(0)).toBe(1000);
    expect(high(1)).toBe(2000);
    expect(high(5)).toBe(32_000);
    expect(high(6)).toBe(60_000);
    expect(high(40)).toBe(60_000);
    expect(low(0)).toBe(1000);
    expect(low(3)).toBe(4000);
    expect(low(10)).toBe(30_000);
    expect(backoffDelay(0, { random: () => 0.5 }, 45_000)).toBe(45_000);
  });

  it('forgets an id after a while', () => {
    let now = 0;
    const ids = new RecentIds(1000, 10, () => now);
    expect(ids.first('a')).toBe(true);
    expect(ids.first('a')).toBe(false);
    now = 2000;
    expect(ids.first('a')).toBe(true);
    for (let i = 0; i < 20; i++) ids.first(`x${i}`);
    expect(ids.first('x19')).toBe(false);
    // Forgotten because at most ten are kept, though it is not old.
    expect(ids.first('x0')).toBe(true);
    expect(ids.first(undefined)).toBe(true);
  });
});
