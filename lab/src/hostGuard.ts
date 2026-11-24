import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';

/**
 * This machine's own state around a run. The lab's servers run as privileged containers (systemd and
 * the tasks' mounts need it), so a command in one can change a kernel setting of this machine or its
 * clock, and that would carry into every later run and every other lab. The settings and the clock are
 * read before a run and after it; what changed is written down with the run and put back.
 */

export interface HostSnapshot {
  sysctl: Map<string, string>;
  /** Settings that changed by themselves while the first reading was taken twice: counters, not settings. */
  volatile: Set<string>;
  wallMs: number;
  /** A clock nothing can set: the time since this process started. */
  monoMs: number;
}

export interface HostChanges {
  sysctl: Array<{ key: string; before: string; after: string }>;
  /** How far the wall clock was moved during the run (0: not moved). */
  clockShiftMs: number;
}

/**
 * Counters that move too slowly to be caught by the second reading (open terminals, the last process
 * number, entropy, connection counts), and the settings of the lab networks' own links, which come and
 * go with the labs' containers.
 */
const COUNTERS = /^(?:fs\.(?:dentry-state|inode-nr|inode-state|file-nr|aio-nr|quota\.)|kernel\.(?:random\.|ns_last_pid|pty\.nr|tainted)|net\.netfilter\.nf_conntrack_count)|^net\.ipv[46]\.(?:conf|neigh)\.(?:veth|br-|docker)/;

/** Two clocks read a few milliseconds apart are not a change. */
const CLOCK_SLACK_MS = 2000;

function sysctlAll(): Promise<Map<string, string>> {
  return new Promise((resolve) =>
    execFile('sysctl', ['-a'], { maxBuffer: 16 * 1024 * 1024 }, (_error, stdout) => {
      const values = new Map<string, string>();
      for (const line of stdout.split('\n')) {
        const at = line.indexOf(' = ');
        if (at > 0) values.set(line.slice(0, at), line.slice(at + 3).replace(/\s+/g, ' ').trim());
      }
      resolve(values);
    }),
  );
}

/** Reads the settings twice, a second apart, to learn which change by themselves. */
export async function hostSnapshot(): Promise<HostSnapshot> {
  const first = await sysctlAll();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const second = await sysctlAll();
  const volatile = new Set([...second.keys()].filter((k) => first.get(k) !== second.get(k)));
  return { sysctl: second, volatile, wallMs: Date.now(), monoMs: performance.now() };
}

export async function hostNow(): Promise<HostSnapshot> {
  return { sysctl: await sysctlAll(), volatile: new Set(), wallMs: Date.now(), monoMs: performance.now() };
}

export function hostChanges(before: HostSnapshot, after: HostSnapshot): HostChanges {
  const sysctl = [...before.sysctl.entries()]
    .filter(([key, value]) => !before.volatile.has(key) && !COUNTERS.test(key) && after.sysctl.has(key) && after.sysctl.get(key) !== value)
    .map(([key, value]) => ({ key, before: value, after: after.sysctl.get(key)! }));
  const shift = after.wallMs - before.wallMs - (after.monoMs - before.monoMs);
  return { sysctl, clockShiftMs: Math.abs(shift) > CLOCK_SLACK_MS ? Math.round(shift) : 0 };
}

const run = (file: string, args: string[]): Promise<void> => new Promise((resolve) => execFile(file, args, () => resolve()));

/** Puts back what a run changed: each setting as it was, the clock by the amount it was moved. */
export async function restoreHost(changes: HostChanges): Promise<void> {
  for (const c of changes.sysctl) await run('sysctl', ['-q', '-w', `${c.key}=${c.before}`]);
  if (changes.clockShiftMs) await run('date', ['-s', `@${((Date.now() - changes.clockShiftMs) / 1000).toFixed(3)}`]);
}
