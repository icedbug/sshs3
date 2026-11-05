// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { InsertTokenModal } from '../../src/renderer/src/components/InsertTokenModal';

describe('InsertTokenModal', () => {
  let onPrompt: ((e: { id: string; kind: 'smartcard' | 'fido2'; context?: string }) => void) | null = null;
  let onDismiss: ((e: { id: string }) => void) | null = null;
  const cancelInsertToken = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    cancelInsertToken.mockClear();
    window.multissh = {
      ...(window.multissh || {}),
      onInsertTokenPrompt: vi.fn((cb) => {
        onPrompt = cb;
        return vi.fn();
      }),
      onInsertTokenDismiss: vi.fn((cb) => {
        onDismiss = cb;
        return vi.fn();
      }),
      cancelInsertToken,
    } as any;
  });
  afterEach(() => cleanup());

  it('renders nothing until a prompt arrives', () => {
    render(<InsertTokenModal />);
    expect(screen.queryByTestId('insert-token-modal')).not.toBeInTheDocument();
  });

  it('asks for the right token and goes away when the token is detected', () => {
    render(<InsertTokenModal />);
    act(() => onPrompt!({ id: 't1', kind: 'fido2', context: 'SSH: gnarg' }));
    expect(screen.getByText('Insert your security key')).toBeInTheDocument();
    expect(screen.getByText('SSH: gnarg')).toBeInTheDocument();

    act(() => onDismiss!({ id: 't1' }));
    expect(screen.queryByTestId('insert-token-modal')).not.toBeInTheDocument();
  });

  it('says smartcard for a PIV prompt', () => {
    render(<InsertTokenModal />);
    act(() => onPrompt!({ id: 't1', kind: 'smartcard' }));
    expect(screen.getByText('Insert your smartcard')).toBeInTheDocument();
  });

  it('Cancel tells the main process and closes the modal', () => {
    render(<InsertTokenModal />);
    act(() => onPrompt!({ id: 't1', kind: 'smartcard' }));
    fireEvent.click(screen.getByTestId('insert-token-cancel'));
    expect(cancelInsertToken).toHaveBeenCalledWith('t1');
    expect(screen.queryByTestId('insert-token-modal')).not.toBeInTheDocument();
  });

  it('Escape cancels', () => {
    render(<InsertTokenModal />);
    act(() => onPrompt!({ id: 't2', kind: 'fido2' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(cancelInsertToken).toHaveBeenCalledWith('t2');
  });
});
