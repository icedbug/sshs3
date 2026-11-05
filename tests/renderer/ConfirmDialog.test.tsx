// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ConfirmProvider, useConfirm } from '../../src/renderer/src/components/ConfirmDialog';

// LOW finding (code review): replaces window.confirm() for destructive
// actions, which is trivially dismissed by a stray Enter/Space press.
const TestButton: React.FC<{ onResult: (result: boolean) => void; danger?: boolean }> = ({ onResult, danger }) => {
  const confirm = useConfirm();
  return (
    <button
      onClick={async () => {
        const result = await confirm({ title: 'Delete thing', message: 'Are you sure?', danger });
        onResult(result);
      }}
    >
      Trigger
    </button>
  );
};

describe('ConfirmDialog', () => {
  afterEach(() => cleanup());

  it('resolves true when the confirm button is clicked', async () => {
    const onResult = vi.fn();
    render(
      <ConfirmProvider>
        <TestButton onResult={onResult} />
      </ConfirmProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();
    expect(screen.getByText('Are you sure?')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));
    expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
  });

  it('resolves false when Cancel is clicked', async () => {
    const onResult = vi.fn();
    render(
      <ConfirmProvider>
        <TestButton onResult={onResult} />
      </ConfirmProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));
  });

  it('resolves false on Escape', async () => {
    const onResult = vi.fn();
    render(
      <ConfirmProvider>
        <TestButton onResult={onResult} />
      </ConfirmProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' });

    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));
  });

  it('resolves false on a backdrop click', async () => {
    const onResult = vi.fn();
    render(
      <ConfirmProvider>
        <TestButton onResult={onResult} />
      </ConfirmProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    fireEvent.click(screen.getByTestId('confirm-dialog'));

    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));
  });

  // The core fix: Cancel is the button that receives autofocus, not the
  // destructive action, so a stray Enter/Space press is safe.
  it('autofocuses Cancel, not the destructive confirm button', () => {
    render(
      <ConfirmProvider>
        <TestButton onResult={vi.fn()} />
      </ConfirmProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));

    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('keeps Tab inside the dialog and never lands on the page behind it', () => {
    render(
      <ConfirmProvider>
        <TestButton onResult={vi.fn()} />
      </ConfirmProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const confirmButton = screen.getByRole('button', { name: 'Delete' });

    confirmButton.focus();
    fireEvent.keyDown(confirmButton, { key: 'Tab' });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
    expect(confirmButton).toHaveFocus();
  });

  it('gives focus back to the element that opened it once it closes', async () => {
    render(
      <ConfirmProvider>
        <TestButton onResult={vi.fn()} />
      </ConfirmProvider>
    );
    const trigger = screen.getByRole('button', { name: 'Trigger' });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('names the dialog by its title, or "Confirm" when it has none', () => {
    const NoTitle: React.FC = () => {
      const confirm = useConfirm();
      return <button onClick={() => void confirm({ message: 'Proceed?' })}>NoTitle</button>;
    };
    render(
      <ConfirmProvider>
        <TestButton onResult={vi.fn()} />
        <NoTitle />
      </ConfirmProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    expect(screen.getByRole('alertdialog', { name: 'Delete thing' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    fireEvent.click(screen.getByRole('button', { name: 'NoTitle' }));
    expect(screen.getByRole('alertdialog', { name: 'Confirm' })).toBeInTheDocument();
  });

  it('answers an earlier request "no" instead of leaving it hanging when a second one replaces it', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const Two: React.FC = () => {
      const confirm = useConfirm();
      return (
        <>
          <button onClick={async () => first(await confirm({ title: 'First', message: 'one' }))}>Ask first</button>
          <button onClick={async () => second(await confirm({ title: 'Second', message: 'two' }))}>Ask second</button>
        </>
      );
    };
    render(
      <ConfirmProvider>
        <Two />
      </ConfirmProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Ask first' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ask second' }));
    await waitFor(() => expect(first).toHaveBeenCalledWith(false));
    expect(screen.getByRole('alertdialog', { name: 'Second' })).toBeInTheDocument();

    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(second).toHaveBeenCalledWith(true));
  });

  it('uses a neutral (non-red) confirm button and different default label when danger is false', async () => {
    const onResult = vi.fn();
    render(
      <ConfirmProvider>
        <TestButton onResult={onResult} danger={false} />
      </ConfirmProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    const confirmButton = screen.getByRole('button', { name: 'OK' });
    expect(confirmButton.className).not.toContain('bg-red-600');

    fireEvent.click(confirmButton);
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));
  });

  it('throws if useConfirm is used outside a ConfirmProvider', () => {
    const BareComponent: React.FC = () => {
      useConfirm();
      return null;
    };
    // Suppress React's expected console.error for the thrown render error.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<BareComponent />)).toThrow(/must be used within a ConfirmProvider/);
    spy.mockRestore();
  });
});
