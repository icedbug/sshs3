// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { CommandOutputTracker } from '../../src/renderer/src/lib/terminalOutput';
import { TerminalView } from '../../src/renderer/src/components/TerminalView';
import { PaneTreeView } from '../../src/renderer/src/components/PaneTree';
import {
  LIVE_SESSION_STORAGE_KEY,
  persistLiveSession,
  useSessionPersistence,
} from '../../src/renderer/src/lib/useSessionPersistence';
import { resetLiveSessions, takeAttach } from '../../src/renderer/src/lib/liveSessions';
import { WebAuthGate } from '../../src/renderer/src/components/WebAuthGate';
import { disconnectWebClientBridge } from '../../src/renderer/src/lib/webClientBridge';
import type { SSHConnectionConfig } from '../../src/shared/types/ssh';
import type { PaneNode } from '../../src/shared/types/session';
import { DEFAULT_SETTINGS, type AppSettings } from '../../src/shared/types/settings';

let resizeCallback: ((entries: any[], observer: any) => void) | null = null;
class MockResizeObserver {
  constructor(cb: any) {
    resizeCallback = cb;
  }
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
global.ResizeObserver = MockResizeObserver as any;

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

function createMockTrackerTerminal(lines: string[], bufferType: 'normal' | 'alternate' = 'normal') {
  const oscHandlers = new Map<number, (data: string) => boolean>();
  const markers: Array<{ line: number; isDisposed: boolean }> = [];
  const lineBuffer = [...lines];

  const makeLine = (text: string) => ({
    isWrapped: false,
    translateToString: (trimRight?: boolean) => (trimRight ? text.replace(/\s+$/, '') : text),
  });

  const term = {
    rows: 24,
    cols: 80,
    buffer: {
      active: {
        get type() {
          return bufferType;
        },
        baseY: 0,
        viewportY: 0,
        get cursorY() {
          return Math.max(0, lineBuffer.length - 1);
        },
        get length() {
          return lineBuffer.length;
        },
        getLine(idx: number) {
          return idx >= 0 && idx < lineBuffer.length ? makeLine(lineBuffer[idx]) : undefined;
        },
      },
    },
    registerMarker: vi.fn((offset = 0) => {
      const m = { line: Math.max(0, lineBuffer.length - 1 + offset), isDisposed: false };
      markers.push(m);
      return m;
    }),
    parser: {
      registerOscHandler: vi.fn((id: number, cb: (data: string) => boolean) => {
        oscHandlers.set(id, cb);
        return { dispose: vi.fn() };
      }),
    },
  };

  return {
    term: term as unknown as Terminal,
    lineBuffer,
    emitOsc133: (payload: string) => {
      oscHandlers.get(133)?.(payload);
    },
    pushLine: (line: string) => {
      lineBuffer.push(line);
    },
  };
}

describe('CommandOutputTracker command blocks', () => {
  it('extracts OSC 133 command blocks with exit codes and allows lookup by id', () => {
    const mock = createMockTrackerTerminal(['$ ls -la']);
    const tracker = new CommandOutputTracker(mock.term);

    mock.emitOsc133('A');
    mock.emitOsc133('B');
    mock.emitOsc133('C');
    mock.pushLine('total 12');
    mock.pushLine('README.md');
    mock.pushLine('$ ');
    mock.emitOsc133('D;0');

    mock.pushLine('$ failing-cmd');
    mock.emitOsc133('A');
    mock.emitOsc133('B');
    mock.emitOsc133('C');
    mock.pushLine('error: permission denied');
    mock.pushLine('$ ');
    mock.emitOsc133('D;1');

    const blocks = tracker.getCommandBlocks();
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      command: 'ls -la',
      exitCode: 0,
      source: 'osc',
      running: false,
    });
    expect(blocks[0].output).toContain('README.md');
    expect(blocks[1]).toMatchObject({
      command: 'failing-cmd',
      exitCode: 1,
      source: 'osc',
      running: false,
    });
    expect(tracker.getBlockById(blocks[1].id)?.command).toBe('failing-cmd');
  });

  it('falls back to Enter-marker blocks and suppresses blocks in alternate screen buffer', () => {
    const normal = createMockTrackerTerminal(['user@host:~$ uname -a']);
    const tracker = new CommandOutputTracker(normal.term);
    tracker.recordEnter();
    normal.pushLine('Linux host 6.8.0');
    normal.pushLine('user@host:~$ ');

    const blocks = tracker.getCommandBlocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      command: 'uname -a',
      source: 'enter-marker',
    });
    expect(blocks[0].output).toContain('Linux host 6.8.0');

    const alt = createMockTrackerTerminal(['vim buffer'], 'alternate');
    const altTracker = new CommandOutputTracker(alt.term);
    altTracker.recordEnter();
    expect(altTracker.getCommandBlocks()).toEqual([]);
  });
});

describe('TerminalView HUD overhaul', () => {
  const sampleConfig: SSHConnectionConfig = {
    id: 'ssh-hud-1',
    name: 'App Server',
    host: 'app.example.com',
    port: 22,
    username: 'deploy',
    authType: 'password',
  };

  let dataCallback: ((sessionId: string, data: string) => void) | null = null;
  let capturedCustomKeyHandler: ((e: KeyboardEvent) => boolean) | null = null;
  let selectionChangeCallbacks: Array<() => void> = [];
  let scrollCallbacks: Array<() => void> = [];
  let currentSelection = '';
  let scrollToBottomSpy: ReturnType<typeof vi.fn>;
  const mockTerminalCreate = vi.fn();
  const mockTerminalAttach = vi.fn();
  const mockTerminalWrite = vi.fn();
  const mockTerminalResize = vi.fn();
  const mockTerminalKill = vi.fn();

  beforeEach(() => {
    dataCallback = null;
    capturedCustomKeyHandler = null;
    selectionChangeCallbacks = [];
    scrollCallbacks = [];
    currentSelection = '';
    resizeCallback = null;

    vi.spyOn(Terminal.prototype, 'attachCustomKeyEventHandler').mockImplementation((fn) => {
      capturedCustomKeyHandler = fn;
    });
    vi.spyOn(Terminal.prototype, 'getSelection').mockImplementation(() => currentSelection);
    vi.spyOn(Terminal.prototype as any, 'onSelectionChange', 'get').mockImplementation(
      () => (cb: () => void) => {
        selectionChangeCallbacks.push(cb);
        return { dispose: vi.fn() };
      }
    );
    vi.spyOn(Terminal.prototype as any, 'onScroll', 'get').mockImplementation(
      () => (cb: () => void) => {
        scrollCallbacks.push(cb);
        return { dispose: vi.fn() };
      }
    );
    scrollToBottomSpy = vi.spyOn(Terminal.prototype, 'scrollToBottom').mockImplementation(() => {});

    mockTerminalCreate.mockReset().mockResolvedValue({ sessionId: 'sess-hud-1' });
    mockTerminalAttach.mockReset().mockResolvedValue({ sessionId: 'sess-hud-1', scrollback: '' });
    mockTerminalWrite.mockReset().mockResolvedValue(undefined);
    mockTerminalResize.mockReset().mockResolvedValue(undefined);
    mockTerminalKill.mockReset().mockResolvedValue(undefined);

    window.multissh = {
      ...(window.multissh || {}),
      terminalCreate: mockTerminalCreate,
      terminalAttach: mockTerminalAttach,
      terminalWrite: mockTerminalWrite,
      terminalResize: mockTerminalResize,
      terminalKill: mockTerminalKill,
      onTerminalData: vi.fn((cb) => {
        dataCallback = cb;
        return vi.fn();
      }),
      onTerminalExit: vi.fn(() => vi.fn()),
    } as any;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as any).__SSHS3_WEB_MODE__;
    resetLiveSessions();
    cleanup();
  });

  it('does not intercept Ctrl+L so shell screen clearing passes through', async () => {
    render(<TerminalView config={sampleConfig} />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(capturedCustomKeyHandler).toBeTruthy();
    const ctrlL = new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, cancelable: true });
    expect(capturedCustomKeyHandler!(ctrlL)).toBe(true);
    expect(ctrlL.defaultPrevented).toBe(false);
  });

  it('shows selection Ask AI & Explain popover on non-empty selection and dispatches onAskAi + sshs3:ask-ai', async () => {
    const onAskAi = vi.fn();
    const eventListener = vi.fn();
    window.addEventListener('sshs3:ask-ai', eventListener);

    render(<TerminalView config={sampleConfig} onAskAi={onAskAi} />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByTestId('terminal-selection-popover')).not.toBeInTheDocument();

    act(() => {
      currentSelection = 'OOMKilled in pod api-7f9d';
      selectionChangeCallbacks.forEach((cb) => cb());
    });

    expect(screen.getByTestId('terminal-selection-popover')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('selection-explain-btn'));
    expect(onAskAi).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'OOMKilled in pod api-7f9d',
        action: 'explain',
        sessionId: 'sess-hud-1',
      })
    );
    expect(eventListener).toHaveBeenCalledTimes(1);
    expect((eventListener.mock.calls[0][0] as CustomEvent).detail).toMatchObject({
      text: 'OOMKilled in pod api-7f9d',
      action: 'explain',
      sessionId: 'sess-hud-1',
    });

    // Re-open popover on new selection and test Ask AI button
    act(() => {
      selectionChangeCallbacks.forEach((cb) => cb());
    });
    fireEvent.click(screen.getByTestId('selection-ask-ai-btn'));
    expect(onAskAi).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: 'OOMKilled in pod api-7f9d',
        action: 'ask',
        sessionId: 'sess-hud-1',
      })
    );

    // Selecting again and clearing selection hides popover
    act(() => {
      selectionChangeCallbacks.forEach((cb) => cb());
    });
    expect(screen.getByTestId('terminal-selection-popover')).toBeInTheDocument();
    act(() => {
      currentSelection = '   ';
      selectionChangeCallbacks.forEach((cb) => cb());
    });
    expect(screen.queryByTestId('terminal-selection-popover')).not.toBeInTheDocument();

    window.removeEventListener('sshs3:ask-ai', eventListener);
  });

  it('docks bottom status bar outside terminal viewport (preventing bottom-right HUD collision) and shows Jump to bottom when scrolled up', async () => {
    render(<TerminalView config={sampleConfig} />);
    await act(async () => {
      await Promise.resolve();
    });

    const statusBar = screen.getByTestId('terminal-status-bar');
    const viewportContainer = screen.getByTestId('terminal-container');
    expect(statusBar).toBeInTheDocument();
    expect(statusBar.contains(viewportContainer)).toBe(false);
    expect(viewportContainer.contains(statusBar)).toBe(false);
    expect(screen.getByTestId('terminal-inline-ai-btn')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-attach-ai-btn')).toBeInTheDocument();

    // Feed > 24 lines to create scrollback, then simulate scrolling up
    expect(dataCallback).toBeTruthy();
    const lines = Array.from({ length: 30 }, (_, i) => `line-${i}`).join('\r\n');
    act(() => {
      dataCallback!('sess-hud-1', lines);
    });

    const termEl = screen.getByTestId('terminal-view');
    expect(termEl).toBeInTheDocument();

    // Simulate xterm buffer scrolled above baseY
    vi.spyOn(Terminal.prototype, 'buffer', 'get').mockReturnValue({
      active: {
        type: 'normal',
        baseY: 10,
        viewportY: 2,
        cursorY: 0,
        length: 34,
        getLine: () => ({ isWrapped: false, translateToString: () => '' }),
      },
    } as any);

    act(() => {
      scrollCallbacks.forEach((cb) => cb());
    });

    const scrollBtn = screen.getByTestId('terminal-scroll-bottom-btn');
    expect(scrollBtn).toBeInTheDocument();
    fireEvent.click(scrollBtn);
    expect(scrollToBottomSpy).toHaveBeenCalled();
  });

  it('debounces ResizeObserver terminalResize notifications cleanly', async () => {
    vi.useFakeTimers();
    try {
      let dims = { cols: 80, rows: 24 };
      vi.spyOn(FitAddon.prototype, 'fit').mockImplementation(() => {});
      vi.spyOn(Terminal.prototype, 'cols', 'get').mockImplementation(() => dims.cols);
      vi.spyOn(Terminal.prototype, 'rows', 'get').mockImplementation(() => dims.rows);

      render(<TerminalView config={sampleConfig} resizeDebounceMs={120} />);
      await act(async () => {
        await Promise.resolve();
      });
      act(() => {
        vi.advanceTimersByTime(300);
      });

      mockTerminalResize.mockClear();

      // Burst 3 resizes within debounce window
      act(() => {
        dims = { cols: 100, rows: 30 };
        resizeCallback?.([], {} as any);
        vi.advanceTimersByTime(40);
        dims = { cols: 112, rows: 34 };
        resizeCallback?.([], {} as any);
        vi.advanceTimersByTime(40);
        dims = { cols: 120, rows: 36 };
        resizeCallback?.([], {} as any);
      });

      expect(mockTerminalResize).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(125);
      });

      expect(mockTerminalResize).toHaveBeenCalledTimes(1);
      expect(mockTerminalResize).toHaveBeenCalledWith('sess-hud-1', 120, 36);
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders OSC 133 command gutter markers and opens bookmarkable blocks drawer', async () => {
    vi.useFakeTimers();
    try {
      render(<TerminalView config={sampleConfig} />);
      await act(async () => {
        await Promise.resolve();
      });

      act(() => {
        dataCallback!(
          'sess-hud-1',
          '\x1b]133;A\x07$ \x1b]133;B\x07kubectl get pods\r\n\x1b]133;C\x07pod/web Running\r\n\x1b]133;D;0\x07'
        );
        vi.advanceTimersByTime(150);
      });

      const gutter = screen.getByTestId('terminal-command-gutter');
      expect(gutter).toBeInTheDocument();
      const blocksBtn = screen.getByTestId('terminal-blocks-btn');
      expect(blocksBtn).toHaveTextContent('1 cmd');

      fireEvent.click(blocksBtn);
      expect(screen.getByTestId('terminal-blocks-drawer')).toBeInTheDocument();

      const bookmarkBtn = screen.getByLabelText('Bookmark block');
      fireEvent.click(bookmarkBtn);
      expect(blocksBtn).toHaveTextContent('★ 1');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('PaneTree compact header & badges', () => {
  afterEach(() => {
    cleanup();
  });

  const makeSettings = (): AppSettings => ({
    ...DEFAULT_SETTINGS,
  });

  it('highlights focused split pane border and displays Broadcast, Observer, and AI badges', () => {
    const tree: PaneNode = {
      type: 'split',
      id: 'split-1',
      orientation: 'row',
      children: [
        { type: 'leaf', id: 'p-1', local: true },
        { type: 'leaf', id: 'p-2', local: true },
      ],
    };

    render(
      <PaneTreeView
        node={tree}
        isActive={true}
        activePaneId="p-1"
        totalPanes={2}
        settings={makeSettings()}
        platform="linux"
        broadcastEnabled={true}
        broadcastPaneIds={['p-1', 'p-2']}
        paneRoles={{ 'p-1': 'broadcast', 'p-2': 'observer' }}
        observerCount={3}
        aiBoundPaneId="p-1"
        onSelectPane={vi.fn()}
        onSplitPane={vi.fn()}
        onClosePane={vi.fn()}
        onChangeConnection={vi.fn()}
        onOpenLocalTerminal={vi.fn()}
        onCloseTab={vi.fn()}
      />
    );

    const p1 = screen.getByTestId('terminal-pane-p-1');
    const p2 = screen.getByTestId('terminal-pane-p-2');
    expect(p1).toHaveAttribute('data-active', 'true');
    expect(p1.className).toContain('border-l-sky-500');
    expect(p2).toHaveAttribute('data-active', 'false');

    expect(screen.getByTestId('pane-broadcast-badge-p-1')).toHaveTextContent('Broadcast');
    expect(screen.getByTestId('pane-ai-badge-p-1')).toHaveTextContent('AI');
    expect(screen.getByTestId('pane-observer-badge-p-2')).toHaveTextContent('Observer · 3');
    expect(screen.getByTestId('split-row-p-1')).toBeInTheDocument();
  });
});

describe('useSessionPersistence web PTY liveSessionId persistence', () => {
  beforeEach(() => {
    resetLiveSessions();
    sessionStorage.clear();
    (window as any).__SSHS3_WEB_MODE__ = true;
  });

  afterEach(() => {
    delete (window as any).__SSHS3_WEB_MODE__;
    resetLiveSessions();
    sessionStorage.clear();
    cleanup();
  });

  it('persists liveSessionId in web mode and queues attach upon page reload', async () => {
    persistLiveSession('pane-web-1', 'web-pty-abc', 'ssh');
    expect(sessionStorage.getItem(LIVE_SESSION_STORAGE_KEY)).toContain('web-pty-abc');

    const loadedTabs: any[] = [];
    const Harness: React.FC = () => {
      const [tabs, setTabs] = React.useState<any[]>([]);
      const [activeTabId, setActiveTabId] = React.useState('t-1');
      useSessionPersistence(tabs, activeTabId, setTabs, setActiveTabId);
      React.useEffect(() => {
        loadedTabs.splice(0, loadedTabs.length, ...tabs);
      }, [tabs]);
      return <div data-testid="tabs-count">{tabs.length}</div>;
    };

    window.multissh = {
      ...(window.multissh || {}),
      sessionGet: vi.fn().mockResolvedValue({
        activeTabId: 't-1',
        tabs: [
          {
            id: 't-1',
            title: 'Prod',
            activePaneId: 'pane-web-1',
            paneTree: { type: 'leaf', id: 'pane-web-1', local: true },
          },
        ],
      }),
      sessionUpdate: vi.fn().mockResolvedValue(undefined),
    } as any;

    render(<Harness />);

    await waitFor(() => {
      expect(screen.getByTestId('tabs-count')).toHaveTextContent('1');
    });

    expect(takeAttach('pane-web-1')).toEqual({ kind: 'ssh', sessionId: 'web-pty-abc' });
  });
});

describe('WebAuthGate HttpOnly cookie, SSO, and topbar', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    disconnectWebClientBridge();
    localStorage.clear();
    (window as any).__SSHS3_WEB_MODE__ = true;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete (window as any).__SSHS3_WEB_MODE__;
    localStorage.clear();
    disconnectWebClientBridge();
    cleanup();
  });

  it('renders SSO login button when configured, uses English-only UI, and logs in via HttpOnly cookie without JSON token', async () => {
    const onSsoLogin = vi.fn();
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url === '/api/auth/status') {
        return {
          ok: true,
          json: async () => ({
            initialized: true,
            authenticated: false,
            user: null,
            ssoConfigured: true,
            ssoUrl: '/api/auth/sso/login',
            ssoProviderName: 'Okta',
          }),
        } as any;
      }
      if (url === '/api/auth/login') {
        return {
          ok: true,
          json: async () => ({
            wsTicket: 'ticket-xyz',
            user: {
              id: 'u-1',
              username: 'anna',
              displayName: 'Anna Admin',
              role: 'admin',
              createdAt: 1,
              sshPublicKey: 'ssh-ed25519 AAAA',
            },
          }),
        } as any;
      }
      return { ok: true, json: async () => ({}) } as any;
    });
    global.fetch = fetchMock;

    render(
      <WebAuthGate onSsoLogin={onSsoLogin}>
        <div data-testid="workspace-child">Workspace</div>
      </WebAuthGate>
    );

    const ssoBtn = await screen.findByTestId('web-auth-sso-btn');
    expect(ssoBtn).toHaveTextContent('Sign in with Okta');
    fireEvent.click(ssoBtn);
    expect(onSsoLogin).toHaveBeenCalledWith('/api/auth/sso/login');

    // Product UI is strictly English-only (no language toggle)
    expect(screen.queryByTestId('web-auth-lang-toggle')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Sign in to sshs3');

    fireEvent.change(screen.getByLabelText('User name'), { target: { value: 'anna' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await screen.findByTestId('workspace-child');
    const topbar = screen.getByTestId('web-auth-topbar');
    expect(topbar).toBeInTheDocument();
    expect(screen.queryByTestId('web-auth-lang-toggle')).not.toBeInTheDocument();
    expect(localStorage.getItem('sshs3_web_session_token')).toBeNull();
  });

  it('closes accessible account modal on Escape and hides SSO when unconfigured', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        initialized: true,
        authenticated: true,
        ssoConfigured: false,
        user: {
          id: 'u-2',
          username: 'jacob',
          displayName: 'Jacob',
          role: 'member',
          createdAt: 1,
          sshPublicKey: 'ssh-ed25519 AAAA',
        },
      }),
    } as any);

    render(
      <WebAuthGate>
        <div data-testid="workspace-child">Workspace</div>
      </WebAuthGate>
    );

    await screen.findByTestId('workspace-child');
    expect(screen.queryByTestId('web-auth-sso-btn')).not.toBeInTheDocument();

    const sshKeyBtn = screen.getByRole('button', { name: '🔑 SSH key' });
    fireEvent.click(sshKeyBtn);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });
});
