import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where the lab keeps what is made on this machine and never committed: keys, canaries, lab state. */
export const STATE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.state');

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

let made: Promise<{ privateKeyPath: string; publicKey: string }> | undefined;

/**
 * The lab's control key: how the runner itself reaches every server, to break, check and reset it.
 * It is never given to the product, so what the product does and what the runner checks stay apart.
 */
export function controlKey(): Promise<{ privateKeyPath: string; publicKey: string }> {
  made ??= (async () => {
    const privateKeyPath = path.join(STATE_DIR, 'control_ed25519');
    await fs.mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
    try {
      await fs.access(privateKeyPath);
    } catch {
      await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'sshs3-lab-control', '-f', privateKeyPath]);
    }
    const publicKey = (await fs.readFile(`${privateKeyPath}.pub`, 'utf8')).trim();
    return { privateKeyPath, publicKey };
  })();
  return made;
}

/** Runs a command on a lab server over the control channel. A failed connection is code 255, as with ssh. */
export async function exec(host: string, cmd: string, opts: { user?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
  const key = await controlKey();
  const args = [
    '-i', key.privateKeyPath,
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'LogLevel=ERROR',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    `${opts.user ?? 'root'}@${host}`,
    cmd,
  ];
  return run('ssh', args, opts.timeoutMs ?? 60_000);
}

/** Waits until a server answers on SSH: a server that has just started takes a moment, as a VM does. */
export async function waitForSsh(host: string, timeoutMs = 60_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  let last: ExecResult | undefined;
  while (Date.now() < until) {
    last = await exec(host, 'true', { timeoutMs: 10_000 });
    if (last.code === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${host} did not answer on SSH within ${Math.round(timeoutMs / 1000)} s: ${last?.stderr.trim() ?? ''}`);
}

function run(file: string, args: string[], timeoutMs = 60_000): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : 255) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}
