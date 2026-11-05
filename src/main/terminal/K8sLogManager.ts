import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { PassThrough } from 'node:stream';
import { loadK8sClient } from '../services/k8sClient';
import { loadKubeConfigForContext } from '../services/k8sKubeConfig';
import type { K8sTerminalTarget } from '../../shared/types/kubernetes';

export interface K8sLogOptions {
  /** Defaults to 200 so opening a busy container's logs doesn't dump its entire history. */
  tailLines?: number;
  timestamps?: boolean;
  previous?: boolean;
}

interface K8sLogSession {
  sessionId: string;
  output: PassThrough;
  controller?: AbortController;
  disposed: boolean;
}

export interface K8sLogManagerEvents {
  data: (event: { sessionId: string; data: string }) => void;
  end: (event: { sessionId: string }) => void;
}

/**
 * `@kubernetes/client-node`'s `Log.log()` pipes the fetch response body
 * (wrapped via `Readable.fromWeb`) into our output stream with a raw
 * `.pipe()` call, which does not forward source-stream errors to the
 * destination. When `AbortController.abort()` cancels that fetch, the
 * internal source stream — which we have no reference to and can't attach
 * an error listener to — emits an 'error' with zero listeners, which is a
 * fatal, *unhandleable* uncaught exception in Node (crashes the Electron
 * main process with its default error dialog). This is a real gotcha of
 * Node's `stream.pipe()` (`stream.pipeline()` doesn't have this problem,
 * but the library doesn't use it), reproduced independently of sshs3.
 * The only way to stop that crash from outside the library is a narrow,
 * time-boxed `uncaughtException` guard around the single `abort()` call.
 */
function abortWithoutCrashing(controller: AbortController): void {
  const swallowAbortTeardownError = () => {
    // Expected: the internal fetch stream's unforwarded abort error. Any
    // other exception in this window would also be swallowed, but the
    // window is a single macrotask wide specifically to minimize that risk.
  };
  process.once('uncaughtException', swallowAbortTeardownError);
  try {
    controller.abort();
  } finally {
    setTimeout(() => process.removeListener('uncaughtException', swallowAbortTeardownError), 50);
  }
}

/**
 * Follows a container's logs over the Kubernetes API's plain HTTP chunked
 * log endpoint (`k8s.Log`, distinct from the exec/attach WebSocket protocol
 * K8sTerminalManager uses) and forwards chunks through the same `data`
 * event shape as the other k8s managers so the renderer can pipe it into
 * a read-only xterm view.
 */
export class K8sLogManager extends EventEmitter {
  private sessions: Map<string, K8sLogSession> = new Map();
  private kubeConfigPath?: string;

  constructor(kubeConfigPath?: string) {
    super();
    this.kubeConfigPath = kubeConfigPath;
  }

  public async startFollow(target: K8sTerminalTarget, options?: K8sLogOptions): Promise<string> {
    const sessionId = `k8s-log-${crypto.randomUUID()}`;
    const output = new PassThrough();
    const session: K8sLogSession = { sessionId, output, disposed: false };

    // @kubernetes/client-node pipes the internal fetch response stream into output.
    // Attach an error listener directly to the source stream so HTTP/2 timeouts
    // (e.g. TypeError: terminated) and remote disconnects never become unhandled errors.
    output.on('pipe', (src) => {
      src.on('error', (err: Error) => {
        if (!session.disposed) {
          const isTerminated = err.message === 'terminated' || /terminated|abort|timeout/i.test(err.message);
          if (!isTerminated) {
            this.emit('data', { sessionId, data: `\r\n\x1b[33m[sshs3: log stream ended: ${err.message}]\x1b[0m\r\n` });
          }
          void this.finish(sessionId);
        }
      });
    });

    output.on('data', (chunk: Buffer) => {
      this.emit('data', { sessionId, data: chunk.toString('utf-8') });
    });
    output.on('end', () => void this.finish(sessionId));
    output.on('error', (err: Error) => {
      this.emit('data', { sessionId, data: `\r\n\x1b[31m[sshs3: log stream error: ${err.message}]\x1b[0m\r\n` });
    });

    const [kc, { Log }] = await Promise.all([
      loadKubeConfigForContext(target.contextName, this.kubeConfigPath),
      loadK8sClient(),
    ]);
    const log = new Log(kc);

    try {
      const controller = await log.log(target.namespace, target.podName, target.containerName, output, {
        follow: !options?.previous,
        tailLines: options?.tailLines ?? 200,
        timestamps: options?.timestamps ?? false,
        previous: options?.previous ?? false,
      });
      session.controller = controller;
    } catch (err: unknown) {
      output.removeAllListeners();
      if (options?.previous) {
        const anyErr = err as Record<string, unknown> | null;
        const msg = String(err);
        if (
          anyErr?.statusCode === 400 ||
          anyErr?.code === 400 ||
          /400|previous terminated container/i.test(msg)
        ) {
          throw new Error(
            `previous terminated container "${target.containerName}" in pod "${target.podName}" not found`,
            { cause: err }
          );
        }
      }
      throw err;
    }

    this.sessions.set(sessionId, session);
    return sessionId;
  }

  public stop(sessionId: string): void {
    void this.finish(sessionId);
  }

  public async stopAll(): Promise<void> {
    await Promise.all(Array.from(this.sessions.keys()).map((id) => this.finish(id)));
  }

  private async finish(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.disposed) return;
    session.disposed = true;

    // Stop consuming data first: this alone lets `.pipe()`'s internal
    // cleanup unhook from the source cleanly, before we risk the abort's
    // fire-and-forget teardown error (see abortWithoutCrashing above).
    session.output.destroy();
    if (session.controller) {
      abortWithoutCrashing(session.controller);
    }
    this.sessions.delete(sessionId);
    this.emit('end', { sessionId });
  }
}
