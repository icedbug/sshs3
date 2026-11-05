import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Layers } from 'lucide-react';
import { folderIconComponent } from './teamFolderIcons';
import { countTeamFolderProfiles, folderAncestors, type TeamFolderNode } from './teamFolderTree';

interface TeamFolderSidebarProps {
  /** Only the shape of the tree matters here, not what kind of profile the folders hold. */
  roots: TeamFolderNode<unknown>[];
  /** Profiles without a folder; with the folders' profiles they make up the total shown for "All folders". */
  ungroupedCount: number;
  /** The folder being browsed, as segment names from the root (the same state the breadcrumb uses). */
  currentPath: string[];
  onNavigate: (path: string[]) => void;
  /** A profile was dropped on a folder (its full path) or on "All folders" (`undefined`: take it out of its folder). */
  onDropProfile: (targetPath: string | undefined, e: React.DragEvent) => void;
}

const profileCount = (n: number) => `${n} profile${n === 1 ? '' : 's'}`;

const ROW =
  'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500';

/**
 * The Team Vault's folder tree as an always-visible list beside the profiles: pick a folder to
 * browse it (the same `currentPath` the breadcrumb uses), see how many profiles each holds, and drop
 * a profile on a folder to move it there. Folders are created, renamed and deleted from the folder
 * rows in the main pane, not here.
 */
export function TeamFolderSidebar({
  roots,
  ungroupedCount,
  currentPath,
  onNavigate,
  onDropProfile,
}: TeamFolderSidebarProps): React.ReactElement {
  // Folders the user opened (by full path). The ones above the current folder are always opened too,
  // so the folder being browsed is never hidden inside a closed parent.
  const [open, setOpen] = useState<Set<string>>(() => new Set(folderAncestors(currentPath)));
  const [dragOver, setDragOver] = useState<string | null>(null);

  const currentKey = currentPath.join('/');
  useEffect(() => {
    const ancestors = folderAncestors(currentKey === '' ? [] : currentKey.split('/'));
    if (ancestors.length > 0) setOpen((prev) => new Set([...prev, ...ancestors]));
  }, [currentKey]);

  const total = roots.reduce((sum, node) => sum + countTeamFolderProfiles(node), 0) + ungroupedCount;

  const toggle = (path: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const dropProps = (target: string | undefined) => ({
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (dragOver !== (target ?? '')) setDragOver(target ?? '');
    },
    onDragLeave: () => {
      if (dragOver === (target ?? '')) setDragOver(null);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(null);
      onDropProfile(target, e);
    },
  });

  const rowClasses = (current: boolean, target: string) =>
    `${ROW} ${
      dragOver === target
        ? 'bg-sky-500/15 text-sky-300'
        : current
          ? 'bg-app-surface-hover font-medium text-txt-primary'
          : 'text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary'
    }`;

  const renderNode = (node: TeamFolderNode<unknown>, depth: number): React.ReactNode => {
    const FolderIcon = folderIconComponent(node.icon);
    const isOpen = open.has(node.path);
    const isCurrent = node.path === currentKey;
    const hasChildren = node.children.length > 0;
    return (
      <li key={node.path}>
        <div className="flex items-center" style={{ paddingLeft: depth * 12 }}>
          {hasChildren ? (
            <button
              type="button"
              aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${node.name}`}
              aria-expanded={isOpen}
              onClick={() => toggle(node.path)}
              className="shrink-0 rounded p-0.5 text-txt-muted hover:text-txt-primary"
            >
              {isOpen ? <ChevronDown className="h-3 w-3" aria-hidden="true" /> : <ChevronRight className="h-3 w-3" aria-hidden="true" />}
            </button>
          ) : (
            <span className="w-4 shrink-0" aria-hidden="true" />
          )}
          <button
            type="button"
            aria-current={isCurrent ? 'page' : undefined}
            aria-label={`${node.name} (${profileCount(countTeamFolderProfiles(node))})`}
            onClick={() => onNavigate(node.path.split('/'))}
            className={rowClasses(isCurrent, node.path)}
            {...dropProps(node.path)}
          >
            <FolderIcon className="h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{node.name}</span>
            <span className="shrink-0 text-2xs text-txt-muted">{countTeamFolderProfiles(node)}</span>
          </button>
        </div>
        {hasChildren && isOpen && <ul>{node.children.map((child) => renderNode(child, depth + 1))}</ul>}
      </li>
    );
  };

  return (
    <nav aria-label="Folders" className="w-48 shrink-0">
      <ul className="space-y-0.5">
        <li>
          <button
            type="button"
            aria-current={currentKey === '' ? 'page' : undefined}
            aria-label={`All folders (${profileCount(total)})`}
            onClick={() => onNavigate([])}
            className={`${rowClasses(currentKey === '', '')} pl-6`}
            {...dropProps(undefined)}
          >
            <Layers className="h-3.5 w-3.5 shrink-0 text-txt-muted" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">All folders</span>
            <span className="shrink-0 text-2xs text-txt-muted">{total}</span>
          </button>
        </li>
        {roots.map((node) => renderNode(node, 0))}
      </ul>
    </nav>
  );
}
