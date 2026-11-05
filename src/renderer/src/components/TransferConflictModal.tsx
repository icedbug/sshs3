import React, { useEffect, useState, useRef } from 'react';
import { Copy, FileWarning, SkipForward } from 'lucide-react';
import type { TransferConflictPromptEvent, TransferConflictResolution } from '@shared/types/ipc';
import { useEscapeToClose } from '../lib/useModalDismiss';
import { useDialogFocus } from '../lib/useDialogFocus';
import { createRendererLogger } from '../lib/log';
const log = createRendererLogger('TransferConflictModal');

export const TransferConflictModal: React.FC = () => {
  const [prompts, setPrompts] = useState<TransferConflictPromptEvent[]>([]);
  const [applyToAll, setApplyToAll] = useState(false);

  const currentPrompt = prompts[0] || null;

  useEffect(() => {
    if (!window.multissh?.onTransferConflictPrompt) return;

    const unsubscribe = window.multissh.onTransferConflictPrompt((event) => {
      setPrompts((prev) => {
        if (
          prev.some(
            (p) =>
              p.id === event.id ||
              (p.sourcePath === event.sourcePath && p.targetPath === event.targetPath)
          )
        ) {
          return prev;
        }
        return [...prev, event];
      });
    });

    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    setApplyToAll(false);
  }, [currentPrompt?.id]);

  const respond = async (resolution: TransferConflictResolution) => {
    if (!currentPrompt) return;
    const promptId = currentPrompt.id;
    const applied = applyToAll;
    const targetPath = currentPrompt.targetPath;

    setPrompts((prev) =>
      applied
        ? []
        : prev.filter((p) => p.id !== promptId && p.targetPath !== targetPath)
    );

    if (window.multissh?.respondTransferConflict) {
      try {
        await window.multissh.respondTransferConflict(promptId, resolution, applied);
      } catch (err) {
        log.error('Failed to respond to transfer conflict prompt:', err);
      }
    }
  };

  // M11 (code review): a window-level listener catches Escape even while
  // focus is elsewhere (e.g. a terminal), unlike a handler attached only to
  // this dialog's own <div>.
  useEscapeToClose(() => void respond('skip'), !!currentPrompt);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, !!currentPrompt);

  if (!currentPrompt) {
    return null;
  }

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="transfer-conflict-modal-title"
      data-testid="transfer-conflict-modal"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/65 animate-in fade-in duration-150 p-4"
    >
      <div className="w-full max-w-md rounded-xl border border-border-subtle bg-app-card p-6 shadow-2xl">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/20 text-amber-400">
            <FileWarning className="h-5 w-5" />
          </div>
          <div>
            <h2 id="transfer-conflict-modal-title" className="text-base font-semibold text-txt-primary">
              File Already Exists
            </h2>
            <p className="break-all text-xs text-txt-muted">{currentPrompt.targetPath}</p>
          </div>
        </div>

        <div className="mt-4 text-sm text-txt-secondary">
          <p>
            {currentPrompt.isDirectory ? 'The folder' : 'The file'}{' '}
            <span className="font-medium text-txt-primary">{currentPrompt.fileName}</span> already exists
            at the destination. What would you like to do?
          </p>
        </div>

        <label className="mt-4 flex items-center gap-2 text-xs text-txt-muted cursor-pointer">
          <input
            type="checkbox"
            checked={applyToAll}
            onChange={(e) => setApplyToAll(e.target.checked)}
            data-testid="transfer-conflict-apply-all"
            className="rounded border-border-subtle bg-app-input text-sky-600 focus:ring-sky-500"
          />
          <span>Apply to all remaining conflicts in this transfer</span>
        </label>

        <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => respond('skip')}
            autoFocus
            data-testid="transfer-conflict-skip"
            className="flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-2 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
          >
            <SkipForward className="h-3.5 w-3.5" />
            Skip
          </button>
          <button
            type="button"
            onClick={() => respond('rename')}
            data-testid="transfer-conflict-rename"
            className="flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-2 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
          >
            <Copy className="h-3.5 w-3.5" />
            Rename
          </button>
          <button
            type="button"
            onClick={() => respond('overwrite')}
            data-testid="transfer-conflict-overwrite"
            className="rounded-lg bg-red-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-red-500 shadow-sm transition-colors"
          >
            Overwrite
          </button>
        </div>
      </div>
    </div>
  );
};

export default TransferConflictModal;
