import { SHORTCUT_DEFINITIONS } from '@shared/types/settings';
import type { TabType } from '../components/TabBar';
import type { SearchEntry } from './globalSearchIndex';
import { getShortcutKeys } from './shortcuts';

/**
 * The shortcut actions that do the same thing wherever the focus is: they open a tab, a dialog or a
 * window and read nothing from the focused terminal, pane or overlay. Those can be started from the
 * keyboard and from the global search alike. Everything tied to the focus (closing or splitting a
 * pane, moving between panes, terminal-only keys) stays in `useAppKeyboard`.
 */
export const GLOBAL_ACTION_IDS = [
  'newTerminal',
  'newFileManager',
  'newRemoteFileManager',
  'newWindow',
  'openProfiles',
  'openSettings',
  'showShortcuts',
] as const;

export type GlobalActionId = (typeof GLOBAL_ACTION_IDS)[number];

export function isGlobalActionId(id: string): id is GlobalActionId {
  return (GLOBAL_ACTION_IDS as readonly string[]).includes(id);
}

/** What each caller wires up; the mapping from action to handler lives in `runGlobalAction`. */
export interface GlobalActionHandlers {
  newTab: (type?: TabType, options?: { remote?: boolean }) => void;
  openProfiles: () => void;
  openSettings: () => void;
  newWindow: () => void;
  showShortcuts: () => void;
}

export function runGlobalAction(id: GlobalActionId, handlers: GlobalActionHandlers): void {
  switch (id) {
    case 'newTerminal':
      handlers.newTab('terminal');
      break;
    case 'newFileManager':
      handlers.newTab('filemanager');
      break;
    case 'newRemoteFileManager':
      handlers.newTab('filemanager', { remote: true });
      break;
    case 'newWindow':
      handlers.newWindow();
      break;
    case 'openProfiles':
      handlers.openProfiles();
      break;
    case 'openSettings':
      handlers.openSettings();
      break;
    case 'showShortcuts':
      handlers.showShortcuts();
      break;
  }
}

/** The actions as search entries: named like their shortcut, with the user's current key combination as the subtitle. */
export function buildActionEntries(shortcuts: Record<string, string> | undefined): SearchEntry[] {
  return GLOBAL_ACTION_IDS.map((id) => {
    const definition = SHORTCUT_DEFINITIONS.find((d) => d.id === id);
    return {
      id: `action:${id}`,
      kind: 'action' as const,
      title: definition?.name ?? id,
      subtitle: getShortcutKeys(id, shortcuts),
      tags: [],
      source: '',
      ref: id,
      sftp: false,
    };
  });
}
