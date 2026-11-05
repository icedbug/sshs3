import type { SSHConnectionConfig } from '@shared/types/ssh';
import type { S3Config } from '@shared/types/storage';
import { systemNameOf } from '../../lib/systemGrouping';

export const UNGROUPED = 'Ungrouped';

/**
 * "user@host" or "user@host:port" typed into the search box (SSH tab) reads as ad-hoc
 * quick-connect intent rather than a filter.
 */
export function parseAdHocTarget(searchQuery: string): { username: string; host: string; port?: number } | null {
  const m = searchQuery.trim().match(/^([^\s@]+)@([^\s:@]+)(?::(\d{1,5}))?$/);
  if (!m) return null;
  return { username: m[1], host: m[2], port: m[3] ? parseInt(m[3], 10) : undefined };
}

/** True when a tag contains `query` (already lower-cased); a leading `#` is ignored, so "#prod" finds the tag "prod". */
function matchesTag(tags: string[] | undefined, query: string): boolean {
  const needle = query.replace(/^#/, '');
  return needle !== '' && !!tags?.some((tag) => tag.toLowerCase().includes(needle));
}

/** `query` is already trimmed and lower-cased. */
export function filterSshProfiles(profiles: SSHConnectionConfig[], query: string): SSHConnectionConfig[] {
  if (!query) return profiles;
  return profiles.filter(
    (p) =>
      p.name.toLowerCase().includes(query) ||
      p.host.toLowerCase().includes(query) ||
      p.username.toLowerCase().includes(query) ||
      (p.group && p.group.toLowerCase().includes(query)) ||
      (systemNameOf(p) ?? '').toLowerCase().includes(query) ||
      matchesTag(p.tags, query)
  );
}

/** `query` is already trimmed and lower-cased. */
export function filterS3Profiles(profiles: S3Config[], query: string): S3Config[] {
  if (!query) return profiles;
  return profiles.filter(
    (p) =>
      p.name.toLowerCase().includes(query) ||
      (p.endpoint && p.endpoint.toLowerCase().includes(query)) ||
      (p.region && p.region.toLowerCase().includes(query)) ||
      (p.initialPath && p.initialPath.toLowerCase().includes(query)) ||
      (p.group && p.group.toLowerCase().includes(query)) ||
      matchesTag(p.tags, query)
  );
}

/** Saved folders plus every group name used by a profile, sorted. */
export function collectFolderNames(folders: string[], ssh: SSHConnectionConfig[], s3: S3Config[]): string[] {
  const set = new Set<string>(folders);
  for (const p of ssh) {
    if (p.group?.trim()) set.add(p.group.trim());
  }
  for (const p of s3) {
    if (p.group?.trim()) set.add(p.group.trim());
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

/**
 * Folders are one flat, shared list on disk (SSH and S3 profiles both reference the same
 * `folders` string array) — so a folder created while organizing S3 buckets shows up, empty,
 * under SSH/SFTP too, and vice versa. Unless the user opts into sharing (Settings > Files &
 * Storage), scope each tab to folders that actually hold a profile of its own type; a brand-new
 * folder with no profiles anywhere yet still shows in both, since we can't know which type it's
 * "for" until something lands in it.
 */
export function folderNamesForTab(
  tab: 'ssh' | 's3',
  allFolderNames: string[],
  ssh: SSHConnectionConfig[],
  s3: S3Config[],
  shareFoldersAcrossTypes: boolean
): string[] {
  if (shareFoldersAcrossTypes) return allFolderNames;
  const counts = new Map<string, { ssh: number; s3: number }>();
  for (const name of allFolderNames) counts.set(name, { ssh: 0, s3: 0 });
  for (const p of ssh) {
    const g = p.group?.trim();
    if (!g) continue;
    const c = counts.get(g) ?? { ssh: 0, s3: 0 };
    c.ssh += 1;
    counts.set(g, c);
  }
  for (const p of s3) {
    const g = p.group?.trim();
    if (!g) continue;
    const c = counts.get(g) ?? { ssh: 0, s3: 0 };
    c.s3 += 1;
    counts.set(g, c);
  }
  return allFolderNames.filter((name) => {
    const c = counts.get(name);
    if (!c) return true;
    return tab === 'ssh' ? c.ssh > 0 || c.s3 === 0 : c.s3 > 0 || c.ssh === 0;
  });
}

/** [folder name, profiles] pairs for the list view; "Ungrouped" last, empty "Ungrouped" hidden. */
export function groupProfiles<T extends { group?: string }>(
  folderNames: string[],
  filtered: T[],
  query: string
): Array<[string, T[]]> {
  const groups: Record<string, T[]> = {};

  for (const f of folderNames) {
    if (!query || f.toLowerCase().includes(query)) {
      groups[f] = [];
    }
  }
  groups[UNGROUPED] = [];

  for (const p of filtered) {
    const g = p.group?.trim() || UNGROUPED;
    if (!groups[g]) groups[g] = [];
    groups[g].push(p);
  }

  return Object.entries(groups)
    .filter(([name, list]) => {
      if (query) return list.length > 0 || name.toLowerCase().includes(query);
      if (name === UNGROUPED && list.length === 0) return false;
      return true;
    })
    .sort(([a], [b]) => {
      if (a === UNGROUPED) return 1;
      if (b === UNGROUPED) return -1;
      return a.localeCompare(b);
    });
}

/** The `limit` most recently connected profiles. */
export function mostRecentlyUsed<T extends { lastUsedAt?: string }>(profiles: T[], limit = 3): T[] {
  return [...profiles]
    .filter((p) => Boolean(p.lastUsedAt))
    .sort((a, b) => (b.lastUsedAt || '').localeCompare(a.lastUsedAt || ''))
    .slice(0, limit);
}
