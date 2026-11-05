// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ContextMenu, type ContextMenuItem } from '../../src/renderer/src/components/FileManager/ContextMenu';

function makeItems(onSelect: (key: string) => void): ContextMenuItem[] {
  return [
    { key: 'open', label: 'Open', onSelect: () => onSelect('open') },
    { key: 'rename', label: 'Rename', onSelect: () => onSelect('rename') },
    { key: 'disabled-item', label: 'Disabled', disabled: true, onSelect: () => onSelect('disabled-item') },
    { key: 'delete', label: 'Delete', danger: true, onSelect: () => onSelect('delete') },
  ];
}

describe('ContextMenu (M13)', () => {
  afterEach(() => cleanup());

  // `text-red-500` is not remapped for the Breeze theme (only red-400 is, in every theme), and a `dark:` variant never
  // applies there either, so the danger item measured 3.2:1 on Breeze. red-400 is the per-theme token.
  it('colors the danger item with the per-theme red-400 token, not red-500 or a dark: variant', () => {
    render(<ContextMenu x={10} y={10} items={makeItems(vi.fn())} onClose={vi.fn()} />);

    const danger = screen.getByRole('menuitem', { name: 'Delete' });
    expect(danger.className).toContain('text-red-400');
    expect(danger.className).not.toContain('text-red-500');
    expect(danger.className).not.toContain('dark:text-');
  });

  it('moves focus into the first enabled item once opened', () => {
    const onSelect = vi.fn();
    render(<ContextMenu x={10} y={10} items={makeItems(onSelect)} onClose={vi.fn()} />);

    expect(screen.getByRole('menuitem', { name: 'Open' })).toHaveFocus();
  });

  it('navigates forward through enabled items with ArrowDown, skipping disabled ones', () => {
    const onSelect = vi.fn();
    render(<ContextMenu x={10} y={10} items={makeItems(onSelect)} onClose={vi.fn()} />);

    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toHaveFocus();

    // Skips the disabled item entirely.
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus();

    // Wraps back around to the first item.
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Open' })).toHaveFocus();
  });

  it('navigates backward with ArrowUp, wrapping to the last enabled item', () => {
    const onSelect = vi.fn();
    render(<ContextMenu x={10} y={10} items={makeItems(onSelect)} onClose={vi.fn()} />);

    fireEvent.keyDown(window, { key: 'ArrowUp' });
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus();
  });

  it('Home focuses the first item and End focuses the last', () => {
    const onSelect = vi.fn();
    render(<ContextMenu x={10} y={10} items={makeItems(onSelect)} onClose={vi.fn()} />);

    fireEvent.keyDown(window, { key: 'End' });
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus();

    fireEvent.keyDown(window, { key: 'Home' });
    expect(screen.getByRole('menuitem', { name: 'Open' })).toHaveFocus();
  });

  it('activates the focused item on Enter, via the button element itself', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<ContextMenu x={10} y={10} items={makeItems(onSelect)} onClose={onClose} />);

    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));

    expect(onSelect).toHaveBeenCalledWith('rename');
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<ContextMenu x={10} y={10} items={makeItems(vi.fn())} onClose={onClose} />);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on a click outside the menu', () => {
    const onClose = vi.fn();
    render(<ContextMenu x={10} y={10} items={makeItems(vi.fn())} onClose={onClose} />);

    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalled();
  });
});
