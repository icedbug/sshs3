import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import net from 'node:net';

const { mockPortForwardFn, MockPortForward } = vi.hoisted(() => {
  const mockPortForwardFn = vi.fn();
  class MockPortForward {
    constructor(public kc: any) {}
    portForward = mockPortForwardFn;
  }
  return { mockPortForwardFn, MockPortForward };
});

vi.mock('../../src/main/services/k8sClient', () => ({
  loadK8sClient: vi.fn().mockResolvedValue({
    PortForward: MockPortForward,
  }),
}));

vi.mock('../../src/main/services/k8sKubeConfig', () => ({
  loadKubeConfigForContext: vi.fn().mockResolvedValue({
    getCurrentContext: () => 'test-ctx',
  }),
}));

import { K8sPortForwardManager } from '../../src/main/services/K8sPortForwardManager';

describe('K8sPortForwardManager', () => {
  let manager: K8sPortForwardManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPortForwardFn.mockResolvedValue(() => ({ close: vi.fn() }));
    manager = new K8sPortForwardManager();
  });

  afterEach(async () => {
    await manager.stopAll();
  });

  it('starts a port-forward on an ephemeral local port when 0 or omitted', async () => {
    const session = await manager.startPortForward({
      contextName: 'minikube',
      namespace: 'default',
      podName: 'nginx-123',
      containerPort: 80,
    });

    expect(session.id).toMatch(/^pf-/);
    expect(session.contextName).toBe('minikube');
    expect(session.namespace).toBe('default');
    expect(session.podName).toBe('nginx-123');
    expect(session.containerPort).toBe(80);
    expect(session.localPort).toBeGreaterThan(0);
    expect(session.status).toBe('active');

    const activeList = manager.listActive();
    expect(activeList).toHaveLength(1);
    expect(activeList[0].id).toBe(session.id);
  });

  it('emits change events when tunnels start and stop', async () => {
    const changes: number[] = [];
    manager.on('change', (list) => {
      changes.push(list.length);
    });

    const session = await manager.startPortForward({
      contextName: 'minikube',
      namespace: 'default',
      podName: 'nginx-123',
      containerPort: 80,
    });

    expect(changes).toContain(1);

    const stopped = await manager.stopPortForward(session.id);
    expect(stopped).toBe(true);
    expect(manager.listActive()).toHaveLength(0);
    expect(changes).toContain(0);
  });

  it('returns false when stopping a non-existent session', async () => {
    const stopped = await manager.stopPortForward('non-existent-id');
    expect(stopped).toBe(false);
  });

  it('proxies incoming TCP connection to PortForward WebSocket', async () => {
    const session = await manager.startPortForward({
      contextName: 'minikube',
      namespace: 'default',
      podName: 'web-pod',
      containerPort: 8080,
    });

    // Connect to the local server
    await new Promise<void>((resolve, reject) => {
      const client = net.createConnection({ port: session.localPort, host: '127.0.0.1' }, () => {
        client.end();
        resolve();
      });
      client.on('error', reject);
    });

    expect(mockPortForwardFn).toHaveBeenCalledWith(
      'default',
      'web-pod',
      [8080],
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
  });

  it('stops all active tunnels cleanly', async () => {
    await manager.startPortForward({
      contextName: 'minikube',
      namespace: 'default',
      podName: 'pod-1',
      containerPort: 80,
    });

    await manager.startPortForward({
      contextName: 'minikube',
      namespace: 'default',
      podName: 'pod-2',
      containerPort: 81,
    });

    expect(manager.listActive()).toHaveLength(2);

    await manager.stopAll();

    expect(manager.listActive()).toHaveLength(0);
  });

  it('rejects privileged local ports (< 1024) with a descriptive error', async () => {
    await expect(
      manager.startPortForward({
        contextName: 'minikube',
        namespace: 'default',
        podName: 'nginx-123',
        containerPort: 80,
        localPort: 80,
      })
    ).rejects.toThrow(/privileged \(< 1024\)/);
  });

  it('automatically resolves replacement pod and connects when old pod returns 404', async () => {
    const listPodsMock = vi.fn().mockResolvedValue([
      {
        name: 'web-deploy-new-hash',
        namespace: 'default',
        phase: 'Running',
        creationTimestamp: '2026-10-16T15:00:00Z',
        containers: [{ name: 'web', image: 'nginx', ready: true, state: 'running', ports: [{ containerPort: 8080 }] }],
      },
    ]);

    manager.setDiscoveryService({ listPods: listPodsMock });

    mockPortForwardFn
      .mockRejectedValueOnce(new Error('Pod web-deploy-old-hash not found (404)'))
      .mockResolvedValueOnce(() => ({ close: vi.fn() }));

    const session = await manager.startPortForward({
      contextName: 'minikube',
      namespace: 'default',
      podName: 'web-deploy-old-hash',
      containerPort: 8080,
    });

    await new Promise<void>((resolve, reject) => {
      const client = net.createConnection({ port: session.localPort, host: '127.0.0.1' }, () => {
        client.end();
        resolve();
      });
      client.on('error', reject);
    });

    expect(listPodsMock).toHaveBeenCalledWith('minikube', 'default');
    expect(mockPortForwardFn).toHaveBeenLastCalledWith(
      'default',
      'web-deploy-new-hash',
      [8080],
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
    expect(manager.listActive()[0].podName).toBe('web-deploy-new-hash');
  });
});
