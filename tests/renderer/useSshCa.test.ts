// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useSshCa } from '../../src/renderer/src/lib/useSshCa';
import type { SshCaStatus } from '../../src/shared/types/sshCa';

const ACTIVE: SshCaStatus = { active: true, username: 'alun', validSecondsRemaining: 600 };

function installApi(overrides: Record<string, unknown> = {}) {
  const api = {
    sshCaGetStatus: vi.fn().mockResolvedValue({ active: false }),
    onSshCaStatusChanged: vi.fn().mockReturnValue(() => {}),
    sshCaLogin: vi.fn().mockResolvedValue(ACTIVE),
    sshCaRenew: vi.fn().mockResolvedValue(ACTIVE),
    sshCaLogout: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  (window as unknown as { sshs3: unknown }).sshs3 = api;
  return api;
}

describe('useSshCa', () => {
  beforeEach(() => installApi());
  afterEach(() => {
    delete (window as unknown as { sshs3?: unknown }).sshs3;
  });

  it('login stores the returned status and clears loading', async () => {
    const api = installApi();
    const { result } = renderHook(() => useSshCa());
    await waitFor(() => expect(api.sshCaGetStatus).toHaveBeenCalled());

    await act(async () => {
      await result.current.login();
    });

    expect(result.current.status).toEqual(ACTIVE);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('renew stores the returned status', async () => {
    const { result } = renderHook(() => useSshCa());
    await act(async () => {
      await result.current.renew();
    });
    expect(result.current.status).toEqual(ACTIVE);
  });

  it('logout resets the status to inactive', async () => {
    const { result } = renderHook(() => useSshCa());
    await act(async () => {
      await result.current.login();
    });
    await act(async () => {
      await result.current.logout();
    });
    expect(result.current.status).toEqual({ active: false });
  });

  it('exposes the error without the Electron IPC prefix and rethrows it', async () => {
    installApi({
      sshCaLogin: vi.fn().mockRejectedValue(new Error("Error invoking remote method 'ssh-ca:login': Error: IdP unreachable")),
    });
    const { result } = renderHook(() => useSshCa());

    let thrown: Error | undefined;
    await act(async () => {
      await result.current.login().catch((e: Error) => {
        thrown = e;
      });
    });

    expect(thrown?.message).toBe('IdP unreachable');
    expect(result.current.error).toBe('IdP unreachable');
    expect(result.current.loading).toBe(false);
  });

  it('rejects login/renew when the API is missing', async () => {
    (window as unknown as { sshs3: unknown }).sshs3 = {};
    const { result } = renderHook(() => useSshCa());
    await expect(result.current.login()).rejects.toThrow(/not supported/);
    await expect(result.current.renew()).rejects.toThrow(/not supported/);
  });
});
