import React, { useState, useEffect, useRef } from 'react';
import { KeyRound, ShieldCheck, Cpu, Lock, Server, Layers, FolderSync, Users } from 'lucide-react';
import type { AskpassPromptKind } from '@shared/types/ipc';
import { useEscapeToClose } from '../lib/useModalDismiss';
import { useDialogFocus } from '../lib/useDialogFocus';
import { createRendererLogger } from '../lib/log';
const log = createRendererLogger('SmartcardPinModal');

export interface AskpassPromptItem {
  id: string;
  prompt: string;
  sessionId?: string;
  kind?: AskpassPromptKind;
  context?: string;
  error?: string;
  attempt?: number;
  maxAttempts?: number;
}

interface KindVisuals {
  title: string;
  subtitle: string;
  badge: string;
  badgeClass: string;
  iconBgClass: string;
  iconClass: string;
  topBarClass: string;
  focusBorderClass: string;
  submitBtnClass: string;
  inputPlaceholder: string;
  Icon: React.ComponentType<{ className?: string }>;
}

const KIND_VISUALS: Record<AskpassPromptKind, KindVisuals> = {
  fido2: {
    title: 'FIDO2 / Security Key Authentication',
    subtitle: "Enter this device's FIDO2 PIN (not your PIV/smartcard PIN or server password)",
    badge: 'FIDO2 / Security Key',
    badgeClass: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    iconBgClass: 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30',
    iconClass: 'text-emerald-400',
    topBarClass: 'bg-gradient-to-r from-emerald-500 via-teal-400 to-emerald-400',
    focusBorderClass: 'focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/50',
    submitBtnClass: 'bg-emerald-600 hover:bg-emerald-500 text-white',
    inputPlaceholder: 'Enter security key PIN...',
    Icon: ShieldCheck,
  },
  smartcard: {
    title: 'Smartcard / PIV Authentication',
    subtitle: "Enter this card's PIV PIN (not a FIDO2 PIN or server password)",
    badge: 'Smartcard / PIV',
    badgeClass: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
    iconBgClass: 'bg-sky-500/20 text-sky-400 border border-sky-500/30',
    iconClass: 'text-sky-400',
    topBarClass: 'bg-gradient-to-r from-sky-500 via-blue-400 to-indigo-400',
    focusBorderClass: 'focus:border-sky-500 focus:ring-1 focus:ring-sky-500/50',
    submitBtnClass: 'bg-sky-600 hover:bg-sky-500 text-white',
    inputPlaceholder: 'Enter smartcard PIN...',
    Icon: Cpu,
  },
  password: {
    title: 'Host / Server Authentication',
    subtitle: 'Enter your account password for this remote server',
    badge: 'Host Password',
    badgeClass: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
    iconBgClass: 'bg-amber-500/20 text-amber-400 border border-amber-500/30',
    iconClass: 'text-amber-400',
    topBarClass: 'bg-gradient-to-r from-amber-500 via-amber-400 to-orange-400',
    focusBorderClass: 'focus:border-amber-500 focus:ring-1 focus:ring-amber-500/50',
    submitBtnClass: 'bg-amber-600 hover:bg-amber-500 text-white',
    inputPlaceholder: 'Enter server password...',
    Icon: Lock,
  },
};

const DEFAULT_VISUALS: KindVisuals = {
  title: 'Security Authentication',
  subtitle: 'Smartcard / SSH PIN Prompt',
  badge: 'Authentication',
  badgeClass: 'bg-slate-500/15 text-txt-secondary border-slate-500/30',
  iconBgClass: 'bg-slate-500/20 text-txt-muted border border-slate-500/30',
  iconClass: 'text-txt-muted',
  topBarClass: 'bg-gradient-to-r from-slate-500 to-slate-400',
  focusBorderClass: 'focus:border-sky-500 focus:ring-1 focus:ring-sky-500/50',
  submitBtnClass: 'bg-sky-600 hover:bg-sky-500 text-white',
  inputPlaceholder: 'Enter PIN / password...',
  Icon: KeyRound,
};

function resolvePromptContext(
  item: AskpassPromptItem
): { label: string; icon: React.ComponentType<{ className?: string }> } | null {
  const raw =
    item.context?.trim() ||
    (() => {
      const p = item.prompt;
      if (/startup|unlock it for this app session/i.test(p)) {
        return 'Startup: Global Agent Cache';
      }
      if (/dotfile/i.test(p)) {
        const match = p.match(/dotfiles (?:with|for) ([^:]+)/i);
        return match ? `Dotfiles Sync: ${match[1].trim()}` : 'Dotfiles Sync';
      }
      const sshMatch = p.match(/(?:connect via SSH to|connecting to)\s+([^:()]+)/i);
      if (sshMatch) {
        return `SSH: ${sshMatch[1].trim()}`;
      }
      const userHostMatch = p.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+)/);
      if (userHostMatch) {
        return `SSH: ${userHostMatch[1]}`;
      }
      const parenMatch = p.match(/\(([^()]+)\)/);
      if (parenMatch) {
        return parenMatch[1].trim();
      }
      return undefined;
    })();

  if (!raw) return null;
  if (/startup|global/i.test(raw)) {
    return { label: raw, icon: Layers };
  }
  if (/dotfile/i.test(raw)) {
    return { label: raw, icon: FolderSync };
  }
  if (/team vault/i.test(raw)) {
    return { label: raw, icon: Users };
  }
  return { label: raw, icon: Server };
}

function promptNeedsTouch(prompt: string): boolean {
  return /presence|touch/i.test(prompt);
}

function isPurePresencePrompt(prompt: string): boolean {
  return (
    (/confirm user presence|touch (your|the) (security key|authenticator|yubikey)/i.test(prompt) ||
      /^user presence/i.test(prompt)) &&
    !/pin|password|passphrase/i.test(prompt)
  );
}

const AWAITING_TOUCH_TIMEOUT_MS = 4000;

export const SmartcardPinModal: React.FC = () => {
  const [prompts, setPrompts] = useState<AskpassPromptItem[]>([]);
  const [pin, setPin] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [awaitingTouch, setAwaitingTouch] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const awaitingTouchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSubmittedSessionIdRef = useRef<string | undefined>(undefined);

  const currentPrompt = prompts[0] || null;

  const clearAwaitingTouchTimer = () => {
    if (awaitingTouchTimerRef.current) {
      clearTimeout(awaitingTouchTimerRef.current);
      awaitingTouchTimerRef.current = null;
    }
  };

  useEffect(() => clearAwaitingTouchTimer, []);

  useEffect(() => {
    if (!window.multissh?.onAskpassPrompt) return;

    const unsubscribe = window.multissh.onAskpassPrompt((event) => {
      setPrompts((prev) => [...prev, event]);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!window.multissh?.onPresenceClear) return;

    const unsubscribeClear = window.multissh.onPresenceClear(({ sessionId }) => {
      if (!sessionId || !lastSubmittedSessionIdRef.current || sessionId === lastSubmittedSessionIdRef.current) {
        clearAwaitingTouchTimer();
        setAwaitingTouch(false);
        lastSubmittedSessionIdRef.current = undefined;
      }
    });

    return () => {
      unsubscribeClear();
    };
  }, []);

  useEffect(() => {
    if (currentPrompt) {
      setPin('');
      setLocalError(null);
      if (!promptNeedsTouch(currentPrompt.prompt)) {
        clearAwaitingTouchTimer();
        setAwaitingTouch(false);
        lastSubmittedSessionIdRef.current = undefined;
      }
      setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
    }
  }, [currentPrompt]);

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!currentPrompt) return;

    const submittedPin = pin;
    const promptId = currentPrompt.id;
    const needsTouch = promptNeedsTouch(currentPrompt.prompt);
    const isPresencePrompt = isPurePresencePrompt(currentPrompt.prompt);

    // An empty PIN isn't a real attempt — ssh-add/the card would just read it as "cancelled" and
    // fail once, silently eating one of the 3 retries without the user ever seeing why. Catch it
    // here instead: nothing is sent, the prompt stays open, and the attempt budget is untouched.
    if (!isPresencePrompt && submittedPin.trim() === '') {
      setLocalError('Enter your PIN to continue.');
      return;
    }

    lastSubmittedSessionIdRef.current = currentPrompt.sessionId;

    setPrompts((prev) => prev.slice(1));
    setPin('');
    setLocalError(null);

    if (needsTouch) {
      clearAwaitingTouchTimer();
      setAwaitingTouch(true);
      awaitingTouchTimerRef.current = setTimeout(() => {
        setAwaitingTouch(false);
        lastSubmittedSessionIdRef.current = undefined;
      }, AWAITING_TOUCH_TIMEOUT_MS);
    }

    if (window.multissh?.submitAskpassPin) {
      try {
        await window.multissh.submitAskpassPin(promptId, submittedPin);
      } catch (err) {
        log.error('Failed to submit askpass PIN:', err);
      }
    }
  };

  const handleCancel = async () => {
    if (!currentPrompt) return;

    const promptId = currentPrompt.id;

    setPrompts((prev) => prev.slice(1));
    setPin('');
    clearAwaitingTouchTimer();
    setAwaitingTouch(false);
    lastSubmittedSessionIdRef.current = undefined;

    if (window.multissh?.submitAskpassPin) {
      try {
        await window.multissh.submitAskpassPin(promptId, '');
      } catch (err) {
        log.error('Failed to cancel askpass PIN:', err);
      }
    }
  };

  // M11 (code review): a window-level listener catches Escape even while
  // focus is elsewhere (e.g. a terminal, or before the focus() call above
  // has had its 50ms delay to run) — unlike relying only on the dialog's
  // own onKeyDown below, which needs focus already inside it. Enter (submit)
  // stays on the dialog's onKeyDown: it's only meaningful once the user is
  // actively typing in the focused PIN input anyway.
  useEscapeToClose(handleCancel, !!currentPrompt);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, !!currentPrompt);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    }
  };

  const awaitingTouchBanner = awaitingTouch && (
    <div
      role="status"
      aria-live="polite"
      data-testid="smartcard-awaiting-touch-banner"
      className="fixed bottom-6 left-1/2 z-[110] flex -translate-x-1/2 items-center gap-3 rounded-xl border border-sky-500/60 bg-app-card px-5 py-3 shadow-2xl ring-4 ring-sky-500/20 animate-in fade-in slide-in-from-bottom-2 duration-150"
    >
      <KeyRound className="h-6 w-6 shrink-0 animate-pulse text-sky-400" />
      <span className="text-base font-medium text-txt-primary">Touch your security key now to confirm...</span>
    </div>
  );

  if (!currentPrompt) {
    return awaitingTouchBanner || null;
  }

  const visuals = (currentPrompt.kind && KIND_VISUALS[currentPrompt.kind]) || DEFAULT_VISUALS;
  const contextInfo = resolvePromptContext(currentPrompt);

  return (
    <>
      {awaitingTouchBanner}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="smartcard-modal-title"
        data-testid="smartcard-pin-modal"
        onKeyDown={handleKeyDown}
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
                <div className="flex items-center gap-2 mb-1">
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded text-2xs font-semibold uppercase tracking-wider ${visuals.badgeClass}`}
                  >
                    {visuals.badge}
                  </span>
                </div>
                <h2 id="smartcard-modal-title" className="text-base font-semibold text-txt-primary truncate">
                  {visuals.title}
                </h2>
                <p className="text-xs text-txt-muted mt-0.5">
                  {isPurePresencePrompt(currentPrompt.prompt)
                    ? 'User presence confirmation required'
                    : visuals.subtitle}
                </p>
              </div>
            </div>

            {contextInfo && (
              <div className="mt-4 flex items-center gap-2.5 rounded-lg border border-border-subtle bg-app-surface/60 px-3 py-2 text-xs">
                <contextInfo.icon className="h-4 w-4 shrink-0 text-txt-muted" />
                <div className="min-w-0 flex-1">
                  <span className="text-txt-muted text-2xs uppercase tracking-wider block font-semibold leading-tight">
                    Target / Purpose
                  </span>
                  <span className="font-mono text-xs text-txt-primary font-medium break-all block">
                    {contextInfo.label}
                  </span>
                </div>
              </div>
            )}

            <div className="mt-4">
              <p className="text-xs font-normal text-txt-secondary break-words">
                {currentPrompt.prompt}
              </p>

              {isPurePresencePrompt(currentPrompt.prompt) ? (
                <div className="mt-3 flex items-center gap-2.5 rounded-lg border border-sky-500/40 bg-sky-500/10 px-3.5 py-2.5">
                  <KeyRound className="h-5 w-5 shrink-0 animate-pulse text-sky-400" />
                  <span className="text-xs font-medium text-sky-300">
                    Touch your security key now to confirm. No PIN is required.
                  </span>
                </div>
              ) : (
                <>
                  {promptNeedsTouch(currentPrompt.prompt) && (
                    <div className="mt-3 flex items-center gap-2.5 rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-2">
                      <KeyRound className="h-4 w-4 shrink-0 animate-pulse text-sky-400" />
                      <span className="text-xs font-medium text-sky-300">
                        Touch your security key after submitting to confirm this signature.
                      </span>
                    </div>
                  )}

                  <form onSubmit={handleSubmit} className="mt-4">
                    {(localError || currentPrompt.error) && (
                      <div
                        role="alert"
                        data-testid="smartcard-pin-error"
                        className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 p-2.5 text-xs text-red-300"
                      >
                        {localError || currentPrompt.error}
                        {!localError && currentPrompt.attempt && currentPrompt.maxAttempts && (
                          <span className="text-red-300/70">
                            {' '}
                            (attempt {currentPrompt.attempt} of {currentPrompt.maxAttempts})
                          </span>
                        )}
                      </div>
                    )}
                    <div className="relative">
                      <input
                        ref={inputRef}
                        type="password"
                        value={pin}
                        onChange={(e) => {
                          setPin(e.target.value);
                          if (localError) setLocalError(null);
                        }}
                        placeholder={visuals.inputPlaceholder}
                        data-testid="smartcard-pin-input"
                        data-autofocus
                        autoComplete="off"
                        className={`w-full rounded-lg border border-border-subtle bg-app-input px-3.5 py-2 text-sm text-txt-primary placeholder-txt-muted ${visuals.focusBorderClass} focus:outline-none`}
                      />
                    </div>

                    <div className="mt-6 flex items-center justify-end gap-3">
                      <button
                        type="button"
                        onClick={handleCancel}
                        data-testid="smartcard-pin-cancel"
                        className="rounded-lg border border-border-subtle px-3.5 py-1.5 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        data-testid="smartcard-pin-submit"
                        className={`rounded-lg ${visuals.submitBtnClass} px-4 py-1.5 text-xs font-medium shadow-sm transition-colors`}
                      >
                        Submit
                      </button>
                    </div>
                  </form>
                </>
              )}

              {isPurePresencePrompt(currentPrompt.prompt) && (
                <div className="mt-6 flex items-center justify-end gap-3">
                  <button
                    type="button"
                    onClick={handleCancel}
                    data-testid="smartcard-pin-cancel"
                    className="rounded-lg border border-border-subtle px-3.5 py-1.5 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleSubmit()}
                    data-testid="smartcard-pin-submit"
                    className={`rounded-lg ${visuals.submitBtnClass} px-4 py-1.5 text-xs font-medium shadow-sm transition-colors`}
                  >
                    Confirm
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
};

export default SmartcardPinModal;
