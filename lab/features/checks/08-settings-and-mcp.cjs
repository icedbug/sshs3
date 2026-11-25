'use strict';
/*
 * Areas 8 and 9: settings asked for in the conversation, and sshs3 as an MCP server for a person's own
 * agent. A settings change waits for the person in every mode; what an outside agent asks to run waits
 * in the key owner's inbox, runs only once approved, and every call is in the owner's audit log.
 */
const path = require('node:path');

const AREA_SETTINGS = '8 Settings from the conversation';
const AREA_MCP = '9 Own agents and MCP';
const DOC_SETTINGS = 'docs/ai-hub.md, "Every setting from the conversation"';
const DOC_MCP = 'docs/ai-hub.md, "Your own agent, and this app as an MCP server"';

const word = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const hide = (s) => String(s).replace(/[A-Za-z0-9_-]{24,}/g, '<key>');

/** An MCP client of the product's own endpoint, as Claude Code would connect with the key. */
async function mcpClient(ws, token, extraHeaders = {}) {
  const sdk = path.join(__dirname, '..', '..', '..', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'cjs', 'client');
  const { Client } = require(path.join(sdk, 'index.js'));
  const { StreamableHTTPClientTransport } = require(path.join(sdk, 'streamableHttp.js'));
  const client = new Client({ name: 'lab-check', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${ws.baseUrl}/api/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}`, ...extraHeaders } },
  });
  await client.connect(transport);
  return client;
}

/** Makes an MCP key in the person's AI settings, as a person does, and returns it as shown once. */
async function makeKey(p, ctx, { name, run }) {
  await p.panel();
  await p.page.getByRole('button', { name: 'AI settings', exact: true }).first().click();
  const panel = p.page.getByTestId('mcp-keys').first();
  await panel.waitFor({ state: 'visible', timeout: 15_000 });
  await panel.scrollIntoViewIfNeeded();
  await panel.getByLabel('What the key is for').fill(name);
  if (run) {
    const runBox = panel.locator('label').filter({ hasText: 'Run commands on one server' }).locator('input[type="checkbox"]').first();
    await runBox.check();
    await panel.getByLabel('The one server it may run on').fill(run);
  }
  // "Make a key" heads the form; its button is "Make the key".
  await panel.getByRole('button', { name: 'Make the key' }).click();
  await p.page.waitForTimeout(1500);
  const text = await panel.innerText();
  await ctx.shot(p.who, `key-${name.replace(/\W+/g, '-')}`);
  // The new key shows once in its own box, written s3k_<user>.<id>.<secret>.
  const shown = await panel.getByTestId('mcp-new-key').innerText().catch(() => '');
  const token = (shown.match(/\bs3k_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{20,}/) || [])[0];
  await p.page.keyboard.press('Escape');
  await p.page.waitForTimeout(400);
  return { token, shownOnce: /shown once|only time it is shown|will not be shown again/i.test(text) };
}

module.exports = [
  {
    id: 'settings-from-chat',
    area: AREA_SETTINGS,
    title: 'A setting asked for in the conversation waits for the person, then is set',
    doc: DOC_SETTINGS,
    expected:
      'Asked in the chat for quiet hours, the agent makes a settings card that waits for the person even in Auto; once approved the quiet hours are set, as the settings show.',
    timeoutMs: 900_000,
    async run(ctx) {
      const m = await ctx.as('maria');
      await m.terminal('web-02');
      await m.newChat();
      await m.mode('autonomous');
      const t0 = Date.now();
      await m.ask('Please set quiet hours for my notifications: from 22:00 to 07:00, every day.');
      const task = await m.newestSince(t0 - 2000);
      const waiting = await m.waitTask((t) => t.id === task.id && ((t.changes || []).some((c) => c.status === 'pending') || !['queued', 'running'].includes(t.status)), 300_000);
      const card = (waiting.changes || []).find((c) => c.status === 'pending');
      await ctx.shot('maria', 'asked');
      if (!ctx.expect(card, 'the settings change waits for the person, also in Auto', `${waiting.status} ${JSON.stringify((waiting.changes || []).map((c) => [c.kind, c.status]))}`)) return;
      ctx.expect(card.kind === 'setting', 'it is a settings card', card.kind);
      await m.open('Inbox');
      await m.page.waitForTimeout(2000);
      await ctx.shot('maria', 'inbox');
      const approve = m.page.getByRole('button', { name: 'Approve', exact: true }).first();
      if (!ctx.expect(await approve.isVisible().catch(() => false), 'the inbox offers to approve it')) return;
      await approve.click();
      await m.page.waitForTimeout(1500);
      if (await m.page.getByTestId('inbox-read-first').isVisible().catch(() => false)) await approve.click().catch(() => {});
      const done = await m.waitSettled(task.id, 300_000);
      const snap = await m.snapshot();
      const quiet = JSON.stringify(snap.notifyPolicy || snap.quietHours || snap.notifications || {});
      ctx.note(`After: ${hide(quiet).slice(0, 400)}`);
      ctx.expect(/22:00|"22"|1320/.test(quiet) && /07:00|"7"|420/.test(quiet), 'the quiet hours are set', hide(quiet).slice(0, 300));
      ctx.expect(done.status === 'completed', 'the conversation ends completed', done.status);
    },
  },
  {
    id: 'settings-member-limits',
    area: AREA_SETTINGS,
    title: 'A member cannot have the agent loosen the rules for everyone',
    doc: DOC_SETTINGS,
    expected: 'When Omar, a member, asks the agent to turn off the two-person rule for everyone, it is refused (only an administrator may), and the rule is as it was.',
    timeoutMs: 600_000,
    async run(ctx) {
      const maria = await ctx.as('maria');
      const omar = await ctx.as('omar');
      try {
        await maria.hub({ action: 'team-rules-save', requirePeerApprovalOnProd: true });
        await omar.terminal('web-02');
        await omar.newChat();
        await omar.mode('assisted');
        const t0 = Date.now();
        await omar.ask('Please turn off the rule that two people must approve changes on production, for everyone on this server.');
        const task = await omar.newestSince(t0 - 2000);
        const settled = await omar.waitTask((t) => t.id === task.id && ((t.changes || []).some((c) => c.status === 'pending') || !['queued', 'running'].includes(t.status)), 300_000);
        const card = (settled.changes || []).find((c) => c.status === 'pending');
        if (card) {
          ctx.note('A card was made; Omar approves it to see whether the change is allowed.');
          await omar.open('Inbox');
          await omar.page.getByRole('button', { name: 'Approve', exact: true }).first().click().catch(() => {});
          await omar.waitSettled(task.id, 300_000);
        }
        await ctx.shot('omar', 'answer');
        const rules = JSON.stringify((await maria.snapshot()).teamRules || {});
        ctx.expect(/"requirePeerApprovalOnProd":true/.test(rules), 'the rule is still on', rules.slice(0, 300));
        const said = await omar.answer(task.id);
        ctx.expect(/administrator|admin|not allowed|can't|cannot|only/i.test(said), 'Omar is told he may not', said.slice(-500));
      } finally {
        await maria.hub({ action: 'team-rules-save', requirePeerApprovalOnProd: false }).catch(() => {});
      }
    },
  },
  {
    id: 'mcp-read',
    area: AREA_MCP,
    title: 'An outside agent with a key reads the team\'s servers over MCP, and it is logged',
    doc: DOC_MCP,
    expected:
      'Maria makes a key in AI settings (shown once); an MCP client with it lists the tools, gets the seven servers and searches the knowledge base; each call is a line in Maria\'s audit log with the key\'s name.',
    async run(ctx) {
      const m = await ctx.as('maria');
      const name = `lab mcp ${word()}`;
      const key = await makeKey(m, ctx, { name });
      if (!ctx.expect(key.token, 'the key is shown')) return;
      ctx.expect(key.shownOnce, 'the panel says the key is shown only once');
      const client = await mcpClient(ctx.ws, key.token);
      try {
        const tools = (await client.listTools()).tools.map((t) => t.name);
        ctx.note(`Tools: ${tools.join(', ')}`);
        ctx.expect(tools.includes('list_servers') && tools.includes('kb_search'), 'the read tools are offered');
        ctx.expect(!tools.includes('run_command'), 'a read key is not offered run_command');
        const servers = await client.callTool({ name: 'list_servers', arguments: {} });
        const text = JSON.stringify(servers.content || servers.structuredContent || servers);
        for (const s of ['web-01', 'db-01', 'cache-01']) ctx.expect(text.includes(s), `list_servers gives ${s}`);
        const hits = await client.callTool({ name: 'kb_search', arguments: { query: 'nginx' } });
        ctx.expect(/nginx/i.test(JSON.stringify(hits)), 'kb_search finds the team\'s nginx page');
      } finally {
        await client.close().catch(() => {});
      }
      await m.open('Changes');
      await m.page.getByRole('tab', { name: 'Audit log' }).click();
      await m.page.waitForTimeout(2000);
      const log = await m.page.getByTestId('audit-log').innerText();
      await ctx.shot('maria', 'audit');
      ctx.expect(log.includes(name) || /list_servers/.test(log), 'the calls are in Maria\'s audit log with the key\'s name', log.slice(0, 600));
    },
  },
  {
    id: 'mcp-command-waits',
    area: AREA_MCP,
    title: 'A command an outside agent asks for waits for the person and runs once approved',
    doc: DOC_MCP,
    expected:
      'With a key that may run on web-02, run_command does not run at once: it waits in Maria\'s inbox; after she approves, it runs in her terminal on web-02 and command_status says what it printed.',
    timeoutMs: 900_000,
    async run(ctx) {
      const m = await ctx.as('maria');
      await m.terminal('web-02');
      const w = word();
      const key = await makeKey(m, ctx, { name: `lab run ${w}`, run: 'web-02' });
      if (!ctx.expect(key.token, 'the key is shown')) return;
      const client = await mcpClient(ctx.ws, key.token);
      try {
        const asked = await client.callTool({ name: 'run_command', arguments: { command: `echo ${w} > /tmp/${w}`, why: 'A lab check of commands asked from outside.' } });
        const askedText = JSON.stringify(asked);
        const id = (askedText.match(/"id"\s*:\s*\\?"([^"\\]+)/) || [])[1];
        ctx.note(`run_command answered: ${hide(askedText).slice(0, 400)}`);
        if (!ctx.expect(id, 'run_command gives an id to follow')) return;
        await ctx.sleep(3000);
        ctx.expect((await ctx.onServer('web-02', `test -e /tmp/${w}`)).code !== 0, 'nothing ran before the person approved');
        await m.open('Inbox');
        await m.page.waitForTimeout(2000);
        await ctx.shot('maria', 'inbox');
        const approve = m.page.getByRole('button', { name: 'Approve', exact: true }).first();
        if (!ctx.expect(await approve.isVisible().catch(() => false), 'Maria is asked in her inbox')) return;
        await approve.click();
        await m.page.waitForTimeout(1200);
        if (await m.page.getByTestId('inbox-read-first').isVisible().catch(() => false)) await approve.click().catch(() => {});
        let status = '';
        for (let i = 0; i < 30; i++) {
          status = JSON.stringify(await client.callTool({ name: 'command_status', arguments: { id } }));
          if (/completed|ran|exit/i.test(status) && !/waiting/i.test(status)) break;
          await ctx.sleep(3000);
        }
        ctx.note(`command_status: ${hide(status).slice(0, 400)}`);
        ctx.expect((await ctx.onServer('web-02', `cat /tmp/${w}`)).stdout.includes(w), 'the command ran on web-02 after the approval');
        ctx.expect(/completed|exit/i.test(status), 'command_status says it ran', hide(status).slice(0, 300));
      } finally {
        await client.close().catch(() => {});
        await ctx.onServer('web-02', `rm -f /tmp/${w}`);
      }
    },
  },
  {
    id: 'mcp-origin-refused',
    area: AREA_MCP,
    title: 'A request to the MCP endpoint from a web page is refused',
    doc: DOC_MCP,
    expected: 'A request that carries an Origin header is refused before the key is read, so a web page on the same machine cannot use a key.',
    async run(ctx) {
      const res = await fetch(`${ctx.ws.baseUrl}/api/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', origin: 'http://evil.example', authorization: 'Bearer not-a-key' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      ctx.note(`HTTP ${res.status}`);
      ctx.expect(res.status === 403 || res.status === 400, 'the request is refused', `HTTP ${res.status}`);
    },
  },
];
