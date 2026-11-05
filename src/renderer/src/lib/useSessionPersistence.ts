import { useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { normalizeTab, sanitizeTabForSession, type AppTab } from './tabs';
import { updateSession } from './sessionUpdate';
import { createRendererLogger } from './log';

const log = createRendererLogger('useSessionPersistence');

/**
 * Restores the saved tabs on mount and saves them (credentials stripped) whenever tabs or the
 * active tab change. Saving waits for the restore to finish so a fresh render never overwrites
 * the stored session with an empty one.
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

  // Load saved session on mount
  useEffect(() => {
    const read = () => Promise.resolve(window.multissh.sessionGet?.());
    // One more try: a failed read is usually a hiccup, and giving up means nothing is saved this run.
    read()
      .catch(() => read())
      .then((session) => {
        if (session?.tabs && session.tabs.length > 0) {
          setTabs(session.tabs.map(normalizeTab));
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

  // Persist session whenever tabs or active tab change
  useEffect(() => {
    if (!sessionLoaded || restoreFailed.current) return;
    updateSession((current) => ({
      tabs: tabs.map(sanitizeTabForSession),
      activeTabId,
      lastPaths: current?.lastPaths || {},
      panes: current?.panes,
    })).catch((err) => log.error('Failed to save the session:', err));
  }, [tabs, activeTabId, sessionLoaded]);

  return sessionLoaded;
}
