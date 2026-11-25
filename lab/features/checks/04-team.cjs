'use strict';
/*
 * Area 4, the team: rules an administrator sets for everyone (two people on production, a change freeze),
 * a second person who approves in her own browser, what each account may see of the others, and a new
 * person who joins with an invite. Maria is the administrator, Omar and Lina are members.
 */
const AREA = '4 The team';
const DOC = 'docs/ai-hub.md, "Two people" and "Rules for everyone on a server"';

const word = () => `lab${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
/** The password of the new person the invite check signs up: a lab account on the lab's server. */
const NORA_PASSWORD = 'lab-nora-password-1'; // pragma: allowlist secret
const fileExists = async (ctx, server, file) => (await ctx.onServer(server, `test -e ${file}`)).code === 0;
const createFile = (file, text) =>
  `Please create the file ${file} on this server, containing exactly the text ${text}. It is only a test file, nothing else should change.`;

/** The administrator's AI settings, scrolled to the rules for everyone. */
async function openTeamRules(p) {
  await p.panel();
  await p.page.getByRole('button', { name: 'AI settings', exact: true }).first().click();
  await p.page.getByTestId('team-rules').waitFor({ state: 'visible', timeout: 15_000 });
  await p.page.getByTestId('team-rules').scrollIntoViewIfNeeded();
  await p.page.waitForTimeout(400);
}

async function closeDialog(p) {
  await p.page.keyboard.press('Escape');
  await p.page.waitForTimeout(400);
}

/** A conversation in Ask first on the server, with the request sent, and the change that waits. */
async function askForChange(p, server, prompt) {
  await p.terminal(server);
  await p.newChat();
  await p.mode('assisted');
  const t0 = Date.now();
  await p.ask(prompt);
  const task = await p.newestSince(t0 - 2000);
  const now = await p.waitTask((t) => t.id === task.id && ((t.changes || []).some((c) => c.status === 'pending') || !['queued', 'running'].includes(t.status)), 300_000);
  return { task: now, change: (now.changes || []).find((c) => c.status === 'pending') };
}

module.exports = [
  {
    id: 'team-two-people',
    area: AREA,
    title: 'Two people on production: a member asks, the administrator approves as the second person',
    doc: DOC,
    expected:
      'With "Two people must approve a change card or a file write on production" on, Omar\'s own approval of a change on web-01 is not enough; it waits, Maria sees it in her inbox, and it runs only once she has approved it too. The card records both.',
    timeoutMs: 1_200_000,
    async run(ctx) {
      const maria = await ctx.as('maria');
      const omar = await ctx.as('omar');
      const w = word();
      const file = `/tmp/${w}`;
      try {
        await openTeamRules(maria);
        const toggle = maria.page.getByTestId('team-peer-toggle');
        // The box follows the saved rule: it turns on once the server has kept it.
        if (!(await toggle.isChecked())) await toggle.click();
        await maria.page.waitForFunction(() => document.querySelector('[data-testid="team-peer-toggle"]')?.checked === true, null, { timeout: 15_000 }).catch(() => {});
        await ctx.shot('maria', 'rule-on');
        ctx.expect(await toggle.isChecked(), 'the administrator turns the rule on in AI settings');
        await closeDialog(maria);

        const { task, change } = await askForChange(omar, 'web-01', createFile(file, w));
        if (!ctx.expect(change, 'Omar\'s change waits for approval')) return;
        await omar.page.waitForTimeout(1500);
        await omar.approveInTerminal();
        await omar.page.waitForTimeout(4000);
        await ctx.shot('omar', 'approved-once');
        const afterOmar = (await omar.tasks()).find((t) => t.id === task.id);
        const still = (afterOmar.changes || []).find((c) => c.id === change.id);
        ctx.expect(still && still.status === 'pending', 'after Omar alone it still waits for a second person', still && `${still.status}, ${JSON.stringify(still.approvals || [])}`);
        ctx.expect(!(await fileExists(ctx, 'web-01', file)), 'nothing is changed on production yet');

        await maria.open('Inbox');
        await maria.page.waitForTimeout(2500);
        await ctx.shot('maria', 'inbox');
        const peer = maria.page.getByTestId(`peer-approve-${change.id}`);
        if (!ctx.expect(await peer.isVisible().catch(() => false), 'Maria is asked in her inbox, as the second person')) return;
        await peer.click();
        const done = await omar.waitTask((t) => t.id === task.id && !['queued', 'running'].includes(t.status) && !(t.changes || []).some((c) => c.status === 'pending'), 300_000);
        await omar.page.waitForTimeout(1500);
        await ctx.shot('omar', 'after');
        const ran = (done.changes || []).find((c) => c.id === change.id);
        ctx.expect(ran && ran.status === 'completed', 'the change runs once both have approved', ran && ran.status);
        ctx.expect(await fileExists(ctx, 'web-01', file), 'the file is on web-01');
        const names = JSON.stringify((ran && ran.approvals) || []);
        ctx.expect(/omar/i.test(names) && /maria/i.test(names), 'the card records both approvals', names);
      } finally {
        await ctx.onServer('web-01', `rm -f ${file}`);
        await maria.hub({ action: 'team-rules-save', requirePeerApprovalOnProd: false }).catch(() => {});
      }
    },
  },
  {
    id: 'team-member-not-second',
    area: AREA,
    title: 'A member may not be the second person on production',
    doc: DOC,
    expected: 'When Maria asks for a change on production under the two-person rule, Omar, a member, is not offered the second approval there, and the change does not run on his word.',
    timeoutMs: 1_200_000,
    async run(ctx) {
      const maria = await ctx.as('maria');
      const omar = await ctx.as('omar');
      const w = word();
      const file = `/tmp/${w}`;
      try {
        await maria.hub({ action: 'team-rules-save', requirePeerApprovalOnProd: true });
        const { task, change } = await askForChange(maria, 'web-01', createFile(file, w));
        if (!ctx.expect(change, 'Maria\'s change waits')) return;
        await maria.page.waitForTimeout(1500);
        await maria.approveInTerminal();
        await maria.page.waitForTimeout(3000);
        await omar.open('Inbox');
        await omar.page.waitForTimeout(2500);
        await ctx.shot('omar', 'inbox');
        const peer = omar.page.getByTestId(`peer-approve-${change.id}`);
        const offered = await peer.isVisible().catch(() => false);
        if (offered) {
          await peer.click();
          await omar.page.waitForTimeout(3000);
          await ctx.shot('omar', 'pressed');
        }
        const now = (await maria.tasks()).find((t) => t.id === task.id);
        const c = (now.changes || []).find((x) => x.id === change.id);
        ctx.note(`Omar was ${offered ? '' : 'not '}offered the second approval; the change is ${c && c.status}.`);
        ctx.expect(!(await fileExists(ctx, 'web-01', file)), 'the change has not run on a member\'s second approval');
        ctx.expect(c && c.status !== 'completed', 'the change is not completed', c && c.status);
        await maria.denyInTerminal().catch(() => {});
      } finally {
        await ctx.onServer('web-01', `rm -f ${file}`);
        await maria.hub({ action: 'team-rules-save', requirePeerApprovalOnProd: false }).catch(() => {});
      }
    },
  },
  {
    id: 'team-freeze',
    area: AREA,
    title: 'A change freeze stops change cards and lets commands run',
    doc: DOC,
    expected: 'While an administrator\'s freeze is on, a change card is refused and nothing is changed, a plain command to look still runs, and the freeze can be ended from the same place.',
    timeoutMs: 1_200_000,
    async run(ctx) {
      const maria = await ctx.as('maria');
      const omar = await ctx.as('omar');
      const w = word();
      const file = `/tmp/${w}`;
      try {
        await openTeamRules(maria);
        const form = maria.page.getByTestId('team-freeze-form');
        await form.getByLabel('Freeze for how many hours').fill('1');
        await form.getByLabel('Why the freeze').fill('lab check of the freeze');
        await maria.page.getByTestId('team-freeze-start').click();
        await maria.page.waitForTimeout(2000);
        await ctx.shot('maria', 'freeze-on');
        const frozen = maria.page.locator('[data-testid^="team-freeze-"]').filter({ hasText: 'frozen' });
        ctx.expect((await frozen.count()) > 0, 'the freeze shows as on');
        await closeDialog(maria);

        await omar.terminal('web-02');
        await omar.newChat();
        await omar.mode('assisted');
        const t0 = Date.now();
        await omar.ask(`${createFile(file, w)} Before that, tell me how long the server has been up.`);
        const task = await omar.newestSince(t0 - 2000);
        const done = await omar.waitSettled(task.id, 400_000);
        await omar.page.waitForTimeout(1500);
        await ctx.shot('omar', 'answer');
        ctx.expect(!(await fileExists(ctx, 'web-02', file)), 'nothing is changed while the freeze is on');
        ctx.expect((done.commandsUsed || 0) > 0, 'a plain command to look still ran', `commandsUsed ${done.commandsUsed}`);
        const said = await omar.answer(task.id);
        ctx.expect(/freez/i.test(said), 'the answer tells Omar about the freeze', said.slice(-600));

        await openTeamRules(maria);
        const end = maria.page.getByRole('button', { name: 'End it now' }).first();
        if (ctx.expect(await end.isVisible().catch(() => false), 'the freeze has "End it now"')) {
          await end.click();
          await maria.page.waitForTimeout(600);
          // A confirm button asks once more.
          const confirm = maria.page.getByRole('button', { name: /End this freeze|End it|Yes|Confirm/ }).first();
          if (await confirm.isVisible().catch(() => false)) await confirm.click();
          await maria.page.waitForTimeout(2000);
          await ctx.shot('maria', 'freeze-ended');
          ctx.expect(await maria.page.getByTestId('team-freeze-none').isVisible().catch(() => false), 'the freeze is gone after "End it now"');
        }
        await closeDialog(maria);
      } finally {
        await ctx.onServer('web-02', `rm -f ${file}`);
        const snap = await maria.snapshot().catch(() => ({}));
        for (const key of Object.keys((snap.teamRules && snap.teamRules.freezes) || {})) {
          await maria.hub({ action: 'team-rules-save', endFreeze: key }).catch(() => {});
        }
      }
    },
  },
  {
    id: 'team-what-each-sees',
    area: AREA,
    title: 'Conversations are private, the knowledge base and the servers are the team\'s',
    doc: 'docs/ai-hub.md, "Runtime modes" (web server: one isolated set of stores per user)',
    expected:
      'Omar does not see Maria\'s conversations; he sees the team\'s shared servers and the knowledge base page made from her work; as a member he cannot change the rules for everyone.',
    async run(ctx) {
      const maria = await ctx.as('maria');
      const omar = await ctx.as('omar');
      const mariaTasks = (await maria.tasks()).filter((t) => maria.isConversation(t)).map((t) => t.id);
      const omarTasks = (await omar.tasks()).map((t) => t.id);
      ctx.note(`Maria has ${mariaTasks.length} conversations, Omar ${omarTasks.length}.`);
      ctx.expect(!mariaTasks.some((id) => omarTasks.includes(id)), 'none of Maria\'s conversations is in Omar\'s list');
      const read = await omar.hub({ action: 'task-read', taskId: mariaTasks[0] }).then(() => 'read', (e) => String(e));
      ctx.expect(read !== 'read', 'Omar cannot read one of Maria\'s conversations by its id', read.slice(0, 200));
      const pages = (await omar.snapshot()).kbPages || [];
      ctx.expect(pages.length > 0, 'Omar sees the team\'s knowledge base pages', pages.map((p) => p.title).join(' | '));
      await omar.open('Infrastructure');
      await omar.page.waitForTimeout(1500);
      ctx.expect((await omar.page.locator('[data-testid^="infra-server-"]').count()) >= 7, 'Omar sees the team\'s seven servers');
      await openTeamRules(omar);
      await ctx.shot('omar', 'rules');
      ctx.expect(await omar.page.getByTestId('team-peer-toggle').isDisabled(), 'a member cannot change the rules for everyone');
      await closeDialog(omar);
    },
  },
  {
    id: 'team-invite',
    area: AREA,
    title: 'A new person joins with an invite and finds the team\'s servers',
    doc: 'docs/workforce-server.md and the Invite / team dialog',
    expected: 'Maria makes a member invite from "Invite / team"; the link lets a new person make an account; signed in, she sees the team\'s seven shared servers and no one else\'s conversations.',
    async run(ctx) {
      const maria = await ctx.as('maria');
      await maria.page.getByText('Invite / team', { exact: false }).first().click();
      await maria.page.waitForTimeout(1200);
      await ctx.shot('maria', 'invite-dialog');
      const create = maria.page.getByRole('button', { name: 'Create and copy invite link' });
      if (!ctx.expect(await create.isVisible().catch(() => false), 'the dialog has a button to make an invite')) return;
      await create.click();
      await maria.page.waitForTimeout(1500);
      await ctx.shot('maria', 'invite-made');
      const text = await maria.page.locator('body').innerText();
      const url = (text.match(/https?:\/\/\S*invite\S*/i) || text.match(/https?:\/\/\S+token=\S+/i) || [])[0];
      if (!ctx.expect(url, 'an invite link is shown', text.slice(-800))) return;
      ctx.note(`Invite link: ${url.replace(/([?&#=/])[A-Za-z0-9_-]{16,}/g, '$1<token>')}`);
      const token = (url.match(/[A-Za-z0-9_-]{16,}/g) || []).at(-1);
      const name = `nora${Date.now().toString(36)}`;
      const reg = await fetch(`${ctx.ws.baseUrl}/api/auth/register-invite`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inviteToken: token, username: name, displayName: 'Nora', password: NORA_PASSWORD }),
      });
      if (!ctx.expect(reg.ok, 'the invite makes an account', `HTTP ${reg.status} ${(await reg.text()).slice(0, 200)}`)) return;
      ctx.ws.people[name] = { username: name, password: NORA_PASSWORD, role: 'member' };
      const nora = await ctx.as(name);
      await nora.page.waitForTimeout(1500);
      await ctx.shot(name, 'start');
      ctx.expect((await nora.page.locator('[data-testid^="workspace-server-card-"]').count()) >= 7, 'Nora sees the team\'s seven servers');
      ctx.expect(((await nora.tasks()) || []).length === 0, 'Nora has no conversations of anyone else');
    },
  },
];
