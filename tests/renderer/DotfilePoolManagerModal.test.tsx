// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render as rtlRender, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { DotfilePoolManagerModal } from '../../src/renderer/src/components/SettingsModal/DotfilePoolManagerModal';
import { ConfirmProvider } from '../../src/renderer/src/components/ConfirmDialog';
import type { DotfilePool } from '../../src/shared/types/dotfiles';

// Asks for confirmations through the app's ConfirmDialog, which needs its provider.
function render(ui: React.ReactElement) {
  const result = rtlRender(<ConfirmProvider>{ui}</ConfirmProvider>);
  return {
    ...result,
    rerender: (next: React.ReactElement) => result.rerender(<ConfirmProvider>{next}</ConfirmProvider>),
  };
}

describe('DotfilePoolManagerModal Component', () => {
  const mockPools: DotfilePool[] = [
    {
      id: 'p1',
      name: 'Linux Servers',
      files: [
        {
          id: 'f1',
          remotePath: '~/.bashrc',
          content: 'export EDITOR=vim',
          mode: '644',
          masterFileName: '.bashrc',
          sourcePath: '/home/user/.bashrc',
          updatedAt: '2026-09-17 19:40',
        },
        {
          id: 'f2',
          remotePath: '~/.kube/config',
          content: 'apiVersion: v1',
          mode: '600',
          updatedAt: '2026-09-17 19:40',
        },
      ],
      masterDirectory: '/home/user/.sshs3/dotfiles/p1',
      updatedAt: '2026-09-17 19:40',
    },
  ];

  beforeEach(() => {
    window.multissh = {
      dotfilePoolsGet: vi.fn().mockResolvedValue(mockPools),
      dotfilePoolsSave: vi.fn().mockResolvedValue(undefined),
      dotfilePoolsDelete: vi.fn().mockResolvedValue(undefined),
      dotfilePoolOpenFolder: vi.fn().mockResolvedValue(''),
      dotfilePoolSelectFiles: vi.fn().mockResolvedValue([
        {
          name: '.zshrc',
          path: '/home/user/.zshrc',
          content: 'export ZSH=1',
          mode: '644',
          size: 12,
          suggestedRemotePath: '~/.zshrc',
        },
      ]),
      // Source of ~/.bashrc has been edited locally since it was pooled.
      dotfilePoolReadSources: vi.fn().mockResolvedValue([
        {
          name: '.bashrc',
          path: '/home/user/.bashrc',
          content: 'export EDITOR=nano',
          mode: '644',
          size: 18,
          suggestedRemotePath: '~/.bashrc',
        },
      ]),
    } as unknown as typeof window.multissh;
  });

  afterEach(() => {
    cleanup();
  });

  it('renders nothing when open is false', () => {
    const { container } = render(<DotfilePoolManagerModal open={false} onClose={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it('loads and displays pools with master file details', async () => {
    render(<DotfilePoolManagerModal open={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Linux Servers')).toBeInTheDocument();
    });

    // Select the pool
    fireEvent.click(screen.getByText('Linux Servers'));

    expect(screen.getByDisplayValue('Linux Servers')).toBeInTheDocument();
    // Files are grouped by target directory; no editable content area.
    expect(screen.getByText('~/.kube')).toBeInTheDocument();
    expect(screen.getByText('config')).toBeInTheDocument();
    expect(screen.getByText('.bashrc')).toBeInTheDocument();
    expect(screen.queryByLabelText('File content')).toBeNull();
    expect(screen.getByText('Open Master Directory')).toBeInTheDocument();
  });

  it('asks before deleting a pool and only deletes it once confirmed', async () => {
    render(<DotfilePoolManagerModal open={true} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Linux Servers')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Linux Servers'));

    fireEvent.click(screen.getByRole('button', { name: /Delete Pool/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Delete the pool "Linux Servers"?');
    expect(dialog).toHaveTextContent('cannot be undone');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(window.multissh.dotfilePoolsDelete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Delete Pool/ }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete pool' }));
    await waitFor(() => expect(window.multissh.dotfilePoolsDelete).toHaveBeenCalledWith('p1'));
  });

  it('flags changed sources and refreshes the stored copy', async () => {
    render(<DotfilePoolManagerModal open={true} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Linux Servers')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Linux Servers'));

    await waitFor(() => expect(screen.getByText('Source changed')).toBeInTheDocument());
    expect(window.multissh.dotfilePoolReadSources).toHaveBeenCalledWith(['/home/user/.bashrc']);

    fireEvent.click(screen.getByLabelText('Refresh from source'));
    await waitFor(() => expect(screen.getByText('Up to date')).toBeInTheDocument());

    fireEvent.click(screen.getAllByLabelText('Preview content')[0]);
    expect(screen.getByText('export EDITOR=nano')).toBeInTheDocument();
  });

  it('warns about credential files like .kube/config', async () => {
    render(<DotfilePoolManagerModal open={true} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Linux Servers')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Linux Servers'));
    expect(await screen.findByTitle(/looks like a credentials file/)).toBeInTheDocument();
  });

  it('adds explicitly chosen files to the draft pool', async () => {
    render(<DotfilePoolManagerModal open={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Linux Servers')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Linux Servers'));

    fireEvent.click(screen.getByText('Add Files...'));

    await waitFor(() => {
      expect(window.multissh.dotfilePoolSelectFiles).toHaveBeenCalled();
      expect(screen.getByText('.zshrc')).toBeInTheDocument();
    });
  });

  it('opens master directory on disk when clicking open folder button', async () => {
    render(<DotfilePoolManagerModal open={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Linux Servers')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Linux Servers'));

    const openFolderBtn = screen.getByText('Open Master Directory');
    fireEvent.click(openFolderBtn);

    expect(window.multissh.dotfilePoolOpenFolder).toHaveBeenCalledWith('p1');
  });

  it('disables Save until something changes, then confirms the save', async () => {
    render(<DotfilePoolManagerModal open={true} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Linux Servers')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Linux Servers'));

    const saveBtn = screen.getByText('Save Pool').closest('button')!;
    expect(saveBtn).toBeDisabled();
    expect(screen.queryByText('Unsaved changes')).toBeNull();

    fireEvent.click(screen.getByText('Add Files...'));
    await waitFor(() => expect(screen.getByText('Unsaved changes')).toBeInTheDocument());
    expect(saveBtn).not.toBeDisabled();

    fireEvent.click(saveBtn);
    await waitFor(() => expect(window.multissh.dotfilePoolsSave).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saved'));
    expect(screen.queryByText('Unsaved changes')).toBeNull();
    // The pool stays open after saving.
    expect(screen.getByDisplayValue('Linux Servers')).toBeInTheDocument();
  });

  it('disables importing from Git when an administrator blocks it', async () => {
    window.multissh = {
      ...window.multissh,
      policyGet: vi.fn().mockResolvedValue({ managed: [], features: { dotfileGitImport: false }, warnings: [] }),
    } as unknown as typeof window.multissh;
    render(<DotfilePoolManagerModal open={true} onClose={vi.fn()} />);

    expect(await screen.findByRole('note')).toHaveTextContent('Disabled by your administrator.');
    expect(screen.getByRole('button', { name: /From Git/ })).toBeDisabled();
  });
});
