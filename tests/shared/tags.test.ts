import { describe, it, expect } from 'vitest';
import { MAX_TAGS, MAX_TAG_LENGTH, collectTags, normalizeTag, normalizeTags, withNormalizedTags } from '../../src/shared/tags';

describe('collectTags', () => {
  it('lists every tag in use once (case-insensitive, first spelling), sorted', () => {
    const profiles = [{ tags: ['web', 'Prod'] }, {}, { tags: ['prod', 'db'] }, { tags: undefined }];
    expect(collectTags(profiles)).toEqual(['db', 'Prod', 'web']);
  });

  it('returns an empty list when nothing is tagged', () => {
    expect(collectTags([{}, { tags: [] }])).toEqual([]);
    expect(collectTags([])).toEqual([]);
  });
});

describe('withNormalizedTags', () => {
  it('returns the same object when the record has no tags key', () => {
    const profile: { id: string; name: string; tags?: string[] } = { id: 'a', name: 'A' };
    expect(withNormalizedTags(profile)).toBe(profile);
  });

  it('cleans the tags and drops the key when nothing valid is left', () => {
    expect(withNormalizedTags({ id: 'a', tags: ['#b', 'A'] })).toEqual({ id: 'a', tags: ['A', 'b'] });
    expect('tags' in withNormalizedTags({ id: 'a', tags: ['bad tag'] })).toBe(false);
  });

  it('does not mutate its input', () => {
    const profile = { id: 'a', tags: ['#b', 'A'] };
    withNormalizedTags(profile);
    expect(profile.tags).toEqual(['#b', 'A']);
  });
});

describe('normalizeTag', () => {
  it('trims and strips leading # characters', () => {
    expect(normalizeTag('  #prod ')).toBe('prod');
    expect(normalizeTag('##db')).toBe('db');
  });

  it('keeps the original casing and allows letters, digits and . _ : / -', () => {
    expect(normalizeTag('Prod-EU')).toBe('Prod-EU');
    expect(normalizeTag('team/web_1.a:b')).toBe('team/web_1.a:b');
    expect(normalizeTag('åäö')).toBe('åäö');
  });

  it('rejects empty, non-string, whitespace-containing and over-long values', () => {
    expect(normalizeTag('')).toBeNull();
    expect(normalizeTag('#')).toBeNull();
    expect(normalizeTag('two words')).toBeNull();
    expect(normalizeTag(42)).toBeNull();
    expect(normalizeTag(null)).toBeNull();
    expect(normalizeTag('a'.repeat(MAX_TAG_LENGTH + 1))).toBeNull();
    expect(normalizeTag('a'.repeat(MAX_TAG_LENGTH))).toBe('a'.repeat(MAX_TAG_LENGTH));
  });

  it('rejects characters that could be abused in a filter or in markup', () => {
    expect(normalizeTag('<b>')).toBeNull();
    expect(normalizeTag('a,b')).toBeNull();
    expect(normalizeTag('-leading')).toBeNull();
  });
});

describe('normalizeTags', () => {
  it('returns undefined for anything that is not a non-empty array of valid tags', () => {
    expect(normalizeTags(undefined)).toBeUndefined();
    expect(normalizeTags(null)).toBeUndefined();
    expect(normalizeTags('prod')).toBeUndefined();
    expect(normalizeTags({ 0: 'prod' })).toBeUndefined();
    expect(normalizeTags([])).toBeUndefined();
    expect(normalizeTags(['', '  ', 5, null])).toBeUndefined();
  });

  it('dedupes case-insensitively, keeping the first spelling', () => {
    expect(normalizeTags(['Prod', 'prod', '#PROD', 'db'])).toEqual(['db', 'Prod']);
  });

  it('sorts deterministically (case-insensitive, then code point) regardless of input order', () => {
    const a = normalizeTags(['web', 'Db', 'prod', 'API']);
    const b = normalizeTags(['API', 'prod', 'web', 'Db']);
    expect(a).toEqual(['API', 'Db', 'prod', 'web']);
    expect(b).toEqual(a);
  });

  it('drops invalid entries but keeps the valid ones', () => {
    expect(normalizeTags(['prod', 'bad tag', 7, '#db'])).toEqual(['db', 'prod']);
  });

  it('keeps at most MAX_TAGS tags, taking them in input order before sorting', () => {
    const input = Array.from({ length: MAX_TAGS + 5 }, (_, i) => `t${String(i).padStart(2, '0')}`);
    const result = normalizeTags(input);
    expect(result).toHaveLength(MAX_TAGS);
    expect(result).toEqual(input.slice(0, MAX_TAGS));
  });

  it('is idempotent', () => {
    const once = normalizeTags(['#Web', 'db', 'web']);
    expect(normalizeTags(once)).toEqual(once);
  });
});
