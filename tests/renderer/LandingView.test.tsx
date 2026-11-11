// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { LandingView } from '../../src/renderer/src/components/LandingView';
import type { SSHConnectionConfig } from '@shared/types/ssh';

describe('LandingView Component', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const mockRecentSSH: SSHConnectionConfig[] = [
    {
      id: 'conn-1',
      name: 'gnarg-yubi-pkcs11',
      host: 'gnarg',
      port: 22,
      username: 'alun',
      authType: 'smartcard',
    },
    {
      id: 'conn-2',
      name: 'demoserver',
      host: '206.168.215.216',
      port: 22,
      username: 'root',
      authType: 'password',
    },
  ];

  it('renders recent connections and action buttons', () => {
    render(
      <LandingView
        recentSSH={mockRecentSSH}
        onConnectRecentSSH={vi.fn()}
        onConnectSFTP={vi.fn()}
        onQuickConnectSSH={vi.fn()}
        onQuickStartTerminal={vi.fn()}
        onNewTab={vi.fn()}
        onOpenProfiles={vi.fn()}
        onNewProfile={vi.fn()}
        onOpenSyncBootstrap={vi.fn()}
        onNavigateToTabBar={vi.fn()}
      />
    );

    expect(screen.getByText('Recent Connections')).toBeInTheDocument();
    expect(screen.getByText('gnarg-yubi-pkcs11')).toBeInTheDocument();
    expect(screen.getByText('demoserver')).toBeInTheDocument();
    expect(screen.getByTestId('landing-new-terminal-btn')).toBeInTheDocument();
    expect(screen.getByTestId('landing-file-manager-btn')).toBeInTheDocument();
  });

  describe('searching saved profiles from the quick-connect box', () => {
    const allSSH: SSHConnectionConfig[] = [
      ...mockRecentSSH,
      { id: 'conn-3', name: 'build-box', host: 'ci.example.com', port: 22, username: 'deploy', authType: 'password' },
    ];

    const renderLanding = (overrides: Partial<React.ComponentProps<typeof LandingView>> = {}) =>
      render(
        <LandingView
          recentSSH={mockRecentSSH}
          allSSH={allSSH}
          onConnectRecentSSH={vi.fn()}
          onConnectSFTP={vi.fn()}
          onQuickConnectSSH={vi.fn()}
          onQuickStartTerminal={vi.fn()}
          onNewTab={vi.fn()}
          onOpenProfiles={vi.fn()}
          onNewProfile={vi.fn()}
          onOpenSyncBootstrap={vi.fn()}
          onNavigateToTabBar={vi.fn()}
          {...overrides}
        />
      );

    const type = (text: string) =>
      fireEvent.change(screen.getByPlaceholderText(/search saved profiles/i), { target: { value: text } });

    it('lists profiles outside the recent ones that match what is typed', () => {
      renderLanding();
      type('build');
      expect(screen.getByText('Matching Profiles')).toBeInTheDocument();
      expect(screen.getByTitle('build-box')).toBeInTheDocument();
      expect(screen.queryByTitle('demoserver')).not.toBeInTheDocument();
    });

    it('matches fuzzily like the global search, and highlights the matched letters', () => {
      renderLanding();
      type('bdbx');
      const row = screen.getByTitle('build-box');
      expect(row).toBeInTheDocument();
      expect(row.querySelectorAll('mark').length).toBeGreaterThan(0);
    });

    it('moves the selection with the arrows and connects to the selected match', () => {
      const onConnectRecentSSH = vi.fn();
      renderLanding({ onConnectRecentSSH });
      type('e');
      const input = screen.getByPlaceholderText(/search saved profiles/i);
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      fireEvent.click(screen.getByTestId('quick-connect-btn'));
      expect(onConnectRecentSSH).toHaveBeenCalledTimes(1);
      const first = onConnectRecentSSH.mock.calls[0][0];
      onConnectRecentSSH.mockClear();
      type('e');
      fireEvent.click(screen.getByTestId('quick-connect-btn'));
      expect(onConnectRecentSSH.mock.calls[0][0].id).not.toBe(first.id);
    });

    it('exposes the matches as a listbox with the selected one as the active descendant', () => {
      renderLanding();
      type('e');
      const input = screen.getByRole('combobox', { name: /quick connect/i });
      const options = screen.getAllByRole('option');
      expect(screen.getByRole('listbox')).toBeInTheDocument();
      expect(options[0]).toHaveAttribute('aria-selected', 'true');
      expect(input).toHaveAttribute('aria-activedescendant', options[0].id);
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
      expect(input).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[1].id);
    });

    it('moves the selection to the row under the mouse', () => {
      renderLanding();
      type('e');
      fireEvent.mouseMove(screen.getAllByRole('option')[1]);
      expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    });

    it('shows no selection while a user@host target is typed, and the arrows leave the matches alone', () => {
      const onConnectRecentSSH = vi.fn();
      const onQuickConnectSSH = vi.fn();
      renderLanding({ onConnectRecentSSH, onQuickConnectSSH });
      type('alun@gnarg');
      const input = screen.getByRole('combobox', { name: /quick connect/i });
      expect(input).not.toHaveAttribute('aria-activedescendant');
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      // Only the search result rows; the workspace team-note <select> has native <option>s of its own.
      screen
        .queryAllByRole('option')
        .filter((o) => o.closest('#landing-search-results'))
        .forEach((o) => expect(o).toHaveAttribute('aria-selected', 'false'));
      fireEvent.click(screen.getByTestId('quick-connect-btn'));
      expect(onQuickConnectSSH).toHaveBeenCalledWith(expect.objectContaining({ host: 'gnarg', username: 'alun' }));
      expect(onConnectRecentSSH).not.toHaveBeenCalled();
    });

    it('leaves Left/Right to the text caret unless it is at the start or end', () => {
      const onNavigateToTabBar = vi.fn();
      renderLanding({ onNavigateToTabBar });
      type('build');
      const input = screen.getByRole('combobox', { name: /quick connect/i }) as HTMLInputElement;
      input.focus();
      input.setSelectionRange(2, 2);
      const mid = fireEvent.keyDown(input, { key: 'ArrowLeft' });
      expect(mid).toBe(true); // not default-prevented: the caret may move
      input.setSelectionRange(0, 0);
      expect(fireEvent.keyDown(input, { key: 'ArrowLeft' })).toBe(false); // at the edge: spatial navigation takes over
    });

    it('opens SFTP to the selected match on Shift+Enter', () => {
      const onConnectSFTP = vi.fn();
      renderLanding({ onConnectSFTP });
      type('build');
      fireEvent.keyDown(screen.getByPlaceholderText(/search saved profiles/i), { key: 'Enter', shiftKey: true });
      expect(onConnectSFTP).toHaveBeenCalledWith(expect.objectContaining({ id: 'conn-3' }));
    });

    it('matches on host and user too, and says so when nothing matches', () => {
      renderLanding();
      type('ci.example');
      expect(screen.getByTitle('build-box')).toBeInTheDocument();
      type('zzz-nothing');
      expect(screen.getByText(/No saved profile matches/)).toBeInTheDocument();
    });

    it('connects to the first match on submit', () => {
      const onConnectRecentSSH = vi.fn();
      const onQuickConnectSSH = vi.fn();
      renderLanding({ onConnectRecentSSH, onQuickConnectSSH });
      type('build');
      fireEvent.click(screen.getByTestId('quick-connect-btn'));
      expect(onConnectRecentSSH).toHaveBeenCalledWith(expect.objectContaining({ id: 'conn-3' }));
      expect(onQuickConnectSSH).not.toHaveBeenCalled();
    });

    it('keeps user@host as an ad-hoc connection', () => {
      const onConnectRecentSSH = vi.fn();
      const onQuickConnectSSH = vi.fn();
      renderLanding({ onConnectRecentSSH, onQuickConnectSSH });
      type('deploy@ci.example.com');
      fireEvent.click(screen.getByTestId('quick-connect-btn'));
      expect(onQuickConnectSSH).toHaveBeenCalledWith(expect.objectContaining({ host: 'ci.example.com', username: 'deploy' }));
      expect(onConnectRecentSSH).not.toHaveBeenCalled();
    });

    it('greys out SFTP together with Connect while there is nothing to open', () => {
      renderLanding();
      const sftp = () => screen.getAllByRole('button', { name: /SFTP/ })[0];
      expect(screen.getByTestId('quick-connect-btn')).toBeDisabled();
      expect(sftp()).toBeDisabled();
      type('build');
      expect(screen.getByTestId('quick-connect-btn')).toBeEnabled();
      expect(sftp()).toBeEnabled();
    });

    it('shows recent connections again when the box is cleared', () => {
      renderLanding();
      type('build');
      type('');
      expect(screen.getByText('Recent Connections')).toBeInTheDocument();
    });
  });

  it('auto-focuses the quick-connect field after mount', () => {
    render(
      <LandingView
        recentSSH={mockRecentSSH}
        onConnectRecentSSH={vi.fn()}
        onConnectSFTP={vi.fn()}
        onQuickConnectSSH={vi.fn()}
        onQuickStartTerminal={vi.fn()}
        onNewTab={vi.fn()}
        onOpenProfiles={vi.fn()}
        onNewProfile={vi.fn()}
        onOpenSyncBootstrap={vi.fn()}
        onNavigateToTabBar={vi.fn()}
      />
    );

    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(document.activeElement).toBe(screen.getByPlaceholderText(/Type user@host to connect/));
  });

  it('jumps to TabBar on ArrowUp from anywhere in the quick-connect row (the first row)', () => {
    const onNavigateToTabBar = vi.fn();
    const { container } = render(
      <LandingView
        recentSSH={mockRecentSSH}
        onConnectRecentSSH={vi.fn()}
        onConnectSFTP={vi.fn()}
        onQuickConnectSSH={vi.fn()}
        onQuickStartTerminal={vi.fn()}
        onNewTab={vi.fn()}
        onOpenProfiles={vi.fn()}
        onNewProfile={vi.fn()}
        onOpenSyncBootstrap={vi.fn()}
        onNavigateToTabBar={onNavigateToTabBar}
      />
    );

    const quickConnectInput = screen.getByPlaceholderText(/Type user@host to connect/);
    quickConnectInput.focus();
    fireEvent.keyDown(container.firstChild as HTMLElement, { key: 'ArrowUp' });
    expect(onNavigateToTabBar).toHaveBeenCalledTimes(1);
  });

  it('calls onNavigateToTabBar when Escape is pressed', () => {
    const onNavigateToTabBar = vi.fn();
    const { container } = render(
      <LandingView
        recentSSH={mockRecentSSH}
        onConnectRecentSSH={vi.fn()}
        onConnectSFTP={vi.fn()}
        onQuickConnectSSH={vi.fn()}
        onQuickStartTerminal={vi.fn()}
        onNewTab={vi.fn()}
        onOpenProfiles={vi.fn()}
        onNewProfile={vi.fn()}
        onOpenSyncBootstrap={vi.fn()}
        onNavigateToTabBar={onNavigateToTabBar}
      />
    );

    fireEvent.keyDown(container.firstChild as HTMLElement, { key: 'Escape' });
    expect(onNavigateToTabBar).toHaveBeenCalledTimes(1);
  });

  it('triggers onConnectRecentSSH when Connect is clicked', () => {
    const onConnectRecentSSH = vi.fn();
    render(
      <LandingView
        recentSSH={mockRecentSSH}
        onConnectRecentSSH={onConnectRecentSSH}
        onConnectSFTP={vi.fn()}
        onQuickConnectSSH={vi.fn()}
        onQuickStartTerminal={vi.fn()}
        onNewTab={vi.fn()}
        onOpenProfiles={vi.fn()}
        onNewProfile={vi.fn()}
        onOpenSyncBootstrap={vi.fn()}
        onNavigateToTabBar={vi.fn()}
      />
    );

    fireEvent.click(screen.getByTestId('recent-connect-conn-1'));
    expect(onConnectRecentSSH).toHaveBeenCalledWith(mockRecentSSH[0]);
  });

  it('displays active VM Team sharing indicator in s3-workspace-status-badge when in web browser mode', () => {
    (window as any).__SSHS3_WEB_MODE__ = true;
    try {
      render(
        <LandingView
          recentSSH={mockRecentSSH}
          onConnectRecentSSH={vi.fn()}
          onConnectSFTP={vi.fn()}
          onQuickConnectSSH={vi.fn()}
          onQuickStartTerminal={vi.fn()}
          onNewTab={vi.fn()}
          onOpenProfiles={vi.fn()}
          onNewProfile={vi.fn()}
          onOpenSyncBootstrap={vi.fn()}
          onNavigateToTabBar={vi.fn()}
        />
      );
      const badge = screen.getByTestId('s3-workspace-status-badge');
      expect(badge.textContent).toContain('Shared on this web server');
    } finally {
      delete (window as any).__SSHS3_WEB_MODE__;
    }
  });

  it('supports changing password and revoking active invites in WebAuthGate modal', async () => {
    vi.useRealTimers();
    const { WebAuthGate } = await import('../../src/renderer/src/components/WebAuthGate');
    (window as any).__SSHS3_WEB_MODE__ = true;
    const calls: Array<{ url: string; method: string; body?: any }> = [];
    let invites = [
      {
        token: 'inv_test_123',
        role: 'member',
        note: 'DevOps',
        createdAt: Date.now(),
        expiresAt: Date.now() + 86400000,
        maxUses: 5,
        usedCount: 1,
      },
    ];
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: any, init?: any) => {
      const url = String(input);
      const method = (init?.method || 'GET').toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      if (url.endsWith('/api/auth/status')) {
        return {
          ok: true,
          json: async () => ({
            needsSetup: false,
            authenticated: true,
            user: {
              id: 'u-admin',
              username: 'jacob',
              displayName: 'Jacob Admin',
              role: 'admin',
              createdAt: Date.now(),
              sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest jacob@sshs3-web',
            },
          }),
        } as any;
      }
      if (url.endsWith('/api/admin/users')) {
        return {
          ok: true,
          json: async () => ({
            users: [],
            invites,
          }),
        } as any;
      }
      if (url.endsWith('/api/admin/invites') && method === 'GET') {
        return {
          ok: true,
          json: async () => ({
            invites,
          }),
        } as any;
      }
      if (url.endsWith('/api/user/password') && method === 'POST') {
        return {
          ok: true,
          json: async () => ({ ok: true }),
        } as any;
      }
      if (url.includes('/api/admin/invites/') && method === 'DELETE') {
        invites = [];
        return {
          ok: true,
          json: async () => ({ invites }),
        } as any;
      }
      return { ok: true, json: async () => ({}) } as any;
    });

    try {
      render(
        <WebAuthGate>
          <div data-testid="app-inside-gate">Inside Gate</div>
        </WebAuthGate>
      );

      await screen.findByTestId('app-inside-gate');

      // Open SSH / Account modal and submit password change
      fireEvent.click(screen.getByText('🔑 SSH key'));
      fireEvent.change(screen.getByPlaceholderText('Current password'), {
        target: { value: 'old-pass-123' },
      });
      fireEvent.change(screen.getByPlaceholderText('New password (at least 6 characters)'), {
        target: { value: 'new-pass-456' },
      });
      fireEvent.click(screen.getByText('Update password'));

      await screen.findByText('The password was updated');
      expect(
        calls.some(
          (c) =>
            c.url.endsWith('/api/user/password') &&
            c.method === 'POST' &&
            c.body?.currentPassword === 'old-pass-123' && // pragma: allowlist secret
            c.body?.newPassword === 'new-pass-456' // pragma: allowlist secret
        )
      ).toBe(true);

      // Switch to Team tab and revoke active invite
      fireEvent.click(screen.getByText('👥 Invites and user accounts'));
      await screen.findByText(/inv_test_123/);
      fireEvent.click(screen.getByText('Revoke'));

      await screen.findByText('Invite code revoked.');
      expect(
        calls.some(
          (c) => c.url.includes('/api/admin/invites/inv_test_123') && c.method === 'DELETE'
        )
      ).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
      delete (window as any).__SSHS3_WEB_MODE__;
    }
  });

  it('renders AI Workspace Command Center, KPI Ribbon, and 3-tab Right Column (Activity, Memory, Runbooks)', async () => {
    const originalMultissh = (window as any).multissh;
    const aiOpenEvents: any[] = [];
    const listener = (e: Event) => {
      aiOpenEvents.push((e as CustomEvent).detail);
    };
    window.addEventListener('sshs3:ai-open', listener);

    try {
      render(
        <LandingView
          recentSSH={mockRecentSSH}
          onConnectRecentSSH={vi.fn()}
          onConnectSFTP={vi.fn()}
          onQuickConnectSSH={vi.fn()}
          onQuickStartTerminal={vi.fn()}
          onNewTab={vi.fn()}
          onOpenProfiles={vi.fn()}
          onNewProfile={vi.fn()}
          onOpenSyncBootstrap={vi.fn()}
          onNavigateToTabBar={vi.fn()}
        />
      );

      // KPI Ribbon & AI Command Bar are present
      expect(screen.getByTestId('workspace-kpi-ribbon')).toBeInTheDocument();
      expect(screen.getByTestId('workspace-ai-command-bar')).toBeInTheDocument();

      // Submitting a prompt in the AI Workspace Command Bar dispatches sshs3:ai-open
      const promptInput = screen.getByTestId('workspace-ai-prompt-input');
      fireEvent.change(promptInput, {
        target: { value: 'Konfigurera en SSH-tunnel för port 5432' },
      });
      fireEvent.click(screen.getByTestId('workspace-ai-submit-btn'));
      expect(aiOpenEvents.length).toBeGreaterThanOrEqual(1);
      expect(aiOpenEvents[0]).toMatchObject({
        view: 'Work',
        mode: 'panel',
        prompt: 'Konfigurera en SSH-tunnel för port 5432',
      });

      // The team's activity, memory and runbooks are views of the AI panel, not a column of this page.
      expect(screen.queryByTestId('workspace-right-column')).not.toBeInTheDocument();

      // Self-learning reflection button & @orama/orama + Voyager badge are rendered in the command center
      expect(screen.getByText('@orama/orama + Voyager')).toBeInTheDocument();
      const reflectBtn = screen.getByTestId('workspace-self-reflect-btn');
      expect(reflectBtn).toBeInTheDocument();
      // hubRequest stores whatever aiHubRequest resolves as the shared hub snapshot, so resolve with
      // this test's snapshot (none) instead of a partial object that would leak into later tests.
      const aiHubRequestMock = vi.fn().mockResolvedValue(undefined);
      (window as any).multissh = {
        ...(originalMultissh ?? {}),
        aiHubRequest: aiHubRequestMock,
      };
      await act(async () => {
        fireEvent.click(reflectBtn);
      });
      expect(aiHubRequestMock).toHaveBeenCalledWith({ action: 'self-learn-reflect' });

    } finally {
      window.removeEventListener('sshs3:ai-open', listener);
      if (originalMultissh === undefined) delete (window as any).multissh;
      else (window as any).multissh = originalMultissh;
    }
  });

  it('connects via the quick-connect field for a typed user@host, without saving it as a profile', () => {
    const onQuickConnectSSH = vi.fn();
    render(
      <LandingView
        recentSSH={mockRecentSSH}
        onConnectRecentSSH={vi.fn()}
        onConnectSFTP={vi.fn()}
        onQuickConnectSSH={onQuickConnectSSH}
        onQuickStartTerminal={vi.fn()}
        onNewTab={vi.fn()}
        onOpenProfiles={vi.fn()}
        onNewProfile={vi.fn()}
        onOpenSyncBootstrap={vi.fn()}
        onNavigateToTabBar={vi.fn()}
      />
    );

    const input = screen.getByPlaceholderText(/Type user@host to connect/);
    fireEvent.change(input, { target: { value: 'deploy@staging.example.com' } });
    fireEvent.click(screen.getByTestId('quick-connect-btn'));

    expect(onQuickConnectSSH).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'staging.example.com', username: 'deploy', authType: 'password' })
    );
    expect(input).toHaveValue('');
  });

  it('disables the quick-connect Connect button until the typed value looks like user@host', () => {
    render(
      <LandingView
        recentSSH={mockRecentSSH}
        onConnectRecentSSH={vi.fn()}
        onConnectSFTP={vi.fn()}
        onQuickConnectSSH={vi.fn()}
        onQuickStartTerminal={vi.fn()}
        onNewTab={vi.fn()}
        onOpenProfiles={vi.fn()}
        onNewProfile={vi.fn()}
        onOpenSyncBootstrap={vi.fn()}
        onNavigateToTabBar={vi.fn()}
      />
    );

    expect(screen.getByTestId('quick-connect-btn')).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/Type user@host to connect/), { target: { value: 'not a target' } });
    expect(screen.getByTestId('quick-connect-btn')).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/Type user@host to connect/), { target: { value: 'root@example.com' } });
    expect(screen.getByTestId('quick-connect-btn')).not.toBeDisabled();
  });
});
