import { parseAdHocTarget } from '../components/ConnectionModal/connectionGrouping';

export interface ParsedSearch {
  /** Words that must each fuzzy-match some field of an entry. */
  terms: string[];
  /** `#tag` filters, lower-cased and without the `#`: each must match one of the entry's tags. */
  tags: string[];
  /** Set when the whole input is `user@host[:port]`: the palette then offers a one-off connection. */
  adHoc: { username: string; host: string; port?: number } | null;
  /** True when the input starts with `>`: the palette lists actions instead of profiles and tabs. */
  actionMode: boolean;
  empty: boolean;
}

/** Splits the palette's input into words, `#tag` filters, a possible quick-connect target and the `>` action mode. */
export function parseSearchQuery(raw: string): ParsedSearch {
  let trimmed = raw.trim();
  const actionMode = trimmed.startsWith('>');
  if (actionMode) trimmed = trimmed.slice(1).trim();
  const terms: string[] = [];
  const tags: string[] = [];
  for (const token of trimmed.split(/\s+/)) {
    if (token === '') continue;
    if (token.startsWith('#')) {
      const tag = token.replace(/^#+/, '').toLowerCase();
      if (tag !== '') tags.push(tag);
    } else {
      terms.push(token);
    }
  }
  return {
    terms,
    tags,
    adHoc: actionMode ? null : parseAdHocTarget(trimmed),
    actionMode,
    empty: terms.length === 0 && tags.length === 0,
  };
}
