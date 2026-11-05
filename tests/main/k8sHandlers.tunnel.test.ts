import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }));

import { registerK8sHandlers } from '../../src/main/ipc/k8sHandlers';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';
import type { SSHConnectionConfig, SSHTunnelConfig } from '../../src/shared/types/ssh';

type Handler = (event: unknown, ...args: unknown[]) => Promise<any>;

const tunnel: SSHTunnelConfig = { id: 't1', type: 'local', localPort: 8080, remoteHost: 'db', remotePort: 5432 } as SSHTunnelConfig;

function setup() {
  const handlers = new Map<string, Handler>();
  const startTunnel = vi.fn(async (config: SSHConnectionConfig) => ({ id: 'tun-1', connectionId: config.id }));
  const bridge = {
    registerHandler: (channel: string, handler: Handler) => handlers.set(channel, handler),
    broadcast: vi.fn(),
    k8sDiscoveryService: { reload: vi.fn() },
    // Stand-ins that mark what each step did, so the order and the result are visible in the config.
    restoreSavedSecrets: vi.fn(async (c: SSHConnectionConfig) =>
      c.authType === 'password' && !c.password ? { ...c, password: 'saved-pw' } : c // pragma: allowlist secret
    ),
    resolveProxyJumpConfig: vi.fn(async (c: SSHConnectionConfig) => ({ ...c, proxyJump: 'resolved-jump' })),
    teamVaultService: {
      resolveProfileForConnect: vi.fn(async () => ({
        id: 'shared-profile',
        name: 'Shared',
        host: 'shared.example.com',
        username: 'deploy',
        authType: 'password',
        password: 'team-pw', // pragma: allowlist secret
      })),
    },
    smartcard: {
      prepareSmartcardConfig: vi.fn(async (c: SSHConnectionConfig) => c),
      prepareFido2Config: vi.fn(async (c: SSHConnectionConfig) => c),
      prepareSshCaConfig: vi.fn(async (c: SSHConnectionConfig) => c),
    },
    sshTunnelManager: { startTunnel },
    promptForPinDirect: vi.fn(),
  };
  registerK8sHandlers(bridge as never, { openShiftWebLogin: {} as never });
  return { handler: handlers.get(IPC_CHANNELS.SSH_TUNNEL_START)!, bridge, startTunnel };
}

describe('SSH_TUNNEL_START handler', () => {
  it('restores the saved password that never left main before starting the tunnel', async () => {
    const { handler, startTunnel } = setup();
    const config = { id: 'p1', name: 'Prod', host: 'h', username: 'u', authType: 'password' } as SSHConnectionConfig;

    await handler({}, config, tunnel);

    const started = startTunnel.mock.calls[0][0];
    expect(started.password).toBe('saved-pw'); // pragma: allowlist secret
    expect(started.proxyJump).toBe('resolved-jump'); // the existing steps still run on the restored config
  });

  it('resolves a Team Vault profile reference server-side and keeps the connection id', async () => {
    const { handler, bridge, startTunnel } = setup();
    const config = {
      id: 'conn-1',
      name: 'Shared',
      host: 'ignored',
      username: 'ignored',
      authType: 'password',
      teamVaultProfileRef: { vaultId: 'v1', profileId: 'shared-profile' },
    } as SSHConnectionConfig;

    await handler({}, config, tunnel);

    expect(bridge.teamVaultService.resolveProfileForConnect).toHaveBeenCalledWith('v1', 'ssh', 'shared-profile');
    const started = startTunnel.mock.calls[0][0];
    expect(started).toMatchObject({ id: 'conn-1', host: 'shared.example.com', password: 'team-pw' }); // pragma: allowlist secret
  });
});
