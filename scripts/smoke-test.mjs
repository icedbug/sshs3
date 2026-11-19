#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import os from 'node:os';

const APP_DIR = path.resolve(import.meta.dirname, '..');
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(os.tmpdir(), 'sshs3-smoke-shots');
const profileParent = process.env.TEST_PROFILE_DIR || os.tmpdir();
mkdirSync(profileParent, { recursive: true });
const PROFILE_DIR = mkdtempSync(path.join(profileParent, 'sshs3-smoke-'));
const CDP_PORT = process.env.CDP_PORT || '0';
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS) || 30_000;
// --demo (or SMOKE_DEMO=1) starts the app in its demo lab and goes on into the AI workspace: the board, the
// demo's incidents, and one incident started and taken back.
const DEMO = process.env.SMOKE_DEMO === '1' || process.argv.includes('--demo');

mkdirSync(SHOT_DIR, { recursive: true });
mkdirSync(PROFILE_DIR, { recursive: true });

const electronBin = process.env.SMOKE_APP || path.join(APP_DIR, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

let child = null;
let ws = null;
let msgId = 1;
const pending = new Map();
const consoleErrors = [];

function cdpSend(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = msgId++;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error('The app did not answer ' + method));
    }, TIMEOUT_MS);
    pending.set(id, {
      resolve: value => { clearTimeout(timeout); resolve(value); },
      reject: err => { clearTimeout(timeout); reject(err); },
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalJs(expression) {
  const result = await cdpSend('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error('Evaluation exception: ' + JSON.stringify(result.exceptionDetails));
  }
  return result.result.value;
}

async function cleanup() {
  if (ws) {
    try {
      ws.close();
    } catch {
      // ignore
    }
    ws = null;
  }
  if (child) {
    try {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
          resolve();
        }, 3000);
        child.on('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    } catch {
      // ignore
    }
    child = null;
  }
  try {
    rmSync(PROFILE_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

async function run() {
  console.log(`[smoke-test] Starting Electron with isolated profile: ${PROFILE_DIR} on CDP port ${CDP_PORT}...`);

  const spawnArgs = [
    '--no-sandbox',
    '--disable-gpu',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    ...(process.env.SMOKE_APP ? [] : ['.']),
    ...(DEMO ? ['--demo'] : []),
  ];

  child = spawn(electronBin, spawnArgs, {
    cwd: APP_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
    },
  });

  child.stdout.on('data', (d) => {
    const s = d.toString('utf-8');
    if (process.env.VERBOSE) process.stdout.write(`[electron stdout] ${s}`);
  });

  child.stderr.on('data', (d) => {
    const s = d.toString('utf-8');
    if (s.includes('Uncaught') || s.includes('UnhandledPromiseRejection')) {
      consoleErrors.push(s);
    }
    if (process.env.VERBOSE) process.stderr.write(`[electron stderr] ${s}`);
  });

  // Poll for CDP endpoint
  const startTime = Date.now();
  const deadline = startTime + TIMEOUT_MS;
  let page = null;

  while (Date.now() < deadline) {
    try {
      const profile = DEMO ? path.join(PROFILE_DIR, 'demo-workspace') : PROFILE_DIR;
      const port = CDP_PORT === '0' ? readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\s/)[0] : CDP_PORT;
      const res = await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const targets = await res.json();
        page = targets.find((t) => t.type === 'page' && /^(file|https?|app):/.test(t.url));
        if (page) break;
      }
    } catch {
      // Retry after short delay
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  if (!page) {
    throw new Error(`Timed out waiting for Electron CDP page target (${TIMEOUT_MS}ms)`);
  }

  console.log(`[smoke-test] Page target connected: ${page.url}`);

  ws = new WebSocket(page.webSocketDebuggerUrl);
  ws.addEventListener('close', () => {
    for (const request of pending.values()) request.reject(new Error('The app closed its test connection.'));
    pending.clear();
  });
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      const text = msg.params.args?.map((a) => a.value || a.description || '').join(' ');
      if (text) consoleErrors.push(text);
    }
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });

  // Enable Runtime to catch console messages
  await cdpSend('Runtime.enable');

  // React may render a loading message inside #root while the application chunk is opening.
  console.log('[smoke-test] Waiting for the packaged app controls...');
  await waitFor(
    'document.readyState === "complete" && Boolean(document.querySelector("#root :is(.app-surface, [data-testid], button, nav)"))',
    'the packaged app renders its controls',
  );
  const pageTitle = await evalJs('document.title');
  console.log(`[smoke-test] Page title: "${pageTitle}", UI surface detected: true`);

  // Take screenshot
  const shotPath = path.join(SHOT_DIR, 'smoke-test.png');
  const { data } = await cdpSend('Page.captureScreenshot', { format: 'png' });
  writeFileSync(shotPath, Buffer.from(data, 'base64'));
  console.log(`[smoke-test] Screenshot saved: ${shotPath}`);

  if (DEMO) await demoWorkspace();

  // Check fatal errors
  const fatalErrors = consoleErrors.filter(
    (e) => !e.includes('GPU process exited') && !e.includes('libva error') && !e.includes('mesa')
  );

  if (fatalErrors.length > 0) {
    console.warn('[smoke-test] Warnings / errors captured in console:');
    for (const err of fatalErrors) {
      console.warn(`  - ${err}`);
    }
  }

  const elapsed = Date.now() - startTime;
  console.log(`[smoke-test] SUCCESS: App launched, rendered UI, and captured screenshot in ${elapsed}ms!`);
}

/** Waits until an expression is true on the page, or says what never happened. */
async function waitFor(expression, what, ms = 15_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await evalJs(expression)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Never happened: ${what}`);
}

/**
 * The AI workspace in the demo lab, as a person finds it in the desktop app: the hub answers, it is
 * the demo, the board is drawn, the demo's incidents are offered, and one of them can be started
 * (its alert becomes a ticket on the board) and taken back.
 */
async function demoWorkspace() {
  console.log('[smoke-test] Demo lab: opening the AI workspace...');
  const hub = (request) =>
    evalJs(`window.multissh.aiHubRequest(${JSON.stringify(request)}).then((s) => JSON.stringify({ ok: true, demoMode: s.demoMode, scenarios: (s.simulation?.scenarios ?? []).map((x) => x.id), running: s.simulation?.running ? { title: s.simulation.running.title, ticketId: s.simulation.running.ticketId, total: s.simulation.running.total } : null, tickets: (s.workTickets ?? []).map((t) => ({ id: t.id, title: t.title })), agents: (s.agents ?? []).length }), (e) => JSON.stringify({ ok: false, error: String(e) }))`).then((text) => JSON.parse(text));

  const first = await hub({ action: 'snapshot' });
  if (!first.ok) throw new Error(`The hub did not answer: ${first.error}`);
  if (first.demoMode !== true) throw new Error('The app was started with --demo and the hub does not say it is the demo lab');
  if (first.scenarios.length < 5) throw new Error(`The demo lab offers ${first.scenarios.length} incidents, expected 5`);
  console.log(`[smoke-test] Demo lab: the hub answers (${first.agents} agents, incidents: ${first.scenarios.join(', ')})`);

  await evalJs(`window.dispatchEvent(new CustomEvent('sshs3:ai-open', { detail: { view: 'Workforce', mode: 'hub' } })), true`);
  await waitFor('Boolean(document.querySelector(".ai-hub"))', 'the AI workspace opens');
  await waitFor('Boolean(document.querySelector(\'[data-testid="scenarios"]\'))', 'the board shows the demo incidents');
  await waitFor('Boolean(document.querySelector(\'[data-testid="board-shared-with"]\'))', 'the board says who has it');
  const note = await evalJs('document.querySelector(\'[data-testid="board-shared-with"]\').textContent');
  console.log(`[smoke-test] Demo lab: the board is drawn ("${note.trim()}")`);

  const started = await hub({ action: 'sim-start', scenarioId: 'nginx-bad-config' });
  if (!started.ok) throw new Error(`An incident could not be started: ${started.error}`);
  if (!started.running?.ticketId) throw new Error('The incident started and its alert did not become a ticket');
  const ticket = started.tickets.find((t) => t.id === started.running.ticketId);
  if (!ticket) throw new Error('The incident\'s ticket is not on the board');
  await waitFor(`document.body.textContent.includes(${JSON.stringify(ticket.title.slice(0, 40))})`, 'the alert ticket is drawn on the board');
  console.log(`[smoke-test] Demo lab: incident "${started.running.title}" started, its alert is the ticket "${ticket.title}" (${started.running.total} checks)`);

  const shot = path.join(SHOT_DIR, 'smoke-test-demo.png');
  const { data } = await cdpSend('Page.captureScreenshot', { format: 'png' });
  writeFileSync(shot, Buffer.from(data, 'base64'));
  console.log(`[smoke-test] Screenshot saved: ${shot}`);

  const reset = await hub({ action: 'sim-reset' });
  if (!reset.ok) throw new Error(`The incident could not be taken back: ${reset.error}`);
  if (reset.running) throw new Error('The incident was taken back and is still said to be running');
  console.log('[smoke-test] Demo lab: the incident was taken back');
}

run()
  .then(async () => {
    await cleanup();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(`[smoke-test] FAILED: ${err.message}`);
    await cleanup();
    process.exit(1);
  });
