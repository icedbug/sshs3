import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Activity, Search, Settings, X, Terminal, Keyboard, Sliders, Shield, FolderTree, RefreshCw, Boxes, GitBranch, Users } from 'lucide-react';
import { type AppSettings } from '@shared/types/settings';
import { DotfilePoolManagerModal } from './DotfilePoolManagerModal';
import { SyncSettingsPanel } from './SyncSettingsPanel';
import { TeamVaultListPanel } from './TeamVaultListPanel';
import { GitSettingsPanel } from './GitSettingsPanel';
import { useModalDismiss } from '../../lib/useModalDismiss';
import { useDialogFocus } from '../../lib/useDialogFocus';
import { nextMenuIndex } from '../../lib/rovingNavigation';
import { useSettingsForm } from './useSettingsForm';
import type { SettingsCategory } from './settingsConstants';
import { GeneralSettingsSection } from './GeneralSettingsSection';
import { TerminalSettingsSection } from './TerminalSettingsSection';
import { PerformanceSettingsSection } from './PerformanceSettingsSection';
import { FilesSettingsSection } from './FilesSettingsSection';
import { SecuritySettingsSection } from './SecuritySettingsSection';
import { ShortcutsSettingsSection } from './ShortcutsSettingsSection';
import { KubernetesSettingsSection } from './KubernetesSettingsSection';

interface SettingsModalProps {
  open: boolean;
  initialCategory?: SettingsCategory;
  currentSettings: AppSettings;
  onSave: (settings: AppSettings) => void;
  onClose: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  open,
  initialCategory,
  currentSettings,
  onSave,
  onClose,
}) => {
  const form = useSettingsForm({ open, initialCategory, currentSettings, onSave, onClose });
  const {
    activeCategory,
    setActiveCategory,
    fileManagerGitIntegration,
    setFileManagerGitIntegration,
    poolManagerOpen,
    setPoolManagerOpen,
    handleSubmit,
  } = form;

  // Design audit Phase 1: every other modal in the app dismisses on Escape
  // and backdrop click via this shared hook; SettingsModal had never been
  // wired up to it, so Escape silently did nothing here.
  const handleBackdropClick = useModalDismiss(onClose, open);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, open);

  // Design audit Phase 2: several categories (Terminal, Security &
  // Smartcard, ...) have more content than fits in the modal's max-h.
  // The custom 6px scrollbar (index.css) is too subtle to register as
  // "there's more below", so content used to just look cut off mid-
  // sentence. Track scroll position and fade a gradient in/out at the
  // bottom edge whenever there's unscrolled content beneath it.
  const contentRef = useRef<HTMLDivElement | null>(null);
  const sidebarButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  // Filters the sidebar by category label (§26) — 11 categories is enough that scanning for one
  // by eye is slower than typing a few letters.
  const [categoryQuery, setCategoryQuery] = useState('');
  const [hasMoreBelow, setHasMoreBelow] = useState(false);
  const updateScrollShadow = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    setHasMoreBelow(el.scrollHeight - el.scrollTop - el.clientHeight > 1);
  }, []);
  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
    updateScrollShadow();
  }, [activeCategory, updateScrollShadow]);

  // Grouped under short section headers (UX review #9) so a 7-item sidebar
  // scans faster than one flat list.
  const categoryGroups: {
    group: string;
    items: { id: SettingsCategory; label: string; icon: React.ComponentType<{ className?: string }> }[];
  }[] = [
    {
      group: 'Appearance',
      items: [
        { id: 'general', label: 'General', icon: Sliders },
        { id: 'terminal', label: 'Terminal', icon: Terminal },
        { id: 'performance', label: 'Performance', icon: Activity },
      ],
    },
    {
      group: 'Connectivity & Storage',
      items: [
        { id: 'files', label: 'Files & Storage', icon: FolderTree },
        { id: 'sync', label: 'Synchronization', icon: RefreshCw },
        { id: 'team-vault', label: 'Team Vault', icon: Users },
        { id: 'kubernetes', label: 'Kubernetes & Debug', icon: Boxes },
      ],
    },
    {
      group: 'Developer & Security',
      items: [
        { id: 'git', label: 'Git & GitHub', icon: GitBranch },
        { id: 'security', label: 'Security & Smartcard', icon: Shield },
        { id: 'shortcuts', label: 'Keyboard Shortcuts', icon: Keyboard },
      ],
    },
  ];
  const query = categoryQuery.trim().toLowerCase();
  const visibleCategoryGroups = query
    ? categoryGroups
        .map((g) => ({ ...g, items: g.items.filter((c) => c.label.toLowerCase().includes(query)) }))
        .filter((g) => g.items.length > 0)
    : categoryGroups;
  // Arrow-key navigation (§26) walks this list, not the unfiltered one — while a search is
  // active, Up/Down should only ever land on a tab that's actually visible.
  const visibleCategories = visibleCategoryGroups.flatMap((g) => g.items);

  // Keeps the active tab always one of the visible ones: narrowing the search to a set that
  // excludes the current category would otherwise leave every tab unselected (and, since each
  // non-active tab is tabIndex={-1}, keyboard-unreachable) while the content pane kept showing
  // the now-hidden category.
  useEffect(() => {
    if (visibleCategories.length === 0) return;
    if (!visibleCategories.some((c) => c.id === activeCategory)) {
      setActiveCategory(visibleCategories[0].id);
    }
    // Deliberately keyed on the query/activeCategory primitives, not the `visibleCategories`
    // array itself (a fresh reference every render) — this only needs to re-check when the
    // search term or the selected tab actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, activeCategory]);

  if (!open) return null;

  return (
    <div
      data-testid="drawer-settings"
      data-drawer-side="right"
      className="fixed inset-0 z-50 flex items-stretch justify-end bg-black/55 backdrop-blur-[2px] animate-in fade-in duration-150"
      onClick={handleBackdropClick}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        data-testid="slide-over-drawer"
        className="sshs3-slide-drawer sshs3-slide-drawer-right flex h-full w-full max-w-3xl flex-col border-l border-border-subtle bg-app-card shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-divider bg-app-surface/90 px-5 backdrop-blur-md">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-sky-500/10 text-sky-400">
              <Settings className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-txt-primary">Settings</h2>
            </div>
          </div>
          <button
            aria-label="Close"
            title="Close"
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body with Sidebar & Content */}
        <div className="flex flex-1 min-h-0">
          {/* Sidebar — a vertical tablist (§26): Up/Down moves between categories regardless of
              group, wrapping at the ends; group headers are purely visual dividers. */}
          <aside className="w-52 shrink-0 flex flex-col border-r border-divider bg-app-surface">
            <div className="shrink-0 p-2.5 pb-1.5">
              <div className="relative">
                <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-txt-muted" />
                <input
                  type="text"
                  value={categoryQuery}
                  onChange={(e) => setCategoryQuery(e.target.value)}
                  placeholder="Search settings..."
                  aria-label="Search settings categories"
                  className="w-full rounded-lg border border-border-subtle bg-app-input py-1.5 pl-8 pr-2.5 text-xs text-txt-primary outline-none focus:border-sky-500 placeholder-txt-muted"
                />
              </div>
            </div>
            <div
              role="tablist"
              aria-orientation="vertical"
              aria-label="Settings categories"
              className="flex-1 min-h-0 overflow-y-auto p-2.5 pt-0 flex flex-col gap-3"
            >
            {visibleCategoryGroups.length === 0 ? (
              <p className="px-3 py-2 text-xs text-txt-muted">No matching settings.</p>
            ) : (
            visibleCategoryGroups.map(({ group, items }) => (
              <div key={group} className="flex flex-col gap-1">
                <div aria-hidden="true" className="px-3 pt-1 text-2xs font-semibold uppercase tracking-wide text-txt-muted">
                  {group}
                </div>
                {items.map((cat) => {
                  const Icon = cat.icon;
                  const isActive = activeCategory === cat.id;
                  return (
                    <button
                      key={cat.id}
                      id={`settings-tab-${cat.id}`}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      aria-controls="settings-panel"
                      data-autofocus={isActive ? true : undefined}
                      tabIndex={isActive ? 0 : -1}
                      onClick={() => setActiveCategory(cat.id)}
                      onKeyDown={(e) => {
                        const idx = visibleCategories.findIndex((c) => c.id === cat.id);
                        const nextIdx = nextMenuIndex(visibleCategories.length, idx, e.key);
                        if (nextIdx === null) return;
                        e.preventDefault();
                        const next = visibleCategories[nextIdx];
                        setActiveCategory(next.id);
                        sidebarButtonRefs.current[next.id]?.focus();
                      }}
                      ref={(el) => {
                        sidebarButtonRefs.current[cat.id] = el;
                      }}
                      className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-xs font-medium text-left transition-colors ${
                        isActive
                          ? 'bg-sky-500/15 text-sky-400 font-semibold'
                          : 'text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary'
                      }`}
                    >
                      <Icon className={`h-4 w-4 ${isActive ? 'text-sky-400' : 'text-txt-muted'}`} />
                      <span>{cat.label}</span>
                    </button>
                  );
                })}
              </div>
            ))
            )}
            </div>
            <div className="shrink-0 mt-auto p-2.5 pt-2 border-t border-divider flex flex-col gap-1">
              <div className="px-3 pt-1 text-2xs font-semibold uppercase tracking-wide text-sky-400">
                AI Hub &amp; Workspace
              </div>
              <button
                type="button"
                data-testid="settings-open-ai-agents-btn"
                onClick={() => {
                  onClose();
                  window.dispatchEvent(
                    new CustomEvent('sshs3:ai-open', {
                      detail: { view: 'Agents & MCP', mode: 'hub' },
                    })
                  );
                }}
                className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium text-sky-300 hover:bg-sky-500/15 transition-colors text-left"
              >
                <span>🤖</span>
                <span>Mission Agents &amp; MCP</span>
              </button>
              <button
                type="button"
                data-testid="settings-open-ai-kb-btn"
                onClick={() => {
                  onClose();
                  window.dispatchEvent(
                    new CustomEvent('sshs3:ai-open', {
                      detail: { view: 'Knowledge Base', mode: 'hub' },
                    })
                  );
                }}
                className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium text-emerald-300 hover:bg-emerald-500/15 transition-colors text-left"
              >
                <span>📚</span>
                <span>Knowledge Base (KB)</span>
              </button>
              <button
                type="button"
                data-testid="settings-open-ai-memory-btn"
                onClick={() => {
                  onClose();
                  window.dispatchEvent(
                    new CustomEvent('sshs3:ai-open', {
                      detail: { view: 'Memory & skills', mode: 'hub' },
                    })
                  );
                }}
                className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium text-purple-300 hover:bg-purple-500/15 transition-colors text-left"
              >
                <span>🧠</span>
                <span>Smart Memory &amp; Infra-Graf</span>
              </button>
            </div>
          </aside>

          {/* Form Content Area */}
          <form onSubmit={handleSubmit} className="flex flex-1 flex-col min-w-0 bg-app-card">
            <div className="relative flex-1 min-h-0">
            <div
              ref={contentRef}
              id="settings-panel"
              role="tabpanel"
              aria-labelledby={`settings-tab-${activeCategory}`}
              onScroll={updateScrollShadow}
              className="h-full overflow-y-auto p-5 pb-8 text-xs text-txt-secondary space-y-5"
            >
              {form.policyWarnings.length > 0 && (
                <div role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs text-amber-300/90 space-y-1">
                  <p className="font-medium">Your organization's policy was not fully applied.</p>
                  {form.policyWarnings.map((warning) => (
                    <p key={warning}>{warning}</p>
                  ))}
                </div>
              )}

              {/* Category: General */}
              {activeCategory === 'general' && <GeneralSettingsSection form={form} />}

              {/* Category: Terminal */}
              {activeCategory === 'terminal' && <TerminalSettingsSection form={form} />}

              {/* Category: Performance */}
              {activeCategory === 'performance' && <PerformanceSettingsSection form={form} />}

              {/* Category: Files & Storage */}
              {activeCategory === 'files' && <FilesSettingsSection form={form} />}

              {/* Category: Security & Smartcard */}
              {activeCategory === 'security' && <SecuritySettingsSection form={form} />}

              {/* Category: Synchronization */}
              {activeCategory === 'sync' && <SyncSettingsPanel />}

              {/* Category: Team Vault */}
              {activeCategory === 'team-vault' && <TeamVaultListPanel />}

              {/* Category: Git & GitHub */}
              {activeCategory === 'git' && (
                <GitSettingsPanel
                  fileManagerGitIntegration={fileManagerGitIntegration}
                  onChangeFileManagerGitIntegration={setFileManagerGitIntegration}
                />
              )}

              {/* Category: Keyboard Shortcuts */}
              {activeCategory === 'shortcuts' && <ShortcutsSettingsSection form={form} />}

              {/* Category: Kubernetes & Debug */}
              {activeCategory === 'kubernetes' && <KubernetesSettingsSection form={form} />}
            </div>
            {hasMoreBelow && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-app-card to-transparent"
              />
            )}
            </div>

            {/* Modal Footer — same two buttons, same place, in every category (§26). Sync and
                Team Vault save their own changes immediately, but submitting here is still
                harmless: it re-saves the rest of the draft and closes, same as any other
                category. */}
            <div className="flex items-center justify-end gap-2 border-t border-divider bg-app-surface px-5 py-3">
              {(activeCategory === 'sync' || activeCategory === 'team-vault') && (
                <p className="mr-auto text-xs text-txt-muted">
                  {activeCategory === 'sync'
                    ? 'Synchronization changes save immediately.'
                    : 'Team Vault changes save immediately.'}
                </p>
              )}
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-border-subtle px-3.5 py-1.5 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-lg bg-sky-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-sky-500 shadow-sm transition-colors"
              >
                Save Settings
              </button>
            </div>
          </form>
        </div>
      </div>

      <DotfilePoolManagerModal open={poolManagerOpen} onClose={() => setPoolManagerOpen(false)} />
    </div>
  );
};

export default SettingsModal;
