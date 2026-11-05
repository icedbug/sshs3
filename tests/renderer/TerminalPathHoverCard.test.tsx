// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TerminalPathHoverCard } from '../../src/renderer/src/components/TerminalPathHoverCard';

describe('TerminalPathHoverCard', () => {
  it('renders file details with correct category badge', () => {
    render(
      <TerminalPathHoverCard
        path="/etc/nginx/nginx.conf"
        x={100}
        y={100}
        onClose={vi.fn()}
        onCopyPath={vi.fn()}
      />
    );

    expect(screen.getByText('nginx.conf')).toBeInTheDocument();
    expect(screen.getByText('/etc/nginx/nginx.conf')).toBeInTheDocument();
    expect(screen.getByText('Configuration')).toBeInTheDocument();
  });

  it('does not extend its hit area back to the pointer', () => {
    render(<TerminalPathHoverCard path="/var/log/app.log" x={50} y={50} onClose={vi.fn()} onCopyPath={vi.fn()} />);
    const card = screen.getByTestId('terminal-path-hover-card');

    // It opens 12px right of and 16px below the pointer. An invisible strip reaching back towards the
    // pointer (a `before:` pseudo-element) would lie under it, so the pointer would be "inside" the card
    // the moment it opens and the terminal would stop reporting the link.
    expect(card.className).not.toMatch(/before:/);
    expect(card.style.left).toBe('62px');
    expect(card.style.top).toBe('66px');
  });

  it('caps its height to the room on its side of the pointer so it cannot slide over it', () => {
    const original = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', { value: 520, configurable: true, writable: true });
    try {
      render(<TerminalPathHoverCard path="/var/log/app.log" x={50} y={250} onClose={vi.fn()} onCopyPath={vi.fn()} />);
      const card = screen.getByTestId('terminal-path-hover-card');
      // 520 high with the pointer at 250: 238px of room below it (the side it opens on), 218px above it.
      expect(card.style.maxHeight).toBe('238px');
      expect(card.className).toContain('overflow-y-auto');
    } finally {
      Object.defineProperty(window, 'innerHeight', { value: original, configurable: true, writable: true });
    }
  });

  it('triggers onCopyPath when copy button is clicked', () => {
    const onCopyPath = vi.fn();
    render(
      <TerminalPathHoverCard
        path="/var/log/app.log"
        x={50}
        y={50}
        onClose={vi.fn()}
        onCopyPath={onCopyPath}
      />
    );

    const copyBtn = screen.getByRole('button', { name: /copy path/i });
    fireEvent.click(copyBtn);
    expect(onCopyPath).toHaveBeenCalledWith('/var/log/app.log');
  });

  it('shows Edit button for files and calls onOpenEditor', () => {
    const onOpenEditor = vi.fn();
    render(
      <TerminalPathHoverCard
        path="/app/server.ts"
        x={50}
        y={50}
        onClose={vi.fn()}
        onCopyPath={vi.fn()}
        onOpenEditor={onOpenEditor}
      />
    );

    const editBtn = screen.getByRole('button', { name: /edit/i });
    fireEvent.click(editBtn);
    expect(onOpenEditor).toHaveBeenCalledWith('/app/server.ts');
  });

  it('shows Browse button for directories instead of Edit', () => {
    const onOpenPath = vi.fn();
    const onOpenEditor = vi.fn();
    render(
      <TerminalPathHoverCard
        path="/var/log/"
        x={50}
        y={50}
        onClose={vi.fn()}
        onCopyPath={vi.fn()}
        onOpenPath={onOpenPath}
        onOpenEditor={onOpenEditor}
      />
    );

    expect(screen.getByText('Browse')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /browse/i }));
    expect(onOpenPath).toHaveBeenCalledWith('/var/log/');
  });

  it('resolves relative file paths against currentCwd when provided', () => {
    render(
      <TerminalPathHoverCard
        path="nginx.conf"
        currentCwd="/etc/nginx"
        userHome="/home/alun"
        x={50}
        y={50}
        onClose={vi.fn()}
        onCopyPath={vi.fn()}
      />
    );

    expect(screen.getByText('nginx.conf')).toBeInTheDocument();
    expect(screen.getByText('/etc/nginx/nginx.conf')).toBeInTheDocument();
  });

  it('shows Copied feedback when copy button is clicked', () => {
    const onCopyPath = vi.fn();
    render(
      <TerminalPathHoverCard
        path="/var/log/app.log"
        x={50}
        y={50}
        onClose={vi.fn()}
        onCopyPath={onCopyPath}
      />
    );

    const copyBtn = screen.getByRole('button', { name: /copy path/i });
    fireEvent.click(copyBtn);
    expect(screen.getByText('Copied')).toBeInTheDocument();
  });

  it('shows View button for image files and Edit for editable files', () => {
    const onOpenEditor = vi.fn();
    const { rerender } = render(
      <TerminalPathHoverCard
        path="/var/www/logo.png"
        x={50}
        y={50}
        onClose={vi.fn()}
        onCopyPath={vi.fn()}
        onOpenEditor={onOpenEditor}
      />
    );

    expect(screen.getByRole('button', { name: /^view$/i })).toBeInTheDocument();

    rerender(
      <TerminalPathHoverCard
        path="/var/www/server.py"
        x={50}
        y={50}
        onClose={vi.fn()}
        onCopyPath={vi.fn()}
        onOpenEditor={onOpenEditor}
      />
    );

    expect(screen.getByRole('button', { name: /^edit$/i })).toBeInTheDocument();
  });

  it('loads and renders preview snippet for text files when providerId is supplied', async () => {
    const mockFileRead = vi.fn().mockResolvedValue({
      content: 'flask==3.0.0\nrequests>=2.31.0\npandas==2.1.0\n',
      size: 50,
      isBinary: false,
    });
    (window as any).multissh = { fileRead: mockFileRead };

    render(
      <TerminalPathHoverCard
        path="/app/requirements.txt"
        providerId="local"
        x={50}
        y={50}
        onClose={vi.fn()}
        onCopyPath={vi.fn()}
      />
    );

    expect(await screen.findByText('flask==3.0.0')).toBeInTheDocument();
    expect(screen.getByText('requests>=2.31.0')).toBeInTheDocument();
  });

  it('never reads a file or checks a certificate on a network share, and offers no drag-out for it', async () => {
    // Opening \\server\share\x from here would make Windows send the user's NetNTLMv2 credentials to it.
    const mockFileRead = vi.fn().mockResolvedValue({ content: 'x', size: 1, isBinary: false });
    const mockCertificatePreview = vi.fn().mockResolvedValue(undefined);
    const mockDragOutStart = vi.fn();
    (window as any).multissh = {
      fileRead: mockFileRead,
      certificatePreview: mockCertificatePreview,
      dragOutStart: mockDragOutStart,
    };

    render(
      <TerminalPathHoverCard
        path={'\\\\attacker.example.com\\share\\server.pem'}
        providerId="local"
        x={50}
        y={50}
        onClose={vi.fn()}
        onCopyPath={vi.fn()}
      />
    );
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(mockFileRead).not.toHaveBeenCalled();
    expect(mockCertificatePreview).not.toHaveBeenCalled();
    expect(document.querySelector('[draggable="true"]')).toBeNull();
  });

  it('loads and renders image thumbnail preview when providerId is supplied for images', async () => {
    const mockFileRead = vi.fn().mockResolvedValue({
      content: '',
      isBinary: true,
      base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      mimeType: 'image/png',
      size: 68,
      truncated: false,
    });
    (window as any).multissh = { fileRead: mockFileRead };

    render(
      <TerminalPathHoverCard
        path="/images/icon.png"
        providerId="local"
        x={50}
        y={50}
        onClose={vi.fn()}
        onCopyPath={vi.fn()}
      />
    );

    const img = await screen.findByRole('img');
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('src', expect.stringContaining('data:image/png;base64,'));
    expect(screen.getByText('68 B')).toBeInTheDocument();
  });

  it('renders extensionless file as text file with preview snippet and Edit button', async () => {
    const mockFileRead = vi.fn().mockResolvedValue({
      content: '# My Notes\nTask 1\nTask 2\n',
      size: 25,
      isBinary: false,
    });
    (window as any).multissh = { fileRead: mockFileRead };

    render(
      <TerminalPathHoverCard
        path="notes"
        currentCwd="/home/alun"
        providerId="local"
        x={50}
        y={50}
        onClose={vi.fn()}
        onCopyPath={vi.fn()}
        onOpenEditor={vi.fn()}
      />
    );

    expect(screen.getByText('notes')).toBeInTheDocument();
    expect(screen.getByText('Notes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^edit$/i })).toBeInTheDocument();
    expect(await screen.findByText('# My Notes')).toBeInTheDocument();
    expect(screen.getByText('Task 1')).toBeInTheDocument();
  });

  it('adapts dynamically to directory when fileRead reports isDirectory: true', async () => {
    const mockFileRead = vi.fn().mockResolvedValue({
      content: '',
      size: 4096,
      isBinary: false,
      truncated: false,
      isDirectory: true,
    });
    (window as any).multissh = { fileRead: mockFileRead };

    render(
      <TerminalPathHoverCard
        path="src"
        currentCwd="/home/alun/sshs3"
        providerId="local"
        x={50}
        y={50}
        onClose={vi.fn()}
        onCopyPath={vi.fn()}
        onOpenEditor={vi.fn()}
        onOpenPath={vi.fn()}
      />
    );

    expect(screen.getByText('src')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /^browse$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
    expect(screen.getByText('Directory')).toBeInTheDocument();
    expect(screen.getByText(/click to browse/i)).toBeInTheDocument();
  });

  it('renders all action buttons with consistent height and whitespace-nowrap', () => {
    render(
      <TerminalPathHoverCard
        path="/home/alun/windows.png"
        x={50}
        y={50}
        onClose={vi.fn()}
        onCopyPath={vi.fn()}
        onOpenEditor={vi.fn()}
        onOpenPath={vi.fn()}
      />
    );

    const viewBtn = screen.getByRole('button', { name: /^view$/i });
    const revealBtn = screen.getByRole('button', { name: /^reveal$/i });
    const copyBtn = screen.getByRole('button', { name: /copy path/i });

    for (const btn of [viewBtn, revealBtn, copyBtn]) {
      expect(btn.className).toContain('h-8');
      expect(btn.className).toContain('flex-1');
      expect(btn.className).toContain('whitespace-nowrap');
    }
  });

  describe('drag out', () => {
    const renderCard = (providerId?: string) =>
      render(
        <TerminalPathHoverCard
          path="/home/me/report.pdf"
          x={50}
          y={50}
          providerId={providerId}
          onClose={vi.fn()}
          onCopyPath={vi.fn()}
        />
      );

    it('starts a native drag of the file from the handle for local terminals', () => {
      const dragOutStart = vi.fn().mockResolvedValue(true);
      (window as any).multissh = { dragOutStart };
      renderCard('local');
      const event = fireEvent.dragStart(screen.getByTestId('path-hover-drag-handle'));
      expect(event).toBe(false); // default prevented, the native drag takes over
      expect(dragOutStart).toHaveBeenCalledWith(['/home/me/report.pdf']);
    });

    it('shows no handle for remote terminals that cannot drag out', () => {
      (window as any).multissh = { dragOutStart: vi.fn() };
      renderCard('sftp-host');
      expect(screen.queryByTestId('path-hover-drag-handle')).not.toBeInTheDocument();
    });

    it('asks first for remote files: clicking the handle requests a drag-out, nothing is downloaded', () => {
      const dragOutPrepare = vi.fn();
      const onDragOut = vi.fn();
      (window as any).multissh = { dragOutStart: vi.fn(), dragOutPrepare };
      render(
        <TerminalPathHoverCard
          path="/home/me/report.pdf"
          x={50}
          y={50}
          providerId="sftp-host"
          onClose={vi.fn()}
          onCopyPath={vi.fn()}
          onDragOut={onDragOut}
        />
      );
      const handle = screen.getByRole('button', { name: /drag out of sshs3/i }); // a real button: reachable by keyboard
      expect(handle).toBe(screen.getByTestId('path-hover-drag-handle'));
      fireEvent.mouseEnter(handle);
      fireEvent.click(handle);
      expect(onDragOut).toHaveBeenCalledWith('/home/me/report.pdf');
      expect(dragOutPrepare).not.toHaveBeenCalled();
    });

    it('asks first when a remote file is dragged by its handle or icon, nothing is downloaded', () => {
      const dragOutPrepare = vi.fn();
      const onDragOut = vi.fn();
      (window as any).multissh = { dragOutStart: vi.fn(), dragOutPrepare };
      render(
        <TerminalPathHoverCard
          path="/home/me/report.pdf"
          x={50}
          y={50}
          providerId="sftp-host"
          onClose={vi.fn()}
          onCopyPath={vi.fn()}
          onDragOut={onDragOut}
        />
      );
      for (const id of ['path-hover-drag-handle', 'path-hover-drag-icon']) {
        onDragOut.mockClear();
        expect(fireEvent.dragStart(screen.getByTestId(id))).toBe(false);
        expect(onDragOut).toHaveBeenCalledWith('/home/me/report.pdf');
      }
      expect(dragOutPrepare).not.toHaveBeenCalled();
    });
  });
  describe('certificate preview', () => {
    const cert = {
      subject: 'C=SE, O=Test Org, CN=www.example.test',
      issuer: 'CN=Test Root CA',
      serialNumber: '01',
      notBefore: '2026-01-01T00:00:00.000Z',
      notAfter: '2126-01-01T00:00:00.000Z',
      validity: 'valid',
      daysLeft: 36000,
      sans: ['DNS:www.example.test'],
      moreSans: 0,
      publicKey: 'RSA 2048',
      signatureAlgorithm: 'SHA-256 with RSA',
      weakSignature: false,
      isCa: false,
      selfSigned: false,
      extendedKeyUsage: ['serverAuth'],
      sha256: 'AA:BB',
    };

    it('shows the certificate facts, and does not read a .pem as text', async () => {
      const fileRead = vi.fn();
      const certificatePreview = vi.fn().mockResolvedValue({ certs: [cert], moreCerts: 0 });
      (window as any).multissh = { fileRead, certificatePreview };

      render(
        <TerminalPathHoverCard path="/etc/ssl/site.pem" providerId="p1" x={50} y={50} onClose={vi.fn()} onCopyPath={vi.fn()} />
      );

      expect(await screen.findByTestId('certificate-preview')).toBeInTheDocument();
      expect(screen.getByText('C=SE, O=Test Org, CN=www.example.test')).toBeInTheDocument();
      expect(screen.getByText('Valid, 36000 days left')).toBeInTheDocument();
      expect(screen.getByText('Certificate')).toBeInTheDocument();
      expect(certificatePreview).toHaveBeenCalledWith('p1', '/etc/ssl/site.pem');
      expect(fileRead).not.toHaveBeenCalled();
    });

    it('asks with the storage path and ignores files that are not named like certificates', async () => {
      const certificatePreview = vi.fn().mockResolvedValue({ certs: [cert], moreCerts: 0 });
      (window as any).multissh = { fileRead: vi.fn().mockResolvedValue(null), certificatePreview };

      render(
        <TerminalPathHoverCard
          path="/mnt/c/a.crt"
          providerId="wsl"
          toStoragePath={(p) => p.replace('/mnt/c', 'C:')}
          x={50}
          y={50}
          onClose={vi.fn()}
          onCopyPath={vi.fn()}
        />
      );
      await screen.findByTestId('certificate-preview');
      expect(certificatePreview).toHaveBeenCalledWith('wsl', 'C:/a.crt');

      certificatePreview.mockClear();
      render(
        <TerminalPathHoverCard path="/etc/hosts" providerId="p1" x={50} y={50} onClose={vi.fn()} onCopyPath={vi.fn()} />
      );
      await new Promise((r) => setTimeout(r, 80));
      expect(certificatePreview).not.toHaveBeenCalled();
    });

    it('reads a certificate-named file once: as a certificate, and as text only when it is not one', async () => {
      const fileRead = vi.fn().mockResolvedValue({ content: 'just notes\n', size: 11, isBinary: false });
      const certificatePreview = vi.fn().mockResolvedValue({ certs: [], moreCerts: 0, error: 'none' });
      (window as any).multissh = { fileRead, certificatePreview };
      render(
        <TerminalPathHoverCard path="/x/notes.crt" providerId="p1" x={50} y={50} onClose={vi.fn()} onCopyPath={vi.fn()} />
      );
      expect(await screen.findByText('just notes')).toBeInTheDocument();
      expect(certificatePreview).toHaveBeenCalledTimes(1);
      expect(fileRead).toHaveBeenCalledTimes(1);

      fileRead.mockClear();
      (window as any).multissh = { fileRead, certificatePreview: vi.fn().mockResolvedValue({ certs: [cert], moreCerts: 0 }) };
      render(
        <TerminalPathHoverCard path="/x/site.crt" providerId="p1" x={50} y={50} onClose={vi.fn()} onCopyPath={vi.fn()} />
      );
      await screen.findAllByTestId('certificate-preview');
      expect(fileRead).not.toHaveBeenCalled();
    });

    it('falls back to the normal card when the file holds no certificate', async () => {
      const certificatePreview = vi.fn().mockResolvedValue({ certs: [], moreCerts: 0, error: 'none' });
      (window as any).multissh = { fileRead: vi.fn().mockResolvedValue(null), certificatePreview };

      render(
        <TerminalPathHoverCard path="/x/notes.crt" providerId="p1" x={50} y={50} onClose={vi.fn()} onCopyPath={vi.fn()} />
      );
      await new Promise((r) => setTimeout(r, 80));
      expect(certificatePreview).toHaveBeenCalled();
      expect(screen.queryByTestId('certificate-preview')).not.toBeInTheDocument();
    });
  });
});
