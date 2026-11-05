import { describe, it, expect } from 'vitest';
import { normalizeFolderName, withAddedTags, withGroup } from '../../src/renderer/src/lib/bulkProfileEdit';

interface P {
  id: string;
  group?: string;
  tags?: string[];
}

describe('normalizeFolderName', () => {
  it('trims the name and each segment of a path, and drops empty segments', () => {
    expect(normalizeFolderName('  Prod  ')).toBe('Prod');
    expect(normalizeFolderName(' Acme Infra / Cluster A ')).toBe('Acme Infra/Cluster A');
    expect(normalizeFolderName('a//b/')).toBe('a/b');
  });

  it('means "no folder" for blank input', () => {
    expect(normalizeFolderName('')).toBeUndefined();
    expect(normalizeFolderName('   ')).toBeUndefined();
    expect(normalizeFolderName(' / ')).toBeUndefined();
  });
});

describe('withGroup', () => {
  const profiles: P[] = [
    { id: 'a', group: 'Old' },
    { id: 'b' },
    { id: 'c', group: 'Prod' },
  ];

  it('returns changed copies of the chosen profiles only', () => {
    const changed = withGroup(profiles, new Set(['a', 'b']), 'Prod');
    expect(changed).toEqual([
      { id: 'a', group: 'Prod' },
      { id: 'b', group: 'Prod' },
    ]);
  });

  it('skips profiles that are already in the folder, so nothing is saved for them', () => {
    expect(withGroup(profiles, new Set(['c']), 'Prod')).toEqual([]);
    expect(withGroup(profiles, new Set(['b']), undefined)).toEqual([]);
  });

  it('takes profiles out of their folder when the folder is undefined, removing the key', () => {
    const [moved] = withGroup(profiles, new Set(['a']), undefined);
    expect(moved).toEqual({ id: 'a' });
    expect('group' in moved).toBe(false);
  });

  it('does not touch the originals', () => {
    withGroup(profiles, new Set(['a']), 'New');
    expect(profiles[0].group).toBe('Old');
  });

  it('ignores ids that are not in the list', () => {
    expect(withGroup(profiles, new Set(['zzz']), 'Prod')).toEqual([]);
  });

  it('keeps every other field of the profile', () => {
    const rich = [{ id: 'a', name: 'Web', host: 'h', tags: ['x'], group: 'Old' }];
    expect(withGroup(rich, new Set(['a']), 'New')[0]).toEqual({ id: 'a', name: 'Web', host: 'h', tags: ['x'], group: 'New' });
  });
});

describe('withAddedTags', () => {
  const profiles: P[] = [
    { id: 'a', tags: ['web'] },
    { id: 'b' },
    { id: 'c', tags: ['prod', 'db'] },
  ];

  it('adds the tags to the chosen profiles, merged and sorted with the ones they have', () => {
    const changed = withAddedTags(profiles, new Set(['a', 'b']), ['Prod']);
    expect(changed).toEqual([
      { id: 'a', tags: ['Prod', 'web'] },
      { id: 'b', tags: ['Prod'] },
    ]);
  });

  it('cleans what is typed: a leading #, case-only duplicates and invalid tags', () => {
    const [changed] = withAddedTags(profiles, new Set(['b']), ['#Prod', 'prod', 'two words']);
    expect(changed.tags).toEqual(['Prod']);
  });

  it('skips profiles that already carry every tag, ignoring case', () => {
    expect(withAddedTags(profiles, new Set(['c']), ['PROD'])).toEqual([]);
  });

  it('changes nothing when no valid tag is given', () => {
    expect(withAddedTags(profiles, new Set(['a']), [])).toEqual([]);
    expect(withAddedTags(profiles, new Set(['a']), ['bad tag'])).toEqual([]);
  });

  it('does not exceed the tag limit: the profile keeps what it has, then the new ones fill up to ten', () => {
    const full = [{ id: 'f', tags: Array.from({ length: 10 }, (_, i) => `t${i}`) }];
    expect(withAddedTags(full, new Set(['f']), ['extra'])).toEqual([]);
  });

  it('does not touch the originals', () => {
    withAddedTags(profiles, new Set(['a']), ['x']);
    expect(profiles[0].tags).toEqual(['web']);
  });
});
