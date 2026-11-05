import { describe, it, expect } from 'vitest';
import { describeError } from '../../src/renderer/src/lib/k8sErrors';

describe('k8sErrors describeError', () => {
  it('maps ECONNREFUSED to user-friendly message', () => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:6443');
    expect(describeError(err)).toContain('Connection refused');
  });

  it('maps ENOTFOUND to user-friendly message', () => {
    const err = new Error('getaddrinfo ENOTFOUND k8s.example.com');
    expect(describeError(err)).toContain('Host not found');
  });

  it('maps 401 unauthorized to user-friendly message', () => {
    const err = new Error('HTTP 401 Unauthorized');
    expect(describeError(err)).toContain('Not authorized');
  });

  it('maps self-signed certificate error to user-friendly message', () => {
    const err = new Error('unable to verify the first certificate (self-signed)');
    expect(describeError(err)).toContain('TLS certificate problem');
  });

  it('walks error cause chain', () => {
    const inner = new Error('connect ECONNREFUSED');
    const outer = new TypeError('fetch failed');
    (outer as any).cause = inner;
    expect(describeError(outer)).toContain('Connection refused');
  });

  it('strips Electron remote method prefix', () => {
    const err = new Error("Error invoking remote method 'k8s:list-pods': namespace not found");
    expect(describeError(err)).toBe('namespace not found');
  });

  it('handles non-error objects gracefully', () => {
    expect(describeError('unexpected string error')).toBe('unexpected string error');
  });
});
