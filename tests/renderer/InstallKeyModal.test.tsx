// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { InstallKeyModal } from '../../src/renderer/src/components/SSH/InstallKeyModal';
import type { LocalPublicKey, SSHConnectionConfig } from '../../src/shared/types/ssh';

const conn: SSHConnectionConfig = {
  id: 'p1',
  name: 'Prod',
  host: 'db.internal',
  username: 'alice',
  authType: 'privateKey',
  privateKeyPath: '/home/alice/.ssh/id_ed25519',
};

const ownKey: LocalPublicKey = {
  id: 'SHA256:own',
  line: 'ssh-ed25519 AAAAOWN alice@laptop',
  type: 'ssh-ed25519',
  fingerprint: 'SHA256:own',
  comment: 'alice@laptop',
  source: 'file',
  label: 'id_ed25519.pub',
  privateKeyPath: '/home/alice/.ssh/id_ed25519',
};
const otherKey: LocalPublicKey = {
  ...ownKey,
  id: 'SHA256:other',
  line: 'ssh-ed25519 AAAAOTHER old',
  fingerprint: 'SHA256:other',
  label: 'old.pub',
  privateKeyPath: undefined,
};

describe('InstallKeyModal', () => {
  const listPublicKeys = vi.fn();
  const installPublicKeys = vi.fn();
  const buildInstallCommand = vi.fn();
  const onClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    listPublicKeys.mockResolvedValue([ownKey, otherKey]);
    installPublicKeys.mockResolvedValue({
      success: true,
      results: [{ fingerprint: 'SHA256:own', status: 'installed', verified: true }],
    });
    buildInstallCommand.mockResolvedValue("printf '%s\\n' 'k' | sh -c '...'");
    const openExternal = vi.fn().mockResolvedValue(true);
    window.multissh = { ...(window.multissh || {}), listPublicKeys, installPublicKeys, buildInstallCommand, openExternal } as any;
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  afterEach(() => cleanup());

  it('pre-selects only the profile\'s own key and installs the selection', async () => {
    render(<InstallKeyModal connection={conn} onClose={onClose} />);

    const own = await screen.findByLabelText('Select id_ed25519.pub');
    expect(own).toBeChecked();
    expect(screen.getByLabelText('Select old.pub')).not.toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: /Install 1 key/ }));

    await waitFor(() =>
      expect(installPublicKeys).toHaveBeenCalledWith(
        expect.objectContaining({ config: conn, publicKeys: [ownKey.line], loginMethod: 'auto', installsOwnKeyOnly: true })
      )
    );
    const result = await screen.findByTestId('install-key-result');
    expect(result).toHaveTextContent('Installed');
    expect(result).toHaveTextContent('key login works');
  });

  it('offers Cancel before installing and turns into Done once the keys went in', async () => {
    render(<InstallKeyModal connection={conn} onClose={onClose} />);
    await screen.findByLabelText('Select id_ed25519.pub');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Install 1 key/ }));
    const done = await screen.findByRole('button', { name: 'Done' });
    expect(screen.queryByRole('button', { name: /^Install/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();

    fireEvent.click(done);
    expect(onClose).toHaveBeenCalled();
  });

  it('goes back to Install when another key is selected after a successful run', async () => {
    render(<InstallKeyModal connection={conn} onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: /Install 1 key/ }));
    await screen.findByRole('button', { name: 'Done' });

    fireEvent.click(screen.getByLabelText('Select old.pub'));
    expect(await screen.findByRole('button', { name: /Install 2 keys/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument();
  });

  it('after a failed run the buttons read Close / Try again, not Done', async () => {
    installPublicKeys.mockResolvedValue({ success: false, error: 'Permission denied', results: [{ fingerprint: 'SHA256:own', status: 'unknown' }] });
    render(<InstallKeyModal connection={conn} onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: /Install 1 key/ }));

    expect(await screen.findByRole('button', { name: 'Try again 1 key' })).toBeInTheDocument();
    // Header X and footer button are both labelled Close.
    expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument();
  });

  it('installs several selected keys in one call', async () => {
    installPublicKeys.mockResolvedValue({
      success: true,
      results: [
        { fingerprint: 'SHA256:own', status: 'present' },
        { fingerprint: 'SHA256:other', status: 'installed' },
      ],
    });
    render(<InstallKeyModal connection={conn} onClose={onClose} />);
    fireEvent.click(await screen.findByLabelText('Select old.pub'));
    fireEvent.click(screen.getByRole('button', { name: /Install 2 keys/ }));

    await waitFor(() =>
      expect(installPublicKeys).toHaveBeenCalledWith(
        expect.objectContaining({ config: conn, publicKeys: [ownKey.line, otherKey.line], installsOwnKeyOnly: false })
      )
    );
    expect(await screen.findByText('Already present')).toBeInTheDocument();
  });

  it('disables install until a key is selected', async () => {
    listPublicKeys.mockResolvedValue([otherKey]);
    render(<InstallKeyModal connection={conn} onClose={onClose} />);
    await screen.findByLabelText('Select old.pub');
    expect(screen.getByRole('button', { name: /^Install/ })).toBeDisabled();
  });

  it('adds a pasted key to the list, selected', async () => {
    listPublicKeys.mockResolvedValue([]);
    render(<InstallKeyModal connection={conn} onClose={onClose} />);
    await screen.findByText(/No public keys found/);

    fireEvent.change(screen.getByLabelText('Paste a public key'), {
      target: { value: 'ssh-ed25519 AAAAPASTED me@x' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(await screen.findByLabelText('Select me@x')).toBeChecked();
  });

  it('shows the error from a failed install', async () => {
    installPublicKeys.mockResolvedValue({
      success: false,
      error: 'Permission denied (publickey,password).',
      results: [{ fingerprint: 'SHA256:own', status: 'unknown' }],
    });
    render(<InstallKeyModal connection={conn} onClose={onClose} />);
    await screen.findByLabelText('Select id_ed25519.pub');
    fireEvent.click(screen.getByRole('button', { name: /Install 1 key/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Permission denied');
  });

  it('builds and copies the manual fallback command', async () => {
    render(<InstallKeyModal connection={conn} onClose={onClose} />);
    await screen.findByLabelText('Select id_ed25519.pub');
    fireEvent.click(screen.getByRole('button', { name: /Copy command/ }));

    await waitFor(() => expect(buildInstallCommand).toHaveBeenCalledWith([ownKey.line]));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("printf '%s\\n' 'k' | sh -c '...'");
  });

  it('refreshes the shown command and clipboard when the selection changes afterwards', async () => {
    buildInstallCommand.mockImplementation(async (lines: string[]) => `cmd for ${lines.length}`);
    render(<InstallKeyModal connection={conn} onClose={onClose} />);
    await screen.findByLabelText('Select id_ed25519.pub');
    fireEvent.click(screen.getByRole('button', { name: /Copy command/ }));
    expect(await screen.findByText('cmd for 1')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Select old.pub'));
    expect(await screen.findByText('cmd for 2')).toBeInTheDocument();
    expect(buildInstallCommand).toHaveBeenLastCalledWith([ownKey.line, otherKey.line]);
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith('cmd for 2');

    fireEvent.click(screen.getByLabelText('Select old.pub'));
    fireEvent.click(screen.getByLabelText('Select id_ed25519.pub'));
    await waitFor(() => expect(screen.queryByText(/cmd for/)).not.toBeInTheDocument());
  });

  it('labels keys from the running ssh-agent as "already loaded", not "agent"', async () => {
    listPublicKeys.mockResolvedValue([{ ...otherKey, source: 'agent' as const, label: 'alun@fedora' }]);
    render(<InstallKeyModal connection={conn} onClose={onClose} />);
    await screen.findByLabelText('Select alun@fedora');
    expect(screen.getByText('Already loaded')).toBeInTheDocument();
    expect(screen.queryByText('Agent')).not.toBeInTheDocument();
  });

  it('selects and clears all keys, only offered when there is more than one', async () => {
    render(<InstallKeyModal connection={conn} onClose={onClose} />);
    await screen.findByLabelText('Select old.pub');
    expect(screen.getByText('1 of 2 selected')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    expect(screen.getByLabelText('Select old.pub')).toBeChecked();
    expect(screen.getByText('2 of 2 selected')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(screen.getByLabelText('Select id_ed25519.pub')).not.toBeChecked();
    cleanup();

    listPublicKeys.mockResolvedValue([ownKey]);
    render(<InstallKeyModal connection={conn} onClose={onClose} />);
    await screen.findByLabelText('Select id_ed25519.pub');
    expect(screen.queryByRole('button', { name: 'Select all' })).not.toBeInTheDocument();
  });

  it('pre-selects keys read from an unlocked smartcard cache and hides the read button', async () => {
    const cardKey = { ...ownKey, id: 'SHA256:card', fingerprint: 'SHA256:card', line: 'ssh-ed25519 AAAACARD', source: 'smartcard' as const, label: 'PIV AUTH pubkey', privateKeyPath: undefined };
    listPublicKeys.mockResolvedValue([cardKey, otherKey]);
    render(
      <InstallKeyModal connection={{ ...conn, authType: 'smartcard', pkcs11LibPath: '/lib/x.so', privateKeyPath: undefined }} onClose={onClose} />
    );
    expect(await screen.findByLabelText('Select PIV AUTH pubkey')).toBeChecked();
    expect(screen.getByLabelText('Select old.pub')).not.toBeChecked();
    expect(screen.queryByText(/Read keys from smartcard/)).not.toBeInTheDocument();
  });

  it('says so when reading the device finds no keys, instead of silently doing nothing', async () => {
    render(
      <InstallKeyModal connection={{ ...conn, authType: 'fido2', fido2Resident: true, privateKeyPath: undefined }} onClose={onClose} />
    );
    fireEvent.click(await screen.findByText(/Read keys from security key/));
    expect(await screen.findByRole('alert')).toHaveTextContent('No resident SSH credentials were found');
  });

  it('shows the backend error when the device could not be read', async () => {
    render(
      <InstallKeyModal connection={{ ...conn, authType: 'fido2', fido2Resident: true, privateKeyPath: undefined }} onClose={onClose} />
    );
    await screen.findByLabelText('Select id_ed25519.pub');
    listPublicKeys.mockRejectedValueOnce(new Error('Could not read the security key.'));
    fireEvent.click(screen.getByText(/Read keys from security key/));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not read the security key.');
  });

  it('lets the user force the login method and shows which one was used', async () => {
    installPublicKeys.mockResolvedValue({
      success: true,
      loginMethod: 'password',
      results: [{ fingerprint: 'SHA256:own', status: 'installed' }],
    });
    const onInstalled = vi.fn();
    render(<InstallKeyModal connection={conn} serverMethods={['publickey', 'password']} onInstalled={onInstalled} onClose={onClose} />);
    await screen.findByLabelText('Select id_ed25519.pub');

    fireEvent.change(screen.getByLabelText('Log in with'), { target: { value: 'password' } });
    fireEvent.click(screen.getByRole('button', { name: /Install 1 key/ }));

    await waitFor(() =>
      expect(installPublicKeys).toHaveBeenCalledWith(
        expect.objectContaining({ loginMethod: 'password', serverMethods: ['publickey', 'password'] })
      )
    );
    expect(await screen.findByText('Logged in with password.')).toBeInTheDocument();
    expect(onInstalled).toHaveBeenCalledWith(expect.objectContaining({ loginMethod: 'password' }));
  });

  it('shows the automatic login order, and includes the smartcard left over from a PIV profile', async () => {
    render(
      <InstallKeyModal
        connection={{ ...conn, authType: 'fido2', fido2Resident: true, privateKeyPath: undefined, pkcs11LibPath: '/usr/lib64/p11-kit-proxy.so' }}
        onClose={onClose}
      />
    );
    await screen.findByLabelText('Select id_ed25519.pub');
    // Nothing selected yet: other-key rule applies (profile first).
    expect(screen.getByTestId('install-key-login-order')).toHaveTextContent("This profile's key → Smartcard (PKCS#11) → Password");
    expect(screen.getByRole('option', { name: 'Smartcard (PKCS#11)' })).toBeInTheDocument();
  });

  it('own-key-only installs on a FIDO2 profile with a leftover card list the card before the password', async () => {
    const fidoKey = { ...ownKey, id: 'SHA256:fido', fingerprint: 'SHA256:fido', line: 'sk-ssh-ed25519@openssh.com AAAAFIDO', source: 'fido2' as const, label: 'Security key', privateKeyPath: undefined };
    listPublicKeys.mockResolvedValue([fidoKey]);
    render(
      <InstallKeyModal
        connection={{ ...conn, authType: 'fido2', fido2Resident: true, privateKeyPath: undefined, pkcs11LibPath: '/usr/lib64/p11-kit-proxy.so' }}
        onClose={onClose}
      />
    );
    await screen.findByLabelText('Select Security key');
    expect(screen.getByTestId('install-key-login-order')).toHaveTextContent('Smartcard (PKCS#11) → Password');
    expect(screen.getByTestId('install-key-login-order')).not.toHaveTextContent("This profile's key");
  });

  it('hides the smartcard option when the profile has no library, and shows the order for a keys-only host', async () => {
    render(<InstallKeyModal connection={conn} serverMethods={['publickey']} onClose={onClose} />);
    await screen.findByLabelText('Select id_ed25519.pub');
    expect(screen.queryByRole('option', { name: 'Smartcard (PKCS#11)' })).not.toBeInTheDocument();

    // Own key only on a keys-only host: nothing sensible to log in with, and the user is told why.
    expect(screen.getByTestId('install-key-login-order')).toHaveTextContent('No automatic login is possible');

    // Selecting another key makes the profile's own key usable for logging in.
    fireEvent.click(screen.getByLabelText('Select id_ed25519.pub'));
    fireEvent.click(screen.getByLabelText('Select old.pub'));
    expect(screen.getByTestId('install-key-login-order')).toHaveTextContent("Tries, in order: This profile's key");
    expect(screen.getByTestId('install-key-login-order')).not.toHaveTextContent('Password');
  });

  it('can force the smartcard or the unlocked ssh-agent keys', async () => {
    render(
      <InstallKeyModal
        connection={{ ...conn, authType: 'fido2', fido2Resident: true, privateKeyPath: undefined, pkcs11LibPath: '/lib.so' }}
        onClose={onClose}
      />
    );
    await screen.findByLabelText('Select id_ed25519.pub');
    fireEvent.click(screen.getByLabelText('Select id_ed25519.pub'));
    fireEvent.change(screen.getByLabelText('Log in with'), { target: { value: 'smartcard' } });
    expect(screen.queryByTestId('install-key-login-order')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Install 1 key/ }));
    await waitFor(() => expect(installPublicKeys).toHaveBeenCalledWith(expect.objectContaining({ loginMethod: 'smartcard' })));
  });

  it('does not offer a login method choice for password profiles', async () => {
    render(<InstallKeyModal connection={{ ...conn, authType: 'password' }} onClose={onClose} />);
    await screen.findByLabelText('Select id_ed25519.pub');
    expect(screen.queryByLabelText('Log in with')).not.toBeInTheDocument();
  });

  it('only offers hardware key loading for smartcard/resident FIDO2 profiles', async () => {
    const { unmount } = render(<InstallKeyModal connection={conn} onClose={onClose} />);
    await screen.findByLabelText('Select id_ed25519.pub');
    expect(screen.queryByText(/Read keys from/)).not.toBeInTheDocument();
    unmount();

    render(
      <InstallKeyModal
        connection={{ ...conn, authType: 'fido2', fido2Resident: true, privateKeyPath: undefined }}
        onClose={onClose}
      />
    );
    fireEvent.click(await screen.findByText(/Read keys from security key/));
    await waitFor(() =>
      expect(listPublicKeys).toHaveBeenLastCalledWith({ config: expect.objectContaining({ id: 'p1' }), includeHardware: true })
    );
  });

  it('copies public key to clipboard when clicking Copy', async () => {
    render(<InstallKeyModal connection={conn} onClose={onClose} />);
    await screen.findByLabelText('Select id_ed25519.pub');
    const copyButtons = screen.getAllByRole('button', { name: /Copy/i });
    expect(copyButtons.length).toBeGreaterThan(0);
    fireEvent.click(copyButtons[0]);

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(ownKey.line);
    });
  });

  it('disables Fetch keys with an explanation when an administrator blocks it', async () => {
    const gitFetchPublicKeys = vi.fn();
    window.multissh = {
      ...window.multissh,
      gitFetchPublicKeys,
      policyGet: vi.fn().mockResolvedValue({ managed: [], features: { gitKeyFetch: false }, warnings: [] }),
    } as any;
    render(<InstallKeyModal connection={conn} onClose={onClose} />);

    expect(await screen.findByRole('note')).toHaveTextContent('Disabled by your administrator.');
    const input = screen.getByRole('textbox', { name: 'GitHub username' });
    fireEvent.change(input, { target: { value: 'octocat' } });
    expect(screen.getByRole('button', { name: /Fetch keys/ })).toBeDisabled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(gitFetchPublicKeys).not.toHaveBeenCalled();
  });
});
