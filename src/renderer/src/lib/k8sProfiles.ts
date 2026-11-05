import type { K8sClusterNode, K8sNamespaceNode, K8sProfile } from '@shared/types/kubernetes';

/** The saved profile whose latest sign-in produced this kubeconfig context. */
export function profileForContext(profiles: K8sProfile[], contextName: string): K8sProfile | undefined {
  return profiles.find((p) => p.contextName === contextName);
}

/** Profiles with no matching kubeconfig context (never signed in, or the context was removed). */
export function unattachedProfiles(profiles: K8sProfile[], contexts: K8sClusterNode[]): K8sProfile[] {
  const known = new Set(contexts.map((c) => c.contextName));
  return profiles.filter((p) => !p.contextName || !known.has(p.contextName));
}

/**
 * The single project a profile is limited to, or undefined when it should list the whole cluster.
 * Only an explicit choice counts: the kubeconfig context also holds an auto-picked project.
 */
export function restrictedNamespaces(profile: K8sProfile | undefined): K8sNamespaceNode[] | undefined {
  const namespace = profile?.namespace?.trim();
  return namespace ? [{ name: namespace, pods: [] }] : undefined;
}

/** Default profile name: the API host, e.g. `api.cluster.example.com`. */
export function defaultProfileName(server: string): string {
  const trimmed = server.trim();
  try {
    return new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).hostname || trimmed;
  } catch {
    return trimmed;
  }
}

export function newProfileId(): string {
  return crypto.randomUUID();
}

function sameServer(a: string, b: string): boolean {
  const normalize = (value: string) =>
    value
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, '');
  return normalize(a) === normalize(b);
}

/** The personal profile that already covers a shared template: same server and same project. */
export function findMatchingProfile(profiles: K8sProfile[], template: K8sProfile): K8sProfile | undefined {
  const namespace = template.namespace?.trim() || '';
  return profiles.find((p) => sameServer(p.server, template.server) && (p.namespace?.trim() || '') === namespace);
}

/**
 * What a shared template turns into on this machine: the existing personal profile when there is one
 * (so signing in twice never duplicates), else a new personal copy with its own id and no context.
 */
export function personalProfileFromTemplate(profiles: K8sProfile[], template: K8sProfile): K8sProfile {
  const existing = findMatchingProfile(profiles, template);
  if (existing) return existing;
  return {
    id: newProfileId(),
    name: template.name,
    server: template.server,
    insecureSkipTlsVerify: template.insecureSkipTlsVerify,
    namespace: template.namespace,
  };
}

/** A personal profile as a shareable template: no kubeconfig context, usage stamp or tombstone. */
export function templateFromProfile(profile: K8sProfile): K8sProfile {
  return {
    id: profile.id,
    name: profile.name,
    server: profile.server,
    insecureSkipTlsVerify: profile.insecureSkipTlsVerify,
    namespace: profile.namespace,
  };
}
