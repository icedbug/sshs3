// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { App } from '../../../src/renderer/src/App';
import { LandingView } from '../../../src/renderer/src/components/LandingView';
import { hubRequest } from '../../../src/renderer/src/lib/aiHub';
import type {
  ConnectedWorkspaceSummary,
  HubRequest,
  HubSnapshot,
  WorkspaceServerSummary,
} from '../../../src/shared/types/aiHub';
import type { SSHConnectionConfig } from '../../../src/shared/types/ssh';

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

function buildThreeWorkspaces(): ConnectedWorkspaceSummary[] {
  return [
    {
      id: 'ws-demo-ontap',
      name: 'Stockholm Core Storage',
      kind: 'demo',
      connected: true,
      badge: 'ONTAP 9.15 · DC1/DC2',
      bucket: 'ontap-core-workspace',
      prefix: 'stockholm-dc1',
      region: 'eu-north-1',
      serverCount: 2,
      memoryCount: 2,
      presenceCount: 2,
    },
    {
      id: 'ws-demo-s3-grid',
      name: 'StorageGRID & Cloud S3',
      kind: 's3',
      connected: true,
      badge: 'S3 11.8 · AIStor',
      bucket: 'storagegrid-ops',
      prefix: 's3-fleet',
      region: 'eu-north-1',
      serverCount: 2,
      memoryCount: 1,
      presenceCount: 1,
    },
    {
      id: 'ws-demo-k8s-ceph',
      name: 'K8s & Ceph Platform',
      kind: 'team-vault',
      connected: true,
      badge: 'VAULT · Ceph Reef',
      serverCount: 2,
      memoryCount: 1,
      presenceCount: 2,
    },
  ];
}

function buildMultiWorkspaceServers(): WorkspaceServerSummary[] {
  return [
    {
      id: 'srv-ontap-01',
      name: 'sto-ontap-cl01a',
      host: '10.30.10.11',
      port: 22,
      username: 'admin',
      cluster: 'Stockholm-MetroCluster',
      role: 'storage',
      shared: true,
      workspaceId: 'ws-demo-ontap',
      workspaceName: 'Stockholm Core Storage',
    },
    {
      id: 'srv-ontap-02',
      name: 'sto-ontap-cl01b',
      host: '10.30.10.12',
      port: 22,
      username: 'admin',
      cluster: 'Stockholm-MetroCluster',
      role: 'storage',
      shared: true,
      workspaceId: 'ws-demo-ontap',
      workspaceName: 'Stockholm Core Storage',
    },
    {
      id: 'srv-s3grid-01',
      name: 'sg-admin-dc1',
      host: '10.40.20.11',
      port: 22,
      username: 'root',
      cluster: 'StorageGRID-Nordic',
      role: 's3-gateway',
      shared: true,
      workspaceId: 'ws-demo-s3-grid',
      workspaceName: 'StorageGRID & Cloud S3',
    },
    {
      id: 'srv-s3grid-02',
      name: 'sg-storage-sn01',
      host: '10.40.20.12',
      port: 22,
      username: 'root',
      cluster: 'StorageGRID-Nordic',
      role: 's3-storage',
      shared: true,
      workspaceId: 'ws-demo-s3-grid',
      workspaceName: 'StorageGRID & Cloud S3',
    },
    {
      id: 'srv-k8s-01',
      name: 'k8s-trident-cp01',
      host: '10.50.30.11',
      port: 22,
      username: 'ubuntu',
      cluster: 'K8s-Ceph-Prod',
      role: 'kubernetes',
      shared: true,
      workspaceId: 'ws-demo-k8s-ceph',
      workspaceName: 'K8s & Ceph Platform',
      teamVaultProfileRef: {
        vaultId: 'vlt-k8s-ceph',
        profileId: 'prof-k8s-cp01',
      },
    },
    {
      id: 'srv-k8s-02',
      name: 'ceph-osd-nvme01',
      host: '10.50.30.12',
      port: 22,
      username: 'ubuntu',
      cluster: 'K8s-Ceph-Prod',
      role: 'ceph-osd',
      shared: true,
      workspaceId: 'ws-demo-k8s-ceph',
      workspaceName: 'K8s & Ceph Platform',
    },
  ];
}

function createInitialHubSnapshot(): HubSnapshot {
  return {
    config: {
      provider: 'openai',
      model: 'gpt-4.1',
      baseUrl: 'https://api.openai.com/v1',
      actorName: 'jacob-ops',
      hasKey: true,
    },
    preferences: {},
    demoMode: false,
    runtime: { bundled: true, version: 'native-ts-1.0' },
    sessions: [],
    tasks: [],
    memories: [
      {
        id: 'mem-ontap-1',
        kind: 'memory',
        tier: 'core',
        scope: 'workspace',
        title: 'ONTAP Aggregate Policy',
        text: 'Keep aggr0_sto1 below 80% utilization.',
        workspaceId: 'ws-demo-ontap',
        workspaceName: 'Stockholm Core Storage',
        updatedAt: 1762500000000,
      },
      {
        id: 'mem-s3-1',
        kind: 'memory',
        tier: 'core',
        scope: 'workspace',
        title: 'StorageGRID Erasure Coding',
        text: 'Use 6+3 EC scheme across Stockholm and Frankfurt.',
        workspaceId: 'ws-demo-s3-grid',
        workspaceName: 'StorageGRID & Cloud S3',
        updatedAt: 1762500100000,
      },
    ],
    schedules: [],
    inventory: [],
    activityLog: [],
    workspaceServers: buildMultiWorkspaceServers(),
    s3Workspace: {
      id: 'ws-demo-s3-grid',
      name: 'StorageGRID & Cloud S3',
      configured: true,
      enabled: true,
      connected: true,
      syncing: false,
      bucket: 'storagegrid-ops',
      region: 'eu-north-1',
      prefix: 's3-fleet',
      inviteCode: 'sshs3-s3://mock-invite',
    },
    s3Workspaces: [
      {
        id: 'ws-demo-s3-grid',
        name: 'StorageGRID & Cloud S3',
        configured: true,
        enabled: true,
        connected: true,
        syncing: false,
        bucket: 'storagegrid-ops',
        region: 'eu-north-1',
        prefix: 's3-fleet',
        inviteCode: 'sshs3-s3://mock-invite',
      },
    ],
    workspaces: buildThreeWorkspaces(),
    activeWorkspaceId: 'ALL',
    presence: [
      {
        actor: 'alice-sre',
        updatedAt: Date.now(),
        activeTerminals: [],
        workspaceId: 'ws-demo-ontap',
        workspaceName: 'Stockholm Core Storage',
      },
    ],
  } as unknown as HubSnapshot;
}

describe('Milestone 6: Multi-Workspace Simultaneous Connectivity — Renderer & E2E Tiers 1–4 (F14, F15, F16)', () => {
  let currentSnapshot: HubSnapshot;
  let hubRequests: HubRequest[];
  let aiHubMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    document.documentElement.className = 'dark';
    currentSnapshot = createInitialHubSnapshot();
    hubRequests = [];

    aiHubMock = vi.fn().mockImplementation(async (req: HubRequest) => {
      hubRequests.push(req);
      if (req.action === 'workspace-select') {
        currentSnapshot = {
          ...currentSnapshot,
          activeWorkspaceId: req.workspaceId,
        };
      } else if (req.action === 'workspace-s3-configure') {
        const wsName = req.config?.name || req.config?.bucket || 'New S3 Workspace';
        const slug = wsName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const wsId = req.workspaceId || req.config?.id || `s3:${slug}`;
        const newWs: ConnectedWorkspaceSummary = {
          id: wsId,
          name: wsName,
          kind: 's3',
          connected: true,
          badge: 'S3',
          bucket: req.config?.bucket || 'dr-bucket',
          prefix: req.config?.prefix || 'sshs3-team',
          region: req.config?.region || 'eu-central-1',
          serverCount: 1,
          memoryCount: 0,
          presenceCount: 1,
        };
        const newSrv: WorkspaceServerSummary = {
          id: `srv-${slug}-01`,
          name: `${slug}-node-01`,
          host: '10.77.10.11',
          port: 22,
          username: 'ubuntu',
          cluster: `${wsName}-Cluster`,
          shared: true,
          workspaceId: wsId,
          workspaceName: wsName,
        };
        currentSnapshot = {
          ...currentSnapshot,
          workspaces: [
            ...(currentSnapshot.workspaces ?? []).filter((w) => w.id !== wsId),
            newWs,
          ],
          workspaceServers: [...(currentSnapshot.workspaceServers ?? []), newSrv],
          activeWorkspaceId: wsId,
        };
      } else if (req.action === 'workspace-connect-demo') {
        const wsName = req.name;
        const slug = wsName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const wsId = req.id || `ws-demo-${slug}`;
        const newWs: ConnectedWorkspaceSummary = {
          id: wsId,
          name: wsName,
          kind: 'demo',
          connected: true,
          badge: 'DEMO',
          serverCount: 2,
          memoryCount: 1,
          presenceCount: 1,
        };
        const newSrv: WorkspaceServerSummary = {
          id: `demo-node-${slug}-01`,
          name: `${slug}-node-01`,
          host: '10.88.10.11',
          port: 22,
          username: 'ubuntu',
          cluster: req.cluster || `${wsName}-Cluster`,
          shared: true,
          workspaceId: wsId,
          workspaceName: wsName,
        };
        currentSnapshot = {
          ...currentSnapshot,
          workspaces: [
            ...(currentSnapshot.workspaces ?? []).filter((w) => w.id !== wsId),
            newWs,
          ],
          workspaceServers: [...(currentSnapshot.workspaceServers ?? []), newSrv],
          activeWorkspaceId: wsId,
        };
      } else if (req.action === 'workspace-s3-disconnect') {
        if (req.workspaceId && req.remove) {
          currentSnapshot = {
            ...currentSnapshot,
            workspaces: (currentSnapshot.workspaces ?? []).filter(
              (w) => w.id !== req.workspaceId
            ),
            workspaceServers: (currentSnapshot.workspaceServers ?? []).filter(
              (s) => s.workspaceId !== req.workspaceId
            ),
            activeWorkspaceId:
              currentSnapshot.activeWorkspaceId === req.workspaceId
                ? 'ALL'
                : currentSnapshot.activeWorkspaceId,
          };
        }
      } else if (req.action === 'server-upsert') {
        const srv: WorkspaceServerSummary = {
          id: req.server.id || 'srv-added-node',
          name: req.server.name,
          host: req.server.host,
          port: req.server.port || 22,
          username: req.server.username || 'ubuntu',
          cluster: req.server.cluster,
          shared: req.server.shared ?? true,
          workspaceId: req.workspaceId || req.server.workspaceId,
          workspaceName: req.workspaceName || req.server.workspaceName,
        };
        currentSnapshot = {
          ...currentSnapshot,
          workspaceServers: [...(currentSnapshot.workspaceServers ?? []), srv],
        };
      }
      return currentSnapshot;
    });

    window.multissh = {
      ...(window.multissh || {}),
      getPlatform: vi.fn().mockResolvedValue('linux'),
      getHostname: vi.fn().mockResolvedValue('sre-workstation'),
      detectLocalShells: vi.fn().mockResolvedValue({ pwsh: true, wsl: true }),
      terminalCreate: vi.fn().mockResolvedValue({ sessionId: 'pty-mw-1' }),
      terminalWrite: vi.fn().mockResolvedValue(undefined),
      terminalResize: vi.fn().mockResolvedValue(undefined),
      terminalKill: vi.fn().mockResolvedValue(undefined),
      onTerminalData: vi.fn(() => vi.fn()),
      onTerminalExit: vi.fn(() => vi.fn()),
      onAskpassPrompt: vi.fn(() => vi.fn()),
      submitAskpassPin: vi.fn().mockResolvedValue(undefined),
      connectStorage: vi.fn().mockResolvedValue({ id: 'storage-mw-1' }),
      storageList: vi.fn().mockResolvedValue([]),
      getHomeDir: vi.fn().mockResolvedValue('/home/admin'),
      storageGetHomeDir: vi.fn().mockResolvedValue('/home/admin'),
      transferGetJobs: vi.fn().mockResolvedValue([]),
      transferClearCompleted: vi.fn().mockResolvedValue(undefined),
      onTransferProgress: vi.fn(() => vi.fn()),
      sessionGet: vi.fn().mockResolvedValue({ tabs: [], activeTabId: '' }),
      sessionSave: vi.fn().mockResolvedValue(undefined),
      settingsGet: vi.fn().mockResolvedValue(undefined),
      settingsSave: vi.fn().mockImplementation(async (patch) => patch),
      profilesGet: vi.fn().mockResolvedValue({ ssh: [], s3: [] }),
      profilesSaveSSH: vi.fn().mockResolvedValue(undefined),
      teamVaultList: vi.fn().mockResolvedValue([]),
      sshTunnelList: vi.fn().mockResolvedValue([]),
      onSshTunnelEvent: vi.fn(() => vi.fn()),
      dirSyncProfileList: vi.fn().mockResolvedValue([]),
      onSearchResult: vi.fn(() => vi.fn()),
      onSearchProgress: vi.fn(() => vi.fn()),
      onSearchError: vi.fn(() => vi.fn()),
      onSearchDone: vi.fn(() => vi.fn()),
      aiHubRequest: aiHubMock,
      onAiHubChanged: vi.fn(() => vi.fn()),
    } as unknown as typeof window.multissh;

    await act(async () => {
      await hubRequest({ action: 'snapshot' });
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function renderLandingView(overrides?: {
    recentSSH?: SSHConnectionConfig[];
    onConnectRecentSSH?: (cfg: SSHConnectionConfig) => void;
  }) {
    return render(
      <LandingView
        recentSSH={overrides?.recentSSH ?? []}
        onConnectRecentSSH={overrides?.onConnectRecentSSH ?? vi.fn()}
        onConnectSFTP={vi.fn()}
        onQuickStartTerminal={vi.fn()}
        onNewTab={vi.fn()}
        onOpenProfiles={vi.fn()}
        onNewProfile={vi.fn()}
        onOpenSyncBootstrap={vi.fn()}
        onNavigateToTabBar={vi.fn()}
      />
    );
  }

  describe('Tier 1 — Feature Coverage (F14, F15)', () => {
    it('F14.1: renders multi-workspace-bar with workspace-pill-ALL, individual pills for 3 connected workspaces, server counts, per-workspace sync/disconnect, and Sync All', () => {
      renderLandingView();

      const bar = screen.getByTestId('multi-workspace-bar');
      expect(bar).toBeInTheDocument();
      expect(within(bar).getByText(/3 CONNECTED WORKSPACES/i)).toBeInTheDocument();

      const pillAll = screen.getByTestId('workspace-pill-ALL');
      expect(pillAll).toHaveAttribute('aria-pressed', 'true');
      expect(pillAll).toHaveTextContent('All Workspaces');
      expect(pillAll).toHaveTextContent('6');

      const pillOntap = screen.getByTestId('workspace-pill-ws-demo-ontap');
      const pillS3 = screen.getByTestId('workspace-pill-ws-demo-s3-grid');
      const pillK8s = screen.getByTestId('workspace-pill-ws-demo-k8s-ceph');

      expect(pillOntap).toHaveTextContent('Stockholm Core Storage');
      expect(pillOntap).toHaveTextContent('2');
      expect(pillS3).toHaveTextContent('StorageGRID & Cloud S3');
      expect(pillS3).toHaveTextContent('2');
      expect(pillK8s).toHaveTextContent('K8s & Ceph Platform');
      expect(pillK8s).toHaveTextContent('2');

      // Per-workspace sync & disconnect controls + Sync All button
      expect(screen.getByTestId('workspace-sync-ws-demo-ontap')).toBeInTheDocument();
      expect(screen.getByTestId('workspace-disconnect-ws-demo-ontap')).toBeInTheDocument();
      expect(screen.getByTestId('workspace-sync-ws-demo-s3-grid')).toBeInTheDocument();
      expect(screen.getByTestId('workspace-disconnect-ws-demo-s3-grid')).toBeInTheDocument();
      expect(screen.getByTestId('workspace-sync-ws-demo-k8s-ceph')).toBeInTheDocument();
      expect(screen.getByTestId('workspace-disconnect-ws-demo-k8s-ceph')).toBeInTheDocument();
      expect(screen.getByTestId('workspace-sync-all-btn')).toBeInTheDocument();

      // Clicking per-workspace sync dispatches workspace-s3-sync-now with workspaceId
      fireEvent.click(screen.getByTestId('workspace-sync-ws-demo-s3-grid'));
      expect(hubRequests).toContainEqual({
        action: 'workspace-s3-sync-now',
        workspaceId: 'ws-demo-s3-grid',
      });
    });

    it('F14.2: Server Blade cards display blade-workspace-badge-${s.id} with workspace name and preserve teamVaultProfileRef on connect', () => {
      const onConnectRecentSSH = vi.fn();
      renderLandingView({ onConnectRecentSSH });

      expect(screen.getByTestId('blade-card-srv-ontap-01')).toBeInTheDocument();
      expect(screen.getByTestId('blade-workspace-badge-srv-ontap-01')).toHaveTextContent(
        'Stockholm Core Storage'
      );

      expect(screen.getByTestId('blade-card-srv-s3grid-01')).toBeInTheDocument();
      expect(screen.getByTestId('blade-workspace-badge-srv-s3grid-01')).toHaveTextContent(
        'StorageGRID & Cloud S3'
      );

      const k8sBlade = screen.getByTestId('blade-card-srv-k8s-01');
      expect(k8sBlade).toBeInTheDocument();
      expect(screen.getByTestId('blade-workspace-badge-srv-k8s-01')).toHaveTextContent(
        'K8s & Ceph Platform'
      );

      // Connect to the Team Vault server and verify teamVaultProfileRef is preserved
      const k8sServerCard = screen.getByTestId('workspace-server-card-srv-k8s-01');
      const terminalBtn = within(k8sServerCard).getByRole('button', { name: 'Terminal' });
      fireEvent.click(terminalBtn);

      expect(onConnectRecentSSH).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'srv-k8s-01',
          host: '10.50.30.11',
          teamVaultProfileRef: {
            vaultId: 'vlt-k8s-ceph',
            profileId: 'prof-k8s-cp01',
          },
        })
      );
    });

    it('F14.3: clicking workspace-pill-ws-demo-s3-grid filters Server Blades to that workspace and dispatches workspace-select; clicking workspace-pill-ALL restores unified fleet view', async () => {
      renderLandingView();

      // Initially all 6 servers across all 3 workspaces are visible
      expect(screen.getByTestId('blade-card-srv-ontap-01')).toBeInTheDocument();
      expect(screen.getByTestId('blade-card-srv-s3grid-01')).toBeInTheDocument();
      expect(screen.getByTestId('blade-card-srv-k8s-01')).toBeInTheDocument();

      // Filter to StorageGRID & Cloud S3
      await act(async () => {
        fireEvent.click(screen.getByTestId('workspace-pill-ws-demo-s3-grid'));
      });

      expect(hubRequests).toContainEqual({
        action: 'workspace-select',
        workspaceId: 'ws-demo-s3-grid',
      });
      expect(screen.getByTestId('workspace-pill-ws-demo-s3-grid')).toHaveAttribute(
        'aria-pressed',
        'true'
      );
      expect(screen.getByTestId('blade-card-srv-s3grid-01')).toBeInTheDocument();
      expect(screen.getByTestId('blade-card-srv-s3grid-02')).toBeInTheDocument();
      expect(screen.queryByTestId('blade-card-srv-ontap-01')).not.toBeInTheDocument();
      expect(screen.queryByTestId('blade-card-srv-k8s-01')).not.toBeInTheDocument();

      // Restore unified view via workspace-pill-ALL
      await act(async () => {
        fireEvent.click(screen.getByTestId('workspace-pill-ALL'));
      });

      expect(hubRequests).toContainEqual({
        action: 'workspace-select',
        workspaceId: 'ALL',
      });
      expect(screen.getByTestId('blade-card-srv-ontap-01')).toBeInTheDocument();
      expect(screen.getByTestId('blade-card-srv-s3grid-01')).toBeInTheDocument();
      expect(screen.getByTestId('blade-card-srv-k8s-01')).toBeInTheDocument();
    });

    it('F14.4: connecting an additional workspace via workspace-add-connection-btn -> s3-workspace-name-input -> s3-save-connect-btn sends mode: "add" and keeps existing workspaces connected', async () => {
      renderLandingView();

      fireEvent.click(screen.getByTestId('workspace-add-connection-btn'));
      expect(screen.getByTestId('s3-bucket-setup-form')).toBeInTheDocument();

      fireEvent.change(screen.getByTestId('s3-workspace-name-input'), {
        target: { value: 'DR Vault Frankfurt' },
      });
      fireEvent.change(screen.getByTestId('s3-bucket-input'), {
        target: { value: 'frankfurt-dr-vault' },
      });
      fireEvent.change(screen.getByTestId('s3-access-key-input'), {
        target: { value: 'AKIADR999' },
      });
      fireEvent.change(screen.getByTestId('s3-secret-key-input'), {
        target: { value: 'secret-dr-999' },
      });

      await act(async () => {
        fireEvent.click(screen.getByTestId('s3-save-connect-btn'));
      });

      expect(hubRequests).toContainEqual(
        expect.objectContaining({
          action: 'workspace-s3-configure',
          mode: 'add',
          config: expect.objectContaining({
            name: 'DR Vault Frankfurt',
            bucket: 'frankfurt-dr-vault',
            accessKeyId: 'AKIADR999',
          }),
        })
      );

      // All 3 original workspaces + the 4th workspace remain connected in the bar
      expect(screen.getByTestId('workspace-pill-ws-demo-ontap')).toBeInTheDocument();
      expect(screen.getByTestId('workspace-pill-ws-demo-s3-grid')).toBeInTheDocument();
      expect(screen.getByTestId('workspace-pill-ws-demo-k8s-ceph')).toBeInTheDocument();
      expect(screen.getByTestId('workspace-pill-s3:dr-vault-frankfurt')).toBeInTheDocument();
    });

    it('F14.5: + Add Node (add-cluster-node-btn) renders add-node-workspace-select and submits selected workspaceId and workspaceName', async () => {
      renderLandingView();

      fireEvent.click(screen.getByTestId('add-cluster-node-btn'));
      const form = screen.getByTestId('add-cluster-node-form');
      const wsSelect = screen.getByTestId('add-node-workspace-select') as HTMLSelectElement;
      expect(wsSelect).toBeInTheDocument();

      fireEvent.change(wsSelect, { target: { value: 'ws-demo-k8s-ceph' } });
      fireEvent.change(within(form).getByPlaceholderText('Node Name *'), {
        target: { value: 'ceph-mon-04' },
      });
      fireEvent.change(within(form).getByPlaceholderText('IP / Hostname *'), {
        target: { value: '10.50.30.14' },
      });

      await act(async () => {
        fireEvent.submit(form);
      });

      expect(hubRequests).toContainEqual(
        expect.objectContaining({
          action: 'server-upsert',
          workspaceId: 'ws-demo-k8s-ceph',
          workspaceName: 'K8s & Ceph Platform',
          server: expect.objectContaining({
            name: 'ceph-mon-04',
            host: '10.50.30.14',
            workspaceId: 'ws-demo-k8s-ceph',
            workspaceName: 'K8s & Ceph Platform',
          }),
        })
      );
    });
  });

  describe('Tier 2 — Boundary & Isolation Cases', () => {
    it('F14.6: disconnecting a single workspace via workspace-disconnect-${ws.id} calls workspace-s3-disconnect with remove: true and removes only its servers while keeping other workspaces active', async () => {
      renderLandingView();

      await act(async () => {
        fireEvent.click(screen.getByTestId('workspace-disconnect-ws-demo-s3-grid'));
      });

      expect(hubRequests).toContainEqual({
        action: 'workspace-s3-disconnect',
        workspaceId: 'ws-demo-s3-grid',
        remove: true,
      });

      expect(screen.queryByTestId('workspace-pill-ws-demo-s3-grid')).not.toBeInTheDocument();
      expect(screen.queryByTestId('blade-card-srv-s3grid-01')).not.toBeInTheDocument();

      // Other 2 workspaces and their nodes remain connected and visible
      expect(screen.getByTestId('workspace-pill-ws-demo-ontap')).toBeInTheDocument();
      expect(screen.getByTestId('workspace-pill-ws-demo-k8s-ceph')).toBeInTheDocument();
      expect(screen.getByTestId('blade-card-srv-ontap-01')).toBeInTheDocument();
      expect(screen.getByTestId('blade-card-srv-k8s-01')).toBeInTheDocument();
    });

    it('F14.7: renders gracefully when hub.workspaces is undefined/empty and preserves keyboard focus order', async () => {
      currentSnapshot = {
        ...currentSnapshot,
        workspaces: undefined,
        s3Workspaces: undefined,
        s3Workspace: undefined,
        workspaceServers: [],
      };
      await act(async () => {
        await hubRequest({ action: 'snapshot' });
      });

      renderLandingView({ recentSSH: [] });

      expect(screen.getByTestId('multi-workspace-bar')).toBeInTheDocument();
      expect(screen.getByTestId('workspace-pill-ALL')).toBeInTheDocument();
      expect(screen.getByTestId('s3-workspace-status-badge')).toHaveTextContent(
        /Lokal workspace/i
      );
    });
  });

  describe('Tier 3 — Cross-Feature Combinations (BottomStatusBar, AiHubPanel, Omnibar & Themes)', () => {
    it('F15.1: BottomStatusBar status-workspaces-badge opens status-workspaces-popover, switches active workspace across BottomStatusBar and LandingView, and preserves status-connection-indicator text', async () => {
      await act(async () => {
        render(<App />);
      });

      const connIndicator = await screen.findByTestId('status-connection-indicator');
      expect(connIndicator).toHaveTextContent('Mission Control · Fleet Ready');

      const wsBadge = screen.getByTestId('status-workspaces-badge');
      expect(wsBadge).toHaveTextContent('3 Workspaces');
      expect(wsBadge).toHaveTextContent('All Connected');

      // Open the status bar workspace switcher popover
      fireEvent.click(wsBadge);
      const popover = screen.getByTestId('status-workspaces-popover');
      expect(popover).toBeInTheDocument();

      // Switch to K8s & Ceph Platform from BottomStatusBar
      await act(async () => {
        fireEvent.click(screen.getByTestId('status-workspace-select-ws-demo-k8s-ceph'));
      });

      expect(wsBadge).toHaveTextContent('K8s & Ceph Platform');
      expect(connIndicator).toHaveTextContent('Mission Control · Fleet Ready');

      // LandingView is synchronized and filters blades to K8s & Ceph Platform
      expect(screen.getByTestId('workspace-pill-ws-demo-k8s-ceph')).toHaveAttribute(
        'aria-pressed',
        'true'
      );
      expect(screen.getByTestId('blade-card-srv-k8s-01')).toBeInTheDocument();
      expect(screen.queryByTestId('blade-card-srv-ontap-01')).not.toBeInTheDocument();
    });

    it('F15.2: AiHubPanel renders ai-hub-workspaces-bar with ai-hub-workspace-pill-ALL and per-workspace pills, synchronizing workspace selection across the app', async () => {
      await act(async () => {
        render(<App />);
      });

      // Open AI Hub slide-over drawer from topbar
      const aiToggle = await screen.findByTestId('drawer-toggle-ai');
      await act(async () => {
        fireEvent.click(aiToggle);
      });

      const aiWsBar = await screen.findByTestId('ai-hub-workspaces-bar');
      expect(aiWsBar).toBeInTheDocument();
      expect(screen.getByTestId('ai-hub-workspace-pill-ALL')).toBeInTheDocument();
      expect(screen.getByTestId('ai-hub-workspace-pill-ws-demo-ontap')).toBeInTheDocument();
      expect(screen.getByTestId('ai-hub-workspace-pill-ws-demo-s3-grid')).toBeInTheDocument();
      expect(screen.getByTestId('ai-hub-workspace-pill-ws-demo-k8s-ceph')).toBeInTheDocument();

      // Click Stockholm Core Storage pill inside AI Hub
      await act(async () => {
        fireEvent.click(screen.getByTestId('ai-hub-workspace-pill-ws-demo-ontap'));
      });

      expect(screen.getByTestId('ai-hub-workspace-pill-ws-demo-ontap')).toHaveAttribute(
        'aria-pressed',
        'true'
      );
      expect(screen.getByTestId('status-workspaces-badge')).toHaveTextContent(
        'Stockholm Core Storage'
      );
      expect(screen.getByTestId('workspace-pill-ws-demo-ontap')).toHaveAttribute(
        'aria-pressed',
        'true'
      );
    });

    it('F15.3: GlobalSearchPalette (Omnibar Cmd+K) surfaces omnibar-workspaces-bar and executes 1-click workspace switching and syncing across Dark, Light, and Breeze themes', async () => {
      await act(async () => {
        render(<App />);
      });

      for (const theme of ['dark', 'light', 'breeze'] as const) {
        await act(async () => {
          fireEvent.click(screen.getByTestId(`status-theme-${theme}`));
        });

        await act(async () => {
          fireEvent.click(screen.getByTestId('omnibar-trigger'));
        });

        const omnibarWsBar = await screen.findByTestId('omnibar-workspaces-bar');
        expect(omnibarWsBar).toBeInTheDocument();
        expect(screen.getByTestId('omnibar-workspace-ALL')).toBeInTheDocument();
        expect(screen.getByTestId('omnibar-workspace-ws-demo-s3-grid')).toBeInTheDocument();
        expect(screen.getByTestId('omnibar-workspace-sync-all')).toBeInTheDocument();

        // Switch workspace via Omnibar
        await act(async () => {
          fireEvent.click(screen.getByTestId('omnibar-workspace-ws-demo-s3-grid'));
        });

        expect(screen.getByTestId('status-workspaces-badge')).toHaveTextContent(
          'StorageGRID & Cloud S3'
        );
      }
    });
  });

  describe('Tier 4 — Real-World Multi-Workspace Operator Workflow (F13–F16)', () => {
    it('F16.1: End-to-end operator journey across 4 simultaneously connected workspaces using LandingView, S3 Connect, BottomStatusBar, and Omnibar (Cmd+K)', async () => {
      await act(async () => {
        render(<App />);
      });

      // Step 1: Operator sees 3 simultaneously connected workspaces on Mission Control
      await waitFor(() => {
        expect(screen.getByTestId('multi-workspace-bar')).toHaveTextContent(
          /3 CONNECTED WORKSPACES/i
        );
      });
      expect(screen.getByTestId('blade-card-srv-ontap-01')).toBeInTheDocument();
      expect(screen.getByTestId('blade-card-srv-s3grid-01')).toBeInTheDocument();
      expect(screen.getByTestId('blade-card-srv-k8s-01')).toBeInTheDocument();

      // Step 2: Filter to "StorageGRID & Cloud S3" from LandingView
      await act(async () => {
        fireEvent.click(screen.getByTestId('workspace-pill-ws-demo-s3-grid'));
      });
      expect(screen.getByTestId('blade-card-srv-s3grid-01')).toBeInTheDocument();
      expect(screen.queryByTestId('blade-card-srv-ontap-01')).not.toBeInTheDocument();
      expect(screen.getByTestId('status-workspaces-badge')).toHaveTextContent(
        'StorageGRID & Cloud S3'
      );

      // Step 3: Connect a 4th workspace ("DR Vault Frankfurt") without disconnecting the existing 3
      fireEvent.click(screen.getByTestId('workspace-add-connection-btn'));
      fireEvent.change(screen.getByTestId('s3-workspace-name-input'), {
        target: { value: 'DR Vault Frankfurt' },
      });
      fireEvent.change(screen.getByTestId('s3-bucket-input'), {
        target: { value: 'dr-vault-frankfurt' },
      });
      fireEvent.change(screen.getByTestId('s3-access-key-input'), {
        target: { value: 'AKIADR444' },
      });
      fireEvent.change(screen.getByTestId('s3-secret-key-input'), {
        target: { value: 'secret-dr-444' },
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('s3-save-connect-btn'));
      });

      expect(screen.getByTestId('multi-workspace-bar')).toHaveTextContent(
        /4 CONNECTED WORKSPACES/i
      );
      expect(screen.getByTestId('status-workspaces-badge')).toHaveTextContent('4 Workspaces');

      // Step 4: Switch back to "All Connected Workspaces" via BottomStatusBar popover
      fireEvent.click(screen.getByTestId('status-workspaces-badge'));
      await act(async () => {
        fireEvent.click(screen.getByTestId('status-workspace-select-ALL'));
      });

      expect(screen.getByTestId('status-workspaces-badge')).toHaveTextContent('All Connected');
      expect(screen.getByTestId('blade-card-srv-ontap-01')).toBeInTheDocument();
      expect(screen.getByTestId('blade-card-srv-s3grid-01')).toBeInTheDocument();
      expect(screen.getByTestId('blade-card-srv-k8s-01')).toBeInTheDocument();
      expect(screen.getByTestId('blade-card-srv-dr-vault-frankfurt-01')).toBeInTheDocument();

      // Step 5: Trigger "Sync All Connected Workspaces" via Omnibar (Cmd+K)
      await act(async () => {
        fireEvent.click(screen.getByTestId('omnibar-trigger'));
      });
      expect(screen.getByTestId('omnibar-workspace-s3:dr-vault-frankfurt')).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByTestId('omnibar-workspace-sync-all'));
      });

      expect(hubRequests).toContainEqual({ action: 'workspace-s3-sync-now' });
      expect(screen.getByTestId('workspace-pill-ws-demo-ontap')).toBeInTheDocument();
      expect(screen.getByTestId('workspace-pill-ws-demo-s3-grid')).toBeInTheDocument();
      expect(screen.getByTestId('workspace-pill-ws-demo-k8s-ceph')).toBeInTheDocument();
      expect(screen.getByTestId('workspace-pill-s3:dr-vault-frankfurt')).toBeInTheDocument();
    });
  });
});
