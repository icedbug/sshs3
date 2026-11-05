// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render as rtlRender, screen, cleanup, act, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { K8sLogView } from '../../src/renderer/src/components/K8sLogView';
import { ConfirmProvider } from '../../src/renderer/src/components/ConfirmDialog';
import type { K8sTerminalTarget, K8sPodNode } from '../../src/shared/types/kubernetes';

// The log view asks for confirmations through the app's ConfirmDialog.
function render(ui: React.ReactElement) {
  const result = rtlRender(<ConfirmProvider>{ui}</ConfirmProvider>);
  return {
    ...result,
    rerender: (next: React.ReactElement) => result.rerender(<ConfirmProvider>{next}</ConfirmProvider>),
  };
}

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

const TARGET: K8sTerminalTarget = {
  contextName: 'minikube',
  namespace: 'default',
  podName: 'backend-pod-7798fd6599-abc11',
  containerName: 'api',
};

describe('K8sLogView', () => {
  let logDataCb: ((sessionId: string, data: string) => void) | null = null;
  let logEndCb: ((sessionId: string) => void) | null = null;
  const mockUnsubData = vi.fn();
  const mockUnsubEnd = vi.fn();
  const mockK8sLogStart = vi.fn();
  const mockK8sLogStop = vi.fn();
  const mockK8sListPods = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    logDataCb = null;
    logEndCb = null;
    mockUnsubData.mockClear();
    mockUnsubEnd.mockClear();
    mockK8sLogStart.mockReset().mockResolvedValue({ sessionId: 'log-sess-1' });
    mockK8sLogStop.mockReset().mockResolvedValue(undefined);
    mockK8sListPods.mockReset().mockResolvedValue([]);

    window.multissh = {
      ...(window.multissh || {}),
      k8sLogStart: mockK8sLogStart,
      k8sLogStop: mockK8sLogStop,
      k8sListPods: mockK8sListPods,
      onK8sLogData: vi.fn((cb) => {
        logDataCb = cb;
        return mockUnsubData;
      }),
      onK8sLogEnd: vi.fn((cb) => {
        logEndCb = cb;
        return mockUnsubEnd;
      }),
    } as any;
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('asks before restarting the pod and only deletes it once confirmed', async () => {
    const k8sDeletePod = vi.fn().mockResolvedValue(undefined);
    window.multissh.k8sDeletePod = k8sDeletePod;
    await act(async () => {
      render(<K8sLogView target={TARGET} />);
      await Promise.resolve();
    });

    const restart = () => fireEvent.click(screen.getByRole('button', { name: 'Restart pod' }));
    const settle = () =>
      act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

    restart();
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent(`Restart pod "${TARGET.podName}" in namespace "default"?`);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await settle();
    expect(k8sDeletePod).not.toHaveBeenCalled();

    restart();
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Restart pod' }));
    await settle();
    expect(k8sDeletePod).toHaveBeenCalledWith('minikube', 'default', TARGET.podName);
  });

  it('starts follow log stream on mount with tailLines: 1000', async () => {
    await act(async () => {
      render(<K8sLogView target={TARGET} />);
      await Promise.resolve();
    });

    expect(mockK8sLogStart).toHaveBeenCalledWith(TARGET, {
      tailLines: 1000,
      timestamps: false,
      previous: false,
    });
  });

  it('streams incoming log data chunks to terminal for the active session', async () => {
    await act(async () => {
      render(<K8sLogView target={TARGET} />);
      await Promise.resolve();
    });

    expect(logDataCb).toBeDefined();
    await act(async () => {
      logDataCb?.('log-sess-1', 'Server started on port 8080\n');
      logDataCb?.('different-sess', 'Ignore mismatched session data\n');
    });

    expect(screen.getByTestId('k8s-log-container')).toBeInTheDocument();
  });

  it('toggles timestamps and reconnects with timestamps: true', async () => {
    await act(async () => {
      render(<K8sLogView target={TARGET} />);
      await Promise.resolve();
    });

    const tsBtn = screen.getByTestId('toggle-timestamps');
    await act(async () => {
      fireEvent.click(tsBtn);
      await Promise.resolve();
    });

    expect(mockK8sLogStart).toHaveBeenLastCalledWith(TARGET, {
      tailLines: 1000,
      timestamps: true,
      previous: false,
    });
  });

  // M10: two reconnects in a row (e.g. toggling timestamps twice) start two streams; the one that finishes
  // starting last must not replace, and so leak, the one the user is looking at.
  it('stops a stream whose start finished after a newer reconnect had begun', async () => {
    await act(async () => {
      render(<K8sLogView target={TARGET} />);
      await Promise.resolve();
    });
    const finish: Array<(value: { sessionId: string }) => void> = [];
    mockK8sLogStart.mockImplementation(() => new Promise((resolve) => finish.push(resolve)));
    mockK8sLogStop.mockClear();

    await act(async () => {
      fireEvent.click(screen.getByTestId('toggle-timestamps'));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('toggle-timestamps'));
      await Promise.resolve();
    });
    expect(finish).toHaveLength(2);

    await act(async () => {
      finish[1]({ sessionId: 'newest' });
      await Promise.resolve();
    });
    await act(async () => {
      finish[0]({ sessionId: 'older' });
      await Promise.resolve();
    });

    expect(mockK8sLogStop).toHaveBeenCalledWith('older');
    expect(mockK8sLogStop).not.toHaveBeenCalledWith('newest');
  });

  it('toggles previous container logs and reconnects with previous: true', async () => {
    await act(async () => {
      render(<K8sLogView target={TARGET} />);
      await Promise.resolve();
    });

    const prevBtn = screen.getByTestId('toggle-previous-logs');
    await act(async () => {
      fireEvent.click(prevBtn);
      await Promise.resolve();
    });

    expect(mockK8sLogStart).toHaveBeenLastCalledWith(TARGET, {
      tailLines: 1000,
      timestamps: false,
      previous: true,
    });
  });

  it('enters reconnecting state and shows banner when stream ends', async () => {
    await act(async () => {
      render(<K8sLogView target={TARGET} />);
      await Promise.resolve();
    });

    expect(screen.queryByTestId('reconnecting-banner')).not.toBeInTheDocument();

    // Pod restarts / log stream ends
    await act(async () => {
      logEndCb?.('log-sess-1');
    });

    expect(screen.getByTestId('reconnecting-banner')).toBeInTheDocument();
    expect(screen.getByTestId('reconnect-now-button')).toBeInTheDocument();
    expect(screen.getByTestId('cancel-reconnect-button')).toBeInTheDocument();
  });

  it('reconnects automatically after timer countdown expires', async () => {
    mockK8sLogStart
      .mockResolvedValueOnce({ sessionId: 'log-sess-1' })
      .mockResolvedValueOnce({ sessionId: 'log-sess-2' });

    await act(async () => {
      render(<K8sLogView target={TARGET} />);
      await Promise.resolve();
    });

    // End stream
    await act(async () => {
      logEndCb?.('log-sess-1');
    });

    expect(screen.getByTestId('reconnecting-banner')).toBeInTheDocument();

    // Advance 1s to trigger retry
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });

    expect(mockK8sLogStart).toHaveBeenCalledTimes(2);
    expect(mockK8sLogStart).toHaveBeenLastCalledWith(TARGET, {
      tailLines: 100,
      timestamps: false,
      previous: false,
    });

    // Reconnection succeeded, banner disappears
    expect(screen.queryByTestId('reconnecting-banner')).not.toBeInTheDocument();
  });

  it('triggers immediate reconnect when "Reconnect Now" is clicked', async () => {
    mockK8sLogStart
      .mockResolvedValueOnce({ sessionId: 'log-sess-1' })
      .mockResolvedValueOnce({ sessionId: 'log-sess-2' });

    await act(async () => {
      render(<K8sLogView target={TARGET} />);
      await Promise.resolve();
    });

    await act(async () => {
      logEndCb?.('log-sess-1');
    });

    const reconnectBtn = screen.getByTestId('reconnect-now-button');
    await act(async () => {
      fireEvent.click(reconnectBtn);
      await Promise.resolve();
    });

    expect(mockK8sLogStart).toHaveBeenCalledTimes(2);
    expect(mockK8sLogStart).toHaveBeenLastCalledWith(TARGET, {
      tailLines: 100,
      timestamps: false,
      previous: false,
    });
  });

  it('cancels auto-reconnect when "Cancel" button is clicked and shows ended banner', async () => {
    await act(async () => {
      render(<K8sLogView target={TARGET} />);
      await Promise.resolve();
    });

    await act(async () => {
      logEndCb?.('log-sess-1');
    });

    const cancelBtn = screen.getByTestId('cancel-reconnect-button');
    await act(async () => {
      fireEvent.click(cancelBtn);
    });

    expect(screen.queryByTestId('reconnecting-banner')).not.toBeInTheDocument();
    expect(screen.getByTestId('stream-ended-banner')).toBeInTheDocument();
    expect(screen.getByTestId('reconnect-button')).toBeInTheDocument();
  });

  it('toggles auto-reconnect via toolbar button', async () => {
    await act(async () => {
      render(<K8sLogView target={TARGET} />);
      await Promise.resolve();
    });

    const toggleBtn = screen.getByTestId('toggle-auto-reconnect');
    expect(toggleBtn).toHaveAttribute('aria-label', 'Disable auto-reconnect');

    await act(async () => {
      fireEvent.click(toggleBtn);
    });

    expect(toggleBtn).toHaveAttribute('aria-label', 'Enable auto-reconnect');

    // End stream while auto-reconnect is disabled
    await act(async () => {
      logEndCb?.('log-sess-1');
    });

    // Should go straight to ended banner
    expect(screen.queryByTestId('reconnecting-banner')).not.toBeInTheDocument();
    expect(screen.getByTestId('stream-ended-banner')).toBeInTheDocument();
  });

  it('detects replacement pod when previous pod was deleted and switches target', async () => {
    const replacementPod: K8sPodNode = {
      name: 'backend-pod-7798fd6599-new99',
      namespace: 'default',
      phase: 'Running',
      creationTimestamp: '2026-10-16T18:05:00Z',
      containers: [{ name: 'api', image: 'api:v2', ready: true, state: 'running' }],
    };

    mockK8sListPods.mockResolvedValue([replacementPod]);

    mockK8sLogStart
      .mockResolvedValueOnce({ sessionId: 'log-sess-1' })
      .mockRejectedValueOnce(new Error("Error invoking remote method 'k8s-log:start': Error: HTTP-Code: 404\nMessage: Error occurred in log request"))
      .mockResolvedValueOnce({ sessionId: 'log-sess-2' });

    await act(async () => {
      render(<K8sLogView target={TARGET} />);
      await Promise.resolve();
    });

    // Pod is deleted
    await act(async () => {
      logEndCb?.('log-sess-1');
    });

    // Advance timer to trigger reconnect
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });

    // Should have queried listPods and found the replacement pod
    expect(mockK8sListPods).toHaveBeenCalledWith('minikube', 'default');
    // Should have reconnected to the new replacement pod name!
    expect(mockK8sLogStart).toHaveBeenLastCalledWith(
      expect.objectContaining({ podName: 'backend-pod-7798fd6599-new99' }),
      expect.anything()
    );
  });

  it('toggles metrics panel when Metrics button is clicked without hiding controls', async () => {
    window.multissh.perfK8sSample = vi.fn().mockResolvedValue({
      ok: true,
      raw: {
        timestamp: '2026-10-16T18:00:00Z',
        cpuUsageNano: '100000000',
        memoryWorkingSetBytes: '52428800',
      },
    });

    await act(async () => {
      render(<K8sLogView target={TARGET} />);
      await Promise.resolve();
    });

    const metricsBtn = screen.getByTestId('toggle-metrics-button');
    expect(metricsBtn).toBeInTheDocument();

    // Toggle on
    await act(async () => {
      fireEvent.click(metricsBtn);
      await Promise.resolve();
    });

    expect(screen.getByText('Live Resource Metrics')).toBeInTheDocument();
    // The metrics button itself must still be in the document and visible!
    expect(screen.getByTestId('toggle-metrics-button')).toBeInTheDocument();

    // Toggle off
    await act(async () => {
      fireEvent.click(screen.getByTestId('toggle-metrics-button'));
      await Promise.resolve();
    });

    expect(screen.queryByText('Live Resource Metrics')).not.toBeInTheDocument();
  });

  it('handles previous logs 400 error by showing no previous instance message and Live Logs button', async () => {
    mockK8sLogStart
      .mockResolvedValueOnce({ sessionId: 'log-sess-1' })
      .mockRejectedValueOnce(new Error('HTTP-Code: 400\nMessage: Error occurred in log request'))
      .mockResolvedValueOnce({ sessionId: 'log-sess-2' });

    await act(async () => {
      render(<K8sLogView target={TARGET} />);
      await Promise.resolve();
    });

    // Click Previous logs button
    const prevBtn = screen.getByTestId('toggle-previous-logs');
    await act(async () => {
      fireEvent.click(prevBtn);
      await Promise.resolve();
    });

    // Expect ended banner with Switch to Live Logs button
    expect(screen.getByText('No previous terminated instance found')).toBeInTheDocument();
    const liveLogsBtn = screen.getByTestId('switch-to-live-logs-button');
    expect(liveLogsBtn).toBeInTheDocument();

    // Click Switch to Live Logs button
    await act(async () => {
      fireEvent.click(liveLogsBtn);
      await Promise.resolve();
    });

    // Verify it reconnected back to live logs
    expect(mockK8sLogStart).toHaveBeenLastCalledWith(TARGET, expect.objectContaining({ previous: false }));
  });

  it('cleans up on unmount by stopping active session and clearing timers', async () => {
    let unmountFn!: () => void;
    await act(async () => {
      const { unmount } = render(<K8sLogView target={TARGET} />);
      unmountFn = unmount;
      await Promise.resolve();
    });

    await act(async () => {
      unmountFn();
    });

    expect(mockK8sLogStop).toHaveBeenCalledWith('log-sess-1');
    expect(mockUnsubData).toHaveBeenCalled();
    expect(mockUnsubEnd).toHaveBeenCalled();
  });
});
