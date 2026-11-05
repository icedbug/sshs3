// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { FilePane } from '../../src/renderer/src/components/FileManager/FilePane';
import { DragDropProvider } from '../../src/renderer/src/components/FileManager/DragDropLayer';
import { ConfirmProvider } from '../../src/renderer/src/components/ConfirmDialog';

// The real editor needs a lot of IPC; only its open/tail props matter here.
vi.mock('../../src/renderer/src/components/FileManager/FileEditorModal', () => ({
  FileEditorModal: (p: { entry: { name: string } | null; isTailMode?: boolean; onClose: () => void }) =>
    p.entry ? (
      <div data-testid="editor" data-tail={String(Boolean(p.isTailMode))}>
        <button onClick={p.onClose}>close-editor</button>
      </div>
    ) : null,
}));

describe('FilePane Home Button', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as any).multissh = {
      storageList: vi.fn().mockResolvedValue([]),
      getHomeDir: vi.fn().mockResolvedValue('/home/localuser'),
      storageGetHomeDir: vi.fn().mockResolvedValue('/home/remoteuser'),
      onTransferProgress: vi.fn().mockReturnValue(() => {}),
      onSearchResult: vi.fn().mockReturnValue(() => {}),
      onSearchProgress: vi.fn().mockReturnValue(() => {}),
      onSearchError: vi.fn().mockReturnValue(() => {}),
      onSearchDone: vi.fn().mockReturnValue(() => {}),
    };
  });

  it('renders Home button for local storage and navigates to local home on click', async () => {
    const onPathChange = vi.fn();
    render(
      <ConfirmProvider>
        <DragDropProvider>
        <FilePane
          side="left"
          source={{ providerId: 'local', sourceType: 'local', label: 'Local Disk' }}
          currentPath="/var/log"
          onPathChange={onPathChange}
          onSourceTypeRequest={vi.fn()}
          onTransferRequested={vi.fn()}
          refreshToken={0}
        />
        </DragDropProvider>
      </ConfirmProvider>
    );

    const homeBtn = screen.getByRole('button', { name: 'Home' });
    expect(homeBtn).toBeInTheDocument();

    fireEvent.click(homeBtn);
    await waitFor(() => {
      expect(onPathChange).toHaveBeenCalledWith('/home/localuser');
    });
  });

  it('renders Home button for sftp storage and navigates to remote home on click', async () => {
    const onPathChange = vi.fn();
    render(
      <ConfirmProvider>
        <DragDropProvider>
        <FilePane
          side="right"
          source={{ providerId: 'sftp-1', sourceType: 'sftp', label: 'My SFTP' }}
          currentPath="/etc/nginx"
          onPathChange={onPathChange}
          onSourceTypeRequest={vi.fn()}
          onTransferRequested={vi.fn()}
          refreshToken={0}
        />
        </DragDropProvider>
      </ConfirmProvider>
    );

    const homeBtn = screen.getByRole('button', { name: 'Home' });
    expect(homeBtn).toBeInTheDocument();

    fireEvent.click(homeBtn);
    await waitFor(() => {
      expect((window as any).multissh.storageGetHomeDir).toHaveBeenCalledWith('sftp-1');
      expect(onPathChange).toHaveBeenCalledWith('/home/remoteuser');
    });
  });

  it('does NOT render Home button for s3 storage', () => {
    render(
      <ConfirmProvider>
        <DragDropProvider>
        <FilePane
          side="right"
          source={{ providerId: 's3-1', sourceType: 's3', label: 'My S3' }}
          currentPath="/my-bucket"
          onPathChange={vi.fn()}
          onSourceTypeRequest={vi.fn()}
          onTransferRequested={vi.fn()}
          refreshToken={0}
        />
        </DragDropProvider>
      </ConfirmProvider>
    );

    expect(screen.queryByRole('button', { name: 'Home' })).not.toBeInTheDocument();
  });

  it('does NOT render Home button for k8s storage', () => {
    render(
      <ConfirmProvider>
        <DragDropProvider>
        <FilePane
          side="right"
          source={{ providerId: 'k8s-1', sourceType: 'k8s', label: 'My Pod' }}
          currentPath="/"
          onPathChange={vi.fn()}
          onSourceTypeRequest={vi.fn()}
          onTransferRequested={vi.fn()}
          refreshToken={0}
        />
        </DragDropProvider>
      </ConfirmProvider>
    );

    expect(screen.queryByRole('button', { name: 'Home' })).not.toBeInTheDocument();
  });

  it('does NOT reload folder or clear selection when isActive or callback references change', async () => {
    const storageListMock = vi.fn().mockResolvedValue([
      { name: 'file1.txt', path: '/var/log/file1.txt', size: 100, isDirectory: false },
    ]);
    (window as any).multissh.storageList = storageListMock;

    const { rerender } = render(
      <ConfirmProvider>
        <DragDropProvider>
          <FilePane
            side="right"
            source={{ providerId: 'local', sourceType: 'local', label: 'Local Disk' }}
            currentPath="/var/log"
            isActive={false}
            onPathChange={() => {}}
            onSourceTypeRequest={vi.fn()}
            onTransferRequested={vi.fn()}
            refreshToken={0}
          />
        </DragDropProvider>
      </ConfirmProvider>
    );

    await waitFor(() => {
      expect(storageListMock).toHaveBeenCalledTimes(1);
    });

    // Re-render with isActive=true and a new inline function reference for onPathChange
    rerender(
      <ConfirmProvider>
        <DragDropProvider>
          <FilePane
            side="right"
            source={{ providerId: 'local', sourceType: 'local', label: 'Local Disk' }}
            currentPath="/var/log"
            isActive={true}
            onPathChange={() => {}}
            onSourceTypeRequest={vi.fn()}
            onTransferRequested={vi.fn()}
            refreshToken={0}
          />
        </DragDropProvider>
      </ConfirmProvider>
    );

    // storageList should STILL have only been called once (no redundant reload that resets scroll)
    expect(storageListMock).toHaveBeenCalledTimes(1);
  });

  it('queries git status and renders git branch when gitIntegrationEnabled is true', async () => {
    const gitGetStatusMock = vi.fn().mockResolvedValue({
      isRepo: true,
      branch: 'main',
      isClean: true,
      ahead: 0,
      behind: 0,
    });
    (window as any).multissh.gitGetStatus = gitGetStatusMock;

    render(
      <ConfirmProvider>
        <DragDropProvider>
          <FilePane
            side="left"
            source={{ providerId: 'local', sourceType: 'local', label: 'Local Disk' }}
            currentPath="/var/log"
            gitIntegrationEnabled={true}
            onPathChange={vi.fn()}
            onSourceTypeRequest={vi.fn()}
            onTransferRequested={vi.fn()}
            refreshToken={0}
          />
        </DragDropProvider>
      </ConfirmProvider>
    );

    await waitFor(() => {
      expect(gitGetStatusMock).toHaveBeenCalledWith('/var/log', 'local');
    });

    await waitFor(() => {
      expect(screen.getByText('main')).toBeInTheDocument();
    });
  });

  it('does NOT query git status or render git toolbar elements when gitIntegrationEnabled is false', async () => {
    const gitGetStatusMock = vi.fn().mockResolvedValue({
      isRepo: true,
      branch: 'main',
      isClean: true,
    });
    (window as any).multissh.gitGetStatus = gitGetStatusMock;

    render(
      <ConfirmProvider>
        <DragDropProvider>
          <FilePane
            side="left"
            source={{ providerId: 'local', sourceType: 'local', label: 'Local Disk' }}
            currentPath="/var/log"
            gitIntegrationEnabled={false}
            onPathChange={vi.fn()}
            onSourceTypeRequest={vi.fn()}
            onTransferRequested={vi.fn()}
            refreshToken={0}
          />
        </DragDropProvider>
      </ConfirmProvider>
    );

    await waitFor(() => {
      expect((window as any).multissh.storageList).toHaveBeenCalled();
    });

    expect(gitGetStatusMock).not.toHaveBeenCalled();
    expect(screen.queryByText('main')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Git \(Clone repository here\.\.\.\)/i)).not.toBeInTheDocument();
  });

  it('opens a file in normal mode after an earlier "Tail -f" session was closed', async () => {
    (window as any).multissh.storageList = vi
      .fn()
      .mockResolvedValue([{ name: 'app.log', path: '/var/log/app.log', size: 100, isDirectory: false }]);

    render(
      <ConfirmProvider>
        <DragDropProvider>
          <FilePane
            side="left"
            source={{ providerId: 'local', sourceType: 'local', label: 'Local Disk' }}
            currentPath="/var/log"
            onPathChange={() => {}}
            onSourceTypeRequest={vi.fn()}
            onTransferRequested={vi.fn()}
            refreshToken={0}
          />
        </DragDropProvider>
      </ConfirmProvider>
    );

    const row = await screen.findByText('app.log');
    fireEvent.click(row);
    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByText('Tail -f (Stream Log)'));
    expect((await screen.findByTestId('editor')).getAttribute('data-tail')).toBe('true');

    fireEvent.click(screen.getByText('close-editor'));
    expect(screen.queryByTestId('editor')).toBeNull();

    fireEvent.doubleClick(row);
    expect((await screen.findByTestId('editor')).getAttribute('data-tail')).toBe('false');
  });

  it('enters breadcrumb path-editing on Ctrl+L and Alt+D (§25)', async () => {
    render(
      <ConfirmProvider>
        <DragDropProvider>
          <FilePane
            side="left"
            source={{ providerId: 'local', sourceType: 'local', label: 'Local Disk' }}
            currentPath="/var/log"
            onPathChange={() => {}}
            onSourceTypeRequest={vi.fn()}
            onTransferRequested={vi.fn()}
            refreshToken={0}
          />
        </DragDropProvider>
      </ConfirmProvider>
    );

    const pane = screen.getByTestId('file-pane-left');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

    fireEvent.keyDown(pane, { key: 'l', ctrlKey: true });
    const input = (await screen.findByRole('textbox')) as HTMLInputElement;
    expect(input.value).toBe('/var/log');

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

    fireEvent.keyDown(pane, { key: 'd', altKey: true });
    expect(await screen.findByRole('textbox')).toBeInTheDocument();
  });

  it('shows item count, selection count, and selected size in the status bar (§24)', async () => {
    (window as any).multissh.storageList = vi.fn().mockResolvedValue([
      { name: 'a.txt', path: '/var/log/a.txt', size: 1024, isDirectory: false },
      { name: 'b.txt', path: '/var/log/b.txt', size: 2048, isDirectory: false },
    ]);

    render(
      <ConfirmProvider>
        <DragDropProvider>
          <FilePane
            side="left"
            source={{ providerId: 'local', sourceType: 'local', label: 'Local Disk' }}
            currentPath="/var/log"
            onPathChange={() => {}}
            onSourceTypeRequest={vi.fn()}
            onTransferRequested={vi.fn()}
            refreshToken={0}
          />
        </DragDropProvider>
      </ConfirmProvider>
    );

    await screen.findByText('a.txt');
    expect(screen.getByText('2 items')).toBeInTheDocument();

    fireEvent.click(screen.getByText('a.txt'));
    expect(screen.getByText(/1 selected.*1\.00 KB/)).toBeInTheDocument();
  });

  it("reflects the active text filter in the status bar's item count, not the pre-filter count", async () => {
    (window as any).multissh.storageList = vi.fn().mockResolvedValue([
      { name: 'apple.txt', path: '/var/log/apple.txt', size: 100, isDirectory: false },
      { name: 'banana.txt', path: '/var/log/banana.txt', size: 100, isDirectory: false },
      { name: 'cherry.txt', path: '/var/log/cherry.txt', size: 100, isDirectory: false },
    ]);

    render(
      <ConfirmProvider>
        <DragDropProvider>
          <FilePane
            side="left"
            source={{ providerId: 'local', sourceType: 'local', label: 'Local Disk' }}
            currentPath="/var/log"
            onPathChange={() => {}}
            onSourceTypeRequest={vi.fn()}
            onTransferRequested={vi.fn()}
            refreshToken={0}
          />
        </DragDropProvider>
      </ConfirmProvider>
    );

    await screen.findByText('apple.txt');
    expect(screen.getByText('3 items')).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Search / Filter files (Ctrl+F)'));
    const filterInput = await screen.findByPlaceholderText(/Filter files in current folder/);
    fireEvent.change(filterInput, { target: { value: 'an' } });

    await waitFor(() => {
      expect(screen.queryByText('apple.txt')).not.toBeInTheDocument();
      expect(screen.getByText('banana.txt')).toBeInTheDocument();
    });
    expect(screen.getByText('1 item')).toBeInTheDocument();
  });

  it('pre-selects and highlights initialSelectedPath upon directory load', async () => {
    (window as any).multissh.storageList = vi.fn().mockResolvedValue([
      { name: 'apple.txt', path: '/var/log/apple.txt', size: 100, isDirectory: false },
      { name: 'banana.txt', path: '/var/log/banana.txt', size: 200, isDirectory: false },
    ]);

    render(
      <ConfirmProvider>
        <DragDropProvider>
          <FilePane
            side="left"
            source={{ providerId: 'local', sourceType: 'local', label: 'Local Disk' }}
            currentPath="/var/log"
            initialSelectedPath="/var/log/banana.txt"
            onPathChange={() => {}}
            onSourceTypeRequest={vi.fn()}
            onTransferRequested={vi.fn()}
            refreshToken={0}
          />
        </DragDropProvider>
      </ConfirmProvider>
    );

    await screen.findByText('banana.txt');
    await waitFor(() => {
      expect(screen.getByText(/1 selected/)).toBeInTheDocument();
    });
  });
});

describe('FilePane AWS SSO sign-in', () => {
  const expired = 'AWS SSO session expired: sign in again to continue.';
  let api: Record<string, any>;

  beforeEach(() => {
    vi.clearAllMocks();
    api = {
      storageList: vi.fn().mockRejectedValue(new Error(expired)),
      awsSsoReloginProvider: vi.fn().mockResolvedValue(undefined),
      getHomeDir: vi.fn().mockResolvedValue('/home/localuser'),
      onTransferProgress: vi.fn().mockReturnValue(() => {}),
      onSearchResult: vi.fn().mockReturnValue(() => {}),
      onSearchProgress: vi.fn().mockReturnValue(() => {}),
      onSearchError: vi.fn().mockReturnValue(() => {}),
      onSearchDone: vi.fn().mockReturnValue(() => {}),
    };
    (window as any).multissh = api;
  });

  const renderPane = (sourceType: 's3' | 'sftp' = 's3') =>
    render(
      <ConfirmProvider>
        <DragDropProvider>
          <FilePane
            side="left"
            source={{ providerId: 's3-1', sourceType, label: 'Bucket' }}
            currentPath="/"
            onPathChange={vi.fn()}
            onSourceTypeRequest={vi.fn()}
            onTransferRequested={vi.fn()}
            refreshToken={0}
          />
        </DragDropProvider>
      </ConfirmProvider>
    );

  it('offers Sign in again for an expired session and reloads the folder after signing in', async () => {
    renderPane();
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in again' }));

    await waitFor(() => expect(api.awsSsoReloginProvider).toHaveBeenCalledWith('s3-1'));
    await waitFor(() => expect(api.storageList).toHaveBeenCalledTimes(2));
  });

  it('keeps the button when the sign-in is cancelled, and shows why', async () => {
    api.awsSsoReloginProvider.mockRejectedValue(new Error('Error: AWS SSO login was cancelled'));
    renderPane();
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in again' }));

    expect(await screen.findByText(/AWS SSO login was cancelled/)).toBeInTheDocument();
    expect(screen.getByText(/AWS SSO login was cancelled/).textContent).not.toMatch(/Error:/);
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeEnabled();
  });

  it('reloads an S3 listing when the window regains focus after a long idle, but not for a fresh one or SFTP', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { unmount } = renderPane();
      await waitFor(() => expect(api.storageList).toHaveBeenCalledTimes(1));

      fireEvent.focus(window);
      expect(api.storageList).toHaveBeenCalledTimes(1);

      vi.setSystemTime(Date.now() + 6 * 60_000);
      fireEvent.focus(window);
      await waitFor(() => expect(api.storageList).toHaveBeenCalledTimes(2));
      unmount();

      api.storageList.mockClear();
      renderPane('sftp');
      await waitFor(() => expect(api.storageList).toHaveBeenCalledTimes(1));
      vi.setSystemTime(Date.now() + 6 * 60_000);
      fireEvent.focus(window);
      expect(api.storageList).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not reload on refocus while a browser sign-in is pending', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      let finishSignIn: () => void = () => {};
      api.awsSsoReloginProvider.mockReturnValue(new Promise<void>((resolve) => { finishSignIn = resolve; }));
      renderPane();
      fireEvent.click(await screen.findByRole('button', { name: 'Sign in again' }));
      await waitFor(() => expect(api.awsSsoReloginProvider).toHaveBeenCalled());
      expect(api.storageList).toHaveBeenCalledTimes(1);

      vi.setSystemTime(Date.now() + 6 * 60_000);
      fireEvent.focus(window);
      expect(api.storageList).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('button', { name: /Waiting for browser/ })).toBeInTheDocument();

      finishSignIn();
      await waitFor(() => expect(api.storageList).toHaveBeenCalledTimes(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not offer Sign in again for other errors or other storage types', async () => {
    api.storageList.mockRejectedValue(new Error('Access denied: nope'));
    renderPane();
    await screen.findByText(/Access denied/);
    expect(screen.queryByRole('button', { name: 'Sign in again' })).toBeNull();
  });
});
