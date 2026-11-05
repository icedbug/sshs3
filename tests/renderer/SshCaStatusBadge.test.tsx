// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SshCaStatusBadge } from '../../src/renderer/src/components/ca/SshCaStatusBadge';
import type { SshCaStatus } from '../../src/shared/types/sshCa';

describe('SshCaStatusBadge', () => {
  let mockStatus: SshCaStatus;
  const mockLogin = vi.fn();
  const mockLogout = vi.fn();
  const mockRenew = vi.fn();

  beforeEach(() => {
    mockStatus = { active: false };
    vi.clearAllMocks();

    window.sshs3 = {
      ...window.sshs3,
      sshCaGetStatus: vi.fn().mockImplementation(async () => mockStatus),
      onSshCaStatusChanged: vi.fn().mockImplementation(() => () => {}),
      sshCaLogin: mockLogin,
      sshCaLogout: mockLogout,
      sshCaRenew: mockRenew,
    } as any;
  });

  it('renders inactive icon when no active certificate session exists', async () => {
    render(<SshCaStatusBadge />);

    const btn = screen.getByTestId('ssh-ca-status-btn');
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute('title', expect.stringContaining('Inactive'));
  });

  it('opens status dialog and shows Log In button when clicked', async () => {
    render(<SshCaStatusBadge />);

    const btn = screen.getByTestId('ssh-ca-status-btn');
    fireEvent.click(btn);

    expect(screen.getByRole('dialog', { name: 'SSH CA Status' })).toBeInTheDocument();
    expect(screen.getByText('Log In with SSH CA')).toBeInTheDocument();

    // Click Log In
    mockLogin.mockResolvedValueOnce({ active: true, username: 'alun' });
    fireEvent.click(screen.getByText('Log In with SSH CA'));
    expect(mockLogin).toHaveBeenCalledTimes(1);
  });

  it('renders active status with username and expiration details', async () => {
    mockStatus = {
      active: true,
      username: 'alun',
      principals: ['alun', 'alun@alun.se'],
      expiresAt: '2026-11-01T07:16:26.000Z',
      validSecondsRemaining: 3600,
      certInfo: {
        certType: 'user',
        keyId: 'alun@alun.se',
        principals: ['alun', 'alun@alun.se'],
        validAfter: '2026-10-31T15:15:26.000Z',
        validBefore: '2026-11-01T07:16:26.000Z',
        serial: '97609306611426011',
        signatureKeyFingerprint: 'SHA256:ca-fp',
        publicKeyFingerprint: 'SHA256:key-fp',
      },
    };

    render(<SshCaStatusBadge />);

    await waitFor(() => {
      const btn = screen.getByTestId('ssh-ca-status-btn');
      expect(btn).toHaveAttribute('title', expect.stringContaining('Active (alun)'));
    });

    fireEvent.click(screen.getByTestId('ssh-ca-status-btn'));

    expect(screen.getByText('alun')).toBeInTheDocument();
    expect(screen.getByText('alun, alun@alun.se')).toBeInTheDocument();
    expect(screen.getByText('97609306611426011')).toBeInTheDocument();
    expect(screen.getByText('Renew Certificate')).toBeInTheDocument();
    expect(screen.getByText('Log Out')).toBeInTheDocument();

    // Click Renew
    mockRenew.mockResolvedValueOnce({ ...mockStatus });
    fireEvent.click(screen.getByText('Renew Certificate'));
    await waitFor(() => expect(mockRenew).toHaveBeenCalledTimes(1));

    // Click Log Out
    mockLogout.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByText('Log Out'));
    await waitFor(() => expect(mockLogout).toHaveBeenCalledTimes(1));
  });

  it('closes popover on Escape key press', async () => {
    render(<SshCaStatusBadge />);

    const btn = screen.getByTestId('ssh-ca-status-btn');
    fireEvent.click(btn);
    expect(screen.getByRole('dialog', { name: 'SSH CA Status' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'SSH CA Status' })).not.toBeInTheDocument();
  });

  it('updates remaining time dynamically while popover is open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const now = new Date('2026-10-31T20:00:00.000Z').getTime();
      vi.setSystemTime(now);

      mockStatus = {
        active: true,
        username: 'alun',
        expiresAt: new Date(now + 120_000).toISOString(), // 2 minutes (120s)
        certInfo: {
          certType: 'user',
          keyId: 'alun',
          principals: ['alun'],
          validAfter: new Date(now - 60_000).toISOString(),
          validBefore: new Date(now + 120_000).toISOString(),
          serial: '123',
          signatureKeyFingerprint: 'SHA256:ca',
          publicKeyFingerprint: 'SHA256:user',
        },
      };

      render(<SshCaStatusBadge />);

      // Wait for status to load
      await waitFor(() => {
        expect(screen.getByTestId('ssh-ca-status-btn')).toHaveAttribute(
          'title',
          expect.stringContaining('Active (alun)')
        );
      });

      // Open popover
      fireEvent.click(screen.getByTestId('ssh-ca-status-btn'));
      expect(screen.getByText(/1m 5[89]s remaining|2m 0s remaining/)).toBeInTheDocument();

      // Advance by 15 seconds
      act(() => {
        vi.advanceTimersByTime(15_000);
      });
      expect(screen.getByText(/1m 4[345]s remaining/)).toBeInTheDocument();

      // Advance past expiration
      act(() => {
        vi.advanceTimersByTime(120_000);
      });
      expect(screen.getByText('Expired')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
