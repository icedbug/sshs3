import { describe, it, expect } from 'vitest';
import { planSystemConnect } from '../../src/renderer/src/lib/connectSystem';
import type { SSHConnectionConfig } from '../../src/shared/types/ssh';

const tunnel = (id: string, name = id) => ({ id, name, type: 'local' as const, localPort: 1000, remoteHost: 'localhost', remotePort: 80 });
const member = (id: string, name: string, system: SSHConnectionConfig['system'], tunnels?: SSHConnectionConfig['tunnels']): SSHConnectionConfig =>
  ({ id, name, host: `${name}.example.com`, username: 'u', authType: 'password', system, tunnels }) as SSHConnectionConfig;

describe('planSystemConnect', () => {
  it('opens a terminal for each server, in name order, titled after the server', () => {
    const plan = planSystemConnect([member('2', 'web-2', { name: 'shop' }), member('1', 'db-1', { name: 'shop' })]);
    expect(plan.tabs.map((t) => t.title)).toEqual(['db-1', 'web-2']);
    expect(plan.tabs[0].config.id).toBe('1');
  });

  it('starts the terminal in the start directory when there is one', () => {
    const plan = planSystemConnect([member('1', 'web', { name: 'shop', startDirectory: '/srv/web' }), member('2', 'db', { name: 'shop' })]);
    expect(plan.tabs.find((t) => t.config.id === '1')?.startDirectory).toBe('/srv/web');
    expect(plan.tabs.find((t) => t.config.id === '2')?.startDirectory).toBeUndefined();
  });

  it('opens no terminal for a server that only contributes tunnels', () => {
    const plan = planSystemConnect([member('1', 'web', { name: 'shop' }), member('2', 'tun', { name: 'shop', shell: false, tunnelIds: ['t1'] }, [tunnel('t1')])]);
    expect(plan.tabs.map((t) => t.config.id)).toEqual(['1']);
    expect(plan.tunnels.map((t) => t.tunnel.id)).toEqual(['t1']);
  });

  it('starts the chosen tunnels of each server, with that server\'s connection', () => {
    const web = member('1', 'web', { name: 'shop', tunnelIds: ['t2'] }, [tunnel('t1'), tunnel('t2')]);
    const plan = planSystemConnect([web]);
    expect(plan.tunnels).toHaveLength(1);
    expect(plan.tunnels[0]).toMatchObject({ config: web, tunnel: { id: 't2' } });
  });

  it('skips a tunnel id the server no longer has instead of failing', () => {
    const plan = planSystemConnect([member('1', 'web', { name: 'shop', tunnelIds: ['gone', 't1'] }, [tunnel('t1')])]);
    expect(plan.tunnels.map((t) => t.tunnel.id)).toEqual(['t1']);
  });

  it('plans nothing for no servers, and nothing for a server that has neither a terminal nor tunnels', () => {
    expect(planSystemConnect([])).toEqual({ tabs: [], tunnels: [] });
    expect(planSystemConnect([member('1', 'idle', { name: 'shop', shell: false })])).toEqual({ tabs: [], tunnels: [] });
  });

  it('treats a profile without a membership as a server with a terminal', () => {
    const plan = planSystemConnect([member('1', 'plain', undefined)]);
    expect(plan.tabs).toHaveLength(1);
  });
});
