import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { IS_WINDOWS } from '../../lib/platform';
import { describeIpcError } from '../../lib/format';

interface WindowsAgentPathNoticeProps {
  /** The PKCS#11 module currently chosen as the default; nothing is shown for Auto-detect (empty). */
  libPath: string;
}

/**
 * Windows only. Some PKCS#11 modules (Yubico's libykcs11) keep the DLLs they depend on in their own folder. The
 * Windows ssh-agent service only searches the *machine* PATH, so without that folder on it `ssh-add -s` fails with
 * a bare "agent refused operation". When that's the case for the chosen module, explain it and offer a one-click
 * fix — explicit, because it edits the system-wide PATH and restarts the agent (administrator prompt).
 */
export const WindowsAgentPathNotice: React.FC<WindowsAgentPathNoticeProps> = ({ libPath }) => {
  const [status, setStatus] = useState<{ needsFix: boolean; libDir?: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justFixed, setJustFixed] = useState(false);

  const check = useCallback(async () => {
    if (!IS_WINDOWS || !libPath) {
      setStatus(null);
      return;
    }
    setChecking(true);
    try {
      const s = await window.multissh?.smartcardAgentPathStatus?.(libPath);
      setStatus(s?.applicable ? { needsFix: s.needsFix, libDir: s.libDir } : null);
    } catch {
      setStatus(null);
    } finally {
      setChecking(false);
    }
  }, [libPath]);

  useEffect(() => {
    setError(null);
    setJustFixed(false);
    void check();
  }, [check]);

  const fix = async () => {
    setFixing(true);
    setError(null);
    try {
      await window.multissh.smartcardAgentPathFix(libPath);
      setJustFixed(true);
      await check();
    } catch (err) {
      setError(describeIpcError(err, 'Could not update the system PATH'));
    } finally {
      setFixing(false);
    }
  };

  if (!IS_WINDOWS || !libPath) return null;

  if (checking && !status) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-txt-muted">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Checking whether the Windows ssh-agent can load this driver...
      </div>
    );
  }

  if (justFixed && status && !status.needsFix) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-emerald-300">
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
        Done — the Windows ssh-agent was restarted and can now load this driver.
      </div>
    );
  }

  if (!status?.needsFix) return null;

  return (
    <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs">
      <div className="flex items-start gap-1.5 text-amber-300">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          The Windows ssh-agent can't load this driver yet: its helper files live in{' '}
          <code className="font-mono">{status.libDir}</code>, which isn't on the system PATH, so unlocking the card
          fails with "agent refused operation" before your PIN is even used.
        </span>
      </div>
      <p className="text-txt-muted">
        Fixing it adds that folder to the <span className="text-txt-primary">system-wide</span> PATH and restarts the
        OpenSSH Authentication Agent (this clears keys currently loaded in it). Windows will ask for administrator
        approval. The driver's own DLLs become visible to every program, so only do this for a driver you trust.
      </p>
      {error && <p role="alert" className="text-red-300">{error}</p>}
      <button
        type="button"
        onClick={() => void fix()}
        disabled={fixing}
        className="flex items-center gap-1.5 rounded-lg bg-amber-600 px-2.5 py-1.5 font-medium text-white hover:bg-amber-500 disabled:opacity-50 transition-colors"
      >
        {fixing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {fixing ? 'Waiting for administrator approval...' : 'Fix Windows ssh-agent (administrator)'}
      </button>
    </div>
  );
};
