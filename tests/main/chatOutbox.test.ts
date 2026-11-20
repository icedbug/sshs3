import { describe, expect, it } from 'vitest';
import { ChatError } from '../../src/main/ai/hub/ChatSources';
import { ChatOutbox, type OutboxApi, type OutboxKind } from '../../src/main/web/chatAgent/ChatOutbox';
import { note, type ChatOut } from '../../src/main/web/chatAgent/chatFormat';

/**
 * The agent bot's posts wait their turn per channel: Slack's pace, a pause when a service asks for one,
 * a bounded line where only status edits and notes are ever dropped, and no error thrown at the caller.
 */

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function fakeTime() {
  let now = 0;
  let next = 0;
  const timers: Array<{ id: number; at: number; fn: () => void }> = [];
  return {
    clock: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const id = ++next;
      timers.push({ id, at: now + ms, fn });
      return id;
    },
    clearTimer: (h: unknown) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        await flush();
        timers.sort((a, b) => a.at - b.at);
        const t = timers[0];
        if (!t || t.at > end) break;
        timers.shift();
        now = t.at;
        t.fn();
      }
      now = end;
      await flush();
    },
    pendingTimers: () => timers.length,
  };
}

interface Call {
  at: number;
  method: string;
  channel: string;
  text: string;
  id?: string;
}

function fakeApi(time: { clock(): number }, fail: (method: string, n: number) => unknown = () => undefined) {
  const calls: Call[] = [];
  let n = 0;
  let posts = 0;
  const record = (method: string, channel: string, text: string, id?: string): void => {
    n++;
    const error = fail(method, n);
    calls.push({ at: time.clock(), method, channel, text, ...(id ? { id } : {}) });
    if (error) throw error;
  };
  const api: OutboxApi = {
    slackPost: async (_a, m) => {
      record('slackPost', m.channel, m.text);
      return { channel: m.channel, ts: `1700000000.00000${++posts}` };
    },
    slackUpdate: async (_a, m) => record('slackUpdate', m.channel, m.text, m.ts),
    slackEphemeral: async (_a, m) => record('slackEphemeral', m.channel, m.text, m.user),
    mmPost: async (_a, p) => {
      record('mmPost', p.channelId, p.message);
      return { id: `post${++posts}` };
    },
    mmPatch: async (_a, id, p) => record('mmPatch', '', p.message ?? '', id),
    mmReact: async (_a, r) => record('mmReact', '', r.emoji, r.postId),
  };
  return { api, calls };
}

const AUTH = {
  slack: () => ({ botToken: 'xoxb-test', appToken: 'xapp-test' }),
  mattermost: () => ({ baseUrl: 'http://127.0.0.1:1', token: 'mmtoken123' }),
};
const S = (text: string): ChatOut => note('slack', text);
const M = (text: string): ChatOut => note('mattermost', text);

function setup(options: { fail?: (method: string, n: number) => unknown; maxQueue?: number } = {}) {
  const time = fakeTime();
  const { api, calls } = fakeApi(time, options.fail);
  const errors: Array<{ error: unknown; kind: OutboxKind }> = [];
  const dropped: Array<{ kind: OutboxKind; op: string }> = [];
  const outbox = new ChatOutbox({
    api,
    auth: AUTH,
    clock: time.clock,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    maxQueue: options.maxQueue,
    onError: (error, item) => errors.push({ error, kind: item.kind }),
    onDropped: (item) => dropped.push({ kind: item.kind, op: item.op }),
  });
  return { time, calls, errors, dropped, outbox };
}

describe('ChatOutbox', () => {
  it('posts in Slack at least 1.1 s apart per channel, and other channels do not wait', async () => {
    const { time, calls, outbox } = setup();
    const ids = [outbox.post('slack', 'C1', S('one')), outbox.post('slack', 'C1', S('two')), outbox.post('slack', 'C1', S('three')), outbox.post('slack', 'C2', S('other'))];
    await time.advance(5000);
    expect(calls.map((c) => [c.channel, c.text, c.at])).toEqual([
      ['C1', 'one', 0],
      ['C2', 'other', 0],
      ['C1', 'two', 1100],
      ['C1', 'three', 2200],
    ]);
    expect(await Promise.all(ids)).toEqual(['1700000000.000001', '1700000000.000003', '1700000000.000004', '1700000000.000002']);
  });

  it('edits at least 3 s apart, and a newer edit of a post takes the place of one still waiting', async () => {
    const { time, calls, outbox } = setup();
    const first = outbox.edit('slack', 'C1', '1700000000.000001', S('step 1'));
    const second = outbox.edit('slack', 'C1', '1700000000.000001', S('step 2'));
    const third = outbox.edit('slack', 'C1', '1700000000.000001', S('step 3'));
    await time.advance(10_000);
    expect(calls.map((c) => [c.text, c.at])).toEqual([
      ['step 1', 0],
      ['step 3', 3000],
    ]);
    expect(await Promise.all([first, second, third])).toEqual([true, true, true]);
  });

  it('keeps a smaller gap in Mattermost, and reacts there', async () => {
    const { time, calls, outbox } = setup();
    void outbox.post('mattermost', 'ch1', M('a'));
    void outbox.post('mattermost', 'ch1', M('b'));
    void outbox.react('ch1', 'post1', 'eyes', 'botuser');
    await time.advance(2000);
    expect(calls.map((c) => [c.method, c.at])).toEqual([
      ['mmPost', 0],
      ['mmPost', 250],
      ['mmReact', 500],
    ]);
  });

  it('waits as long as the service asks, then tries the same message again', async () => {
    const { time, calls, errors, outbox } = setup({ fail: (_m, n) => (n === 1 ? new ChatError('Slow down', 429, 5000) : undefined) });
    const id = outbox.post('slack', 'C1', S('hello'));
    void outbox.post('slack', 'C1', S('after'));
    await time.advance(4000);
    expect(calls).toHaveLength(1);
    await time.advance(10_000);
    expect(calls.map((c) => [c.text, c.at])).toEqual([
      ['hello', 0],
      ['hello', 5000],
      ['after', 6100],
    ]);
    expect(await id).toBe('1700000000.000001');
    expect(errors).toEqual([]);
  });

  it('tries a card, an answer and an edit again after a lost connection or a fault, but not a note', async () => {
    // The card fails twice (status 0, then 503), then the note and the edit once each.
    const { time, calls, errors, outbox } = setup({
      fail: (_m, n) => (n === 1 ? new ChatError('Slack did not answer in time.', 0) : n === 2 ? new ChatError('Slack answered 503.', 503) : n === 4 || n === 5 ? new ChatError('Slack answered 502.', 502) : undefined),
    });
    const card = outbox.post('slack', 'C1', S('card'), { kind: 'card' });
    await time.advance(10_000);
    expect(await card).toBe('1700000000.000001');
    const shortNote = outbox.post('slack', 'C1', S('note'));
    await time.advance(10_000);
    expect(await shortNote).toBeUndefined();
    const edit = outbox.edit('slack', 'C1', '1700000000.000001', S('edited'), { kind: 'card' });
    await time.advance(10_000);
    expect(await edit).toBe(true);
    expect(calls.map((c) => c.text)).toEqual(['card', 'card', 'card', 'note', 'edited', 'edited']);
    // The second wait is longer than the first.
    expect(calls[2].at - calls[1].at).toBeGreaterThan(calls[1].at - calls[0].at);
    expect(errors.map((e) => e.kind)).toEqual(['note']);
  });

  it('reports a failure to the callback and goes on with the next message, never throwing', async () => {
    const { time, calls, errors, outbox } = setup({ fail: (_m, n) => (n === 1 ? new ChatError('The agent bot is not in that channel.', 400) : n === 2 ? new Error('boom') : undefined) });
    const a = outbox.post('slack', 'C1', S('a'));
    const b = outbox.edit('slack', 'C1', '1700000000.000009', S('b'));
    const c = outbox.post('slack', 'C1', S('c'));
    await time.advance(5000);
    expect(await a).toBeUndefined();
    expect(await b).toBe(false);
    expect(await c).toBe('1700000000.000001');
    expect(errors.map((e) => (e.error as Error).message)).toEqual(['The agent bot is not in that channel.', 'boom']);
    expect(calls).toHaveLength(3);
  });

  it('without credentials, says so to the callback and sends nothing', async () => {
    const time = fakeTime();
    const { api, calls } = fakeApi(time);
    const errors: unknown[] = [];
    const outbox = new ChatOutbox({ api, auth: { slack: () => undefined, mattermost: () => undefined }, clock: time.clock, setTimer: time.setTimer, clearTimer: time.clearTimer, onError: (e) => errors.push(e) });
    const id = outbox.post('slack', 'C1', S('x'));
    await time.advance(100);
    expect(await id).toBeUndefined();
    expect(calls).toEqual([]);
    expect((errors[0] as ChatError).status).toBe(401);
  });

  it('drops status edits first and notes next when a line is full, never a card or an answer', async () => {
    const { time, calls, dropped, outbox } = setup({ maxQueue: 3 });
    void outbox.post('slack', 'C1', S('card 1'), { kind: 'card' });
    const answer = outbox.post('slack', 'C1', S('answer'), { kind: 'answer' });
    const edits = [1, 2, 3, 4, 5].map((i) => outbox.edit('slack', 'C1', `1700000000.00000${i}`, S(`status ${i}`)));
    const noteSent = outbox.post('slack', 'C1', S('a note'), { kind: 'note' });
    const cards = [2, 3, 4].map((i) => outbox.post('slack', 'C1', S(`card ${i}`), { kind: 'card' }));
    await time.advance(60_000);
    expect(await Promise.all(edits.slice(0, 4))).toEqual([false, false, false, false]);
    expect(await edits[4]).toBe(false);
    expect(await noteSent).toBeUndefined();
    expect(await answer).toBeDefined();
    expect((await Promise.all(cards)).every(Boolean)).toBe(true);
    expect(calls.map((c) => c.text)).toEqual(['card 1', 'answer', 'card 2', 'card 3', 'card 4']);
    expect(dropped.map((d) => d.kind)).toEqual(['status', 'status', 'status', 'status', 'status', 'note']);
  });

  it('stop() drops what waits, lets what is on its way finish, and takes nothing after', async () => {
    const { time, calls, dropped, outbox } = setup();
    const first = outbox.post('slack', 'C1', S('first'));
    const second = outbox.post('slack', 'C1', S('second'));
    const stopped = outbox.stop();
    await time.advance(0);
    await stopped;
    expect(await first).toBeDefined();
    expect(await second).toBeUndefined();
    expect(await outbox.post('slack', 'C1', S('late'))).toBeUndefined();
    await time.advance(10_000);
    expect(calls.map((c) => c.text)).toEqual(['first']);
    expect(dropped).toHaveLength(2);
    expect(time.pendingTimers()).toBe(0);
  });

  it('stop({ drain }) sends what is queued first', async () => {
    const { time, calls, outbox } = setup();
    void outbox.post('slack', 'C1', S('one'));
    void outbox.post('slack', 'C1', S('two'));
    const stopped = outbox.stop({ drain: true });
    await time.advance(2000);
    await stopped;
    expect(calls.map((c) => c.text)).toEqual(['one', 'two']);
    expect(time.pendingTimers()).toBe(0);
  });

  it('sends a Slack note only one person sees', async () => {
    const { time, calls, outbox } = setup();
    const ok = outbox.ephemeral('C1', 'U123', S('Link your account first.'), { threadId: '1700000000.000001' });
    await time.advance(10);
    expect(await ok).toBe(true);
    expect(calls[0]).toMatchObject({ method: 'slackEphemeral', id: 'U123' });
  });
});
