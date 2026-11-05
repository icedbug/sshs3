import { describe, it, expect, vi } from 'vitest';
import { registerTerminalHandlers, type TerminalHost } from '../../src/main/ipc/terminalHandlers';
import { ScrollbackBuffer } from '../../src/main/terminal/ScrollbackBuffer';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';

type Handler = (event: unknown, ...args: unknown[]) => Promise<any>;

function setup(sessions: { ssh?: string[]; k8s?: string[] } = {}) {
  const handlers = new Map<string, Handler>();
  const scrollback = new ScrollbackBuffer();
  scrollback.append('s1', 'hello\r\n');
  const assignSession = vi.fn();
  const host = {
    registerHandler: (channel: string, handler: Handler) => handlers.set(channel, handler),
    assignSession,
    scrollback,
    sshPtyManager: { getSession: (id: string) => (sessions.ssh ?? ['s1']).includes(id) },
    k8sTerminalManager: { getSession: (id: string) => (sessions.k8s ?? []).includes(id) },
  } as unknown as TerminalHost;
  registerTerminalHandlers(host);
  return { attach: handlers.get(IPC_CHANNELS.TERMINAL_ATTACH)!, assignSession };
}

describe('TERMINAL_ATTACH', () => {
  it('claims the session for the calling window and returns the output so far', async () => {
    const { attach, assignSession } = setup();
    const sender = { id: 2 };
    await expect(attach({ sender }, 's1', 'ssh')).resolves.toEqual({ scrollback: 'hello\r\n' });
    expect(assignSession).toHaveBeenCalledWith(sender, 's1');
  });

  it('attaches Kubernetes sessions through their own manager', async () => {
    const { attach } = setup({ k8s: ['k1'] });
    await expect(attach({ sender: {} }, 'k1', 'k8s')).resolves.toEqual({ scrollback: '' });
    await expect(attach({ sender: {} }, 'k1', 'ssh')).rejects.toThrow(/ended/);
  });

  it('refuses a session that has ended and malformed arguments, without claiming anything', async () => {
    const { attach, assignSession } = setup();
    await expect(attach({ sender: {} }, 'gone', 'ssh')).rejects.toThrow(/ended/);
    await expect(attach({ sender: {} }, 5, 'ssh')).rejects.toThrow(/Invalid/);
    await expect(attach({ sender: {} }, 's1', 'other')).rejects.toThrow(/Invalid/);
    expect(assignSession).not.toHaveBeenCalled();
  });
});
