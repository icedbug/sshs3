import { useCallback, useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { MoveTabTarget, TabHandoff } from '@shared/types/ipc';
import { markDetached, queueAttach, unmarkDetached } from './liveSessions';
import { createRendererLogger } from './log';
import type { AppTab } from './tabs';
import { adoptedTab, buildTabHandoff, canMoveTab } from './tabTransfer';

const log = createRendererLogger('tab-transfer');

/**
 * Moving tabs between windows: hands a tab (and its running terminal sessions) to a new or another
 * window, and takes over tabs handed to this one. Tabs that arrive before the saved session has
 * loaded wait for it, so restoring the session cannot overwrite them.
 */
export function useTabTransfer(
  tabs: AppTab[],
  activeTabId: string,
  sessionLoaded: boolean,
  setTabs: Dispatch<SetStateAction<AppTab[]>>,
  setActiveTabId: Dispatch<SetStateAction<string>>
): { moveTab: (tabId: string, target: MoveTabTarget) => Promise<void> } {
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const sessionLoadedRef = useRef(sessionLoaded);
  sessionLoadedRef.current = sessionLoaded;
  const waiting = useRef<TabHandoff[]>([]);

  const addTab = useCallback(
    (handoff: TabHandoff) => {
      queueAttach(handoff.sessions);
      const tab = adoptedTab(handoff);
      setTabs((prev) => (prev.some((t) => t.id === tab.id) ? prev : [...prev, tab]));
      setActiveTabId(tab.id);
    },
    [setTabs, setActiveTabId]
  );

  const adopt = useCallback(
    (handoff: TabHandoff) => {
      if (sessionLoadedRef.current) addTab(handoff);
      else waiting.current.push(handoff);
    },
    [addTab]
  );

  useEffect(() => window.multissh?.onWindowAdoptTab?.(adopt), [adopt]);

  // The tab a newly opened window was created for. Not cancelled on cleanup: the handoff can be
  // fetched only once, so a StrictMode remount must still apply the result of the first call.
  useEffect(() => {
    if (!sessionLoaded) return;
    for (const handoff of waiting.current.splice(0)) addTab(handoff);
    void window.multissh
      ?.windowTakeHandoff?.()
      .then((handoff) => {
        if (handoff) addTab(handoff);
      })
      .catch((err) => log.warn('could not fetch the tab for this window', err));
  }, [sessionLoaded, addTab]);

  const moveTab = useCallback(
    async (tabId: string, target: MoveTabTarget) => {
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (!tab || !canMoveTab(tab) || !window.multissh?.windowMoveTab) return;
      const handoff = buildTabHandoff(tab);
      const sessionIds = handoff.sessions.map((s) => s.sessionId);
      // The pane that shows a session must not kill it when it unmounts: the other window takes it over.
      markDetached(sessionIds);
      try {
        await window.multissh.windowMoveTab(handoff, target);
      } catch (err) {
        unmarkDetached(sessionIds);
        log.warn('moving the tab failed', err);
        return;
      }
      setTabs((prev) => {
        const index = prev.findIndex((t) => t.id === tabId);
        const remaining = prev.filter((t) => t.id !== tabId);
        if (tabId === activeTabIdRef.current && remaining.length > 0) {
          setActiveTabId(remaining[Math.max(0, index - 1)].id);
        }
        return remaining;
      });
    },
    [setTabs, setActiveTabId]
  );

  return { moveTab };
}
