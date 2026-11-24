import fs from 'node:fs/promises';
import path from 'node:path';
import type { Grade } from './grade';
import type { RunResult } from './run';
import { resultsDir } from './run';

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
}

export interface Queue {
  name: string;
  models: string[];
  times: number;
  createdAt: string;
  entries: QueueEntry[];
  /** Set when the campaign stopped before its queue was done, with the reason. */
  stoppedBecause?: string;
  /** Labs a worker found broken (not healthy after a second reset), and left. */
  brokenLabs?: number[];
}

export interface CampaignDeps {
  /** The tasks, in the order the queue lists them. */
  scenarios: Array<{ id: string; group: string }>;
  freeBytes(dir: string): Promise<number>;
  /** Brings a lab up for its worker. */
  prepareLab(lab: number): Promise<void>;
  runOne(opts: { lab: number; scenario: string; model: string }): Promise<RunResult>;
  /** Stops what the campaign started (the model proxy). */
  close?(): Promise<void>;
}

/** Under this much free disk no run is started: a run on a full disk fails for reasons of its own. */
export const MIN_FREE_BYTES = 3e9;

const queuePath = (name: string): string => path.join(resultsDir(), 'campaigns', `${name}.json`);

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

function freshQueue(name: string, models: string[], times: number, scenarios: CampaignDeps['scenarios']): Queue {
  const entries: QueueEntry[] = [];
  for (const s of scenarios)
    for (const model of models)
      for (let repeat = 1; repeat <= times; repeat++) entries.push({ id: `${s.id}/${model}/${repeat}`, scenario: s.id, model, repeat, status: 'queued' });
  return { name, models, times, createdAt: new Date().toISOString(), entries };
}

/** A second try of an entry, placed right after it, once: a retry is never tried again. */
function retry(q: Queue, of: QueueEntry): void {
  if (of.retryOf || q.entries.some((e) => e.retryOf === of.id)) return;
  const at = q.entries.indexOf(of);
  q.entries.splice(at + 1, 0, { id: `${of.id}/again`, scenario: of.scenario, model: of.model, repeat: of.repeat, status: 'queued', retryOf: of.id });
}

export async function runCampaign(opts: { name: string; models: string[]; times: number; labs: number[]; deps?: CampaignDeps }): Promise<void> {
  const deps = opts.deps ?? (await (await import('./campaignDeps')).defaultDeps());
  let q: Queue;
  try {
    q = await loadQueue(opts.name);
    // Started again: what was running when it stopped was cut short.
    for (const e of [...q.entries])
      if (e.status === 'running') {
        e.status = 'interrupted';
        e.endedAt = new Date().toISOString();
        e.note = 'The campaign stopped while this ran (a restart of the machine, or the campaign was stopped).';
        retry(q, e);
      }
    delete q.stoppedBecause;
  } catch {
    q = freshQueue(opts.name, opts.models, opts.times, deps.scenarios);
  }
  await saveQueue(q);

  let stop: string | undefined;
  // One write at a time: the workers share the queue.
  let writing: Promise<void> = Promise.resolve();
  const save = (): Promise<void> => (writing = writing.then(() => saveQueue(q)));

  const worker = async (lab: number): Promise<void> => {
    try {
      await deps.prepareLab(lab);
    } catch (error) {
      q.brokenLabs = [...(q.brokenLabs ?? []), lab];
      await save();
      console.error(`Lab ${lab} could not be brought up: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    for (;;) {
      if (stop) return;
      const entry = q.entries.find((e) => e.status === 'queued');
      if (!entry) return;
      // Taken at once, before anything is awaited: another worker must not take it too.
      Object.assign(entry, { status: 'running', lab, startedAt: new Date().toISOString() });
      const free = await deps.freeBytes(resultsDir());
      if (free < MIN_FREE_BYTES) {
        Object.assign(entry, { status: 'queued', lab: undefined, startedAt: undefined });
        stop = `Under 3 GB free on the disk (${(free / 1e9).toFixed(1)} GB): no run was started. Free space, then start the campaign again.`;
        q.stoppedBecause = stop;
        await save();
        return;
      }
      await save();
      try {
        const result = await deps.runOne({ lab, scenario: entry.scenario, model: entry.model });
        Object.assign(entry, { status: result.grade.status, outcome: result.grade.outcome, runId: result.runId, dir: result.dir, endedAt: new Date().toISOString() });
        if (result.grade.status === 'provider-error') retry(q, entry);
        if (result.grade.status === 'harness-error' && /not healthy after two resets/.test(await harnessNote(result.dir))) {
          // The lab is broken: this worker leaves it, and the entry waits for another lab.
          q.brokenLabs = [...(q.brokenLabs ?? []), lab];
          retry(q, entry);
          await save();
          return;
        }
      } catch (error) {
        Object.assign(entry, { status: 'harness-error', endedAt: new Date().toISOString(), note: error instanceof Error ? error.message : String(error) });
      }
      await save();
    }
  };

  try {
    await Promise.all(opts.labs.map((lab) => worker(lab)));
  } finally {
    await writing;
    await deps.close?.();
  }
}

async function harnessNote(dir: string): Promise<string> {
  try {
    return String((JSON.parse(await fs.readFile(path.join(dir, 'run.json'), 'utf8')) as { harnessError?: string }).harnessError ?? '');
  } catch {
    return '';
  }
}
