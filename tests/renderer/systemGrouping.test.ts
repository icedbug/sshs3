import { describe, it, expect } from 'vitest';
import { alignSystemMembers, groupBySystem, systemMembersOf, systemNames } from '../../src/renderer/src/lib/systemGrouping';
import type { SSHSystemMembership } from '../../src/shared/types/ssh';

interface P {
  id: string;
  name: string;
  group?: string;
  system?: SSHSystemMembership;
}

const p = (id: string, name: string, system?: string, group?: string): P => ({
  id,
  name,
  ...(group !== undefined ? { group } : {}),
  ...(system !== undefined ? { system: { name: system } } : {}),
});

describe('groupBySystem', () => {
  it('splits the profiles into systems and loose ones, keeping the loose ones in order', () => {
    const profiles = [p('1', 'web-1', 'shop'), p('2', 'solo'), p('3', 'db-1', 'shop'), p('4', 'other')];
    const { systems, loose } = groupBySystem(profiles);
    expect(systems).toHaveLength(1);
    expect(systems[0].name).toBe('shop');
    expect(loose.map((x) => x.id)).toEqual(['2', '4']);
  });

  it('lists a system\'s servers by name', () => {
    const { systems } = groupBySystem([p('1', 'web-2', 'shop'), p('2', 'db-1', 'shop'), p('3', 'web-1', 'shop')]);
    expect(systems[0].members.map((m) => m.name)).toEqual(['db-1', 'web-1', 'web-2']);
  });

  it('puts servers whose system names differ only in case into one system, named after the first server by name', () => {
    const { systems } = groupBySystem([p('1', 'b', 'SHOP'), p('2', 'a', 'shop')]);
    expect(systems).toHaveLength(1);
    expect(systems[0].name).toBe('shop');
    expect(systems[0].members).toHaveLength(2);
  });

  it('orders several systems by name', () => {
    const { systems } = groupBySystem([p('1', 'x', 'zeta'), p('2', 'y', 'alpha')]);
    expect(systems.map((s) => s.name)).toEqual(['alpha', 'zeta']);
  });

  it('puts a system in the folder most of its servers are in', () => {
    const { systems } = groupBySystem([p('1', 'a', 'shop', 'Stray'), p('2', 'b', 'shop', 'Prod'), p('3', 'c', 'shop', 'Prod')]);
    expect(systems[0].folder).toBe('Prod');
  });

  it('settles a tie with the folder of the first server by name', () => {
    const { systems } = groupBySystem([p('1', 'web-2', 'shop', 'Other'), p('2', 'web-1', 'shop', 'Prod')]);
    expect(systems[0].folder).toBe('Prod');
  });

  it('is not pulled out of its folder by a single server that has none', () => {
    const { systems } = groupBySystem([p('1', 'a', 'shop'), p('2', 'b', 'shop', 'Prod'), p('3', 'c', 'shop', 'Prod')]);
    expect(systems[0].folder).toBe('Prod');
  });

  it('has no folder when the first server has none', () => {
    expect(groupBySystem([p('1', 'a', 'shop')]).systems[0].folder).toBeUndefined();
  });

  it('is empty for no profiles', () => {
    expect(groupBySystem([])).toEqual({ systems: [], loose: [] });
  });

  it('treats a profile with a blank system name as loose', () => {
    const odd = { id: '1', name: 'x', system: { name: '   ' } } as P;
    expect(groupBySystem([odd]).loose).toEqual([odd]);
  });
});

describe('alignSystemMembers', () => {
  it('moves every server of a system into the system\'s folder, for drawing', () => {
    const profiles = [p('1', 'web-1', 'shop', 'Prod'), p('2', 'web-2', 'shop', 'Stray'), p('3', 'db', 'shop'), p('4', 'web-3', 'shop', 'Prod')];
    const aligned = alignSystemMembers(profiles);
    expect(aligned.map((x) => x.group)).toEqual(['Prod', 'Prod', 'Prod', 'Prod']);
  });

  it('returns the very same objects for servers already in place and for loose profiles', () => {
    const inPlace = p('1', 'web-1', 'shop', 'Prod');
    const loose = p('2', 'solo', undefined, 'Elsewhere');
    const [a, b] = alignSystemMembers([inPlace, loose]);
    expect(a).toBe(inPlace);
    expect(b).toBe(loose);
  });

  it('removes the folder from servers when most of the system has none, and keeps the original order', () => {
    const aligned = alignSystemMembers([p('1', 'z', 'shop'), p('2', 'a', 'shop', 'Stray'), p('3', 'm', 'shop')]);
    expect(aligned.map((x) => x.id)).toEqual(['1', '2', '3']);
    expect(aligned.map((x) => 'group' in x)).toEqual([false, false, false]);
  });

  it('does not touch the originals', () => {
    const profiles = [p('1', 'a', 'shop', 'Prod'), p('2', 'b', 'shop', 'Stray')];
    alignSystemMembers(profiles);
    expect(profiles[1].group).toBe('Stray');
  });
});

describe('systemNames and systemMembersOf', () => {
  const profiles = [p('1', 'a', 'Shop'), p('2', 'b', 'shop'), p('3', 'c', 'blog'), p('4', 'd')];

  it('lists each system once, sorted, for suggestions', () => {
    expect(systemNames(profiles)).toEqual(['blog', 'Shop']);
  });

  it('finds the servers of a system by name, ignoring case', () => {
    expect(systemMembersOf(profiles, 'SHOP').map((m) => m.id)).toEqual(['1', '2']);
    expect(systemMembersOf(profiles, 'nope')).toEqual([]);
  });
});

describe('malformed memberships', () => {
  const odd = [
    { id: '1', name: 'a', system: {} },
    { id: '2', name: 'b', system: { name: 7 } },
    { id: '3', name: 'c', system: { name: 'shop' } },
  ] as unknown as P[];

  it('count as no system and do not throw', () => {
    const { systems, loose } = groupBySystem(odd);
    expect(systems.map((s) => s.name)).toEqual(['shop']);
    expect(loose.map((x) => x.id)).toEqual(['1', '2']);
    expect(() => alignSystemMembers(odd)).not.toThrow();
    expect(systemMembersOf(odd, 'shop').map((x) => x.id)).toEqual(['3']);
    expect(systemNames(odd)).toEqual(['shop']);
  });
});
