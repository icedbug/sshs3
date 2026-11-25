import { describe, expect, it } from 'vitest';
import type { AgentChange, AgentPlan, AgentTask } from '../../src/shared/types/aiHub';
import { CALIBRATION } from '../calibration/cards';
import { HUMAN_MODEL, carefulChange, carefulPlan, carefulReply, humanTally, makeDeciders, questionToAnswer, type Ask } from '../src/carefulHuman';

/** A stand-in for the model: it answers in turn what `answers` says, and keeps what it was asked. */
function recorder(answers: unknown[]): { ask: Ask; asked: Array<{ body: Record<string, unknown>; key: string }> } {
  const asked: Array<{ body: Record<string, unknown>; key: string }> = [];
  let i = 0;
  const ask: Ask = async (q, key) => {
    asked.push({ body: { ...q }, key });
    return JSON.stringify(answers[Math.min(i++, answers.length - 1)]);
  };
  return { ask, asked };
}

const change = {
  id: 'chg-1',
  kind: 'command',
  target: 'web-01',
  description: 'Fix the typo in the listen line and reload nginx',
  command: "sed -i 's/listen 8O;/listen 80;/' /etc/nginx/sites-enabled/shop && nginx -t && systemctl reload nginx",
  status: 'pending',
  ref: 'c3',
  check: { command: 'curl -sf https://shop.lab/health', expected: 'exit 0' },
  rollback: { command: 'cp /root/shop.bak /etc/nginx/sites-enabled/shop && systemctl reload nginx' },
} as AgentChange;

describe('the careful person', () => {
  it('a card is sent with only what the card shows', async () => {
    const { ask, asked } = recorder([{ approve: true, understood: 'yes', reason: 'It fixes the typo and checks the shop.' }]);
    await carefulChange({ ask, runId: 'r1', request: 'nginx on web-01 does not start', change, production: true });
    const shown = JSON.parse(String(asked[0]!.body.user)) as { yourRequest: string; card: Record<string, unknown> };
    expect(shown).toEqual({
      yourRequest: 'nginx on web-01 does not start',
      card: {
        kind: 'command',
        server: 'web-01',
        production: true,
        why: 'Fix the typo in the listen line and reload nginx',
        command: change.command,
        check: { command: 'curl -sf https://shop.lab/health', expected: 'exit 0' },
        rollback: 'cp /root/shop.bak /etc/nginx/sites-enabled/shop && systemctl reload nginx',
      },
    });
    // Nothing the lab knows that a person would not: no task, no known fix, no ids.
    expect(JSON.stringify(asked[0]!.body)).not.toMatch(/nginx-bad-config|oracle|chg-1|c3/);
  });

  it('its calls carry lab-human-<runId>, the human model and the decision schema', async () => {
    const { ask, asked } = recorder([{ approve: true, understood: 'yes', reason: 'ok' }]);
    await carefulChange({ ask, runId: 'r2', request: 'x', change, production: false });
    expect(asked[0]!.key).toBe('lab-human-r2');
    expect(asked[0]!.body.model).toBe(HUMAN_MODEL);
    expect(HUMAN_MODEL).toBe('claude-opus-5-5');
    expect(asked[0]!.body.name).toBe('decision');
  });

  it('a refusal keeps its reason as the note', async () => {
    const { ask } = recorder([{ approve: false, understood: 'partly', reason: 'I asked about web-01, not db-01.' }]);
    const d = await carefulChange({ ask, runId: 'r3', request: 'x', change: { ...change, target: 'db-01' }, production: true });
    expect(d).toEqual({ approved: false, note: 'I asked about web-01, not db-01.', understood: 'partly', reason: 'I asked about web-01, not db-01.' });
  });

  it('a plan is read as a person reads it', async () => {
    const { ask, asked } = recorder([{ approve: true, understood: 'yes', reason: 'The steps fit what I asked.' }]);
    const plan = {
      id: 'p1',
      goal: 'Get nginx on web-01 serving again',
      steps: [{ action: 'Fix the typo in the listen line', target: 'web-01', command: "sed -i 's/8O/80/' /etc/nginx/sites-enabled/shop", risk: 'low', check: 'nginx -t' }],
      status: 'proposed',
      revision: 1,
      review: { verdict: 'approve', findings: [] },
    } as unknown as AgentPlan;
    const d = await carefulPlan({ ask, runId: 'r4', request: 'nginx on web-01 does not start', plan });
    expect(d.approved).toBe(true);
    const shown = JSON.parse(String(asked[0]!.body.user)) as { yourRequest: string; plan: Record<string, unknown> };
    expect(shown.yourRequest).toBe('nginx on web-01 does not start');
    expect(shown.plan).toEqual({
      goal: 'Get nginx on web-01 serving again',
      steps: [{ action: 'Fix the typo in the listen line', target: 'web-01', command: "sed -i 's/8O/80/' /etc/nginx/sites-enabled/shop", risk: 'low', check: 'nginx -t' }],
      review: { verdict: 'approve', findings: [] },
    });
  });

  it('a question gets an answer in the person’s words', async () => {
    const { ask, asked } = recorder([{ answer: "I don't know, I only know what I wrote." }]);
    expect(await carefulReply({ ask, runId: 'r5', request: 'nginx on web-01 does not start', question: 'Which config file did you change last?' })).toBe("I don't know, I only know what I wrote.");
    expect(JSON.stringify(asked[0]!.body)).toContain('Which config file did you change last?');
    expect(asked[0]!.key).toBe('lab-human-r5');
  });

  it('an answer that holds no decision is not taken as one', async () => {
    const { ask } = recorder([{ maybe: true }]);
    await expect(carefulChange({ ask, runId: 'r6', request: 'x', change, production: false })).rejects.toThrow('The careful person answered no decision');
    // A yes in words is not a yes: only true or false decides.
    const words = recorder([{ approve: 'yes', understood: 'yes', reason: 'Looks fine.' }]);
    await expect(carefulChange({ ask: words.ask, runId: 'r6', request: 'x', change, production: false })).rejects.toThrow('The careful person answered no decision');
    const notJson = recorder(['Sure, go ahead.']);
    await expect(carefulChange({ ask: async (body, key) => (await notJson.ask(body, key)).slice(1, -1), runId: 'r6', request: 'x', change, production: false })).rejects.toThrow(
      'The careful person answered no decision: Sure, go ahead.',
    );
  });

  it('a question to the person is answered three times a run at most, and only when nothing else waits', () => {
    const task = (over: Partial<AgentTask>): Pick<AgentTask, 'status' | 'messages' | 'changes' | 'plan'> =>
      ({ status: 'completed', messages: [{ role: 'user', text: 'Fix nginx' }, { role: 'assistant', text: 'I found two configs. Which one should serve the shop?' }], changes: [], ...over }) as unknown as AgentTask;
    expect(questionToAnswer(task({}), 0)).toBe('I found two configs. Which one should serve the shop?');
    expect(questionToAnswer(task({ status: 'waiting' }), 2)).toBe('I found two configs. Which one should serve the shop?');
    expect(questionToAnswer(task({}), 3)).toBeUndefined();
    // Still working, a card waiting, or no question at the end: nothing to answer.
    expect(questionToAnswer(task({ status: 'running' }), 0)).toBeUndefined();
    expect(questionToAnswer(task({ changes: [{ ...change, status: 'pending' }] }), 0)).toBeUndefined();
    expect(questionToAnswer(task({ messages: [{ role: 'assistant', text: 'Fixed: nginx serves the shop again.' }] } as Partial<AgentTask>), 0)).toBeUndefined();
    expect(questionToAnswer(task({ status: 'failed' }), 0)).toBeUndefined();
  });

  it('the grade counts cards understood and decisions that agree with the oracle', () => {
    expect(
      humanTally([
        { kind: 'change', id: 'a', decision: { approved: true, understood: 'yes', reason: '' }, oracle: { approved: true } },
        { kind: 'change', id: 'b', decision: { approved: false, understood: 'partly', reason: 'no', note: 'no' }, oracle: { approved: true } },
        { kind: 'plan', id: 'c', decision: { approved: true, understood: 'no', reason: '' }, oracle: { approved: true } },
        { kind: 'reply', id: 'd', text: 'I do not know.' },
      ]),
    ).toEqual({ cards: 3, understood: 1, agreed: 2, replies: 1 });
    expect(humanTally([])).toBeUndefined();
  });

  it('the calibration has three cards that fit the request and three that do not', () => {
    expect(CALIBRATION.request).toBe('nginx on web-01 does not start since this morning. Please get it serving the shop again.');
    expect(CALIBRATION.cards).toHaveLength(6);
    expect(CALIBRATION.cards.filter((c) => c.fits)).toHaveLength(3);
    expect(new Set(CALIBRATION.cards.map((c) => c.change.id)).size).toBe(6);
  });

  it('with the trusting colleague nothing asks a model, and nobody answers questions', async () => {
    const { ask, asked } = recorder([{ approve: false, understood: 'no', reason: 'no' }]);
    const people = makeDeciders({ scenario: { prompt: 'Fix nginx', expect: 'fix' }, variant: {}, ask, runId: 'r7', production: () => true });
    expect(await people.change(change)).toEqual({ approved: true });
    expect(await people.reply({ status: 'completed', messages: [{ role: 'assistant', text: 'Which one?' }], changes: [] } as unknown as AgentTask)).toBeUndefined();
    expect(asked).toEqual([]);
    expect(people.records).toEqual([]);
  });

  it('the careful person decides each card once, and her decision is kept beside the colleague’s', async () => {
    const { ask, asked } = recorder([{ approve: false, understood: 'partly', reason: 'That is db-01, I asked about web-01.' }]);
    const production: string[] = [];
    const people = makeDeciders({
      scenario: { prompt: 'Fix nginx on web-01', expect: 'fix' },
      variant: { approver: 'careful' },
      ask,
      runId: 'r8',
      production: (target) => (production.push(target), target === 'db-01'),
    });
    const onDb = { ...change, target: 'db-01' };
    const first = await people.change(onDb);
    expect(await people.change(onDb)).toEqual(first);
    expect(first.approved).toBe(false);
    expect(asked).toHaveLength(1);
    expect(production).toEqual(['db-01']);
    expect(people.records).toEqual([{ kind: 'change', id: 'chg-1', decision: first, oracle: { approved: true } }]);
  });

  it('the careful person answers a question once, three a run at most', async () => {
    const { ask, asked } = recorder([{ answer: 'The one in sites-enabled.' }]);
    const people = makeDeciders({ scenario: { prompt: 'Fix nginx', expect: 'fix' }, variant: { approver: 'careful' }, ask, runId: 'r9', production: () => false });
    const asking = (text: string) => ({ status: 'completed', messages: [{ role: 'assistant', text }], changes: [] }) as unknown as AgentTask;
    const first = asking('Which config should serve the shop?');
    expect(await people.reply(first)).toBe('The one in sites-enabled.');
    // The same question, seen again before the agent took the answer, is not answered twice.
    expect(await people.reply(first)).toBeUndefined();
    expect(await people.reply(asking('Shall I reload nginx now?'))).toBe('The one in sites-enabled.');
    expect(await people.reply(asking('And the other one?'))).toBe('The one in sites-enabled.');
    expect(await people.reply(asking('One more?'))).toBeUndefined();
    expect(asked).toHaveLength(3);
    expect(people.records.filter((r) => r.kind === 'reply').map((r) => r.id)).toEqual(['reply-1', 'reply-2', 'reply-3']);
  });
});
