// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { S3CloudExplorer } from '../../../src/renderer/src/components/FileManager/S3CloudExplorer';
import { S3InspectorPanel } from '../../../src/renderer/src/components/FileManager/S3InspectorPanel';
import { FilePane } from '../../../src/renderer/src/components/FileManager/FilePane';
import { DragDropProvider } from '../../../src/renderer/src/components/FileManager/DragDropLayer';
import { ConfirmProvider } from '../../../src/renderer/src/components/ConfirmDialog';
import { TerminalView } from '../../../src/renderer/src/components/TerminalView';
import type { FileEntry } from '../../../src/shared/types/storage';
import type { SSHConnectionConfig } from '../../../src/shared/types/ssh';

// Polyfill ResizeObserver and matchMedia for JSDOM
class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
global.ResizeObserver = MockResizeObserver as any;

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query) => ({
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

describe('Milestone 4: S3 Cloud Explorer & Inspector (F9) & Contextual AI Actions (F11)', () => {
  const sampleEntries: FileEntry[] = [
    {
      name: 'prod-backups',
      path: '/prod-backups',
      size: 0,
      isDirectory: true,
    },
    {
      name: 'cluster-config.yaml',
      path: '/prod-backups/cluster-config.yaml',
      size: 4096,
      isDirectory: false,
      mtime: '2026-11-05 14:30',
      etag: '"9b2cf535f27731c974343645a3985328"',
    },
    {
      name: 'db-snapshot.tar.gz',
      path: '/prod-backups/db-snapshot.tar.gz',
      size: 1048576,
      isDirectory: false,
      mtime: '2026-11-06 08:00',
      etag: '"1a2b3c4d5e6f"',
    },
  ];

  let mockApi: Record<string, any>;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined), readText: vi.fn().mockResolvedValue('') },
      configurable: true,
      writable: true,
    });

    mockApi = {
      storageList: vi.fn().mockImplementation(async (_providerId: string, path: string) => {
        if (path === '/') {
          return [
            { name: 'prod-backups', path: '/prod-backups', size: 0, isDirectory: true },
            { name: 'logs-archive', path: '/logs-archive', size: 0, isDirectory: true },
          ];
        }
        return [
          { name: 'daily', path: '/prod-backups/daily', size: 0, isDirectory: true },
          sampleEntries[1],
          sampleEntries[2],
        ];
      }),
      storageCreateFolder: vi.fn().mockResolvedValue(undefined),
      storageGetTags: vi.fn().mockResolvedValue([{ key: 'env', value: 'production' }]),
      storageSetTags: vi.fn().mockResolvedValue(undefined),
      storageGetBucketPolicy: vi.fn().mockResolvedValue('{"Version":"2012-10-17","Statement":[]}'),
      storageGetBucketCors: vi.fn().mockResolvedValue('[{"AllowedMethods":["GET"],"AllowedOrigins":["*"]}]'),
      storageGetBucketVersioning: vi.fn().mockResolvedValue({ status: 'Enabled' }),
      storageSetBucketVersioning: vi.fn().mockResolvedValue(undefined),
      storageListObjectVersions: vi.fn().mockResolvedValue([
        { versionId: 'v2-latest', isLatest: true, isDeleteMarker: false, size: 4096, lastModified: '2026-11-06' },
        { versionId: 'v1-old', isLatest: false, isDeleteMarker: false, size: 2048, lastModified: '2026-11-01' },
      ]),
      storageRestoreObjectVersion: vi.fn().mockResolvedValue(undefined),
      storageGetPresignedUrl: vi
        .fn()
        .mockImplementation(
          async (_pid: string, path: string, sec: number) =>
            `https://s3.eu-north-1.amazonaws.com${path}?X-Amz-Expires=${sec}&X-Amz-Signature=abc123`
        ),
      aiHubRequest: vi.fn().mockResolvedValue({
        config: {},
        preferences: {},
        runtime: { bundled: true },
        sessions: [],
        tasks: [],
        memories: [],
        schedules: [],
        inventory: [],
      }),
      onTransferProgress: vi.fn().mockReturnValue(() => {}),
      onSearchResult: vi.fn().mockReturnValue(() => {}),
      onSearchProgress: vi.fn().mockReturnValue(() => {}),
      onSearchError: vi.fn().mockReturnValue(() => {}),
      onSearchDone: vi.fn().mockReturnValue(() => {}),
    };
    (window as any).multissh = mockApi;
  });

  afterEach(() => {
    cleanup();
  });

  it('renders 3-column S3CloudExplorer with Bucket Tree, Object Table, and S3InspectorPanel', async () => {
    const onNavigate = vi.fn();
    render(
      <S3CloudExplorer
        providerId="s3-main"
        providerLabel="AWS Prod S3"
        currentPath="/prod-backups"
        entries={[sampleEntries[1], sampleEntries[2]]}
        selectedEntries={[sampleEntries[1]]}
        onNavigate={onNavigate}
      >
        <div data-testid="mock-inner-list">Object Rows</div>
      </S3CloudExplorer>
    );

    expect(screen.getByTestId('s3-cloud-explorer')).toBeInTheDocument();
    expect(screen.getByTestId('s3-bucket-tree')).toBeInTheDocument();
    expect(screen.getByTestId('s3-object-table')).toBeInTheDocument();
    expect(screen.getByTestId('s3-inspector-panel')).toBeInTheDocument();

    // Wait for buckets to load in tree
    expect(await screen.findByTestId('s3-tree-bucket-prod-backups')).toBeInTheDocument();
    expect(screen.getByTestId('s3-tree-bucket-logs-archive')).toBeInTheDocument();

    // Filter buckets in tree
    fireEvent.change(screen.getByTestId('s3-bucket-tree-filter'), { target: { value: 'logs' } });
    expect(screen.queryByTestId('s3-tree-bucket-prod-backups')).not.toBeInTheDocument();
    expect(screen.getByTestId('s3-tree-bucket-logs-archive')).toBeInTheDocument();

    // Click bucket in tree navigates to it
    fireEvent.click(screen.getByTestId('s3-tree-bucket-logs-archive'));
    expect(onNavigate).toHaveBeenCalledWith('/logs-archive');
  });

  it('displays object metadata, bucket metrics, tags editor, version history, and 1-click Presigned URL in S3InspectorPanel', async () => {
    const onRefresh = vi.fn();
    render(
      <S3InspectorPanel
        providerId="s3-main"
        providerLabel="AWS Prod S3"
        currentPath="/prod-backups"
        entries={[sampleEntries[1], sampleEntries[2]]}
        selectedEntries={[sampleEntries[1]]}
        onRefresh={onRefresh}
      />
    );

    // 1. Metadata section
    expect(screen.getByTestId('s3-inspector-object-key')).toHaveTextContent('cluster-config.yaml');
    expect(screen.getByTestId('s3-inspector-object-size')).toHaveTextContent('4.00 KB');
    expect(screen.getByTestId('s3-inspector-object-etag')).toHaveTextContent('9b2cf535f27731c974343645a3985328');

    // 2. Bucket metrics & governance
    await waitFor(() => {
      expect(mockApi.storageGetBucketVersioning).toHaveBeenCalledWith('s3-main', '/prod-backups');
      expect(mockApi.storageGetBucketPolicy).toHaveBeenCalledWith('s3-main', '/prod-backups');
    });
    expect(screen.getByTestId('s3-metric-object-count')).toHaveTextContent('2');
    expect(screen.getByTestId('s3-metric-versioning-toggle')).toHaveTextContent('Enabled');
    expect(screen.getByTestId('s3-inspector-policy-preview')).toHaveTextContent('"Version":"2012-10-17"');

    // 3. 1-Click Presigned URL Generator
    const expirySelect = screen.getByTestId('s3-presign-expiry-select') as HTMLSelectElement;
    fireEvent.change(expirySelect, { target: { value: String(24 * 3600) } });
    fireEvent.click(screen.getByTestId('s3-presign-generate-btn'));

    await waitFor(() => {
      expect(mockApi.storageGetPresignedUrl).toHaveBeenCalledWith(
        's3-main',
        '/prod-backups/cluster-config.yaml',
        86400
      );
    });
    const urlInput = (await screen.findByTestId('s3-presign-url-input')) as HTMLInputElement;
    expect(urlInput.value).toContain('X-Amz-Expires=86400');
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(urlInput.value);

    // 4. Object Tags Editor
    await waitFor(() => {
      expect(mockApi.storageGetTags).toHaveBeenCalledWith('s3-main', '/prod-backups/cluster-config.yaml');
    });
    fireEvent.click(screen.getByTestId('s3-tags-add-btn'));
    const keyInputs = screen.getAllByLabelText('Tag key');
    const valInputs = screen.getAllByLabelText('Tag value');
    fireEvent.change(keyInputs[keyInputs.length - 1], { target: { value: 'owner' } });
    fireEvent.change(valInputs[valInputs.length - 1], { target: { value: 'sre-team' } });
    fireEvent.click(screen.getByTestId('s3-tags-save-btn'));

    await waitFor(() => {
      expect(mockApi.storageSetTags).toHaveBeenCalledWith('s3-main', '/prod-backups/cluster-config.yaml', [
        { key: 'env', value: 'production' },
        { key: 'owner', value: 'sre-team' },
      ]);
    });

    // 5. Version History & Restore
    await waitFor(() => {
      expect(mockApi.storageListObjectVersions).toHaveBeenCalledWith(
        's3-main',
        '/prod-backups/cluster-config.yaml'
      );
    });
    const restoreBtn = await screen.findByTestId('s3-version-restore-v1-old');
    fireEvent.click(restoreBtn);
    await waitFor(() => {
      expect(mockApi.storageRestoreObjectVersion).toHaveBeenCalledWith(
        's3-main',
        '/prod-backups/cluster-config.yaml',
        'v1-old'
      );
    });
  });

  it('integrates S3 Inspector toggle and Contextual AI Actions inside FilePane', async () => {
    const aiOpenEvents: CustomEvent[] = [];
    const onAiOpen = (e: Event) => aiOpenEvents.push(e as CustomEvent);
    window.addEventListener('sshs3:ai-open', onAiOpen);

    try {
      render(
        <ConfirmProvider>
          <DragDropProvider>
            <FilePane
              side="right"
              source={{ providerId: 's3-prod', sourceType: 's3', label: 'Prod S3' }}
              currentPath="/prod-backups"
              onPathChange={vi.fn()}
              onSourceTypeRequest={vi.fn()}
              onTransferRequested={vi.fn()}
              refreshToken={0}
            />
          </DragDropProvider>
        </ConfirmProvider>
      );

      // S3 Cloud Explorer & Inspector are rendered when sourceType === 's3'
      expect(await screen.findByTestId('s3-cloud-explorer')).toBeInTheDocument();
      expect(screen.getByTestId('s3-inspector-panel')).toBeInTheDocument();

      // Test Contextual AI Action: Explain Config Diff
      fireEvent.click(screen.getByTestId('ai-action-explain-diff'));
      expect(aiOpenEvents.length).toBeGreaterThanOrEqual(1);
      expect(aiOpenEvents[aiOpenEvents.length - 1].detail).toEqual(
        expect.objectContaining({
          mode: 'panel',
          view: 'Work',
          prompt: expect.stringContaining('Förklara konfigurationsdiff'),
        })
      );

      // Test Contextual AI Action: Generate S3 Policy
      const genPolicyButtons = screen.getAllByTestId('ai-action-generate-s3-policy');
      fireEvent.click(genPolicyButtons[0]);
      expect(aiOpenEvents[aiOpenEvents.length - 1].detail).toEqual(
        expect.objectContaining({
          mode: 'panel',
          view: 'Work',
          prompt: expect.stringContaining('prod-backups'),
        })
      );

      // Test Contextual AI Action: Index in Knowledge Base (@orama)
      const indexKbButtons = screen.getAllByTestId('ai-action-index-kb');
      fireEvent.click(indexKbButtons[0]);
      await waitFor(() => {
        expect(mockApi.aiHubRequest).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'kb-ingest-s3',
            s3ProfileId: 'prod',
          })
        );
      });

      // Toggle S3 Inspector off and back on
      const toggleBtn = screen.getByTestId('toggle-s3-inspector');
      fireEvent.click(toggleBtn);
      expect(screen.queryByTestId('s3-inspector-panel')).not.toBeInTheDocument();

      fireEvent.click(toggleBtn);
      expect(screen.getByTestId('s3-inspector-panel')).toBeInTheDocument();
    } finally {
      window.removeEventListener('sshs3:ai-open', onAiOpen);
    }
  });

  it('displays floating copilot pill (✨ Förklara & fixa felet) in TerminalView on non-zero exit / error and dispatches sshs3:ai-open', async () => {
    let dataCallback: ((sessionId: string, data: string) => void) | null = null;
    mockApi.terminalCreate = vi.fn().mockResolvedValue({ sessionId: 'sess-err-1' });
    mockApi.terminalWrite = vi.fn().mockResolvedValue(undefined);
    mockApi.terminalResize = vi.fn().mockResolvedValue(undefined);
    mockApi.terminalKill = vi.fn().mockResolvedValue(undefined);
    mockApi.onTerminalData = vi.fn((cb) => {
      dataCallback = cb;
      return () => {};
    });
    mockApi.onTerminalExit = vi.fn(() => () => {});

    const sampleConfig: SSHConnectionConfig = {
      id: 'ssh-prod-1',
      name: 'Prod Node 01',
      host: '10.0.0.10',
      port: 22,
      username: 'root',
      authType: 'agent',
    };

    const aiOpenEvents: CustomEvent[] = [];
    const onAiOpen = (e: Event) => aiOpenEvents.push(e as CustomEvent);
    window.addEventListener('sshs3:ai-open', onAiOpen);

    try {
      render(<TerminalView config={sampleConfig} />);

      await act(async () => {
        await Promise.resolve();
      });

      expect(dataCallback).toBeTruthy();

      // Simulate a command failing with OSC 133 non-zero exit + error output
      act(() => {
        dataCallback!(
          'sess-err-1',
          'systemctl restart nginx\r\nJob for nginx.service failed (Result: exit-code).\x1b]133;D;1\x07\r\n'
        );
      });

      const copilotPill = await screen.findByTestId('terminal-copilot-pill');
      expect(copilotPill).toBeInTheDocument();
      expect(copilotPill).toHaveClass('sshs3-copilot-pill');

      const fixBtn = screen.getByTestId('terminal-fix-error-btn');
      expect(fixBtn).toHaveTextContent('✨ Förklara & fixa felet');

      fireEvent.click(fixBtn);

      expect(aiOpenEvents.length).toBe(1);
      expect(aiOpenEvents[0].detail).toEqual(
        expect.objectContaining({
          mode: 'panel',
          view: 'Work',
          prompt: expect.stringContaining('Förklara varför detta fel uppstod'),
          context: expect.stringContaining('nginx.service'),
        })
      );
    } finally {
      window.removeEventListener('sshs3:ai-open', onAiOpen);
    }
  });
});
