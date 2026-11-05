import { describe, it, expect } from 'vitest';
import {
  defaultSystemFolder,
  expandToSystems,
  groupAsSystem,
  moveWithSystems,
  removeFromSystem,
  renameSystem,
  systemNameTaken,
  ungroupSystem,
} from '../../src/renderer/src/lib/systemEdit';
import type { SSHSystemMembership } from '../../src/shared/types/ssh';

interface P {
  id: string;
  name: string;
  group?: string;
  system?: SSHSystemMembership;
}

const p = (id: string, name: string, group?: string, system?: SSHSystemMembership): P => ({
  id,
  name,
  ...(group !== undefined ? { group } : {}),
  ...(system ? { system } : {}),
});

const profiles: P[] = [
  p('1', 'web', 'Prod', { name: 'Shop', startDirectory: '/srv' }),
  p('2', 'db', 'Prod', { name: 'shop', shell: false }),
  p('3', 'blog', 'Prod'),
  p('4', 'api', 'Stage', { name: 'Api' }),
];

describe('expandToSystems', () => {
  it('adds every other server of the systems the selected servers belong to', () => {
    expect([...expandToSystems(profiles, new Set(['1']))].sort()).toEqual(['1', '2']);
  });

  it('leaves profiles outside any system as they are', () => {
    expect([...expandToSystems(profiles, new Set(['3']))]).toEqual(['3']);
  });

  it('does not add anything for an id that is not in the list', () => {
    expect([...expandToSystems(profiles, new Set(['zzz']))]).toEqual(['zzz']);
  });
});

describe('moveWithSystems', () => {
  it('moves the whole system when one of its servers is moved', () => {
    const moved = moveWithSystems(profiles, new Set(['1']), 'Other');
    expect(moved.map((x) => [x.id, x.group])).toEqual([
      ['1', 'Other'],
      ['2', 'Other'],
    ]);
  });

  it('moves a plain profile on its own, and skips servers that are already there', () => {
    expect(moveWithSystems(profiles, new Set(['3']), 'Other').map((x) => x.id)).toEqual(['3']);
    expect(moveWithSystems(profiles, new Set(['1']), 'Prod')).toEqual([]);
  });

  it('can take a whole system out of its folder', () => {
    const moved = moveWithSystems(profiles, new Set(['2']), undefined);
    expect(moved.map((x) => 'group' in x)).toEqual([false, false]);
  });
});

describe('defaultSystemFolder', () => {
  it('is the folder of the system when it already exists', () => {
    expect(defaultSystemFolder(profiles, new Set(['3']), 'SHOP')).toBe('Prod');
  });

  it('is the folder most of the selected profiles are in when the system is new', () => {
    const list = [p('a', 'a', 'X'), p('b', 'b', 'Y'), p('c', 'c', 'Y')];
    expect(defaultSystemFolder(list, new Set(['a', 'b', 'c']), 'new')).toBe('Y');
  });

  it('is no folder when the selected profiles have none', () => {
    expect(defaultSystemFolder([p('a', 'a'), p('b', 'b')], new Set(['a', 'b']), 'new')).toBeUndefined();
  });
});

describe('groupAsSystem', () => {
  it('puts the selected profiles into the system and its folder', () => {
    const changed = groupAsSystem(profiles, new Set(['3', '4']), 'Shop', 'Prod');
    expect(changed.map((x) => [x.id, x.group, x.system?.name])).toEqual([
      ['3', 'Prod', 'Shop'],
      ['4', 'Prod', 'Shop'],
    ]);
  });

  it('keeps what a server already contributes when it stays in the same system', () => {
    const [changed] = groupAsSystem(profiles, new Set(['1']), 'shop', 'Elsewhere');
    expect(changed.system).toEqual({ name: 'Shop', startDirectory: '/srv' });
    expect(changed.group).toBe('Elsewhere');
  });

  it('starts a server that moves between systems with no start directory or tunnels of its own', () => {
    const [changed] = groupAsSystem(profiles, new Set(['4']), 'Shop', 'Prod');
    expect(changed.system).toEqual({ name: 'Shop' });
  });

  it('leaves out servers that would not change', () => {
    expect(groupAsSystem(profiles, new Set(['1', '2']), 'Shop', 'Prod')).toEqual([]);
  });

  it('moves the servers already in the system along, so the system stays in one folder', () => {
    const changed = groupAsSystem(profiles, new Set(['3']), 'Shop', 'Elsewhere');
    expect(changed.map((x) => [x.id, x.group])).toEqual([
      ['1', 'Elsewhere'],
      ['2', 'Elsewhere'],
      ['3', 'Elsewhere'],
    ]);
    expect(changed[0].system).toEqual({ name: 'Shop', startDirectory: '/srv' });
  });

  it('removes the folder when none is given', () => {
    const [changed] = groupAsSystem(profiles, new Set(['3']), 'Shop', undefined);
    expect('group' in changed).toBe(false);
  });
});

describe('ungroupSystem', () => {
  it('takes every server out of the system and leaves the rest of each profile', () => {
    const changed = ungroupSystem(profiles, 'shop');
    expect(changed).toEqual([p('1', 'web', 'Prod'), p('2', 'db', 'Prod')]);
    expect(changed.every((x) => !('system' in x))).toBe(true);
  });

  it('does nothing for a system that does not exist', () => {
    expect(ungroupSystem(profiles, 'nope')).toEqual([]);
  });
});

describe('removeFromSystem', () => {
  it('takes one server out of its system', () => {
    expect(removeFromSystem(profiles, '2')).toEqual([p('2', 'db', 'Prod')]);
  });

  it('does nothing for a profile that is in no system', () => {
    expect(removeFromSystem(profiles, '3')).toEqual([]);
    expect(removeFromSystem(profiles, 'zzz')).toEqual([]);
  });
});

describe('renameSystem', () => {
  it('gives every server the new name and keeps its other settings', () => {
    const changed = renameSystem(profiles, 'shop', 'Webshop');
    expect(changed.map((x) => x.system)).toEqual([{ name: 'Webshop', startDirectory: '/srv' }, { name: 'Webshop', shell: false }]);
  });

  it('does nothing when the name is blank or the same', () => {
    expect(renameSystem(profiles, 'shop', '   ')).toEqual([]);
    expect(renameSystem([p('1', 'a', undefined, { name: 'Shop' })], 'shop', ' Shop ')).toEqual([]);
  });

  it('can change only the capitalisation', () => {
    expect(renameSystem([p('1', 'a', undefined, { name: 'shop' })], 'shop', 'Shop')).toHaveLength(1);
  });
});

describe('renameSystem onto an existing system', () => {
  it('refuses a name another system already has, so two systems are not merged by accident', () => {
    expect(renameSystem(profiles, 'Api', 'SHOP')).toEqual([]);
    expect(systemNameTaken(profiles, 'Api', 'shop')).toBe(true);
  });

  it('allows a new name, and the same system under another capitalisation', () => {
    expect(systemNameTaken(profiles, 'shop', 'Webshop')).toBe(false);
    expect(systemNameTaken(profiles, 'shop', 'SHOP')).toBe(false);
  });
});

describe('malformed systems from sync or another version', () => {
  const odd = [
    { id: 'x', name: 'x', system: {} },
    { id: 'y', name: 'y', system: { name: 5 } },
    { id: 'z', name: 'z', system: { name: 'Shop' } },
  ] as unknown as P[];

  it('are profiles in no system, and do not throw', () => {
    expect(() => expandToSystems(odd, new Set(['x', 'y', 'z']))).not.toThrow();
    expect([...expandToSystems(odd, new Set(['x']))]).toEqual(['x']);
    expect(ungroupSystem(odd, 'Shop').map((r) => r.id)).toEqual(['z']);
    expect(renameSystem(odd, 'Shop', 'Webshop').map((r) => r.id)).toEqual(['z']);
    // z is already in Shop and in the right folder, so only x changes.
    expect(groupAsSystem(odd, new Set(['x']), 'Shop', undefined).map((r) => r.id)).toEqual(['x']);
  });
});
