// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { LocalPerfBar } from '../../src/renderer/src/components/LocalPerfBar';
import { PerfBar } from '../../src/renderer/src/components/PerfBar';
import { resetLocalPerfHistory, usePerfSamples } from '../../src/renderer/src/lib/usePerfSamples';
import type { PerfSshRaw } from '../../src/shared/types/perf';

const raw = (t: number): PerfSshRaw => ({
  t,
  cpuTotal: 1000,
  cpuIdle: 800,
  cores: 4,
  load: [1, 0.5, 0.25],
  memTotalKb: 1000,
  memAvailKb: 250,
  swapTotalKb: 100,
  swapFreeKb: 50,
  diskUsedPct: 90,
  netRxBytes: 0,
  netTxBytes: 0,
  uptimeSec: 3700,
});

const Probe: React.FC = () => {
  const state = usePerfSamples({ local: true, active: true });
  return <span data-testid="count">{state.history.length}</span>;
};

describe('LocalPerfBar', () => {
  beforeEach(() => {
    resetLocalPerfHistory();
    window.multissh = { perfLocalSample: vi.fn().mockImplementation(async () => ({ ok: true, raw: raw(Date.now()) })) } as any;
  });
  afterEach(cleanup);

  it('labels itself as the local machine', async () => {
    render(<LocalPerfBar layout="text" items={['mem']} active />);
    expect(screen.getByText('Local')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('perf-bar')).toHaveTextContent('RAM 75%'));
  });

  it('embedded bar has focus and hover styling instead of a surface background', async () => {
    render(<LocalPerfBar layout="text" items={['mem']} active />);
    const bar = await screen.findByRole('button', { name: /Performance metrics/ });
    expect(bar.className).toContain('focus-visible:outline');
    expect(bar.className).not.toContain('bg-app-surface-subtle');
  });

  it('keeps the local history when the sampler moves to another component', async () => {
    const first = render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'));
    first.unmount();
    render(<Probe />);
    // Seeded from the shared history on mount, before the new sampler has produced anything.
    expect(Number(screen.getByTestId('count').textContent)).toBeGreaterThanOrEqual(1);
  });

  it('does not seed a non-embedded bar differently', () => {
    render(<PerfBar kind="ssh" state={{ history: [], status: 'loading' }} layout="text" items={['cpu']} />);
    expect(screen.getByTestId('perf-bar').className).toContain('bg-app-surface-subtle');
  });
});
