import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ExternalLink, FolderPlus, GitBranch, Loader2, RefreshCw } from 'lucide-react';
import type { GitRepoStatus } from '@shared/types/git';
import type { SourceType } from './types';
import { toWebRepoUrl } from './filePaneHelpers';

interface GitStatusMenuProps {
  enabled: boolean;
  gitStatus: GitRepoStatus | null;
  gitPulling: boolean;
  sourceType: SourceType;
  currentPath: string;
  onPull: () => Promise<void> | void;
  onCloneHere: (dir: string) => void;
}

/** Toolbar entry for the current folder's git repo: branch badge with pull / open-in-web / clone, or a clone button outside a repo. */
export const GitStatusMenu: React.FC<GitStatusMenuProps> = ({
  enabled: gitIntegrationEnabled,
  gitStatus,
  gitPulling,
  sourceType,
  currentPath,
  onPull,
  onCloneHere,
}) => {
  const [gitMenuOpen, setGitMenuOpen] = useState(false);
  const gitMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!gitMenuOpen) return;
    const handleOutsideClick = (e: MouseEvent) => {
      if (gitMenuRef.current && !gitMenuRef.current.contains(e.target as Node)) {
        setGitMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', handleOutsideClick);
    return () => window.removeEventListener('mousedown', handleOutsideClick);
  }, [gitMenuOpen]);

  return gitIntegrationEnabled ? (
    gitStatus?.isRepo && gitStatus.branch ? (
      <div ref={gitMenuRef} className="relative shrink-0">
        <button
          type="button"
          title={`Git: ${gitStatus.branch}${gitStatus.isClean === true ? ' (clean)' : gitStatus.isClean === false ? ' (uncommitted changes)' : ''}${gitStatus.ahead ? `, ahead ${gitStatus.ahead}` : ''}${gitStatus.behind ? `, behind ${gitStatus.behind}` : ''}\nClick for Git options (Pull, Web, Clone)`}
          onClick={() => setGitMenuOpen((prev) => !prev)}
          className="flex items-center gap-1 bg-app-card hover:bg-app-surface border border-border-subtle rounded-md px-1.5 py-0.5 text-2xs text-txt-secondary transition-colors cursor-pointer select-none"
        >
          {gitPulling ? (
            <Loader2 className="h-3 w-3 animate-spin text-sky-400 shrink-0" />
          ) : (
            <GitBranch className="h-3 w-3 text-sky-400 shrink-0" />
          )}
          <span className="font-medium text-txt-primary max-w-[100px] truncate">{gitStatus.branch}</span>
          {gitStatus.isClean === false && <span className="text-amber-400 font-bold">*</span>}
          {Boolean(gitStatus.ahead) && <span className="text-emerald-400 text-2xs">↑{gitStatus.ahead}</span>}
          {Boolean(gitStatus.behind) && <span className="text-amber-400 text-2xs">↓{gitStatus.behind}</span>}
          <ChevronDown className="h-3 w-3 text-txt-muted ml-0.5" />
        </button>

        {gitMenuOpen && (
          <div className="absolute left-0 top-full mt-1 z-40 w-64 rounded-xl border border-border-subtle bg-app-card p-2.5 shadow-xl text-xs space-y-2">
            <div className="flex items-center justify-between border-b border-divider pb-1.5">
              <div className="flex items-center gap-1.5 font-semibold text-txt-primary truncate">
                <GitBranch className="h-4 w-4 text-sky-400 shrink-0" />
                <span className="truncate">{gitStatus.branch}</span>
              </div>
              {/* Remote repos are not scanned, so cleanliness is unknown (undefined) there. */}
              {gitStatus.isClean === true && (
                <span className="rounded bg-emerald-500/15 text-emerald-400 text-2xs px-1.5 py-0.5 font-medium">Clean</span>
              )}
              {gitStatus.isClean === false && (
                <span className="rounded bg-amber-500/15 text-amber-400 text-2xs px-1.5 py-0.5 font-medium">Modified</span>
              )}
            </div>

            <div className="text-2xs text-txt-muted space-y-0.5">
              {gitStatus.isClean === false && (
                <div className="text-amber-300">
                  ● {gitStatus.modifiedCount ?? 0} modified, {gitStatus.untrackedCount ?? 0} untracked
                </div>
              )}
              {(Boolean(gitStatus.ahead) || Boolean(gitStatus.behind)) && (
                <div className="flex items-center gap-2">
                  {Boolean(gitStatus.ahead) && <span className="text-emerald-400">↑ {gitStatus.ahead} ahead</span>}
                  {Boolean(gitStatus.behind) && <span className="text-amber-400">↓ {gitStatus.behind} behind</span>}
                </div>
              )}
              {gitStatus.remoteOriginUrl && (
                <div className="truncate text-txt-muted font-mono text-2xs" title={gitStatus.remoteOriginUrl}>
                  {gitStatus.remoteOriginUrl}
                </div>
              )}
            </div>

            <div className="flex flex-col gap-1 pt-1 border-t border-divider">
              <button
                type="button"
                disabled={gitPulling}
                onClick={() => {
                  setGitMenuOpen(false);
                  void onPull();
                }}
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-txt-primary hover:bg-app-surface hover:text-sky-400 transition-colors disabled:opacity-40 text-left"
              >
                {gitPulling ? <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-400" /> : <RefreshCw className="h-3.5 w-3.5 text-sky-400" />}
                <span>Git Pull</span>
              </button>

              {gitStatus.remoteOriginUrl && (
                <button
                  type="button"
                  onClick={() => {
                    setGitMenuOpen(false);
                    const url = toWebRepoUrl(gitStatus.remoteOriginUrl!);
                    if (url) void window.multissh.openExternal(url);
                  }}
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-txt-primary hover:bg-app-surface hover:text-sky-400 transition-colors text-left"
                >
                  <ExternalLink className="h-3.5 w-3.5 text-sky-400" />
                  <span>Open in GitHub/GitLab</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => {
                  setGitMenuOpen(false);
                  onCloneHere(currentPath);
                }}
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-txt-primary hover:bg-app-surface hover:text-sky-400 transition-colors text-left"
              >
                <FolderPlus className="h-3.5 w-3.5 text-sky-400" />
                <span>Clone Git repository here...</span>
              </button>
            </div>
          </div>
        )}
      </div>
    ) : sourceType !== 's3' && sourceType !== 'k8s' ? (
      <button
        type="button"
        title="Git (Clone repository here...)"
        aria-label="Git (Clone repository here...)"
        onClick={() => {
          onCloneHere(currentPath);
        }}
        className="rounded-lg p-1 text-txt-secondary hover:bg-app-surface-hover hover:text-sky-400 transition-colors shrink-0"
      >
        <GitBranch className="h-4 w-4" />
      </button>
    ) : null
  ) : null;
};
