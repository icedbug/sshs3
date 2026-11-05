import type { SSHConnectionConfig } from '@shared/types/ssh';
import type { K8sTerminalTarget } from '@shared/types/kubernetes';
import type { SFTPConfig } from '@shared/types/storage';
import type { StorageConnectConfig } from '@shared/types/ipc';

export interface TerminalStorageTarget {
  local?: boolean;
  config?: SSHConnectionConfig;
  k8sTarget?: K8sTerminalTarget;
  /** The SSH terminal's session id; lets main share that terminal's SSH connection with the SFTP channel. */
  sessionId?: string | null;
}

/** Storage provider id for the host a terminal is attached to ('' when it has none). */
export function terminalProviderId({ local, config, k8sTarget }: TerminalStorageTarget): string {
  if (local) return 'local';
  if (k8sTarget) {
    return `k8s-${k8sTarget.contextName}/${k8sTarget.namespace}/${k8sTarget.podName}/${k8sTarget.containerName}`;
  }
  if (config) return `sftp-${config.id || config.host}`;
  return '';
}

/** Connect config for the terminal's storage provider, or null when the terminal has none. */
export function terminalStorageConnectConfig(target: TerminalStorageTarget): StorageConnectConfig | null {
  const id = terminalProviderId(target);
  if (!id) return null;
  const { local, config, k8sTarget, sessionId } = target;
  if (local) return { id, name: 'Local Disk', type: 'local' };
  if (k8sTarget) {
    const name = `${k8sTarget.podName}/${k8sTarget.containerName}`;
    return {
      id,
      name,
      type: 'k8s',
      k8sConfig: {
        id,
        name,
        contextName: k8sTarget.contextName,
        namespace: k8sTarget.namespace,
        podName: k8sTarget.podName,
        containerName: k8sTarget.containerName,
      },
    };
  }
  if (!config) return null;
  const sftpConfig: SFTPConfig = {
    ...config,
    id: config.id || config.host,
    name: config.name || config.host,
    port: config.port ?? 22,
  };
  return {
    id,
    name: config.name || config.host,
    type: 'sftp',
    sftpConfig,
    ...(sessionId ? { terminalSessionId: sessionId } : {}),
  };
}

/** Name of the file at the end of a path (either separator). */
export function pathBasename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() || p;
}
