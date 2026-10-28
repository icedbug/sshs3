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

  it('auto-focuses the first button after mount', () => {
    render(
      <LandingView
        recentSSH={mockRecentSSH}
        onConnectRecentSSH={vi.fn()}
        onConnectSFTP={vi.fn()}
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

    const firstConnectBtn = screen.getByTestId('recent-connect-conn-1');
    expect(document.activeElement).toBe(firstConnectBtn);
  });

  it('navigates with ArrowDown and ArrowUp between buttons', () => {
    const onNavigateToTabBar = vi.fn();
    const { container } = render(
      <LandingView
        recentSSH={mockRecentSSH}
        onConnectRecentSSH={vi.fn()}
        onConnectSFTP={vi.fn()}
        onQuickStartTerminal={vi.fn()}
        onNewTab={vi.fn()}
        onOpenProfiles={vi.fn()}
        onNewProfile={vi.fn()}
        onOpenSyncBootstrap={vi.fn()}
        onNavigateToTabBar={onNavigateToTabBar}
      />
    );

    const firstConnectBtn = screen.getByTestId('recent-connect-conn-1');
    firstConnectBtn.focus();

    // ArrowUp on the very first element jumps up to TabBar
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
          onQuickStartTerminal={vi.fn()}
          onNewTab={vi.fn()}
          onOpenProfiles={vi.fn()}
          onNewProfile={vi.fn()}
          onOpenSyncBootstrap={vi.fn()}
          onNavigateToTabBar={vi.fn()}
        />
      );
      const badge = screen.getByTestId('s3-workspace-status-badge');
      expect(badge.textContent).toContain('VM Team-delning aktiv på denna Web-server');
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
      fireEvent.click(screen.getByText('🔑 SSH-nyckel'));
      fireEvent.change(screen.getByPlaceholderText('Nuvarande lösenord'), {
        target: { value: 'old-pass-123' },
      });
      fireEvent.change(screen.getByPlaceholderText('Nytt lösenord (minst 6 tecken)'), {
        target: { value: 'new-pass-456' },
      });
      fireEvent.click(screen.getByText('Uppdatera lösenord'));

      await screen.findByText('Lösenordet har uppdaterats!');
      expect(
        calls.some(
          (c) =>
            c.url.endsWith('/api/user/password') &&
            c.method === 'POST' &&
            c.body?.currentPassword === 'old-pass-123' &&
            c.body?.newPassword === 'new-pass-456'
        )
      ).toBe(true);

      // Switch to Team tab and revoke active invite
      fireEvent.click(screen.getByText('👥 Bjud in kompisar & Användarkonton'));
      await screen.findByText(/inv_test_123/);
      fireEvent.click(screen.getByText('Återkalla'));

      await screen.findByText('Invite-kod återkallad.');
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
});
