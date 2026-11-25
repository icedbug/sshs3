#!/usr/bin/env node
/*
 * A person of the lab's team in a real browser, against the workspace that `npm run lab -- workspace`
 * started. The steps run in the order given, in one page:
 *
 *   node lab/ui/browser.cjs --as maria --goto Inbox --ids inbox --shot /tmp/inbox.png
 *
 *   --ws <file>             the workspace file (default: lab/.state/workspace-9.json)
 *   --as <maria|omar|lina>  who signs in (default: maria)
 *   --goto <view>           opens a view of the AI workspace: Work, Inbox, Workforce, Infrastructure,
 *                           "Knowledge Base", Changes, "Memory & skills", "Agents & MCP", Schedules
 *   --panel                 opens the AI panel beside the terminals (the chat)
 *   --click <target>        a target is id:<test id>, text:<visible text>, role:<role>:<name>, or a
 *                           bare word, tried as a test id first and as text then
 *   --type <target> <text>  fills a field
 *   --press <key>           presses a key (Enter, Escape, Control+K)
 *   --scroll <target>       scrolls the target into view
 *   --wait <ms>             waits
 *   --waitfor <target> [ms] waits until the target shows (default 60000 ms)
 *   --waitgone <target> [ms] waits until the target is gone
 *   --text [target]         prints the visible text of the target, or of the whole page
 *   --ids [prefix]          prints the test ids that show, or those that start with the prefix
 *   --shot <file>           saves a screenshot
 *   --files <target> <path> gives a file input a file
 *
 * At the end it prints what the page itself reported as an error: those are often bugs.
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const wsFile = opt('ws', path.join(__dirname, '..', '.state', 'workspace-9.json'));
const who = opt('as', 'maria');
const [width, height] = (opt('size', '1500x1000')).split('x').map(Number);

function locate(page, target) {
  if (target.startsWith('id:')) return page.getByTestId(target.slice(3)).first();
  if (target.startsWith('text:')) return page.getByText(target.slice(5), { exact: false }).first();
  if (target.startsWith('exact:')) return page.getByText(target.slice(6), { exact: true }).first();
  if (target.startsWith('role:')) {
    const [, role, ...name] = target.split(':');
    return page.getByRole(role, name.length ? { name: name.join(':'), exact: false } : {}).first();
  }
  if (target.startsWith('css:')) return page.locator(target.slice(4)).first();
  return page.getByTestId(target).or(page.getByText(target, { exact: false })).first();
}

async function main() {
  const ws = JSON.parse(fs.readFileSync(wsFile, 'utf8'));
  const person = ws.people[who];
  if (!person) throw new Error(`No one called ${who} in the workspace: ${Object.keys(ws.people).join(', ')}.`);
  const login = await fetch(`${ws.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: person.username, password: person.password }),
  });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  if (!login.ok || !cookie) throw new Error(`${who} could not sign in: HTTP ${login.status}.`);
  const [name, ...value] = cookie.split('=');

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width, height } });
  await context.addCookies([{ name, value: value.join('='), url: ws.baseUrl }]);
  const page = await context.newPage();
  const reported = [];
  page.on('pageerror', (e) => reported.push(`page error: ${String(e).slice(0, 300)}`));
  page.on('console', (m) => m.type() === 'error' && reported.push(`console error: ${m.text().slice(0, 300)}`));
  await page.goto(ws.baseUrl);
  await page.waitForLoadState('networkidle').catch(() => {});

  for (let i = 0; i < argv.length; i++) {
    const step = argv[i];
    const next = () => argv[++i];
    switch (step) {
      case '--ws':
      case '--as':
      case '--size':
        i++;
        break;
      case '--goto': {
        const view = next();
        // The AI dock hears a view switch only while it is open: it is opened first, with the Chat button.
        if (!(await page.getByTestId('ai-dock').isVisible().catch(() => false))) {
          await page.getByTestId('topbar-chat-toggle-btn').click();
          await page.getByTestId('ai-dock').waitFor({ state: 'visible', timeout: 15_000 });
        }
        await page.evaluate((v) => window.dispatchEvent(new CustomEvent('sshs3:ai-open', { detail: { view: v, mode: v === 'Work' ? 'panel' : 'hub' } })), view);
        await page.waitForTimeout(1200);
        break;
      }
      case '--panel':
        if (!(await page.getByTestId('ai-dock').isVisible().catch(() => false))) {
          await page.getByTestId('topbar-chat-toggle-btn').click();
          await page.getByTestId('ai-dock').waitFor({ state: 'visible', timeout: 15_000 });
        }
        await page.evaluate(() => window.dispatchEvent(new CustomEvent('sshs3:ai-open', { detail: { view: 'Work', mode: 'panel' } })));
        await page.waitForTimeout(1200);
        break;
      case '--click':
        await locate(page, next()).click({ timeout: 15_000 });
        await page.waitForTimeout(300);
        break;
      case '--type': {
        const target = next();
        await locate(page, target).fill(next(), { timeout: 15_000 });
        break;
      }
      case '--press':
        await page.keyboard.press(next());
        break;
      case '--scroll':
        await locate(page, next()).scrollIntoViewIfNeeded({ timeout: 15_000 });
        await page.waitForTimeout(300);
        break;
      case '--wait':
        await page.waitForTimeout(Number(next()));
        break;
      case '--waitfor': {
        const target = next();
        const ms = /^\d+$/.test(argv[i + 1] || '') ? Number(next()) : 60_000;
        await locate(page, target).waitFor({ state: 'visible', timeout: ms });
        break;
      }
      case '--waitgone': {
        const target = next();
        const ms = /^\d+$/.test(argv[i + 1] || '') ? Number(next()) : 60_000;
        await locate(page, target).waitFor({ state: 'hidden', timeout: ms });
        break;
      }
      case '--text': {
        const target = argv[i + 1] && !argv[i + 1].startsWith('--') ? next() : undefined;
        const text = target ? await locate(page, target).innerText({ timeout: 15_000 }) : await page.locator('body').innerText();
        console.log(text.replace(/\n{3,}/g, '\n\n').slice(0, 6000));
        break;
      }
      case '--ids': {
        const prefix = argv[i + 1] && !argv[i + 1].startsWith('--') ? next() : '';
        const ids = await page.evaluate((p) => [...document.querySelectorAll('[data-testid]')]
          .filter((e) => e.getClientRects().length > 0)
          .map((e) => e.getAttribute('data-testid'))
          .filter((id) => id.startsWith(p)), prefix);
        console.log([...new Set(ids)].join(' '));
        break;
      }
      case '--shot': {
        const file = next();
        await page.screenshot({ path: file });
        console.log(`screenshot: ${file}`);
        break;
      }
      case '--files': {
        const target = next();
        await locate(page, target).setInputFiles(next());
        break;
      }
      default:
        throw new Error(`Unknown step ${step}.`);
    }
  }
  if (reported.length) console.log(`\nThe page reported:\n${[...new Set(reported)].join('\n')}`);
  await browser.close();
}

main().catch((error) => {
  console.error(String(error && error.message ? error.message : error));
  process.exit(1);
});
