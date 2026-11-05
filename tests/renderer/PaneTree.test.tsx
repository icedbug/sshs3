// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { PaneTreeView } from '../../src/renderer/src/components/PaneTree';
import type { PaneLeaf } from '../../src/shared/types/session';
import type { AppSettings } from '../../src/shared/types/settings';

// Polyfill ResizeObserver and matchMedia
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

const dummySettings: AppSettings = {
  theme: 'dark',
  fontSize: 14,
  fontFamily: 'monospace',
  cursorStyle: 'block',
  cursorBlink: true,
  scrollback: 1000,
  copyOnSelect: false,
} as unknown as AppSettings;

describe('PaneTree Component', () => {
  beforeEach(() => {
    window.multissh = {
      ...(window.multissh || {}),
      detectLocalShells: vi.fn().mockResolvedValue({ pwsh: true, wsl: true }),
    } as any;
  });

  afterEach(() => {
    cleanup();
  });

  it('renders Open Local Terminal button on non-Windows platforms', () => {
    const emptyLeaf: PaneLeaf = {
      id: 'pane-1',
      type: 'leaf',
    };
    const onOpenLocal = vi.fn();

    render(
      <PaneTreeView
        node={emptyLeaf}
        isActive={true}
        activePaneId="pane-1"
        totalPanes={1}
        settings={dummySettings}
        platform="linux"
        onSelectPane={vi.fn()}
        onSplitPane={vi.fn()}
        onClosePane={vi.fn()}
        onChangeConnection={vi.fn()}
        onOpenLocalTerminal={onOpenLocal}
        onCloseTab={vi.fn()}
      />
    );

    const button = screen.getByRole('button', { name: 'Open Local Terminal' });
    expect(button).toBeInTheDocument();
    fireEvent.click(button);
    expect(onOpenLocal).toHaveBeenCalledWith('pane-1', undefined, undefined);
  });

  it('renders individual buttons for each WSL distro when multiple distros exist', async () => {
    (window.multissh.detectLocalShells as any).mockResolvedValue({
      pwsh: true,
      wsl: true,
      wslDistros: ['Ubuntu', 'Debian'],
    });

    const emptyLeaf: PaneLeaf = {
      id: 'pane-1',
      type: 'leaf',
    };
    const onOpenLocal = vi.fn();

    render(
      <PaneTreeView
        node={emptyLeaf}
        isActive={true}
        activePaneId="pane-1"
        totalPanes={1}
        settings={dummySettings}
        platform="win32"
        onSelectPane={vi.fn()}
        onSplitPane={vi.fn()}
        onClosePane={vi.fn()}
        onChangeConnection={vi.fn()}
        onOpenLocalTerminal={onOpenLocal}
        onCloseTab={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Ubuntu' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Debian' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Ubuntu' }));
    expect(onOpenLocal).toHaveBeenCalledWith('pane-1', 'wsl', 'Ubuntu');

    fireEvent.click(screen.getByRole('button', { name: 'Debian' }));
    expect(onOpenLocal).toHaveBeenCalledWith('pane-1', 'wsl', 'Debian');
  });

  it('renders WSL (distro) button when a single WSL distro exists', async () => {
    (window.multissh.detectLocalShells as any).mockResolvedValue({
      pwsh: false,
      wsl: true,
      wslDistros: ['Ubuntu-22.04'],
    });

    const emptyLeaf: PaneLeaf = {
      id: 'pane-1',
      type: 'leaf',
    };
    const onOpenLocal = vi.fn();

    render(
      <PaneTreeView
        node={emptyLeaf}
        isActive={true}
        activePaneId="pane-1"
        totalPanes={1}
        settings={dummySettings}
        platform="win32"
        onSelectPane={vi.fn()}
        onSplitPane={vi.fn()}
        onClosePane={vi.fn()}
        onChangeConnection={vi.fn()}
        onOpenLocalTerminal={onOpenLocal}
        onCloseTab={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'WSL (Ubuntu-22.04)' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'WSL (Ubuntu-22.04)' }));
    expect(onOpenLocal).toHaveBeenCalledWith('pane-1', 'wsl', 'Ubuntu-22.04');
  });

  it('displays WSL: <distro> in pane header when node has shellType wsl and wslDistro', () => {
    const wslLeaf: PaneLeaf = {
      id: 'pane-1',
      type: 'leaf',
      local: true,
      shellType: 'wsl',
      wslDistro: 'Ubuntu-24.04',
    };

    render(
      <PaneTreeView
        node={wslLeaf}
        isActive={true}
        activePaneId="pane-1"
        totalPanes={1}
        settings={dummySettings}
        platform="win32"
        onSelectPane={vi.fn()}
        onSplitPane={vi.fn()}
        onClosePane={vi.fn()}
        onChangeConnection={vi.fn()}
        onOpenLocalTerminal={vi.fn()}
        onCloseTab={vi.fn()}
      />
    );

    expect(screen.getByText('WSL: Ubuntu-24.04')).toBeInTheDocument();
  });

  it('renders a resizable divider for a 2-child split and reports the new weights on change (§23)', () => {
    const splitNode = {
      type: 'split' as const,
      id: 'split-1',
      orientation: 'row' as const,
      children: [
        { type: 'leaf' as const, id: 'pane-1' },
        { type: 'leaf' as const, id: 'pane-2' },
      ],
    };
    const onResizeSplit = vi.fn();

    render(
      <PaneTreeView
        node={splitNode}
        isActive={true}
        activePaneId="pane-1"
        totalPanes={2}
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

    const divider = screen.getByRole('separator', { name: 'Resize terminal panes' });
    expect(divider).toHaveAttribute('aria-valuenow', '50');

    fireEvent.keyDown(divider, { key: 'ArrowRight', ctrlKey: true, altKey: true });
    expect(onResizeSplit).toHaveBeenCalledTimes(1);
    const [splitId, [first, second]] = onResizeSplit.mock.calls[0];
    expect(splitId).toBe('split-1');
    expect(first).toBeCloseTo(0.55);
    expect(second).toBeCloseTo(0.45);
  });

  it('does not render a divider for a 3-child split (not yet resizable)', () => {
    const splitNode = {
      type: 'split' as const,
      id: 'split-1',
      orientation: 'row' as const,
      children: [
        { type: 'leaf' as const, id: 'pane-1' },
        { type: 'leaf' as const, id: 'pane-2' },
        { type: 'leaf' as const, id: 'pane-3' },
      ],
    };

    render(
      <PaneTreeView
        node={splitNode}
        isActive={true}
        activePaneId="pane-1"
        totalPanes={3}
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

    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
  });
});
