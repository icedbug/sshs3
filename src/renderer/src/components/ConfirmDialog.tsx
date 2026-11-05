import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { AlertTriangle, HelpCircle } from 'lucide-react';
import { useModalDismiss } from '../lib/useModalDismiss';
import { useDialogFocus } from '../lib/useDialogFocus';

/**
 * In-app replacement for window.confirm() for destructive/consequential
 * actions (LOW finding, code review): the native dialog is trivially
 * dismissed by a stray Enter/Space press (whatever happens to have focus,
 * including a button the user just clicked), and shows the same one-line
 * prompt for deleting 1 item as for 50. This dialog instead default-focuses
 * Cancel (so an accidental Enter is safe, not destructive) and lets the
 * caller show a message that reflects the actual scale of the action.
 */
export interface ConfirmOptions {
  title?: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm button red and swaps the icon for a warning triangle. Default true. */
  danger?: boolean;
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (value: boolean) => void;
}

const ConfirmContext = createContext<((options: ConfirmOptions) => Promise<boolean>) | null>(null);

export const ConfirmProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  // The request on screen, readable outside render: a second confirm() while one is open must not leave the first
  // promise unresolved for ever (its caller would hang), so it is answered "no" before the new one replaces it.
  const pendingRef = useRef<PendingConfirm | null>(null);

  const confirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      pendingRef.current?.resolve(false);
      // options.danger explicitly set to undefined (e.g. a caller passing a
      // possibly-undefined variable through) must still fall back to the
      // default — a trailing `...options` spread would otherwise let an
      // explicit `undefined` key override it.
      const next: PendingConfirm = { ...options, danger: options.danger ?? true, resolve };
      pendingRef.current = next;
      setPending(next);
    });
  }, []);

  const settle = useCallback(
    (result: boolean) => {
      pending?.resolve(result);
      if (pendingRef.current === pending) pendingRef.current = null;
      setPending(null);
    },
    [pending]
  );

  const handleBackdropClick = useModalDismiss(() => settle(false), pending !== null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // The Cancel button's `autoFocus` below runs first, so useDialogFocus leaves the default focus on Cancel.
  useDialogFocus(dialogRef, pending !== null);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <div
          ref={dialogRef}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby={pending.title ? 'confirm-dialog-title' : undefined}
          aria-label={pending.title ? undefined : 'Confirm'}
          data-testid="confirm-dialog"
          onClick={handleBackdropClick}
          className="fixed inset-0 z-[150] flex items-center justify-center bg-black/65 animate-in fade-in duration-150 p-4"
        >
          <div className="w-full max-w-sm rounded-xl border border-border-subtle bg-app-card p-5 shadow-2xl">
            <div className="flex items-start gap-3">
              <div
                className={
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ' +
                  (pending.danger ? 'bg-red-500/20 text-red-400' : 'bg-sky-500/20 text-sky-400')
                }
              >
                {pending.danger ? <AlertTriangle className="h-4.5 w-4.5" /> : <HelpCircle className="h-4.5 w-4.5" />}
              </div>
              <div className="min-w-0 flex-1 space-y-1">
                {pending.title && (
                  <h2 id="confirm-dialog-title" className="text-sm font-semibold text-txt-primary">
                    {pending.title}
                  </h2>
                )}
                <div className="text-xs text-txt-secondary leading-relaxed">{pending.message}</div>
              </div>
            </div>
            <div className="mt-4 flex items-center justify-end gap-2">
              {/* Autofocused, so a stray Enter/Space press (or the same key
                  that just confirmed a previous, unrelated dialog) cancels
                  rather than confirms. */}
              <button
                type="button"
                autoFocus
                onClick={() => settle(false)}
                className="rounded-lg border border-border-subtle px-3.5 py-1.5 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
              >
                {pending.cancelLabel ?? 'Cancel'}
              </button>
              <button
                type="button"
                onClick={() => settle(true)}
                className={
                  'rounded-lg px-3.5 py-1.5 text-xs font-medium text-white shadow-sm transition-colors ' +
                  (pending.danger ? 'bg-red-600 hover:bg-red-500' : 'bg-sky-600 hover:bg-sky-500')
                }
              >
                {pending.confirmLabel ?? (pending.danger ? 'Delete' : 'OK')}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
};

// eslint-disable-next-line react-refresh/only-export-components -- companion hook for context provider in same file
export function useConfirm(): (options: ConfirmOptions) => Promise<boolean> {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    throw new Error('useConfirm must be used within a ConfirmProvider');
  }
  return ctx;
}
