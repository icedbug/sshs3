import path from 'node:path';
import { takeLock } from '../src/lock';
import { STATE_DIR } from '../src/ssh';

/**
 * A test's own lab, taken as a campaign or a lab command takes it: refused at once while a run or a
 * campaign uses it, where the test would otherwise reset or stop that lab under the run.
 */
export const takeLabForTests = (n: number, what: string): Promise<() => Promise<void>> =>
  takeLock(path.join(STATE_DIR, `lab-${n}.lock`), `Lab ${n} (lab tests: ${what})`);
