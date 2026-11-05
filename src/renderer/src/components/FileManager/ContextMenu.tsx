import React, { useEffect, useRef, useState } from 'react';
import { classNames } from '../../lib/format';

export interface ContextMenuItem {
  key: string;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  onSelect?: () => void;
  disabled?: boolean;
  danger?: boolean;
  separatorBefore?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

// M13 (code review): a plain NodeList query for the currently-enabled items,
// re-read on every key press rather than cached, since `items` (and which
// entries are disabled) can change while the menu is open.
function getEnabledMenuItems(container: HTMLElement | null): HTMLButtonElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
}

export const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, items, onClose }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y, visible: false });

  useEffect(() => {
    const handlePointerDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      // Arrow-key/Home/End navigation between enabled items (M13, code
      // review) — previously only Escape and a mouse click outside worked,
      // so a keyboard/screen-reader user had no way to move between items.
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
        const enabledItems = getEnabledMenuItems(ref.current);
        if (enabledItems.length === 0) return;
        e.preventDefault();

        if (e.key === 'Home') {
          enabledItems[0].focus();
          return;
        }
        if (e.key === 'End') {
          enabledItems[enabledItems.length - 1].focus();
          return;
        }
        const currentIndex = enabledItems.findIndex((el) => el === document.activeElement);
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        const nextIndex =
          currentIndex === -1
            ? delta === 1
              ? 0
              : enabledItems.length - 1
            : (currentIndex + delta + enabledItems.length) % enabledItems.length;
        enabledItems[nextIndex].focus();
      }
    };
    window.addEventListener('mousedown', handlePointerDown, true);
    window.addEventListener('contextmenu', handlePointerDown, true);
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown, true);
      window.removeEventListener('contextmenu', handlePointerDown, true);
      window.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const clampedX = Math.min(x, window.innerWidth - rect.width - 8);
    const clampedY = Math.min(y, window.innerHeight - rect.height - 8);
    setPos({ x: Math.max(4, clampedX), y: Math.max(4, clampedY), visible: true });
  }, [x, y]);

  // Move focus into the menu once it's positioned and visible, so arrow-key
  // navigation and Enter/Space activation work immediately without first
  // requiring a mouse hover (M13, code review).
  useEffect(() => {
    if (!pos.visible) return;
    getEnabledMenuItems(ref.current)[0]?.focus();
  }, [pos.visible]);

  return (
    <div
      ref={ref}
      role="menu"
      style={{ position: 'fixed', top: pos.y, left: pos.x, visibility: pos.visible ? 'visible' : 'hidden' }}
      className="z-50 min-w-[190px] rounded-md border border-border-subtle bg-app-card py-1 text-sm shadow-2xl"
    >
      {items.map((item) => (
        <React.Fragment key={item.key}>
          {/* border-strong, not border-subtle (UX review #14): border-subtle's
              contrast against bg-app-card is too low to actually read as a
              separator, so the intended grouping (e.g. Delete set apart from
              the rest) was invisible in practice. */}
          {item.separatorBefore && <div className="my-1.5 border-t border-border-strong" />}
          <button
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              item.onSelect?.();
              onClose();
            }}
            className={classNames(
              'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors',
              item.disabled
                ? 'cursor-not-allowed text-txt-muted'
                : item.danger
                  ? 'text-red-400 hover:bg-red-500/10 dark:hover:bg-red-950/60'
                  : 'text-txt-primary hover:bg-app-surface-hover'
            )}
          >
            {item.icon && <item.icon className="h-3.5 w-3.5 shrink-0" />}
            <span className="truncate">{item.label}</span>
          </button>
        </React.Fragment>
      ))}
    </div>
  );
};

export default ContextMenu;
