// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { WorkspaceChat } from '../../src/renderer/src/components/AiHub/WorkspaceChat';
import type { AgentTask, HubSnapshot, WorkspaceActivityEvent } from '../../src/shared/types/aiHub';

const event = (id: string, extra: Partial<WorkspaceActivityEvent>): WorkspaceActivityEvent => ({
  id,
  actor: 'erik',
  summary: id,
  kind: 'chat',
  targetLabel: '#general',
  at: 1_700_000_000_000,
  ...extra,
});

function hub(extra: Partial<HubSnapshot> = {}): HubSnapshot {
  return {
    config: { enabled: true },
    preferences: {},
    runtime: { bundled: true },
    sessions: [],
    tasks: [],
    memories: [],
    schedules: [],
    inventory: [],
    activityLog: [],
    ...extra,
  } as unknown as HubSnapshot;
}

afterEach(cleanup);

describe('WorkspaceChat', () => {
  it('shows only chat messages of its channel, oldest first, and marks the assistant with what it answers', () => {
    render(
      <WorkspaceChat
        request={vi.fn()}
        hub={hub({
          activityLog: [
            event('a2', { actor: 'AI', actorKind: 'ai', summary: '**13:48** Erik', at: 3, replyTo: 'q1' }),
            event('q1', { actor: 'sara', summary: '@ai what changed?', at: 2 }),
            event('n1', { kind: 'service-action', summary: 'restarted postgres', at: 1 }),
            event('o1', { channel: 'cluster:prod', summary: 'other channel', at: 1 }),
          ],
        })}
      />
    );
    expect(screen.queryByText('restarted postgres')).not.toBeInTheDocument();
    expect(screen.queryByText('other channel')).not.toBeInTheDocument();
    const articles = screen.getAllByRole('article');
    expect(articles).toHaveLength(2);
    expect(articles[0]).toHaveTextContent('sara');
    expect(articles[1]).toHaveTextContent('Assistant');
    expect(articles[1]).toHaveTextContent('Reply to sara: @ai what changed?');
    // The assistant's markdown is rendered, not shown as source.
    expect(articles[1].querySelector('strong')).toHaveTextContent('13:48');
  });

  it('sends the draft on Enter, clears it, and keeps it with the error when the hub refuses', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('A chat message can be at most 4000 characters'));
    render(<WorkspaceChat request={request} hub={hub()} />);
    const input = screen.getByTestId('workspace-chat-input') as HTMLTextAreaElement;

    fireEvent.change(input, { target: { value: 'hello team' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(input.value).toBe(''));
    expect(request).toHaveBeenCalledWith({ action: 'chat-post', text: 'hello team', channel: 'general' });

    fireEvent.change(input, { target: { value: 'second' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByRole('alert')).toHaveTextContent('at most 4000 characters');
    expect(input.value).toBe('second');
  });

  it('does not send on Shift+Enter or an empty draft', () => {
    const request = vi.fn();
    render(<WorkspaceChat request={request} hub={hub()} />);
    const input = screen.getByTestId('workspace-chat-input');
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.change(input, { target: { value: 'line one' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(request).not.toHaveBeenCalled();
    expect(screen.getByTestId('workspace-chat-send')).not.toBeDisabled();
  });

  it('adds the @ai mention once and warns when AI is off', () => {
    render(<WorkspaceChat request={vi.fn()} hub={hub({ config: { enabled: false } as HubSnapshot['config'] })} />);
    const input = screen.getByTestId('workspace-chat-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'who restarted nginx?' } });
    fireEvent.click(screen.getByTestId('workspace-chat-mention-ai'));
    fireEvent.click(screen.getByTestId('workspace-chat-mention-ai'));
    expect(input.value).toBe('@ai who restarted nginx?');
    expect(screen.getByText(/AI is not enabled/)).toBeInTheDocument();
  });

  it('says where messages go: shared when the team sync is on, this computer only otherwise', () => {
    const { rerender } = render(<WorkspaceChat request={vi.fn()} hub={hub()} />);
    expect(screen.getByText(/kept here only/)).toBeInTheDocument();
    rerender(
      <WorkspaceChat
        request={vi.fn()}
        hub={hub({ s3Workspace: { enabled: true, configured: true } as HubSnapshot['s3Workspace'] })}
      />
    );
    expect(screen.getByText(/Shared with the team/)).toBeInTheDocument();
    // The caller's knowledge of another transport wins over the bucket status.
    rerender(<WorkspaceChat request={vi.fn()} hub={hub()} teamShared />);
    expect(screen.getByText(/Shared with the team/)).toBeInTheDocument();
  });

  it('shows that the assistant is answering only while its run for a message of this channel is active', () => {
    const task = (status: AgentTask['status'], chatMessageId: string): AgentTask =>
      ({ id: `t-${chatMessageId}`, status, chatMessageId }) as AgentTask;
    const log = [event('q1', { summary: '@ai hi' })];
    const { rerender } = render(
      <WorkspaceChat request={vi.fn()} hub={hub({ activityLog: log, tasks: [task('running', 'q1')] })} />
    );
    expect(screen.getByTestId('workspace-chat-answering')).toBeInTheDocument();
    rerender(<WorkspaceChat request={vi.fn()} hub={hub({ activityLog: log, tasks: [task('completed', 'q1')] })} />);
    expect(screen.queryByTestId('workspace-chat-answering')).not.toBeInTheDocument();
    rerender(<WorkspaceChat request={vi.fn()} hub={hub({ activityLog: log, tasks: [task('running', 'elsewhere')] })} />);
    expect(screen.queryByTestId('workspace-chat-answering')).not.toBeInTheDocument();
  });
});
