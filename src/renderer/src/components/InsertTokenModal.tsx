import React, { useEffect, useRef, useState } from 'react';
import { Cpu, ShieldCheck, Usb } from 'lucide-react';
import type { InsertTokenPromptEvent } from '@shared/types/ipc';
import { useEscapeToClose } from '../lib/useModalDismiss';
import { useDialogFocus } from '../lib/useDialogFocus';
import { createRendererLogger } from '../lib/log';
const log = createRendererLogger('InsertTokenModal');

const KIND_VISUALS = {
  fido2: {
    title: 'Insert your security key',
    noun: 'FIDO2 security key',
    badge: 'FIDO2 / Security Key',
    badgeClass: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    iconBgClass: 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30',
    iconClass: 'text-emerald-400',
    topBarClass: 'bg-gradient-to-r from-emerald-500 via-teal-400 to-emerald-400',
    Icon: ShieldCheck,
  },
  smartcard: {
    title: 'Insert your smartcard',
    noun: 'smartcard / PIV token',
    badge: 'Smartcard / PIV',
    badgeClass: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
    iconBgClass: 'bg-sky-500/20 text-sky-400 border border-sky-500/30',
    iconClass: 'text-sky-400',
    topBarClass: 'bg-gradient-to-r from-sky-500 via-blue-400 to-indigo-400',
    Icon: Cpu,
  },
} as const;

/**
 * Shown while an operation waits for a smartcard / security key that is not plugged in. The main
 * process polls for the token and dismisses this once it is found, so the PIN prompt takes over.
 */
export const InsertTokenModal: React.FC = () => {
  const [prompts, setPrompts] = useState<InsertTokenPromptEvent[]>([]);
  const dialogRef = useRef<HTMLDivElement>(null);
  const current = prompts[0] ?? null;

  useEffect(() => {
    if (!window.multissh?.onInsertTokenPrompt || !window.multissh?.onInsertTokenDismiss) return;
    const offPrompt = window.multissh.onInsertTokenPrompt((event) => setPrompts((prev) => [...prev, event]));
    const offDismiss = window.multissh.onInsertTokenDismiss(({ id }) =>
      setPrompts((prev) => prev.filter((p) => p.id !== id))
    );
    return () => {
      offPrompt();
      offDismiss();
    };
  }, []);

  const handleCancel = () => {
    if (!current) return;
    const { id } = current;
    setPrompts((prev) => prev.filter((p) => p.id !== id));
    window.multissh?.cancelInsertToken?.(id).catch((err) => log.error('Failed to cancel insert-token prompt:', err));
  };

  useEscapeToClose(handleCancel, !!current);
  useDialogFocus(dialogRef, !!current);

  if (!current) return null;
  const visuals = KIND_VISUALS[current.kind];

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="insert-token-title"
      data-testid="insert-token-modal"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/65 animate-in fade-in duration-150 p-4"
    >
      <div className="w-full max-w-md rounded-xl border border-border-subtle bg-app-card overflow-hidden shadow-2xl">
        <div className={`h-1.5 w-full ${visuals.topBarClass}`} />
        <div className="p-6">
          <div className="flex items-start gap-3.5">
            <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${visuals.iconBgClass}`}>
              <visuals.Icon className={`h-5 w-5 ${visuals.iconClass}`} />
            </div>
            <div className="flex-1 min-w-0">
              <span
                className={`inline-flex items-center px-2 py-0.5 rounded text-2xs font-semibold uppercase tracking-wider mb-1 ${visuals.badgeClass}`}
              >
                {visuals.badge}
              </span>
              <h2 id="insert-token-title" className="text-base font-semibold text-txt-primary truncate">
                {visuals.title}
              </h2>
              <p className="text-xs text-txt-muted mt-0.5">The PIN prompt appears as soon as it is detected.</p>
            </div>
          </div>

          {current.context && (
            <div className="mt-4 rounded-lg border border-border-subtle bg-app-surface/60 px-3 py-2 text-xs">
              <span className="text-txt-muted text-2xs uppercase tracking-wider block font-semibold leading-tight">
                Target / Purpose
              </span>
              <span className="font-mono text-xs text-txt-primary font-medium break-all block">{current.context}</span>
            </div>
          )}

          <div
            role="status"
            aria-live="polite"
            className="mt-4 flex items-center gap-2.5 rounded-lg border border-sky-500/40 bg-sky-500/10 px-3.5 py-2.5"
          >
            <Usb className="h-5 w-5 shrink-0 animate-pulse text-sky-400" />
            <span className="text-xs font-medium text-sky-300">
              Waiting for your {visuals.noun}. Plug it in to continue.
            </span>
          </div>

          <div className="mt-6 flex items-center justify-end">
            <button
              type="button"
              onClick={handleCancel}
              data-testid="insert-token-cancel"
              data-autofocus
              className="rounded-lg border border-border-subtle px-3.5 py-1.5 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default InsertTokenModal;
