// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTabActions } from '../../src/renderer/src/lib/useTabActions';
import type { AppTab } from '../../src/renderer/src/lib/tabs';
import { DEFAULT_SETTINGS } from '../../src/shared/types/settings';

function setup(tabs: AppTab[], confirm: (o: unknown) => Promise<boolean> = vi.fn().mockResolvedValue(true), notify?: (message: string) => void) {
  const setTabs = vi.fn();
  const setActiveTabId = vi.fn();
  const setConnectTarget = vi.fn();
  const setProfilesModalOpen = vi.fn();
  const { result } = renderHook(() =>
    useTabActions({
      tabs,
      activeTabId: tabs[0].id,
      settings: DEFAULT_SETTINGS,
      localHostname: 'host',
      setTabs,
      setActiveTabId,
      setTabBarFocused: vi.fn(),
      setConnectTarget,
      setProfilesModalOpen,
      confirm,
      notify,
    })
  );
  return { result, setTabs, setActiveTabId, setConnectTarget, setProfilesModalOpen };
}

describe('useTabActions handleCloseTab', () => {
  const tabs = [
    { id: 'a', type: 'editor', title: 'notes.md', isDirty: true } as AppTab,
    { id: 'b', type: 'terminal', title: 'b' } as AppTab,
  ];

  it('asks once, naming the file, and keeps a dirty tab when the user cancels', async () => {
    const confirm = vi.fn().mockResolvedValue(false);
    const { result, setTabs } = setup(tabs, confirm);
    await act(async () => {
      await result.current.handleCloseTab('a');
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toMatchObject({
      message: 'Discard your unsaved changes to notes.md?',
      confirmLabel: 'Discard changes',
      cancelLabel: 'Keep editing',
    });
    expect(setTabs).not.toHaveBeenCalled();
  });

  it('closes the dirty tab once the user discards, and never confirms from inside the state updater', async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    const { result, setTabs } = setup(tabs, confirm);
    await act(async () => {
      await result.current.handleCloseTab('a');
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    const updater = setTabs.mock.calls[0][0] as (prev: AppTab[]) => AppTab[];
    const prev = [{ id: 'a' }, { id: 'b' }] as AppTab[];
    updater(prev);
    updater(prev);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('closes a clean tab without asking', async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    const { result, setTabs } = setup(tabs, confirm);
    await act(async () => {
      await result.current.handleCloseTab('b');
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(setTabs).toHaveBeenCalledTimes(1);
  });
});

describe('useTabActions handleConnectS3', () => {
  it('opens a file manager tab focused on the S3 profile', () => {
    const { result, setTabs } = setup([{ id: 'a', type: 'terminal', title: 'a' } as AppTab]);
    const profile = { id: 'b1', name: 'Archive' } as any;
    act(() => result.current.handleConnectS3(profile));
    const updater = setTabs.mock.calls[0][0] as (prev: AppTab[]) => AppTab[];
    const next = updater([]);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ type: 'filemanager', title: 'Archive (S3)', initialS3Config: profile });
  });
});

describe('useTabActions open a profile in a tab (Connection Manager)', () => {
  const sshConfig = { id: 'p1', name: 'Prod', host: 'prod.example.com', username: 'u', authType: 'password' } as any;
  const k8sTarget = { contextName: 'ctx', namespace: 'ns', podName: 'web-1', containerName: 'app' } as any;
  const emptyTerminal = { id: 't1', type: 'terminal', title: 'Terminal 1', paneTree: { type: 'leaf', id: 'l1' } } as AppTab;
  const connectedTerminal = {
    id: 't1',
    type: 'terminal',
    title: 'other',
    paneTree: { type: 'leaf', id: 'l1', config: { id: 'x', name: 'other' } },
  } as unknown as AppTab;
  const fileManager = { id: 't1', type: 'filemanager', title: 'Files' } as AppTab;

  const applyTabs = (setTabs: ReturnType<typeof vi.fn>, prev: AppTab[]) =>
    (setTabs.mock.calls[0][0] as (p: AppTab[]) => AppTab[])(prev);

  describe('handleOpenSSHInTab', () => {
    it('connects in place when the active tab is an empty terminal, and closes the modal', () => {
      const { result, setTabs, setActiveTabId, setProfilesModalOpen, setConnectTarget } = setup([emptyTerminal]);
      act(() => result.current.handleOpenSSHInTab(sshConfig));

      const next = applyTabs(setTabs, [emptyTerminal]);
      expect(next).toHaveLength(1);
      expect(next[0]).toMatchObject({ id: 't1', title: 'Prod', paneTree: { config: sshConfig, local: false, baseHost: 'prod.example.com' } });
      expect(setActiveTabId).not.toHaveBeenCalled();
      expect(setConnectTarget).toHaveBeenCalledWith(null);
      expect(setProfilesModalOpen).toHaveBeenCalledWith(false);
    });

    it.each([
      ['a connected terminal', connectedTerminal],
      ['a file manager', fileManager],
    ])('opens a new terminal tab and selects it when the active tab is %s', (_label, active) => {
      const { result, setTabs, setActiveTabId, setProfilesModalOpen } = setup([active]);
      act(() => result.current.handleOpenSSHInTab(sshConfig));

      const next = applyTabs(setTabs, [active]);
      expect(next).toHaveLength(2);
      expect(next[0]).toBe(active);
      expect(next[1]).toMatchObject({ type: 'terminal', title: 'Prod', paneTree: { type: 'leaf', config: sshConfig } });
      expect(next[1].id).toMatch(/^term-\d+$/);
      expect(setActiveTabId).toHaveBeenCalledWith(next[1].id);
      expect(setProfilesModalOpen).toHaveBeenCalledWith(false);
    });
  });

  describe('handleOpenK8sInTab', () => {
    it('connects in place when the active tab is an empty terminal, and closes the modal', () => {
      const { result, setTabs, setActiveTabId, setProfilesModalOpen } = setup([emptyTerminal]);
      act(() => result.current.handleOpenK8sInTab(k8sTarget));

      const next = applyTabs(setTabs, [emptyTerminal]);
      expect(next).toHaveLength(1);
      expect(next[0]).toMatchObject({ id: 't1', title: 'web-1', paneTree: { k8sTarget, baseHost: 'web-1/app' } });
      expect(setActiveTabId).not.toHaveBeenCalled();
      expect(setProfilesModalOpen).toHaveBeenCalledWith(false);
    });

    it('opens a new terminal tab titled after the pod when the active tab is a file manager', () => {
      const { result, setTabs, setActiveTabId } = setup([fileManager]);
      act(() => result.current.handleOpenK8sInTab(k8sTarget));

      const next = applyTabs(setTabs, [fileManager]);
      expect(next).toHaveLength(2);
      expect(next[1]).toMatchObject({ type: 'terminal', title: 'web-1', paneTree: { type: 'leaf', k8sTarget } });
      expect(setActiveTabId).toHaveBeenCalledWith(next[1].id);
    });
  });
});

describe('useTabActions handleConnectSystem', () => {
  const tunnel = (id: string, name = id) => ({ id, name, type: 'local', localPort: 1000, remoteHost: 'localhost', remotePort: 80 });
  const server = (id: string, name: string, system: object, tunnels?: object[]) =>
    ({ id, name, host: `${name}.example.com`, username: 'u', authType: 'password', system, tunnels }) as never;
  const existing = { id: 'term-9', type: 'terminal', title: 'Terminal 1', paneTree: { type: 'leaf', id: 'l', config: { id: 'x' } } } as unknown as AppTab;

  const install = (over: Record<string, unknown> = {}) => {
    const api = {
      profilesSaveSSH: vi.fn().mockResolvedValue(undefined),
      sshTunnelStart: vi.fn().mockResolvedValue({}),
      ...over,
    };
    (window as unknown as { multissh: unknown }).multissh = api;
    return api as { profilesSaveSSH: ReturnType<typeof vi.fn>; sshTunnelStart: ReturnType<typeof vi.fn> };
  };

  afterEach(() => {
    delete (window as unknown as { multissh?: unknown }).multissh;
  });

  it('opens a terminal tab for every server in one go, each with its own id, and selects the first', async () => {
    install();
    const { result, setTabs, setActiveTabId, setProfilesModalOpen } = setup([existing]);
    await act(async () => {
      await result.current.handleConnectSystem(
        [server('2', 'web', { name: 'shop' }), server('1', 'db', { name: 'shop' }), server('3', 'cache', { name: 'shop' })],
        'personal'
      );
    });
    expect(setTabs).toHaveBeenCalledTimes(1);
    const next = (setTabs.mock.calls[0][0] as (p: AppTab[]) => AppTab[])([existing]);
    expect(next[0]).toBe(existing);
    const opened = next.slice(1);
    expect(opened.map((t) => t.title)).toEqual(['cache', 'db', 'web']);
    expect(new Set(opened.map((t) => t.id)).size).toBe(3);
    expect(opened.every((t) => /^term-\d+-\d+$/.test(t.id))).toBe(true);
    expect(opened[0].paneTree).toMatchObject({ type: 'leaf', config: { name: 'cache' } });
    expect(setActiveTabId).toHaveBeenCalledTimes(1);
    expect(setActiveTabId).toHaveBeenCalledWith(opened[0].id);
    expect(setProfilesModalOpen).toHaveBeenCalledWith(false);
  });

  it('starts each terminal in the start directory of its server', async () => {
    install();
    const { result, setTabs } = setup([existing]);
    await act(async () => {
      await result.current.handleConnectSystem([server('1', 'web', { name: 'shop', startDirectory: '/srv/web' }), server('2', 'db', { name: 'shop' })], 'personal');
    });
    const opened = (setTabs.mock.calls[0][0] as (p: AppTab[]) => AppTab[])([]);
    expect(opened.find((t) => t.title === 'web')?.initialCwd).toBe('/srv/web');
    expect(opened.find((t) => t.title === 'db')?.initialCwd).toBeUndefined();
  });

  it('starts the chosen tunnels with the connection of their server', async () => {
    const api = install();
    const { result } = setup([existing]);
    const web = server('1', 'web', { name: 'shop', tunnelIds: ['t2'] }, [tunnel('t1'), tunnel('t2')]);
    await act(async () => {
      await result.current.handleConnectSystem([web], 'personal');
    });
    expect(api.sshTunnelStart).toHaveBeenCalledTimes(1);
    expect(api.sshTunnelStart).toHaveBeenCalledWith(web, expect.objectContaining({ id: 't2' }));
  });

  it('reports the tunnels that could not start in one message, and still opens the terminals', async () => {
    const api = install({ sshTunnelStart: vi.fn().mockRejectedValueOnce(new Error('address in use')).mockResolvedValueOnce({}) });
    const notify = vi.fn();
    const { result, setTabs } = setup([existing], undefined, notify);
    await act(async () => {
      await result.current.handleConnectSystem(
        [server('1', 'web', { name: 'shop', tunnelIds: ['t1'] }, [tunnel('t1', 'db')]), server('2', 'api', { name: 'shop', tunnelIds: ['t2'] }, [tunnel('t2', 'cache')])],
        'personal'
      );
    });
    expect(api.sshTunnelStart).toHaveBeenCalledTimes(2);
    expect(setTabs).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain('1 of 2 tunnels could not start');
    expect(notify.mock.calls[0][0]).toContain('address in use');
  });

  it('says nothing when every tunnel started or there are none', async () => {
    install();
    const notify = vi.fn();
    const { result } = setup([existing], undefined, notify);
    await act(async () => {
      await result.current.handleConnectSystem([server('1', 'web', { name: 'shop' })], 'personal');
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it('records when each personal server was last used, but never writes a Team Vault server', async () => {
    const api = install();
    const { result } = setup([existing]);
    await act(async () => {
      await result.current.handleConnectSystem([server('1', 'web', { name: 'shop' }), server('2', 'db', { name: 'shop' })], 'personal');
    });
    expect(api.profilesSaveSSH).toHaveBeenCalledTimes(2);
    expect(api.profilesSaveSSH.mock.calls[0][0].lastUsedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);

    api.profilesSaveSSH.mockClear();
    await act(async () => {
      await result.current.handleConnectSystem([server('3', 'web', { name: 'shop' })], 'vault-1');
    });
    expect(api.profilesSaveSSH).not.toHaveBeenCalled();
  });

  it('still opens the terminals when recording the last-used time fails', async () => {
    install({ profilesSaveSSH: vi.fn().mockRejectedValue(new Error('disk full')) });
    const { result, setTabs } = setup([existing]);
    await act(async () => {
      await result.current.handleConnectSystem([server('1', 'web', { name: 'shop' })], 'personal');
    });
    expect(setTabs).toHaveBeenCalledTimes(1);
  });

  it('does nothing for a system with nothing to open', async () => {
    const api = install();
    const { result, setTabs, setActiveTabId, setProfilesModalOpen } = setup([existing]);
    await act(async () => {
      await result.current.handleConnectSystem([], 'personal');
      await result.current.handleConnectSystem([server('1', 'idle', { name: 'shop', shell: false })], 'personal');
    });
    expect(setTabs).not.toHaveBeenCalled();
    expect(setActiveTabId).not.toHaveBeenCalled();
    expect(api.sshTunnelStart).not.toHaveBeenCalled();
    expect(setProfilesModalOpen).not.toHaveBeenCalled();
  });
});

describe('useTabActions handleNewTab file manager', () => {
  const create = (remote?: boolean) => {
    const { result, setTabs } = setup([{ id: 'a', type: 'terminal', title: 'a' } as AppTab]);
    act(() => result.current.handleNewTab('filemanager', remote ? { remote: true } : undefined));
    return (setTabs.mock.calls[0][0] as (prev: AppTab[]) => AppTab[])([])[0];
  };

  it('opens locally by default and prompts for a connection when remote', () => {
    expect(create().promptRemote).toBeUndefined();
    expect(create(true).promptRemote).toBe(true);
  });
});
