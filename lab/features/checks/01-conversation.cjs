'use strict';
/*
 * Area 1, the conversation: a person asks in the chat panel beside a terminal, the agent looks on the
 * server, answers with its sources, and the person goes on with the same conversation, stops it, finds
 * it again, shows it a picture and keeps what it learned.
 */
const fs = require('node:fs');
const path = require('node:path');

const AREA = '1 The conversation';
const assistantText = (task) => task.messages.filter((m) => m.role === 'assistant').map((m) => m.text || '').join('\n');
const cited = (text) => /\[(c|S|s)\d+\]/.test(text);

/** The dollar figure in the panel's usage pill, as a person reads it. */
async function shownCost(page) {
  const text = await page.getByTestId('ai-usage-pill').innerText().catch(() => '');
  const m = text.match(/\$([\d.]+)/);
  return { text, usd: m ? Number(m[1]) : undefined };
}

module.exports = [
  {
    id: 'chat-answer',
    area: AREA,
    title: 'A question in the panel gets a sourced answer from the server',
    expected:
      'The agent looks in the person\'s own terminal, the answer shows while it is written, it names what the server really has, cites what it ran, the conversation ends completed, and "Show sources" lists the commands.',
    async run(ctx) {
      const m = await ctx.as('maria');
      await m.terminal('web-01');
      await m.newChat();
      await m.mode('assisted');
      const t0 = Date.now();
      await m.ask('Which nginx version runs on this server, and how many nginx worker processes are running right now?');
      const started = await m.newestSince(t0 - 2000);
      ctx.expect(started.target && started.target.label === 'web-01', 'the conversation works in the terminal on web-01', JSON.stringify(started.target));
      const { task, streamed, lengths } = await m.watchUntilSettled(started.id);
      ctx.expect(streamed, 'the answer shows while it is being written (it grows in the panel before the run ends)', `lengths seen: ${JSON.stringify(lengths).slice(0, 300)}`);
      await m.page.waitForTimeout(2000);
      await ctx.shot('maria', 'answer');
      ctx.expect(task.status === 'completed', 'the conversation ends completed', `${task.status} ${task.error || ''}`);
      const answer = await m.answer(task.id);
      const version = await ctx.onServer('web-01', 'nginx -v 2>&1');
      const real = ((version.stdout + version.stderr).match(/nginx\/([\d.]+)/) || [])[1];
      ctx.expect(real && answer.includes(real), `the answer names the version the server runs (${real})`, answer.slice(0, 800));
      const workers = await ctx.onServer('web-01', "pgrep -c -f 'nginx: worker process'");
      ctx.expect(answer.includes(workers.stdout.trim()), `the answer gives the number of workers the server has (${workers.stdout.trim()})`, answer.slice(0, 800));
      ctx.expect(cited(answer), 'the answer cites what it rests on', answer.slice(0, 400));
      ctx.expect((task.commandsUsed || 0) > 0, 'the agent ran commands to find out', `commandsUsed ${task.commandsUsed}`);
      const button = m.page.getByRole('button', { name: 'Show sources' }).last();
      if (ctx.expect(await button.isVisible().catch(() => false), 'the answer has "Show sources"')) {
        await button.click();
        await m.page.waitForTimeout(1500);
        const body = await m.page.locator('.ai-answer-sources .ai-receipt-body').last().innerText().catch(() => '');
        ctx.expect(/nginx/.test(body), '"Show sources" lists the commands the answer rests on', body.slice(0, 800));
        await ctx.shot('maria', 'sources');
      }
      // The conversation's own token counts, at Anthropic's prices for Claude Opus 5.5 (per million tokens:
      // $4 in, $20 out, $0.20 read from the cache, $5 written to it).
      const u = task.usage || {};
      const real$ = ((u.inputTokens || 0) * 4 + (u.outputTokens || 0) * 20 + (u.cacheReadTokens || 0) * 0.2 + (u.cacheCreationTokens || 0) * 5) / 1e6;
      const cost = await shownCost(m.page);
      ctx.note(`The conversation counted ${JSON.stringify(u)}. At Anthropic's prices that is $${real$.toFixed(4)}; the panel showed "${cost.text}".`);
      ctx.expect(u.costUsd !== undefined && real$ > 0 && Math.abs(u.costUsd - real$) / real$ < 0.1, 'the cost the workspace counts is what those tokens cost (within 10 %)', `counted $${u.costUsd}, real $${real$.toFixed(4)}`);
      ctx.expect(cost.usd !== undefined && Math.abs(cost.usd - (u.costUsd || 0)) < 0.01, 'the panel shows the cost the workspace counted', `${cost.text} against $${u.costUsd}`);
    },
  },
  {
    id: 'chat-follow-up',
    area: AREA,
    title: 'A reply goes on with the same conversation and what was said before',
    expected: 'A second message in the same conversation is answered in that conversation, and the agent uses what it found the first time.',
    async run(ctx) {
      const m = await ctx.as('maria');
      await m.terminal('web-01');
      await m.newChat();
      await m.mode('assisted');
      const t0 = Date.now();
      await m.ask('How much free disk space does / have on this server? Just the number, please.');
      const first = await m.newestSince(t0 - 2000);
      await m.waitSettled(first.id);
      await m.ask('And is that more or less than half of the disk? Answer from what you already found.');
      await m.page.waitForTimeout(3000);
      const after = await m.waitTask((t) => t.id === first.id && t.messages.filter((x) => x.role === 'user').length >= 2 && !['queued', 'running'].includes(t.status), 300_000);
      await ctx.shot('maria', 'follow-up');
      const tasksNow = (await m.tasks()).filter((t) => (t.createdAt || 0) >= t0 - 2000 && !t.workforceRunId && !t.distillSourceId);
      ctx.expect(tasksNow.length === 1, 'the reply stays in the same conversation, no new one is started', tasksNow.map((t) => t.title).join(' | '));
      const answers = (await m.read(after.id)).messages.filter((x) => x.role === 'assistant');
      const last = answers.at(-1);
      // The number the first answer gave (as "14G" or "14 GB"). The second answer uses what was found the
      // first time when it compares with half of the disk, or when it names that number and says the first
      // look did not show the disk's size: an honest "cannot tell from that" uses it as well.
      const firstText = answers.length > 1 ? answers[0].text || '' : '';
      const found = (firstText.match(/\b\d+(?:[.,]\d+)?\s?(?:[KMGT]i?B?|[KMGT])\b/i) || [])[0];
      const usesIt = Boolean(last) && (/(more|less|half)/i.test(last.text || '') || (found !== undefined && (last.text || '').replace(/\s/g, '').includes(found.replace(/\s/g, ''))));
      ctx.expect(usesIt, 'the second answer uses what the first one found: it compares with half, or names the number it found', `first: ${firstText.slice(0, 200)} | second: ${(last && last.text || '').slice(0, 500)}`);
      ctx.expect(after.status === 'completed', 'the conversation ends completed again', after.status);
    },
  },
  {
    id: 'chat-stop',
    area: AREA,
    title: 'Stop response stops the agent',
    expected: 'While the agent works, "Stop response" ends the run at once; it is shown as stopped and nothing more is run afterwards.',
    async run(ctx) {
      const m = await ctx.as('maria');
      await m.terminal('web-01');
      await m.newChat();
      await m.mode('assisted');
      const t0 = Date.now();
      await m.ask('Look through every log file under /var/log on this server one by one and summarise each of them in detail.');
      const started = await m.newestSince(t0 - 2000);
      await m.waitTask((t) => t.id === started.id && (t.commandsUsed || 0) >= 1, 180_000);
      const stop = m.page.getByRole('button', { name: 'Stop response' });
      ctx.expect(await stop.isVisible().catch(() => false), 'a "Stop response" button shows while the agent works');
      const pressed = Date.now();
      await stop.click();
      const ended = await m.waitTask((t) => t.id === started.id && !['queued', 'running'].includes(t.status), 60_000);
      const tookMs = Date.now() - pressed;
      await ctx.shot('maria', 'stopped');
      ctx.note(`It ended as "${ended.status}" ${Math.round(tookMs / 1000)} s after the press.`);
      ctx.expect(tookMs < 20_000, 'the run stops within 20 seconds of the press', `${tookMs} ms`);
      ctx.expect(['interrupted', 'stopped', 'cancelled'].includes(ended.status), 'the conversation is shown as stopped', ended.status);
      const steps = ended.commandsUsed || 0;
      await ctx.sleep(20_000);
      const later = (await m.tasks()).find((t) => t.id === started.id);
      ctx.expect((later.commandsUsed || 0) === steps, 'nothing more is run after the stop', `${steps} commands at the stop, ${later.commandsUsed || 0} twenty seconds later`);
    },
  },
  {
    id: 'chat-history',
    area: AREA,
    title: 'An earlier conversation is found in the history and opens with its messages',
    expected: 'After a new chat, the earlier conversation is listed in "Chat history"; choosing it shows its question and answer again.',
    async run(ctx) {
      const m = await ctx.as('maria');
      await m.terminal('web-01');
      await m.newChat();
      const marker = `marker-${Date.now().toString(36)}`;
      const t0 = Date.now();
      await m.ask(`Please answer only with the word "${marker}" and nothing else. Do not run any command.`);
      const task = await m.waitSettled((await m.newestSince(t0 - 2000)).id);
      const said = await m.answer(task.id);
      ctx.expect(said.includes(marker), 'the answer is the marker word', said.slice(0, 300));
      await m.newChat();
      await m.page.getByRole('button', { name: 'Chat history', exact: true }).first().click();
      await m.page.waitForTimeout(1000);
      await ctx.shot('maria', 'history');
      const entry = m.page.getByText(task.title, { exact: false }).first();
      if (ctx.expect(await entry.isVisible().catch(() => false), 'the conversation is listed in the history by its title', task.title)) {
        await entry.click();
        await m.page.waitForTimeout(1500);
        const shown = await m.page.locator('body').innerText();
        ctx.expect(shown.includes(marker), 'choosing it shows its answer again');
        await ctx.shot('maria', 'reopened');
      }
    },
  },
  {
    id: 'chat-picture',
    area: AREA,
    title: 'A picture sent with a question is read',
    expected: 'A screenshot attached to a message reaches the model: the answer says what the picture shows.',
    async run(ctx) {
      const m = await ctx.as('maria');
      // A picture of an error page, drawn in the browser itself.
      const png = await m.page.evaluate(() => {
        const c = document.createElement('canvas');
        c.width = 640;
        c.height = 200;
        const g = c.getContext('2d');
        g.fillStyle = '#fff';
        g.fillRect(0, 0, 640, 200);
        g.fillStyle = '#000';
        g.font = 'bold 40px sans-serif';
        g.fillText('502 Bad Gateway', 40, 90);
        g.font = '24px sans-serif';
        g.fillText('nginx/1.24.0 (Ubuntu)', 40, 150);
        return c.toDataURL('image/png').split(',')[1];
      });
      const file = path.join(ctx.dir, 'error-page.png');
      fs.writeFileSync(file, Buffer.from(png, 'base64'));
      await m.terminal('web-01');
      await m.newChat();
      await m.panel();
      const input = m.page.locator('input[type="file"]').first();
      if (!ctx.expect((await input.count()) > 0, 'the panel has a way to attach a file')) return;
      await input.setInputFiles(file);
      await m.page.waitForTimeout(1000);
      await ctx.shot('maria', 'attached');
      const t0 = Date.now();
      await m.ask('What does this screenshot show? Answer from the picture only, without running anything.');
      const task = await m.waitSettled((await m.newestSince(t0 - 2000)).id);
      await ctx.shot('maria', 'answer');
      const answer = await m.answer(task.id);
      ctx.expect(/502/.test(answer) && /gateway/i.test(answer), 'the answer reads "502 Bad Gateway" from the picture', answer.slice(0, 600));
    },
  },
  {
    id: 'chat-save-memory',
    area: AREA,
    title: '"Save to team memory" keeps what an answer said',
    expected: 'The button under an answer saves it as a team memory, which then shows in "Memory & skills".',
    async run(ctx) {
      const m = await ctx.as('maria');
      await m.terminal('db-01');
      await m.newChat();
      const t0 = Date.now();
      await m.ask('Which PostgreSQL major version runs on this server? One short sentence.');
      const task = await m.waitSettled((await m.newestSince(t0 - 2000)).id);
      const before = ((await m.snapshot()).memories || []).length;
      const save = m.page.getByRole('button', { name: 'Save to team memory' }).last();
      if (!ctx.expect(await save.isVisible().catch(() => false), 'the answer has "Save to team memory"')) return;
      await save.click();
      await m.page.waitForTimeout(2500);
      await ctx.shot('maria', 'saved');
      const snap = await m.snapshot();
      const memories = snap.memories || [];
      const proposals = snap.memoryProposals || [];
      ctx.note(`Memories ${before} before, ${memories.length} after; ${proposals.length} proposals waiting.`);
      const kept = memories.length > before || proposals.some((p) => (p.createdAt || 0) >= t0);
      ctx.expect(kept, 'a memory (or a proposal of one) is made from the answer', JSON.stringify(memories.slice(-1)).slice(0, 500));
      await m.open('Memory & skills');
      await m.page.waitForTimeout(1500);
      await ctx.shot('maria', 'memory-view');
      const view = await m.page.locator('body').innerText();
      ctx.expect(/PostgreSQL|postgres/i.test(view), 'the memory shows in "Memory & skills"', task.title);
    },
  },
  {
    id: 'chat-slash',
    area: AREA,
    title: 'Typing / in the composer offers the commands',
    expected: 'A slash in the composer opens a palette of commands such as /plan.',
    async run(ctx) {
      const m = await ctx.as('maria');
      await m.terminal('web-01');
      await m.newChat();
      await m.page.getByTestId('ai-composer').fill('/');
      await m.page.waitForTimeout(800);
      const palette = m.page.getByTestId('ai-slash-palette');
      const shown = await palette.isVisible().catch(() => false);
      await ctx.shot('maria', 'palette');
      ctx.expect(shown, 'the command palette opens');
      if (shown) ctx.expect(/plan/i.test(await palette.innerText()), 'it offers /plan', await palette.innerText());
      await m.page.getByTestId('ai-composer').fill('');
    },
  },
  {
    id: 'chat-bang',
    area: AREA,
    title: '!command runs in the terminal without the agent',
    expected: 'A message that starts with ! runs that command in the person\'s terminal at once, and no model is asked.',
    async run(ctx) {
      const m = await ctx.as('maria');
      await m.terminal('web-01');
      await m.newChat();
      const marker = `bang-${Date.now().toString(36)}`;
      const sent = Date.now();
      await m.page.getByTestId('ai-composer').fill(`!echo ${marker} > /tmp/${marker}`);
      await m.page.getByTestId('ai-composer').press('Enter');
      await m.page.waitForTimeout(6000);
      await ctx.shot('maria', 'after');
      const onServer = await ctx.onServer('web-01', `cat /tmp/${marker} 2>&1; rm -f /tmp/${marker}`);
      ctx.expect(onServer.stdout.includes(marker), 'the command ran on web-01', onServer.stdout + onServer.stderr);
      // Counted by when each call began: a call the workspace began before (a memory or knowledge base
      // reading of the last conversation) can end, and be written down, during this check.
      const began = ctx.callsBegunSince('maria', sent);
      ctx.expect(began.length === 0, 'no model call was made for it', began.map((c) => c.at).join(', '));
    },
  },
];
