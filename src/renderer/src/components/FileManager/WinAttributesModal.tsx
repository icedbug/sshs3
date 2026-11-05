import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Shield, X, Loader2 } from 'lucide-react';
import type { FileEntry, WinAttributes } from '@shared/types/storage';
import { useModalDismiss } from '../../lib/useModalDismiss';
import { useDialogFocus } from '../../lib/useDialogFocus';
import { describeIpcError } from '../../lib/format';
import { Button } from '../ui/Button';

interface WinAttributesModalProps {
  open: boolean;
  providerId: string;
  entries: FileEntry[];
  onClose: () => void;
  onSaved: () => void;
}

type AttrKey = keyof WinAttributes;

/** Checkbox state: `null` means the selected items differ, so it is left alone unless the user ticks it. */
type AttrState = Record<AttrKey, boolean | null>;

const ATTRIBUTES: Array<{ key: AttrKey; label: string; hint: string }> = [
  { key: 'readOnly', label: 'Read-only', hint: 'The file cannot be changed or deleted by most programs.' },
  { key: 'hidden', label: 'Hidden', hint: 'Not shown in Explorer unless hidden items are enabled.' },
  { key: 'system', label: 'System', hint: 'Marks an operating-system file; also hidden by default.' },
  { key: 'archive', label: 'Archive (ready for archiving)', hint: 'Set when a file changed since the last backup.' },
];

const EMPTY: AttrState = { readOnly: false, hidden: false, system: false, archive: false };

/** Windows counterpart of the chmod dialog: shows and changes the R/H/S/A file attributes of local items. */
export const WinAttributesModal: React.FC<WinAttributesModalProps> = ({ open, providerId, entries, onClose, onSaved }) => {
  const [initial, setInitial] = useState<AttrState>(EMPTY);
  const [attrs, setAttrs] = useState<AttrState>(EMPTY);
  const [recursive, setRecursive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasDirectory = useMemo(() => entries.some((e) => e.isDirectory), [entries]);

  // FilePane rebuilds `entries` on every render; keying on the paths keeps a re-render from reloading the
  // attributes and discarding what the user has ticked.
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const entryPaths = entries.map((e) => e.path).join('\n');

  useEffect(() => {
    const targets = entriesRef.current;
    if (!open || targets.length === 0) return;
    let cancelled = false;
    setRecursive(false);
    setError(null);
    setLoading(true);
    void Promise.all(targets.map((e) => window.multissh.storageGetWinAttributes(providerId, e.path)))
      .then((all) => {
        if (cancelled) return;
        const merged = { ...EMPTY } as AttrState;
        for (const { key } of ATTRIBUTES) {
          const values = new Set(all.map((a) => a[key]));
          merged[key] = values.size === 1 ? all[0][key] : null;
        }
        setInitial(merged);
        setAttrs(merged);
      })
      .catch((err) => {
        if (!cancelled) setError(describeIpcError(err, 'Could not read the file attributes'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, entryPaths, providerId]);

  const handleBackdropClick = useModalDismiss(onClose, open, !saving);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, open);

  if (!open) return null;

  // Only what the user changed is sent, so mixed selections and untouched flags are never overwritten.
  const changes: Partial<WinAttributes> = {};
  for (const { key } of ATTRIBUTES) {
    if (attrs[key] !== initial[key] && attrs[key] !== null) changes[key] = attrs[key] as boolean;
  }
  const hasChanges = Object.keys(changes).length > 0;

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      for (const entry of entries) {
        await window.multissh.storageSetWinAttributes(providerId, entry.path, changes, recursive && entry.isDirectory);
      }
      onClose();
    } catch (err) {
      setError(describeIpcError(err, 'Failed to change attributes'));
    } finally {
      // Also after a partial failure: the items before the failing one have changed on disk.
      onSaved();
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 animate-in fade-in duration-150"
      onClick={handleBackdropClick}
    >
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Change attributes" className="w-full max-w-md rounded-xl border border-border-subtle bg-app-card shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between border-b border-divider bg-app-surface px-4 py-3">
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-sky-400" />
            <h2 className="text-sm font-semibold text-txt-primary">Change Attributes</h2>
          </div>
          <button
            aria-label="Close"
            title="Close"
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4 space-y-4 text-xs text-txt-secondary">
          <div className="rounded-lg border border-border-subtle bg-app-surface p-2.5">
            <div className="text-xs text-txt-muted uppercase tracking-wider font-semibold">Target</div>
            <div className="mt-1 font-mono text-xs text-txt-primary truncate">
              {entries.length === 1 ? entries[0].name : `${entries.length} selected items`}
            </div>
          </div>

          <div className="rounded-lg border border-border-subtle bg-app-surface p-3 space-y-2.5">
            {loading ? (
              <div className="flex items-center gap-2 text-txt-muted">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading attributes…
              </div>
            ) : (
              ATTRIBUTES.map(({ key, label, hint }) => (
                <label key={key} className="flex items-start gap-2 cursor-pointer text-txt-primary" title={hint}>
                  <input
                    type="checkbox"
                    checked={attrs[key] === true}
                    ref={(el) => {
                      if (el) el.indeterminate = attrs[key] === null;
                    }}
                    onChange={() => setAttrs((prev) => ({ ...prev, [key]: prev[key] !== true }))}
                    className="mt-0.5 rounded border-border-subtle bg-app-input text-sky-600 focus:ring-sky-500"
                  />
                  <span className="flex flex-col">
                    <span>{label}</span>
                    <span className="text-txt-muted">{hint}</span>
                  </span>
                </label>
              ))
            )}
          </div>

          {hasDirectory && (
            <label className="flex items-center gap-2 cursor-pointer text-txt-primary">
              <input
                type="checkbox"
                checked={recursive}
                onChange={(e) => setRecursive(e.target.checked)}
                className="rounded border-border-subtle bg-app-input text-sky-600 focus:ring-sky-500"
              />
              <span>Apply to all files and folders inside</span>
            </label>
          )}

          {error && (
            <div role="alert" className="rounded-lg border border-red-800/80 bg-red-950/40 p-2.5 text-xs text-red-300">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-divider bg-app-surface px-4 py-3">
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" variant="primary" onClick={handleSave} disabled={saving || loading || !hasChanges}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save
          </Button>
        </div>
      </div>
    </div>
  );
};

export default WinAttributesModal;
