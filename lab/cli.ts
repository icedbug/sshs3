/**
 * The lab from the command line: `npm run lab:up -- <n>`, `lab:reset`, `lab:down`, `lab:status`, and
 * `npm run lab -- validate [--scenario <id>[,<id>]] [--times 3] [--lab <n>]` and
 * `npm run lab -- run --scenario <id> --model <m> [settings] [--lab <n>]`,
 * `npm run lab -- campaign --name <n> --models <list> --times <k> [--labs 1,2] [--scenarios <id>,<id> | --group trap] [settings] [--new]`,
 * `npm run lab -- report --name <n>`, `npm run lab -- regrade --name <n>`, `npm run lab -- compare --names <a>,<b>`
 * and `npm run lab -- calibrate [--model <m>] [--times 3]`.
 * The settings name a variant of the plain run (variant.ts): `--mode`, `--reasoning`, `--context`,
 * `--caps calls,commands,minutes`, `--approver`, `--via`, `--shell` and `--disturb`.
 * Lab n has the subnet 10.77.<n>.0/24; the campaigns use 1 and 2, the lab's own tests 9.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CALIBRATION } from './calibration/cards';
import { CANDIDATES, SCENARIOS } from './scenarios';
import { loadQueue, runCampaign } from './src/campaign';
import { HUMAN_MODEL, carefulChange, proxyAsk } from './src/carefulHuman';
import { compareCampaigns } from './src/compare';
import { labDown, labHealthy, labReset, labUp } from './src/lab';
import { judgeHonesty } from './src/judge';
import { takeLock } from './src/lock';
import { startModelProxy } from './src/modelProxy';
import { startProduct } from './src/product';
import { regradeRun } from './src/regrade';
import { buildReport } from './src/report';
import { resultsDir, runOne } from './src/run';
import { STATE_DIR } from './src/ssh';
import { labTls } from './src/tls';
import { validateScenario } from './src/validate';
import { notYetSupported, parseVariant, type Variant } from './src/variant';

const [command, ...rest] = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = rest.indexOf(`--${name}`);
  return at >= 0 ? rest[at + 1] : undefined;
};
const arg = command === 'validate' || command === 'run' ? flag('lab') : ['campaign', 'report', 'regrade', 'compare', 'calibrate'].includes(command ?? '') ? undefined : rest[0];

/** The variant the settings on the command line name; none when no setting is given. */
function variantFlags(): Variant | undefined {
  const names = ['mode', 'reasoning', 'context', 'caps', 'approver', 'via', 'shell', 'disturb'] as const;
  if (!names.some((name) => rest.includes(`--${name}`))) return undefined;
  const variant = parseVariant(Object.fromEntries(names.filter((name) => rest.includes(`--${name}`)).map((name) => [name, flag(name) ?? ''])));
  const missing = notYetSupported(variant);
  if (missing.length) throw new Error(`The lab cannot run ${missing.join(', ')} yet.`);
  return variant;
}
const n = Number(arg ?? 1);

/** The lab for this command only: refused while a campaign or another command uses it. */
async function withLab<T>(what: string, fn: () => Promise<T>): Promise<T> {
  const unlock = await takeLock(path.join(STATE_DIR, `lab-${n}.lock`), `Lab ${n} (${what})`);
  try {
    return await fn();
  } finally {
    await unlock();
  }
}

async function validate(): Promise<void> {
  const ids = flag('scenario')?.split(',');
  const times = Number(flag('times') ?? 1);
  const known = [...SCENARIOS, ...CANDIDATES];
  for (const id of ids ?? []) if (!known.some((s) => s.id === id)) throw new Error(`No task is named "${id}".`);
  const chosen = ids ? known.filter((s) => ids.includes(s.id)) : SCENARIOS;
  // Each validation resets the lab first: a lab left broken (by a run, or by hand) is no obstacle.
  await labUp(n, { waitHealthy: false });
  let bad = 0;
  for (const s of chosen)
    for (let i = 1; i <= times; i++) {
      const started = Date.now();
      const result = await validateScenario(s, n);
      const took = `${Math.round((Date.now() - started) / 1000)} s`;
      if (result.skipped) console.log(`${s.id} ${i}/${times}: skipped. ${result.skipped}`);
      else if (result.ok) console.log(`${s.id} ${i}/${times}: ok (${took})`);
      else {
        bad++;
        console.log(`${s.id} ${i}/${times}: NOT OK (${took})\n${result.problems.map((p) => `  - ${p}`).join('\n')}`);
      }
    }
  await labReset(n);
  process.exitCode = bad ? 1 : 0;
}

/** One graded run of the agent on a task, with a fresh product and the real model through the proxy. */
async function run(): Promise<void> {
  const scenario = SCENARIOS.find((s) => s.id === flag('scenario'));
  if (!scenario) throw new Error(`No task is named "${flag('scenario')}". Tasks: ${SCENARIOS.map((s) => s.id).join(', ')}.`);
  const model = flag('model');
  if (!model) throw new Error('Name the model: --model gpt-6.2-sol');
  const variant = variantFlags();
  // The run resets the lab first: the last run may have left it broken.
  await labUp(n, { waitHealthy: false });
  const proxy = await startModelProxy({ port: 0, host: '0.0.0.0', tls: await labTls(), upstream: 'https://api.openai.com', logDir: path.join(resultsDir(), '_proxy') });
  const dataDir = path.join(STATE_DIR, 'products', `${new Date().toISOString().replace(/[-:.]/g, '')}-${scenario.id}`);
  await fs.mkdir(dataDir, { recursive: true });
  const product = await startProduct({ dataDir, port: 0 });
  try {
    const result = await runOne({ lab: n, product, proxy, scenario, model, ...(variant ? { variant } : {}) });
    const g = result.grade;
    console.log(`${result.runId}: ${g.status}, ${g.outcome}. Damage: ${g.damage.length ? g.damage.join('; ') : 'none'}. Rule breaks: ${g.ruleBreaks.length}. Risky plain commands: ${g.riskyPlainCommands.length}. Leaks: ${g.leaks.length}. Honesty: ${g.honesty.verdict}.`);
    console.log(`${g.cost.modelCalls} model calls, ${g.cost.inputTokens} tokens in (${g.cost.cachedTokens} cached), ${g.cost.outputTokens} out, ${g.cost.commands} commands, ${Math.round(g.cost.ms / 1000)} s.`);
    console.log(`Results: ${result.dir}`);
  } finally {
    await product.stop();
    await proxy.stop();
  }
}

/** Every task with every model, `times` times, one worker per lab; started again, it goes on from its queue. */
async function campaign(): Promise<void> {
  const name = flag('name');
  const models = flag('models')?.split(',').filter(Boolean);
  const times = Number(flag('times') ?? 1);
  const labs = (flag('labs') ?? '1,2').split(',').map(Number);
  if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) throw new Error('Name the campaign: --name pass1');
  if (!models?.length) throw new Error('Name the models: --models gpt-6.2-sol,gpt-6-luna');
  const variant = variantFlags();
  if (!Number.isInteger(times) || times < 1) throw new Error(`--times is a whole number of at least 1, not "${flag('times')}".`);
  for (const lab of labs) if (!Number.isInteger(lab) || lab < 1 || lab > 250) throw new Error(`A lab number is 1 to 250, not "${lab}".`);
  console.log(`${new Date().toISOString()} campaign ${name}: ${models.join(', ')}, ${times} time(s), labs ${labs.join(', ')}.`);
  // Some tasks only: named, or a whole group (the traps, say).
  const group = flag('group');
  const scenarios = flag('scenarios')?.split(',').filter(Boolean) ?? (group ? SCENARIOS.filter((s) => s.group === group).map((s) => s.id) : undefined);
  if (group && !scenarios?.length) throw new Error(`No task is in the group "${group}".`);
  // Some tasks run again after a fix of the lab: --rerun <id>,<id> --why "<what was fixed>".
  const rerunIds = flag('rerun')?.split(',').filter(Boolean);
  if (rerunIds && !flag('why')) throw new Error('Say why the tasks run again: --why "<the fix of the lab>"');
  for (const id of rerunIds ?? []) if (!SCENARIOS.some((s) => s.id === id)) throw new Error(`No task is named "${id}".`);
  await runCampaign({
    name,
    models,
    times,
    labs,
    create: rest.includes('--new'),
    ...(scenarios ? { scenarios } : {}),
    ...(rerunIds ? { rerun: { scenarios: rerunIds, why: flag('why')! } } : {}),
    ...(variant ? { variant } : {}),
    onProgress: (line) => console.log(line),
  });
  const report = await buildReport(name);
  console.log(`${new Date().toISOString()} campaign ${name} ${report.stoppedBecause ? `stopped: ${report.stoppedBecause}` : 'done'}. ${report.runs} runs. Report: ${path.join(resultsDir(), 'campaigns', name, 'report.md')}`);
  if (report.stoppedBecause) process.exitCode = 1;
}

/** A campaign's finished runs graded again with the grading as it is now, and its report made again. */
async function regrade(): Promise<void> {
  const name = flag('name');
  if (!name) throw new Error('Name the campaign: --name pass1');
  const q = await loadQueue(name);
  const proxy = await startModelProxy({ port: 0, tls: await labTls(), upstream: 'https://api.openai.com', logDir: path.join(resultsDir(), '_proxy') });
  try {
    for (const entry of q.entries) {
      if (!entry.dir) continue;
      try {
        const g = await regradeRun(entry.dir, { judge: (input) => judgeHonesty({ ...input, proxyUrl: proxy.url }) });
        Object.assign(entry, { status: g.status, outcome: g.outcome });
        console.log(`${entry.id}: ${g.status}, ${g.outcome}; risky plain commands ${g.riskyPlainCommands.length}, honesty ${g.honesty.verdict}`);
      } catch (error) {
        console.log(`${entry.id}: not graded again: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await proxy.stop();
  }
  const file = path.join(resultsDir(), 'campaigns', `${name}.json`);
  await fs.writeFile(`${file}.tmp`, JSON.stringify(q, null, 2));
  await fs.rename(`${file}.tmp`, file);
  const r = await buildReport(name);
  console.log(`${r.runs} runs in the report: ${path.join(resultsDir(), 'campaigns', name, 'report.md')}`);
}

async function report(): Promise<void> {
  const name = flag('name');
  if (!name) throw new Error('Name the campaign: --name pass1');
  const r = await buildReport(name);
  console.log(`${r.runs} runs. ${Object.entries(r.byModel).map(([m, x]) => `${m}: ${x.solved}/${x.counted} solved`).join('; ')}. Report: ${path.join(resultsDir(), 'campaigns', name, 'report.md')}`);
}

/**
 * The careful person against six cards made by hand (lab/calibration/cards.ts), each a few times, with
 * the real model: a campaign leans on her only when she decides at least five of six right each time.
 */
async function calibrate(): Promise<void> {
  const model = flag('model') ?? HUMAN_MODEL;
  const times = Number(flag('times') ?? 3);
  if (!Number.isInteger(times) || times < 1) throw new Error(`--times is a whole number of at least 1, not "${flag('times')}".`);
  const proxy = await startModelProxy({ port: 0, tls: await labTls(), upstream: 'https://api.openai.com', logDir: path.join(resultsDir(), '_proxy') });
  let worst = CALIBRATION.cards.length;
  try {
    const ask = proxyAsk(proxy.url);
    for (let round = 1; round <= times; round++) {
      let right = 0;
      for (const card of CALIBRATION.cards) {
        const d = await carefulChange({ ask, runId: `calibrate-${round}`, request: CALIBRATION.request, change: card.change, production: card.production, model });
        const ok = d.approved === card.fits;
        if (ok) right++;
        console.log(`${round}: ${card.change.id}: ${d.approved ? 'approved' : 'denied'} (understood ${d.understood}), ${ok ? 'right' : 'WRONG'}. ${d.reason}`);
      }
      console.log(`${round}: ${right} of ${CALIBRATION.cards.length} right.`);
      worst = Math.min(worst, right);
    }
  } finally {
    await proxy.stop();
  }
  const enough = worst >= CALIBRATION.cards.length - 1;
  console.log(enough ? `The careful person is calibrated: at least ${worst} of ${CALIBRATION.cards.length} right each time.` : `Not calibrated: ${worst} of ${CALIBRATION.cards.length} right at worst. Change her brief and try again.`);
  process.exitCode = enough ? 0 : 1;
}

/** Campaigns side by side, per task and model. */
async function compare(): Promise<void> {
  const names = flag('names')?.split(',').filter(Boolean) ?? [];
  const { file } = await compareCampaigns(names);
  console.log(`Side by side: ${file}`);
}

async function main(): Promise<void> {
  if (!Number.isInteger(n) || n < 1 || n > 250) throw new Error(`A lab number is 1 to 250, not "${arg}".`);
  switch (command) {
    case 'validate':
      return withLab('validate', validate);
    case 'run':
      return withLab('run', run);
    case 'campaign':
      return campaign();
    case 'report':
      return report();
    case 'regrade':
      return regrade();
    case 'compare':
      return compare();
    case 'calibrate':
      return calibrate();
    case 'up': {
      const lab = await labUp(n);
      for (const s of lab.servers) console.log(`${s.name.padEnd(11)} ${s.ip.padEnd(13)} ${s.tags.join(', ')}`);
      console.log(`Lab ${n} is up and healthy.`);
      return;
    }
    case 'reset': {
      const failing = await withLab('reset', () => labReset(n));
      if (failing.length) {
        console.log(`Lab ${n} is back to its golden images, but not healthy: ${failing.join('; ')}`);
        process.exitCode = 1;
      } else console.log(`Lab ${n} is back to its golden images and healthy.`);
      return;
    }
    case 'down':
      await withLab('down', () => labDown(n));
      console.log(`Lab ${n} is down. Its golden images are kept.`);
      return;
    case 'status': {
      const failing = await labHealthy(n);
      console.log(failing.length ? `Lab ${n} is not healthy:\n${failing.map((f) => `- ${f}`).join('\n')}` : `Lab ${n} is healthy.`);
      process.exitCode = failing.length ? 1 : 0;
      return;
    }
    default:
      throw new Error(
        'Commands: up, reset, down, status, each with a lab number; validate [--scenario <id>] [--times 3] [--lab <n>]; run --scenario <id> --model <m> [settings] [--lab <n>]; campaign --name <n> --models <list> --times <k> [--labs 1,2] [--scenarios <id>,<id> | --group <group>] [settings] [--new]; report --name <n>; regrade --name <n>; compare --names <a>,<b>; calibrate [--model <m>] [--times 3]. Settings: --mode, --reasoning, --context, --caps calls,commands,minutes, --approver, --via, --shell, --disturb.',
      );
  }
}

// Node's fetch takes the environment's proxy only when asked at start: a run that calls the model
// starts itself again with that setting.
if (['run', 'campaign', 'regrade', 'calibrate'].includes(command ?? '') && (process.env.HTTPS_PROXY || process.env.https_proxy) && process.env.NODE_USE_ENV_PROXY !== '1') {
  const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], { stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: '1' } });
  child.on('exit', (code) => process.exit(code ?? 1));
} else
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
