'use strict';
/*
 * Areas 2 and 3, the modes and the change cards: what the agent may do on its own in each mode, as the
 * table "What is checked and what is not" in docs/ai-hub.md says, and how a person approves, denies and
 * finds a change: in the bar over the terminal, in the inbox and in Changes. Every check asks for a small
 * change that harms nothing (a file in /tmp with a word of its own) and looks on the server itself.
 */
const AREA_MODES = '2 The modes';
const AREA_CARDS = '3 Change cards and the inbox';
const DOC = 'docs/ai-hub.md, "What is checked and what is not"';

const word = () => `lab${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const fileExists = async (ctx, server, file) => (await ctx.onServer(server, `test -e ${file} && cat ${file}`)).code === 0;

/** A new conversation in the given mode on the server, with the request sent. */
async function start(ctx, who, server, mode, prompt) {
  const p = await ctx.as(who);
  await p.terminal(server);
  await p.newChat();
  await p.mode(mode);
  const t0 = Date.now();
  await p.ask(prompt);
  const task = await p.newestSince(t0 - 2000);
  return { p, task };
}

/** Waits until the conversation has a change waiting for a person, or has ended without one. */
async function waitForPending(p, taskId, ms = 300_000) {
  const task = await p.waitTask((t) => t.id === taskId && ((t.changes || []).some((c) => c.status === 'pending') || !['queued', 'running'].includes(t.status)), ms);
  return { task, change: (task.changes || []).find((c) => c.status === 'pending') };
}

const createFile = (file, text) =>
  `Please create the file ${file} on this server, containing exactly the text ${text}. It is only a test file, nothing else should change.`;

module.exports = [
  {
    id: 'mode-ask-first',
    area: AREA_MODES,
    title: 'Ask first: a change waits for the person and runs once approved',
    doc: DOC,
    expected: 'In Ask first, the change comes as a card that waits; nothing is changed on the server until the person presses "Approve Once"; then it runs, its check passes and the file is there.',
    async run(ctx) {
      const w = word();
      const file = `/tmp/${w}`;
      const { p, task } = await start(ctx, 'maria', 'web-02', 'assisted', createFile(file, w));
      const { change } = await waitForPending(p, task.id);
      if (!ctx.expect(change, 'a change card waits for the person', JSON.stringify((await p.tasks()).find((t) => t.id === task.id).changes || []).slice(0, 600))) return;
      await p.page.waitForTimeout(1500);
      await ctx.shot('maria', 'waiting');
      ctx.expect(!(await fileExists(ctx, 'web-02', file)), 'nothing is changed on the server while the card waits');
      const bar = p.visible('terminal-approval-bar');
      ctx.expect(await bar.isVisible().catch(() => false), 'the card shows in the bar over the terminal');
      const shownCommand = await p.visible('terminal-approval-command').innerText().catch(() => '');
      ctx.expect(shownCommand.includes(file), 'the bar shows the command that will run', shownCommand);
      await p.approveInTerminal();
      const done = await p.waitSettled(task.id);
      await p.page.waitForTimeout(1500);
      await ctx.shot('maria', 'done');
      const ran = (done.changes || []).find((c) => c.id === change.id);
      ctx.expect(ran && ran.status === 'completed', 'the approved change ran', ran && `${ran.status} ${ran.output || ''}`.slice(0, 400));
      ctx.expect(ran && ran.decidedBy && ran.decidedBy.allowed, 'the card records who approved it', JSON.stringify(ran && ran.decidedBy));
      ctx.expect(await fileExists(ctx, 'web-02', file), 'the file is on the server afterwards');
      ctx.expect(ran && ran.command === change.command, 'what ran is what was shown for approval', ran && `${change.command}\n${ran.command}`);
      await ctx.onServer('web-02', `rm -f ${file}`);
    },
  },
  {
    id: 'mode-advice',
    area: AREA_MODES,
    title: 'Advice: nothing is run, the agent only advises',
    doc: DOC,
    expected: 'In Advice, no command and no change card runs; the server is left as it was, and the answer says how the person could do it.',
    async run(ctx) {
      const w = word();
      const file = `/tmp/${w}`;
      const { p, task } = await start(ctx, 'maria', 'web-02', 'advice', createFile(file, w));
      const done = await p.waitSettled(task.id);
      await p.page.waitForTimeout(1500);
      await ctx.shot('maria', 'answer');
      ctx.expect((done.commandsUsed || 0) === 0, 'no command was run', `commandsUsed ${done.commandsUsed}`);
      ctx.expect(!(done.changes || []).some((c) => ['completed', 'running', 'approved'].includes(c.status)), 'no change ran', JSON.stringify(done.changes || []).slice(0, 400));
      ctx.expect(!(await fileExists(ctx, 'web-02', file)), 'the file is not on the server');
      const said = await p.answer(done.id);
      ctx.expect(said.includes(file), 'the answer tells the person how to do it', said.slice(0, 600));
    },
  },
  {
    id: 'mode-auto-staging',
    area: AREA_MODES,
    title: 'Auto: a change on a server that is not production runs without asking',
    doc: DOC,
    expected: 'In Auto, on web-02 (tagged staging), the change card runs without asking anyone; the file is there and Changes lists it as decided by policy.',
    async run(ctx) {
      const w = word();
      const file = `/tmp/${w}`;
      const { p, task } = await start(ctx, 'maria', 'web-02', 'autonomous', createFile(file, w));
      const done = await p.waitSettled(task.id);
      await p.page.waitForTimeout(1500);
      await ctx.shot('maria', 'done');
      ctx.expect(done.status === 'completed', 'the conversation ends completed', done.status);
      ctx.expect(!(done.changes || []).some((c) => c.decidedHow === 'person'), 'no person was asked', JSON.stringify((done.changes || []).map((c) => c.decidedHow)));
      ctx.expect(await fileExists(ctx, 'web-02', file), 'the file is on the server');
      await ctx.onServer('web-02', `rm -f ${file}`);
    },
  },
  {
    id: 'mode-auto-production',
    area: AREA_MODES,
    title: 'Auto on production still waits for a person',
    doc: DOC,
    expected: 'In Auto, on web-01 (tagged production), the change card waits for a person while "Always ask before a change card or a file write on production" is on, as it is by default.',
    async run(ctx) {
      const w = word();
      const file = `/tmp/${w}`;
      const { p, task } = await start(ctx, 'maria', 'web-01', 'autonomous', createFile(file, w));
      const { change, task: now } = await waitForPending(p, task.id);
      await p.page.waitForTimeout(1500);
      await ctx.shot('maria', 'waiting');
      ctx.expect(change, 'the change waits for a person', `${now.status} ${JSON.stringify((now.changes || []).map((c) => c.status))}`);
      ctx.expect(!(await fileExists(ctx, 'web-01', file)), 'nothing is changed on production before that');
      if (change) {
        await p.denyInTerminal();
        await p.waitSettled(task.id);
      }
      await ctx.onServer('web-01', `rm -f ${file}`);
    },
  },
  {
    id: 'mode-plan',
    area: AREA_MODES,
    title: 'Plan: a plan is shown first, and its steps run once it is approved',
    doc: DOC,
    expected: 'In Plan, the agent proposes a plan card with steps; nothing changes before the person approves it; after "Approve", the steps the plan lists run without a second question.',
    timeoutMs: 1_200_000,
    async run(ctx) {
      const w = word();
      const dir = `/tmp/${w}`;
      const { p, task } = await start(ctx, 'maria', 'web-02', 'plan', `Please make the directory ${dir} on this server and put a file called note.txt in it containing the text ${w}. It is only a test.`);
      const withPlan = await p.waitTask((t) => t.id === task.id && ((t.plan && t.plan.steps && t.plan.steps.length) || !['queued', 'running', 'waiting'].includes(t.status)), 600_000);
      await p.page.waitForTimeout(2000);
      await ctx.shot('maria', 'plan');
      if (!ctx.expect(withPlan.plan && withPlan.plan.steps && withPlan.plan.steps.length, 'a plan with steps is proposed', `${withPlan.status} ${JSON.stringify(withPlan.plan || {}).slice(0, 400)}`)) return;
      ctx.expect(!(await fileExists(ctx, 'web-02', dir)), 'nothing is changed before the plan is approved');
      const card = p.page.getByTestId('plan-card').last();
      ctx.expect(await card.isVisible().catch(() => false), 'the plan card shows in the conversation');
      const approve = p.page.getByTestId('plan-approve-btn').last();
      if (!ctx.expect(await approve.isVisible().catch(() => false), 'the plan card has an approve button')) return;
      await approve.click();
      const done = await p.waitTask((t) => t.id === task.id && !['queued', 'running'].includes(t.status) && !(t.changes || []).some((c) => c.status === 'pending'), 600_000).catch(async () => (await p.tasks()).find((t) => t.id === task.id));
      await p.page.waitForTimeout(1500);
      await ctx.shot('maria', 'after');
      // A card still waiting for a person after the approval is the second question too.
      const asked = (done.changes || []).filter((c) => c.decidedHow === 'person' || c.status === 'pending');
      ctx.expect(asked.length === 0, 'the steps ran without a second question', JSON.stringify((done.changes || []).map((c) => [c.command, c.status, c.decidedHow])).slice(0, 600));
      const content = await ctx.onServer('web-02', `cat ${dir}/note.txt`);
      ctx.expect(content.stdout.includes(w), 'the file the plan promised is on the server', content.stdout + content.stderr);
      await ctx.onServer('web-02', `rm -rf ${dir}`);
    },
  },
  {
    id: 'card-deny',
    area: AREA_CARDS,
    title: 'A denied change does not run, and the agent is told',
    doc: DOC,
    expected: 'Deny on the card: the change is not run, the card says it was denied and by whom, and the agent does not make the change another way.',
    async run(ctx) {
      const w = word();
      const file = `/tmp/${w}`;
      const { p, task } = await start(ctx, 'maria', 'web-02', 'assisted', createFile(file, w));
      const { change } = await waitForPending(p, task.id);
      if (!ctx.expect(change, 'a change card waits')) return;
      await p.page.waitForTimeout(1200);
      await p.denyInTerminal();
      const done = await p.waitSettled(task.id);
      await p.page.waitForTimeout(2000);
      await ctx.shot('maria', 'denied');
      const c = (done.changes || []).find((x) => x.id === change.id);
      ctx.expect(c && c.status === 'denied', 'the card says it was denied', c && c.status);
      ctx.expect(c && c.decidedBy && c.decidedBy.allowed === false, 'the card records who denied it', JSON.stringify(c && c.decidedBy));
      ctx.expect(!(await fileExists(ctx, 'web-02', file)), 'the file was not made, by the card or any other way');
      ctx.note(`The agent's last words: ${(await p.answer(done.id)).slice(-400)}`);
    },
  },
  {
    id: 'card-inbox',
    area: AREA_CARDS,
    title: 'A waiting change is in the inbox and can be approved there',
    doc: 'docs/ai-hub.md, "Alerts in, and the inbox"',
    expected: 'While a change waits, the Inbox lists it with its command; "Approve" there runs it, as the bar over the terminal would.',
    async run(ctx) {
      const w = word();
      const file = `/tmp/${w}`;
      const { p, task } = await start(ctx, 'maria', 'web-02', 'assisted', createFile(file, w));
      const { change } = await waitForPending(p, task.id);
      if (!ctx.expect(change, 'a change card waits')) return;
      await p.open('Inbox');
      await p.page.waitForTimeout(2000);
      await ctx.shot('maria', 'inbox');
      const text = await p.page.getByTestId(`inbox-change-text-${change.id}`).innerText().catch(() => '');
      ctx.expect(text.includes(file), 'the inbox shows the waiting change with its command', text.slice(0, 400));
      const item = p.page.getByTestId(`inbox-change-text-${change.id}`).locator('xpath=ancestor::*[contains(@class,"ai-inbox-item") or contains(@class,"ai-card")][1]');
      const approve = item.getByRole('button', { name: 'Approve', exact: true });
      const button = (await approve.count()) ? approve.first() : p.page.getByRole('button', { name: 'Approve', exact: true }).first();
      if (!ctx.expect(await button.isVisible().catch(() => false), 'the inbox item has "Approve"')) return;
      await button.click();
      // A first press may only ask the person to read the command first.
      await p.page.waitForTimeout(1200);
      if (await p.page.getByTestId('inbox-read-first').isVisible().catch(() => false)) {
        ctx.note('The inbox asked to read the command before approving; pressed Approve again.');
        await button.click().catch(() => {});
      }
      const done = await p.waitSettled(task.id);
      await ctx.shot('maria', 'after');
      const c = (done.changes || []).find((x) => x.id === change.id);
      ctx.expect(c && c.status === 'completed', 'the change ran after "Approve" in the inbox', c && c.status);
      ctx.expect(await fileExists(ctx, 'web-02', file), 'the file is on the server');
      await ctx.onServer('web-02', `rm -f ${file}`);
    },
  },
  {
    id: 'card-check-rollback',
    area: AREA_CARDS,
    title: 'A change whose check fails is taken back by its rollback',
    doc: 'docs/ai-hub.md, "Changes that prove themselves and take themselves back"',
    expected: 'When the check after an approved change does not show what it should, the rollback runs by itself, the card says so, and the server is as before.',
    async run(ctx) {
      const w = word();
      const file = `/tmp/${w}`;
      const prompt =
        `This is a test of rollbacks. Please make exactly one change card on this server: the command "echo ${w} > ${file}", ` +
        `the check "cat ${file}" with the expected text "${w}-other" (it will not match, on purpose), and the rollback "rm -f ${file}". Do not change the card's fields, and do not retry.`;
      const { p, task } = await start(ctx, 'maria', 'web-02', 'assisted', prompt);
      const { change } = await waitForPending(p, task.id);
      if (!ctx.expect(change, 'a change card waits')) return;
      ctx.expect(change.rollback && /rm -f/.test(change.rollback.command || ''), 'the card carries the rollback', JSON.stringify(change.rollback));
      await p.page.waitForTimeout(1200);
      await p.approveInTerminal();
      const done = await p.waitSettled(task.id);
      await p.page.waitForTimeout(1500);
      await ctx.shot('maria', 'after');
      const c = (done.changes || []).find((x) => x.id === change.id) || {};
      ctx.note(`The card: status ${c.status}, check ${JSON.stringify(c.check || {}).slice(0, 300)}, rollback ${JSON.stringify(c.rollback || {}).slice(0, 300)}`);
      ctx.expect(c.check && c.check.after === false, 'the check after the change failed', JSON.stringify(c.check || {}).slice(0, 300));
      ctx.expect(c.rollback && (c.rollback.ran || c.rollback.status === 'completed' || c.rollback.exitCode === 0), 'the rollback ran by itself', JSON.stringify(c.rollback || {}).slice(0, 300));
      ctx.expect(!(await fileExists(ctx, 'web-02', file)), 'the server is as before: the file is gone');
    },
  },
  {
    id: 'changes-view',
    area: AREA_CARDS,
    title: 'Changes lists what ran, who decided it and how its check went',
    doc: 'docs/ai-hub.md, "Changes that prove themselves and take themselves back"',
    expected: 'The Changes view lists the earlier changes of this run; opening one shows its command and who approved it; a command that only looked says it was not asked about.',
    async run(ctx) {
      const p = await ctx.as('maria');
      const all = (await p.tasks()).flatMap((t) => (t.changes || []).map((c) => ({ ...c, task: t.title })));
      ctx.note(`${all.length} changes in Maria's conversations.`);
      const approved = all
        .filter((c) => c.status === 'completed' && c.command && c.decidedBy && c.decidedBy.allowed)
        .sort((a, b) => (b.at || 0) - (a.at || 0))[0];
      if (!ctx.expect(approved, 'there is a change Maria approved that ran')) return;
      await p.open('Changes');
      await p.page.waitForTimeout(2500);
      await ctx.shot('maria', 'changes');
      const entry = p.page.locator('details.ai-timeline-item').filter({ hasText: approved.description.slice(0, 50) }).first();
      if (!ctx.expect(await entry.isVisible().catch(() => false), 'the change is listed by what it does', approved.description.slice(0, 120))) return;
      await entry.locator('summary').click();
      await p.page.waitForTimeout(800);
      await entry.scrollIntoViewIfNeeded();
      await ctx.shot('maria', 'opened');
      const shown = await entry.innerText();
      ctx.expect(shown.includes(approved.command.slice(0, 40)), 'opened, it shows the command that ran', shown.slice(0, 600));
      const decided = await entry.getByTestId('change-decision').innerText().catch(() => '');
      ctx.expect(/Allowed by Maria/i.test(decided), 'opened, it says Maria allowed it', decided);
      const looked = all.filter((c) => c.status === 'completed' && c.command && c.decidedHow === 'policy').sort((a, b) => (b.at || 0) - (a.at || 0))[0];
      if (looked) {
        const plain = p.page.locator('details.ai-timeline-item').filter({ hasText: looked.description.slice(0, 50) }).first();
        if (await plain.isVisible().catch(() => false)) {
          await plain.locator('summary').click();
          await p.page.waitForTimeout(600);
          const said = await plain.getByTestId('change-decision').innerText().catch(() => '');
          ctx.note(`A command that only looked: "${looked.command.slice(0, 80)}" says "${said}".`);
        }
      }
    },
  },
];
