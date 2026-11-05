// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { BulkActionBar } from '../../src/renderer/src/components/ConnectionModal/BulkActionBar';

afterEach(cleanup);

function setup(over: Partial<React.ComponentProps<typeof BulkActionBar>> = {}) {
  const props = {
    count: 3,
    busy: false,
    notice: null,
    folderSuggestions: ['Prod', 'Staging'],
    onMove: vi.fn(),
    onAddTags: vi.fn(),
    onClear: vi.fn(),
    ...over,
  };
  const utils = render(<BulkActionBar {...props} />);
  return { ...utils, ...props };
}

describe('BulkActionBar', () => {
  it('renders nothing when no profile is selected and there is nothing to say', () => {
    const { container } = setup({ count: 0 });
    expect(container).toBeEmptyDOMElement();
  });

  it('shows how many are selected and the three actions', () => {
    setup({ count: 3 });
    expect(screen.getByText('3 selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move to folder…' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add tags…' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear selection' })).toBeInTheDocument();
  });

  it('still shows the result of an action after the selection was cleared', () => {
    setup({ count: 0, notice: 'Moved 2 profiles to "Prod".' });
    expect(screen.getByRole('status')).toHaveTextContent('Moved 2 profiles to "Prod".');
    expect(screen.queryByRole('button', { name: 'Move to folder…' })).not.toBeInTheDocument();
  });

  it('clears the selection', () => {
    const { onClear } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  describe('move to folder', () => {
    const open = () => fireEvent.click(screen.getByRole('button', { name: 'Move to folder…' }));
    const field = () => screen.getByLabelText('Folder');

    it('moves to the typed folder on Enter or the Move button, and closes the panel', () => {
      const { onMove } = setup();
      open();
      fireEvent.change(field(), { target: { value: 'Prod/Web' } });
      fireEvent.keyDown(field(), { key: 'Enter' });
      expect(onMove).toHaveBeenLastCalledWith('Prod/Web');
      expect(screen.queryByLabelText('Folder')).not.toBeInTheDocument();

      open();
      fireEvent.change(field(), { target: { value: 'Staging' } });
      fireEvent.click(screen.getByRole('button', { name: 'Move' }));
      expect(onMove).toHaveBeenLastCalledWith('Staging');
    });

    it('offers the existing folders as suggestions', () => {
      const { container } = setup();
      open();
      const values = Array.from(container.querySelectorAll('datalist option')).map((o) => o.getAttribute('value'));
      expect(values).toEqual(['Prod', 'Staging']);
    });

    it('will not move to a blank folder; taking profiles out of their folder is its own button', () => {
      const { onMove } = setup();
      open();
      expect(screen.getByRole('button', { name: 'Move' })).toBeDisabled();
      fireEvent.keyDown(field(), { key: 'Enter' });
      expect(onMove).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Take out of folder' }));
      expect(onMove).toHaveBeenCalledWith('');
    });

    it('closes on Escape without that Escape reaching the dialog around it', () => {
      setup();
      const onWindowKey = vi.fn();
      window.addEventListener('keydown', onWindowKey);
      open();
      fireEvent.keyDown(field(), { key: 'Escape' });
      window.removeEventListener('keydown', onWindowKey);
      expect(screen.queryByLabelText('Folder')).not.toBeInTheDocument();
      expect(onWindowKey).not.toHaveBeenCalled();
    });
  });

  describe('add tags', () => {
    const open = () => fireEvent.click(screen.getByRole('button', { name: 'Add tags…' }));

    it('adds the tags that were entered', () => {
      const { onAddTags } = setup();
      open();
      const input = screen.getByLabelText('Tags to add');
      fireEvent.change(input, { target: { value: '#prod, web' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));
      expect(onAddTags).toHaveBeenCalledWith(['prod', 'web']);
    });

    it('cannot add before a tag has been entered', () => {
      setup();
      open();
      expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    });

    it('closes on Escape without that Escape reaching the dialog around it', () => {
      setup();
      const onWindowKey = vi.fn();
      window.addEventListener('keydown', onWindowKey);
      open();
      fireEvent.keyDown(within(screen.getByRole('group', { name: 'Add tags' })).getByLabelText('Tags to add'), { key: 'Escape' });
      window.removeEventListener('keydown', onWindowKey);
      expect(screen.queryByRole('group', { name: 'Add tags' })).not.toBeInTheDocument();
      expect(onWindowKey).not.toHaveBeenCalled();
    });
  });

  describe('group as system', () => {
    const open = () => fireEvent.click(screen.getByRole('button', { name: 'Group as system…' }));

    it('is only offered where systems are supported', () => {
      setup();
      expect(screen.queryByRole('button', { name: 'Group as system…' })).not.toBeInTheDocument();
    });

    it('groups into the typed system and folder on Enter or the Group button, and closes the panel', () => {
      const onGroupAsSystem = vi.fn();
      setup({ onGroupAsSystem, systemSuggestions: ['Shop'] });
      open();
      fireEvent.change(screen.getByLabelText('System'), { target: { value: 'Webshop' } });
      fireEvent.change(screen.getByLabelText('Folder (optional)'), { target: { value: 'Prod' } });
      fireEvent.keyDown(screen.getByLabelText('System'), { key: 'Enter' });
      expect(onGroupAsSystem).toHaveBeenLastCalledWith('Webshop', 'Prod');
      expect(screen.queryByRole('group', { name: 'Group as system' })).not.toBeInTheDocument();

      open();
      fireEvent.change(screen.getByLabelText('System'), { target: { value: 'Blog' } });
      fireEvent.click(screen.getByRole('button', { name: 'Group' }));
      expect(onGroupAsSystem).toHaveBeenLastCalledWith('Blog', '');
    });

    it('offers existing systems and folders as suggestions', () => {
      const { container } = setup({ onGroupAsSystem: vi.fn(), systemSuggestions: ['Shop', 'Blog'], folderSuggestions: ['Prod'] });
      open();
      const lists = Array.from(container.querySelectorAll('datalist')).map((l) => Array.from(l.querySelectorAll('option')).map((o) => o.getAttribute('value')));
      expect(lists).toEqual([['Shop', 'Blog'], ['Prod']]);
    });

    it('cannot group without a system name', () => {
      const onGroupAsSystem = vi.fn();
      setup({ onGroupAsSystem });
      open();
      expect(screen.getByRole('button', { name: 'Group' })).toBeDisabled();
      fireEvent.keyDown(screen.getByLabelText('System'), { key: 'Enter' });
      expect(onGroupAsSystem).not.toHaveBeenCalled();
    });

    it('closes on Escape without that Escape reaching the dialog around it', () => {
      setup({ onGroupAsSystem: vi.fn() });
      const onWindowKey = vi.fn();
      window.addEventListener('keydown', onWindowKey);
      open();
      fireEvent.keyDown(screen.getByLabelText('System'), { key: 'Escape' });
      window.removeEventListener('keydown', onWindowKey);
      expect(screen.queryByRole('group', { name: 'Group as system' })).not.toBeInTheDocument();
      expect(onWindowKey).not.toHaveBeenCalled();
    });

    it('is disabled while a save is running', () => {
      setup({ onGroupAsSystem: vi.fn(), busy: true });
      expect(screen.getByRole('button', { name: 'Group as system…' })).toBeDisabled();
    });
  });

  it('disables the actions while a save is running', () => {
    setup({ busy: true });
    expect(screen.getByRole('button', { name: 'Move to folder…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add tags…' })).toBeDisabled();
  });

  it('opens one panel at a time', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Move to folder…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add tags…' }));
    expect(screen.queryByLabelText('Folder')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Tags to add')).toBeInTheDocument();
  });
});
