import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { K8sTerminalTarget } from '../../src/shared/types/kubernetes';

const execMock = vi.fn();

interface CapturedExecCall {
  namespace: string;
  podName: string;
  containerName: string;
  command: string[];
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  tty: boolean;
  statusCallback: (status: { status: string }) => void;
}

class FakeConnection extends EventEmitter {
  close = vi.fn();
}

vi.mock('@kubernetes/client-node', () => {
  class KubeConfig {
    loadFromFile = vi.fn();
    loadFromDefault = vi.fn();
    loadFromOptions = vi.fn();
    getContexts = vi.fn(() => []);
    getClusters = vi.fn(() => []);
    getUsers = vi.fn(() => []);
  }
  class Exec {
    exec = execMock;
  }
  return { KubeConfig, Exec };
});

import { K8sTerminalManager } from '../../src/main/terminal/K8sTerminalManager';

const TARGET: K8sTerminalTarget = {
  contextName: 'default',
  namespace: 'default',
  podName: 'nginx-1',
  containerName: 'nginx',
};

describe('K8sTerminalManager', () => {
  let calls: CapturedExecCall[];
  let connections: FakeConnection[];

  beforeEach(() => {
    vi.clearAllMocks();
    calls = [];
    connections = [];
    execMock.mockImplementation(
      async (
        namespace: string,
        podName: string,
        containerName: string,
        command: string[],
        stdout: PassThrough,
        stderr: PassThrough,
        stdin: PassThrough,
        tty: boolean,
        statusCallback: (status: { status: string }) => void
      ) => {
        calls.push({ namespace, podName, containerName, command, stdout, stderr, stdin, tty, statusCallback });
        const conn = new FakeConnection();
        connections.push(conn);
        return conn;
      }
    );
  });

  it('opens a tty exec session with the default shell and correct target', async () => {
    const manager = new K8sTerminalManager();
    const sessionId = await manager.createSession(TARGET);

    expect(sessionId).toMatch(/^k8s-/);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      namespace: 'default',
      podName: 'nginx-1',
      containerName: 'nginx',
      command: ['/bin/sh'],
      tty: true,
    });
  });

  it('uses a custom shell when provided on the target', async () => {
    const manager = new K8sTerminalManager();
    await manager.createSession({ ...TARGET, shell: '/bin/bash' });
    expect(calls[0].command).toEqual(['/bin/bash']);
  });

  it('forwards container output as data events keyed by session id', async () => {
    const manager = new K8sTerminalManager();
    const sessionId = await manager.createSession(TARGET);
    const onData = vi.fn();
    manager.on('data', onData);

    calls[0].stdout.write(Buffer.from('hello\r\n'));
    await new Promise((resolve) => setImmediate(resolve));

    expect(onData).toHaveBeenCalledWith({ sessionId, data: 'hello\r\n' });
  });

  // Low finding (code review 2026-11-03): each chunk was decoded on its own, so a character split across two
  // chunks (any multi-byte UTF-8 character) came out as replacement characters.
  it('keeps a multi-byte character that arrives split across two chunks intact', async () => {
    const manager = new K8sTerminalManager();
    await manager.createSession(TARGET);
    const received: string[] = [];
    manager.on('data', (e: { data: string }) => received.push(e.data));

    const euro = Buffer.from('€'); // 3 bytes
    calls[0].stdout.write(euro.subarray(0, 2));
    await new Promise((resolve) => setImmediate(resolve));
    calls[0].stdout.write(Buffer.concat([euro.subarray(2), Buffer.from('\r\n')]));
    await new Promise((resolve) => setImmediate(resolve));

    expect(received.join('')).toBe('€\r\n');
  });

  it('writes terminal input into the session stdin stream', async () => {
    const manager = new K8sTerminalManager();
    const sessionId = await manager.createSession(TARGET);
    const writeSpy = vi.spyOn(calls[0].stdin, 'write');

    manager.write(sessionId, 'ls -la\n');

    expect(writeSpy).toHaveBeenCalledWith('ls -la\n');
  });

  it('silently ignores writes to an unknown session id', async () => {
    const manager = new K8sTerminalManager();
    expect(() => manager.write('nonexistent', 'x')).not.toThrow();
  });

  it('propagates resize onto the resizable output stream', async () => {
    const manager = new K8sTerminalManager();
    const sessionId = await manager.createSession(TARGET, { cols: 80, rows: 24 });

    manager.resize(sessionId, 120, 40);

    expect((calls[0].stdout as any).columns).toBe(120);
    expect((calls[0].stdout as any).rows).toBe(40);
  });

  it('emits exit with the status from the exec status callback and removes the session', async () => {
    const manager = new K8sTerminalManager();
    const sessionId = await manager.createSession(TARGET);
    const onExit = vi.fn();
    manager.on('exit', onExit);

    calls[0].statusCallback({ status: 'Failure' });

    expect(onExit).toHaveBeenCalledWith({ sessionId, status: 'Failure' });
    // A write after exit should be a no-op, not throw.
    expect(() => manager.write(sessionId, 'x')).not.toThrow();
  });

  it('kill() closes the connection and emits a Cancelled exit exactly once', async () => {
    const manager = new K8sTerminalManager();
    const sessionId = await manager.createSession(TARGET);
    const onExit = vi.fn();
    manager.on('exit', onExit);

    manager.kill(sessionId);
    // The underlying WebSocket firing 'close' after our own close() call
    // must not double-emit exit.
    connections[0].emit('close');

    expect(connections[0].close).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith({ sessionId, status: 'Cancelled' });
  });

  it('killAll() tears down every open session', async () => {
    const manager = new K8sTerminalManager();
    const idA = await manager.createSession(TARGET);
    const idB = await manager.createSession({ ...TARGET, podName: 'nginx-2' });

    await manager.killAll();

    expect(manager.getSession(idA)).toBeUndefined();
    expect(manager.getSession(idB)).toBeUndefined();
    expect(connections[0].close).toHaveBeenCalled();
    expect(connections[1].close).toHaveBeenCalled();
  });
});
