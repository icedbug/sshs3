import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IPty, IDisposable } from 'node-pty';
import { SSHPtyManager } from '../../src/main/ssh/SSHPtyManager';
import { AgentLifecycleManager } from '../../src/main/ssh/AgentLifecycleManager';
import type { SSHConnectionConfig } from '../../src/shared/types/ssh';

// createShellSession() calls AgentLifecycleManager.ensureAgent() to inject
// SSH_AUTH_SOCK; mocked so unit tests never spawn a real ssh-agent process
// (non-hermetic, and would leak a process in CI where none is running).
vi.mock('../../src/main/ssh/AgentLifecycleManager', () => ({
  AgentLifecycleManager: {
    ensureAgent: vi.fn().mockResolvedValue({ isRunning: false, isManaged: false, platform: process.platform }),
  },
}));

// Mock node-pty
const mockPtyInstances: MockPty[] = [];

class MockPty implements Partial<IPty> {
  pid = 12345;
  cols = 80;
  rows = 24;
  process = 'ssh';
  handleFlowControl = false;

  private dataListeners: ((data: string) => void)[] = [];
  private exitListeners: ((event: { exitCode: number; signal?: number }) => void)[] = [];

  write = vi.fn();
  resize = vi.fn((cols: number, rows: number) => {
    this.cols = cols;
    this.rows = rows;
  });
  kill = vi.fn((signal?: string) => {
    this.emitExit(0, signal ? 15 : undefined);
  });
  clear = vi.fn();
  pause = vi.fn();
  resume = vi.fn();

  onData = vi.fn((listener: (data: string) => void): IDisposable => {
    this.dataListeners.push(listener);
    return {
      dispose: () => {
        const index = this.dataListeners.indexOf(listener);
        if (index >= 0) this.dataListeners.splice(index, 1);
      },
    };
  });

  onExit = vi.fn(
    (listener: (event: { exitCode: number; signal?: number }) => void): IDisposable => {
      this.exitListeners.push(listener);
      return {
        dispose: () => {
          const index = this.exitListeners.indexOf(listener);
          if (index >= 0) this.exitListeners.splice(index, 1);
        },
      };
    }
  );

  emitData(data: string) {
    for (const listener of [...this.dataListeners]) {
      listener(data);
    }
  }

  emitExit(exitCode: number, signal?: number) {
    for (const listener of [...this.exitListeners]) {
      listener({ exitCode, signal });
    }
  }
}

vi.mock('node-pty', () => {
  const spawn = vi.fn((file: string, args: string[] | string, options: any) => {
    const mock = new MockPty();
    (mock as any)._spawnArgs = { file, args, options };
    mockPtyInstances.push(mock);
    return mock as unknown as IPty;
  });

  return {
    default: { spawn },
    spawn,
  };
});

describe('SSHPtyManager', () => {
  let manager: SSHPtyManager;

  beforeEach(() => {
    mockPtyInstances.length = 0;
    manager = new SSHPtyManager();
    vi.mocked(AgentLifecycleManager.ensureAgent).mockResolvedValue({
      isRunning: false,
      isManaged: false,
      platform: process.platform,
    });
  });

  afterEach(async () => {
    await manager.killAll();
  });

  const cfg = (id: string): SSHConnectionConfig => ({
    id, name: 'Reconnect', host: 'host.local', username: 'tester', authType: 'password', // pragma: allowlist secret
    autoReconnect: true, maxReconnectAttempts: 3, reconnectDelayMs: 50,
  } as SSHConnectionConfig);

  // Code review: closing a terminal tab killed ssh (exit 255 / a signal), which looked like a dropped connection,
  // so a profile with autoReconnect started a new, hidden ssh session for the closed tab.
  it('does not reconnect a session the user killed (signal exit)', async () => {
    vi.useFakeTimers();
    try {
      const session = await manager.createSession(cfg('sess-kill-signal'));
      const reconnecting = vi.fn();
      const exited = vi.fn();
      manager.on('reconnecting', reconnecting);
      manager.on('exit', exited);

      session.kill('SIGHUP');
      await vi.advanceTimersByTimeAsync(500);

      expect(reconnecting).not.toHaveBeenCalled();
      expect(mockPtyInstances).toHaveLength(1);
      expect(exited).toHaveBeenCalledTimes(1);
      expect(manager.getSession('sess-kill-signal')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not reconnect when ssh exits with 255 after a kill (exit arrives later)', async () => {
    vi.useFakeTimers();
    try {
      const session = await manager.createSession(cfg('sess-kill-255'));
      const pty = mockPtyInstances[0];
      pty.kill.mockImplementation(() => {}); // real node-pty reports the exit asynchronously
      const reconnecting = vi.fn();
      manager.on('reconnecting', reconnecting);

      session.kill();
      pty.emitExit(255, 0);
      await vi.advanceTimersByTimeAsync(500);

      expect(reconnecting).not.toHaveBeenCalled();
      expect(mockPtyInstances).toHaveLength(1);
      expect(manager.getSession('sess-kill-255')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('kill during a pending reconnect cancels it and ends the session', async () => {
    vi.useFakeTimers();
    try {
      const session = await manager.createSession(cfg('sess-kill-pending'));
      const exited = vi.fn();
      manager.on('exit', exited);

      mockPtyInstances[0].emitExit(255, 0); // a real drop: reconnect is scheduled
      expect(session.isReconnecting?.()).toBe(true);

      session.kill();
      await vi.advanceTimersByTimeAsync(500);

      expect(mockPtyInstances).toHaveLength(1);
      expect(exited).toHaveBeenCalledTimes(1);
      expect(manager.getSession('sess-kill-pending')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
