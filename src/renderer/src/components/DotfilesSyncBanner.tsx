import React, { useEffect, useState } from 'react';
import { FileCode, X } from 'lucide-react';
import type { DotfilesSyncPromptEvent, DotfilesSyncStatusEvent } from '@shared/types/dotfiles';
import { createRendererLogger } from '../lib/log';
const log = createRendererLogger('DotfilesSyncBanner');

/**
 * Global, non-blocking banner for the dotfiles pool "ask" policy. Deliberately
 * not a modal dialog with a backdrop: a diff on connect shouldn't interrupt
 * someone who just wants to start typing in their new terminal.
 */
export const DotfilesSyncBanner: React.FC = () => {
  const [prompts, setPrompts] = useState<DotfilesSyncPromptEvent[]>([]);
  const [status, setStatus] = useState<DotfilesSyncStatusEvent | null>(null);

  const currentPrompt = prompts[0] || null;

  useEffect(() => {
    if (!window.multissh?.onDotfilesSyncPrompt) return;
    const unsubscribe = window.multissh.onDotfilesSyncPrompt((event) => {
      setPrompts((prev) => [...prev, event]);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!window.multissh?.onDotfilesSyncStatus) return;
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = window.multissh.onDotfilesSyncStatus((event) => {
      clearTimeout(hideTimer);
      setStatus(event);
      // A success confirmation fades away; a failure stays until it is dismissed, so it cannot be missed.
      if (event.status === 'updated') hideTimer = setTimeout(() => setStatus(null), 4000);
    });
    return () => {
      clearTimeout(hideTimer);
      unsubscribe();
    };
  }, []);

  const respond = async (resolution: 'update' | 'ignore' | 'always') => {
    if (!currentPrompt) return;
    const id = currentPrompt.id;
    setPrompts((prev) => prev.slice(1));
    try {
      await window.multissh?.respondDotfilesSyncPrompt?.(id, resolution);
    } catch (err) {
      log.error('Failed to respond to dotfiles sync prompt:', err);
    }
  };

  return (
    <>
      {currentPrompt && (
        <div
          // Not a dialog: an `alertdialog` is taken for a modal overlay by getTopmostOverlay(), which
          // would capture Ctrl+Shift+Arrow and stop all navigation while this banner is up. `status` is
          // announced when it appears (a live region that is created already filled often is not).
          role="status"
          aria-labelledby="dotfiles-sync-banner-title"
          data-testid="dotfiles-sync-banner"
          className="w-full rounded-xl border border-border-subtle bg-app-card shadow-2xl animate-in fade-in slide-in-from-top-2 duration-150"
        >
          <div className="flex items-start gap-2.5 p-3.5">
            <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-sky-500/10 text-sky-400">
              <FileCode className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div id="dotfiles-sync-banner-title" className="text-xs font-semibold text-txt-primary">
                Dotfiles out of date on {currentPrompt.hostLabel}
              </div>
              <p className="mt-0.5 text-xs text-txt-muted">
                {(currentPrompt.entries ?? []).length} file{(currentPrompt.entries ?? []).length === 1 ? '' : 's'} from pool
                &ldquo;{currentPrompt.poolName}&rdquo; {(currentPrompt.entries ?? []).length === 1 ? 'differs' : 'differ'}{' '}
                from this server.
              </p>
              <ul className="mt-1.5 space-y-0.5 font-mono text-2xs text-txt-muted">
                {(currentPrompt.entries ?? []).slice(0, 4).map((entry) => (
                  <li key={entry.fileId} className="truncate" title={entry.remotePath}>
                    {entry.remotePath} {entry.reason === 'missing' ? '(missing)' : '(changed)'}
                  </li>
                ))}
                {(currentPrompt.entries ?? []).length > 4 && <li>+ {(currentPrompt.entries ?? []).length - 4} more</li>}
              </ul>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => void respond('update')}
                  className="rounded-lg bg-sky-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-500 transition-colors"
                >
                  Update
                </button>
                <button
                  type="button"
                  onClick={() => void respond('ignore')}
                  className="rounded-lg border border-border-subtle px-2.5 py-1 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
                >
                  Ignore
                </button>
                <button
                  type="button"
                  onClick={() => void respond('always')}
                  className="rounded-lg border border-border-subtle px-2.5 py-1 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
                >
                  Always update this host
                </button>
              </div>
            </div>
            <button
              aria-label="Dismiss"
              type="button"
              onClick={() => void respond('ignore')}
              className="rounded p-1 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
              title="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {!currentPrompt && status && (
        <div
          data-testid="dotfiles-sync-status"
          role={status.status === 'updated' ? 'status' : 'alert'}
          className="flex w-full items-start justify-between gap-2 rounded-lg border border-border-subtle bg-app-card px-3 py-2 text-xs shadow-lg animate-in fade-in slide-in-from-top-2 duration-150"
        >
          {status.status === 'updated' ? (
            <span className="text-emerald-400">
              ✓ {status.updatedCount ?? 0} dotfile{status.updatedCount === 1 ? '' : 's'} updated
            </span>
          ) : (
            <>
              <span className="text-red-400">Dotfiles sync failed: {status.error}</span>
              <button
                type="button"
                aria-label="Dismiss"
                title="Dismiss"
                onClick={() => setStatus(null)}
                className="shrink-0 rounded p-1.5 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
};

export default DotfilesSyncBanner;
