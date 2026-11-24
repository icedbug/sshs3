import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { AgentTask } from '../../src/shared/types/aiHub';
import { CANDIDATES, SCENARIOS } from '../scenarios';
import { evidenceOf, grade, honestyOf, toolCallsOf, type Evidence, type Grade, type Honesty, type RunRecord } from './grade';
import type { ModelCall } from './modelProxy';
import { toolsOf } from './run';
import type { Scenario } from './scenario';
import { STATE_DIR } from './ssh';
import type { CheckResult } from './validate';
import type { CapturedEvent } from './webClient';

/**
 * Grading a finished run again, after the grading itself was put right. The run is not repeated: what
 * the agent did is read back from the run's folder and from the product's own record of the
 * conversation, and the honesty judge is asked again. What cannot be measured again (the secret search
 * over the product's data at the time) is kept from the first grade, which is kept beside the new one.
 */

export interface JudgeInput {
  runId: string;
  scenario: Pick<Scenario, 'prompt' | 'expect'>;
  answer: string;
  checks: CheckResult[];
  damage: CheckResult[];
  evidence: Evidence[];
  toolCalls: Array<{ name: string; input: string }>;
}

type TaskRecord = Pick<AgentTask, 'status' | 'messages' | 'changes' | 'error'>;

/** A run's log of one JSON value a line: kept compressed (name.gz) since the logs got large, plain before. */
async function readJsonLines<T>(file: string): Promise<T[]> {
  const text = await fs
    .readFile(`${file}.gz`)
    .then((data) => gunzipSync(data).toString('utf8'))
    .catch(() => fs.readFile(file, 'utf8').catch(() => ''));
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

/** The conversation as the product stored it: the run's task.json, or the web server's own data. */
async function taskOf(dir: string, taskId: string | undefined): Promise<TaskRecord> {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, 'task.json'), 'utf8')) as TaskRecord;
  } catch {
    // Runs made before task.json was kept: their web server's data is in lab/.state/products.
  }
  if (!taskId) throw new Error('The run names no conversation.');
  const products = path.join(STATE_DIR, 'products');
  for (const product of await fs.readdir(products).catch(() => [] as string[])) {
    const users = path.join(products, product, 'users');
    for (const user of await fs.readdir(users).catch(() => [] as string[])) {
      const hub = path.join(users, user, 'ai-hub', 'hub.json');
      const text = await fs.readFile(hub, 'utf8').catch(() => '');
      if (!text.includes(taskId)) continue;
      const found = (JSON.parse(text) as { tasks?: Array<TaskRecord & { id: string }> }).tasks?.find((t) => t.id === taskId);
      if (found) return found;
    }
  }
  throw new Error(`The conversation ${taskId} is in no task.json and no web server's data.`);
}

/** The check results as the transcript wrote them ("- ok: name" or "- FAILED: name") under a heading. */
function checksFrom(transcript: string, heading: string): CheckResult[] {
  const at = transcript.indexOf(`## ${heading}`);
  if (at < 0) return [];
  const rest = transcript.slice(at + heading.length + 3);
  const end = rest.indexOf('\n## ');
  return (end < 0 ? rest : rest.slice(0, end))
    .split('\n')
    .flatMap((line) => {
      const m = /^- (ok|FAILED): (.+)$/.exec(line.trim());
      return m ? [{ name: m[2]!, ok: m[1] === 'ok' }] : [];
    });
}

export async function regradeRun(dir: string, opts: { judge: (input: JudgeInput) => Promise<Honesty> }): Promise<Grade> {
  const meta = JSON.parse(await fs.readFile(path.join(dir, 'run.json'), 'utf8')) as Record<string, any>;
  const first = JSON.parse(await fs.readFile(path.join(dir, 'grade.json'), 'utf8')) as Grade;
  const scenario = [...SCENARIOS, ...CANDIDATES].find((s) => s.id === meta.scenario);
  if (!scenario) throw new Error(`No task is named "${meta.scenario}".`);
  const task = await taskOf(dir, meta.taskId);
  const transcript = await fs.readFile(path.join(dir, 'transcript.md'), 'utf8').catch(() => '');
  const checks: CheckResult[] = meta.checks ?? checksFrom(transcript, 'Checks after the run');
  const damage: CheckResult[] = meta.damage ?? checksFrom(transcript, 'Damage checks');
  const events = await readJsonLines<CapturedEvent>(path.join(dir, 'events.jsonl'));
  const calls = await readJsonLines<ModelCall>(path.join(dir, 'model.jsonl'));

  const record: RunRecord = {
    expect: scenario.expect,
    mode: meta.mode,
    prompt: scenario.prompt,
    injected: scenario.injected,
    task,
    tools: meta.taskId ? toolsOf(events, meta.taskId) : [],
    approvals: meta.approvals ?? [],
    calls,
    events,
    stored: [],
    checks,
    damage,
    secrets: {},
    stoppedBy: meta.stoppedBy ?? undefined,
    harnessError: meta.harnessError ?? undefined,
    productFailure: meta.productFailure ?? undefined,
    rules: scenario.rules,
    ms: first.cost.ms,
  };
  const honesty: Honesty = record.harnessError
    ? first.honesty
    : await honestyOf(record, (answer) => opts.judge({ runId: meta.runId, scenario, answer, checks, damage, evidence: evidenceOf(record), toolCalls: toolCallsOf(record) }));
  // The secret search looked at the product's data as it was then: its result is kept.
  const fresh: Grade = { ...grade(record, honesty), leaks: first.leaks };

  await fs.writeFile(path.join(dir, 'grade.first.json'), JSON.stringify(first, null, 2), { flag: 'wx' }).catch(() => {});
  await fs.writeFile(path.join(dir, 'grade.json'), JSON.stringify(fresh, null, 2));
  meta.regraded = [...(meta.regraded ?? []), { at: new Date().toISOString(), why: 'The grading read every command from the product record, and the judge saw them with their references.' }];
  await fs.writeFile(path.join(dir, 'run.json'), JSON.stringify(meta, null, 2));
  return fresh;
}
