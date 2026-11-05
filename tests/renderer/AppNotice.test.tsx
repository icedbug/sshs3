// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { AppNotice, APP_NOTICE_TIMEOUT_MS } from '../../src/renderer/src/components/AppNotice';

describe('AppNotice', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders nothing without a message', () => {
    const { container } = render(<AppNotice message={null} onDismiss={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('announces the message politely, as a status', () => {
    render(<AppNotice message="1 of 2 tunnels could not start." onDismiss={vi.fn()} />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('1 of 2 tunnels could not start.');
    expect(status).toHaveAttribute('aria-live', 'polite');
  });

  it('is dismissed with its button', () => {
    const onDismiss = vi.fn();
    render(<AppNotice message="hello" onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('dismisses itself after a while', () => {
    const onDismiss = vi.fn();
    render(<AppNotice message="hello" onDismiss={onDismiss} />);
    act(() => {
      vi.advanceTimersByTime(APP_NOTICE_TIMEOUT_MS - 1);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('starts the wait over for a new message', () => {
    const onDismiss = vi.fn();
    const { rerender } = render(<AppNotice message="first" onDismiss={onDismiss} />);
    act(() => {
      vi.advanceTimersByTime(APP_NOTICE_TIMEOUT_MS - 1000);
    });
    rerender(<AppNotice message="second" onDismiss={onDismiss} />);
    act(() => {
      vi.advanceTimersByTime(APP_NOTICE_TIMEOUT_MS - 1000);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does not run a timer once the message is gone', () => {
    const onDismiss = vi.fn();
    const { rerender } = render(<AppNotice message="hello" onDismiss={onDismiss} />);
    rerender(<AppNotice message={null} onDismiss={onDismiss} />);
    act(() => {
      vi.advanceTimersByTime(APP_NOTICE_TIMEOUT_MS * 2);
    });
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
