import type { FileEntry } from '@shared/types/storage';
import { makeNameMatcher } from './nameFilter';

/** Everything in `entries` that is not currently selected. */
export function invertSelection(entries: FileEntry[], selected: ReadonlySet<string>): Set<string> {
  return new Set(entries.filter((e) => !selected.has(e.path)).map((e) => e.path));
}

/**
 * Paths of the entries whose own name matches `pattern` (same matcher as the filter box:
 * `*`/`?` globs the whole name, plain text matches as a substring). An empty pattern matches nothing,
 * unlike the filter box, so "select by pattern" with a blank field never selects everything.
 */
export function entriesMatchingPattern(entries: FileEntry[], pattern: string): string[] {
  if (!pattern.trim()) return [];
  const matches = makeNameMatcher(pattern);
  return entries.filter((e) => matches(e.name.slice(e.name.lastIndexOf('/') + 1))).map((e) => e.path);
}
