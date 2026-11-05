import { recentEntries, searchEntries } from './globalSearch';
import type { SearchEntry } from './globalSearchIndex';
import type { LockedVault } from './globalSearchSources';
import { parseSearchQuery } from './searchQuery';

export type PaletteFilter = 'all' | 'profiles' | 'tabs';

export type PaletteRow =
  | { type: 'adhoc'; key: string; target: { username: string; host: string; port?: number } }
  | { type: 'entry'; key: string; entry: SearchEntry; titleIndices: number[] }
  | { type: 'locked'; key: string; vault: LockedVault };

export interface PaletteGroup {
  label: string;
  rows: PaletteRow[];
}

const DEFAULT_PER_GROUP = 8;
const RECENT_COUNT = 5;

const FILTER_ORDER: PaletteFilter[] = ['all', 'profiles', 'tabs'];

export function nextFilter(filter: PaletteFilter): PaletteFilter {
  return FILTER_ORDER[(FILTER_ORDER.indexOf(filter) + 1) % FILTER_ORDER.length];
}

/**
 * What the palette lists for the current input: with nothing typed, the most recent profiles and
 * the open tabs; otherwise the matches split into profiles and tabs, best first. A `user@host`
 * input adds a quick-connect row on top, and locked Team Vaults are mentioned when they could be
 * hiding what the user is looking for (nothing typed, or no profile matched).
 */
export function buildPaletteGroups(args: {
  entries: SearchEntry[];
  /** Actions (new tab, settings, ...), listed only when the input starts with `>`. */
  actions?: SearchEntry[];
  locked: LockedVault[];
  query: string;
  filter: PaletteFilter;
  perGroup?: number;
}): PaletteGroup[] {
  const { entries, actions = [], locked, query, filter, perGroup = DEFAULT_PER_GROUP } = args;
  const parsed = parseSearchQuery(query);

  if (parsed.actionMode) {
    const found = parsed.empty ? actions.map((entry) => ({ entry, titleIndices: [] as number[] })) : searchEntries(actions, parsed);
    const rows = found
      .slice(0, perGroup)
      .map((r): PaletteRow => ({ type: 'entry', key: r.entry.id, entry: r.entry, titleIndices: r.titleIndices }));
    return rows.length > 0 ? [{ label: 'Actions', rows }] : [];
  }

  const showProfiles = filter !== 'tabs';
  const showTabs = filter !== 'profiles';
  const groups: PaletteGroup[] = [];

  const entryRow = (entry: SearchEntry, titleIndices: number[] = []): PaletteRow => ({
    type: 'entry',
    key: entry.id,
    entry,
    titleIndices,
  });

  if (showProfiles && parsed.adHoc) {
    groups.push({
      label: 'Quick connect',
      rows: [{ type: 'adhoc', key: `adhoc:${query.trim()}`, target: parsed.adHoc }],
    });
  }

  const results = parsed.empty
    ? [
        ...recentEntries(entries, RECENT_COUNT),
        ...entries.filter((e) => e.kind === 'tab'),
      ].map((entry) => ({ entry, titleIndices: [] as number[] }))
    : searchEntries(entries, parsed);
  const rowsOf = (isTab: boolean, limit: number): PaletteRow[] =>
    results
      .filter((r) => (r.entry.kind === 'tab') === isTab)
      .slice(0, limit)
      .map((r) => entryRow(r.entry, r.titleIndices));
  const profileRows = rowsOf(false, parsed.empty ? RECENT_COUNT : perGroup);
  const tabRows = rowsOf(true, perGroup);
  if (showProfiles && profileRows.length > 0) groups.push({ label: parsed.empty ? 'Recent' : 'Profiles', rows: profileRows });
  if (showTabs && tabRows.length > 0) groups.push({ label: 'Open tabs', rows: tabRows });

  if (showProfiles && locked.length > 0 && (parsed.empty || profileRows.length === 0)) {
    groups.push({
      label: 'Locked Team Vaults',
      rows: locked.map((vault) => ({ type: 'locked', key: `locked:${vault.vaultId}`, vault })),
    });
  }
  return groups;
}

/** Cuts `text` into runs of matched / unmatched characters (`indices` count characters, as fuzzyMatch reports them). */
export function splitHighlight(text: string, indices: number[]): Array<{ text: string; hit: boolean }> {
  const hits = new Set(indices);
  const pieces: Array<{ text: string; hit: boolean }> = [];
  Array.from(text).forEach((ch, i) => {
    const hit = hits.has(i);
    const last = pieces[pieces.length - 1];
    if (last && last.hit === hit) last.text += ch;
    else pieces.push({ text: ch, hit });
  });
  return pieces;
}
