#!/usr/bin/env node
// Starts the built web server on a free port with an empty data folder and checks that it answers:
// the health route, the sign-in status, and a page that loads the client's JavaScript.
// Run `npm run build:web` first.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import * as path from 'node:path';

const APP_DIR = path.resolve(import.meta.dirname, '..');
const SERVER = path.join(APP_DIR, 'dist-web', 'server.mjs');
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS) || 30_000;

if (!existsSync(SERVER)) {
  console.error('dist-web/server.mjs is missing. Run "npm run build:web" first.');
  process.exit(1);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'sshs3-web-smoke-'));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const output = [];
const child = spawn(process.execPath, [SERVER], {
  cwd: APP_DIR,
  env: {
    ...process.env,
    SSHS3_DATA_DIR: dataDir,
    SSHS3_WEB_PORT: String(port),
    SSHS3_WEB_HOST: '127.0.0.1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (chunk) => output.push(String(chunk)));
child.stderr.on('data', (chunk) => output.push(String(chunk)));
let exited = false;
child.once('exit', () => { exited = true; });

function fail(message) {
  console.error(`Web smoke test failed: ${message}`);
  const tail = output.join('').split('\n').slice(-40).join('\n');
  if (tail.trim()) console.error(`Last lines from the server:\n${tail}`);
  process.exitCode = 1;
}

async function waitForHealth() {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) throw new Error('the server stopped before it answered');
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return await res.json();
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`no answer from ${base}/api/health within ${TIMEOUT_MS} ms`);
}

try {
  const health = await waitForHealth();
  if (health.ok !== true || health.mode !== 'web-multiuser') throw new Error(`unexpected health answer: ${JSON.stringify(health)}`);

  const status = await (await fetch(`${base}/api/auth/status`)).json();
  if (status.authenticated !== false) throw new Error(`a fresh server says somebody is signed in: ${JSON.stringify(status)}`);

  const page = await fetch(`${base}/`);
  const html = await page.text();
  if (!page.ok || !/<script[^>]+src="[^"]+\.js"/.test(html)) throw new Error('the start page does not load a script');
  const script = html.match(/<script[^>]+src="([^"]+\.js)"/)[1];
  const js = await fetch(new URL(script, `${base}/`));
  if (!js.ok || !String(js.headers.get('content-type')).includes('javascript')) throw new Error(`the client script ${script} was not served as JavaScript`);

  // A route that needs a session must refuse a visitor who has none.
  const guarded = await fetch(`${base}/api/admin/users`);
  if (guarded.status !== 401) throw new Error(`a route for signed-in accounts answered ${guarded.status} without a session`);

  console.log(`Web smoke test passed on ${base}.`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  child.kill('SIGTERM');
  await new Promise((resolve) => (exited ? resolve() : child.once('exit', resolve)));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
