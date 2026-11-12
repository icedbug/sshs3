import type { WorkspaceActivityEvent } from "../../../shared/types/aiHub";

/**
 * Cuts the team's shared activity log into batches to be read for memory.
 *
 * Every app in the workspace holds the same log (it is synced) and the same
 * cursor (one small object in the bucket: the time up to which activity has
 * been handed over). A batch is a pure function of the log, the cursor and
 * the clock rounded down to the hour, so two apps that look at the same time
 * cut the same batch with the same id. Uploading it twice then overwrites one
 * record instead of creating two. That is what lets any teammate's app hand
 * over activity for a colleague whose computer is already closed.
 */

/** Batches end on these boundaries, so apps agree on where one ends. */
export const ACTIVITY_SLOT_MS = 3_600_000;
/** How long after a boundary a batch waits, so that teammates' changes have synced in. */
export const ACTIVITY_GRACE_MS = 30 * 60_000;
/** A batch is cut once this many changes are waiting … */
export const ACTIVITY_MIN_EVENTS = 8;
/** … or once the oldest waiting change is this old, however few there are. */
export const ACTIVITY_MAX_WAIT_MS = 6 * 3_600_000;
export const ACTIVITY_MAX_EVENTS = 80;
/** A workspace with no cursor yet starts this far back, not at the beginning of the log. */
export const ACTIVITY_FIRST_LOOKBACK_MS = 24 * 3_600_000;

export interface ActivityBatch {
  /** `activity:<from>-<through>`: the same for every app that cuts this batch. */
  id: string;
  from: number;
  /** The cursor after this batch. */
  through: number;
  /** Oldest first; empty when the cursor only moves past a quiet stretch. */
  events: WorkspaceActivityEvent[];
}

const slotStart = (time: number): number =>
  Math.floor(time / ACTIVITY_SLOT_MS) * ACTIVITY_SLOT_MS;

export function firstActivityCursor(now: number): number {
  return slotStart(now - ACTIVITY_FIRST_LOOKBACK_MS);
}

/**
 * The next batch after `cursor`, or undefined while there is nothing to hand
 * over yet (too few changes that are not old enough, or no new boundary).
 */
export function nextActivityBatch(
  log: WorkspaceActivityEvent[],
  cursor: number,
  now: number,
): ActivityBatch | undefined {
  const boundary = slotStart(now - ACTIVITY_GRACE_MS);
  if (boundary <= cursor) return undefined;
  const waiting = log
    .filter((e) => e.at > cursor && e.at <= boundary)
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  // A quiet stretch: nothing to read, the cursor just moves on.
  if (waiting.length === 0)
    return { id: `activity:${cursor}-${boundary}`, from: cursor, through: boundary, events: [] };
  const due =
    waiting.length >= ACTIVITY_MIN_EVENTS ||
    now - waiting[0].at >= ACTIVITY_MAX_WAIT_MS;
  if (!due) return undefined;
  if (waiting.length <= ACTIVITY_MAX_EVENTS)
    return { id: `activity:${cursor}-${boundary}`, from: cursor, through: boundary, events: waiting };
  // More than one record holds: cut at the last change that fits, keeping changes of the same instant together.
  const cut = waiting[ACTIVITY_MAX_EVENTS - 1].at;
  const events = waiting.filter((e) => e.at <= cut);
  return { id: `activity:${cursor}-${cut}`, from: cursor, through: cut, events };
}
