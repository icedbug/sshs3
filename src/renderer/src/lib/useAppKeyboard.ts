import { useEffect } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { TabType } from '../components/TabBar';
import { FILEMANAGER_FOCUS_SIDE_EVENT } from '../components/FileManager/types';
import { DEFAULT_SETTINGS, DEFAULT_SHORTCUTS, type AppSettings } from '@shared/types/settings';
import type { PaneOrientation } from '@shared/types/session';
import { tabForNumber, type AppTab } from './tabs';
import { collectLeafIds } from './paneTree';
import { comboFromKeyboardEvent } from './shortcuts';
import { isGlobalActionId, runGlobalAction } from './globalActions';
import { OPEN_CLIPBOARD_HISTORY_EVENT } from './clipboardHistoryEvents';
import { dispatchTerminalAction } from './terminalActionEvents';
import { openTabMenuFor } from './tabMenuEvents';
import {
  findAdjacentPane,
  getTopmostOverlay,
  navigateInOverlay,
  type PaneRect,
  type NavigationDirection,
} from './spatialNavigation';

export interface AppKeyboardContext {
  tabs: AppTab[];
  activeTabId: string;
  tabBarFocused: boolean;
  anyTopLevelModalOpen: boolean;
  settings: AppSettings;
  setActiveTabId: Dispatch<SetStateAction<string>>;
  setTabBarFocused: Dispatch<SetStateAction<boolean>>;
  setSettings: Dispatch<SetStateAction<AppSettings>>;
  setProfilesModalOpen: Dispatch<SetStateAction<boolean>>;
  setSettingsModalOpen: Dispatch<SetStateAction<boolean>>;
  setGlobalSearchOpen: Dispatch<SetStateAction<boolean>>;
  openTopLevelModal: (open: () => void) => void;
  handleNewTab: (type?: TabType, options?: { remote?: boolean }) => void;
  handleCloseTab: (id: string) => void;
  /** Moves a tab (and its running sessions) to a new window. */
  handleMoveTabToNewWindow: (id: string) => void;
  handleSplitPane: (tabId: string, orientation: PaneOrientation, paneId?: string) => void;
  handleClosePane: (tabId: string, paneId: string) => void;
  handleToggleZoom: (tabId: string, paneId?: string) => void;
  handleSelectPane: (tabId: string, paneId: string) => void;
  /** Opens Settings on the keyboard shortcuts overview. */
  openShortcutsHelp: () => void;
  focusActiveTabContent: () => void;
}

/**
 * App-wide keyboard handling (capture phase): shortcut dispatch, the spatial Ctrl+Shift+Arrow
 * navigation between tab bar / panes / overlays, and Enter/Escape handling inside modals.
 */
export function useAppKeyboard(ctx: AppKeyboardContext): void {
  const {
    tabs,
    activeTabId,
    tabBarFocused,
    anyTopLevelModalOpen,
    settings,
    setActiveTabId,
    setTabBarFocused,
    setSettings,
    setProfilesModalOpen,
    setSettingsModalOpen,
    setGlobalSearchOpen,
    openTopLevelModal,
    handleNewTab,
    handleCloseTab,
    handleMoveTabToNewWindow,
    handleSplitPane,
    handleClosePane,
    handleToggleZoom,
    handleSelectPane,
    openShortcutsHelp,
    focusActiveTabContent,
  } = ctx;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // While the Settings shortcut recorder is capturing a new binding, every app-level shortcut
      // must stay silent — otherwise a combo that matches an existing binding (including the one
      // being rebound) gets consumed here first (preventDefault+stopPropagation in the capture
      // phase, before the recorder's own onKeyDown ever runs), so the recorder looks unresponsive
      // and the matched action fires in the background instead (e.g. closing a tab on Ctrl+W).
      if (document.querySelector('[data-shortcut-recording="true"]')) {
        return;
      }

      // If TabBar is focused and user presses Enter or Escape: descend into active tab
      if (tabBarFocused && (e.key === 'Enter' || e.key === 'Escape') && !getTopmostOverlay()) {
        e.preventDefault();
        e.stopPropagation();
        focusActiveTabContent();
        return;
      }

      // Activate custom elements (or checkboxes) on Enter when inside an active modal/menu
      if (e.key === 'Enter' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        const overlay = getTopmostOverlay();
        if (overlay) {
          const active = document.activeElement as HTMLElement | null;
          if (active && overlay.contains(active)) {
            if (active.tagName === 'TEXTAREA' || active.tagName === 'SELECT' || active.isContentEditable) return;

            if (active.tagName === 'INPUT') {
              const input = active as HTMLInputElement;
              if (input.type === 'checkbox' || input.type === 'radio') {
                e.preventDefault();
                e.stopPropagation();
                input.click();
                return;
              }
              return;
            }

            // Custom non-button elements (e.g. div[role="button"], div[role="menuitem"], div[tabindex])
            if (active.tagName !== 'BUTTON' && active.tagName !== 'A') {
              e.preventDefault();
              e.stopPropagation();
              active.click();
              return;
            }
          }
        }
      }

      const target = e.target as HTMLElement | null;
      // xterm.js captures keyboard input via a hidden <textarea class="xterm-helper-textarea">
      // inside every terminal pane. Treating it as a real input field would swallow every
      // app-level shortcut (tab switching, split, etc.) whenever a terminal has focus, which
      // is effectively always — so it's explicitly excluded from the "is a text field" check.
      const isInput =
        target &&
        !target.classList?.contains('xterm-helper-textarea') &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);

      if (isInput) {
        // If an overlay (modal, menu) is open, allow spatial navigation shortcuts
        // so the user can navigate out of inputs (e.g. search box) with Ctrl+Shift+Arrows
        const rawCombo = comboFromKeyboardEvent(e);
        if (rawCombo) {
          const combo = rawCombo.toLowerCase().replace(/^cmd\+/, 'ctrl+');
          const isNav =
            combo === (settings.shortcuts?.navigateLeft || DEFAULT_SHORTCUTS.navigateLeft).toLowerCase() ||
            combo === (settings.shortcuts?.navigateRight || DEFAULT_SHORTCUTS.navigateRight).toLowerCase() ||
            combo === (settings.shortcuts?.navigateUp || DEFAULT_SHORTCUTS.navigateUp).toLowerCase() ||
            combo === (settings.shortcuts?.navigateDown || DEFAULT_SHORTCUTS.navigateDown).toLowerCase();

          if (!isNav) return;
        } else {
          return;
        }
      }

      // Inline Terminal AI shortcut Ctrl+K (not Ctrl+Shift+K, which is a separate,
      // user-rebindable shortcut — see 'searchInFiles' below).
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        const inlineAiBtn = Array.from(
          document.querySelectorAll<HTMLButtonElement>('[data-testid="terminal-inline-ai-btn"]')
        ).find((el) => el.offsetParent !== null);
        if (inlineAiBtn) {
          e.preventDefault();
          e.stopPropagation();
          inlineAiBtn.click();
          return;
        }
      }

      const rawCombo = comboFromKeyboardEvent(e);
      if (rawCombo === null) return;
      const combo = rawCombo.toLowerCase();
      const normalizedCombo = combo.replace(/^cmd\+/, 'ctrl+');
      const activeShortcuts = { ...DEFAULT_SHORTCUTS, ...(settings.shortcuts || {}) };

      for (const [actionId, keyBinding] of Object.entries(activeShortcuts)) {
        const bindingLower = keyBinding.toLowerCase();
        const isMatch =
          combo === bindingLower ||
          normalizedCombo === bindingLower ||
          (actionId === 'increaseFontSize' &&
            (bindingLower === 'ctrl++' || bindingLower === 'ctrl+=') &&
            (normalizedCombo === 'ctrl++' || normalizedCombo === 'ctrl+=' || normalizedCombo === 'ctrl+shift+=')) ||
          (actionId === 'decreaseFontSize' &&
            bindingLower === 'ctrl+-' &&
            (normalizedCombo === 'ctrl+-' || normalizedCombo === 'ctrl+shift+-'));

        // These only act on the focused terminal; elsewhere the keys must stay free for other uses.
        const terminalOnly =
          actionId === 'terminalSearch' ||
          actionId === 'copyLastOutput' ||
          actionId === 'snippets' ||
          actionId === 'rerunWithSudo';
        if (
          isMatch &&
          terminalOnly &&
          !(document.activeElement as HTMLElement | null)?.closest?.('[data-testid="terminal-view"]')
        ) {
          continue;
        }
        // Switched off in Settings: leave the key free instead of swallowing it.
        if (isMatch && actionId === 'globalSearch' && settings.enableGlobalSearch === false) continue;

        if (isMatch) {
          e.preventDefault();
          e.stopPropagation();
          // The focus-independent actions are shared with the global search (see globalActions.ts).
          if (isGlobalActionId(actionId)) {
            runGlobalAction(actionId, {
              newTab: handleNewTab,
              openProfiles: () => openTopLevelModal(() => setProfilesModalOpen(true)),
              openSettings: () => openTopLevelModal(() => setSettingsModalOpen(true)),
              newWindow: () => void window.multissh.windowNew(),
              showShortcuts: openShortcutsHelp,
            });
            break;
          }
          switch (actionId) {
            case 'closeTab':
              if (activeTabId) handleCloseTab(activeTabId);
              break;
            case 'nextTab': {
              if (tabs.length > 1) {
                const idx = tabs.findIndex((t) => t.id === activeTabId);
                const currentIdx = idx >= 0 ? idx : 0;
                const nextIdx = (currentIdx + 1) % tabs.length;
                setActiveTabId(tabs[nextIdx].id);
              }
              break;
            }
            case 'prevTab': {
              if (tabs.length > 1) {
                const idx = tabs.findIndex((t) => t.id === activeTabId);
                const currentIdx = idx >= 0 ? idx : 0;
                const prevIdx = (currentIdx - 1 + tabs.length) % tabs.length;
                setActiveTabId(tabs[prevIdx].id);
              }
              break;
            }
            case 'globalSearch':
              openTopLevelModal(() => setGlobalSearchOpen(true));
              break;
            case 'splitVertical':
              if (activeTabId) handleSplitPane(activeTabId, 'row');
              break;
            case 'splitHorizontal':
              if (activeTabId) handleSplitPane(activeTabId, 'column');
              break;
            case 'closePane':
            case 'zoomPane': {
              const activeTab = tabs.find((t) => t.id === activeTabId);
              if (!activeTab || activeTab.type !== 'terminal' || !activeTab.paneTree) break;
              if (collectLeafIds(activeTab.paneTree).length < 2) break; // a sole pane has nothing to close or zoom
              if (actionId === 'zoomPane') handleToggleZoom(activeTab.id, activeTab.activePaneId);
              else if (activeTab.activePaneId) handleClosePane(activeTab.id, activeTab.activePaneId);
              break;
            }
            case 'openTabMenu':
              if (activeTabId) openTabMenuFor(activeTabId);
              break;
            case 'moveTabToNewWindow':
              if (activeTabId) handleMoveTabToNewWindow(activeTabId);
              break;
            case 'navigateLeft':
            case 'navigateRight':
            case 'navigateUp':
            case 'navigateDown': {
              const dir: NavigationDirection =
                actionId === 'navigateLeft'
                  ? 'left'
                  : actionId === 'navigateRight'
                    ? 'right'
                    : actionId === 'navigateUp'
                      ? 'up'
                      : 'down';

              // If an overlay (modal dialog, menu popup) is active, navigate within its elements
              const overlay = getTopmostOverlay();
              if (overlay) {
                const handled = navigateInOverlay(overlay, dir);
                if (handled) break;
              }

              if (anyTopLevelModalOpen || overlay) break;

              if (tabBarFocused) {
                if (dir === 'left' && tabs.length > 1) {
                  const idx = tabs.findIndex((t) => t.id === activeTabId);
                  const currentIdx = idx >= 0 ? idx : 0;
                  const prevIdx = (currentIdx - 1 + tabs.length) % tabs.length;
                  setActiveTabId(tabs[prevIdx].id);
                } else if (dir === 'right' && tabs.length > 1) {
                  const idx = tabs.findIndex((t) => t.id === activeTabId);
                  const currentIdx = idx >= 0 ? idx : 0;
                  const nextIdx = (currentIdx + 1) % tabs.length;
                  setActiveTabId(tabs[nextIdx].id);
                } else if (dir === 'down') {
                  focusActiveTabContent();
                }
                break;
              }

              const activeTab = tabs.find((t) => t.id === activeTabId);
              if (!activeTab) {
                if (dir === 'up') {
                  setTabBarFocused(true);
                  (document.activeElement as HTMLElement | null)?.blur?.();
                } else {
                  const landing = document.querySelector<HTMLElement>('[data-testid="landing-view"]');
                  if (landing) navigateInOverlay(landing, dir);
                }
                break;
              }

              if (activeTab.type === 'filemanager') {
                if (dir === 'up') {
                  setTabBarFocused(true);
                  (document.activeElement as HTMLElement | null)?.blur?.();
                } else if (dir === 'down') {
                  const pane = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(
                    '[data-testid^="file-pane-"]'
                  );
                  const side = pane?.getAttribute('data-testid') === 'file-pane-right' ? 'right' : 'left';
                  window.dispatchEvent(new CustomEvent(FILEMANAGER_FOCUS_SIDE_EVENT, { detail: side }));
                } else if (dir === 'left') {
                  window.dispatchEvent(
                    new CustomEvent(FILEMANAGER_FOCUS_SIDE_EVENT, { detail: 'left' })
                  );
                } else if (dir === 'right') {
                  window.dispatchEvent(
                    new CustomEvent(FILEMANAGER_FOCUS_SIDE_EVENT, { detail: 'right' })
                  );
                }
                break;
              }

              if (activeTab.type === 'terminal' && activeTab.paneTree) {
                const paneEls = Array.from(
                  document.querySelectorAll<HTMLElement>('[data-testid^="terminal-pane-"]')
                ).filter((el) => el.offsetParent !== null);

                const paneRects: PaneRect[] = paneEls.map((el) => {
                  const id = el.getAttribute('data-testid')!.replace('terminal-pane-', '');
                  const r = el.getBoundingClientRect();
                  return {
                    id,
                    rect: {
                      left: r.left,
                      top: r.top,
                      right: r.right,
                      bottom: r.bottom,
                      width: r.width,
                      height: r.height,
                    },
                  };
                });

                const currentPaneId = activeTab.activePaneId || paneRects[0]?.id || '';
                const target = findAdjacentPane(paneRects, currentPaneId, dir);

                if (target?.type === 'to_tab_bar') {
                  setTabBarFocused(true);
                  (document.activeElement as HTMLElement | null)?.blur?.();
                } else if (target?.type === 'pane') {
                  handleSelectPane(activeTab.id, target.id);
                  const xterm = document.querySelector<HTMLTextAreaElement>(
                    `[data-testid="terminal-pane-${target.id}"] .xterm-helper-textarea`
                  );
                  if (xterm) {
                    xterm.focus();
                  } else {
                    const btn = document.querySelector<HTMLElement>(
                      `[data-testid="unconnected-pane-${target.id}"] button:not([disabled]), [data-testid="terminal-pane-${target.id}"] button:not([disabled])`
                    );
                    btn?.focus();
                  }
                } else if (!target || paneRects.length <= 1) {
                  const currentUnconnected = document.querySelector<HTMLElement>(
                    `[data-testid="unconnected-pane-${currentPaneId}"]`
                  );
                  if (currentUnconnected) {
                    navigateInOverlay(currentUnconnected, dir);
                  }
                }
              }
              break;
            }
            case 'nextPane':
            case 'prevPane': {
              const activeTab = tabs.find((t) => t.id === activeTabId);
              if (!activeTab || activeTab.type !== 'terminal' || !activeTab.paneTree) break;
              const leafIds = collectLeafIds(activeTab.paneTree);
              if (leafIds.length < 2 || activeTab.zoomedPaneId) break; // zoomed: the other panes are hidden
              const currentIdx = activeTab.activePaneId ? leafIds.indexOf(activeTab.activePaneId) : -1;
              const step = actionId === 'nextPane' ? 1 : -1;
              const nextIdx = currentIdx === -1 ? 0 : (currentIdx + step + leafIds.length) % leafIds.length;
              const nextPaneId = leafIds[nextIdx];
              handleSelectPane(activeTab.id, nextPaneId);
              document
                .querySelector<HTMLTextAreaElement>(
                  `[data-testid="terminal-pane-${nextPaneId}"] .xterm-helper-textarea`
                )
                ?.focus();
              break;
            }
            case 'clipboardHistory':
              window.dispatchEvent(new CustomEvent(OPEN_CLIPBOARD_HISTORY_EVENT));
              break;
            case 'terminalSearch':
            case 'copyLastOutput':
            case 'snippets':
            case 'rerunWithSudo':
              dispatchTerminalAction(actionId === 'terminalSearch' ? 'search' : actionId);
              break;
            case 'increaseFontSize':
            case 'decreaseFontSize':
            case 'resetFontSize': {
              const current = settings.terminalFontSize || DEFAULT_SETTINGS.terminalFontSize;
              const next =
                actionId === 'increaseFontSize'
                  ? Math.min(current + 1, 32)
                  : actionId === 'decreaseFontSize'
                    ? Math.max(current - 1, 8)
                    : DEFAULT_SETTINGS.terminalFontSize;
              if (next === current) break;
              setSettings((prev) => ({ ...prev, terminalFontSize: next }));
              // Only this key (the app's copy of the others can be out of date, see settingsSave.ts), and
              // outside the updater, which has to be pure.
              void window.multissh?.settingsSave?.({ terminalFontSize: next });
              break;
            }
            default: {
              const tabNumber = /^selectTab([1-9])$/.exec(actionId)?.[1];
              const tab = tabNumber ? tabForNumber(tabs, Number(tabNumber)) : null;
              if (tab) setActiveTabId(tab.id);
            }
          }
          break;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [
    tabs,
    activeTabId,
    tabBarFocused,
    anyTopLevelModalOpen,
    settings.shortcuts,
    settings.terminalFontSize,
    settings.enableGlobalSearch,
    setActiveTabId,
    setTabBarFocused,
    setSettings,
    setProfilesModalOpen,
    setSettingsModalOpen,
    setGlobalSearchOpen,
    openTopLevelModal,
    handleNewTab,
    handleCloseTab,
    handleMoveTabToNewWindow,
    handleSplitPane,
    handleClosePane,
    handleToggleZoom,
    handleSelectPane,
    openShortcutsHelp,
    focusActiveTabContent,
  ]);
}
