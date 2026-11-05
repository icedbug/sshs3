import { describe, it, expect } from 'vitest';
import { fuzzyMatch } from '../../src/renderer/src/lib/fuzzyMatch';

const score = (query: string, text: string) => fuzzyMatch(query, text)?.score ?? null;

describe('fuzzyMatch', () => {
  it('matches an empty query against anything, with no highlighted characters', () => {
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, indices: [] });
  });

  it('returns null when the query is not a subsequence of the text', () => {
    expect(fuzzyMatch('xyz', 'web-01')).toBeNull();
    expect(fuzzyMatch('10w', 'web-01')).toBeNull();
    expect(fuzzyMatch('longer than the text', 'short')).toBeNull();
  });

  it('is case-insensitive and reports the matched positions', () => {
    expect(fuzzyMatch('WEB', 'web-01')?.indices).toEqual([0, 1, 2]);
    expect(fuzzyMatch('w1', 'web-01')?.indices).toEqual([0, 5]);
  });

  it('prefers a prefix over a match in the middle of a word', () => {
    expect(score('web', 'web-01')!).toBeGreaterThan(score('web', 'cobweb')!);
  });

  it('prefers a match at a word boundary over one inside a word', () => {
    expect(score('db', 'prod-db')!).toBeGreaterThan(score('db', 'oddball')!);
    expect(score('db', 'my.db.host')!).toBeGreaterThan(score('db', 'sudbury')!);
  });

  it('prefers consecutive characters over scattered ones', () => {
    expect(score('prod', 'prod-web')!).toBeGreaterThan(score('prod', 'p-r-o-d')!);
  });

  it('prefers a shorter text when the match is otherwise equal', () => {
    expect(score('web', 'web')!).toBeGreaterThan(score('web', 'web-server-in-the-datacenter')!);
  });

  it('matches letters outside ASCII, ignoring case', () => {
    expect(fuzzyMatch('ål', 'Älvsjö-Ålen')?.indices).toEqual([7, 8]);
    expect(fuzzyMatch('ÄLV', 'älvsjö')?.indices).toEqual([0, 1, 2]);
  });

  it('counts positions in characters, not UTF-16 units, so highlights stay aligned', () => {
    expect(fuzzyMatch('b', '😀b')?.indices).toEqual([1]);
  });

  it('gives up on very long texts instead of scanning them', () => {
    expect(fuzzyMatch('a', 'a'.repeat(1000))).toBeNull();
  });
});
