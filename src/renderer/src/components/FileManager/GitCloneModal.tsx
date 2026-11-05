import React, { useRef, useState } from 'react';
import { GitBranch, Loader2, ShieldAlert, X } from 'lucide-react';
import type { SSHConnectionConfig } from '@shared/types/ssh';
import { useModalDismiss } from '../../lib/useModalDismiss';
import { useDialogFocus } from '../../lib/useDialogFocus';

interface GitCloneModalProps {
  targetPath: string;
  providerId?: string;
  sftpConfig?: SSHConnectionConfig;
  onClose: () => void;
  onCloned: () => void;
}

export const GitCloneModal: React.FC<GitCloneModalProps> = ({
  targetPath,
  providerId,
  sftpConfig,
  onClose,
  onCloned,
}) => {
  const [url, setUrl] = useState('');
  const [folderName, setFolderName] = useState('');
  const [depth, setDepth] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleBackdrop = useModalDismiss(onClose, true, !cloning);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, true);

  const handleUrlChange = (newUrl: string) => {
    setUrl(newUrl);
    // Auto-derive folder name if empty
    const derived = newUrl.trim().split('/').pop()?.replace(/\.git$/, '');
    if (derived && !folderName) {
      setFolderName(derived);
    }
  };

  const handleClone = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;

    setCloning(true);
    setError(null);

    try {
      const res = await window.multissh.gitClone({
        url: url.trim(),
        targetDirectory: targetPath,
        directoryName: folderName.trim() || undefined,
        depth: depth ? 1 : undefined,
        providerId,
        sftpConfig,
      });

      if (!res.success) {
        setError(res.error || 'Git clone failed');
      } else {
        onCloned();
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCloning(false);
    }
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="git-clone-title"
      onClick={handleBackdrop}
      className="fixed inset-0 z-[95] flex items-center justify-center bg-black/65 p-4 animate-in fade-in duration-150"
    >
      <div className="flex w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border-subtle bg-app-card shadow-2xl">
        <div className="flex items-center justify-between border-b border-divider bg-app-surface px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <GitBranch className="h-4 w-4 text-sky-400" />
            <div>
              <h2 id="git-clone-title" className="text-sm font-semibold text-txt-primary">
                Git Clone Repository
              </h2>
              <p className="text-xs text-txt-muted truncate max-w-sm">{targetPath}</p>
            </div>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            disabled={cloning}
            className="rounded-lg p-1.5 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleClone} className="space-y-4 p-5 text-xs">
          <div className="space-y-1.5">
            <label htmlFor="git-clone-url" className="text-txt-secondary font-medium">
              Repository URL
            </label>
            <input
              id="git-clone-url"
              type="text"
              autoFocus
              required
              value={url}
              onChange={(e) => handleUrlChange(e.target.value)}
              placeholder="https://github.com/username/repo.git or git@github.com:..."
              className="w-full rounded-lg border border-border-subtle bg-app-surface px-3 py-2 text-txt-primary placeholder:text-txt-muted/60 focus:border-sky-500 focus:outline-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label htmlFor="git-clone-folder" className="text-txt-secondary font-medium">
                Directory name (optional)
              </label>
              <input
                id="git-clone-folder"
                type="text"
                value={folderName}
                onChange={(e) => setFolderName(e.target.value)}
                placeholder="Leave empty for default"
                className="w-full rounded-lg border border-border-subtle bg-app-surface px-3 py-2 text-txt-primary placeholder:text-txt-muted/60 focus:border-sky-500 focus:outline-none"
              />
            </div>

            <div className="flex items-center pt-6">
              <label className="flex items-center gap-2 cursor-pointer text-txt-secondary">
                <input
                  type="checkbox"
                  checked={depth}
                  onChange={(e) => setDepth(e.target.checked)}
                  className="rounded border-border-subtle bg-app-input text-sky-600 focus:ring-sky-500"
                />
                <span>Shallow clone (--depth 1)</span>
              </label>
            </div>
          </div>

          {error && (
            <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-red-300">
              <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="break-words">{error}</span>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={cloning}
              className="rounded-lg px-3.5 py-1.5 text-txt-secondary hover:bg-app-surface-hover disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!url.trim() || cloning}
              className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-4 py-1.5 font-medium text-white shadow-sm hover:bg-sky-500 disabled:opacity-50"
            >
              {cloning && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {cloning ? 'Cloning…' : 'Clone'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
