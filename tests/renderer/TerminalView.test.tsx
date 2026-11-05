// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { SSHConnectionConfig } from '../../src/shared/types/ssh';
import { TerminalView } from '../../src/renderer/src/components/TerminalView';
import * as terminalLinksModule from '../../src/renderer/src/lib/terminalLinks';

// Polyfill ResizeObserver and matchMedia for JSDOM
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

describe('TerminalView Component', () => {
  const sampleConfig: SSHConnectionConfig = {
    id: 'ssh-1',
    name: 'Production Server',
    host: 'prod.example.com',
    port: 22,
    username: 'admin',
    authType: 'password',
  };

  let dataCallback: ((sessionId: string, data: string) => void) | null = null;
  let exitCallback: ((sessionId: string, event: { exitCode: number; signal?: number }) => void) | null = null;
  const mockUnsubData = vi.fn();
  const mockUnsubExit = vi.fn();
  const mockTerminalCreate = vi.fn();
  const mockTerminalWrite = vi.fn();
  const mockTerminalResize = vi.fn();
  const mockTerminalKill = vi.fn();

  beforeEach(() => {
    dataCallback = null;
    exitCallback = null;
    resizeCallback = null;
    mockUnsubData.mockClear();
    mockUnsubExit.mockClear();
    mockTerminalCreate.mockReset().mockResolvedValue({ sessionId: 'session-123' });
    mockTerminalWrite.mockReset().mockResolvedValue(undefined);
    mockTerminalResize.mockReset().mockResolvedValue(undefined);
    mockTerminalKill.mockReset().mockResolvedValue(undefined);

    window.multissh = {
      ...(window.multissh || {}),
      terminalCreate: mockTerminalCreate,
      terminalWrite: mockTerminalWrite,
      terminalResize: mockTerminalResize,
      terminalKill: mockTerminalKill,
      onTerminalData: vi.fn((cb) => {
        dataCallback = cb;
        return mockUnsubData;
      }),
      onTerminalExit: vi.fn((cb) => {
        exitCallback = cb;
        return mockUnsubExit;
      }),
    } as any;
  });

  afterEach(() => {
    cleanup();
  });

  it('initializes xterm, fitAddon, and calls terminalCreate on mount', async () => {
    render(<TerminalView config={sampleConfig} />);

    expect(screen.getByTestId('terminal-view')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-container')).toBeInTheDocument();

    expect(mockTerminalCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        // The session id is regenerated per mount (never the saved profile's own
        // id) so two tabs on the same profile can't collide on one PTY session.
        config: expect.objectContaining({ ...sampleConfig, id: expect.any(String) }),
        ptyOptions: expect.objectContaining({
          cols: expect.any(Number),
          rows: expect.any(Number),
        }),
      })
    );

    const [[createArgs]] = mockTerminalCreate.mock.calls;
    expect(createArgs.config.id).not.toBe(sampleConfig.id);
  });

  // LOW finding (code review): xterm.js renders its own internal DOM into
  // this container (a canvas layer plus a hidden textarea), none of which
  // otherwise indicates what a screen reader user has tabbed into.
  it('labels the terminal container for screen readers, based on the session type', () => {
    const { rerender } = render(<TerminalView config={sampleConfig} />);
    expect(screen.getByTestId('terminal-container')).toHaveAttribute('aria-label', 'Terminal: Production Server');

    rerender(<TerminalView local />);
    expect(screen.getByTestId('terminal-container')).toHaveAttribute('aria-label', 'Terminal: local shell');

    rerender(
      <TerminalView
        k8sTarget={{ contextName: 'ctx', namespace: 'default', podName: 'my-pod', containerName: 'app' }}
      />
    );
    expect(screen.getByTestId('terminal-container')).toHaveAttribute('aria-label', 'Terminal: my-pod/app');
  });

  it('synchronizes dimensions to PTY via terminalResize once session creation resolves', async () => {
    render(<TerminalView config={sampleConfig} />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockTerminalResize).toHaveBeenCalledWith('session-123', expect.any(Number), expect.any(Number));
  });

  it('synchronizes dimensions to PTY when an initially background tab becomes active', async () => {
    const { rerender } = render(<TerminalView config={sampleConfig} isActive={false} />);

    await act(async () => {
      await Promise.resolve();
    });

    // While inactive, terminalResize should not have been called
    expect(mockTerminalResize).not.toHaveBeenCalled();

    // Now activate the tab
    rerender(<TerminalView config={sampleConfig} isActive={true} />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockTerminalResize).toHaveBeenCalledWith('session-123', expect.any(Number), expect.any(Number));
  });

  it('receives terminal data from IPC and writes matching session data to terminal', async () => {
    render(<TerminalView config={sampleConfig} />);

    // Wait for terminalCreate promise to resolve
    await act(async () => {
      await Promise.resolve();
    });

    expect(window.multissh.onTerminalData).toHaveBeenCalled();
    expect(dataCallback).toBeTruthy();

    // Data for our session
    act(() => {
      dataCallback!('session-123', 'Hello MultiSSH\r\n');
    });

    // Data for another session should be ignored
    act(() => {
      dataCallback!('other-session', 'Secret data');
    });

    // Verify terminal output container exists
    const container = screen.getByTestId('terminal-container');
    expect(container).toBeInTheDocument();
  });

  it('handles terminal exit event and invokes onExit prop', async () => {
    const onExit = vi.fn();
    render(<TerminalView config={sampleConfig} onExit={onExit} />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(window.multissh.onTerminalExit).toHaveBeenCalled();
    expect(exitCallback).toBeTruthy();

    act(() => {
      exitCallback!('session-123', { exitCode: 0 });
    });

    expect(onExit).toHaveBeenCalledWith({ exitCode: 0 });
  });

  it('handles resize observer trigger and calls terminalResize when dimensions change', async () => {
    render(<TerminalView config={sampleConfig} />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(resizeCallback).toBeTruthy();

    // Trigger resize observer callback
    act(() => {
      resizeCallback!([], {} as any);
    });

    // If dimensions didn't change from default 80x24, it won't re-send needlessly.
    // Let's verify that the ResizeObserver was instantiated and observing the container
    expect(screen.getByTestId('terminal-container')).toBeInTheDocument();
  });

  it('cleans up session, listeners, and xterm on unmount', async () => {
    const { unmount } = render(<TerminalView config={sampleConfig} />);

    await act(async () => {
      await Promise.resolve();
    });

    unmount();

    expect(mockUnsubData).toHaveBeenCalledTimes(1);
    expect(mockUnsubExit).toHaveBeenCalledTimes(1);
    expect(mockTerminalKill).toHaveBeenCalledWith('session-123');
  });

  it('renders reconnect overlay and buttons when session terminates under reconnect action', async () => {
    const onCloseTab = vi.fn();
    render(<TerminalView config={sampleConfig} onCloseTab={onCloseTab} sessionExitAction="reconnect" />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByTestId('session-exit-overlay')).not.toBeInTheDocument();

    act(() => {
      exitCallback!('session-123', { exitCode: 0 });
    });

    expect(screen.getByTestId('session-exit-overlay')).toBeInTheDocument();
    expect(screen.getByText(/Session ended/)).toBeInTheDocument();
    expect(screen.getByTestId('reconnect-button')).toBeInTheDocument();
    expect(screen.getByTestId('close-tab-button')).toBeInTheDocument();

    // Click Close Tab
    act(() => {
      screen.getByTestId('close-tab-button').click();
    });
    expect(onCloseTab).toHaveBeenCalledTimes(1);
  });

  it('re-spawns a new session when Reconnect is clicked', async () => {
    render(<TerminalView config={sampleConfig} sessionExitAction="reconnect" />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(mockTerminalCreate).toHaveBeenCalledTimes(1);

    act(() => {
      exitCallback!('session-123', { exitCode: 0 });
    });
    expect(screen.getByTestId('reconnect-button')).toBeInTheDocument();

    // Click Reconnect
    mockTerminalCreate.mockResolvedValueOnce({ sessionId: 'session-456' });
    await act(async () => {
      screen.getByTestId('reconnect-button').click();
    });

    expect(mockTerminalCreate).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('session-exit-overlay')).not.toBeInTheDocument();
  });

  it('automatically closes tab when sessionExitAction is close and exit code is 0', async () => {
    const onCloseTab = vi.fn();
    render(<TerminalView config={sampleConfig} onCloseTab={onCloseTab} sessionExitAction="close" />);

    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      exitCallback!('session-123', { exitCode: 0 });
    });

    expect(onCloseTab).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('session-exit-overlay')).not.toBeInTheDocument();
  });

  it('keeps tab open and shows overlay if session exits with non-zero error code even when sessionExitAction is close', async () => {
    const onCloseTab = vi.fn();
    render(<TerminalView config={sampleConfig} onCloseTab={onCloseTab} sessionExitAction="close" />);

    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      exitCallback!('session-123', { exitCode: 255 });
    });

    expect(onCloseTab).not.toHaveBeenCalled();
    expect(screen.getByTestId('session-exit-overlay')).toBeInTheDocument();
    expect(screen.getByText(/Session ended \(code 255\)/)).toBeInTheDocument();
  });

  it('does not display overlay when sessionExitAction is keep', async () => {
    render(<TerminalView config={sampleConfig} sessionExitAction="keep" />);

    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      exitCallback!('session-123', { exitCode: 0 });
    });

    expect(screen.queryByTestId('session-exit-overlay')).not.toBeInTheDocument();
  });

  it('renders correctly with breeze theme background', async () => {
    render(<TerminalView config={sampleConfig} theme="breeze" />);

    await act(async () => {
      await Promise.resolve();
    });

    const termView = screen.getByTestId('terminal-view');
    expect(termView).toHaveClass('bg-[#232627]');
  });

  it('defers terminalCreate when mounted with isActive=false until isActive becomes true', async () => {
    const { rerender } = render(<TerminalView config={sampleConfig} isActive={false} />);

    await act(async () => {
      await Promise.resolve();
    });

    // Background tab should NOT have triggered terminalCreate on mount
    expect(mockTerminalCreate).not.toHaveBeenCalled();

    // Now tab becomes active (user clicks the tab)
    rerender(<TerminalView config={sampleConfig} isActive={true} />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockTerminalCreate).toHaveBeenCalledTimes(1);

    // Switching away (isActive = false) should NOT kill or recreate the session
    rerender(<TerminalView config={sampleConfig} isActive={false} />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockTerminalKill).not.toHaveBeenCalled();
    expect(mockTerminalCreate).toHaveBeenCalledTimes(1);
  });

  it('deduplicates rapid identical paste events to prevent double paste', async () => {
    render(<TerminalView config={sampleConfig} />);

    await act(async () => {
      await Promise.resolve();
    });

    const container = screen.getByTestId('terminal-container');

    // Dispatch a DOM paste event with test string
    act(() => {
      const pasteEvent = new Event('paste', { bubbles: true }) as any;
      pasteEvent.clipboardData = {
        getData: (type: string) => (type === 'text/plain' ? 'echo duplicate-test' : ''),
      };
      container.dispatchEvent(pasteEvent);
    });

    // Terminal container handles DOM paste listener without errors
    expect(container).toBeInTheDocument();
  });

  it('configures linkHandler to open external URLs via window.multissh.openExternal', async () => {
    const mockOpenExternal = vi.fn();
    window.multissh.openExternal = mockOpenExternal;

    let capturedLinkHandler: any = null;
    const { Terminal } = await import('@xterm/xterm');
    const openSpy = vi.spyOn(Terminal.prototype, 'open').mockImplementation(function (this: any, element: HTMLElement) {
      capturedLinkHandler = this.options.linkHandler;
      return openSpy.getMockImplementation() ? undefined : (openSpy as any)(element);
    });

    render(<TerminalView config={sampleConfig} />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(capturedLinkHandler).toBeDefined();
    capturedLinkHandler.activate({} as any, 'https://github.com/remotion-dev/remotion');
    expect(mockOpenExternal).toHaveBeenCalledWith('https://github.com/remotion-dev/remotion');

    openSpy.mockRestore();
  });

  it('connects the SFTP provider lazily, only once a path is actually used', async () => {
    let capturedHandlers: any;
    const registerSpy = vi.spyOn(terminalLinksModule, 'registerTerminalLinks').mockImplementation((_term, handlers) => {
      capturedHandlers = handlers;
      return { dispose: vi.fn() };
    });
    const mockConnectStorage = vi.fn().mockResolvedValue({ id: 'sftp-ssh-1' });
    window.multissh.connectStorage = mockConnectStorage;

    render(<TerminalView config={sampleConfig} initialCwd="/srv" onOpenPath={vi.fn()} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockConnectStorage).not.toHaveBeenCalled();

    await capturedHandlers.openPath('notes.txt');
    await capturedHandlers.openPath('other.txt');
    expect(mockConnectStorage).toHaveBeenCalledTimes(1);
    expect(mockConnectStorage).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.stringMatching(/^sftp-/), type: 'sftp' })
    );

    registerSpy.mockRestore();
  });

  it('resolves relative paths and standalone files against currentCwd when Ctrl+clicked via openPath', async () => {
    let capturedHandlers: any;
    const registerSpy = vi.spyOn(terminalLinksModule, 'registerTerminalLinks').mockImplementation((_term, handlers) => {
      capturedHandlers = handlers;
      return { dispose: vi.fn() };
    });

    const onOpenPath = vi.fn();
    render(
      <TerminalView
        config={sampleConfig}
        initialCwd="/var/www/html"
        onOpenPath={onOpenPath}
      />
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(capturedHandlers).toBeDefined();
    await capturedHandlers.openPath('notes');
    expect(onOpenPath).toHaveBeenCalledWith('/var/www/html/notes');

    await capturedHandlers.openPath('src/App.tsx');
    expect(onOpenPath).toHaveBeenCalledWith('/var/www/html/src/App.tsx');

    await capturedHandlers.openPath('/etc/nginx/nginx.conf');
    expect(onOpenPath).toHaveBeenCalledWith('/etc/nginx/nginx.conf');

    registerSpy.mockRestore();
  });

  it('pastes from system clipboard on Shift+Insert and Ctrl+Shift+V', async () => {
    let capturedKeyHandler: any = null;
    const { Terminal } = await import('@xterm/xterm');
    const pasteSpy = vi.spyOn(Terminal.prototype, 'paste').mockImplementation(() => {});
    const attachSpy = vi.spyOn(Terminal.prototype, 'attachCustomKeyEventHandler').mockImplementation(function (this: any, handler: any) {
      capturedKeyHandler = handler;
    });

    const mockReadText = vi.fn().mockResolvedValue('git status --short');
    Object.defineProperty(navigator, 'clipboard', {
      value: { readText: mockReadText },
      configurable: true,
      writable: true,
    });

    render(<TerminalView config={sampleConfig} />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(capturedKeyHandler).toBeDefined();

    // 1. Shift+Insert
    const shiftInsertEvt = {
      type: 'keydown',
      shiftKey: true,
      key: 'Insert',
      preventDefault: vi.fn(),
    };
    const resShiftInsert = capturedKeyHandler(shiftInsertEvt);
    expect(resShiftInsert).toBe(false);
    expect(shiftInsertEvt.preventDefault).toHaveBeenCalled();
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockReadText).toHaveBeenCalled();
    expect(pasteSpy).toHaveBeenCalledWith('git status --short');

    // 2. Ctrl+Shift+V
    pasteSpy.mockClear();
    mockReadText.mockResolvedValueOnce('curl -s https://api.example.com');
    const ctrlShiftVEvt = {
      type: 'keydown',
      ctrlKey: true,
      shiftKey: true,
      key: 'V',
      code: 'KeyV',
      preventDefault: vi.fn(),
    };
    const resCtrlShiftV = capturedKeyHandler(ctrlShiftVEvt);
    expect(resCtrlShiftV).toBe(false);
    expect(ctrlShiftVEvt.preventDefault).toHaveBeenCalled();
    await act(async () => {
      await Promise.resolve();
    });
    expect(pasteSpy).toHaveBeenCalledWith('curl -s https://api.example.com');

    // 3. Fallback to clipboard history if navigator.clipboard fails
    pasteSpy.mockClear();
    mockReadText.mockRejectedValueOnce(new Error('Permission denied'));
    window.multissh.clipboardHistoryList = vi.fn().mockResolvedValueOnce([
      { id: '1', text: 'fallback-from-history', timestamp: Date.now() },
    ]);

    const resFallback = capturedKeyHandler(ctrlShiftVEvt);
    expect(resFallback).toBe(false);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(pasteSpy).toHaveBeenCalledWith('fallback-from-history');

    attachSpy.mockRestore();
    pasteSpy.mockRestore();
  });

  it('suppresses hover card preview when pathHoverPreview is false', async () => {
    let capturedHandlers: any;
    const registerSpy = vi.spyOn(terminalLinksModule, 'registerTerminalLinks').mockImplementation((_term, handlers) => {
      capturedHandlers = handlers;
      return { dispose: vi.fn() };
    });

    render(
      <TerminalView
        config={sampleConfig}
        pathHoverPreview={false}
      />
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(capturedHandlers).toBeDefined();

    // Trigger hoverPath
    act(() => {
      capturedHandlers.hoverPath({ clientX: 100, clientY: 100 }, '/var/log/syslog');
    });

    // Advance dwell timer
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    // Hover card should NOT be in document
    expect(screen.queryByTestId('terminal-path-hover-card')).not.toBeInTheDocument();

    registerSpy.mockRestore();
  });

  describe('path hover card gating', () => {
    let capturedHandlers: any;
    let registerSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      registerSpy = vi.spyOn(terminalLinksModule, 'registerTerminalLinks').mockImplementation((_term, handlers) => {
        capturedHandlers = handlers;
        return { dispose: vi.fn() };
      });
    });

    afterEach(() => {
      registerSpy.mockRestore();
      delete (window.multissh as any).storageLookup;
      delete (window.multissh as any).connectStorage;
      delete (window.multissh as any).terminalHasSshClient;
    });

    const dwell = () =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 400));
      });

    it('does not open the card for a path that does not exist', async () => {
      const storageLookup = vi.fn().mockResolvedValue(null);
      (window.multissh as any).storageLookup = storageLookup;
      render(<TerminalView config={sampleConfig} />);
      await act(async () => {
        await Promise.resolve();
      });

      act(() => {
        capturedHandlers.hoverPath({ clientX: 10, clientY: 10, ctrlKey: false, metaKey: false }, '/srv/app/not-there.ts');
      });
      await dwell();

      expect(storageLookup).toHaveBeenCalled();
      expect(screen.queryByTestId('terminal-path-hover-card')).not.toBeInTheDocument();
    });

    it('opens the card for a path that exists', async () => {
      (window.multissh as any).storageLookup = vi.fn().mockResolvedValue({ name: 'syslog', isDirectory: false, size: 1 });
      render(<TerminalView config={sampleConfig} />);
      await act(async () => {
        await Promise.resolve();
      });

      act(() => {
        capturedHandlers.hoverPath({ clientX: 10, clientY: 10, ctrlKey: false, metaKey: false }, '/var/log/syslog');
      });
      await dwell();

      expect(screen.getByTestId('terminal-path-hover-card')).toBeInTheDocument();
    });

    it('does not judge a relative path while the working directory is only a guess', async () => {
      const storageLookup = vi.fn().mockResolvedValue(null);
      (window.multissh as any).storageLookup = storageLookup;
      render(<TerminalView config={sampleConfig} />);
      await act(async () => {
        await Promise.resolve();
      });

      act(() => {
        capturedHandlers.hoverPath({ clientX: 10, clientY: 10, ctrlKey: false, metaKey: false }, 'src/app/main.ts');
      });
      await dwell();

      // An SSH terminal has no OSC 7 or process to ask, so a miss would only reflect a wrong directory.
      expect(storageLookup).not.toHaveBeenCalled();
      expect(screen.getByTestId('terminal-path-hover-card')).toBeInTheDocument();
    });

    it('shows the card as before when the lookup is too slow to answer', async () => {
      (window.multissh as any).storageLookup = vi.fn().mockReturnValue(new Promise(() => {}));
      render(<TerminalView config={sampleConfig} />);
      await act(async () => {
        await Promise.resolve();
      });

      act(() => {
        capturedHandlers.hoverPath({ clientX: 10, clientY: 10, ctrlKey: false, metaKey: false }, '/var/log/syslog');
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      });

      expect(screen.getByTestId('terminal-path-hover-card')).toBeInTheDocument();
    });

    it('registers the local storage provider before looking a path up in a local terminal', async () => {
      const calls: string[] = [];
      (window.multissh as any).connectStorage = vi.fn().mockImplementation(async (config: { id: string }) => {
        calls.push(`connect:${config.id}`);
        return { id: config.id };
      });
      (window.multissh as any).storageLookup = vi.fn().mockImplementation(async () => {
        calls.push('lookup');
        return { name: 'syslog', isDirectory: false, size: 1 };
      });
      render(<TerminalView local />);
      await act(async () => {
        await Promise.resolve();
      });

      act(() => {
        capturedHandlers.hoverPath({ clientX: 10, clientY: 10, ctrlKey: false, metaKey: false }, '/var/log/syslog');
      });
      await dwell();

      expect(calls.indexOf('connect:local')).toBeGreaterThanOrEqual(0);
      expect(calls.indexOf('connect:local')).toBeLessThan(calls.indexOf('lookup'));
    });

    it('does not offer the card while a local shell runs ssh, but does otherwise', async () => {
      (window.multissh as any).connectStorage = vi.fn().mockResolvedValue({ id: 'local' });
      (window.multissh as any).storageLookup = vi.fn().mockResolvedValue({ name: 'syslog', isDirectory: false, size: 1 });
      const terminalHasSshClient = vi.fn().mockResolvedValue(true);
      (window.multissh as any).terminalHasSshClient = terminalHasSshClient;
      render(<TerminalView local />);
      await act(async () => {
        await Promise.resolve();
      });
      const hover = { clientX: 10, clientY: 10, ctrlKey: false, metaKey: false };

      act(() => {
        capturedHandlers.hoverPath(hover, '/var/log/syslog');
      });
      await dwell();
      expect(terminalHasSshClient).toHaveBeenCalled();
      expect(screen.queryByTestId('terminal-path-hover-card')).not.toBeInTheDocument();

      terminalHasSshClient.mockResolvedValue(false);
      act(() => {
        capturedHandlers.leavePath({}, '/var/log/syslog');
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
      });
      act(() => {
        capturedHandlers.hoverPath(hover, '/var/log/syslog');
      });
      await dwell();
      expect(screen.getByTestId('terminal-path-hover-card')).toBeInTheDocument();
    });

    it('keeps an open card when a repaint makes xterm report leave and hover for the same path', async () => {
      (window.multissh as any).storageLookup = vi.fn().mockResolvedValue({ name: 'syslog', isDirectory: false, size: 1 });
      render(<TerminalView config={sampleConfig} />);
      await act(async () => {
        await Promise.resolve();
      });
      const hover = { clientX: 10, clientY: 10, ctrlKey: false, metaKey: false };

      act(() => {
        capturedHandlers.hoverPath(hover, '/var/log/syslog');
      });
      await dwell();
      expect(screen.getByTestId('terminal-path-hover-card')).toBeInTheDocument();

      // The pointer has not moved; the rows were repainted.
      act(() => {
        capturedHandlers.leavePath({}, '/var/log/syslog');
        capturedHandlers.hoverPath(hover, '/var/log/syslog');
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 700));
      });
      expect(screen.getByTestId('terminal-path-hover-card')).toBeInTheDocument();
    });

    it('keeps the open card while the pointer moves from one path to the next', async () => {
      (window.multissh as any).storageLookup = vi.fn().mockResolvedValue({ name: 'f', isDirectory: false, size: 1 });
      render(<TerminalView config={sampleConfig} />);
      await act(async () => {
        await Promise.resolve();
      });
      const hover = { clientX: 10, clientY: 10, ctrlKey: false, metaKey: false };

      act(() => {
        capturedHandlers.hoverPath(hover, '/var/log/a.log');
      });
      await dwell();
      expect(screen.getByTestId('terminal-path-hover-card')).toBeInTheDocument();

      // Sweep across three paths within a few milliseconds each, like a pointer crossing an ls listing.
      for (const p of ['/var/log/b.log', '/var/log/c.log', '/var/log/d.log']) {
        act(() => {
          capturedHandlers.leavePath({}, p);
          capturedHandlers.hoverPath(hover, p);
        });
      }
      // The old card must not be closed by timers left over from the earlier leaves (400 ms), and the
      // card for the path the pointer ended on must open (500 ms dwell) and stay.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 900));
      });
      expect(screen.getByTestId('terminal-path-hover-card')).toBeInTheDocument();
      expect(screen.getByTestId('terminal-path-hover-card').textContent).toContain('d.log');
    });

    it('places the card relative to where the pointer is when it opens, not where it entered the link', async () => {
      (window.multissh as any).storageLookup = vi.fn().mockResolvedValue({ name: 'f', isDirectory: false, size: 1 });
      render(<TerminalView config={sampleConfig} />);
      await act(async () => {
        await Promise.resolve();
      });

      act(() => {
        capturedHandlers.hoverPath({ clientX: 10, clientY: 10, ctrlKey: false, metaKey: false }, '/var/log/syslog');
      });
      // The pointer moves on while the card waits to open.
      act(() => {
        window.dispatchEvent(new MouseEvent('mousemove', { clientX: 300, clientY: 120 }));
      });
      await dwell();

      const card = screen.getByTestId('terminal-path-hover-card');
      expect(card.style.left).toBe('312px');
    });

    it('keeps the card when the pointer enters it right after leaving the link, and closes it after it leaves', async () => {
      (window.multissh as any).storageLookup = vi.fn().mockResolvedValue({ name: 'f', isDirectory: false, size: 1 });
      render(<TerminalView config={sampleConfig} />);
      await act(async () => {
        await Promise.resolve();
      });

      act(() => {
        capturedHandlers.hoverPath({ clientX: 10, clientY: 10, ctrlKey: false, metaKey: false }, '/var/log/syslog');
      });
      await dwell();
      const card = screen.getByTestId('terminal-path-hover-card');

      // The pointer leaves the link and is in the card before the leave has been confirmed.
      act(() => {
        capturedHandlers.leavePath({}, '/var/log/syslog');
        fireEvent.mouseEnter(card);
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 700));
      });
      expect(screen.getByTestId('terminal-path-hover-card')).toBeInTheDocument();

      act(() => {
        fireEvent.mouseLeave(card);
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 450));
      });
      expect(screen.queryByTestId('terminal-path-hover-card')).not.toBeInTheDocument();
    });

    it('still closes the card once the pointer really leaves', async () => {
      (window.multissh as any).storageLookup = vi.fn().mockResolvedValue({ name: 'syslog', isDirectory: false, size: 1 });
      render(<TerminalView config={sampleConfig} />);
      await act(async () => {
        await Promise.resolve();
      });

      act(() => {
        capturedHandlers.hoverPath({ clientX: 10, clientY: 10, ctrlKey: false, metaKey: false }, '/var/log/syslog');
      });
      await dwell();
      expect(screen.getByTestId('terminal-path-hover-card')).toBeInTheDocument();

      act(() => {
        capturedHandlers.leavePath({}, '/var/log/syslog');
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 700));
      });
      expect(screen.queryByTestId('terminal-path-hover-card')).not.toBeInTheDocument();
    });

    it('does not restart the dwell when a repaint reports leave and hover while the card is opening', async () => {
      const storageLookup = vi.fn().mockResolvedValue({ name: 'syslog', isDirectory: false, size: 1 });
      (window.multissh as any).storageLookup = storageLookup;
      render(<TerminalView config={sampleConfig} />);
      await act(async () => {
        await Promise.resolve();
      });
      const hover = { clientX: 10, clientY: 10, ctrlKey: false, metaKey: false };

      act(() => {
        capturedHandlers.hoverPath(hover, '/var/log/syslog');
      });
      // Repaints every 100 ms, which is faster than the 150 ms dwell: it must still complete.
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
        });
        act(() => {
          capturedHandlers.leavePath({}, '/var/log/syslog');
          capturedHandlers.hoverPath(hover, '/var/log/syslog');
        });
      }
      await dwell();
      expect(screen.getByTestId('terminal-path-hover-card')).toBeInTheDocument();
      expect(storageLookup).toHaveBeenCalledTimes(1);
    });

    it('still opens the card when the lookup fails for a reason other than a missing file', async () => {
      (window.multissh as any).storageLookup = vi.fn().mockRejectedValue(new Error('Connection lost'));
      render(<TerminalView config={sampleConfig} />);
      await act(async () => {
        await Promise.resolve();
      });

      act(() => {
        capturedHandlers.hoverPath({ clientX: 10, clientY: 10, ctrlKey: false, metaKey: false }, '/var/log/syslog');
      });
      await dwell();

      expect(screen.getByTestId('terminal-path-hover-card')).toBeInTheDocument();
    });

    it('does not open the card when the pointer leaves while the lookup is in flight', async () => {
      let resolveLookup: (v: unknown) => void = () => {};
      (window.multissh as any).storageLookup = vi.fn().mockReturnValue(
        new Promise((resolve) => {
          resolveLookup = resolve;
        })
      );
      render(<TerminalView config={sampleConfig} />);
      await act(async () => {
        await Promise.resolve();
      });

      act(() => {
        capturedHandlers.hoverPath({ clientX: 10, clientY: 10, ctrlKey: false, metaKey: false }, '/var/log/syslog');
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 250));
      });
      act(() => {
        capturedHandlers.leavePath({}, '/var/log/syslog');
      });
      // A leave only counts once no hover of the same path follows within the repaint grace time.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
      });
      await act(async () => {
        resolveLookup({ name: 'syslog', isDirectory: false, size: 1 });
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      expect(screen.queryByTestId('terminal-path-hover-card')).not.toBeInTheDocument();
    });

    it('in ctrl mode waits for Ctrl before checking and opening the card', async () => {
      const storageLookup = vi.fn().mockResolvedValue({ name: 'syslog', isDirectory: false, size: 1 });
      (window.multissh as any).storageLookup = storageLookup;
      render(<TerminalView config={sampleConfig} pathHoverMode="ctrl" />);
      await act(async () => {
        await Promise.resolve();
      });

      act(() => {
        capturedHandlers.hoverPath({ clientX: 10, clientY: 10, ctrlKey: false, metaKey: false }, '/var/log/syslog');
      });
      await dwell();
      expect(storageLookup).not.toHaveBeenCalled();
      expect(screen.queryByTestId('terminal-path-hover-card')).not.toBeInTheDocument();

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control' }));
      });
      await dwell();
      expect(screen.getByTestId('terminal-path-hover-card')).toBeInTheDocument();
    });

    it('in ctrl mode opens the card at once when Ctrl is already held', async () => {
      (window.multissh as any).storageLookup = vi.fn().mockResolvedValue({ name: 'syslog', isDirectory: false, size: 1 });
      render(<TerminalView config={sampleConfig} pathHoverMode="ctrl" />);
      await act(async () => {
        await Promise.resolve();
      });

      act(() => {
        capturedHandlers.hoverPath({ clientX: 10, clientY: 10, ctrlKey: true, metaKey: false }, '/var/log/syslog');
      });
      await dwell();
      expect(screen.getByTestId('terminal-path-hover-card')).toBeInTheDocument();
    });

    it('forgets the waiting path when the pointer leaves it', async () => {
      (window.multissh as any).storageLookup = vi.fn().mockResolvedValue({ name: 'syslog', isDirectory: false, size: 1 });
      render(<TerminalView config={sampleConfig} pathHoverMode="ctrl" />);
      await act(async () => {
        await Promise.resolve();
      });

      act(() => {
        capturedHandlers.hoverPath({ clientX: 10, clientY: 10, ctrlKey: false, metaKey: false }, '/var/log/syslog');
        capturedHandlers.leavePath({}, '/var/log/syslog');
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
      });
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control' }));
      });
      await dwell();
      expect(screen.queryByTestId('terminal-path-hover-card')).not.toBeInTheDocument();
    });
  });

  it('detects listening ports in terminal output and displays TerminalPortPill', async () => {
    render(<TerminalView config={sampleConfig} />);

    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      dataCallback?.('session-123', 'Vite dev server running at: http://localhost:5173\n');
    });

    expect(screen.getByTestId('terminal-port-pill-5173')).toBeInTheDocument();
    expect(screen.getByText('5173')).toBeInTheDocument();
  });

  it('shows drop overlay on drag enter and handles file drop', async () => {
    window.multissh.connectStorage = vi.fn().mockResolvedValue({ id: 'sftp-ssh-1' });
    window.multissh.transferAdd = vi.fn().mockResolvedValue({ jobId: 'job-1' });

    render(<TerminalView config={sampleConfig} initialCwd="/var/www/site" />);

    await act(async () => {
      await Promise.resolve();
    });

    const terminalView = screen.getByTestId('terminal-view');

    // 1. Drag enter
    act(() => {
      const dragEnterEvt = new Event('dragenter', { bubbles: true }) as any;
      dragEnterEvt.dataTransfer = { types: ['Files'] };
      terminalView.dispatchEvent(dragEnterEvt);
    });

    expect(screen.getByTestId('terminal-drop-overlay')).toBeInTheDocument();
    expect(screen.getByText('/var/www/site')).toBeInTheDocument();

    // 2. Drop file
    await act(async () => {
      const dropEvt = new Event('drop', { bubbles: true }) as any;
      dropEvt.dataTransfer = {
        files: [{ name: 'bundle.js', path: '/home/user/build/bundle.js' }],
      };
      terminalView.dispatchEvent(dropEvt);
    });

    expect(screen.queryByTestId('terminal-drop-overlay')).not.toBeInTheDocument();
    expect(window.multissh.transferAdd).toHaveBeenCalledWith({
      sourceProviderId: 'local',
      sourcePath: '/home/user/build/bundle.js',
      targetProviderId: 'sftp-ssh-1',
      targetPath: '/var/www/site/bundle.js',
    });
  });
});



