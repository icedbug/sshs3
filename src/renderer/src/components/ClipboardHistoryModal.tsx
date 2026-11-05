import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Trash2, X } from 'lucide-react';
import type { ClipboardHistoryEntry } from '@shared/types/clipboard';
import { useModalDismiss } from '../lib/useModalDismiss';
import { useDialogFocus } from '../lib/useDialogFocus';
import { useConfirm } from './ConfirmDialog';
import { plural } from '../lib/plural';
import { formatDateTime } from '../lib/format';

interface ClipboardHistoryModalProps {
  /** Only entries from this host; omit to show the global history. */
  hostKey?: string;
  onPaste: (text: string) => void;
  onClose: () => void;
}

export const ClipboardHistoryModal: React.FC<ClipboardHistoryModalProps> = ({ hostKey, onPaste, onClose }) => {
  const onBackdrop = useModalDismiss(onClose, true);
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirm = useConfirm();
  useDialogFocus(dialogRef, true);
  const [entries, setEntries] = useState<ClipboardHistoryEntry[]>([]);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [selected, setSelected] = useState(0);

  // The terminal may grab focus back right after the opening mouse/key event (xterm refocuses
  // its textarea on mouseup), so focus the search field again once that has settled.
  useEffect(() => {
    searchRef.current?.focus();
    const timer = setTimeout(() => searchRef.current?.focus(), 60);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    window.multissh
      .clipboardHistoryList(hostKey)
      .then((list) => {
        if (!cancelled) setEntries(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [hostKey]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? entries.filter((e) => e.text.toLowerCase().includes(q)) : entries;
  }, [entries, query]);

  // Keep the highlighted row valid as the list shrinks or the filter changes, and in view.
  const activeIndex = Math.min(selected, Math.max(visible.length - 1, 0));
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, visible]);

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (visible.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((activeIndex + 1) % visible.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((activeIndex - 1 + visible.length) % visible.length);
    } else if (e.key === 'Home' && e.ctrlKey) {
      e.preventDefault();
      setSelected(0);
    } else if (e.key === 'End' && e.ctrlKey) {
      e.preventDefault();
      setSelected(visible.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      onPaste(visible[activeIndex].text);
    }
  };

  const remove = (id: string): void => {
    setEntries((prev) => prev.filter((e) => e.id !== id));
    void window.multissh.clipboardHistoryDelete(id);
  };

  const clearAll = async (): Promise<void> => {
    const confirmed = await confirm({
      title: 'Clear clipboard history',
      message: `Delete all ${plural(entries.length, 'entry', 'entries')} from the clipboard history? This cannot be undone.`,
      confirmLabel: 'Clear history',
    });
    if (!confirmed) return;
    setEntries([]);
    void window.multissh.clipboardHistoryClear();
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onBackdrop}
      data-testid="clipboard-history-modal"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Clipboard history"
        className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-xl border border-border-subtle bg-app-surface shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-divider px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-txt-primary">Clipboard history</h2>
            <p className="text-xs text-txt-muted">
              {hostKey ? 'This host only' : 'All hosts'} · ↑/↓ to navigate, Enter or click to paste
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1.5 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex items-center gap-2 border-b border-divider px-4 py-2">
          <input
            ref={searchRef}
            type="text"
            aria-label="Search clipboard history"
            aria-controls="clipboard-history-list"
            aria-activedescendant={visible.length > 0 ? `clipboard-history-item-${activeIndex}` : undefined}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
            onKeyDown={onSearchKeyDown}
            placeholder="Search history…"
            className="w-full rounded-lg border border-border-subtle bg-app-input px-3 py-2 text-xs text-txt-primary outline-none focus:border-sky-500"
          />
          <button
            type="button"
            onClick={() => void clearAll()}
            disabled={entries.length === 0}
            className="shrink-0 rounded-lg border border-border-subtle px-3 py-2 text-xs text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary disabled:opacity-40 cursor-pointer"
          >
            Clear all
          </button>
        </div>

        <div role="status" aria-live="polite" className="sr-only">
          {visible.length === 0 ? 'No entries' : plural(visible.length, 'entry', 'entries')}
        </div>
        <ul id="clipboard-history-list" ref={listRef} aria-label="Clipboard history" className="min-h-0 flex-1 overflow-y-auto p-2">
          {visible.length === 0 && (
            <li className="px-3 py-6 text-center text-xs text-txt-muted">
              {entries.length === 0 ? 'Nothing copied yet.' : 'No matches.'}
            </li>
          )}
          {visible.map((entry, index) => (
            <li
              key={entry.id}
              id={`clipboard-history-item-${index}`}
              aria-current={index === activeIndex ? 'true' : undefined}
              data-active={index === activeIndex}
              onMouseMove={() => index !== activeIndex && setSelected(index)}
              className={`group flex items-start gap-2 rounded-lg ${
                index === activeIndex ? 'bg-app-surface-hover ring-1 ring-sky-500/60' : ''
              }`}
            >
              <button
                type="button"
                onClick={() => onPaste(entry.text)}
                className="min-w-0 flex-1 px-3 py-2 text-left cursor-pointer"
              >
                <pre className="max-h-20 overflow-hidden whitespace-pre-wrap break-all font-mono text-xs text-txt-primary">
                  {entry.text.length > 400 ? `${entry.text.slice(0, 400)}…` : entry.text}
                </pre>
                <span className="mt-1 block text-[11px] text-txt-muted">
                  {formatDateTime(entry.copiedAt)} · {entry.text.length} chars
                  {!hostKey && entry.hostLabel ? ` · ${entry.hostLabel}` : ''}
                </span>
              </button>
              <button
                type="button"
                onClick={() => remove(entry.id)}
                aria-label="Delete entry"
                className="m-2 rounded-md p-1.5 text-txt-muted opacity-0 hover:text-rose-400 focus:opacity-100 group-hover:opacity-100 cursor-pointer"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>,
    document.body
  );
};
