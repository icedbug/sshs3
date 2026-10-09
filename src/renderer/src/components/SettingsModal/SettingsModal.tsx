import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Activity, Settings, X, Terminal, Keyboard, Sliders, Shield, FolderTree, RefreshCw, Boxes, GitBranch, Sparkles } from 'lucide-react';
import { type AppSettings } from '@shared/types/settings';
import { DotfilePoolManagerModal } from './DotfilePoolManagerModal';
import { SyncSettingsPanel } from './SyncSettingsPanel';
import { GitSettingsPanel } from './GitSettingsPanel';
import { AiSettingsPanel } from './AiSettingsPanel';
import { useModalDismiss } from '../../lib/useModalDismiss';
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
  currentSettings: AppSettings;
  onSave: (settings: AppSettings) => void;
  onClose: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  open,
  currentSettings,
  onSave,
  onClose,
}) => {
  const form = useSettingsForm({ open, currentSettings, onSave, onClose });
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

  // Design audit Phase 2: several categories (Terminal, Security &
  // Smartcard, ...) have more content than fits in the modal's max-h.
  // The custom 6px scrollbar (index.css) is too subtle to register as
  // "there's more below", so content used to just look cut off mid-
  // sentence. Track scroll position and fade a gradient in/out at the
  // bottom edge whenever there's unscrolled content beneath it.
  const contentRef = useRef<HTMLDivElement | null>(null);
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

  if (!open) return null;


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
        { id: 'kubernetes', label: 'Kubernetes & Debug', icon: Boxes },
      ],
    },
    {
      group: 'Developer & Security',
      items: [
        { id: 'git', label: 'Git & GitHub', icon: GitBranch },
        { id: 'ai', label: 'AI Assistant', icon: Sparkles },
        { id: 'security', label: 'Security & Smartcard', icon: Shield },
        { id: 'shortcuts', label: 'Keyboard Shortcuts', icon: Keyboard },
      ],
    },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 animate-in fade-in duration-150"
      onClick={handleBackdropClick}
    >
      {/* Fixed height (capped at 680px / 85vh): sizing to content made the dialog
          change height and jump on screen every time a different category was
          selected. Sparse categories now leave some empty space instead. */}
      <div role="dialog" aria-modal="true" aria-label="Settings" className="flex h-[85vh] max-h-[680px] min-h-[420px] w-full max-w-3xl flex-col rounded-xl border border-border-subtle bg-app-card shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-divider bg-app-surface px-5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-sky-500/10 text-sky-400">
              <Settings className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-txt-primary">Settings</h2>
            </div>
          </div>
          <button aria-label="Close" title="Close"
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body with Sidebar & Content */}
        <div className="flex flex-1 min-h-0">
          {/* Sidebar */}
          <aside className="w-52 shrink-0 overflow-y-auto border-r border-divider bg-app-surface p-2.5 flex flex-col gap-3">
            {categoryGroups.map(({ group, items }) => (
              <div key={group} className="flex flex-col gap-1">
                <div className="px-3 pt-1 text-2xs font-semibold uppercase tracking-wide text-txt-muted">
                  {group}
                </div>
                {items.map((cat) => {
                  const Icon = cat.icon;
                  const isActive = activeCategory === cat.id;
                  return (
                    <button
                      key={cat.id}
                      type="button"
                      onClick={() => setActiveCategory(cat.id)}
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
            ))}
          </aside>

          {/* Form Content Area */}
          <form onSubmit={handleSubmit} className="flex flex-1 flex-col min-w-0 bg-app-card">
            <div className="relative flex-1 min-h-0">
            <div
              ref={contentRef}
              onScroll={updateScrollShadow}
              className="h-full overflow-y-auto p-5 pb-8 text-xs text-txt-secondary space-y-5"
            >
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

              {/* Category: Git & GitHub */}
              {activeCategory === 'git' && (
                <GitSettingsPanel
                  fileManagerGitIntegration={fileManagerGitIntegration}
                  onChangeFileManagerGitIntegration={setFileManagerGitIntegration}
                />
              )}

              {/* Category: AI Assistant (saves on its own, see AiSettingsPanel) */}
              {activeCategory === 'ai' && <AiSettingsPanel />}

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

            {/* Modal Footer */}
            <div className="flex items-center justify-end gap-2 border-t border-divider bg-app-surface px-5 py-3">
              {activeCategory === 'sync' || activeCategory === 'ai' ? (
                <>
                  <p className="mr-auto text-xs text-txt-muted">
                    {activeCategory === 'sync'
                      ? 'Synchronization changes save immediately — nothing to save here.'
                      : 'AI settings are saved with the button above.'}
                  </p>
                  <button
                    type="button"
                    onClick={onClose}
                    className="rounded-lg bg-sky-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-sky-500 shadow-sm transition-colors"
                  >
                    Close
                  </button>
                </>
              ) : (
                <>
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
                </>
              )}
            </div>
          </form>
        </div>
      </div>

      <DotfilePoolManagerModal open={poolManagerOpen} onClose={() => setPoolManagerOpen(false)} />
    </div>
  );
};

export default SettingsModal;
