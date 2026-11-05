// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TerminalPortPill } from '../../src/renderer/src/components/TerminalPortPill';

describe('TerminalPortPill', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders nothing when ports array is empty', () => {
    const { container } = render(
      <TerminalPortPill
        ports={[]}
        isRemote={true}
        onForwardAndOpen={vi.fn()}
        onDismiss={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders port pill with Forward & Open for remote sessions', () => {
    render(
      <TerminalPortPill
        ports={[{ port: 8080, protocol: 'http', matchedText: 'http://localhost:8080' }]}
        isRemote={true}
        onForwardAndOpen={vi.fn()}
        onDismiss={vi.fn()}
      />
    );

    expect(screen.getByText('8080')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Forward & Open/i })).toBeInTheDocument();
  });

  it('renders port pill with Open in Browser for local sessions', () => {
    render(
      <TerminalPortPill
        ports={[{ port: 3000, protocol: 'http', matchedText: 'http://localhost:3000' }]}
        isRemote={false}
        onForwardAndOpen={vi.fn()}
        onDismiss={vi.fn()}
      />
    );

    expect(screen.getByText('3000')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open in Browser/i })).toBeInTheDocument();
  });

  it('calls onForwardAndOpen when action button is clicked', async () => {
    const onForward = vi.fn().mockResolvedValue(undefined);
    render(
      <TerminalPortPill
        ports={[{ port: 5173, protocol: 'http', matchedText: 'http://localhost:5173' }]}
        isRemote={true}
        onForwardAndOpen={onForward}
        onDismiss={vi.fn()}
      />
    );

    const button = screen.getByRole('button', { name: /Forward & Open/i });
    await act(async () => {
      fireEvent.click(button);
    });

    expect(onForward).toHaveBeenCalledWith(5173, 'http');
  });

  it('calls onDismiss when close button is clicked', () => {
    const onDismiss = vi.fn();
    render(
      <TerminalPortPill
        ports={[{ port: 8000, protocol: 'http', matchedText: 'http://localhost:8000' }]}
        isRemote={true}
        onForwardAndOpen={vi.fn()}
        onDismiss={onDismiss}
      />
    );

    const closeBtn = screen.getByRole('button', { name: /Dismiss port 8000/i });
    fireEvent.click(closeBtn);

    expect(onDismiss).toHaveBeenCalledWith(8000);
  });

  it('displays error message if onForwardAndOpen fails', async () => {
    const onForward = vi.fn().mockRejectedValue(new Error('Port 8080 already bound'));
    render(
      <TerminalPortPill
        ports={[{ port: 8080, protocol: 'http', matchedText: 'http://localhost:8080' }]}
        isRemote={true}
        onForwardAndOpen={onForward}
        onDismiss={vi.fn()}
      />
    );

    const button = screen.getByRole('button', { name: /Forward & Open/i });
    await act(async () => {
      fireEvent.click(button);
    });

    expect(screen.getByText('Port 8080 already bound')).toBeInTheDocument();
  });

  it('offers a retry after a failure', async () => {
    const onForward = vi.fn().mockRejectedValueOnce(new Error('Tunnel timed out')).mockResolvedValueOnce(undefined);
    render(
      <TerminalPortPill
        ports={[{ port: 8080, protocol: 'http', matchedText: 'http://localhost:8080' }]}
        isRemote={true}
        onForwardAndOpen={onForward}
        onDismiss={vi.fn()}
      />
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Forward & Open/i }));
    });
    expect(screen.getByText('Tunnel timed out')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
    });
    expect(onForward).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Tunnel timed out')).not.toBeInTheDocument();
  });
});
