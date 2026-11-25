import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE_IMAGE } from '../src/lab';
import { controlKey, exec, waitForSsh } from '../src/ssh';

// One container from the base image, on a network of its own, reached over the lab's control channel.
const NAME = 'lab-test-base';
const NET = 'lab-test-net';
const IP = '10.77.250.10';

const docker = (...args: string[]): string => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const quietly = (...args: string[]): void => {
  try {
    docker(...args);
  } catch {
    // Already gone.
  }
};

describe('the base server image', () => {
  beforeAll(() => {
    quietly('rm', '-f', NAME);
    quietly('network', 'rm', NET);
    docker('network', 'create', '--subnet', '10.77.250.0/24', NET);
  });

  afterAll(() => {
    quietly('rm', '-f', NAME);
    quietly('network', 'rm', NET);
  });

  it('a base container boots systemd and takes the control key', async () => {
    docker('run', '-d', '--privileged', '--name', NAME, '--hostname', NAME, '--network', NET, '--ip', IP, BASE_IMAGE);
    const key = await controlKey();
    docker('exec', NAME, 'sh', '-c', `mkdir -p /root/.ssh && echo '${key.publicKey}' > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys`);

    // A server that has just started takes a moment before sshd answers, as a VM does.
    await waitForSsh(IP, 60_000);
    const state = await exec(IP, 'systemctl is-system-running --wait || true', { timeoutMs: 120_000 });
    expect(['running', 'degraded']).toContain(state.stdout.trim());
    const name = await exec(IP, 'hostname');
    expect(name.code).toBe(0);
    expect(name.stdout.trim()).toBe(NAME);
  });
});
