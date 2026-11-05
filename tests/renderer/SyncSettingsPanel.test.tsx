// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render as rtlRender, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SyncSettingsPanel } from '../../src/renderer/src/components/SettingsModal/SyncSettingsPanel';
import { ConfirmProvider } from '../../src/renderer/src/components/ConfirmDialog';
import type { ProfileSyncStatus } from '../../src/shared/types/sync';

// The panel asks for confirmations through the app's ConfirmDialog, which needs its provider.
function render(ui: React.ReactElement) {
  const result = rtlRender(<ConfirmProvider>{ui}</ConfirmProvider>);
  return {
    ...result,
    rerender: (next: React.ReactElement) => result.rerender(<ConfirmProvider>{next}</ConfirmProvider>),
  };
}

function statusFixture(overrides: Partial<ProfileSyncStatus> = {}): ProfileSyncStatus {
  return {
    configured: false,
    hasLocalSalts: false,
    topologyUnlocked: false,
    credentialsUnlocked: false,
    ...overrides,
  };
}

describe('SyncSettingsPanel', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows the target form when sync is not configured yet', async () => {
    window.multissh = {
      profileSyncStatus: vi.fn().mockResolvedValue(statusFixture()),
    } as unknown as typeof window.multissh;

    render(<SyncSettingsPanel />);

    await waitFor(() => {
      expect(screen.getByText('SFTP server')).toBeInTheDocument();
      expect(screen.getByText('S3 bucket')).toBeInTheDocument();
    });
  });

  it('saves an SFTP target with the entered fields', async () => {
    const profileSyncSetup = vi.fn().mockResolvedValue(undefined);
    window.multissh = {
      profileSyncStatus: vi
        .fn()
        .mockResolvedValueOnce(statusFixture())
        .mockResolvedValueOnce(statusFixture({ configured: true, target: { id: 'x', name: 'x', type: 'sftp' } })),
      profileSyncSetup,
    } as unknown as typeof window.multissh;

    render(<SyncSettingsPanel />);
    await waitFor(() => expect(screen.getByText('SFTP server')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('sync.example.com'), { target: { value: 'sync.host.com' } });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'deploy' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'sync-pass' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save Sync Target' }));

    await waitFor(() => {
      expect(profileSyncSetup).toHaveBeenCalledWith(
        expect.objectContaining({
          target: expect.objectContaining({
            type: 'sftp',
            sftpConfig: expect.objectContaining({ host: 'sync.host.com', username: 'deploy', password: 'sync-pass' }),
          }),
        })
      );
    });
  });

  it('opens the master password dialog and requires matching confirmation before enabling submit (first-time setup)', async () => {
    window.multissh = {
      profileSyncStatus: vi.fn().mockResolvedValue(
        statusFixture({ configured: true, target: { id: 'x', name: 'x', type: 'sftp' }, hasLocalSalts: false })
      ),
    } as unknown as typeof window.multissh;

    render(<SyncSettingsPanel />);
    await waitFor(() => expect(screen.getByText('Set up master passwords')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Set up master passwords'));

    const submitButton = await screen.findByRole('button', { name: 'Activate sync' });
    expect(submitButton).toBeDisabled();

    const masterInput = screen.getByLabelText('Master password') as HTMLInputElement;
    const masterConfirm = screen.getByLabelText('Confirm master password') as HTMLInputElement;

    fireEvent.change(masterInput, { target: { value: 'master-secret-1' } });
    fireEvent.change(masterConfirm, { target: { value: 'master-secret-1' } });

    // Still disabled: the "I've saved these passwords" checkbox hasn't been checked yet.
    expect(submitButton).toBeDisabled();

    fireEvent.click(screen.getByText("I've saved these passwords somewhere safe."));
    expect(submitButton).not.toBeDisabled();
  });

  it('allows switching to separate passwords for topology and credentials', async () => {
    window.multissh = {
      profileSyncStatus: vi.fn().mockResolvedValue(
        statusFixture({ configured: true, target: { id: 'x', name: 'x', type: 'sftp' }, hasLocalSalts: false })
      ),
    } as unknown as typeof window.multissh;

    render(<SyncSettingsPanel />);
    await waitFor(() => expect(screen.getByText('Set up master passwords')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Set up master passwords'));

    fireEvent.click(screen.getByText('Use separate passwords'));

    const topologyInput = screen.getByLabelText('Topology master password') as HTMLInputElement;
    const topologyConfirm = screen.getByLabelText('Confirm topology master password') as HTMLInputElement;
    const credentialsInput = screen.getByLabelText('Credentials master password') as HTMLInputElement;
    const credentialsConfirm = screen.getByLabelText('Confirm credentials master password') as HTMLInputElement;

    fireEvent.change(topologyInput, { target: { value: 'topology-secret-1' } });
    fireEvent.change(topologyConfirm, { target: { value: 'topology-secret-1' } });
    fireEvent.change(credentialsInput, { target: { value: 'credentials-secret-1' } });
    fireEvent.change(credentialsConfirm, { target: { value: 'credentials-secret-1' } });

    const submitButton = screen.getByRole('button', { name: 'Activate sync' });
    expect(submitButton).toBeDisabled();

    fireEvent.click(screen.getByText("I've saved these passwords somewhere safe."));
    expect(submitButton).not.toBeDisabled();
  });

  it('shows push and pull actions once both key groups are unlocked', async () => {
    window.multissh = {
      profileSyncStatus: vi.fn().mockResolvedValue(
        statusFixture({
          configured: true,
          target: { id: 'x', name: 'x', type: 's3' },
          hasLocalSalts: true,
          topologyUnlocked: true,
          credentialsUnlocked: true,
          lastSyncAt: '2026-01-01T00:00:00.000Z',
        })
      ),
      profileSyncPush: vi.fn().mockResolvedValue(
        statusFixture({
          configured: true,
          target: { id: 'x', name: 'x', type: 's3' },
          hasLocalSalts: true,
          topologyUnlocked: true,
          credentialsUnlocked: true,
          lastSyncAt: '2026-01-01T00:05:00.000Z',
        })
      ),
    } as unknown as typeof window.multissh;

    render(<SyncSettingsPanel />);
    const pushButton = await screen.findByRole('button', { name: /Push/ });
    expect(screen.getByRole('button', { name: /Pull/ })).toBeInTheDocument();

    fireEvent.click(pushButton);
    await waitFor(() => {
      expect(window.multissh.profileSyncPush).toHaveBeenCalled();
    });
  });

  it('displays in_sync status badge when client and remote are in sync', async () => {
    window.multissh = {
      profileSyncStatus: vi.fn().mockResolvedValue(
        statusFixture({
          configured: true,
          target: { id: 'x', name: 'x', type: 's3' },
          hasLocalSalts: true,
          topologyUnlocked: true,
          credentialsUnlocked: true,
          lastSyncAt: '2026-09-18T20:00:00.000Z',
          comparison: {
            state: 'in_sync',
            aheadCount: 0,
            behindCount: 0,
            categories: [],
            checkedAt: '2026-09-18 20:00',
          },
        })
      ),
    } as unknown as typeof window.multissh;

    render(<SyncSettingsPanel />);
    await waitFor(() => {
      expect(screen.getByText('In sync with remote')).toBeInTheDocument();
    });
  });

  it('displays ahead badge and highlights push button when client has unpushed changes', async () => {
    window.multissh = {
      profileSyncStatus: vi.fn().mockResolvedValue(
        statusFixture({
          configured: true,
          target: { id: 'x', name: 'x', type: 's3' },
          hasLocalSalts: true,
          topologyUnlocked: true,
          credentialsUnlocked: true,
          lastSyncAt: '2026-09-18T20:00:00.000Z',
          comparison: {
            state: 'ahead',
            aheadCount: 3,
            behindCount: 0,
            categories: [
              { category: 'topology', state: 'ahead', ahead: 3, behind: 0, details: ['3 profiles modified'] },
            ],
            checkedAt: '2026-09-18 20:05',
          },
        })
      ),
    } as unknown as typeof window.multissh;

    render(<SyncSettingsPanel />);
    await waitFor(() => {
      expect(screen.getByText(/Client ahead/)).toBeInTheDocument();
      expect(screen.getByText('3 unpushed changes', { exact: false })).toBeInTheDocument();
    });
  });

  it('displays behind badge and highlights pull button when remote has changes', async () => {
    window.multissh = {
      profileSyncStatus: vi.fn().mockResolvedValue(
        statusFixture({
          configured: true,
          target: { id: 'x', name: 'x', type: 's3' },
          hasLocalSalts: true,
          topologyUnlocked: true,
          credentialsUnlocked: true,
          lastSyncAt: '2026-09-18T20:00:00.000Z',
          comparison: {
            state: 'behind',
            aheadCount: 0,
            behindCount: 2,
            categories: [
              { category: 'settings', state: 'behind', ahead: 0, behind: 2, details: ['2 settings updated'] },
            ],
            checkedAt: '2026-09-18 20:10',
          },
        })
      ),
    } as unknown as typeof window.multissh;

    render(<SyncSettingsPanel />);
    await waitFor(() => {
      expect(screen.getByText(/Client behind/)).toBeInTheDocument();
      expect(screen.getByText('2 remote changes', { exact: false })).toBeInTheDocument();
    });
  });

  it('saves an SFTP target with private key authentication and proxy jump', async () => {
    const profileSyncSetup = vi.fn().mockResolvedValue(undefined);
    window.multissh = {
      profileSyncStatus: vi
        .fn()
        .mockResolvedValueOnce(statusFixture())
        .mockResolvedValueOnce(statusFixture({ configured: true, target: { id: 'x', name: 'x', type: 'sftp' } })),
      profileSyncSetup,
    } as unknown as typeof window.multissh;

    render(<SyncSettingsPanel />);
    await waitFor(() => expect(screen.getByText('SFTP server')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('sync.example.com'), { target: { value: 'ssh.corp.com' } });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'alice' } });

    // Switch to Private Key
    fireEvent.change(screen.getByLabelText('Authentication'), { target: { value: 'privateKey' } });
    expect(screen.getByLabelText('Private Key')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Private Key'), {
      target: { value: '/home/alice/.ssh/id_ed25519' },
    });
    fireEvent.change(screen.getByLabelText('Passphrase (optional)'), {
      target: { value: 'key-passphrase' },
    });
    fireEvent.change(screen.getByPlaceholderText('jumpuser@bastion.example.com:22'), {
      target: { value: 'bastion.corp.com' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save Sync Target' }));

    await waitFor(() => {
      expect(profileSyncSetup).toHaveBeenCalledWith(
        expect.objectContaining({
          target: expect.objectContaining({
            type: 'sftp',
            sftpConfig: expect.objectContaining({
              host: 'ssh.corp.com',
              username: 'alice',
              authType: 'privateKey',
              privateKeyPath: '/home/alice/.ssh/id_ed25519',
              passphrase: 'key-passphrase',
              proxyJump: 'bastion.corp.com',
            }),
          }),
        })
      );
    });
  });

  it('prefills draft from existing targetConfig when editing target', async () => {
    window.multissh = {
      profileSyncStatus: vi.fn().mockResolvedValue(
        statusFixture({
          configured: true,
          target: { id: 's3-target', name: 'S3 Sync', type: 's3' },
          targetConfig: {
            type: 's3',
            s3Config: {
              id: 's3-cfg',
              name: 'S3 Sync',
              region: 'eu-north-1',
              endpoint: 'https://s3.custom.io',
              authMode: 'static',
              accessKeyId: 'AKIA12345678',
              secretAccessKey: 'SECRETKEY123',
              forcePathStyle: true,
            },
          },
          remoteBasePath: 'backups/sshs3',
          hasLocalSalts: true,
          topologyUnlocked: false,
          credentialsUnlocked: false,
        })
      ),
    } as unknown as typeof window.multissh;

    render(<SyncSettingsPanel />);
    await waitFor(() => expect(screen.getByText('Change target')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Change target'));

    await waitFor(() => {
      expect(screen.getByLabelText('Bucket (or bucket/prefix)')).toHaveValue('backups/sshs3');
      expect(screen.getByLabelText('Region')).toHaveValue('eu-north-1');
      expect(screen.getByLabelText('Access Key ID')).toHaveValue('AKIA12345678');
      expect(screen.getByLabelText(/Endpoint/)).toHaveValue('https://s3.custom.io');
    });
  });

  it('toggles auto-sync changes when switch is clicked', async () => {
    const profileSyncSetAutoSync = vi.fn().mockResolvedValue(
      statusFixture({
        configured: true,
        target: { id: 's3-target', name: 'S3 Sync', type: 's3' },
        autoSync: true,
      })
    );
    window.multissh = {
      profileSyncStatus: vi.fn().mockResolvedValue(
        statusFixture({
          configured: true,
          target: { id: 's3-target', name: 'S3 Sync', type: 's3' },
          autoSync: false,
        })
      ),
      profileSyncSetAutoSync,
    } as unknown as typeof window.multissh;

    render(<SyncSettingsPanel />);
    const toggle = await screen.findByLabelText('Auto-sync changes');
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);
    await waitFor(() => {
      expect(profileSyncSetAutoSync).toHaveBeenCalledWith(true);
    });
  });

  it('shows "Unlock with Smartcard" button when smartcard is available and calls profileSyncUnlockSmartcard', async () => {
    const profileSyncUnlockSmartcard = vi.fn().mockResolvedValue(
      statusFixture({
        configured: true,
        target: { id: 's3-target', name: 'S3 Sync', type: 's3' },
        hasLocalSalts: true,
        topologyUnlocked: true,
        credentialsUnlocked: true,
        smartcardAvailable: true,
      })
    );
    window.multissh = {
      profileSyncStatus: vi.fn().mockResolvedValue(
        statusFixture({
          configured: true,
          target: { id: 's3-target', name: 'S3 Sync', type: 's3' },
          hasLocalSalts: true,
          topologyUnlocked: false,
          credentialsUnlocked: false,
          smartcardAvailable: true,
        })
      ),
      profileSyncUnlockSmartcard,
      profileSyncCompare: vi.fn().mockResolvedValue(undefined),
    } as unknown as typeof window.multissh;

    render(<SyncSettingsPanel />);
    const unlockBtn = await screen.findByRole('button', { name: /Unlock with Smartcard/i });
    expect(unlockBtn).toBeInTheDocument();

    fireEvent.click(unlockBtn);
    await waitFor(() => {
      expect(profileSyncUnlockSmartcard).toHaveBeenCalled();
      expect(screen.getByText('Sync unlocked with smartcard.')).toBeInTheDocument();
    });
  });

  it('shows "Unlink card" when smartcard is linked and calls profileSyncUnlinkSmartcard', async () => {
    const profileSyncUnlinkSmartcard = vi.fn().mockResolvedValue(
      statusFixture({
        configured: true,
        target: { id: 's3-target', name: 'S3 Sync', type: 's3' },
        smartcardLinked: false,
        topologyUnlocked: true,
        credentialsUnlocked: true,
      })
    );
    window.multissh = {
      profileSyncStatus: vi.fn().mockResolvedValue(
        statusFixture({
          configured: true,
          target: { id: 's3-target', name: 'S3 Sync', type: 's3' },
          hasLocalSalts: true,
          topologyUnlocked: true,
          credentialsUnlocked: true,
          smartcardLinked: true,
          smartcardLibPath: '/usr/lib/opensc-pkcs11.so',
        })
      ),
      profileSyncUnlinkSmartcard,
      profileSyncCompare: vi.fn().mockResolvedValue(undefined),
    } as unknown as typeof window.multissh;

    render(<SyncSettingsPanel />);
    const unlinkBtn = await screen.findByRole('button', { name: /Unlink card/i });
    expect(unlinkBtn).toBeInTheDocument();

    // Unlinking changes how sync unlocks, so it asks first; Cancel leaves the link alone.
    fireEvent.click(unlinkBtn);
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Sync will ask for the master password instead of the card');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(profileSyncUnlinkSmartcard).not.toHaveBeenCalled();

    fireEvent.click(unlinkBtn);
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Unlink card' }));
    await waitFor(() => {
      expect(profileSyncUnlinkSmartcard).toHaveBeenCalled();
      expect(screen.getByText('Smartcard unlinked from sync.')).toBeInTheDocument();
    });
  });

  it('links smartcard when "Link card" is clicked and master password is provided', async () => {
    const profileSyncLinkSmartcard = vi.fn().mockResolvedValue(
      statusFixture({
        configured: true,
        target: { id: 's3-target', name: 'S3 Sync', type: 's3' },
        smartcardLinked: true,
        topologyUnlocked: true,
        credentialsUnlocked: true,
      })
    );
    const smartcardDetect = vi.fn().mockResolvedValue([{ path: '/usr/lib/opensc-pkcs11.so', label: 'OpenSC' }]);

    window.multissh = {
      profileSyncStatus: vi.fn().mockResolvedValue(
        statusFixture({
          configured: true,
          target: { id: 's3-target', name: 'S3 Sync', type: 's3' },
          hasLocalSalts: true,
          topologyUnlocked: true,
          credentialsUnlocked: true,
          smartcardAvailable: true,
          smartcardLinked: false,
        })
      ),
      smartcardDetect,
      profileSyncLinkSmartcard,
      profileSyncCompare: vi.fn().mockResolvedValue(undefined),
    } as unknown as typeof window.multissh;

    render(<SyncSettingsPanel />);
    const linkBtn = await screen.findByRole('button', { name: /Link card/i });
    expect(linkBtn).toBeInTheDocument();

    fireEvent.click(linkBtn);
    expect(await screen.findByText('Link smartcard to sync')).toBeInTheDocument();

    const passwordInput = screen.getByLabelText('Master password');
    fireEvent.change(passwordInput, { target: { value: 'master-pass-123' } });

    const submitBtn = screen.getByRole('button', { name: 'Link smartcard' });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(profileSyncLinkSmartcard).toHaveBeenCalledWith({
        pkcs11LibPath: '/usr/lib/opensc-pkcs11.so',
        passwords: {
          topologyPassword: 'master-pass-123',
          credentialsPassword: 'master-pass-123',
        },
      });
      expect(screen.getByText('Smartcard linked to sync.')).toBeInTheDocument();
    });
  });
});
