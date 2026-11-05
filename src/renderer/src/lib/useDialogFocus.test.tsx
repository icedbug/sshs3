// @vitest-environment jsdom
import React, { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useDialogFocus } from './useDialogFocus';

function Dialog({ open, label, children }: { open: boolean; label: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, open);
  if (!open) return null;
  return (
    <div ref={ref} role="dialog" aria-label={label}>
      {children}
    </div>
  );
}

function Page({ withAutoFocus = false, dataAutofocus = false }: { withAutoFocus?: boolean; dataAutofocus?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      <Dialog open={open} label="Test dialog">
        <button>First</button>
        {dataAutofocus && <input aria-label="Preferred" data-autofocus />}
        {withAutoFocus && <button autoFocus>Cancel</button>}
        <button onClick={() => setOpen(false)}>Last</button>
      </Dialog>
    </>
  );
}

const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(5); });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function open(ui: React.ReactElement = <Page />) {
  render(ui);
  const trigger = screen.getByText('Open');
  trigger.focus();
  fireEvent.click(trigger);
  return trigger;
}

describe('useDialogFocus', () => {
  it('moves focus to the first tabbable element when the dialog opens', () => {
    open();
    expect(document.activeElement).toBe(screen.getByText('First'));
  });

  it('prefers an element marked data-autofocus', () => {
    open(<Page dataAutofocus />);
    expect(document.activeElement).toBe(screen.getByLabelText('Preferred'));
  });

  it('leaves focus alone when an element inside already took it (React autoFocus)', () => {
    open(<Page withAutoFocus />);
    expect(document.activeElement).toBe(screen.getByText('Cancel'));
  });

  it('wraps Tab from the last element to the first and Shift+Tab the other way', () => {
    open();
    screen.getByText('Last').focus();
    fireEvent.keyDown(document.activeElement as Element, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByText('First'));
    fireEvent.keyDown(document.activeElement as Element, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByText('Last'));
  });

  it('does not intervene in the middle of the dialog', () => {
    open(<Page dataAutofocus />);
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    screen.getByLabelText('Preferred').dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('pulls Tab from behind the dialog back in', () => {
    const trigger = open();
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByText('First'));
  });

  it('ignores a Tab that another handler already consumed, and modified Tab presses', () => {
    open();
    const last = screen.getByText('Last');
    last.focus();
    last.addEventListener('keydown', (e) => e.preventDefault());
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(last);
    const free = screen.getByText('First');
    free.focus();
    fireEvent.keyDown(free, { key: 'Tab', shiftKey: true, ctrlKey: true });
    expect(document.activeElement).toBe(free);
  });

  it('leaves Tab alone while focus is inside another modal that is not wired to the hook', () => {
    open();
    const other = document.createElement('div');
    other.setAttribute('aria-modal', 'true');
    const button = document.createElement('button');
    other.appendChild(button);
    document.body.appendChild(other);
    button.focus();
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    button.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(button);
    other.remove();
  });

  it('restores focus to the opener after the dialog closes', async () => {
    const trigger = open();
    fireEvent.click(screen.getByText('Last'));
    expect(screen.queryByRole('dialog')).toBeNull();
    await flush();
    expect(document.activeElement).toBe(trigger);
  });

  it('does not take focus back when something else claimed it after the close', async () => {
    const other = document.createElement('button');
    document.body.appendChild(other);
    open();
    fireEvent.click(screen.getByText('Last'));
    other.focus();
    await flush();
    expect(document.activeElement).toBe(other);
    other.remove();
  });

  it('puts focus on the dialog itself when it has nothing focusable', () => {
    function Empty() {
      const ref = useRef<HTMLDivElement>(null);
      useDialogFocus(ref, true);
      return <div ref={ref} role="dialog" aria-label="Empty">No controls</div>;
    }
    render(<Empty />);
    expect(document.activeElement).toBe(screen.getByRole('dialog', { name: 'Empty' }));
  });

  it('lets only the topmost of two dialogs trap Tab', () => {
    function Stack() {
      const [inner, setInner] = useState(false);
      return (
        <>
          <Dialog open label="Outer">
            <button onClick={() => setInner(true)}>Outer one</button>
            <button>Outer two</button>
          </Dialog>
          <Dialog open={inner} label="Inner">
            <button>Inner one</button>
            <button>Inner two</button>
          </Dialog>
        </>
      );
    }
    render(<Stack />);
    fireEvent.click(screen.getByText('Outer one'));
    expect(document.activeElement).toBe(screen.getByText('Inner one'));
    screen.getByText('Inner two').focus();
    fireEvent.keyDown(document.activeElement as Element, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByText('Inner one'));
  });
});
