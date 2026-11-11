// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryProposals } from '../../src/renderer/src/components/AiHub/MemoryProposals';
import type { HubSnapshot, MemoryProposal } from '../../src/shared/types/aiHub';

afterEach(cleanup);

const proposal = (extra: Partial<MemoryProposal> = {}): MemoryProposal => ({
  id: 'p1',
  op: 'add',
  kind: 'memory',
  scope: 'server:prod-api-01',
  title: 'SSE timeout',
  text: 'Keep proxy_read_timeout at 120s.',
  evidence: 'nginx -t → exit 0',
  sourceId: 'task:t1',
  sourceTitle: 'Session: SSE drops',
  createdAt: 1,
  ...extra,
});
const hub = (extra: Partial<HubSnapshot>): HubSnapshot => ({ memories: [], ...extra }) as unknown as HubSnapshot;

describe('MemoryProposals', () => {
  it('shows what a proposal says, where it applies, what it rests on, and what an update replaces', () => {
    render(
      <MemoryProposals
        act={vi.fn().mockResolvedValue(undefined)}
        hub={hub({
          memoryProposals: [
            proposal(),
            proposal({ id: 'p2', op: 'update', targetId: 'm1', scope: 'workspace', previousText: 'max_connections is 150' }),
          ],
        })}
      />
    );
    const first = within(screen.getByTestId('memory-proposal-p1'));
    expect(first.getByText('New memory')).toBeInTheDocument();
    expect(first.getByText('Applies to server prod-api-01')).toBeInTheDocument();
    expect(first.getByText('nginx -t → exit 0')).toBeInTheDocument();
    expect(first.getByText(/from Session: SSE drops/)).toBeInTheDocument();
    expect(first.queryByTestId('memory-proposal-previous')).not.toBeInTheDocument();
    const second = within(screen.getByTestId('memory-proposal-p2'));
    expect(second.getByText('Update an existing memory')).toBeInTheDocument();
    expect(second.getByTestId('memory-proposal-previous')).toHaveTextContent('max_connections is 150');
  });

  it('accepts with the corrected text and rejects by id', async () => {
    const act = vi.fn().mockResolvedValue(undefined);
    render(<MemoryProposals act={act} hub={hub({ memoryProposals: [proposal()] })} />);
    fireEvent.change(screen.getByLabelText('Text'), { target: { value: '  Keep it at 180s.  ' } });
    fireEvent.click(screen.getByText('Accept and share with the team'));
    expect(act).toHaveBeenLastCalledWith({
      action: 'memory-proposal-accept',
      id: 'p1',
      title: 'SSE timeout',
      text: 'Keep it at 180s.',
    });
    // Both buttons wait for the request in flight.
    expect(screen.getByText('Reject')).toBeDisabled();
    await waitFor(() => expect(screen.getByText('Reject')).not.toBeDisabled());
    fireEvent.click(screen.getByText('Reject'));
    expect(act).toHaveBeenLastCalledWith({ action: 'memory-proposal-reject', id: 'p1' });
  });

  it('cannot accept an emptied proposal', () => {
    render(<MemoryProposals act={vi.fn()} hub={hub({ memoryProposals: [proposal()] })} />);
    fireEvent.change(screen.getByLabelText('Text'), { target: { value: '   ' } });
    expect(screen.getByText('Accept and share with the team')).toBeDisabled();
  });

  it('reports the latest reading: nothing new, a count, or why it failed; and is busy while one runs', () => {
    const act = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <MemoryProposals act={act} hub={hub({ lastMemoryDistill: { at: 1, sourceTitle: 'Session: x', proposed: 0 } })} />
    );
    expect(screen.getByTestId('memory-distill-status')).toHaveTextContent('found nothing new to remember');
    rerender(
      <MemoryProposals
        act={act}
        hub={hub({ lastMemoryDistill: { at: 1, sourceTitle: 'Session: x', proposed: 0, error: 'Anthropic API (401)' } })}
      />
    );
    expect(screen.getByTestId('memory-distill-status')).toHaveTextContent('failed: Anthropic API (401)');
    rerender(<MemoryProposals act={act} hub={hub({ memoryDistillRunning: true })} />);
    expect(screen.getByTestId('memory-distill-activity-btn')).toBeDisabled();
    rerender(<MemoryProposals act={act} hub={hub({})} />);
    fireEvent.click(screen.getByTestId('memory-distill-activity-btn'));
    expect(act).toHaveBeenCalledWith({ action: 'memory-distill-activity' });
  });
});
