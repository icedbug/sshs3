// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { DotfilesSyncBanner } from '../../src/renderer/src/components/DotfilesSyncBanner';
import type { DotfilesSyncPromptEvent, DotfilesSyncStatusEvent } from '../../src/shared/types/dotfiles';
import { getTopmostOverlay } from '../../src/renderer/src/lib/spatialNavigation';

describe('DotfilesSyncBanner status toast', () => {
  let emitStatus: ((event: DotfilesSyncStatusEvent) => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    emitStatus = null;
    window.multissh = {
      onDotfilesSyncPrompt: vi.fn(() => () => undefined),
      onDotfilesSyncStatus: vi.fn((cb: (event: DotfilesSyncStatusEvent) => void) => {
        emitStatus = cb;
        return () => undefined;
      }),
    } as unknown as typeof window.multissh;
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('announces a success politely and removes it after a few seconds', () => {
    render(<DotfilesSyncBanner />);
    act(() => emitStatus!({ sessionId: 's1', status: 'updated', updatedCount: 2 }));

    const toast = screen.getByTestId('dotfiles-sync-status');
    expect(toast).toHaveAttribute('role', 'status');
    expect(toast).toHaveTextContent('2 dotfiles updated');

    act(() => vi.advanceTimersByTime(4100));
    expect(screen.queryByTestId('dotfiles-sync-status')).not.toBeInTheDocument();
  });

  it('announces a failure as an alert and keeps it until it is dismissed', () => {
    render(<DotfilesSyncBanner />);
    act(() => emitStatus!({ sessionId: 's1', status: 'error', error: 'permission denied' }));

    const toast = screen.getByTestId('dotfiles-sync-status');
    expect(toast).toHaveAttribute('role', 'alert');
    expect(toast).toHaveTextContent('Dotfiles sync failed: permission denied');

    // Well past the old 4 s auto-hide: still there.
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByTestId('dotfiles-sync-status')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('dotfiles-sync-status')).not.toBeInTheDocument();
  });

  it('a later success does not leave a stale hide timer that removes a newer failure', () => {
    render(<DotfilesSyncBanner />);
    act(() => emitStatus!({ sessionId: 's1', status: 'updated', updatedCount: 1 }));
    act(() => vi.advanceTimersByTime(1000));
    act(() => emitStatus!({ sessionId: 's2', status: 'error', error: 'boom' }));
    act(() => vi.advanceTimersByTime(10_000));

    expect(screen.getByTestId('dotfiles-sync-status')).toHaveTextContent('boom');
  });
});

describe('DotfilesSyncBanner prompt', () => {
  let emitPrompt: ((event: DotfilesSyncPromptEvent) => void) | null = null;

  beforeEach(() => {
    emitPrompt = null;
    window.multissh = {
      onDotfilesSyncPrompt: vi.fn((cb: (event: DotfilesSyncPromptEvent) => void) => {
        emitPrompt = cb;
        return () => undefined;
      }),
      onDotfilesSyncStatus: vi.fn(() => () => undefined),
      respondDotfilesSyncPrompt: vi.fn().mockResolvedValue(undefined),
    } as unknown as typeof window.multissh;
  });

  afterEach(() => cleanup());

  it('is a labelled status notice that is announced, not a dialog', () => {
    render(<DotfilesSyncBanner />);
    act(() =>
      emitPrompt!({ id: 'p1', sessionId: 's1', poolName: 'Work', hostLabel: 'web-1', entries: [{ fileId: 'f', remotePath: '~/.bashrc', reason: 'changed' } as never] })
    );
    expect(screen.getByRole('status', { name: 'Dotfiles out of date on web-1' })).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('is not taken for a modal overlay, so Ctrl+Shift+Arrow keeps navigating the app', () => {
    render(<DotfilesSyncBanner />);
    act(() => emitPrompt!({ id: 'p1', sessionId: 's1', poolName: 'Work', hostLabel: 'web-1', entries: [] }));
    expect(screen.getByTestId('dotfiles-sync-banner')).toBeInTheDocument();
    expect(getTopmostOverlay()).toBeNull();
  });
});
