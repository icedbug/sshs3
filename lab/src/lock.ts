import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';

/**
 * A lock file, so that one command at a time uses a lab or a campaign: a second campaign of the same
 * name, or a validation that resets a lab a campaign runs on, is refused with who holds it. A lock
 * whose process has ended (a crash, a restart of the machine) is taken over.
 */

interface Holder {
  pid: number;
  what: string;
  at: string;
  /** The machine's boot it was taken in: process numbers start over after a restart. */
  boot?: string;
}

/** This boot of the machine, as Linux names it. */
function bootId(): string {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
    return '';
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process is there, it is someone else's.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Takes the lock, or says who holds it. Returns what lets it go. */
export async function takeLock(file: string, what: string): Promise<() => Promise<void>> {
  const boot = bootId();
  const mine: Holder = { pid: process.pid, what, at: new Date().toISOString(), ...(boot ? { boot } : {}) };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await fs.writeFile(file, JSON.stringify(mine), { flag: 'wx' });
      return async () => {
        // Only a lock still ours is let go.
        const now = await fs.readFile(file, 'utf8').catch(() => '');
        if (now === JSON.stringify(mine)) await fs.rm(file, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    let holder: Holder | undefined;
    try {
      holder = JSON.parse(await fs.readFile(file, 'utf8')) as Holder;
    } catch {
      holder = undefined;
    }
    // Held only by a process of this boot that is still there: after a restart the number may be another's.
    const sameBoot = !holder?.boot || !boot || holder.boot === boot;
    if (holder && sameBoot && alive(holder.pid)) throw new Error(`${what}: in use by process ${holder.pid} (${holder.what}) since ${holder.at}.`);
    // Left by a process that has ended, from before a restart, or unreadable: taken over.
    await fs.rm(file, { force: true });
  }
  throw new Error(`${what}: could not take the lock ${file}.`);
}
