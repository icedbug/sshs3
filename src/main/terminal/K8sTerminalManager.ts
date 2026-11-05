import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { PassThrough } from 'node:stream';
import type * as k8s from '@kubernetes/client-node';
import { loadK8sClient } from '../services/k8sClient';
import { loadKubeConfigForContext } from '../services/k8sKubeConfig';
import type { K8sTerminalExitEvent, K8sTerminalTarget } from '../../shared/types/kubernetes';
import { StringDecoder } from 'node:string_decoder';

type ExecConnection = Awaited<ReturnType<k8s.Exec['exec']>>;

/**
 * A PassThrough that also looks like a TTY (rows/columns + a 'resize' event),
 * which is exactly what `@kubernetes/client-node`'s `isResizable()` check
 * looks for before it multiplexes a resize channel over the exec WebSocket.
 * Used as both the combined stdout/stderr sink (tty mode merges them).
 */
class ResizableOutputStream extends PassThrough {
  public rows: number;
  public columns: number;

  constructor(rows: number, columns: number) {
    super();
    this.rows = rows;
    this.columns = columns;
  }

  public setSize(rows: number, columns: number): void {
    this.rows = rows;
    this.columns = columns;
    this.emit('resize');
  }
}

interface K8sTerminalSession {
  sessionId: string;
  target: K8sTerminalTarget;
  output: ResizableOutputStream;
  stdin: PassThrough;
  conn?: ExecConnection;
  disposed: boolean;
}

export interface K8sTerminalManagerEvents {
  data: (event: { sessionId: string; data: string }) => void;
  exit: (event: K8sTerminalExitEvent) => void;
}

/**
 * Runs interactive `exec` sessions inside Kubernetes/OpenShift containers
 * over the client-go-compatible WebSocket protocol, and forwards output
 * through the same `data`/`exit` event shape as SSHPtyManager so the
 * renderer's xterm view can treat a k8s exec session like any other pane.
 */
export class K8sTerminalManager extends EventEmitter {
  private sessions: Map<string, K8sTerminalSession> = new Map();
  private kubeConfigPath?: string;

  constructor(kubeConfigPath?: string) {
    super();
    this.kubeConfigPath = kubeConfigPath;
  }

  /**
   * Opens an interactive exec session (tty=true) into the target container
   * and returns its session id once the WebSocket is established.
   */
  public async createSession(
    target: K8sTerminalTarget,
    options?: { cols?: number; rows?: number }
  ): Promise<string> {
    const sessionId = `k8s-${crypto.randomUUID()}`;
    const cols = options?.cols ?? 80;
    const rows = options?.rows ?? 24;

    const output = new ResizableOutputStream(rows, cols);
    const stdin = new PassThrough();
    output.on('error', () => {});
    stdin.on('error', () => {});
    const session: K8sTerminalSession = { sessionId, target, output, stdin, disposed: false };

    // A multi-byte character can be split across two chunks; the decoder holds back the incomplete bytes.
    const decoder = new StringDecoder('utf8');
    output.on('data', (chunk: Buffer) => {
      const data = decoder.write(chunk);
      if (data) this.emit('data', { sessionId, data });
    });

    const [kc, { Exec }] = await Promise.all([
      loadKubeConfigForContext(target.contextName, this.kubeConfigPath),
      loadK8sClient(),
    ]);
    const exec = new Exec(kc);
    const shell = target.shell || '/bin/sh';

    let conn: ExecConnection;
    try {
      conn = await exec.exec(
        target.namespace,
        target.podName,
        target.containerName,
        [shell],
        output,
        output,
        stdin,
        true,
        (status) => {
          void this.finish(sessionId, status.status || 'Unknown');
        }
      );
    } catch (err) {
      output.removeAllListeners();
      throw err;
    }

    session.conn = conn;
    conn.on('close', () => void this.finish(sessionId, 'Success'));
    conn.on('error', (err: Error) => {
      this.emit('data', { sessionId, data: `\r\n\x1b[31m[sshs3: k8s exec error: ${err.message}]\x1b[0m\r\n` });
    });

    this.sessions.set(sessionId, session);
    return sessionId;
  }

  public write(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (session && !session.disposed) {
      session.stdin.write(data);
    }
  }

  public resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId);
    if (session && !session.disposed) {
      session.output.setSize(rows, cols);
    }
  }

  public kill(sessionId: string): void {
    void this.finish(sessionId, 'Cancelled');
  }

  public async killAll(): Promise<void> {
    await Promise.all(Array.from(this.sessions.keys()).map((id) => this.finish(id, 'Cancelled')));
  }

  public getSession(sessionId: string): K8sTerminalSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** Tears a session down exactly once and emits the `exit` event for it. */
  private async finish(sessionId: string, status: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.disposed) return;
    session.disposed = true;

    this.emit('exit', { sessionId, status });

    try {
      session.conn?.close();
    } catch {
      // Already closed
    }
    session.stdin.end();
    session.output.end();
    this.sessions.delete(sessionId);
  }
}
