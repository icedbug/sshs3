import React, { useEffect, useState, useRef } from 'react';
import { AlertTriangle, ChevronRight, Folder, Loader2, X } from 'lucide-react';
import type { FileEntry } from '@shared/types/storage';
import { useModalDismiss } from '../../lib/useModalDismiss';
import { useDialogFocus } from '../../lib/useDialogFocus';

interface FolderBrowserModalProps {
  open: boolean;
  onClose: () => void;
  onSelect: (path: string) => void;
  providerId: string;
  providerLabel: string;
  /** Path to open the browser in; falls back to '/' if it can't be listed. */
  initialPath: string;
}

function splitBreadcrumbs(path: string): { label: string; path: string }[] {
  const normalized = (path || '/').replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  const crumbs: { label: string; path: string }[] = [{ label: '/', path: '/' }];
  let acc = '';
  for (const part of parts) {
    acc += `/${part}`;
    crumbs.push({ label: part, path: acc });
  }
  return crumbs;
}

/** Minimal remote/local directory browser used to pick a target folder for directory sync. */
export const FolderBrowserModal: React.FC<FolderBrowserModalProps> = ({
  open,
  onClose,
  onSelect,
  providerId,
  providerLabel,
  initialPath,
}) => {
  const [currentPath, setCurrentPath] = useState(initialPath || '/');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setCurrentPath(initialPath || '/');
    }
  }, [open, initialPath]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    window.multissh
      .storageList(providerId, currentPath)
      .then((list) => {
        if (cancelled) return;
        setEntries(list.filter((e) => e.isDirectory).sort((a, b) => a.name.localeCompare(b.name)));
      })
      .catch((err) => {
        if (cancelled) return;
        setEntries([]);
        setError((err as Error)?.message ?? String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, providerId, currentPath]);

  const handleBackdropClick = useModalDismiss(onClose, open);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, open);

  if (!open) return null;

  const crumbs = splitBreadcrumbs(currentPath);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/65 p-4"
      onClick={handleBackdropClick}
    >
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Choose folder" className="w-full max-w-md rounded-xl border border-border-subtle bg-app-card shadow-2xl flex flex-col max-h-[80vh]">
        <div className="flex items-center justify-between border-b border-divider p-3">
          <div className="text-sm font-semibold text-txt-primary">Choose folder — {providerLabel}</div>
          <button
            aria-label="Close"
            title="Close"
            type="button"
            onClick={onClose}
            className="text-txt-muted hover:text-txt-primary transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex items-center gap-0.5 overflow-x-auto whitespace-nowrap border-b border-divider px-3 py-2 text-xs text-txt-secondary">
          {crumbs.map((crumb, idx) => (
            <React.Fragment key={crumb.path}>
              {idx > 0 && <ChevronRight className="h-3 w-3 shrink-0 text-txt-muted" />}
              <button
                type="button"
                onClick={() => setCurrentPath(crumb.path)}
                className="rounded px-1.5 py-0.5 hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
              >
                {crumb.label}
              </button>
            </React.Fragment>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {loading && (
            <div className="flex items-center gap-2 p-3 text-xs text-txt-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading...
            </div>
          )}
          {!loading && error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-800/80 bg-red-950/40 p-2.5 text-xs text-red-300">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
          {!loading && !error && entries.length === 0 && (
            <div className="p-3 text-xs text-txt-muted">No subfolders here.</div>
          )}
          {!loading &&
            !error &&
            entries.map((entry) => (
              <button
                key={entry.path || entry.name}
                type="button"
                onClick={() => setCurrentPath(entry.path || `${currentPath.replace(/\/$/, '')}/${entry.name}`)}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
              >
                <Folder className="h-3.5 w-3.5 shrink-0 text-sky-400" />
                <span className="truncate">{entry.name}</span>
              </button>
            ))}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-divider p-3">
          <span className="truncate font-mono text-xs text-txt-muted">{currentPath}</span>
          <div className="flex gap-2 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-border-subtle px-3.5 py-1.5 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => onSelect(currentPath)}
              className="rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-500 transition-colors"
            >
              Select this folder
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
