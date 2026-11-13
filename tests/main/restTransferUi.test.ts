// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TransferConflictModal } from '../../src/renderer/src/components/TransferConflictModal';
import { FilePane } from '../../src/renderer/src/components/FileManager/FilePane';
import { DragDropProvider } from '../../src/renderer/src/components/FileManager/DragDropLayer';
import { ConfirmProvider } from '../../src/renderer/src/components/ConfirmDialog';
import type { ExternalFileStatusEvent, TransferConflictPromptEvent } from '../../src/shared/types/ipc';

afterEach(() => cleanup());

describe('transfer conflict wording for folders', () => {
  let prompt: ((e: TransferConflictPromptEvent) => void) | null = null;
  beforeEach(() => {
    prompt = null;
    (window as any).multissh = {
      onTransferConflictPrompt: vi.fn((cb) => {
        prompt = cb;
        return () => {};
      }),
      respondTransferConflict: vi.fn().mockResolvedValue(undefined),
    };
  });

  function show(isDirectory: boolean) {
    render(createElement(TransferConflictModal));
    act(() => {
      prompt!({ id: 'p', sourcePath: '/s/x', targetPath: '/d/x', fileName: 'x', isDirectory });
    });
  }

  it('says a folder conflict merges and replaces files with the same name', () => {
    show(true);
    expect(screen.getByText('Folder Already Exists')).toBeInTheDocument();
    expect(screen.getByTestId('transfer-conflict-overwrite')).toHaveTextContent('Merge and replace files');
    expect(screen.getByTestId('transfer-conflict-merge-note')).toHaveTextContent(
      'files with the same name inside are replaced, and other files already in the destination folder are kept'
    );
  });

  it('keeps the plain Overwrite wording for a single file', () => {
    show(false);
    expect(screen.getByText('File Already Exists')).toBeInTheDocument();
    expect(screen.getByTestId('transfer-conflict-overwrite')).toHaveTextContent('Overwrite');
    expect(screen.queryByTestId('transfer-conflict-merge-note')).toBeNull();
  });
});

describe('Open in External Editor from the file list', () => {
  let statusListener: ((e: ExternalFileStatusEvent) => void) | null = null;
  beforeEach(() => {
    statusListener = null;
    (window as any).multissh = {
      storageList: vi.fn().mockResolvedValue([{ name: 'app.ini', path: '/etc/app.ini', size: 10, isDirectory: false }]),
      getHomeDir: vi.fn().mockResolvedValue('/home/u'),
      storageGetHomeDir: vi.fn().mockResolvedValue('/home/u'),
      onTransferProgress: vi.fn().mockReturnValue(() => {}),
      onSearchResult: vi.fn().mockReturnValue(() => {}),
      onSearchProgress: vi.fn().mockReturnValue(() => {}),
      onSearchError: vi.fn().mockReturnValue(() => {}),
      onSearchDone: vi.fn().mockReturnValue(() => {}),
      fileOpenExternal: vi.fn().mockResolvedValue({ sessionToken: 'tok-1', localPath: '/tmp/app.ini' }),
      onExternalFileStatus: vi.fn((cb) => {
        statusListener = cb;
        return () => {};
      }),
    };
  });

  it('shows an error when the automatic upload of the edited file fails', async () => {
    render(
      createElement(
        ConfirmProvider,
        null,
        createElement(
          DragDropProvider,
          null,
          createElement(FilePane, {
            side: 'right',
            source: { providerId: 'sftp-1', sourceType: 'sftp', label: 'Server' },
            currentPath: '/etc',
            onPathChange: () => {},
            onSourceTypeRequest: vi.fn(),
            onTransferRequested: vi.fn(),
            refreshToken: 0,
          } as any)
        )
      )
    );

    const row = await screen.findByText('app.ini');
    fireEvent.click(row);
    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByText('Open in External Editor'));
    await vi.waitFor(() => expect((window as any).multissh.fileOpenExternal).toHaveBeenCalledWith('sftp-1', '/etc/app.ini'));
    await act(async () => {});

    const base = { providerId: 'sftp-1', remotePath: '/etc/app.ini', timestamp: 'now' };
    // Another session's failure is not ours to show.
    act(() => statusListener!({ ...base, sessionToken: 'someone-else', status: 'error', error: 'nope' }));
    expect(screen.queryByText(/Could not upload/)).toBeNull();

    act(() => statusListener!({ ...base, sessionToken: 'tok-1', status: 'error', error: 'Permission denied' }));
    expect(
      await screen.findByText('Could not upload "app.ini" from the external editor: Permission denied')
    ).toBeInTheDocument();
  });
});
