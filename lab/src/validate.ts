import { labReset, loadLab, type LabState } from './lab';
import { fillIn, type Check, type Scenario, type Step } from './scenario';
import { exec } from './ssh';
import { labValues } from './values';

/**
 * A task counts only once it is shown right, in fresh resets of a lab: doing nothing leaves its checks
 * red, its known solution turns them green, and its damage checks go red when harm is done on purpose.
 * That keeps the lab, and not the agent, from deciding a run.
 */

export interface CheckResult {
  name: string;
  ok: boolean;
}

const ipOf = (lab: LabState, server: string): string => {
  const s = lab.servers.find((x) => x.name === server);
  if (!s) throw new Error(`The lab has no server ${server}.`);
  return s.ip;
};

/** Runs a step; a step that fails stops what it is part of, with what it printed. */
export async function runStep(lab: LabState, values: Record<string, string>, step: Step): Promise<void> {
  const r = await exec(ipOf(lab, step.server), `set -eo pipefail\n${fillIn(step.run, values)}`, { timeoutMs: 10 * 60_000 });
  if (r.code !== 0) throw new Error(`A step on ${step.server} failed (${r.code}): ${(r.stderr || r.stdout).trim().slice(-600)}`);
}

export async function runChecks(lab: LabState, values: Record<string, string>, checks: Check[]): Promise<CheckResult[]> {
  return Promise.all(
    checks.map(async (c) => ({ name: c.name, ok: (await exec(ipOf(lab, c.server), fillIn(c.run, values), { timeoutMs: 60_000 })).code === 0 })),
  );
}

/**
 * The checks, read again until they show what is wanted or the time is up: a service takes a moment
 * to come up after a fix, and a fault a moment to show. Returns the last reading.
 */
export async function waitForChecks(
  lab: LabState,
  values: Record<string, string>,
  checks: Check[],
  want: 'all-true' | 'some-false',
  timeoutMs = 90_000,
): Promise<CheckResult[]> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const results = await runChecks(lab, values, checks);
    const done = want === 'all-true' ? results.every((r) => r.ok) : results.some((r) => !r.ok);
    if (done || Date.now() >= until) return results;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

const failing = (results: CheckResult[]): string => results.filter((r) => !r.ok).map((r) => r.name).join('; ');

export interface Validation {
  ok: boolean;
  problems: string[];
  /** Why the task was not tried at all here (it needs what this machine cannot run). */
  skipped?: string;
}

export async function validateScenario(s: Scenario, n: number): Promise<Validation> {
  const problems: string[] = [];
  let lab = await loadLab(n);
  if (s.needs?.includes('k8s') && !lab.k8s) return { ok: false, problems: [], skipped: 'It needs Kubernetes, which this machine cannot run (see lab/.state/k8s-<n>.reason).' };
  const values = await labValues(lab);
  const toFix = s.expect === 'fix' || s.expect === 'investigate';

  // 1 to 3: a fresh lab, the fault, and the known solution.
  await labReset(n);
  lab = await loadLab(n);
  let r = await waitForChecks(lab, values, s.forward ? s.damage : [...s.checks, ...s.damage], 'all-true');
  if (!r.every((x) => x.ok)) problems.push(`Before setup these are not true: ${failing(r)}.`);
  try {
    for (const step of s.setup) await runStep(lab, values, step);
    if (toFix) {
      r = await waitForChecks(lab, values, s.checks, 'some-false');
      if (r.every((x) => x.ok)) problems.push('After setup every check is still true: doing nothing would pass.');
    } else {
      r = await waitForChecks(lab, values, s.checks, 'all-true');
      if (!r.every((x) => x.ok)) problems.push(`After setup these checks are not true, though nothing is to be fixed: ${failing(r)}.`);
    }
    r = await waitForChecks(lab, values, s.damage, 'all-true');
    if (!r.every((x) => x.ok)) problems.push(`After setup these damage checks are not true: ${failing(r)}.`);
    if (s.oracle?.length) {
      for (const step of s.oracle) await runStep(lab, values, step);
      r = await waitForChecks(lab, values, [...s.checks, ...s.damage], 'all-true');
      if (!r.every((x) => x.ok)) problems.push(`After the known solution these are not true: ${failing(r)}.`);
    }
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }

  // 4: a fresh lab, the fault, and harm done on purpose.
  if (s.harm?.length) {
    await labReset(n);
    lab = await loadLab(n);
    try {
      for (const step of [...s.setup, ...s.harm]) await runStep(lab, values, step);
      r = await waitForChecks(lab, values, s.damage, 'some-false');
      if (r.every((x) => x.ok)) problems.push('After the harm every damage check is still true: damage would go unseen.');
    } catch (error) {
      problems.push(`Harm: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { ok: problems.length === 0, problems };
}
