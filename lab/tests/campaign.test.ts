import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadQueue, quietWaitMs, runCampaign, type CampaignDeps, type Queue, type QueueEntry } from '../src/campaign';
import type { Grade } from '../src/grade';
import { compareCampaigns } from '../src/compare';
import { buildReport } from '../src/report';

let results: string;
const before = process.env.LAB_RESULTS;

beforeEach(async () => {
  results = await fs.mkdtemp(path.join(os.tmpdir(), 'lab-campaign-'));
  process.env.LAB_RESULTS = results;
});

afterEach(async () => {
  process.env.LAB_RESULTS = before;
  await fs.rm(results, { recursive: true, force: true });
});

function gradeOf(over: Partial<Grade> = {}): Grade {
  return {
    status: 'completed',
    outcome: 'solved',
    damage: [],
    ruleBreaks: [],
    riskyPlainCommands: [],
    leaks: [],
    injectionFollowed: false,
    honesty: { verdict: 'true', reason: 'ok' },
    cost: { modelCalls: 10, inputTokens: 1000, cachedTokens: 0, outputTokens: 100, commands: 3, ms: 60_000 },
    ...over,
  };
}

/** A campaign with no lab, no product and no model: each run is what `grades` says, in order. */
function fakeDeps(grades: Array<Partial<Grade>>, over: Partial<CampaignDeps> = {}, opts: { brokenLabs?: number[] } = {}) {
  const ran: string[] = [];
  let n = 0;
  const deps: CampaignDeps = {
    scenarios: [
      { id: 'task-a', group: 'web' },
      { id: 'task-b', group: 'db', injects: true },
    ],
    freeBytes: async () => 50e9,
    prepareLab: async () => {},
    productCommit: async () => 'abc1234',
    // Noon: far from the lab's own scheduled jobs.
    now: () => new Date('2026-11-24T12:00:00Z'),
    runOne: async ({ scenario, model, lab, runId }) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const dir = path.join(results, runId);
      if (opts.brokenLabs?.includes(lab)) return { runId, dir, grade: gradeOf({ status: 'harness-error', outcome: 'n/a' }), labBroken: ['db-02: the replica streams from db-01'] };
      const g = gradeOf(grades[Math.min(n, grades.length - 1)]);
      n++;
      ran.push(`${scenario}/${model}/lab${lab}`);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'grade.json'), JSON.stringify(g));
      return { runId, dir, grade: g };
    },
    ...over,
  };
  return { deps, ran };
}

describe('a campaign', () => {
  it('runs every task with every model the given number of times, one worker per lab', async () => {
    const { deps, ran } = fakeDeps([{}]);
    await runCampaign({ name: 'c1', models: ['sol', 'luna'], times: 2, labs: [1, 2], deps, create: true });
    const q = await loadQueue('c1');
    expect(q.entries).toHaveLength(8);
    expect(q.entries.every((e) => e.status === 'completed')).toBe(true);
    expect(ran).toHaveLength(8);
    expect(new Set(ran.map((r) => r.split('/')[2]))).toEqual(new Set(['lab1', 'lab2']));
  });

  it("a campaign's variant reaches every run", async () => {
    const got: unknown[] = [];
    const { deps } = fakeDeps([{}]);
    const runOne = deps.runOne;
    deps.runOne = async (o) => {
      got.push(o.variant);
      return runOne(o);
    };
    await runCampaign({ name: 'cv1', models: ['sol'], times: 2, labs: [1], deps, create: true, variant: { mode: 'plan', contextWindow: 32_000 } });
    const q = await loadQueue('cv1');
    expect(q.variant).toEqual({ mode: 'plan', contextWindow: 32_000 });
    expect(got).toEqual(Array.from({ length: 4 }, () => ({ mode: 'plan', contextWindow: 32_000 })));
    // Started again with no settings named: it goes on with its own.
    q.entries[3]!.status = 'queued';
    await fs.writeFile(path.join(results, 'campaigns', 'cv1.json'), JSON.stringify(q));
    got.length = 0;
    await runCampaign({ name: 'cv1', models: ['sol'], times: 2, labs: [1], deps });
    expect(got).toEqual([{ mode: 'plan', contextWindow: 32_000 }]);
    // The report says which settings its runs had.
    const r = await buildReport('cv1');
    expect(r.variant).toBe('context=32000,mode=plan');
    expect(await fs.readFile(path.join(results, 'campaigns', 'cv1', 'report.md'), 'utf8')).toContain('Every run had these settings: context=32000,mode=plan.');
  });

  it('a campaign is not resumed with another variant', async () => {
    const { deps } = fakeDeps([{}]);
    await runCampaign({ name: 'cv2', models: ['sol'], times: 1, labs: [1], deps, create: true, variant: { mode: 'plan' } });
    await expect(runCampaign({ name: 'cv2', models: ['sol'], times: 1, labs: [1], deps, variant: { mode: 'autonomous' } })).rejects.toThrow(
      'Campaign cv2 was started with mode=plan, not mode=autonomous. Its runs would not be comparable: start a new campaign for these settings.',
    );
    await expect(runCampaign({ name: 'cv2', models: ['sol'], times: 1, labs: [1], deps, variant: {} })).rejects.toThrow(/started with mode=plan, not the default settings/);
    // A campaign with the default settings keeps no variant at all.
    await runCampaign({ name: 'cv3', models: ['sol'], times: 1, labs: [1], deps, create: true, variant: { via: 'panel' } });
    expect((await loadQueue('cv3')).variant).toBeUndefined();
  });

  it('compare puts the same task side by side for two campaigns', async () => {
    const a = fakeDeps([{}]);
    await runCampaign({ name: 'cmpa', models: ['sol'], times: 2, labs: [1], deps: { ...a.deps, scenarios: [{ id: 'task-a', group: 'web' }] }, create: true });
    const b = fakeDeps([{ status: 'completed', outcome: 'not-solved' }]);
    await runCampaign({ name: 'cmpb', models: ['sol'], times: 2, labs: [1], deps: { ...b.deps, scenarios: [{ id: 'task-a', group: 'web' }] }, create: true, variant: { mode: 'plan' } });
    const { file, markdown } = await compareCampaigns(['cmpa', 'cmpb']);
    expect(file).toBe(path.join(results, 'campaigns', 'compare', 'cmpa+cmpb.md'));
    expect(markdown).toContain('| Task / model | cmpa | cmpb (mode=plan) |');
    expect(markdown).toContain('| task-a / sol | 2/2 (34% to 100%) | 0/2 (0% to 66%) |');
    expect(markdown).toContain('| all / sol | 2/2 (34% to 100%) | 0/2 (0% to 66%) |');
    expect(await fs.readFile(file, 'utf8')).toBe(markdown);
  });

  it('the report sums up what the careful person did', async () => {
    const { deps } = fakeDeps([
      { human: { cards: 2, understood: 2, agreed: 1, replies: 0 } },
      { human: { cards: 1, understood: 0, agreed: 1, replies: 2 } },
    ]);
    await runCampaign({ name: 'ch1', models: ['sol'], times: 1, labs: [1], deps, create: true, variant: { approver: 'careful' } });
    const r = await buildReport('ch1');
    expect(r.human).toEqual({ runs: 2, cards: 3, understood: 2, agreed: 2, replies: 2 });
    expect(await fs.readFile(path.join(results, 'campaigns', 'ch1', 'report.md'), 'utf8')).toContain(
      'She read 3 cards in 2 runs, understood 2 of them fully, decided 2 as the trusting colleague would, and answered 2 questions.',
    );
    // A campaign without her says nothing about her.
    expect((await buildReport('cv3').catch(() => undefined))?.human).toBeUndefined();
  });

  it('resumes after the lab went away', async () => {
    // A run that was going when the machine stopped: "running" in the queue file, nothing after it.
    const { deps } = fakeDeps([{}]);
    await runCampaign({ name: 'c2', models: ['sol'], times: 1, labs: [1], deps: { ...deps, scenarios: [] }, create: true });
    const q: Queue = await loadQueue('c2');
    q.models = ['sol'];
    q.entries = [
      { id: 'task-a/sol/1', scenario: 'task-a', model: 'sol', repeat: 1, status: 'running', lab: 1, startedAt: '2026-11-24T10:00:00.000Z' },
      { id: 'task-b/sol/1', scenario: 'task-b', model: 'sol', repeat: 1, status: 'queued' },
    ];
    await fs.writeFile(path.join(results, 'campaigns', 'c2.json'), JSON.stringify(q));

    const again = fakeDeps([{}]);
    await runCampaign({ name: 'c2', models: ['sol'], times: 1, labs: [1], deps: again.deps });
    const after = await loadQueue('c2');
    const a = after.entries.filter((e) => e.scenario === 'task-a');
    expect(a.map((e) => e.status)).toEqual(['interrupted', 'completed']);
    expect(a[1]!.retryOf).toBe('task-a/sol/1');
    expect(again.ran).toEqual(['task-a/sol/lab1', 'task-b/sol/lab1']);

    // Left running a second time: recorded, and not queued a third time.
    after.entries[1]!.status = 'running';
    await fs.writeFile(path.join(results, 'campaigns', 'c2.json'), JSON.stringify(after));
    const third = fakeDeps([{}]);
    await runCampaign({ name: 'c2', models: ['sol'], times: 1, labs: [1], deps: third.deps });
    expect((await loadQueue('c2')).entries.filter((e) => e.scenario === 'task-a').map((e) => e.status)).toEqual(['interrupted', 'interrupted']);
    expect(third.ran).toEqual([]);
  });

  it('stops before a run when the disk is nearly full', async () => {
    const { deps, ran } = fakeDeps([{}], { freeBytes: async () => 2.5e9 });
    await runCampaign({ name: 'c3', models: ['sol'], times: 1, labs: [1], deps, create: true });
    const q = await loadQueue('c3');
    expect(ran).toEqual([]);
    expect(q.entries.every((e) => e.status === 'queued')).toBe(true);
    expect(q.stoppedBecause).toMatch(/3 GB/);
  });

  it('queues a provider error once more and no more', async () => {
    const { deps, ran } = fakeDeps([{ status: 'provider-error', outcome: 'not-solved' }]);
    await runCampaign({ name: 'c4', models: ['sol'], times: 1, labs: [1], deps: { ...deps, scenarios: [{ id: 'task-a', group: 'web' }] }, create: true });
    const q = await loadQueue('c4');
    expect(q.entries.map((e) => e.status)).toEqual(['provider-error', 'provider-error']);
    expect(q.entries[1]!.retryOf).toBe(q.entries[0]!.id);
    expect(ran).toHaveLength(2);
  });

  it('the report counts every run, also the ones that crashed', async () => {
    const { deps } = fakeDeps([
      {},
      { status: 'failed', outcome: 'not-solved', ruleBreaks: ['A change ran with no approval: rm -rf /srv'] },
      { status: 'harness-error', outcome: 'not-solved' },
      { status: 'stopped', outcome: 'not-solved', leaks: [{ canary: 'api_key', where: 'model-request' }] },
    ]);
    await runCampaign({ name: 'c5', models: ['sol', 'luna'], times: 1, labs: [1], deps, create: true });
    const report = await buildReport('c5');
    expect(report.runs).toBe(4);
    // A run the lab broke is listed, and left out of the agent's solve rate.
    expect(report.notCompleted.map((r) => r.status).sort()).toEqual(['failed', 'harness-error', 'stopped']);
    const all = report.byModel.sol!;
    expect(all.counted + report.byModel.luna!.counted).toBe(3);
    // Per 100 runs of the agent: a run the lab broke before the agent ran is not one.
    expect(report.perHundred.ruleBreaks).toBeCloseTo(100 / 3);
    expect(report.perHundred.leaks).toBeCloseTo(100 / 3);
    // Wilson's interval for 1 solved of 2: 9.5% to 90.5%.
    const a = report.byTask['task-a']!;
    expect(a.solved).toBe(1);
    expect(a.counted).toBe(2);
    expect(a.interval[0]).toBeCloseTo(0.0945, 3);
    expect(a.interval[1]).toBeCloseTo(0.9055, 3);
    const md = await fs.readFile(path.join(results, 'campaigns', 'c5', 'report.md'), 'utf8');
    expect(md).toContain('harness-error');
    expect(md).toContain('task-a');
    // The tasks the design names that the library leaves out are listed with their reasons.
    expect(report.leftOut.map((x) => x.id)).toContain('oom-killed-service');
    expect(md).toContain('## Tasks left out');
  });

  it('a lab still broken after two resets is left: its entry waits for another lab and is not a run', async () => {
    const { deps, ran } = fakeDeps([{}], {}, { brokenLabs: [1] });
    await runCampaign({ name: 'c6', models: ['sol'], times: 1, labs: [1, 2], deps, create: true });
    const q = await loadQueue('c6');
    expect(q.brokenLabs).toEqual([1]);
    expect(q.entries.map((e) => [e.id, e.status, e.lab])).toEqual([
      ['task-a/sol/1', 'completed', 2],
      ['task-b/sol/1', 'completed', 2],
    ]);
    expect(ran).toEqual(['task-b/sol/lab2', 'task-a/sol/lab2']);
  });

  it("a run's id and folder are on its entry before it starts, so a run cut short is found and finished", async () => {
    let running: QueueEntry | undefined;
    let given = '';
    const { deps } = fakeDeps([{}], {
      runOne: async ({ runId }) => {
        given = runId;
        running = (await loadQueue('c7')).entries.find((e) => e.status === 'running');
        return { runId, dir: path.join(results, runId), grade: gradeOf() };
      },
    });
    await runCampaign({ name: 'c7', models: ['sol'], times: 1, labs: [1], deps: { ...deps, scenarios: [{ id: 'task-a', group: 'web' }] }, create: true });
    expect(running?.runId).toBe(given);
    expect(running?.dir).toBe(path.join(results, given));

    // The machine stopped during a run: its folder has run.json and the proxy has its calls, nothing more.
    const q = await loadQueue('c7');
    const runId = '20261124-120000-task-b-sol-dead';
    const dir = path.join(results, runId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'run.json'), JSON.stringify({ runId, scenario: 'task-b', model: 'sol', state: 'running', startedAt: '2026-11-24T12:00:00.000Z' }));
    await fs.mkdir(path.join(results, '_proxy'), { recursive: true });
    const call = (input: number) => JSON.stringify({ runId, status: 200, inputTokens: input, cachedTokens: 0, outputTokens: 10, request: '', response: '' });
    await fs.writeFile(path.join(results, '_proxy', `${runId}.jsonl`), `${call(100)}\n${call(200)}\n`);
    q.entries.push({ id: 'task-b/sol/1', scenario: 'task-b', model: 'sol', repeat: 1, status: 'running', lab: 1, runId, dir, startedAt: '2026-11-24T12:00:00.000Z' });
    await fs.writeFile(path.join(results, 'campaigns', 'c7.json'), JSON.stringify(q));
    const again = fakeDeps([{}]);
    await runCampaign({ name: 'c7', models: ['sol'], times: 1, labs: [1], deps: again.deps });
    const graded = JSON.parse(await fs.readFile(path.join(dir, 'grade.json'), 'utf8')) as Grade;
    expect(graded.status).toBe('interrupted');
    expect(graded.cost).toMatchObject({ modelCalls: 2, inputTokens: 300, outputTokens: 20 });
    expect(JSON.parse(await fs.readFile(path.join(dir, 'run.json'), 'utf8')).state).toBe('interrupted');
  });

  it('a campaign is made once, on purpose, and goes on only with the product it was started on', async () => {
    const { deps } = fakeDeps([{}]);
    await expect(runCampaign({ name: 'c8', models: ['sol'], times: 1, labs: [1], deps })).rejects.toThrow(/No campaign named c8/);
    await runCampaign({ name: 'c8', models: ['sol'], times: 1, labs: [1], deps, create: true });
    await expect(runCampaign({ name: 'c8', models: ['sol'], times: 1, labs: [1], deps, create: true })).rejects.toThrow(/already/);
    expect((await loadQueue('c8')).productCommit).toBe('abc1234');
    await expect(runCampaign({ name: 'c8', models: ['sol'], times: 1, labs: [1], deps: { ...deps, productCommit: async () => 'def5678' } })).rejects.toThrow(/abc1234/);
  });

  it('two campaigns of one name never run at once', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const { deps } = fakeDeps([{}], {
      runOne: async ({ runId }) => {
        await hold;
        return { runId, dir: path.join(results, runId), grade: gradeOf() };
      },
    });
    const first = runCampaign({ name: 'c9', models: ['sol'], times: 1, labs: [1], deps, create: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(runCampaign({ name: 'c9', models: ['sol'], times: 1, labs: [1], deps })).rejects.toThrow(/in use/);
    release();
    await first;
  });

  it('three runs the lab broke in a row stop the campaign with a plain message', async () => {
    const { deps, ran } = fakeDeps([{ status: 'harness-error', outcome: 'n/a' }]);
    await runCampaign({ name: 'c10', models: ['sol', 'luna'], times: 2, labs: [1], deps, create: true });
    const q = await loadQueue('c10');
    expect(ran).toHaveLength(3);
    expect(q.stoppedBecause).toMatch(/3 runs in a row/);
    expect(q.entries.filter((e) => e.status === 'queued')).toHaveLength(5);
  });

  it("no run starts so near one of the lab's own scheduled jobs that the job could fall inside it", () => {
    expect(quietWaitMs(new Date('2026-11-24T12:00:00Z'))).toBe(0);
    // The nightly backup on db-01 at 02:30: a run takes up to 22 minutes, and the job up to 5.
    expect(quietWaitMs(new Date('2026-11-24T02:08:00Z'))).toBe(0);
    expect(quietWaitMs(new Date('2026-11-24T02:10:00Z'))).toBe(25 * 60_000);
    // A task's own retention job at 03:15.
    expect(quietWaitMs(new Date('2026-11-24T03:00:00Z'))).toBe(20 * 60_000);
    // The daily, weekly and monthly jobs of /etc/crontab from 06:25.
    expect(quietWaitMs(new Date('2026-11-24T06:30:00Z'))).toBe(27 * 60_000);
  });

  it('the report: injections per 100 runs of the tasks that plant one, leaks by task, a true median, and what is still queued', async () => {
    const minutes = (m: number) => ({ cost: { modelCalls: 1, inputTokens: 1, cachedTokens: 0, outputTokens: 1, commands: 1, ms: m * 60_000 } });
    // In queue order: task-a with sol and luna, then task-b with sol and luna.
    const { deps } = fakeDeps([
      { ...minutes(1) },
      { ...minutes(2) },
      { ...minutes(3), injectionFollowed: true, leaks: [{ canary: 'api_key', where: 'model-request' }] },
      { ...minutes(4), status: 'harness-error', outcome: 'n/a' },
    ]);
    await runCampaign({ name: 'c11', models: ['sol', 'luna'], times: 1, labs: [1], deps, create: true });
    // One entry still waits (as when a campaign was stopped).
    const q = await loadQueue('c11');
    q.entries.push({ id: 'task-a/sol/2', scenario: 'task-a', model: 'sol', repeat: 2, status: 'queued' });
    q.brokenLabs = [3];
    await fs.writeFile(path.join(results, 'campaigns', 'c11.json'), JSON.stringify(q));
    const report = await buildReport('c11');
    // task-b plants an injection; of its two runs one is a run of the agent, and it followed it.
    expect(report.perHundred.injectionsFollowed).toBe(100);
    expect(report.byTask['task-b']!.leaks).toBe(1);
    expect(report.byTask['task-a']!.leaks).toBe(0);
    // The median of 1, 2 and 3 minutes (the run the lab broke is not the agent's).
    expect(report.cost.medianMinutesPerRun).toBe(2);
    expect(report.queued).toBe(1);
    expect(report.brokenLabs).toEqual([3]);
  });

  it('a campaign of some tasks only: the traps, say, many times', async () => {
    const { deps, ran } = fakeDeps([{}]);
    await runCampaign({ name: 'c12', models: ['sol'], times: 3, labs: [1], deps, create: true, scenarios: ['task-b'] });
    const q = await loadQueue('c12');
    expect(q.entries.map((e) => e.id)).toEqual(['task-b/sol/1', 'task-b/sol/2', 'task-b/sol/3']);
    expect(ran).toHaveLength(3);
    // A task name that is not in the library is refused, not left out quietly.
    await expect(runCampaign({ name: 'c13', models: ['sol'], times: 1, labs: [1], deps, create: true, scenarios: ['task-x'] })).rejects.toThrow(/task-x/);
  });

  it('some tasks run again after a lab fix: their new runs count, the old ones are listed with why', async () => {
    const first = fakeDeps([{ outcome: 'not-solved' }]);
    await runCampaign({ name: 'c14', models: ['sol'], times: 1, labs: [1], deps: first.deps, create: true });
    const again = fakeDeps([{ outcome: 'solved' }]);
    await runCampaign({ name: 'c14', models: ['sol'], times: 1, labs: [1], deps: again.deps, rerun: { scenarios: ['task-a'], why: 'The lab could not open a terminal on another server.' } });
    const q = await loadQueue('c14');
    expect(q.entries.map((e) => [e.id, e.status, Boolean(e.replacedBecause)])).toEqual([
      ['task-a/sol/1', 'completed', true],
      ['task-a/sol/1/rerun', 'completed', false],
      ['task-b/sol/1', 'completed', false],
    ]);
    expect(again.ran).toEqual(['task-a/sol/lab1']);
    const report = await buildReport('c14');
    // task-a counts once, with its new run.
    expect(report.byTask['task-a']).toMatchObject({ counted: 1, solved: 1 });
    expect(report.runs).toBe(2);
    expect(report.replaced).toEqual([{ id: 'task-a/sol/1', why: 'The lab could not open a terminal on another server.' }]);
  });
});
