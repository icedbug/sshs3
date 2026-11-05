import React, { useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { ChevronDown, ChevronRight, Folder, Pencil, Trash2 } from 'lucide-react';

interface ProfileFolderHeaderProps {
  groupName: string;
  /** Display text, when it should differ from `groupName` (the identity used for
   * rename/delete) — e.g. a Team Vault tree node showing just its own segment ("Cluster A")
   * while `groupName` carries the full path ("Acme Infra/Cluster A"). Defaults to `groupName`. */
  label?: string;
  profileCount: number;
  isCollapsed: boolean;
  isDragOver: boolean;
  dragOverGroup: string | null;
  setDragOverGroup: Dispatch<SetStateAction<string | null>>;
  renamingFolder: string | null;
  setRenamingFolder: Dispatch<SetStateAction<string | null>>;
  renameFolderValue: string;
  setRenameFolderValue: Dispatch<SetStateAction<string>>;
  onToggle: () => void;
  onDrop: (e: React.DragEvent) => void;
  onCommitRename: (groupName: string) => Promise<void> | void;
  onDeleteFolder: (groupName: string) => Promise<void> | void;
}

const FolderIcons: React.FC<{ isCollapsed: boolean }> = ({ isCollapsed }) => (
  <>
    {isCollapsed ? (
      <ChevronRight className="h-3.5 w-3.5 text-txt-muted" />
    ) : (
      <ChevronDown className="h-3.5 w-3.5 text-txt-muted" />
    )}
    <Folder className="h-3.5 w-3.5 text-amber-400" />
  </>
);

const CountBadge: React.FC<{ count: number }> = ({ count }) => (
  <span className="rounded bg-app-surface px-1.5 py-0.2 text-2xs text-txt-muted">{count}</span>
);

/** A folder row in the profile list: collapse toggle, inline rename, delete, and drop target for dragged profiles. */
export const ProfileFolderHeader: React.FC<ProfileFolderHeaderProps> = ({
  groupName,
  label,
  profileCount,
  isCollapsed,
  isDragOver,
  dragOverGroup,
  setDragOverGroup,
  renamingFolder,
  setRenamingFolder,
  renameFolderValue,
  setRenameFolderValue,
  onToggle,
  onDrop,
  onCommitRename,
  onDeleteFolder,
}) => {
  const toggleRef = useRef<HTMLButtonElement>(null);
  const wasRenaming = useRef(false);
  const renaming = renamingFolder === groupName;

  // Enter or Escape removes the field that has focus; give the focus back to the folder row, not to the page.
  useEffect(() => {
    if (wasRenaming.current && !renaming) toggleRef.current?.focus();
    wasRenaming.current = renaming;
  }, [renaming]);

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (dragOverGroup !== groupName) setDragOverGroup(groupName);
      }}
      onDragLeave={() => {
        if (dragOverGroup === groupName) setDragOverGroup(null);
      }}
      onDrop={(e) => onDrop(e)}
      className={`flex items-center justify-between rounded-lg px-2 py-1.5 transition-colors ${
        isDragOver
          ? 'border border-dashed border-sky-400 bg-sky-500/15'
          : 'hover:bg-app-surface-hover'
      }`}
    >
      {renaming ? (
        // Not inside the button: an input in a button makes every Space typed in the name click the button
        // (the folder folds and unfolds while it is being renamed), and is not valid HTML.
        <div className="flex min-h-6 flex-1 items-center gap-1.5 text-xs font-semibold text-txt-secondary">
          <FolderIcons isCollapsed={isCollapsed} />
          <input
            type="text"
            autoFocus
            value={renameFolderValue}
            onChange={(e) => setRenameFolderValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void onCommitRename(groupName);
              if (e.key === 'Escape') {
                // Stop this local Escape from also
                // bubbling up to the modal's own
                // window-level Escape-to-close handler
                // (M12) — it should only cancel the
                // rename here, not close the dialog.
                e.stopPropagation();
                setRenamingFolder(null);
              }
            }}
            aria-label="Folder name"
            className="rounded border border-sky-500 bg-app-input px-1.5 py-0.5 text-xs text-txt-primary outline-none"
          />
          <CountBadge count={profileCount} />
        </div>
      ) : (
        <button
          ref={toggleRef}
          type="button"
          onClick={() => onToggle()}
          className="flex min-h-6 flex-1 items-center gap-1.5 text-xs font-semibold text-txt-secondary"
        >
          <FolderIcons isCollapsed={isCollapsed} />
          <span>{label ?? groupName}</span>
          <CountBadge count={profileCount} />
        </button>
      )}

      {groupName !== 'Ungrouped' && (
        <div className="flex items-center gap-1 opacity-80 hover:opacity-100">
          <button
            aria-label="Rename folder"
            type="button"
            title="Rename folder"
            onClick={() => {
              setRenamingFolder(groupName);
              setRenameFolderValue(groupName);
            }}
            className="rounded p-1.5 text-txt-muted hover:text-txt-primary transition-colors"
          >
            <Pencil className="h-3 w-3" />
          </button>
          <button
            aria-label="Delete folder (ungroup profiles)"
            type="button"
            title="Delete folder (ungroup profiles)"
            onClick={() => void onDeleteFolder(groupName)}
            className="rounded p-1.5 text-txt-muted hover:text-red-400 transition-colors"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );
};
