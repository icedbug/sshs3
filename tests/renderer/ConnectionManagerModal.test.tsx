// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ConnectionManagerModal } from '../../src/renderer/src/components/ConnectionModal/ConnectionManagerModal';
import { ConfirmProvider } from '../../src/renderer/src/components/ConfirmDialog';
import type { SSHConnectionConfig } from '../../src/shared/types/ssh';
import type { S3Config } from '../../src/shared/types/storage';

const mockSSHProfiles: SSHConnectionConfig[] = [
  {
    id: 'ssh-1',
    name: 'Prod Web 01',
    host: 'web01.prod.example.com',
    port: 22,
    username: 'deploy',
    authType: 'password',
    group: 'Produktion',
    lastUsedAt: '2026-09-16 12:30',
  },
  {
    id: 'ssh-2',
    name: 'Prod DB 01',
    host: 'db01.prod.example.com',
    port: 2222,
    username: 'postgres',
    authType: 'password',
    group: 'Produktion',
    forwardAgent: true,
  },
  {
    id: 'ssh-3',
    name: 'Dev Sandbox',
    host: 'sandbox.dev.example.com',
    port: 22,
    username: 'ubuntu',
    authType: 'password',
    group: 'Utveckling',
  },
];

const mockS3Profiles: S3Config[] = [
  {
    id: 's3-1',
    name: 'Backup Bucket',
    region: 'eu-north-1',
    accessKeyId: 'test-key',
    secretAccessKey: 'test-secret',
    group: 'Backuper',
    lastUsedAt: '2026-09-15 09:15',
  },
];

describe('ConnectionManagerModal', () => {
  beforeEach(() => {
    window.multissh = {
      settingsGet: vi.fn().mockResolvedValue({}),
      settingsSave: vi.fn().mockResolvedValue({}),
      profilesGet: vi.fn().mockResolvedValue({
        ssh: mockSSHProfiles,
        s3: mockS3Profiles,
      }),
      profilesSaveSSH: vi.fn().mockResolvedValue(undefined),
      profilesSaveS3: vi.fn().mockResolvedValue(undefined),
      profilesDeleteSSH: vi.fn().mockResolvedValue(undefined),
      profilesDeleteS3: vi.fn().mockResolvedValue(undefined),
      teamVaultGetStatus: vi.fn().mockResolvedValue({
        exists: true,
        unlocked: true,
        filePath: '/x',
        selfRecipientId: 'alice@piv:abc',
        selfIdentityFilePath: '/tmp/alice-identity.txt',
      }),
      // No teams by default — tests inside the "Team Vault view" describe below override this
      // with whichever vaults they need.
      teamVaultList: vi.fn().mockResolvedValue([]),
    } as unknown as typeof window.multissh;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('does not render when open is false', () => {
    const { container } = render(
      <ConfirmProvider>
        <ConnectionManagerModal open={false} onClose={vi.fn()} />
      </ConfirmProvider>
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders profile groups and recently used section for SSH', async () => {
    render(
      <ConfirmProvider>
        <ConnectionManagerModal
          open={true}
          onClose={vi.fn()}
          onConnectSSH={vi.fn()}
        />
      </ConfirmProvider>
    );

    // Verify recent section
    await waitFor(() => {
      expect(screen.getByText('Recently Used')).toBeInTheDocument();
    });
    expect(screen.getByText(/Last connected: 2026-09-16 12:30/)).toBeInTheDocument();

    // Verify folders / groups with count badges
    expect(screen.getAllByText('Produktion').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Utveckling')).toBeInTheDocument();

    // Verify profiles rendered
    expect(screen.getAllByText('Prod Web 01').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Prod DB 01')).toBeInTheDocument();
    expect(screen.getByText('Agent Fwd')).toBeInTheDocument();
    expect(screen.getByText('Dev Sandbox')).toBeInTheDocument();
  });

  it('filters profiles and groups based on search query', async () => {
    render(
      <ConfirmProvider>
        <ConnectionManagerModal
          open={true}
          onClose={vi.fn()}
          onConnectSSH={vi.fn()}
        />
      </ConfirmProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('Dev Sandbox')).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText('Search profiles, or type user@host to connect...');
    fireEvent.change(searchInput, { target: { value: 'sandbox' } });

    // Sandbox should remain, Prod should be filtered out
    expect(screen.getByText('Dev Sandbox')).toBeInTheDocument();
    expect(screen.queryByText('Prod Web 01')).not.toBeInTheDocument();
    expect(screen.queryByText('Prod DB 01')).not.toBeInTheDocument();

    // Search query also suppresses the recently used section
    expect(screen.queryByText('Recently Used')).not.toBeInTheDocument();
  });

  it('allows collapsing and expanding a group folder', async () => {
    render(
      <ConfirmProvider>
        <ConnectionManagerModal
          open={true}
          onClose={vi.fn()}
          onConnectSSH={vi.fn()}
        />
      </ConfirmProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('Prod DB 01')).toBeInTheDocument();
    });

    // Click "Produktion" folder header to collapse (folder header button containing 'Produktion')
    const groupHeader = screen.getByRole('button', { name: /Produktion/ });
    fireEvent.click(groupHeader);

    // Items inside group should now be collapsed/hidden
    expect(screen.queryByText('Prod DB 01')).not.toBeInTheDocument();

    // Click again to expand
    fireEvent.click(groupHeader);
    expect(screen.getByText('Prod DB 01')).toBeInTheDocument();
  });

  it('calls onConnectSSH with updated timestamp when Connect is clicked', async () => {
    const onConnectSSH = vi.fn();
    render(
      <ConfirmProvider>
        <ConnectionManagerModal
          open={true}
          onClose={vi.fn()}
          onConnectSSH={onConnectSSH}
        />
      </ConfirmProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('Dev Sandbox')).toBeInTheDocument();
    });

    // Find the connect button for Dev Sandbox
    const connectButtons = screen.getAllByRole('button', { name: 'Connect' });
    expect(connectButtons.length).toBeGreaterThan(0);

    fireEvent.click(connectButtons[connectButtons.length - 1]);

    await waitFor(() => {
      expect(window.multissh.profilesSaveSSH).toHaveBeenCalled();
      expect(onConnectSSH).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'ssh-3',
          name: 'Dev Sandbox',
          lastUsedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/),
        })
      );
    });
  });

  it('switches to S3 tab and displays S3 profiles and groups', async () => {
    render(
      <ConfirmProvider>
        <ConnectionManagerModal
          open={true}
          onClose={vi.fn()}
        />
      </ConfirmProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('Dev Sandbox')).toBeInTheDocument();
    });

    // Switch to S3 tab
    const s3TabButton = screen.getByRole('button', { name: /S3/i });
    fireEvent.click(s3TabButton);

    await waitFor(() => {
      expect(screen.getAllByText('Backup Bucket').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Backuper').length).toBeGreaterThanOrEqual(1);
    });
  });

  // M12 (code review): this dialog previously only closed via the header X.
  it('calls onClose on Escape and on a backdrop click from the list view (M12)', async () => {
    const onClose = vi.fn();
    const { container } = render(
      <ConfirmProvider>
        <ConnectionManagerModal open={true} onClose={onClose} />
      </ConfirmProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('Dev Sandbox')).toBeInTheDocument();
    });

    fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(container.firstElementChild as Element);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  // M12 (code review): an accidental Escape or stray backdrop click while a
  // profile form is open must not silently discard it — there's no
  // unsaved-changes warning here, unlike closing via the form's own Cancel.
  it('does not close on Escape or backdrop click while a profile form is open (M12)', async () => {
    const onClose = vi.fn();
    const { container } = render(
      <ConfirmProvider>
        <ConnectionManagerModal open={true} onClose={onClose} />
      </ConfirmProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('Dev Sandbox')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('New Profile'));

    await waitFor(() => {
      expect(screen.queryByText('Dev Sandbox')).not.toBeInTheDocument();
    });

    fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' });
    fireEvent.click(container.firstElementChild as Element);

    expect(onClose).not.toHaveBeenCalled();
  });

  // LOW finding (code review): deleting a connection profile used to go
  // through window.confirm(), trivially dismissed by a stray Enter/Space
  // press. It must now name the profile and only delete once confirmed.
  it('opens the install-public-key dialog for the clicked profile', async () => {
    (window.multissh as any).listPublicKeys = vi.fn().mockResolvedValue([]);
    render(
      <ConfirmProvider>
        <ConnectionManagerModal open={true} onClose={vi.fn()} onConnectSSH={vi.fn()} />
      </ConfirmProvider>
    );

    await waitFor(() => expect(screen.getByText('Prod DB 01')).toBeInTheDocument());
    fireEvent.click(screen.getAllByTitle('More actions')[0]);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Install public key' }));

    expect(await screen.findByTestId('install-key-modal')).toBeInTheDocument();
    expect((window.multissh as any).listPublicKeys).toHaveBeenCalledWith(
      expect.objectContaining({ config: expect.objectContaining({ host: expect.any(String) }) })
    );
  });

  it('opens straight into the empty new-profile form when startNewProfile is set, and only for that open', async () => {
    const { rerender } = render(
      <ConfirmProvider>
        <ConnectionManagerModal open={true} startNewProfile onClose={vi.fn()} />
      </ConfirmProvider>
    );
    expect(await screen.findByLabelText(/Profile Name/i)).toHaveValue('');

    // Closed and re-opened without the flag: back to the plain list.
    rerender(
      <ConfirmProvider>
        <ConnectionManagerModal open={false} onClose={vi.fn()} />
      </ConfirmProvider>
    );
    rerender(
      <ConfirmProvider>
        <ConnectionManagerModal open={true} onClose={vi.fn()} />
      </ConfirmProvider>
    );
    await waitFor(() => expect(screen.getByText('Prod DB 01')).toBeInTheDocument());
    expect(screen.queryByLabelText(/Profile Name/i)).not.toBeInTheDocument();
  });

  it('asks for in-app confirmation before deleting a connection profile', async () => {
    render(
      <ConfirmProvider>
        <ConnectionManagerModal open={true} onClose={vi.fn()} />
      </ConfirmProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('Dev Sandbox')).toBeInTheDocument();
    });

    // Delete lives in each row's overflow menu. Dev Sandbox is the last row, per the Connect-button test's ordering.
    const openDeleteMenu = async () => {
      const menus = screen.getAllByTitle('More actions');
      fireEvent.click(menus[menus.length - 1]);
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete profile' }));
    };
    await openDeleteMenu();

    const dialog = await screen.findByTestId('confirm-dialog');
    expect(dialog).toHaveTextContent('Dev Sandbox');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(window.multissh.profilesDeleteSSH).not.toHaveBeenCalled();

    await openDeleteMenu();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(window.multissh.profilesDeleteSSH).toHaveBeenCalledWith('ssh-3');
    });
  });

  describe('Team Vault view (docs/team-vault-plan.md multi-team plan: every known team, each its own section)', () => {
    const VAULT_ID = 'vlt_1';

    function unlockedStatus(overrides: Record<string, unknown> = {}) {
      return {
        exists: true,
        vaultId: VAULT_ID,
        vaultName: 'Acme Infra Team',
        unlocked: true,
        filePath: '/x',
        members: [{ recipientId: 'alice@piv:abc', role: 'admin', addedAt: '2026-01-01T00:00:00Z' }],
        adminCount: 1,
        selfRecipientId: 'alice@piv:abc',
        selfIdentityFilePath: '/tmp/alice-identity.txt',
        selfRole: 'admin',
        ...overrides,
      };
    }

    function lockedStatus(overrides: Record<string, unknown> = {}) {
      return {
        exists: true,
        vaultId: VAULT_ID,
        vaultName: 'Acme Infra Team',
        unlocked: false,
        filePath: '/x',
        members: [{ recipientId: 'alice@piv:abc', role: 'admin', addedAt: '2026-01-01T00:00:00Z' }],
        adminCount: 1,
        selfRecipientId: 'alice@piv:abc',
        selfIdentityFilePath: '/tmp/alice-identity.txt',
        selfRole: 'admin',
        ...overrides,
      };
    }

    it('shows each known team as its own tab next to Personal', async () => {
      window.multissh.teamVaultList = vi.fn().mockResolvedValue([unlockedStatus()]);
      window.multissh.teamVaultGetStatus = vi.fn().mockResolvedValue(unlockedStatus());
      window.multissh.teamVaultGetPayload = vi.fn().mockResolvedValue({ ssh: [], s3: [] });
      render(
        <ConfirmProvider>
          <ConnectionManagerModal open={true} onClose={vi.fn()} />
        </ConfirmProvider>
      );
      await waitFor(() => expect(screen.getByRole('button', { name: 'Acme Infra Team' })).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: 'Acme Infra Team' }));
      await waitFor(() => expect(screen.getByText('No shared profiles yet')).toBeInTheDocument());

      // §11: the panel below must not repeat the team's name — the tab row already names it.
      expect(screen.getAllByText('Acme Infra Team')).toHaveLength(1);
    });

    it('keeps the per-tab "Set as default tab" pin button keyboard-reachable (CLAUDE.md: 100% mouse-free navigation) — it must stay in the tab order via an opacity reveal, not `hidden`/`display:none`', async () => {
      window.multissh.teamVaultList = vi.fn().mockResolvedValue([unlockedStatus()]);
      window.multissh.teamVaultGetStatus = vi.fn().mockResolvedValue(unlockedStatus());
      window.multissh.teamVaultGetPayload = vi.fn().mockResolvedValue({ ssh: [], s3: [] });
      render(
        <ConfirmProvider>
          <ConnectionManagerModal open={true} onClose={vi.fn()} />
        </ConfirmProvider>
      );
      // Wait for the team tab itself to render before looking for its pin button — there's one
      // "Set as default tab" button per tab (Personal included), so querying before the team tab
      // exists would resolve to Personal's instead.
      await waitFor(() => expect(screen.getByRole('button', { name: 'Acme Infra Team' })).toBeInTheDocument());
      // Found via getAllByRole with no prior hover/pointer interaction at all — an element hidden
      // via the HTML `hidden` attribute or a `display:none` class is excluded from the
      // accessibility tree and wouldn't be findable this way, exactly the bug this
      // regression-tests. The team tab's pin button is the second one (Personal's is first).
      const pinButtons = screen.getAllByRole('button', { name: 'Set as default tab' });
      expect(pinButtons).toHaveLength(2);
      const pinButton = pinButtons[1];

      // A `hidden` Tailwind utility (display:none) is what originally made this unreachable by
      // keyboard — assert the fix (opacity-based reveal) is what's actually applied, not just
      // that *some* button with this name exists somewhere.
      expect(pinButton.className).not.toMatch(/(?:^|\s)hidden(?:\s|$)/);
      expect(pinButton.className).toContain('opacity-0');
      expect(pinButton.className).toContain('focus-visible:opacity-100');

      // And it's genuinely focusable/clickable via keyboard, not just present in markup.
      pinButton.focus();
      expect(document.activeElement).toBe(pinButton);
      fireEvent.click(pinButton);
      await waitFor(() => {
        expect(window.multissh.settingsSave).toHaveBeenCalledWith({ connectionManagerDefaultTab: VAULT_ID });
      });
    });

    it('shows the team description under the tab row, preserving line breaks instead of collapsing them to one line', async () => {
      window.multissh.teamVaultList = vi
        .fn()
        .mockResolvedValue([unlockedStatus({ vaultDescription: 'Line one\nLine two' })]);
      window.multissh.teamVaultGetStatus = vi.fn().mockResolvedValue(unlockedStatus());
      window.multissh.teamVaultGetPayload = vi.fn().mockResolvedValue({ ssh: [], s3: [] });
      render(
        <ConfirmProvider>
          <ConnectionManagerModal open={true} onClose={vi.fn()} />
        </ConfirmProvider>
      );
      await waitFor(() => expect(screen.getByRole('button', { name: 'Acme Infra Team' })).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: 'Acme Infra Team' }));

      const descriptions = await screen.findAllByText((_, el) => el?.textContent === 'Line one\nLine two');
      const paragraph = descriptions.find((el) => el.tagName === 'P');
      expect(paragraph?.className).toContain('whitespace-pre-wrap');
    });

    it('lets an admin edit the team description directly from the Connection Manager tab row, without going to Settings', async () => {
      window.multissh.teamVaultList = vi.fn().mockResolvedValue([unlockedStatus({ vaultDescription: 'Old text' })]);
      window.multissh.teamVaultGetStatus = vi.fn().mockResolvedValue(unlockedStatus());
      window.multissh.teamVaultGetPayload = vi.fn().mockResolvedValue({ ssh: [], s3: [] });
      window.multissh.teamVaultSetDescription = vi.fn().mockResolvedValue(undefined);
      render(
        <ConfirmProvider>
          <ConnectionManagerModal open={true} onClose={vi.fn()} />
        </ConfirmProvider>
      );
      await waitFor(() => expect(screen.getByRole('button', { name: 'Acme Infra Team' })).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: 'Acme Infra Team' }));
      await screen.findByText('Old text');

      fireEvent.click(screen.getByTitle('Edit description'));
      const textarea = screen.getByPlaceholderText(/What is this team for/);
      fireEvent.change(textarea, { target: { value: 'New multi-line\ndescription' } });
      fireEvent.click(screen.getByTitle('Save'));

      await waitFor(() => {
        expect(window.multissh.teamVaultSetDescription).toHaveBeenCalledWith(VAULT_ID, 'New multi-line\ndescription');
      });
    });

    it('does not offer an edit affordance to a non-admin member', async () => {
      window.multissh.teamVaultList = vi
        .fn()
        .mockResolvedValue([unlockedStatus({ vaultDescription: 'Team notes', selfRole: 'member' })]);
      window.multissh.teamVaultGetStatus = vi.fn().mockResolvedValue(unlockedStatus({ selfRole: 'member' }));
      window.multissh.teamVaultGetPayload = vi.fn().mockResolvedValue({ ssh: [], s3: [] });
      render(
        <ConfirmProvider>
          <ConnectionManagerModal open={true} onClose={vi.fn()} />
        </ConfirmProvider>
      );
      await waitFor(() => expect(screen.getByRole('button', { name: 'Acme Infra Team' })).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: 'Acme Infra Team' }));
      await screen.findByText('Team notes');

      expect(screen.queryByTitle('Edit description')).not.toBeInTheDocument();
    });

    it('shows a collapsed, locked header with an inline unlock form instead of profiles when a team is locked', async () => {
      window.multissh.teamVaultList = vi.fn().mockResolvedValue([lockedStatus()]);
      render(
        <ConfirmProvider>
          <ConnectionManagerModal open={true} onClose={vi.fn()} />
        </ConfirmProvider>
      );
      await waitFor(() => expect(screen.getByText('Dev Sandbox')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: 'Acme Infra Team' }));
      await waitFor(() => expect(screen.getByText('Acme Infra Team is locked')).toBeInTheDocument());
      // Personal profiles must not leak into the Team view.
      expect(screen.queryByText('Prod Web 01')).not.toBeInTheDocument();
    });

    it('hides the search field while the active team is locked', async () => {
      window.multissh.teamVaultList = vi.fn().mockResolvedValue([lockedStatus()]);
      render(
        <ConfirmProvider>
          <ConnectionManagerModal open={true} onClose={vi.fn()} />
        </ConfirmProvider>
      );
      await waitFor(() => expect(screen.getByText('Dev Sandbox')).toBeInTheDocument());
      expect(screen.getByPlaceholderText(/Search profiles/)).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Acme Infra Team' }));
      await waitFor(() => expect(screen.getByText('Acme Infra Team is locked')).toBeInTheDocument());
      expect(screen.queryByPlaceholderText(/Search profiles/)).not.toBeInTheDocument();
    });

    it('offers "Unlock all" once more than one team is locked, and unlocks every ready vault', async () => {
      window.multissh.teamVaultList = vi.fn().mockResolvedValue([
        lockedStatus({ vaultId: 'vlt_1', vaultName: 'Acme Infra Team' }),
        lockedStatus({ vaultId: 'vlt_2', vaultName: 'Beta Team' }),
      ]);
      window.multissh.teamVaultGetStatus = vi.fn().mockImplementation((vaultId: string) =>
        Promise.resolve(
          vaultId === 'vlt_1'
            ? lockedStatus({ vaultId: 'vlt_1', vaultName: 'Acme Infra Team' })
            : lockedStatus({ vaultId: 'vlt_2', vaultName: 'Beta Team' })
        )
      );
      window.multissh.teamVaultUnlock = vi.fn().mockResolvedValue(undefined);
      render(
        <ConfirmProvider>
          <ConnectionManagerModal open={true} onClose={vi.fn()} />
        </ConfirmProvider>
      );
      await waitFor(() => expect(screen.getByRole('button', { name: 'Acme Infra Team' })).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: 'Acme Infra Team' }));
      await waitFor(() => expect(screen.getByText('Acme Infra Team is locked')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: /Unlock all/ }));

      await waitFor(() => {
        expect(window.multissh.teamVaultUnlock).toHaveBeenCalledWith('vlt_1', 'alice@piv:abc', '/tmp/alice-identity.txt');
        expect(window.multissh.teamVaultUnlock).toHaveBeenCalledWith('vlt_2', 'alice@piv:abc', '/tmp/alice-identity.txt');
      });
    });

    it('unlocks every ready vault from "Unlock all" straight from the default Personal view, without first opening a team tab', async () => {
      window.multissh.teamVaultList = vi.fn().mockResolvedValue([
        lockedStatus({ vaultId: 'vlt_1', vaultName: 'Acme Infra Team' }),
        lockedStatus({ vaultId: 'vlt_2', vaultName: 'Beta Team' }),
      ]);
      window.multissh.teamVaultUnlock = vi.fn().mockResolvedValue(undefined);
      render(
        <ConfirmProvider>
          <ConnectionManagerModal open={true} onClose={vi.fn()} />
        </ConfirmProvider>
      );
      await waitFor(() => expect(screen.getByRole('button', { name: /Unlock all/ })).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: /Unlock all/ }));

      await waitFor(() => {
        expect(window.multissh.teamVaultUnlock).toHaveBeenCalledWith('vlt_1', 'alice@piv:abc', '/tmp/alice-identity.txt');
        expect(window.multissh.teamVaultUnlock).toHaveBeenCalledWith('vlt_2', 'alice@piv:abc', '/tmp/alice-identity.txt');
      });
    });

    it('unlocks "Unlock all" targets one at a time, not concurrently, and surfaces which ones failed', async () => {
      window.multissh.teamVaultList = vi.fn().mockResolvedValue([
        lockedStatus({ vaultId: 'vlt_1', vaultName: 'Acme Infra Team' }),
        lockedStatus({ vaultId: 'vlt_2', vaultName: 'Beta Team' }),
      ]);
      let concurrentCalls = 0;
      let maxConcurrentCalls = 0;
      window.multissh.teamVaultUnlock = vi.fn(async (vaultId: string) => {
        concurrentCalls += 1;
        maxConcurrentCalls = Math.max(maxConcurrentCalls, concurrentCalls);
        await new Promise((resolve) => setTimeout(resolve, 0));
        concurrentCalls -= 1;
        if (vaultId === 'vlt_2') throw new Error('touch timed out');
      });
      render(
        <ConfirmProvider>
          <ConnectionManagerModal open={true} onClose={vi.fn()} />
        </ConfirmProvider>
      );
      await waitFor(() => expect(screen.getByRole('button', { name: /Unlock all/ })).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: /Unlock all/ }));

      await waitFor(() => expect(screen.getByText(/Failed to unlock: Beta Team/)).toBeInTheDocument());
      expect(maxConcurrentCalls).toBe(1);
      expect(window.multissh.teamVaultUnlock).toHaveBeenCalledTimes(2);
    });

    it('refreshes the active team\'s own panel content after "Unlock all", without navigating away (TeamProfileTreeList keeps its own status cache)', async () => {
      const unlockedVaultIds = new Set<string>();
      window.multissh.teamVaultList = vi.fn().mockResolvedValue([
        lockedStatus({ vaultId: 'vlt_1', vaultName: 'Acme Infra Team' }),
        lockedStatus({ vaultId: 'vlt_2', vaultName: 'Beta Team' }),
      ]);
      window.multissh.teamVaultGetStatus = vi.fn().mockImplementation((vaultId: string) =>
        Promise.resolve(
          unlockedVaultIds.has(vaultId)
            ? unlockedStatus({ vaultId, vaultName: vaultId === 'vlt_1' ? 'Acme Infra Team' : 'Beta Team' })
            : lockedStatus({ vaultId, vaultName: vaultId === 'vlt_1' ? 'Acme Infra Team' : 'Beta Team' })
        )
      );
      window.multissh.teamVaultUnlock = vi.fn(async (vaultId: string) => {
        unlockedVaultIds.add(vaultId);
      });
      window.multissh.teamVaultGetPayload = vi.fn().mockResolvedValue({
        ssh: [{ id: 'team-ssh-1', name: 'Shared Bastion', host: 'bastion.example.com', username: 'ops', authType: 'password' }],
        s3: [],
      });

      render(
        <ConfirmProvider>
          <ConnectionManagerModal open={true} onClose={vi.fn()} />
        </ConfirmProvider>
      );
      await waitFor(() => expect(screen.getByRole('button', { name: 'Acme Infra Team' })).toBeInTheDocument());

      // Stay on Acme Infra Team's own tab — TeamProfileTreeList mounts and caches its (locked) status.
      fireEvent.click(screen.getByRole('button', { name: 'Acme Infra Team' }));
      await waitFor(() => expect(screen.getByText('Acme Infra Team is locked')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: /Unlock all/ }));

      // Must show the actual unlocked profile list directly — not just the tab row's lock icon —
      // without the user switching away to Personal and back first.
      await waitFor(() => expect(screen.getByText('Shared Bastion')).toBeInTheDocument());
      expect(screen.queryByText('Acme Infra Team is locked')).not.toBeInTheDocument();
    });

    it('lists shared SSH/S3 profiles once unlocked, separately from personal ones', async () => {
      window.multissh.teamVaultList = vi.fn().mockResolvedValue([unlockedStatus()]);
      window.multissh.teamVaultGetPayload = vi.fn().mockResolvedValue({
        ssh: [
          { id: 'team-ssh-1', name: 'Shared Bastion', host: 'bastion.example.com', username: 'ops', authType: 'password' },
        ],
        s3: [],
      });
      render(
        <ConfirmProvider>
          <ConnectionManagerModal open={true} onClose={vi.fn()} />
        </ConfirmProvider>
      );
      await waitFor(() => expect(screen.getByText('Dev Sandbox')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: 'Acme Infra Team' }));
      await waitFor(() => expect(screen.getByText('Shared Bastion')).toBeInTheDocument());
      expect(screen.queryByText('Prod Web 01')).not.toBeInTheDocument();
    });

    it('shows "Also matches" for other sources while on Personal, and jumps to the team on click (§8)', async () => {
      window.multissh.teamVaultList = vi.fn().mockResolvedValue([unlockedStatus()]);
      window.multissh.teamVaultGetPayload = vi.fn().mockResolvedValue({
        ssh: [
          { id: 'team-ssh-1', name: 'Shared Sandbox Host', host: 'sandbox.team.example.com', username: 'ops', authType: 'password' },
        ],
        s3: [],
      });
      render(
        <ConfirmProvider>
          <ConnectionManagerModal open={true} onClose={vi.fn()} />
        </ConfirmProvider>
      );
      await waitFor(() => expect(screen.getByText('Dev Sandbox')).toBeInTheDocument());

      fireEvent.change(screen.getByPlaceholderText(/Search profiles/), { target: { value: 'sandbox' } });
      await waitFor(() => expect(screen.getByText(/Acme Infra Team \(1\)/)).toBeInTheDocument());

      fireEvent.click(screen.getByText(/Acme Infra Team \(1\)/));
      await waitFor(() => expect(screen.getByText('Shared Sandbox Host')).toBeInTheDocument());
    });

    it('shows a "Personal (N)" chip while searching inside a team, for matches back in Personal', async () => {
      window.multissh.teamVaultList = vi.fn().mockResolvedValue([unlockedStatus()]);
      window.multissh.teamVaultGetPayload = vi.fn().mockResolvedValue({ ssh: [], s3: [] });
      render(
        <ConfirmProvider>
          <ConnectionManagerModal open={true} onClose={vi.fn()} />
        </ConfirmProvider>
      );
      await waitFor(() => expect(screen.getByText('Dev Sandbox')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: 'Acme Infra Team' }));
      await waitFor(() => expect(screen.getByText('No shared profiles yet')).toBeInTheDocument());

      fireEvent.change(screen.getByPlaceholderText(/Search profiles/), { target: { value: 'sandbox' } });
      await waitFor(() => expect(screen.getByText(/Personal \(1\)/)).toBeInTheDocument());
    });

    it('flags a shared privateKey-authenticated profile as machine-local', async () => {
      window.multissh.teamVaultList = vi.fn().mockResolvedValue([unlockedStatus()]);
      window.multissh.teamVaultGetPayload = vi.fn().mockResolvedValue({
        ssh: [
          {
            id: 'team-ssh-2',
            name: 'Shared Key Host',
            host: 'keyhost.example.com',
            username: 'ops',
            authType: 'privateKey',
            privateKeyPath: '/home/alice/.ssh/id_ed25519',
          },
        ],
        s3: [],
      });
      render(
        <ConfirmProvider>
          <ConnectionManagerModal open={true} onClose={vi.fn()} />
        </ConfirmProvider>
      );
      await waitFor(() => expect(screen.getByText('Dev Sandbox')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: 'Acme Infra Team' }));
      await waitFor(() => expect(screen.getByText('Shared Key Host')).toBeInTheDocument());
      expect(screen.getByText(/Private key path is local to this machine/)).toBeInTheDocument();
    });

    it('saves a new profile via the Team Vault IPC, scoped to that team\'s vaultId, not the personal profile store', async () => {
      window.multissh.teamVaultList = vi.fn().mockResolvedValue([unlockedStatus()]);
      window.multissh.teamVaultGetStatus = vi.fn().mockResolvedValue(unlockedStatus());
      window.multissh.teamVaultGetPayload = vi.fn().mockResolvedValue({ ssh: [], s3: [] });
      window.multissh.teamVaultSaveSSHProfile = vi.fn().mockResolvedValue(undefined);
      render(
        <ConfirmProvider>
          <ConnectionManagerModal open={true} onClose={vi.fn()} />
        </ConfirmProvider>
      );
      await waitFor(() => expect(screen.getByText('Dev Sandbox')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: 'Acme Infra Team' }));
      await waitFor(() => expect(screen.getByText('No shared profiles yet')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: /New Profile/i }));
      fireEvent.change(await screen.findByLabelText(/Profile Name/i), { target: { value: 'Shared Host' } });
      fireEvent.change(screen.getByLabelText(/Hostname \/ IP/i), { target: { value: 'shared.example.com' } });
      fireEvent.change(screen.getByLabelText(/Username/i), { target: { value: 'ops' } });

      fireEvent.click(screen.getByRole('button', { name: 'Save Profile' }));

      await waitFor(() => {
        expect(window.multissh.teamVaultSaveSSHProfile).toHaveBeenCalledWith(
          VAULT_ID,
          expect.objectContaining({ name: 'Shared Host', host: 'shared.example.com' })
        );
      });
      expect(window.multissh.profilesSaveSSH).not.toHaveBeenCalled();
    });

    it("saves a smartcard profile's PKCS#11 path directly into the shared payload (pkcs11LibPath is not a security boundary — see correction in the connection-manager plan)", async () => {
      window.multissh.teamVaultList = vi.fn().mockResolvedValue([unlockedStatus()]);
      window.multissh.teamVaultGetStatus = vi.fn().mockResolvedValue(unlockedStatus());
      window.multissh.teamVaultGetPayload = vi.fn().mockResolvedValue({ ssh: [], s3: [] });
      window.multissh.teamVaultSaveSSHProfile = vi.fn().mockResolvedValue(undefined);
      window.multissh.smartcardDetect = vi.fn().mockResolvedValue([]);

      render(
        <ConfirmProvider>
          <ConnectionManagerModal open={true} onClose={vi.fn()} />
        </ConfirmProvider>
      );
      await waitFor(() => expect(screen.getByText('Dev Sandbox')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: 'Acme Infra Team' }));
      await waitFor(() => expect(screen.getByText('No shared profiles yet')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: /New Profile/i }));
      fireEvent.change(await screen.findByLabelText(/Profile Name/i), { target: { value: 'Shared Smartcard Host' } });
      fireEvent.change(screen.getByLabelText(/Hostname \/ IP/i), { target: { value: 'h' } });
      fireEvent.change(screen.getByLabelText(/Username/i), { target: { value: 'u' } });
      fireEvent.change(screen.getByLabelText(/Authentication/i), { target: { value: 'smartcard' } });
      fireEvent.change(await screen.findByLabelText(/PKCS#11 Library/i), {
        target: { value: '/usr/lib/opensc-pkcs11.so' },
      });

      fireEvent.click(screen.getByRole('button', { name: 'Save Profile' }));
      // Smartcard/key-based auth types show an intermediate "not verified yet" access-check
      // panel on first submit (SSHProfileForm) — this test isn't exercising that flow, so take
      // its explicit "save anyway" escape hatch.
      fireEvent.click(await screen.findByRole('button', { name: 'Save anyway' }));

      await waitFor(() => expect(window.multissh.teamVaultSaveSSHProfile).toHaveBeenCalled());
      const savedConfig = (window.multissh.teamVaultSaveSSHProfile as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(savedConfig.pkcs11LibPath).toBe('/usr/lib/opensc-pkcs11.so');
    });

    it('hides the New Profile button for a locked team', async () => {
      window.multissh.teamVaultList = vi.fn().mockResolvedValue([lockedStatus()]);
      render(
        <ConfirmProvider>
          <ConnectionManagerModal open={true} onClose={vi.fn()} />
        </ConfirmProvider>
      );
      await waitFor(() => expect(screen.getByText('Dev Sandbox')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: 'Acme Infra Team' }));
      await waitFor(() => expect(screen.getByText('Acme Infra Team is locked')).toBeInTheDocument());
      expect(screen.queryByRole('button', { name: /New Profile/i })).not.toBeInTheDocument();
    });

    it('refreshes that team\'s view when the background auto-poll reports a pulled update for its vaultId', async () => {
      let autoPulledCallback: ((payload: { vaultId: string }) => void) | undefined;
      window.multissh.teamVaultList = vi.fn().mockResolvedValue([unlockedStatus()]);
      window.multissh.teamVaultGetStatus = vi.fn().mockResolvedValue(unlockedStatus());
      window.multissh.teamVaultGetPayload = vi
        .fn()
        .mockResolvedValueOnce({ ssh: [], s3: [] })
        .mockResolvedValueOnce({
          ssh: [{ id: 'team-ssh-3', name: 'New From Bob', host: 'h', username: 'u', authType: 'password' }],
          s3: [],
        });
      window.multissh.onTeamVaultAutoPulled = vi.fn((cb: (payload: { vaultId: string }) => void) => {
        autoPulledCallback = cb;
        return () => {};
      });
      window.multissh.onTeamVaultRemoteChanged = vi.fn(() => () => {});

      render(
        <ConfirmProvider>
          <ConnectionManagerModal open={true} onClose={vi.fn()} />
        </ConfirmProvider>
      );
      await waitFor(() => expect(screen.getByText('Dev Sandbox')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: 'Acme Infra Team' }));
      await waitFor(() => expect(screen.getByText('No shared profiles yet')).toBeInTheDocument());

      autoPulledCallback?.({ vaultId: VAULT_ID });

      await waitFor(() => expect(screen.getByText('New From Bob')).toBeInTheDocument());
      expect(screen.getByText(/Updated/)).toBeInTheDocument();
    });

    it('unlocks a team right from the Team view, with no detour through Settings, using the saved identity', async () => {
      window.multissh.teamVaultList = vi.fn().mockResolvedValue([lockedStatus()]);
      // Initial load() only calls teamVaultList (already locked, above) — teamVaultGetStatus is
      // only ever called by refreshVault() after the unlock below, so it can just always resolve
      // the unlocked status.
      window.multissh.teamVaultGetStatus = vi.fn().mockResolvedValue(unlockedStatus());
      window.multissh.teamVaultGetPayload = vi.fn().mockResolvedValue({ ssh: [], s3: [] });
      window.multissh.teamVaultUnlock = vi.fn().mockResolvedValue(undefined);

      render(
        <ConfirmProvider>
          <ConnectionManagerModal open={true} onClose={vi.fn()} />
        </ConfirmProvider>
      );
      await waitFor(() => expect(screen.getByText('Dev Sandbox')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: 'Acme Infra Team' }));
      await waitFor(() => expect(screen.getByText(/Unlock as alice@piv:abc/)).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: /Unlock as alice@piv:abc/ }));

      await waitFor(() => {
        expect(window.multissh.teamVaultUnlock).toHaveBeenCalledWith(VAULT_ID, 'alice@piv:abc', '/tmp/alice-identity.txt');
      });
      await waitFor(() => expect(screen.getByText('No shared profiles yet')).toBeInTheDocument());
    });

    it('falls back to manual recipient id / identity file fields when no saved identity exists', async () => {
      window.multissh.teamVaultList = vi.fn().mockResolvedValue([
        lockedStatus({ selfRecipientId: undefined, selfIdentityFilePath: undefined, selfRole: undefined }),
      ]);
      // Same reasoning as the test above: teamVaultGetStatus is only ever called by
      // refreshVault() after the unlock below.
      window.multissh.teamVaultGetStatus = vi.fn().mockResolvedValue(unlockedStatus());
      window.multissh.teamVaultGetPayload = vi.fn().mockResolvedValue({ ssh: [], s3: [] });
      window.multissh.teamVaultUnlock = vi.fn().mockResolvedValue(undefined);

      render(
        <ConfirmProvider>
          <ConnectionManagerModal open={true} onClose={vi.fn()} />
        </ConfirmProvider>
      );
      await waitFor(() => expect(screen.getByText('Dev Sandbox')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: 'Acme Infra Team' }));
      await waitFor(() => expect(screen.getByPlaceholderText('Your recipient id')).toBeInTheDocument());

      fireEvent.change(screen.getByPlaceholderText('Your recipient id'), { target: { value: 'bob@piv:def' } });
      fireEvent.change(screen.getByPlaceholderText('Path to your identity file'), {
        target: { value: '/tmp/bob-identity.txt' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));

      await waitFor(() => {
        expect(window.multissh.teamVaultUnlock).toHaveBeenCalledWith(VAULT_ID, 'bob@piv:def', '/tmp/bob-identity.txt');
      });
      await waitFor(() => expect(screen.getByText('No shared profiles yet')).toBeInTheDocument());
    });

    it('hides the tab row entirely when no Team Vault exists on this machine at all (§11: "Personal" is meaningless as a lone subtab)', async () => {
      window.multissh.teamVaultList = vi.fn().mockResolvedValue([]);

      render(
        <ConfirmProvider>
          <ConnectionManagerModal open={true} onClose={vi.fn()} />
        </ConfirmProvider>
      );
      await waitFor(() => expect(screen.getByText('Dev Sandbox')).toBeInTheDocument());

      // No teams at all — nothing was ever unlocked/configured on this device, so there's
      // nothing for the per-team tab row (§D of the join-flow plan) to distinguish, and a lone
      // "Personal" tab with no alternative is not a meaningful choice.
      expect(screen.queryByRole('button', { name: 'Acme Infra Team' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Personal' })).not.toBeInTheDocument();
    });
  });
});

describe('ConnectionManagerModal multi-select', () => {
  beforeEach(() => {
    window.multissh = {
      settingsGet: vi.fn().mockResolvedValue({}),
      settingsSave: vi.fn().mockResolvedValue({}),
      profilesGet: vi.fn().mockResolvedValue({ ssh: mockSSHProfiles, s3: mockS3Profiles }),
      profilesSaveSSH: vi.fn().mockResolvedValue(undefined),
      profilesSaveS3: vi.fn().mockResolvedValue(undefined),
      teamVaultGetStatus: vi.fn().mockResolvedValue({ exists: false, unlocked: false, filePath: '/x' }),
      teamVaultList: vi.fn().mockResolvedValue([]),
    } as unknown as typeof window.multissh;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  async function openList() {
    render(
      <ConfirmProvider>
        <ConnectionManagerModal open={true} onClose={vi.fn()} onConnectSSH={vi.fn()} />
      </ConfirmProvider>
    );
    await screen.findByRole('checkbox', { name: 'Select Dev Sandbox' });
  }

  it('shows a checkbox on every profile of the list, and the action bar once one is selected', async () => {
    await openList();
    expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Prod Web 01' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Dev Sandbox' }));
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select Prod Web 01' })).toBeChecked();
  });

  it('moves the selected profiles to a new folder and reloads the list', async () => {
    await openList();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Prod Web 01' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Dev Sandbox' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move to folder…' }));
    fireEvent.change(screen.getByLabelText('Folder'), { target: { value: ' Nytt ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));

    await waitFor(() => expect(window.multissh.profilesSaveSSH).toHaveBeenCalledTimes(2));
    expect(window.multissh.profilesSaveSSH).toHaveBeenCalledWith(expect.objectContaining({ id: 'ssh-1', group: 'Nytt' }));
    expect(window.multissh.profilesSaveSSH).toHaveBeenCalledWith(expect.objectContaining({ id: 'ssh-3', group: 'Nytt' }));
    await waitFor(() => expect(window.multissh.profilesGet).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Moved 2 profiles to "Nytt".')).toBeInTheDocument();
    expect(screen.queryByText(/\d+ selected/)).not.toBeInTheDocument();
  });

  it('takes the selected profiles out of their folder', async () => {
    await openList();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Prod Web 01' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move to folder…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Take out of folder' }));

    await waitFor(() => expect(window.multissh.profilesSaveSSH).toHaveBeenCalledTimes(1));
    const saved = (window.multissh.profilesSaveSSH as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(saved.id).toBe('ssh-1');
    expect('group' in saved).toBe(false);
  });

  it('adds tags to the selected profiles', async () => {
    await openList();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Prod Web 01' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add tags…' }));
    const input = screen.getByLabelText('Tags to add');
    fireEvent.change(input, { target: { value: 'prod' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(window.multissh.profilesSaveSSH).toHaveBeenCalledWith(expect.objectContaining({ id: 'ssh-1', tags: ['prod'] })));
    expect(await screen.findByText('Added tags to 1 profile.')).toBeInTheDocument();
  });

  it('shows a failed save and keeps the selection so it can be tried again', async () => {
    (window.multissh.profilesSaveSSH as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('disk is read-only'));
    await openList();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Prod Web 01' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move to folder…' }));
    fireEvent.change(screen.getByLabelText('Folder'), { target: { value: 'Nytt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));

    expect(await screen.findByText(/disk is read-only/)).toBeInTheDocument();
    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });

  it('forgets the selection when the tab is switched', async () => {
    await openList();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Prod Web 01' }));
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /S3/i }));
    await screen.findByRole('checkbox', { name: 'Select Backup Bucket' });
    expect(screen.queryByText(/\d+ selected/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /SSH/i }));
    await screen.findByRole('checkbox', { name: 'Select Prod Web 01' });
    expect(screen.getByRole('checkbox', { name: 'Select Prod Web 01' })).not.toBeChecked();
  });

  it('groups the selected profiles into a system, in a folder, and says so', async () => {
    await openList();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Prod Web 01' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Prod DB 01' }));
    fireEvent.click(screen.getByRole('button', { name: 'Group as system…' }));
    fireEvent.change(screen.getByLabelText('System'), { target: { value: 'Prod stack' } });
    fireEvent.click(screen.getByRole('button', { name: 'Group' }));

    await waitFor(() => expect(window.multissh.profilesSaveSSH).toHaveBeenCalledTimes(2));
    for (const call of (window.multissh.profilesSaveSSH as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[0]).toMatchObject({ group: 'Produktion', system: { name: 'Prod stack' } });
    }
    expect(await screen.findByText('Grouped 2 profiles into "Prod stack".')).toBeInTheDocument();
  });

  it('does not offer grouping as a system for S3 profiles', async () => {
    await openList();
    fireEvent.click(screen.getByRole('button', { name: /S3/i }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select Backup Bucket' }));
    expect(screen.getByRole('button', { name: 'Move to folder…' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Group as system…' })).not.toBeInTheDocument();
  });

  it('selects S3 profiles too, and saves them through the S3 store', async () => {
    await openList();
    fireEvent.click(screen.getByRole('button', { name: /S3/i }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select Backup Bucket' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move to folder…' }));
    fireEvent.change(screen.getByLabelText('Folder'), { target: { value: 'Arkiv' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));

    await waitFor(() => expect(window.multissh.profilesSaveS3).toHaveBeenCalledWith(expect.objectContaining({ id: 's3-1', group: 'Arkiv' })));
    expect(window.multissh.profilesSaveSSH).not.toHaveBeenCalled();
  });

  it('only counts the profiles the search leaves visible', async () => {
    await openList();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Prod Web 01' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Dev Sandbox' }));
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/Search profiles/i), { target: { value: 'sandbox' } });
    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });
});

describe('ConnectionManagerModal systems', () => {
  const servers: SSHConnectionConfig[] = [
    { id: 'a', name: 'Shop Web', host: 'web.example.com', username: 'deploy', authType: 'password', group: 'Produktion', system: { name: 'shop' } },
    { id: 'b', name: 'Shop Web 2', host: 'web2.example.com', username: 'deploy', authType: 'password', group: 'Produktion', system: { name: 'shop', startDirectory: '/srv' } },
    { id: 'c', name: 'Shop Db', host: 'db.example.com', username: 'deploy', authType: 'password', group: 'Utveckling', system: { name: 'Shop' } },
    { id: 'd', name: 'Blog', host: 'blog.example.com', username: 'deploy', authType: 'password', group: 'Produktion' },
  ];

  beforeEach(() => {
    window.multissh = {
      settingsGet: vi.fn().mockResolvedValue({}),
      settingsSave: vi.fn().mockResolvedValue({}),
      profilesGet: vi.fn().mockResolvedValue({ ssh: servers, s3: [], folders: ['Produktion', 'Utveckling'] }),
      profilesSaveSSH: vi.fn().mockResolvedValue(undefined),
      profilesSaveS3: vi.fn().mockResolvedValue(undefined),
      teamVaultGetStatus: vi.fn().mockResolvedValue({ exists: false, unlocked: false, filePath: '/x' }),
      teamVaultList: vi.fn().mockResolvedValue([]),
    } as unknown as typeof window.multissh;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  async function openList(onConnectSystem = vi.fn()) {
    render(
      <ConfirmProvider>
        <ConnectionManagerModal open={true} onClose={vi.fn()} onConnectSSH={vi.fn()} onConnectSystem={onConnectSystem} />
      </ConfirmProvider>
    );
    await screen.findByText('Shop');
    return onConnectSystem;
  }

  it('draws the servers that form a system as one row with the servers below it', async () => {
    await openList();
    expect(screen.getByText('3 servers')).toBeInTheDocument();
    const group = screen.getByRole('group', { name: 'Shop' });
    expect(group).toHaveTextContent('Shop Db');
    expect(group).toHaveTextContent('Shop Web');
    expect(group).toHaveTextContent('Shop Web 2');
  });

  it('keeps the whole system in the folder most of its servers are in, whatever the others say', async () => {
    await openList();
    const production = screen.getByText('Produktion').closest('div.space-y-1\\.5') as HTMLElement;
    expect(production).toContainElement(screen.getByRole('group', { name: 'Shop' }));
    expect(production).toHaveTextContent('Blog');
    const development = screen.getByText('Utveckling').closest('div.space-y-1\\.5') as HTMLElement;
    expect(development).not.toHaveTextContent('Shop');
  });

  const dropOnFolder = (folder: string, id: string) => {
    const header = screen.getByText(folder).closest('div[class*="rounded-lg"]') as HTMLElement;
    fireEvent.drop(header, { dataTransfer: { getData: () => JSON.stringify({ type: 'ssh', id }) } });
  };

  it('moves the whole system when one of its servers is dropped on another folder', async () => {
    await openList();
    dropOnFolder('Utveckling', 'b');
    // 'c' already says Utveckling, so only the two servers that disagree are saved.
    await waitFor(() => expect(window.multissh.profilesSaveSSH).toHaveBeenCalledTimes(2));
    const saved = (window.multissh.profilesSaveSSH as ReturnType<typeof vi.fn>).mock.calls.map(([p]) => [p.id, p.group]);
    expect(saved).toEqual([['a', 'Utveckling'], ['b', 'Utveckling']]);
  });

  it('renames a system by saving each of its servers with the new name', async () => {
    await openList();
    fireEvent.click(screen.getByRole('button', { name: 'Rename Shop' }));
    const field = screen.getByRole('textbox', { name: 'New name for Shop' });
    fireEvent.change(field, { target: { value: 'Webshop' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(window.multissh.profilesSaveSSH).toHaveBeenCalledTimes(3));
    const saved = (window.multissh.profilesSaveSSH as ReturnType<typeof vi.fn>).mock.calls.map(([x]) => [x.id, x.system.name]);
    expect(saved.sort()).toEqual([['a', 'Webshop'], ['b', 'Webshop'], ['c', 'Webshop']]);
  });

  it('ungrouping asks first, then takes every server out of the system but keeps the profiles', async () => {
    await openList();
    fireEvent.click(screen.getByRole('button', { name: 'Ungroup Shop' }));
    expect(window.multissh.profilesSaveSSH).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Ungroup' }));
    await waitFor(() => expect(window.multissh.profilesSaveSSH).toHaveBeenCalledTimes(3));
    for (const [saved] of (window.multissh.profilesSaveSSH as ReturnType<typeof vi.fn>).mock.calls) {
      expect('system' in saved).toBe(false);
      expect(saved.name).toMatch(/^Shop/);
    }
  });

  it('keeps a system in its folder while a search leaves only some of its servers, and still connects to all of them', async () => {
    const onConnectSystem = await openList();
    fireEvent.change(screen.getByPlaceholderText(/Search profiles/i), { target: { value: 'Shop Db' } });
    const production = await screen.findByText('Produktion');
    const group = screen.getByRole('group', { name: 'Shop' });
    expect(production.closest('div.space-y-1\\.5')).toContainElement(group);
    expect(screen.getByText('1 server')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Connect all servers in Shop' }));
    expect(onConnectSystem.mock.calls[0][0].map((m: SSHConnectionConfig) => m.id)).toEqual(['c', 'a', 'b']);
  });

  it('saves the stored folder, not the system\'s, when a server is connected on its own', async () => {
    await openList();
    // 'Shop Db' is stored in Utveckling but drawn in its system's folder, Produktion.
    const row = within(screen.getByRole('group', { name: 'Shop' }))
      .getByText('Shop Db')
      .closest('[draggable="true"]') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(window.multissh.profilesSaveSSH).toHaveBeenCalledTimes(1));
    expect((window.multissh.profilesSaveSSH as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ id: 'c', group: 'Utveckling' });
  });

  it('refuses to rename a system to the name of another one', async () => {
    window.multissh.profilesGet = vi.fn().mockResolvedValue({
      ssh: [...servers, { id: 'e', name: 'Blog Web', host: 'b.example.com', username: 'deploy', authType: 'password', group: 'Produktion', system: { name: 'Blog' } }],
      s3: [],
      folders: ['Produktion', 'Utveckling'],
    });
    await openList();
    fireEvent.click(await screen.findByRole('button', { name: 'Rename Blog' }));
    const field = screen.getByRole('textbox', { name: 'New name for Blog' });
    fireEvent.change(field, { target: { value: 'shop' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(await screen.findByText('A system called "shop" already exists.')).toBeInTheDocument();
    expect(window.multissh.profilesSaveSSH).not.toHaveBeenCalled();
  });

  it('still moves a plain profile on its own', async () => {
    await openList();
    dropOnFolder('Utveckling', 'd');
    await waitFor(() => expect(window.multissh.profilesSaveSSH).toHaveBeenCalledTimes(1));
    expect((window.multissh.profilesSaveSSH as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ id: 'd', group: 'Utveckling' });
  });

  it('connects to every server of the system, as personal, in one call', async () => {
    const onConnectSystem = await openList();
    fireEvent.click(screen.getByRole('button', { name: 'Connect all servers in Shop' }));
    expect(onConnectSystem).toHaveBeenCalledTimes(1);
    const [members, source] = onConnectSystem.mock.calls[0];
    expect(members.map((m: SSHConnectionConfig) => m.id)).toEqual(['c', 'a', 'b']);
    expect(source).toBe('personal');
  });

  it('still lets a server of a system be selected like any other profile', async () => {
    await openList();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select Shop Db' }));
    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });

  it('leaves the list as it was when no profile belongs to a system', async () => {
    (window.multissh.profilesGet as ReturnType<typeof vi.fn>).mockResolvedValue({ ssh: [servers[3]], s3: [], folders: [] });
    render(
      <ConfirmProvider>
        <ConnectionManagerModal open={true} onClose={vi.fn()} onConnectSSH={vi.fn()} onConnectSystem={vi.fn()} />
      </ConfirmProvider>
    );
    await screen.findByText('Blog');
    expect(screen.queryByText(/servers?$/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Connect all/ })).not.toBeInTheDocument();
  });
});
