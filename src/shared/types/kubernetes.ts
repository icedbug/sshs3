export interface K8sContainerNode {
  name: string;
  image: string;
  ready: boolean;
  state: 'running' | 'waiting' | 'terminated' | 'unknown';
  isEphemeral?: boolean;
  ports?: Array<{ containerPort: number; name?: string; protocol?: string }>;
}

export interface K8sPodNode {
  name: string;
  namespace: string;
  phase: string;
  creationTimestamp?: string;
  containers: K8sContainerNode[];
}

export interface K8sNamespaceNode {
  name: string;
  displayName?: string;
  pods: K8sPodNode[];
}

export interface K8sClusterNode {
  /** Kubeconfig context name — the id used to select this cluster for discovery/exec. */
  contextName: string;
  clusterName: string;
  server: string;
  user: string;
  isCurrent: boolean;
  isOpenShift?: boolean;
  namespaces: K8sNamespaceNode[];
}

export interface K8sDiscoveryTree {
  kubeconfigPath: string;
  clusters: K8sClusterNode[];
}

export interface K8sTerminalTarget {
  contextName: string;
  namespace: string;
  podName: string;
  containerName: string;
  shell?: string; // defaults to '/bin/sh'
}

export interface K8sTerminalExitEvent {
  sessionId: string;
  status: string; // 'Success' | 'Failure' | reason string from the exec status channel
}

export interface K8sStorageConfig {
  id: string;
  name: string;
  contextName: string;
  namespace: string;
  podName: string;
  containerName: string;
  initialPath?: string;
  group?: string;
  lastUsedAt?: string;
}

export interface K8sPodCondition {
  type: string;
  status: string;
  lastTransitionTime?: string;
  reason?: string;
  message?: string;
}

export interface K8sPodContainerStatus {
  name: string;
  image: string;
  ready: boolean;
  restartCount: number;
  state: 'running' | 'waiting' | 'terminated' | 'unknown';
  isEphemeral?: boolean;
  stateDetails?: {
    startedAt?: string;
    reason?: string;
    message?: string;
    exitCode?: number;
    finishedAt?: string;
  };
  ports?: Array<{ containerPort: number; name?: string; protocol?: string }>;
}

export interface K8sPodEvent {
  type: 'Normal' | 'Warning' | string;
  reason: string;
  message: string;
  count?: number;
  firstTimestamp?: string;
  lastTimestamp?: string;
  source?: string;
}

export interface K8sPodDescription {
  name: string;
  namespace: string;
  nodeName?: string;
  phase: string;
  podIP?: string;
  hostIP?: string;
  startTime?: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  conditions: K8sPodCondition[];
  containers: K8sPodContainerStatus[];
  initContainers?: K8sPodContainerStatus[];
  ephemeralContainers?: K8sPodContainerStatus[];
  events: K8sPodEvent[];
  yaml: string;
}

export interface K8sPortForwardTarget {
  contextName: string;
  namespace: string;
  podName: string;
  containerPort: number;
  localPort?: number;
}

export interface K8sActivePortForward {
  id: string;
  contextName: string;
  namespace: string;
  podName: string;
  containerPort: number;
  localPort: number;
  activeConnections: number;
  startedAt: string;
  status: 'active' | 'error' | 'stopped';
  error?: string;
}

export interface K8sDebugImage {
  id: string;
  name: string;
  image: string;
  description?: string;
  defaultCommand?: string;
}

export const DEFAULT_K8S_DEBUG_IMAGES: K8sDebugImage[] = [
  {
    id: 'netshoot',
    name: 'Netshoot (Network Troubleshooting)',
    image: 'nicolaka/netshoot',
    description: 'Swiss army knife for network troubleshooting (tcpdump, curl, iperf, netstat, nmap, etc.)',
    defaultCommand: 'bash',
  },
  {
    id: 'rhel-support-tools',
    name: 'RHEL Support Tools',
    image: 'registry.access.redhat.com/ubi9/rhel-support-tools',
    description: 'Red Hat Enterprise Linux UBI with sysstat, gdb, strace, iproute, etc.',
    defaultCommand: 'bash',
  },
  {
    id: 'busybox',
    name: 'BusyBox (Minimal Shell)',
    image: 'busybox:latest',
    description: 'Lightweight POSIX shell environment with standard core utilities',
    defaultCommand: 'sh',
  },
  {
    id: 'curl',
    name: 'Curl (HTTP Testing)',
    image: 'curlimages/curl:latest',
    description: 'Minimal Alpine-based image with curl for HTTP/HTTPS API testing',
    defaultCommand: 'sh',
  },
  {
    id: 'ubuntu',
    name: 'Ubuntu (Full Linux Utilities)',
    image: 'ubuntu:latest',
    description: 'Standard Ubuntu environment with apt-get package manager',
    defaultCommand: 'bash',
  },
];

export interface K8sDebugTarget {
  contextName: string;
  namespace: string;
  podName: string;
  image: string;
  containerName?: string;
  targetContainerName?: string;
  command?: string[];
}

export interface K8sLoginOptions {
  server: string;
  token: string;
  insecureSkipTlsVerify?: boolean;
  namespace?: string;
  username?: string;
  kubeConfigPath?: string;
}

export interface K8sLoginResult {
  success: boolean;
  contextName: string;
  clusterName: string;
  userName: string;
  server: string;
  namespace: string;
  projects: string[];
}

/** Whether a cluster offers the OpenShift browser sign-in (built-in OAuth server, OpenShift 4.13+). */
export interface K8sOpenShiftProbeResult {
  supported: boolean;
  reason?: string;
}

export interface K8sWebLoginOptions {
  server: string;
  insecureSkipTlsVerify?: boolean;
  namespace?: string;
  /** Fixed loopback port for the sign-in callback; a random free port is used when omitted. */
  callbackPort?: number;
}

export interface K8sWebLoginResult extends K8sLoginResult {
  /** ISO timestamp of the token expiry, when the OAuth server reported it. */
  expiresAt?: string;
}

/**
 * A saved cluster. Holds no secret: the token only ever lives in the kubeconfig.
 * `namespace` is the project the user explicitly chose, and restricts the tree to it.
 */
export interface K8sProfile {
  id: string;
  name: string;
  server: string;
  insecureSkipTlsVerify?: boolean;
  namespace?: string;
  /** Kubeconfig context written by the latest sign-in with this profile. */
  contextName?: string;
  lastUsedAt?: string;
  updatedAt?: string;
  /** Set when the profile was deleted; kept so the deletion can sync to other devices. */
  deletedAt?: string;
}
