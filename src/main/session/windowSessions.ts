import type { SavedWindow, SavedWindowBounds, SessionData } from '../../shared/types/session';

/**
 * The main window is stored in the top-level fields of SessionData (so older versions still read
 * it); every other window is an entry in `windows`. A window key of `null` means the main window.
 */
export type WindowKey = string | null;

const EMPTY: SessionData = { tabs: [], activeTabId: '' };

/** What a window's renderer sees as "the session": its own tabs plus the shared lastPaths/panes. */
export function sessionViewForWindow(stored: SessionData | null, key: WindowKey): SessionData | null {
  if (key === null || !stored) return stored;
  const own = stored.windows?.find((w) => w.key === key);
  return { ...stored, tabs: own?.tabs ?? [], activeTabId: own?.activeTabId ?? '', windows: undefined };
}

/** Applies a renderer's save to its own window; lastPaths and panes are shared by all windows. */
export function mergeWindowSave(stored: SessionData | null, key: WindowKey, incoming: SessionData): SessionData {
  const base = stored ?? EMPTY;
  const shared = { lastPaths: incoming.lastPaths, panes: incoming.panes };
  if (key === null) {
    return { ...base, ...shared, tabs: incoming.tabs, activeTabId: incoming.activeTabId };
  }
  const windows = upsertWindow(base.windows, key, { tabs: incoming.tabs, activeTabId: incoming.activeTabId });
  return { ...base, ...shared, windows };
}

export function mergeWindowBounds(
  stored: SessionData | null,
  key: WindowKey,
  bounds: SavedWindowBounds,
  maximized: boolean
): SessionData {
  const base = stored ?? EMPTY;
  if (key === null) return { ...base, mainBounds: bounds, mainMaximized: maximized };
  return { ...base, windows: upsertWindow(base.windows, key, { bounds, maximized }) };
}

/** Forgets a secondary window the user closed on purpose. */
export function removeWindow(stored: SessionData | null, key: string): SessionData | null {
  if (!stored?.windows) return stored;
  const windows = stored.windows.filter((w) => w.key !== key);
  return { ...stored, windows: windows.length > 0 ? windows : undefined };
}

/** Secondary windows worth reopening: those that still hold at least one tab. */
export function restorableWindows(stored: SessionData | null): SavedWindow[] {
  return (stored?.windows ?? []).filter((w) => Array.isArray(w.tabs) && w.tabs.length > 0);
}

function upsertWindow(
  windows: SavedWindow[] | undefined,
  key: string,
  patch: Partial<Omit<SavedWindow, 'key'>>
): SavedWindow[] {
  const list = windows ?? [];
  const existing = list.find((w) => w.key === key);
  if (!existing) return [...list, { key, tabs: [], activeTabId: '', ...patch }];
  return list.map((w) => (w.key === key ? { ...w, ...patch } : w));
}
