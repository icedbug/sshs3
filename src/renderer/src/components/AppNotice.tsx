import React, { useEffect } from 'react';
import { X } from 'lucide-react';

/** How long a notice stays before it goes away by itself. */
export const APP_NOTICE_TIMEOUT_MS = 15000;

interface AppNoticeProps {
  message: string | null;
  onDismiss: () => void;
}

/**
 * A short message for something that happened where no dialog is open to show it (tunnels that
 * failed to start after "Connect all", for example). Announced politely, dismissed with its button
 * or by itself after a while.
 */
export const AppNotice: React.FC<AppNoticeProps> = ({ message, onDismiss }) => {
  useEffect(() => {
    if (!message) return undefined;
    const timer = setTimeout(onDismiss, APP_NOTICE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [message, onDismiss]);

  if (!message) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 left-1/2 z-50 flex max-w-lg -translate-x-1/2 items-start gap-3 rounded-lg border border-amber-700/60 bg-app-surface px-4 py-3 text-xs text-txt-primary shadow-2xl"
    >
      <span className="min-w-0 flex-1">{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 rounded p-0.5 text-txt-muted hover:text-txt-primary"
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
};
