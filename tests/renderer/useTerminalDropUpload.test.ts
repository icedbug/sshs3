// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTerminalDropUpload, shellQuote, isUnpasteableWindowsPath, isSafeEntryName } from '../../src/renderer/src/lib/useTerminalDropUpload';
import type { SSHConnectionConfig } from '../../src/shared/types/ssh';

describe('useTerminalDropUpload', () => {
  const sampleConfig: SSHConnectionConfig = {
    id: 'ssh-1',
    name: 'Server',
    host: 'server.example.com',
    port: 22,
    username: 'deploy',
    authType: 'password',
  };

  beforeEach(() => {
    window.multissh = {
      ...(window.multissh || {}),
      connectStorage: vi.fn().mockResolvedValue({ id: 'sftp-ssh-1' }),
      transferAdd: vi.fn().mockResolvedValue({ jobId: 'job-1' }),
    } as any;
  });

  const entry = (name: string, path: string) => ({ name, path, size: 1, isDirectory: false });
  const internalDrag = (providerId: string, entries: ReturnType<typeof entry>[]) => ({
    fromPane: 'left',
    providerId,
    basePath: '/',
    entries,
  });
  const dropWith = (payload: unknown) =>
    ({
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      dataTransfer: {
        getData: vi.fn((mime: string) =>
          mime === 'application/x-multissh-file-entries' ? JSON.stringify(payload) : ''
        ),
      },
    }) as any;

  describe('shellQuote on Windows paths', () => {
    it('double-quotes a local Windows path', () => {
      expect(shellQuote('C:\\Users\\alun\\my file.txt')).toBe('"C:\\Users\\alun\\my file.txt"');
    });

    it('uses PowerShell literal quoting when the path could expand inside double quotes', () => {
      expect(shellQuote('C:\\tmp\\a$(calc).txt')).toBe("'C:\\tmp\\a$(calc).txt'");
      expect(shellQuote('C:\\tmp\\50%.txt')).toBe("'C:\\tmp\\50%.txt'");
      expect(shellQuote('C:\\tmp\\a`b.txt')).toBe("'C:\\tmp\\a`b.txt'");
      expect(shellQuote("C:\\tmp\\it's $x.txt")).toBe("'C:\\tmp\\it''s $x.txt'");
    });

    it('doubles typographic single quotes and avoids double quotes around typographic double quotes', () => {
      expect(shellQuote('C:\\tmp\\a\u2019b$.txt')).toBe("'C:\\tmp\\a\u2019\u2019b$.txt'");
      expect(shellQuote('C:\\tmp\\a\u201Db.txt')).toBe("'C:\\tmp\\a\u201Db.txt'");
    });

    it('flags paths that no single quoting makes safe for both shells', () => {
      expect(isUnpasteableWindowsPath('C:\\tmp\\a$&calc.txt')).toBe(true);
      expect(isUnpasteableWindowsPath('C:\\tmp\\a&b.txt')).toBe(false);
      expect(isUnpasteableWindowsPath('C:\\tmp\\a$b.txt')).toBe(false);
      expect(isUnpasteableWindowsPath('/tmp/a$&b')).toBe(false);
    });
  });

  describe('shellQuote', () => {
    it('wraps paths in single quotes and escapes single quotes inside', () => {
      expect(shellQuote('/var/log/syslog')).toBe("'/var/log/syslog'");
      expect(shellQuote("/path/with 'quotes'")).toBe("'/path/with '\\''quotes'\\'''");
    });
  });

  it('toggles isDragging on dragEnter and dragLeave', () => {
    const { result } = renderHook(() =>
      useTerminalDropUpload({
        isRemote: false,
        targetFolder: '/home/user',
        onPaste: vi.fn(),
        onNotice: vi.fn(),
      })
    );

    expect(result.current.isDragging).toBe(false);

    const fakeDragEnterEvent = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      dataTransfer: { types: ['Files'] },
    } as any;

    act(() => {
      result.current.dragHandlers.onDragEnter(fakeDragEnterEvent);
    });

    expect(result.current.isDragging).toBe(true);

    const fakeDragLeaveEvent = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as any;

    act(() => {
      result.current.dragHandlers.onDragLeave(fakeDragLeaveEvent);
    });

    expect(result.current.isDragging).toBe(false);
  });

  it('clears the overlay when the drag ends without a drop or dragleave on the terminal', () => {
    const { result } = renderHook(() =>
      useTerminalDropUpload({ isRemote: false, targetFolder: '/home/user', onPaste: vi.fn(), onNotice: vi.fn() })
    );
    const enter = () =>
      act(() => {
        result.current.dragHandlers.onDragEnter({
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
          dataTransfer: { types: ['Files'] },
        } as any);
      });

    for (const name of ['dragend', 'pointermove', 'keydown']) {
      enter();
      expect(result.current.isDragging).toBe(true);
      act(() => {
        window.dispatchEvent(new Event(name));
      });
      expect(result.current.isDragging).toBe(false);
    }
  });

  it('pastes local file paths directly when dropping in local session', async () => {
    const onPaste = vi.fn();
    const { result } = renderHook(() =>
      useTerminalDropUpload({
        isRemote: false,
        targetFolder: '/home/user',
        onPaste,
        onNotice: vi.fn(),
      })
    );

    const fakeFile = {
      name: 'report.pdf',
      path: '/home/user/Downloads/report.pdf',
    };

    const fakeDropEvent = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      dataTransfer: {
        files: [fakeFile],
      },
    } as any;

    await act(async () => {
      await result.current.dragHandlers.onDrop(fakeDropEvent);
    });

    expect(onPaste).toHaveBeenCalledWith("'/home/user/Downloads/report.pdf'");
  });

  it('never pastes or uploads names carrying control characters', async () => {
    // Ctrl+U / Ctrl+C / CR / the end of a bracketed paste act before the shell parses the quotes.
    for (const bad of ['a\u0015b', 'a\u0003b', 'a\nb', 'a\rb', 'a\u001b[201~b', 'a\u007fb']) {
      expect(isSafeEntryName(bad)).toBe(false);
    }
    expect(isSafeEntryName('report final (1).pdf')).toBe(true);

    const onPaste = vi.fn();
    const onNotice = vi.fn();
    const { result } = renderHook(() =>
      useTerminalDropUpload({ isRemote: false, targetFolder: '/home/user', onPaste, onNotice })
    );
    const drop = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      dataTransfer: { files: [{ name: 'x', path: "/tmp/'\u0015rm -rf ~\u0015" }, { name: 'ok.txt', path: '/tmp/ok.txt' }] },
    } as any;
    await act(async () => {
      await result.current.dragHandlers.onDrop(drop);
    });
    expect(onPaste).toHaveBeenCalledTimes(1);
    expect(onPaste).toHaveBeenCalledWith("'/tmp/ok.txt'");
    expect(onNotice).toHaveBeenCalled();
  });

  it('uploads to remote CWD via SFTP and pastes remote path when dropping in SSH session', async () => {
    const onPaste = vi.fn();
    const onNotice = vi.fn();
    window.multissh.getPathForFile = vi.fn().mockReturnValue('/home/user/Downloads/archive.tar.gz');

    const { result } = renderHook(() =>
      useTerminalDropUpload({
        isRemote: true,
        config: sampleConfig,
        targetFolder: '/var/www/site',
        onPaste,
        onNotice,
      })
    );

    // In modern Electron, DOM File has no .path property:
    const fakeFile = {
      name: 'archive.tar.gz',
    };

    const fakeDropEvent = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      dataTransfer: {
        files: [fakeFile],
        getData: vi.fn(),
      },
    } as any;

    await act(async () => {
      await result.current.dragHandlers.onDrop(fakeDropEvent);
    });

    expect(window.multissh.getPathForFile).toHaveBeenCalledWith(fakeFile);

    expect(window.multissh.connectStorage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'local',
        type: 'local',
      })
    );

    expect(window.multissh.connectStorage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'sftp-ssh-1',
        type: 'sftp',
      })
    );

    expect(window.multissh.transferAdd).toHaveBeenCalledWith({
      sourceProviderId: 'local',
      sourcePath: '/home/user/Downloads/archive.tar.gz',
      targetProviderId: 'sftp-ssh-1',
      targetPath: '/var/www/site/archive.tar.gz',
    });

    expect(onNotice).toHaveBeenCalledWith('Uploading archive.tar.gz...');
    expect(onPaste).toHaveBeenCalledWith("'/var/www/site/archive.tar.gz'");
  });

  it('handles internal drag from sshs3 file manager on remote SSH host', async () => {
    const onPaste = vi.fn();
    const { result } = renderHook(() =>
      useTerminalDropUpload({
        isRemote: true,
        config: sampleConfig,
        targetFolder: '/var/www/site',
        onPaste,
        onNotice: vi.fn(),
      })
    );

    const internalPayload = internalDrag('sftp-ssh-1', [entry('app.log', '/var/log/app.log')]);

    const fakeDropEvent = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      dataTransfer: {
        getData: vi.fn((mime: string) =>
          mime === 'application/x-multissh-file-entries' ? JSON.stringify(internalPayload) : ''
        ),
      },
    } as any;

    await act(async () => {
      await result.current.dragHandlers.onDrop(fakeDropEvent);
    });

    expect(onPaste).toHaveBeenCalledWith("'/var/log/app.log'");
    expect(window.multissh.transferAdd).not.toHaveBeenCalled();
  });

  it('uploads internal drags from other providers and reports transfer errors', async () => {
    const onPaste = vi.fn();
    const onNotice = vi.fn();
    const { result } = renderHook(() =>
      useTerminalDropUpload({ isRemote: true, config: sampleConfig, targetFolder: '/srv', onPaste, onNotice })
    );

    await act(async () => {
      await result.current.dragHandlers.onDrop(dropWith(internalDrag('local', [entry('a.txt', '/tmp/a.txt')])));
    });
    expect(window.multissh.transferAdd).toHaveBeenCalledWith({
      sourceProviderId: 'local',
      sourcePath: '/tmp/a.txt',
      targetProviderId: 'sftp-ssh-1',
      targetPath: '/srv/a.txt',
    });
    expect(onPaste).toHaveBeenCalledWith("'/srv/a.txt'");

    onPaste.mockClear();
    (window.multissh.transferAdd as any).mockRejectedValueOnce(new Error('disk full'));
    await act(async () => {
      await result.current.dragHandlers.onDrop(dropWith(internalDrag('local', [entry('b.txt', '/tmp/b.txt')])));
    });
    expect(onNotice).toHaveBeenCalledWith('Upload failed: disk full');
    expect(onPaste).not.toHaveBeenCalled();
  });

  it('rejects malformed payloads and entry names that could escape the destination', async () => {
    const onPaste = vi.fn();
    const onNotice = vi.fn();
    const { result } = renderHook(() =>
      useTerminalDropUpload({ isRemote: true, config: sampleConfig, targetFolder: '/srv', onPaste, onNotice })
    );

    await act(async () => {
      await result.current.dragHandlers.onDrop(dropWith(internalDrag('local', [entry('../etc/passwd', '/tmp/x')])));
    });
    expect(onNotice).toHaveBeenCalledWith('Cannot drop files with unsupported names');
    expect(window.multissh.transferAdd).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.dragHandlers.onDrop(dropWith({ providerId: 'local', entries: [{ name: 'a', path: '/a' }] }));
    });
    expect(window.multissh.transferAdd).not.toHaveBeenCalled();
    expect(onPaste).not.toHaveBeenCalled();
  });

  it('tells the user when remote files are dropped into a local terminal', async () => {
    const onPaste = vi.fn();
    const onNotice = vi.fn();
    const { result } = renderHook(() =>
      useTerminalDropUpload({ isRemote: false, targetFolder: '', onPaste, onNotice })
    );

    await act(async () => {
      await result.current.dragHandlers.onDrop(dropWith(internalDrag('sftp-x', [entry('a', '/a')])));
    });
    expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('copy them to the local disk'));
    expect(onPaste).not.toHaveBeenCalled();
  });

  it('uploads into the container for Kubernetes terminals', async () => {
    const onPaste = vi.fn();
    const k8sTarget = { contextName: 'c', namespace: 'n', podName: 'p', containerName: 'x' };
    const { result } = renderHook(() =>
      useTerminalDropUpload({ isRemote: false, k8sTarget, targetFolder: '/app', onPaste, onNotice: vi.fn() })
    );

    await act(async () => {
      await result.current.dragHandlers.onDrop(dropWith(internalDrag('local', [entry('a.txt', '/tmp/a.txt')])));
    });
    expect(window.multissh.transferAdd).toHaveBeenCalledWith(
      expect.objectContaining({ targetProviderId: 'k8s-c/n/p/x', targetPath: '/app/a.txt' })
    );
    expect(onPaste).toHaveBeenCalledWith("'/app/a.txt'");
  });

  it('pastes the path the transfer really wrote to and skips skipped uploads', async () => {
    const onPaste = vi.fn();
    const onNotice = vi.fn();
    (window.multissh.transferAdd as any)
      .mockResolvedValueOnce({ jobId: 'j1', targetPath: '/srv/a (1).txt' })
      .mockResolvedValueOnce({ jobId: null, skipped: true, targetPath: '/srv/b.txt' });
    const { result } = renderHook(() =>
      useTerminalDropUpload({ isRemote: true, config: sampleConfig, targetFolder: '/srv', onPaste, onNotice })
    );

    await act(async () => {
      await result.current.dragHandlers.onDrop(
        dropWith(internalDrag('local', [entry('a.txt', '/tmp/a.txt'), entry('b.txt', '/tmp/b.txt')]))
      );
    });
    expect(onPaste).toHaveBeenCalledWith("'/srv/a (1).txt'");
    expect(onNotice).toHaveBeenCalledWith('Uploading a.txt...');
  });

  it('says so when every upload was skipped and pastes nothing', async () => {
    const onPaste = vi.fn();
    const onNotice = vi.fn();
    (window.multissh.transferAdd as any).mockResolvedValue({ jobId: null, skipped: true });
    const { result } = renderHook(() =>
      useTerminalDropUpload({ isRemote: true, config: sampleConfig, targetFolder: '/srv', onPaste, onNotice })
    );
    await act(async () => {
      await result.current.dragHandlers.onDrop(dropWith(internalDrag('local', [entry('a.txt', '/tmp/a.txt')])));
    });
    expect(onNotice).toHaveBeenCalledWith('Upload skipped');
    expect(onPaste).not.toHaveBeenCalled();
  });

  it('refuses to upload while the current directory is unknown', async () => {
    const onPaste = vi.fn();
    const onNotice = vi.fn();
    const { result } = renderHook(() =>
      useTerminalDropUpload({ isRemote: true, config: sampleConfig, targetFolder: '', onPaste, onNotice })
    );
    await act(async () => {
      await result.current.dragHandlers.onDrop(dropWith(internalDrag('local', [entry('a.txt', '/tmp/a.txt')])));
    });
    expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('current directory is not known'));
    expect(window.multissh.transferAdd).not.toHaveBeenCalled();
    expect(onPaste).not.toHaveBeenCalled();
  });
});
