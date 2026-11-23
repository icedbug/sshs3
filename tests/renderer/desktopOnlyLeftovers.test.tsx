// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmProvider } from '../../src/renderer/src/components/ConfirmDialog';
import { SSHProfileForm } from '../../src/renderer/src/components/ConnectionModal/SSHProfileForm';
import { TeamProfileTreeList } from '../../src/renderer/src/components/ConnectionModal/TeamProfileTreeList';
import { buildContextMenuItems, type FilePaneContextMenuInput } from '../../src/renderer/src/components/FileManager/filePaneContextMenu';
import { LocalPerfBar } from '../../src/renderer/src/components/LocalPerfBar';
import { DotfilePoolManagerModal } from '../../src/renderer/src/components/SettingsModal/DotfilePoolManagerModal';
import { SyncSettingsPanel } from '../../src/renderer/src/components/SettingsModal/SyncSettingsPanel';
import { TeamVaultDetailPanel } from '../../src/renderer/src/components/SettingsModal/TeamVaultDetailPanel';
import { LocalTerminalButtons } from '../../src/renderer/src/components/UnconnectedPanePlaceholder';
import { UpdateBanner } from '../../src/renderer/src/components/UpdateBanner';
import { resetLocalPerfHistory } from '../../src/renderer/src/lib/usePerfSamples';
import { usePortDetection } from '../../src/renderer/src/lib/usePortDetection';
import { useTabTransfer } from '../../src/renderer/src/lib/useTabTransfer';
import type { AppTab } from '../../src/renderer/src/lib/tabs';
import type { DotfilePool } from '../../src/shared/types/dotfiles';
import type { SSHConnectionConfig } from '../../src/shared/types/ssh';
import type { ProfileSyncStatus } from '../../src/shared/types/sync';
import type { TeamVaultStatus } from '../../src/shared/types/teamVault';

/**
 * What needs the person's own computer and was still offered in the browser. Each control is drawn once
 * as the browser sees it and once as the desktop app does, so a guard that hides it everywhere fails too.
 */
const web = (on: boolean): void => {
  (window as unknown as { __SSHS3_WEB_MODE__?: boolean }).__SSHS3_WEB_MODE__ = on ? true : undefined;
};

const api = (methods: Record<string, unknown>): void => {
  window.multissh = methods as unknown as typeof window.multissh;
};

afterEach(() => {
  cleanup();
  web(false);
});

const places = ['browser', 'desktop'] as const;

describe.each(places)('in the %s', (place) => {
  const inBrowser = place === 'browser';
  beforeEach(() => web(inBrowser));

  it(`the Windows shell buttons ${inBrowser ? 'have no' : 'have an'} administrator shield`, () => {
    api({ detectLocalShells: vi.fn().mockResolvedValue({ pwsh: false, wsl: false, wslDistros: [] }), openElevatedShell: vi.fn().mockResolvedValue(undefined) });
    render(<LocalTerminalButtons platform="win32" onOpen={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'PowerShell' })).toBeInTheDocument();
    const shield = screen.queryByRole('button', { name: 'Open PowerShell as administrator' });
    if (inBrowser) expect(shield).toBeNull();
    else expect(shield).toBeInTheDocument();
  });

  it(`a new version ${inBrowser ? 'is not announced' : 'is announced with a download button'}`, async () => {
    const getUpdateState = vi.fn().mockResolvedValue({ status: 'available', version: '9.9.9', currentVersion: '1.0.0' });
    const downloadUpdate = vi.fn().mockResolvedValue(undefined);
    api({ getUpdateState, onUpdateState: vi.fn(() => () => undefined), downloadUpdate });
    render(<UpdateBanner />);
    await waitFor(() => expect(getUpdateState).toHaveBeenCalled());
    if (inBrowser) {
      // The state has arrived (the promise above settled) and still nothing is drawn.
      await act(async () => undefined);
      expect(screen.queryByTestId('update-banner')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
    } else {
      fireEvent.click(await screen.findByRole('button', { name: 'Download' }));
      expect(downloadUpdate).toHaveBeenCalledTimes(1);
    }
  });

  it(`a dotfile pool ${inBrowser ? 'offers nothing that reads the disk of the computer the app runs on' : 'offers files, the folder and git'}`, async () => {
    const pool: DotfilePool = {
      id: 'p1',
      name: 'Linux servers',
      files: [{ id: 'f1', remotePath: '~/.bashrc', content: 'export EDITOR=vim', mode: '644', sourcePath: '/home/user/.bashrc', updatedAt: '2026-09-17 19:40' }],
      masterDirectory: '/data/dotfiles/p1',
      updatedAt: '2026-09-17 19:40',
    };
    const dotfilePoolReadSources = vi.fn().mockResolvedValue([]);
    const dotfilePoolSelectFiles = vi.fn().mockResolvedValue([]);
    api({ dotfilePoolsGet: vi.fn().mockResolvedValue([pool]), dotfilePoolReadSources, dotfilePoolSelectFiles, dotfilePoolOpenFolder: vi.fn().mockResolvedValue('') });
    render(
      <ConfirmProvider>
        <DotfilePoolManagerModal open onClose={vi.fn()} />
      </ConfirmProvider>,
    );
    fireEvent.click(await screen.findByText('Linux servers'));
    const add = await screen.findByRole('button', { name: /Add Files/ });
    if (inBrowser) {
      expect(screen.queryByRole('button', { name: /From Git/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /Open Master Directory/ })).toBeNull();
      expect(add).toBeDisabled();
      expect(add.closest('[data-testid="desktop-only"]')).toHaveTextContent('Only in the desktop app.');
      // Opening the pool does not ask the server to read the files it once came from.
      expect(dotfilePoolReadSources).not.toHaveBeenCalled();
    } else {
      expect(screen.getByRole('button', { name: /From Git/ })).toBeEnabled();
      expect(screen.getByRole('button', { name: /Open Master Directory/ })).toBeEnabled();
      await waitFor(() => expect(dotfilePoolReadSources).toHaveBeenCalledWith(['/home/user/.bashrc']));
      fireEvent.click(add);
      await waitFor(() => expect(dotfilePoolSelectFiles).toHaveBeenCalledTimes(1));
    }
  });

  it(`an empty dotfile pool ${inBrowser ? 'says where a file is added from' : 'opens the file picker'}`, async () => {
    const pool: DotfilePool = { id: 'p2', name: 'Empty pool', files: [], updatedAt: '2026-09-17 19:40' };
    const dotfilePoolSelectFiles = vi.fn().mockResolvedValue([]);
    api({ dotfilePoolsGet: vi.fn().mockResolvedValue([pool]), dotfilePoolReadSources: vi.fn().mockResolvedValue([]), dotfilePoolSelectFiles });
    render(
      <ConfirmProvider>
        <DotfilePoolManagerModal open onClose={vi.fn()} />
      </ConfirmProvider>,
    );
    fireEvent.click(await screen.findByText('Empty pool'));
    if (inBrowser) {
      expect(await screen.findByTestId('dotfile-pool-empty-web')).toHaveTextContent('In the file manager, right-click a file and choose Add to Dotfiles Pool.');
      fireEvent.click(screen.getByTestId('dotfile-pool-empty-web'));
      expect(dotfilePoolSelectFiles).not.toHaveBeenCalled();
    } else {
      fireEvent.click(await screen.findByText(/Add files or drag/));
      await waitFor(() => expect(dotfilePoolSelectFiles).toHaveBeenCalledTimes(1));
    }
  });

  it(`sync ${inBrowser ? 'offers no smartcard' : 'offers to unlock with a smartcard'}`, async () => {
    const status: ProfileSyncStatus = {
      configured: true,
      target: { id: 's3-target', name: 'S3 Sync', type: 's3' },
      hasLocalSalts: true,
      topologyUnlocked: false,
      credentialsUnlocked: false,
      smartcardAvailable: true,
    } as ProfileSyncStatus;
    api({ profileSyncStatus: vi.fn().mockResolvedValue(status), profileSyncUnlockSmartcard: vi.fn().mockResolvedValue(status), profileSyncCompare: vi.fn().mockResolvedValue(undefined) });
    render(
      <ConfirmProvider>
        <SyncSettingsPanel />
      </ConfirmProvider>,
    );
    const note = await screen.findByTestId('sync-smartcard-note');
    if (inBrowser) {
      expect(note).toHaveTextContent('Only in the desktop app.');
      expect(screen.queryByRole('button', { name: /Unlock with Smartcard/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /Link card/i })).toBeNull();
      // The password way stays.
      expect(screen.getByRole('button', { name: 'Unlock sync' })).toBeEnabled();
    } else {
      expect(note).toHaveTextContent('Card reader detected');
      expect(screen.getByRole('button', { name: /Unlock with Smartcard/i })).toBeEnabled();
      expect(screen.getByRole('button', { name: /Link card/i })).toBeEnabled();
    }
  });

  it(`a locked Team Vault ${inBrowser ? 'opens with its recovery key only' : 'offers its saved identity first'}`, async () => {
    const status: TeamVaultStatus = {
      exists: true,
      vaultId: 'vlt_1',
      unlocked: false,
      filePath: '/x',
      members: [{ recipientId: 'alice@piv:abc', role: 'admin', addedAt: '2026-10-01T00:00:00Z' }],
      adminCount: 1,
      selfRecipientId: 'alice@piv:abc',
      selfIdentityFilePath: '/home/alice/.sshs3/identity.txt',
      selfRole: 'admin',
    } as TeamVaultStatus;
    const teamVaultUnlock = vi.fn().mockResolvedValue(undefined);
    api({ settingsGet: vi.fn().mockResolvedValue({}), teamVaultGetStatus: vi.fn().mockResolvedValue(status), teamVaultUnlock });
    render(
      <ConfirmProvider>
        <TeamVaultDetailPanel vaultId="vlt_1" onBack={vi.fn()} onVaultRemoved={vi.fn()} />
      </ConfirmProvider>,
    );
    await screen.findByText('Unlock to add, remove, or promote members');
    if (inBrowser) {
      expect(screen.getByTestId('desktop-only-note')).toHaveTextContent('Unlock with a card or an identity file: Only in the desktop app.');
      expect(screen.queryByRole('button', { name: 'Unlock' })).toBeNull();
      expect(screen.queryByLabelText('Path to your identity file')).toBeNull();
      // The recovery key is already open: it is the one way in here.
      expect(screen.getByLabelText('Recovery key')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Recover vault access' })).toBeInTheDocument();
    } else {
      expect(screen.queryByTestId('desktop-only-note')).toBeNull();
      expect(screen.queryByLabelText('Recovery key')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
      await waitFor(() => expect(teamVaultUnlock).toHaveBeenCalledWith('vlt_1', 'alice@piv:abc', '/home/alice/.sshs3/identity.txt'));
    }
  });

  it(`a locked team in the list of servers ${inBrowser ? 'says where it opens, and offers no card or identity file' : 'offers its saved identity'}`, async () => {
    const locked = { exists: true, vaultId: 'v1', vaultName: 'Acme', unlocked: false, filePath: '/tmp/v1', selfRecipientId: 'age1alice', selfIdentityFilePath: '/home/alice/key.txt' } as TeamVaultStatus;
    const teamVaultUnlock = vi.fn().mockResolvedValue(undefined);
    api({ teamVaultList: vi.fn().mockResolvedValue([locked]), teamVaultGetStatus: vi.fn().mockResolvedValue(locked), teamVaultGetPayload: vi.fn().mockResolvedValue({ ssh: [], s3: [], folders: [] }), teamVaultUnlock });
    render(
      <ConfirmProvider>
        <TeamProfileTreeList tab="ssh" query="" activeVaultId="v1" setEditing={vi.fn()} onNewProfile={vi.fn()} onVaultsMetaChange={vi.fn()} />
      </ConfirmProvider>,
    );
    await screen.findByText('Acme is locked');
    if (inBrowser) {
      expect(screen.getByTestId('desktop-only-note')).toHaveTextContent(
        'Unlock with a card or an identity file: Only in the desktop app. Here it opens with its recovery key, under Settings, Team Vault.',
      );
      expect(screen.queryByRole('button', { name: /Unlock/ })).toBeNull();
      expect(screen.queryByPlaceholderText('Path to your identity file')).toBeNull();
    } else {
      fireEvent.click(screen.getByRole('button', { name: /Unlock as age1alice/ }));
      await waitFor(() => expect(teamVaultUnlock).toHaveBeenCalledWith('v1', 'age1alice', '/home/alice/key.txt'));
    }
  });

  it(`a server that signs in with a security key ${inBrowser ? 'shows its key settings switched off' : 'can scan the key'}`, async () => {
    const fido2ListResidentKeys = vi.fn().mockResolvedValue([]);
    api({
      dotfilePoolsGet: vi.fn().mockResolvedValue([]),
      profilesGet: vi.fn().mockResolvedValue({ ssh: [], s3: [] }),
      smartcardDetect: vi.fn().mockResolvedValue([]),
      fido2ListResidentKeys,
    });
    const profile: SSHConnectionConfig = { id: 'c1', name: 'Bastion', host: 'bastion.example', port: 22, username: 'ops', authType: 'fido2', fido2Resident: true };
    render(<SSHProfileForm initial={profile} onSave={vi.fn()} onCancel={vi.fn()} />);
    const resident = screen.getByLabelText(/Use a resident \(discoverable\) credential/);
    if (inBrowser) {
      expect(resident).toBeDisabled();
      const group = resident.closest('[data-testid="desktop-only"]') as HTMLElement;
      expect(within(group).getByTestId('desktop-only-note')).toHaveTextContent('Only in the desktop app.');
      for (const button of within(group).queryAllByRole('button')) expect(button).toBeDisabled();
      expect(fido2ListResidentKeys).not.toHaveBeenCalled();
    } else {
      expect(resident).toBeEnabled();
      expect(resident.closest('[data-testid="desktop-only"]')).toBeNull();
    }
  });

  it(`a port a server prints ${inBrowser ? 'is not offered as a local one' : 'is offered, and its tunnel is started'}`, async () => {
    const sshTunnelStart = vi.fn().mockResolvedValue({ id: 'active-1' });
    const sshTunnelCheckPort = vi.fn().mockResolvedValue(true);
    api({ sshTunnelStart, sshTunnelCheckPort, sshTunnelStop: vi.fn().mockResolvedValue(true), openExternal: vi.fn().mockResolvedValue(undefined) });
    const config: SSHConnectionConfig = { id: 'ssh-1', name: 'Web host', host: 'web.example', port: 22, username: 'ops', authType: 'password' };
    const { result } = renderHook(() => usePortDetection({ enabled: true, isRemote: true, config }));
    act(() => result.current.scanOutput('Server listening on http://localhost:8080'));
    await act(async () => result.current.handleForwardAndOpen(8080, 'http'));
    if (inBrowser) {
      expect(result.current.detectedPorts).toEqual([]);
      expect(sshTunnelCheckPort).not.toHaveBeenCalled();
      expect(sshTunnelStart).not.toHaveBeenCalled();
    } else {
      expect(result.current.detectedPorts.map((p) => p.port)).toEqual([8080]);
      expect(sshTunnelStart).toHaveBeenCalledTimes(1);
    }
  });

  it(`the load of the local machine ${inBrowser ? 'is not asked for' : 'is read'}`, async () => {
    resetLocalPerfHistory();
    const perfLocalSample = vi.fn().mockResolvedValue({
      ok: true,
      raw: { t: Date.now(), cpuTotal: 1000, cpuIdle: 800, cores: 4, load: [1, 0.5, 0.25], memTotalKb: 1000, memAvailKb: 250, swapTotalKb: 100, swapFreeKb: 50, diskUsedPct: 90, netRxBytes: 0, netTxBytes: 0, uptimeSec: 3700 },
    });
    api({ perfLocalSample });
    render(<LocalPerfBar layout="text" items={['mem']} active />);
    if (inBrowser) {
      await waitFor(() => expect(screen.getByText(/Only in the desktop app\./)).toBeInTheDocument());
      expect(perfLocalSample).not.toHaveBeenCalled();
    } else {
      await waitFor(() => expect(screen.getByTestId('perf-bar')).toHaveTextContent('RAM 75%'));
      expect(perfLocalSample).toHaveBeenCalled();
    }
  });

  it(`a tab ${inBrowser ? 'is not handed to another window' : 'can be moved to a new window'}`, async () => {
    const windowMoveTab = vi.fn().mockResolvedValue(undefined);
    api({ windowMoveTab, windowTakeHandoff: vi.fn().mockResolvedValue(null), onWindowAdoptTab: vi.fn(() => () => undefined) });
    const tab = { id: 'files-1', type: 'filemanager', title: 'Files' } as unknown as AppTab;
    const setTabs = vi.fn();
    const { result } = renderHook(() => useTabTransfer([tab], 'files-1', true, setTabs, vi.fn()));
    await act(async () => result.current.moveTab('files-1', 'new'));
    if (inBrowser) {
      expect(windowMoveTab).not.toHaveBeenCalled();
      expect(setTabs).not.toHaveBeenCalled();
    } else {
      expect(windowMoveTab).toHaveBeenCalledTimes(1);
    }
  });
});

describe('the right-click menu of a file', () => {
  const noop = (): void => undefined;
  const input = (handleOpenExternal?: FilePaneContextMenuInput['handleOpenExternal']): FilePaneContextMenuInput =>
    ({
      contextMenuOpen: true,
      selectedEntries: [{ name: 'notes.txt', path: '/srv/notes.txt', isDirectory: false, size: 12, modifiedAt: 0 }],
      sourceType: 'ssh',
      currentPath: '/srv',
      clipboard: null,
      gitIntegrationEnabled: false,
      gitStatus: null,
      supportsChmod: true,
      isBucketEntry: false,
      isS3ObjectEntry: false,
      selectedAreAllFiles: true,
      handleOpen: noop,
      handleOpenExternal,
      handleCut: noop,
      handleCopy: noop,
      handlePaste: noop,
      handleRenameStart: noop,
      handleDownloadTo: noop,
      handleGitPull: noop,
      handleDelete: noop,
      handleNewFolder: noop,
      handleNewFile: noop,
      handleCompress: noop,
      handleExtract: noop,
      setPatternOpen: noop,
      handleInvertSelection: noop,
      load: noop,
      setSyncModalOpen: noop,
      setEditorTailMode: noop,
      setEditorEntry: noop,
      setChmodOpen: noop,
      setAddToDotfilesOpen: noop,
      setTagsOpen: noop,
      setBucketPolicyOpen: noop,
      setVersionsOpen: noop,
      setPresignedOpen: noop,
      setGitCloneTargetDir: noop,
      setGitCloneOpen: noop,
      setPropertiesOpen: noop,
      setCertificateOpen: noop,
      setSearchOpen: noop,
    }) as unknown as FilePaneContextMenuInput;

  const keys = (items: ReturnType<typeof buildContextMenuItems>): string[] => items.map((item) => item.key);

  it('has no external editor and no drag out when the pane hands it neither, as it does in the browser', () => {
    const items = keys(buildContextMenuItems(input(undefined)));
    expect(items).toContain('tail');
    expect(items).not.toContain('open-external');
    expect(items).not.toContain('drag-out');
  });

  it('has the external editor when the pane hands it one, as it does in the desktop app', () => {
    const open = vi.fn();
    const items = buildContextMenuItems(input(open));
    const external = items.find((item) => item.key === 'open-external');
    expect(external).toBeDefined();
    external?.onSelect?.();
    expect(open).toHaveBeenCalledTimes(1);
  });
});
