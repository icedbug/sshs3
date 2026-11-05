import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type * as k8s from '@kubernetes/client-node';
import { loadK8sClient } from './k8sClient';
import { loadKubeConfigForContext, getExecAuthUserNames } from './k8sKubeConfig';
import type {
  K8sClusterNode,
  K8sContainerNode,
  K8sNamespaceNode,
  K8sPodCondition,
  K8sPodContainerStatus,
  K8sPodDescription,
  K8sPodEvent,
  K8sPodNode,
} from '../../shared/types/kubernetes';

function containerState(status: k8s.V1ContainerStatus | undefined): K8sContainerNode['state'] {
  if (!status?.state) return 'unknown';
  if (status.state.running) return 'running';
  if (status.state.waiting) return 'waiting';
  if (status.state.terminated) return 'terminated';
  return 'unknown';
}

function looksLikeOpenShift(contextName: string, user?: string, server?: string): boolean {
  const text = `${contextName} ${user || ''} ${server || ''}`.toLowerCase();
  return text.includes('openshift') || text.includes('crc') || (Boolean(user?.includes('/')) && /api.*:6443/.test(user || ''));
}

/**
 * Reads the user's kubeconfig and exposes a lazily-expandable
 * cluster -> namespace -> pod -> container tree for the sidebar.
 * Namespaces/pods are only fetched on demand (not eagerly for every
 * context at startup) since a kubeconfig can reference clusters that
 * are slow or unreachable.
 */
export class K8sDiscoveryService {
  private kubeConfigPath?: string;
  private kc: k8s.KubeConfig | undefined;
  private apiClients: Map<string, k8s.CoreV1Api> = new Map();
  private watcher?: fs.FSWatcher;
  private changeListeners: Set<() => void> = new Set();
  private debounceTimer: NodeJS.Timeout | null = null;
  private watchingPath?: string;
  /** Exec-auth users seen on the last load; undefined until the first load completes. */
  private knownExecAuthUsers: Set<string> | undefined;
  /** Set when a reload (file changed on disk, not the initial load) introduces a new exec-auth user; consumed once by consumePendingExecAuthWarning(). */
  private pendingExecAuthWarning: string | null = null;

  constructor(kubeConfigPath?: string) {
    this.kubeConfigPath = kubeConfigPath;
  }

  private isForbiddenError(err: unknown): boolean {
    if (!err) return false;
    const e = err as { code?: number; statusCode?: number; response?: { statusCode?: number }; message?: string };
    if (e.code === 403 || e.statusCode === 403 || e.response?.statusCode === 403) return true;
    if (typeof e.message === 'string' && /forbidden|403/i.test(e.message)) return true;
    return false;
  }

  private async loadKubeConfig(): Promise<k8s.KubeConfig> {
    if (this.kc) return this.kc;
    const { KubeConfig } = await loadK8sClient();
    const kc = new KubeConfig();
    if (this.kubeConfigPath) {
      kc.loadFromFile(this.kubeConfigPath);
    } else {
      kc.loadFromDefault();
    }
    this.kc = kc;
    this.checkExecAuthChange(kc);
    return kc;
  }

  /**
   * exec-auth (a kubeconfig user with a `command`/`args` credential plugin,
   * e.g. `aws eks get-token`) is completely normal and not itself flagged —
   * only a NEW exec entry appearing in a kubeconfig that changed on disk
   * while the app was already running is, since @kubernetes/client-node
   * runs that command silently on first use of the context (H8 code-review
   * finding). The very first load (this.knownExecAuthUsers still undefined)
   * establishes the baseline instead of warning, so the user's own
   * long-standing kubeconfig never nags on ordinary app startup.
   */
  private checkExecAuthChange(kc: k8s.KubeConfig): void {
    const current = getExecAuthUserNames(kc);
    if (this.knownExecAuthUsers) {
      const added = [...current].filter((name) => !this.knownExecAuthUsers!.has(name));
      if (added.length > 0) {
        this.pendingExecAuthWarning =
          `Your kubeconfig changed on disk and now runs an external command to authenticate ` +
          `${added.length === 1 ? 'user' : 'users'} "${added.join('", "')}" the next time it's used. ` +
          `If you didn't make this change yourself, review ${this.getKubeconfigPath()} before continuing.`;
      }
    }
    this.knownExecAuthUsers = current;
  }

  /** One-shot: returns and clears any exec-auth warning raised by the most recent reload. */
  public consumePendingExecAuthWarning(): string | null {
    const warning = this.pendingExecAuthWarning;
    this.pendingExecAuthWarning = null;
    return warning;
  }

  public getKubeconfigPath(): string {
    return this.kubeConfigPath || process.env.KUBECONFIG || path.join(os.homedir(), '.kube', 'config');
  }

  /**
   * Re-reads the kubeconfig from disk and drops cached API clients, so a
   * manual refresh picks up contexts/clusters added since this service
   * was created (e.g. after `oc login` or `kubectl config use-context`).
   */
  public reload(): void {
    this.kc = undefined;
    this.apiClients.clear();
  }

  /**
   * Registers a listener that is invoked when the underlying kubeconfig file
   * is modified, created, or changed on disk. Automatically begins watching.
   */
  public onConfigChanged(listener: () => void): () => void {
    this.changeListeners.add(listener);
    this.ensureWatcher();
    return () => {
      this.changeListeners.delete(listener);
      if (this.changeListeners.size === 0) {
        this.stopWatcher();
      }
    };
  }

  public ensureWatcher(): void {
    const kubePath = this.getKubeconfigPath();
    if (this.watcher && this.watchingPath === kubePath) return;
    this.stopWatcher();
    this.watchingPath = kubePath;

    const kubeDir = path.dirname(kubePath);
    if (!fs.existsSync(kubeDir)) {
      try {
        fs.mkdirSync(kubeDir, { recursive: true });
      } catch {
        // Ignored
      }
    }

    try {
      this.watcher = fs.watch(kubeDir, (_eventType, filename) => {
        const targetFilename = path.basename(kubePath);
        if (!filename || filename === targetFilename) {
          this.triggerChange();
        }
      });
    } catch {
      if (fs.existsSync(kubePath)) {
        try {
          this.watcher = fs.watch(kubePath, () => {
            this.triggerChange();
          });
        } catch {
          // Ignored
        }
      }
    }
  }

  private triggerChange(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.reload();
      for (const listener of this.changeListeners) {
        try {
          listener();
        } catch {
          // Ignored
        }
      }
    }, 250);
  }

  public stopWatcher(): void {
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        // Ignored
      }
      this.watcher = undefined;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.watchingPath = undefined;
  }

  public destroy(): void {
    this.stopWatcher();
    this.changeListeners.clear();
  }

  private async getApiClient(contextName: string): Promise<k8s.CoreV1Api> {
    const cached = this.apiClients.get(contextName);
    if (cached) return cached;

    const [kc, { CoreV1Api }] = await Promise.all([
      loadKubeConfigForContext(contextName, this.kubeConfigPath),
      loadK8sClient(),
    ]);
    const client = kc.makeApiClient(CoreV1Api);
    this.apiClients.set(contextName, client);
    return client;
  }

  /**
   * Lists every context defined in the kubeconfig, without connecting to
   * any of them. This is the top level of the sidebar tree.
   */
  public async listContexts(): Promise<K8sClusterNode[]> {
    const kc = await this.loadKubeConfig();
    const currentContext = kc.getCurrentContext();

    return kc.getContexts().map((context): K8sClusterNode => {
      const cluster = kc.getCluster(context.cluster);
      const server = cluster?.server || '';
      return {
        contextName: context.name,
        clusterName: context.cluster,
        server,
        user: context.user,
        isCurrent: context.name === currentContext,
        isOpenShift: looksLikeOpenShift(context.name, context.user, server),
        namespaces: [],
      };
    });
  }

  /**
   * Lists namespaces for a single context (one tree-node expansion).
   * Falls back to OpenShift Projects API if standard namespace listing
   * is forbidden (common for non-admin OpenShift users), or context.namespace.
   */
  public async listNamespaces(contextName: string): Promise<K8sNamespaceNode[]> {
    const client = await this.getApiClient(contextName);
    try {
      const res = await client.listNamespace();
      return res.items.map((ns) => ({
        name: ns.metadata?.name || '',
        pods: [],
      }));
    } catch (err) {
      if (this.isForbiddenError(err)) {
        // Fallback 1: Try OpenShift Projects API (project.openshift.io/v1/projects)
        try {
          const [kc, { CustomObjectsApi }] = await Promise.all([
            loadKubeConfigForContext(contextName, this.kubeConfigPath),
            loadK8sClient(),
          ]);
          const customApi = kc.makeApiClient(CustomObjectsApi);
          const projectsRes = (await customApi.listClusterCustomObject({
            group: 'project.openshift.io',
            version: 'v1',
            plural: 'projects',
          })) as { items?: Array<{ metadata?: { name?: string; annotations?: Record<string, string> } }> };

          if (Array.isArray(projectsRes.items) && projectsRes.items.length > 0) {
            return projectsRes.items.map((p) => {
              const name = p.metadata?.name || '';
              const displayName = p.metadata?.annotations?.['openshift.io/display-name'];
              return {
                name,
                displayName: displayName && displayName !== name ? displayName : undefined,
                pods: [],
              };
            });
          }
        } catch {
          // OpenShift Projects call failed or not an OpenShift cluster; fall through
        }

        // Fallback 2: Check if current kubeconfig context specifies a default namespace
        const kc = await this.loadKubeConfig();
        const ctxObj = kc.getContextObject(contextName);
        if (ctxObj?.namespace) {
          return [
            {
              name: ctxObj.namespace,
              pods: [],
            },
          ];
        }
      }
      throw err;
    }
  }

  /**
   * Lists pods (with their containers) for a single namespace.
   */
  public async listPods(contextName: string, namespace: string): Promise<K8sPodNode[]> {
    const client = await this.getApiClient(contextName);
    const res = await client.listNamespacedPod({ namespace });

    return res.items.map((pod): K8sPodNode => {
      const statusByName = new Map(
        (pod.status?.containerStatuses || []).map((s) => [s.name, s])
      );
      const regularContainers: K8sContainerNode[] = (pod.spec?.containers || []).map((c) => {
        const status = statusByName.get(c.name);
        const node: K8sContainerNode = {
          name: c.name,
          image: c.image || '',
          ready: status?.ready ?? false,
          state: containerState(status),
        };
        if (c.ports && c.ports.length > 0) {
          node.ports = c.ports.map((p) => ({
            containerPort: p.containerPort,
            name: p.name,
            protocol: p.protocol,
          }));
        }
        return node;
      });

      const ephemeralContainers: K8sContainerNode[] = (pod.spec?.ephemeralContainers || []).map((c) => {
        const status = (pod.status?.ephemeralContainerStatuses || []).find((s) => s.name === c.name);
        const node: K8sContainerNode = {
          name: c.name,
          image: c.image || '',
          ready: status?.ready ?? false,
          state: containerState(status),
          isEphemeral: true,
        };
        if (c.ports && c.ports.length > 0) {
          node.ports = c.ports.map((p) => ({
            containerPort: p.containerPort,
            name: p.name,
            protocol: p.protocol,
          }));
        }
        return node;
      });

      const rawCreated = pod.metadata?.creationTimestamp;
      const creationTimestamp =
        rawCreated instanceof Date
          ? rawCreated.toISOString()
          : typeof rawCreated === 'string'
            ? rawCreated
            : undefined;

      return {
        name: pod.metadata?.name || '',
        namespace,
        phase: pod.status?.phase || 'Unknown',
        creationTimestamp,
        containers: [...regularContainers, ...ephemeralContainers],
      };
    });
  }

  /**
   * Fetches detailed information, conditions, container statuses, and events for a pod.
   */
  public async describePod(
    contextName: string,
    namespace: string,
    podName: string
  ): Promise<K8sPodDescription> {
    const client = await this.getApiClient(contextName);
    const pod = await client.readNamespacedPod({ name: podName, namespace });

    let events: K8sPodEvent[] = [];
    try {
      const eventRes = await client.listNamespacedEvent({
        namespace,
        fieldSelector: `involvedObject.name=${podName}`,
      });
      events = (eventRes.items || []).map((e): K8sPodEvent => ({
        type: e.type || 'Normal',
        reason: e.reason || '',
        message: e.message || '',
        count: e.count ?? 1,
        firstTimestamp: e.firstTimestamp ? new Date(e.firstTimestamp).toISOString() : undefined,
        lastTimestamp: (e.lastTimestamp || e.eventTime)
          ? new Date(e.lastTimestamp || e.eventTime!).toISOString()
          : undefined,
        source: e.source?.component || e.reportingComponent || '',
      }));
    } catch {
      // Fallback: list all namespace events and filter in-memory if fieldSelector is unsupported
      try {
        const eventRes = await client.listNamespacedEvent({ namespace });
        events = (eventRes.items || [])
          .filter((e) => e.involvedObject?.name === podName)
          .map((e): K8sPodEvent => ({
            type: e.type || 'Normal',
            reason: e.reason || '',
            message: e.message || '',
            count: e.count ?? 1,
            firstTimestamp: e.firstTimestamp ? new Date(e.firstTimestamp).toISOString() : undefined,
            lastTimestamp: (e.lastTimestamp || e.eventTime)
              ? new Date(e.lastTimestamp || e.eventTime!).toISOString()
              : undefined,
            source: e.source?.component || e.reportingComponent || '',
          }));
      } catch {
        // Events might be inaccessible due to RBAC
      }
    }

    // Sort events newest first
    events.sort((a, b) => {
      const tA = a.lastTimestamp || a.firstTimestamp || '';
      const tB = b.lastTimestamp || b.firstTimestamp || '';
      return tB.localeCompare(tA);
    });

    const statusByName = new Map(
      (pod.status?.containerStatuses || []).map((s) => [s.name, s])
    );
    const initStatusByName = new Map(
      (pod.status?.initContainerStatuses || []).map((s) => [s.name, s])
    );

    const mapContainer = (
      c: k8s.V1Container,
      s?: k8s.V1ContainerStatus
    ): K8sPodContainerStatus => {
      let state: K8sPodContainerStatus['state'] = 'unknown';
      let stateDetails: K8sPodContainerStatus['stateDetails'];

      if (s?.state?.running) {
        state = 'running';
        stateDetails = {
          startedAt: s.state.running.startedAt
            ? new Date(s.state.running.startedAt).toISOString()
            : undefined,
        };
      } else if (s?.state?.waiting) {
        state = 'waiting';
        stateDetails = {
          reason: s.state.waiting.reason,
          message: s.state.waiting.message,
        };
      } else if (s?.state?.terminated) {
        state = 'terminated';
        stateDetails = {
          exitCode: s.state.terminated.exitCode,
          reason: s.state.terminated.reason,
          message: s.state.terminated.message,
          startedAt: s.state.terminated.startedAt
            ? new Date(s.state.terminated.startedAt).toISOString()
            : undefined,
          finishedAt: s.state.terminated.finishedAt
            ? new Date(s.state.terminated.finishedAt).toISOString()
            : undefined,
        };
      }

      return {
        name: c.name,
        image: c.image || '',
        ready: s?.ready ?? false,
        restartCount: s?.restartCount ?? 0,
        state,
        stateDetails,
        ports: c.ports?.map((p) => ({
          containerPort: p.containerPort,
          name: p.name,
          protocol: p.protocol,
        })),
      };
    };

    const containers = (pod.spec?.containers || []).map((c) =>
      mapContainer(c, statusByName.get(c.name))
    );
    const initContainers = (pod.spec?.initContainers || []).map((c) =>
      mapContainer(c, initStatusByName.get(c.name))
    );
    const ephemeralStatusByName = new Map(
      (pod.status?.ephemeralContainerStatuses || []).map((s) => [s.name, s])
    );
    const ephemeralContainers = (pod.spec?.ephemeralContainers || []).map((c) => ({
      ...mapContainer(c as any, ephemeralStatusByName.get(c.name)),
      isEphemeral: true,
    }));

    const conditions: K8sPodCondition[] = (pod.status?.conditions || []).map((c) => ({
      type: c.type,
      status: c.status,
      lastTransitionTime: c.lastTransitionTime
        ? new Date(c.lastTransitionTime).toISOString()
        : undefined,
      reason: c.reason,
      message: c.message,
    }));

    const { dumpYaml } = await loadK8sClient();
    const yaml = dumpYaml ? dumpYaml(pod) : JSON.stringify(pod, null, 2);

    return {
      name: pod.metadata?.name || podName,
      namespace,
      nodeName: pod.spec?.nodeName,
      phase: pod.status?.phase || 'Unknown',
      podIP: pod.status?.podIP,
      hostIP: pod.status?.hostIP,
      startTime: pod.status?.startTime
        ? new Date(pod.status.startTime).toISOString()
        : undefined,
      labels: (pod.metadata?.labels as Record<string, string>) || {},
      annotations: (pod.metadata?.annotations as Record<string, string>) || {},
      conditions,
      containers,
      initContainers: initContainers.length > 0 ? initContainers : undefined,
      ephemeralContainers: ephemeralContainers.length > 0 ? ephemeralContainers : undefined,
      events,
      yaml,
    };
  }

  /**
   * Deletes a pod in the specified namespace and context.
   * If the pod is owned by a controller (Deployment, ReplicaSet, StatefulSet, DaemonSet),
   * Kubernetes will automatically create a replacement pod.
   */
  public async deletePod(
    contextName: string,
    namespace: string,
    podName: string
  ): Promise<void> {
    const client = await this.getApiClient(contextName);
    await client.deleteNamespacedPod({ name: podName, namespace });
  }
}
