import React from 'react';
import { Upload, Folder } from 'lucide-react';

export interface TerminalDropOverlayProps {
  isDragging: boolean;
  isRemote: boolean;
  targetFolder: string;
}

export const TerminalDropOverlay: React.FC<TerminalDropOverlayProps> = ({
  isDragging,
  isRemote,
  targetFolder,
}) => {
  if (!isDragging) return null;

  return (
    <div
      data-testid="terminal-drop-overlay"
      className="pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-center bg-slate-950/80 backdrop-blur-sm p-6 animate-fade-in"
    >
      <div className="flex flex-col items-center max-w-md text-center rounded-xl border-2 border-dashed border-sky-400/60 bg-sky-950/20 px-8 py-8 shadow-2xl">
        <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-md bg-sky-500/20 text-sky-400 ring-8 ring-sky-500/10">
          <Upload className="h-7 w-7 animate-bounce" />
        </div>

        <h3 className="text-sm font-semibold text-white mb-1">
          {isRemote ? 'Drop to Upload & Paste Path' : 'Drop to Paste File Path'}
        </h3>

        {isRemote ? (
          <div className="space-y-1.5 mt-1">
            <div className="flex items-center justify-center gap-1.5 text-xs text-sky-300 font-mono bg-sky-950/60 px-3 py-1 rounded-lg border border-sky-500/30 max-w-full truncate">
              <Folder className="h-3.5 w-3.5 shrink-0 text-sky-400" />
              <span className="truncate" title={targetFolder}>{targetFolder}</span>
            </div>
            <p className="text-[11px] text-slate-400">
              File will be uploaded to the active directory and quoted into your terminal prompt.
            </p>
          </div>
        ) : (
          <p className="text-xs text-slate-400 mt-1">
            The local absolute file path will be quoted and pasted into your terminal prompt.
          </p>
        )}
      </div>
    </div>
  );
};
