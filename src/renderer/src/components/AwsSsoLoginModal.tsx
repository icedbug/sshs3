import React, { useEffect, useState, useRef } from 'react';
import { Check, Cloud, Copy, Loader2 } from 'lucide-react';
import type { AwsSsoPromptEvent } from '@shared/types/ipc';
import { useEscapeToClose } from '../lib/useModalDismiss';
import { useDialogFocus } from '../lib/useDialogFocus';
import { createRendererLogger } from '../lib/log';
const log = createRendererLogger('AwsSsoLoginModal');

export const AwsSsoLoginModal: React.FC = () => {
  const [prompts, setPrompts] = useState<AwsSsoPromptEvent[]>([]);
  const [copied, setCopied] = useState<'code' | 'link' | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const currentPrompt = prompts[0] || null;

  useEffect(() => {
    if (!window.multissh?.onAwsSsoPrompt) return;

    const unsubscribe = window.multissh.onAwsSsoPrompt((event) => {
      setPrompts((prev) => [...prev, event]);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!window.multissh?.onAwsSsoPromptDone) return;
    return window.multissh.onAwsSsoPromptDone((id) => {
      setPrompts((prev) => prev.filter((p) => p.id !== id));
    });
  }, []);

  useEffect(() => {
    setCopied(null);
    setCancelling(false);
  }, [currentPrompt?.id]);

  const copyToClipboard = async (kind: 'code' | 'link', value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
    } catch (err) {
      log.error('Failed to copy to clipboard:', err);
    }
  };

  const handleCancel = async () => {
    if (!currentPrompt) return;
    const promptId = currentPrompt.id;

    setCancelling(true);
    setPrompts((prev) => prev.slice(1));

    if (window.multissh?.awsSsoCancelLogin) {
      try {
        await window.multissh.awsSsoCancelLogin(promptId);
      } catch (err) {
        log.error('Failed to cancel AWS SSO login:', err);
      }
    }
  };

  // M11 (code review): a window-level listener catches Escape even while
  // focus is elsewhere (e.g. a terminal), unlike a handler attached only to
  // this dialog's own <div>.
  useEscapeToClose(() => void handleCancel(), !!currentPrompt);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, !!currentPrompt);

  if (!currentPrompt) {
    return null;
  }

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="aws-sso-modal-title"
      data-testid="aws-sso-login-modal"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/65 animate-in fade-in duration-150 p-4"
    >
      <div className="w-full max-w-md rounded-xl border border-border-subtle bg-app-card p-6 shadow-2xl">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-orange-500/20 text-orange-400">
            <Cloud className="h-5 w-5" />
          </div>
          <div>
            <h2 id="aws-sso-modal-title" className="text-base font-semibold text-txt-primary">
              Sign in with AWS SSO
            </h2>
            <p className="text-xs text-txt-muted">Approve this sign-in in your browser</p>
          </div>
        </div>

        <div className="mt-4 space-y-3 text-xs text-txt-secondary">
          <p className="leading-relaxed">
            We opened your browser to approve this sign-in. If nothing opened, visit the verification
            page yourself and enter the code below.
          </p>

          <div className="flex items-center justify-between gap-2 rounded-lg border border-border-subtle bg-app-input px-3 py-2.5">
            <span className="font-mono text-base tracking-widest text-txt-primary">{currentPrompt.userCode}</span>
            <button
              type="button"
              onClick={() => void copyToClipboard('code', currentPrompt.userCode)}
              className="flex items-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
              title="Copy code"
            >
              {copied === 'code' ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
          </div>

          <div className="flex items-center justify-between gap-2 rounded-lg border border-border-subtle bg-app-input px-3 py-2">
            <span className="truncate text-txt-secondary">{currentPrompt.verificationUri}</span>
            <button
              type="button"
              onClick={() => void copyToClipboard('link', currentPrompt.verificationUriComplete || currentPrompt.verificationUri)}
              className="flex shrink-0 items-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
              title={currentPrompt.verificationUriComplete ? 'Copy link (with code pre-filled)' : 'Copy link'}
            >
              {copied === 'link' ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
          </div>

          <div className="flex items-center gap-2 text-txt-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span>Waiting for approval in your browser…</span>
          </div>
        </div>

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            disabled={cancelling}
            onClick={() => void handleCancel()}
            data-testid="aws-sso-login-cancel"
            className="rounded-lg border border-border-subtle px-4 py-2 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors disabled:opacity-40"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};

export default AwsSsoLoginModal;
