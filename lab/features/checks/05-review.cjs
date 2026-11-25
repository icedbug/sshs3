'use strict';
/*
 * Area 5, review: what a person can find afterwards about what the agents did. The audit log and its
 * chain, the recordings of the terminals an agent ran in, the team's timeline of changes, and what the
 * workspace knows about each server. These read what the earlier checks left behind.
 */
const AREA = '5 Review';

module.exports = [
  {
    id: 'audit-log',
    area: AREA,
    title: 'The audit log lists what the agent did, and its chain verifies',
    doc: 'docs/ai-hub.md, "The audit log and terminal recordings"',
    expected: 'In Changes, the audit log has an entry for each command and change Maria\'s agent ran, with who approved it; "Verify chain" says the log is whole; it can be exported.',
    async run(ctx) {
      const m = await ctx.as('maria');
      await m.open('Changes');
      await m.page.getByRole('tab', { name: 'Audit log' }).click();
      await m.page.getByTestId('audit-log').waitFor({ state: 'visible', timeout: 15_000 });
      await m.page.waitForTimeout(2000);
      const text = await m.page.getByTestId('audit-log').innerText();
      await ctx.shot('maria', 'audit-log');
      const ran = (await m.tasks()).flatMap((t) => (t.changes || []).filter((c) => c.status === 'completed' && c.command));
      ctx.note(`${ran.length} changes of Maria's ran; the log shows ${text.length} characters.`);
      ctx.expect(!/Nothing has been written to the log yet/.test(text), 'the log has entries');
      for (const c of ran.slice(-3)) ctx.expect(text.includes(c.command.slice(0, 30)), `the log lists the change "${c.command.slice(0, 50)}"`);
      ctx.expect(/Maria/i.test(text), 'the log says who approved');
      await m.page.getByTestId('verify-audit-chain').click();
      await m.page.waitForTimeout(2500);
      const verdict = await m.page.getByTestId('audit-verdict').innerText().catch(() => '');
      const ok = await m.page.getByTestId('audit-verdict').evaluate((e) => e.className.includes('ai-audit-ok')).catch(() => false);
      await ctx.shot('maria', 'verified');
      ctx.expect(ok, '"Verify chain" says the log is whole', verdict);
      for (const name of ['Export CSV', 'Export Markdown', 'Export JSONL']) {
        ctx.expect(await m.page.getByRole('button', { name }).isVisible().catch(() => false), `the log can be exported (${name})`);
      }
    },
  },
  {
    id: 'recordings',
    area: AREA,
    title: 'A recording of the agent\'s terminal plays back what it did',
    doc: 'docs/ai-hub.md, "The audit log and terminal recordings"',
    expected: 'In Changes, "With a recording" lists runs that were recorded; opening one plays the terminal as it was, with the agent\'s commands.',
    async run(ctx) {
      const m = await ctx.as('maria');
      await m.open('Changes');
      await m.page.getByTestId('filter-with-recording').click();
      await m.page.waitForTimeout(2000);
      await ctx.shot('maria', 'with-recording');
      const body = await m.page.locator('body').innerText();
      if (!ctx.expect(!/Nothing matches/.test(body), 'there are runs with a recording')) return;
      // An entry opens with its arrow; its recording plays in the recording player.
      const entry = m.page.locator('details.ai-timeline-item').first();
      await entry.locator('summary').click();
      await m.page.waitForTimeout(1200);
      const play = entry.getByRole('button', { name: 'Watch the terminal recording' });
      if (!ctx.expect(await play.isVisible().catch(() => false), 'an opened entry offers to watch its recording', (await entry.innerText()).slice(0, 400))) return;
      await play.click();
      await m.page.waitForTimeout(2500);
      await ctx.shot('maria', 'player');
      const player = m.page.getByTestId('recording-player');
      if (ctx.expect(await player.isVisible().catch(() => false), 'the recording player opens')) {
        const shown = await player.innerText().catch(() => '');
        ctx.expect(/\$|ops@/.test(shown) || shown.length > 40, 'the player shows the terminal', shown.slice(0, 400));
      }
    },
  },
  {
    id: 'team-timeline',
    area: AREA,
    title: 'The team sees in the timeline what another person\'s agent changed',
    doc: 'docs/ai-hub.md, "Server facts, and what changed"',
    expected: 'Lina\'s Changes timeline lists what Maria\'s agent ran, with Maria\'s name, the server and the command.',
    async run(ctx) {
      const lina = await ctx.as('lina');
      await lina.open('Changes');
      await lina.page.waitForTimeout(2000);
      const text = await lina.page.locator('body').innerText();
      await ctx.shot('lina', 'timeline');
      ctx.expect(/Maria \(AI\)/.test(text), 'the timeline names Maria\'s agent');
      ctx.expect(/web-0[12]|db-01/.test(text), 'the timeline names the servers');
      ctx.expect(/Reported by the team/.test(text), 'the entries are marked as the team\'s');
    },
  },
  {
    id: 'infra-view',
    area: AREA,
    title: 'Infrastructure lists the servers with their state',
    doc: 'docs/ai-hub.md, "Server facts, and what changed"',
    expected: 'Infrastructure lists the seven servers with a state each, and says how to have facts read from them.',
    async run(ctx) {
      const omar = await ctx.as('omar');
      await omar.open('Infrastructure');
      await omar.page.waitForTimeout(2500);
      await ctx.shot('omar', 'infrastructure');
      const rows = omar.page.locator('[data-testid^="infra-server-"]');
      ctx.expect((await rows.count()) === 7, 'the seven servers are listed', String(await rows.count()));
      const text = await omar.page.locator('body').innerText();
      for (const name of ['web-01', 'db-01', 'cache-01']) ctx.expect(text.includes(name), `${name} is listed`);
      const off = await omar.page.getByTestId('facts-off-note').innerText().catch(() => '');
      ctx.note(`Facts note: ${off.slice(0, 300)}`);
    },
  },
];
