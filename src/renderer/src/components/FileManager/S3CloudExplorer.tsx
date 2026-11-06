import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Cloud,
  Database,
  Folder,
  FolderPlus,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Search,
  UploadCloud,
} from 'lucide-react';
import type { FileEntry } from '@shared/types/storage';
import { describeIpcError, joinPath } from '../../lib/format';
import { S3InspectorPanel } from './S3InspectorPanel';

export interface S3CloudExplorerProps {
  providerId: string;
  providerLabel: string;
  currentPath: string;
  entries?: FileEntry[];
  selectedEntries?: FileEntry[];
  onNavigate: (path: string) => void;
  onRefresh?: () => void;
  onCreateBucketOrFolder?: (name: string) => Promise<void> | void;
  onUploadDrop?: (files: string[], targetPath: string) => void;
  inspectorOpen?: boolean;
  onToggleInspector?: () => void;
  children?: React.ReactNode;
}

export const S3CloudExplorer: React.FC<S3CloudExplorerProps> = ({
  providerId,
  providerLabel,
  currentPath,
  entries = [],
  selectedEntries = [],
  onNavigate,
  onRefresh,
  onCreateBucketOrFolder,
  onUploadDrop,
  inspectorOpen = true,
  onToggleInspector,
  children,
}) => {
  const [buckets, setBuckets] = useState<FileEntry[]>([]);
  const [prefixesByBucket, setPrefixesByBucket] = useState<Record<string, FileEntry[]>>({});
  const [expandedBuckets, setExpandedBuckets] = useState<Set<string>>(new Set());
  const [treeFilter, setTreeFilter] = useState('');
  const [loadingBuckets, setLoadingBuckets] = useState(false);
  const [creatingBucket, setCreatingBucket] = useState(false);
  const [newBucketName, setNewBucketName] = useState('');
  const [treeError, setTreeError] = useState<string | null>(null);
  const [dragHover, setDragHover] = useState(false);

  const activeBucketName = useMemo(() => {
    const clean = (currentPath || '/').replace(/^\/+/, '');
    const first = clean.split('/').filter(Boolean)[0];
    return first || '';
  }, [currentPath]);

  const loadRootBuckets = useCallback(async () => {
    if (!window.multissh?.storageList) return;
    setLoadingBuckets(true);
    setTreeError(null);
    try {
      const rootItems = await window.multissh.storageList(providerId, '/');
      if (Array.isArray(rootItems)) {
        const dirs = rootItems.filter((item) => item.isDirectory);
        setBuckets(dirs);
      }
    } catch (err) {
      setTreeError(describeIpcError(err, 'Kunde inte hämta S3-buckets'));
    } finally {
      setLoadingBuckets(false);
    }
  }, [providerId]);

  useEffect(() => {
    const isRoot = !currentPath || currentPath === '/';
    if (!isRoot && buckets.length === 0) {
      void loadRootBuckets();
    }
  }, [currentPath, buckets.length, loadRootBuckets]);

  // Keep current directory's folders synced into buckets (at '/') or prefixes (inside a bucket)
  useEffect(() => {
    if (!activeBucketName) {
      const dirs = entries.filter((e) => e.isDirectory);
      setBuckets(dirs);
      return;
    }
    setExpandedBuckets((prev) => {
      if (prev.has(activeBucketName)) return prev;
      const next = new Set(prev);
      next.add(activeBucketName);
      return next;
    });
    const subFolders = entries.filter((e) => e.isDirectory);
    if (subFolders.length > 0) {
      setPrefixesByBucket((prev) => ({
        ...prev,
        [activeBucketName]: subFolders,
      }));
    }
  }, [activeBucketName, entries]);

  const toggleBucketExpand = async (bucket: FileEntry) => {
    const bName = bucket.name;
    const isExpanded = expandedBuckets.has(bName);
    const next = new Set(expandedBuckets);
    if (isExpanded) {
      next.delete(bName);
      setExpandedBuckets(next);
      return;
    }
    next.add(bName);
    setExpandedBuckets(next);
    if (!prefixesByBucket[bName] && window.multissh?.storageList) {
      try {
        const items = await window.multissh.storageList(providerId, bucket.path);
        if (Array.isArray(items)) {
          setPrefixesByBucket((prev) => ({
            ...prev,
            [bName]: items.filter((i) => i.isDirectory),
          }));
        }
      } catch {
        // Ignore prefix list error
      }
    }
  };

  const filteredBuckets = useMemo(() => {
    const q = treeFilter.trim().toLowerCase();
    if (!q) return buckets;
    return buckets.filter((b) => {
      if (b.name.toLowerCase().includes(q)) return true;
      const prefixes = prefixesByBucket[b.name] || [];
      return prefixes.some((p) => p.name.toLowerCase().includes(q));
    });
  }, [buckets, prefixesByBucket, treeFilter]);

  const handleCreateBucketSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newBucketName.trim();
    if (!trimmed) return;
    try {
      if (onCreateBucketOrFolder) {
        await onCreateBucketOrFolder(trimmed);
      } else if (window.multissh?.storageCreateFolder) {
        const target = currentPath === '/' || !currentPath ? `/${trimmed}` : joinPath(currentPath, trimmed);
        await window.multissh.storageCreateFolder(providerId, target);
      }
      setNewBucketName('');
      setCreatingBucket(false);
      await loadRootBuckets();
      onRefresh?.();
    } catch (err) {
      setTreeError(describeIpcError(err, 'Kunde inte skapa bucket/prefix'));
    }
  };

  return (
    <div
      data-testid="s3-cloud-explorer"
      className="flex min-h-0 flex-1 overflow-hidden rounded-xl border border-border-subtle bg-app-card"
    >
      {/* Left Column: S3 Bucket & Prefix Tree */}
      <aside
        data-testid="s3-bucket-tree"
        aria-label="S3 Bucket and Prefix Tree"
        className="flex h-full w-60 shrink-0 flex-col border-r border-divider bg-app-surface text-xs"
      >
        <div className="flex items-center justify-between border-b border-divider px-3 py-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <Database className="h-3.5 w-3.5 shrink-0 text-amber-400" />
            <span className="truncate font-semibold text-txt-primary">Buckets &amp; Prefix</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              data-testid="s3-bucket-create-trigger"
              title="Skapa ny bucket eller prefix"
              aria-label="Skapa ny bucket eller prefix"
              onClick={() => setCreatingBucket((prev) => !prev)}
              className="rounded p-1 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
            >
              <FolderPlus className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title="Uppdatera bucket-träd"
              aria-label="Uppdatera bucket-träd"
              onClick={() => void loadRootBuckets()}
              className="rounded p-1 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Filter Input */}
        <div className="border-b border-divider p-2">
          <div className="flex items-center gap-1.5 rounded-md border border-border-subtle bg-app-input px-2 py-1">
            <Search className="h-3 w-3 shrink-0 text-txt-muted" />
            <input
              type="text"
              data-testid="s3-bucket-tree-filter"
              aria-label="Filtrera buckets och prefix"
              placeholder="Filtrera buckets..."
              value={treeFilter}
              onChange={(e) => setTreeFilter(e.target.value)}
              className="w-full bg-transparent text-xs text-txt-primary outline-none placeholder:text-txt-muted"
            />
          </div>
        </div>

        {/* Inline Bucket / Prefix Creation Form */}
        {creatingBucket && (
          <form onSubmit={handleCreateBucketSubmit} className="border-b border-divider bg-app-card p-2 space-y-1.5">
            <input
              type="text"
              data-testid="s3-bucket-create-input"
              placeholder={activeBucketName ? 'Nytt prefix...' : 'Nytt bucket-namn...'}
              value={newBucketName}
              onChange={(e) => setNewBucketName(e.target.value)}
              autoFocus
              className="w-full rounded border border-border-subtle bg-app-input px-2 py-1 text-xs text-txt-primary outline-none focus:border-sky-500"
            />
            <div className="flex justify-end gap-1">
              <button
                type="button"
                onClick={() => setCreatingBucket(false)}
                className="rounded px-2 py-0.5 text-2xs text-txt-muted hover:text-txt-primary"
              >
                Avbryt
              </button>
              <button
                type="submit"
                data-testid="s3-bucket-create-submit"
                className="rounded bg-sky-600 px-2 py-0.5 text-2xs font-medium text-white hover:bg-sky-500"
              >
                Skapa
              </button>
            </div>
          </form>
        )}

        {treeError && (
          <div
            role="alert"
            className="mx-2 mt-1.5 rounded border border-red-800/60 bg-red-950/30 p-1.5 text-2xs text-red-300"
          >
            {treeError}
          </div>
        )}

        {/* Tree Nodes */}
        <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
          <button
            type="button"
            data-testid="s3-tree-root-btn"
            onClick={() => onNavigate('/')}
            className={
              'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs transition-colors ' +
              (currentPath === '/' || !currentPath
                ? 'bg-sky-500/20 text-sky-400 font-semibold'
                : 'text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary')
            }
          >
            <Cloud className="h-3.5 w-3.5 shrink-0 text-amber-400" />
            <span className="truncate">{providerLabel} (Alla buckets)</span>
          </button>

          {loadingBuckets && buckets.length === 0 && (
            <div className="flex items-center gap-1.5 px-2 py-3 text-2xs text-txt-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-400" />
              Laddar buckets...
            </div>
          )}

          {filteredBuckets.map((bucket) => {
            const isExpanded = expandedBuckets.has(bucket.name);
            const isSelectedBucket = activeBucketName === bucket.name;
            const prefixes = prefixesByBucket[bucket.name] || [];

            return (
              <div key={bucket.path} className="space-y-0.5">
                <div
                  className={
                    'flex items-center gap-1 rounded-md px-1.5 py-1 transition-colors ' +
                    (isSelectedBucket && currentPath === bucket.path
                      ? 'bg-sky-500/20 text-sky-400 font-semibold'
                      : isSelectedBucket
                        ? 'bg-app-surface-subtle text-txt-primary font-medium'
                        : 'text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary')
                  }
                >
                  <button
                    type="button"
                    aria-label={`Expandera ${bucket.name}`}
                    onClick={() => void toggleBucketExpand(bucket)}
                    className="rounded p-0.5 text-txt-muted hover:text-txt-primary"
                  >
                    {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  </button>
                  <button
                    type="button"
                    data-testid={`s3-tree-bucket-${bucket.name}`}
                    onClick={() => onNavigate(bucket.path)}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  >
                    <Database className="h-3.5 w-3.5 shrink-0 text-amber-400" />
                    <span className="truncate">{bucket.name}</span>
                  </button>
                </div>

                {isExpanded && prefixes.length > 0 && (
                  <div className="ml-4 border-l border-divider pl-1.5 space-y-0.5">
                    {prefixes.map((pref) => {
                      const isPrefActive = currentPath === pref.path;
                      return (
                        <button
                          key={pref.path}
                          type="button"
                          data-testid={`s3-tree-prefix-${pref.name}`}
                          onClick={() => onNavigate(pref.path)}
                          className={
                            'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs transition-colors ' +
                            (isPrefActive
                              ? 'bg-sky-500/20 text-sky-400 font-semibold'
                              : 'text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary')
                          }
                        >
                          <Folder className="h-3 w-3 shrink-0 text-sky-400" />
                          <span className="truncate">{pref.name}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </aside>

      {/* Middle Column: Virtualized Object Table & Drag-and-Drop Dropzone */}
      <div
        data-testid="s3-object-table"
        className={
          'relative flex min-h-0 min-w-0 flex-1 flex-col ' +
          (dragHover ? 'ring-2 ring-inset ring-sky-500/70 bg-sky-500/5' : '')
        }
        onDragOver={(e) => {
          e.preventDefault();
          setDragHover(true);
        }}
        onDragLeave={() => setDragHover(false)}
        onDrop={(e) => {
          setDragHover(false);
          if (onUploadDrop && e.dataTransfer?.files?.length) {
            const paths = Array.from(e.dataTransfer.files)
              .map((f) => (window.multissh?.getPathForFile ? window.multissh.getPathForFile(f) : (f as any).path || f.name))
              .filter(Boolean);
            if (paths.length > 0) {
              e.preventDefault();
              e.stopPropagation();
              onUploadDrop(paths, currentPath);
            }
          }
        }}
      >
        {/* S3 Cloud Header Bar */}
        <div className="flex items-center justify-between border-b border-divider bg-app-surface-subtle px-3 py-1 text-2xs text-txt-secondary">
          <div className="flex items-center gap-2 min-w-0">
            <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 border border-amber-500/30 px-1.5 py-0.5 font-semibold text-amber-400">
              <UploadCloud className="h-3 w-3" />
              S3 Object Table
            </span>
            <span className="truncate font-mono text-txt-muted">
              Dra och släpp filer här för direkt S3-uppladdning
            </span>
          </div>
          {onToggleInspector && (
            <button
              type="button"
              data-testid="s3-cloud-inspector-toggle"
              onClick={onToggleInspector}
              className="inline-flex items-center gap-1 rounded border border-border-subtle bg-app-card px-2 py-0.5 text-2xs font-medium text-txt-secondary hover:text-txt-primary"
            >
              {inspectorOpen ? <PanelRightClose className="h-3 w-3" /> : <PanelRightOpen className="h-3 w-3" />}
              <span>{inspectorOpen ? 'Dölj Inspector' : 'Visa Inspector'}</span>
            </button>
          )}
        </div>

        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </div>

      {/* Right Column: Dedicated S3 Inspector Panel */}
      {inspectorOpen && (
        <S3InspectorPanel
          providerId={providerId}
          providerLabel={providerLabel}
          currentPath={currentPath}
          entries={entries}
          selectedEntries={selectedEntries}
          onRefresh={onRefresh}
        />
      )}
    </div>
  );
};

export default S3CloudExplorer;
