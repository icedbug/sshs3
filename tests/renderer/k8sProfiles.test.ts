import { describe, it, expect } from 'vitest';
import {
  defaultProfileName,
  profileForContext,
  restrictedNamespaces,
  unattachedProfiles,
} from '../../src/renderer/src/lib/k8sProfiles';
import type { K8sClusterNode, K8sProfile } from '../../src/shared/types/kubernetes';

const profile = (over: Partial<K8sProfile> = {}): K8sProfile => ({
  id: 'p1',
  name: 'Prod',
  server: 'https://api.example.com:6443',
  ...over,
});
const context = (contextName: string): K8sClusterNode => ({
  contextName,
  clusterName: 'c',
  server: 'https://api.example.com:6443',
  user: 'u',
  isCurrent: false,
  namespaces: [],
});

describe('k8sProfiles', () => {
  it('matches a profile to the context its latest sign-in wrote', () => {
    const list = [profile({ id: 'a', contextName: 'x/c/u' }), profile({ id: 'b' })];
    expect(profileForContext(list, 'x/c/u')?.id).toBe('a');
    expect(profileForContext(list, 'other')).toBeUndefined();
  });

  it('lists profiles that have no kubeconfig context', () => {
    const list = [
      profile({ id: 'signed-in', contextName: 'ctx-1' }),
      profile({ id: 'never' }),
      profile({ id: 'stale', contextName: 'gone' }),
    ];
    expect(unattachedProfiles(list, [context('ctx-1')]).map((p) => p.id)).toEqual(['never', 'stale']);
  });

  it('restricts to the explicit project only', () => {
    expect(restrictedNamespaces(profile({ namespace: ' team-a ' }))).toEqual([{ name: 'team-a', pods: [] }]);
    expect(restrictedNamespaces(profile())).toBeUndefined();
    expect(restrictedNamespaces(profile({ namespace: '  ' }))).toBeUndefined();
    expect(restrictedNamespaces(undefined)).toBeUndefined();
  });

  it('defaults the profile name to the API host', () => {
    expect(defaultProfileName('https://api.example.com:6443')).toBe('api.example.com');
    expect(defaultProfileName('api.example.com:6443')).toBe('api.example.com');
  });
});

describe('shared templates', () => {
  const template = { id: 't1', name: 'Shared', server: 'https://API.example.com:6443/', namespace: 'team-a' };

  it('finds the personal profile with the same server (ignoring case/scheme/trailing slash) and project', async () => {
    const { findMatchingProfile } = await import('../../src/renderer/src/lib/k8sProfiles');
    const mine = profile({ id: 'mine', server: 'api.example.com:6443', namespace: 'team-a' });
    expect(findMatchingProfile([mine], template)?.id).toBe('mine');
    expect(findMatchingProfile([profile({ server: 'api.example.com:6443', namespace: 'other' })], template)).toBeUndefined();
    expect(findMatchingProfile([profile({ server: 'api.example.com:6443' })], template)).toBeUndefined();
  });

  it('turns a template into a fresh personal profile without a context when none matches', async () => {
    const { personalProfileFromTemplate } = await import('../../src/renderer/src/lib/k8sProfiles');
    const copy = personalProfileFromTemplate([], template);
    expect(copy.id).not.toBe('t1');
    expect(copy).toMatchObject({ name: 'Shared', server: template.server, namespace: 'team-a' });
    expect(copy.contextName).toBeUndefined();
  });

  it('shares a profile without its context, usage stamp or tombstone', async () => {
    const { templateFromProfile } = await import('../../src/renderer/src/lib/k8sProfiles');
    const shared = templateFromProfile(
      profile({ contextName: 'c', lastUsedAt: '2026-01-01T00:00:00.000Z', deletedAt: '2026-01-01T00:00:00.000Z', updatedAt: 'x' })
    );
    expect(shared).toEqual({ id: 'p1', name: 'Prod', server: 'https://api.example.com:6443', insecureSkipTlsVerify: undefined, namespace: undefined });
  });
});
