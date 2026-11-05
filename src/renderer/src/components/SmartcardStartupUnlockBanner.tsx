import React, { useEffect, useState } from 'react';
import { KeyRound, X } from 'lucide-react';
import type { SmartcardStartupUnlockStatusEvent } from '@shared/types/ipc';

/**
 * Surfaces failures from the "unlock smartcard/FIDO2 at startup" flow.
 * That flow runs fire-and-forget in the main process (see
 * runSmartcardStartupUnlockWork in IpcBridge.ts) — a wrong or empty PIN
 * would otherwise fail silently until the user later tries to actually
 * use the card, with no obvious link back to the startup prompt.
 */
export const SmartcardStartupUnlockBanner: React.FC = () => {
  const [status, setStatus] = useState<SmartcardStartupUnlockStatusEvent | null>(null);

  useEffect(() => {
    if (!window.multissh?.onSmartcardStartupUnlockStatus) return;
    const unsubscribe = window.multissh.onSmartcardStartupUnlockStatus((event) => {
      if (event.status === 'error') {
        setStatus(event);
      }
    });
    return () => unsubscribe();
  }, []);

  if (!status) return null;

  const label = status.kind === 'fido2' ? 'FIDO2 resident keys' : 'Smartcard';

  return (
    <div
      role="alert"
      data-testid="smartcard-startup-unlock-error"
      className="w-full rounded-xl border border-border-subtle bg-app-card shadow-2xl animate-in fade-in slide-in-from-top-2 duration-150"
    >
      <div className="flex items-start gap-2.5 p-3.5">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-red-500/10 text-red-400">
          <KeyRound className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold text-txt-primary">Unlock failed</div>
          <p className="mt-0.5 text-xs text-txt-muted">
            {label} could not be unlocked ({status.error ?? 'unknown error'}). You&apos;ll be prompted again the
            next time it&apos;s needed, or you can retry from the smartcard icon in the top bar.
          </p>
        </div>
        <button
          aria-label="Dismiss"
          type="button"
          onClick={() => setStatus(null)}
          className="rounded p-1 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
          title="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
};

export default SmartcardStartupUnlockBanner;
