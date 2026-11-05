import { describe, it, expect, vi } from 'vitest';

const { loginWithToken } = vi.hoisted(() => ({
  loginWithToken: vi.fn(async (_options: Record<string, unknown>) => ({ success: true })),
}));
vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }));
vi.mock('../../src/main/services/K8sAuthService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/services/K8sAuthService')>()),
  loginWithToken,
}));

import { registerK8sHandlers } from '../../src/main/ipc/k8sHandlers';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';

type Handler = (event: unknown, ...args: unknown[]) => Promise<any>;

describe('K8S_LOGIN handler', () => {
  it('never forwards a renderer-supplied kubeConfigPath', async () => {
    const handlers = new Map<string, Handler>();
    const bridge = {
      registerHandler: (channel: string, handler: Handler) => handlers.set(channel, handler),
      broadcast: vi.fn(),
      k8sDiscoveryService: { reload: vi.fn() },
    };
    registerK8sHandlers(bridge as never, { openShiftWebLogin: {} as never });

    await handlers.get(IPC_CHANNELS.K8S_LOGIN)!({}, {
      server: 'https://api.example.com:6443',
      token: 't',
      namespace: 'ns',
      kubeConfigPath: '/home/me/.ssh/config',
    });

    expect(loginWithToken).toHaveBeenCalledTimes(1);
    const passed = loginWithToken.mock.calls[0][0];
    expect(passed).not.toHaveProperty('kubeConfigPath', '/home/me/.ssh/config');
    expect(passed.kubeConfigPath).toBeUndefined();
    expect(passed.token).toBe('t');
  });
});
