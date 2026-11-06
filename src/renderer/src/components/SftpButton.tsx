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
        'flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] font-mono transition-colors ' +
        (unavailableReason
          ? 'cursor-not-allowed border-white/5 bg-white/[0.02] text-neutral-600 opacity-50'
          : 'border-white/15 bg-white/[0.04] text-neutral-300 hover:border-white/30 hover:bg-white/[0.09] hover:text-white disabled:opacity-40')
      }
    >
      <Files className="h-3 w-3" />
      SFTP
    </button>
  );
};
