import type { SessionData } from '@shared/types/session';

let chain: Promise<unknown> = Promise.resolve();

/**
 * Reads the saved session, lets `update` build the next one from it and saves that, one update at a
 * time. The tabs and the file manager's pane state share one session.json and each used to read it and
 * write it back on its own: two of them in flight at once meant the later save put the older tabs (or
 * panes) back over the newer ones. A failed update does not stop the ones queued behind it.
 */
export function updateSession(update: (current: SessionData | null) => SessionData): Promise<void> {
  const run = async () => {
    const api = window.multissh;
    if (!api.sessionGet || !api.sessionSave) return;
    await api.sessionSave(update((await api.sessionGet()) ?? null));
  };
  const result = chain.then(run, run);
  chain = result.catch(() => undefined);
  return result;
}
