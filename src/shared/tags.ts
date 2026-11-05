/** Most tags a profile can carry; extra ones are dropped. */
export const MAX_TAGS = 10;
/** Longest allowed tag, in characters. */
export const MAX_TAG_LENGTH = 32;

// Starts with a letter or digit, then letters, digits and . _ : / - (no whitespace, commas or markup).
const TAG_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._:/-]*$/u;

/** One user-typed tag: trimmed, leading `#` removed. Null when it is not a valid tag. */
export function normalizeTag(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const tag = raw.trim().replace(/^#+/, '');
  if (tag.length === 0 || tag.length > MAX_TAG_LENGTH) return null;
  return TAG_PATTERN.test(tag) ? tag : null;
}

// Not localeCompare: the order is part of the synced record, so it must be identical on every device.
function compareTags(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la !== lb) return la < lb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Cleans an untrusted `tags` value from the UI, an import file, a sync payload or a Team Vault:
 * invalid entries are dropped, duplicates (case-insensitive) keep their first spelling, at most
 * MAX_TAGS are kept (in input order), and the result is sorted so the same set always serializes
 * identically. Returns undefined when nothing valid is left, so callers can omit the field.
 */
export function normalizeTags(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of raw) {
    const tag = normalizeTag(item);
    if (tag === null) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length === MAX_TAGS) break;
  }
  return tags.length > 0 ? tags.sort(compareTags) : undefined;
}

/** Every tag in use across `profiles`, once each (case-insensitive, first spelling wins), sorted. */
export function collectTags(profiles: ReadonlyArray<{ tags?: string[] }>): string[] {
  const seen = new Map<string, string>();
  for (const profile of profiles) {
    for (const tag of profile.tags ?? []) {
      const key = tag.toLowerCase();
      if (!seen.has(key)) seen.set(key, tag);
    }
  }
  return Array.from(seen.values()).sort(compareTags);
}

/**
 * A copy of a profile with its `tags` cleaned (key removed when nothing valid is left). A record
 * without a `tags` key is returned as is, so save paths that never touch tags stay byte-identical.
 */
export function withNormalizedTags<T extends { tags?: string[] }>(profile: T): T {
  if (!('tags' in profile)) return profile;
  const { tags, ...rest } = profile;
  const clean = normalizeTags(tags);
  return (clean ? { ...rest, tags: clean } : rest) as T;
}
