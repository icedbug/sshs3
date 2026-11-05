// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { DirectorySyncModal } from '../../src/renderer/src/components/FileManager/DirectorySyncModal';
import { ConfirmProvider } from '../../src/renderer/src/components/ConfirmDialog';
import type { DirectoryDiffResult, DirectorySyncProfile } from '../../src/shared/types/dirsync';
import type { SSHConnectionConfig } from '../../src/shared/types/ssh';

const mockSsh: SSHConnectionConfig[] = [
  {
    id: 'remote-srv',
    name: 'Production Server',
    host: 'prod.example.com',
    port: 22,
    username: 'deploy',
    authType: 'password',
  },
];

const mockDiff: DirectoryDiffResult = {
  scannedAt: '2026-09-26T12:00:00.000Z',
  counts: { new: 2, changed: 1, onlyTarget: 1, same: 5, conflict: 0 },
  skippedPaths: { source: [], target: [] },
  skippedSymlinks: { source: [], target: [] },
  entries: [
    {
      relativePath: 'assets/app.js',
      isDirectory: false,
      status: 'new',
      sourceEntry: { name: 'app.js', path: '/var/www/assets/app.js', size: 1024, isDirectory: false },
    },
    {
      relativePath: 'images/logo.png',
      isDirectory: false,
      status: 'new',
      sourceEntry: { name: 'logo.png', path: '/var/www/images/logo.png', size: 2048, isDirectory: false },
    },
    {
      relativePath: 'index.html',
      isDirectory: false,
      status: 'changed',
      sourceEntry: { name: 'index.html', path: '/var/www/index.html', size: 500, isDirectory: false },
      targetEntry: { name: 'index.html', path: '/backups/index.html', size: 400, isDirectory: false },
    },
    {
      relativePath: 'old-backup.tar.gz',
      isDirectory: false,
      status: 'only-target',
      targetEntry: { name: 'old-backup.tar.gz', path: '/backups/old-backup.tar.gz', size: 10000, isDirectory: false },
    },
  ],
};

const mockProfile: DirectorySyncProfile = {
  id: 'profile-1',
  name: 'Sync Prod to Backup',
  source: { providerConfigRef: 'sftp-remote-srv', path: '/var/www' },
  target: { providerConfigRef: 'local', path: '/backups' },
  deleteExtraneous: false,
  createdAt: '2026-09-26T10:00:00.000Z',
  updatedAt: '2026-09-26T10:00:00.000Z',
};

describe('DirectorySyncModal', () => {
  beforeEach(() => {
    window.multissh = {
      connectStorage: vi.fn().mockResolvedValue(undefined),
      profilesGet: vi.fn().mockResolvedValue({ ssh: mockSsh, s3: [] }),
      dirSyncComputeDiff: vi.fn().mockResolvedValue(mockDiff),
      dirSyncApply: vi.fn().mockResolvedValue({ copied: 3, deleted: 0, failed: 0, errors: [] }),
      dirSyncProfileSave: vi.fn().mockResolvedValue(undefined),
      onDirSyncScanProgress: vi.fn().mockReturnValue(() => {}),
      onDirSyncApplyProgress: vi.fn().mockReturnValue(() => {}),
    } as any;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders diff review with clear flow banner, stat cards, and action badges', async () => {
    render(
      <ConfirmProvider>
        <DirectorySyncModal
          open={true}
          onClose={() => {}}
          runProfile={mockProfile}
        />
      </ConfirmProvider>
    );

    // Wait for diff step to load
    await waitFor(() => {
      expect(screen.getByText('Source (From)')).toBeInTheDocument();
      expect(screen.getByText('Target (To)')).toBeInTheDocument();
    });

    // Check Flow Comparison banner
    expect(screen.getByText('Syncs to')).toBeInTheDocument();
    expect(screen.getByText('Production Server')).toBeInTheDocument();
    expect(screen.getByText('SFTP · deploy@prod.example.com')).toBeInTheDocument();
    expect(screen.getByText('/var/www')).toBeInTheDocument();
    expect(screen.getByText('Local Disk')).toBeInTheDocument();
    expect(screen.getByText('This computer (Local)')).toBeInTheDocument();
    expect(screen.getByText('/backups')).toBeInTheDocument();

    // Check Policy banner (defaults to safe sync)
    expect(screen.getByText(/Safe sync: Files existing only in target are preserved/)).toBeInTheDocument();

    // Check Stat cards
    expect(screen.getByText('New on source')).toBeInTheDocument();
    expect(screen.getByText('Will copy to target')).toBeInTheDocument();
    expect(screen.getByText('Will overwrite target')).toBeInTheDocument();
    expect(screen.getByText('Kept (safe sync)')).toBeInTheDocument();

    // Check table headers and action badges
    expect(screen.getByText(/New on source \(2\) — select all to copy/)).toBeInTheDocument();
    expect(screen.getAllByText('+ Copy to target')).toHaveLength(2);
    expect(screen.getByText(/Modified on source \(1\) — select all to overwrite/)).toBeInTheDocument();
    expect(screen.getByText('↻ Overwrite target')).toBeInTheDocument();
    expect(screen.getByText(/Only in target \(1\) — preserved in target \(safe sync\)/)).toBeInTheDocument();
    expect(screen.getByText('Kept in target')).toBeInTheDocument();

    // Check Run sync button shows exact count (2 new + 1 modified = 3 to copy)
    expect(screen.getByRole('button', { name: /Run sync \(3 to copy\)/ })).toBeInTheDocument();

    // Check Back to setup button is available
    expect(screen.getByRole('button', { name: /Back to setup/ })).toBeInTheDocument();
  });

  it('updates actions and counts when toggling mirror mode', async () => {
    render(
      <ConfirmProvider>
        <DirectorySyncModal
          open={true}
          onClose={() => {}}
          runProfile={mockProfile}
        />
      </ConfirmProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('Source (From)')).toBeInTheDocument();
    });

    // Toggle mirror mode on
    const mirrorCheckbox = screen.getByRole('checkbox', {
      name: /Enable mirror \(delete extraneous files in target\)/,
    });
    fireEvent.click(mirrorCheckbox);

    // Banner and stat card should update to mirror mode
    expect(screen.getByText(/Mirror mode: Files only in target will be deleted if selected/)).toBeInTheDocument();
    expect(screen.getByText('Deletes if selected')).toBeInTheDocument();

    // Category header should now allow selecting files to delete
    expect(screen.getByText(/Only in target \(1\) — select all to delete/)).toBeInTheDocument();

    // Check the only-target entry checkbox (relative path: old-backup.tar.gz)
    const selectAllOnlyTargetBtn = screen.getByRole('button', {
      name: /Only in target \(1\) — select all to delete/,
    });
    fireEvent.click(selectAllOnlyTargetBtn);

    // Now button should show 3 to copy, 1 to delete!
    expect(screen.getByRole('button', { name: /Run sync \(3 to copy, 1 to delete\)/ })).toBeInTheDocument();
    expect(screen.getByText('Delete from target')).toBeInTheDocument();
  });

  // H6 (code review 2026-11-03): a file and a folder with the same name used to be shown as identical.
  it('shows a file/folder name clash as a skipped conflict that is never part of the run', async () => {
    const conflictDiff: DirectoryDiffResult = {
      scannedAt: '2026-11-03T12:00:00.000Z',
      counts: { new: 1, changed: 0, onlyTarget: 0, same: 0, conflict: 1 },
      skippedPaths: { source: [], target: [] },
  skippedSymlinks: { source: [], target: [] },
      entries: [
        {
          relativePath: 'build',
          isDirectory: false,
          status: 'conflict',
          sourceEntry: { name: 'build', path: '/var/www/build', size: 5, isDirectory: false },
          targetEntry: { name: 'build', path: '/backups/build', size: 0, isDirectory: true },
        },
        {
          relativePath: 'index.html',
          isDirectory: false,
          status: 'new',
          sourceEntry: { name: 'index.html', path: '/var/www/index.html', size: 10, isDirectory: false },
        },
      ],
    };
    (window.multissh as any).dirSyncComputeDiff = vi.fn().mockResolvedValue(conflictDiff);

    render(
      <ConfirmProvider>
        <DirectorySyncModal open={true} onClose={() => {}} runProfile={mockProfile} />
      </ConfirmProvider>
    );

    await waitFor(() => {
      expect(screen.getByText(/File and folder with the same name \(1\) — skipped/)).toBeInTheDocument();
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/1 path is a file on one side and a folder on the other/);
    expect(screen.getByText('Skipped (type conflict)')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Run sync \(1 to copy\)/ }));
    await waitFor(() => expect(window.multissh.dirSyncApply).toHaveBeenCalled());
    const sent = (window.multissh.dirSyncApply as any).mock.calls[0][0].entries as Array<{ relativePath: string }>;
    expect(sent.map((e) => e.relativePath)).toEqual(['index.html']);
  });

  it('says which symbolic links were left out, without calling them unreadable', async () => {
    (window.multissh as any).dirSyncComputeDiff = vi.fn().mockResolvedValue({
      ...mockDiff,
      skippedSymlinks: { source: ['current.log', 'node_modules/.bin'], target: ['shortcut'] },
    });

    render(
      <ConfirmProvider>
        <DirectorySyncModal open={true} onClose={() => {}} runProfile={mockProfile} />
      </ConfirmProvider>
    );

    await waitFor(() => {
      expect(screen.getByText(/2 symbolic link\(s\) in the source are not synced/)).toBeInTheDocument();
    });
    expect(screen.getByText(/1 symbolic link\(s\) in the target are not synced/)).toBeInTheDocument();
    expect(screen.queryByText(/could not be read/)).not.toBeInTheDocument();
  });
});
