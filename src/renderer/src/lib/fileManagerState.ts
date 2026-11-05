import type { PaneSide, PaneSource } from '../components/FileManager/types';

export interface FileManagerPaneSnapshot {
  source: PaneSource;
  path: string;
}

/** What a file manager tab shows right now; carried along when the tab moves to another window. */
export interface FileManagerSnapshot {
  left: FileManagerPaneSnapshot;
  right: FileManagerPaneSnapshot;
  activeSide: PaneSide;
  splitRatio: number;
}

const getters = new Map<string, () => FileManagerSnapshot | null>();

/** Lets a mounted file manager tab be asked for its current state. Returns the unregister function. */
export function registerFileManager(tabId: string, getSnapshot: () => FileManagerSnapshot | null): () => void {
  getters.set(tabId, getSnapshot);
  return () => {
    if (getters.get(tabId) === getSnapshot) getters.delete(tabId);
  };
}

export function getFileManagerSnapshot(tabId: string): FileManagerSnapshot | null {
  return getters.get(tabId)?.() ?? null;
}
