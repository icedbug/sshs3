import React, { useEffect, useState, useRef } from 'react';
import { Info, Loader2, X } from 'lucide-react';
import type { FileEntry } from '@shared/types/storage';
import { formatBytes, describeIpcError } from '../../lib/format';
import { useModalDismiss } from '../../lib/useModalDismiss';
import { useDialogFocus } from '../../lib/useDialogFocus';
import type { SourceType } from './types';
import { Button } from '../ui/Button';

interface PropertiesModalProps {
  open: boolean;
  providerId: string;
  sourceType: SourceType;
  entries: FileEntry[];
  onClose: () => void;
  onSaved?: () => void;
}

interface Row {
  label: string;
  value: string;
}

export const PropertiesModal: React.FC<PropertiesModalProps> = ({
  open,
  providerId,
  sourceType,
  entries,
  onClose,
  onSaved,
}) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<FileEntry | null>(null);
  const [contentType, setContentType] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDetail(null);
    setError(null);
    if (entries.length === 1) {
      setLoading(true);
      window.multissh
        .storageStat(providerId, entries[0].path)
        .then((entry) => {
          setDetail(entry);
          setContentType(entry.mimeType ?? '');
        })
        .catch((err) => setError(describeIpcError(err, 'Failed to retrieve file details')))
        .finally(() => setLoading(false));
    }
  }, [open, providerId, entries]);

  const handleBackdropClick = useModalDismiss(onClose, open, !saving);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, open);

  if (!open) return null;

  const single = entries.length === 1 ? (detail ?? entries[0]) : null;
  const totalSize = entries.reduce((sum, e) => sum + (e.isDirectory ? 0 : e.size), 0);
  const fileCount = entries.filter((e) => !e.isDirectory).length;
  const dirCount = entries.filter((e) => e.isDirectory).length;
  const canEditContentType = sourceType === 's3' && single !== null && !single.isDirectory;

  const rows: Row[] = single
    ? [
        { label: 'Name', value: single.name },
        { label: 'Path', value: single.path },
        { label: 'Type', value: single.isDirectory ? 'Folder' : 'File' },
        { label: 'Size', value: single.isDirectory ? '-' : `${formatBytes(single.size)} (${single.size} bytes)` },
        { label: 'Permissions', value: single.permissions ?? '-' },
        { label: 'Last Modified', value: single.mtime ?? '-' },
      ]
    : [
        { label: 'Total Items', value: `${entries.length} (${fileCount} files, ${dirCount} folders)` },
        { label: 'Total Size', value: `${formatBytes(totalSize)} (${totalSize} bytes)` },
      ];

  const handleSaveContentType = async () => {
    if (!single) return;
    setSaving(true);
    setError(null);
    try {
      await window.multissh.storageSetMetadata(providerId, single.path, { contentType: contentType.trim() });
      onSaved?.();
      onClose();
    } catch (err) {
      setError(describeIpcError(err, 'Failed to update metadata'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 animate-in fade-in duration-150 p-4"
      onClick={handleBackdropClick}
    >
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Properties" className="w-full max-w-md rounded-xl border border-border-subtle bg-app-card shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between border-b border-divider bg-app-surface px-4 py-3">
          <div className="flex items-center gap-2">
            <Info className="h-4 w-4 text-sky-400" />
            <h2 className="text-sm font-semibold text-txt-primary">Properties</h2>
          </div>
          <button aria-label="Close" title="Close" type="button" onClick={onClose} className="rounded-lg p-1 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4 text-xs text-txt-secondary">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-6 text-txt-muted">
              <Loader2 className="h-4 w-4 animate-spin text-sky-400" />
              Loading details...
            </div>
          )}
          {error && (
            <div role="alert" className="mb-3 rounded-lg border border-red-800/80 bg-red-950/40 p-2.5 text-xs text-red-300">{error}</div>
          )}
          {!loading && (
            <dl className="divide-y divide-divider rounded-lg border border-border-subtle bg-app-surface">
              {rows.map((row) => (
                <div key={row.label} className="flex items-start gap-3 px-3 py-2">
                  <dt className="w-28 shrink-0 text-xs font-semibold uppercase tracking-wider text-txt-muted">{row.label}</dt>
                  <dd className="min-w-0 flex-1 break-all font-mono text-xs text-txt-primary">{row.value}</dd>
                </div>
              ))}
              {canEditContentType && (
                <div className="flex items-center gap-3 px-3 py-2">
                  <dt className="w-28 shrink-0 text-xs font-semibold uppercase tracking-wider text-txt-muted">Content-Type</dt>
                  <dd className="min-w-0 flex-1">
                    <input
                      aria-label="Content-Type"
                      type="text"
                      value={contentType}
                      onChange={(e) => setContentType(e.target.value)}
                      placeholder="application/octet-stream"
                      className="w-full rounded-md border border-border-subtle bg-app-input px-2 py-1 font-mono text-xs text-txt-primary outline-none focus:border-sky-500"
                    />
                  </dd>
                </div>
              )}
            </dl>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-divider bg-app-surface px-4 py-3">
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
            Close
          </Button>
          {canEditContentType && (
            <Button
              type="button"
              variant="primary"
              onClick={() => void handleSaveContentType()}
              disabled={saving || contentType.trim() === (single?.mimeType ?? '')}
            >
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Save
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};

export default PropertiesModal;
