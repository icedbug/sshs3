import { parseStoredK8sProfile } from '../ipc/ipcHelpers';
import type { K8sProfile } from '../../shared/types/kubernetes';

/**
 * A K8s profile as it is shared in a Team Vault: a template (server, project, TLS option) with no secret.
 * `contextName` and `lastUsedAt` describe one member's machine, and a tombstone has no meaning in a vault
 * (an entry is simply removed), so none of them are kept. Throws when the profile does not validate.
 */
export function toTeamK8sProfile(raw: unknown): K8sProfile {
  const { contextName: _contextName, lastUsedAt: _lastUsedAt, deletedAt: _deletedAt, ...rest } =
    parseStoredK8sProfile(raw);
  return rest;
}

/** Reads the payload's `k8s` field: absent on a vault written before it existed, and entries that fail validation are dropped. */
export function normalizeK8sList(raw: unknown): K8sProfile[] {
  if (!Array.isArray(raw)) return [];
  const byId = new Map<string, K8sProfile>();
  for (const entry of raw) {
    try {
      const profile = toTeamK8sProfile(entry);
      byId.set(profile.id, profile);
    } catch {
      // Drop an entry that fails validation.
    }
  }
  return Array.from(byId.values());
}

/** Adds or replaces by id, stamping `updatedAt`. */
export function upsertK8sProfile(list: K8sProfile[], incoming: K8sProfile, now: string): K8sProfile[] {
  const stamped: K8sProfile = { ...toTeamK8sProfile(incoming), updatedAt: now };
  const index = list.findIndex((p) => p.id === stamped.id);
  if (index < 0) return [...list, stamped];
  return list.map((p, i) => (i === index ? stamped : p));
}

export function removeK8sProfile(list: K8sProfile[], id: string): K8sProfile[] {
  return list.filter((p) => p.id !== id);
}
