import React, { useEffect, useRef, useState } from 'react';
import {
  Check,
  FileCode,
  FolderOpen,
  GitBranch,
  Loader2,
  Plus,
  Save,
  ShieldAlert,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import type { DotfilePool, DotfilePoolFile } from '@shared/types/dotfiles';
import type { DotfileImportedFile } from '@shared/types/dotfiles';
import { DotfilePoolFileTable, type DotfileSourceStatus } from './DotfilePoolFileTable';
import { Button } from '../ui/Button';
import { useModalDismiss } from '../../lib/useModalDismiss';
import { useDialogFocus } from '../../lib/useDialogFocus';
import { useConfirm } from '../ConfirmDialog';
import { createRendererLogger } from '../../lib/log';
import { isFeatureBlocked, usePolicy } from '../../lib/usePolicy';
import { formatDateTime } from '../../lib/dateFormat';
import { FeatureBlockedNotice } from './Managed';
const log = createRendererLogger('DotfilePoolManagerModal');

interface DotfilePoolManagerModalProps {
  open: boolean;
  onClose: () => void;
}

const formatTimestamp = (): string => formatDateTime(new Date());

/** Stable fingerprint of what Save would persist (ignores timestamps), used for the unsaved-changes indicator. */
function poolSnapshot(pool: DotfilePool): string {
  return JSON.stringify({
    name: pool.name,
    files: pool.files.map((f) => [f.id, f.remotePath, f.content, f.mode ?? '', f.deletedAt ?? '']),
  });
}

function emptyPool(): DotfilePool {
  return { id: crypto.randomUUID(), name: '', files: [], updatedAt: formatTimestamp() };
}

export const DotfilePoolManagerModal: React.FC<DotfilePoolManagerModalProps> = ({ open, onClose }) => {
  const [pools, setPools] = useState<DotfilePool[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DotfilePool | null>(null);
  const [saving, setSaving] = useState(false);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, DotfileSourceStatus>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const justSavedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (justSavedTimer.current) clearTimeout(justSavedTimer.current);
    },
    []
  );

  // Git import state
  const [gitImportOpen, setGitImportOpen] = useState(false);
  const gitImportBlocked = isFeatureBlocked(usePolicy(), 'dotfileGitImport');
  const [gitImportUrl, setGitImportUrl] = useState('');
  const [gitImporting, setGitImporting] = useState(false);
  const [gitImportError, setGitImportError] = useState<string | null>(null);

  const handleGitImport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!gitImportUrl.trim()) return;
    setGitImporting(true);
    setGitImportError(null);
    try {
      const res = await window.multissh.dotfilesImportFromGit({ urlOrRepo: gitImportUrl.trim() });
      if (!res.success) {
        setGitImportError(res.error || 'Import failed');
      } else {
        setGitImportOpen(false);
        setGitImportUrl('');
        const updated = await load();
        if (res.poolId) {
          const imported = updated.find((p) => p.id === res.poolId);
          if (imported) selectPool(imported);
        }
      }
    } catch (err) {
      setGitImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setGitImporting(false);
    }
  };

  const load = async () => {
    setLoading(true);
    try {
      const loaded = await window.multissh.dotfilePoolsGet();
      setPools(loaded);
      return loaded;
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      setSelectedId(null);
      setDraft(null);
      void load();
    }
  }, [open]);

  // Escape closes; a stray backdrop click would discard typed input, so it is intentionally ignored.
  useModalDismiss(onClose, open);
  useModalDismiss(() => setGitImportOpen(false), gitImportOpen, !gitImporting);
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirm = useConfirm();
  const gitImportDialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, open);
  useDialogFocus(gitImportDialogRef, gitImportOpen);
  if (!open) return null;

  const dirty = draft ? savedSnapshot === null || poolSnapshot(draft) !== savedSnapshot : false;
  const activeFiles = draft ? draft.files.filter((f) => !f.deletedAt) : [];

  const checkSources = async (files: DotfilePoolFile[]) => {
    const withSource = files.filter((f) => f.sourcePath && !f.deletedAt);
    if (withSource.length === 0) {
      setStatuses({});
      return;
    }
    try {
      const read = await window.multissh.dotfilePoolReadSources(withSource.map((f) => f.sourcePath!));
      const byPath = new Map(read.map((r) => [r.path, r]));
      const next: Record<string, DotfileSourceStatus> = {};
      for (const f of withSource) {
        const src = byPath.get(f.sourcePath!);
        next[f.id] = !src ? 'missing' : src.content === f.content ? 'up-to-date' : 'changed';
      }
      setStatuses(next);
    } catch {
      setStatuses({});
    }
  };

  const selectPool = (pool: DotfilePool) => {
    setSelectedId(pool.id);
    setDraft(JSON.parse(JSON.stringify(pool)));
    setSavedSnapshot(poolSnapshot(pool));
    setJustSaved(false);
    setNotice(null);
    void checkSources(pool.files);
  };

  const startNewPool = () => {
    const pool = emptyPool();
    setSelectedId(pool.id);
    setDraft(pool);
    setSavedSnapshot(null);
    setJustSaved(false);
  };

  const updateDraft = <K extends keyof DotfilePool>(key: K, value: DotfilePool[K]) => {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  const updateFile = (fileId: string, patch: Partial<DotfilePoolFile>) => {
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            files: prev.files.map((f) =>
              f.id === fileId ? { ...f, ...patch, updatedAt: formatTimestamp() } : f
            ),
          }
        : prev
    );
  };

  const removeFile = (fileId: string) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const target = prev.files.find((f) => f.id === fileId);
      if (!target?.updatedAt) {
        return { ...prev, files: prev.files.filter((f) => f.id !== fileId) };
      }
      const now = formatTimestamp();
      return {
        ...prev,
        files: prev.files.map((f) =>
          f.id === fileId ? { ...f, deletedAt: now, updatedAt: now } : f
        ),
      };
    });
  };

  /** Adds (or updates, matching on target path) the given local files; each file is added explicitly by the user. */
  const addImported = (imported: DotfileImportedFile[], requested: number) => {
    if (imported.length === 0) {
      if (requested > 0) setNotice(`Skipped ${requested} file(s): binary, larger than 1 MB, or unreadable.`);
      return;
    }
    if (!draft) return;
    const now = formatTimestamp();
    const files = [...draft.files];
    const added: string[] = [];
    for (const f of imported) {
      const idx = files.findIndex((ef) => !ef.deletedAt && ef.remotePath === f.suggestedRemotePath);
      const entry: DotfilePoolFile = {
        id: idx >= 0 ? files[idx].id : crypto.randomUUID(),
        remotePath: f.suggestedRemotePath,
        content: f.content,
        mode: f.mode || '644',
        masterFileName: f.name,
        sourcePath: f.path,
        updatedAt: now,
      };
      if (idx >= 0) files[idx] = { ...files[idx], ...entry };
      else files.push(entry);
      added.push(entry.id);
    }
    setDraft({ ...draft, files });
    setStatuses((prev) => {
      const next = { ...prev };
      for (const id of added) next[id] = 'up-to-date';
      return next;
    });
    setNotice(
      imported.length < requested ? `Skipped ${requested - imported.length} file(s): binary, larger than 1 MB, or unreadable.` : null
    );
  };

  const handleAddFiles = async () => {
    if (!draft) return;
    try {
      const imported = await window.multissh.dotfilePoolSelectFiles();
      addImported(imported ?? [], imported?.length ?? 0);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDropFiles = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingOver(false);
    if (!draft) return;
    const paths = Array.from(e.dataTransfer.files)
      .map((file) => window.multissh.getPathForFile?.(file) ?? '')
      .filter(Boolean);
    if (paths.length === 0) return;
    try {
      const imported = await window.multissh.dotfilePoolReadSources(paths);
      addImported(imported, paths.length);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRefreshFile = async (fileId: string) => {
    const file = draft?.files.find((f) => f.id === fileId);
    if (!file?.sourcePath) return;
    const [src] = await window.multissh.dotfilePoolReadSources([file.sourcePath]);
    if (!src) {
      setStatuses((prev) => ({ ...prev, [fileId]: 'missing' }));
      return;
    }
    updateFile(fileId, { content: src.content });
    setStatuses((prev) => ({ ...prev, [fileId]: 'up-to-date' }));
  };

  const changedFileIds = Object.keys(statuses).filter((id) => statuses[id] === 'changed');

  const handleOpenMasterFolder = async () => {
    if (!draft) return;
    try {
      await window.multissh.dotfilePoolOpenFolder(draft.id);
    } catch (err) {
      log.error('Failed to open pool folder:', err);
    }
  };

  const handleSave = async () => {
    if (!draft || !draft.name.trim()) return;
    setSaving(true);
    try {
      const poolToSave = {
        ...draft,
        updatedAt: formatTimestamp(),
      };
      await window.multissh.dotfilePoolsSave(poolToSave);
      const updated = await load();
      const saved = updated.find((p) => p.id === draft.id);
      if (saved) selectPool(saved);
      setJustSaved(true);
      if (justSavedTimer.current) clearTimeout(justSavedTimer.current);
      justSavedTimer.current = setTimeout(() => setJustSaved(false), 3000);
    } catch (err) {
      setNotice(`Failed to save pool: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    const name = pools.find((p) => p.id === id)?.name ?? draft?.name ?? 'this pool';
    const confirmed = await confirm({
      title: 'Delete dotfile pool',
      message: `Delete the pool "${name}"? Its files and master directory on this device are removed, and the deletion syncs to your other devices. This cannot be undone.`,
      confirmLabel: 'Delete pool',
    });
    if (!confirmed) return;
    await window.multissh.dotfilePoolsDelete(id);
    setSelectedId(null);
    setDraft(null);
    void load();
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/65 p-4">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Dotfile pools and master files" className="flex h-[600px] w-full max-w-3xl flex-col rounded-xl border border-border-subtle bg-app-card shadow-2xl overflow-hidden">
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-divider bg-app-surface px-5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-sky-500/10 text-sky-400">
              <FileCode className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-txt-primary leading-tight">Dotfile Pools &amp; Master Files</h2>
              <p className="text-xs text-txt-muted">Choose the files that are synced to your servers</p>
            </div>
          </div>
          <button
            aria-label="Close"
            title="Close"
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-1 min-h-0">
          <aside className="w-56 shrink-0 border-r border-divider bg-app-surface p-2.5 flex flex-col gap-1 overflow-y-auto">
            <div className="grid grid-cols-2 gap-1 mb-1.5">
              <button
                type="button"
                onClick={startNewPool}
                className="flex items-center justify-center gap-1 rounded-lg border border-border-subtle bg-app-surface-subtle px-2 py-1.5 text-xs font-medium text-sky-400 hover:bg-app-surface-hover transition-colors"
              >
                <Plus className="h-3.5 w-3.5" />
                New
              </button>
              <button
                type="button"
                disabled={gitImportBlocked}
                aria-describedby={gitImportBlocked ? 'dotfile-git-import-blocked' : undefined}
                onClick={() => {
                  setGitImportError(null);
                  setGitImportOpen(true);
                }}
                className="flex items-center justify-center gap-1 disabled:opacity-50 rounded-lg border border-border-subtle bg-app-surface-subtle px-2 py-1.5 text-xs font-medium text-sky-400 hover:bg-app-surface-hover transition-colors"
              >
                <GitBranch className="h-3.5 w-3.5" />
                From Git
              </button>
            </div>
            <FeatureBlockedNotice blocked={gitImportBlocked} id="dotfile-git-import-blocked" />
            {loading ? (
              <div className="flex items-center justify-center py-4 text-txt-muted">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            ) : pools.length === 0 ? (
              <p className="px-1 py-2 text-xs text-txt-muted">No pools saved.</p>
            ) : (
              pools.map((pool) => (
                <button
                  key={pool.id}
                  type="button"
                  onClick={() => selectPool(pool)}
                  className={`flex items-center justify-between rounded-lg px-3 py-2 text-xs font-medium text-left transition-colors ${
                    selectedId === pool.id
                      ? 'bg-sky-500/15 text-sky-400 font-semibold'
                      : 'text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary'
                  }`}
                >
                  <span className="truncate">{pool.name || '(unnamed pool)'}</span>
                  <span className="ml-2 shrink-0 rounded bg-app-surface px-1.5 py-0.5 text-2xs text-txt-muted font-mono">
                    {pool.files.length} {pool.files.length === 1 ? 'file' : 'files'}
                  </span>
                </button>
              ))
            )}
          </aside>

          <div className="flex flex-1 flex-col min-w-0 bg-app-card">
            {!draft ? (
              <div className="flex flex-1 items-center justify-center text-xs text-txt-muted">
                Select a pool on the left or create a new one.
              </div>
            ) : (
              <>
                <div
                  className={`flex-1 overflow-y-auto p-5 space-y-4 text-xs text-txt-secondary transition-colors ${
                    isDraggingOver ? 'bg-sky-500/5 ring-2 ring-inset ring-sky-500/30' : ''
                  }`}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setIsDraggingOver(true);
                  }}
                  onDragLeave={() => setIsDraggingOver(false)}
                  onDrop={handleDropFiles}
                >
                  <div className="flex items-end justify-between gap-3">
                    <label className="flex-1 flex flex-col gap-1">
                      <span className="text-xs font-medium text-txt-primary">Pool Name</span>
                      <input
                        value={draft.name}
                        onChange={(e) => updateDraft('name', e.target.value)}
                        placeholder="e.g. Linux Standard (.bashrc, .vimrc)"
                        className="rounded-lg border border-border-subtle bg-app-input px-2.5 py-1.5 text-sm text-txt-primary outline-none focus:border-sky-500"
                      />
                    </label>

                    <button
                      type="button"
                      onClick={() => void handleOpenMasterFolder()}
                      className="flex items-center gap-1.5 rounded-lg border border-border-subtle bg-app-surface px-3 py-2 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
                      title="Open the folder with saved master files in the system file explorer"
                    >
                      <FolderOpen className="h-3.5 w-3.5 text-sky-400" />
                      Open Master Directory
                    </button>
                  </div>

                  {draft.masterDirectory && (
                    <div className="flex items-center gap-1.5 text-xs text-txt-muted bg-app-surface/60 rounded-md px-2.5 py-1 font-mono border border-border-subtle/50">
                      <span className="font-semibold text-txt-secondary">Location on disk:</span>
                      <span className="truncate">{draft.masterDirectory}</span>
                    </div>
                  )}

                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-txt-primary">Files in this pool</span>
                        <span className="text-xs text-txt-muted">({activeFiles.length})</span>
                      </div>
                      <div className="flex items-center gap-2">
                        {changedFileIds.length > 0 && (
                          <Button
                            variant="secondary"
                            onClick={() => void Promise.all(changedFileIds.map((id) => handleRefreshFile(id)))}
                            title="Re-read all changed source files"
                          >
                            <RefreshCw className="h-3.5 w-3.5 text-amber-300" />
                            Refresh all ({changedFileIds.length})
                          </Button>
                        )}
                        <Button
                          variant="primary"
                          onClick={() => void handleAddFiles()}
                          title="Choose the files to add. Each file is added explicitly."
                        >
                          <Plus className="h-3.5 w-3.5" />
                          Add Files...
                        </Button>
                      </div>
                    </div>

                    {notice && (
                      <div className="flex items-start gap-1.5 rounded-lg border border-amber-900/60 bg-amber-950/40 px-2.5 py-2 text-2xs text-amber-300">
                        <ShieldAlert className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                        <span>{notice}</span>
                      </div>
                    )}

                    {activeFiles.length === 0 ? (
                      <div
                        onClick={() => void handleAddFiles()}
                        className="cursor-pointer flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-border-subtle p-8 text-center hover:border-sky-500/40 hover:bg-app-surface/50 transition-colors"
                      >
                        <FileCode className="h-8 w-8 text-sky-400/60 mb-2" />
                        <p className="text-xs font-medium text-txt-primary">Add files or drag &amp; drop them here</p>
                        <p className="text-xs text-txt-muted mt-1">
                          Only the files you pick are copied into the pool and synced to connected SSH servers.
                        </p>
                      </div>
                    ) : (
                      <DotfilePoolFileTable
                        files={activeFiles}
                        statuses={statuses}
                        onUpdate={updateFile}
                        onRemove={removeFile}
                        onRefresh={(id) => void handleRefreshFile(id)}
                      />
                    )}
                  </div>
                </div>

                <div className="flex items-center justify-between border-t border-divider bg-app-surface px-5 py-3">
                  <button
                    type="button"
                    onClick={() => void handleDelete(draft.id)}
                    className="flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-app-surface-hover transition-colors"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete Pool
                  </button>
                  <div className="flex items-center gap-3">
                    {justSaved && !dirty ? (
                      <span role="status" className="flex items-center gap-1 text-xs font-medium text-emerald-400">
                        <Check className="h-3.5 w-3.5" />
                        Saved
                      </span>
                    ) : dirty ? (
                      <span className="flex items-center gap-1.5 text-xs text-amber-300">
                        <span className="h-1.5 w-1.5 rounded-full bg-amber-300" />
                        Unsaved changes
                      </span>
                    ) : null}
                    <Button
                      variant="primary"
                      className="px-4"
                      disabled={!draft.name.trim() || saving || !dirty}
                      onClick={() => void handleSave()}
                    >
                      {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                      Save Pool
                    </Button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {gitImportOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4">
          <div ref={gitImportDialogRef} role="dialog" aria-modal="true" aria-label="Import dotfiles from Git" className="flex w-full max-w-md flex-col rounded-xl border border-border-subtle bg-app-card shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between border-b border-divider bg-app-surface px-4 py-3">
              <div className="flex items-center gap-2">
                <GitBranch className="h-4 w-4 text-sky-400" />
                <span className="text-sm font-semibold text-txt-primary">Import Dotfiles from Git</span>
              </div>
              <button
                aria-label="Close"
                title="Close"
                type="button"
                onClick={() => setGitImportOpen(false)}
                disabled={gitImporting}
                className="rounded-lg p-1 text-txt-muted hover:text-txt-primary"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={handleGitImport} className="p-4 space-y-3 text-xs">
              <p className="text-txt-secondary">
                Enter a GitHub repo (<code>username/dotfiles</code>) or any Git clone URL. The repository will be scanned for shell and editor configuration files.
              </p>
              <input
                aria-label="Git repository"
                type="text"
                autoFocus
                required
                value={gitImportUrl}
                onChange={(e) => setGitImportUrl(e.target.value)}
                placeholder="username/dotfiles or https://github.com/..."
                className="w-full rounded-lg border border-border-subtle bg-app-surface px-3 py-2 text-txt-primary placeholder:text-txt-muted/60 focus:border-sky-500 focus:outline-none"
              />
              {gitImportError && (
                <div role="alert" className="flex items-start gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 p-2.5 text-red-300">
                  <ShieldAlert className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <span>{gitImportError}</span>
                </div>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setGitImportOpen(false)}
                  disabled={gitImporting}
                  className="rounded-lg px-3 py-1.5 text-txt-secondary hover:bg-app-surface-hover disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!gitImportUrl.trim() || gitImporting}
                  className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3.5 py-1.5 font-medium text-white hover:bg-sky-500 disabled:opacity-50"
                >
                  {gitImporting && <Loader2 className="h-3 w-3 animate-spin" />}
                  {gitImporting ? 'Importing…' : 'Import'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default DotfilePoolManagerModal;
