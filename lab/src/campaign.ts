import fs from 'node:fs/promises';
import path from 'node:path';
import type { Grade } from './grade';
import { takeLock } from './lock';
import type { ModelCall } from './modelProxy';
import type { RunResult } from './run';
import { makeRunId, resultsDir } from './run';

/**
 * A campaign: every task, with every model, a number of times, run by one worker per lab. Its queue is
 * a file, written after every change, so a campaign stopped by anything (a restart of the machine, a
 * full disk, a person) goes on from where it was when started again with the same name.
 *
 * Every run counts. A run left "running" by a crash is recorded as interrupted and queued once more;
 * a run the provider broke is recorded as a provider error and queued once more. Neither is dropped.
 */

export type EntryStatus = 'queued' | 'running' | Grade['status'];

export interface QueueEntry {
  id: string;
  scenario: string;
  model: string;
  repeat: number;
  status: EntryStatus;
  /** The entry this one runs again (after an interruption or a provider error). */
  retryOf?: string;
  lab?: number;
  startedAt?: string;
  endedAt?: string;
  runId?: string;
  dir?: string;
  outcome?: Grade['outcome'];
  /** Why a worker could not run it. */
  note?: string;
  /** Run again after a fix of the lab: why. The run is kept and listed, and no longer counted. */
  replacedBecause?: string;
}

export interface Queue {
  name: string;
  models: string[];
  times: number;
  createdAt: string;
  /** The product build every run of the campaign uses: a campaign does not go on with another. */
  productCommit?: string;
  /** Each task's group, and whether it plants instructions the agent must not follow. */
  tasks?: Record<string, { group: string; injects?: boolean }>;
  entries: QueueEntry[];
  /** Set when the campaign stopped before its queue was done, with the reason. */
  stoppedBecause?: string;
  /** Labs a worker found broken (not healthy after a second reset), and left. */
  brokenLabs?: number[];
}

export interface CampaignDeps {
  /** The tasks, in the order the queue lists them. */
  scenarios: Array<{ id: string; group: string; injects?: boolean }>;
  freeBytes(dir: string): Promise<number>;
  /** Brings a lab up for its worker. */
  prepareLab(lab: number): Promise<void>;
  /** The lab for one worker only: refused while another command uses it. Returns what lets it go. */
  lockLab?(lab: number): Promise<() => Promise<void>>;
  /** The product build for the whole campaign, made once at its start: its commit. */
  productCommit(): Promise<string>;
  runOne(opts: { lab: number; scenario: string; model: string; runId: string; productCommit: string }): Promise<RunResult>;
  /** Stops what the campaign started (the model proxy). */
  close?(): Promise<void>;
  now?(): Date;
  sleep?(ms: number): Promise<void>;
}

/**
 * The lab's own scheduled jobs (UTC, the servers' time): db-01's nightly backup at 02:30, a task's
 * retention job at 03:15, and the daily, weekly and monthly jobs of /etc/crontab from 06:25. A job
 * that falls inside a run changes the task under the agent, so no run starts that could reach one.
 */
const SCHEDULED = ['02:30', '03:15', '06:25', '06:47', '06:52'];
/** The longest a run takes: its caps (15 minutes) and the lab's own work before and after. */
const RUN_MINUTES = 22;
/** How long a scheduled job is given to finish. */
const JOB_MINUTES = 5;

/** How long to wait before a run may start at `at` (0: it may start now). */
export function quietWaitMs(at: Date): number {
  const minute = 60_000;
  const day = 24 * 60 * minute;
  const t = at.getTime();
  let until = t;
  // The jobs of today and of the days either side, so that windows across midnight are seen too.
  for (const offset of [-day, 0, day])
    for (const hhmm of SCHEDULED) {
      const [h, m] = hhmm.split(':').map(Number) as [number, number];
      const job = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), h, m) + offset;
      if (until + RUN_MINUTES * minute > job && until < job + JOB_MINUTES * minute) until = job + JOB_MINUTES * minute;
    }
  // A window can end where another starts: looked at again from its end.
  return until === t ? 0 : until - t + quietWaitMs(new Date(until));
}

/** Three runs the lab broke in a row: something is wrong with the lab or the product, and more runs would only add to it. */
const HARNESS_ERRORS_IN_A_ROW = 3;

/** Under this much free disk no run is started: a run on a full disk fails for reasons of its own. */
export const MIN_FREE_BYTES = 3e9;

const queuePath = (name: string): string => path.join(resultsDir(), 'campaigns', `${name}.json`);
const proxyLog = (runId: string): string => path.join(resultsDir(), '_proxy', `${runId.replace(/[^A-Za-z0-9._-]/g, '_')}.jsonl`);

export async function loadQueue(name: string): Promise<Queue> {
  return JSON.parse(await fs.readFile(queuePath(name), 'utf8')) as Queue;
}

async function saveQueue(q: Queue): Promise<void> {
  const file = queuePath(q.name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(q, null, 2));
  await fs.rename(tmp, file);
}

function freshQueue(name: string, models: string[], times: number, scenarios: CampaignDeps['scenarios'], productCommit: string): Queue {
  const entries: QueueEntry[] = [];
  for (const s of scenarios)
    for (const model of models)
      for (let repeat = 1; repeat <= times; repeat++) entries.push({ id: `${s.id}/${model}/${repeat}`, scenario: s.id, model, repeat, status: 'queued' });
  const tasks = Object.fromEntries(scenarios.map((s) => [s.id, { group: s.group, ...(s.injects ? { injects: true } : {}) }]));
  return { name, models, times, createdAt: new Date().toISOString(), productCommit, tasks, entries };
}

/**
 * The folder of a run the campaign was stopped in the middle of: marked interrupted, with a grade that
 * says so and its cost so far from the model proxy's log. Nothing of a run is left without a grade.
 */
async function finishInterrupted(e: QueueEntry): Promise<void> {
  if (!e.dir || !e.runId) return;
  await fs.mkdir(e.dir, { recursive: true });
  const meta = JSON.parse(await fs.readFile(path.join(e.dir, 'run.json'), 'utf8').catch(() => '{}')) as Record<string, unknown>;
  const calls = (await fs.readFile(proxyLog(e.runId), 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Pick<ModelCall, 'inputTokens' | 'cachedTokens' | 'outputTokens'>);
  const sum = (f: (c: (typeof calls)[number]) => number) => calls.reduce((total, c) => total + (f(c) || 0), 0);
  const started = Date.parse(e.startedAt ?? '') || Date.now();
  const grade: Grade = {
    status: 'interrupted',
    outcome: 'n/a',
    damage: [],
    ruleBreaks: [],
    riskyPlainCommands: [],
    leaks: [],
    injectionFollowed: false,
    honesty: { verdict: 'n/a', reason: 'The campaign stopped during the run.' },
    cost: { modelCalls: calls.length, inputTokens: sum((c) => c.inputTokens), cachedTokens: sum((c) => c.cachedTokens), outputTokens: sum((c) => c.outputTokens), commands: 0, ms: Date.now() - started },
  };
  await fs.writeFile(path.join(e.dir, 'grade.json'), JSON.stringify(grade, null, 2));
  await fs.writeFile(path.join(e.dir, 'run.json'), JSON.stringify({ ...meta, runId: e.runId, state: 'interrupted', endedAt: new Date().toISOString() }, null, 2));
}

/**
 * Each entry of the tasks named is replaced, with why, and the place of the last try of each one
 * (a retry included) gets a new entry right after it.
 */
function rerunTasks(q: Queue, rerun: { scenarios: string[]; why: string }): void {
  const lastTry = new Map<string, QueueEntry>();
  for (const e of q.entries) {
    if (!rerun.scenarios.includes(e.scenario) || e.replacedBecause || e.status === 'queued' || e.status === 'running') continue;
    e.replacedBecause = rerun.why;
    lastTry.set(`${e.scenario}/${e.model}/${e.repeat}`, e);
  }
  for (const [key, e] of lastTry) {
    const at = q.entries.indexOf(e);
    q.entries.splice(at + 1, 0, { id: `${key}/rerun`, scenario: e.scenario, model: e.model, repeat: e.repeat, status: 'queued' });
  }
}

/** A second try of an entry, placed right after it, once: a retry is never tried again. */
function retry(q: Queue, of: QueueEntry): void {
  if (of.retryOf || q.entries.some((e) => e.retryOf === of.id)) return;
  const at = q.entries.indexOf(of);
  q.entries.splice(at + 1, 0, { id: `${of.id}/again`, scenario: of.scenario, model: of.model, repeat: of.repeat, status: 'queued', retryOf: of.id });
}

export async function runCampaign(opts: {
  name: string;
  models: string[];
  times: number;
  labs: number[];
  deps?: CampaignDeps;
  /** Makes the campaign: without it, only one that exists goes on. */
  create?: boolean;
  /** Only these tasks (the traps, say), in the library's order; all of them when left out. */
  scenarios?: string[];
  /**
   * In a campaign that exists: these tasks run again, after a fix of the lab that touched them. Their
   * runs so far are kept and listed with why, and no longer counted; a new entry takes each one's place.
   */
  rerun?: { scenarios: string[]; why: string };
  /** Told a line when a run starts or ends, for a log to follow. */
  onProgress?: (line: string) => void;
}): Promise<void> {
  const tell = (line: string): void => opts.onProgress?.(`${new Date().toISOString()} ${line}`);
  await fs.mkdir(path.dirname(queuePath(opts.name)), { recursive: true });
  const unlock = await takeLock(`${queuePath(opts.name)}.lock`, `Campaign ${opts.name}`);
  try {
    await campaign(opts, tell);
  } finally {
    await unlock();
  }
}

async function campaign(opts: Parameters<typeof runCampaign>[0], tell: (line: string) => void): Promise<void> {
  let existing: Queue | undefined;
  try {
    existing = await loadQueue(opts.name);
  } catch {
    existing = undefined;
  }
  if (existing && opts.create) throw new Error(`Campaign ${opts.name} already exists: start it without --new to go on with it, or give a new campaign another name.`);
  if (!existing && !opts.create) throw new Error(`No campaign named ${opts.name}: start one with --new.`);
  const deps = opts.deps ?? (await (await import('./campaignDeps')).defaultDeps());
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let q: Queue;
  try {
    const productCommit = await deps.productCommit();
    if (existing) {
      q = existing;
      if (q.productCommit && q.productCommit !== productCommit)
        throw new Error(`Campaign ${opts.name} was started on product ${q.productCommit.slice(0, 10)}; the product is now ${productCommit.slice(0, 10)}. Its runs would not be comparable: start a new campaign for this product.`);
      // Started again: what was running when it stopped was cut short. Its folder is finished and graded so.
      for (const e of [...q.entries])
        if (e.status === 'running') {
          await finishInterrupted(e);
          e.status = 'interrupted';
          e.endedAt = new Date().toISOString();
          e.note = 'The campaign stopped while this ran (a restart of the machine, or the campaign was stopped).';
          retry(q, e);
        }
      delete q.stoppedBecause;
      delete q.brokenLabs;
      if (opts.rerun) rerunTasks(q, opts.rerun);
    } else {
      const unknown = (opts.scenarios ?? []).filter((id) => !deps.scenarios.some((s) => s.id === id));
      if (unknown.length) throw new Error(`No task is named ${unknown.join(', ')}.`);
      const chosen = opts.scenarios ? deps.scenarios.filter((s) => opts.scenarios!.includes(s.id)) : deps.scenarios;
      q = freshQueue(opts.name, opts.models, opts.times, chosen, productCommit);
    }
  } catch (error) {
    await deps.close?.();
    throw error;
  }
  await saveQueue(q);

  let stop: string | undefined;
  let harnessErrorsInARow = 0;
  // One write at a time: the workers share the queue.
  let writing: Promise<void> = Promise.resolve();
  const save = (): Promise<void> => (writing = writing.then(() => saveQueue(q)));

  const brokenLab = async (lab: number, why: string): Promise<void> => {
    q.brokenLabs = [...(q.brokenLabs ?? []), lab];
    tell(`lab ${lab}: left, it is broken: ${why}`);
    await save();
  };

  const worker = async (lab: number): Promise<void> => {
    let unlockLab: (() => Promise<void>) | undefined;
    try {
      unlockLab = await deps.lockLab?.(lab);
      await deps.prepareLab(lab);
    } catch (error) {
      await unlockLab?.();
      await brokenLab(lab, error instanceof Error ? error.message : String(error));
      return;
    }
    try {
      for (;;) {
        if (stop) return;
        if (!q.entries.some((e) => e.status === 'queued')) return;
        // Not across one of the lab's own scheduled jobs.
        const wait = quietWaitMs(now());
        if (wait > 0) {
          tell(`lab ${lab}: waits ${Math.ceil(wait / 60_000)} minutes, until the lab's own scheduled jobs are past`);
          await sleep(wait);
          continue;
        }
        const entry = q.entries.find((e) => e.status === 'queued');
        if (!entry) return;
        // Taken at once, before anything is awaited: another worker must not take it too. Its run's name
        // and folder are written down before the run starts, so a run cut short is found again.
        const runId = makeRunId(entry.scenario, entry.model);
        Object.assign(entry, { status: 'running', lab, startedAt: new Date().toISOString(), runId, dir: path.join(resultsDir(), runId) });
        const free = await deps.freeBytes(resultsDir());
        if (free < MIN_FREE_BYTES) {
          Object.assign(entry, { status: 'queued', lab: undefined, startedAt: undefined, runId: undefined, dir: undefined });
          stop = `Under 3 GB free on the disk (${(free / 1e9).toFixed(1)} GB): no run was started. Free space, then start the campaign again.`;
          q.stoppedBecause = stop;
          await save();
          return;
        }
        await save();
        tell(`lab ${lab}: ${entry.id} starts (${q.entries.filter((e) => e.status === 'queued').length} queued)`);
        try {
          const result = await deps.runOne({ lab, scenario: entry.scenario, model: entry.model, runId, productCommit: q.productCommit ?? '' });
          if (result.labBroken) {
            // The lab is broken: this worker leaves it. The entry waits for another lab, and was no run.
            Object.assign(entry, { status: 'queued', lab: undefined, startedAt: undefined, runId: undefined, dir: undefined });
            await brokenLab(lab, `not healthy after two resets: ${result.labBroken.join('; ')}`);
            return;
          }
          Object.assign(entry, { status: result.grade.status, outcome: result.grade.outcome, runId: result.runId, dir: result.dir, endedAt: new Date().toISOString() });
          const g = result.grade;
          tell(`lab ${lab}: ${entry.id} ${g.status}, ${g.outcome}; damage ${g.damage.length}, rule breaks ${g.ruleBreaks.length}, leaks ${g.leaks.length}, honesty ${g.honesty.verdict}; ${g.cost.modelCalls} calls, ${Math.round(g.cost.ms / 1000)} s (${result.runId})`);
          if (g.status === 'provider-error') retry(q, entry);
          harnessErrorsInARow = g.status === 'harness-error' ? harnessErrorsInARow + 1 : 0;
          if (g.status === 'harness-error') entry.note ??= await harnessNote(result.dir);
        } catch (error) {
          Object.assign(entry, { status: 'harness-error', endedAt: new Date().toISOString(), note: error instanceof Error ? error.message : String(error) });
          tell(`lab ${lab}: ${entry.id} harness-error: ${entry.note}`);
          harnessErrorsInARow++;
        }
        if (harnessErrorsInARow >= HARNESS_ERRORS_IN_A_ROW && !stop) {
          stop = `${harnessErrorsInARow} runs in a row ended with the lab or the product failing to start (the last: ${entry.note ?? 'see its run'}). The campaign stopped: look at the lab and the product, then start it again.`;
          q.stoppedBecause = stop;
        }
        await save();
      }
    } finally {
      await unlockLab?.();
    }
  };

  try {
    await Promise.all(opts.labs.map((lab) => worker(lab)));
    if (!q.stoppedBecause && q.entries.some((e) => e.status === 'queued') && opts.labs.every((lab) => q.brokenLabs?.includes(lab)))
      q.stoppedBecause = `Every lab broke (${opts.labs.join(', ')}): the rest of the queue waits. Look at the labs, then start the campaign again.`;
    await save();
  } finally {
    await writing;
    await deps.close?.();
  }
}

async function harnessNote(dir: string): Promise<string | undefined> {
  try {
    return (JSON.parse(await fs.readFile(path.join(dir, 'run.json'), 'utf8')) as { harnessError?: string }).harnessError;
  } catch {
    return undefined;
  }
}
