import { useCallback, useEffect, useState } from 'react';
import type { SshCaConfig, SshCaStatus } from '@shared/types/sshCa';
import { ELECTRON_IPC_PREFIX } from './format';

function cleanIpcError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(ELECTRON_IPC_PREFIX, '');
}

export function useSshCa() {
  const [status, setStatus] = useState<SshCaStatus>({ active: false });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async (): Promise<SshCaStatus> => {
    if (!window.sshs3?.sshCaGetStatus) {
      return { active: false };
    }
    try {
      const s = await window.sshs3.sshCaGetStatus();
      setStatus(s);
      return s;
    } catch (err) {
      const msg = cleanIpcError(err);
      setError(msg);
      return { active: false, error: msg };
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    if (!window.sshs3?.onSshCaStatusChanged) return;
    const unsubscribe = window.sshs3.onSshCaStatusChanged((s) => {
      setStatus(s);
      if (s.error) {
        setError(s.error);
      } else {
        setError(null);
      }
    });
    return () => unsubscribe();
  }, [refreshStatus]);

  /** Runs one IPC action with the shared loading/error handling; rethrows the cleaned error. */
  const run = useCallback(async <T,>(action: () => Promise<T>): Promise<T> => {
    setLoading(true);
    setError(null);
    try {
      return await action();
    } catch (err) {
      const msg = cleanIpcError(err);
      setError(msg);
      throw new Error(msg, { cause: err });
    } finally {
      setLoading(false);
    }
  }, []);

  const login = useCallback(
    (config?: SshCaConfig): Promise<SshCaStatus> => {
      const ipcLogin = window.sshs3?.sshCaLogin;
      if (!ipcLogin) return Promise.reject(new Error('SSH CA is not supported in this environment'));
      return run(async () => {
        const res = await window.sshs3.sshCaLogin(config);
        setStatus(res);
        return res;
      });
    },
    [run]
  );

  const logout = useCallback(async (): Promise<void> => {
    if (!window.sshs3?.sshCaLogout) return;
    await run(async () => {
      await window.sshs3.sshCaLogout();
      setStatus({ active: false });
    });
  }, [run]);

  const renew = useCallback(
    (): Promise<SshCaStatus> => {
      if (!window.sshs3?.sshCaRenew) return Promise.reject(new Error('SSH CA is not supported in this environment'));
      return run(async () => {
        const res = await window.sshs3.sshCaRenew();
        setStatus(res);
        return res;
      });
    },
    [run]
  );

  return {
    status,
    loading,
    error,
    login,
    logout,
    renew,
    refreshStatus,
  };
}
