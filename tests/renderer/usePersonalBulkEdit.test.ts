// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePersonalBulkEdit } from '../../src/renderer/src/lib/usePersonalBulkEdit';

const ssh = [
  { id: 's1', name: 'web', group: 'Old' },
  { id: 's2', name: 'db' },
];
const s3 = [{ id: 'b1', name: 'assets' }];

function setup(over: Partial<Parameters<typeof usePersonalBulkEdit>[0]> = {}) {
  const profilesSaveSSH = vi.fn().mockResolvedValue(undefined);
  const profilesSaveS3 = vi.fn().mockResolvedValue(undefined);
  (window as unknown as { multissh: unknown }).multissh = { profilesSaveSSH, profilesSaveS3 };
  const reload = vi.fn().mockResolvedValue(undefined);
  const onError = vi.fn();
  const hook = renderHook(
    (props: Parameters<typeof usePersonalBulkEdit>[0]) => usePersonalBulkEdit(props),
    {
      initialProps: {
        tab: 'ssh',
        source: 'personal',
        open: true,
        sshProfiles: ssh as never,
        s3Profiles: s3 as never,
        sshFolders: ['Old', 'Prod'],
        s3Folders: ['Buckets'],
        reload,
        onError,
        ...over,
      } as Parameters<typeof usePersonalBulkEdit>[0],
    }
  );
  return { ...hook, profilesSaveSSH, profilesSaveS3, reload, onError };
}

afterEach(() => {
  delete (window as unknown as { multissh?: unknown }).multissh;
});

describe('usePersonalBulkEdit', () => {
  it('selects in the list of the active tab and offers that tab\'s folders', () => {
    const { result } = setup();
    expect(result.current.barProps.folderSuggestions).toEqual(['Old', 'Prod']);
    act(() => result.current.ssh.toggle('s1'));
    expect(result.current.barProps.count).toBe(1);
    expect(result.current.ssh.rowSelect('s1')).toMatchObject({ checked: true, anyChecked: true });
    expect(result.current.ssh.rowSelect('s2')).toMatchObject({ checked: false, anyChecked: true });
  });

  it('shows the S3 list and folders on the S3 tab', () => {
    const { result } = setup({ tab: 's3' });
    expect(result.current.barProps.folderSuggestions).toEqual(['Buckets']);
    act(() => result.current.s3.toggle('b1'));
    expect(result.current.barProps.count).toBe(1);
  });

  it('moves the selected SSH profiles through the personal store and reloads', async () => {
    const { result, profilesSaveSSH, reload } = setup();
    act(() => result.current.ssh.toggle('s2'));
    await act(async () => {
      result.current.barProps.onMove('Prod');
    });
    expect(profilesSaveSSH).toHaveBeenCalledWith({ id: 's2', name: 'db', group: 'Prod' });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('saves S3 profiles through the S3 store', async () => {
    const { result, profilesSaveS3, profilesSaveSSH } = setup({ tab: 's3' });
    act(() => result.current.s3.toggle('b1'));
    await act(async () => {
      result.current.barProps.onAddTags(['archive']);
    });
    expect(profilesSaveS3).toHaveBeenCalledWith({ id: 'b1', name: 'assets', tags: ['archive'] });
    expect(profilesSaveSSH).not.toHaveBeenCalled();
  });

  it('forgets the selection when the tab is switched, a team is chosen, or the dialog is reopened', () => {
    const { result, rerender } = setup();
    const base = {
      tab: 'ssh',
      source: 'personal',
      open: true,
      sshProfiles: ssh as never,
      s3Profiles: s3 as never,
      sshFolders: [],
      s3Folders: [],
      reload: vi.fn(),
      onError: vi.fn(),
    } as Parameters<typeof usePersonalBulkEdit>[0];

    act(() => result.current.ssh.toggle('s1'));
    rerender({ ...base, tab: 's3' });
    expect(result.current.ssh.rowSelect('s1').checked).toBe(false);

    rerender({ ...base, tab: 'ssh' });
    act(() => result.current.ssh.toggle('s1'));
    rerender({ ...base, source: 'vault-1' });
    expect(result.current.ssh.rowSelect('s1').checked).toBe(false);

    rerender({ ...base, source: 'personal' });
    act(() => result.current.ssh.toggle('s1'));
    rerender({ ...base, open: false });
    rerender({ ...base, open: true });
    expect(result.current.ssh.rowSelect('s1').checked).toBe(false);
  });

  it('reports a failed save through onError', async () => {
    const { result, profilesSaveSSH, onError } = setup();
    profilesSaveSSH.mockRejectedValue(new Error('disk full'));
    act(() => result.current.ssh.toggle('s2'));
    await act(async () => {
      result.current.barProps.onMove('Prod');
    });
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('disk full'));
  });

  it('forgets selected profiles that the search filter hides, and remembers them when they come back', () => {
    const { result, rerender } = setup();
    act(() => result.current.ssh.toggle('s1'));
    act(() => result.current.ssh.toggle('s2'));
    const base = {
      tab: 'ssh',
      source: 'personal',
      open: true,
      s3Profiles: s3 as never,
      sshFolders: [],
      s3Folders: [],
      reload: vi.fn(),
      onError: vi.fn(),
    };
    rerender({ ...base, sshProfiles: [ssh[1]] as never } as Parameters<typeof usePersonalBulkEdit>[0]);
    expect(result.current.barProps.count).toBe(1);
    rerender({ ...base, sshProfiles: ssh as never } as Parameters<typeof usePersonalBulkEdit>[0]);
    expect(result.current.barProps.count).toBe(2);
  });

  it('offers "Group as system" on the SSH tab only, with the names of the existing systems', () => {
    const withSystem = [
      { id: 's1', name: 'web', system: { name: 'Shop' } },
      { id: 's2', name: 'db' },
    ];
    const { result, rerender } = setup({ sshProfiles: withSystem as never, allSshProfiles: withSystem as never });
    expect(result.current.barProps.systemSuggestions).toEqual(['Shop']);
    expect(typeof result.current.barProps.onGroupAsSystem).toBe('function');
    rerender({
      tab: 's3',
      source: 'personal',
      open: true,
      sshProfiles: withSystem as never,
      allSshProfiles: withSystem as never,
      s3Profiles: s3 as never,
      sshFolders: [],
      s3Folders: [],
      reload: vi.fn(),
      onError: vi.fn(),
    } as Parameters<typeof usePersonalBulkEdit>[0]);
    expect(result.current.barProps.onGroupAsSystem).toBeUndefined();
    expect(result.current.barProps.systemSuggestions).toBeUndefined();
  });

  it('groups the selected SSH profiles into a system through the personal store', async () => {
    const { result, profilesSaveSSH, reload } = setup();
    act(() => result.current.ssh.toggle('s2'));
    await act(async () => {
      result.current.barProps.onGroupAsSystem?.('Shop', 'Prod');
    });
    expect(profilesSaveSSH).toHaveBeenCalledWith({ id: 's2', name: 'db', group: 'Prod', system: { name: 'Shop' } });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('moves a whole system when one of its servers is moved, also servers a search hides', async () => {
    const all = [
      { id: 's1', name: 'web', group: 'Old', system: { name: 'Shop' } },
      { id: 's2', name: 'db', group: 'Old', system: { name: 'Shop' } },
    ];
    const { result, profilesSaveSSH } = setup({ sshProfiles: [all[0]] as never, allSshProfiles: all as never });
    act(() => result.current.ssh.toggle('s1'));
    await act(async () => {
      result.current.barProps.onMove('Prod');
    });
    expect(profilesSaveSSH.mock.calls.map(([p]) => p.id)).toEqual(['s1', 's2']);
  });
});
