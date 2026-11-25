import fs from 'node:fs/promises';
import path from 'node:path';
import type { QueueEntry } from './campaign';
import { loadQueue } from './campaign';
import type { Grade } from './grade';
import { resultsDir } from './run';

/**
 * What a campaign found: how often the agent solved a task, by task, group and model, with Wilson 95%
 * intervals; rule breaks, damage, leaks and followed injections per 100 runs of the agent; honesty;
 * cost; and every run that did not complete, with why.
 *
 * Counted in a solve rate: the runs where the agent had its chance (completed, failed, stopped). Left
 * out of it, and listed: a run the lab broke (harness-error), a run the provider broke (provider-error)
 * and a run the machine cut short (interrupted). A run the lab broke before the agent ran is not a run
 * of the agent in the rates per 100 either.
 */

export interface Rate {
  counted: number;
  solved: number;
  rate: number;
  /** Wilson 95% interval of the solve rate. */
  interval: [number, number];
}

export interface ReportRun {
  id: string;
  scenario: string;
  group: string;
  model: string;
  status: QueueEntry['status'];
  runId?: string;
  outcome?: Grade['outcome'];
  note?: string;
}

export interface Report {
  name: string;
  at: string;
  runs: number;
  byStatus: Record<string, number>;
  /** Per task: its solve rate, and the planted secrets its runs of the agent showed or sent. */
  byTask: Record<string, Rate & { group: string; leaks: number }>;
  byGroup: Record<string, Rate>;
  byModel: Record<string, Rate>;
  byTaskAndModel: Record<string, Rate>;
  /** Per 100 runs of the agent; injections per 100 runs of the tasks that plant one. */
  perHundred: { ruleBreaks: number; damage: number; leaks: number; injectionsFollowed: number; riskyPlainCommands: number };
  perModelPerHundred: Record<string, Report['perHundred']>;
  honesty: Record<string, number>;
  cost: { modelCalls: number; inputTokens: number; cachedTokens: number; outputTokens: number; commands: number; minutes: number; medianMinutesPerRun: number };
  notCompleted: ReportRun[];
  /** Entries not run yet (still queued, or left running). */
  queued: number;
  /** Runs replaced by a run again after a fix of the lab: listed, not counted. */
  replaced: Array<{ id: string; why: string }>;
  /** Labs a worker found broken and left. */
  brokenLabs: number[];
  stoppedBecause?: string;
  /** Tasks the design names that are not in the library, and why. */
  leftOut: Array<{ id: string; reason: string }>;
}

/** Wilson score interval, 95%. */
export function wilson(solved: number, n: number): [number, number] {
  if (!n) return [0, 1];
  const z = 1.959964;
  const p = solved / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

const COUNTED: ReadonlyArray<QueueEntry['status']> = ['completed', 'failed', 'stopped'];

function rate(entries: Array<{ status: QueueEntry['status']; outcome?: Grade['outcome'] }>): Rate {
  const counted = entries.filter((e) => COUNTED.includes(e.status) && e.outcome !== 'n/a');
  const solved = counted.filter((e) => e.outcome === 'solved').length;
  return { counted: counted.length, solved, rate: counted.length ? solved / counted.length : 0, interval: wilson(solved, counted.length) };
}

const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;

export async function buildReport(name: string, groups: Record<string, string> = {}): Promise<Report> {
  const q = await loadQueue(name);
  const graded: Array<QueueEntry & { grade?: Grade; group: string }> = [];
  for (const e of q.entries.filter((x) => x.status !== 'queued' && x.status !== 'running' && !x.replacedBecause)) {
    let g: Grade | undefined;
    if (e.dir) g = JSON.parse(await fs.readFile(path.join(e.dir, 'grade.json'), 'utf8').catch(() => 'null')) ?? undefined;
    graded.push({ ...e, grade: g, group: groups[e.scenario] ?? e.scenario.split('-')[0]! });
  }
  let leftOut: Report['leftOut'] = [];
  try {
    // The groups from the task list, and what it leaves out, when the report is made where the tasks are.
    const tasks = await import('../scenarios');
    leftOut = tasks.LEFT_OUT;
    if (!Object.keys(groups).length) for (const g of graded) g.group = tasks.SCENARIOS.find((s) => s.id === g.scenario)?.group ?? g.group;
  } catch {
    // Not available: the group stays a guess from the name.
  }

  const by = <K extends string>(key: (e: (typeof graded)[number]) => K): Record<K, Rate> => {
    const out = {} as Record<K, Rate>;
    for (const k of new Set(graded.map(key))) out[k] = rate(graded.filter((e) => key(e) === k));
    return out;
  };
  const agentRuns = graded.filter((e) => e.status !== 'harness-error' && e.grade);
  const injects = (id: string): boolean => Boolean(q.tasks?.[id]?.injects);
  const per100 = (list: typeof graded): Report['perHundred'] => {
    const runs = list.filter((e) => e.status !== 'harness-error' && e.grade);
    const per = (of: typeof runs, f: (g: Grade) => number) => (of.reduce((sum, e) => sum + f(e.grade!), 0) / (of.length || 1)) * 100;
    return {
      ruleBreaks: per(runs, (g) => g.ruleBreaks.length),
      damage: per(runs, (g) => (g.damage.length ? 1 : 0)),
      leaks: per(runs, (g) => g.leaks.length),
      // Only a task that plants an injection can have one followed: per 100 runs of those tasks.
      injectionsFollowed: per(runs.filter((e) => injects(e.scenario)), (g) => (g.injectionFollowed ? 1 : 0)),
      riskyPlainCommands: per(runs, (g) => g.riskyPlainCommands.length),
    };
  };
  const minutes = agentRuns.map((e) => e.grade!.cost.ms / 60_000).sort((a, b) => a - b);
  const median = (xs: number[]): number => (xs.length ? (xs.length % 2 ? xs[(xs.length - 1) / 2]! : (xs[xs.length / 2 - 1]! + xs[xs.length / 2]!) / 2) : 0);

  const byTask: Report['byTask'] = {};
  for (const id of new Set(graded.map((e) => e.scenario))) {
    const runs = graded.filter((e) => e.scenario === id);
    byTask[id] = {
      ...rate(runs),
      group: runs[0]!.group,
      leaks: runs.filter((e) => e.status !== 'harness-error' && e.grade).reduce((sum, e) => sum + e.grade!.leaks.length, 0),
    };
  }
  const report: Report = {
    name,
    at: new Date().toISOString(),
    runs: graded.length,
    byStatus: Object.fromEntries([...new Set(graded.map((e) => e.status))].map((s) => [s, graded.filter((e) => e.status === s).length])),
    byTask,
    byGroup: by((e) => e.group),
    byModel: by((e) => e.model),
    byTaskAndModel: by((e) => `${e.scenario} / ${e.model}` as string),
    perHundred: per100(graded),
    perModelPerHundred: Object.fromEntries(q.models.map((m) => [m, per100(graded.filter((e) => e.model === m))])),
    honesty: agentRuns.reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.grade!.honesty.verdict]: (acc[e.grade!.honesty.verdict] ?? 0) + 1 }), {}),
    cost: {
      modelCalls: agentRuns.reduce((s, e) => s + e.grade!.cost.modelCalls, 0),
      inputTokens: agentRuns.reduce((s, e) => s + e.grade!.cost.inputTokens, 0),
      cachedTokens: agentRuns.reduce((s, e) => s + e.grade!.cost.cachedTokens, 0),
      outputTokens: agentRuns.reduce((s, e) => s + e.grade!.cost.outputTokens, 0),
      commands: agentRuns.reduce((s, e) => s + e.grade!.cost.commands, 0),
      minutes: minutes.reduce((s, m) => s + m, 0),
      medianMinutesPerRun: median(minutes),
    },
    notCompleted: graded
      .filter((e) => e.status !== 'completed')
      .map((e) => ({ id: e.id, scenario: e.scenario, group: e.group, model: e.model, status: e.status, runId: e.runId, outcome: e.outcome, note: e.note })),
    queued: q.entries.filter((e) => e.status === 'queued' || e.status === 'running').length,
    replaced: q.entries.filter((e) => e.replacedBecause).map((e) => ({ id: e.id, why: e.replacedBecause! })),
    brokenLabs: q.brokenLabs ?? [],
    stoppedBecause: q.stoppedBecause,
    leftOut,
  };

  const dir = path.join(resultsDir(), 'campaigns', name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(dir, 'report.md'), markdown(report));
  return report;
}

function markdown(r: Report): string {
  const lines: string[] = [];
  const row = (cells: Array<string | number>) => lines.push(`| ${cells.join(' | ')} |`);
  const rateCells = (x: Rate) => [x.counted, x.solved, pct(x.rate), `${pct(x.interval[0])} to ${pct(x.interval[1])}`];
  lines.push(`# Campaign ${r.name}`, '', `${r.runs} runs. ${Object.entries(r.byStatus).map(([s, n]) => `${s}: ${n}`).join(', ')}.`, '');
  if (r.queued) lines.push(`${r.queued} entries are not run yet.`, '');
  if (r.brokenLabs.length) lines.push(`Labs found broken and left: ${r.brokenLabs.join(', ')}.`, '');
  if (r.stoppedBecause) lines.push(`Stopped before its queue was done: ${r.stoppedBecause}`, '');
  lines.push('## Solved, by model', '');
  row(['Model', 'Counted', 'Solved', 'Rate', '95% interval']);
  row(['---', '---', '---', '---', '---']);
  for (const [m, x] of Object.entries(r.byModel)) row([m, ...rateCells(x)]);
  lines.push('', '## Solved, by group', '');
  row(['Group', 'Counted', 'Solved', 'Rate', '95% interval']);
  row(['---', '---', '---', '---', '---']);
  for (const [g, x] of Object.entries(r.byGroup)) row([g, ...rateCells(x)]);
  lines.push('', '## Solved, by task and model', '');
  row(['Task / model', 'Counted', 'Solved', 'Rate', '95% interval']);
  row(['---', '---', '---', '---', '---']);
  for (const [t, x] of Object.entries(r.byTaskAndModel)) row([t, ...rateCells(x)]);
  lines.push('', '## Planted secrets shown or sent, by task', '');
  const leaky = Object.entries(r.byTask).filter(([, x]) => x.leaks);
  if (!leaky.length) lines.push('None.');
  for (const [t, x] of leaky) lines.push(`- ${t}: ${x.leaks}`);
  lines.push('', '## Per 100 runs of the agent', '', 'Injections followed: per 100 runs of the tasks that plant one.', '');
  row(['', 'Rule breaks', 'Runs with damage', 'Leaks', 'Injections followed', 'Risky plain commands']);
  row(['---', '---', '---', '---', '---', '---']);
  const p = (x: Report['perHundred']) => [x.ruleBreaks, x.damage, x.leaks, x.injectionsFollowed, x.riskyPlainCommands].map((v) => v.toFixed(1));
  row(['All', ...p(r.perHundred)]);
  for (const [m, x] of Object.entries(r.perModelPerHundred)) row([m, ...p(x)]);
  lines.push('', '## Honesty of the last answer', '', ...Object.entries(r.honesty).map(([v, n]) => `- ${v}: ${n}`), '');
  lines.push(
    '## Cost',
    '',
    `${r.cost.modelCalls} model calls; ${r.cost.inputTokens} tokens in (${r.cost.cachedTokens} from the cache), ${r.cost.outputTokens} out; ${r.cost.commands} commands; ${r.cost.minutes.toFixed(0)} minutes in all, ${r.cost.medianMinutesPerRun.toFixed(1)} per run (median).`,
    '',
  );
  lines.push('## Runs that did not complete', '');
  if (!r.notCompleted.length) lines.push('None.');
  for (const x of r.notCompleted) lines.push(`- ${x.status}: ${x.scenario} with ${x.model}${x.runId ? ` (${x.runId})` : ''}${x.note ? `. ${x.note}` : ''}`);
  lines.push('', '## Runs replaced after a fix of the lab', '');
  if (!r.replaced.length) lines.push('None.');
  for (const x of r.replaced) lines.push(`- ${x.id}: ${x.why}`);
  lines.push('', '## Tasks left out', '');
  if (!r.leftOut.length) lines.push('None.');
  for (const x of r.leftOut) lines.push(`- ${x.id}: ${x.reason}`);
  lines.push('');
  return lines.join('\n');
}
