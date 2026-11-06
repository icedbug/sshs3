// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {
  SessionTelemetryPill,
  buildSparklinePolylinePoints,
  computeSessionTelemetry,
} from '../../../src/renderer/src/components/SessionTelemetryPill';
import { PaneTreeView } from '../../../src/renderer/src/components/PaneTree';
import { LandingView } from '../../../src/renderer/src/components/LandingView';
import {
  createLeaf,
  splitPaneWithSftp,
  isSftpLeaf,
  getLeafSurfaceType,
  consumePendingHostWorkspaceSplit,
} from '../../../src/renderer/src/lib/paneTree';
import type { PaneLeaf } from '../../../src/shared/types/session';
import type { SSHConnectionConfig } from '../../../src/shared/types/ssh';
import type { AppSettings } from '../../../src/shared/types/settings';

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

const dummySettings: AppSettings = {
  theme: 'dark',
  terminalFontSize: 14,
  terminalFontFamily: 'monospace',
  terminalScrollback: 1000,
  copyOnSelect: false,
} as unknown as AppSettings;

const sampleSshConfig: SSHConnectionConfig = {
  id: 'ssh-ontap-01',
  name: 'prod-ontap-node01',
  host: '10.20.30.11',
  port: 22,
  username: 'netapp-admin',
  authType: 'agent',
  cluster: 'MetroCluster-SE',
  role: 'NetApp ONTAP Controller',
};

describe('Milestone 3: Hybrid Server Blades & Session Telemetry Pill (F7) + SSH/SFTP Host Workspace Split View (F8)', () => {
  beforeEach(() => {
    consumePendingHostWorkspaceSplit(sampleSshConfig);
    window.multissh = {
      ...(window.multissh || {}),
      detectLocalShells: vi.fn().mockResolvedValue({ pwsh: true, wsl: true }),
      terminalCreate: vi.fn().mockResolvedValue({ sessionId: 'm3-pty-1' }),
      terminalWrite: vi.fn().mockResolvedValue(undefined),
      terminalResize: vi.fn().mockResolvedValue(undefined),
      terminalKill: vi.fn().mockResolvedValue(undefined),
      onTerminalData: vi.fn(() => vi.fn()),
      onTerminalExit: vi.fn(() => vi.fn()),
      onAskpassPrompt: vi.fn(() => vi.fn()),
      connectStorage: vi.fn().mockResolvedValue({ id: 'sftp-m3-1' }),
      storageList: vi.fn().mockResolvedValue([
        { name: 'etc', path: '/etc', size: 0, isDirectory: true },
        { name: 'nginx.conf', path: '/etc/nginx.conf', size: 2048, isDirectory: false },
      ]),
      getHomeDir: vi.fn().mockResolvedValue('/home/netapp-admin'),
      storageGetHomeDir: vi.fn().mockResolvedValue('/home/netapp-admin'),
      profilesGet: vi.fn().mockResolvedValue({ ssh: [sampleSshConfig], s3: [] }),
      transferGetJobs: vi.fn().mockResolvedValue([]),
      onTransferProgress: vi.fn(() => vi.fn()),
      onSearchResult: vi.fn(() => vi.fn()),
      onSearchProgress: vi.fn(() => vi.fn()),
      onSearchError: vi.fn(() => vi.fn()),
      onSearchDone: vi.fn(() => vi.fn()),
    } as unknown as typeof window.multissh;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  // ============================================================================
  // FEATURE F7: Hybrid Server Blades & Session Telemetry Pill
  // ============================================================================
  describe('F7: Hybrid Server Blades & Session Telemetry Pill', () => {
    it('F7.1: LandingView renders Server Blades with "Host Workspace (SSH + SFTP)" button that dispatches sshs3:open-host-workspace and invokes onConnectRecentSSH', () => {
      const onConnectRecentSSH = vi.fn();
      const hostWorkspaceEvents: CustomEvent[] = [];
      const onHostWorkspace = (e: Event) => hostWorkspaceEvents.push(e as CustomEvent);
      window.addEventListener('sshs3:open-host-workspace', onHostWorkspace);

      try {
        render(
          <LandingView
            recentSSH={[sampleSshConfig]}
            onConnectRecentSSH={onConnectRecentSSH}
            onConnectSFTP={vi.fn()}
            onQuickStartTerminal={vi.fn()}
            onNewTab={vi.fn()}
            onOpenProfiles={vi.fn()}
            onNewProfile={vi.fn()}
            onOpenSyncBootstrap={vi.fn()}
            onNavigateToTabBar={vi.fn()}
          />
        );

        const workspaceBtn = screen.getByTestId(`blade-connect-workspace-${sampleSshConfig.id}`);
        expect(workspaceBtn).toBeInTheDocument();
        expect(workspaceBtn).toHaveTextContent('Host Workspace (SSH + SFTP)');

        fireEvent.click(workspaceBtn);

        expect(onConnectRecentSSH).toHaveBeenCalledWith(sampleSshConfig);
        expect(hostWorkspaceEvents).toHaveLength(1);
        expect(hostWorkspaceEvents[0].detail).toEqual(
          expect.objectContaining({
            serverId: sampleSshConfig.id,
            config: expect.objectContaining({
              id: sampleSshConfig.id,
              host: sampleSshConfig.host,
            }),
          })
        );
        // Clean up the queued host workspace split token
        expect(consumePendingHostWorkspaceSplit(sampleSshConfig)).toBe(true);
      } finally {
        window.removeEventListener('sshs3:open-host-workspace', onHostWorkspace);
      }
    });

    it('F7.2: SessionTelemetryPill renders health status sonar dot, live CPU %, latency in ms, and 8-point SVG sparkline polyline', () => {
      render(
        <SessionTelemetryPill
          paneId="pane-1"
          config={sampleSshConfig}
          cpuPct={42}
          memPct={58}
          latencyMs={0.34}
          sparklineValues={[28, 32, 35, 30, 38, 40, 39, 42]}
        />
      );

      const pill = screen.getByTestId('session-telemetry-pill');
      expect(pill).toBeInTheDocument();
      expect(pill).toHaveClass('sshs3-telemetry-pill');
      expect(pill).toHaveAttribute('data-health', 'healthy');

      const dot = screen.getByTestId('session-telemetry-dot');
      expect(dot).toHaveAttribute('data-health', 'healthy');
      expect(dot).toHaveClass('sshs3-sonar-emerald');

      expect(screen.getByTestId('session-telemetry-cpu')).toHaveTextContent('42% CPU');
      expect(screen.getByTestId('session-telemetry-latency')).toHaveTextContent('0.34 ms');

      const sparkline = screen.getByTestId('session-telemetry-sparkline');
      expect(sparkline.tagName.toLowerCase()).toBe('polyline');
      const points = (sparkline.getAttribute('points') || '').trim().split(/\s+/);
      expect(points).toHaveLength(8);
    });

    it('F7.3: clicking SessionTelemetryPill expands session-telemetry-detail popover with CPU/RAM/Network/Latency cards and closes on Escape or outside click', () => {
      render(
        <div>
          <div data-testid="outside-region">Outside</div>
          <SessionTelemetryPill
            paneId="pane-1"
            config={sampleSshConfig}
            cpuPct={48}
            memPct={64}
            latencyMs={0.41}
            netIoLabel="34.5 MB/s · 40.2k IOPS"
          />
        </div>
      );

      const pill = screen.getByTestId('session-telemetry-pill');
      expect(pill).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByTestId('session-telemetry-detail')).not.toBeInTheDocument();

      // 1-click opens the telemetry detail popover
      fireEvent.click(pill);
      expect(pill).toHaveAttribute('aria-expanded', 'true');

      const detail = screen.getByTestId('session-telemetry-detail');
      expect(detail).toBeInTheDocument();
      expect(screen.getByTestId('session-telemetry-status-badge')).toHaveTextContent('Healthy');
      expect(detail).toHaveTextContent('netapp-admin@10.20.30.11:22 · MetroCluster-SE');
      expect(detail).toHaveTextContent('64%');
      expect(detail).toHaveTextContent('34.5 MB/s · 40.2k IOPS');
      expect(screen.getByTestId('telemetry-action-split-sftp')).toBeInTheDocument();
      expect(screen.getByTestId('telemetry-action-diagnose-ai')).toBeInTheDocument();
      expect(screen.getByTestId('telemetry-action-open-fleet')).toBeInTheDocument();

      // Pressing Escape closes the popover
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByTestId('session-telemetry-detail')).not.toBeInTheDocument();

      // Re-open and click outside to close
      fireEvent.click(pill);
      expect(screen.getByTestId('session-telemetry-detail')).toBeInTheDocument();
      fireEvent.mouseDown(screen.getByTestId('outside-region'));
      expect(screen.queryByTestId('session-telemetry-detail')).not.toBeInTheDocument();
    });

    it('F7.4: "Diagnose with AI" and "Open Fleet Overview" inside SessionTelemetryPill dispatch CustomEvents with host telemetry payloads', () => {
      const onDiagnoseAi = vi.fn();
      const onOpenFleet = vi.fn();
      const aiOpenEvents: CustomEvent[] = [];
      const fleetEvents: CustomEvent[] = [];
      const handleAiOpen = (e: Event) => aiOpenEvents.push(e as CustomEvent);
      const handleFleetOpen = (e: Event) => fleetEvents.push(e as CustomEvent);
      window.addEventListener('sshs3:ai-open', handleAiOpen);
      window.addEventListener('sshs3:open-fleet-overview', handleFleetOpen);

      try {
        render(
          <SessionTelemetryPill
            paneId="pane-diag-1"
            config={sampleSshConfig}
            cpuPct={91}
            memPct={82}
            latencyMs={14.5}
            onDiagnoseAi={onDiagnoseAi}
            onOpenFleet={onOpenFleet}
          />
        );

        // Open detail popover and click "Diagnose with AI"
        fireEvent.click(screen.getByTestId('session-telemetry-pill'));
        fireEvent.click(screen.getByTestId('telemetry-action-diagnose-ai'));

        expect(onDiagnoseAi).toHaveBeenCalledTimes(1);
        expect(aiOpenEvents).toHaveLength(1);
        expect(aiOpenEvents[0].detail).toEqual(
          expect.objectContaining({
            view: 'Work',
            mode: 'panel',
            paneId: 'pane-diag-1',
            host: 'prod-ontap-node01',
            profileId: 'ssh-ontap-01',
            telemetry: expect.objectContaining({
              cpuPct: 91,
              memPct: 82,
              healthStatus: 'warning',
            }),
            prompt: expect.stringContaining('CPU 91%'),
          })
        );
        // Popover closes after action
        expect(screen.queryByTestId('session-telemetry-detail')).not.toBeInTheDocument();

        // Re-open detail popover and click "Open Fleet Overview"
        fireEvent.click(screen.getByTestId('session-telemetry-pill'));
        fireEvent.click(screen.getByTestId('telemetry-action-open-fleet'));

        expect(onOpenFleet).toHaveBeenCalledTimes(1);
        expect(fleetEvents).toHaveLength(1);
        expect(fleetEvents[0].detail).toEqual(
          expect.objectContaining({
            paneId: 'pane-diag-1',
            host: 'prod-ontap-node01',
            profileId: 'ssh-ontap-01',
          })
        );
      } finally {
        window.removeEventListener('sshs3:ai-open', handleAiOpen);
        window.removeEventListener('sshs3:open-fleet-overview', handleFleetOpen);
      }
    });

    it('F7.5 (Tier 2 Boundary): SessionTelemetryPill handles high-load warning (>85% CPU / >150ms latency) and disconnected/offline states accurately', () => {
      const { rerender } = render(
        <SessionTelemetryPill paneId="pane-b1" config={sampleSshConfig} cpuPct={94} latencyMs={45} />
      );

      const pill = screen.getByTestId('session-telemetry-pill');
      expect(pill).toHaveAttribute('data-health', 'warning');
      expect(screen.getByTestId('session-telemetry-dot')).toHaveClass('sshs3-sonar-amber');

      fireEvent.click(pill);
      expect(screen.getByTestId('session-telemetry-status-badge')).toHaveTextContent('High Load');

      // Rerender in disconnected / offline state
      rerender(
        <SessionTelemetryPill
          paneId="pane-b1"
          config={sampleSshConfig}
          disconnected={true}
        />
      );

      expect(screen.getByTestId('session-telemetry-pill')).toHaveAttribute('data-health', 'offline');
      expect(screen.getByTestId('session-telemetry-cpu')).toHaveTextContent('Offline');
      expect(screen.getByTestId('session-telemetry-latency')).toHaveTextContent('-- ms');
      expect(screen.getByTestId('session-telemetry-status-badge')).toHaveTextContent('Offline');
    });

    it('F7.6 (Tier 2 Boundary): buildSparklinePolylinePoints and computeSessionTelemetry clamp out-of-range inputs and produce valid 8-point coordinates', () => {
      const pointsStr = buildSparklinePolylinePoints([-40, 0, 50, 100, 250, Number.NaN], 56, 16);
      const pairs = pointsStr.split(' ');
      expect(pairs).toHaveLength(8);
      for (const pair of pairs) {
        const [x, y] = pair.split(',').map(Number);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(56);
        expect(y).toBeGreaterThanOrEqual(2);
        expect(y).toBeLessThanOrEqual(14);
      }

      const snap = computeSessionTelemetry({
        seedKey: 'ceph-osd-node',
        clusterOrRole: 'ceph-san',
        cpuPct: 140,
        memPct: -15,
        latencyMs: '185 ms',
      });
      expect(snap.cpuPct).toBe(100);
      expect(snap.memPct).toBe(0);
      expect(snap.latencyNumericMs).toBe(185);
      expect(snap.healthStatus).toBe('warning');
    });
  });

  // ============================================================================
  // FEATURE F8: SSH + SFTP Split View (Host Workspace)
  // ============================================================================
  describe('F8: SSH + SFTP Split View (Host Workspace)', () => {
    it('F8.1: splitPaneWithSftp creates a 2-child row split with an SFTP surface leaf bound to the same SSHConnectionConfig', () => {
      const rootTerminal = createLeaf('term-leaf-1', {
        config: sampleSshConfig,
        sftpInitialPath: '/var/log',
      });
      expect(isSftpLeaf(rootTerminal)).toBe(false);
      expect(getLeafSurfaceType(rootTerminal)).toBe('terminal');

      const { tree, newPaneId } = splitPaneWithSftp(rootTerminal, 'term-leaf-1', 'ws', '/etc/nginx');
      expect(tree.type).toBe('split');
      if (tree.type === 'split') {
        expect(tree.orientation).toBe('row');
        expect(tree.children).toHaveLength(2);
        const [first, second] = tree.children;
        expect(first.id).toBe('term-leaf-1');
        expect(second.id).toBe(newPaneId);
        expect(second.type).toBe('leaf');
        if (second.type === 'leaf') {
          expect(isSftpLeaf(second)).toBe(true);
          expect(second.surfaceType).toBe('sftp');
          expect(second.leafType).toBe('sftp');
          expect(second.config).toEqual(sampleSshConfig);
          expect(second.sshConfig).toEqual(sampleSshConfig);
          expect(second.sftpInitialPath).toBe('/etc/nginx');
        }
      }
    });

    it('F8.2: clicking pane-split-sftp in PaneTreeView splits the terminal side-by-side with DualPaneExplorer (host-workspace-sftp-pane)', () => {
      const terminalLeaf: PaneLeaf = {
        id: 'pane-main-1',
        type: 'leaf',
        local: true,
      };
      const onSplitSftp = vi.fn();

      render(
        <PaneTreeView
          node={terminalLeaf}
          isActive={true}
          activePaneId="pane-main-1"
          totalPanes={1}
          settings={dummySettings}
          platform="linux"
          onSelectPane={vi.fn()}
          onSplitPane={vi.fn()}
          onSplitSftp={onSplitSftp}
          onClosePane={vi.fn()}
          onChangeConnection={vi.fn()}
          onOpenLocalTerminal={vi.fn()}
          onCloseTab={vi.fn()}
        />
      );

      const splitBtn = screen.getByTestId('pane-split-sftp-pane-main-1');
      expect(splitBtn).toHaveAttribute('aria-pressed', 'false');
      expect(screen.getByTestId('pane-split-sftp')).toBeInTheDocument();
      expect(screen.queryByTestId('host-workspace-sftp-pane')).not.toBeInTheDocument();

      // Click SFTP Split button
      fireEvent.click(splitBtn);

      expect(onSplitSftp).toHaveBeenCalledWith('pane-main-1', undefined);
      expect(screen.getByTestId('pane-split-sftp-pane-main-1')).toHaveAttribute(
        'aria-pressed',
        'true'
      );
      expect(screen.getByTestId('host-workspace-sftp-pane')).toBeInTheDocument();
      expect(screen.getByTestId('sftp-pane-pane-main-1-sftp')).toHaveAttribute(
        'data-surface-type',
        'sftp'
      );
    });

    it('F8.3: clicking telemetry-action-split-sftp inside SessionTelemetryPill toggles the side-by-side SFTP Host Workspace split', () => {
      const terminalLeaf: PaneLeaf = {
        id: 'pane-pill-split',
        type: 'leaf',
        local: true,
      };
      const splitEvents: CustomEvent[] = [];
      const onSplitEvent = (e: Event) => splitEvents.push(e as CustomEvent);
      window.addEventListener('sshs3:split-sftp', onSplitEvent);

      try {
        render(
          <PaneTreeView
            node={terminalLeaf}
            isActive={true}
            activePaneId="pane-pill-split"
            totalPanes={1}
            settings={dummySettings}
            platform="linux"
            onSelectPane={vi.fn()}
            onSplitPane={vi.fn()}
            onClosePane={vi.fn()}
            onChangeConnection={vi.fn()}
            onOpenLocalTerminal={vi.fn()}
            onCloseTab={vi.fn()}
          />
        );

        // Open SessionTelemetryPill detail popover and click "Split SFTP"
        fireEvent.click(screen.getByTestId('session-telemetry-pill'));
        const splitActionBtn = screen.getByTestId('telemetry-action-split-sftp');
        expect(splitActionBtn).toHaveTextContent('Split SFTP');
        fireEvent.click(splitActionBtn);

        expect(splitEvents).toHaveLength(1);
        expect(screen.getByTestId('host-workspace-sftp-pane')).toBeInTheDocument();

        // Open pill again; button now reads "Close SFTP Split" and closes the SFTP pane when clicked
        fireEvent.click(screen.getByTestId('session-telemetry-pill'));
        const closeActionBtn = screen.getByTestId('telemetry-action-split-sftp');
        expect(closeActionBtn).toHaveTextContent('Close SFTP Split');
        fireEvent.click(closeActionBtn);

        expect(screen.queryByTestId('host-workspace-sftp-pane')).not.toBeInTheDocument();
      } finally {
        window.removeEventListener('sshs3:split-sftp', onSplitEvent);
      }
    });

    it('F8.4: renders resizable SplitDivider between SSH terminal and SFTP split pane and updates split weights on keyboard resize', () => {
      const terminalLeaf: PaneLeaf = {
        id: 'pane-resize-1',
        type: 'leaf',
        local: true,
      };
      const onResizeSplit = vi.fn();

      render(
        <PaneTreeView
          node={terminalLeaf}
          isActive={true}
          activePaneId="pane-resize-1"
          totalPanes={1}
          settings={dummySettings}
          platform="linux"
          onSelectPane={vi.fn()}
          onSplitPane={vi.fn()}
          onResizeSplit={onResizeSplit}
          onClosePane={vi.fn()}
          onChangeConnection={vi.fn()}
          onOpenLocalTerminal={vi.fn()}
          onCloseTab={vi.fn()}
        />
      );

      fireEvent.click(screen.getByTestId('pane-split-sftp-pane-resize-1'));

      const divider = screen.getByRole('separator', { name: 'Resize terminal panes' });
      expect(divider).toBeInTheDocument();
      expect(divider).toHaveAttribute('aria-valuenow', '50');

      fireEvent.keyDown(divider, { key: 'ArrowRight', ctrlKey: true, altKey: true });
      expect(onResizeSplit).toHaveBeenCalledTimes(1);
      const [splitId, weights] = onResizeSplit.mock.calls[0];
      expect(splitId).toBe('pane-resize-1-sftp-split');
      expect(weights[0]).toBeCloseTo(0.55);
      expect(weights[1]).toBeCloseTo(0.45);
      expect(divider).toHaveAttribute('aria-valuenow', '55');
    });

    it('F8.5: closing the SFTP split pane via close-sftp-split preserves the exact terminal portal container without unmounting the session', () => {
      const terminalLeaf: PaneLeaf = {
        id: 'pane-preserve-1',
        type: 'leaf',
      };
      const onClosePane = vi.fn();

      render(
        <PaneTreeView
          node={terminalLeaf}
          isActive={true}
          activePaneId="pane-preserve-1"
          totalPanes={1}
          settings={dummySettings}
          platform="linux"
          onSelectPane={vi.fn()}
          onSplitPane={vi.fn()}
          onClosePane={onClosePane}
          onChangeConnection={vi.fn()}
          onOpenLocalTerminal={vi.fn()}
          onCloseTab={vi.fn()}
        />
      );

      const openLocalBtnBefore = screen.getByRole('button', { name: 'Open Local Terminal' });

      // Split into SSH + SFTP
      fireEvent.click(screen.getByTestId('pane-split-sftp-pane-preserve-1'));
      expect(screen.getByTestId('host-workspace-sftp-pane')).toBeInTheDocument();
      expect(screen.getByTestId('close-sftp-split')).toBeInTheDocument();

      // Close the SFTP split pane using the close button
      fireEvent.click(screen.getByTestId('close-pane-pane-preserve-1-sftp'));
      expect(screen.queryByTestId('host-workspace-sftp-pane')).not.toBeInTheDocument();
      expect(onClosePane).not.toHaveBeenCalled();

      // Verify the exact same DOM node instance inside the terminal portal survived both transitions
      const openLocalBtnAfter = screen.getByRole('button', { name: 'Open Local Terminal' });
      expect(openLocalBtnAfter).toBe(openLocalBtnBefore);
    });

    it('F8.6: clicking blade-connect-workspace in LandingView queues a Host Workspace split that PaneTreeView automatically opens side-by-side', async () => {
      const onConnectRecentSSH = vi.fn();
      const { unmount } = render(
        <LandingView
          recentSSH={[sampleSshConfig]}
          onConnectRecentSSH={onConnectRecentSSH}
          onConnectSFTP={vi.fn()}
          onQuickStartTerminal={vi.fn()}
          onNewTab={vi.fn()}
          onOpenProfiles={vi.fn()}
          onNewProfile={vi.fn()}
          onOpenSyncBootstrap={vi.fn()}
          onNavigateToTabBar={vi.fn()}
        />
      );

      fireEvent.click(screen.getByTestId(`blade-connect-workspace-${sampleSshConfig.id}`));
      expect(onConnectRecentSSH).toHaveBeenCalledWith(sampleSshConfig);
      unmount();

      // Mount PaneTreeView for the newly connected SSH leaf; it should consume the pending split and open SFTP automatically
      const connectedLeaf: PaneLeaf = {
        id: 'pane-auto-ws',
        type: 'leaf',
        config: sampleSshConfig,
      };
      render(
        <PaneTreeView
          node={connectedLeaf}
          isActive={true}
          activePaneId="pane-auto-ws"
          totalPanes={1}
          settings={dummySettings}
          platform="linux"
          onSelectPane={vi.fn()}
          onSplitPane={vi.fn()}
          onClosePane={vi.fn()}
          onChangeConnection={vi.fn()}
          onOpenLocalTerminal={vi.fn()}
          onCloseTab={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('host-workspace-sftp-pane')).toBeInTheDocument();
      });
      expect(screen.getByTestId('pane-split-sftp-pane-auto-ws')).toHaveAttribute(
        'aria-pressed',
        'true'
      );
    });
  });
});
