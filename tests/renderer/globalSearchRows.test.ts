import { describe, it, expect } from 'vitest';
import { buildPaletteGroups, nextFilter, splitHighlight, type PaletteRow } from '../../src/renderer/src/lib/globalSearchRows';
import type { SearchEntry } from '../../src/renderer/src/lib/globalSearchIndex';

const profile = (id: string, over: Partial<SearchEntry> = {}): SearchEntry => ({
  id: `ssh:personal:${id}`,
  kind: 'ssh',
  title: id,
  subtitle: `u@${id}.example.com`,
  tags: [],
  source: 'personal',
  ref: id,
  sftp: true,
  ...over,
});
const tab = (id: string, title: string): SearchEntry => ({
  id: `tab:${id}`,
  kind: 'tab',
  title,
  subtitle: 'Terminal',
  tags: [],
  source: '',
  ref: id,
  sftp: false,
});

const labels = (groups: ReturnType<typeof buildPaletteGroups>) => groups.map((g) => g.label);
const keys = (rows: PaletteRow[]) => rows.map((r) => r.key);
const base = { locked: [], filter: 'all' as const };

describe('buildPaletteGroups', () => {
  const entries = [
    profile('web-01', { lastUsedAt: '2026-10-29 10:00' }),
    profile('db-01', { lastUsedAt: '2026-10-28 10:00' }),
    profile('old'),
    { ...profile('assets'), id: 's3:personal:assets', kind: 's3' as const, sftp: false },
    tab('t1', 'Web One'),
  ];

  it('shows recent profiles and the open tabs when nothing is typed', () => {
    const groups = buildPaletteGroups({ ...base, entries, query: '' });
    expect(labels(groups)).toEqual(['Recent', 'Open tabs']);
    expect(keys(groups[0].rows)).toEqual(['ssh:personal:web-01', 'ssh:personal:db-01']);
    expect(keys(groups[1].rows)).toEqual(['tab:t1']);
  });

  it('groups matches into profiles and open tabs, best match first', () => {
    const groups = buildPaletteGroups({ ...base, entries, query: 'web' });
    expect(labels(groups)).toEqual(['Profiles', 'Open tabs']);
    expect(keys(groups[0].rows)).toEqual(['ssh:personal:web-01']);
    expect(keys(groups[1].rows)).toEqual(['tab:t1']);
  });

  it('finds S3 profiles among the profiles and passes the highlight positions on', () => {
    const [group] = buildPaletteGroups({ ...base, entries, query: 'ass' });
    const row = group.rows[0];
    expect(row).toMatchObject({ type: 'entry', key: 's3:personal:assets', titleIndices: [0, 1, 2] });
  });

  it('limits each group', () => {
    const many = Array.from({ length: 12 }, (_, i) => profile(`node-${String(i).padStart(2, '0')}`));
    const [group] = buildPaletteGroups({ ...base, entries: many, query: 'node', perGroup: 5 });
    expect(group.rows).toHaveLength(5);
  });

  it('filters by #tag, with no word needed', () => {
    const tagged = [profile('a', { tags: ['prod'] }), profile('b', { tags: ['dev'] })];
    const [group] = buildPaletteGroups({ ...base, entries: tagged, query: '#prod' });
    expect(keys(group.rows)).toEqual(['ssh:personal:a']);
  });

  it('offers a quick connection first when the input is user@host', () => {
    const groups = buildPaletteGroups({ ...base, entries, query: 'alice@web1:2222' });
    expect(labels(groups)[0]).toBe('Quick connect');
    expect(groups[0].rows[0]).toMatchObject({
      type: 'adhoc',
      target: { username: 'alice', host: 'web1', port: 2222 },
    });
  });

  it('restricts the list to one kind with the filter', () => {
    expect(labels(buildPaletteGroups({ ...base, entries, query: '', filter: 'tabs' }))).toEqual(['Open tabs']);
    expect(labels(buildPaletteGroups({ ...base, entries, query: 'web', filter: 'profiles' }))).toEqual(['Profiles']);
  });

  it('does not offer quick connect when only open tabs are shown', () => {
    const groups = buildPaletteGroups({ ...base, entries, query: 'alice@web1', filter: 'tabs' });
    expect(labels(groups)).not.toContain('Quick connect');
  });

  describe('locked Team Vaults', () => {
    const locked = [{ vaultId: 'v1', name: 'Prod - Team' }];

    it('are listed when nothing is typed, so their profiles are not silently missing', () => {
      const groups = buildPaletteGroups({ ...base, locked, entries, query: '' });
      expect(labels(groups)).toContain('Locked Team Vaults');
      const row = groups[groups.length - 1].rows[0];
      expect(row).toMatchObject({ type: 'locked', vault: { vaultId: 'v1', name: 'Prod - Team' } });
    });

    it('are listed when a search finds no profile', () => {
      const groups = buildPaletteGroups({ ...base, locked, entries, query: 'zzz' });
      expect(labels(groups)).toEqual(['Locked Team Vaults']);
    });

    it('stay out of the way when a search found profiles', () => {
      expect(labels(buildPaletteGroups({ ...base, locked, entries, query: 'web' }))).not.toContain('Locked Team Vaults');
    });

    it('are not listed when only open tabs are shown', () => {
      expect(labels(buildPaletteGroups({ ...base, locked, entries, query: '', filter: 'tabs' }))).toEqual(['Open tabs']);
    });
  });

  it('returns no groups when there is nothing to show', () => {
    expect(buildPaletteGroups({ ...base, entries: [], query: '' })).toEqual([]);
    expect(buildPaletteGroups({ ...base, entries, query: 'zzz' })).toEqual([]);
  });
});

describe('buildPaletteGroups in action mode', () => {
  const action = (ref: string, title: string): SearchEntry => ({
    id: `action:${ref}`,
    kind: 'action',
    title,
    subtitle: 'Ctrl+Shift+X',
    tags: [],
    source: '',
    ref,
    sftp: false,
  });
  const actions = [action('newTerminal', 'New Terminal'), action('openSettings', 'Settings'), action('newWindow', 'New Window')];
  const entries = [profile('web-01', { lastUsedAt: '2026-10-29 10:00' }), tab('t1', 'Web One')];
  const base = { entries, actions, locked: [{ vaultId: 'v', name: 'Team' }], filter: 'all' as const };

  it('lists every action for a lone >', () => {
    const groups = buildPaletteGroups({ ...base, query: '>' });
    expect(labels(groups)).toEqual(['Actions']);
    expect(keys(groups[0].rows)).toEqual(['action:newTerminal', 'action:openSettings', 'action:newWindow']);
  });

  it('narrows the actions with the words after the >', () => {
    const groups = buildPaletteGroups({ ...base, query: '>new' });
    expect(keys(groups[0].rows).sort()).toEqual(['action:newTerminal', 'action:newWindow']);
    expect(keys(buildPaletteGroups({ ...base, query: '>sett' })[0].rows)).toEqual(['action:openSettings']);
  });

  it('shows no group at all when no action matches', () => {
    expect(buildPaletteGroups({ ...base, query: '>zzz' })).toEqual([]);
  });

  it('shows profiles, tabs, quick connect and locked vaults in no other mode, and the actions only here', () => {
    const groups = buildPaletteGroups({ ...base, query: '>web' });
    expect(labels(groups)).not.toContain('Profiles');
    expect(labels(groups)).not.toContain('Open tabs');
    expect(labels(groups)).not.toContain('Locked Team Vaults');
    expect(labels(buildPaletteGroups({ ...base, query: 'new' }))).not.toContain('Actions');
    expect(labels(buildPaletteGroups({ ...base, query: '' }))).not.toContain('Actions');
  });

  it('ignores the type filter, since the actions are not profiles or tabs', () => {
    expect(labels(buildPaletteGroups({ ...base, query: '>', filter: 'tabs' }))).toEqual(['Actions']);
  });
});

describe('nextFilter', () => {
  it('cycles all, profiles, open tabs and back', () => {
    expect(nextFilter('all')).toBe('profiles');
    expect(nextFilter('profiles')).toBe('tabs');
    expect(nextFilter('tabs')).toBe('all');
  });
});

describe('splitHighlight', () => {
  it('returns the whole text as one plain piece when nothing is highlighted', () => {
    expect(splitHighlight('web-01', [])).toEqual([{ text: 'web-01', hit: false }]);
  });

  it('merges neighbouring matched characters into one highlighted piece', () => {
    expect(splitHighlight('web-01', [0, 1, 2, 5])).toEqual([
      { text: 'web', hit: true },
      { text: '-0', hit: false },
      { text: '1', hit: true },
    ]);
  });

  it('cuts by characters, so an emoji or a combined letter is never split', () => {
    expect(splitHighlight('😀ab', [1])).toEqual([
      { text: '😀', hit: false },
      { text: 'a', hit: true },
      { text: 'b', hit: false },
    ]);
  });

  it('returns nothing for an empty text', () => {
    expect(splitHighlight('', [0])).toEqual([]);
  });
});
