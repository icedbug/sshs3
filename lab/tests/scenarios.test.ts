import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FLEET } from '../fleet';
import { CANDIDATES, SCENARIOS } from '../scenarios';
import { labDown, labUp } from '../src/lab';
import { placeholdersIn, VALUE_NAMES } from '../src/scenario';
import { STATE_DIR } from '../src/ssh';
import { validateScenario } from '../src/validate';
import { takeLabForTests } from './labLock';

// Lab 9 is the tests' own: the campaigns use 1 and 2.
const N = 9;
const servers = new Set(FLEET.map((s) => s.name));
const withShell = new Set(FLEET.filter((s) => s.role !== 's3').map((s) => s.name));

/** The secrets planted in every lab built on this machine so far. */
async function plantedSecrets(): Promise<string[]> {
  const found: string[] = [];
  for (const name of await fs.readdir(STATE_DIR).catch(() => [] as string[]))
    if (/^lab-\d+\.json$/.test(name)) found.push(...Object.values((JSON.parse(await fs.readFile(path.join(STATE_DIR, name), 'utf8')) as { canaries: Record<string, string> }).canaries));
  return found;
}

describe('the tasks', () => {
  it('every scenario is well formed', async () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(8);
    const all = [...SCENARIOS, ...CANDIDATES];
    expect(new Set(all.map((s) => s.id)).size).toBe(all.length);
    const secrets = await plantedSecrets();
    for (const s of all) {
      const where = `scenario ${s.id}`;
      expect(s.id, where).toMatch(/^[a-z0-9-]+$/);
      expect(withShell.has(s.start), `${where}: it starts on ${s.start}, which has no shell`).toBe(true);
      const steps = [...s.setup, ...(s.oracle ?? []), ...(s.harm ?? []), ...(s.alternatives ?? []).flat(), ...(s.secretsAfter ?? []), ...(s.observe ?? []), ...s.checks, ...s.damage];
      for (const step of steps) expect(servers.has(step.server), `${where}: unknown server ${step.server}`).toBe(true);
      for (const step of steps) for (const name of placeholdersIn(step.run)) expect(VALUE_NAMES, `${where}: unknown value {{${name}}}`).toContain(name);
      if (s.expect === 'fix') expect(s.oracle?.length, `${where}: a task to solve needs a known solution`).toBeGreaterThan(0);
      expect(s.checks.length, `${where}: no checks`).toBeGreaterThan(0);
      expect(s.damage.length, `${where}: no damage checks`).toBeGreaterThan(0);
      expect(new Set([...s.checks, ...s.damage].map((c) => c.name)).size, `${where}: two checks share a name`).toBe(s.checks.length + s.damage.length);
      // What the person writes holds no secret and no value the lab fills in.
      expect(placeholdersIn(s.prompt), `${where}: a value in the prompt`).toEqual([]);
      for (const secret of secrets) expect(s.prompt.includes(secret), `${where}: a planted secret in the prompt`).toBe(false);
    }
  });

  describe('in a lab', () => {
    let unlock: (() => Promise<void>) | undefined;
    beforeAll(async () => {
      unlock = await takeLabForTests(N, 'scenarios');
      await labUp(N);
    });

    afterAll(async () => {
      if (unlock) await labDown(N);
      await unlock?.();
    });

    it('nginx-bad-config validates in a lab', async () => {
      const result = await validateScenario(SCENARIOS.find((s) => s.id === 'nginx-bad-config')!, N);
      expect(result.problems).toEqual([]);
      expect(result.ok).toBe(true);
    });
  });
});
