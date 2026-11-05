// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TeamVaultDetailPanel } from '../../src/renderer/src/components/SettingsModal/TeamVaultDetailPanel';
import { ConfirmProvider } from '../../src/renderer/src/components/ConfirmDialog';
import type { TeamVaultStatus } from '../../src/shared/types/teamVault';

const VAULT_ID = 'vlt_1';

function renderPanel(onVaultRemoved = vi.fn(), onBack = vi.fn()) {
  return render(
    <ConfirmProvider>
      <TeamVaultDetailPanel vaultId={VAULT_ID} onBack={onBack} onVaultRemoved={onVaultRemoved} />
    </ConfirmProvider>
  );
}

describe('TeamVaultDetailPanel', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  describe('existing vault', () => {
    const baseStatus: TeamVaultStatus = {
      exists: true,
      vaultId: VAULT_ID,
      unlocked: true,
      filePath: '/x',
      members: [
        { recipientId: 'alice@piv:abc', role: 'admin', addedAt: '2026-10-01T00:00:00Z' },
      ],
      adminCount: 1,
      selfRecipientId: 'alice@piv:abc',
      selfRole: 'admin',
    };

    function mockApi(overrides: Partial<typeof window.multissh> = {}) {
      window.multissh = {
        settingsGet: vi.fn().mockResolvedValue({}),
        settingsSave: vi.fn().mockResolvedValue({}),
        settingsSetTeamVaultTabVisible: vi.fn().mockResolvedValue({}),
        teamVaultGetStatus: vi.fn().mockResolvedValue(baseStatus),
        teamVaultAddMember: vi.fn().mockResolvedValue(undefined),
        teamVaultRemoveMember: vi.fn().mockResolvedValue({ remainingAdmins: 0 }),
        teamVaultSetRole: vi.fn().mockResolvedValue(undefined),
        teamVaultDelete: vi.fn().mockResolvedValue(undefined),
        teamVaultLock: vi.fn().mockResolvedValue(undefined),
        ...overrides,
      } as unknown as typeof window.multissh;
    }

    it('fetches status scoped to this vaultId', async () => {
      mockApi();
      renderPanel();
      await waitFor(() => expect(window.multissh.teamVaultGetStatus).toHaveBeenCalledWith(VAULT_ID));
    });

    it('toggles "show as tab" via the atomic settingsSetTeamVaultTabVisible call, not a settingsGet+settingsSave round trip (the race the atomic method exists to close)', async () => {
      mockApi();
      renderPanel();
      const checkbox = await screen.findByRole('checkbox', { name: /Show this team as a tab/i });
      expect(checkbox).toBeChecked();

      fireEvent.click(checkbox);

      await waitFor(() => {
        expect(window.multissh.settingsSetTeamVaultTabVisible).toHaveBeenCalledWith(VAULT_ID, false);
      });
      expect(window.multissh.settingsSave).not.toHaveBeenCalled();
    });

    it('warns when fewer than 2 admins', async () => {
      mockApi();
      renderPanel();
      await waitFor(() => expect(screen.getByText('alice@piv:abc')).toBeInTheDocument());
      expect(screen.getByText(/fewer than 2 admins/)).toBeInTheDocument();
      // No other member to promote in this fixture (alice is the only member).
      expect(screen.queryByRole('button', { name: /Promote/ })).not.toBeInTheDocument();
    });

    it('offers a quick "Promote <member>" action in the admin warning when another member exists', async () => {
      mockApi({
        teamVaultGetStatus: vi.fn().mockResolvedValue({
          ...baseStatus,
          members: [
            { recipientId: 'alice@piv:abc', role: 'admin', addedAt: '2026-10-01T00:00:00Z' },
            { recipientId: 'bob@piv:def', role: 'member', addedAt: '2026-10-02T00:00:00Z' },
          ],
        }),
      });
      renderPanel();
      await waitFor(() => expect(screen.getByText('bob@piv:def')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: 'Promote bob@piv:def' }));

      await waitFor(() => {
        expect(window.multissh.teamVaultSetRole).toHaveBeenCalledWith(VAULT_ID, 'bob@piv:def', 'admin');
      });
    });

    it('shows this device\'s role for the vault', async () => {
      mockApi();
      renderPanel();
      await waitFor(() => expect(screen.getByText('alice@piv:abc')).toBeInTheDocument());
      expect(screen.getByText('Your role')).toBeInTheDocument();
      expect(screen.getByText('Your role').nextSibling).toHaveTextContent('admin');
    });

    it('adds a member by pasting their join-info blob into the one field — no second box to fill in', async () => {
      mockApi();
      renderPanel();
      await waitFor(() => expect(screen.getByText('alice@piv:abc')).toBeInTheDocument());

      const joinInfo =
        'sshs3 Team Vault join request\nrecipientId: bob@piv:def\nageRecipient: age1yubikey1bobbobbobbobbobbobbobbob';
      fireEvent.change(screen.getByPlaceholderText(/Paste their join info/i), { target: { value: joinInfo } });

      await waitFor(() => {
        expect(screen.getByTestId('parsed-join-info-recipient-id')).toHaveTextContent('bob@piv:def');
      });
      expect(screen.getByTestId('parsed-join-info-age-recipient')).toHaveTextContent(
        'age1yubikey1bobbobbobbobbobbobbobbob'
      );

      fireEvent.click(screen.getByRole('button', { name: 'Add member' }));

      await waitFor(() => {
        expect(window.multissh.teamVaultAddMember).toHaveBeenCalledWith(
          VAULT_ID,
          'bob@piv:def',
          'age1yubikey1bobbobbobbobbobbobbobbob',
          'member'
        );
      });
    });

    it("shows an inline hint instead of a crash when the pasted text isn't a recognizable join blob", async () => {
      mockApi();
      renderPanel();
      await waitFor(() => expect(screen.getByText('alice@piv:abc')).toBeInTheDocument());

      fireEvent.change(screen.getByPlaceholderText(/Paste their join info/i), { target: { value: 'oops wrong thing' } });

      expect(await screen.findByText(/doesn't look like a join-info blob/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Add member' })).toBeDisabled();
    });

    it('asks for confirmation before removing a member', async () => {
      mockApi();
      renderPanel();
      await waitFor(() => expect(screen.getByText('alice@piv:abc')).toBeInTheDocument());

      fireEvent.click(screen.getByTitle('Remove member'));
      const dialog = await screen.findByTestId('confirm-dialog');
      expect(dialog).toHaveTextContent('alice@piv:abc');

      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

      await waitFor(() => {
        expect(window.multissh.teamVaultRemoveMember).toHaveBeenCalledWith(VAULT_ID, 'alice@piv:abc');
      });
    });

    it("disables Demote for the last admin so they can't lock everyone out", async () => {
      mockApi();
      renderPanel();
      await waitFor(() => expect(screen.getByText('alice@piv:abc')).toBeInTheDocument());

      const demoteButton = screen.getByRole('button', { name: 'Demote' });
      expect(demoteButton).toBeDisabled();
      expect(demoteButton).toHaveAttribute('title', "Can't demote the last admin — promote another member first");

      fireEvent.click(demoteButton);
      expect(window.multissh.teamVaultSetRole).not.toHaveBeenCalled();
    });

    it('promotes/demotes a member via the role button once a second admin exists', async () => {
      mockApi({
        teamVaultGetStatus: vi.fn().mockResolvedValue({
          ...baseStatus,
          adminCount: 2,
          members: [
            { recipientId: 'alice@piv:abc', role: 'admin', addedAt: '2026-10-01T00:00:00Z' },
            { recipientId: 'bob@piv:def', role: 'admin', addedAt: '2026-10-02T00:00:00Z' },
          ],
        }),
      });
      renderPanel();
      await waitFor(() => expect(screen.getByText('bob@piv:def')).toBeInTheDocument());

      const bobRow = screen.getByText('bob@piv:def').closest('div[class*="rounded-lg"]') as HTMLElement;
      fireEvent.click(within(bobRow).getByRole('button', { name: 'Demote' }));

      await waitFor(() => {
        expect(window.multissh.teamVaultSetRole).toHaveBeenCalledWith(VAULT_ID, 'bob@piv:def', 'member');
      });
    });

    it("hides Copy invite on the signed-in identity's own row", async () => {
      mockApi({
        teamVaultGetStatus: vi.fn().mockResolvedValue({
          ...baseStatus,
          adminCount: 2,
          members: [
            { recipientId: 'alice@piv:abc', role: 'admin', addedAt: '2026-10-01T00:00:00Z' },
            { recipientId: 'bob@piv:def', role: 'admin', addedAt: '2026-10-02T00:00:00Z' },
          ],
        }),
      });
      renderPanel();
      await waitFor(() => expect(screen.getByText('bob@piv:def')).toBeInTheDocument());

      const aliceRow = screen.getByText('alice@piv:abc').closest('div[class*="rounded-lg"]') as HTMLElement;
      const bobRow = screen.getByText('bob@piv:def').closest('div[class*="rounded-lg"]') as HTMLElement;
      expect(within(aliceRow).queryByRole('button', { name: /Copy invite/ })).not.toBeInTheDocument();
      expect(within(bobRow).getByRole('button', { name: /Copy invite/ })).toBeInTheDocument();
    });

    it('locks the vault immediately via "Lock now"', async () => {
      mockApi();
      renderPanel();
      await waitFor(() => expect(screen.getByText('Unlocked for this session')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: 'Lock now' }));

      await waitFor(() => expect(window.multissh.teamVaultLock).toHaveBeenCalledWith(VAULT_ID));
    });

    it('offers to delete the vault (local-only) when the signed-in identity is an admin, with confirmation, then reports it removed', async () => {
      mockApi();
      const onVaultRemoved = vi.fn();
      renderPanel(onVaultRemoved);
      await waitFor(() => expect(screen.getByText('alice@piv:abc')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: /Remove vault from this machine/i }));
      const dialog = await screen.findByTestId('confirm-dialog');
      expect(dialog).toHaveTextContent(/S3 copy/i);

      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

      await waitFor(() => expect(window.multissh.teamVaultDelete).toHaveBeenCalledWith(VAULT_ID));
      await waitFor(() => expect(onVaultRemoved).toHaveBeenCalled());
    });

    it('hides the delete-vault button for a plain, non-admin member', async () => {
      mockApi({
        teamVaultGetStatus: vi.fn().mockResolvedValue({
          ...baseStatus,
          selfRecipientId: 'bob@piv:def',
          selfRole: 'member',
          members: [
            { recipientId: 'alice@piv:abc', role: 'admin', addedAt: '2026-10-01T00:00:00Z' },
            { recipientId: 'bob@piv:def', role: 'member', addedAt: '2026-10-02T00:00:00Z' },
          ],
        }),
      });

      renderPanel();
      await waitFor(() => expect(screen.getByText('alice@piv:abc')).toBeInTheDocument());
      expect(screen.queryByRole('button', { name: /Remove vault from this machine/i })).not.toBeInTheDocument();
    });
  });

  describe('locked vault, with a remembered own identity (no fields needed to unlock)', () => {
    const lockedStatus: TeamVaultStatus = {
      exists: true,
      vaultId: VAULT_ID,
      unlocked: false,
      filePath: '/x',
      members: [
        { recipientId: 'alice@piv:abc', role: 'admin', addedAt: '2026-10-01T00:00:00Z' },
      ],
      adminCount: 1,
      selfRecipientId: 'alice@piv:abc',
      selfIdentityFilePath: '/home/alice/.config/sshs3/team-vault-identities/abc.txt',
    };

    function mockApi() {
      window.multissh = {
        settingsGet: vi.fn().mockResolvedValue({}),
        settingsSave: vi.fn().mockResolvedValue({}),
        settingsSetTeamVaultTabVisible: vi.fn().mockResolvedValue({}),
        teamVaultGetStatus: vi.fn().mockResolvedValue(lockedStatus),
        teamVaultUnlock: vi.fn().mockResolvedValue(undefined),
      } as unknown as typeof window.multissh;
    }

    it('shows no recipient-id/identity-path fields at all when both are already known — just an Unlock button', async () => {
      mockApi();
      renderPanel();
      await waitFor(() => expect(screen.getByText(/Unlock as/)).toBeInTheDocument());

      expect(screen.getByText(/Unlock as/)).toHaveTextContent('alice@piv:abc');
      expect(screen.queryByPlaceholderText('Your recipient id')).not.toBeInTheDocument();
      expect(screen.queryByPlaceholderText('Path to your identity file')).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
      await waitFor(() => {
        expect(window.multissh.teamVaultUnlock).toHaveBeenCalledWith(
          VAULT_ID,
          'alice@piv:abc',
          '/home/alice/.config/sshs3/team-vault-identities/abc.txt'
        );
      });
    });

    it('offers a manual fallback ("use a different identity") for the rare case of multiple identities or a new machine', async () => {
      mockApi();
      renderPanel();
      await waitFor(() => expect(screen.getByText(/Unlock as/)).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: /use a different identity/i }));

      const recipientInput = screen.getByPlaceholderText('Your recipient id') as HTMLInputElement;
      const identityInput = screen.getByPlaceholderText('Path to your identity file') as HTMLInputElement;
      fireEvent.change(recipientInput, { target: { value: 'carol@piv:ghi' } });
      fireEvent.change(identityInput, { target: { value: '/tmp/carol-identity.txt' } });
      fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));

      await waitFor(() => {
        expect(window.multissh.teamVaultUnlock).toHaveBeenCalledWith(VAULT_ID, 'carol@piv:ghi', '/tmp/carol-identity.txt');
      });
    });
  });

  describe('locked vault, with no remembered identity at all (fresh machine)', () => {
    function mockApi() {
      window.multissh = {
        teamVaultGetStatus: vi.fn().mockResolvedValue({
          exists: true,
          vaultId: VAULT_ID,
          unlocked: false,
          filePath: '/x',
          members: [{ recipientId: 'alice@piv:abc', role: 'admin', addedAt: '2026-10-01T00:00:00Z' }],
          adminCount: 1,
        }),
        settingsGet: vi.fn().mockResolvedValue({}),
        settingsSave: vi.fn().mockResolvedValue({}),
        settingsSetTeamVaultTabVisible: vi.fn().mockResolvedValue({}),
        teamVaultUnlock: vi.fn().mockResolvedValue(undefined),
      } as unknown as typeof window.multissh;
    }

    it('falls back to the manual fields directly, with no "known identity" summary to show', async () => {
      mockApi();
      renderPanel();
      await waitFor(() => expect(screen.getByText('alice@piv:abc')).toBeInTheDocument());

      expect(screen.getByPlaceholderText('Your recipient id')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Path to your identity file')).toBeInTheDocument();
    });
  });

  describe('recovery (lost card, has only the saved recovery key text)', () => {
    function mockApi() {
      window.multissh = {
        teamVaultGetStatus: vi.fn().mockResolvedValue({
          exists: true,
          vaultId: VAULT_ID,
          unlocked: false,
          filePath: '/x',
          members: [{ recipientId: 'alice@piv:abc', role: 'admin', addedAt: '2026-10-01T00:00:00Z' }],
          adminCount: 1,
        }),
        settingsGet: vi.fn().mockResolvedValue({}),
        settingsSave: vi.fn().mockResolvedValue({}),
        settingsSetTeamVaultTabVisible: vi.fn().mockResolvedValue({}),
        teamVaultUnlockWithRecoveryText: vi.fn().mockResolvedValue(undefined),
      } as unknown as typeof window.multissh;
    }

    it('reveals a textarea and recovers the vault with the pasted recovery key', async () => {
      mockApi();
      renderPanel();
      await waitFor(() => expect(screen.getByText('alice@piv:abc')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: /Lost your card\?/i }));
      const textarea = screen.getByPlaceholderText('AGE-SECRET-KEY-1...');
      fireEvent.change(textarea, { target: { value: 'AGE-SECRET-KEY-1FAKERECOVERYTEXT' } });

      fireEvent.click(screen.getByRole('button', { name: 'Recover vault access' }));

      await waitFor(() => {
        expect(window.multissh.teamVaultUnlockWithRecoveryText).toHaveBeenCalledWith(
          VAULT_ID,
          'AGE-SECRET-KEY-1FAKERECOVERYTEXT'
        );
      });
    });

    it('surfaces an error if the pasted text is rejected', async () => {
      mockApi();
      window.multissh.teamVaultUnlockWithRecoveryText = vi
        .fn()
        .mockRejectedValue(new Error('This does not look like a Team Vault recovery key'));
      renderPanel();
      await waitFor(() => expect(screen.getByText('alice@piv:abc')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: /Lost your card\?/i }));
      fireEvent.change(screen.getByPlaceholderText('AGE-SECRET-KEY-1...'), { target: { value: 'garbage' } });
      fireEvent.click(screen.getByRole('button', { name: 'Recover vault access' }));

      await waitFor(() => expect(screen.getByText(/does not look like a Team Vault recovery key/)).toBeInTheDocument());
    });
  });

  describe('remote sync (Fas 3)', () => {
    const baseStatus: TeamVaultStatus = {
      exists: true,
      vaultId: VAULT_ID,
      unlocked: true,
      filePath: '/x',
      members: [{ recipientId: 'alice@piv:abc', role: 'admin', addedAt: '2026-10-01T00:00:00Z' }],
      adminCount: 1,
      remoteConfigured: false,
    };

    function mockApi(overrides: Partial<typeof window.multissh> = {}) {
      window.multissh = {
        settingsGet: vi.fn().mockResolvedValue({}),
        settingsSave: vi.fn().mockResolvedValue({}),
        settingsSetTeamVaultTabVisible: vi.fn().mockResolvedValue({}),
        teamVaultGetStatus: vi.fn().mockResolvedValue(baseStatus),
        teamVaultSetTarget: vi.fn().mockResolvedValue(undefined),
        teamVaultPush: vi.fn().mockResolvedValue(undefined),
        teamVaultPull: vi.fn().mockResolvedValue(undefined),
        teamVaultGetSyncPreview: vi.fn().mockResolvedValue({ hasUnpushedLocalChanges: false, remoteChanged: false }),
        ...overrides,
      } as unknown as typeof window.multissh;
    }

    it('configures an S3 target, scoped to this vaultId', async () => {
      mockApi();
      renderPanel();
      await waitFor(() => expect(screen.getByText('No S3 target configured yet')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: /Configure target/i }));
      fireEvent.change(await screen.findByLabelText(/Region/i), { target: { value: 'us-east-1' } });
      fireEvent.change(screen.getByLabelText(/Access Key ID/i), { target: { value: 'AKIA' } });
      fireEvent.change(screen.getByLabelText(/Secret Access Key/i), { target: { value: 'secret' } });
      fireEvent.change(screen.getByLabelText(/Bucket/i), { target: { value: 'team-bucket' } });

      fireEvent.click(screen.getByRole('button', { name: 'Save target' }));

      await waitFor(() => {
        expect(window.multissh.teamVaultSetTarget).toHaveBeenCalledWith(
          VAULT_ID,
          expect.objectContaining({ type: 's3' }),
          'team-bucket'
        );
      });
    });

    it('prefills "Edit target" from the saved target (minus the secret, which never reaches the renderer) and offers to keep it unchanged', async () => {
      mockApi({
        teamVaultGetStatus: vi.fn().mockResolvedValue({
          ...baseStatus,
          remoteConfigured: true,
          remoteBasePath: 'team-bucket/prefix',
          targetConfig: {
            type: 's3',
            s3Config: {
              region: 'eu-north-1',
              accessKeyId: 'AKIASAVED',
              secretAccessKey: '',
              hasSecretAccessKey: true,
              endpoint: 'https://s3.example.com',
            },
          },
        }),
      });
      renderPanel();
      await waitFor(() => expect(screen.getByText('S3 target configured')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: /Edit target/i }));

      expect(await screen.findByLabelText(/Region/i)).toHaveValue('eu-north-1');
      expect(screen.getByLabelText(/Access Key ID/i)).toHaveValue('AKIASAVED');
      // The secret itself is never sent to the renderer — only a flag that one is saved.
      expect(screen.getByLabelText(/Secret Access Key/i)).toHaveValue('');
      expect(screen.getByLabelText(/Bucket/i)).toHaveValue('team-bucket/prefix');
      expect(screen.getByText(/already saved.*Leave "Secret Access Key" blank to keep it/)).toBeInTheDocument();
    });

    it('saves "Edit target" with a blank secret when one is already saved, relying on the main process to preserve it', async () => {
      mockApi({
        teamVaultGetStatus: vi.fn().mockResolvedValue({
          ...baseStatus,
          remoteConfigured: true,
          remoteBasePath: 'team-bucket/prefix',
          targetConfig: {
            type: 's3',
            s3Config: { region: 'eu-north-1', accessKeyId: 'AKIASAVED', secretAccessKey: '', hasSecretAccessKey: true },
          },
        }),
      });
      renderPanel();
      await waitFor(() => expect(screen.getByText('S3 target configured')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: /Edit target/i }));
      await screen.findByLabelText(/Region/i);
      fireEvent.click(screen.getByRole('button', { name: 'Save target' }));

      await waitFor(() => {
        expect(window.multissh.teamVaultSetTarget).toHaveBeenCalledWith(
          VAULT_ID,
          expect.objectContaining({ s3Config: expect.objectContaining({ accessKeyId: 'AKIASAVED', secretAccessKey: '' }) }),
          'team-bucket/prefix'
        );
      });
    });

    it('pushes and pulls once a target is configured, scoped to this vaultId', async () => {
      mockApi({
        teamVaultGetStatus: vi
          .fn()
          .mockResolvedValue({ ...baseStatus, remoteConfigured: true, lastSyncAt: '2026-10-08T00:00:00Z' }),
      });

      renderPanel();
      await waitFor(() => expect(screen.getByText('S3 target configured')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: 'Push' }));
      await waitFor(() => expect(window.multissh.teamVaultPush).toHaveBeenCalledWith(VAULT_ID));

      fireEvent.click(screen.getByRole('button', { name: 'Pull' }));
      await waitFor(() => expect(window.multissh.teamVaultPull).toHaveBeenCalledWith(VAULT_ID, undefined));
    });

    it('shows sync status before Push/Pull, highlighting Pull when the remote changed', async () => {
      mockApi({
        teamVaultGetStatus: vi
          .fn()
          .mockResolvedValue({ ...baseStatus, remoteConfigured: true, lastSyncAt: '2026-10-08T00:00:00Z' }),
        teamVaultGetSyncPreview: vi.fn().mockResolvedValue({ hasUnpushedLocalChanges: false, remoteChanged: true }),
      });

      renderPanel();
      await waitFor(() => expect(screen.getByText('Remote has a newer version — pull first')).toBeInTheDocument());
      expect(screen.getByRole('button', { name: /Pull/ }).className).toContain('border-amber-500');
    });

    it('shows sync status before Push/Pull, highlighting Push when there are unpushed local changes', async () => {
      mockApi({
        teamVaultGetStatus: vi
          .fn()
          .mockResolvedValue({ ...baseStatus, remoteConfigured: true, lastSyncAt: '2026-10-08T00:00:00Z' }),
        teamVaultGetSyncPreview: vi.fn().mockResolvedValue({ hasUnpushedLocalChanges: true, remoteChanged: false }),
      });

      renderPanel();
      await waitFor(() => expect(screen.getByText('Local changes not pushed')).toBeInTheDocument());
      expect(screen.getByRole('button', { name: /Push/ }).className).toContain('border-sky-500');
    });

    it('shows "Up to date" when nothing needs syncing', async () => {
      mockApi({
        teamVaultGetStatus: vi
          .fn()
          .mockResolvedValue({ ...baseStatus, remoteConfigured: true, lastSyncAt: '2026-10-08T00:00:00Z' }),
      });

      renderPanel();
      await waitFor(() => expect(screen.getByText('Up to date')).toBeInTheDocument());
    });

    it('offers to pull anyway (discarding local changes) when the pull is rejected as unpushed', async () => {
      mockApi({
        teamVaultGetStatus: vi
          .fn()
          .mockResolvedValue({ ...baseStatus, remoteConfigured: true, lastSyncAt: '2026-10-08T00:00:00Z' }),
        teamVaultPull: vi
          .fn()
          .mockRejectedValueOnce(new Error('This machine has local Team Vault changes that have not been pushed yet.'))
          .mockResolvedValueOnce(undefined),
      });

      renderPanel();
      await waitFor(() => expect(screen.getByText('S3 target configured')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: 'Pull' }));
      const dialog = await screen.findByTestId('confirm-dialog');
      expect(dialog).toHaveTextContent('Unpushed local changes');

      fireEvent.click(within(dialog).getByRole('button', { name: /Pull anyway/i }));

      await waitFor(() => expect(window.multissh.teamVaultPull).toHaveBeenCalledWith(VAULT_ID, { force: true }));
    });
  });
});
