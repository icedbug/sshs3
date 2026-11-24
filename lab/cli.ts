/**
 * The lab from the command line: `npm run lab:up -- <n>`, `lab:reset`, `lab:down`, `lab:status`, and
 * `npm run lab -- validate [--scenario <id>[,<id>]] [--times 3] [--lab <n>]`.
 * Lab n has the subnet 10.77.<n>.0/24; the campaigns use 1 and 2, the lab's own tests 9.
 */
import { SCENARIOS } from './scenarios';
import { labDown, labHealthy, labReset, labUp } from './src/lab';
import { validateScenario } from './src/validate';

const [command, ...rest] = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = rest.indexOf(`--${name}`);
  return at >= 0 ? rest[at + 1] : undefined;
};
const arg = command === 'validate' ? flag('lab') : rest[0];
const n = Number(arg ?? 1);

async function validate(): Promise<void> {
  const ids = flag('scenario')?.split(',');
  const times = Number(flag('times') ?? 1);
  for (const id of ids ?? []) if (!SCENARIOS.some((s) => s.id === id)) throw new Error(`No task is named "${id}".`);
  const chosen = ids ? SCENARIOS.filter((s) => ids.includes(s.id)) : SCENARIOS;
  await labUp(n);
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

async function main(): Promise<void> {
  if (!Number.isInteger(n) || n < 1 || n > 250) throw new Error(`A lab number is 1 to 250, not "${arg}".`);
  switch (command) {
    case 'validate':
      return validate();
    case 'up': {
      const lab = await labUp(n);
      for (const s of lab.servers) console.log(`${s.name.padEnd(11)} ${s.ip.padEnd(13)} ${s.tags.join(', ')}`);
      console.log(`Lab ${n} is up and healthy.`);
      return;
    }
    case 'reset':
      await labReset(n);
      console.log(`Lab ${n} is back to its golden images and healthy.`);
      return;
    case 'down':
      await labDown(n);
      console.log(`Lab ${n} is down. Its golden images are kept.`);
      return;
    case 'status': {
      const failing = await labHealthy(n);
      console.log(failing.length ? `Lab ${n} is not healthy:\n${failing.map((f) => `- ${f}`).join('\n')}` : `Lab ${n} is healthy.`);
      process.exitCode = failing.length ? 1 : 0;
      return;
    }
    default:
      throw new Error('Commands: up, reset, down, status, each with a lab number; validate [--scenario <id>] [--times 3] [--lab <n>].');
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
