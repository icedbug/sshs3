/**
 * Helper functions and calculations for K8s log streaming reconnection.
 */

export type K8sLogStatus = 'connecting' | 'connected' | 'reconnecting' | 'ended';

/**
 * Calculates exponential backoff delay in seconds for K8s log reconnection attempts.
 * Backoff progression:
 * - Attempt 1: 1s
 * - Attempt 2: 2s
 * - Attempt 3: 3s
 * - Attempt 4: 5s
 * - Attempt 5: 8s
 * - Attempt 6+: 10s max
 */
export function calculateReconnectDelay(attempt: number): number {
  if (attempt <= 1) return 1;
  if (attempt === 2) return 2;
  if (attempt === 3) return 3;
  if (attempt === 4) return 5;
  if (attempt === 5) return 8;
  return 10;
}

/**
 * Formats the countdown text for the reconnecting banner.
 */
export function formatReconnectCountdown(countdown: number, attempt: number): string {
  const attemptStr = attempt > 0 ? ` (attempt ${attempt})` : '';
  if (countdown <= 0) {
    return `Reconnecting now${attemptStr}...`;
  }
  return `Reconnecting in ${countdown}s${attemptStr}...`;
}

import { extractErrorMessage } from '@shared/k8sPodHelpers';

/**
 * Normalizes error messages from Kubernetes log API errors for display in the status banner.
 */
export function formatK8sLogError(error: unknown): string {
  if (!error) return 'Connection failed';
  const msg = extractErrorMessage(error);

  if (/previous terminated container.*not found/i.test(msg)) {
    return 'No previous terminated instance found';
  }
  if (/404|not found/i.test(msg)) return 'Pod not found (404)';
  if (/waiting to start|containercreating/i.test(msg)) return 'Container is starting';
  if (/crashloop/i.test(msg)) return 'Container crash looping';
  if (/terminated/i.test(msg)) return 'Container terminated';
  if (/HTTP-Code:\s*(\d+)/i.test(msg)) {
    const match = msg.match(/HTTP-Code:\s*(\d+)/i);
    return `Kubernetes API error (${match![1]})`;
  }

  // Strip Electron remote method IPC prefixes
  const cleaned = msg.replace(ELECTRON_IPC_PREFIX, '');
  const firstLine = cleaned.split('\n')[0].trim();
  if (firstLine.length > 50) return `${firstLine.slice(0, 47)}...`;
  return firstLine || 'Connection failed';
}

export {
  extractErrorMessage,
  isPodNotFoundError,
  getPodPrefix,
  sortNewestPod,
  findReplacementPod,
} from '@shared/k8sPodHelpers';
import { ELECTRON_IPC_PREFIX } from './format';
