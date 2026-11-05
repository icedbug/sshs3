// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ProfileFolderHeader } from '../../src/renderer/src/components/ConnectionModal/ProfileFolderHeader';

afterEach(() => cleanup());

function renderHeader(over: Partial<React.ComponentProps<typeof ProfileFolderHeader>> = {}) {
  const props: React.ComponentProps<typeof ProfileFolderHeader> = {
    groupName: 'Prod',
    profileCount: 3,
    isCollapsed: false,
    isDragOver: false,
    dragOverGroup: null,
    setDragOverGroup: vi.fn(),
    renamingFolder: null,
    setRenamingFolder: vi.fn(),
    renameFolderValue: 'Prod',
    setRenameFolderValue: vi.fn(),
    onToggle: vi.fn(),
    onDrop: vi.fn(),
    onCommitRename: vi.fn(),
    onDeleteFolder: vi.fn(),
    ...over,
  };
  render(<ProfileFolderHeader {...props} />);
  return props;
}

describe('ProfileFolderHeader', () => {
  it('toggles the folder from its name button', () => {
    const props = renderHeader();
    fireEvent.click(screen.getByRole('button', { name: /Prod/ }));
    expect(props.onToggle).toHaveBeenCalledOnce();
  });

  it('puts the rename field next to the toggle button, not inside it', () => {
    renderHeader({ renamingFolder: 'Prod' });
    const input = screen.getByRole('textbox', { name: 'Folder name' });
    // Inside a button, every Space typed in the name clicks the button and folds the folder (checked in Electron).
    expect(input.closest('button')).toBeNull();
    expect(screen.queryByRole('button', { name: /Prod/ })).not.toBeInTheDocument();
  });

  it('commits on Enter and cancels on Escape without letting Escape close the dialog', () => {
    const props = renderHeader({ renamingFolder: 'Prod' });
    const input = screen.getByRole('textbox', { name: 'Folder name' });

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(props.onCommitRename).toHaveBeenCalledWith('Prod');

    const outer = vi.fn();
    window.addEventListener('keydown', outer);
    fireEvent.keyDown(input, { key: 'Escape' });
    window.removeEventListener('keydown', outer);
    expect(props.setRenamingFolder).toHaveBeenCalledWith(null);
    expect(outer).not.toHaveBeenCalled();
  });

  it('types into the field without toggling the folder', () => {
    const props = renderHeader({ renamingFolder: 'Prod' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Folder name' }), { target: { value: 'My Folder' } });
    expect(props.setRenameFolderValue).toHaveBeenCalledWith('My Folder');
    expect(props.onToggle).not.toHaveBeenCalled();
  });

  it('gives the focus back to the folder row when the rename ends, instead of dropping it on the page', () => {
    const base: React.ComponentProps<typeof ProfileFolderHeader> = {
      groupName: 'Prod',
      profileCount: 3,
      isCollapsed: false,
      isDragOver: false,
      dragOverGroup: null,
      setDragOverGroup: vi.fn(),
      renamingFolder: 'Prod',
      setRenamingFolder: vi.fn(),
      renameFolderValue: 'Prod',
      setRenameFolderValue: vi.fn(),
      onToggle: vi.fn(),
      onDrop: vi.fn(),
      onCommitRename: vi.fn(),
      onDeleteFolder: vi.fn(),
    };
    const { rerender } = render(<ProfileFolderHeader {...base} />);
    screen.getByRole('textbox', { name: 'Folder name' }).focus();

    rerender(<ProfileFolderHeader {...base} renamingFolder={null} />);

    expect(screen.getByRole('button', { name: /Prod/ })).toHaveFocus();
  });

  it('does not take the focus when the row was never being renamed', () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    renderHeader();
    expect(outside).toHaveFocus();
    outside.remove();
  });

  it('shows no rename or delete buttons for the Ungrouped row', () => {
    renderHeader({ groupName: 'Ungrouped' });
    expect(screen.queryByRole('button', { name: 'Rename folder' })).not.toBeInTheDocument();
  });
});
