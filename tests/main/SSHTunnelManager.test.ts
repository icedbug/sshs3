import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import net from 'node:net';
import { EventEmitter } from 'node:events';

let mockSpawnImpl: any = null;

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: any[]) => {
      if (mockSpawnImpl) {
        return mockSpawnImpl(...args);
      }
      return (actual.spawn as any)(...args);
    },
  };
});

// Mock AskpassServer to avoid opening actual listening servers
vi.mock('../../src/main/smartcard/AskpassServer', () => {
  class MockAskpassServer {
    static instances: MockAskpassServer[] = [];
    constructor() {
      MockAskpassServer.instances.push(this);
    }
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    getEnv = vi.fn().mockReturnValue({ SSH_ASKPASS: '/mock/askpass', DISPLAY: ':99' });
  }
  return {
    AskpassServer: MockAskpassServer,
  };
});

import { AskpassServer } from '../../src/main/smartcard/AskpassServer';
import { SSHTunnelManager } from '../../src/main/services/SSHTunnelManager';
import type { SSHConnectionConfig, SSHTunnelConfig } from '../../src/shared/types/ssh';

function createMockChildProcess(pid = 12345) {
  const child = new EventEmitter() as any;
  child.pid = pid;
  child.exitCode = null;
  child.stderr = new EventEmitter();
  child.kill = vi.fn().mockImplementation((signal?: string) => {
    if (signal === 'SIGTERM' || signal === 'SIGKILL') {
      child.exitCode = 0;
      setTimeout(() => child.emit('exit', 0, null), 10);
    }
    return true;
  });
  return child;
}

describe('SSHTunnelManager', () => {
  let manager: SSHTunnelManager;

  const mockConfig: SSHConnectionConfig = {
    id: 'conn-1',
    name: 'Production Server',
    host: 'prod.example.com',
    port: 22,
    username: 'admin',
    authType: 'password',
    password: 'secretpassword', // pragma: allowlist secret
  };

  const mockTunnel: SSHTunnelConfig = {
    id: 'tun-cfg-1',
    name: 'Database Forward',
    type: 'local',
    localPort: 5432,
    remoteHost: '127.0.0.1',
    remotePort: 5432,
    enabled: true,
  };

  beforeEach(() => {
    mockSpawnImpl = null;
    vi.restoreAllMocks();
    manager = new SSHTunnelManager();
  });

  afterEach(async () => {
    await manager.stopAll();
    vi.restoreAllMocks();
  });

  describe('isPortFree', () => {
    it('returns true when a port is currently unused', async () => {
      // Find a free port by listening on 0 then closing
      const s = net.createServer();
      await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
      const freePort = (s.address() as net.AddressInfo).port;
      await new Promise<void>((resolve) => s.close(() => resolve()));

      const isFree = await manager.isPortFree(freePort);
      expect(isFree).toBe(true);
    });

    it('returns false when a port is already bound by another process', async () => {
      const s = net.createServer();
      await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
      const boundPort = (s.address() as net.AddressInfo).port;

      const isFree = await manager.isPortFree(boundPort);
      expect(isFree).toBe(false);

      await new Promise<void>((resolve) => s.close(() => resolve()));
    });
  });

  describe('startTunnel', () => {
    it('throws error when privileged port (< 1024) is requested by non-root', async () => {
      const privilegedTunnel: SSHTunnelConfig = {
        ...mockTunnel,
        localPort: 80,
      };

      const origGetuid = process.getuid;
      try {
        process.getuid = () => 1000; // non-root uid
        await expect(manager.startTunnel(mockConfig, privilegedTunnel)).rejects.toThrow(
          'Port 80 is privileged (< 1024) and requires root/administrator privileges'
        );
      } finally {
        process.getuid = origGetuid;
      }
    });

    it('successfully starts a tunnel and emits change event', async () => {
      const mockChild = createMockChildProcess();
      mockSpawnImpl = vi.fn().mockReturnValue(mockChild);

      const changeEvents: any[] = [];
      manager.on('change', (list) => changeEvents.push(list));

      const activeTunnel = await manager.startTunnel(mockConfig, mockTunnel);

      expect(activeTunnel).toBeDefined();
      expect(activeTunnel.connectionId).toBe(mockConfig.id);
      expect(activeTunnel.tunnel.localPort).toBe(5432);
      expect(activeTunnel.status).toBe('active');
      expect(activeTunnel.pid).toBe(mockChild.pid);

      expect(changeEvents.length).toBeGreaterThan(0);
      expect(manager.listActive()).toHaveLength(1);
    });

    it('throws error and cleans up session if ssh process fails immediately on startup', async () => {
      const mockChild = createMockChildProcess();
      mockSpawnImpl = vi.fn().mockImplementation(() => {
        setTimeout(() => {
          mockChild.stderr.emit('data', Buffer.from('bind: Address already in use\n'));
          mockChild.emit('exit', 255, null);
        }, 50);
        return mockChild;
      });

      await expect(manager.startTunnel(mockConfig, mockTunnel)).rejects.toThrow(
        'bind: Address already in use'
      );

      expect(manager.listActive()).toHaveLength(0);
    });

    it('handles unexpected exit of active tunnel after startup', async () => {
      const mockChild = createMockChildProcess();
      mockSpawnImpl = vi.fn().mockReturnValue(mockChild);

      const active = await manager.startTunnel(mockConfig, mockTunnel);
      expect(active.status).toBe('active');

      const changePromise = new Promise<void>((resolve) => {
        manager.once('change', () => resolve());
      });

      // Simulate child crash
      mockChild.stderr.emit('data', Buffer.from('Connection reset by peer\n'));
      mockChild.emit('exit', 1, null);

      await changePromise;

      const current = manager.listActive().find((t) => t.id === active.id);
      expect(current).toBeDefined();
      expect(current?.status).toBe('error');
      expect(current?.error).toContain('Connection reset by peer');
    });

    it('handles signal termination of active tunnel', async () => {
      const mockChild = createMockChildProcess();
      mockSpawnImpl = vi.fn().mockReturnValue(mockChild);

      const active = await manager.startTunnel(mockConfig, mockTunnel);

      const changePromise = new Promise<void>((resolve) => {
        manager.once('change', () => resolve());
      });

      mockChild.emit('exit', null, 'SIGTERM');
      await changePromise;

      const current = manager.listActive().find((t) => t.id === active.id);
      expect(current?.status).toBe('error');
      expect(current?.error).toBe('Terminated (SIGTERM)');
    });

    it('stops the askpass server it started when ssh cannot be launched', async () => {
      const servers = (AskpassServer as unknown as { instances: Array<{ stop: ReturnType<typeof vi.fn> }> }).instances;
      servers.length = 0;
      mockSpawnImpl = vi.fn().mockImplementation(() => {
        throw new Error('spawn failed');
      });

      await expect(manager.startTunnel(mockConfig, mockTunnel)).rejects.toThrow('spawn failed');

      expect(servers).toHaveLength(1);
      expect(servers[0].stop).toHaveBeenCalledTimes(1);
      expect(manager.listActive()).toHaveLength(0);
    });

    it('reports an ssh that cannot be started (ENOENT arrives as an error event) and stops the askpass server', async () => {
      const servers = (AskpassServer as unknown as { instances: Array<{ stop: ReturnType<typeof vi.fn> }> }).instances;
      servers.length = 0;
      const missing = createMockChildProcess();
      mockSpawnImpl = vi.fn().mockImplementation(() => {
        // spawn() returns a child and reports the failure asynchronously; there is no 'exit'.
        setTimeout(() => missing.emit('error', Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT' })), 5);
        return missing;
      });

      await expect(manager.startTunnel(mockConfig, mockTunnel)).rejects.toThrow(/ENOENT/);

      expect(servers[0].stop).toHaveBeenCalledTimes(1);
      expect(manager.listActive()).toHaveLength(0);
    });

    it('uses promptHandler if password and passphrase are not set on config', async () => {
      const configWithAskpass: SSHConnectionConfig = {
        ...mockConfig,
        authType: 'fido2',
        password: undefined,
        passphrase: undefined,
      };

      const mockChild = createMockChildProcess();
      mockSpawnImpl = vi.fn().mockReturnValue(mockChild);

      const promptHandler = vi.fn().mockResolvedValue('user-pin');
      const active = await manager.startTunnel(configWithAskpass, mockTunnel, promptHandler);

      expect(active.status).toBe('active');
    });

    it('sets SSH_AUTH_SOCK when agentPath is provided on config', async () => {
      const configWithAgent: SSHConnectionConfig = {
        ...mockConfig,
        agentPath: '/custom/agent.sock',
      };

      let capturedEnv: any = null;
      mockSpawnImpl = vi.fn().mockImplementation((_bin: string, _args: string[], options: any) => {
        capturedEnv = options.env;
        return createMockChildProcess();
      });

      await manager.startTunnel(configWithAgent, mockTunnel);
      expect(capturedEnv.SSH_AUTH_SOCK).toBe('/custom/agent.sock');
    });
  });

  describe('stopTunnel and stopAll', () => {
    it('returns false when stopping a non-existent tunnel id', async () => {
      const result = await manager.stopTunnel('non-existent-id');
      expect(result).toBe(false);
    });

    it('stops an active tunnel by killing the child process with SIGTERM', async () => {
      const mockChild = createMockChildProcess();
      mockSpawnImpl = vi.fn().mockReturnValue(mockChild);

      const active = await manager.startTunnel(mockConfig, mockTunnel);
      expect(manager.listActive()).toHaveLength(1);

      const stopped = await manager.stopTunnel(active.id);
      expect(stopped).toBe(true);
      expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');
      expect(manager.listActive()).toHaveLength(0);
    });

    it('stops all active tunnels on stopAll()', async () => {
      const mockChild1 = createMockChildProcess(101);
      const mockChild2 = createMockChildProcess(102);

      let count = 0;
      mockSpawnImpl = vi.fn().mockImplementation(() => {
        count++;
        return count === 1 ? mockChild1 : mockChild2;
      });

      await manager.startTunnel(mockConfig, { ...mockTunnel, id: 't1', localPort: 6001 });
      await manager.startTunnel(mockConfig, { ...mockTunnel, id: 't2', localPort: 6002 });
      expect(manager.listActive()).toHaveLength(2);

      await manager.stopAll();
      expect(manager.listActive()).toHaveLength(0);
    });

    it('executes killAllSync on process exit handler', async () => {
      const mockChild = createMockChildProcess(999);
      mockSpawnImpl = vi.fn().mockReturnValue(mockChild);

      await manager.startTunnel(mockConfig, mockTunnel);

      // Trigger the internal killAllSync
      (manager as any).killAllSync();
      expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');
    });
  });
});
