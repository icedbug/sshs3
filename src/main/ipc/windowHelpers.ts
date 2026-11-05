import type { MoveTabTarget, TabHandoff, TabHandoffSession } from '../../shared/types/ipc';

const MAX_SESSIONS = 64;
const MAX_ID_LENGTH = 256;
/** A tab snapshot is a few KB; this only guards against a runaway payload. */
const MAX_TAB_JSON_LENGTH = 1_000_000;
const TAB_TYPES = new Set(['terminal', 'filemanager', 'editor']);

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

/** Validates a tab handoff coming from a renderer; throws on anything malformed. */
export function parseTabHandoff(value: unknown): TabHandoff {
  if (!value || typeof value !== 'object') throw new Error('Invalid tab handoff');
  const { tab, sessions } = value as { tab?: unknown; sessions?: unknown };
  if (!tab || typeof tab !== 'object' || Array.isArray(tab)) throw new Error('Invalid tab handoff');
  const t = tab as Record<string, unknown>;
  if (!isId(t.id) || typeof t.type !== 'string' || !TAB_TYPES.has(t.type)) throw new Error('Invalid tab handoff');
  if (JSON.stringify(t).length > MAX_TAB_JSON_LENGTH) throw new Error('Tab handoff is too large');

  if (!Array.isArray(sessions) || sessions.length > MAX_SESSIONS) throw new Error('Invalid tab handoff sessions');
  const parsed: TabHandoffSession[] = sessions.map((s) => {
    const entry = s as Partial<TabHandoffSession> | null;
    if (!entry || !isId(entry.paneId) || !isId(entry.sessionId) || (entry.kind !== 'ssh' && entry.kind !== 'k8s')) {
      throw new Error('Invalid tab handoff session');
    }
    return { paneId: entry.paneId, sessionId: entry.sessionId, kind: entry.kind };
  });
  return { tab: t, sessions: parsed };
}

export function parseMoveTarget(value: unknown): MoveTabTarget {
  if (value === 'new') return 'new';
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  throw new Error('Invalid window target');
}
