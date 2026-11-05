// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { CredentialEncryptionWarningBanner } from '../../src/renderer/src/components/CredentialEncryptionWarningBanner';

function mockStatus(status: { credentialEncryptionAvailable: boolean; undecryptableSecretCount: number } | Error) {
  window.multissh = {
    getSecurityStatus: status instanceof Error ? vi.fn().mockRejectedValue(status) : vi.fn().mockResolvedValue(status),
  } as unknown as typeof window.multissh;
}

describe('CredentialEncryptionWarningBanner', () => {
  afterEach(() => cleanup());

  it('shows nothing when encryption works and every secret decrypts', async () => {
    mockStatus({ credentialEncryptionAvailable: true, undecryptableSecretCount: 0 });
    render(<CredentialEncryptionWarningBanner />);
    await waitFor(() => expect(window.multissh.getSecurityStatus).toHaveBeenCalled());
    expect(screen.queryByTestId('credential-encryption-warning-banner')).not.toBeInTheDocument();
  });

  it('warns that saved passwords are not encrypted when there is no keyring', async () => {
    mockStatus({ credentialEncryptionAvailable: false, undecryptableSecretCount: 0 });
    render(<CredentialEncryptionWarningBanner />);
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('Saved passwords are not encrypted');
  });

  it('says how many saved secrets were lost, and what to do about it', async () => {
    mockStatus({ credentialEncryptionAvailable: true, undecryptableSecretCount: 3 });
    render(<CredentialEncryptionWarningBanner />);
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('3 saved secrets could not be decrypted');
    expect(banner).toHaveTextContent('enter the secret again');
  });

  it('uses the singular for one lost secret', async () => {
    mockStatus({ credentialEncryptionAvailable: true, undecryptableSecretCount: 1 });
    render(<CredentialEncryptionWarningBanner />);
    expect(await screen.findByRole('alert')).toHaveTextContent('1 saved secret could not be decrypted');
  });

  it('can be dismissed', async () => {
    mockStatus({ credentialEncryptionAvailable: true, undecryptableSecretCount: 2 });
    render(<CredentialEncryptionWarningBanner />);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('credential-encryption-warning-banner')).not.toBeInTheDocument();
  });

  it('stays quiet when the check itself fails', async () => {
    mockStatus(new Error('ipc failed'));
    render(<CredentialEncryptionWarningBanner />);
    await waitFor(() => expect(window.multissh.getSecurityStatus).toHaveBeenCalled());
    expect(screen.queryByTestId('credential-encryption-warning-banner')).not.toBeInTheDocument();
  });
});
