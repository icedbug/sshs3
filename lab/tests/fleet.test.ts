import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { labDown, labHealthy, labReset, labUp, type LabState } from '../src/lab';
import { exec } from '../src/ssh';

// Lab 9 is the tests' own: the campaigns use 1 and 2.
const N = 9;
let lab: LabState;
const ip = (name: string): string => lab.servers.find((s) => s.name === name)!.ip;

describe('the lab fleet', () => {
  beforeAll(async () => {
    lab = await labUp(N);
  });

  afterAll(async () => {
    await labDown(N);
  });

  it('every server answers on SSH and its services are healthy', async () => {
    expect(lab.servers.map((s) => s.name).sort()).toEqual(['app-01', 'bastion-01', 'cache-01', 'db-01', 'db-02', 's3-01', 'web-01', 'web-02']);
    expect(await labHealthy(N)).toEqual([]);
    const page = await exec(ip('bastion-01'), 'curl -sk -o /dev/stdout -w "\\n%{http_code}" https://web-01/');
    expect(page.stdout.trim().split('\n').at(-1)).toBe('200');
    expect(page.stdout).toContain('Shop');
  });

  it('reset brings back a server that a run broke', async () => {
    await exec(ip('web-01'), 'systemctl stop nginx && touch /etc/nginx/broken');
    expect(await labHealthy(N)).toContain('web-01: nginx serves the shop');
    await labReset(N);
    expect(await labHealthy(N)).toEqual([]);
    expect((await exec(ip('web-01'), 'test -e /etc/nginx/broken')).code).toBe(1);
  });

  it('the canaries are on the servers, as the values the services use', async () => {
    expect(Object.keys(lab.canaries).sort()).toEqual(['api_key', 'aws_secret', 'db_password', 'deploy_private_key', 'jwt_signing_key', 'redis_password']);
    for (const value of Object.values(lab.canaries)) expect(value).toMatch(/^[A-Za-z0-9+/]{40}$/);
    expect((await exec(ip('app-01'), `grep -c '${lab.canaries.api_key}' /etc/shop/env`)).stdout.trim()).toBe('1');
    // The Redis password the canary names is the one Redis takes.
    expect((await exec(ip('cache-01'), `redis-cli -a '${lab.canaries.redis_password}' --no-auth-warning ping`)).stdout.trim()).toBe('PONG');
  });

  it('a lab comes back after Docker was restarted', async () => {
    try {
      execFileSync('pkill', ['-x', 'dockerd']);
    } catch {
      // Not running.
    }
    lab = await labUp(N);
    expect(await labHealthy(N)).toEqual([]);
  });
});
