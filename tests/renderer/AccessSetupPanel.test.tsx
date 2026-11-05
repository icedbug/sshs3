// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { AccessSetupPanel } from '../../src/renderer/src/components/SSH/AccessSetupPanel';
import type { SSHConnectionConfig } from '../../src/shared/types/ssh';

const config: SSHConnectionConfig = {
  id: 'p1',
  name: 'Prod',
  host: 'db.internal',
  username: 'alice',
  authType: 'smartcard',
  pkcs11LibPath: '/lib/x.so',
};

const status = (id: string) => screen.getByTestId(`access-step-${id}`).getAttribute('data-status');

describe('AccessSetupPanel', () => {
  const sshProbeHost = vi.fn();
  const sshTestLogin = vi.fn();
  const listPublicKeys = vi.fn();
  const onStateChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    sshProbeHost.mockResolvedValue({ reachable: true, hostKey: 'trusted', methods: ['publickey', 'password'] });
    sshTestLogin.mockResolvedValue({ success: true });
    listPublicKeys.mockResolvedValue([]);
    window.multissh = { ...(window.multissh || {}), sshProbeHost, sshTestLogin, listPublicKeys } as any;
  });

  afterEach(() => cleanup());

  it('runs the chain on the unsaved config and marks the login as verified', async () => {
    render(<AccessSetupPanel config={config} onStateChange={onStateChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    await waitFor(() => expect(status('verified')).toBe('ok'));
    expect(sshProbeHost).toHaveBeenCalledWith(config);
    expect(sshTestLogin).toHaveBeenCalledWith(config);
    expect(status('reach')).toBe('ok');
    expect(status('hostkey')).toBe('ok');
    expect(status('methods')).toBe('ok');
    expect(screen.getByText('The server allows: publickey, password.')).toBeInTheDocument();
    // Login already works, so nothing needs installing.
    expect(status('installed')).toBe('skipped');
    expect(onStateChange).toHaveBeenLastCalledWith('verified');
  });

  it('names the state of every step for assistive technology, not only with an icon', async () => {
    render(<AccessSetupPanel config={config} onStateChange={onStateChange} />);
    const icon = (id: string) => within(screen.getByTestId(`access-step-${id}`)).getByRole('img');

    // Before the test runs nothing has happened yet
    expect(icon('reach')).toHaveAccessibleName('Not started');

    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(status('verified')).toBe('ok'));
    expect(icon('reach')).toHaveAccessibleName('OK');
    expect(icon('installed')).toHaveAccessibleName('Skipped');
  });

  it('stops at the first broken link and says why', async () => {
    sshProbeHost.mockResolvedValue({ reachable: false, hostKey: 'trusted', methods: [], errorKind: 'dns', error: 'The host name could not be resolved.' });
    render(<AccessSetupPanel config={config} onStateChange={onStateChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    await waitFor(() => expect(status('reach')).toBe('failed'));
    expect(screen.getByText('The host name could not be resolved.')).toBeInTheDocument();
    expect(status('hostkey')).toBe('skipped');
    expect(status('verified')).toBe('skipped');
    expect(sshTestLogin).not.toHaveBeenCalled();
    expect(onStateChange).toHaveBeenLastCalledWith('failed');
  });

  it('shows a changed host key as a failure and never attempts login', async () => {
    sshProbeHost.mockResolvedValue({ reachable: true, hostKey: 'changed', methods: [], errorKind: 'hostkey-changed', error: 'The host key has changed.' });
    render(<AccessSetupPanel config={config} />);
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    await waitFor(() => expect(status('hostkey')).toBe('failed'));
    expect(sshTestLogin).not.toHaveBeenCalled();
  });

  it('warns when a new host key was trusted during the probe', async () => {
    sshProbeHost.mockResolvedValue({ reachable: true, hostKey: 'accepted', methods: ['password'] });
    render(<AccessSetupPanel config={config} />);
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(status('hostkey')).toBe('warn'));
  });

  it('hints at installing the key when the host rejects the profile login', async () => {
    sshTestLogin.mockResolvedValue({ success: false, error: 'alice@db.internal: Permission denied (publickey,password).' });
    render(<AccessSetupPanel config={config} onStateChange={onStateChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    await waitFor(() => expect(status('verified')).toBe('failed'));
    expect(screen.getByText(/does not accept this profile's login yet/)).toBeInTheDocument();
    expect(onStateChange).toHaveBeenLastCalledWith('failed');
  });

  it('does not show the install hint for password profiles', async () => {
    sshTestLogin.mockResolvedValue({ success: false, error: 'Permission denied (password).' });
    render(<AccessSetupPanel config={{ ...config, authType: 'password' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(status('verified')).toBe('failed'));
    expect(screen.queryByText(/does not accept this profile's login yet/)).not.toBeInTheDocument();
  });

  it('is disabled until host and user are filled in', () => {
    render(<AccessSetupPanel config={{ ...config, host: '' }} />);
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Install key/ })).toBeDisabled();
    expect(screen.getByText('Fill in host and user first.')).toBeInTheDocument();
  });

  it.each([
    ['a smartcard profile without a PKCS#11 library', { ...config, pkcs11LibPath: '' }, 'Choose a PKCS#11 library first.'],
    ['a smartcard profile with a blank library', { ...config, pkcs11LibPath: '   ' }, 'Choose a PKCS#11 library first.'],
    ['a file-based FIDO2 profile without a key file', { ...config, authType: 'fido2' as const, pkcs11LibPath: undefined, privateKeyPath: '' }, 'Choose a key file first'],
  ])('blocks the whole flow for %s', (_name, cfg, message) => {
    render(<AccessSetupPanel config={cfg as SSHConnectionConfig} />);
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Install key/ })).toBeDisabled();
    expect(screen.getByText(new RegExp(message))).toBeInTheDocument();
  });

  it('allows a resident FIDO2 profile without a key file', () => {
    render(<AccessSetupPanel config={{ ...config, authType: 'fido2', pkcs11LibPath: undefined, fido2Resident: true }} />);
    expect(screen.getByRole('button', { name: /Install key/ })).toBeEnabled();
  });

  it('resets earlier results when the credentials change', async () => {
    const { rerender } = render(<AccessSetupPanel config={config} resetKey="a" onStateChange={onStateChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(status('verified')).toBe('ok'));

    rerender(<AccessSetupPanel config={{ ...config, host: 'other' }} resetKey="b" onStateChange={onStateChange} />);
    await waitFor(() => expect(status('verified')).toBe('pending'));
    expect(onStateChange).toHaveBeenLastCalledWith('unknown');
  });

  it('opens the install dialog for the draft config, passes the probed methods, and records the install', async () => {
    window.multissh.installPublicKeys = vi.fn().mockResolvedValue({
      success: true,
      loginMethod: 'password',
      results: [{ fingerprint: 'SHA256:own', status: 'installed' }],
    });
    listPublicKeys.mockResolvedValue([
      { id: 'SHA256:own', line: 'ssh-ed25519 AAAA', type: 'ssh-ed25519', fingerprint: 'SHA256:own', comment: '', source: 'smartcard', label: 'PIV key' },
    ]);
    render(<AccessSetupPanel config={config} onStateChange={onStateChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(status('methods')).toBe('ok'));

    fireEvent.click(screen.getByRole('button', { name: /Install key/ }));
    expect(await screen.findByTestId('install-key-modal')).toBeInTheDocument();
    expect(listPublicKeys).toHaveBeenCalledWith({ config });

    fireEvent.click(await screen.findByRole('button', { name: /Install 1 key/ }));
    await waitFor(() =>
      expect(window.multissh.installPublicKeys).toHaveBeenCalledWith(
        expect.objectContaining({ config, installsOwnKeyOnly: true, serverMethods: ['publickey', 'password'] })
      )
    );
    await waitFor(() => expect(status('installed')).toBe('ok'));
    expect(screen.getByText('Installed (logged in with password).')).toBeInTheDocument();
  });

  it('installing a key without testing first reports the installed state', async () => {
    window.multissh.installPublicKeys = vi.fn().mockResolvedValue({
      success: true,
      results: [{ fingerprint: 'SHA256:own', status: 'installed' }],
    });
    listPublicKeys.mockResolvedValue([
      { id: 'SHA256:own', line: 'ssh-ed25519 AAAA', type: 'ssh-ed25519', fingerprint: 'SHA256:own', comment: '', source: 'smartcard', label: 'PIV key' },
    ]);
    render(<AccessSetupPanel config={config} onStateChange={onStateChange} />);
    fireEvent.click(screen.getByRole('button', { name: /Install key/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Install 1 key/ }));

    await waitFor(() => expect(status('installed')).toBe('ok'));
    expect(onStateChange).toHaveBeenLastCalledWith('installed');
  });

  it('a failed install does not count as access', async () => {
    window.multissh.installPublicKeys = vi.fn().mockResolvedValue({
      success: false,
      error: 'Permission denied',
      results: [{ fingerprint: 'SHA256:own', status: 'unknown' }],
    });
    listPublicKeys.mockResolvedValue([
      { id: 'SHA256:own', line: 'ssh-ed25519 AAAA', type: 'ssh-ed25519', fingerprint: 'SHA256:own', comment: '', source: 'smartcard', label: 'PIV key' },
    ]);
    render(<AccessSetupPanel config={config} onStateChange={onStateChange} />);
    fireEvent.click(screen.getByRole('button', { name: /Install key/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Install 1 key/ }));
    await waitFor(() => expect(window.multissh.installPublicKeys).toHaveBeenCalled());
    await screen.findByRole('alert');
    expect(onStateChange).not.toHaveBeenCalled();
    expect(status('installed')).toBe('pending');
  });

  it('keeps an already verified login when a key is installed afterwards', async () => {
    window.multissh.installPublicKeys = vi.fn().mockResolvedValue({
      success: true,
      results: [{ fingerprint: 'SHA256:own', status: 'present' }],
    });
    listPublicKeys.mockResolvedValue([
      { id: 'SHA256:own', line: 'ssh-ed25519 AAAA', type: 'ssh-ed25519', fingerprint: 'SHA256:own', comment: '', source: 'smartcard', label: 'PIV key' },
    ]);
    render(<AccessSetupPanel config={config} onStateChange={onStateChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(status('verified')).toBe('ok'));

    fireEvent.click(screen.getByRole('button', { name: /Install key/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Install 1 key/ }));
    await waitFor(() => expect(status('installed')).toBe('ok'));
    expect(status('verified')).toBe('ok');
    expect(onStateChange).toHaveBeenLastCalledWith('verified');
  });

  it('opens the install dialog when the parent signals it (save reminder)', async () => {
    const { rerender } = render(<AccessSetupPanel config={config} openInstallSignal={0} />);
    expect(screen.queryByTestId('install-key-modal')).not.toBeInTheDocument();
    rerender(<AccessSetupPanel config={config} openInstallSignal={1} />);
    expect(await screen.findByTestId('install-key-modal')).toBeInTheDocument();
  });
});
