'use strict';
/*
 * Area 7, the workforce: a team of agents that works on tickets towards goals, a review where several
 * agents look at once, and jobs on a schedule. Lina sets things up; the board is shared with the team.
 */
const AREA = '7 Workforce and schedules';
const DOC = 'docs/ai-hub.md, "Workforce: goals, tickets and a team"';

const word = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

module.exports = [
  {
    id: 'workforce-template',
    area: AREA,
    title: 'Setting up a ready-made team adds its agents, a goal and tickets, for the whole team',
    doc: DOC,
    expected: '"Set up this team" on "Operate a system" adds its five agents, a goal and its first tickets; nothing runs until a ticket is started; Omar sees the same board.',
    async run(ctx) {
      const lina = await ctx.as('lina');
      await lina.open('Workforce');
      const before = await lina.snapshot();
      ctx.note(`Before: ${(before.agents || []).length} agents, ${(before.workTickets || []).length} tickets, ${(before.goals || before.workGoals || []).length} goals.`);
      await lina.page.getByTestId('workforce-template-operate-system').getByRole('button', { name: 'Set up this team' }).click();
      await lina.page.waitForTimeout(2500);
      await ctx.shot('lina', 'after');
      const after = await lina.snapshot();
      const names = (after.agents || []).map((a) => a.name);
      ctx.note(`After: agents ${names.join(', ')}; ${(after.workTickets || []).length} tickets.`);
      for (const n of ['Watch', 'Investigator', 'Operator', 'Reviewer']) ctx.expect(names.some((x) => x.includes(n)), `the team has its ${n}`);
      ctx.expect((after.workTickets || []).length > (before.workTickets || []).length, 'the template adds its first tickets');
      ctx.expect(!(after.tasks || []).some((t) => t.ticketId && ['running', 'queued'].includes(t.status)), 'nothing runs before a ticket is started');
      const omar = await ctx.as('omar');
      const seen = (await omar.snapshot()).workTickets || [];
      ctx.expect(seen.length === (after.workTickets || []).length, 'Omar sees the same tickets', `${seen.length} against ${(after.workTickets || []).length}`);
    },
  },
  {
    id: 'workforce-ticket',
    area: AREA,
    title: 'A ticket given to an agent is worked, reported, and closed by a person',
    doc: DOC,
    expected:
      'A new ticket for the Investigator about web-01 is started; the agent works it in a terminal of its own, reports, and the ticket waits in Review until a person decides; the report is about the right server and changes nothing.',
    timeoutMs: 1_500_000,
    async run(ctx) {
      const lina = await ctx.as('lina');
      const mark = word();
      await lina.open('Workforce');
      await lina.page.getByRole('button', { name: 'New ticket' }).click();
      const form = lina.page.getByTestId('ticket-form');
      await form.waitFor({ state: 'visible', timeout: 15_000 });
      await form.locator('input').first().fill(`Disk use of web-01 is known (${mark})`);
      await form.locator('textarea').first().fill('Find out how full the disks of web-01 are and report it. Change nothing.');
      const agentSelect = form.locator('select').first();
      const options = await agentSelect.locator('option').allInnerTexts();
      const investigator = options.find((o) => /Investigator/.test(o)) || options.find((o) => !/Nobody/.test(o));
      ctx.note(`Agents offered: ${options.join(' | ')}`);
      if (!ctx.expect(investigator, 'the ticket can be given to an agent')) return;
      await agentSelect.selectOption({ label: investigator });
      await form.getByPlaceholder('A cluster or server').fill('web-01');
      await form.getByRole('button', { name: 'Add ticket' }).click();
      await lina.page.waitForTimeout(2000);
      const ticket = ((await lina.snapshot()).workTickets || []).find((t) => t.title.includes(mark));
      if (!ctx.expect(ticket, 'the ticket is on the board')) return;
      await ctx.shot('lina', 'board');
      const card = lina.page.locator(`[data-testid="ticket-${ticket.id}"], [data-testid="ticket-card-${ticket.id}"]`).first();
      const start = (await card.count()) ? card.getByRole('button', { name: /Start|Run/ }).first() : lina.page.getByRole('button', { name: /Start/ }).first();
      if (await start.isVisible().catch(() => false)) await start.click();
      else await lina.hub({ action: 'ticket-start', id: ticket.id });
      const until = Date.now() + 900_000;
      let now = ticket;
      while (Date.now() < until) {
        now = ((await lina.snapshot()).workTickets || []).find((t) => t.id === ticket.id) || now;
        if (['review', 'done', 'blocked'].includes(now.status)) break;
        await ctx.sleep(5000);
      }
      await lina.open('Workforce');
      await lina.page.waitForTimeout(1500);
      await ctx.shot('lina', 'reported');
      ctx.note(`The ticket ended in ${now.status}.`);
      ctx.expect(now.status === 'review', 'the ticket waits in Review for a person', now.status);
      const task = ((await lina.snapshot()).tasks || []).find((t) => t.ticketId === ticket.id);
      if (ctx.expect(task, 'the ticket has the agent\'s run')) {
        const report = await lina.answer(task.id);
        ctx.expect(/web-01/.test(report) && /%|GiB|G\b|full/i.test(report), 'the report is about web-01\'s disks', report.slice(0, 600));
        ctx.expect(!(task.changes || []).some((c) => c.status === 'completed'), 'the agent changed nothing');
      }
    },
  },
  {
    id: 'workforce-review',
    area: AREA,
    title: 'A review lets several agents look at once and gives one report',
    doc: 'docs/ai-hub.md, "Investigating an incident" and the workforce review',
    expected: 'In Agents & MCP, a review of the shop starts several read-only agents in terminals of their own; they change nothing, and one report combines what they found.',
    timeoutMs: 1_500_000,
    async run(ctx) {
      const omar = await ctx.as('omar');
      await omar.open('Agents & MCP');
      const t0 = Date.now();
      await omar.page.getByTestId('workforce-objective-input').fill('Find out how healthy the shop\'s web servers and database are right now. Change nothing.');
      await omar.page.getByTestId('run-workforce-btn').click();
      await omar.page.waitForTimeout(3000);
      await ctx.shot('omar', 'started');
      const lead = await omar.waitTask((t) => (t.createdAt || 0) >= t0 - 2000 && !t.workforceRunId && !t.distillSourceId, 120_000).catch(() => undefined);
      if (!ctx.expect(lead, 'the review starts a run')) return;
      const done = await omar.waitSettled(lead.id, 1_200_000);
      const helpers = ((await omar.snapshot()).tasks || []).filter((t) => t.workforceRunId);
      ctx.note(`The review ended ${done.status}; ${helpers.length} specialist runs.`);
      await ctx.shot('omar', 'done');
      ctx.expect(helpers.length >= 2, 'several agents looked', String(helpers.length));
      const report = await omar.answer(lead.id);
      ctx.expect(/web-0|db-0/.test(report), 'one report says what they found about the servers', report.slice(0, 700));
      ctx.expect(!helpers.some((h) => (h.changes || []).some((c) => c.status === 'completed')), 'the review changed nothing');
    },
  },
  {
    id: 'schedule-job',
    area: AREA,
    title: 'A scheduled job is made, runs on demand and reports',
    doc: 'docs/ai-hub.md, "Nightly upkeep" and Schedules',
    expected: 'Lina makes a report-only job in Schedules; it is listed with its next run; "Run now" runs it and its report is kept.',
    timeoutMs: 1_200_000,
    async run(ctx) {
      const lina = await ctx.as('lina');
      const mark = word();
      await lina.open('Schedules');
      await lina.page.getByRole('button', { name: 'New job' }).click();
      await lina.page.waitForTimeout(800);
      await lina.page.getByPlaceholder('Morning check of the storage cluster').fill(`Daily web check ${mark}`);
      await lina.page.locator('textarea').first().fill('Say which of the shop\'s web servers the workspace knows about, and nothing else.');
      await lina.page.getByRole('button', { name: 'Create job' }).click();
      await lina.page.waitForTimeout(2000);
      await ctx.shot('lina', 'created');
      const job = ((await lina.snapshot()).schedules || []).find((s) => JSON.stringify(s).includes(mark));
      if (!ctx.expect(job, 'the job is kept', JSON.stringify((await lina.snapshot()).schedules || []).slice(0, 300))) return;
      const text = await lina.page.locator('body').innerText();
      ctx.expect(text.includes(mark), 'the job is listed in Schedules');
      const run = lina.page.getByRole('button', { name: /Run now/ }).first();
      if (!ctx.expect(await run.isVisible().catch(() => false), 'the job has "Run now"')) return;
      const t0 = Date.now();
      await run.click();
      const task = await lina.waitTask((t) => (t.createdAt || 0) >= t0 - 2000, 120_000).catch(() => undefined);
      if (!ctx.expect(task, 'running it starts a run')) return;
      const done = await lina.waitSettled(task.id, 900_000);
      await lina.open('Schedules');
      await lina.page.waitForTimeout(1500);
      await ctx.shot('lina', 'ran');
      ctx.expect(done.status === 'completed', 'the run ends completed', done.status);
      const report = await lina.answer(task.id);
      ctx.expect(/web-0/.test(report), 'its report says what was asked', report.slice(0, 500));
    },
  },
];
