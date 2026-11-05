import { describe, it, expect } from 'vitest';
import { recentEntries, searchEntries } from '../../src/renderer/src/lib/globalSearch';
import { parseSearchQuery } from '../../src/renderer/src/lib/searchQuery';
import type { SearchEntry } from '../../src/renderer/src/lib/globalSearchIndex';

const entry = (id: string, over: Partial<SearchEntry> = {}): SearchEntry => ({
  id: `ssh:personal:${id}`,
  kind: 'ssh',
  title: id,
  subtitle: `deploy@${id}.example.com`,
  tags: [],
  source: 'personal',
  ref: id,
  sftp: true,
  ...over,
});

const ids = (query: string, entries: SearchEntry[]) =>
  searchEntries(entries, parseSearchQuery(query)).map((r) => r.entry.ref);

describe('searchEntries', () => {
  const entries = [
    entry('web-01', { tags: ['prod', 'web'], group: 'Prod/Web' }),
    entry('db-01', { tags: ['prod', 'db'], group: 'Prod/Database' }),
    entry('staging-web', { tags: ['staging', 'web'], group: 'Staging' }),
    entry('backup', { subtitle: 'root@storage.example.com', tags: [] }),
  ];

  it('returns nothing when no entry matches', () => {
    expect(ids('zzz', entries)).toEqual([]);
  });

  it('finds an entry by a fuzzy match on its name', () => {
    expect(ids('w01', entries)).toEqual(['web-01']);
    expect(ids('bkp', entries)).toEqual(['backup']);
  });

  it('finds an entry by host, folder or tag text too', () => {
    expect(ids('storage', entries)).toEqual(['backup']);
    expect(ids('database', entries)).toEqual(['db-01']);
    expect(ids('staging', entries)).toContain('staging-web');
  });

  it('finds a server by the name of its system, ranking its own name above that', () => {
    const list = [entry('billing-db'), entry('a1', { system: 'Billing' }), entry('zz')];
    expect(ids('billing', list)).toEqual(['billing-db', 'a1']);
  });

  it('requires every word to match somewhere', () => {
    expect(ids('web prod', entries)).toEqual(['web-01']);
    expect(ids('web nothing', entries)).toEqual([]);
  });

  it('ranks a name match above a match only in the folder or host', () => {
    const list = [
      entry('alpha', { group: 'web' }),
      entry('webserver', { group: 'Other' }),
    ];
    expect(ids('web', list)[0]).toBe('webserver');
  });

  it('ranks a match at the start of the name above one in the middle', () => {
    const list = [entry('cobweb'), entry('web-01')];
    expect(ids('web', list)).toEqual(['web-01', 'cobweb']);
  });

  it('filters on #tags (every tag must be present, partial text allowed) without needing a word', () => {
    expect(ids('#prod', entries).sort()).toEqual(['db-01', 'web-01']);
    expect(ids('#prod #db', entries)).toEqual(['db-01']);
    expect(ids('#pro', entries).sort()).toEqual(['db-01', 'web-01']);
    expect(ids('#nope', entries)).toEqual([]);
  });

  it('combines #tag filters with words', () => {
    expect(ids('#web staging', entries)).toEqual(['staging-web']);
  });

  it('puts the most recently used first when scores tie', () => {
    const list = [
      entry('a', { title: 'node', lastUsedAt: '2026-10-01 10:00' }),
      entry('b', { title: 'node', lastUsedAt: '2026-10-29 09:00' }),
      entry('c', { title: 'node' }),
    ];
    expect(ids('node', list)).toEqual(['b', 'a', 'c']);
  });

  it('reports which characters of the title matched, for highlighting', () => {
    const [result] = searchEntries([entry('web-01')], parseSearchQuery('w01'));
    expect(result.titleIndices).toEqual([0, 4, 5]);
  });

  it('reports no highlight when the match was in another field', () => {
    const [result] = searchEntries([entry('backup')], parseSearchQuery('example'));
    expect(result.titleIndices).toEqual([]);
  });

  it('returns every entry for an empty query, so callers decide what to show', () => {
    expect(ids('', entries)).toHaveLength(entries.length);
  });
});

describe('recentEntries', () => {
  it('lists the most recently used profiles first, limited, and skips never-used and tab entries', () => {
    const list = [
      entry('old', { lastUsedAt: '2026-09-01 08:00' }),
      entry('never'),
      entry('new', { lastUsedAt: '2026-10-29 09:00' }),
      entry('mid', { lastUsedAt: '2026-10-01 10:00' }),
      entry('tab', { kind: 'tab', lastUsedAt: '2026-10-30 10:00' }),
    ];
    expect(recentEntries(list, 2).map((e) => e.ref)).toEqual(['new', 'mid']);
  });
});
