import { fuzzyMatch } from './fuzzyMatch';
import type { SearchEntry } from './globalSearchIndex';
import type { ParsedSearch } from './searchQuery';

export interface SearchResult {
  entry: SearchEntry;
  score: number;
  /** Matched character positions in the entry's title, for highlighting (empty when only another field matched). */
  titleIndices: number[];
}

// Added to a word's fuzzy score by the field it matched in: a name match beats the same-quality match in the host or folder.
const FIELD_BONUS = { title: 2, tags: 1.6, system: 1.4, subtitle: 1.2, group: 1, source: 0.6 };

function byRecency(a: SearchEntry, b: SearchEntry): number {
  return (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? '');
}

function hasTag(entry: SearchEntry, tag: string): boolean {
  return entry.tags.some((t) => t.toLowerCase().includes(tag));
}

/** The best score a word reaches in any field of the entry, or null when it matches none. */
function matchWord(word: string, entry: SearchEntry): { score: number; titleIndices: number[] } | null {
  let best: { score: number; titleIndices: number[] } | null = null;
  const consider = (text: string | undefined, bonus: number, isTitle: boolean) => {
    if (!text) return;
    const match = fuzzyMatch(word, text);
    if (!match) return;
    const score = match.score + bonus;
    if (!best || score > best.score) best = { score, titleIndices: isTitle ? match.indices : [] };
  };
  consider(entry.title, FIELD_BONUS.title, true);
  consider(entry.tags.join(' '), FIELD_BONUS.tags, false);
  consider(entry.system, FIELD_BONUS.system, false);
  consider(entry.subtitle, FIELD_BONUS.subtitle, false);
  consider(entry.group, FIELD_BONUS.group, false);
  consider(entry.sourceLabel, FIELD_BONUS.source, false);
  return best;
}

/** Entries matching every word and every `#tag` of `query`, best first (ties: most recently used, then name). */
export function searchEntries(entries: SearchEntry[], query: ParsedSearch): SearchResult[] {
  const results: SearchResult[] = [];
  for (const entry of entries) {
    if (!query.tags.every((tag) => hasTag(entry, tag))) continue;
    let score = 0;
    const highlighted = new Set<number>();
    let matched = true;
    for (const word of query.terms) {
      const hit = matchWord(word, entry);
      if (!hit) {
        matched = false;
        break;
      }
      score += hit.score;
      hit.titleIndices.forEach((i) => highlighted.add(i));
    }
    if (matched) results.push({ entry, score, titleIndices: [...highlighted].sort((a, b) => a - b) });
  }
  return results.sort(
    (a, b) => b.score - a.score || byRecency(a.entry, b.entry) || a.entry.title.localeCompare(b.entry.title)
  );
}

/** Profiles opened most recently, newest first. Profiles never opened (and tabs) are left out. */
export function recentEntries(entries: SearchEntry[], limit: number): SearchEntry[] {
  return entries
    .filter((e) => e.kind !== 'tab' && e.lastUsedAt)
    .sort(byRecency)
    .slice(0, limit);
}
