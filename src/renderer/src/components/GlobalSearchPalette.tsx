import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, X } from 'lucide-react';
import type { HubSnapshot } from '@shared/types/aiHub';
import type { Snippet } from '@shared/types/snippets';
import type { SSHConnectionConfig } from '@shared/types/ssh';
import type { S3Config } from '@shared/types/storage';
import { openTaskStorageKey } from '../lib/aiHubSession';
import { useModalDismiss } from '../lib/useModalDismiss';
import { useDialogFocus } from '../lib/useDialogFocus';
import { useGlobalSearchIndex } from '../lib/useGlobalSearchIndex';
import { buildPaletteGroups, nextFilter, type PaletteFilter, type PaletteRow } from '../lib/globalSearchRows';
import { buildAdHocConfig, prepareConnect } from '../lib/openProfile';
import { parseSearchQuery } from '../lib/searchQuery';
import {
  buildActionEntries,
  buildUnifiedCommandEntries,
  isGlobalActionId,
  searchAiPaletteEntries,
  type AiPaletteEntry,
  type AiPaletteEntryKind,
  type GlobalActionId,
} from '../lib/globalActions';
import { dispatchTerminalAction } from '../lib/terminalActionEvents';
import { FOCUS_AI_COMPOSER_EVENT } from '../lib/useAppKeyboard';
import type { AppTab } from '../lib/tabs';
import type { HubViewId } from './AiHub/panelShared';
import { Kbd } from './ui/Kbd';
import { Highlighted } from './ui/Highlighted';
import { TagChips } from './ui/TagChips';
import { GlobalSearchResultRow } from './GlobalSearchResultRow';

type ExtendedFilter = PaletteFilter | 'ai';

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
  /** Optional AI Hub snapshot (otherwise fetched via `window.multissh.aiHubRequest` when available). */
  hubSnapshot?: HubSnapshot;
  /** Optional saved snippets (otherwise fetched via `window.multissh.snippetsList` when available). */
  snippets?: Snippet[];
  /** Optional Labs views toggle state (defaults to `settingsGet().labsEnabled`). */
  labsEnabled?: boolean;
  /** Optional compact mode state (defaults to `settingsGet().compactMode`). */
  compactMode?: boolean;
  onSelectAiView?: (view: HubViewId) => void;
  onSelectAiTask?: (taskId: string) => void;
  onSelectAgent?: (agentId: string) => void;
  onSelectKbPage?: (pageId: string) => void;
  onRunSnippet?: (snippet: Snippet) => void;
  onNewAiTask?: () => void;
  onToggleLabs?: (next: boolean) => void;
  onToggleCompactMode?: (next: boolean) => void;
  onOpenCommandRunner?: () => void;
}

const BASE_FILTERS: Array<{ id: ExtendedFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'profiles', label: 'Profiles' },
  { id: 'tabs', label: 'Open tabs' },
];

const AI_FILTERS: Array<{ id: ExtendedFilter; label: string }> = [
  ...BASE_FILTERS,
  { id: 'ai', label: 'AI & Commands' },
];

type UnifiedRow =
  | { kind: 'search'; key: string; row: PaletteRow }
  | { kind: 'ai'; key: string; entry: AiPaletteEntry; titleIndices: number[] };

interface UnifiedGroup {
  label: string;
  rows: UnifiedRow[];
}

const AI_GROUP_LABELS: Record<AiPaletteEntryKind, string> = {
  'command-action': 'Quick Actions',
  'ai-view': 'AI Hub Views',
  'ai-task': 'Recent AI Tasks',
  agent: 'Agents',
  'kb-page': 'Knowledge Base',
  snippet: 'Snippets & Workflows',
};

const AI_GROUP_ORDER: AiPaletteEntryKind[] = [
  'ai-view',
  'ai-task',
  'agent',
  'kb-page',
  'snippet',
  'command-action',
];

const AI_BADGE_CLASSES: Record<AiPaletteEntryKind, string> = {
  'command-action': 'bg-violet-500/15 text-violet-400',
  'ai-view': 'bg-sky-500/15 text-sky-400',
  'ai-task': 'bg-emerald-500/15 text-emerald-400',
  agent: 'bg-amber-500/15 text-amber-400',
  'kb-page': 'bg-teal-500/15 text-teal-400',
  snippet: 'bg-indigo-500/15 text-indigo-400',
};

/**
 * Unified Command & AI Palette ("Go to anything"): finds saved profiles (personal and Team Vault),
 * open tabs, a typed `user@host`, AI Hub views, recent AI tasks, agents, KB pages, saved snippets/
 * workflows, and quick actions. Leading `>` enters action mode.
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
  hubSnapshot: hubSnapshotProp,
  snippets: snippetsProp,
  labsEnabled: labsEnabledProp,
  compactMode: compactModeProp,
  onSelectAiView,
  onSelectAiTask,
  onSelectAgent,
  onSelectKbPage,
  onRunSnippet,
  onNewAiTask,
  onToggleLabs,
  onToggleCompactMode,
  onOpenCommandRunner,
}) => {
  const onBackdrop = useModalDismiss(onClose, true);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  useDialogFocus(dialogRef, true);
  const { entries, locked, loading, getProfile } = useGlobalSearchIndex(tabs);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ExtendedFilter>('all');
  const [active, setActive] = useState(0);
  const [loadedHub, setLoadedHub] = useState<HubSnapshot | undefined>(undefined);
  const [loadedSnippets, setLoadedSnippets] = useState<Snippet[] | undefined>(undefined);
  const [localLabsEnabled, setLocalLabsEnabled] = useState<boolean | undefined>(undefined);
  const [localCompactMode, setLocalCompactMode] = useState<boolean | undefined>(undefined);

  const hasAiProps = Boolean(
    hubSnapshotProp ||
      snippetsProp ||
      labsEnabledProp !== undefined ||
      compactModeProp !== undefined ||
      onSelectAiView ||
      onSelectAiTask ||
      onSelectAgent ||
      onSelectKbPage ||
      onRunSnippet ||
      onNewAiTask ||
      onToggleLabs ||
      onToggleCompactMode ||
      onOpenCommandRunner
  );
  const hasAiBridge = Boolean(
    typeof window !== 'undefined' &&
      (typeof window.multissh?.aiHubRequest === 'function' ||
        typeof window.multissh?.snippetsList === 'function')
  );
  const aiPaletteEnabled = hasAiProps || hasAiBridge;

  // xterm refocuses its textarea right after the opening key event; take focus back once that settles.
  useEffect(() => {
    inputRef.current?.focus();
    const timer = setTimeout(() => inputRef.current?.focus(), 60);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!aiPaletteEnabled) return;
    let cancelled = false;
    if (!hubSnapshotProp && typeof window.multissh?.aiHubRequest === 'function') {
      void window.multissh
        .aiHubRequest({ action: 'snapshot' })
        .then((snap) => {
          if (!cancelled) setLoadedHub(snap);
        })
        .catch(() => {});
    }
    if (!snippetsProp && typeof window.multissh?.snippetsList === 'function') {
      void window.multissh
        .snippetsList()
        .then((list) => {
          if (!cancelled) setLoadedSnippets(list);
        })
        .catch(() => {});
    }
    if (
      labsEnabledProp === undefined &&
      compactModeProp === undefined &&
      typeof window.multissh?.settingsGet === 'function'
    ) {
      void window.multissh
        .settingsGet()
        .then((s) => {
          if (!cancelled && s) {
            if (s.labsEnabled !== undefined) setLocalLabsEnabled(s.labsEnabled);
            if (s.compactMode !== undefined) setLocalCompactMode(s.compactMode);
          }
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [aiPaletteEnabled, hubSnapshotProp, snippetsProp, labsEnabledProp, compactModeProp]);

  const effectiveSnapshot = hubSnapshotProp ?? loadedHub;
  const effectiveSnippets = useMemo(
    () => snippetsProp ?? loadedSnippets ?? [],
    [snippetsProp, loadedSnippets]
  );
  const effectiveLabsEnabled = localLabsEnabled ?? labsEnabledProp ?? false;
  const effectiveCompactMode = localCompactMode ?? compactModeProp ?? false;

  const parsed = useMemo(() => parseSearchQuery(query), [query]);
  const actionMode = parsed.actionMode;
  const actions = useMemo(() => buildActionEntries(shortcuts), [shortcuts]);

  const aiEntries = useMemo(() => {
    if (!aiPaletteEnabled) return [];
    return buildUnifiedCommandEntries({
      snapshot: effectiveSnapshot,
      snippets: effectiveSnippets,
      shortcuts,
      labsEnabled: effectiveLabsEnabled,
      compactMode: effectiveCompactMode,
    });
  }, [
    aiPaletteEnabled,
    effectiveSnapshot,
    effectiveSnippets,
    shortcuts,
    effectiveLabsEnabled,
    effectiveCompactMode,
  ]);

  const groups = useMemo<UnifiedGroup[]>(() => {
    const searchFilter: PaletteFilter = filter === 'ai' ? 'all' : filter;
    const baseGroups =
      filter === 'ai' && !actionMode
        ? []
        : buildPaletteGroups({
            entries,
            actions,
            locked,
            query,
            filter: searchFilter,
          }).map(
            (g): UnifiedGroup => ({
              label: g.label,
              rows: g.rows.map((r) => ({ kind: 'search', key: r.key, row: r })),
            })
          );

    if (!aiPaletteEnabled) return baseGroups;

    if (actionMode) {
      const actionEntries = aiEntries.filter(
        (e) => e.kind === 'command-action' || (!parsed.empty && e.kind === 'ai-view')
      );
      const matched = searchAiPaletteEntries(actionEntries, parsed);
      const extraGroups: UnifiedGroup[] = [];
      for (const kind of ['command-action', 'ai-view'] as AiPaletteEntryKind[]) {
        const rows = matched
          .filter((r) => r.entry.kind === kind)
          .slice(0, 12)
          .map(
            (r): UnifiedRow => ({
              kind: 'ai',
              key: r.entry.id,
              entry: r.entry,
              titleIndices: r.titleIndices,
            })
          );
        if (rows.length > 0) extraGroups.push({ label: AI_GROUP_LABELS[kind], rows });
      }
      return [...baseGroups, ...extraGroups];
    }

    if (filter !== 'all' && filter !== 'ai') return baseGroups;

    if (parsed.empty) {
      if (filter === 'ai') {
        const aiGroups: UnifiedGroup[] = [];
        for (const kind of AI_GROUP_ORDER) {
          const rows = aiEntries
            .filter((e) => e.kind === kind)
            .slice(0, 8)
            .map(
              (entry): UnifiedRow => ({
                kind: 'ai',
                key: entry.id,
                entry,
                titleIndices: [],
              })
            );
          if (rows.length > 0) aiGroups.push({ label: AI_GROUP_LABELS[kind], rows });
        }
        return aiGroups;
      }
      const recentTasks = aiEntries
        .filter((e) => e.kind === 'ai-task')
        .slice(0, 3)
        .map(
          (entry): UnifiedRow => ({
            kind: 'ai',
            key: entry.id,
            entry,
            titleIndices: [],
          })
        );
      return recentTasks.length > 0
        ? [...baseGroups, { label: AI_GROUP_LABELS['ai-task'], rows: recentTasks }]
        : baseGroups;
    }

    const matchedAi = searchAiPaletteEntries(aiEntries, parsed);
    const aiGroups: UnifiedGroup[] = [];
    for (const kind of AI_GROUP_ORDER) {
      const rows = matchedAi
        .filter((r) => r.entry.kind === kind)
        .slice(0, 6)
        .map(
          (r): UnifiedRow => ({
            kind: 'ai',
            key: r.entry.id,
            entry: r.entry,
            titleIndices: r.titleIndices,
          })
        );
      if (rows.length > 0) aiGroups.push({ label: AI_GROUP_LABELS[kind], rows });
    }
    return [...baseGroups, ...aiGroups];
  }, [aiPaletteEnabled, aiEntries, actions, entries, filter, locked, parsed, query, actionMode]);

  const rows = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
  const activeIndex = Math.min(active, Math.max(rows.length - 1, 0));
  const activeId = rows.length > 0 ? `global-search-row-${activeIndex}` : undefined;

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId]);

  const activateAiEntry = (entry: AiPaletteEntry): void => {
    if (entry.kind === 'ai-view' && entry.viewId) {
      onClose();
      onSelectAiView?.(entry.viewId);
      window.dispatchEvent(
        new CustomEvent('sshs3:ai-open', { detail: { mode: 'hub', view: entry.viewId } })
      );
      return;
    }
    if (entry.kind === 'ai-task') {
      try {
        const key = openTaskStorageKey();
        if (key) window.sessionStorage.setItem(key, entry.ref);
      } catch {
        // Ignore storage errors in restricted environments.
      }
      onClose();
      onSelectAiTask?.(entry.ref);
      window.dispatchEvent(
        new CustomEvent('sshs3:ai-open', { detail: { mode: 'panel', view: 'Work', taskId: entry.ref } })
      );
      return;
    }
    if (entry.kind === 'agent') {
      onClose();
      onSelectAgent?.(entry.ref);
      window.dispatchEvent(
        new CustomEvent('sshs3:ai-open', { detail: { mode: 'panel', view: 'Work', agentId: entry.ref } })
      );
      return;
    }
    if (entry.kind === 'kb-page') {
      onClose();
      onSelectKbPage?.(entry.ref);
      window.dispatchEvent(
        new CustomEvent('sshs3:ai-open', { detail: { mode: 'hub', view: 'Knowledge Base', pageId: entry.ref } })
      );
      return;
    }
    if (entry.kind === 'snippet') {
      onClose();
      if (entry.snippet) {
        onRunSnippet?.(entry.snippet);
        window.dispatchEvent(
          new CustomEvent('sshs3:run-snippet', { detail: { snippet: entry.snippet } })
        );
        if (!onRunSnippet) dispatchTerminalAction('snippets');
      }
      return;
    }
    if (entry.kind === 'command-action') {
      switch (entry.ref) {
        case 'newAiTask':
          onClose();
          onNewAiTask?.();
          window.dispatchEvent(
            new CustomEvent('sshs3:ai-open', { detail: { mode: 'panel', view: 'Work', newTask: true } })
          );
          window.dispatchEvent(new CustomEvent(FOCUS_AI_COMPOSER_EVENT));
          break;
        case 'switchAiView':
          onClose();
          onSelectAiView?.('Work');
          window.dispatchEvent(
            new CustomEvent('sshs3:ai-open', { detail: { mode: 'hub', view: 'Work' } })
          );
          break;
        case 'toggleLabs': {
          const next = !effectiveLabsEnabled;
          setLocalLabsEnabled(next);
          void window.multissh?.settingsSave?.({ labsEnabled: next })?.catch?.(() => {});
          onToggleLabs?.(next);
          window.dispatchEvent(
            new CustomEvent('sshs3:settings-updated', { detail: { labsEnabled: next } })
          );
          onClose();
          break;
        }
        case 'toggleCompactMode': {
          const next = !effectiveCompactMode;
          setLocalCompactMode(next);
          void window.multissh?.settingsSave?.({ compactMode: next })?.catch?.(() => {});
          onToggleCompactMode?.(next);
          window.dispatchEvent(
            new CustomEvent('sshs3:settings-updated', { detail: { compactMode: next } })
          );
          onClose();
          break;
        }
        case 'openCommandRunner':
          onClose();
          onOpenCommandRunner?.();
          dispatchTerminalAction('snippets');
          window.dispatchEvent(new CustomEvent('sshs3:open-command-runner'));
          break;
        case 'focusAiBounce':
          onClose();
          window.dispatchEvent(new CustomEvent(FOCUS_AI_COMPOSER_EVENT));
          window.dispatchEvent(
            new CustomEvent('sshs3:ai-open', { detail: { mode: 'panel', view: 'Work' } })
          );
          break;
      }
    }
  };

  const activate = async (item: UnifiedRow, sftp: boolean): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      if (item.kind === 'ai') {
        activateAiEntry(item.entry);
        return;
      }
      const row = item.row;
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

  const cycleFilter = (): void => {
    if (!aiPaletteEnabled) {
      setFilter(nextFilter(filter === 'ai' ? 'all' : filter));
      return;
    }
    const order: ExtendedFilter[] = ['all', 'profiles', 'tabs', 'ai'];
    setFilter(order[(order.indexOf(filter) + 1) % order.length]);
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
      cycleFilter();
      setActive(0);
    }
  };

  const filters = aiPaletteEnabled ? AI_FILTERS : BASE_FILTERS;
  const activeRow = rows[activeIndex];
  const isAiOrActionRow = activeRow?.kind === 'ai' || (activeRow?.kind === 'search' && activeRow.row.type === 'entry' && activeRow.row.entry.kind === 'action');

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
              placeholder={
                aiPaletteEnabled
                  ? 'Search profiles, AI views, tasks, agents, KB, snippets or > for actions…'
                  : 'Search profiles, tags (#prod), user@host or > for actions…'
              }
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
            {filters.map((f) => (
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
              {group.rows.map((item) => {
                rowIndex += 1;
                const index = rowIndex;
                if (item.kind === 'search') {
                  return (
                    <GlobalSearchResultRow
                      key={item.key}
                      id={`global-search-row-${index}`}
                      row={item.row}
                      active={index === activeIndex}
                      onHover={() => index !== activeIndex && setActive(index)}
                      onActivate={(sftp) => void activate(item, sftp)}
                    />
                  );
                }
                const { entry } = item;
                return (
                  <li
                    key={item.key}
                    id={`global-search-row-${index}`}
                    role="option"
                    aria-selected={index === activeIndex}
                    onMouseMove={() => index !== activeIndex && setActive(index)}
                    onClick={() => void activate(item, false)}
                    className={`flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 ${
                      index === activeIndex ? 'bg-app-surface-hover ring-1 ring-sky-500/60' : ''
                    }`}
                  >
                    <span
                      className={`inline-flex w-12 shrink-0 items-center justify-center rounded px-1 py-0.5 text-[10px] font-semibold ${AI_BADGE_CLASSES[entry.kind]}`}
                    >
                      {entry.badge}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-txt-primary">
                        <Highlighted text={entry.title} indices={item.titleIndices} />
                      </span>
                      <span className="block truncate text-[11px] text-txt-muted">{entry.subtitle}</span>
                    </span>
                    <TagChips tags={entry.tags} max={2} />
                  </li>
                );
              })}
            </React.Fragment>
          ))}
        </ul>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-divider px-4 py-2 text-[11px] text-txt-muted">
          <span><Kbd>↑</Kbd> <Kbd>↓</Kbd> navigate</span>
          <span><Kbd>Enter</Kbd> {actionMode || isAiOrActionRow ? 'run' : 'connect'}</span>
          {!actionMode && <span><Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> SFTP</span>}
          {!actionMode && <span><Kbd>Tab</Kbd> filter</span>}
          <span><Kbd>Esc</Kbd> close</span>
        </div>
      </div>
    </div>,
    document.body
  );
};
