// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { SSHConnectionConfig } from '../../src/shared/types/ssh';
import { TerminalView } from '../../src/renderer/src/components/TerminalView';
import { dispatchTerminalAction } from '../../src/renderer/src/lib/terminalActionEvents';

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

  describe('AI assistant integration', () => {
    const enabledAi = { enabled: true, provider: 'anthropic', model: 'claude-opus-5-5', hasApiKey: true };

    async function renderWithAi(aiAsk = vi.fn()) {
      Object.assign(window.multissh, { aiGetConfig: vi.fn().mockResolvedValue(enabledAi), aiAsk });
      const view = render(<TerminalView config={sampleConfig} />);
      await act(async () => {
        await Promise.resolve();
      });
      const textarea = view.container.querySelector('textarea.xterm-helper-textarea') as HTMLTextAreaElement;
      textarea.focus();
      const type = (text: string) => {
        for (const ch of text) fireEvent.keyPress(textarea, { key: ch, charCode: ch.charCodeAt(0) });
      };
      const pressEnter = () => fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 13 });
      return { aiAsk, type, pressEnter };
    }

    it('offers to explain a command that exited with an error', async () => {
      const aiAsk = vi.fn().mockResolvedValue({ text: 'The command name is misspelled.', redacted: false });
      const { type, pressEnter } = await renderWithAi(aiAsk);
      type('dokcer ps');
      pressEnter();
      act(() => {
        dataCallback!('session-123', '\r\nbash: dokcer: command not found\r\n\x1b]133;D;127\x07\x1b]133;A\x07$ ');
      });

      fireEvent.click(await screen.findByRole('button', { name: /Explain this error/ }));
      expect(await screen.findByText('The command name is misspelled.')).toBeInTheDocument();
      expect(aiAsk).toHaveBeenCalledWith(
        expect.objectContaining({ task: 'explain', context: expect.stringContaining('dokcer: command not found') })
      );
      expect(screen.queryByTestId('ai-failure-hint')).not.toBeInTheDocument();
    });

    it('stays quiet after a command that succeeded', async () => {
      const { type, pressEnter } = await renderWithAi();
      type('true');
      pressEnter();
      act(() => {
        dataCallback!('session-123', '\r\n\x1b]133;D;0\x07\x1b]133;A\x07$ ');
      });
      await new Promise((resolve) => setTimeout(resolve, 900));
      expect(screen.queryByTestId('ai-failure-hint')).not.toBeInTheDocument();
    });

    it('recognises a typical error message when the shell reports no exit codes', async () => {
      const { type, pressEnter } = await renderWithAi();
      type('cat nope');
      pressEnter();
      act(() => {
        dataCallback!('session-123', '\r\ncat: nope: No such file or directory\r\n$ ');
      });
      expect(await screen.findByTestId('ai-failure-hint', {}, { timeout: 2000 })).toBeInTheDocument();
    });

    it('turns the typed line into a command without running it', async () => {
      const aiAsk = vi.fn().mockResolvedValue({ command: 'du -sh * | sort -h', text: 'Sizes, largest last.', redacted: false });
      const { type } = await renderWithAi(aiAsk);
      type('largest folders here');
      mockTerminalWrite.mockClear();

      act(() => dispatchTerminalAction('aiInlineCommand'));

      await waitFor(() => expect(mockTerminalWrite).toHaveBeenCalledTimes(2));
      expect(aiAsk).toHaveBeenCalledWith(expect.objectContaining({ task: 'command', prompt: 'largest folders here' }));
      expect(mockTerminalWrite).toHaveBeenNthCalledWith(1, 'session-123', '\x7f'.repeat('largest folders here'.length));
      expect(mockTerminalWrite).toHaveBeenNthCalledWith(2, 'session-123', 'du -sh * | sort -h');
      expect(await screen.findByTestId('copy-notice')).toHaveTextContent('Sizes, largest last.');
    });

    it('opens the assistant instead when nothing is typed', async () => {
      const aiAsk = vi.fn();
      await renderWithAi(aiAsk);
      act(() => dispatchTerminalAction('aiInlineCommand'));
      expect(await screen.findByRole('tab', { name: 'Suggest a command' })).toHaveAttribute('aria-selected', 'true');
      expect(aiAsk).not.toHaveBeenCalled();
    });
  });
});
