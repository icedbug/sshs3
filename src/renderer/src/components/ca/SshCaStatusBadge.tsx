import React, { useState, useRef, useEffect } from 'react';
import { ShieldCheck, Shield, Loader2, RefreshCw, LogOut, KeyRound, AlertCircle } from 'lucide-react';
import { useSshCa } from '../../lib/useSshCa';
import { formatDateTime } from '../../lib/dateFormat';
import {
  calculateRemainingSeconds,
  formatRemainingTime,
  getRemainingTimeColorClass,
} from '../../lib/sshCaTime';

interface SshCaStatusBadgeProps {
  onOpenSettings?: () => void;
}

export const SshCaStatusBadge: React.FC<SshCaStatusBadgeProps> = ({ onOpenSettings }) => {
  const { status, loading, error, login, logout, renew, refreshStatus } = useSshCa();
  const [isOpen, setIsOpen] = useState(false);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Keep countdown updated: 1-second interval when popup is open, 30-second interval when closed
  useEffect(() => {
    if (!status.active || !status.expiresAt) return;

    setNowMs(Date.now());
    const intervalMs = isOpen ? 1000 : 30_000;
    const interval = setInterval(() => {
      const now = Date.now();
      setNowMs(now);

      const rem = calculateRemainingSeconds(status.expiresAt, status.validSecondsRemaining, now);
      if (rem <= 0) {
        void refreshStatus();
      }
    }, intervalMs);

    return () => clearInterval(interval);
  }, [status.active, status.expiresAt, status.validSecondsRemaining, isOpen, refreshStatus]);

  // Close menu on click outside or Escape
  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (e: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
        buttonRef.current?.focus();
      }
    };

    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const remainingSeconds = calculateRemainingSeconds(
    status.expiresAt,
    status.validSecondsRemaining,
    nowMs
  );

  const handleToggle = () => {
    setIsOpen((prev) => {
      const next = !prev;
      if (next) {
        setNowMs(Date.now());
        void refreshStatus();
      }
      return next;
    });
  };

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        data-testid="ssh-ca-status-btn"
        aria-label="SSH Certificate Authority"
        aria-haspopup="true"
        aria-expanded={isOpen}
        title={
          status.active
            ? `SSH CA: Active (${status.username}) — ${formatRemainingTime(remainingSeconds)}`
            : 'SSH CA: Inactive (Click to log in)'
        }
        onClick={handleToggle}
        className={`flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-app-surface-hover ${
          status.active
            ? 'text-emerald-400 hover:text-emerald-300'
            : 'text-txt-muted hover:text-txt-primary'
        }`}
      >
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin text-sky-400" />
        ) : status.active ? (
          <ShieldCheck className="h-4 w-4" />
        ) : (
          <Shield className="h-4 w-4" />
        )}
      </button>

      {isOpen && (
        <div
          ref={menuRef}
          role="dialog"
          aria-label="SSH CA Status"
          className="absolute right-0 top-8 z-50 w-72 rounded-xl border border-border-subtle bg-app-card p-2.5 shadow-2xl text-xs text-txt-primary animate-in fade-in zoom-in-95 duration-100"
        >
          <div className="flex items-center justify-between border-b border-divider pb-2 mb-2">
            <div className="flex items-center gap-1.5 font-semibold text-txt-primary">
              {status.active ? (
                <ShieldCheck className="h-4 w-4 text-emerald-400" />
              ) : (
                <Shield className="h-4 w-4 text-txt-muted" />
              )}
              <span>SSH Certificate Authority</span>
            </div>
            <span
              className={`rounded-md px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wider ${
                status.active
                  ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                  : 'bg-app-surface text-txt-muted border border-border-subtle'
              }`}
            >
              {status.active ? 'Active' : 'Inactive'}
            </span>
          </div>

          {error && (
            <div role="alert" className="mb-2 flex items-start gap-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 p-2 text-rose-300 text-2xs">
              <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {status.active && status.certInfo ? (
            <dl className="mb-2.5 space-y-1.5 rounded-lg border border-border-subtle/60 bg-app-surface/60 p-2 text-2xs">
              <div className="flex justify-between items-baseline gap-2">
                <dt className="text-txt-muted shrink-0">User:</dt>
                <dd className="font-medium text-txt-primary truncate select-text">{status.username}</dd>
              </div>
              <div className="flex justify-between items-baseline gap-2">
                <dt className="text-txt-muted shrink-0">Principals:</dt>
                <dd className="font-medium text-txt-primary truncate max-w-[170px] select-text" title={status.principals?.join(', ')}>
                  {status.principals?.join(', ') || '—'}
                </dd>
              </div>
              <div className="flex justify-between items-baseline gap-2">
                <dt className="text-txt-muted shrink-0">Valid Until:</dt>
                <dd className="font-medium text-txt-primary select-text">{formatDateTime(status.expiresAt)}</dd>
              </div>
              <div className="flex justify-between items-baseline gap-2">
                <dt className="text-txt-muted shrink-0">Time Left:</dt>
                <dd className={`font-medium select-text ${getRemainingTimeColorClass(remainingSeconds)}`}>
                  {formatRemainingTime(remainingSeconds)}
                </dd>
              </div>
              <div className="flex justify-between items-baseline gap-2">
                <dt className="text-txt-muted shrink-0">Serial:</dt>
                <dd className="font-mono text-txt-muted truncate max-w-[170px] select-text" title={status.certInfo.serial}>
                  {status.certInfo.serial}
                </dd>
              </div>
            </dl>
          ) : (
            <div className="mb-2.5 rounded-lg border border-border-subtle/50 bg-app-surface/40 p-2 text-2xs text-txt-muted">
              No active SSH CA certificate. Log in with your identity provider to acquire an ephemeral certificate for SSH authentication.
            </div>
          )}

          <div className="flex flex-col gap-1.5 pt-1 border-t border-divider">
            {status.active ? (
              <>
                <button
                  type="button"
                  disabled={loading}
                  onClick={async () => {
                    try {
                      await renew();
                    } catch {
                      // Handled by hook error state
                    }
                  }}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-border-subtle bg-app-surface px-2.5 py-1.5 text-xs font-medium text-txt-primary hover:bg-app-surface-hover hover:border-border-strong transition-colors disabled:opacity-50"
                >
                  {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  Renew Certificate
                </button>
                <button
                  type="button"
                  disabled={loading}
                  onClick={async () => {
                    try {
                      await logout();
                      setIsOpen(false);
                    } catch {
                      // Handled by hook error state
                    }
                  }}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-xs font-medium text-rose-300 hover:bg-rose-500/20 transition-colors disabled:opacity-50"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  Log Out
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  disabled={loading}
                  onClick={async () => {
                    try {
                      await login();
                    } catch {
                      // Handled by hook error state
                    }
                  }}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1.5 text-xs font-medium text-emerald-300 hover:bg-emerald-500/20 transition-colors disabled:opacity-50"
                >
                  {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
                  Log In with SSH CA
                </button>
                {onOpenSettings && (
                  <button
                    type="button"
                    onClick={() => {
                      setIsOpen(false);
                      onOpenSettings();
                    }}
                    className="flex w-full items-center justify-center gap-1 text-2xs text-txt-muted hover:text-txt-primary transition-colors py-1"
                  >
                    Configure in Settings
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
