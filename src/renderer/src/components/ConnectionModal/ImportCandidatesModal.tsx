import React, { useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { Upload, X } from 'lucide-react';
import type { SSHConnectionConfig } from '@shared/types/ssh';
import { useDialogFocus } from '../../lib/useDialogFocus';
import { plural } from '../../lib/plural';

interface ImportCandidatesModalProps {
  importCandidates: SSHConnectionConfig[];
  importTargetFolder: string;
  setImportTargetFolder: Dispatch<SetStateAction<string>>;
  selectedCandidateIds: Set<string>;
  setSelectedCandidateIds: Dispatch<SetStateAction<Set<string>>>;
  onClose: () => void;
  onConfirm: () => Promise<void> | void;
}

/** Preview of the hosts found in ~/.ssh/config: pick which to import and into which folder. */
export const ImportCandidatesModal: React.FC<ImportCandidatesModalProps> = ({
  importCandidates,
  importTargetFolder,
  setImportTargetFolder,
  selectedCandidateIds,
  setSelectedCandidateIds,
  onClose,
  onConfirm,
}) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, true);
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-4 animate-in fade-in duration-100">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Import hosts from SSH config" className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-xl border border-border-subtle bg-app-surface p-4 shadow-2xl space-y-3">
        <div className="flex items-center justify-between border-b border-divider pb-2">
          <div className="flex items-center gap-2 text-sky-400 font-semibold text-sm">
            <Upload className="h-4 w-4" />
            <span>Import Hosts from ~/.ssh/config</span>
          </div>
          <button
            aria-label="Close"
            title="Close"
            type="button"
            onClick={() => onClose()}
            className="rounded p-1 text-txt-muted hover:text-txt-primary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-txt-muted">Target Folder:</span>
            <input
              aria-label="Target folder"
              type="text"
              value={importTargetFolder}
              onChange={(e) => setImportTargetFolder(e.target.value)}
              placeholder="e.g. Imported"
              className="rounded border border-border-subtle bg-app-input px-2 py-1 text-xs text-txt-primary outline-none focus:border-sky-500 w-32"
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSelectedCandidateIds(new Set(importCandidates.map((c) => c.id)))}
              className="text-xs text-sky-400 hover:underline"
            >
              Select All
            </button>
            <span className="text-txt-muted">|</span>
            <button
              type="button"
              onClick={() => setSelectedCandidateIds(new Set())}
              className="text-xs text-txt-muted hover:underline"
            >
              Deselect All
            </button>
          </div>
        </div>

        <div className="max-h-60 overflow-y-auto space-y-1.5 rounded-lg border border-border-subtle bg-app-card p-2">
          {importCandidates.map((candidate) => {
            const isChecked = selectedCandidateIds.has(candidate.id);
            return (
              <label
                key={candidate.id}
                className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-app-surface-hover cursor-pointer text-xs"
              >
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={(e) => {
                    const next = new Set(selectedCandidateIds);
                    if (e.target.checked) next.add(candidate.id);
                    else next.delete(candidate.id);
                    setSelectedCandidateIds(next);
                  }}
                  className="rounded border-border-subtle text-sky-500 focus:ring-0"
                />
                <div className="min-w-0 flex-1">
                  <span className="font-medium text-txt-primary">{candidate.name}</span>
                  <span className="ml-2 text-txt-muted">
                    {candidate.username ? `${candidate.username}@` : ''}
                    {candidate.host}:{candidate.port ?? 22}
                  </span>
                </div>
                <span className="rounded bg-app-surface-subtle px-1.5 py-0.5 text-2xs text-txt-muted">
                  {candidate.authType}
                </span>
              </label>
            );
          })}
        </div>

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-divider">
          <button
            type="button"
            onClick={() => onClose()}
            className="rounded-lg px-3 py-1.5 text-xs text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void onConfirm()}
            disabled={selectedCandidateIds.size === 0}
            className="rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
          >
            Import {plural(selectedCandidateIds.size, 'profile')}
          </button>
        </div>
      </div>
    </div>
  );
};
