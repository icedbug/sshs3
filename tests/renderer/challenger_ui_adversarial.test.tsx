// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import type { HubSnapshot } from '../../src/shared/types/aiHub';
import { AiHubPanel } from '../../src/renderer/src/components/AiHub/AiHubPanel';
import { TerminalControl } from '../../src/renderer/src/components/AiHub/TerminalControl';
import { TabBar } from '../../src/renderer/src/components/TabBar';
import { SessionTelemetryPill } from '../../src/renderer/src/components/SessionTelemetryPill';
import { App } from '../../src/renderer/src/App';

// Polyfills for jsdom
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

let hubFixture: HubSnapshot;
let selectedTerm = 'sess-1';
const mockHubRequest = vi.fn();

vi.mock('../../src/renderer/src/lib/aiHub', () => ({
  useHub: () => hubFixture,
  useSelectedTerminal: () => selectedTerm,
  selectAiTerminal: (id: string) => {
    selectedTerm = id;
  },
  hubRequest: (...args: unknown[]) => mockHubRequest(...args),
}));

describe('Empirical Challenger: UI Polish & Regression Harness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectedTerm = 'sess-1';
    hubFixture = {
      config: {
        enabled: true,
        provider: 'openai-compatible',
        model: 'local',
        hasApiKey: false,
      },
      preferences: {
        background: false,
        autoStart: false,
        inventory: false,
        retentionDays: 30,
      },
      runtime: { bundled: true },
      sessions: [
        {
          id: 'sess-1',
          generation: 'g1',
          label: 'prod-db-01',
          kind: 'ssh',
          state: 'ready',
          shell: 'bash',
          updatedAt: 1,
        },
      ],
      tasks: [],
      inventory: [],
      memories: [],
      schedules: [],
    };
    mockHubRequest.mockImplementation(async () => hubFixture);

    window.multissh = {
      ...(window.multissh || {}),
      terminalCreate: vi.fn().mockResolvedValue({ sessionId: 'term-challenger-1' }),
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
      onTransferProgress: vi.fn(() => vi.fn()),
      sessionGet: vi.fn().mockResolvedValue({
        tabs: [{ id: 'term-1', type: 'terminal', title: 'prod-srv-01' }],
        activeTabId: 'term-1',
      }),
      sessionSave: vi.fn().mockResolvedValue(undefined),
      settingsGet: vi.fn().mockResolvedValue(undefined),
      settingsSave: vi.fn().mockResolvedValue(undefined),
      profilesGet: vi.fn().mockResolvedValue({
        ssh: [{ id: 'ssh-1', name: 'prod-srv', host: '10.0.0.1', port: 22, username: 'root' }],
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
  });

  describe('1. Chat Message Bubbles & Role Rendering (AiHubPanel)', () => {
    it('renders user, assistant, and system message bubbles cleanly without .ai-message-footer', async () => {
      hubFixture.tasks = [
        {
          id: 'task-bubble-test',
          title: 'Database Investigation',
          target: { sessionId: 'sess-1', generation: 'g1', label: 'prod-db-01' },
          mode: 'assisted',
          status: 'completed',
          createdAt: 1000,
          updatedAt: 2000,
          maxCommands: 10,
          maxMinutes: 10,
          verification: 'verified',
          messages: [
            {
              id: 'msg-user',
              role: 'user',
              text: 'Why is postgresql consuming 99% CPU?',
              at: 1000,
            },
            {
              id: 'msg-asst',
              role: 'assistant',
              text: 'Here is the diagnosis:\n\n```sql\nSELECT pid, query FROM pg_stat_activity;\n```\n\nRun this query to identify long-running transactions.',
              at: 1500,
            },
            {
              id: 'msg-sys',
              role: 'system',
              text: 'System notification: automated health check completed.',
              at: 2000,
            },
          ],
          sources: [],
          changes: [],
        },
      ];

      render(<AiHubPanel mode="panel" setMode={() => {}} />);

      // Switch to previous chat
      fireEvent.click(screen.getByRole('button', { name: 'Chat history' }));
      fireEvent.click(screen.getByRole('button', { name: /Database Investigation/ }));

      // Check user message
      expect(screen.getByText('Why is postgresql consuming 99% CPU?')).toBeInTheDocument();
      expect(screen.getByText('You')).toBeInTheDocument();

      // Check assistant message
      expect(screen.getByText(/Here is the diagnosis:/)).toBeInTheDocument();
      expect(screen.getByText('Assistant')).toBeInTheDocument();

      // Check system message
      expect(screen.getByText('System notification: automated health check completed.')).toBeInTheDocument();
      expect(screen.getByText('sshs3')).toBeInTheDocument();

      // ADVERSARIAL CHECK: Verify .ai-message-footer is NOT rendered anywhere
      expect(document.querySelector('.ai-message-footer')).toBeNull();
      expect(screen.queryByText('🧠 Spara i Team Memory')).not.toBeInTheDocument();
      expect(screen.queryByText('📋 Kopiera svar')).not.toBeInTheDocument();
      expect(screen.queryByText('🔄 Följ upp')).not.toBeInTheDocument();

      // ADVERSARIAL CHECK: Verify "Save findings as a skill" is NOT rendered
      expect(screen.queryByText('Save findings as a skill')).not.toBeInTheDocument();

      // Check assistant header copy button by title
      const copyBtn = screen.getByTitle('Kopiera hela svaret');
      expect(copyBtn).toHaveTextContent('📋 Kopiera');

      // Mock navigator.clipboard
      const writeTextMock = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, {
        clipboard: { writeText: writeTextMock },
      });

      // Click copy
      fireEvent.click(copyBtn);
      expect(writeTextMock).toHaveBeenCalledWith(
        'Here is the diagnosis:\n\n```sql\nSELECT pid, query FROM pg_stat_activity;\n```\n\nRun this query to identify long-running transactions.'
      );
      expect(copyBtn).toHaveTextContent('✓ Kopierad');

      // User message should NOT have a copy button in header
      const userArticle = screen.getByText('Why is postgresql consuming 99% CPU?').closest('article');
      expect(userArticle).not.toBeNull();
      expect(userArticle?.querySelector('.ai-code-btn')).toBeNull();

      // System message should NOT have a copy button in header
      const sysArticle = screen.getByText('System notification: automated health check completed.').closest('article');
      expect(sysArticle).not.toBeNull();
      expect(sysArticle?.querySelector('.ai-code-btn')).toBeNull();
    });

    it('adversarially handles extreme message payloads (huge markdown, code blocks, empty content)', async () => {
      const hugeText = '# Extreme Load\n\n' + 'Line item with detail.\n'.repeat(500);
      hubFixture.tasks = [
        {
          id: 'task-stress',
          title: 'Stress Task',
          target: { sessionId: 'sess-1', generation: 'g1', label: 'prod-db-01' },
          mode: 'assisted',
          status: 'completed',
          createdAt: 100,
          updatedAt: 200,
          maxCommands: 10,
          maxMinutes: 10,
          verification: 'not-verified',
          messages: [
            {
              id: 'msg-empty',
              role: 'assistant',
              text: '',
              at: 100,
            },
            {
              id: 'msg-huge',
              role: 'assistant',
              text: hugeText,
              at: 200,
            },
          ],
          sources: [],
          changes: [],
        },
      ];

      render(<AiHubPanel mode="panel" setMode={() => {}} />);
      fireEvent.click(screen.getByRole('button', { name: 'Chat history' }));
      fireEvent.click(screen.getByRole('button', { name: /Stress Task/ }));

      // Large message rendered without throwing
      expect(screen.getByText('Extreme Load')).toBeInTheDocument();
      // Empty message rendered without crashing
      const articles = document.querySelectorAll('.ai-message-assistant');
      expect(articles.length).toBe(2);
      expect(document.querySelector('.ai-message-footer')).toBeNull();
    });
  });

  describe('2. TerminalControl State Transitions', () => {
    it('returns null when terminal session is idle (no session.owner)', () => {
      // sess-1 has NO session.owner
      const { container } = render(<TerminalControl sessionId="sess-1" />);
      expect(container.firstChild).toBeNull();
    });

    it('returns null when AI hub is disabled in config', () => {
      hubFixture.config.enabled = false;
      hubFixture.sessions[0].owner = 'task-active';
      const { container } = render(<TerminalControl sessionId="sess-1" />);
      expect(container.firstChild).toBeNull();
    });

    it('returns null when sessionId does not exist in hub snapshot', () => {
      const { container } = render(<TerminalControl sessionId="non-existent" />);
      expect(container.firstChild).toBeNull();
    });

    it('renders active AI takeover banner and "Take control" button when session.owner is set', async () => {
      hubFixture.sessions[0].owner = 'task-running';
      hubFixture.tasks = [
        {
          id: 'task-running',
          title: 'Automated Recovery',
          target: { sessionId: 'sess-1', generation: 'g1', label: 'prod-db-01' },
          mode: 'autonomous',
          status: 'running',
          createdAt: 10,
          updatedAt: 20,
          maxCommands: 10,
          maxMinutes: 10,
          verification: 'not-verified',
          messages: [],
          sources: [],
          changes: [],
        },
      ];

      render(<TerminalControl sessionId="sess-1" />);
      expect(screen.getByText('AI working · prod-db-01')).toBeInTheDocument();
      const takeControlBtn = screen.getByRole('button', { name: 'Take control' });
      expect(takeControlBtn).toBeInTheDocument();

      fireEvent.click(takeControlBtn);
      expect(mockHubRequest).toHaveBeenCalledWith({
        action: 'takeover',
        sessionId: 'sess-1',
      });
    });

    it('renders "Waiting for you" banner when task is in waiting status', () => {
      hubFixture.sessions[0].owner = 'task-waiting';
      hubFixture.tasks = [
        {
          id: 'task-waiting',
          title: 'Manual Confirmation',
          target: { sessionId: 'sess-1', generation: 'g1', label: 'prod-db-01' },
          mode: 'assisted',
          status: 'waiting',
          createdAt: 10,
          updatedAt: 20,
          maxCommands: 10,
          maxMinutes: 10,
          verification: 'not-verified',
          messages: [],
          sources: [],
          changes: [],
        },
      ];

      render(<TerminalControl sessionId="sess-1" />);
      expect(screen.getByText('Waiting for you · prod-db-01')).toBeInTheDocument();
    });
  });

  describe('3. TabBar Cleanup & Redundant Button Elimination', () => {
    it('does not render quick action buttons in TabBar under any conditions', () => {
      render(
        <TabBar
          tabs={[
            { id: 'tab-1', title: 'Shell 1', type: 'terminal' },
            { id: 'tab-2', title: 'SFTP 1', type: 'filemanager' },
          ]}
          activeTabId="tab-1"
          onSelectTab={vi.fn()}
          onCloseTab={vi.fn()}
          onNewTab={vi.fn()}
          onOpenGlobalSearch={vi.fn()}
          onOpenSettings={vi.fn()}
        />
      );

      // Verify complete absence of removed quick action buttons
      expect(screen.queryByTestId('quick-profiles-btn')).toBeNull();
      expect(screen.queryByTestId('quick-tunnels-btn')).toBeNull();
      expect(screen.queryByTestId('quick-dirsync-profiles-btn')).toBeNull();
      expect(screen.queryByTestId('quick-settings-btn')).toBeNull();

      // Verify kept elements
      expect(screen.getByTestId('global-search-btn')).toBeInTheDocument();
      expect(screen.getByTestId('add-tab-btn')).toBeInTheDocument();
    });
  });

  describe('4. App Shell Slide-Over Drawers, Omnibar & Split Actions', () => {
    it('cleanly toggles slide-over drawers without collisions', async () => {
      render(<App />);
      await screen.findByTestId('tab-term-1');

      // 1. Left Drawer: Connections / Inventory
      const connectionsBtn = screen.getByTestId('drawer-toggle-connections');
      fireEvent.click(connectionsBtn);
      const connDrawer = await screen.findByTestId('drawer-connections');
      expect(connDrawer).toHaveAttribute('data-drawer-side', 'left');
      expect(within(connDrawer).getByTestId('slide-over-drawer')).toHaveClass('sshs3-slide-drawer-left');
      fireEvent.keyDown(window, { key: 'Escape' });
      await waitFor(() => {
        expect(screen.queryByTestId('drawer-connections')).not.toBeInTheDocument();
      });

      // 2. Right Drawer: Settings
      const settingsBtn = screen.getByTestId('drawer-toggle-settings');
      fireEvent.click(settingsBtn);
      const settingsDrawer = await screen.findByTestId('drawer-settings');
      expect(settingsDrawer).toHaveAttribute('data-drawer-side', 'right');
      expect(within(settingsDrawer).getByTestId('slide-over-drawer')).toHaveClass('sshs3-slide-drawer-right');
      fireEvent.keyDown(window, { key: 'Escape' });
      await waitFor(() => {
        expect(screen.queryByTestId('drawer-settings')).not.toBeInTheDocument();
      });

      // 3. Right Drawer: SSH Tunnels
      const tunnelsBtn = screen.getByTestId('drawer-toggle-tunnels');
      fireEvent.click(tunnelsBtn);
      const tunnelsDrawer = await screen.findByTestId('drawer-tunnels');
      expect(tunnelsDrawer).toHaveAttribute('data-drawer-side', 'right');
      expect(within(tunnelsDrawer).getByTestId('slide-over-drawer')).toHaveClass('sshs3-slide-drawer-right');
      fireEvent.keyDown(window, { key: 'Escape' });
      await waitFor(() => {
        expect(screen.queryByTestId('drawer-tunnels')).not.toBeInTheDocument();
      });

      // 4. Right Drawer: Directory Sync
      const dirsyncBtn = screen.getByTestId('drawer-toggle-dirsync');
      fireEvent.click(dirsyncBtn);
      const dirsyncDrawer = await screen.findByTestId('drawer-dirsync');
      expect(dirsyncDrawer).toHaveAttribute('data-drawer-side', 'right');
      expect(within(dirsyncDrawer).getByTestId('slide-over-drawer')).toHaveClass('sshs3-slide-drawer-right');
      fireEvent.keyDown(window, { key: 'Escape' });
      await waitFor(() => {
        expect(screen.queryByTestId('drawer-dirsync')).not.toBeInTheDocument();
      });

      // 5. Right Drawer: AI Hub Chat
      expect(screen.getByTestId('drawer-ai')).toHaveAttribute('data-drawer-open', 'false');
      const aiBtn = screen.getByTestId('drawer-toggle-ai');
      fireEvent.click(aiBtn);
      expect(screen.getByTestId('drawer-ai')).toHaveAttribute('data-drawer-open', 'true');
      fireEvent.click(aiBtn);
      expect(screen.getByTestId('drawer-ai')).toHaveAttribute('data-drawer-open', 'false');
    });

    it('opens Omnibar and handles command search palette', async () => {
      render(<App />);
      await screen.findByTestId('tab-term-1');

      const omnibarBtn = screen.getByTestId('omnibar-trigger');
      fireEvent.click(omnibarBtn);

      const combobox = await screen.findByRole('combobox');
      expect(combobox).toBeInTheDocument();

      // Press Escape to dismiss
      fireEvent.keyDown(window, { key: 'Escape' });
      await waitFor(() => {
        expect(screen.queryByTestId('global-search-palette')).not.toBeInTheDocument();
      });
    });

    it('dispatches sshs3:split-sftp event when telemetry split SFTP is clicked', () => {
      const splitListener = vi.fn();
      window.addEventListener('sshs3:split-sftp', splitListener);

      const sshConfig = {
        id: 'ssh-1',
        name: 'storage01.corp',
        host: 'storage01.corp',
        port: 22,
        username: 'sysadmin',
        authType: 'password' as const,
        role: 'netapp ontap',
      };

      render(
        <SessionTelemetryPill
          paneId="pane-1"
          config={sshConfig}
          status="online"
        />
      );

      // Expand pill
      fireEvent.click(screen.getByRole('button', { name: /Session telemetry/ }));

      // Click split action
      const splitBtn = screen.getByTestId('telemetry-action-split-sftp');
      expect(splitBtn).toHaveTextContent('Split SFTP');

      fireEvent.click(splitBtn);

      expect(splitListener).toHaveBeenCalledTimes(1);
      const eventDetail = splitListener.mock.calls[0][0].detail;
      expect(eventDetail).toEqual({
        paneId: 'pane-1',
        config: sshConfig,
        host: 'storage01.corp',
      });

      window.removeEventListener('sshs3:split-sftp', splitListener);
    });

    it('handles rapid sequential drawer transitions without state corruption or hanging backdrops', async () => {
      render(<App />);
      await screen.findByTestId('tab-term-1');

      const connToggle = screen.getByTestId('drawer-toggle-connections');
      const settingsToggle = screen.getByTestId('drawer-toggle-settings');
      const tunnelsToggle = screen.getByTestId('drawer-toggle-tunnels');
      const dirsyncToggle = screen.getByTestId('drawer-toggle-dirsync');

      // Rapidly toggle across all drawers
      fireEvent.click(connToggle);
      expect(await screen.findByTestId('drawer-connections')).toBeInTheDocument();

      fireEvent.click(settingsToggle);
      expect(await screen.findByTestId('drawer-settings')).toBeInTheDocument();

      fireEvent.click(tunnelsToggle);
      expect(await screen.findByTestId('drawer-tunnels')).toBeInTheDocument();

      fireEvent.click(dirsyncToggle);
      expect(await screen.findByTestId('drawer-dirsync')).toBeInTheDocument();

      // Dismiss with Escape
      fireEvent.keyDown(window, { key: 'Escape' });
      await waitFor(() => {
        expect(screen.queryByTestId('drawer-dirsync')).not.toBeInTheDocument();
      });
    });
  });

  describe('5. Cleanliness & Dead Code Elimination Invariants', () => {
    it('verifies that aiHub.css has no lingering .ai-message-footer or .ai-msg-action-btn rules', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const cssPath = path.resolve(__dirname, '../../src/renderer/src/components/AiHub/aiHub.css');
      const content = fs.readFileSync(cssPath, 'utf8');

      expect(content).not.toContain('.ai-message-footer');
      expect(content).not.toContain('.ai-msg-action-btn');
    });

    it('verifies that TerminalView.tsx does not contain the floating "Attach selection to AI" button', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const tvPath = path.resolve(__dirname, '../../src/renderer/src/components/TerminalView.tsx');
      const content = fs.readFileSync(tvPath, 'utf8');

      expect(content).not.toContain('Attach selection to AI');
      // But keeps the ambient copilot and inline AI
      expect(content).toContain('Inline AI (Ctrl+K)');
      expect(content).toContain('terminal-copilot-pill');
    });

    it('verifies that message bubbles render image attachments cleanly', async () => {
      hubFixture.tasks = [
        {
          id: 'task-img',
          title: 'Image Diagnostic',
          target: { sessionId: 'sess-1', generation: 'g1', label: 'prod-db-01' },
          mode: 'assisted',
          status: 'completed',
          createdAt: 100,
          updatedAt: 200,
          maxCommands: 5,
          maxMinutes: 5,
          verification: 'not-verified',
          messages: [
            {
              id: 'msg-with-img',
              role: 'assistant',
              text: 'Here is the network graph screenshot:',
              images: [
                {
                  label: 'topology.png',
                  dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
                },
              ],
              at: 100,
            },
          ],
          sources: [],
          changes: [],
        },
      ];

      render(<AiHubPanel mode="panel" setMode={() => {}} />);
      fireEvent.click(screen.getByRole('button', { name: 'Chat history' }));
      fireEvent.click(screen.getByRole('button', { name: /Image Diagnostic/ }));

      const img = screen.getByRole('img');
      expect(img).toBeInTheDocument();
      expect(img).toHaveAttribute('alt', 'topology.png');
      expect(img).toHaveAttribute('src', expect.stringContaining('data:image/png;base64'));
      expect(document.querySelector('.ai-message-footer')).toBeNull();
    });

    it('verifies that code block "Använd" action updates composer prompt', async () => {
      hubFixture.tasks = [
        {
          id: 'task-cmd',
          title: 'Command Diagnostic',
          target: { sessionId: 'sess-1', generation: 'g1', label: 'prod-db-01' },
          mode: 'assisted',
          status: 'completed',
          createdAt: 100,
          updatedAt: 200,
          maxCommands: 5,
          maxMinutes: 5,
          verification: 'not-verified',
          messages: [
            {
              id: 'msg-with-code',
              role: 'assistant',
              text: '```bash\nfree -m\n```',
              at: 100,
            },
          ],
          sources: [],
          changes: [],
        },
      ];

      render(<AiHubPanel mode="panel" setMode={() => {}} />);
      fireEvent.click(screen.getByRole('button', { name: 'Chat history' }));
      fireEvent.click(screen.getByRole('button', { name: /Command Diagnostic/ }));

      const useBtn = screen.getByRole('button', { name: /Använd/ });
      expect(useBtn).toBeInTheDocument();

      fireEvent.click(useBtn);

      const composer = screen.getByLabelText('Message to agent');
      expect(composer).toHaveValue('free -m');
    });
  });
});
