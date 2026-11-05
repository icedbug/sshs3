// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render as rtlRender, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SettingsModal } from '../../src/renderer/src/components/SettingsModal/SettingsModal';
import { ConfirmProvider } from '../../src/renderer/src/components/ConfirmDialog';
import { DEFAULT_SETTINGS } from '../../src/shared/types/settings';

// Asks for confirmations through the app's ConfirmDialog, which needs its provider.
function render(ui: React.ReactElement) {
  const result = rtlRender(<ConfirmProvider>{ui}</ConfirmProvider>);
  return {
    ...result,
    rerender: (next: React.ReactElement) => result.rerender(<ConfirmProvider>{next}</ConfirmProvider>),
  };
}

describe('SettingsModal performance bar section', () => {
  afterEach(cleanup);

  const open = (onSave = vi.fn()) => {
    render(<SettingsModal open currentSettings={DEFAULT_SETTINGS} onSave={onSave} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: /Performance/ }));
    return onSave;
  };

  it('is off by default and hides the detail controls', () => {
    open();
    expect(screen.getByTestId('perf-enabled')).not.toBeChecked();
    expect(screen.queryByLabelText('Layout')).toBeNull();
  });

  it('saves master switch, layout, interval and selected metrics', () => {
    const onSave = open();
    fireEvent.click(screen.getByTestId('perf-enabled'));
    fireEvent.change(screen.getByLabelText('Layout'), { target: { value: 'sparklines' } });
    fireEvent.change(screen.getByLabelText('Update interval'), { target: { value: '10' } });
    fireEvent.click(screen.getByTestId('perf-item-net'));
    fireEvent.click(screen.getByTestId('perf-item-load')); // default on -> off
    fireEvent.click(screen.getByText('Save Settings'));

    const saved = onSave.mock.calls[0][0];
    expect(saved.perfMetricsEnabled).toBe(true);
    expect(saved.perfMetricsLayout).toBe('sparklines');
    expect(saved.perfMetricsIntervalSec).toBe(10);
    expect(saved.perfMetricsItems).toEqual(['cpu', 'mem', 'net']);
  });

  it('lives in its own category, not under Terminal', () => {
    render(<SettingsModal open currentSettings={DEFAULT_SETTINGS} onSave={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: /^Terminal/ }));
    expect(screen.queryByTestId('perf-enabled')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /Performance/ }));
    expect(screen.getByTestId('perf-enabled')).toBeInTheDocument();
  });

  it('offers Kubernetes-only metrics in a separate group', () => {
    open();
    fireEvent.click(screen.getByTestId('perf-enabled'));
    expect(screen.getByTestId('perf-k8s-item-resources')).toBeInTheDocument();
    expect(screen.queryByTestId('perf-item-resources')).toBeNull();
    expect(screen.getByTestId('perf-item-iowait')).toBeInTheDocument();
  });
});
