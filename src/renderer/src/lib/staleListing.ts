/** How long a remote listing may sit before returning to the window reloads it. */
export const STALE_LISTING_MS = 5 * 60_000;

/** True when a listing loaded at `loadedAt` (ms epoch; 0 = never) is old enough to reload on refocus. */
export function isListingStale(loadedAt: number, now: number, thresholdMs = STALE_LISTING_MS): boolean {
  return now - loadedAt >= thresholdMs;
}
