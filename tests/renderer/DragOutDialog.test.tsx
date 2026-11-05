// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { DragOutDialog } from '../../src/renderer/src/components/FileManager/DragOutDialog';

describe('DragOutDialog', () => {
  const dragOutPrepare = vi.fn();
  const dragOutStart = vi.fn().mockResolvedValue(true);

  beforeEach(() => {
    dragOutPrepare.mockReset();
    dragOutStart.mockClear();
    (window as any).multissh = { dragOutPrepare, dragOutStart };
  });

  it('asks first and downloads nothing until confirmed', () => {
    render(<DragOutDialog providerId="sftp-1" paths={['/srv/report.pdf']} onClose={vi.fn()} />);
    expect(screen.getByText('report.pdf')).toBeInTheDocument();
    expect(dragOutPrepare).not.toHaveBeenCalled();
  });

  it('prepares on confirm, then offers a chip that starts the native drag', async () => {
    dragOutPrepare.mockResolvedValue(['/tmp/x/report.pdf']);
    render(<DragOutDialog providerId="sftp-1" paths={['/srv/report.pdf']} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /prepare copy/i }));
    expect(dragOutPrepare).toHaveBeenCalledWith('sftp-1', ['/srv/report.pdf']);
    const chip = await screen.findByTestId('drag-out-chip');
    fireEvent.dragStart(chip);
    expect(dragOutStart).toHaveBeenCalledWith(['/tmp/x/report.pdf']);
  });

  it('shows the error and lets the user retry', async () => {
    dragOutPrepare.mockRejectedValueOnce(new Error('File is too large'));
    render(<DragOutDialog providerId="sftp-1" paths={['/srv/big.iso']} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /prepare copy/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('File is too large');
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('warns for credential files and summarizes multiple items', () => {
    const { rerender } = render(<DragOutDialog providerId="sftp-1" paths={['/home/me/.ssh/id_ed25519']} onClose={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/credential or secret/);
    rerender(<DragOutDialog providerId="sftp-1" paths={['/a', '/b', '/c']} onClose={vi.fn()} />);
    expect(screen.getByText('3 items')).toBeInTheDocument();
  });

  it('closes on Escape and ignores a result that arrives after closing', async () => {
    let resolve!: (v: string[]) => void;
    dragOutPrepare.mockReturnValue(new Promise((r) => (resolve = r)));
    const onClose = vi.fn();
    const { unmount } = render(<DragOutDialog providerId="sftp-1" paths={['/a']} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /prepare copy/i }));
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    unmount();
    resolve(['/tmp/x/a']);
  });
});
