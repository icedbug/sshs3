'use strict';
/*
 * Area 6, knowledge: the team's knowledge base and memory. A page the workspace wrote from finished work,
 * a note a person adds that an agent then uses, what happens when a server no longer matches its page,
 * and memories: proposed by the workspace, accepted by a person, added and edited by hand.
 */
const AREA = '6 Knowledge and memory';
const DOC = 'docs/ai-hub.md, "Knowledge base: what agents know" and "Memory"';

const word = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

/** The knowledge base's pages, each read whole: the snapshot keeps only the first 500 characters of a page. */
async function fullPages(p) {
  const pages = (await p.snapshot()).kbPages || [];
  const whole = [];
  for (const page of pages) {
    const read = await p.hub({ action: 'kb-page-read', id: page.id }).catch(() => undefined);
    whole.push((read && read.reply && read.reply.kbPage) || page);
  }
  return whole;
}

module.exports = [
  {
    id: 'kb-learned-from-work',
    area: AREA,
    title: 'A finished conversation becomes a knowledge base page the whole team sees',
    doc: DOC,
    expected: 'After Maria\'s conversations, the knowledge base has a page made from them ("Created from Session"), about the right server, with what the server really has; Lina sees it too.',
    async run(ctx) {
      const lina = await ctx.as('lina');
      const pages = await fullPages(lina);
      ctx.note(`Pages: ${pages.map((p) => `${p.title} (${(p.targets || []).join(',')})`).join(' | ')}`);
      const nginx = pages.find((p) => /nginx/i.test(p.title));
      if (!ctx.expect(nginx, 'a page about nginx was written from the work', pages.map((p) => p.title).join(' | '))) return;
      ctx.expect((nginx.targets || []).includes('web-01'), 'the page is about web-01', JSON.stringify(nginx.targets));
      const version = await ctx.onServer('web-01', 'nginx -v 2>&1');
      const real = ((version.stdout + version.stderr).match(/nginx\/([\d.]+)/) || [])[1];
      ctx.expect(nginx.body && nginx.body.includes(real), `the page has the version web-01 runs (${real})`, (nginx.body || '').slice(0, 600));
      await lina.open('Knowledge Base');
      await lina.page.waitForTimeout(1500);
      await ctx.shot('lina', 'kb');
      ctx.expect(/Created from Session/.test(await lina.page.locator('body').innerText()), 'the page says it was made from a session');
    },
  },
  {
    id: 'kb-note-used',
    area: AREA,
    title: 'A note a person adds is found by search and used by the agent',
    doc: DOC,
    expected:
      'Lina pastes a note into the knowledge base; it is kept as a source and a page; search finds it by its words; when Maria asks, the agent answers from it and cites it.',
    timeoutMs: 1_200_000,
    async run(ctx) {
      const lina = await ctx.as('lina');
      const ticket = `MW-${word().toUpperCase()}`;
      const note =
        `Maintenance window for the shop: every Sunday from 03:00 to 04:00 UTC. ` +
        `Every change in the window needs a change ticket whose number starts with ${ticket}. The platform team owns the window.`;
      await lina.open('Knowledge Base');
      await lina.page.getByTestId('kb-paste').fill(note);
      await lina.page.getByRole('button', { name: 'Add', exact: true }).first().click();
      await lina.page.waitForTimeout(2000);
      await ctx.shot('lina', 'added');
      // The workspace reads the note into a page: a model call, so it may take a little while.
      const until = Date.now() + 240_000;
      let page;
      while (!page && Date.now() < until) {
        page = (await fullPages(lina)).find((p) => (p.body || '').includes(ticket));
        if (!page) await ctx.sleep(4000);
      }
      ctx.expect(page, 'the note becomes a page', page && page.title);
      await lina.page.getByTestId('kb-hybrid-search-input').fill('maintenance window sunday');
      await lina.page.waitForTimeout(2500);
      const hits = await lina.page.getByTestId('kb-hits').innerText().catch(() => lina.page.locator('body').innerText());
      await ctx.shot('lina', 'search');
      ctx.expect(/maintenance/i.test(hits), 'search finds it by its words', hits.slice(0, 400));

      const maria = await ctx.as('maria');
      await maria.terminal('web-01');
      await maria.newChat();
      await maria.mode('advice');
      const t0 = Date.now();
      await maria.ask('When is the shop\'s maintenance window, and what must a change ticket number in it start with?');
      const task = await maria.waitSettled((await maria.newestSince(t0 - 2000)).id);
      const said = await maria.answer(task.id);
      await ctx.shot('maria', 'answer');
      ctx.expect(/03:00/.test(said) && said.includes(ticket), 'the agent answers from the note', said.slice(0, 600));
      ctx.expect(/\[S\d+\]|\[c\d+\]/.test(said), 'the answer cites where it read it', said.slice(0, 300));
    },
  },
  {
    id: 'kb-stale-page',
    area: AREA,
    title: 'When a server no longer matches its page, the agent goes by the server',
    doc: DOC,
    expected:
      'After web-01 is changed behind the page\'s back (2 nginx workers instead of 4), a question about it is answered from the server (2), not from the page, and the page is brought up to date or marked as no longer right.',
    timeoutMs: 1_200_000,
    async run(ctx) {
      const conf = '/etc/nginx/nginx.conf';
      try {
        await ctx.onServer('web-01', `cp ${conf} /root/nginx.conf.lab && sed -i 's/^worker_processes .*/worker_processes 2;/' ${conf} && nginx -t 2>&1 && systemctl reload nginx && sleep 2 && pgrep -c -f 'nginx: worker process'`);
        const workers = (await ctx.onServer('web-01', "pgrep -c -f 'nginx: worker process'")).stdout.trim();
        ctx.note(`web-01 now has ${workers} nginx workers.`);
        const maria = await ctx.as('maria');
        await maria.terminal('web-01');
        await maria.newChat();
        await maria.mode('assisted');
        const t0 = Date.now();
        await maria.ask('How many nginx worker processes are running on this server right now?');
        const task = await maria.waitSettled((await maria.newestSince(t0 - 2000)).id);
        const said = await maria.answer(task.id);
        await ctx.shot('maria', 'answer');
        // The answer leads with what the server has now; it may go on to say what the page said.
        const lead = said.split(/\n/).find((l) => l.trim()) || '';
        ctx.expect(new RegExp(`\\b${workers}\\b`).test(lead) && /worker/i.test(lead), `the answer gives what the server has now (${workers})`, said.slice(0, 600));
        ctx.expect((task.commandsUsed || 0) > 0, 'the agent looked on the server', `commandsUsed ${task.commandsUsed}`);
        // What the conversation confirmed goes to the pages in a run of its own after it ends ("Pages · ...").
        const learn = await maria.waitTask((t) => t.distillSourceId === `kbl:task:${task.id}` && !['queued', 'running'].includes(t.status), 300_000).catch(() => undefined);
        ctx.note(learn ? `The pages run ended ${learn.status}.` : 'No pages run was made for the conversation within five minutes.');
        const page = (await fullPages(maria)).find((p) => /nginx/i.test(p.title) && (p.targets || []).includes('web-01'));
        ctx.note(`The page now: ${(page && page.body || '').slice(0, 500)}`);
        ctx.expect(page && (/\b2\b/.test(page.body || '') || page.health === 'stale' || page.stale || /stale|outdated|no longer/i.test(JSON.stringify(page))), 'the page is brought up to date or marked as no longer right', JSON.stringify(page || {}).slice(0, 400));
      } finally {
        await ctx.onServer('web-01', `cp /root/nginx.conf.lab ${conf} && systemctl reload nginx`);
      }
    },
  },
  {
    id: 'memory-proposals',
    area: AREA,
    title: 'Memories the workspace proposes can be accepted or rejected',
    doc: DOC,
    expected: 'Memory & skills lists what the assistant learned and proposes; accepting one makes it an entry the team sees, rejecting one removes it.',
    async run(ctx) {
      const m = await ctx.as('maria');
      await m.open('Memory & skills');
      await m.page.waitForTimeout(2000);
      await ctx.shot('maria', 'memory');
      const proposals = m.page.locator('[data-testid^="memory-proposal-"]').filter({ hasNotText: '' });
      const ids = await m.page.evaluate(() => [...document.querySelectorAll('[data-testid^="memory-proposal-"]')].map((e) => e.getAttribute('data-testid')));
      ctx.note(`Proposal elements: ${ids.slice(0, 12).join(' ')}`);
      const snap = await m.snapshot();
      ctx.note(`Snapshot: ${(snap.memoryProposals || []).length} proposals, ${(snap.memories || []).length} memories.`);
      if (!ctx.expect((snap.memoryProposals || []).length > 0, 'the workspace has proposed memories from the work')) return;
      const first = snap.memoryProposals[0];
      const card = m.page.getByTestId(`memory-proposal-${first.id}`);
      if (!ctx.expect(await card.isVisible().catch(() => false), 'a proposal shows as a card', first.id)) return;
      const accept = card.getByRole('button', { name: /Accept|Keep|Save|Approve/ }).first();
      if (!ctx.expect(await accept.isVisible().catch(() => false), 'the card has a button to accept it', await card.innerText())) return;
      await accept.click();
      await m.page.waitForTimeout(2500);
      await ctx.shot('maria', 'accepted');
      const after = await m.snapshot();
      ctx.expect(!(after.memoryProposals || []).some((p) => p.id === first.id), 'the accepted proposal leaves the list');
      ctx.expect((after.memories || []).length > (snap.memories || []).length || (after.memories || []).some((x) => (x.text || '').includes((first.text || first.body || '').slice(0, 40))), 'it becomes an entry');
      void proposals;
    },
  },
  {
    id: 'memory-by-hand',
    area: AREA,
    title: 'A memory added by hand is shared, can be edited and forgotten',
    doc: DOC,
    expected: 'Lina adds a memory with "Add by hand"; it shows for Omar too; "Quick edit" changes it; "Forget" removes it.',
    async run(ctx) {
      const lina = await ctx.as('lina');
      const mark = word();
      await lina.open('Memory & skills');
      await lina.page.getByRole('button', { name: 'Add by hand' }).click();
      await lina.page.waitForTimeout(800);
      await ctx.shot('lina', 'form');
      const form = lina.page.getByTestId('memory-add-form');
      if (!ctx.expect(await form.isVisible().catch(() => false), '"Add by hand" opens a form')) return;
      const fields = form.locator('input, textarea');
      const n = await fields.count();
      ctx.note(`The form has ${n} fields.`);
      await fields.nth(0).fill(`Shop on-call phone rota ${mark}`);
      if (n > 1) await fields.nth(1).fill(`The shop on-call rota ${mark} is kept in the platform team's wiki under On-call.`);
      await form.getByRole('button', { name: /Save|Add/ }).last().click();
      await lina.page.waitForTimeout(2000);
      await ctx.shot('lina', 'added');
      const mine = ((await lina.snapshot()).memories || []).find((x) => JSON.stringify(x).includes(mark));
      if (!ctx.expect(mine, 'the memory is kept')) return;
      const omar = await ctx.as('omar');
      ctx.expect(((await omar.snapshot()).memories || []).some((x) => JSON.stringify(x).includes(mark)), 'Omar sees it too');
      await lina.page.getByTestId(`memory-inline-edit-${mine.id}`).click();
      await lina.page.waitForTimeout(600);
      const inline = lina.page.getByTestId(`memory-inline-form-${mine.id}`).locator('textarea, input').first();
      if (ctx.expect(await inline.isVisible().catch(() => false), '"Quick edit" opens the entry for editing')) {
        await inline.fill(`The shop on-call rota ${mark} moved to the incident tool.`);
        await lina.page.getByTestId(`memory-inline-form-${mine.id}`).getByRole('button', { name: /Save/ }).click();
        await lina.page.waitForTimeout(1500);
        const edited = ((await lina.snapshot()).memories || []).find((x) => x.id === mine.id);
        ctx.expect(edited && /incident tool/.test(JSON.stringify(edited)), 'the edit is kept', JSON.stringify(edited || {}).slice(0, 300));
      }
      // "Forget" asks once more in the same entry ("Forget for the whole team?").
      const entry = lina.page.getByTestId(`memory-${mine.id}`);
      await entry.getByRole('button', { name: 'Forget', exact: true }).click();
      await lina.page.waitForTimeout(800);
      const sure = entry.getByRole('button', { name: /Forget for the whole team/ });
      if (ctx.expect(await sure.isVisible().catch(() => false), '"Forget" asks once more before it removes a team memory')) await sure.click();
      await lina.page.waitForTimeout(1500);
      await ctx.shot('lina', 'forgotten');
      ctx.expect(!((await lina.snapshot()).memories || []).some((x) => x.id === mine.id), '"Forget" removes it');
    },
  },
];
