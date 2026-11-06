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

  it('renders SessionTelemetryPill in pane header with live CPU, latency, 8-point SVG sparkline, and 1-click detail popover (F7)', () => {
    const sshLeaf: PaneLeaf = {
      id: 'pane-ssh-1',
      type: 'leaf',
      local: true,
    };

    render(
      <PaneTreeView
        node={sshLeaf}
        isActive={true}
        activePaneId="pane-ssh-1"
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

    const pill = screen.getByTestId('session-telemetry-pill');
    expect(pill).toBeInTheDocument();
    expect(pill.className).toContain('sshs3-telemetry-pill');

    const sparkline = screen.getByTestId('session-telemetry-sparkline');
    expect(sparkline).toBeInTheDocument();
    const points = (sparkline.getAttribute('points') || '').trim().split(/\s+/);
    expect(points.length).toBe(8);

    // 1-click expand opens detail popover
    expect(screen.queryByTestId('session-telemetry-detail')).not.toBeInTheDocument();
    fireEvent.click(pill);
    expect(screen.getByTestId('session-telemetry-detail')).toBeInTheDocument();
    expect(screen.getByTestId('telemetry-action-split-sftp')).toBeInTheDocument();
    expect(screen.getByTestId('telemetry-action-diagnose-ai')).toBeInTheDocument();
    expect(screen.getByTestId('telemetry-action-open-fleet')).toBeInTheDocument();

    // Clicking Diagnose with AI dispatches sshs3:ai-open with telemetry context
    const aiEvents: CustomEvent[] = [];
    const onAiOpen = (e: Event) => aiEvents.push(e as CustomEvent);
    window.addEventListener('sshs3:ai-open', onAiOpen);
    try {
      fireEvent.click(screen.getByTestId('telemetry-action-diagnose-ai'));
      expect(aiEvents.length).toBe(1);
      expect(aiEvents[0].detail.telemetry).toBeDefined();
    } finally {
      window.removeEventListener('sshs3:ai-open', onAiOpen);
    }
  });

  it('splits a pane side-by-side with SFTP browser when clicking SFTP Split, supports resizing, and closes SFTP split cleanly (F8)', async () => {
    const localLeaf: PaneLeaf = {
      id: 'pane-host-1',
      type: 'leaf',
    };
    const onResizeSplit = vi.fn();

    render(
      <PaneTreeView
        node={localLeaf}
        isActive={true}
        activePaneId="pane-host-1"
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

    expect(screen.queryByTestId('host-workspace-sftp-pane')).not.toBeInTheDocument();

    // Click the 1-click Split SFTP button in the header
    fireEvent.click(screen.getByTestId('pane-split-sftp-pane-host-1'));

    expect(screen.getByTestId('host-workspace-sftp-pane')).toBeInTheDocument();
    const divider = screen.getByRole('separator', { name: 'Resize terminal panes' });
    expect(divider).toBeInTheDocument();

    // Resize the split divider between terminal and SFTP browser
    fireEvent.keyDown(divider, { key: 'ArrowRight', ctrlKey: true, altKey: true });
    expect(onResizeSplit).toHaveBeenCalledTimes(1);

    // Close the SFTP split pane and verify the original pane remains mounted
    fireEvent.click(screen.getByTestId('close-pane-pane-host-1-sftp'));
    expect(screen.queryByTestId('host-workspace-sftp-pane')).not.toBeInTheDocument();
    expect(screen.getByTestId('terminal-pane-pane-host-1')).toBeInTheDocument();
  });
});
