// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { GitSettingsPanel } from '../../src/renderer/src/components/SettingsModal/GitSettingsPanel';
import type { LocalPublicKey } from '../../src/shared/types/ssh';

const testKey: LocalPublicKey = {
  id: 'SHA256:abc123key',
  line: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKey user@workstation',
  type: 'ssh-ed25519',
  fingerprint: 'SHA256:abc123key',
  comment: 'user@workstation',
  source: 'file',
  label: 'id_ed25519.pub',
  privateKeyPath: '/home/user/.ssh/id_ed25519',
};

describe('GitSettingsPanel', () => {
  const listPublicKeys = vi.fn();
  const gitGetSigningConfig = vi.fn();
  const gitConfigureSigning = vi.fn();
  const gitSetSigningEnabled = vi.fn();
  const gitFetchPublicKeys = vi.fn();
  const openExternal = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    listPublicKeys.mockResolvedValue([testKey]);
    gitGetSigningConfig.mockResolvedValue({
      enabled: true,
      format: 'ssh',
      signingKey: testKey.line,
      allowedSignersFile: '/home/user/.ssh/allowed_signers',
      email: 'user@example.com',
    });
    gitConfigureSigning.mockResolvedValue({ success: true, allowedSignersUpdated: true });
    gitSetSigningEnabled.mockResolvedValue({ success: true });
    gitFetchPublicKeys.mockResolvedValue({
      success: true,
      keys: [
        {
          id: 'SHA256:remote1',
          line: 'ssh-ed25519 AAAARemoteKey remote@github',
          type: 'ssh-ed25519',
          fingerprint: 'SHA256:remote1',
          comment: 'remote@github',
          source: 'github',
          label: 'GitHub Key 1',
        },
      ],
    });
    openExternal.mockResolvedValue(true);

    window.multissh = {
      ...(window.multissh || {}),
      listPublicKeys,
      gitGetSigningConfig,
      gitConfigureSigning,
      gitSetSigningEnabled,
      gitFetchPublicKeys,
      openExternal,
    } as any;

    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => cleanup());

  it('renders developer keys and active signing status', async () => {
    render(<GitSettingsPanel />);

    await screen.findByText('id_ed25519.pub');
    const activeBadges = await screen.findAllByText(/Active Signing Key/i);
    expect(activeBadges.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Automatic Signing (commit.gpgsign)')).toBeInTheDocument();
    expect(screen.getByText('Enabled')).toBeInTheDocument();
  });

  it('copies key to clipboard when clicking Copy button', async () => {
    render(<GitSettingsPanel />);

    await screen.findByText('id_ed25519.pub');
    const copyButton = screen.getAllByRole('button', { name: /^Copy$/i })[0];
    fireEvent.click(copyButton);

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(testKey.line);
    });

    expect(screen.getByTestId('git-notice-banner')).toBeInTheDocument();
    expect(screen.getByTestId('git-notice-banner')).toHaveTextContent(/Public key copied to clipboard/);
  });

  it('opens GitHub SSH settings page and copies key when clicking GitHub', async () => {
    render(<GitSettingsPanel />);

    await screen.findByText('id_ed25519.pub');
    const githubBtn = screen.getByTitle('Register this public key on GitHub (copies key to clipboard and opens browser)');
    fireEvent.click(githubBtn);

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(testKey.line);
      expect(openExternal).toHaveBeenCalledWith(
        expect.stringContaining('https://github.com/settings/ssh/new?title=id_ed25519.pub')
      );
    });

    const banner = screen.getByTestId('git-notice-banner');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent(/GitHub/);
    expect(banner).toHaveTextContent(/Ctrl\+V/);

    // Dismiss banner
    fireEvent.click(screen.getByRole('button', { name: /Dismiss notice/i }));
    expect(screen.queryByTestId('git-notice-banner')).not.toBeInTheDocument();
  });

  it('configures commit signing when clicking Git Sign', async () => {
    render(<GitSettingsPanel />);

    await screen.findByText('id_ed25519.pub');
    const signBtn = screen.getByRole('button', { name: /Sign Active/i });
    fireEvent.click(signBtn);

    await waitFor(() => {
      expect(gitConfigureSigning).toHaveBeenCalledWith({ signingKey: testKey.line });
    });
  });

  it('fetches remote keys from Git provider (username.keys)', async () => {
    render(<GitSettingsPanel />);

    const usernameInput = screen.getByPlaceholderText(/GitHub username/i);
    // The field must have a real name, not only a placeholder that disappears once typing starts.
    expect(screen.getByRole('textbox', { name: 'GitHub username' })).toBe(usernameInput);
    fireEvent.change(usernameInput, { target: { value: 'octocat' } });

    const fetchBtn = screen.getByRole('button', { name: /Fetch keys/i });
    fireEvent.click(fetchBtn);

    await waitFor(() => {
      expect(gitFetchPublicKeys).toHaveBeenCalledWith({
        provider: 'github',
        username: 'octocat',
        customHost: undefined,
      });
    });

    await screen.findByText('GitHub Key 1');
  });

  it('toggles automatic signing on and off', async () => {
    render(<GitSettingsPanel />);

    const disableBtn = await screen.findByRole('button', { name: /Disable/i });
    fireEvent.click(disableBtn);

    await waitFor(() => {
      expect(gitSetSigningEnabled).toHaveBeenCalledWith(false);
    });
  });

  it('allows setting custom signing key', async () => {
    render(<GitSettingsPanel />);

    const changeKeyBtn = await screen.findByRole('button', { name: /Change Key…/i });
    fireEvent.click(changeKeyBtn);

    const customInput = screen.getByPlaceholderText(/ssh-ed25519 AAAAC3…/i);
    fireEvent.change(customInput, { target: { value: 'ssh-ed25519 AAAAC3CustomKey user@custom' } });

    const applyBtn = screen.getByRole('button', { name: /Apply/i });
    fireEvent.click(applyBtn);

    await waitFor(() => {
      expect(gitConfigureSigning).toHaveBeenCalledWith({ signingKey: 'ssh-ed25519 AAAAC3CustomKey user@custom' });
    });
  });

  it('renders and toggles SFTP & File Manager Git Integration setting', async () => {
    const onChangeIntegration = vi.fn();
    const { rerender } = render(
      <GitSettingsPanel
        fileManagerGitIntegration={true}
        onChangeFileManagerGitIntegration={onChangeIntegration}
      />
    );

    expect(screen.getByText('SFTP & File Manager Git Integration')).toBeInTheDocument();
    expect(screen.getByText(/Enabled in SFTP and file manager panes/i)).toBeInTheDocument();

    const toggle = screen.getByTestId('toggle-filemanager-git-integration');
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);
    expect(onChangeIntegration).toHaveBeenCalledWith(false);

    rerender(
      <GitSettingsPanel
        fileManagerGitIntegration={false}
        onChangeFileManagerGitIntegration={onChangeIntegration}
      />
    );
    expect(screen.getByText(/Disabled \(Git branch and actions hidden\)/i)).toBeInTheDocument();
    expect(screen.getByTestId('toggle-filemanager-git-integration')).not.toBeChecked();
  });

  it('disables Fetch keys with an explanation when an administrator blocks it', async () => {
    window.multissh = {
      ...window.multissh,
      policyGet: vi.fn().mockResolvedValue({ managed: [], features: { gitKeyFetch: false }, warnings: [] }),
    } as any;
    render(<GitSettingsPanel />);

    fireEvent.change(screen.getByPlaceholderText(/GitHub username/i), { target: { value: 'octocat' } });
    const fetchBtn = screen.getByRole('button', { name: /Fetch keys/i });
    expect(await screen.findByRole('note')).toHaveTextContent('Disabled by your administrator.');
    expect(fetchBtn).toBeDisabled();
    expect(fetchBtn).toHaveAccessibleDescription('Disabled by your administrator.');

    fireEvent.keyDown(screen.getByPlaceholderText(/GitHub username/i), { key: 'Enter' });
    expect(gitFetchPublicKeys).not.toHaveBeenCalled();
  });
});
