import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ChatBridge } from '../../src/main/ai/hub/ChatBridge';
import type { ChatTransport } from '../../src/main/ai/hub/ChatSources';
import { guardUrl, request } from '../../src/main/ai/hub/Notifier';
import { AgentBotApi } from '../../src/main/web/chatAgent/AgentBotApi';
import { SLACK_WRITE_METHODS, startFakeSlack, type FakeSlack } from '../helpers/fakeSlack';
import { CHANNEL_OPS, CHANNEL_QUIET, USER_OMAR, startFakeMattermost, type FakeMattermost } from '../helpers/fakeMattermost';

/**
 * The two bots side by side. The agent bot posts; the context bot only reads, and reads one thread now
 * when the agent bot is mentioned in it, but only in a channel an administrator chose for it to read.
 */

const LOCAL = { server: false, allowPrivate: true };
const dirs: string[] = [];
let slack: FakeSlack;
let mm: FakeMattermost;

beforeEach(async () => {
  slack = await startFakeSlack();
  mm = await startFakeMattermost();
});
afterEach(async () => {
  await slack.close();
  await mm.close();
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** Slack's fixed address goes to the stand-in; Mattermost's address is the stand-in's own. */
const transport: ChatTransport = async (r) => {
  if (r.url.startsWith('https://slack.com/api')) return slack.transport(r);
  const got = await request(await guardUrl(r.url, LOCAL), { method: r.method, headers: r.headers, body: r.body });
  return { status: got.status, body: got.body, headers: got.headers as Record<string, string | string[] | undefined> };
};

async function contextBot(): Promise<ChatBridge> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sshs3-context-bot-'));
  dirs.push(dir);
  const bridge = new ChatBridge(dir, { guard: () => LOCAL });
  bridge.transport = transport;
  await bridge.load();
  return bridge;
}

function agentBot(): AgentBotApi {
  const api = new AgentBotApi({ guard: () => LOCAL });
  api.slackBase = slack.base;
  return api;
}

describe('ChatBridge.readThreadNow', () => {
  it('reads a Slack thread now, masked, only in a channel the context bot reads', async () => {
    const bridge = await contextBot();
    // Not connected yet: nothing.
    expect(await bridge.readThreadNow('slack', 'COPS', '1763640001.000100')).toBeUndefined();
    await bridge.save({ service: 'slack', token: slack.apps.context.botToken, enabled: true });
    expect(await bridge.test('slack')).toMatchObject({ ok: true, channels: 3 });
    await bridge.select('slack', 'COPS', true);

    const root = slack.say('COPS', 'db-1 is slow since the deploy');
    slack.say('COPS', 'the key was AKIAIOSFODNN7EXAMPLE in the log', { thread: root.ts, user: 'U2OMAR' });
    slack.say('COPS', 'can you look?', { thread: root.ts });
    const thread = await bridge.readThreadNow('slack', 'COPS', root.ts);
    expect(thread?.map((m) => m.text)).toEqual(['@UAGENT db-1 is slow since the deploy', '@UAGENT the key was [redacted] in the log', '@UAGENT can you look?']);
    expect(thread?.map((m) => m.author)).toEqual(['Maria', 'Omar', 'Maria']);
    expect(JSON.stringify(thread)).not.toContain('AKIAIOSFODNN7EXAMPLE');
    // Kept in the index like any other read.
    expect(bridge.thread('slack', 'COPS', root.ts)).toHaveLength(3);

    // A channel the context bot is in, but nobody chose: nothing, and nothing is asked of Slack.
    const before = slack.calls.length;
    const other = slack.say('CDB', 'drop the table?');
    expect(await bridge.readThreadNow('slack', 'CDB', other.ts)).toBeUndefined();
    expect(await bridge.readThreadNow('slack', 'CNOPE', other.ts)).toBeUndefined();
    expect(await bridge.readThreadNow('slack', 'COPS', 'not-a-ts')).toBeUndefined();
    expect(slack.calls.slice(before).filter((c) => c.app === 'context')).toEqual([]);
  });

  it('gives what it read before when Slack cannot be asked now', async () => {
    const bridge = await contextBot();
    await bridge.save({ service: 'slack', token: slack.apps.context.botToken, enabled: true });
    await bridge.test('slack');
    await bridge.select('slack', 'COPS', true);
    const root = slack.say('COPS', 'first');
    expect(await bridge.readThreadNow('slack', 'COPS', root.ts)).toHaveLength(1);
    slack.say('COPS', 'second', { thread: root.ts });
    slack.failNext('conversations.replies', { status: 429, retryAfter: 30 });
    expect((await bridge.readThreadNow('slack', 'COPS', root.ts))?.map((m) => m.text)).toEqual(['@UAGENT first']);
  });

  it('reads a Mattermost thread only from the channel asked about', async () => {
    const bridge = await contextBot();
    await bridge.save({ service: 'mattermost', baseUrl: mm.base, token: mm.bots.context.token, enabled: true });
    expect(await bridge.test('mattermost')).toMatchObject({ ok: true, channels: 2 });
    await bridge.select('mattermost', CHANNEL_OPS, true);
    const root = mm.post(CHANNEL_OPS, 'nginx returns 502');
    mm.post(CHANNEL_OPS, '@agentbot what changed?', { user: USER_OMAR, root: root.id });
    const thread = await bridge.readThreadNow('mattermost', CHANNEL_OPS, root.id);
    expect(thread?.map((m) => [m.author, m.text])).toEqual([
      ['maria', 'nginx returns 502'],
      ['omar', '@agentbot what changed?'],
    ]);
    // A thread of a channel nobody chose, asked for as if it were in a chosen one: nothing of it is read in.
    const elsewhere = mm.post(CHANNEL_QUIET, 'private plans');
    expect(await bridge.readThreadNow('mattermost', CHANNEL_OPS, elsewhere.id)).toEqual([]);
    expect(bridge.thread('mattermost', CHANNEL_OPS, elsewhere.id)).toEqual([]);
    expect(await bridge.readThreadNow('mattermost', CHANNEL_QUIET, elsewhere.id)).toBeUndefined();
  });
});

describe('two bots, one writes', () => {
  it('the context bot makes no write call while the agent bot posts in the same channels', async () => {
    const bridge = await contextBot();
    await bridge.save({ service: 'slack', token: slack.apps.context.botToken, enabled: true });
    await bridge.save({ service: 'mattermost', baseUrl: mm.base, token: mm.bots.context.token, enabled: true });
    await bridge.test('slack');
    await bridge.test('mattermost');
    await bridge.select('slack', 'COPS', true);
    await bridge.select('mattermost', CHANNEL_OPS, true);

    const agent = agentBot();
    const asked = slack.say('COPS', 'restart nginx');
    await agent.slackPost({ botToken: slack.apps.agent.botToken }, { channel: 'COPS', threadTs: asked.ts, text: 'Looking.' });
    await agent.slackUpdate({ botToken: slack.apps.agent.botToken }, { channel: 'COPS', ts: slack.posts[0].ts, text: 'Done.' });
    const mmAsked = mm.post(CHANNEL_OPS, '@agentbot restart nginx');
    await agent.mmPost({ baseUrl: mm.base, token: mm.bots.agent.token }, { channelId: CHANNEL_OPS, rootId: mmAsked.id, message: 'Looking.' });

    await bridge.tick();
    await bridge.readThreadNow('slack', 'COPS', asked.ts);
    await bridge.readThreadNow('mattermost', CHANNEL_OPS, mmAsked.id);
    await bridge.tick(Date.now() + 10 * 60_000);

    const contextSlack = slack.calls.filter((c) => c.app === 'context');
    expect(contextSlack.length).toBeGreaterThan(3);
    expect(contextSlack.filter((c) => SLACK_WRITE_METHODS.has(c.method))).toEqual([]);
    expect(slack.posts.every((p) => p.app === 'agent')).toBe(true);
    expect(slack.updates.every((p) => p.app === 'agent')).toBe(true);

    const contextMm = mm.calls.filter((c) => c.bot === 'context');
    expect(contextMm.length).toBeGreaterThan(3);
    // Its only POST looks names up; it never posts, patches, reacts or opens a channel.
    expect(contextMm.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`)).toEqual(
      contextMm.filter((c) => c.method === 'POST' && c.path === '/users/ids').map((c) => `${c.method} ${c.path}`),
    );
    expect(mm.created.every((p) => p.bot === 'agent')).toBe(true);
  });

  it('the context bot has no write call in its code', async () => {
    const root = path.resolve(__dirname, '../../src/main/ai/hub');
    for (const file of ['ChatSources.ts', 'ChatBridge.ts', 'ChatIndex.ts']) {
      const text = await fs.readFile(path.join(root, file), 'utf8');
      for (const call of [...SLACK_WRITE_METHODS, '/patch', '/reactions', '/channels/direct', '"PUT"', '"DELETE"'])
        expect(text.includes(call), `${file} mentions ${call}`).toBe(false);
      expect(/mattermost<[^>]*>\(t, auth, "POST", "\/posts"/.test(text)).toBe(false);
    }
  });
});
