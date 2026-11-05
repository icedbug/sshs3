import { parseStoredK8sProfile } from '../ipc/ipcHelpers';
import type { K8sProfile } from '../../shared/types/kubernetes';

/** What a profile looks like on the wire: `contextName` names a kubeconfig entry of this machine only. */
function withoutContextName(profile: K8sProfile): K8sProfile {
  const { contextName: _contextName, ...rest } = profile;
  return rest;
}

/**
 * A remote profile that wins a merge replaces the local one outright, so a field cleared on the other
 * machine (the project, say) is cleared here too. Only `contextName` stays: it names a kubeconfig entry
 * of this machine and is never part of what is synced.
 */
export function replaceKeepingContext(local: K8sProfile, remote: K8sProfile): K8sProfile {
  return local.contextName ? { ...remote, contextName: local.contextName } : remote;
}

export interface K8sProfilesPayload {
  profiles: K8sProfile[];
}

export function toSyncPayload(profiles: K8sProfile[]): K8sProfilesPayload {
  return { profiles: profiles.map(withoutContextName) };
}

/**
 * Validates profiles received from the remote. Entries that do not validate are dropped, and the
 * kubeconfig context name is never accepted, so a tampered remote cannot point a profile at an
 * existing local context. A remote winning a merge replaces the local record but keeps its
 * `contextName` (see replaceKeepingContext).
 */
export function fromRemotePayload(raw: unknown): K8sProfile[] {
  const entries: unknown[] = Array.isArray((raw as K8sProfilesPayload | null)?.profiles)
    ? (raw as K8sProfilesPayload).profiles
    : [];
  const profiles: K8sProfile[] = [];
  for (const entry of entries) {
    try {
      profiles.push(withoutContextName(parseStoredK8sProfile(entry)));
    } catch {
      // Drop an entry that fails validation.
    }
  }
  return profiles;
}
