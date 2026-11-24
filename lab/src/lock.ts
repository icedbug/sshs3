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
  const mine: Holder = { pid: process.pid, what, at: new Date().toISOString() };
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
    if (holder && alive(holder.pid)) throw new Error(`${what}: in use by process ${holder.pid} (${holder.what}) since ${holder.at}.`);
    // Left by a process that has ended, or unreadable: taken over.
    await fs.rm(file, { force: true });
  }
  throw new Error(`${what}: could not take the lock ${file}.`);
}
