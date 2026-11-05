import React, { useEffect, useRef, useState } from 'react';
import { GripVertical, Loader2, X, Download } from 'lucide-react';
import { useModalDismiss } from '../../lib/useModalDismiss';
import { useDialogFocus } from '../../lib/useDialogFocus';
import { describeIpcError } from '../../lib/format';
import { isSensitiveFilePath } from '../../lib/terminalPathPreview';

export interface DragOutDialogProps {
  providerId: string;
  /** Paths on the remote host (or container/bucket) to make draggable. */
  paths: string[];
  onClose: () => void;
}

type Phase = { name: 'confirm' } | { name: 'preparing' } | { name: 'ready'; localPaths: string[] } | { name: 'error'; message: string };

function baseName(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p;
}

/**
 * Asks before copying remote items to this computer so they can be dragged into another app.
 * Nothing is downloaded until the user confirms; the copy lives in a private temp folder that is
 * removed when sshs3 quits.
 */
export const DragOutDialog: React.FC<DragOutDialogProps> = ({ providerId, paths, onClose }) => {
  const [phase, setPhase] = useState<Phase>({ name: 'confirm' });
  const closedRef = useRef(false);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const handleBackdropClick = useModalDismiss(onClose, true);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, true);

  useEffect(() => {
    closedRef.current = false;
    primaryRef.current?.focus();
    return () => {
      closedRef.current = true;
    };
  }, []);

  const names = paths.map(baseName);
  const title = names.length === 1 ? names[0] : `${names.length} items`;
  const sensitive = paths.some(isSensitiveFilePath);

  const prepare = async () => {
    setPhase({ name: 'preparing' });
    try {
      const localPaths = await window.multissh.dragOutPrepare(providerId, paths);
      if (!closedRef.current) setPhase({ name: 'ready', localPaths });
    } catch (err) {
      if (!closedRef.current) setPhase({ name: 'error', message: describeIpcError(err, 'Could not prepare the copy') });
    }
  };

  const handleChipDragStart = (e: React.DragEvent, localPaths: string[]) => {
    e.preventDefault();
    void window.multissh.dragOutStart(localPaths).catch(() => {});
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4" onClick={handleBackdropClick}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Drag out of sshs3"
        className="w-full max-w-md overflow-hidden rounded-xl border border-border-subtle bg-app-card shadow-2xl"
      >
        <div className="flex h-12 items-center justify-between border-b border-divider bg-app-surface px-5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-sky-500/10 text-sky-400">
              <Download className="h-4 w-4" />
            </div>
            <h2 className="text-sm font-semibold text-txt-primary">Drag out of sshs3</h2>
          </div>
          <button
            type="button"
            aria-label="Close"
            title="Close"
            onClick={onClose}
            className="rounded-lg p-1.5 text-txt-muted transition-colors hover:bg-app-surface-hover hover:text-txt-primary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 p-5 text-xs text-txt-secondary">
          {phase.name === 'ready' ? (
            <>
              <p>Ready. Drag the item below into the other application.</p>
              <p className="text-txt-muted">
                If the application asks what to do, choose <span className="font-semibold text-txt-primary">Copy</span>, not Link:
                a link would break when sshs3 deletes the temporary copy.
              </p>
              <div
                draggable
                data-testid="drag-out-chip"
                onDragStart={(e) => handleChipDragStart(e, phase.localPaths)}
                className="flex cursor-grab items-center gap-2 rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-2.5 text-sm font-medium text-txt-primary active:cursor-grabbing"
              >
                <GripVertical className="h-4 w-4 shrink-0 text-sky-400" />
                <span className="truncate">{title}</span>
              </div>
            </>
          ) : (
            <>
              <p>
                Copy <span className="font-semibold text-txt-primary">{title}</span> to this computer so you can drag it into
                another application?
              </p>
              <p className="text-txt-muted">
                A temporary copy is downloaded to a private folder and deleted when sshs3 quits. Files over 500 MB can not be
                dragged out.
              </p>
              {sensitive && (
                <p role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-amber-300">
                  This looks like a credential or secret file. The temporary copy stays on this computer until sshs3 quits.
                </p>
              )}
              {phase.name === 'error' && (
                <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 p-2.5 text-red-400">
                  {phase.message}
                </p>
              )}
            </>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-divider bg-app-card px-3 py-1.5 font-medium text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary"
            >
              {phase.name === 'ready' ? 'Done' : 'Cancel'}
            </button>
            {phase.name !== 'ready' && (
              <button
                ref={primaryRef}
                type="button"
                disabled={phase.name === 'preparing'}
                onClick={() => void prepare()}
                className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 font-semibold text-white hover:bg-sky-500 disabled:opacity-60"
              >
                {phase.name === 'preparing' ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>Preparing…</span>
                  </>
                ) : (
                  <span>{phase.name === 'error' ? 'Try again' : 'Prepare copy'}</span>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
