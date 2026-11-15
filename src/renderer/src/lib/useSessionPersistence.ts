import { useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { PaneLeaf, PaneNode, SavedTab } from '@shared/types/session';
import { normalizeTab, sanitizeTabForSession, type AppTab } from './tabs';
import { updateSession } from './sessionUpdate';
import { collectLeaves } from './paneTree';
import { getLiveSession, queueAttach } from './liveSessions';
import { isWebBrowserMode } from './webClientBridge';
import { createRendererLogger } from './log';

const log = createRendererLogger('useSessionPersistence');

export const LIVE_SESSION_STORAGE_KEY = 'sshs3:web-live-sessions';
export const LIVE_SESSION_CHANGED_EVENT = 'sshs3:live-session-changed';

export interface PersistedLiveSession {
  paneId: string;
  sessionId: string;
  kind: 'ssh' | 'k8s';
}

type LiveSessionMap = Record<string, { sessionId: string; kind: 'ssh' | 'k8s' }>;
type LeafWithLiveSession = PaneLeaf & { liveSessionId?: string; liveSessionKind?: 'ssh' | 'k8s' };

export function readStoredLiveSessions(): LiveSessionMap {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return {};
    const raw = window.sessionStorage.getItem(LIVE_SESSION_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const clean: LiveSessionMap = {};
    for (const [paneId, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        entry &&
        typeof entry === 'object' &&
        typeof (entry as { sessionId?: unknown }).sessionId === 'string' &&
        ((entry as { sessionId: string }).sessionId.length > 0)
      ) {
        const kind = (entry as { kind?: unknown }).kind === 'k8s' ? 'k8s' : 'ssh';
        clean[paneId] = { sessionId: (entry as { sessionId: string }).sessionId, kind };
      }
    }
    return clean;
  } catch {
    return {};
  }
}

export function writeStoredLiveSessions(map: LiveSessionMap): void {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return;
    if (Object.keys(map).length === 0) {
      window.sessionStorage.removeItem(LIVE_SESSION_STORAGE_KEY);
    } else {
      window.sessionStorage.setItem(LIVE_SESSION_STORAGE_KEY, JSON.stringify(map));
    }
  } catch {
    // Ignore storage quota or private-mode errors
  }
}

/**
 * Updates the browser-tab persisted live PTY session mapping and notifies persistence hooks.
 */
export function persistLiveSession(
  paneId: string,
  sessionId: string | null,
  kind: 'ssh' | 'k8s' = 'ssh'
): void {
  const current = readStoredLiveSessions();
  if (sessionId) {
    current[paneId] = { sessionId, kind };
  } else {
    delete current[paneId];
  }
  writeStoredLiveSessions(current);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent(LIVE_SESSION_CHANGED_EVENT, {
        detail: { paneId, sessionId, kind },
      })
    );
  }
}

function mapPaneLeavesWithLiveSession(node: PaneNode, liveMap: LiveSessionMap): PaneNode {
  if (node.type === 'leaf') {
    const inMemory = getLiveSession(node.id);
    const entry = inMemory ?? liveMap[node.id];
    const leaf = node as LeafWithLiveSession;
    if (entry?.sessionId) {
      return {
        ...leaf,
        liveSessionId: entry.sessionId,
        liveSessionKind: entry.kind,
      } as PaneLeaf;
    }
    if ('liveSessionId' in leaf || 'liveSessionKind' in leaf) {
      const { liveSessionId: _sid, liveSessionKind: _kind, ...rest } = leaf;
      return rest;
    }
    return node;
  }
  return {
    ...node,
    children: node.children.map((child) => mapPaneLeavesWithLiveSession(child, liveMap)),
  };
}

export function attachLiveSessionsToTab(tab: AppTab, liveMap: LiveSessionMap): AppTab {
  if (!tab.paneTree) return tab;
  return {
    ...tab,
    paneTree: mapPaneLeavesWithLiveSession(tab.paneTree, liveMap),
  };
}

export function collectLiveSessionsFromTabs(
  tabs: ReadonlyArray<Pick<SavedTab, 'paneTree'>>,
  fallbackMap: LiveSessionMap = {}
): PersistedLiveSession[] {
  const result: PersistedLiveSession[] = [];
  for (const tab of tabs) {
    if (!tab.paneTree) continue;
    for (const leaf of collectLeaves(tab.paneTree)) {
      const withLive = leaf as LeafWithLiveSession;
      const fallback = fallbackMap[leaf.id];
      const sessionId = fallback?.sessionId || withLive.liveSessionId;
      if (!sessionId) continue;
      const kind: 'ssh' | 'k8s' =
        fallback?.kind ?? withLive.liveSessionKind ?? (leaf.k8sTarget ? 'k8s' : 'ssh');
      result.push({ paneId: leaf.id, sessionId, kind });
    }
  }
  return result;
}

/**
 * Restores the saved tabs on mount and saves them (credentials stripped) whenever tabs or the
 * active tab change. In web mode, also persists `liveSessionId` per pane so browser reloads
 * can re-attach cleanly to running backend PTY sessions when available.
 */
export function useSessionPersistence(
  tabs: AppTab[],
  activeTabId: string,
  setTabs: Dispatch<SetStateAction<AppTab[]>>,
  setActiveTabId: Dispatch<SetStateAction<string>>
): boolean {
  const [sessionLoaded, setSessionLoaded] = useState(false);
  // When the saved session could not be read, the app still opens, but it must not save over what is stored.
  const restoreFailed = useRef(false);
  const liveMapRef = useRef<LiveSessionMap>(isWebBrowserMode() ? readStoredLiveSessions() : {});
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const sessionLoadedRef = useRef(false);
  sessionLoadedRef.current = sessionLoaded;

  // Load saved session on mount
  useEffect(() => {
    const read = () => Promise.resolve(window.multissh.sessionGet?.());
    // One more try: a failed read is usually a hiccup, and giving up means nothing is saved this run.
    read()
      .catch(() => read())
      .then((session) => {
        if (session?.tabs && session.tabs.length > 0) {
          const normalized = session.tabs.map(normalizeTab);
          if (isWebBrowserMode()) {
            const storedMap = readStoredLiveSessions();
            const toAttach = collectLiveSessionsFromTabs(normalized, storedMap);
            if (toAttach.length > 0) {
              for (const entry of toAttach) {
                liveMapRef.current[entry.paneId] = { sessionId: entry.sessionId, kind: entry.kind };
              }
              queueAttach(toAttach.map((s) => ({ paneId: s.paneId, sessionId: s.sessionId, kind: s.kind })));
            }
          }
          setTabs(normalized);
          if (session.activeTabId && session.tabs.some((t) => t.id === session.activeTabId)) {
            setActiveTabId(session.activeTabId);
          } else {
            setActiveTabId(session.tabs[0].id);
          }
        }
      })
      .catch((err) => {
        restoreFailed.current = true;
        log.error('Failed to restore the saved session:', err);
      })
      .finally(() => setSessionLoaded(true));
  }, [setTabs, setActiveTabId]);

  // Listen for live PTY session registrations in web mode and persist liveSessionId updates
  useEffect(() => {
    const onLiveChanged = (e: Event) => {
      const detail = (e as CustomEvent<{ paneId?: string; sessionId?: string | null; kind?: 'ssh' | 'k8s' }>).detail;
      if (!detail?.paneId) return;
      if (detail.sessionId) {
        liveMapRef.current[detail.paneId] = {
          sessionId: detail.sessionId,
          kind: detail.kind === 'k8s' ? 'k8s' : 'ssh',
        };
      } else {
        delete liveMapRef.current[detail.paneId];
      }
      if (!isWebBrowserMode() || !sessionLoadedRef.current || restoreFailed.current) return;
      updateSession((current) => ({
        tabs: tabsRef.current.map((t) => sanitizeTabForSession(attachLiveSessionsToTab(t, liveMapRef.current))),
        activeTabId: activeTabIdRef.current,
        lastPaths: current?.lastPaths || {},
        panes: current?.panes,
      })).catch((err) => log.error('Failed to persist live session id:', err));
    };
    window.addEventListener(LIVE_SESSION_CHANGED_EVENT, onLiveChanged);
    return () => window.removeEventListener(LIVE_SESSION_CHANGED_EVENT, onLiveChanged);
  }, []);

  // Persist session whenever tabs or active tab change
  useEffect(() => {
    if (!sessionLoaded || restoreFailed.current) return;
    const webMode = isWebBrowserMode();
    if (webMode) {
      // Refresh liveMapRef from in-memory liveSessions for all current leaves
      for (const tab of tabs) {
        if (!tab.paneTree) continue;
        for (const leaf of collectLeaves(tab.paneTree)) {
          const live = getLiveSession(leaf.id);
          if (live) {
            liveMapRef.current[leaf.id] = live;
          }
        }
      }
      writeStoredLiveSessions(liveMapRef.current);
    }
    updateSession((current) => ({
      tabs: tabs.map((t) =>
        sanitizeTabForSession(webMode ? attachLiveSessionsToTab(t, liveMapRef.current) : t)
      ),
      activeTabId,
      lastPaths: current?.lastPaths || {},
      panes: current?.panes,
    })).catch((err) => log.error('Failed to save the session:', err));
  }, [tabs, activeTabId, sessionLoaded]);

  return sessionLoaded;
}
