// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBulkProfileEdit } from '../../src/renderer/src/lib/useBulkProfileEdit';

interface P {
  id: string;
  name: string;
  group?: string;
  tags?: string[];
  system?: { name: string; startDirectory?: string };
}

const profiles: P[] = [
  { id: 'a', name: 'A', group: 'Old' },
  { id: 'b', name: 'B' },
  { id: 'c', name: 'C', group: 'Prod' },
];

function setup(list: P[] = profiles, over: Partial<{ save: (p: P) => Promise<void>; reload: () => Promise<void>; onError: (m: string) => void; allProfiles: P[] }> = {}) {
  const save = over.save ?? vi.fn().mockResolvedValue(undefined);
  const reload = over.reload ?? vi.fn().mockResolvedValue(undefined);
  const onError = over.onError ?? vi.fn();
  const hook = renderHook(({ items }) => useBulkProfileEdit<P>({ profiles: items, allProfiles: over.allProfiles, save, reload, onError }), {
    initialProps: { items: list },
  });
  return { ...hook, save: save as ReturnType<typeof vi.fn>, reload: reload as ReturnType<typeof vi.fn>, onError: onError as ReturnType<typeof vi.fn> };
}

describe('useBulkProfileEdit selection', () => {
  it('starts empty and toggles a profile on and off', () => {
    const { result } = setup();
    expect(result.current.count).toBe(0);
    act(() => result.current.toggle('a'));
    expect(result.current.isSelected('a')).toBe(true);
    expect(result.current.count).toBe(1);
    act(() => result.current.toggle('a'));
    expect(result.current.isSelected('a')).toBe(false);
    expect(result.current.count).toBe(0);
  });

  it('clears the selection', () => {
    const { result } = setup();
    act(() => {
      result.current.toggle('a');
      result.current.toggle('b');
    });
    expect(result.current.count).toBe(2);
    act(() => result.current.clear());
    expect(result.current.count).toBe(0);
  });

  it('forgets a selected profile that is no longer in the list (deleted, or another tab)', () => {
    const { result, rerender } = setup();
    act(() => {
      result.current.toggle('a');
      result.current.toggle('b');
    });
    rerender({ items: profiles.filter((p) => p.id !== 'a') });
    expect(result.current.count).toBe(1);
    expect(result.current.isSelected('a')).toBe(false);
    expect(result.current.isSelected('b')).toBe(true);
  });
});

describe('useBulkProfileEdit moveTo', () => {
  it('saves each selected profile that changes, in order, then reloads and clears the selection', async () => {
    const order: string[] = [];
    const save = vi.fn(async (p: P) => {
      order.push(p.id);
    });
    const { result, reload } = setup(profiles, { save });
    act(() => {
      result.current.toggle('a');
      result.current.toggle('b');
      result.current.toggle('c');
    });
    await act(async () => {
      await result.current.moveTo(' Prod ');
    });
    expect(save.mock.calls.map(([p]) => p)).toEqual([
      { id: 'a', name: 'A', group: 'Prod' },
      { id: 'b', name: 'B', group: 'Prod' },
    ]);
    expect(order).toEqual(['a', 'b']);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(result.current.count).toBe(0);
    expect(result.current.notice).toBe('Moved 2 profiles to "Prod".');
  });

  it('takes the profiles out of their folder for a blank name', async () => {
    const { result, save } = setup();
    act(() => result.current.toggle('a'));
    await act(async () => {
      await result.current.moveTo('  ');
    });
    expect(save).toHaveBeenCalledWith({ id: 'a', name: 'A' });
    expect(result.current.notice).toBe('Moved 1 profile out of its folder.');
  });

  it('says "their" folder when several profiles were taken out', async () => {
    const list: P[] = [{ id: 'a', name: 'A', group: 'X' }, { id: 'b', name: 'B', group: 'Y' }];
    const { result } = setup(list);
    act(() => {
      result.current.toggle('a');
      result.current.toggle('b');
    });
    await act(async () => {
      await result.current.moveTo('');
    });
    expect(result.current.notice).toBe('Moved 2 profiles out of their folder.');
  });

  it('says so, and keeps the selection, when nothing needs to move', async () => {
    const { result, save, reload } = setup();
    act(() => result.current.toggle('c'));
    await act(async () => {
      await result.current.moveTo('Prod');
    });
    expect(save).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(result.current.count).toBe(1);
    expect(result.current.notice).toBe('Already in "Prod".');
  });

  it('stops at the first failure, reports it, reloads what did change and keeps the selection to try again', async () => {
    const save = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('vault is locked'));
    const { result, reload, onError } = setup(profiles, { save });
    act(() => {
      result.current.toggle('a');
      result.current.toggle('b');
    });
    await act(async () => {
      await result.current.moveTo('Prod');
    });
    expect(save).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('vault is locked'));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(result.current.count).toBe(2);
    expect(result.current.notice).toBeNull();
  });

  it('reports the failure after the reload, since reloading usually clears the error that is showing', async () => {
    const order: string[] = [];
    const save = vi.fn().mockRejectedValue(new Error('boom'));
    const reload = vi.fn(async () => {
      order.push('reload');
    });
    const onError = vi.fn(() => {
      order.push('error');
    });
    const { result } = setup(profiles, { save, reload, onError });
    act(() => result.current.toggle('b'));
    await act(async () => {
      await result.current.moveTo('Prod');
    });
    expect(order).toEqual(['reload', 'error']);
  });

  it('does nothing without a selection', async () => {
    const { result, save } = setup();
    await act(async () => {
      await result.current.moveTo('Prod');
    });
    expect(save).not.toHaveBeenCalled();
  });

  it('ignores a second request while one is running', async () => {
    let release: () => void = () => {};
    const save = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const { result } = setup(profiles, { save });
    act(() => result.current.toggle('a'));
    let first: Promise<void> = Promise.resolve();
    act(() => {
      first = result.current.moveTo('Prod');
    });
    expect(result.current.busy).toBe(true);
    await act(async () => {
      await result.current.moveTo('Other');
    });
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => {
      release();
      await first;
    });
    expect(result.current.busy).toBe(false);
  });
});

describe('useBulkProfileEdit addTags', () => {
  it('saves the profile as it is stored, not as it is drawn, so a tags change leaves the folder alone', async () => {
    const stored: P[] = [{ id: 'a', name: 'A', group: 'Stray' }];
    const drawn: P[] = [{ id: 'a', name: 'A', group: 'Prod' }];
    const { result, save } = setup(drawn, { allProfiles: stored });
    act(() => result.current.toggle('a'));
    await act(async () => {
      await result.current.addTags(['prod']);
    });
    expect(save.mock.calls.map(([p]) => p)).toEqual([{ id: 'a', name: 'A', group: 'Stray', tags: ['prod'] }]);
  });

  it('adds the tags to every selected profile that lacks them, then reloads and clears', async () => {
    const list: P[] = [{ id: 'a', name: 'A', tags: ['web'] }, { id: 'b', name: 'B' }];
    const { result, save, reload } = setup(list);
    act(() => {
      result.current.toggle('a');
      result.current.toggle('b');
    });
    await act(async () => {
      await result.current.addTags(['prod']);
    });
    expect(save.mock.calls.map(([p]) => p)).toEqual([
      { id: 'a', name: 'A', tags: ['prod', 'web'] },
      { id: 'b', name: 'B', tags: ['prod'] },
    ]);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(result.current.count).toBe(0);
    expect(result.current.notice).toBe('Added tags to 2 profiles.');
  });

  it('says so when every selected profile already has them', async () => {
    const list: P[] = [{ id: 'a', name: 'A', tags: ['prod'] }];
    const { result, save } = setup(list);
    act(() => result.current.toggle('a'));
    await act(async () => {
      await result.current.addTags(['prod']);
    });
    expect(save).not.toHaveBeenCalled();
    expect(result.current.notice).toBe('They already have those tags.');
  });

  it('reports a failed save and keeps the selection', async () => {
    const save = vi.fn().mockRejectedValue(new Error('boom'));
    const list: P[] = [{ id: 'a', name: 'A' }];
    const { result, onError } = setup(list, { save });
    act(() => result.current.toggle('a'));
    await act(async () => {
      await result.current.addTags(['prod']);
    });
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('boom'));
    expect(result.current.count).toBe(1);
  });
});

describe('useBulkProfileEdit notice', () => {
  it('goes away when the selection changes', async () => {
    const { result } = setup();
    act(() => result.current.toggle('c'));
    await act(async () => {
      await result.current.moveTo('Prod');
    });
    expect(result.current.notice).not.toBeNull();
    act(() => result.current.toggle('a'));
    expect(result.current.notice).toBeNull();
  });
});

describe('useBulkProfileEdit with systems', () => {
  const all: P[] = [
    { id: 'a', name: 'A', group: 'Prod', system: { name: 'Shop' } },
    { id: 'b', name: 'B', group: 'Prod', system: { name: 'shop' } },
    { id: 'c', name: 'C', group: 'Prod' },
    { id: 'd', name: 'D' },
  ];

  it('moves every server of a system when one of its servers is moved, also ones the search hides', async () => {
    const visible = all.filter((p) => p.id !== 'b');
    const { result, save } = setup(visible, { allProfiles: all });
    act(() => result.current.toggle('a'));
    await act(async () => {
      await result.current.moveTo('Elsewhere');
    });
    expect(save.mock.calls.map(([p]) => [p.id, p.group])).toEqual([
      ['a', 'Elsewhere'],
      ['b', 'Elsewhere'],
    ]);
    expect(result.current.notice).toBe('Moved 2 profiles to "Elsewhere".');
  });

  it('moves a profile that is in no system on its own', async () => {
    const { result, save } = setup(all, { allProfiles: all });
    act(() => result.current.toggle('c'));
    await act(async () => {
      await result.current.moveTo('Elsewhere');
    });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('groups the selected profiles into a system in the folder given', async () => {
    const { result, save } = setup(all, { allProfiles: all });
    act(() => {
      result.current.toggle('c');
      result.current.toggle('d');
    });
    await act(async () => {
      await result.current.groupAsSystem(' Blog ', ' Content ');
    });
    expect(save.mock.calls.map(([p]) => [p.id, p.group, p.system?.name])).toEqual([
      ['c', 'Content', 'Blog'],
      ['d', 'Content', 'Blog'],
    ]);
    expect(result.current.notice).toBe('Grouped 2 profiles into "Blog".');
    expect(result.current.count).toBe(0);
  });

  it('puts the profiles into the folder of an existing system when no folder is given', async () => {
    const { result, save } = setup(all, { allProfiles: all });
    act(() => result.current.toggle('d'));
    await act(async () => {
      await result.current.groupAsSystem('Shop', '');
    });
    expect(save.mock.calls[0][0]).toMatchObject({ id: 'd', group: 'Prod', system: { name: 'Shop' } });
  });

  it('refuses a name that is not a valid system name', async () => {
    const { result, save } = setup(all, { allProfiles: all });
    act(() => result.current.toggle('c'));
    await act(async () => {
      await result.current.groupAsSystem('   ', 'X');
    });
    expect(save).not.toHaveBeenCalled();
    expect(result.current.notice).toBe('Enter a name for the system.');
    expect(result.current.count).toBe(1);
  });

  it('says so when everything is already in the system and its folder', async () => {
    const { result, save } = setup(all, { allProfiles: all });
    act(() => result.current.toggle('a'));
    await act(async () => {
      await result.current.groupAsSystem('Shop', 'Prod');
    });
    expect(save).not.toHaveBeenCalled();
    expect(result.current.notice).toBe('Already in "Shop".');
  });

  it('reports a failed save and keeps the selection', async () => {
    const save = vi.fn().mockRejectedValue(new Error('boom'));
    const { result, onError } = setup(all, { allProfiles: all, save });
    act(() => result.current.toggle('c'));
    await act(async () => {
      await result.current.groupAsSystem('Blog', 'X');
    });
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('boom'));
    expect(result.current.count).toBe(1);
  });
});
