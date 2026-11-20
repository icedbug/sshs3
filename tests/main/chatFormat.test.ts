import { describe, expect, it } from 'vitest';
import {
  ANSWER_MAX,
  CARD_MAX,
  MATTERMOST_APPROVE_ACTION,
  MATTERMOST_POST_MAX,
  RESTARTED_TEXT,
  SLACK_APPROVE_ACTION,
  SLACK_BLOCKS_MAX,
  SLACK_DENY_ACTION,
  SLACK_SECTION_MAX,
  changeCard,
  chatText,
  formatAnswer,
  mattermostDefuse,
  note,
  planCard,
  slackEscape,
  splitAtParagraphs,
  statusText,
  toSlackMrkdwn,
  type CardChange,
  type CardPlan,
  type ChatOut,
  type MattermostOut,
  type SlackOut,
} from '../../src/main/web/chatAgent/chatFormat';

/**
 * What the agent bot posts: answers split where a reader would, never inside a code block; nothing a
 * model writes can call the whole channel; and a card shows all of what is approved, or has no buttons.
 */

const fences = (s: string): number => (s.match(/^```/gm) ?? []).length;
const slackText = (out: ChatOut[]): string =>
  (out as SlackOut[]).flatMap((m) => (m.blocks ?? []).map((b) => (b as { text?: { text: string } }).text?.text ?? '')).join('\n');
const mmText = (out: ChatOut[]): string => (out as MattermostOut[]).map((m) => m.message).join('\n');
const PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAx1234567890abcdef\n-----END RSA PRIVATE KEY-----';

describe('splitAtParagraphs', () => {
  it('keeps short paragraphs together and splits between them', () => {
    const text = ['one '.repeat(20), 'two '.repeat(20), 'three '.repeat(20)].join('\n\n');
    const pieces = splitAtParagraphs(text, 180);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(180);
    expect(pieces.join('\n\n').replace(/\s+/g, ' ')).toBe(text.replace(/\s+/g, ' '));
  });

  it('never breaks a code block: a long one becomes several closed blocks', () => {
    const code = Array.from({ length: 200 }, (_, i) => `echo line ${i}`).join('\n');
    const text = `Run this:\n\n\`\`\`bash\n${code}\n\`\`\`\n\nThen check it.`;
    const pieces = splitAtParagraphs(text, 500);
    for (const p of pieces) {
      expect(p.length).toBeLessThanOrEqual(500);
      expect(fences(p) % 2).toBe(0);
    }
    const lines = pieces.join('\n').split('\n').filter((l) => l.startsWith('echo line'));
    expect(lines).toHaveLength(200);
    expect(pieces.filter((p) => p.includes('```bash')).length).toBeGreaterThan(1);
  });

  it('keeps blank lines inside a code block, and closes a block left open', () => {
    const pieces = splitAtParagraphs('```\na\n\nb\n', 1000);
    expect(pieces).toEqual(['```\na\n\nb\n\n```']);
  });

  it('breaks a line that is too long by itself', () => {
    const pieces = splitAtParagraphs('word '.repeat(1000).trim(), 300);
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(300);
    expect(pieces.join(' ').split(' ')).toHaveLength(1000);
  });
});

describe('Slack', () => {
  it('escapes & < > so nothing a model writes calls anybody', () => {
    const out = formatAnswer('slack', 'Hey <!channel> <!here> <!everyone> and <@U123ABC> & <https://evil.example|click>');
    const text = slackText(out);
    expect(text).not.toMatch(/<[!@]/);
    expect(text).toContain('&lt;!channel&gt;');
    expect(text).toContain('&lt;@U123ABC&gt;');
    expect(text).toContain('&amp;');
    expect(text).not.toContain('<https://evil');
    expect(slackEscape('a<b>&c')).toBe('a&lt;b&gt;&amp;c');
  });

  it('writes Markdown as Slack does, and leaves code as it is', () => {
    const md = '# Status\n\n**Disk** is fine. See [the runbook](https://kb.example/run?a=1&b=2).\n\n- one\n- two\n\n```bash\nls -la | grep "<x>"\n```';
    const out = toSlackMrkdwn(md);
    expect(out).toContain('*Status*');
    expect(out).toContain('*Disk* is fine');
    expect(out).toContain('<https://kb.example/run?a=1&amp;b=2|the runbook>');
    expect(out).toContain('• one');
    expect(out).toContain('```\nls -la | grep "&lt;x&gt;"\n```');
    expect(out).not.toContain('```bash');
  });

  it('splits a long answer into sections and messages within the limits, and says the rest is in sshs3', () => {
    const paragraph = 'The service restarted at noon and has been fine since. '.repeat(20);
    const text = Array.from({ length: 40 }, () => paragraph).join('\n\n');
    const out = formatAnswer('slack', text, { link: { url: 'https://sshs3.example/t/1', label: 'Open in sshs3' } }) as SlackOut[];
    const blocks = out.flatMap((m) => m.blocks ?? []);
    for (const m of out) expect(m.blocks!.length).toBeLessThanOrEqual(SLACK_BLOCKS_MAX);
    for (const b of blocks) expect((b as { text: { text: string } }).text.text.length).toBeLessThanOrEqual(SLACK_SECTION_MAX);
    const all = slackText(out);
    expect(all.length).toBeLessThan(ANSWER_MAX + 500);
    expect(all).toContain(chatText.restInApp());
    expect(all).toContain('<https://sshs3.example/t/1|Open in sshs3>');
    expect(out[0].text.length).toBeLessThanOrEqual(300);
  });

  it('masks the answer once more', () => {
    const text = slackText(formatAnswer('slack', `Found this:\n${PRIVATE_KEY}`));
    expect(text).not.toContain('MIIEowIBAAKCAQEA');
  });
});

describe('Mattermost', () => {
  it('makes @all, @channel, @here and names harmless, but not a code block or an address in inline code', () => {
    const out = mattermostDefuse('Ping @all @channel @here and @maria.lind, mail ops@example.com\n\n```\nnpm i @types/node\n```\n\nRun `ssh ops@db-1` or `ssh @host`');
    expect(out).not.toMatch(/(^|[^\w])@(all|channel|here|maria)/);
    expect(out).toContain('@\u200Dall');
    expect(out).toContain('@\u200Dmaria.lind');
    // Nothing in front of an @ in prose is trusted to stop a mention, an address included.
    expect(out).toContain('ops@\u200Dexample.com');
    expect(out).toContain('npm i @types/node');
    expect(out).toContain('`ssh ops@db-1`');
    expect(out).toContain('`ssh @\u200Dhost`');
  });

  it('finds no way past the defusing with marks Mattermost trims, or with code it reads differently', () => {
    const calls = (text: string): boolean => /(^|[^\p{L}\p{N}])@(all|channel|here)\b/u.test(text);
    for (const text of ['Heads up _@channel_', '__@all__ now', 'x _@here', '.@channel']) {
      expect(calls(mattermostDefuse(text))).toBe(false);
      expect(calls((note('mattermost', `${text}: done`) as MattermostOut).message)).toBe(false);
    }
    // A closing fence longer than the opening one ends the block, as CommonMark reads it.
    const longer = (formatAnswer('mattermost', '```\nx\n````\n@channel please look\n```')[0] as MattermostOut).message;
    expect(longer).toContain('@\u200Dchannel please look');
    // An opener whose info string holds a backtick is text, not a fence.
    const ticked = (formatAnswer('mattermost', '```x`\n@all hello\n```')[0] as MattermostOut).message;
    expect(ticked).toContain('@\u200Dall hello');
    // A block that holds a line Mattermost could read as a fence is text: ~~~ ends a ``` block there.
    const tilde = (formatAnswer('mattermost', '```\nok\n~~~\n@here look\n```')[0] as MattermostOut).message;
    expect(calls(tilde)).toBe(false);
    // A fence in prose opens nothing, so the code block after it stays code for every reader.
    const opened = (formatAnswer('mattermost', 'intro\n    ```\ntext\n\n```\necho done\n```')[0] as MattermostOut).message;
    expect(opened).not.toMatch(/^ {4}```/m);
    expect(opened).toContain('```\necho done\n```');
    // Inline code paired another way by Mattermost leaves no raw @channel either.
    expect(calls((formatAnswer('mattermost', '``x `@channel` y``')[0] as MattermostOut).message)).toBe(false);
    // In a card, a fence in the text cannot turn the command into text.
    const card = changeCard(change({ description: 'look\n```', command: 'echo @channel' }), { approvers: 'linked', buttons });
    expect(card.mattermost.message).not.toMatch(/^```$\n\n\*\*Where/m);
    expect(card.mattermost.message).toContain('look\n`\u200D`\u200D`');
    // A command with a fence mark of either kind is answered in sshs3, never drawn whole.
    for (const command of ['echo x\n~~~\n@channel', 'echo ```']) {
      const c = changeCard(change({ command }), { approvers: 'linked', buttons });
      expect(c.fits.mattermost).toBe(false);
      expect(c.answerable.mattermost).toBe(false);
    }
  });

  it('shows an image as a link, so no app fetches it by itself', () => {
    expect(mattermostDefuse('![chart](https://evil.example/x.png?d=1)')).toBe('[chart](https://evil.example/x.png?d=1)');
  });

  it('posts at most 15000 characters each and caps the answer', () => {
    const text = Array.from({ length: 300 }, (_, i) => `Paragraph ${i}. ${'x '.repeat(80)}`).join('\n\n');
    const out = formatAnswer('mattermost', text) as MattermostOut[];
    for (const m of out) expect(m.message.length).toBeLessThanOrEqual(MATTERMOST_POST_MAX);
    const all = mmText(out);
    expect(all.length).toBeLessThan(ANSWER_MAX + 200);
    expect(all).toContain(chatText.restInApp());
    expect(all).not.toContain('Paragraph 299');
  });
});

describe('short messages', () => {
  it('escapes and masks, and adds a link only when it is a plain web address', () => {
    const slack = note('slack', 'Hi <!here>', { url: 'https://sshs3.example/x', label: 'sshs3' }) as SlackOut;
    expect(slack.text).toBe('Hi &lt;!here&gt; <https://sshs3.example/x|sshs3>');
    const mm = note('mattermost', 'Hi @here', { url: 'javascript:alert(1)', label: 'x' }) as MattermostOut;
    expect(mm.message).toBe('Hi @\u200Dhere');
  });

  it('says what each limit is in plain words, and never repeats a code', () => {
    expect(chatText.rateLimited('person-new', 10)).toContain('10 conversations');
    expect(chatText.rateLimited('channel', 30)).toContain('This channel');
    expect(chatText.rateLimited('runs')).toContain('other questions');
    expect(chatText.codeInChannel()).toContain('turned it off');
    expect(chatText.freeze('prod-db', Date.parse('2026-11-21T08:00:00Z'), 'release')).toContain('until 2026-11-21 08:00 UTC');
    for (const text of [chatText.help(), chatText.notLinked(), chatText.dmsLinkedOnly(), chatText.budgetSpent(), chatText.channelOff()])
      expect(text).not.toMatch(/ - |—/);
  });
});

const change = (over: Partial<CardChange> = {}): CardChange => ({
  id: 'chg1',
  kind: 'command',
  target: 'web-1',
  description: 'Restart nginx to load the new certificate',
  command: 'sudo systemctl restart nginx',
  riskLevel: 'modify',
  riskReason: 'The site is down for a second.',
  check: { command: 'systemctl is-active nginx', expected: 'active' },
  rollback: 'sudo systemctl start nginx',
  requiredApprovals: 2,
  approvals: [{ actor: 'Maria', allowed: true, at: 1, via: 'slack' }],
  ...over,
});
const buttons = { approve: 'tok-approve', deny: 'tok-deny', mattermostUrl: 'https://sshs3.example/api/chat/mattermost/action' };

describe('change card', () => {
  it('shows everything that is approved, and buttons that carry the signed values', () => {
    const card = changeCard(change({ hiddenValues: true, diff: '--- a\n+++ b\n-x\n+y' }), { approvers: 'linked', buttons });
    expect(card.fits).toEqual({ slack: true, mattermost: true });
    const blocks = card.slack.blocks!;
    const text = blocks.map((b) => JSON.stringify(b)).join('\n');
    for (const want of ['Restart nginx', 'web-1', 'sudo systemctl restart nginx', 'systemctl is-active nginx', 'active', 'sudo systemctl start nginx', '+y', '1 of 2 approvals. Approved by Maria in Slack.', 'Maria in Slack', 'look like secrets', 'linked their chat account'])
      expect(text).toContain(want);
    const actions = blocks.find((b) => b.type === 'actions') as { elements: Array<{ action_id: string; value: string; confirm?: unknown }> };
    expect(actions.elements.map((e) => [e.action_id, e.value])).toEqual([
      [SLACK_APPROVE_ACTION, 'tok-approve'],
      [SLACK_DENY_ACTION, 'tok-deny'],
    ]);
    expect(actions.elements[0].confirm).toBeUndefined();

    const mm = card.mattermost;
    expect(mm.message).toContain('```\nsudo systemctl restart nginx\n```');
    expect(mm.message).toContain('```diff');
    const action = (mm.attachments![0] as { actions: Array<{ id: string; integration: { url: string; context: { t: string } } }> }).actions[0];
    expect(action.id).toBe(MATTERMOST_APPROVE_ACTION);
    expect(action.integration).toEqual({ url: buttons.mattermostUrl, context: { t: 'tok-approve' } });
  });

  it('asks Slack for a second click on production or a destructive change', () => {
    const card = changeCard(change({ riskLevel: 'destructive' }), { approvers: 'admins', production: true, buttons });
    const actions = card.slack.blocks!.find((b) => b.type === 'actions') as { elements: Array<{ confirm?: { text: { text: string } } }> };
    expect(actions.elements[0].confirm?.text.text).toContain('production');
    expect(JSON.stringify(card.slack.blocks)).toContain('administrators');
  });

  it('without a public address, a Mattermost card says to answer with a reaction and has no buttons', () => {
    const card = changeCard(change(), { approvers: 'linked', buttons: { approve: 'a', deny: 'd' } });
    expect(card.mattermost.attachments).toEqual([]);
    expect(card.mattermost.message).toContain('react to this message with ✅');
    expect(card.slack.blocks!.some((b) => b.type === 'actions')).toBe(true);
  });

  it('a card that does not fit whole has no buttons, shows no part of the command, and points to sshs3', () => {
    const long = `echo ${'a'.repeat(CARD_MAX + 100)}`;
    const card = changeCard(change({ command: long }), { approvers: 'linked', buttons, link: 'https://sshs3.example/t/1' });
    expect(card.fits).toEqual({ slack: false, mattermost: false });
    expect(card.slack.blocks!.some((b) => b.type === 'actions')).toBe(false);
    expect(card.mattermost.attachments).toEqual([]);
    expect(JSON.stringify(card.slack.blocks)).not.toContain('aaaaaaaaaa');
    expect(card.mattermost.message).not.toContain('aaaaaaaaaa');
    expect(JSON.stringify(card.slack.blocks)).toContain('too long to show here in full');
    expect(card.mattermost.message).toContain('[Open in sshs3](https://sshs3.example/t/1)');
  });

  it('a command that holds a fence mark would break out of its block: answered in sshs3', () => {
    const card = changeCard(change({ command: "printf '```\\n'" }), { approvers: 'linked', buttons });
    expect(card.fits.slack).toBe(false);
    expect(card.slack.blocks!.some((b) => b.type === 'actions')).toBe(false);
  });

  it("a change to sshs3's own rules is answered only in the app", () => {
    const card = changeCard(change({ kind: 'setting' }), { approvers: 'linked', buttons });
    expect(card.slack.blocks!.some((b) => b.type === 'actions')).toBe(false);
    expect(card.mattermost.attachments).toEqual([]);
    expect(card.mattermost.message).toContain('only in the app');
  });

  it('shows how it ended, with no buttons', () => {
    const approved = changeCard(change(), { approvers: 'linked', buttons, final: { state: 'approved', by: ['Maria', 'Lina'], via: 'slack' } });
    expect(JSON.stringify(approved.slack.blocks)).toContain('Approved by Maria and Lina in Slack.');
    expect(approved.slack.blocks!.some((b) => b.type === 'actions')).toBe(false);
    // Who approved it is said once, not in an approvals line and again below it.
    expect(JSON.stringify(approved.slack.blocks).match(/Approved by/g)).toHaveLength(1);
    expect(approved.mattermost.message.match(/Approved by/g)).toHaveLength(1);
    // A denied card still shows who approved before somebody denied it.
    expect(JSON.stringify(changeCard(change(), { approvers: 'linked', final: { state: 'denied', by: ['Omar'], via: 'slack' } }).slack.blocks)).toContain('1 of 2 approvals. Approved by Maria in Slack.');
    const restarted = changeCard(change(), { approvers: 'linked', final: { state: 'restarted' } });
    expect(restarted.mattermost.message).toContain(RESTARTED_TEXT);
    expect(restarted.mattermost.attachments).toEqual([]);
    expect(JSON.stringify(changeCard(change(), { approvers: 'linked', final: { state: 'denied', by: ['Omar'], via: 'mattermost' } }).slack.blocks)).toContain(
      'Denied by Omar in Mattermost.',
    );
    expect(JSON.stringify(changeCard(change(), { approvers: 'linked', final: { state: 'expired' } }).slack.blocks)).toContain('Expired');
  });

  it('makes names and text from chat harmless on both services', () => {
    const card = changeCard(change({ description: 'Tell <!channel> and @all', approvals: [{ actor: '@here', allowed: true, at: 1 }] }), { approvers: 'linked', buttons });
    expect(JSON.stringify(card.slack.blocks)).not.toContain('<!channel>');
    expect(card.mattermost.message).not.toMatch(/(^|[^\w])@(all|here)\b/);
  });
});

const plan = (over: Partial<CardPlan> = {}): CardPlan => ({
  id: 'plan1',
  goal: 'Move the database to the new disk',
  status: 'proposed',
  steps: [
    { action: 'Stop the service', target: 'db-1', command: 'systemctl stop pg', risk: 'medium', check: 'systemctl is-active pg', checkExpected: 'inactive', rollback: 'systemctl start pg' },
    { action: 'Copy the data', target: 'db-1', command: 'rsync -a /var/lib/pg /mnt/new', risk: 'high', check: 'du -sh /mnt/new' },
  ],
  review: { verdict: 'revise', findings: ['Take a backup first.'] },
  requiredApprovals: 2,
  approvals: [],
  ...over,
});

describe('plan card', () => {
  it('shows the goal, every step, the review and how many must approve', () => {
    const card = planCard(plan(), { approvers: 'linked', production: true, buttons });
    const text = JSON.stringify(card.slack.blocks);
    for (const want of ['Move the database', 'Step 1', 'Stop the service', 'systemctl stop pg', 'Risk: medium', 'inactive', 'systemctl start pg', 'Step 2', 'rsync -a', 'asks for changes', 'Take a backup first.', 'No approvals yet. 2 needed.', 'production'])
      expect(text).toContain(want);
    expect(card.mattermost.message).toContain('**Step 2**');
    expect(card.fits.mattermost).toBe(true);
  });
});

describe('card lines', () => {
  it('end as sentences where they are prose, whatever the model wrote', () => {
    const card = changeCard(
      change({ description: 'Restart the Harvest poller', riskReason: 'Systemd service state modification', blastRadius: 'the poller only', check: { command: 'systemctl is-active harvest', expected: 'active' } }),
      { approvers: 'linked', buttons },
    );
    const mm = card.mattermost.message;
    expect(mm).toContain('Restart the Harvest poller.');
    expect(mm).toContain('It changes something. Systemd service state modification.');
    expect(mm).toContain('What it can affect: the poller only.');
    expect(mm).toContain('It should show: active.');
    // A command is not prose: it gets no period.
    expect(mm).toContain('```\nsystemctl is-active harvest\n```');
    // What already ends a sentence keeps its own mark.
    expect(changeCard(change({ description: 'Is it up?' }), { approvers: 'linked', buttons }).mattermost.message).toContain('Is it up?\n');

    const p = planCard(plan({ goal: 'Move the database', review: { verdict: 'revise', findings: ['Take a backup first'] } }), { approvers: 'linked', buttons }).mattermost.message;
    expect(p).toContain('Move the database.');
    expect(p).toContain('Stop the service.');
    expect(p).toContain('It should show: inactive.');
    expect(p).toContain('• Take a backup first.');
  });
});

describe('status line', () => {
  const base = { pending: [] as CardChange[], commandsUsed: 3 };
  it('says what the run does, in one plain line', () => {
    expect(statusText({ ...base, status: 'queued' })).toBe('Starting.');
    expect(statusText({ ...base, status: 'running', lastStep: { name: 'terminal_exec', target: 'web-1', at: 1 } })).toBe(
      'Working on it. 3 commands so far. Last step: ran a command on web-1.',
    );
    expect(statusText({ ...base, status: 'waiting', pending: [change()] })).toContain('Waiting for approval of a change.');
    expect(statusText({ ...base, status: 'waiting', plan: plan() })).toContain('plan to be approved');
    expect(statusText({ ...base, status: 'completed' })).toBe('Done. 3 commands ran.');
    expect(statusText({ ...base, status: 'failed', error: 'model timed out' })).toBe('Stopped with an error: model timed out');
    expect(statusText({ ...base, status: 'interrupted' })).toBe(RESTARTED_TEXT);
  });

  it('cuts a long step short', () => {
    const line = statusText({ ...base, status: 'running', lastStep: { name: 'terminal_exec', target: 'x'.repeat(500), at: 1 } });
    expect(line.length).toBeLessThan(300);
  });
});
