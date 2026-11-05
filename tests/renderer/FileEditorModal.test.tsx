// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render as rtlRender, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { FileEditorModal } from '../../src/renderer/src/components/FileManager/FileEditorModal';
import { OPEN_EDITOR_TAB_EVENT } from '../../src/renderer/src/lib/editorTabEvents';
import { ConfirmProvider } from '../../src/renderer/src/components/ConfirmDialog';
import type { FileEntry } from '../../src/shared/types/storage';

// The editor asks for confirmations through the app's ConfirmDialog, which needs its provider.
function render(ui: React.ReactElement) {
  const result = rtlRender(<ConfirmProvider>{ui}</ConfirmProvider>);
  return {
    ...result,
    rerender: (next: React.ReactElement) => result.rerender(<ConfirmProvider>{next}</ConfirmProvider>),
  };
}

describe('FileEditorModal', () => {
  const mockFileRead = vi.fn();
  const mockFileSave = vi.fn();
  const mockFileOpenExternal = vi.fn();
  const mockFileCloseExternal = vi.fn();
  const mockOnExternalFileStatus = vi.fn().mockReturnValue(() => {});
  const mockFileTailStart = vi.fn();
  const mockFileTailStop = vi.fn();
  const mockOnFileTailData = vi.fn().mockReturnValue(() => {});
  const mockOnFileTailError = vi.fn().mockReturnValue(() => {});

  const sampleEntry: FileEntry = {
    name: 'config.json',
    path: '/etc/app/config.json',
    size: 256,
    isDirectory: false,
    mtime: '2026-09-18 08:00',
  };

  beforeEach(() => {
    Range.prototype.getClientRects = () => [] as any;
    Range.prototype.getBoundingClientRect = () => ({
      bottom: 0,
      height: 0,
      left: 0,
      right: 0,
      top: 0,
      width: 0,
      x: 0,
      y: 0,
      toJSON: () => {},
    }) as any;
    mockFileRead.mockResolvedValue({
      content: '{\n  "port": 8080,\n  "host": "localhost"\n}',
      size: 45,
      isBinary: false,
      truncated: false,
    });
    mockFileSave.mockResolvedValue(undefined);
    mockFileOpenExternal.mockResolvedValue({ sessionToken: 'ext-tok-1', localPath: '/tmp/config.json' });
    mockFileCloseExternal.mockResolvedValue(undefined);
    mockFileTailStart.mockResolvedValue({ tailId: 'tail-123', initialContent: 'Log line 1\nLog line 2\n', size: 1024 });
    mockFileTailStop.mockResolvedValue(undefined);

    window.multissh = {
      ...(window.multissh || {}),
      fileRead: mockFileRead,
      fileSave: mockFileSave,
      fileOpenExternal: mockFileOpenExternal,
      fileCloseExternal: mockFileCloseExternal,
      onExternalFileStatus: mockOnExternalFileStatus,
      fileTailStart: mockFileTailStart,
      fileTailStop: mockFileTailStop,
      onFileTailData: mockOnFileTailData,
      onFileTailError: mockOnFileTailError,
    } as any;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('does not render when open is false or entry is null', () => {
    const { container: c1 } = render(
      <FileEditorModal
        open={false}
        providerId="sftp-1"
        sourceType="sftp"
        entry={sampleEntry}
        onClose={vi.fn()}
      />
    );
    expect(c1.firstChild).toBeNull();

    const { container: c2 } = render(
      <FileEditorModal
        open={true}
        providerId="sftp-1"
        sourceType="sftp"
        entry={null}
        onClose={vi.fn()}
      />
    );
    expect(c2.firstChild).toBeNull();
  });

  it('loads file content and displays file details in header and textarea', async () => {
    render(
      <FileEditorModal
        open={true}
        providerId="sftp-1"
        sourceType="sftp"
        entry={sampleEntry}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText('config.json')).toBeInTheDocument();
    expect(screen.getByText('sftp')).toBeInTheDocument();
    expect(screen.getByText('/etc/app/config.json')).toBeInTheDocument();

    await waitFor(() => {
      expect(mockFileRead).toHaveBeenCalledWith('sftp-1', '/etc/app/config.json');
      const editor = screen.getByTestId('code-editor');
      expect(editor.textContent).toContain('port');
    });

    // Check statusbar line count
    expect(screen.getByText('4 lines')).toBeInTheDocument();
  });

  it('detects changes, marks dirty state, and allows saving', async () => {
    const onSaved = vi.fn();
    render(
      <FileEditorModal
        open={true}
        providerId="sftp-1"
        sourceType="sftp"
        entry={sampleEntry}
        onClose={vi.fn()}
        onSaved={onSaved}
      />
    );

    await waitFor(() => {
      const editor = screen.getByTestId('code-editor');
      expect(editor.textContent).toContain('port');
    });

    const editor = screen.getByTestId('code-editor');
    act(() => {
      (editor as any).__cmChangeDoc('{\n  "port": 9000\n}');
    });

    // Should indicate unsaved changes
    await waitFor(() => {
      expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    });

    // Save button should be enabled
    const saveButton = screen.getByRole('button', { name: /Save/i });
    expect(saveButton).toBeEnabled();

    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(mockFileSave).toHaveBeenCalledWith('sftp-1', '/etc/app/config.json', '{\n  "port": 9000\n}');
      expect(onSaved).toHaveBeenCalled();
      expect(screen.getAllByText(/Saved/).length).toBeGreaterThanOrEqual(1);
    });
  });

  it('displays binary file warning when isBinary is true', async () => {
    mockFileRead.mockResolvedValueOnce({
      content: '',
      size: 1024,
      isBinary: true,
      truncated: false,
    });

    render(
      <FileEditorModal
        open={true}
        providerId="sftp-1"
        sourceType="sftp"
        entry={{ ...sampleEntry, name: 'binary.exe' }}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/Binary file detected/i)).toBeInTheDocument();
      expect(screen.getByText('Read-Only')).toBeInTheDocument();
    });
  });

  it('toggles search bar and matches query within content', async () => {
    render(
      <FileEditorModal
        open={true}
        providerId="sftp-1"
        sourceType="sftp"
        entry={sampleEntry}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('code-editor')).toBeInTheDocument();
    });

    // Toggle search
    const searchBtn = screen.getByTitle('Search (Ctrl+F)');
    fireEvent.click(searchBtn);

    const searchInput = screen.getByPlaceholderText(/Find in file/i);
    expect(searchInput).toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: 'port' } });
    expect(screen.getByText('1 of 1')).toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: 'nonexistent' } });
    expect(screen.getByText('No matches')).toBeInTheDocument();
  });

  it('toggles read-only and word-wrap states', async () => {
    render(
      <FileEditorModal
        open={true}
        providerId="sftp-1"
        sourceType="sftp"
        entry={sampleEntry}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('code-editor')).toBeInTheDocument();
    });

    // Toggle wrap
    const wrapBtn = screen.getByTitle('Disable Word Wrap');
    fireEvent.click(wrapBtn);
    expect(screen.getByTitle('Enable Word Wrap')).toBeInTheDocument();

    // Toggle read-only
    const lockBtn = screen.getByTitle('Switch to Read-Only Mode');
    fireEvent.click(lockBtn);
    expect(screen.getByText('Read-Only')).toBeInTheDocument();
  });

  it('launches external editor when External Editor button is clicked', async () => {
    render(
      <FileEditorModal
        open={true}
        providerId="sftp-1"
        sourceType="sftp"
        entry={sampleEntry}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('code-editor')).toBeInTheDocument();
    });

    const extBtn = screen.getByRole('button', { name: /External Editor/i });
    fireEvent.click(extBtn);

    await waitFor(() => {
      expect(mockFileOpenExternal).toHaveBeenCalledWith('sftp-1', '/etc/app/config.json');
      expect(screen.getByText(/External editor active/i)).toBeInTheDocument();
    });
  });

  it('starts Tail -f mode when isTailMode is true', async () => {
    render(
      <FileEditorModal
        open={true}
        providerId="sftp-1"
        sourceType="sftp"
        entry={sampleEntry}
        isTailMode={true}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(mockFileTailStart).toHaveBeenCalledWith('sftp-1', '/etc/app/config.json');
      expect(screen.getByText(/TAIL -F STREAM ACTIVE/i)).toBeInTheDocument();
      expect(screen.getByTestId('code-editor').textContent).toContain('Log line 1');
    });
  });

  // M10: fileTailStart resolved after the editor had been closed, and nobody was left to stop the tail.
  it('stops a tail that finished starting after the editor was closed', async () => {
    let finishTail!: (value: { tailId: string; initialContent: string; size: number }) => void;
    mockFileTailStart.mockImplementation(() => new Promise((resolve) => (finishTail = resolve)));

    const { unmount } = render(
      <FileEditorModal open={true} providerId="sftp-1" sourceType="sftp" entry={sampleEntry} onClose={vi.fn()} isTailMode={true} />
    );
    await waitFor(() => expect(mockFileTailStart).toHaveBeenCalled());
    unmount();
    mockFileTailStop.mockClear();

    await act(async () => finishTail({ tailId: 'late-tail', initialContent: 'x', size: 1 }));

    expect(mockFileTailStop).toHaveBeenCalledWith('late-tail');
  });

  it('displays large file warning for files > 20 MB and offers switch to Tail -f', async () => {
    const largeEntry: FileEntry = {
      ...sampleEntry,
      name: 'huge.log',
      size: 25 * 1024 * 1024, // 25 MB
    };

    render(
      <FileEditorModal
        open={true}
        providerId="sftp-1"
        sourceType="sftp"
        entry={largeEntry}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/Large file/i)).toBeInTheDocument();
    });

    const switchBtn = screen.getByRole('button', { name: /Switch to Tail -f/i });
    expect(switchBtn).toBeInTheDocument();

    fireEvent.click(switchBtn);

    await waitFor(() => {
      expect(mockFileTailStart).toHaveBeenCalledWith('sftp-1', '/etc/app/config.json');
      expect(screen.getByText(/TAIL -F STREAM ACTIVE/i)).toBeInTheDocument();
    });
  });

  it('confirms discard if user closes with unsaved changes', async () => {
    const nativeConfirm = vi.spyOn(window, 'confirm');
    const onClose = vi.fn();

    render(
      <FileEditorModal
        open={true}
        providerId="sftp-1"
        sourceType="sftp"
        entry={sampleEntry}
        onClose={onClose}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('code-editor')).toBeInTheDocument();
    });

    // Make change
    const editor = screen.getByTestId('code-editor');
    act(() => {
      (editor as any).__cmChangeDoc('dirty change');
    });

    await waitFor(() => {
      expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    });

    const closeBtn = screen.getByTitle('Close editor (Esc)');

    // The app's own dialog names the file and the consequence; the safe choice is the default
    fireEvent.click(closeBtn);
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(`Discard your unsaved changes to ${sampleEntry.name}?`);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus());

    // User keeps editing
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();

    // User discards
    fireEvent.click(closeBtn);
    fireEvent.click(await screen.findByRole('button', { name: 'Discard changes' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(nativeConfirm).not.toHaveBeenCalled();
  });

  it('asks before reloading over unsaved changes', async () => {
    render(
      <FileEditorModal
        open={true}
        providerId="sftp-1"
        sourceType="sftp"
        entry={sampleEntry}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('code-editor')).toBeInTheDocument();
    });
    act(() => {
      ((screen.getByTestId('code-editor')) as any).__cmChangeDoc('dirty change');
    });
    await waitFor(() => {
      expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    });

    const reads = (window.multissh.fileRead as ReturnType<typeof vi.fn>).mock.calls.length;
    fireEvent.click(screen.getByTitle('Reload from storage'));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Reloading discards your unsaved changes');

    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect((window.multissh.fileRead as ReturnType<typeof vi.fn>).mock.calls.length).toBe(reads);

    fireEvent.click(screen.getByTitle('Reload from storage'));
    fireEvent.click(await screen.findByRole('button', { name: 'Reload and discard' }));
    await waitFor(() =>
      expect((window.multissh.fileRead as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(reads)
    );
  });

  // M11 (code review 2026-11-03): the external editor event only carried the remote path, so a save on another
  // server's file with the same path reloaded this tab, and a reload replaced unsaved edits without asking.
  describe('external editor events', () => {
    function captureStatusListener() {
      let listener: ((event: any) => void) | undefined;
      mockOnExternalFileStatus.mockImplementation((cb: (event: any) => void) => {
        listener = cb;
        return () => {};
      });
      return (event: Record<string, unknown>) =>
        act(() => {
          listener?.({ sessionToken: 'other-token', remotePath: '/etc/app/config.json', status: 'uploaded', timestamp: '2026-11-03 12:00', ...event });
        });
    }
    const openEditor = () =>
      render(<FileEditorModal open={true} providerId="sftp-1" sourceType="sftp" entry={sampleEntry} onClose={vi.fn()} />);
    const reads = () => (window.multissh.fileRead as ReturnType<typeof vi.fn>).mock.calls.length;

    it('ignores an upload on another storage that happens to have the same path', async () => {
      const emit = captureStatusListener();
      openEditor();
      await waitFor(() => expect(screen.getByTestId('code-editor')).toBeInTheDocument());
      const before = reads();

      emit({ providerId: 'sftp-OTHER' });

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(reads()).toBe(before);
      expect(screen.queryByText(/Uploaded from external editor/)).not.toBeInTheDocument();
    });

    it('reloads when the upload is for this storage and path and there are no unsaved edits', async () => {
      const emit = captureStatusListener();
      openEditor();
      await waitFor(() => expect(screen.getByTestId('code-editor')).toBeInTheDocument());
      const before = reads();

      emit({ providerId: 'sftp-1' });

      await waitFor(() => expect(reads()).toBeGreaterThan(before));
    });

    it('asks before reloading over unsaved edits, and keeps them when the user declines', async () => {
      const emit = captureStatusListener();
      openEditor();
      await waitFor(() => expect(screen.getByTestId('code-editor')).toBeInTheDocument());
      act(() => {
        ((screen.getByTestId('code-editor')) as any).__cmChangeDoc('my unsaved edit');
      });
      await waitFor(() => expect(screen.getByText('Unsaved changes')).toBeInTheDocument());
      const before = reads();

      emit({ providerId: 'sftp-1' });

      const dialog = await screen.findByRole('alertdialog');
      expect(dialog).toHaveTextContent(/changed by the external editor/i);
      fireEvent.click(screen.getByRole('button', { name: 'Keep my edits' }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
      expect(reads()).toBe(before);
      expect(screen.getByText('Unsaved changes')).toBeInTheDocument();

      emit({ providerId: 'sftp-1' });
      fireEvent.click(await screen.findByRole('button', { name: 'Reload and discard' }));
      await waitFor(() => expect(reads()).toBeGreaterThan(before));
    });
  });

  it('does not trigger window.confirm when closing in embedded mode even if dirty', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const onClose = vi.fn();

    render(
      <FileEditorModal
        open={true}
        embedded={true}
        providerId="sftp-1"
        sourceType="sftp"
        entry={sampleEntry}
        onClose={onClose}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('code-editor')).toBeInTheDocument();
    });

    const editor = screen.getByTestId('code-editor');
    act(() => {
      (editor as any).__cmChangeDoc('dirty change in tab');
    });

    await waitFor(() => {
      expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    });

    const closeBtn = screen.getByTitle('Close tab');
    fireEvent.click(closeBtn);

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('highlights search hits and scrolls in markdown view mode and edit mode', async () => {
    const markdownEntry: FileEntry = {
      name: 'README.md',
      path: '/docs/README.md',
      size: 100,
      isDirectory: false,
      mtime: '2026-09-18 08:00',
    };

    mockFileRead.mockResolvedValueOnce({
      content: '# Hello world\n\nThis is a test of searching world in markdown.',
      size: 58,
      isBinary: false,
      truncated: false,
    });

    const scrollIntoViewMock = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scrollIntoViewMock;

    render(
      <FileEditorModal
        open={true}
        providerId="sftp-1"
        sourceType="sftp"
        entry={markdownEntry}
        onClose={vi.fn()}
      />
    );

    // In markdown mode, it opens in preview mode by default
    await waitFor(() => {
      expect(screen.getByText(/Hello world/)).toBeInTheDocument();
    });

    // Toggle search
    const searchBtn = screen.getByTitle('Search (Ctrl+F)');
    fireEvent.click(searchBtn);

    const searchInput = screen.getByPlaceholderText(/Find in file/i);
    fireEvent.change(searchInput, { target: { value: 'world' } });

    // In View mode, it highlights matches in the preview
    await waitFor(() => {
      const marks = document.querySelectorAll('mark.md-search-hit');
      expect(marks.length).toBe(2);
      expect(screen.getByText('1 of 2')).toBeInTheDocument();
      // First match should be active (sky-500)
      expect(marks[0]).toHaveClass('bg-sky-500');
      expect(marks[1]).toHaveClass('bg-amber-400/35');
      expect(scrollIntoViewMock).toHaveBeenCalled();
    });

    // Click Next
    const nextBtn = screen.getByRole('button', { name: 'Next' });
    fireEvent.click(nextBtn);

    await waitFor(() => {
      const marks = document.querySelectorAll('mark.md-search-hit');
      expect(screen.getByText('2 of 2')).toBeInTheDocument();
      expect(marks[0]).toHaveClass('bg-amber-400/35');
      expect(marks[1]).toHaveClass('bg-sky-500');
    });

    // Switch to Edit mode
    const editBtn = screen.getByTitle('Switch to Source (Edit)');
    fireEvent.click(editBtn);

    await waitFor(() => {
      expect(screen.getByTestId('code-editor')).toBeInTheDocument();
      expect(screen.getByText('2 of 2')).toBeInTheDocument();
    });

    // Close search
    fireEvent.keyDown(searchInput, { key: 'Escape' });
    expect(screen.queryByPlaceholderText(/Find in file/i)).not.toBeInTheDocument();
  });

  it('does not re-read or discard unsaved changes when entry reference changes with same path', async () => {
    const { rerender } = render(
      <FileEditorModal
        open={true}
        providerId="sftp-1"
        sourceType="sftp"
        entry={{ ...sampleEntry }}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('code-editor')).toBeInTheDocument();
    });

    const editor = screen.getByTestId('code-editor');
    act(() => {
      (editor as any).__cmChangeDoc('{\n  "port": 9000\n}');
    });

    await waitFor(() => {
      expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    });

    // Parent re-renders (e.g. perf metrics sample arrived in TerminalView)
    // passing a new entry object with same path
    rerender(
      <FileEditorModal
        open={true}
        providerId="sftp-1"
        sourceType="sftp"
        entry={{ ...sampleEntry }}
        onClose={vi.fn()}
      />
    );

    // Unsaved changes MUST remain, and fileRead should NOT have been called again
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    expect(mockFileRead).toHaveBeenCalledTimes(1);
  });

  it('honors initialMode="source" for markdown files to open directly in edit mode', async () => {
    const markdownEntry: FileEntry = {
      name: 'notes.md',
      path: '/home/user/notes.md',
      size: 100,
      isDirectory: false,
    };

    render(
      <FileEditorModal
        open={true}
        providerId="sftp-1"
        sourceType="sftp"
        initialMode="source"
        entry={markdownEntry}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('code-editor')).toBeInTheDocument();
    });
  });

  it('renders ImageViewer for raster image without binary warning banner', async () => {
    mockFileRead.mockResolvedValueOnce({
      content: '',
      size: 1024,
      isBinary: true,
      truncated: false,
      base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      mimeType: 'image/png',
    });

    const imageEntry: FileEntry = {
      name: 'logo.png',
      path: '/var/www/logo.png',
      size: 0,
      isDirectory: false,
    };

    render(
      <FileEditorModal
        open={true}
        providerId="sftp-1"
        sourceType="sftp"
        entry={imageEntry}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('image-viewer')).toBeInTheDocument();
    });

    // Should display size from fileRead (1024 bytes -> 1.00 KB) even though entry.size was 0
    expect(screen.getByText('1.00 KB')).toBeInTheDocument();

    // Binary warning banner should NOT be displayed for supported image files
    expect(screen.queryByText(/Binary file detected/i)).not.toBeInTheDocument();
    // Tail -f button should be hidden for image files
    expect(screen.queryByRole('button', { name: /Tail -f/i })).not.toBeInTheDocument();
  });

  it('renders dual-mode segmented control for SVG and toggles between Preview and Source', async () => {
    mockFileRead.mockResolvedValueOnce({
      content: '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" /></svg>',
      size: 65,
      isBinary: false,
      truncated: false,
      mimeType: 'image/svg+xml',
    });

    const svgEntry: FileEntry = {
      name: 'icon.svg',
      path: '/var/www/icon.svg',
      size: 65,
      isDirectory: false,
    };

    render(
      <FileEditorModal
        open={true}
        providerId="sftp-1"
        sourceType="sftp"
        entry={svgEntry}
        onClose={vi.fn()}
      />
    );

    // Defaults to preview mode
    await waitFor(() => {
      expect(screen.getByTestId('image-viewer')).toBeInTheDocument();
    });

    // Switch to Source
    const sourceBtn = screen.getByRole('button', { name: /Source/i });
    fireEvent.click(sourceBtn);

    await waitFor(() => {
      expect(screen.getByTestId('code-editor')).toBeInTheDocument();
    });
  });

  it('renders HtmlPreview for HTML files and supports switching to Source', async () => {
    mockFileRead.mockResolvedValueOnce({
      content: '<h1>Hello World</h1><p>Test HTML</p>',
      size: 35,
      isBinary: false,
      truncated: false,
      mimeType: 'text/html',
    });

    const htmlEntry: FileEntry = {
      name: 'index.html',
      path: '/var/www/index.html',
      size: 35,
      isDirectory: false,
    };

    render(
      <FileEditorModal
        open={true}
        providerId="sftp-1"
        sourceType="sftp"
        entry={htmlEntry}
        onClose={vi.fn()}
      />
    );

    // HTML opens in preview mode by default
    await waitFor(() => {
      expect(screen.getByTestId('html-preview')).toBeInTheDocument();
    });

    // Switch to Source
    const sourceBtn = screen.getByRole('button', { name: /Source/i });
    fireEvent.click(sourceBtn);

    await waitFor(() => {
      expect(screen.getByTestId('code-editor')).toBeInTheDocument();
    });
  });

  it('renders CsvTablePreview with Table tab for CSV/TSV files', async () => {
    mockFileRead.mockResolvedValueOnce({
      content: 'name,role,age\nAlice,Admin,30\nBob,User,25',
      size: 40,
      isBinary: false,
      truncated: false,
      mimeType: 'text/csv',
    });

    const csvEntry: FileEntry = {
      name: 'users.csv',
      path: '/var/data/users.csv',
      size: 40,
      isDirectory: false,
    };

    render(
      <FileEditorModal
        open={true}
        providerId="sftp-1"
        sourceType="sftp"
        entry={csvEntry}
        onClose={vi.fn()}
      />
    );

    // CSV opens in table preview mode by default
    await waitFor(() => {
      expect(screen.getByTestId('csv-table-preview')).toBeInTheDocument();
      expect(screen.getByText('Alice')).toBeInTheDocument();
      expect(screen.getByText('Bob')).toBeInTheDocument();
    });

    // Switch to Source
    const sourceBtn = screen.getByRole('button', { name: /Source/i });
    fireEvent.click(sourceBtn);

    await waitFor(() => {
      expect(screen.getByTestId('code-editor')).toBeInTheDocument();
    });
  });

  it('renders PdfViewer for PDF files with document badge', async () => {
    mockFileRead.mockResolvedValueOnce({
      content: '',
      size: 2048,
      isBinary: true,
      truncated: false,
      base64: 'JVBERi0xLjQKJXRlc3Q=',
      mimeType: 'application/pdf',
    });

    const pdfEntry: FileEntry = {
      name: 'invoice.pdf',
      path: '/var/docs/invoice.pdf',
      size: 2048,
      isDirectory: false,
    };

    render(
      <FileEditorModal
        open={true}
        providerId="sftp-1"
        sourceType="sftp"
        entry={pdfEntry}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(mockFileRead).toHaveBeenCalledWith('sftp-1', '/var/docs/invoice.pdf', 100 * 1024 * 1024);
      expect(screen.getByTestId('pdf-viewer')).toBeInTheDocument();
      expect(screen.getAllByText(/PDF Document/).length).toBeGreaterThanOrEqual(1);
    });

    // Binary warning banner should NOT be displayed for PDF files
    expect(screen.queryByText(/Binary file detected/i)).not.toBeInTheDocument();
  });

  it('formats JSON file when Format button is clicked', async () => {
    mockFileRead.mockResolvedValueOnce({
      content: '{"a":1,"b":2}',
      size: 13,
      isBinary: false,
      truncated: false,
      mimeType: 'application/json',
    });

    const jsonEntry: FileEntry = {
      name: 'settings.json',
      path: '/etc/settings.json',
      size: 13,
      isDirectory: false,
    };

    render(
      <FileEditorModal
        open={true}
        providerId="sftp-1"
        sourceType="sftp"
        entry={jsonEntry}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('code-editor')).toBeInTheDocument();
    });

    const formatBtn = screen.getByRole('button', { name: /Format/i });
    expect(formatBtn).toBeInTheDocument();

    fireEvent.click(formatBtn);

    // Unsaved changes should now be detected
    await waitFor(() => {
      expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    });
  });

  it('does not flag unsaved changes when opening a file with CRLF line endings in source mode, and preserves CRLF on save', async () => {
    mockFileRead.mockResolvedValueOnce({
      content: 'col1,col2\r\nval1,val2\r\n',
      size: 22,
      isBinary: false,
      truncated: false,
      mimeType: 'text/csv',
    });

    const csvEntry: FileEntry = {
      name: 'data.csv',
      path: '/var/data.csv',
      size: 22,
      isDirectory: false,
    };

    render(
      <FileEditorModal
        open={true}
        providerId="sftp-1"
        sourceType="sftp"
        entry={csvEntry}
        initialMode="source"
        onClose={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('code-editor')).toBeInTheDocument();
    });

    // Must NOT flag unsaved changes right after loading
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
    const saveButton = screen.getByRole('button', { name: /Save/i });
    expect(saveButton).toBeDisabled();

    // Now edit document and verify CRLF is preserved on save
    const editor = screen.getByTestId('code-editor');
    act(() => {
      (editor as any).__cmChangeDoc('col1,col2\nval1,val3\n');
    });

    await waitFor(() => {
      expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    });
    expect(saveButton).toBeEnabled();

    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(mockFileSave).toHaveBeenCalledWith('sftp-1', '/var/data.csv', 'col1,col2\r\nval1,val3\r\n');
    });
  });

  it('dispatches OPEN_EDITOR_TAB_EVENT and closes modal when Detach to tab button is clicked', async () => {
    const onClose = vi.fn();
    const handleOpenTab = vi.fn();
    window.addEventListener(OPEN_EDITOR_TAB_EVENT, handleOpenTab);

    render(
      <FileEditorModal
        open={true}
        providerId="local"
        sourceType="local"
        entry={sampleEntry}
        onClose={onClose}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('code-editor')).toBeInTheDocument();
    });

    const detachBtn = screen.getByRole('button', { name: /Detach to tab/i });
    expect(detachBtn).toBeInTheDocument();

    fireEvent.click(detachBtn);

    expect(handleOpenTab).toHaveBeenCalledTimes(1);
    const event = handleOpenTab.mock.calls[0][0] as CustomEvent;
    expect(event.detail).toEqual({
      providerId: 'local',
      sourceType: 'local',
      entry: sampleEntry,
      initialMode: 'source',
      isTailMode: false,
      initialContent: '{\n  "port": 8080,\n  "host": "localhost"\n}',
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    window.removeEventListener(OPEN_EDITOR_TAB_EVENT, handleOpenTab);
  });

  it('hides Detach to tab and Maximize buttons when embedded=true', async () => {
    render(
      <FileEditorModal
        open={true}
        embedded={true}
        providerId="local"
        sourceType="local"
        entry={sampleEntry}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('code-editor')).toBeInTheDocument();
    });

    expect(screen.queryByRole('button', { name: /Detach to tab/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Maximize editor/i })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: `Editing ${sampleEntry.name}` })).toBeInTheDocument();
  });

  it('uses initialContentOverride and fires onDirtyChange', async () => {
    const onDirtyChange = vi.fn();
    render(
      <FileEditorModal
        open={true}
        embedded={true}
        providerId="local"
        sourceType="local"
        entry={sampleEntry}
        initialContentOverride="modified content from detach"
        onDirtyChange={onDirtyChange}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    });

    expect(onDirtyChange).toHaveBeenCalledWith(true);
  });
});

