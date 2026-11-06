// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { App } from '../../../src/renderer/src/App';
import { SlideOverDrawer } from '../../../src/renderer/src/components/SlideOverDrawer';
import { GlobalTransferHud } from '../../../src/renderer/src/components/GlobalTransferHud';
import { BottomStatusBar } from '../../../src/renderer/src/components/BottomStatusBar';
import type { TransferProgress } from '../../../src/shared/types/storage';

// Polyfill ResizeObserver and matchMedia for JSDOM
class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

describe('Milestone 2: Airy Topbar, Slide-Over Drawers & Persistent Bottom Status Bar (F4, F5, F6)', () => {
  let transferProgressCb: ((progress: TransferProgress) => void) | null = null;

  beforeEach(() => {
    transferProgressCb = null;
    window.multissh = {
      ...(window.multissh || {}),
      terminalCreate: vi.fn().mockResolvedValue({ sessionId: 'm2-term-1' }),
      terminalWrite: vi.fn().mockResolvedValue(undefined),
      terminalResize: vi.fn().mockResolvedValue(undefined),
      terminalKill: vi.fn().mockResolvedValue(undefined),
      onTerminalData: vi.fn(() => vi.fn()),
      onTerminalExit: vi.fn(() => vi.fn()),
      onAskpassPrompt: vi.fn(() => vi.fn()),
      submitAskpassPin: vi.fn().mockResolvedValue(undefined),
      connectStorage: vi.fn().mockResolvedValue({ id: 'local' }),
      storageList: vi.fn().mockResolvedValue([]),
      transferGetJobs: vi.fn().mockResolvedValue([]),
      transferClearCompleted: vi.fn().mockResolvedValue(undefined),
      transferPause: vi.fn().mockResolvedValue(undefined),
      transferResume: vi.fn().mockResolvedValue(undefined),
      transferCancel: vi.fn().mockResolvedValue(undefined),
      onTransferProgress: vi.fn((cb) => {
        transferProgressCb = cb;
        return vi.fn();
      }),
      sessionGet: vi.fn().mockResolvedValue({
        tabs: [{ id: 'term-1', type: 'terminal', title: 'prod-node-01' }],
        activeTabId: 'term-1',
      }),
      sessionSave: vi.fn().mockResolvedValue(undefined),
      settingsGet: vi.fn().mockResolvedValue(undefined),
      settingsSave: vi.fn().mockResolvedValue(undefined),
      profilesGet: vi.fn().mockResolvedValue({
        ssh: [
          {
            id: 'ssh-m2-1',
            name: 'prod-gateway',
            host: '10.0.1.10',
            port: 22,
            username: 'admin',
            authType: 'password',
            tags: ['prod'],
          },
        ],
        s3: [],
      }),
      profilesSaveSSH: vi.fn().mockResolvedValue(undefined),
      teamVaultList: vi.fn().mockResolvedValue([]),
      sshTunnelList: vi.fn().mockResolvedValue([]),
      onSshTunnelEvent: vi.fn(() => vi.fn()),
      dirSyncProfileList: vi.fn().mockResolvedValue([]),
      getHostname: vi.fn().mockResolvedValue('workstation'),
      onSearchResult: vi.fn(() => vi.fn()),
      onSearchProgress: vi.fn(() => vi.fn()),
      onSearchError: vi.fn(() => vi.fn()),
      onSearchDone: vi.fn(() => vi.fn()),
      searchStart: vi.fn().mockResolvedValue({ searchId: 's-1' }),
      searchCancel: vi.fn().mockResolvedValue(undefined),
      searchPreview: vi.fn().mockResolvedValue({ content: '', startLine: 1 }),
    } as unknown as typeof window.multissh;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  describe('F4: Airy Tab-Centered Topbar & Omnibar', () => {
    it('renders the airy h-11 topbar with brand home, left inventory drawer toggle, centered tabs, Omnibar trigger, and right drawer toggles', async () => {
      render(<App />);
      await screen.findByTestId('tab-term-1');

      const topbar = screen.getByTestId('app-topbar');
      expect(topbar).toHaveClass('h-11');
      expect(screen.getByTestId('topbar-brand-home')).toBeInTheDocument();
      expect(screen.getByTestId('drawer-toggle-connections')).toBeInTheDocument();
      expect(screen.getByTestId('omnibar-trigger')).toBeInTheDocument();
      expect(screen.getByTestId('drawer-toggle-tunnels')).toBeInTheDocument();
      expect(screen.getByTestId('drawer-toggle-dirsync')).toBeInTheDocument();
      expect(screen.getByTestId('drawer-toggle-settings')).toBeInTheDocument();
      expect(screen.getByTestId('drawer-toggle-ai')).toBeInTheDocument();
    });

    it('opens the GlobalSearchPalette Omnibar when clicking omnibar-trigger and triggers slide-over drawers or theme changes directly from Omnibar', async () => {
      render(<App />);
      await screen.findByTestId('tab-term-1');

      // Open Omnibar via central trigger
      fireEvent.click(screen.getByTestId('omnibar-trigger'));
      expect(await screen.findByTestId('global-search-palette')).toBeInTheDocument();

      // Quick drawer button inside Omnibar opens SSH Tunnels drawer and closes Omnibar
      fireEvent.click(screen.getByTestId('omnibar-action-tunnels'));
      await waitFor(() => expect(screen.queryByTestId('global-search-palette')).not.toBeInTheDocument());
      expect(await screen.findByTestId('drawer-tunnels')).toBeInTheDocument();

      // Close tunnels drawer with Escape
      fireEvent.keyDown(window, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByTestId('drawer-tunnels')).not.toBeInTheDocument());

      // Open Omnibar again and run >theme: breeze command
      fireEvent.click(screen.getByTestId('omnibar-trigger'));
      const input = await screen.findByRole('combobox');
      fireEvent.change(input, { target: { value: '>breeze' } });
      await waitFor(() => expect(screen.getAllByRole('option')[0]).toHaveTextContent('Theme: Breeze'));
      fireEvent.keyDown(input, { key: 'Enter' });

      await waitFor(() => expect(screen.queryByTestId('global-search-palette')).not.toBeInTheDocument());
      expect(window.multissh.settingsSave).toHaveBeenCalledWith({ theme: 'breeze' });
    });
  });

  describe('F5: Slide-Over Side Panels (Drawers) Replacing Blocking Modals', () => {
    it('renders SlideOverDrawer on left or right side and dismisses on Escape and backdrop click', () => {
      const onClose = vi.fn();
      const { rerender } = render(
        <SlideOverDrawer open={true} onClose={onClose} side="left" title="Left Inventory" dataTestId="custom-drawer">
          <div>Drawer Body</div>
        </SlideOverDrawer>
      );

      const wrapper = screen.getByTestId('custom-drawer');
      expect(wrapper).toHaveAttribute('data-drawer-side', 'left');
      expect(screen.getByTestId('slide-over-drawer')).toHaveClass('sshs3-slide-drawer-left');
      expect(screen.getByText('Left Inventory')).toBeInTheDocument();
      expect(screen.getByText('Drawer Body')).toBeInTheDocument();

      // Escape dismisses
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);

      // Backdrop click dismisses
      fireEvent.click(wrapper);
      expect(onClose).toHaveBeenCalledTimes(2);

      // Rerender on right side
      rerender(
        <SlideOverDrawer open={true} onClose={onClose} side="right" title="Right Panel" dataTestId="custom-drawer">
          <div>Drawer Body</div>
        </SlideOverDrawer>
      );
      expect(screen.getByTestId('custom-drawer')).toHaveAttribute('data-drawer-side', 'right');
      expect(screen.getByTestId('slide-over-drawer')).toHaveClass('sshs3-slide-drawer-right');
    });

    it('opens and closes Connections (left drawer), Settings (right drawer), Tunnels (right drawer), DirSync (right drawer), and AI Hub (right drawer)', async () => {
      render(<App />);
      await screen.findByTestId('tab-term-1');

      // 1. Connections & Inventory left slide-over drawer
      fireEvent.click(screen.getByTestId('drawer-toggle-connections'));
      const connDrawer = await screen.findByTestId('drawer-connections');
      expect(connDrawer).toHaveAttribute('data-drawer-side', 'left');
      expect(within(connDrawer).getByTestId('slide-over-drawer')).toHaveClass('sshs3-slide-drawer-left');
      fireEvent.keyDown(window, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByTestId('drawer-connections')).not.toBeInTheDocument());

      // 2. Settings right slide-over drawer
      fireEvent.click(screen.getByTestId('drawer-toggle-settings'));
      const settingsDrawer = await screen.findByTestId('drawer-settings');
      expect(settingsDrawer).toHaveAttribute('data-drawer-side', 'right');
      expect(within(settingsDrawer).getByTestId('slide-over-drawer')).toHaveClass('sshs3-slide-drawer-right');
      fireEvent.keyDown(window, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByTestId('drawer-settings')).not.toBeInTheDocument());

      // 3. SSH Tunnels right slide-over drawer
      fireEvent.click(screen.getByTestId('drawer-toggle-tunnels'));
      const tunnelsDrawer = await screen.findByTestId('drawer-tunnels');
      expect(tunnelsDrawer).toHaveAttribute('data-drawer-side', 'right');
      expect(within(tunnelsDrawer).getByTestId('slide-over-drawer')).toHaveClass('sshs3-slide-drawer-right');
      fireEvent.keyDown(window, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByTestId('drawer-tunnels')).not.toBeInTheDocument());

      // 4. DirSync Saved Profiles right slide-over drawer
      fireEvent.click(screen.getByTestId('drawer-toggle-dirsync'));
      const dirsyncDrawer = await screen.findByTestId('drawer-dirsync');
      expect(dirsyncDrawer).toHaveAttribute('data-drawer-side', 'right');
      expect(within(dirsyncDrawer).getByTestId('slide-over-drawer')).toHaveClass('sshs3-slide-drawer-right');
      fireEvent.keyDown(window, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByTestId('drawer-dirsync')).not.toBeInTheDocument());

      // 5. AI Hub right slide-over drawer
      expect(screen.getByTestId('drawer-ai')).toHaveAttribute('data-drawer-open', 'false');
      fireEvent.click(screen.getByTestId('drawer-toggle-ai'));
      expect(screen.getByTestId('drawer-ai')).toHaveAttribute('data-drawer-open', 'true');
    });
  });

  describe('F6: Persistent Bottom Status Bar & Global Transfer HUD', () => {
    it('mounts BottomStatusBar at the bottom of the app shell across Mission Control, Terminal, and File Manager tabs', async () => {
      render(<App />);
      await screen.findByTestId('tab-term-1');

      const statusBar = screen.getByTestId('bottom-status-bar');
      expect(statusBar).toBeInTheDocument();
      expect(screen.getByTestId('global-transfer-hud')).toBeInTheDocument();
      expect(screen.getByTestId('status-theme-switcher')).toBeInTheDocument();

      // Switch to Mission Control (Home)
      fireEvent.click(screen.getByTestId('topbar-brand-home'));
      expect(screen.getByTestId('bottom-status-bar')).toBeInTheDocument();
      expect(screen.getByTestId('status-connection-indicator')).toHaveTextContent('Mission Control · Fleet Ready');

      // Open a File Manager tab
      fireEvent.click(screen.getByTestId('add-tab-btn'));
      fireEvent.click(screen.getByTestId('new-filemanager-btn'));
      expect(screen.getByTestId('bottom-status-bar')).toBeInTheDocument();
      expect(screen.getByTestId('status-connection-indicator')).toHaveTextContent('Storage / SFTP · S3');
    });

    it('updates GlobalTransferHud live on transfer progress and toggles the expandable global-transfer-drawer', async () => {
      render(<App />);
      await screen.findByTestId('tab-term-1');

      const hud = screen.getByTestId('global-transfer-hud');
      expect(hud).toHaveTextContent('0 active · Inga aktiva överföringar');

      // Emit a running transfer progress event
      act(() => {
        transferProgressCb?.({
          jobId: 'job-101',
          fileName: 'database-dump.sql.gz',
          transferredBytes: 50 * 1024 * 1024,
          totalBytes: 100 * 1024 * 1024,
          percentage: 50,
          bytesPerSecond: 10 * 1024 * 1024,
          status: 'running',
        });
      });

      expect(hud).toHaveTextContent('1 active');
      expect(hud).toHaveTextContent('50%');
      expect(screen.getByTestId('global-transfer-speed')).toBeInTheDocument();

      // Click HUD to open expandable transfer queue drawer
      expect(screen.queryByTestId('global-transfer-drawer')).not.toBeInTheDocument();
      fireEvent.click(hud);
      const drawer = await screen.findByTestId('global-transfer-drawer');
      expect(drawer).toBeInTheDocument();
      expect(within(drawer).getByText('database-dump.sql.gz')).toBeInTheDocument();

      // Pause button calls transferPause
      fireEvent.click(within(drawer).getByRole('button', { name: 'Pause' }));
      expect(window.multissh.transferPause).toHaveBeenCalledWith('job-101');

      // Clicking HUD again collapses the drawer
      fireEvent.click(hud);
      expect(screen.queryByTestId('global-transfer-drawer')).not.toBeInTheDocument();
    });

    it('switches themes (Dark / Light / Breeze) directly from BottomStatusBar', async () => {
      render(<App />);
      await screen.findByTestId('tab-term-1');

      fireEvent.click(screen.getByTestId('status-theme-breeze'));
      expect(window.multissh.settingsSave).toHaveBeenCalledWith({ theme: 'breeze' });

      fireEvent.click(screen.getByTestId('status-theme-light'));
      expect(window.multissh.settingsSave).toHaveBeenCalledWith({ theme: 'light' });

      fireEvent.click(screen.getByTestId('status-theme-dark'));
      expect(window.multissh.settingsSave).toHaveBeenCalledWith({ theme: 'dark' });
    });

    it('supports transferList fallback when transferGetJobs is absent in GlobalTransferHud', async () => {
      delete (window.multissh as unknown as Record<string, unknown>).transferGetJobs;
      (window.multissh as unknown as Record<string, unknown>).transferList = vi.fn().mockResolvedValue([
        {
          jobId: 'job-fallback-1',
          fileName: 'archive.tar.zst',
          transferredBytes: 256,
          totalBytes: 512,
          percentage: 50,
          bytesPerSecond: 128,
          status: 'running',
        } satisfies TransferProgress,
      ]);

      render(<GlobalTransferHud />);
      await waitFor(() => {
        expect(screen.getByTestId('global-transfer-hud')).toHaveTextContent('1 active');
      });
    });

    it('renders BottomStatusBar standalone with tunnel counts and smartcard indicator', async () => {
      (window.multissh.sshTunnelList as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 'tun-1', connectionId: 'ssh-1', tunnel: { id: 't1', name: 'PG', type: 'local', localPort: 5432, remoteHost: 'localhost', remotePort: 5432, enabled: true }, status: 'active', startedAt: '2026-11-06T00:00:00Z' },
      ]);

      const onOpenTunnels = vi.fn();
      render(
        <BottomStatusBar
          tabs={[]}
          activeTabId=""
          theme="dark"
          onChangeTheme={vi.fn()}
          smartcardAuthMode="agent-global"
          onOpenTunnels={onOpenTunnels}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('status-tunnels-badge')).toHaveTextContent('1 tunnel');
      });
      expect(screen.getByTestId('status-ca-smartcard-badge')).toHaveTextContent('PIV/FIDO2');
      fireEvent.click(screen.getByTestId('status-tunnels-badge'));
      expect(onOpenTunnels).toHaveBeenCalledTimes(1);
    });
  });
});
