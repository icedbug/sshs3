/**
 * The lab from the command line: `npm run lab:up -- <n>`, `lab:reset`, `lab:down`, `lab:status`.
 * Lab n has the subnet 10.77.<n>.0/24; the campaigns use 1 and 2, the lab's own tests 9.
 */
import { labDown, labHealthy, labReset, labUp } from './src/lab';

const [command, arg] = process.argv.slice(2);
const n = Number(arg ?? 1);

async function main(): Promise<void> {
  if (!Number.isInteger(n) || n < 1 || n > 250) throw new Error(`A lab number is 1 to 250, not "${arg}".`);
  switch (command) {
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
      throw new Error('Commands: up, reset, down, status, each with a lab number.');
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
