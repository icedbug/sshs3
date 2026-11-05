import React from 'react';
import { Files } from 'lucide-react';
import { sftpUnavailableReason } from '../lib/platform';

interface SftpButtonProps {
  authType: string | undefined;
  onOpen: () => void;
  /** Nothing to open yet (e.g. an empty quick-connect box); greyed out like the Connect button next to it. */
  disabled?: boolean;
}

/**
 * The "SFTP" quick-action shown next to an SSH profile. For profiles that can't use SFTP (see
 * sftpUnavailableReason) it stays visible but is greyed out and explains why on hover, so the
 * limitation is discoverable instead of the button silently failing after a PIN/touch prompt.
 */
export const SftpButton: React.FC<SftpButtonProps> = ({ authType, onOpen, disabled = false }) => {
  const unavailableReason = sftpUnavailableReason(authType);
  return (
    <button
      type="button"
      title={unavailableReason ?? 'Open SFTP in Dual-Pane File Manager'}
      aria-disabled={unavailableReason ? true : undefined}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        if (!unavailableReason) onOpen();
      }}
      className={
        'flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium shadow-sm transition-colors ' +
        (unavailableReason
          ? 'cursor-not-allowed bg-app-surface text-txt-muted opacity-50'
          : 'bg-sky-700 text-white hover:bg-sky-600 disabled:opacity-40 disabled:hover:bg-sky-700')
      }
    >
      <Files className="h-3 w-3" />
      SFTP
    </button>
  );
};
