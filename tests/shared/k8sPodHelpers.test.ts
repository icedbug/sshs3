import { describe, it, expect } from 'vitest';
import {
  isPodNotFoundError,
  extractErrorMessage,
  getPodPrefix,
  sortNewestPod,
  findReplacementPod,
} from '../../src/shared/k8sPodHelpers';
import type { K8sPodNode } from '../../src/shared/types/kubernetes';

describe('k8sPodHelpers', () => {
  describe('extractErrorMessage', () => {
    it('handles strings and Error instances', () => {
      expect(extractErrorMessage('Direct error message')).toBe('Direct error message');
      expect(extractErrorMessage(new Error('Standard Error'))).toBe('Standard Error');
      expect(extractErrorMessage(null)).toBe('Unknown error');
      expect(extractErrorMessage(undefined)).toBe('Unknown error');
    });

    it('extracts messages from K8s client response/body objects', () => {
      expect(extractErrorMessage({ message: 'Resource missing' })).toBe('Resource missing');
      expect(extractErrorMessage({ body: JSON.stringify({ message: 'JSON body error' }) })).toBe('JSON body error');
      expect(extractErrorMessage({ body: { message: 'Object body error' } })).toBe('Object body error');
      expect(extractErrorMessage({ response: { statusCode: 404, statusMessage: 'Not Found' } })).toBe('404 Not Found');
      expect(extractErrorMessage({ statusCode: 503 })).toBe('HTTP error 503');
    });
  });

  describe('isPodNotFoundError', () => {
    it('detects 404 in message string or error', () => {
      expect(isPodNotFoundError(new Error('Pod not found'))).toBe(true);
      expect(isPodNotFoundError(new Error('HTTP-Code: 404'))).toBe(true);
      expect(isPodNotFoundError('Error 404: Not Found')).toBe(true);
      expect(isPodNotFoundError(new Error('Connection refused'))).toBe(false);
      expect(isPodNotFoundError(null)).toBe(false);
    });

    it('detects 404 in K8s client response/body objects without Error inheritance', () => {
      expect(isPodNotFoundError({ statusCode: 404 })).toBe(true);
      expect(isPodNotFoundError({ response: { statusCode: 404 } })).toBe(true);
      expect(isPodNotFoundError({ body: { message: 'pods "app" not found' } })).toBe(true);
      expect(isPodNotFoundError({ statusCode: 500, message: 'Internal error' })).toBe(false);
    });
  });

  describe('getPodPrefix', () => {
    it('extracts controller prefix up to last dash', () => {
      expect(getPodPrefix('nginx-deployment-78f9c8d65f-4k2x9')).toBe('nginx-deployment-78f9c8d65f-');
      expect(getPodPrefix('redis-0')).toBe('redis-');
      expect(getPodPrefix('standalone')).toBe('standalone');
    });
  });

  describe('sortNewestPod', () => {
    it('sorts newest creationTimestamp first', () => {
      const pods: K8sPodNode[] = [
        {
          name: 'pod-old',
          namespace: 'default',
          phase: 'Running',
          creationTimestamp: '2026-10-16T10:00:00Z',
          containers: [],
        },
        {
          name: 'pod-new',
          namespace: 'default',
          phase: 'Running',
          creationTimestamp: '2026-10-16T12:00:00Z',
          containers: [],
        },
      ];
      expect(sortNewestPod(pods).name).toBe('pod-new');
    });

    it('prefers Running phase over Pending if timestamps match or missing', () => {
      const pods: K8sPodNode[] = [
        {
          name: 'pod-pending',
          namespace: 'default',
          phase: 'Pending',
          containers: [],
        },
        {
          name: 'pod-running',
          namespace: 'default',
          phase: 'Running',
          containers: [],
        },
      ];
      expect(sortNewestPod(pods).name).toBe('pod-running');
    });
  });

  describe('findReplacementPod', () => {
    it('finds replacement matching prefix and container name', () => {
      const pods: K8sPodNode[] = [
        {
          name: 'api-deploy-78f9-old',
          namespace: 'default',
          phase: 'Running',
          containers: [{ name: 'api', image: 'api:v1', ready: true, state: 'running' }],
        },
        {
          name: 'api-deploy-78f9-new',
          namespace: 'default',
          phase: 'Running',
          creationTimestamp: '2026-10-16T14:00:00Z',
          containers: [{ name: 'api', image: 'api:v1', ready: true, state: 'running' }],
        },
      ];

      const found = findReplacementPod('api-deploy-78f9-old', 'api', pods);
      expect(found?.name).toBe('api-deploy-78f9-new');
    });

    it('matches by containerPort when number is provided', () => {
      const pods: K8sPodNode[] = [
        {
          name: 'web-deploy-new',
          namespace: 'default',
          phase: 'Running',
          containers: [
            {
              name: 'web',
              image: 'nginx',
              ready: true,
              state: 'running',
              ports: [{ containerPort: 8080 }],
            },
          ],
        },
      ];

      const found = findReplacementPod('web-deploy-old', 8080, pods);
      expect(found?.name).toBe('web-deploy-new');
    });

    it('matches when containerOrPort is undefined', () => {
      const pods: K8sPodNode[] = [
        {
          name: 'db-1',
          namespace: 'default',
          phase: 'Running',
          containers: [{ name: 'postgres', image: 'postgres', ready: true, state: 'running' }],
        },
      ];

      const found = findReplacementPod('db-0', undefined, pods);
      expect(found?.name).toBe('db-1');
    });

    it('returns null if no matching candidate exists', () => {
      const pods: K8sPodNode[] = [
        {
          name: 'other-app-xyz',
          namespace: 'default',
          phase: 'Running',
          containers: [],
        },
      ];

      expect(findReplacementPod('my-app-abc', undefined, pods)).toBeNull();
    });
  });
});
