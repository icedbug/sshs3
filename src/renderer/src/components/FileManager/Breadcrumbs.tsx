import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Pencil } from 'lucide-react';
import { classNames, pathSegments } from '../../lib/format';

interface BreadcrumbsProps {
  currentPath: string;
  onNavigate: (path: string) => void;
  onDropToPath?: (targetPath: string, e: React.DragEvent) => void;
  /** Clicking a Windows drive root ("C:") calls this (to show the drive list) instead of navigating to it. */
  onDriveRootClick?: () => void;
}

export interface BreadcrumbsHandle {
  /** Enters path-editing mode with the whole path selected — used by FilePane's Ctrl+L/Alt+D
   * shortcut (§25), the same convention browser address bars use. */
  startEditing: () => void;
}

export const Breadcrumbs = forwardRef<BreadcrumbsHandle, BreadcrumbsProps>(function Breadcrumbs(
  { currentPath, onNavigate, onDropToPath, onDriveRootClick },
  ref
) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(currentPath);
  const [dragOverSegment, setDragOverSegment] = useState<string | null>(null);

  const segmentsRef = useRef<HTMLDivElement | null>(null);
  const springTimerRef = useRef<NodeJS.Timeout | null>(null);
  const springTargetRef = useRef<string | null>(null);

  const clearSpringTimer = useCallback(() => {
    if (springTimerRef.current) {
      clearTimeout(springTimerRef.current);
      springTimerRef.current = null;
    }
    springTargetRef.current = null;
  }, []);

  useImperativeHandle(ref, () => ({
    startEditing: () => setEditing(true),
  }));

  useEffect(() => {
    setDraft(currentPath);
  }, [currentPath]);

  // Keep the current (last) segment visible when the path is wider than the bar.
  useEffect(() => {
    const el = segmentsRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [currentPath, editing]);

  useEffect(() => {
    return () => {
      clearSpringTimer();
    };
  }, [clearSpringTimer]);

  if (editing) {
    return (
      <form
        className="flex-1"
        onSubmit={(e) => {
          e.preventDefault();
          setEditing(false);
          if (draft.trim()) onNavigate(draft.trim());
        }}
      >
        <input
          autoFocus
          value={draft}
          onFocus={(e) => e.target.select()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setDraft(currentPath);
              setEditing(false);
            }
          }}
          className="w-full rounded-md border border-sky-500 bg-app-input px-2 py-1 text-xs text-txt-primary outline-none font-mono shadow-inner"
        />
      </form>
    );
  }

  const segments = pathSegments(currentPath);

  return (
    <div
      className="group/bc relative flex min-w-0 flex-1 items-center justify-between gap-1 overflow-x-auto no-scrollbar rounded-md border border-border-subtle/40 bg-app-input/40 px-1.5 py-0.5 text-xs hover:border-border-subtle transition-colors cursor-pointer"
      onDoubleClick={() => setEditing(true)}
      title="Click edit button or double-click to enter path manually, or drop files on any folder"
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDragEnter={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        clearSpringTimer();
        setDragOverSegment(null);
        onDropToPath?.(currentPath, e);
      }}
    >
      <div ref={segmentsRef} className="flex items-center gap-1 min-w-0 flex-1 overflow-x-auto no-scrollbar py-0.5">
      {segments.map((segment, idx) => {
        const isHovered = dragOverSegment === segment.path;
        return (
          <React.Fragment key={segment.path}>
            {/* No separator after the root segment itself: "/" + "/" read as a double slash. */}
            {idx > 0 && segments[idx - 1].label !== '/' && <span className="text-txt-muted">/</span>}
            <button
              type="button"
              onClick={() =>
                idx === 0 && onDriveRootClick && /^[A-Za-z]:\\$/.test(segment.path)
                  ? onDriveRootClick()
                  : onNavigate(segment.path)
              }
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = 'copy';
                setDragOverSegment(segment.path);
                if (segment.path !== currentPath && springTargetRef.current !== segment.path) {
                  clearSpringTimer();
                  springTargetRef.current = segment.path;
                  springTimerRef.current = setTimeout(() => {
                    clearSpringTimer();
                    onNavigate(segment.path);
                  }, 900);
                }
              }}
              onDragEnter={(e) => {
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = 'copy';
                setDragOverSegment(segment.path);
              }}
              onDragLeave={(e) => {
                e.preventDefault();
                e.stopPropagation();
                clearSpringTimer();
                setDragOverSegment((cur) => (cur === segment.path ? null : cur));
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                clearSpringTimer();
                setDragOverSegment(null);
                onDropToPath?.(segment.path, e);
              }}
              className={classNames(
                'min-w-6 shrink-0 rounded px-1.5 py-1 text-center transition-colors font-medium',
                isHovered
                  ? 'bg-sky-500/25 text-sky-400 ring-1 ring-inset ring-sky-400 font-semibold'
                  : 'text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary'
              )}
            >
              {segment.label}
            </button>
          </React.Fragment>
        );
      })}
      </div>
      <button
        aria-label="Edit path manually"
        type="button"
        title="Edit path manually"
        onClick={(e) => {
          e.stopPropagation();
          setEditing(true);
        }}
        className="opacity-0 group-hover/bc:opacity-100 focus-visible:opacity-100 shrink-0 rounded p-1.5 text-txt-muted hover:text-txt-primary hover:bg-app-surface-hover transition-opacity"
      >
        <Pencil className="h-3 w-3" />
      </button>
    </div>
  );
});

export default Breadcrumbs;
