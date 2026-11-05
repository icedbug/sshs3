import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ListChecks, X } from 'lucide-react';
import type { FileEntry } from '@shared/types/storage';
import { entriesMatchingPattern } from '../../lib/selectionOps';
import { Button } from '../ui/Button';
import { useModalDismiss } from '../../lib/useModalDismiss';
import { useDialogFocus } from '../../lib/useDialogFocus';

interface SelectByPatternModalProps {
  open: boolean;
  /** The entries currently shown in the pane. */
  entries: FileEntry[];
  onClose: () => void;
  /** Adds (`select`) or removes (`deselect`) the matching paths from the pane's selection. */
  onApply: (paths: string[], mode: 'select' | 'deselect') => void;
}

export const SelectByPatternModal: React.FC<SelectByPatternModalProps> = ({ open, entries, onClose, onApply }) => {
  const [pattern, setPattern] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const handleBackdropClick = useModalDismiss(onClose, open, true);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, open);
  const matches = useMemo(() => entriesMatchingPattern(entries, pattern), [entries, pattern]);

  useEffect(() => {
    if (open) {
      setPattern('');
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  if (!open) return null;

  const apply = (mode: 'select' | 'deselect') => {
    if (matches.length === 0) return;
    onApply(matches, mode);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 animate-in fade-in duration-150"
      onClick={handleBackdropClick}
    >
      <div
        className="w-full max-w-sm rounded-xl border border-border-subtle bg-app-card p-5 shadow-2xl space-y-4"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 font-semibold text-txt-primary">
            <ListChecks className="h-5 w-5 text-sky-400 shrink-0" />
            <span>Select by Pattern</span>
          </div>
          <button
            aria-label="Close"
            title="Close"
            type="button"
            onClick={onClose}
            className="rounded p-1 text-txt-muted hover:bg-app-surface hover:text-txt-primary transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            apply('select');
          }}
          className="space-y-4"
        >
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-txt-secondary block">Pattern</label>
            <input
              ref={inputRef}
              type="text"
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              placeholder="*.log"
              className="w-full rounded-lg border border-border-subtle bg-app-surface px-3 py-2 text-xs text-txt-primary placeholder-txt-muted focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
            />
            <p className="text-xs text-txt-muted">
              Use * and ? as wildcards. Without wildcards, names containing the text match.
            </p>
            <p className="text-xs text-txt-secondary">
              {pattern.trim() ? `${matches.length} matching ${matches.length === 1 ? 'item' : 'items'}` : ' '}
            </p>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" onClick={onClose} className="bg-app-surface">
              Cancel
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => apply('deselect')}
              disabled={matches.length === 0}
              className="bg-app-surface"
            >
              Deselect
            </Button>
            <Button type="submit" variant="primary" disabled={matches.length === 0}>
              Select
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
};
