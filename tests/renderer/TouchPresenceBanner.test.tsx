// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TouchPresenceBanner } from '../../src/renderer/src/components/TouchPresenceBanner';
import type { PresencePromptEvent, PresenceClearEvent } from '../../src/shared/types/ipc';

describe('TouchPresenceBanner Component', () => {
  let promptCallback: ((event: PresencePromptEvent) => void) | null = null;
  let clearCallback: ((event: PresenceClearEvent) => void) | null = null;
  const mockUnsubscribePrompt = vi.fn();
  const mockUnsubscribeClear = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    promptCallback = null;
    clearCallback = null;
    mockUnsubscribePrompt.mockClear();
    mockUnsubscribeClear.mockClear();

    window.multissh = {
      ...(window.multissh || {}),
      onPresencePrompt: vi.fn((cb) => {
        promptCallback = cb;
        return mockUnsubscribePrompt;
      }),
      onPresenceClear: vi.fn((cb) => {
        clearCallback = cb;
        return mockUnsubscribeClear;
      }),
    } as any;
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders nothing when there are no active prompts', () => {
    render(<TouchPresenceBanner />);
    expect(screen.queryByTestId('touch-presence-banner')).not.toBeInTheDocument();
  });

  it('displays banner when onPresencePrompt is received', () => {
    render(<TouchPresenceBanner />);

    act(() => {
      promptCallback!({
        id: 'presence-1',
        sessionId: 'session-123',
        message: 'Touch your security key to connect',
      });
    });

    expect(screen.getByTestId('touch-presence-banner')).toBeInTheDocument();
    expect(within(screen.getByTestId('touch-presence-banner')).getByText('Touch your security key to connect')).toBeInTheDocument();
  });

  // A live region inserted together with its text is announced unreliably: the polite region exists before the
  // prompt, empty, and only its text changes.
  it('keeps one polite live region mounted, empty until a prompt arrives, and clears it afterwards', () => {
    render(<TouchPresenceBanner />);
    const region = screen.getByTestId('touch-presence-announcer');
    expect(region).toHaveAttribute('role', 'status');
    expect(region).toBeEmptyDOMElement();

    act(() => {
      promptCallback!({ id: 'presence-1', sessionId: 'session-123', message: 'Touch your security key to connect' });
    });
    expect(screen.getByTestId('touch-presence-announcer')).toBe(region);
    expect(region).toHaveTextContent('Touch your security key to connect');
    // The visible banner is not a second live region (it would be announced twice)
    expect(screen.getByTestId('touch-presence-banner')).not.toHaveAttribute('role');

    act(() => {
      clearCallback!({ id: 'presence-1' });
    });
    expect(region).toBeEmptyDOMElement();
  });

  it('clears banner when onPresenceClear is received with matching id', () => {
    render(<TouchPresenceBanner />);

    act(() => {
      promptCallback!({
        id: 'presence-1',
        sessionId: 'session-123',
        message: 'Touch your security key to connect',
      });
    });
    expect(screen.getByTestId('touch-presence-banner')).toBeInTheDocument();

    act(() => {
      clearCallback!({ id: 'presence-1' });
    });
    expect(screen.queryByTestId('touch-presence-banner')).not.toBeInTheDocument();
  });

  it('clears banner when onPresenceClear is received with matching sessionId', () => {
    render(<TouchPresenceBanner />);

    act(() => {
      promptCallback!({
        id: 'presence-1',
        sessionId: 'session-123',
        message: 'Touch your security key to connect',
      });
    });
    expect(screen.getByTestId('touch-presence-banner')).toBeInTheDocument();

    // PTY data arrives or session ends, emitting clear with only sessionId
    act(() => {
      clearCallback!({ sessionId: 'session-123' });
    });
    expect(screen.queryByTestId('touch-presence-banner')).not.toBeInTheDocument();
  });

  it('does not clear prompt if neither id nor sessionId match', () => {
    render(<TouchPresenceBanner />);

    act(() => {
      promptCallback!({
        id: 'presence-1',
        sessionId: 'session-123',
        message: 'Touch your security key to connect',
      });
    });

    act(() => {
      clearCallback!({ sessionId: 'other-session' });
    });
    expect(screen.getByTestId('touch-presence-banner')).toBeInTheDocument();
  });

  it('auto-clears banner after fallback timeout of 4000ms', () => {
    render(<TouchPresenceBanner />);

    act(() => {
      promptCallback!({
        id: 'presence-1',
        message: 'Touch your security key to connect',
      });
    });
    expect(screen.getByTestId('touch-presence-banner')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3999);
    });
    expect(screen.getByTestId('touch-presence-banner')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByTestId('touch-presence-banner')).not.toBeInTheDocument();
  });

  it('a repeated prompt with the same id resets the fallback timeout instead of letting the original one still fire', () => {
    // Regression found via real-world use: a long-running operation (e.g. Team Vault's PIN entry
    // taking the user longer than 4s before the real touch moment) re-sends the same prompt id to
    // keep the banner alive, but the ORIGINAL setTimeout from the first send would still fire and
    // remove it right on schedule, regardless of the refresh — the banner vanished well before
    // the touch was actually needed.
    render(<TouchPresenceBanner />);

    act(() => {
      promptCallback!({ id: 'presence-1', message: 'Touch your security key to connect' });
    });
    expect(screen.getByTestId('touch-presence-banner')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    // Refreshed before the original 4000ms would have elapsed.
    act(() => {
      promptCallback!({ id: 'presence-1', message: 'Touch your security key to connect' });
    });

    act(() => {
      vi.advanceTimersByTime(1500); // 4500ms since the first send, but only 1500ms since the refresh
    });
    expect(screen.getByTestId('touch-presence-banner')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2500); // 4000ms since the refresh
    });
    expect(screen.queryByTestId('touch-presence-banner')).not.toBeInTheDocument();
  });

  it('unsubscribes on unmount', () => {
    const { unmount } = render(<TouchPresenceBanner />);
    unmount();
    expect(mockUnsubscribePrompt).toHaveBeenCalled();
    expect(mockUnsubscribeClear).toHaveBeenCalled();
  });
});
