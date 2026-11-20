import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ChatAnsweringStore,
  DEFAULT_CHAT_BUDGET,
  DEFAULT_CHAT_LIMITS,
  dmFence,
  fenceFromRule,
} from '../../src/main/web/chatAgent/ChatAnsweringStore';

/**
 * Where the agent bot answers and how far: the channels an administrator chose, each with its fence;
 * direct messages; the hourly limits; and the month's token budget, which outlives a restart.
 */

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

const NOW = Date.parse('2026-11-20T12:00:00Z');
const MM_CHANNEL = 'abcdefghijklmnopqrstuvwxyz';

async function fresh(start = NOW) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sshs3-answering-'));
  dirs.push(dir);
  let now = start;
  const clock = { now: () => now, set: (t: number) => (now = t), add: (ms: number) => (now += ms) };
  const store = new ChatAnsweringStore(dir, { clock: clock.now });
  await store.initialize();
  return { dir, store, clock, file: path.join(dir, 'chat-agent', 'answering.json') };
}

const opsDb = {
  channelId: 'C0OPSDB',
  channelName: '#ops-db',
  servers: ['db-1', 'db-2'],
  clusters: ['postgres'],
  reach: 'ask' as const,
  approvers: 'admins' as const,
  historyFrom: [],
};

describe('ChatAnsweringStore', () => {
  it('starts off, with the default limits and budget', async () => {
    const { store } = await fresh();
    const view = store.view();
    expect(view.enabled).toBe(false);
    expect(view.limits).toEqual(DEFAULT_CHAT_LIMITS);
    expect(view.limits).toEqual({ personNewPerHour: 10, personMessagesPerHour: 30, channelPerHour: 30, concurrentRuns: 4 });
    expect(view.monthlyTokenBudget).toBe(DEFAULT_CHAT_BUDGET);
    expect(view.usage).toEqual({ month: '2026-11', tokens: 0 });
    expect(view.dms).toEqual({ enabled: false, unlinked: 'off', servers: [], clusters: [] });
    expect(store.fenceFor('slack', { kind: 'channel', channelId: 'C0OPSDB' })).toBeUndefined();
  });

  it('saves the rules in a file only the server reads, and reads them back', async () => {
    const { dir, store, file } = await fresh();
    const view = await store.save(
      {
        enabled: true,
        channels: { slack: [opsDb], mattermost: [{ channelId: MM_CHANNEL, channelName: 'town', servers: '*', clusters: [], reach: 'read', approvers: 'linked', historyFrom: [] }] },
        dms: { enabled: true, unlinked: 'read', servers: ['web-1'], clusters: [] },
        limits: { personNewPerHour: 5 },
        monthlyTokenBudget: 500_000,
        approvalWaitMinutes: 30,
      },
      'maria',
    );
    expect(view.channels.slack[0]).toEqual({ ...opsDb, channelName: 'ops-db' });
    expect(view.limits.personNewPerHour).toBe(5);
    expect(view.limits.channelPerHour).toBe(30);
    expect(view.changedBy).toBe('maria');
    if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o777).toBe(0o600);

    const again = new ChatAnsweringStore(dir, { clock: () => NOW });
    await again.initialize();
    expect(again.view()).toEqual(view);
  });

  it('checks everything before it saves anything', async () => {
    const { store } = await fresh();
    await store.save({ enabled: true, channels: { slack: [opsDb] } }, 'maria');
    await expect(store.save({ channels: { slack: [{ ...opsDb, channelId: 'not a channel' }] } }, 'maria')).rejects.toThrow('not a Slack channel id');
    await expect(store.save({ channels: { slack: [opsDb, opsDb] } }, 'maria')).rejects.toThrow('in the list twice');
    await expect(store.save({ channels: { slack: [{ ...opsDb, reach: 'auto' as never }] } }, 'maria')).rejects.toThrow('read, ask or plan');
    await expect(store.save({ channels: { slack: [{ ...opsDb, approvers: 'anyone' as never }] } }, 'maria')).rejects.toThrow('who may approve');
    await expect(store.save({ channels: { slack: [{ ...opsDb, historyFrom: ['bad id'] }] } }, 'maria')).rejects.toThrow('not a channel id');
    await expect(store.save({ channels: { mattermost: [{ ...opsDb }] } }, 'maria')).rejects.toThrow('not a Mattermost channel id');
    await expect(store.save({ limits: { concurrentRuns: 100 } }, 'maria')).rejects.toThrow('from 1 to 16');
    await expect(store.save({ limits: { personMessagesPerHour: 0 } }, 'maria')).rejects.toThrow('from 1 to 500');
    await expect(store.save({ approvalWaitMinutes: 5000 }, 'maria')).rejects.toThrow('from 1 to 1440');
    await expect(store.save({ monthlyTokenBudget: 10 }, 'maria')).rejects.toThrow('monthly token budget');
    await expect(store.save({ dms: { unlinked: 'write' as never } }, 'maria')).rejects.toThrow('read only or off');
    await expect(store.save({ enabled: false, limits: { concurrentRuns: 0 } }, 'maria')).rejects.toThrow();
    // Nothing of the failed saves stuck, not even the part that was fine.
    expect(store.view().enabled).toBe(true);
    expect(store.view().channels.slack).toHaveLength(1);
  });

  it('gives every conversation in a channel its fence, with who may approve copied in', async () => {
    const { store } = await fresh();
    await store.save({ enabled: true, channels: { slack: [opsDb, { ...opsDb, channelId: 'C0PLAN', channelName: 'plans', reach: 'plan', approvers: 'linked', servers: '*', historyFrom: ['C0OPSDB', 'C0PLAN'] }] } }, 'maria');
    expect(store.fenceFor('slack', { kind: 'channel', channelId: 'C0OPSDB' })).toEqual({
      servers: ['db-1', 'db-2'],
      clusters: ['postgres'],
      reach: 'ask',
      historyFrom: ['C0OPSDB'],
      approvers: 'admins',
    });
    expect(store.fenceFor('slack', { kind: 'channel', channelId: 'C0PLAN' })).toMatchObject({ servers: '*', reach: 'plan', approvers: 'linked', historyFrom: ['C0OPSDB', 'C0PLAN'] });
    expect(store.fenceFor('slack', { kind: 'channel', channelId: 'C0OTHER' })).toBeUndefined();
    expect(store.fenceFor('mattermost', { kind: 'channel', channelId: 'C0OPSDB' })).toBeUndefined();
    // A fence is a copy: changing it changes no rule.
    const fence = store.fenceFor('slack', { kind: 'channel', channelId: 'C0OPSDB' })!;
    (fence.servers as string[]).push('prod-1');
    expect(store.channelRule('slack', 'C0OPSDB')!.servers).toEqual(['db-1', 'db-2']);
    // Answering switched off: no channel has a fence.
    await store.save({ enabled: false }, 'maria');
    expect(store.fenceFor('slack', { kind: 'channel', channelId: 'C0OPSDB' })).toBeUndefined();
  });

  it('answers direct messages as the administrator chose', async () => {
    const { store } = await fresh();
    await store.save({ enabled: true, dms: { enabled: false, unlinked: 'read', servers: ['web-1'], clusters: ['web'] } }, 'maria');
    expect(store.fenceFor('slack', { kind: 'dm', linked: true })).toBeUndefined();
    await store.save({ dms: { enabled: true } }, 'maria');
    expect(store.fenceFor('slack', { kind: 'dm', linked: false })).toEqual({ servers: ['web-1'], clusters: ['web'], reach: 'read', historyFrom: [], approvers: 'linked' });
    expect(store.fenceFor('slack', { kind: 'dm', linked: true })).toEqual({ servers: '*', clusters: [], reach: 'ask', historyFrom: [], approvers: 'linked' });
    await store.save({ dms: { unlinked: 'off' } }, 'maria');
    expect(store.fenceFor('mattermost', { kind: 'dm', linked: false })).toBeUndefined();
    expect(store.fenceFor('mattermost', { kind: 'dm', linked: true })?.reach).toBe('ask');
    expect(dmFence({ enabled: true, unlinked: 'read', servers: '*', clusters: [] }, false).reach).toBe('read');
    expect(fenceFromRule({ ...opsDb, historyFrom: [] }).historyFrom).toEqual(['C0OPSDB']);
  });

  it('counts per person and per channel over the last hour', async () => {
    const { store, clock } = await fresh();
    await store.save({ limits: { personNewPerHour: 2 } }, 'maria');
    expect(store.take('person-new', 'slack:U1')).toBe(true);
    clock.add(10 * 60_000);
    expect(store.take('person-new', 'slack:U1')).toBe(true);
    expect(store.may('person-new', 'slack:U1')).toBe(false);
    expect(store.take('person-new', 'slack:U1')).toBe(false);
    expect(store.may('person-new', 'slack:U2')).toBe(true);
    // The first one leaves the window an hour after it was counted.
    clock.add(50 * 60_000);
    expect(store.may('person-new', 'slack:U1')).toBe(true);
    for (let i = 0; i < 30; i++) store.count('channel', 'slack:C1');
    expect(store.may('channel', 'slack:C1')).toBe(false);
    // "Not turned on here" is said once an hour per channel.
    expect(store.take('off-reply', 'slack:C9')).toBe(true);
    expect(store.take('off-reply', 'slack:C9')).toBe(false);
    clock.add(3600_000);
    expect(store.take('off-reply', 'slack:C9')).toBe(true);
  });

  it('keeps the month’s budget across a restart, and starts a new month from nothing', async () => {
    const { dir, store, clock } = await fresh();
    await store.save({ monthlyTokenBudget: 100_000 }, 'maria');
    await store.addUsage(60_000);
    expect(store.budgetLeft()).toBe(40_000);
    await store.addUsage(50_000);
    expect(store.withinBudget()).toBe(false);
    await store.addUsage(-5);
    await store.addUsage(Number.NaN);

    const again = new ChatAnsweringStore(dir, { clock: () => NOW });
    await again.initialize();
    expect(again.view().usage).toEqual({ month: '2026-11', tokens: 110_000 });
    expect(again.withinBudget()).toBe(false);

    clock.set(Date.parse('2026-12-01T00:00:01Z'));
    expect(store.withinBudget()).toBe(true);
    expect(store.view().usage).toEqual({ month: '2026-12', tokens: 0 });
  });

  it('leaves out a rule from a changed file that no longer passes the checks', async () => {
    const { dir, file } = await fresh();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({
        version: 1,
        settings: {
          enabled: true,
          channels: { slack: [opsDb, { ...opsDb, channelId: 'bad id' }, { ...opsDb, channelId: 'C0AUTO', reach: 'auto' }] },
          limits: { concurrentRuns: 999 },
          monthlyTokenBudget: -1,
        },
        usage: { month: '2026-11', tokens: 5 },
      }),
    );
    const store = new ChatAnsweringStore(dir, { clock: () => NOW });
    await store.initialize();
    const view = store.view();
    expect(view.channels.slack.map((r) => r.channelId)).toEqual(['C0OPSDB']);
    expect(view.limits).toEqual(DEFAULT_CHAT_LIMITS);
    expect(view.monthlyTokenBudget).toBe(DEFAULT_CHAT_BUDGET);
    expect(view.usage.tokens).toBe(5);
  });
});
