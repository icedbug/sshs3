#!/usr/bin/env node
'use strict';
/*
 * The feature checks of the AI workspace: each one uses a function the way a person in the team does,
 * in a real browser against the workspace `npm run lab -- workspace` started, with the real model, and
 * says what the product's documentation promises and whether that is what happened.
 *
 *   node lab/features/run.cjs [--ws <file>] [--only <id>,<id>] [--area <name>] [--times <k>]
 *
 * Every check gets a folder of its own under lab/.state/results/features/<time>/, with its screenshots
 * and result.json. results.json and report.md cover the whole run. A check is "pass" when everything it
 * expected held, "fail" when something did not, and "broke" when it could not finish (a control that
 * never showed, an error): a broken check is read by hand, as it can be the product or the check.
 */
const fs = require('node:fs');
const path = require('node:path');
const { launch, readWorkspace, signIn, calls, onServer, sleep } = require('../ui/person.cjs');

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};

/** Anthropic's prices per million tokens: in, out, read from the cache, written to it (5 minutes). */
const PRICES = {
  'claude-opus-5-5': [4, 20, 0.2, 5],
  'claude-sonnet-5-5': [2, 10, 0.1, 2.5],
  'claude-haiku-5-5': [0.1, 0.5, 0.01, 0.125],
};

/** What the model calls cost, from the proxy's own record of each call. */
function summarize(list) {
  const sum = { calls: list.length, tokensIn: 0, fromCache: 0, toCache: 0, tokensOut: 0, usd: 0 };
  for (const c of list) {
    const cached = c.cachedTokens || 0;
    const written = c.cacheWriteTokens || 0;
    const fresh = Math.max(0, (c.inputTokens || 0) - cached - written);
    sum.tokensIn += c.inputTokens || 0;
    sum.fromCache += cached;
    sum.toCache += written;
    sum.tokensOut += c.outputTokens || 0;
    const p = PRICES[c.model] || PRICES['claude-opus-5-5'];
    sum.usd += (fresh * p[0] + (c.outputTokens || 0) * p[1] + cached * p[2] + written * p[3]) / 1e6;
  }
  sum.usd = Math.round(sum.usd * 10000) / 10000;
  return sum;
}

/**
 * Stops every conversation of these people that is still running or waits for someone. The workspace's
 * own runs (reading what a conversation taught, a workforce's specialists) are left to finish.
 */
async function tidy(people) {
  let stopped = 0;
  for (const p of people) {
    const open = (await p.tasks().catch(() => [])).filter((t) => p.isConversation(t) && ['queued', 'running', 'waiting'].includes(t.status));
    for (const t of open) {
      await p.hub({ action: 'stop', taskId: t.id }).catch(() => {});
      stopped++;
    }
  }
  if (stopped) await sleep(3000);
  return stopped;
}

function loadChecks() {
  const dir = path.join(__dirname, 'checks');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.cjs'))
    .sort()
    .flatMap((f) => require(path.join(dir, f)));
}

async function runCheck(browser, ws, out, check, k, times) {
  const dir = path.join(out, times > 1 ? `${check.id}-${k}` : check.id);
  fs.mkdirSync(dir, { recursive: true });
  const people = {};
  const result = {
    id: check.id,
    area: check.area,
    title: check.title,
    expected: check.expected,
    doc: check.doc,
    repeat: k,
    startedAt: new Date().toISOString(),
    expectations: [],
    notes: [],
    shots: [],
    errorsOnPage: [],
  };
  const before = Object.fromEntries(Object.keys(ws.people).map((w) => [w, calls(ws, w).length]));
  const ctx = {
    ws,
    dir,
    sleep,
    started: Date.now(),
    onServer: (server, command, ms) => onServer(ws, server, command, ms),
    /** The person, signed in in a browser of their own for this check. */
    as: async (who) => {
      if (!people[who]) people[who] = await signIn(browser, ws, who);
      return people[who];
    },
    /** What the person's model calls cost so far in this check, from the proxy's own record. */
    spent: (who) => summarize(calls(ws, who).slice(before[who])),
    /** The person's model calls that began at or after the given time. */
    callsBegunSince: (who, ms) => calls(ws, who).filter((c) => Date.parse(c.at) >= ms),
    note: (text) => result.notes.push(String(text).slice(0, 3000)),
    expect: (ok, what, detail) => {
      result.expectations.push({ ok: Boolean(ok), what, ...(detail === undefined ? {} : { detail: String(detail).slice(0, 2000) }) });
      return Boolean(ok);
    },
    shot: async (who, name) => {
      const file = await (await ctx.as(who)).shot(dir, name);
      result.shots.push(path.relative(out, file));
      return file;
    },
  };
  const t0 = Date.now();
  try {
    let timer;
    await Promise.race([
      check.run(ctx),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`The check did not end within ${Math.round((check.timeoutMs || 900_000) / 60_000)} minutes.`)), check.timeoutMs || 900_000);
      }),
    ]).finally(() => clearTimeout(timer));
  } catch (error) {
    result.error = String((error && error.stack) || error).slice(0, 2500);
    for (const p of Object.values(people)) {
      await p
        .shot(dir, 'when-it-broke')
        .then((f) => result.shots.push(path.relative(out, f)))
        .catch(() => {});
    }
  }
  result.ms = Date.now() - t0;
  // What a check leaves running or waiting holds its terminal: it is stopped, so the next check starts clean.
  const stopped = await tidy(Object.values(people));
  if (stopped) result.notes.push(`Stopped ${stopped} conversation(s) the check left running or waiting.`);
  for (const p of Object.values(people)) {
    result.errorsOnPage.push(...[...new Set(p.errors)].map((e) => `${p.who}: ${e}`));
    await p.close().catch(() => {});
  }
  result.modelCalls = {};
  for (const who of Object.keys(ws.people)) {
    const added = calls(ws, who).slice(before[who]);
    if (added.length) result.modelCalls[who] = summarize(added);
  }
  result.verdict = result.error ? 'broke' : result.expectations.every((e) => e.ok) ? 'pass' : 'fail';
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  return result;
}

function report(results, ws) {
  const icon = { pass: 'pass', fail: 'FAIL', broke: 'BROKE' };
  const lines = [
    `# Feature checks of the AI workspace`,
    '',
    `Product ${ws.commit.slice(0, 10)}, model ${ws.model}, lab ${ws.lab}. ${results.length} checks: ` +
      ['pass', 'fail', 'broke'].map((v) => `${results.filter((r) => r.verdict === v).length} ${v}`).join(', ') + '.',
    '',
    '| Area | Check | Verdict | Model calls | Cost (USD) | Time |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of results) {
    const c = Object.values(r.modelCalls || {});
    const n = c.reduce((a, x) => a + x.calls, 0);
    const usd = c.reduce((a, x) => a + x.usd, 0);
    lines.push(`| ${r.area} | ${r.id}${r.repeat > 1 ? ` (${r.repeat})` : ''}: ${r.title} | ${icon[r.verdict]} | ${n} | ${usd.toFixed(3)} | ${Math.round(r.ms / 1000)} s |`);
  }
  for (const r of results.filter((x) => x.verdict !== 'pass')) {
    lines.push('', `## ${r.id}: ${r.title}`, '', `Expected: ${r.expected}`, '');
    for (const e of r.expectations.filter((x) => !x.ok)) lines.push(`- not so: ${e.what}${e.detail ? `\n  ${e.detail.replace(/\n/g, '\n  ')}` : ''}`);
    if (r.error) lines.push('', 'It broke:', '```', r.error, '```');
    if (r.errorsOnPage.length) lines.push('', 'The page reported:', ...r.errorsOnPage.map((e) => `- ${e}`));
    if (r.notes.length) lines.push('', 'Notes:', ...r.notes.map((n) => `- ${n}`));
    if (r.shots.length) lines.push('', `Screenshots: ${r.shots.join(', ')}`);
  }
  return lines.join('\n') + '\n';
}

async function main() {
  const ws = readWorkspace(opt('ws'));
  const only = opt('only') ? opt('only').split(',') : undefined;
  const area = opt('area');
  const times = Number(opt('times', '1'));
  const chosen = loadChecks().filter((c) => (!only || only.includes(c.id)) && (!area || c.area === area));
  if (!chosen.length) throw new Error('No check matches.');
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  const out = path.join(__dirname, '..', '.state', 'results', 'features', stamp);
  fs.mkdirSync(out, { recursive: true });
  const browser = await launch();
  const results = [];
  // Whatever an earlier run left running or waiting is stopped first.
  const everyone = [];
  for (const who of Object.keys(ws.people)) everyone.push(await signIn(browser, ws, who));
  const left = await tidy(everyone);
  if (left) console.log(`Stopped ${left} conversation(s) an earlier run left running or waiting.`);
  for (const p of everyone) await p.close().catch(() => {});
  try {
    for (const check of chosen) {
      for (let k = 1; k <= times; k++) {
        const r = await runCheck(browser, ws, out, check, k, times);
        results.push(r);
        const failed = r.expectations.filter((e) => !e.ok).map((e) => e.what);
        console.log(`${new Date().toISOString()} ${r.verdict.toUpperCase()} ${r.id}${times > 1 ? ` (${k})` : ''} in ${Math.round(r.ms / 1000)} s${failed.length ? `: ${failed.join('; ')}` : ''}${r.error ? `: ${r.error.split('\n')[0]}` : ''}`);
        fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
        fs.writeFileSync(path.join(out, 'report.md'), report(results, ws));
      }
    }
  } finally {
    await browser.close();
  }
  console.log(`Report: ${path.join(out, 'report.md')}`);
}

main().catch((error) => {
  console.error(String((error && error.stack) || error));
  process.exit(1);
});
