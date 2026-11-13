// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { S3ProfileForm } from '../../src/renderer/src/components/ConnectionModal/S3ProfileForm';
import type { S3Config } from '../../src/shared/types/storage';

// Code review: the "Use SSL/TLS" checkbox did nothing (the S3 client never read `ssl`), and the path-style
// checkbox showed unchecked for a profile without the field while S3StorageProvider used path-style (`?? true`).
describe('S3ProfileForm SSL and path-style display', () => {
  beforeEach(() => {
    window.multissh = {
      testS3Connection: vi.fn().mockResolvedValue({ success: true }),
      dialogOpenFile: vi.fn().mockResolvedValue(null),
    } as unknown as typeof window.multissh;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  const base: S3Config = {
    id: 's3-1',
    name: 'MinIO',
    region: 'us-east-1',
    authMode: 'static',
    accessKeyId: 'AKIA',
    secretAccessKey: 'x', // pragma: allowlist secret
  };

  it('shows path-style as on when the profile does not set it, like the provider', () => {
    render(<S3ProfileForm initial={{ ...base }} onSave={vi.fn()} onCancel={vi.fn()} />);
    const box = screen.getByLabelText(/Path-style addressing/) as HTMLInputElement;
    expect(box.checked).toBe(true);
  });

  it('shows path-style as off when the profile turned it off', () => {
    render(<S3ProfileForm initial={{ ...base, forcePathStyle: false }} onSave={vi.fn()} onCancel={vi.fn()} />);
    expect((screen.getByLabelText(/Path-style addressing/) as HTMLInputElement).checked).toBe(false);
  });

  it('has no SSL/TLS checkbox that does nothing', () => {
    render(<S3ProfileForm initial={{ ...base }} onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByLabelText(/Use SSL\/TLS/)).toBeNull();
  });

  it('warns when the endpoint uses http, and not for https', () => {
    render(<S3ProfileForm initial={{ ...base, endpoint: 'https://minio.internal:9000' }} onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByText(/sent unencrypted/)).toBeNull();

    const endpoint = screen.getByPlaceholderText('e.g. https://minio.internal:9000');
    fireEvent.change(endpoint, { target: { value: 'http://minio.internal:9000' } });
    expect(screen.getByText(/This endpoint uses http: keys and data are sent unencrypted/)).toBeInTheDocument();
  });
});
