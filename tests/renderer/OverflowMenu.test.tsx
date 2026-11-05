// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { OverflowMenu } from '../../src/renderer/src/components/ui/OverflowMenu';

const setup = () => {
  const onEdit = vi.fn();
  const onDelete = vi.fn();
  const onOuterKey = vi.fn();
  document.addEventListener('keydown', onOuterKey);
  render(
    <OverflowMenu
      items={[
        { label: 'Duplicate profile', icon: <span />, onSelect: onEdit },
        { label: 'Delete profile', icon: <span />, onSelect: onDelete, danger: true, separated: true },
      ]}
    />
  );
  return { onEdit, onDelete, onOuterKey, cleanup: () => document.removeEventListener('keydown', onOuterKey) };
};

describe('OverflowMenu', () => {
  afterEach(() => cleanup());

  it('opens on click, runs the chosen item and closes', () => {
    const { onDelete, cleanup } = setup();
    const trigger = screen.getByTitle('More actions');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete profile' }));

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    cleanup();
  });

  it('closes on Escape without letting the key reach the surrounding modal', () => {
    const { onOuterKey, cleanup } = setup();
    fireEvent.click(screen.getByTitle('More actions'));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(onOuterKey).not.toHaveBeenCalled();
    cleanup();
  });

  it('closes when clicking outside', () => {
    const { cleanup } = setup();
    fireEvent.click(screen.getByTitle('More actions'));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    cleanup();
  });

  it('moves between items with the arrow keys and wraps around', () => {
    const { cleanup: off } = setup();
    fireEvent.click(screen.getByTitle('More actions'));
    const [first, last] = screen.getAllByRole('menuitem');
    expect(first).toHaveFocus();

    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: 'ArrowDown' });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: 'End' });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: 'Home' });
    expect(first).toHaveFocus();
    off();
  });

  it('opens from the trigger with ArrowDown and closes on Tab', () => {
    const { cleanup: off } = setup();
    const trigger = screen.getByTitle('More actions');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.keyDown(screen.getAllByRole('menuitem')[0], { key: 'Tab' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    off();
  });

  it('closes when anything scrolls, so it never floats away from its row', () => {
    const { cleanup: off } = setup();
    fireEvent.click(screen.getByTitle('More actions'));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.scroll(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    off();
  });

  it('keeps the menu open when something unrelated scrolls (e.g. a background terminal)', () => {
    const { cleanup: off } = setup();
    const unrelated = document.createElement('div');
    document.body.appendChild(unrelated);
    fireEvent.click(screen.getByTitle('More actions'));

    fireEvent.scroll(unrelated);
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.scroll(document);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    unrelated.remove();
    off();
  });

  it('goes to the last item on ArrowUp when focus is not on an item', () => {
    const { cleanup: off } = setup();
    fireEvent.click(screen.getByTitle('More actions'));
    const items = screen.getAllByRole('menuitem');
    (document.activeElement as HTMLElement).blur();

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowUp' });
    expect(items[items.length - 1]).toHaveFocus();
    off();
  });
});
