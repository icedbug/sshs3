import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SSHConnectionConfig } from '@shared/types/ssh';
import type { S3Config } from '@shared/types/storage';
import { buildProfileEntries, buildTabEntries, type SearchEntry } from './globalSearchIndex';
import { loadSearchSources, type LoadedSearchSources } from './globalSearchSources';
import { systemMembersOf } from './systemGrouping';
import type { AppTab } from './tabs';

export interface SearchProfile {
  ssh?: SSHConnectionConfig;
  s3?: S3Config;
  /** The servers of a system entry. */
  members?: SSHConnectionConfig[];
}

/**
 * Everything the global search palette can find, read once when the palette mounts (it is mounted
 * only while open, so profiles are never loaded at startup or kept in a cache that could go stale).
 * Open tabs are indexed live from `tabs`. The full profiles stay inside this hook: entries carry no
 * secrets, and `getProfile` turns one back into the profile to connect with.
 */
export function useGlobalSearchIndex(tabs: AppTab[]) {
  const [loaded, setLoaded] = useState<LoadedSearchSources | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadSearchSources(window.multissh).then((result) => {
      if (!cancelled) setLoaded(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const profileEntries = useMemo(() => (loaded ? buildProfileEntries(loaded.sources) : []), [loaded]);
  const tabEntries = useMemo(() => buildTabEntries(tabs), [tabs]);
  const entries = useMemo(() => [...profileEntries, ...tabEntries], [profileEntries, tabEntries]);

  const getProfile = useCallback(
    (entry: SearchEntry): SearchProfile => {
      const source = loaded?.sources.find((s) => s.source === entry.source);
      if (!source) return {};
      if (entry.kind === 'ssh') {
        const ssh = source.ssh.find((p) => p.id === entry.ref);
        return ssh ? { ssh } : {};
      }
      if (entry.kind === 'system') {
        const members = systemMembersOf(source.ssh, entry.ref);
        return members.length > 0 ? { members } : {};
      }
      if (entry.kind === 's3') {
        const s3 = source.s3.find((p) => p.id === entry.ref);
        return s3 ? { s3 } : {};
      }
      return {};
    },
    [loaded]
  );

  return { entries, locked: loaded?.locked ?? [], loading: loaded === null, getProfile };
}
