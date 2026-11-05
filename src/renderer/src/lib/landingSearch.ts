import type { SSHConnectionConfig } from '@shared/types/ssh';
import { searchEntries } from './globalSearch';
import { buildProfileEntries } from './globalSearchIndex';
import { parseSearchQuery } from './searchQuery';

export interface LandingMatch {
  profile: SSHConnectionConfig;
  /** Matched character positions in the profile name, for highlighting. */
  titleIndices: number[];
}

/**
 * Saved SSH profiles matching the landing page's quick-connect text, best first. Uses the same
 * fuzzy engine as the global search (Ctrl+Shift+G): several words, `#tag` filters and a ranking by
 * field, so the first match, which Enter connects to, is the best one.
 */
export function searchLandingProfiles(profiles: SSHConnectionConfig[], raw: string, limit: number): LandingMatch[] {
  const parsed = parseSearchQuery(raw);
  if (parsed.empty) return [];
  const entries = buildProfileEntries([{ source: 'personal', ssh: profiles, s3: [] }]);
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const matches: LandingMatch[] = [];
  for (const result of searchEntries(entries, parsed)) {
    const profile = byId.get(result.entry.ref);
    if (profile) matches.push({ profile, titleIndices: result.titleIndices });
    if (matches.length >= limit) break;
  }
  return matches;
}
