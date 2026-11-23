import React from 'react';
import type { Dispatch, SetStateAction } from 'react';

interface EmptyFolderDropZoneProps {
  groupName: string;
  isDragOver: boolean;
  dragOverGroup: string | null;
  setDragOverGroup: Dispatch<SetStateAction<string | null>>;
  onDrop: (e: React.DragEvent) => void;
}

/** Placeholder shown inside a folder that holds no profiles; also accepts dragged profiles. */
export const EmptyFolderDropZone: React.FC<EmptyFolderDropZoneProps> = ({
  groupName,
  isDragOver,
  dragOverGroup,
  setDragOverGroup,
  onDrop,
}) => (
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
    className={`rounded-lg border border-dashed py-3 text-center text-xs transition-colors ${
      isDragOver
        ? 'border-sky-400 bg-sky-500/10 text-sky-300'
        : 'border-border-subtle/60 text-txt-muted'
    }`}
  >
    Folder is empty: drag profiles here
  </div>
);
