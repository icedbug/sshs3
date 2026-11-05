import React, { useCallback, useEffect, useState, useRef } from 'react';
import { History, X, Loader2, RotateCcw, Trash2 } from 'lucide-react';
import type { ObjectVersionEntry, S3VersioningStatus } from '@shared/types/storage';
import { useModalDismiss } from '../../lib/useModalDismiss';
import { useDialogFocus } from '../../lib/useDialogFocus';
import { useConfirm } from '../ConfirmDialog';
import { describeIpcError } from '../../lib/format';

interface VersionsModalProps {
  open: boolean;
  providerId: string;
  mode: 'bucket' | 'object';
  targetPath: string;
  targetName: string;
  onClose: () => void;
  onSaved?: () => void;
}

export const VersionsModal: React.FC<VersionsModalProps> = ({
  open,
  providerId,
  mode,
  targetPath,
  targetName,
  onClose,
  onSaved,
}) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();

  const [status, setStatus] = useState<S3VersioningStatus>('Disabled');
  const [versions, setVersions] = useState<ObjectVersionEntry[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (mode === 'bucket') {
        const info = await window.multissh.storageGetBucketVersioning(providerId, targetPath);
        setStatus(info.status);
      } else {
        const list = await window.multissh.storageListObjectVersions(providerId, targetPath);
        setVersions(list);
      }
    } catch (err) {
      setError(describeIpcError(err, 'Failed to retrieve version information'));
    } finally {
      setLoading(false);
    }
  }, [mode, providerId, targetPath]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  const handleBackdropClick = useModalDismiss(onClose, open, !busy);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, open);

  if (!open) return null;

  const handleToggleVersioning = async () => {
    setBusy(true);
    setError(null);
    try {
      await window.multissh.storageSetBucketVersioning(providerId, targetPath, status !== 'Enabled');
      onSaved?.();
      await load();
    } catch (err) {
      setError(describeIpcError(err, 'Failed to change versioning status'));
    } finally {
      setBusy(false);
    }
  };

  const handleRestore = async (versionId: string) => {
    if (
      !(await confirm({
        title: 'Restore version',
        message: 'Restore this version as the current version of the object?',
        confirmLabel: 'Restore',
        danger: false,
      }))
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await window.multissh.storageRestoreObjectVersion(providerId, targetPath, versionId);
      onSaved?.();
      await load();
    } catch (err) {
      setError(describeIpcError(err, 'Failed to restore version'));
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteVersion = async (versionId: string) => {
    if (
      !(await confirm({
        title: 'Delete version',
        message: 'Permanently delete this specific version? This action cannot be undone.',
        confirmLabel: 'Delete permanently',
      }))
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await window.multissh.storageDeleteObjectVersion(providerId, targetPath, versionId);
      onSaved?.();
      await load();
    } catch (err) {
      setError(describeIpcError(err, 'Failed to delete version'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 animate-in fade-in duration-150 p-4"
      onClick={handleBackdropClick}
    >
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Object versions" className="flex w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border-subtle bg-app-card shadow-2xl">
        <div className="flex items-center justify-between border-b border-divider bg-app-surface px-4 py-3">
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-sky-400" />
            <h2 className="text-sm font-semibold text-txt-primary">
              {mode === 'bucket' ? 'Bucket Versioning' : 'Object Versions'} — {targetName}
            </h2>
          </div>
          <button aria-label="Close" title="Close" type="button" onClick={onClose} className="rounded-lg p-1 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4 text-xs text-txt-secondary">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-6 text-txt-muted">
              <Loader2 className="h-4 w-4 animate-spin text-sky-400" />
              Loading versions...
            </div>
          )}
          {error && (
            <div role="alert" className="mb-3 rounded-lg border border-red-800/80 bg-red-950/40 p-2.5 text-xs text-red-300">{error}</div>
          )}

          {!loading && mode === 'bucket' && (
            <div className="space-y-3">
              <div className="rounded-lg border border-border-subtle bg-app-surface p-3">
                <div className="text-xs uppercase tracking-wider text-txt-muted font-semibold">Current Status</div>
                <div className="mt-1 text-sm font-medium text-txt-primary">
                  {status === 'Enabled' ? 'Enabled' : status === 'Suspended' ? 'Suspended' : 'Disabled'}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void handleToggleVersioning()}
                disabled={busy}
                className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50 shadow-sm transition-colors"
              >
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {status === 'Enabled' ? 'Suspend Versioning' : 'Enable Versioning'}
              </button>
              <p className="text-txt-muted leading-relaxed">
                When versioning is enabled, all prior versions of objects in this bucket are preserved and can be
                restored or deleted individually via the object context menu.
              </p>
            </div>
          )}

          {!loading && mode === 'object' && (
            <div className="max-h-96 overflow-y-auto rounded-lg border border-border-subtle bg-app-surface">
              {versions.length === 0 && (
                <div className="p-6 text-center text-txt-muted">No versions found (versioning might not be enabled on this bucket)</div>
              )}
              {versions.length > 0 && (
                <table className="w-full text-left">
                  <thead className="sticky top-0 bg-app-surface-subtle text-xs uppercase tracking-wider text-txt-muted border-b border-divider">
                    <tr>
                      <th className="px-3 py-2 font-semibold">Version</th>
                      <th className="px-3 py-2 font-semibold">Modified</th>
                      <th className="px-3 py-2 font-semibold">Size</th>
                      <th className="px-3 py-2 font-semibold">Status</th>
                      <th className="px-3 py-2 font-semibold text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-divider">
                    {versions.map((v) => (
                      <tr key={v.versionId} className={v.isDeleteMarker ? 'text-txt-muted' : 'text-txt-primary'}>
                        <td className="max-w-[140px] truncate px-3 py-2 font-mono text-xs">{v.versionId || '(null)'}</td>
                        <td className="px-3 py-2 text-xs">{v.lastModified ?? '-'}</td>
                        <td className="px-3 py-2 text-xs">{v.isDeleteMarker ? '-' : `${v.size} B`}</td>
                        <td className="px-3 py-2 text-xs">
                          {v.isDeleteMarker ? 'Delete Marker' : v.isLatest ? 'Current' : 'Historical'}
                        </td>
                        <td className="px-3 py-2 text-xs">
                          <div className="flex items-center justify-end gap-1.5">
                            {!v.isDeleteMarker && !v.isLatest && (
                              <button
                                aria-label="Restore as current version"
                                type="button"
                                title="Restore as current version"
                                disabled={busy}
                                onClick={() => void handleRestore(v.versionId)}
                                className="rounded p-1 text-sky-400 hover:bg-app-surface-hover disabled:opacity-40"
                              >
                                <RotateCcw className="h-3.5 w-3.5" />
                              </button>
                            )}
                            <button
                              aria-label="Permanently delete this version"
                              type="button"
                              title="Permanently delete this version"
                              disabled={busy}
                              onClick={() => void handleDeleteVersion(v.versionId)}
                              className="rounded p-1 text-red-400 hover:bg-app-surface-hover disabled:opacity-40"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-divider bg-app-surface px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border-subtle px-3.5 py-1.5 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default VersionsModal;
