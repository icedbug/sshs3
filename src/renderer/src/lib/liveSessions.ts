import type { TabHandoffSession } from '@shared/types/ipc';

export interface LiveSession {
  sessionId: string;
  kind: 'ssh' | 'k8s';
}

/** How long a claimed session stays claimable by its pane: covers React StrictMode's dev remount. */
const RECENT_CLAIM_MS = 2000;
/** Grace before an attached session is killed after its view unmounts, so a remount can take it back. */
const KILL_GRACE_MS = 250;

/** Terminal sessions this window is showing, by pane id. */
const live = new Map<string, LiveSession>();
/** Sessions another window handed over, waiting for their pane to mount and attach. */
const pendingAttach = new Map<string, LiveSession>();
const recentClaims = new Map<string, LiveSession>();
const claimedAt = new Map<string, number>();
/** Sessions that moved to another window: the pane that showed them must not kill them on unmount. */
const detached = new Set<string>();

export function registerLiveSession(paneId: string, session: LiveSession): void {
  live.set(paneId, session);
}

export function unregisterLiveSession(paneId: string, sessionId: string): void {
  if (live.get(paneId)?.sessionId === sessionId) live.delete(paneId);
}

export function getLiveSession(paneId: string): LiveSession | undefined {
  return live.get(paneId);
}

/** Records the sessions of an adopted tab so each pane attaches to its running session instead of starting one. */
export function queueAttach(sessions: TabHandoffSession[]): void {
  for (const s of sessions) pendingAttach.set(s.paneId, { sessionId: s.sessionId, kind: s.kind });
}

/** The session a pane should attach to, if it was handed one (also again right after, for a remount). */
export function takeAttach(paneId: string): LiveSession | undefined {
  const session = pendingAttach.get(paneId) ?? recentClaims.get(paneId);
  if (!session) return undefined;
  pendingAttach.delete(paneId);
  recentClaims.set(paneId, session);
  claimedAt.set(session.sessionId, Date.now());
  setTimeout(() => {
    if (recentClaims.get(paneId) === session) recentClaims.delete(paneId);
  }, RECENT_CLAIM_MS);
  return session;
}

export function markDetached(sessionIds: string[]): void {
  for (const id of sessionIds) detached.add(id);
}

export function unmarkDetached(sessionIds: string[]): void {
  for (const id of sessionIds) detached.delete(id);
}

/** True (once) when the session moved away and so must be left running. */
export function consumeDetached(sessionId: string): boolean {
  return detached.delete(sessionId);
}

/** Kills an attached session shortly after its view went away, unless the pane claimed it again meanwhile. */
export function killUnlessReclaimed(sessionId: string, kill: (sessionId: string) => void): void {
  const unmountedAt = Date.now();
  setTimeout(() => {
    if ((claimedAt.get(sessionId) ?? 0) >= unmountedAt) return;
    kill(sessionId);
  }, KILL_GRACE_MS);
}

/** Test helper. */
export function resetLiveSessions(): void {
  live.clear();
  pendingAttach.clear();
  recentClaims.clear();
  claimedAt.clear();
  detached.clear();
}
