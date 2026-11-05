import type { K8sPodNode } from './types/kubernetes';

/**
 * Extracts a readable message from any error, including @kubernetes/client-node
 * response/body objects which do not inherit from Error.
 */
export function extractErrorMessage(error: unknown): string {
  if (!error) return 'Unknown error';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;

  if (typeof error === 'object') {
    const anyErr = error as Record<string, unknown>;
    if (typeof anyErr.message === 'string' && anyErr.message.trim()) {
      return anyErr.message;
    }
    if (anyErr.body) {
      if (typeof anyErr.body === 'string' && anyErr.body.trim()) {
        try {
          const parsed = JSON.parse(anyErr.body);
          if (parsed && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>).message === 'string') {
            return (parsed as Record<string, unknown>).message as string;
          }
        } catch {
          return anyErr.body;
        }
      } else if (typeof anyErr.body === 'object' && anyErr.body !== null) {
        const bodyObj = anyErr.body as Record<string, unknown>;
        if (typeof bodyObj.message === 'string') return bodyObj.message;
      }
    }
    if (anyErr.response && typeof anyErr.response === 'object') {
      const resp = anyErr.response as Record<string, unknown>;
      if (resp.body && typeof resp.body === 'object' && resp.body !== null) {
        const respBody = resp.body as Record<string, unknown>;
        if (typeof respBody.message === 'string') return respBody.message;
      } else if (typeof resp.body === 'string' && resp.body.trim()) {
        return resp.body;
      }
      if (typeof resp.statusMessage === 'string') {
        return `${resp.statusCode || ''} ${resp.statusMessage}`.trim();
      }
    }
    if (typeof anyErr.statusMessage === 'string') {
      return `${anyErr.statusCode || ''} ${anyErr.statusMessage}`.trim();
    }
    if (anyErr.statusCode) {
      return `HTTP error ${anyErr.statusCode}`;
    }
    try {
      const json = JSON.stringify(error);
      if (json && json !== '{}') return json;
    } catch {
      // ignore serialization error
    }
  }

  return String(error);
}

/**
 * Checks whether an error indicates that the pod was not found (404 or not found message).
 */
export function isPodNotFoundError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === 'object' && error !== null) {
    const anyErr = error as Record<string, unknown>;
    if (anyErr.statusCode === 404) return true;
    if (anyErr.response && typeof anyErr.response === 'object') {
      if ((anyErr.response as Record<string, unknown>).statusCode === 404) return true;
    }
  }
  const msg = extractErrorMessage(error);
  return /404|not found/i.test(msg);
}

/**
 * Extracts the base controller prefix from a pod name.
 * Examples:
 * - 'api-deployment-78f9c8d65f-4k2x9' -> 'api-deployment-78f9c8d65f-'
 * - 'frontend-5w2v1' -> 'frontend-'
 * - 'redis-0' -> 'redis-'
 */
export function getPodPrefix(podName: string): string {
  const lastDashIndex = podName.lastIndexOf('-');
  if (lastDashIndex > 0) {
    return podName.slice(0, lastDashIndex + 1);
  }
  return podName;
}

/**
 * Sorts pods picking the newest one created (or running).
 */
export function sortNewestPod(pods: K8sPodNode[]): K8sPodNode {
  return [...pods].sort((a, b) => {
    if (a.creationTimestamp && b.creationTimestamp) {
      return b.creationTimestamp.localeCompare(a.creationTimestamp);
    }
    if (a.creationTimestamp) return -1;
    if (b.creationTimestamp) return 1;
    // Prefer Running over Pending
    if (a.phase === 'Running' && b.phase !== 'Running') return -1;
    if (b.phase === 'Running' && a.phase !== 'Running') return 1;
    return b.name.localeCompare(a.name);
  })[0];
}

/**
 * Finds a suitable replacement pod in the same namespace when the previous pod was deleted or restarted.
 * Looks for pods matching:
 * 1. Has a name matching the controller prefix of oldPodName, but different from oldPodName.
 * 2. Is in Running or Pending phase (not Failed or Succeeded).
 * 3. Matches container name or port (if provided).
 * 4. Sorts by newest creationTimestamp first.
 */
export function findReplacementPod(
  oldPodName: string,
  containerOrPort: string | number | undefined,
  pods: K8sPodNode[]
): K8sPodNode | null {
  const prefix = getPodPrefix(oldPodName);
  const matchesContainer = (pod: K8sPodNode): boolean => {
    if (containerOrPort === undefined) return true;
    if (typeof containerOrPort === 'string') {
      return pod.containers.some((c) => c.name === containerOrPort);
    }
    return (
      pod.containers.some((c) => c.ports?.some((p) => p.containerPort === containerOrPort)) ||
      pod.containers.length > 0
    );
  };

  const candidates = pods.filter((pod) => {
    if (pod.name === oldPodName) return false;
    if (pod.phase === 'Failed' || pod.phase === 'Succeeded') return false;
    if (!pod.name.startsWith(prefix)) return false;
    return matchesContainer(pod);
  });

  if (candidates.length === 0) {
    const parentPrefix = prefix.replace(/[a-z0-9]+-$/, '');
    if (parentPrefix && parentPrefix !== prefix) {
      const broaderCandidates = pods.filter((pod) => {
        if (pod.name === oldPodName) return false;
        if (pod.phase === 'Failed' || pod.phase === 'Succeeded') return false;
        if (!pod.name.startsWith(parentPrefix)) return false;
        return matchesContainer(pod);
      });
      if (broaderCandidates.length > 0) {
        return sortNewestPod(broaderCandidates);
      }
    }
    return null;
  }

  return sortNewestPod(candidates);
}
