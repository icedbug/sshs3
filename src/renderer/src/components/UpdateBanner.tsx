import React, { useState } from 'react';
import { Download, Loader2, X } from 'lucide-react';
import { useUpdateState } from '../lib/useUpdateState';

/**
 * Non-blocking banner shown when a new version is available. Nothing is
 * downloaded or installed until the user clicks; the restart goes through the
 * normal quit flow, so the active-transfer/quit confirmation still applies.
 */
export const UpdateBanner: React.FC = () => {
  const state = useUpdateState();
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  if (state?.status === 'installing') {
    return (
      <div
        role="alert"
        aria-live="assertive"
        data-testid="update-installing"
        className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-150"
      >
        <div className="flex items-center gap-3 rounded-xl border border-border-subtle bg-app-card px-5 py-4 shadow-2xl">
          <Loader2 className="h-5 w-5 animate-spin text-sky-400" />
          <div>
            <div className="text-sm font-semibold text-txt-primary">Installing sshs3 {state.version}…</div>
            <p className="mt-0.5 text-xs text-txt-muted">
              The app will restart automatically. You may be asked for your password.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const key = state ? `${state.version}:${state.status}` : null;
  if (!state || !state.version || key === dismissedKey) return null;
  if (state.status !== 'available' && state.status !== 'downloading' && state.status !== 'ready') return null;

  return (
    <div
      role="status"
      data-testid="update-banner"
      className="fixed bottom-3 right-3 z-50 w-full max-w-sm rounded-xl border border-border-subtle bg-app-card shadow-2xl animate-in fade-in slide-in-from-bottom-2 duration-150"
    >
      <div className="flex items-start gap-2.5 p-3.5">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-400">
          <Download className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold text-txt-primary">sshs3 {state.version} is available</div>
          <p className="mt-0.5 text-xs text-txt-muted">
            {state.status === 'available' &&
              (state.error ? `${state.error}. You can try again.` : `You are running ${state.currentVersion}.`)}
            {state.status === 'downloading' && `Downloading… ${state.progress ?? 0}%`}
            {state.status === 'ready' &&
              (state.error ? `${state.error}. You can try again.` : 'Downloaded. Restart to finish updating.')}
          </p>
          <div className="mt-2.5 flex gap-1.5">
            {state.status === 'available' && (
              <button
                type="button"
                onClick={() => void window.multissh?.downloadUpdate()}
                className="rounded-lg bg-sky-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-500 transition-colors"
              >
                Download
              </button>
            )}
            {state.status === 'ready' && (
              <button
                type="button"
                onClick={() => void window.multissh?.installUpdate()}
                className="rounded-lg bg-sky-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-500 transition-colors"
              >
                Restart and install
              </button>
            )}
            <button
              type="button"
              onClick={() => setDismissedKey(key)}
              className="rounded-lg border border-border-subtle px-2.5 py-1 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
            >
              Later
            </button>
          </div>
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => setDismissedKey(key)}
          className="rounded p-1.5 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
};
