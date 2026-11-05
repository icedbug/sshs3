import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { makeNameMatcher } from '../../lib/nameFilter';
import { sortFileEntries, type FileSortDir as SortDir, type FileSortKey as SortKey } from '../../lib/fileSort';
import { useVirtualizer } from '@tanstack/react-virtual';
import { File, FileArchive, FileCode, FileImage, FileText, Folder, GitBranch, Loader2, Search } from 'lucide-react';
import type { FileEntry } from '@shared/types/storage';
import { classNames, formatBytes } from '../../lib/format';


interface FileListProps {
  entries: FileEntry[];
  loading: boolean;
  selectedPaths: Set<string>;
  onSelectionChange: (paths: Set<string>) => void;
  /** Moves the keyboard focus (what Enter and the arrow keys act on) to `path`; a new `id` re-applies the same path. */
  focusRequest?: { path: string; id: number } | null;
  onOpen: (entry: FileEntry) => void;
  /** Return true when the drag was handed to the OS (default prevented): the click that follows then must not change the selection. */
  onDraggableStart?: (entry: FileEntry, e: React.DragEvent) => boolean | void;
  onDraggableEnd?: () => void;
  isDropTarget?: (entry: FileEntry) => boolean;
  onEntryDrop?: (entry: FileEntry, e: React.DragEvent) => void;
  onEntryDragOver?: (entry: FileEntry, e: React.DragEvent) => void;
  onEntryDragLeave?: (entry: FileEntry) => void;
  onPaneDrop?: (e: React.DragEvent) => void;
  dragOverPath?: string | null;
  renamingPath?: string | null;
  onRenameCommit?: (entry: FileEntry, newName: string) => void;
  onRenameCancel?: () => void;
  filterText?: string;
  onEntryContextMenu?: (entry: FileEntry, e: React.MouseEvent) => void;
  onPaneContextMenu?: (e: React.MouseEvent) => void;
  onRenameStart?: () => void;
  onRefresh?: () => void;
  onNavigateParent?: () => void;
  onNavigateBack?: () => void;
  onNavigateForward?: () => void;
  onCopySelected?: () => void;
  onCutSelected?: () => void;
  onPaste?: () => void;
  cutPaths?: Set<string>;
  /** Invoked when the user presses Delete/Backspace with a selection and no rename/typeahead in progress. */
  onDeleteSelected?: () => void;
}

function iconForEntry(entry: FileEntry) {
  if (entry.name === '.git') return GitBranch;
  if (entry.isDirectory) return Folder;
  const ext = entry.name.split('.').pop()?.toLowerCase() ?? '';
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp'].includes(ext)) return FileImage;
  if (['zip', 'tar', 'gz', 'tgz', 'rar', '7z'].includes(ext)) return FileArchive;
  if (['ts', 'tsx', 'js', 'jsx', 'json', 'py', 'go', 'rs', 'c', 'cpp', 'sh', 'yml', 'yaml'].includes(ext)) return FileCode;
  if (['txt', 'md', 'log', 'csv'].includes(ext)) return FileText;
  return File;
}

// Dense desktop row height (was 33px); fits ~25% more entries per pane.
const FILE_ROW_HEIGHT = 26;

export const FileList: React.FC<FileListProps> = ({
  entries,
  loading,
  selectedPaths,
  onSelectionChange,
  focusRequest,
  onOpen,
  onDraggableStart,
  isDropTarget,
  onEntryDrop,
  onEntryDragOver,
  onEntryDragLeave,
  onPaneDrop,
  onDraggableEnd,
  dragOverPath,
  renamingPath,
  onRenameCommit,
  onRenameCancel,
  filterText,
  onEntryContextMenu,
  onPaneContextMenu,
  onRenameStart,
  onRefresh,
  onNavigateParent,
  onNavigateBack,
  onNavigateForward,
  onCopySelected,
  onCutSelected,
  onPaste,
  cutPaths,
  onDeleteSelected,
}) => {
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [lastClickedIndex, setLastClickedIndex] = useState<number | null>(null);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [typeaheadText, setTypeaheadText] = useState('');
  const [typeaheadMatch, setTypeaheadMatch] = useState(true);
  const typeaheadBufferRef = useRef('');
  const typeaheadTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const activePath = focusedPath ?? (selectedPaths.size === 1 ? Array.from(selectedPaths)[0] : null);

  useEffect(() => {
    if (focusRequest) setFocusedPath(focusRequest.path);
  }, [focusRequest]);

  useEffect(() => {
    return () => {
      if (typeaheadTimeoutRef.current) {
        clearTimeout(typeaheadTimeoutRef.current);
      }
    };
  }, []);

  const clearTypeahead = useCallback(() => {
    if (typeaheadTimeoutRef.current) {
      clearTimeout(typeaheadTimeoutRef.current);
      typeaheadTimeoutRef.current = null;
    }
    typeaheadBufferRef.current = '';
    setTypeaheadText('');
    setTypeaheadMatch(true);
  }, []);

  const filtered = useMemo(() => {
    if (!(filterText ?? '').trim()) return entries;
    const matches = makeNameMatcher(filterText ?? '');
    // Recursive-filter hits carry a relative path as name; match on the file's own name.
    return entries.filter((e) => matches(e.name.slice(e.name.lastIndexOf('/') + 1)));
  }, [entries, filterText]);

  const sorted = useMemo(() => sortFileEntries(filtered, sortKey, sortDir), [filtered, sortKey, sortDir]);

  const toggleSort = useCallback(
    (key: SortKey) => {
      if (sortKey === key) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
      } else {
        setSortKey(key);
        setSortDir('asc');
      }
    },
    [sortKey]
  );

  const suppressNextClickRef = useRef(false);

  const handleRowClick = useCallback(
    (entry: FileEntry, index: number, e: React.MouseEvent) => {
      if (suppressNextClickRef.current) {
        suppressNextClickRef.current = false;
        return;
      }
      clearTypeahead();
      setFocusedPath(entry.path);
      if (e.shiftKey && lastClickedIndex !== null) {
        const start = Math.min(lastClickedIndex, index);
        const end = Math.max(lastClickedIndex, index);
        const range = new Set(selectedPaths);
        for (let i = start; i <= end; i++) {
          range.add(sorted[i].path);
        }
        onSelectionChange(range);
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        const next = new Set(selectedPaths);
        if (next.has(entry.path)) next.delete(entry.path);
        else next.add(entry.path);
        setLastClickedIndex(index);
        onSelectionChange(next);
        return;
      }
      setLastClickedIndex(index);
      onSelectionChange(new Set([entry.path]));
    },
    [lastClickedIndex, selectedPaths, sorted, onSelectionChange, clearTypeahead]
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const autoScrollRafId = useRef<number | null>(null);
  const scrollSpeedRef = useRef<number>(0);

  const stopAutoScroll = useCallback(() => {
    scrollSpeedRef.current = 0;
    if (autoScrollRafId.current !== null) {
      cancelAnimationFrame(autoScrollRafId.current);
      autoScrollRafId.current = null;
    }
  }, []);

  const updateAutoScroll = useCallback(
    (clientY: number) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const topDist = clientY - rect.top;
      const bottomDist = rect.bottom - clientY;
      const EDGE_THRESHOLD = 50;

      if (topDist >= 0 && topDist < EDGE_THRESHOLD) {
        const intensity = (EDGE_THRESHOLD - topDist) / EDGE_THRESHOLD;
        scrollSpeedRef.current = -Math.round(3 + intensity * 15);
      } else if (bottomDist >= 0 && bottomDist < EDGE_THRESHOLD) {
        const intensity = (EDGE_THRESHOLD - bottomDist) / EDGE_THRESHOLD;
        scrollSpeedRef.current = Math.round(3 + intensity * 15);
      } else {
        scrollSpeedRef.current = 0;
      }

      if (scrollSpeedRef.current !== 0) {
        if (autoScrollRafId.current === null) {
          const step = () => {
            if (scrollSpeedRef.current !== 0 && containerRef.current) {
              containerRef.current.scrollTop += scrollSpeedRef.current;
              autoScrollRafId.current = requestAnimationFrame(step);
            } else {
              autoScrollRafId.current = null;
            }
          };
          autoScrollRafId.current = requestAnimationFrame(step);
        }
      } else {
        stopAutoScroll();
      }
    },
    [stopAutoScroll]
  );

  const springLoadedTimerRef = useRef<NodeJS.Timeout | null>(null);
  const springLoadedTargetRef = useRef<string | null>(null);

  const clearSpringLoadedTimer = useCallback(() => {
    if (springLoadedTimerRef.current) {
      clearTimeout(springLoadedTimerRef.current);
      springLoadedTimerRef.current = null;
    }
    springLoadedTargetRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      stopAutoScroll();
      clearSpringLoadedTimer();
    };
  }, [stopAutoScroll, clearSpringLoadedTimer]);

  const focusElement = useCallback((path: string) => {
    if (!containerRef.current) return;
    const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(path) : path.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const el = containerRef.current.querySelector<HTMLElement>(`[data-entry-path="${escaped}"]`);
    if (el) {
      el.focus({ preventScroll: true });
    }
  }, []);

  // Arrow navigation focuses individual rows; when the directory changes those rows are replaced
  // and the browser drops focus to <body>. Remember that the list owned focus and hand it back.
  const focusWithinRef = useRef(false);
  const handleFocusCapture = useCallback(() => {
    focusWithinRef.current = true;
  }, []);
  const handleBlurCapture = useCallback((e: React.FocusEvent) => {
    if (e.relatedTarget) {
      focusWithinRef.current = containerRef.current?.contains(e.relatedTarget as Node) ?? false;
      return;
    }
    // No new focus target: either the user clicked away (row still mounted) or the row is being removed.
    const target = e.target as HTMLElement;
    setTimeout(() => {
      if (target.isConnected) focusWithinRef.current = false;
    }, 0);
  }, []);
  useEffect(() => {
    const active = document.activeElement;
    if (focusWithinRef.current && (!active || active === document.body)) {
      containerRef.current?.focus({ preventScroll: true });
    }
  }, [entries, loading]);

  const rowVirtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => FILE_ROW_HEIGHT,
    overscan: 10,
    observeElementRect: (instance, cb) => {
      const element = instance.scrollElement;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      const height = rect.height || 600;
      const width = rect.width || 800;
      cb({ width: Math.round(width), height: Math.round(height) });
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        const h = entry?.contentRect?.height || element.getBoundingClientRect().height || 600;
        const w = entry?.contentRect?.width || element.getBoundingClientRect().width || 800;
        cb({ width: Math.round(w), height: Math.round(h) });
      });
      observer.observe(element);
      return () => observer.disconnect();
    },
  });

  useEffect(() => {
    if (!activePath) return;
    const idx = sorted.findIndex((e) => e.path === activePath);
    if (idx >= 0) {
      rowVirtualizer.scrollToIndex(idx, { align: 'auto' });
    }
    focusElement(activePath);
    const timer = setTimeout(() => focusElement(activePath), 40);
    return () => clearTimeout(timer);
  }, [activePath, focusElement, sorted, rowVirtualizer]);

  const searchAndSelect = useCallback(
    (query: string, currentIndex: number) => {
      if (!query || sorted.length === 0) return;
      const q = query.toLowerCase();

      let targetIndex = -1;

      if (q.length === 1) {
        // Cycling: check starting from currentIndex + 1, wrapping around to currentIndex
        for (let i = 1; i <= sorted.length; i++) {
          const idx = (currentIndex + i) % sorted.length;
          if (sorted[idx].name.toLowerCase().startsWith(q)) {
            targetIndex = idx;
            break;
          }
        }
      } else {
        // Multi-character search
        // 1. Try prefix match (startsWith)
        targetIndex = sorted.findIndex((item) => item.name.toLowerCase().startsWith(q));

        // 2. Fallback to substring match (includes)
        if (targetIndex === -1) {
          targetIndex = sorted.findIndex((item) => item.name.toLowerCase().includes(q));
        }
      }

      if (targetIndex !== -1) {
        setTypeaheadMatch(true);
        const match = sorted[targetIndex];
        setFocusedPath(match.path);
        setLastClickedIndex(targetIndex);
        onSelectionChange(new Set([match.path]));
        rowVirtualizer.scrollToIndex(targetIndex, { align: 'auto' });
      } else {
        setTypeaheadMatch(false);
      }
    },
    [sorted, onSelectionChange, rowVirtualizer]
  );

  const handleContainerKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (renamingPath) return;
      if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.stopPropagation();
        onSelectionChange(new Set(sorted.map((item) => item.path)));
        return;
      }

      if (e.key === 'Delete' && selectedPaths.size > 0) {
        e.preventDefault();
        e.stopPropagation();
        onDeleteSelected?.();
        return;
      }

      // Up one level; checked before the empty-list return so an empty folder can still be left. While typeahead is
      // active Backspace edits the search text instead (handled below).
      if (e.key === 'Backspace' && !typeaheadBufferRef.current && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        onNavigateParent?.();
        return;
      }

      if (sorted.length === 0) return;

      const activeIndex = activePath ? sorted.findIndex((item) => item.path === activePath) : -1;
      const firstSelectedIndex = sorted.findIndex((item) => selectedPaths.has(item.path));
      const currentIndex = activeIndex !== -1 ? activeIndex : firstSelectedIndex;
      if (e.key === 'c' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.stopPropagation();
        onCopySelected?.();
        return;
      }

      if (e.key === 'x' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.stopPropagation();
        onCutSelected?.();
        return;
      }

      if (e.key === 'v' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.stopPropagation();
        onPaste?.();
        return;
      }

      if (e.key === 'ArrowLeft' && e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        onNavigateBack?.();
        return;
      }

      if (e.key === 'ArrowRight' && e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        onNavigateForward?.();
        return;
      }

      if (e.key === 'F2') {
        e.preventDefault();
        clearTypeahead();
        if (selectedPaths.size === 1) {
          onRenameStart?.();
        }
        return;
      }

      if (e.key === 'F5') {
        e.preventDefault();
        clearTypeahead();
        onRefresh?.();
        return;
      }

      let matchIndex = -1;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        clearTypeahead();
        if (currentIndex === -1) {
          matchIndex = 0;
        } else {
          matchIndex = currentIndex < sorted.length - 1 ? currentIndex + 1 : 0;
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        clearTypeahead();
        if (e.altKey) {
          onNavigateParent?.();
          return;
        }
        if (currentIndex === -1) {
          matchIndex = sorted.length - 1;
        } else {
          matchIndex = currentIndex > 0 ? currentIndex - 1 : sorted.length - 1;
        }
      } else if (e.key === 'Home') {
        e.preventDefault();
        clearTypeahead();
        matchIndex = 0;
      } else if (e.key === 'End') {
        e.preventDefault();
        clearTypeahead();
        matchIndex = sorted.length - 1;
      } else if (e.key === 'Enter') {
        e.preventDefault();
        clearTypeahead();
        const selected = (activePath && sorted.find((it) => it.path === activePath)) || (selectedPaths.size === 1 ? sorted.find((it) => selectedPaths.has(it.path)) : undefined);
        if (selected) onOpen(selected);
        return;
      } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        e.preventDefault();
        e.stopPropagation();
        clearTypeahead();
        const selected = (activePath && sorted.find((it) => it.path === activePath)) || (selectedPaths.size === 1 ? sorted.find((it) => selectedPaths.has(it.path)) : undefined);
        if (selected && onEntryContextMenu) {
          const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(selected.path) : selected.path.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          const el = containerRef.current?.querySelector<HTMLElement>(`[data-entry-path="${escaped}"]`);
          const rect = el?.getBoundingClientRect();
          const fakeEvent = {
            preventDefault: () => {},
            stopPropagation: () => {},
            clientX: rect ? rect.left + 50 : 200,
            clientY: rect ? rect.top + rect.height / 2 : 200,
          } as unknown as React.MouseEvent;
          onEntryContextMenu(selected, fakeEvent);
        } else if (onPaneContextMenu) {
          const rect = containerRef.current?.getBoundingClientRect();
          const fakeEvent = {
            preventDefault: () => {},
            stopPropagation: () => {},
            clientX: rect ? rect.left + 50 : 200,
            clientY: rect ? rect.top + 50 : 200,
          } as unknown as React.MouseEvent;
          onPaneContextMenu(fakeEvent);
        }
        return;
      } else if (e.key === 'Escape') {
        if (typeaheadBufferRef.current) {
          e.preventDefault();
          clearTypeahead();
          return;
        }
        if (selectedPaths.size > 0 || focusedPath) {
          e.preventDefault();
          setFocusedPath(null);
          onSelectionChange(new Set());
          return;
        }
      } else if (e.key === 'Backspace') {
        if (typeaheadBufferRef.current) {
          e.preventDefault();
          const next = typeaheadBufferRef.current.slice(0, -1);
          typeaheadBufferRef.current = next;
          setTypeaheadText(next);
          if (typeaheadTimeoutRef.current) {
            clearTimeout(typeaheadTimeoutRef.current);
          }
          if (next) {
            typeaheadTimeoutRef.current = setTimeout(() => {
              clearTypeahead();
            }, 1000);
            searchAndSelect(next, currentIndex);
          } else {
            clearTypeahead();
          }
          return;
        }
      } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === ' ' && !typeaheadBufferRef.current) {
          return;
        }
        e.preventDefault();

        const prev = typeaheadBufferRef.current;
        const char = e.key;
        let next: string;

        if (prev.length === 1 && prev.toLowerCase() === char.toLowerCase()) {
          const doubled = prev + char;
          const hasDouble = sorted.some((item) => item.name.toLowerCase().startsWith(doubled.toLowerCase()));
          const hasSingle = sorted.some((item) => item.name.toLowerCase().startsWith(char.toLowerCase()));
          if (hasDouble) {
            next = doubled;
          } else if (hasSingle) {
            next = prev;
          } else {
            next = doubled;
          }
        } else {
          next = prev + char;
        }

        typeaheadBufferRef.current = next;
        setTypeaheadText(next);

        if (typeaheadTimeoutRef.current) {
          clearTimeout(typeaheadTimeoutRef.current);
        }
        typeaheadTimeoutRef.current = setTimeout(() => {
          clearTypeahead();
        }, 1000);

        searchAndSelect(next, currentIndex);
        return;
      }

      if (matchIndex === -1) return;

      const match = sorted[matchIndex];
      setFocusedPath(match.path);
      setLastClickedIndex(matchIndex);
      const next = new Set<string>();
      next.add(match.path);
      onSelectionChange(next);
      rowVirtualizer.scrollToIndex(matchIndex, { align: 'auto' });
    },
    [
      sorted,
      onSelectionChange,
      renamingPath,
      selectedPaths,
      onOpen,
      rowVirtualizer,
      clearTypeahead,
      searchAndSelect,
      activePath,
      onDeleteSelected,
      onRenameStart,
      onRefresh,
      onNavigateParent,
      onNavigateBack,
      onNavigateForward,
      onCopySelected,
      onCutSelected,
      onPaste,
      focusedPath,
      onEntryContextMenu,
      onPaneContextMenu,
    ]
  );

  const SortHeader: React.FC<{ label: string; sortKeyName: SortKey; className?: string; title?: string }> = ({
    label,
    sortKeyName,
    className,
    title,
  }) => (
    <div
      role="columnheader"
      aria-sort={sortKey === sortKeyName ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className="min-w-0"
    >
      <button
        type="button"
        onClick={() => toggleSort(sortKeyName)}
        title={title}
        aria-label={title ? `${label} (${title.toLowerCase()})` : undefined}
        className={classNames(
          'flex min-h-6 w-full items-center gap-1 text-left text-2xs font-semibold uppercase tracking-wider text-txt-muted hover:text-txt-primary transition-colors min-w-0',
          className
        )}
      >
        <span className="truncate">{label}</span>
        {sortKey === sortKeyName && (
          <span aria-hidden="true" className="text-sky-400 font-bold shrink-0">
            {sortDir === 'asc' ? '▲' : '▼'}
          </span>
        )}
      </button>
    </div>
  );

  return (
    <div
      role="grid"
      aria-label="Files"
      aria-multiselectable="true"
      aria-rowcount={sorted.length + 1}
      className="relative flex h-full flex-col overflow-hidden bg-app-card"
    >
      <div
        role="row"
        aria-rowindex={1}
        className="grid grid-cols-[minmax(120px,1fr)_72px_52px_128px] items-center gap-2 border-b border-divider bg-app-surface py-0 pl-3 pr-[18px]"
      >
        <div className="flex items-center gap-2 min-w-0">
          <SortHeader label="Name" sortKeyName="name" />
          {filterText?.trim() && (
            <span className="truncate rounded border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.2 text-2xs font-medium text-sky-400">
              {sorted.length} of {entries.length}
            </span>
          )}
        </div>
        <SortHeader label="Size" sortKeyName="size" className="justify-end" />
        <SortHeader label="Perms" title="Permissions" sortKeyName="permissions" />
        <SortHeader label="Modified" sortKeyName="mtime" />
      </div>
      <div
        ref={containerRef}
        tabIndex={0}
        role="rowgroup"
        data-file-list="true"
        onFocusCapture={handleFocusCapture}
        onBlurCapture={handleBlurCapture}
        className="flex-1 overflow-y-auto [scrollbar-gutter:stable] outline-none focus:ring-1 focus:ring-inset focus:ring-sky-500/40"
        onMouseDown={() => containerRef.current?.focus({ preventScroll: true })}
        onKeyDown={handleContainerKeyDown}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          updateAutoScroll(e.clientY);
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          updateAutoScroll(e.clientY);
        }}
        onDragLeave={() => {
          stopAutoScroll();
          clearSpringLoadedTimer();
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          stopAutoScroll();
          clearSpringLoadedTimer();
          onEntryDragLeave?.(entries[0]);
          onPaneDrop?.(e);
        }}
        onClick={(e) => {
          if (e.currentTarget === e.target) {
            setFocusedPath(null);
            onSelectionChange(new Set());
          }
        }}
        onContextMenu={(e) => {
          if (e.currentTarget === e.target) {
            e.preventDefault();
            setFocusedPath(null);
            onSelectionChange(new Set());
            onPaneContextMenu?.(e);
          }
        }}
      >
        {loading && (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-txt-muted">
            <Loader2 className="h-4 w-4 animate-spin text-sky-400" />
            Loading files...
          </div>
        )}
        {!loading && sorted.length === 0 && (
          <div className="py-8 text-center text-sm text-txt-muted">
            {filterText?.trim() ? `No files match "${filterText.trim()}"` : 'Folder is empty'}
          </div>
        )}
        {!loading && sorted.length > 0 && (
          <div
            style={{
              height: `${rowVirtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const entry = sorted[virtualRow.index];
              const index = virtualRow.index;
              const Icon = iconForEntry(entry);
              const selected = selectedPaths.has(entry.path);
              const isFocused = activePath === entry.path;
              const isDropHover = dragOverPath === entry.path;
              const renaming = renamingPath === entry.path;
              return (
                <div
                  key={entry.path}
                  role="row"
                  aria-rowindex={index + 2}
                  tabIndex={-1}
                  data-entry-path={entry.path}
                  aria-selected={selected}
                  data-focused={isFocused ? 'true' : undefined}
                  draggable
                  onMouseDown={() => {
                    suppressNextClickRef.current = false;
                  }}
                  onFocus={() => setFocusedPath(entry.path)}
                  onDragStart={(e) => {
                    if (onDraggableStart?.(entry, e) === true) suppressNextClickRef.current = true;
                  }}
                  onDragEnd={() => {
                    stopAutoScroll();
                    clearSpringLoadedTimer();
                    onDraggableEnd?.();
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'copy';
                    updateAutoScroll(e.clientY);
                    if (isDropTarget?.(entry)) {
                      onEntryDragOver?.(entry, e);
                      if (entry.isDirectory) {
                        if (springLoadedTargetRef.current !== entry.path) {
                          clearSpringLoadedTimer();
                          springLoadedTargetRef.current = entry.path;
                          springLoadedTimerRef.current = setTimeout(() => {
                            clearSpringLoadedTimer();
                            onOpen(entry);
                          }, 900);
                        }
                      } else {
                        clearSpringLoadedTimer();
                      }
                    } else if (dragOverPath) {
                      clearSpringLoadedTimer();
                      onEntryDragLeave?.(entry);
                    }
                  }}
                  onDragEnter={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'copy';
                    updateAutoScroll(e.clientY);
                    if (isDropTarget?.(entry)) {
                      onEntryDragOver?.(entry, e);
                    }
                  }}
                  onDragLeave={() => {
                    clearSpringLoadedTimer();
                    onEntryDragLeave?.(entry);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    stopAutoScroll();
                    clearSpringLoadedTimer();
                    if (isDropTarget?.(entry)) {
                      onEntryDrop?.(entry, e);
                    } else {
                      onPaneDrop?.(e);
                    }
                  }}
                  onClick={(e) => handleRowClick(entry, index, e)}
                  onDoubleClick={() => onOpen(entry)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setFocusedPath(entry.path);
                    if (!selectedPaths.has(entry.path)) {
                      const next = new Set<string>();
                      next.add(entry.path);
                      setLastClickedIndex(index);
                      onSelectionChange(next);
                    }
                    onEntryContextMenu?.(entry, e);
                  }}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: `${virtualRow.size}px`,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                  className={classNames(
                    'grid cursor-default grid-cols-[minmax(120px,1fr)_72px_52px_128px] items-center gap-2 border-b border-divider/60 px-3 text-sm select-none transition-colors outline-none',
                    selected
                      ? 'bg-sky-500/15 text-txt-primary font-medium [&>span]:text-txt-secondary'
                      : 'text-txt-primary hover:bg-app-surface-hover',
                    isFocused && 'ring-1 ring-inset ring-sky-400 bg-sky-500/25 [&>span]:text-txt-secondary',
                    isDropHover && 'ring-1 ring-inset ring-sky-400 bg-sky-500/20 animate-pulse',
                    cutPaths?.has(entry.path) && 'opacity-40'
                  )}
                >
                  <div role="gridcell" className="pointer-events-none flex min-w-0 items-center gap-2">
                    <Icon
                      className={classNames(
                        'h-4 w-4 shrink-0',
                        entry.isDirectory ? 'text-amber-400' : 'text-txt-muted'
                      )}
                    />
                    {renaming ? (
                      <input
                        autoFocus
                        defaultValue={entry.name}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') onRenameCommit?.(entry, (e.target as HTMLInputElement).value);
                          if (e.key === 'Escape') onRenameCancel?.();
                        }}
                        onBlur={(e) => onRenameCommit?.(entry, e.target.value)}
                        className="pointer-events-auto w-full rounded-md border border-sky-500 bg-app-input px-1.5 py-0.5 text-sm text-txt-primary outline-none"
                      />
                    ) : (
                      <span className="truncate">{entry.name}</span>
                    )}
                  </div>
                  <span role="gridcell" className="pointer-events-none truncate text-right text-xs tabular-nums text-txt-muted">{entry.isDirectory ? '' : formatBytes(entry.size)}</span>
                  <span role="gridcell" className="pointer-events-none truncate font-mono text-xs text-txt-muted">{entry.permissions ?? '-'}</span>
                  <span role="gridcell" className="pointer-events-none truncate text-xs tabular-nums text-txt-muted">{entry.mtime ?? ''}</span>
                </div>
              );
            })}
          </div>
        )}

        {/* Neutral drop zone below the list to safely drop into the current directory */}
        <div
          data-testid="neutral-drop-zone"
          className="min-h-[80px] w-full flex items-center justify-center text-xs text-txt-muted transition-colors cursor-default"
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            updateAutoScroll(e.clientY);
          }}
          onDragEnter={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            stopAutoScroll();
            onPaneDrop?.(e);
          }}
          onClick={(e) => {
            if (e.currentTarget === e.target) {
              setFocusedPath(null);
              onSelectionChange(new Set());
            }
          }}
          onContextMenu={(e) => {
            if (e.currentTarget === e.target) {
              e.preventDefault();
              setFocusedPath(null);
              onSelectionChange(new Set());
              onPaneContextMenu?.(e);
            }
          }}
        />
      </div>

      {typeaheadText && (
        <div
          data-testid="typeahead-badge"
          className="pointer-events-none absolute bottom-4 right-4 z-20 flex items-center gap-2 rounded-lg border border-sky-500/40 bg-app-surface/95 px-3 py-1.5 text-xs text-txt-primary shadow-xl transition-all"
        >
          <Search className="h-3.5 w-3.5 text-sky-400 shrink-0" />
          <span className="text-txt-muted text-xs">Search:</span>
          <span className={classNames('font-mono font-bold', typeaheadMatch ? 'text-sky-400' : 'text-amber-400')}>
            {typeaheadText}
          </span>
          {!typeaheadMatch && (
            <span className="text-2xs text-amber-400/80">
              (no match)
            </span>
          )}
        </div>
      )}
    </div>
  );
};

export default FileList;
