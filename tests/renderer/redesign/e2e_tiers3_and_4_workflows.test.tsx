// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { App } from '../../../src/renderer/src/App';
import { PaneTreeView } from '../../../src/renderer/src/components/PaneTree';
import { FilePane } from '../../../src/renderer/src/components/FileManager/FilePane';
import { S3CloudExplorer } from '../../../src/renderer/src/components/FileManager/S3CloudExplorer';
import { S3InspectorPanel } from '../../../src/renderer/src/components/FileManager/S3InspectorPanel';
import { DragDropProvider } from '../../../src/renderer/src/components/FileManager/DragDropLayer';
import { ConfirmProvider } from '../../../src/renderer/src/components/ConfirmDialog';
import { consumePendingHostWorkspaceSplit } from '../../../src/renderer/src/lib/paneTree';
import type { TransferProgress, FileEntry } from '../../../src/shared/types/storage';
import type { SSHConnectionConfig } from '../../../src/shared/types/ssh';
import type { AppSettings } from '../../../src/shared/types/settings';
import type { PaneLeaf } from '../../../src/shared/types/session';

// Polyfill ResizeObserver, scrollIntoView, and matchMedia for JSDOM
class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = vi.fn();
}

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

const prodSshProfile: SSHConnectionConfig = {
  id: 'ssh-prod-01',
  name: 'prod-ontap-01',
  host: '10.10.20.11',
  port: 22,
  username: 'admin',
  authType: 'agent',
  cluster: 'MetroCluster-North',
  role: 'NetApp ONTAP',
  lastUsedAt: '2026-11-06T12:00:00Z',
  tags: ['prod', 'storage'],
};

const s3Entries: FileEntry[] = [
  {
    name: 'prod-vault-bucket',
    path: '/prod-vault-bucket',
    size: 0,
    isDirectory: true,
  },
  {
    name: 'storage-policy.json',
    path: '/prod-vault-bucket/storage-policy.json',
    size: 8192,
    isDirectory: false,
    mtime: '2026-11-06 09:15',
    etag: '"etag-policy-991"',
  },
  {
    name: 'runbook-dr.md',
    path: '/prod-vault-bucket/runbook-dr.md',
    size: 16384,
    isDirectory: false,
    mtime: '2026-11-06 10:00',
    etag: '"etag-runbook-772"',
  },
];

describe('E2E Tiers 3 & 4: Cross-Feature Combinations & Real-World Operator Workflows (F1–F11)', () => {
  let transferProgressListeners: Array<(progress: TransferProgress) => void> = [];
  let terminalDataListeners: Array<(sessionId: string, data: string) => void> = [];

  const emitTransferProgress = (progress: TransferProgress) => {
    for (const cb of transferProgressListeners) {
      cb(progress);
    }
  };

  const emitTerminalData = (sessionId: string, data: string) => {
    for (const cb of terminalDataListeners) {
      cb(sessionId, data);
    }
  };

  beforeEach(() => {
    transferProgressListeners = [];
    terminalDataListeners = [];
    consumePendingHostWorkspaceSplit(prodSshProfile);
    document.documentElement.className = 'dark';

    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
        readText: vi.fn().mockResolvedValue(''),
      },
      configurable: true,
      writable: true,
    });

    window.multissh = {
      ...(window.multissh || {}),
      getPlatform: vi.fn().mockResolvedValue('linux'),
      getHostname: vi.fn().mockResolvedValue('sre-workstation'),
      detectLocalShells: vi.fn().mockResolvedValue({ pwsh: true, wsl: true }),
      terminalCreate: vi.fn().mockResolvedValue({ sessionId: 'e2e-pty-1' }),
      terminalWrite: vi.fn().mockResolvedValue(undefined),
      terminalResize: vi.fn().mockResolvedValue(undefined),
      terminalKill: vi.fn().mockResolvedValue(undefined),
      onTerminalData: vi.fn((cb) => {
        terminalDataListeners.push(cb);
        return () => {
          terminalDataListeners = terminalDataListeners.filter((item) => item !== cb);
        };
      }),
      onTerminalExit: vi.fn(() => vi.fn()),
      onAskpassPrompt: vi.fn(() => vi.fn()),
      submitAskpassPin: vi.fn().mockResolvedValue(undefined),
      connectStorage: vi.fn().mockResolvedValue({ id: 'storage-e2e-1' }),
      storageList: vi.fn().mockImplementation(async (_providerId: string, path: string) => {
        if (path === '/') {
          return [
            { name: 'prod-vault-bucket', path: '/prod-vault-bucket', size: 0, isDirectory: true },
            { name: 'audit-logs-bucket', path: '/audit-logs-bucket', size: 0, isDirectory: true },
          ];
        }
        return [s3Entries[1], s3Entries[2]];
      }),
      storageCreateFolder: vi.fn().mockResolvedValue(undefined),
      storageGetTags: vi.fn().mockResolvedValue([{ key: 'compliance', value: 'soc2' }]),
      storageSetTags: vi.fn().mockResolvedValue(undefined),
      storageGetBucketPolicy: vi
        .fn()
        .mockResolvedValue('{"Version":"2012-10-17","Statement":[{"Effect":"Allow"}]}'),
      storageGetBucketCors: vi
        .fn()
        .mockResolvedValue('[{"AllowedMethods":["GET","PUT"],"AllowedOrigins":["https://ops.internal"]}]'),
      storageGetBucketVersioning: vi.fn().mockResolvedValue({ status: 'Enabled' }),
      storageSetBucketVersioning: vi.fn().mockResolvedValue(undefined),
      storageListObjectVersions: vi.fn().mockResolvedValue([
        {
          versionId: 'v2-current',
          isLatest: true,
          isDeleteMarker: false,
          size: 8192,
          lastModified: '2026-11-06',
        },
        {
          versionId: 'v1-old',
          isLatest: false,
          isDeleteMarker: false,
          size: 4096,
          lastModified: '2026-11-01',
        },
      ]),
      storageRestoreObjectVersion: vi.fn().mockResolvedValue(undefined),
      storageGetPresignedUrl: vi
        .fn()
        .mockImplementation(
          async (_pid: string, path: string, sec: number) =>
            `https://s3.eu-north-1.amazonaws.com${path}?X-Amz-Expires=${sec}&X-Amz-Signature=signed99`
        ),
      getHomeDir: vi.fn().mockResolvedValue('/home/admin'),
      storageGetHomeDir: vi.fn().mockResolvedValue('/home/admin'),
      transferGetJobs: vi.fn().mockResolvedValue([]),
      transferClearCompleted: vi.fn().mockResolvedValue(undefined),
      transferPause: vi.fn().mockResolvedValue(undefined),
      transferResume: vi.fn().mockResolvedValue(undefined),
      transferCancel: vi.fn().mockResolvedValue(undefined),
      onTransferProgress: vi.fn((cb) => {
        transferProgressListeners.push(cb);
        return () => {
          transferProgressListeners = transferProgressListeners.filter((item) => item !== cb);
        };
      }),
      sessionGet: vi.fn().mockResolvedValue({
        tabs: [
          {
            id: 'term-1',
            type: 'terminal',
            title: 'prod-ontap-01',
            paneTree: {
              id: 'pane-1',
              type: 'leaf',
              config: prodSshProfile,
            },
            activePaneId: 'pane-1',
          },
        ],
        activeTabId: 'term-1',
      }),
      sessionSave: vi.fn().mockResolvedValue(undefined),
      settingsGet: vi.fn().mockResolvedValue(undefined),
      settingsSave: vi.fn().mockImplementation(async (patch) => patch),
      profilesGet: vi.fn().mockResolvedValue({
        ssh: [prodSshProfile],
        s3: [
          {
            id: 's3-prod-1',
            name: 'AWS Prod Vault',
            endpoint: 'https://s3.eu-north-1.amazonaws.com',
            region: 'eu-north-1',
            accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
          },
        ],
      }),
      profilesSaveSSH: vi.fn().mockResolvedValue(undefined),
      teamVaultList: vi.fn().mockResolvedValue([]),
      sshTunnelList: vi.fn().mockResolvedValue([]),
      onSshTunnelEvent: vi.fn(() => vi.fn()),
      dirSyncProfileList: vi.fn().mockResolvedValue([]),
      onSearchResult: vi.fn(() => vi.fn()),
      onSearchProgress: vi.fn(() => vi.fn()),
      onSearchError: vi.fn(() => vi.fn()),
      onSearchDone: vi.fn(() => vi.fn()),
      searchStart: vi.fn().mockResolvedValue({ searchId: 's-e2e' }),
      searchCancel: vi.fn().mockResolvedValue(undefined),
      searchPreview: vi.fn().mockResolvedValue({ content: '', startLine: 1 }),
      aiHubRequest: vi.fn().mockResolvedValue({
        config: {},
        preferences: {},
        runtime: { bundled: true },
        sessions: [],
        tasks: [],
        memories: [],
        schedules: [],
        inventory: [],
        workspaceServers: [
          {
            id: 'ssh-prod-01',
            name: 'prod-ontap-01',
            host: '10.10.20.11',
            port: 22,
            username: 'admin',
            cluster: 'MetroCluster-North',
          },
          {
            id: 'ssh-prod-02',
            name: 'prod-ontap-02',
            host: '10.10.20.12',
            port: 22,
            username: 'admin',
            cluster: 'MetroCluster-North',
          },
        ],
      }),
      onAiHubChanged: vi.fn(() => vi.fn()),
    } as unknown as typeof window.multissh;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    document.documentElement.className = '';
  });

  // ============================================================================
  // TIER 3: Cross-Feature Pairwise & Multi-Feature Combinations
  // ============================================================================
  describe('Tier 3: Cross-Feature Combinations (F2–F11)', () => {
    it('T3.1 (F2 + F3 + F5): switches themes (Dark -> Light -> Breeze) via BottomStatusBar while SlideOverDrawers and AI Hub are open', async () => {
      render(<App />);
      await screen.findByTestId('tab-term-1');

      // Open Connections left drawer and AI Hub right drawer simultaneously
      fireEvent.click(screen.getByTestId('drawer-toggle-connections'));
      expect(await screen.findByTestId('drawer-connections')).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('drawer-toggle-ai'));
      expect(screen.getByTestId('drawer-ai')).toHaveAttribute('data-drawer-open', 'true');

      // Switch to Light theme while drawers are open
      fireEvent.click(screen.getByTestId('status-theme-light'));
      await waitFor(() => {
        expect(document.documentElement.classList.contains('light')).toBe(true);
        expect(document.documentElement.classList.contains('dark')).toBe(false);
      });
      expect(screen.getByTestId('drawer-connections')).toBeInTheDocument();
      expect(screen.getByTestId('drawer-ai')).toHaveAttribute('data-drawer-open', 'true');

      // Switch to Breeze theme while drawers are open
      fireEvent.click(screen.getByTestId('status-theme-breeze'));
      await waitFor(() => {
        expect(document.documentElement.classList.contains('breeze')).toBe(true);
        expect(document.documentElement.classList.contains('light')).toBe(false);
      });

      // Switch back to Dark theme
      fireEvent.click(screen.getByTestId('status-theme-dark'));
      await waitFor(() => {
        expect(document.documentElement.classList.contains('dark')).toBe(true);
        expect(document.documentElement.classList.contains('breeze')).toBe(false);
      });
    });

    it('T3.2 (F4 + F5): enforces mutually exclusive Slide-Over Drawers when switching across Topbar buttons and Cmd+K Omnibar actions', async () => {
      render(<App />);
      await screen.findByTestId('tab-term-1');

      // Open Left Connections drawer from Topbar
      fireEvent.click(screen.getByTestId('drawer-toggle-connections'));
      expect(await screen.findByTestId('drawer-connections')).toBeInTheDocument();

      // Directly click Settings drawer toggle -> Connections drawer must close automatically
      fireEvent.click(screen.getByTestId('drawer-toggle-settings'));
      await waitFor(() => {
        expect(screen.queryByTestId('drawer-connections')).not.toBeInTheDocument();
      });
      expect(await screen.findByTestId('drawer-settings')).toBeInTheDocument();

      // Open Omnibar -> Settings drawer must close automatically
      fireEvent.click(screen.getByTestId('omnibar-trigger'));
      await waitFor(() => {
        expect(screen.queryByTestId('drawer-settings')).not.toBeInTheDocument();
      });
      expect(await screen.findByTestId('global-search-palette')).toBeInTheDocument();

      // Trigger DirSync drawer from Omnibar quick action
      fireEvent.click(screen.getByTestId('omnibar-action-dirsync'));
      await waitFor(() => {
        expect(screen.queryByTestId('global-search-palette')).not.toBeInTheDocument();
      });
      expect(await screen.findByTestId('drawer-dirsync')).toBeInTheDocument();
    });

    it('T3.3 (F4 + F6): keeps GlobalTransferHud and expandable TransferQueueDrawer live across Terminal, Mission Control, and File Manager tabs', async () => {
      render(<App />);
      await screen.findByTestId('tab-term-1');

      act(() => {
        emitTransferProgress({
          jobId: 'tx-cross-1',
          fileName: 'ontap-core-dump.tar.zst',
          transferredBytes: 75 * 1024 * 1024,
          totalBytes: 100 * 1024 * 1024,
          percentage: 75,
          bytesPerSecond: 25 * 1024 * 1024,
          status: 'running',
        });
      });

      const hud = screen.getByTestId('global-transfer-hud');
      expect(hud).toHaveTextContent('1 active');
      expect(hud).toHaveTextContent('75%');

      // Expand transfer drawer while on Terminal tab
      fireEvent.click(hud);
      expect(await screen.findByTestId('global-transfer-drawer')).toBeInTheDocument();

      // Switch to Mission Control Home tab -> transfer HUD & drawer remain visible
      fireEvent.click(screen.getByTestId('topbar-brand-home'));
      expect(await screen.findByTestId('landing-view')).toBeInTheDocument();
      expect(screen.getByTestId('global-transfer-drawer')).toHaveTextContent('ontap-core-dump.tar.zst');

      // Switch back to Terminal tab and pause transfer
      fireEvent.click(screen.getByTestId('tab-term-1'));
      fireEvent.click(
        within(screen.getByTestId('global-transfer-drawer')).getByRole('button', { name: 'Pause' })
      );
      expect(window.multissh.transferPause).toHaveBeenCalledWith('tx-cross-1');
    });

    it('T3.4 (F6 + F8): splits active SSH terminal into Host Workspace SFTP view while tracking live SFTP transfer throughput in BottomStatusBar', async () => {
      render(<App />);
      await screen.findByTestId('tab-term-1');

      // Split the SSH terminal side-by-side with SFTP browser
      fireEvent.click(screen.getByTestId('pane-split-sftp'));
      expect(await screen.findByTestId('host-workspace-sftp-pane')).toBeInTheDocument();

      // Simulate an SFTP upload starting from the split pane
      act(() => {
        emitTransferProgress({
          jobId: 'sftp-split-tx-1',
          fileName: 'sysctl-Cluster.conf',
          transferredBytes: 4096,
          totalBytes: 8192,
          percentage: 50,
          bytesPerSecond: 2 * 1024 * 1024,
          status: 'running',
        });
      });

      const hud = screen.getByTestId('global-transfer-hud');
      expect(hud).toHaveTextContent('1 active');
      expect(hud).toHaveTextContent('50%');
      expect(screen.getByTestId('global-transfer-speed')).toBeInTheDocument();
      expect(screen.getByTestId('host-workspace-sftp-pane')).toBeInTheDocument();
    });

    it('T3.5 (F7 + F8): synchronizes SessionTelemetryPill "Split SFTP" state with PaneTree header split button and SFTP close button', async () => {
      const leaf: PaneLeaf = {
        id: 'pane-sync-1',
        type: 'leaf',
        config: prodSshProfile,
      };

      render(
        <PaneTreeView
          node={leaf}
          isActive={true}
          activePaneId="pane-sync-1"
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

      // Initially unsplit
      expect(screen.getByTestId('pane-split-sftp-pane-sync-1')).toHaveAttribute('aria-pressed', 'false');

      // Split via SessionTelemetryPill
      fireEvent.click(screen.getByTestId('session-telemetry-pill'));
      expect(screen.getByTestId('telemetry-action-split-sftp')).toHaveTextContent('Split SFTP');
      fireEvent.click(screen.getByTestId('telemetry-action-split-sftp'));

      // Header button reflects active split state
      expect(screen.getByTestId('pane-split-sftp-pane-sync-1')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByTestId('host-workspace-sftp-pane')).toBeInTheDocument();

      // Close SFTP pane via the SFTP header close button
      fireEvent.click(screen.getByTestId('close-pane-pane-sync-1-sftp'));
      expect(screen.queryByTestId('host-workspace-sftp-pane')).not.toBeInTheDocument();
      expect(screen.getByTestId('pane-split-sftp-pane-sync-1')).toHaveAttribute('aria-pressed', 'false');

      // Telemetry pill button reflects unsplit state again
      fireEvent.click(screen.getByTestId('session-telemetry-pill'));
      expect(screen.getByTestId('telemetry-action-split-sftp')).toHaveTextContent('Split SFTP');
    });

    it('T3.6 (F7 + F5): clicking "Diagnose with AI" inside SessionTelemetryPill opens the AI Hub right drawer and "Open Fleet Overview" navigates to Fleet view in App', async () => {
      render(<App />);
      await screen.findByTestId('tab-term-1');

      expect(screen.getByTestId('drawer-ai')).toHaveAttribute('data-drawer-open', 'false');

      // Open SessionTelemetryPill in active terminal header and click Diagnose with AI
      fireEvent.click(screen.getByTestId('session-telemetry-pill'));
      fireEvent.click(screen.getByTestId('telemetry-action-diagnose-ai'));

      await waitFor(() => {
        expect(screen.getByTestId('drawer-ai')).toHaveAttribute('data-drawer-open', 'true');
      });

      // Re-open SessionTelemetryPill and click Open Fleet Overview -> navigates to landing-view
      fireEvent.click(screen.getByTestId('session-telemetry-pill'));
      fireEvent.click(screen.getByTestId('telemetry-action-open-fleet'));

      expect(await screen.findByTestId('landing-view')).toBeInTheDocument();
    });

    it('T3.7 (F9 + F11): S3CloudExplorer & S3InspectorPanel trigger S3 Policy generation and Orama Knowledge Base ingestion', async () => {
      const aiOpenEvents: CustomEvent[] = [];
      const onAiOpen = (e: Event) => aiOpenEvents.push(e as CustomEvent);
      window.addEventListener('sshs3:ai-open', onAiOpen);

      try {
        render(
          <ConfirmProvider>
            <DragDropProvider>
              <FilePane
                side="right"
                source={{ providerId: 's3-prod-1', sourceType: 's3', label: 'AWS Prod Vault' }}
                currentPath="/prod-vault-bucket"
                onPathChange={vi.fn()}
                onSourceTypeRequest={vi.fn()}
                onTransferRequested={vi.fn()}
                refreshToken={0}
              />
            </DragDropProvider>
          </ConfirmProvider>
        );

        expect(await screen.findByTestId('s3-cloud-explorer')).toBeInTheDocument();
        expect(screen.getByTestId('s3-inspector-panel')).toBeInTheDocument();

        // Click "Generera S3-policy" inside S3InspectorPanel
        const policyButtons = screen.getAllByTestId('ai-action-generate-s3-policy');
        fireEvent.click(policyButtons[policyButtons.length - 1]);

        expect(aiOpenEvents.length).toBeGreaterThanOrEqual(1);
        expect(aiOpenEvents[aiOpenEvents.length - 1].detail).toEqual(
          expect.objectContaining({
            mode: 'panel',
            view: 'Work',
            prompt: expect.stringContaining('prod-vault-bucket'),
          })
        );

        // Click "Indexera i Kunskapsbas" to ingest S3 bucket docs into Orama
        const indexButtons = screen.getAllByTestId('ai-action-index-kb');
        fireEvent.click(indexButtons[indexButtons.length - 1]);

        await waitFor(() => {
          expect(window.multissh.aiHubRequest).toHaveBeenCalledWith(
            expect.objectContaining({
              action: 'kb-ingest-s3',
            })
          );
        });
      } finally {
        window.removeEventListener('sshs3:ai-open', onAiOpen);
      }
    });

    it('T3.8 (F8 + F11): SFTP FilePane "Förklara konfigurationsdiff" dispatches sshs3:ai-open with remote SFTP path context', async () => {
      const aiOpenEvents: CustomEvent[] = [];
      const onAiOpen = (e: Event) => aiOpenEvents.push(e as CustomEvent);
      window.addEventListener('sshs3:ai-open', onAiOpen);

      try {
        render(
          <ConfirmProvider>
            <DragDropProvider>
              <FilePane
                side="left"
                source={{
                  providerId: 'sftp-prod-01',
                  sourceType: 'sftp',
                  label: 'prod-ontap-01',
                }}
                currentPath="/etc/nginx"
                onPathChange={vi.fn()}
                onSourceTypeRequest={vi.fn()}
                onTransferRequested={vi.fn()}
                refreshToken={0}
              />
            </DragDropProvider>
          </ConfirmProvider>
        );

        // SFTP sourceType does NOT render S3CloudExplorer, but DOES expose contextual AI actions
        expect(screen.queryByTestId('s3-cloud-explorer')).not.toBeInTheDocument();
        const explainDiffBtn = await screen.findByTestId('ai-action-explain-diff');
        fireEvent.click(explainDiffBtn);

        expect(aiOpenEvents).toHaveLength(1);
        expect(aiOpenEvents[0].detail).toEqual(
          expect.objectContaining({
            mode: 'panel',
            view: 'Work',
            prompt: expect.stringContaining('/etc/nginx'),
          })
        );
      } finally {
        window.removeEventListener('sshs3:ai-open', onAiOpen);
      }
    });

    it('T3.9 (F10 + F5): non-zero exit code in App terminal surfaces Ambient Co-Pilot pill and clicking it opens the AI Hub drawer', async () => {
      render(<App />);
      await screen.findByTestId('tab-term-1');

      await waitFor(() => {
        expect(terminalDataListeners.length).toBeGreaterThan(0);
      });

      // Emit failed command with OSC 133;D;2
      act(() => {
        emitTerminalData(
          'e2e-pty-1',
          'mount -t nfs 10.10.20.11:/vol0 /mnt/nfs\r\nmount.nfs: Connection timed out\x1b]133;D;2\x07\r\n'
        );
      });

      const copilotPill = await screen.findByTestId('terminal-copilot-pill');
      expect(copilotPill).toBeInTheDocument();
      expect(copilotPill).toHaveClass('sshs3-copilot-pill');

      // Click the floating Co-Pilot button -> opens AI Hub right drawer
      fireEvent.click(screen.getByTestId('terminal-fix-error-btn'));
      await waitFor(() => {
        expect(screen.getByTestId('drawer-ai')).toHaveAttribute('data-drawer-open', 'true');
      });
    });
  });

  // ============================================================================
  // TIER 4: Real-World Application Scenarios Across All 6 Locked /grill-me Decisions
  // ============================================================================
  describe('Tier 4: Real-World End-to-End Application Scenarios', () => {
    it('T4.1 (Decision #1 & #6): Operator Shell & Theme Tour — Omnibar commands, Slide-Over Drawers, and Dark/Light/Breeze transitions', async () => {
      render(<App />);
      await screen.findByTestId('tab-term-1');

      // Open Omnibar and execute >light command
      fireEvent.click(screen.getByTestId('omnibar-trigger'));
      const input = await screen.findByRole('combobox');
      fireEvent.change(input, { target: { value: '>light' } });
      await waitFor(() => expect(screen.getAllByRole('option')[0]).toHaveTextContent('Theme: Light'));
      fireEvent.keyDown(input, { key: 'Enter' });

      await waitFor(() => {
        expect(document.documentElement.classList.contains('light')).toBe(true);
      });

      // Re-open Omnibar and open AI Hub drawer via quick action chip
      fireEvent.click(screen.getByTestId('omnibar-trigger'));
      fireEvent.click(await screen.findByTestId('omnibar-action-ai'));
      await waitFor(() => {
        expect(screen.getByTestId('drawer-ai')).toHaveAttribute('data-drawer-open', 'true');
      });
    });

    it('T4.2 (Scenario A — Fleet Incident Triage): Operator starts on Mission Control in Light theme, connects to Server Blade, hits terminal error, and triages in AI Hub', async () => {
      render(<App />);
      await screen.findByTestId('tab-term-1');

      // Switch to Light theme and navigate to Mission Control Fleet Home
      fireEvent.click(screen.getByTestId('status-theme-light'));
      fireEvent.click(screen.getByTestId('topbar-brand-home'));

      const landing = await screen.findByTestId('landing-view');
      expect(landing).toBeInTheDocument();
      expect(document.documentElement.classList.contains('light')).toBe(true);

      // Connect to recent Server Blade from Mission Control
      const connectBtn = await screen.findByTestId('recent-connect-ssh-prod-01');
      fireEvent.click(connectBtn);

      // Wait for the newly connected tab's TerminalView to register its data listener
      await waitFor(() => expect(terminalDataListeners.length).toBeGreaterThanOrEqual(2));
      act(() => {
        emitTerminalData(
          'e2e-pty-1',
          'storage failover show\r\nError: partner node mailbox degraded\x1b]133;D;1\x07\r\n'
        );
      });

      const copilotPills = await screen.findAllByTestId('terminal-copilot-pill');
      expect(copilotPills.length).toBeGreaterThanOrEqual(1);
      const fixBtns = screen.getAllByTestId('terminal-fix-error-btn');
      fireEvent.click(fixBtns[fixBtns.length - 1]);

      await waitFor(() => {
        expect(screen.getByTestId('drawer-ai')).toHaveAttribute('data-drawer-open', 'true');
      });
    });

    it('T4.3 (Scenario B — Host Workspace Live Config Fix): Operator inspects SessionTelemetryPill, splits SFTP pane, resizes split, and completes background transfer in GlobalTransferHud', async () => {
      render(<App />);
      await screen.findByTestId('tab-term-1');

      // 1. Inspect live host telemetry in header pill
      fireEvent.click(screen.getByTestId('session-telemetry-pill'));
      expect(screen.getByTestId('session-telemetry-detail')).toBeInTheDocument();

      // 2. Click "Split SFTP" inside telemetry popover
      fireEvent.click(screen.getByTestId('telemetry-action-split-sftp'));
      expect(await screen.findByTestId('host-workspace-sftp-pane')).toBeInTheDocument();

      // 3. Resize split divider between SSH terminal and SFTP browser
      const divider = screen.getByRole('separator', { name: 'Resize terminal panes' });
      fireEvent.keyDown(divider, { key: 'ArrowLeft', ctrlKey: true, altKey: true });
      expect(divider).toHaveAttribute('aria-valuenow', '45');

      // 4. Track upload progress from 50% -> 100% completion in GlobalTransferHud
      act(() => {
        emitTransferProgress({
          jobId: 'cfg-upload-1',
          fileName: 'haproxy.cfg',
          transferredBytes: 2048,
          totalBytes: 4096,
          percentage: 50,
          bytesPerSecond: 512 * 1024,
          status: 'running',
        });
      });
      expect(screen.getByTestId('global-transfer-hud')).toHaveTextContent('1 active');

      act(() => {
        emitTransferProgress({
          jobId: 'cfg-upload-1',
          fileName: 'haproxy.cfg',
          transferredBytes: 4096,
          totalBytes: 4096,
          percentage: 100,
          bytesPerSecond: 0,
          status: 'completed',
        });
      });

      // Open transfer drawer and clear completed jobs
      fireEvent.click(screen.getByTestId('global-transfer-hud'));
      const drawer = await screen.findByTestId('global-transfer-drawer');
      expect(within(drawer).getByText('haproxy.cfg')).toBeInTheDocument();
      fireEvent.click(within(drawer).getByRole('button', { name: 'Clear completed' }));
      expect(window.multissh.transferClearCompleted).toHaveBeenCalled();
    });

    it('T4.4 (Scenario C — Cloud Object Storage Governance): Operator browses S3 bucket tree, inspects object, updates tags, restores version, generates Presigned URL, and requests AI policy', async () => {
      const onNavigate = vi.fn();
      const onRefresh = vi.fn();
      const aiOpenEvents: CustomEvent[] = [];
      const onAiOpen = (e: Event) => aiOpenEvents.push(e as CustomEvent);
      window.addEventListener('sshs3:ai-open', onAiOpen);

      try {
        render(
          <S3CloudExplorer
            providerId="s3-prod-1"
            providerLabel="AWS Prod Vault"
            currentPath="/prod-vault-bucket"
            entries={[s3Entries[1], s3Entries[2]]}
            selectedEntries={[s3Entries[1]]}
            onNavigate={onNavigate}
            onRefresh={onRefresh}
          >
            <div data-testid="s3-virtual-table">Virtualized Rows</div>
          </S3CloudExplorer>
        );

        // Verify 3-column Cloud Explorer layout
        expect(screen.getByTestId('s3-bucket-tree')).toBeInTheDocument();
        expect(screen.getByTestId('s3-object-table')).toBeInTheDocument();
        expect(screen.getByTestId('s3-inspector-panel')).toBeInTheDocument();

        // Wait for bucket list and inspector metadata
        expect(await screen.findByTestId('s3-tree-bucket-prod-vault-bucket')).toBeInTheDocument();
        expect(screen.getByTestId('s3-inspector-object-key')).toHaveTextContent('storage-policy.json');

        // Add a governance tag and save
        await waitFor(() => expect(window.multissh.storageGetTags).toHaveBeenCalled());
        fireEvent.click(screen.getByTestId('s3-tags-add-btn'));
        const keyInputs = screen.getAllByLabelText('Tag key');
        const valInputs = screen.getAllByLabelText('Tag value');
        fireEvent.change(keyInputs[keyInputs.length - 1], { target: { value: 'retention' } });
        fireEvent.change(valInputs[valInputs.length - 1], { target: { value: '7-years' } });
        fireEvent.click(screen.getByTestId('s3-tags-save-btn'));

        await waitFor(() => {
          expect(window.multissh.storageSetTags).toHaveBeenCalledWith(
            's3-prod-1',
            '/prod-vault-bucket/storage-policy.json',
            [
              { key: 'compliance', value: 'soc2' },
              { key: 'retention', value: '7-years' },
            ]
          );
        });

        // Restore previous version v1-old
        const restoreBtn = await screen.findByTestId('s3-version-restore-v1-old');
        fireEvent.click(restoreBtn);
        await waitFor(() => {
          expect(window.multissh.storageRestoreObjectVersion).toHaveBeenCalledWith(
            's3-prod-1',
            '/prod-vault-bucket/storage-policy.json',
            'v1-old'
          );
        });

        // Generate 1-click Presigned URL
        fireEvent.click(screen.getByTestId('s3-presign-generate-btn'));
        const presignInput = (await screen.findByTestId('s3-presign-url-input')) as HTMLInputElement;
        expect(presignInput.value).toContain('https://s3.eu-north-1.amazonaws.com/prod-vault-bucket/storage-policy.json');

        // Trigger AI S3 Policy generation
        fireEvent.click(screen.getByTestId('ai-action-generate-s3-policy'));
        expect(aiOpenEvents).toHaveLength(1);
      } finally {
        window.removeEventListener('sshs3:ai-open', onAiOpen);
      }
    });

    it('T4.5 (Decision #2, #3 & #5): Multi-node Cluster Split tab opens via sshs3:open-cluster-split and triggers AI Split-Analys into AI Hub drawer', async () => {
      render(<App />);
      await screen.findByTestId('tab-term-1');

      act(() => {
        window.dispatchEvent(
          new CustomEvent('sshs3:open-cluster-split', {
            detail: {
              cluster: 'MetroCluster-North',
              serverIds: ['ssh-prod-01', 'ssh-prod-02'],
              layout: 'horizontal',
            },
          })
        );
      });

      const splitAiBtn = await screen.findByTestId('split-view-ask-ai-btn');
      expect(splitAiBtn).toHaveTextContent('✨ AI Split-Analys (2)');

      fireEvent.click(splitAiBtn);
      await waitFor(() => {
        expect(screen.getByTestId('drawer-ai')).toHaveAttribute('data-drawer-open', 'true');
      });
    });

    it('T4.6 (Adversarial / Encoding & Escaping Integrity): safely handles special characters, ANSI codes, and script-like payloads across S3 Inspector and Terminal Co-Pilot', async () => {
      const adversarialEntry: FileEntry = {
        name: '<img src=x onerror=alert(1)>&"weird\'file.conf',
        path: '/prod-vault-bucket/<img src=x onerror=alert(1)>&"weird\'file.conf',
        size: 1024,
        isDirectory: false,
        etag: '"<script>evil()</script>"',
      };

      render(
        <S3InspectorPanel
          providerId="s3-prod-1"
          providerLabel="AWS Prod Vault"
          currentPath="/prod-vault-bucket"
          entries={[adversarialEntry]}
          selectedEntries={[adversarialEntry]}
        />
      );

      // Must render literal escaped text without injecting executable HTML nodes
      const keyEl = screen.getByTestId('s3-inspector-object-key');
      expect(keyEl).toHaveTextContent('<img src=x onerror=alert(1)>&"weird\'file.conf');
      expect(keyEl.querySelector('img')).toBeNull();
      expect(screen.getByTestId('s3-inspector-object-etag').querySelector('script')).toBeNull();
    });

    it('T4.7 (All 6 Locked /grill-me Decisions Unified End-to-End Tour): exercises Topbar/Omnibar/Drawers (#1), Fleet & Telemetry Pill (#2), Host Split & HUD (#3), S3 Inspector (#4), Co-Pilot (#5), and Multi-Theme (#6)', async () => {
      render(<App />);
      await screen.findByTestId('tab-term-1');

      // Decision #6: Switch to Breeze theme
      fireEvent.click(screen.getByTestId('status-theme-breeze'));
      expect(document.documentElement.classList.contains('breeze')).toBe(true);

      // Decision #1: Open Left Inventory Drawer & close with Escape
      fireEvent.click(screen.getByTestId('drawer-toggle-connections'));
      expect(await screen.findByTestId('drawer-connections')).toBeInTheDocument();
      fireEvent.keyDown(window, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByTestId('drawer-connections')).not.toBeInTheDocument());

      // Decision #2: Check inline SessionTelemetryPill in active terminal tab
      const pill = screen.getByTestId('session-telemetry-pill');
      expect(pill).toBeInTheDocument();

      // Decision #3: Split SSH terminal with SFTP Host Workspace & verify GlobalTransferHud
      fireEvent.click(screen.getByTestId('pane-split-sftp'));
      expect(await screen.findByTestId('host-workspace-sftp-pane')).toBeInTheDocument();
      expect(screen.getByTestId('global-transfer-hud')).toBeInTheDocument();

      // Decision #5: Trigger Ambient Terminal Co-Pilot pill on error and open AI Hub drawer
      act(() => {
        emitTerminalData('e2e-pty-1', 'systemctl status ceph-mon\r\nUnit ceph-mon.service failed.\x1b]133;D;3\x07\r\n');
      });
      expect(await screen.findByTestId('terminal-copilot-pill')).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('terminal-fix-error-btn'));
      await waitFor(() => {
        expect(screen.getByTestId('drawer-ai')).toHaveAttribute('data-drawer-open', 'true');
      });
    });
  });
});
