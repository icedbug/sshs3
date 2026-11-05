import type { TabItem } from '../components/TabBar';
import type { SSHConnectionConfig } from '@shared/types/ssh';
import type { PaneNode } from '@shared/types/session';
import type { K8sTerminalTarget } from '@shared/types/kubernetes';
import type { FileEntry, S3Config } from '@shared/types/storage';
import type { SourceType } from '../components/FileManager/types';
import { sanitizePaneNode, sanitizeTabConfigs } from '@shared/sessionSanitize';
import { createLeaf } from './paneTree';
import type { FileManagerSnapshot } from './fileManagerState';

export interface AppTab extends TabItem {
  /** Terminal tabs always carry a pane tree, even when it's a single leaf. */
  paneTree?: PaneNode;
  /** The pane the user last interacted with; keyboard shortcuts (split/close) target this pane. */
  activePaneId?: string;
  /** When set, only this pane is shown (tmux-style zoom); the other panes keep running hidden. */
  zoomedPaneId?: string;
  initialCwd?: string;
  /** Set when opening a filemanager tab focused on a K8s container. */
  initialK8sTarget?: K8sTerminalTarget;
  /** Set when opening a filemanager tab focused on an SSH/SFTP profile. */
  initialSSHConfig?: SSHConnectionConfig;
  /** Filemanager tab opened as "remote": the right pane asks for a connection straight away. */
  promptRemote?: boolean;
  /** Set when opening a filemanager tab focused on an S3 profile. */
  initialS3Config?: S3Config;
  /** Set when opening a filemanager tab focused on a local directory. */
  initialLocalPath?: string;
  /** Optional file or directory path to select and highlight once the directory contents load. */
  initialSelectedPath?: string;
  /** Set on a file manager tab that moved here from another window: show these panes as they were. Never saved. */
  restoredPanes?: FileManagerSnapshot;
  /** Set when opening an editor tab. */
  editorEntry?: FileEntry;
  editorProviderId?: string;
  editorSourceType?: SourceType;
  editorInitialMode?: 'source' | 'preview';
  editorTailMode?: boolean;
  editorInitialContent?: string;
}

/** True when a terminal tab has a single, not-yet-connected pane (safe to fill in-place instead of opening a new tab). */
export function isEmptyUnconnectedTab(tab: AppTab): boolean {
  if (tab.type !== 'terminal' || !tab.paneTree) return true;
  const pane = tab.paneTree;
  return pane.type === 'leaf' && !pane.config && !pane.local && !pane.k8sTarget && !pane.k8sLogTarget;
}

/** Ensures every terminal tab carries a pane tree, synthesizing a single leaf for legacy/corrupted saved state. */
export function normalizeTab(tab: AppTab): AppTab {
  if (tab.type !== 'terminal') return tab;
  if (tab.paneTree) return tab;
  return { ...tab, paneTree: createLeaf(`${tab.id}-root`) };
}

/**
 * The tab a "go to tab N" shortcut selects: 1..8 is that tab, 9 is always the last one (browser
 * convention). Null when there is no such tab.
 */
export function tabForNumber(tabs: AppTab[], n: number): AppTab | null {
  if (n === 9) return tabs[tabs.length - 1] ?? null;
  return n >= 1 ? (tabs[n - 1] ?? null) : null;
}

export function sanitizeTabForSession(rawTab: AppTab): AppTab {
  // initialSSHConfig / initialS3Config hold the connection with its secrets, on tabs with or without a pane tree.
  const tab = sanitizeTabConfigs(rawTab);
  if (tab.restoredPanes) {
    // Only meaningful while the providers it names are still connected, i.e. right after a move.
    const { restoredPanes: _restoredPanes, ...withoutPanes } = tab;
    return sanitizeTabForSession(withoutPanes);
  }
  if (tab.type === 'editor') {
    const { editorInitialContent: _editorInitialContent, ...rest } = tab;
    return rest;
  }
  if (!tab.paneTree) return tab;
  // The zoom is a transient view state; a restored session starts with every pane visible.
  const { zoomedPaneId: _zoomedPaneId, ...rest } = tab;
  return {
    ...rest,
    paneTree: sanitizePaneNode(tab.paneTree),
  };
}
