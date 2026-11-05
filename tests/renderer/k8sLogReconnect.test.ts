import { describe, it, expect } from 'vitest';
import {
  calculateReconnectDelay,
  formatReconnectCountdown,
  formatK8sLogError,
  isPodNotFoundError,
  getPodPrefix,
  findReplacementPod,
} from '../../src/renderer/src/lib/k8sLogReconnect';
import type { K8sPodNode } from '../../src/shared/types/kubernetes';

describe('k8sLogReconnect', () => {
  describe('calculateReconnectDelay', () => {
    it('returns progression with backoff up to 10s', () => {
      expect(calculateReconnectDelay(0)).toBe(1);
      expect(calculateReconnectDelay(1)).toBe(1);
      expect(calculateReconnectDelay(2)).toBe(2);
      expect(calculateReconnectDelay(3)).toBe(3);
      expect(calculateReconnectDelay(4)).toBe(5);
      expect(calculateReconnectDelay(5)).toBe(8);
      expect(calculateReconnectDelay(6)).toBe(10);
      expect(calculateReconnectDelay(10)).toBe(10);
    });
  });

  describe('formatReconnectCountdown', () => {
    it('formats countdown text with attempt number', () => {
      expect(formatReconnectCountdown(3, 1)).toBe('Reconnecting in 3s (attempt 1)...');
      expect(formatReconnectCountdown(1, 2)).toBe('Reconnecting in 1s (attempt 2)...');
      expect(formatReconnectCountdown(0, 3)).toBe('Reconnecting now (attempt 3)...');
      expect(formatReconnectCountdown(0, 0)).toBe('Reconnecting now...');
    });
  });

  describe('formatK8sLogError', () => {
    it('summarizes common Kubernetes pod/container error states', () => {
      expect(formatK8sLogError(new Error('pods "nginx-xyz" not found'))).toBe('Pod not found (404)');
      expect(formatK8sLogError('HTTP-Code: 404\nMessage: Error occurred in log request')).toBe('Pod not found (404)');
      expect(formatK8sLogError('previous terminated container "nginx" in pod "nginx-xyz" not found')).toBe('No previous terminated instance found');
      expect(formatK8sLogError('Container nginx is waiting to start: ContainerCreating')).toBe('Container is starting');
      expect(formatK8sLogError('CrashLoopBackOff: back-off 10s restarting failed container')).toBe('Container crash looping');
      expect(formatK8sLogError('stream terminated prematurely')).toBe('Container terminated');
      expect(formatK8sLogError('HTTP-Code: 503\nService Unavailable')).toBe('Kubernetes API error (503)');
    });

    it('handles unexpected errors and truncates very long messages', () => {
      expect(formatK8sLogError(null)).toBe('Connection failed');
      expect(formatK8sLogError('Network timeout')).toBe('Network timeout');
      const longMsg = 'A'.repeat(80);
      const formatted = formatK8sLogError(longMsg);
      expect(formatted.length).toBeLessThanOrEqual(50);
      expect(formatted.endsWith('...')).toBe(true);
    });
  });

  describe('isPodNotFoundError', () => {
    it('detects 404 or not found errors', () => {
      expect(isPodNotFoundError(new Error('pods "my-pod" not found'))).toBe(true);
      expect(isPodNotFoundError("Error invoking remote method 'k8s-log:start': Error: HTTP-Code: 404\nMessage: Error occurred in log request")).toBe(true);
      expect(isPodNotFoundError(new Error('Connection refused'))).toBe(false);
      expect(isPodNotFoundError(null)).toBe(false);
    });
  });

  describe('getPodPrefix', () => {
    it('extracts prefix before the last random hash segment', () => {
      expect(getPodPrefix('my-deploy-78f9c8d65f-4k2x9')).toBe('my-deploy-78f9c8d65f-');
      expect(getPodPrefix('fluentd-abc12')).toBe('fluentd-');
      expect(getPodPrefix('redis-0')).toBe('redis-');
      expect(getPodPrefix('standalone')).toBe('standalone');
    });
  });

  describe('findReplacementPod', () => {
    const mockPods: K8sPodNode[] = [
      {
        name: 'my-deploy-78f9c8d65f-old11',
        namespace: 'default',
        phase: 'Terminating',
        creationTimestamp: '2026-10-16T18:00:00Z',
        containers: [{ name: 'app', image: 'app:v1', ready: false, state: 'terminated' }],
      },
      {
        name: 'my-deploy-78f9c8d65f-new22',
        namespace: 'default',
        phase: 'Running',
        creationTimestamp: '2026-10-16T18:05:00Z',
        containers: [{ name: 'app', image: 'app:v1', ready: true, state: 'running' }],
      },
      {
        name: 'other-service-55555',
        namespace: 'default',
        phase: 'Running',
        creationTimestamp: '2026-10-16T18:02:00Z',
        containers: [{ name: 'redis', image: 'redis:latest', ready: true, state: 'running' }],
      },
    ];

    it('finds newly spawned replacement pod matching controller prefix', () => {
      const replacement = findReplacementPod('my-deploy-78f9c8d65f-old11', 'app', mockPods);
      expect(replacement).not.toBeNull();
      expect(replacement?.name).toBe('my-deploy-78f9c8d65f-new22');
    });

    it('returns null if no replacement pod matches container or prefix', () => {
      const replacement = findReplacementPod('standalone-pod-1', 'app', mockPods);
      expect(replacement).toBeNull();
    });

    it('sorts multiple candidates by creationTimestamp descending', () => {
      const multipleCandidates: K8sPodNode[] = [
        {
          name: 'replica-11111',
          namespace: 'default',
          phase: 'Running',
          creationTimestamp: '2026-10-16T18:01:00Z',
          containers: [{ name: 'web', image: 'web:1', ready: true, state: 'running' }],
        },
        {
          name: 'replica-22222',
          namespace: 'default',
          phase: 'Running',
          creationTimestamp: '2026-10-16T18:08:00Z',
          containers: [{ name: 'web', image: 'web:1', ready: true, state: 'running' }],
        },
      ];

      const replacement = findReplacementPod('replica-00000', 'web', multipleCandidates);
      expect(replacement?.name).toBe('replica-22222');
    });
  });
});
