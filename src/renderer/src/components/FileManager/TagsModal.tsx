import React, { useEffect, useState, useRef } from 'react';
import { Tag as TagIcon, X, Loader2, Plus, Trash2 } from 'lucide-react';
import type { S3Tag } from '@shared/types/storage';
import { useModalDismiss } from '../../lib/useModalDismiss';
import { useDialogFocus } from '../../lib/useDialogFocus';
import { describeIpcError } from '../../lib/format';
import { Button } from '../ui/Button';

interface TagsModalProps {
  open: boolean;
  providerId: string;
  targetPath: string;
  targetName: string;
  onClose: () => void;
  onSaved?: () => void;
}

export const TagsModal: React.FC<TagsModalProps> = ({
  open,
  providerId,
  targetPath,
  targetName,
  onClose,
  onSaved,
}) => {
  const [tags, setTags] = useState<S3Tag[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setLoading(true);
    window.multissh
      .storageGetTags(providerId, targetPath)
      .then(setTags)
      .catch((err) => setError(describeIpcError(err, 'Failed to retrieve tags')))
      .finally(() => setLoading(false));
  }, [open, providerId, targetPath]);

  const handleBackdropClick = useModalDismiss(onClose, open, !saving);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, open);

  if (!open) return null;

  const handleAdd = () => setTags((prev) => [...prev, { key: '', value: '' }]);
  const handleRemove = (idx: number) => setTags((prev) => prev.filter((_, i) => i !== idx));
  const handleChange = (idx: number, field: 'key' | 'value', value: string) =>
    setTags((prev) => prev.map((t, i) => (i === idx ? { ...t, [field]: value } : t)));

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const cleaned = tags
        .map((t) => ({ key: t.key.trim(), value: t.value.trim() }))
        .filter((t) => t.key.length > 0);
      await window.multissh.storageSetTags(providerId, targetPath, cleaned);
      onSaved?.();
      onClose();
    } catch (err) {
      setError(describeIpcError(err, 'Failed to save tags'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 animate-in fade-in duration-150 p-4"
      onClick={handleBackdropClick}
    >
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Tags" className="w-full max-w-lg rounded-xl border border-border-subtle bg-app-card shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between border-b border-divider bg-app-surface px-4 py-3">
          <div className="flex items-center gap-2">
            <TagIcon className="h-4 w-4 text-sky-400" />
            <h2 className="text-sm font-semibold text-txt-primary">Tags</h2>
          </div>
          <button aria-label="Close" title="Close" type="button" onClick={onClose} className="rounded-lg p-1 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4 space-y-3 text-xs text-txt-secondary">
          <div className="rounded-lg border border-border-subtle bg-app-surface p-2.5">
            <div className="text-xs text-txt-muted uppercase tracking-wider font-semibold">Target</div>
            <div className="mt-1 font-mono text-xs text-txt-primary truncate">{targetName}</div>
          </div>

          {loading && (
            <div className="flex items-center justify-center gap-2 py-6 text-txt-muted">
              <Loader2 className="h-4 w-4 animate-spin text-sky-400" />
              Loading tags...
            </div>
          )}

          {error && (
            <div role="alert" className="rounded-lg border border-red-800/80 bg-red-950/40 p-2.5 text-xs text-red-300">{error}</div>
          )}

          {!loading && (
            <div className="space-y-2">
              {tags.length === 0 && (
                <div className="rounded-lg border border-dashed border-border-subtle p-3 text-center text-txt-muted">
                  No tags configured
                </div>
              )}
              {tags.map((tag, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <input
                    aria-label="Tag key"
                    type="text"
                    placeholder="Key"
                    value={tag.key}
                    onChange={(e) => handleChange(idx, 'key', e.target.value)}
                    className="w-1/2 rounded-md border border-border-subtle bg-app-input px-2.5 py-1.5 font-mono text-xs text-txt-primary outline-none focus:border-sky-500"
                  />
                  <input
                    aria-label="Tag value"
                    type="text"
                    placeholder="Value"
                    value={tag.value}
                    onChange={(e) => handleChange(idx, 'value', e.target.value)}
                    className="w-1/2 rounded-md border border-border-subtle bg-app-input px-2.5 py-1.5 font-mono text-xs text-txt-primary outline-none focus:border-sky-500"
                  />
                  <button
                    aria-label="Remove"
                    title="Remove"
                    type="button"
                    onClick={() => handleRemove(idx)}
                    className="shrink-0 rounded p-1.5 text-red-400 hover:bg-app-surface-hover transition-colors"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              <Button type="button" variant="secondary" onClick={handleAdd} className="px-3">
                <Plus className="h-3.5 w-3.5" />
                Add Tag
              </Button>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-divider bg-app-surface px-4 py-3">
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" variant="primary" onClick={() => void handleSave()} disabled={saving || loading}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save
          </Button>
        </div>
      </div>
    </div>
  );
};

export default TagsModal;
