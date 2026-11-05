import React from 'react';
import { Globe, Loader2 } from 'lucide-react';

interface OpenShiftWebLoginSectionProps {
  waiting: boolean;
  onCancel: () => void;
}

/** Explains the browser sign-in and shows its pending state; the modal renders it only in browser mode. */
export const OpenShiftWebLoginSection: React.FC<OpenShiftWebLoginSectionProps> = ({ waiting, onCancel }) => (
  <div
    data-testid="openshift-web-login"
    className="rounded-xl border border-border-subtle bg-app-surface p-3.5 space-y-2"
  >
    <div className="flex items-center gap-1.5 text-xs font-medium text-txt-primary">
      <Globe className="h-3.5 w-3.5 text-red-400" />
      <span>Sign in with your browser</span>
    </div>
    {waiting ? (
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs text-txt-muted" role="status">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>Waiting for browser sign-in… Finish logging in, then return here.</span>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-3 py-1.5 text-xs text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
        >
          Cancel
        </button>
      </div>
    ) : (
      <p className="text-xs text-txt-muted">
        Uses your cluster&apos;s own login page (OpenShift 4.13 or newer), so there is no token to copy. Fill in the
        server and press Enter.
      </p>
    )}
  </div>
);
