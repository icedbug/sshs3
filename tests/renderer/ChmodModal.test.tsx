// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ChmodModal } from '../../src/renderer/src/components/FileManager/ChmodModal';
import type { FileEntry } from '../../src/shared/types/storage';

describe('ChmodModal', () => {
  const mockStorageChmod = vi.fn().mockResolvedValue(undefined);
  const mockStorageList = vi.fn().mockResolvedValue([]);

  beforeEach(() => {
    window.multissh = {
      ...(window.multissh || {}),
      storageChmod: mockStorageChmod,
      storageList: mockStorageList,
    } as any;
    mockStorageChmod.mockClear();
    mockStorageList.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  const sampleFile: FileEntry = {
    name: 'script.sh',
    path: '/home/user/script.sh',
    size: 1024,
    isDirectory: false,
    permissions: '755',
  };

  const sampleDir: FileEntry = {
    name: 'my-folder',
    path: '/home/user/my-folder',
    size: 4096,
    isDirectory: true,
    permissions: '700',
  };

  it('does not render when open is false', () => {
    const { container } = render(
      <ChmodModal
        open={false}
        providerId="local"
        entries={[sampleFile]}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders target name and initial octal mode', () => {
    render(
      <ChmodModal
        open={true}
        providerId="local"
        entries={[sampleFile]}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    );

    expect(screen.getByText('Change Permissions (chmod)')).toBeInTheDocument();
    expect(screen.getByText('script.sh')).toBeInTheDocument();
    const octalInput = screen.getByDisplayValue('0755') as HTMLInputElement;
    expect(octalInput).toBeInTheDocument();
  });

  it('names every permission checkbox and the octal field for assistive technology', () => {
    render(
      <ChmodModal
        open={true}
        providerId="local"
        entries={[sampleFile]}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    );

    // 0755: owner rwx, group r-x, others r-x
    const expected: Record<string, boolean> = {
      'Owner read': true,
      'Owner write': true,
      'Owner execute': true,
      'Group read': true,
      'Group write': false,
      'Group execute': true,
      'Others read': true,
      'Others write': false,
      'Others execute': true,
    };
    for (const [name, checked] of Object.entries(expected)) {
      const box = screen.getByRole('checkbox', { name });
      if (checked) expect(box).toBeChecked();
      else expect(box).not.toBeChecked();
    }
    expect(screen.getByLabelText('Octal notation:')).toHaveValue('0755');
  });

  it('updates octal input when checkbox is toggled', () => {
    render(
      <ChmodModal
        open={true}
        providerId="local"
        entries={[sampleFile]}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    );

    // Initial 0755 has uW=true (User Write = checkbox checked)
    // Find checkboxes
    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    // Uncheck User Write (index 1 in table row 1)
    fireEvent.click(checkboxes[1]);

    // Should change from 0755 to 0555 (User Write unchecked: 7 - 2 = 5)
    expect(screen.getByDisplayValue('0555')).toBeInTheDocument();
  });

  it('updates checkboxes when octal input changes', () => {
    render(
      <ChmodModal
        open={true}
        providerId="local"
        entries={[sampleFile]}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    );

    const octalInput = screen.getByDisplayValue('0755');
    fireEvent.change(octalInput, { target: { value: '0644' } });

    // 0644 means user read+write, no exec; group read; other read
    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(checkboxes[0].checked).toBe(true); // uR
    expect(checkboxes[1].checked).toBe(true); // uW
    expect(checkboxes[2].checked).toBe(false); // uX
    expect(checkboxes[3].checked).toBe(true); // gR
    expect(checkboxes[4].checked).toBe(false); // gW
    expect(checkboxes[5].checked).toBe(false); // gX
    expect(checkboxes[6].checked).toBe(true); // oR
    expect(checkboxes[7].checked).toBe(false); // oW
    expect(checkboxes[8].checked).toBe(false); // oX
  });

  it('shows recursive checkbox when entry is a directory', () => {
    render(
      <ChmodModal
        open={true}
        providerId="local"
        entries={[sampleDir]}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    );

    expect(screen.getByText('Apply recursively to underlying files and folders')).toBeInTheDocument();
  });

  it('calls storageChmod and onSaved when Save is clicked', async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();

    render(
      <ChmodModal
        open={true}
        providerId="sftp-1"
        entries={[sampleFile]}
        onClose={onClose}
        onSaved={onSaved}
      />
    );

    fireEvent.click(screen.getByText('Save'));

    await vi.waitFor(() => {
      expect(mockStorageChmod).toHaveBeenCalledWith('sftp-1', '/home/user/script.sh', '0755');
      expect(onSaved).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('calls onClose when Cancel is clicked', () => {
    const onClose = vi.fn();
    render(
      <ChmodModal
        open={true}
        providerId="local"
        entries={[sampleFile]}
        onClose={onClose}
        onSaved={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalled();
  });

  // M12 (code review): this dialog previously only closed via the header X
  // or the Cancel button, unlike NewFolderModal/FileEditorModal/etc.
  it('calls onClose on Escape and on a backdrop click (M12)', () => {
    const onClose = vi.fn();
    const { container } = render(
      <ChmodModal
        open={true}
        providerId="local"
        entries={[sampleFile]}
        onClose={onClose}
        onSaved={vi.fn()}
      />
    );

    fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(container.firstElementChild as Element);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
