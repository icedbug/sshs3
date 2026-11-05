import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { classNames } from '../../lib/format';

export interface OverflowMenuItem {
  label: string;
  icon: React.ReactNode;
  onSelect: () => void;
  danger?: boolean;
  /** Draws a divider above this item (used to set destructive actions apart). */
  separated?: boolean;
}

interface OverflowMenuProps {
  items: OverflowMenuItem[];
  label?: string;
}

const MENU_WIDTH = 190;
const ITEM_HEIGHT = 30; // h-[30px] on each item
const MENU_PADDING = 8; // p-1 top + bottom
const SEPARATOR_HEIGHT = 9; // my-1 + h-px

/**
 * Overflow ("...") menu for secondary row actions. Rendered with fixed positioning so it is not
 * clipped by the scrolling modal body, and flips upward when there is no room below the button.
 */
export const OverflowMenu: React.FC<OverflowMenuProps> = ({ items, label = 'More actions' }) => {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const open = pos !== null;

  const close = useCallback(() => setPos(null), []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Close only the menu, not the surrounding modal.
      e.stopPropagation();
      e.preventDefault();
      close();
      buttonRef.current?.focus();
    };
    // The menu is positioned from the trigger's rect at open time, so scrolling the modal body or the
    // profile list (anything containing the trigger) would leave it detached from its row: close instead
    // of following. Scrolls elsewhere, such as a background terminal receiving output, must not close it.
    const onScroll = (e: Event) => {
      const target = e.target;
      if (target === document || (target instanceof Node && target.contains(buttonRef.current))) close();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
    };
  }, [open, close]);

  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [open]);

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const entries = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    if (entries.length === 0) return;
    const current = entries.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | null = null;
    if (e.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % entries.length;
    else if (e.key === 'ArrowUp') next = current < 0 ? entries.length - 1 : (current - 1 + entries.length) % entries.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = entries.length - 1;
    else if (e.key === 'Tab') {
      // Leave the menu like a native one: close it and let focus continue from the trigger.
      close();
      buttonRef.current?.focus();
      return;
    }
    if (next === null) return;
    e.preventDefault();
    entries[next].focus();
  };

  const openMenu = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const separators = items.filter((item) => item.separated).length;
    const height = items.length * ITEM_HEIGHT + separators * SEPARATOR_HEIGHT + MENU_PADDING;
    const openUp = rect.bottom + height > window.innerHeight - 8;
    setPos({
      top: openUp ? Math.max(8, rect.top - height - 4) : rect.bottom + 4,
      left: Math.max(8, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8)),
    });
  };

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (open) close();
    else openMenu();
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            openMenu();
          }
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        className={classNames(
          'rounded-lg p-1.5 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors',
          open && 'bg-app-surface-hover text-txt-primary'
        )}
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
      {pos && (
        <div
          ref={menuRef}
          role="menu"
          aria-orientation="vertical"
          onKeyDown={onMenuKeyDown}
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: MENU_WIDTH }}
          className="z-[60] rounded-lg border border-border-strong bg-app-card p-1 shadow-xl"
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {items.map((item) => (
            <React.Fragment key={item.label}>
              {item.separated && <div className="my-1 h-px bg-border-subtle" />}
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => {
                  close();
                  item.onSelect();
                }}
                className={classNames(
                  'flex h-[30px] w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors',
                  item.danger
                    ? 'text-red-400 hover:bg-red-500/15'
                    : 'text-txt-primary hover:bg-app-surface-hover'
                )}
              >
                <span className="shrink-0">{item.icon}</span>
                {item.label}
              </button>
            </React.Fragment>
          ))}
        </div>
      )}
    </>
  );
};

export default OverflowMenu;
