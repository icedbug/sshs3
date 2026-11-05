import { normalizeTags } from '@shared/tags';

/**
 * A folder name or path as typed: each `/`-separated segment trimmed, empty ones dropped.
 * `undefined` means "no folder" (blank input).
 */
export function normalizeFolderName(raw: string): string | undefined {
  const path = raw
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '')
    .join('/');
  return path === '' ? undefined : path;
}

/**
 * Copies of the chosen profiles moved to `group` (`undefined`: out of their folder). Only the ones
 * that actually change are returned, so nothing is saved, and no Team Vault revision is bumped,
 * for a profile that is already there.
 */
export function withGroup<T extends { id: string; group?: string }>(
  profiles: readonly T[],
  ids: ReadonlySet<string>,
  group: string | undefined
): T[] {
  const moved: T[] = [];
  for (const profile of profiles) {
    if (!ids.has(profile.id) || profile.group === group) continue;
    const { group: _old, ...rest } = profile;
    moved.push((group === undefined ? rest : { ...rest, group }) as T);
  }
  return moved;
}

/**
 * Copies of the chosen profiles with `tags` added to the ones they already have (cleaned, deduped
 * ignoring case and sorted like every saved tag list). Profiles whose tags would not change, for
 * example because they have them all or are at the limit, are left out.
 */
export function withAddedTags<T extends { id: string; tags?: string[] }>(
  profiles: readonly T[],
  ids: ReadonlySet<string>,
  tags: readonly string[]
): T[] {
  const changed: T[] = [];
  for (const profile of profiles) {
    if (!ids.has(profile.id)) continue;
    const merged = normalizeTags([...(profile.tags ?? []), ...tags]);
    if (!merged) continue;
    const had = new Set((profile.tags ?? []).map((t) => t.toLowerCase()));
    if (merged.every((t) => had.has(t.toLowerCase()))) continue; // nothing new would be added
    changed.push({ ...profile, tags: merged });
  }
  return changed;
}
