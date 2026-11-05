import React, { useEffect, useState, useRef } from 'react';
import { CloudDownload, X, Loader2, CheckCircle2, ShieldAlert } from 'lucide-react';
import type { KnownHostsConflict } from '@shared/types/sync';
import { SyncTargetForm, emptySyncTargetDraft, buildSyncTarget, validateSyncTargetDraft, type SyncTargetDraft } from './SyncTargetForm';
import { MasterPasswordDialog } from './MasterPasswordDialog';
import { formatSyncError } from '../../lib/syncErrors';
import { useModalDismiss } from '../../lib/useModalDismiss';
import { useDialogFocus } from '../../lib/useDialogFocus';

interface SyncBootstrapModalProps {
  open: boolean;
  onClose: () => void;
  /** Called after a successful pull, so the caller can refresh whatever it shows (profile list, tabs, etc.). */
  onComplete?: () => void;
}

export const SyncBootstrapModal: React.FC<SyncBootstrapModalProps> = ({ open, onClose, onComplete }) => {
  const [draft, setDraft] = useState<SyncTargetDraft>(emptySyncTargetDraft());
  const [targetError, setTargetError] = useState<string | null>(null);
  const [settingUpTarget, setSettingUpTarget] = useState(false);

  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [pullError, setPullError] = useState<string | null>(null);
  const [result, setResult] = useState<{ changedCategories: string[]; conflicts: KnownHostsConflict[] } | null>(null);

  useEffect(() => {
    if (open) {
      setDraft(emptySyncTargetDraft());
      setTargetError(null);
      setPasswordDialogOpen(false);
      setPullError(null);
      setResult(null);
    }
  }, [open]);

  // Escape closes; a stray backdrop click would discard typed input, so it is intentionally ignored.
  useModalDismiss(onClose, open);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, open);
  if (!open) return null;

  const handleContinue = async () => {
    const validationError = validateSyncTargetDraft(draft);
    if (validationError) {
      setTargetError(validationError);
      return;
    }
    setTargetError(null);
    setSettingUpTarget(true);
    try {
      await window.multissh?.profileSyncSetup?.({ target: buildSyncTarget(draft), remoteBasePath: draft.remoteBasePath });
      setPasswordDialogOpen(true);
    } catch (err: any) {
      setTargetError(formatSyncError(err, 'Failed to save the sync target.').message);
    } finally {
      setSettingUpTarget(false);
    }
  };

  const handlePasswordSubmit = async (passwords: { topologyPassword: string; credentialsPassword: string }) => {
    setPulling(true);
    setPullError(null);
    try {
      const pullResult = await window.multissh?.profileSyncPull?.({
        topologyPassword: passwords.topologyPassword,
        credentialsPassword: passwords.credentialsPassword,
      });
      setResult({ changedCategories: pullResult.changedCategories, conflicts: pullResult.sshNativeConflicts });
      setPasswordDialogOpen(false);
      onComplete?.();
    } catch (err: any) {
      setPullError(formatSyncError(err, 'Failed to import from the cloud. Check your passwords and try again.').message);
    } finally {
      setPulling(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Import profile from the cloud" className="flex w-full max-w-md flex-col rounded-xl border border-border-subtle bg-app-card shadow-2xl overflow-hidden">
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-divider bg-app-surface px-5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-sky-500/10 text-sky-400">
              <CloudDownload className="h-4 w-4" />
            </div>
            <h2 className="text-sm font-semibold text-txt-primary">Import profile from the cloud</h2>
          </div>
          <button
            aria-label="Close"
            title="Close"
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 p-5 text-xs text-txt-secondary max-h-[70vh] overflow-y-auto">
          {result ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-emerald-400">
                <CheckCircle2 className="h-5 w-5" />
                <span className="font-medium">Import complete</span>
              </div>
              <p className="text-xs text-txt-muted leading-relaxed">
                {result.changedCategories.length > 0
                  ? `Imported: ${result.changedCategories.join(', ')}.`
                  : 'Nothing new to import — this machine already matched the remote.'}
              </p>
              {result.conflicts.length > 0 && (
                <div className="space-y-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5">
                  <div className="flex items-center gap-1.5 text-amber-300 font-medium text-xs">
                    <ShieldAlert className="h-3.5 w-3.5" />
                    {result.conflicts.length} known_hosts conflict{result.conflicts.length > 1 ? 's' : ''} — review manually
                  </div>
                  <p className="text-2xs text-amber-200/80 leading-relaxed">
                    Open Settings → Synchronization for details on each conflicting host key.
                  </p>
                </div>
              )}
              <button
                type="button"
                onClick={onClose}
                className="w-full rounded-lg bg-sky-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-sky-500 shadow-sm transition-colors"
              >
                Done
              </button>
            </div>
          ) : (
            <>
              <p className="text-xs text-txt-muted leading-relaxed">
                Point this machine at the same S3 bucket or SFTP server another machine already syncs to, then
                enter the master password it was set up with to pull down your profiles, dotfile pools, and
                settings.
              </p>
              <SyncTargetForm draft={draft} onChange={setDraft} disabled={settingUpTarget} />
              {targetError && <p role="alert" className="text-xs text-red-400">{targetError}</p>}
              <button
                type="button"
                onClick={handleContinue}
                disabled={settingUpTarget}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-sky-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-sky-500 shadow-sm transition-colors disabled:opacity-50"
              >
                {settingUpTarget && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Continue
              </button>
            </>
          )}
        </div>
      </div>

      <MasterPasswordDialog
        open={passwordDialogOpen}
        mode="unlock"
        title="Enter master passwords"
        description="Enter the same master password used when this sync target was first set up."
        submitLabel="Import"
        submitting={pulling}
        error={pullError}
        onCancel={() => setPasswordDialogOpen(false)}
        onSubmit={handlePasswordSubmit}
      />
    </div>
  );
};

export default SyncBootstrapModal;
