// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { FileEntry } from '../../src/shared/types/storage';
import { buildContextMenuItems, type FilePaneContextMenuInput } from '../../src/renderer/src/components/FileManager/filePaneContextMenu';
import { CertificateModal } from '../../src/renderer/src/components/FileManager/CertificateModal';

const file = (name: string, isDirectory = false): FileEntry =>
  ({ name, path: `/certs/${name}`, isDirectory, size: 10 }) as FileEntry;

const fullCert = {
  subject: 'CN=kia', issuer: 'CN=RSC Root CA', serialNumber: '01',
  notBefore: '2026-01-01T00:00:00.000Z', notAfter: '2126-01-01T00:00:00.000Z',
  validity: 'valid', daysLeft: 36000, sans: [], moreSans: 0, publicKey: 'RSA 2048',
  signatureAlgorithm: 'SHA-256 with RSA', weakSignature: false, isCa: false, selfSigned: false,
  keyUsage: ['digitalSignature'], extendedKeyUsage: [], ocspUrls: ['http://ocsp.example.test'], caIssuerUrls: [], crlUrls: [],
  sha256: 'AA:BB', sha1: 'CC:DD', spkiSha256: 'pinpinpin=', pem: 'PEMTEXT',
};

function menuKeys(entries: FileEntry[], setCertificateOpen = vi.fn()) {
  const input = {
    contextMenuOpen: true,
    selectedEntries: entries,
    sourceType: 'sftp',
    currentPath: '/certs',
    clipboard: null,
    gitIntegrationEnabled: false,
    gitStatus: null,
    setCertificateOpen,
  } as unknown as FilePaneContextMenuInput;
  return buildContextMenuItems(input);
}

describe('View Certificate context menu item', () => {
  it('is offered for one file named like a certificate', () => {
    const setCertificateOpen = vi.fn();
    const item = menuKeys([file('server.crt')], setCertificateOpen).find((i) => i.key === 'view-certificate');
    expect(item?.label).toBe('View Certificate...');
    item?.onSelect?.();
    expect(setCertificateOpen).toHaveBeenCalledWith(true);
  });

  it('is not offered for other files, folders, or several files', () => {
    for (const entries of [[file('server.key')], [file('x.crt', true)], [file('a.crt'), file('b.crt')], []]) {
      expect(menuKeys(entries).some((i) => i.key === 'view-certificate')).toBe(false);
    }
  });
});

describe('CertificateModal', () => {
  afterEach(() => cleanup());

  it('shows the certificate facts from the main process', async () => {
    const certificatePreview = vi.fn().mockResolvedValue({ moreCerts: 0, certs: [fullCert] });
    (window as any).multissh = { certificatePreview };
    render(<CertificateModal open providerId="p1" entry={file('server.crt')} onClose={vi.fn()} />);

    expect(await screen.findByText('CN=kia')).toBeInTheDocument();
    expect(certificatePreview).toHaveBeenCalledWith('p1', '/certs/server.crt', undefined);
    expect(screen.getByText(/chain and revocation are not verified/i)).toBeInTheDocument();
  });

  it('shows key usage, revocation URLs and fingerprints, and copies a value', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    (window as any).multissh = { certificatePreview: vi.fn().mockResolvedValue({ moreCerts: 0, certs: [fullCert] }) };
    render(<CertificateModal open providerId="p1" entry={file('server.crt')} onClose={vi.fn()} />);

    expect(await screen.findByText('digitalSignature')).toBeInTheDocument();
    expect(screen.getByText('http://ocsp.example.test')).toBeInTheDocument();
    expect(screen.getByText('CC:DD')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy public key pin' }));
    expect(writeText).toHaveBeenCalledWith('pinpinpin=');
    fireEvent.click(screen.getByRole('button', { name: 'Copy certificate as PEM' }));
    expect(writeText).toHaveBeenCalledWith('PEMTEXT');
  });

  it('checks a host name and shows the answer, and says so when the name is not usable', async () => {
    const certificatePreview = vi
      .fn()
      .mockResolvedValueOnce({ moreCerts: 0, certs: [fullCert] })
      .mockResolvedValueOnce({ moreCerts: 0, certs: [{ ...fullCert, hostMatch: true }], checkedHost: 'www.example.test' })
      .mockResolvedValueOnce({ moreCerts: 0, certs: [fullCert] });
    (window as any).multissh = { certificatePreview };
    render(<CertificateModal open providerId="p1" entry={file('server.crt')} onClose={vi.fn()} />);

    const input = await screen.findByLabelText('Host name to check');
    fireEvent.change(input, { target: { value: ' www.example.test ' } });
    fireEvent.submit(input.closest('form')!);
    expect(await screen.findByText('Valid for www.example.test')).toBeInTheDocument();
    expect(certificatePreview).toHaveBeenLastCalledWith('p1', '/certs/server.crt', 'www.example.test');

    fireEvent.change(input, { target: { value: 'bad host' } });
    fireEvent.submit(input.closest('form')!);
    expect(await screen.findByText('That is not a valid host name or IP address.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Valid for www.example.test')).not.toBeInTheDocument());
  });

  it('drops the old details when a later lookup fails', async () => {
    const certificatePreview = vi
      .fn()
      .mockResolvedValueOnce({ moreCerts: 0, certs: [fullCert] })
      .mockRejectedValueOnce(new Error('Connection lost'));
    (window as any).multissh = { certificatePreview };
    render(<CertificateModal open providerId="p1" entry={file('server.crt')} onClose={vi.fn()} />);

    const input = await screen.findByLabelText('Host name to check');
    fireEvent.change(input, { target: { value: 'www.example.test' } });
    fireEvent.submit(input.closest('form')!);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('certificate-preview')).not.toBeInTheDocument());
  });

  it('says when some certificates in the file could not be read', async () => {
    (window as any).multissh = {
      certificatePreview: vi.fn().mockResolvedValue({ moreCerts: 0, certs: [fullCert], unreadableCerts: 2 }),
    };
    render(<CertificateModal open providerId="p1" entry={file('server.crt')} onClose={vi.fn()} />);
    expect(await screen.findByRole('note')).toHaveTextContent('2 certificates in this file could not be read');
  });

  it('explains why there is nothing to show', async () => {
    (window as any).multissh = { certificatePreview: vi.fn().mockResolvedValue({ certs: [], moreCerts: 0, error: 'too-large' }) };
    render(<CertificateModal open providerId="p1" entry={file('big.pem')} onClose={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('larger than 64 KiB');
  });

  it('closes with the button and renders nothing when closed', async () => {
    (window as any).multissh = { certificatePreview: vi.fn().mockResolvedValue({ certs: [], moreCerts: 0, error: 'none' }) };
    const onClose = vi.fn();
    const { rerender } = render(<CertificateModal open providerId="p1" entry={file('a.crt')} onClose={onClose} />);
    await screen.findByRole('alert');
    // Header icon button and footer button are both named Close.
    const [, footerClose] = screen.getAllByRole('button', { name: 'Close' });
    fireEvent.click(footerClose);
    expect(onClose).toHaveBeenCalled();
    rerender(<CertificateModal open={false} providerId="p1" entry={file('a.crt')} onClose={onClose} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
