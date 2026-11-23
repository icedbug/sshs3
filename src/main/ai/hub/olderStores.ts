/**
 * Fields an older sshs3 wrote and this one no longer has.
 *
 * Commands used to be rated (safe, modify, destructive) and some rules hung on that rating. The rating
 * is gone, so what it left behind in a stored hub is taken out when the store is read: it is not kept,
 * not shown and not written back. Nothing here decides anything.
 */

const POLICY_FIELDS = ["autoApproveSafeReadOnly", "blockDestructiveWithoutConfirm", "commandAllowPrefixes"] as const;
const CHANGE_FIELDS = ["riskLevel", "riskReason", "parsedSubcommands"] as const;

/** Takes the fields of the old command rating out of a hub's data as it was read from disk. */
export function dropCommandRating(data: { safetyPolicy?: unknown; tasks?: unknown }): void {
  if (data.safetyPolicy && typeof data.safetyPolicy === "object") {
    const policy = data.safetyPolicy as Record<string, unknown>;
    for (const field of POLICY_FIELDS) delete policy[field];
  }
  if (!Array.isArray(data.tasks)) return;
  for (const task of data.tasks as unknown[]) {
    if (!task || typeof task !== "object") continue;
    const stored = task as Record<string, unknown>;
    delete stored.sessionAllowPrefixes;
    if (!Array.isArray(stored.changes)) continue;
    for (const change of stored.changes as unknown[]) {
      if (!change || typeof change !== "object") continue;
      for (const field of CHANGE_FIELDS) delete (change as Record<string, unknown>)[field];
    }
  }
}
