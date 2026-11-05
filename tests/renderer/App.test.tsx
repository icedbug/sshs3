// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, within, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { App } from '../../src/renderer/src/App';

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

describe('App Component', () => {
  let dataCallback: ((sessionId: string, data: string) => void) | null = null;

  beforeEach(() => {
    dataCallback = null;
    window.multissh = {
      ...(window.multissh || {}),
      terminalCreate: vi.fn().mockResolvedValue({ sessionId: 'app-term-1' }),
      terminalWrite: vi.fn().mockResolvedValue(undefined),
      terminalResize: vi.fn().mockResolvedValue(undefined),
      terminalKill: vi.fn().mockResolvedValue(undefined),
      onTerminalData: vi.fn((cb) => {
        dataCallback = cb;
        return vi.fn();
      }),
      onTerminalExit: vi.fn(() => vi.fn()),
      onAskpassPrompt: vi.fn(() => vi.fn()),
      submitAskpassPin: vi.fn().mockResolvedValue(undefined),
      connectStorage: vi.fn().mockResolvedValue({ id: 'local' }),
      storageList: vi.fn().mockResolvedValue([]),
      transferGetJobs: vi.fn().mockResolvedValue([]),
      onTransferProgress: vi.fn(() => vi.fn()),
      // A default single terminal tab, as a returning user would have saved
      // (App.tsx no longer seeds one synchronously — see the "no saved
      // session" empty-state unification in the UX review — so tests that
      // don't care about that empty state get a stable starting tab here).
      sessionGet: vi.fn().mockResolvedValue({
        tabs: [{ id: 'term-1', type: 'terminal', title: 'Terminal 1' }],
        activeTabId: 'term-1',
      }),
      sessionSave: vi.fn().mockResolvedValue(undefined),
      settingsGet: vi.fn().mockResolvedValue(undefined),
      settingsSave: vi.fn().mockResolvedValue(undefined),
      profilesGet: vi.fn().mockResolvedValue({ ssh: [], s3: [] }),
      profilesSaveSSH: vi.fn().mockResolvedValue(undefined),
      getHostname: vi.fn().mockResolvedValue('my-laptop'),
      onSearchResult: vi.fn(() => vi.fn()),
      onSearchProgress: vi.fn(() => vi.fn()),
      onSearchError: vi.fn(() => vi.fn()),
      onSearchDone: vi.fn(() => vi.fn()),
      searchStart: vi.fn().mockResolvedValue({ searchId: 'search-1' }),
      searchCancel: vi.fn().mockResolvedValue(undefined),
      searchPreview: vi.fn().mockResolvedValue({ content: '', startLine: 1 }),
    } as any;
  });

  afterEach(() => {
    cleanup();
  });

  it('renders application header, initial terminal tab, and tab bar', async () => {
    render(<App />);
    await screen.findByTestId('tab-term-1');

    expect(screen.getByText('ssh')).toBeInTheDocument();
    expect(screen.getByText('S3')).toBeInTheDocument();
    expect(screen.getByTestId('add-tab-btn')).toBeInTheDocument();

    // Default terminal tab exists and is active
    const tabs = screen.getAllByRole('tab');
    expect(tabs.length).toBeGreaterThanOrEqual(1);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('opens a new filemanager tab when selected from new tab menu', async () => {
    render(<App />);
    await screen.findByTestId('tab-term-1');

    // Click "+" button
    fireEvent.click(screen.getByTestId('add-tab-btn'));

    // Click "Ny filhanterare"
    fireEvent.click(screen.getByTestId('new-filemanager-btn'));

    // Should now have 2 tabs
    const tabs = screen.getAllByRole('tab');
    expect(tabs.length).toBe(2);

    // The new tab should be selected
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('File Manager 1')).toBeInTheDocument();
  });

  it('maintains non-active tabs mounted in DOM with display none', async () => {
    render(<App />);
    await screen.findByTestId('tab-term-1');

    // Add a filemanager tab
    fireEvent.click(screen.getByTestId('add-tab-btn'));
    fireEvent.click(screen.getByTestId('new-filemanager-btn'));

    const tabPanels = screen.getAllByTestId(/^tab-panel-/);
    expect(tabPanels.length).toBe(2);

    // Panel 0 (terminal) should be hidden, Panel 1 (filemanager) should be visible
    expect(tabPanels[0]).toHaveStyle({ display: 'none' });
    expect(tabPanels[1]).toHaveStyle({ display: 'flex' });

    // Switch back to tab 0
    const tabs = screen.getAllByRole('tab');
    fireEvent.click(tabs[0]);

    // Now Panel 0 is visible and Panel 1 is hidden
    expect(tabPanels[0]).toHaveStyle({ display: 'flex' });
    expect(tabPanels[1]).toHaveStyle({ display: 'none' });
  });

  it('closes a tab and switches active tab when close button is clicked', async () => {
    render(<App />);
    await screen.findByTestId('tab-term-1');

    // Add a second tab
    fireEvent.click(screen.getByTestId('add-tab-btn'));
    fireEvent.click(screen.getByTestId('new-terminal-btn'));

    let tabs = screen.getAllByRole('tab');
    expect(tabs.length).toBe(2);

    // Close the second tab
    const closeButtons = screen.getAllByTestId(/^close-tab-/);
    fireEvent.click(closeButtons[1]);

    tabs = screen.getAllByRole('tab');
    expect(tabs.length).toBe(1);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
  });

  describe('welcome screen "New Profile" shortcut', () => {
    const recentProfile = {
      id: 'r1',
      name: 'gnarg-fido2',
      host: 'gnarg',
      username: 'alun',
      authType: 'password',
      lastUsedAt: '2026-10-02 10:00',
    };

    beforeEach(() => {
      // No open tabs => the welcome screen is shown.
      window.multissh.sessionGet = vi.fn().mockResolvedValue({ tabs: [], activeTabId: '' });
    });

    it('first run (no recent connections): opens the connection manager straight into the empty new-profile form', async () => {
      render(<App />);
      fireEvent.click(await screen.findByRole('button', { name: 'New Profile' }));

      expect(await screen.findByLabelText(/Profile Name/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save Profile' })).toBeInTheDocument();
    });

    it('with recent connections: the slim action row has the same shortcut', async () => {
      window.multissh.profilesGet = vi.fn().mockResolvedValue({ ssh: [recentProfile], s3: [] });
      render(<App />);

      expect(await screen.findByText('Recent Connections')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'New Profile' }));
      expect(await screen.findByLabelText(/Profile Name/i)).toBeInTheDocument();
    });

    it('the plain Connections button still opens the profile list, not the form', async () => {
      window.multissh.profilesGet = vi.fn().mockResolvedValue({ ssh: [recentProfile], s3: [] });
      render(<App />);
      await screen.findByText('Recent Connections');

      fireEvent.click(screen.getByRole('button', { name: 'Connections' }));
      expect(await screen.findByText('Connection Manager')).toBeInTheDocument();
      expect(screen.queryByLabelText(/Profile Name/i)).not.toBeInTheDocument();
    });
  });

  it('opens settings modal when settings gear button is clicked', async () => {
    render(<App />);

    fireEvent.click(screen.getByTestId('quick-settings-btn'));
    expect(await screen.findByText('Settings')).toBeInTheDocument();
  });

  it('restores saved tabs from session on mount', async () => {
    window.multissh.sessionGet = vi.fn().mockResolvedValue({
      tabs: [
        { id: 'saved-term', type: 'terminal', title: 'Saved Terminal' },
        { id: 'saved-fm', type: 'filemanager', title: 'Saved Explorer' },
      ],
      activeTabId: 'saved-fm',
    });

    render(<App />);

    await vi.waitFor(() => {
      expect(screen.getByText('Saved Terminal')).toBeInTheDocument();
      expect(screen.getByText('Saved Explorer')).toBeInTheDocument();
    });

    const tabs = screen.getAllByRole('tab');
    expect(tabs.length).toBe(2);
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
  });

  it('splits a pane without recreating the existing session, and lets you close a specific pane', async () => {
    render(<App />);
    await screen.findByTestId('tab-term-1');

    // Start a local terminal first
    fireEvent.click(screen.getByText('Open Local Terminal'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(window.multissh.terminalCreate).toHaveBeenCalled();

    // A fresh tab always has exactly one (root) pane.
    let panes = screen.getAllByTestId(/^terminal-pane-/);
    expect(panes.length).toBe(1);
    const rootPaneId = panes[0].getAttribute('data-testid')!.replace('terminal-pane-', '');

    // Splitting must never call terminalKill for the existing pane's session (it must survive).
    (window.multissh.terminalCreate as any).mockClear();
    (window.multissh.terminalKill as any).mockClear();

    fireEvent.click(screen.getByTestId(`split-row-${rootPaneId}`));

    panes = screen.getAllByTestId(/^terminal-pane-/);
    expect(panes.length).toBe(2);
    // The original pane keeps its id and DOM node (no unmount/remount of the existing terminal).
    expect(screen.getByTestId(`terminal-pane-${rootPaneId}`)).toBeInTheDocument();
    expect(window.multissh.terminalKill).not.toHaveBeenCalled();
    expect(window.multissh.terminalCreate).not.toHaveBeenCalled();

    const otherPaneId = panes
      .map((p) => p.getAttribute('data-testid')!.replace('terminal-pane-', ''))
      .find((id) => id !== rootPaneId)!;

    // Start a session in the other pane too
    const otherPane = screen.getByTestId(`terminal-pane-${otherPaneId}`);
    fireEvent.click(within(otherPane).getByText('Open Local Terminal'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(window.multissh.terminalCreate).toHaveBeenCalled();
    (window.multissh.terminalCreate as any).mockClear();
    (window.multissh.terminalKill as any).mockClear();

    // Now split the ROOT pane again while the second pane is active.
    // This inserts a new pane between root and otherPane, shifting otherPane's index.
    // Neither rootPane nor otherPane must be unmounted or killed!
    fireEvent.click(screen.getByTestId(`split-row-${rootPaneId}`));
    panes = screen.getAllByTestId(/^terminal-pane-/);
    expect(panes.length).toBe(3);
    expect(window.multissh.terminalKill).not.toHaveBeenCalled();
    expect(window.multissh.terminalCreate).not.toHaveBeenCalled();

    const middlePaneId = panes
      .map((p) => p.getAttribute('data-testid')!.replace('terminal-pane-', ''))
      .find((id) => id !== rootPaneId && id !== otherPaneId)!;

    // Close the middle pane: otherPane shifts back down in index.
    (window.multissh.terminalKill as any).mockClear();
    fireEvent.click(screen.getByTestId(`close-pane-${middlePaneId}`));
    panes = screen.getAllByTestId(/^terminal-pane-/);
    expect(panes.length).toBe(2);
    // Middle pane had no active PTY session so terminalKill is 0, and other panes were untouched
    expect(window.multissh.terminalKill).not.toHaveBeenCalled();

    // Close the *other* pane (which has an active session) — its session must be killed cleanly
    (window.multissh.terminalKill as any).mockClear();
    fireEvent.click(screen.getByTestId(`close-pane-${otherPaneId}`));

    panes = screen.getAllByTestId(/^terminal-pane-/);
    expect(panes.length).toBe(1);
    expect(screen.getByTestId(`terminal-pane-${rootPaneId}`)).toBeInTheDocument();
    // Only the other pane's session was killed when it closed
    expect(window.multissh.terminalKill).toHaveBeenCalledTimes(1);
  });

  it('unsplit keeps the active pane alive without recreating its session, while closing other panes', async () => {
    render(<App />);
    await screen.findByTestId('tab-term-1');

    fireEvent.click(screen.getByText('Open Local Terminal'));
    await act(async () => {
      await Promise.resolve();
    });

    const rootPaneId = screen
      .getAllByTestId(/^terminal-pane-/)[0]
      .getAttribute('data-testid')!
      .replace('terminal-pane-', '');

    fireEvent.click(screen.getByTestId(`split-row-${rootPaneId}`));

    const panes = screen.getAllByTestId(/^terminal-pane-/);
    const otherPaneId = panes
      .map((p) => p.getAttribute('data-testid')!.replace('terminal-pane-', ''))
      .find((id) => id !== rootPaneId)!;

    const otherPane = screen.getByTestId(`terminal-pane-${otherPaneId}`);
    fireEvent.click(within(otherPane).getByText('Open Local Terminal'));
    await act(async () => {
      await Promise.resolve();
    });

    // Clear mocks before unsplit
    (window.multissh.terminalKill as any).mockClear();

    // Select the root pane as active
    fireEvent.mouseDown(screen.getByTestId(`terminal-pane-${rootPaneId}`));

    // Click unsplit button in the tab bar
    const unsplitBtn = screen.getByTestId(/^unsplit-/);
    fireEvent.click(unsplitBtn);

    // The other pane has a live session, so closing it must be confirmed first; cancelling keeps it
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(screen.getAllByTestId(/^terminal-pane-/).length).toBe(2);
    expect(window.multissh.terminalKill).not.toHaveBeenCalled();

    fireEvent.click(unsplitBtn);
    fireEvent.click(await screen.findByRole('button', { name: 'Close panes' }));

    // Only root pane remains
    await waitFor(() => expect(screen.getAllByTestId(/^terminal-pane-/).length).toBe(1));
    expect(screen.getByTestId(`terminal-pane-${rootPaneId}`)).toBeInTheDocument();
    // Only other pane's session was killed
    expect(window.multissh.terminalKill).toHaveBeenCalledTimes(1);
  });

  it('cycles focus between split panes via keyboard (Ctrl+Shift+N / Ctrl+Shift+P)', async () => {
    render(<App />);
    await screen.findByTestId('tab-term-1');

    const rootPaneId = screen
      .getAllByTestId(/^terminal-pane-/)[0]
      .getAttribute('data-testid')!
      .replace('terminal-pane-', '');

    fireEvent.click(screen.getByTestId(`split-row-${rootPaneId}`));

    const panes = screen.getAllByTestId(/^terminal-pane-/);
    expect(panes.length).toBe(2);
    const otherPaneId = panes
      .map((p) => p.getAttribute('data-testid')!.replace('terminal-pane-', ''))
      .find((id) => id !== rootPaneId)!;

    const isPaneFocused = (paneId: string) =>
      screen.getByTestId(`terminal-pane-${paneId}`).firstElementChild!.className.includes('bg-sky-500/5');

    // The freshly-split pane becomes active.
    expect(isPaneFocused(otherPaneId)).toBe(true);
    expect(isPaneFocused(rootPaneId)).toBe(false);

    // Ctrl+Shift+P is the "previous pane" shortcut.
    fireEvent.keyDown(window, { key: 'P', ctrlKey: true, shiftKey: true });

    expect(isPaneFocused(rootPaneId)).toBe(true);
    expect(isPaneFocused(otherPaneId)).toBe(false);

    // Ctrl+Shift+N ("next pane") should cycle back.
    fireEvent.keyDown(window, { key: 'N', ctrlKey: true, shiftKey: true });

    expect(isPaneFocused(otherPaneId)).toBe(true);
    expect(isPaneFocused(rootPaneId)).toBe(false);

    // Clicking the root pane activates it
    const rootPaneEl = screen.getByTestId(`terminal-pane-${rootPaneId}`);
    fireEvent.mouseDown(rootPaneEl);

    expect(isPaneFocused(rootPaneId)).toBe(true);
    expect(isPaneFocused(otherPaneId)).toBe(false);
  });

  it('handles keyboard shortcuts for new terminal, split vertical, and close tab', async () => {
    render(<App />);
    await screen.findByTestId('tab-term-1');

    expect(screen.getAllByRole('tab').length).toBe(1);

    // Trigger Ctrl+Shift+T to open new terminal tab
    fireEvent.keyDown(window, {
      key: 'T',
      ctrlKey: true,
      shiftKey: true,
    });

    // Should have 2 tabs now
    expect(screen.getAllByRole('tab').length).toBe(2);

    // Trigger Ctrl+Shift+D to split vertical on active tab
    fireEvent.keyDown(window, {
      key: 'D',
      ctrlKey: true,
      shiftKey: true,
    });

    // 1 pane in the first (now hidden) tab + 2 panes in the newly-split active tab
    expect(screen.getAllByTestId(/^terminal-pane-/).length).toBe(3);

    // Bare Ctrl+W belongs to the shell/TUI (readline, vim, nano) and must not close the tab
    fireEvent.keyDown(window, { key: 'w', ctrlKey: true });
    expect(screen.getAllByRole('tab').length).toBe(2);

    // Trigger Ctrl+Shift+W to close active tab
    fireEvent.keyDown(window, {
      key: 'W',
      ctrlKey: true,
      shiftKey: true,
    });

    expect(screen.getAllByRole('tab').length).toBe(1);
  });

  it('increases, decreases, and resets terminal font size with Ctrl++, Ctrl+-, and Ctrl+0', async () => {
    render(<App />);

    // Initial default terminalFontSize is 13.
    // Press Ctrl++ (e.g. Swedish layout: key '+', code 'Minus')
    fireEvent.keyDown(window, {
      key: '+',
      code: 'Minus',
      ctrlKey: true,
    });

    expect(window.multissh.settingsSave).toHaveBeenCalledWith(
      expect.objectContaining({ terminalFontSize: 14 })
    );

    // Press Ctrl+= (US layout unshifted: key '=', code 'Equal')
    fireEvent.keyDown(window, {
      key: '=',
      code: 'Equal',
      ctrlKey: true,
    });

    expect(window.multissh.settingsSave).toHaveBeenCalledWith(
      expect.objectContaining({ terminalFontSize: 15 })
    );

    // Press Ctrl+- (decrease)
    fireEvent.keyDown(window, {
      key: '-',
      code: 'Minus',
      ctrlKey: true,
    });

    expect(window.multissh.settingsSave).toHaveBeenCalledWith(
      expect.objectContaining({ terminalFontSize: 14 })
    );

    // Press Ctrl+0 (reset to default 13)
    fireEvent.keyDown(window, {
      key: '0',
      code: 'Digit0',
      ctrlKey: true,
    });

    expect(window.multissh.settingsSave).toHaveBeenCalledWith(
      expect.objectContaining({ terminalFontSize: 13 })
    );
  });

  it('cycles tabs indefinitely with Ctrl+Tab and Ctrl+Shift+Tab without getting stuck', async () => {
    render(<App />);
    await screen.findByTestId('tab-term-1');

    // Create two more terminal tabs -> total 3 tabs
    fireEvent.keyDown(window, { key: 'T', ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: 'T', ctrlKey: true, shiftKey: true });

    const tabs = screen.getAllByRole('tab');
    expect(tabs.length).toBe(3);

    // Initial active tab is Terminal 3 (newly created)
    expect(tabs[2]).toHaveAttribute('aria-selected', 'true');

    // Cycle forward: 3 -> 1 -> 2 -> 3 -> 1 -> 2 (multiple times)
    fireEvent.keyDown(window, { key: 'Tab', code: 'Tab', ctrlKey: true });
    expect(screen.getAllByRole('tab')[0]).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(window, { key: 'Tab', code: 'Tab', ctrlKey: true });
    expect(screen.getAllByRole('tab')[1]).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(window, { key: 'Tab', code: 'Tab', ctrlKey: true });
    expect(screen.getAllByRole('tab')[2]).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(window, { key: 'Tab', code: 'Tab', ctrlKey: true });
    expect(screen.getAllByRole('tab')[0]).toHaveAttribute('aria-selected', 'true');

    // Cycle backward with Ctrl+Shift+Tab (also testing Linux ISO_Left_Tab)
    fireEvent.keyDown(window, { key: 'ISO_Left_Tab', code: 'Tab', ctrlKey: true, shiftKey: true });
    expect(screen.getAllByRole('tab')[2]).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(window, { key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: true });
    expect(screen.getAllByRole('tab')[1]).toHaveAttribute('aria-selected', 'true');
  });

  it('jumps to a tab with Ctrl+<digit> and to the last tab with Ctrl+9', async () => {
    render(<App />);
    await screen.findByTestId('tab-term-1');
    fireEvent.keyDown(window, { key: 'T', ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: 'T', ctrlKey: true, shiftKey: true });
    expect(screen.getAllByRole('tab')[2]).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(window, { key: '1', code: 'Digit1', ctrlKey: true });
    expect(screen.getAllByRole('tab')[0]).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(window, { key: '2', code: 'Digit2', ctrlKey: true });
    expect(screen.getAllByRole('tab')[1]).toHaveAttribute('aria-selected', 'true');

    // Ctrl+8 with only three tabs: no such tab, selection is unchanged
    fireEvent.keyDown(window, { key: '8', code: 'Digit8', ctrlKey: true });
    expect(screen.getAllByRole('tab')[1]).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(window, { key: '9', code: 'Digit9', ctrlKey: true });
    expect(screen.getAllByRole('tab')[2]).toHaveAttribute('aria-selected', 'true');
  });

  it('zooms the active split pane with Ctrl+Shift+Z and restores it, and closes it with Ctrl+Alt+Shift+W', async () => {
    render(<App />);
    await screen.findByTestId('tab-term-1');
    fireEvent.keyDown(window, { key: 'D', ctrlKey: true, shiftKey: true });
    expect(screen.getAllByTestId(/^terminal-pane-/).length).toBe(2);

    fireEvent.keyDown(window, { key: 'Z', ctrlKey: true, shiftKey: true });
    expect(screen.getAllByTestId(/^terminal-pane-/).length).toBe(1);

    fireEvent.keyDown(window, { key: 'Z', ctrlKey: true, shiftKey: true });
    expect(screen.getAllByTestId(/^terminal-pane-/).length).toBe(2);

    fireEvent.keyDown(window, { key: 'W', code: 'KeyW', ctrlKey: true, shiftKey: true, altKey: true });
    expect(screen.getAllByTestId(/^terminal-pane-/).length).toBe(1);

    // A sole pane has nothing to close: the shortcut must not close the pane or the tab
    fireEvent.keyDown(window, { key: 'W', code: 'KeyW', ctrlKey: true, shiftKey: true, altKey: true });
    expect(screen.getAllByTestId(/^terminal-pane-/).length).toBe(1);
    expect(screen.getAllByRole('tab').length).toBe(1);
  });

  it('opens Settings on the Keyboard Shortcuts overview with Ctrl+Shift+H', async () => {
    render(<App />);
    await screen.findByTestId('tab-term-1');
    fireEvent.keyDown(window, { key: 'H', ctrlKey: true, shiftKey: true });
    expect(await screen.findByText('Close Split Pane')).toBeInTheDocument();
  });

  it('opens the Connection Manager on Ctrl+Shift+O but leaves Ctrl+K (kill-line) and Ctrl+Shift+K alone', async () => {
    render(<App />);

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(screen.queryByText('Connection Manager')).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'O', ctrlKey: true, shiftKey: true });
    expect(screen.getByText('Connection Manager')).toBeInTheDocument();
  });

  describe('global search', () => {
    it('opens on Ctrl+Shift+G and from the top bar button, but leaves Ctrl+K (kill-line) alone', async () => {
      render(<App />);
      await screen.findByTestId('tab-term-1');

      fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
      expect(screen.queryByRole('dialog', { name: 'Search' })).not.toBeInTheDocument();

      fireEvent.keyDown(window, { key: 'G', ctrlKey: true, shiftKey: true });
      expect(await screen.findByRole('dialog', { name: 'Search' })).toBeInTheDocument();

      fireEvent.keyDown(window, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Search' })).not.toBeInTheDocument());

      fireEvent.click(screen.getByTestId('global-search-btn'));
      expect(await screen.findByRole('dialog', { name: 'Search' })).toBeInTheDocument();
    });

    it('makes the tab bar inert while it is open, like the other top-level dialogs', async () => {
      render(<App />);
      await screen.findByTestId('tab-term-1');
      const header = screen.getByTestId('add-tab-btn').closest('header') as HTMLElement & { inert?: boolean };
      fireEvent.keyDown(window, { key: 'G', ctrlKey: true, shiftKey: true });
      await screen.findByRole('dialog', { name: 'Search' });
      expect(header.inert).toBe(true);
    });

    it('connects the chosen profile in the empty tab and closes', async () => {
      (window.multissh.profilesGet as ReturnType<typeof vi.fn>).mockResolvedValue({
        ssh: [{ id: 'p1', name: 'web-01', host: 'web-01.example.com', username: 'deploy', authType: 'password' }],
        s3: [],
      });
      window.multissh.teamVaultList = vi.fn().mockResolvedValue([]);
      render(<App />);
      await screen.findByTestId('tab-term-1');

      fireEvent.keyDown(window, { key: 'G', ctrlKey: true, shiftKey: true });
      const input = await screen.findByRole('combobox');
      fireEvent.change(input, { target: { value: 'web-01' } });
      await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(0));
      fireEvent.keyDown(input, { key: 'Enter' });

      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Search' })).not.toBeInTheDocument());
      expect(screen.getAllByRole('tab')).toHaveLength(1);
      expect(screen.getByRole('tab')).toHaveTextContent('web-01');
    });

    it('runs an action chosen after > : a new terminal tab, and Settings', async () => {
      render(<App />);
      await screen.findByTestId('tab-term-1');

      fireEvent.keyDown(window, { key: 'G', ctrlKey: true, shiftKey: true });
      let input = await screen.findByRole('combobox');
      fireEvent.change(input, { target: { value: '>new terminal' } });
      await waitFor(() => expect(screen.getAllByRole('option')[0]).toHaveTextContent('New Terminal'));
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Search' })).not.toBeInTheDocument());
      expect(screen.getAllByRole('tab')).toHaveLength(2);

      fireEvent.keyDown(window, { key: 'G', ctrlKey: true, shiftKey: true });
      input = await screen.findByRole('combobox');
      fireEvent.change(input, { target: { value: '>settings' } });
      await waitFor(() => expect(screen.getAllByRole('option')[0]).toHaveTextContent('Settings'));
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Search' })).not.toBeInTheDocument());
      expect(screen.getByRole('dialog', { name: /Settings/i })).toBeInTheDocument();
    });

    it('is switched off by the setting: no button, and the shortcut is left alone', async () => {
      const { DEFAULT_SETTINGS } = await import('../../src/shared/types/settings');
      window.multissh.settingsGet = vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS, enableGlobalSearch: false });
      render(<App />);
      await screen.findByTestId('tab-term-1');
      await waitFor(() => expect(screen.queryByTestId('global-search-btn')).not.toBeInTheDocument());

      const notPrevented = fireEvent.keyDown(window, { key: 'G', ctrlKey: true, shiftKey: true });
      expect(notPrevented).toBe(true);
      expect(screen.queryByRole('dialog', { name: 'Search' })).not.toBeInTheDocument();
    });
  });

  it('reuses closed tab numbers instead of incrementing endlessly', async () => {
    render(<App />);
    await screen.findByTestId('tab-term-1');

    expect(screen.getByText('Terminal 1')).toBeInTheDocument();

    // Create a new terminal tab -> should be Terminal 2
    fireEvent.click(screen.getByTestId('add-tab-btn'));
    fireEvent.click(screen.getByTestId('new-terminal-btn'));
    expect(screen.getByText('Terminal 2')).toBeInTheDocument();

    // Close Terminal 2
    const closeBtns = screen.getAllByTestId(/^close-tab-/);
    fireEvent.click(closeBtns[closeBtns.length - 1]);
    expect(screen.queryByText('Terminal 2')).not.toBeInTheDocument();

    // Create another terminal tab -> should reuse number 2
    fireEvent.click(screen.getByTestId('add-tab-btn'));
    fireEvent.click(screen.getByTestId('new-terminal-btn'));
    expect(screen.getByText('Terminal 2')).toBeInTheDocument();
  });

  it('updates tab title from Terminal 1 to profile name when connecting an SSH profile in an empty tab', async () => {
    (window.multissh.profilesGet as any).mockResolvedValue({
      ssh: [
        {
          id: 'ssh-test-1',
          name: 'Production Server',
          host: 'prod.example.com',
          port: 22,
          username: 'admin',
          authType: 'password',
        },
      ],
      s3: [],
    });

    render(<App />);
    await screen.findByTestId('tab-term-1');

    expect(within(screen.getByTestId('tab-term-1')).getByText('Terminal 1')).toBeInTheDocument();

    // Click "Select SSH Connection" in the empty pane
    fireEvent.click(screen.getByText('Select SSH Connection'));

    // Wait for the modal to finish loading profiles
    expect(await screen.findByText('Production Server')).toBeInTheDocument();

    // Click "Connect" on the profile row
    const connectBtn = screen.getByRole('button', { name: /^connect$/i });
    fireEvent.click(connectBtn);

    // The tab should now be renamed from Terminal 1 to the profile name!
    await vi.waitFor(() => {
      expect(within(screen.getByTestId('tab-term-1')).getByText('Production Server')).toBeInTheDocument();
    });
  });

  it('dynamically updates tab title when SSHing further to a new host and restores on exit', async () => {
    render(<App />);
    await screen.findByTestId('tab-term-1');

    expect(within(screen.getByTestId('tab-term-1')).getByText('Terminal 1')).toBeInTheDocument();

    // Open local terminal in the tab
    fireEvent.click(screen.getByText('Open Local Terminal'));

    await vi.waitFor(() => {
      expect(within(screen.getByTestId('tab-term-1')).getByText('Local Shell')).toBeInTheDocument();
    });

    // Shell starts on local host, sends prompt OSC sequence
    act(() => {
      dataCallback?.('app-term-1', '\x1b]0;alun@my-laptop: ~\x07');
    });

    // Still Local Shell because my-laptop is the base host
    expect(within(screen.getByTestId('tab-term-1')).getByText('Local Shell')).toBeInTheDocument();

    // User runs `ssh remote-prod-1` which outputs OSC title for remote host
    act(() => {
      dataCallback?.('app-term-1', '\x1b]0;root@remote-prod-1: /var/log\x07');
    });

    // Tab title dynamically updates to remote-prod-1!
    await vi.waitFor(() => {
      expect(within(screen.getByTestId('tab-term-1')).getByText('remote-prod-1')).toBeInTheDocument();
    });

    // User exits back to local host
    act(() => {
      dataCallback?.('app-term-1', '\x1b]0;alun@my-laptop: ~\x07');
    });

    // Tab title restores to Local Shell!
    await vi.waitFor(() => {
      expect(within(screen.getByTestId('tab-term-1')).getByText('Local Shell')).toBeInTheDocument();
    });
  });

  it('detects nested hostname from plain prompt output and restores on exit', async () => {
    render(<App />);
    await screen.findByTestId('tab-term-1');

    // Open local terminal
    fireEvent.click(screen.getByText('Open Local Terminal'));
    await vi.waitFor(() => {
      expect(within(screen.getByTestId('tab-term-1')).getByText('Local Shell')).toBeInTheDocument();
    });

    // Remote machine gnarg outputs standard bash prompt without OSC title
    act(() => {
      dataCallback?.('app-term-1', '[alun@gnarg ~]$ ');
    });

    // Tab title dynamically updates to gnarg!
    await vi.waitFor(() => {
      expect(within(screen.getByTestId('tab-term-1')).getByText('gnarg')).toBeInTheDocument();
    });

    // When exiting, local prompt outputs
    act(() => {
      dataCallback?.('app-term-1', '[alun@my-laptop ~]$ ');
    });

    // Tab title restores to Local Shell!
    await vi.waitFor(() => {
      expect(within(screen.getByTestId('tab-term-1')).getByText('Local Shell')).toBeInTheDocument();
    });
  });

  it('drops tab-bar focus when a modal opens so the modal owns Enter/Escape', async () => {
    render(<App />);
    await screen.findByTestId('tab-term-1');
    fireEvent.click(screen.getByTestId('add-tab-btn'));
    fireEvent.click(screen.getByTestId('new-filemanager-btn'));

    const activeTab = () => screen.getAllByRole('tab').find((t) => t.getAttribute('aria-selected') === 'true')!;

    // Ctrl+Shift+Up in the file manager moves focus to the tab bar.
    fireEvent.keyDown(window, { key: 'ArrowUp', code: 'ArrowUp', ctrlKey: true, shiftKey: true });
    expect(activeTab().className).toContain('ring-sky-400');

    // Opening the Connection Manager must release tab-bar focus.
    fireEvent.keyDown(window, { key: 'O', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(activeTab().className).not.toContain('ring-sky-400'));
  });

  it('saves a font size change as that one setting, so a stale copy of the others is never sent back', async () => {
    render(<App />);
    await screen.findByTestId('tab-term-1');

    fireEvent.keyDown(window, { key: '+', ctrlKey: true });

    await waitFor(() => expect(window.multissh.settingsSave).toHaveBeenCalled());
    const sent = vi.mocked(window.multissh.settingsSave).mock.calls[0][0];
    // Not the whole object: connectionManagerVisibleTeamVaults and connectionManagerDefaultTab are written
    // by their own calls and App's copy of them can be out of date.
    expect(Object.keys(sent)).toEqual(['terminalFontSize']);
  });
});

