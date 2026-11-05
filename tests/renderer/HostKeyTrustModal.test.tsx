// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { HostKeyTrustModal } from '../../src/renderer/src/components/HostKeyTrustModal';
import type { HostKeyPromptEvent } from '../../src/shared/types/ipc';

describe('HostKeyTrustModal Component', () => {
  let promptCallback: ((event: HostKeyPromptEvent) => void) | null = null;
  const mockUnsubscribe = vi.fn();
  const mockRespond = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    promptCallback = null;
    mockUnsubscribe.mockClear();
    mockRespond.mockClear();

    window.multissh = {
      ...(window.multissh || {}),
      onHostKeyPrompt: vi.fn((cb) => {
        promptCallback = cb;
        return mockUnsubscribe;
      }),
      respondHostKeyPrompt: mockRespond,
    } as any;
  });

  afterEach(() => {
    cleanup();
  });

  it('renders nothing when there is no active prompt', () => {
    render(<HostKeyTrustModal />);
    expect(screen.queryByTestId('hostkey-trust-modal')).not.toBeInTheDocument();
  });

  it('shows an informational dialog for an unknown host', () => {
    render(<HostKeyTrustModal />);

    act(() => {
      promptCallback!({
        id: 'hk-1',
        host: 'new.example.com',
        port: 22,
        keyType: 'ssh-ed25519',
        fingerprint: 'SHA256:abc123',
        status: 'unknown',
      });
    });

    expect(screen.getByTestId('hostkey-trust-modal')).toBeInTheDocument();
    expect(screen.getByText('Unknown Host')).toBeInTheDocument();
    expect(screen.getByText(/ssh-ed25519/)).toBeInTheDocument();
    expect(screen.getByText(/SHA256:abc123/)).toBeInTheDocument();
  });

  it('shows a warning-styled dialog for a mismatched (changed) host key', () => {
    render(<HostKeyTrustModal />);

    act(() => {
      promptCallback!({
        id: 'hk-2',
        host: 'changed.example.com',
        port: 22,
        keyType: 'ssh-rsa',
        fingerprint: 'SHA256:def456',
        status: 'mismatch',
      });
    });

    expect(screen.getByText('Host Key Changed!')).toBeInTheDocument();
    expect(screen.getByTestId('hostkey-trust-accept')).toHaveTextContent('Replace Key');
  });

  it('accepting calls respondHostKeyPrompt with trust=true and closes the modal', async () => {
    render(<HostKeyTrustModal />);

    act(() => {
      promptCallback!({
        id: 'hk-3',
        host: 'accept.example.com',
        port: 2222,
        keyType: 'ssh-ed25519',
        fingerprint: 'SHA256:ghi789',
        status: 'unknown',
      });
    });

    fireEvent.click(screen.getByTestId('hostkey-trust-accept'));

    expect(mockRespond).toHaveBeenCalledWith('hk-3', true);
    expect(screen.queryByTestId('hostkey-trust-modal')).not.toBeInTheDocument();
  });

  it('canceling or pressing Escape calls respondHostKeyPrompt with trust=false', () => {
    render(<HostKeyTrustModal />);

    act(() => {
      promptCallback!({
        id: 'hk-4',
        host: 'reject.example.com',
        port: 22,
        keyType: 'ssh-ed25519',
        fingerprint: 'SHA256:jkl012',
        status: 'unknown',
      });
    });

    fireEvent.click(screen.getByTestId('hostkey-trust-cancel'));
    expect(mockRespond).toHaveBeenCalledWith('hk-4', false);
    expect(screen.queryByTestId('hostkey-trust-modal')).not.toBeInTheDocument();

    act(() => {
      promptCallback!({
        id: 'hk-5',
        host: 'reject2.example.com',
        port: 22,
        keyType: 'ssh-ed25519',
        fingerprint: 'SHA256:mno345',
        status: 'unknown',
      });
    });
    fireEvent.keyDown(screen.getByTestId('hostkey-trust-modal'), { key: 'Escape', code: 'Escape' });
    expect(mockRespond).toHaveBeenCalledWith('hk-5', false);
  });

  // M11 (code review): this modal often appears while focus is still inside
  // a terminal (xterm's hidden textarea) rather than inside the dialog, so
  // Escape must be caught window-wide, not only when dispatched at (or
  // bubbled up from) the dialog element itself.
  it('responds to Escape even when it is dispatched on document.body, not the dialog (M11)', () => {
    render(<HostKeyTrustModal />);

    act(() => {
      promptCallback!({
        id: 'hk-6',
        host: 'elsewhere.example.com',
        port: 22,
        keyType: 'ssh-ed25519',
        fingerprint: 'SHA256:pqr678',
        status: 'unknown',
      });
    });

    fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' });
    expect(mockRespond).toHaveBeenCalledWith('hk-6', false);
  });

  // The safe action keeps the default focus even while focus was in a terminal, and Tab never reaches the
  // page behind the prompt.
  it('takes focus from the element that had it, defaults to Cancel and keeps Tab inside the dialog', () => {
    const terminal = document.createElement('textarea');
    document.body.appendChild(terminal);
    terminal.focus();
    render(<HostKeyTrustModal />);

    act(() => {
      promptCallback!({
        id: 'hk-7',
        host: 'focus.example.com',
        port: 22,
        keyType: 'ssh-ed25519',
        fingerprint: 'SHA256:fff000',
        status: 'mismatch',
      });
    });

    const cancel = screen.getByTestId('hostkey-trust-cancel');
    const accept = screen.getByTestId('hostkey-trust-accept');
    expect(cancel).toHaveFocus();

    accept.focus();
    fireEvent.keyDown(accept, { key: 'Tab' });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
    expect(accept).toHaveFocus();
    terminal.remove();
  });

  it('cleans up host key prompt listener on unmount', () => {
    const { unmount } = render(<HostKeyTrustModal />);
    unmount();
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });
});
