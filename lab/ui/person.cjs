'use strict';
/*
 * A person of the lab's team using the AI workspace in a real browser: signs in, opens a terminal on a
 * server, uses the chat panel and the views, and reads what the workspace says back. The feature checks
 * and the exploring testers use it; nothing here knows what a check expects.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { chromium } = require('playwright');

const launch = () => chromium.launch();

/** The workspace file `npm run lab -- workspace` writes. */
function readWorkspace(file) {
  return JSON.parse(fs.readFileSync(file || path.join(__dirname, '..', '.state', 'workspace-9.json'), 'utf8'));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Signs the person in, in a browser context of their own, and opens the workspace. */
async function signIn(browser, ws, who, opts = {}) {
  const person = ws.people[who];
  if (!person) throw new Error(`No one called ${who} in the workspace.`);
  const login = await fetch(`${ws.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: person.username, password: person.password }),
  });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  if (!login.ok || !cookie) throw new Error(`${who} could not sign in: HTTP ${login.status}.`);
  const [name, ...value] = cookie.split('=');
  const context = await browser.newContext({ viewport: { width: opts.width || 1500, height: opts.height || 1000 } });
  await context.addCookies([{ name, value: value.join('='), url: ws.baseUrl }]);
  const page = await context.newPage();
  const errors = watchErrors(page);
  await page.goto(ws.baseUrl);
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1500);
  return personOn(page, { who, ws, errors, close: () => context.close() });
}

/** The errors the page reports from now on: uncaught ones and those written to its console. */
function watchErrors(page) {
  const errors = [];
  // An uncaught error with where it was thrown: the first frames of its stack say whose code it is.
  page.on('pageerror', (e) => {
    const frames = String(e.stack || '').split('\n').slice(1, 4).map((l) => l.trim().replace(/https?:\/\/[^/]+/g, '')).join(' < ');
    errors.push(`page error: ${String(e).slice(0, 300)}${frames ? ` at ${frames.slice(0, 400)}` : ''}`);
  });
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console error: ${m.text().slice(0, 400)}`);
  });
  return errors;
}

/**
 * A person's hands on a window of the app that is already open: the web client in a browser, or the
 * desktop app's own window. Both talk to the AI workspace through `window.multissh`.
 */
function personOn(page, { who, ws, errors = watchErrors(page), close = async () => {} }) {
  const p = { who, page, errors, ws };

  /** A request to the workspace as the page itself sends it: the person's own view of the data. */
  p.hub = (req) => page.evaluate((q) => window.multissh.aiHubRequest(q), req);
  p.snapshot = () => p.hub({ action: 'snapshot' });

  /** The AI dock, opened with the Chat button in the top bar if it is closed. */
  p.dock = async () => {
    const dock = page.getByTestId('ai-dock');
    if (!(await dock.isVisible().catch(() => false))) {
      await page.getByTestId('topbar-chat-toggle-btn').click();
      await dock.waitFor({ state: 'visible', timeout: 15_000 });
      await page.waitForTimeout(500);
    }
  };

  /**
   * Opens a view of the AI workspace (Work is the chat). The view switch is heard by the AI dock only
   * while it is open, so it is opened first, as a person would with the Chat button.
   */
  p.open = async (view) => {
    await p.dock();
    await page.evaluate((v) => window.dispatchEvent(new CustomEvent('sshs3:ai-open', { detail: { view: v, mode: v === 'Work' ? 'panel' : 'hub' } })), view);
    await page.waitForTimeout(1200);
  };

  /** The chat panel beside the terminals, opened if it is closed. */
  p.panel = async () => {
    const composer = page.getByTestId('ai-composer');
    if (!(await composer.isVisible().catch(() => false))) {
      await p.dock();
      if (!(await composer.isVisible().catch(() => false))) {
        await page.evaluate(() => window.dispatchEvent(new CustomEvent('sshs3:ai-open', { detail: { view: 'Work', mode: 'panel' } })));
      }
      await composer.waitFor({ state: 'visible', timeout: 15_000 });
    }
  };

  /** A terminal on the server, opened from its card on the start page unless a tab for it is open. */
  p.terminal = async (server) => {
    const tab = page.locator('[data-testid^="tab-term-"]').filter({ hasText: server }).first();
    if ((await tab.count()) > 0) {
      await tab.click();
      // A tab restored after the page was opened again may have lost its session ("Session ended"):
      // it is connected again, as a person would with Reconnect.
      await page.waitForTimeout(800);
      const reconnect = page.getByRole('button', { name: 'Reconnect', exact: true }).filter({ visible: true }).first();
      if (await reconnect.isVisible().catch(() => false)) await reconnect.click();
    } else {
      const card = page.getByTestId(`workspace-server-card-${server}`);
      if (await card.isVisible().catch(() => false)) {
        // The start page: the server's card has a Terminal button.
        await card.getByRole('button', { name: 'Terminal', exact: true }).click();
      } else {
        // Tabs are open: a tab without a connection (or a new one), then the server's Connect in the
        // connection manager.
        const select = page.getByTestId('select-ssh-connection-btn').first();
        const empty = page.locator('[data-testid^="tab-term-"]').filter({ hasText: /^Terminal \d+$/ }).first();
        if ((await empty.count()) > 0) await empty.click();
        if (!(await select.isVisible().catch(() => false))) {
          await page.getByTestId('add-tab-btn').click();
          await page.getByText('New Terminal', { exact: true }).first().click();
          await select.waitFor({ state: 'visible', timeout: 15_000 });
        }
        await select.click();
        const row = page.locator(`xpath=//*[normalize-space(text())="${server}"]/ancestor::*[.//button[normalize-space()="Connect"]][1]`).first();
        await row.getByRole('button', { name: 'Connect', exact: true }).click();
      }
    }
    await page.getByText(`You control · ${server}`).first().waitFor({ state: 'visible', timeout: 30_000 });
    // What the panel sends a question with is the workspace's own list of terminals: it waits until
    // the workspace has the server's terminal connected, not only until the page says so.
    const until = Date.now() + 30_000;
    while (!((await p.snapshot()).sessions || []).some((s) => s.label === server && s.state !== 'disconnected')) {
      if (Date.now() > until) throw new Error(`The workspace has no connected terminal on ${server}.`);
      await sleep(500);
    }
    await page.waitForTimeout(1500);
  };

  /** A new conversation in the panel. */
  p.newChat = async () => {
    await p.panel();
    await page.getByRole('button', { name: 'New chat', exact: true }).first().click();
    await page.waitForTimeout(600);
  };

  p.mode = async (mode) => {
    await page.getByTestId(`ai-mode-pill-${mode}`).click();
    await page.waitForTimeout(300);
  };

  /** Types a message in the panel and sends it with Enter. */
  p.ask = async (text) => {
    await p.panel();
    await page.evaluate(() => {
      window.__labAnswerLengths = [];
    });
    await page.getByTestId('ai-composer').fill(text);
    await page.getByTestId('ai-composer').press('Enter');
  };

  /** The person's conversations, newest last. A long one is in the snapshot by its last messages only. */
  p.tasks = async () => (await p.snapshot()).tasks || [];

  /** A conversation whole: every message and every change, as the window that shows it reads it. */
  p.read = async (taskId) => (await p.hub({ action: 'task-read', taskId })).reply.task;

  /** The whole of what the agent answered in the conversation. */
  p.answer = async (taskId) =>
    (await p.read(taskId)).messages.filter((m) => m.role === 'assistant').map((m) => m.text || '').join('\n');

  /** Waits until a conversation satisfies the test, and returns it. */
  p.waitTask = async (test, ms = 240_000) => {
    const until = Date.now() + ms;
    for (;;) {
      const found = (await p.tasks()).find(test);
      if (found) return found;
      if (Date.now() > until) throw new Error(`No conversation of ${who} came to the state the check waits for within ${Math.round(ms / 1000)} s.`);
      await sleep(1500);
    }
  };

  /** Waits until the conversation has stopped running: done, failed, stopped, or waiting for a person. */
  p.waitSettled = async (taskId, ms = 300_000) =>
    p.waitTask((t) => t.id === taskId && !['queued', 'running'].includes(t.status), ms);

  /** Whether a task is a conversation a person had, not a run the workspace made for itself. */
  p.isConversation = (t) => !t.distillSourceId && !t.workforceRunId;

  /** The newest conversation the person started after the given time. */
  p.newestSince = async (since, ms = 60_000) => p.waitTask((t) => p.isConversation(t) && (t.createdAt || 0) >= since, ms);

  /**
   * Waits until the conversation has stopped running, and says whether the answer was seen in the panel
   * while it was being written.
   */
  p.watchUntilSettled = async (taskId, ms = 300_000) => {
    const until = Date.now() + ms;
    // Seen by the page itself, however briefly it shows: an observer notes every streaming message added.
    // Seen by the page itself: an observer notes each new length of the last answer in the panel. An
    // answer that grows in several steps before the run ends was shown while it was being written.
    await page.evaluate(() => {
      if (window.__labStreamWatch) return;
      window.__labStreamWatch = true;
      window.__labAnswerLengths = [];
      new MutationObserver(() => {
        const last = [...document.querySelectorAll('.ai-message-assistant')].at(-1);
        const n = last ? last.textContent.length : 0;
        const seen = window.__labAnswerLengths;
        if (n > 0 && seen.at(-1) !== n) seen.push(n);
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    for (;;) {
      const t = (await p.tasks()).find((x) => x.id === taskId);
      if (t && !['queued', 'running'].includes(t.status)) {
        const lengths = await page.evaluate(() => window.__labAnswerLengths || []);
        // Growing: at least three different lengths, each longer than the one before.
        const growing = lengths.filter((n, i) => i === 0 || n > lengths[i - 1]).length;
        return { task: t, streamed: growing >= 3, lengths };
      }
      if (Date.now() > until) throw new Error(`The conversation did not end within ${Math.round(ms / 1000)} s.`);
      await sleep(250);
    }
  };

  /** The one of a test id that shows: every terminal tab has its own bar, only the active one shows. */
  p.visible = (testId) => page.getByTestId(testId).filter({ visible: true }).first();

  /** "Approve Once" and "Deny" in the bar over the terminal that shows. */
  p.approveInTerminal = () => p.visible('terminal-approve-once-btn').click();
  p.denyInTerminal = () => p.visible('terminal-deny-btn').click();

  p.shot = async (dir, name) => {
    const file = path.join(dir, `${who}-${name}.png`);
    await page.screenshot({ path: file });
    return file;
  };

  p.close = close;
  return p;
}

/** The person's model calls the proxy has written so far: their number and their tokens. */
function calls(ws, who) {
  let text = '';
  try {
    text = fs.readFileSync(ws.modelCalls[who], 'utf8');
  } catch {
    // No call yet: the proxy writes the file at the first one.
  }
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** A command on a lab server as the lab itself runs it, to see the server's state without the product. */
function onServer(ws, server, command, timeoutMs = 60_000) {
  const s = ws.servers.find((x) => x.name === server);
  if (!s) throw new Error(`No server called ${server}.`);
  return new Promise((resolve) => {
    execFile(
      'ssh',
      ['-i', ws.serverKey, '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=ERROR', '-o', 'BatchMode=yes', `root@${s.ip}`, command],
      { timeout: timeoutMs },
      (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
    );
  });
}

module.exports = { launch, readWorkspace, signIn, personOn, watchErrors, calls, onServer, sleep };
