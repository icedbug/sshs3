import React, { useState } from 'react';
import { ArrowLeft, ChevronRight, Folder, FolderPlus, Pencil, Trash2 } from 'lucide-react';
import { TEAM_FOLDER_ICONS } from '@shared/types/teamVault';
import { FOLDER_ICON_COMPONENTS, folderIconComponent } from './teamFolderIcons';
import type { TeamFolderNode } from './teamFolderTree';
import { findFolderNode, flattenTeamFolderTree } from './teamFolderTree';

interface TeamProfileTreeProps<T> {
  roots: TeamFolderNode<T>[];
  ungrouped: T[];
  /** Breadcrumb position — segment names from the root, e.g. `['Acme Infra', 'Cluster A']`.
   * Lifted to `ConnectionManagerModal` so it survives re-renders of this component. */
  currentPath: string[];
  onNavigate: (path: string[]) => void;
  /** The connection search query (already the same trimmed string driving `filteredTeamSSH`/
   * `filteredTeamS3` in the parent) — non-empty switches this component into a flat,
   * path-labeled search-results list instead of card/breadcrumb navigation. */
  query: string;
  renderProfile: (profile: T) => React.ReactNode;
  /** Draws the profiles of one folder (or the ungrouped ones) as a whole instead of one `renderProfile` row each,
   * so a caller can group them, for example into systems. Not used for search results. */
  renderProfileList?: (profiles: T[]) => React.ReactNode;
  onDropProfile: (targetPath: string | undefined, e: React.DragEvent) => void;
  onCreateFolder: (fullPath: string) => Promise<void> | void;
  onRenameFolder: (oldPath: string, newPath: string) => Promise<void> | void;
  onDeleteFolder: (path: string) => Promise<void> | void;
  onSetFolderIcon: (path: string, icon: string | undefined) => Promise<void> | void;
}

/**
 * Browses the shared, arbitrarily-deep Team Vault folder tree (see `teamFolderTree.ts`) as a
 * list of folder rows with breadcrumb drill-down — one level visible at a time, navigated by clicking a
 * folder row or a breadcrumb segment — rather than an always-expanded indented tree. Modeled
 * visually on `feature/connection-system-model`'s `SystemCardGrid`/breadcrumb pattern (kept only
 * as a UI reference, not reused as code: that branch's `ConnectionSystem` is a separate typed
 * entity with its own id/parentSystemId, while a Team Vault folder is just a `/`-separated path
 * segment on `TeamFolderNode`).
 */
export function TeamProfileTree<T>({
  roots,
  ungrouped,
  currentPath,
  onNavigate,
  query,
  renderProfile,
  renderProfileList,
  onDropProfile,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onSetFolderIcon,
}: TeamProfileTreeProps<T>): React.ReactElement {
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [iconPickerPath, setIconPickerPath] = useState<string | null>(null);

  const commitNewFolder = () => {
    const trimmed = newFolderName.trim();
    setCreatingFolder(false);
    setNewFolderName('');
    if (!trimmed) return;
    void onCreateFolder([...currentPath, trimmed].join('/'));
  };

  const commitRename = (node: TeamFolderNode<T>) => {
    const trimmed = renameValue.trim();
    setRenamingPath(null);
    if (!trimmed || trimmed === node.name) return;
    const parentSegments = node.path.split('/').slice(0, -1);
    void onRenameFolder(node.path, [...parentSegments, trimmed].join('/'));
  };

  const renderList = (profiles: T[]) =>
    renderProfileList ? renderProfileList(profiles) : profiles.map((p) => renderProfile(p));

  const dropZoneClasses = (path: string | undefined, active: boolean) =>
    active && dragOverPath === (path ?? '')
      ? 'border-sky-400 bg-sky-500/15'
      : 'border-border-subtle bg-app-card hover:border-sky-500/40 hover:bg-app-surface-hover';

  // Search mode: ignore currentPath entirely and list every match (roots/ungrouped are already
  // query-filtered by the parent) flat, each labeled with its own folder path, so the user never
  // has to drill down to find where a remembered profile lives.
  const trimmedQuery = query.trim();
  if (trimmedQuery) {
    const results = flattenTeamFolderTree(roots, ungrouped);
    return (
      <div className="space-y-1.5">
        <p className="px-2 text-xs font-semibold text-txt-muted">Search results for &quot;{trimmedQuery}&quot;</p>
        {results.length === 0 ? (
          <p className="px-2 py-4 text-center text-xs text-txt-muted">No matches</p>
        ) : (
          <div className="flex flex-col gap-2">
            {results.map(({ profile, path }, i) => (
              <div key={i} className="space-y-0.5">
                <p className="px-2 text-2xs text-txt-muted">{path ?? 'Ungrouped'}</p>
                {renderProfile(profile)}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  const path = currentPath ?? [];
  const atRoot = path.length === 0;
  const currentNode = atRoot ? null : findFolderNode(roots ?? [], path);
  const children = atRoot ? (roots ?? []) : (currentNode?.children ?? []);
  const profilesHere = atRoot ? [] : (currentNode?.profiles ?? []);

  const renderRow = (node: TeamFolderNode<T>) => {
    const isRenaming = renamingPath === node.path;
    const isPickingIcon = iconPickerPath === node.path;
    const open = () => onNavigate([...path, node.name]);
    const FolderIcon = folderIconComponent(node.icon);
    const profiles = node.profiles ?? [];
    const subfolders = node.children ?? [];
    return (
      <div
        key={node.path}
        data-folder-path={node.path}
        onClick={() => {
          if (!isRenaming) open();
        }}
        tabIndex={isRenaming ? undefined : 0}
        onKeyDown={(e) => {
          if (isRenaming) return;
          if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            open();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (dragOverPath !== node.path) setDragOverPath(node.path);
        }}
        onDragLeave={() => {
          if (dragOverPath === node.path) setDragOverPath(null);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOverPath(null);
          onDropProfile(node.path, e);
        }}
        className={`group relative flex items-center gap-3 rounded-lg border px-3 py-2 transition-colors ${
          isRenaming ? '' : 'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500'
        } ${isPickingIcon ? 'z-10' : ''} ${dropZoneClasses(node.path, true)}`}
      >
        <button
          aria-label="Change folder icon"
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setIconPickerPath(isPickingIcon ? null : node.path);
          }}
          title="Change folder icon"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-400 hover:bg-amber-500/25 transition-colors"
        >
          <FolderIcon className="h-4 w-4" />
        </button>
        {isPickingIcon && (
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute left-3 top-11 z-10 grid w-48 grid-cols-6 gap-1 rounded-lg border border-border-subtle bg-app-surface p-2 shadow-xl"
          >
            {TEAM_FOLDER_ICONS.map((key) => {
              const Icon = FOLDER_ICON_COMPONENTS.get(key)!;
              const selected = (node.icon ?? 'folder') === key;
              return (
                <button
                  key={key}
                  type="button"
                  title={key}
                  aria-label={`Folder icon: ${key}`}
                  aria-pressed={selected}
                  onClick={(e) => {
                    e.stopPropagation();
                    setIconPickerPath(null);
                    void onSetFolderIcon(node.path, key === 'folder' ? undefined : key);
                  }}
                  className={`flex h-7 w-7 items-center justify-center rounded transition-colors ${
                    selected ? 'bg-sky-500/25 text-sky-300' : 'text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                </button>
              );
            })}
          </div>
        )}
        <div className="min-w-0 flex-1 text-left">
          {isRenaming ? (
            <input
              type="text"
              autoFocus
              value={renameValue}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename(node);
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setRenamingPath(null);
                }
              }}
              className="w-full rounded border border-sky-500 bg-app-input px-1.5 py-0.5 text-xs text-txt-primary outline-none cursor-text"
            />
          ) : (
            <div className="truncate text-xs font-semibold text-txt-primary">{node.name}</div>
          )}
          <div className="text-2xs text-txt-muted">
            {profiles.length === 0 && subfolders.length === 0
              ? 'Empty'
              : [
                  profiles.length > 0 ? `${profiles.length} profile${profiles.length === 1 ? '' : 's'}` : null,
                  subfolders.length > 0 ? `${subfolders.length} subfolder${subfolders.length === 1 ? '' : 's'}` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
          </div>
        </div>
        {/* Shown on hover or keyboard focus, so a long list is not a wall of identical icons. */}
        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <button
            aria-label="Rename folder"
            type="button"
            title="Rename folder"
            onClick={(e) => {
              e.stopPropagation();
              setRenamingPath(node.path);
              setRenameValue(node.name);
            }}
            className="rounded p-1 text-txt-muted hover:text-txt-primary transition-colors"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            aria-label="Delete folder (ungroups profiles inside, including subfolders)"
            type="button"
            title="Delete folder (ungroups profiles inside, including subfolders)"
            onClick={(e) => {
              e.stopPropagation();
              void onDeleteFolder(node.path);
            }}
            className="rounded p-1 text-txt-muted hover:text-red-400 transition-colors"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
        <button
          type="button"
          title={`Open ${node.name}`}
          aria-label={`Open ${node.name}`}
          onClick={(e) => {
            e.stopPropagation();
            open();
          }}
          className="shrink-0 rounded p-1 text-txt-muted hover:text-sky-400 transition-colors"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    );
  };

  return (
    <div className="space-y-2">
      {!atRoot && (
        <div className="flex flex-wrap items-center gap-1 px-2 text-xs text-txt-muted">
          <button
            type="button"
            onClick={() => onNavigate(path.slice(0, -1))}
            className="flex items-center gap-1 rounded-lg px-1.5 py-1 hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back
          </button>
          <span className="mx-1">/</span>
          <button type="button" onClick={() => onNavigate([])} className="hover:text-txt-primary transition-colors">
            All folders
          </button>
          {path.map((name, i) => (
            <React.Fragment key={i}>
              <ChevronRight className="h-3 w-3" />
              <button
                type="button"
                onClick={() => onNavigate(path.slice(0, i + 1))}
                onDragOver={(e) => {
                  if (i === path.length - 1) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  const targetPath = path.slice(0, i + 1).join('/');
                  if (dragOverPath !== targetPath) setDragOverPath(targetPath);
                }}
                onDrop={(e) => {
                  if (i === path.length - 1) return;
                  e.preventDefault();
                  setDragOverPath(null);
                  onDropProfile(path.slice(0, i + 1).join('/'), e);
                }}
                className={
                  i === path.length - 1
                    ? 'font-medium text-txt-primary'
                    : `rounded px-1 transition-colors hover:text-txt-primary ${
                        dragOverPath === path.slice(0, i + 1).join('/') ? 'bg-sky-500/15 text-sky-300' : ''
                      }`
                }
              >
                {name}
              </button>
            </React.Fragment>
          ))}
        </div>
      )}

      {iconPickerPath !== null && (
        // Transparent, full-area click-outside-to-close target — sits below the picker's own
        // z-10 popover (rendered per-row above) but above everything else, so clicking anywhere
        // other than the open picker dismisses it.
        <div data-testid="icon-picker-backdrop" className="fixed inset-0 z-[5]" onClick={() => setIconPickerPath(null)} />
      )}

      {children.length > 0 && (
        <div className="flex flex-col gap-1.5">{children.map((node) => renderRow(node))}</div>
      )}

      {!atRoot && profilesHere.length > 0 && (
        <div className="flex flex-col gap-1.5 px-2">{renderList(profilesHere)}</div>
      )}

      {creatingFolder ? (
        <div className="flex items-center gap-1.5 px-2 py-1">
          <Folder className="h-3.5 w-3.5 text-txt-muted" />
          <input
            type="text"
            autoFocus
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitNewFolder();
              if (e.key === 'Escape') {
                e.stopPropagation();
                setCreatingFolder(false);
                setNewFolderName('');
              }
            }}
            onBlur={commitNewFolder}
            placeholder="Folder name"
            className="rounded border border-sky-500 bg-app-input px-1.5 py-0.5 text-xs text-txt-primary outline-none"
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            setCreatingFolder(true);
            setNewFolderName('');
          }}
          className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-txt-muted hover:text-txt-secondary transition-colors"
        >
          <FolderPlus className="h-3.5 w-3.5" />
          {atRoot ? 'New top-level folder' : 'New subfolder'}
        </button>
      )}

      {atRoot && ungrouped.length > 0 && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (dragOverPath !== '') setDragOverPath('');
          }}
          onDragLeave={() => {
            if (dragOverPath === '') setDragOverPath(null);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDragOverPath(null);
            onDropProfile(undefined, e);
          }}
          className={`space-y-1.5 rounded-lg border p-1 transition-colors ${
            dragOverPath === '' ? 'border-dashed border-sky-400 bg-sky-500/15' : 'border-transparent'
          }`}
        >
          <p className="px-2 text-xs font-semibold text-txt-muted">Ungrouped</p>
          <div className="flex flex-col gap-1.5 px-2">{renderList(ungrouped)}</div>
        </div>
      )}
    </div>
  );
}
