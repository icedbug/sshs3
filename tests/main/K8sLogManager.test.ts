import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import type { K8sTerminalTarget } from '../../src/shared/types/kubernetes';

const logMock = vi.fn();

interface CapturedLogCall {
  namespace: string;
  podName: string;
  containerName: string;
  output: PassThrough;
  options: { follow: boolean; tailLines?: number; timestamps?: boolean; previous?: boolean };
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
  class Log {
    log = logMock;
  }
  return { KubeConfig, Log };
});

import { K8sLogManager } from '../../src/main/terminal/K8sLogManager';

const TARGET: K8sTerminalTarget = {
  contextName: 'default',
  namespace: 'default',
  podName: 'nginx-1',
  containerName: 'nginx',
};

describe('K8sLogManager', () => {
  let calls: CapturedLogCall[];
  let controllers: AbortController[];

  beforeEach(() => {
    vi.clearAllMocks();
    calls = [];
    controllers = [];
    logMock.mockImplementation(
      async (
        namespace: string,
        podName: string,
        containerName: string,
        output: PassThrough,
        options: CapturedLogCall['options']
      ) => {
        calls.push({ namespace, podName, containerName, output, options });
        const controller = new AbortController();
        controllers.push(controller);
        return controller;
      }
    );
  });

  it('follows logs with the default tail and forwards chunks as data events', async () => {
    const manager = new K8sLogManager();
    const onData = vi.fn();
    manager.on('data', onData);

    const sessionId = await manager.startFollow(TARGET);

    expect(sessionId).toMatch(/^k8s-log-/);
    expect(calls[0]).toMatchObject({
      namespace: 'default',
      podName: 'nginx-1',
      containerName: 'nginx',
      options: { follow: true, tailLines: 200, timestamps: false, previous: false },
    });

    calls[0].output.write(Buffer.from('line one\n'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(onData).toHaveBeenCalledWith({ sessionId, data: 'line one\n' });
  });

  it('passes through custom tailLines/timestamps/previous options and disables follow for previous', async () => {
    const manager = new K8sLogManager();
    await manager.startFollow(TARGET, { tailLines: 50, timestamps: true, previous: true });
    expect(calls[0].options).toMatchObject({ follow: false, tailLines: 50, timestamps: true, previous: true });
  });

  it('translates HTTP 400 into descriptive previous container not found error', async () => {
    const manager = new K8sLogManager();
    logMock.mockRejectedValueOnce(new Error('HTTP-Code: 400\nMessage: Error occurred in log request'));
    await expect(manager.startFollow(TARGET, { previous: true })).rejects.toThrow(
      /previous terminated container "nginx" in pod "nginx-1" not found/
    );
  });

  it('emits end and stops accepting further stop() calls once the stream naturally ends', async () => {
    const manager = new K8sLogManager();
    const onEnd = vi.fn();
    manager.on('end', onEnd);

    const sessionId = await manager.startFollow(TARGET);
    calls[0].output.end();
    await new Promise((resolve) => setImmediate(resolve));

    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith({ sessionId });

    // A second, redundant stop() must not double-emit end.
    manager.stop(sessionId);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('stop() aborts the underlying request and emits end exactly once', async () => {
    const manager = new K8sLogManager();
    const onEnd = vi.fn();
    manager.on('end', onEnd);

    const sessionId = await manager.startFollow(TARGET);
    const abortSpy = vi.spyOn(controllers[0], 'abort');

    manager.stop(sessionId);

    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith({ sessionId });
  });

  it('stopAll() tears down every active follow session', async () => {
    const manager = new K8sLogManager();
    const idA = await manager.startFollow(TARGET);
    const idB = await manager.startFollow({ ...TARGET, podName: 'nginx-2' });

    await manager.stopAll();

    expect(controllers[0].signal.aborted).toBe(true);
    expect(controllers[1].signal.aborted).toBe(true);
    const onEnd = vi.fn();
    manager.on('end', onEnd);
    manager.stop(idA);
    manager.stop(idB);
    expect(onEnd).not.toHaveBeenCalled();
  });

  it('handles source stream errors (such as TypeError: terminated) gracefully without crashing', async () => {
    const manager = new K8sLogManager();
    const onEnd = vi.fn();
    manager.on('end', onEnd);

    const sessionId = await manager.startFollow(TARGET);

    // Simulate @kubernetes/client-node piping an internal stream that encounters an HTTP/2 timeout or disconnect
    const fakeSourceStream = new PassThrough();
    fakeSourceStream.pipe(calls[0].output);

    // Emit TypeError: terminated on the source stream
    fakeSourceStream.emit('error', new TypeError('terminated'));

    await new Promise((resolve) => setImmediate(resolve));
    expect(onEnd).toHaveBeenCalledWith({ sessionId });
  });
});
