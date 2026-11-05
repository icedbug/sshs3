import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import net from 'node:net';
import stream from 'node:stream';
import { loadK8sClient } from './k8sClient';
import { loadKubeConfigForContext } from './k8sKubeConfig';
import { isPodNotFoundError, findReplacementPod, extractErrorMessage } from '../../shared/k8sPodHelpers';
import type {
  K8sPortForwardTarget,
  K8sActivePortForward,
  K8sPodNode,
} from '../../shared/types/kubernetes';
import { createLogger } from '../log';
const k8sportforwardLog = createLogger('K8sPortForward');

export interface K8sPortForwardDiscovery {
  listPods(contextName: string, namespace: string): Promise<K8sPodNode[]>;
}

interface ActiveSession {
  id: string;
  target: K8sPortForwardTarget;
  server: net.Server;
  localPort: number;
  activeSockets: Set<net.Socket>;
  startedAt: string;
  error?: string;
}

/**
 * Manages local TCP servers that proxy traffic to Kubernetes Pod ports
 * using `@kubernetes/client-node`'s PortForward protocol over WebSockets.
 */
export class K8sPortForwardManager extends EventEmitter {
  private sessions: Map<string, ActiveSession> = new Map();
  private kubeConfigPath?: string;
  private discoveryService?: K8sPortForwardDiscovery;

  constructor(kubeConfigPath?: string, discoveryService?: K8sPortForwardDiscovery) {
    super();
    this.kubeConfigPath = kubeConfigPath;
    this.discoveryService = discoveryService;
  }

  public setDiscoveryService(discoveryService: K8sPortForwardDiscovery): void {
    this.discoveryService = discoveryService;
  }

  /**
   * Attempts to discover a newly created replacement pod for the given port-forward session
   * when the previous pod terminated or was replaced by a controller (e.g. Deployment rollout).
   */
  public async tryResolveReplacement(id: string, maxAttempts = 6, delayMs = 500): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session || !this.discoveryService) return false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const pods = await this.discoveryService.listPods(
          session.target.contextName,
          session.target.namespace
        );
        const replacement = findReplacementPod(
          session.target.podName,
          session.target.containerPort,
          pods
        );
        if (replacement && replacement.name && replacement.name !== session.target.podName) {
          k8sportforwardLog.info(
            `Port-forward ${id}: Pod ${session.target.podName} replaced by ${replacement.name}; re-targeting port-forward`
          );
          session.target.podName = replacement.name;
          session.error = undefined;
          this.emitChange();
          return true;
        }
      } catch (err) {
        k8sportforwardLog.warn(`Port-forward ${id}: Failed to resolve replacement pod (attempt ${attempt}):`, err);
      }

      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return false;
  }

  /**
   * Reconnects an existing port-forward tunnel by clearing any error state and
   * searching for replacement pods.
   */
  public async reconnect(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.error = undefined;
    this.emitChange();
    if (this.discoveryService) {
      await this.tryResolveReplacement(id, 4, 300);
    }
    return true;
  }

  /**
   * Starts a local TCP listener forwarding traffic to the target pod's containerPort.
   * If target.localPort is omitted or 0, an available random port is assigned by the OS.
   */
  public async startPortForward(target: K8sPortForwardTarget): Promise<K8sActivePortForward> {
    if (target.localPort && target.localPort > 0 && target.localPort < 1024) {
      throw new Error(
        `Local port ${target.localPort} is privileged (< 1024) and requires root/administrator privileges. Please choose a port >= 1024 or 0 for auto-assign.`
      );
    }

    const id = `pf-${crypto.randomUUID()}`;
    const [kc, { PortForward }] = await Promise.all([
      loadKubeConfigForContext(target.contextName, this.kubeConfigPath),
      loadK8sClient(),
    ]);

    const pf = new PortForward(kc);
    const activeSockets = new Set<net.Socket>();

    const server = net.createServer((socket) => {
      activeSockets.add(socket);
      this.emitChange();

      // Pause socket immediately so incoming HTTP request data is buffered
      // and NOT lost while the WebSocket handshake completes.
      socket.pause();

      let closed = false;
      const cleanup = () => {
        if (!closed) {
          closed = true;
          activeSockets.delete(socket);
          this.emitChange();
        }
      };

      socket.on('close', cleanup);
      socket.on('error', () => cleanup());

      const errStream = new stream.PassThrough();
      errStream.on('error', () => cleanup());
      errStream.on('data', async (errChunk) => {
        const msg = errChunk.toString().trim();
        const currentSession = this.sessions.get(id);
        const currentPodName = currentSession?.target.podName || target.podName;
        k8sportforwardLog.warn(`Pod ${currentPodName}:${target.containerPort} error:`, msg);
        if (currentSession) {
          currentSession.error = msg;
          this.emitChange();
        }
        if (isPodNotFoundError(msg)) {
          void this.tryResolveReplacement(id, 8, 1000);
        }
        cleanup();
        socket.destroy(new Error(msg));
      });

      const attemptForward = async (attemptResolve = true): Promise<void> => {
        const currentSession = this.sessions.get(id);
        const currentPodName = currentSession?.target.podName || target.podName;
        const currentPort = currentSession?.target.containerPort || target.containerPort;

        try {
          const ws = await pf.portForward(
            target.namespace,
            currentPodName,
            [currentPort],
            socket,
            errStream,
            socket
          );

          if (closed) {
            try {
              if (typeof ws === 'function') (ws as any)()?.close();
              else if (ws && typeof (ws as any).close === 'function') (ws as any).close();
            } catch {
              // Ignore teardown error on closed socket
            }
            return;
          }

          if (currentSession?.error) {
            currentSession.error = undefined;
            this.emitChange();
          }

          socket.resume();

          socket.on('close', () => {
            try {
              if (typeof ws === 'function') {
                const sock = (ws as any)();
                sock?.close();
              } else if (ws && typeof (ws as any).close === 'function') {
                (ws as any).close();
              }
            } catch {
              // Ignore teardown error on closed socket
            }
          });
        } catch (err) {
          if (attemptResolve && isPodNotFoundError(err)) {
            const resolved = await this.tryResolveReplacement(id, 3, 400);
            if (resolved) {
              return await attemptForward(false);
            }
          }
          const errMsg = extractErrorMessage(err);
          if (currentSession) {
            currentSession.error = errMsg;
            this.emitChange();
          }
          cleanup();
          socket.destroy(err instanceof Error ? err : new Error(errMsg));

          if (isPodNotFoundError(err)) {
            void this.tryResolveReplacement(id, 8, 1000);
          }
        }
      };

      attemptForward();
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(target.localPort || 0, '127.0.0.1', () => {
        resolve();
      });
      server.once('error', reject);
    });

    const address = server.address() as net.AddressInfo;
    const assignedPort = address.port;
    const startedAt = new Date().toISOString();

    const session: ActiveSession = {
      id,
      target: { ...target, localPort: assignedPort },
      server,
      localPort: assignedPort,
      activeSockets,
      startedAt,
    };

    this.sessions.set(id, session);
    this.emitChange();

    return {
      id,
      contextName: target.contextName,
      namespace: target.namespace,
      podName: target.podName,
      containerPort: target.containerPort,
      localPort: assignedPort,
      activeConnections: 0,
      startedAt,
      status: 'active',
    };
  }

  /**
   * Stops an active port-forward tunnel and terminates its active client sockets.
   */
  public async stopPortForward(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;

    this.sessions.delete(id);
    for (const socket of session.activeSockets) {
      socket.destroy();
    }
    session.activeSockets.clear();

    await new Promise<void>((resolve) => {
      session.server.close(() => resolve());
    });

    this.emitChange();
    return true;
  }

  /**
   * Lists all currently active port-forward tunnels.
   */
  public listActive(): K8sActivePortForward[] {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      contextName: s.target.contextName,
      namespace: s.target.namespace,
      podName: s.target.podName,
      containerPort: s.target.containerPort,
      localPort: s.localPort,
      activeConnections: s.activeSockets.size,
      startedAt: s.startedAt,
      status: s.error ? 'error' : 'active',
      error: s.error,
    }));
  }

  /**
   * Stops all active port-forwards.
   */
  public async stopAll(): Promise<void> {
    const ids = Array.from(this.sessions.keys());
    await Promise.all(ids.map((id) => this.stopPortForward(id)));
  }

  private emitChange(): void {
    this.emit('change', this.listActive());
  }
}
