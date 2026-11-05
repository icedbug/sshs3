import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AppWindow } from 'lucide-react';
import type { MoveTabTarget, WindowInfo } from '@shared/types/ipc';
import { Shortcut } from './ui/Shortcut';

export interface TabContextMenuProps {
  /** Screen position the menu opens at (viewport coordinates). */
  x: number;
  y: number;
  /** Other windows the tab can be moved to. */
  windows: WindowInfo[];
  /** False when the tab cannot move (e.g. unsaved editor changes). */
  canMove: boolean;
  shortcuts?: Record<string, string>;
  onMove: (target: MoveTabTarget) => void;
  onClose: () => void;
}

const itemClass =
  'flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left text-xs text-txt-primary hover:bg-app-surface-hover focus:bg-app-surface-hover focus:outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-50';

/** Right-click / Menu-key menu of a tab: move it to a new window or to another open window. */
export const TabContextMenu: React.FC<TabContextMenuProps> = ({ x, y, windows, canMove, shortcuts, onMove, onClose }) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPosition({
      left: Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)),
    });
  }, [x, y, windows.length]);

  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const onMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [onClose]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
    items[next].focus();
  };

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Tab actions"
      data-testid="tab-context-menu"
      onKeyDown={onKeyDown}
      style={{ position: 'fixed', left: position.left, top: position.top }}
      className="z-50 min-w-[210px] whitespace-nowrap rounded-xl border border-border-subtle bg-app-card p-1 shadow-2xl"
    >
      <button
        role="menuitem"
        type="button"
        disabled={!canMove}
        title={canMove ? undefined : 'Save your changes before moving this tab'}
        data-testid="tab-move-new-window"
        onClick={() => onMove('new')}
        className={itemClass}
      >
        <span className="flex items-center gap-2">
          <AppWindow className="h-3.5 w-3.5 text-sky-400" />
          Move to New Window
        </span>
        <Shortcut id="moveTabToNewWindow" shortcuts={shortcuts} />
      </button>
      {windows.map((w) => (
        <button
          key={w.id}
          role="menuitem"
          type="button"
          disabled={!canMove}
          data-testid={`tab-move-window-${w.id}`}
          onClick={() => onMove(w.id)}
          className={itemClass}
        >
          <span className="flex items-center gap-2">
            <AppWindow className="h-3.5 w-3.5 text-txt-muted" />
            Move to {w.label}
          </span>
        </button>
      ))}
    </div>
  );
};
