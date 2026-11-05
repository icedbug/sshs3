import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, X } from 'lucide-react';
import type { SSHConnectionConfig } from '@shared/types/ssh';
import type { S3Config } from '@shared/types/storage';
import { useModalDismiss } from '../lib/useModalDismiss';
import { useDialogFocus } from '../lib/useDialogFocus';
import { useGlobalSearchIndex } from '../lib/useGlobalSearchIndex';
import { buildPaletteGroups, nextFilter, type PaletteFilter, type PaletteRow } from '../lib/globalSearchRows';
import { buildAdHocConfig, prepareConnect } from '../lib/openProfile';
import { parseSearchQuery } from '../lib/searchQuery';
import { buildActionEntries, isGlobalActionId, type GlobalActionId } from '../lib/globalActions';
import type { AppTab } from '../lib/tabs';
import { Kbd } from './ui/Kbd';
import { GlobalSearchResultRow } from './GlobalSearchResultRow';

interface GlobalSearchPaletteProps {
  tabs: AppTab[];
  /** The user's key bindings, shown next to the actions. */
  shortcuts: Record<string, string> | undefined;
  onClose: () => void;
  /** Opens a terminal (reusing an empty active tab, as Connection Manager does). */
  onConnectSSH: (config: SSHConnectionConfig) => void;
  onOpenSFTP: (config: SSHConnectionConfig) => void;
  onConnectS3: (config: S3Config) => void;
  onSelectTab: (tabId: string) => void;
  /** Opens Connection Manager, where a locked Team Vault can be unlocked. */
  onOpenConnectionManager: () => void;
  /** Runs a `>` action (new tab, Settings, ...). */
  onRunAction: (id: GlobalActionId) => void;
  /** Connects to every server of a system found by name. */
  onConnectSystem: (members: SSHConnectionConfig[], source: string) => void;
}

const FILTERS: Array<{ id: PaletteFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'profiles', label: 'Profiles' },
  { id: 'tabs', label: 'Open tabs' },
];

/**
 * "Go to anything": one input that finds saved profiles (personal and Team Vault), open tabs and a
 * typed user@host; a leading `>` lists actions instead. Mounted only while open. Enter connects,
 * Shift+Enter opens SFTP, Tab cycles the type filter, Esc closes.
 */
export const GlobalSearchPalette: React.FC<GlobalSearchPaletteProps> = ({
  tabs,
  shortcuts,
  onClose,
  onConnectSSH,
  onOpenSFTP,
  onConnectS3,
  onSelectTab,
  onOpenConnectionManager,
  onRunAction,
  onConnectSystem,
}) => {
  const onBackdrop = useModalDismiss(onClose, true);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  useDialogFocus(dialogRef, true);
  const { entries, locked, loading, getProfile } = useGlobalSearchIndex(tabs);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<PaletteFilter>('all');
  const [active, setActive] = useState(0);

  // xterm refocuses its textarea right after the opening key event; take focus back once that settles.
  useEffect(() => {
    inputRef.current?.focus();
    const timer = setTimeout(() => inputRef.current?.focus(), 60);
    return () => clearTimeout(timer);
  }, []);

  const actionMode = useMemo(() => parseSearchQuery(query).actionMode, [query]);
  const actions = useMemo(() => buildActionEntries(shortcuts), [shortcuts]);
  const groups = useMemo(
    () => buildPaletteGroups({ entries, actions, locked, query, filter }),
    [entries, actions, locked, query, filter]
  );
  const rows = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
  const activeIndex = Math.min(active, Math.max(rows.length - 1, 0));
  const activeId = rows.length > 0 ? `global-search-row-${activeIndex}` : undefined;

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId]);

  const activate = async (row: PaletteRow, sftp: boolean): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      if (row.type === 'locked') {
        onClose();
        onOpenConnectionManager();
      } else if (row.type === 'adhoc') {
        const config = buildAdHocConfig(row.target);
        onClose();
        (sftp ? onOpenSFTP : onConnectSSH)(config);
      } else if (row.entry.kind === 'action') {
        const id = row.entry.ref;
        onClose();
        if (isGlobalActionId(id)) onRunAction(id);
      } else if (row.entry.kind === 'tab') {
        onClose();
        onSelectTab(row.entry.ref);
      } else if (row.entry.kind === 'system') {
        const { members } = getProfile(row.entry);
        if (sftp || !members) return;
        onClose();
        onConnectSystem(members, row.entry.source);
      } else {
        const { ssh, s3 } = getProfile(row.entry);
        if (ssh) {
          if (sftp && !row.entry.sftp) return;
          const profile = await prepareConnect(ssh, row.entry.source, (p) => window.multissh.profilesSaveSSH(p));
          onClose();
          (sftp ? onOpenSFTP : onConnectSSH)(profile);
        } else if (s3 && !sftp) {
          const profile = await prepareConnect(s3, row.entry.source, (p) => window.multissh.profilesSaveS3(p));
          onClose();
          onConnectS3(profile);
        }
      }
    } finally {
      busyRef.current = false;
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (rows.length === 0) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((activeIndex + step + rows.length) % rows.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = rows[activeIndex];
      if (row) void activate(row, e.shiftKey);
    } else if (e.key === 'Tab' && !e.shiftKey && !actionMode) {
      e.preventDefault();
      setFilter(nextFilter(filter));
      setActive(0);
    }
  };

  let rowIndex = -1;
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-[12vh]"
      onClick={onBackdrop}
      data-testid="global-search-palette"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        className="flex max-h-[70vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border-subtle bg-app-surface shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-divider px-4 py-3">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-txt-muted" aria-hidden="true" />
            <input
              ref={inputRef}
              data-autofocus
              type="text"
              role="combobox"
              aria-label="Search profiles, tabs and hosts"
              aria-expanded="true"
              aria-controls="global-search-list"
              aria-activedescendant={activeId}
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
              placeholder="Search profiles, tags (#prod), user@host or > for actions…"
              className="w-full rounded-lg border border-border-subtle bg-app-input py-1.5 pl-8 pr-3 text-xs text-txt-primary outline-none focus:border-sky-500 placeholder-txt-muted"
            />
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {!actionMode && (
          <div className="flex items-center gap-1.5 border-b border-divider px-4 py-2" role="group" aria-label="Show">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                aria-pressed={filter === f.id}
                onClick={() => {
                  setFilter(f.id);
                  setActive(0);
                  inputRef.current?.focus();
                }}
                className={`rounded px-2.5 py-0.5 text-xs cursor-pointer ${
                  filter === f.id
                    ? 'bg-sky-600 font-medium text-white'
                    : 'border border-border-subtle text-txt-secondary hover:bg-app-surface-hover'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        )}

        <ul id="global-search-list" role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto p-2">
          {rows.length === 0 && (
            <li role="presentation" className="px-3 py-6 text-center text-xs text-txt-muted">
              {loading ? 'Loading profiles…' : query.trim() ? 'No matches.' : 'Nothing to show yet. Start typing to search.'}
            </li>
          )}
          {groups.map((group) => (
            <React.Fragment key={group.label}>
              <li role="presentation" className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-txt-muted">
                {group.label}
              </li>
              {group.rows.map((row) => {
                rowIndex += 1;
                const index = rowIndex;
                return (
                  <GlobalSearchResultRow
                    key={row.key}
                    id={`global-search-row-${index}`}
                    row={row}
                    active={index === activeIndex}
                    onHover={() => index !== activeIndex && setActive(index)}
                    onActivate={(sftp) => void activate(row, sftp)}
                  />
                );
              })}
            </React.Fragment>
          ))}
        </ul>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-divider px-4 py-2 text-[11px] text-txt-muted">
          <span><Kbd>↑</Kbd> <Kbd>↓</Kbd> navigate</span>
          <span><Kbd>Enter</Kbd> {actionMode ? 'run' : 'connect'}</span>
          {!actionMode && <span><Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> SFTP</span>}
          {!actionMode && <span><Kbd>Tab</Kbd> filter</span>}
          <span><Kbd>Esc</Kbd> close</span>
        </div>
      </div>
    </div>,
    document.body
  );
};
