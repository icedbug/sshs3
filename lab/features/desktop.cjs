#!/usr/bin/env node
'use strict';
/*
 * Area 11, the desktop app: the AI workspace in the Electron app on one person's computer, against the
 * lab's servers, with the real model through the lab's proxy (the app gets a dummy key, as the web
 * server's people do). The app is the one `npm run bundle:desktop` built from this checkout. It needs a
 * display, so it runs under a virtual one:
 *
 *   xvfb-run -a node lab/features/desktop.cjs [--ws <file>] [--only <id>,<id>]
 *
 * The app gets a home of its own (its settings, its SSH key, its known_hosts), under
 * lab/.state/desktop/<time>/, and its results go where the web checks' do, under features/<time>/.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const { _electron: electron } = require('playwright');
const { readWorkspace, personOn, watchErrors, onServer, sleep } = require('../ui/person.cjs');

const REPO = path.join(__dirname, '..', '..');
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const AREA = '11 The desktop app';
const DOC = 'docs/ai-hub.md and the desktop app';
/** What the app must not have of the lab's environment: the way out, and every real model key. */
const WITHHELD = ['NODE_USE_ENV_PROXY', 'LAB_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'];
const word = () => `lab${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const fileExists = async (ws, server, file) => (await onServer(ws, server, `test -e ${file}`)).code === 0;

/** A home for the app: an SSH key the lab's servers take for the ops account, and their host keys. */
async function homeFor(ws, dir) {
  const home = path.join(dir, 'home');
  const ssh = path.join(home, '.ssh');
  fs.mkdirSync(ssh, { recursive: true, mode: 0o700 });
  const key = path.join(ssh, 'id_ed25519');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'lab-desktop', '-f', key]);
  const publicKey = fs.readFileSync(`${key}.pub`, 'utf8').trim();
  const add = `install -d -m 700 -o ops -g ops /home/ops/.ssh && touch /home/ops/.ssh/authorized_keys && (grep -qxF '${publicKey}' /home/ops/.ssh/authorized_keys || echo '${publicKey}' >> /home/ops/.ssh/authorized_keys) && chown ops:ops /home/ops/.ssh/authorized_keys && chmod 600 /home/ops/.ssh/authorized_keys`;
  for (const s of ws.servers.filter((x) => x.role !== 's3')) {
    const r = await onServer(ws, s.name, add);
    if (r.code !== 0) throw new Error(`Could not put the desktop key on ${s.name}: ${r.stderr || r.stdout}`);
  }
  fs.writeFileSync(path.join(ssh, 'known_hosts'), `${ws.hostKeys.trim()}\n`, { mode: 0o600 });
  return { home, key, publicKey };
}

/** Takes the desktop key off the lab's servers again. */
async function forget(ws, publicKey) {
  for (const s of ws.servers.filter((x) => x.role !== 's3'))
    await onServer(ws, s.name, `grep -vxF '${publicKey}' /home/ops/.ssh/authorized_keys > /tmp/ak.lab; cat /tmp/ak.lab > /home/ops/.ssh/authorized_keys; rm -f /tmp/ak.lab`);
}

/** Starts the desktop app with that home, the lab's CA and no way out but to the lab. */
async function startApp(home, ws) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !WITHHELD.includes(k)) env[k] = v;
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    NODE_EXTRA_CA_CERTS: ws.trustBundle,
    SSHS3_ALLOW_PRIVATE_ADDRESSES: '1',
  });
  const app = await electron.launch({
    executablePath: path.join(REPO, 'node_modules', 'electron', 'dist', 'electron'),
    args: ['--no-sandbox', REPO],
    env,
    timeout: 90_000,
  });
  const page = await app.firstWindow();
  const errors = watchErrors(page);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4000);
  return { app, page, errors };
}

/**
 * The fingerprints of a lab server's host keys, as `ssh-keygen -lf` shows them. OpenSSH in the app asks
 * about a host it has not seen and shows one of these: a careful person compares them before saying yes.
 */
function fingerprints(ws, ip) {
  const lines = ws.hostKeys.split('\n').filter((l) => l.split(/\s+/)[0].split(',').includes(ip));
  if (!lines.length) return [];
  const file = path.join(os.tmpdir(), `lab-hostkeys-${process.pid}`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  try {
    return execFileSync('ssh-keygen', ['-lf', file]).toString().match(/SHA256:[A-Za-z0-9+/]+/g) || [];
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/**
 * The app's ssh asks once whether to trust a server's host key: OpenSSH keeps it in the account's own
 * ~/.ssh/known_hosts, which it finds through the account, not through $HOME. The person reads the
 * fingerprint, compares it with the server's own, and types yes. Returns whether it was asked.
 */
async function answerHostKey(p, ws, server) {
  const s = ws.servers.find((x) => x.name === server);
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    // The terminal that shows must be this server's: the strip over it names the server.
    const strip = await p.page.getByTestId('terminal-control-bar').filter({ visible: true }).first().innerText().catch(() => '');
    if (!strip.includes(`· ${server}`)) {
      await sleep(500);
      continue;
    }
    const rows = await p.page.locator('.xterm-rows').filter({ visible: true }).first().innerText().catch(() => '');
    // Only a question about this server's own address, asked after the last one answered.
    const at = rows.lastIndexOf(`host '${s.ip}`);
    const shown = at >= 0 ? rows.slice(at) : '';
    // Unanswered: the question is the last thing on the screen.
    const question = shown.slice(shown.lastIndexOf('continue connecting'));
    if (shown.includes('continue connecting') && /^continue connecting \(yes\/no[^)]*\)\?\s*$/.test(question)) {
      const fingerprint = (shown.match(/SHA256:[A-Za-z0-9+/]+/) || [])[0];
      if (!fingerprint || !fingerprints(ws, s.ip).includes(fingerprint)) throw new Error(`${server} showed a host key the lab does not have: ${fingerprint}`);
      await p.page.locator('.xterm-helper-textarea').filter({ visible: true }).first().focus();
      await p.page.keyboard.type('yes');
      await p.page.keyboard.press('Enter');
      await p.page.waitForTimeout(2500);
      return true;
    }
    if (/\$\s*$/m.test(rows) && at < 0) return false;
    await sleep(500);
  }
  return false;
}

/** Takes the lab's servers out of the account's known_hosts again, as they were before the run. */
function forgetHostKeys(ws, hadKnownHosts) {
  const file = path.join(os.homedir(), '.ssh', 'known_hosts');
  for (const s of ws.servers) execFileSync('ssh-keygen', ['-R', s.ip, '-f', file], { stdio: 'ignore' });
  // ssh-keygen keeps the file as it was in known_hosts.old: the lab's keys, which go too. A file the run
  // made goes when it is empty again.
  fs.rmSync(`${file}.old`, { force: true });
  if (!hadKnownHosts && fs.existsSync(file) && fs.statSync(file).size === 0) fs.rmSync(file);
}

/** The person at the desktop app: the model through the lab's proxy, and the lab's servers saved. */
async function setUp(page, ws, runId, key) {
  await page.evaluate((config) => window.multissh.aiHubRequest({ action: 'configure', config }), {
    enabled: true,
    provider: 'anthropic',
    model: ws.model,
    baseUrl: ws.proxyUrl,
    apiKey: `lab-${runId}`,
  });
  for (const s of ws.servers.filter((x) => x.role !== 's3')) {
    await page.evaluate((profile) => window.multissh.profilesSaveSSH(profile), {
      id: s.name,
      name: s.name,
      host: s.ip,
      port: 22,
      username: 'ops',
      authType: 'privateKey',
      privateKeyPath: key,
    });
  }
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4000);
  // The notice that saved passwords are not encrypted (this machine has no keyring) is read and closed.
  const dismiss = page.getByTestId('credential-encryption-warning-banner').getByRole('button', { name: 'Dismiss' });
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click();
}

/** A terminal on the server, the host key question answered the careful way when it is asked. */
async function openTerminal(ctx, server) {
  const asked = ctx.p.terminal(server).then(() => 'open', (e) => e);
  const answered = await answerHostKey(ctx.p, ctx.ws, server);
  if (answered) ctx.note(`ssh asked whether to trust ${server}'s host key; its fingerprint matched the server's own, and the person said yes.`);
  const result = await asked;
  if (result !== 'open') throw result;
}

const CHECKS = [
  {
    id: 'desktop-starts',
    title: 'The desktop app starts, with the AI workspace and the servers',
    expected: 'The app opens its window without errors; the AI dock opens; the lab\'s servers are listed.',
    async run(ctx) {
      const p = ctx.p;
      await ctx.shot('start');
      await p.dock();
      await ctx.shot('dock');
      ctx.expect(await p.page.getByTestId('ai-dock').isVisible(), 'the AI dock opens');
      const status = await p.hub({ action: 'snapshot' }).then((s) => s.config && s.config.model).catch((e) => String(e));
      ctx.expect(status === ctx.ws.model, `the AI uses ${ctx.ws.model}`, status);
    },
  },
  {
    id: 'desktop-ask',
    title: 'A question in the desktop app is answered from the server, with the real model',
    expected: 'In Ask first on web-01, "how long has this server been up" runs a command that only looks, unasked, and answers with what it showed.',
    async run(ctx) {
      const p = ctx.p;
      await openTerminal(ctx, 'web-01');
      await p.newChat();
      await p.mode('assisted');
      const t0 = Date.now();
      await p.ask('How long has this server been up? One short sentence.');
      const task = await p.waitSettled((await p.newestSince(t0 - 2000)).id);
      await p.page.waitForTimeout(1500);
      await ctx.shot('answer');
      const said = await p.answer(task.id);
      ctx.note(`The answer: ${said.slice(0, 300)}`);
      ctx.expect(task.status === 'completed', 'the conversation ends completed', task.status);
      ctx.expect((task.commandsUsed || 0) > 0, 'the agent looked on the server', `commandsUsed ${task.commandsUsed}`);
      ctx.expect(/\bup\b|day|hour|minute/i.test(said), 'the answer says how long', said.slice(0, 300));
    },
  },
  {
    id: 'desktop-change-card',
    title: 'A change in the desktop app waits for the person and runs once approved',
    expected: 'In Ask first on web-02, a request to make a file gives a change card that waits; nothing changes before "Approve Once" in the bar over the terminal; then the file is there.',
    async run(ctx) {
      const p = ctx.p;
      const w = word();
      const file = `/tmp/${w}`;
      try {
        await openTerminal(ctx, 'web-02');
        await p.newChat();
        await p.mode('assisted');
        const t0 = Date.now();
        await p.ask(`Please create the file ${file} on this server, containing exactly the text ${w}. It is only a test file, nothing else should change.`);
        const task = await p.newestSince(t0 - 2000);
        const waiting = await p.waitTask((t) => t.id === task.id && ((t.changes || []).some((c) => c.status === 'pending') || !['queued', 'running'].includes(t.status)), 300_000);
        const card = (waiting.changes || []).find((c) => c.status === 'pending');
        await p.page.waitForTimeout(1500);
        await ctx.shot('waiting');
        if (!ctx.expect(card, 'a change card waits for the person', `${waiting.status}`)) return;
        ctx.expect(!(await fileExists(ctx.ws, 'web-02', file)), 'nothing is changed before it is approved');
        await p.approveInTerminal();
        const done = await p.waitSettled(task.id, 300_000);
        await p.page.waitForTimeout(1500);
        await ctx.shot('done');
        const ran = (done.changes || []).find((c) => c.id === card.id);
        ctx.expect(ran && ran.status === 'completed', 'the change runs once approved', ran && ran.status);
        const content = await onServer(ctx.ws, 'web-02', `cat ${file}`);
        ctx.expect(content.stdout.includes(w), 'the file is on web-02', content.stdout + content.stderr);
      } finally {
        await onServer(ctx.ws, 'web-02', `rm -f ${file}`);
      }
    },
  },
];

async function main() {
  const ws = readWorkspace(opt('ws'));
  if (!ws.proxyUrl || !ws.trustBundle) throw new Error('The workspace file has no proxy for another app: start the workspace again with this lab code.');
  const only = opt('only') ? opt('only').split(',') : undefined;
  const chosen = CHECKS.filter((c) => !only || only.includes(c.id));
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  const out = path.join(__dirname, '..', '.state', 'results', 'features', stamp);
  const dir = path.join(__dirname, '..', '.state', 'desktop', stamp);
  fs.mkdirSync(out, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  const runId = `${path.basename(ws.modelCalls.maria, '.jsonl').replace(/-maria$/, '')}-desktop-${stamp}`;
  const callsFile = path.join(path.dirname(ws.modelCalls.maria), `${runId}.jsonl`);
  // OpenSSH reads the account's own known_hosts whatever HOME says: whether it was there before decides
  // whether an empty one is taken away at the end.
  const hadKnownHosts = fs.existsSync(path.join(os.homedir(), '.ssh', 'known_hosts'));
  const { home, key, publicKey } = await homeFor(ws, dir);
  const results = [];
  let app;
  try {
    const started = await startApp(home, ws);
    app = started.app;
    await setUp(started.page, ws, runId, key);
    const p = personOn(started.page, { who: 'desktop', ws, errors: started.errors });
    for (const check of chosen) {
      const cdir = path.join(out, check.id);
      fs.mkdirSync(cdir, { recursive: true });
      const result = { id: check.id, area: AREA, title: check.title, expected: check.expected, doc: DOC, startedAt: new Date().toISOString(), expectations: [], notes: [], shots: [], errorsOnPage: [] };
      const before = p.errors.length;
      const ctx = {
        ws,
        p,
        sleep,
        note: (t) => result.notes.push(String(t).slice(0, 3000)),
        expect: (ok, what, detail) => {
          result.expectations.push({ ok: Boolean(ok), what, ...(detail === undefined ? {} : { detail: String(detail).slice(0, 2000) }) });
          return Boolean(ok);
        },
        shot: async (name) => {
          const file = await p.shot(cdir, name);
          result.shots.push(path.relative(out, file));
        },
      };
      const t0 = Date.now();
      try {
        await check.run(ctx);
      } catch (error) {
        result.error = String((error && error.stack) || error).slice(0, 2500);
        await ctx.shot('when-it-broke').catch(() => {});
      }
      result.ms = Date.now() - t0;
      result.errorsOnPage = [...new Set(p.errors.slice(before))];
      result.verdict = result.error ? 'broke' : result.expectations.every((e) => e.ok) ? 'pass' : 'fail';
      fs.writeFileSync(path.join(cdir, 'result.json'), JSON.stringify(result, null, 2));
      results.push(result);
      const failed = result.expectations.filter((e) => !e.ok).map((e) => e.what);
      console.log(`${new Date().toISOString()} ${result.verdict.toUpperCase()} ${check.id} in ${Math.round(result.ms / 1000)} s${failed.length ? `: ${failed.join('; ')}` : ''}${result.error ? `: ${result.error.split('\n')[0]}` : ''}`);
    }
  } finally {
    await app?.close().catch(() => {});
    await forget(ws, publicKey).catch(() => {});
    try {
      forgetHostKeys(ws, hadKnownHosts);
    } catch {
      // Nothing to take out.
    }
    const calls = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).length : 0;
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ results, modelCalls: calls, callsFile: path.relative(REPO, callsFile) }, null, 2));
    console.log(`${calls} model calls. Results: ${out}`);
  }
}

main().catch((error) => {
  console.error(String((error && error.stack) || error));
  process.exit(1);
});
