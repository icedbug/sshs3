import React, { useEffect, useRef, useState } from 'react';
import { ShieldAlert, ShieldQuestion } from 'lucide-react';
import type { HostKeyPromptEvent } from '@shared/types/ipc';
import { useEscapeToClose } from '../lib/useModalDismiss';
import { useDialogFocus } from '../lib/useDialogFocus';
import { createRendererLogger } from '../lib/log';
const log = createRendererLogger('HostKeyTrustModal');

export const HostKeyTrustModal: React.FC = () => {
  const [prompts, setPrompts] = useState<HostKeyPromptEvent[]>([]);

  const currentPrompt = prompts[0] || null;

  useEffect(() => {
    if (!window.multissh?.onHostKeyPrompt) return;

    const unsubscribe = window.multissh.onHostKeyPrompt((event) => {
      setPrompts((prev) => [...prev, event]);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  const respond = async (trust: boolean) => {
    if (!currentPrompt) return;
    const promptId = currentPrompt.id;

    setPrompts((prev) => prev.slice(1));

    if (window.multissh?.respondHostKeyPrompt) {
      try {
        await window.multissh.respondHostKeyPrompt(promptId, trust);
      } catch (err) {
        log.error('Failed to respond to host key prompt:', err);
      }
    }
  };

  // M11 (code review): this modal often appears while focus is still inside
  // a terminal (xterm's hidden textarea), which never sees a keydown handler
  // attached only to the dialog's own <div>. A window-level listener (like
  // FileEditorModal/SearchModal/DirectorySyncModal already use) catches
  // Escape regardless of where focus currently is.
  useEscapeToClose(() => void respond(false), !!currentPrompt);
  // Cancel keeps its autoFocus: useDialogFocus leaves focus alone when it is already inside the dialog.
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, !!currentPrompt);

  if (!currentPrompt) {
    return null;
  }

  const isMismatch = currentPrompt.status === 'mismatch';

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="hostkey-modal-title"
      data-testid="hostkey-trust-modal"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/65 animate-in fade-in duration-150 p-4"
    >
      <div className="w-full max-w-md rounded-xl border border-border-subtle bg-app-card p-6 shadow-2xl">
        <div className="flex items-center gap-3">
          <div
            className={
              'flex h-10 w-10 items-center justify-center rounded-xl ' +
              (isMismatch ? 'bg-red-500/20 text-red-400' : 'bg-sky-500/20 text-sky-400')
            }
          >
            {isMismatch ? <ShieldAlert className="h-5 w-5" /> : <ShieldQuestion className="h-5 w-5" />}
          </div>
          <div>
            <h2 id="hostkey-modal-title" className="text-base font-semibold text-txt-primary">
              {isMismatch ? 'Host Key Changed!' : 'Unknown Host'}
            </h2>
            <p className="text-xs text-txt-muted">
              {currentPrompt.host}
              {currentPrompt.port !== 22 ? `:${currentPrompt.port}` : ''}
            </p>
          </div>
        </div>

        <div className="mt-4 space-y-3 text-xs text-txt-secondary">
          {isMismatch ? (
            <p className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-red-300 leading-relaxed">
              WARNING: The host key for this server differs from the key stored previously. This could mean
              the server was reinstalled or reconfigured, but could also indicate a man-in-the-middle attack.
              Replacing the key removes all stored keys for this host from known_hosts; you will be asked to verify the new
              key when you reconnect. Only replace it if you are confident this change is legitimate.
            </p>
          ) : (
            <p className="text-txt-secondary leading-relaxed">
              This server could not be verified against known hosts. Verify the fingerprint below with the server
              administrator before trusting it.
            </p>
          )}

          <div className="rounded-lg border border-border-subtle bg-app-input px-3 py-2 font-mono text-xs text-txt-primary">
            <div>Key Type: {currentPrompt.keyType}</div>
            <div className="break-all mt-1">Fingerprint: {currentPrompt.fingerprint}</div>
          </div>
        </div>

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={() => respond(false)}
            autoFocus
            data-testid="hostkey-trust-cancel"
            className="rounded-lg border border-border-subtle px-4 py-2 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => respond(true)}
            data-testid="hostkey-trust-accept"
            className={
              'rounded-lg px-4 py-2 text-xs font-medium text-white shadow-sm transition-colors ' +
              (isMismatch
                ? 'bg-red-600 hover:bg-red-500'
                : 'bg-sky-600 hover:bg-sky-500')
            }
          >
            {isMismatch ? 'Replace Key' : 'Trust Host'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default HostKeyTrustModal;
