import { isDemoMode } from './demoMode';

/**
 * A demo process keeps the demo workspace on this machine: it never pushes to or pulls from shared or
 * remote state, so demo fixtures and demo-mode edits can never reach a teammate, a team bucket or another
 * device. These are the outward syncs it turns off. Connections the user explicitly opens to real targets
 * (SSH, SFTP, S3 browsing, connection tests) are not affected.
 *
 * Each sync checks this at its entry points (schedulers, timers, the services' push/pull methods), before
 * any connection is made, and reports the reason in its status.
 */
export type OutwardSync = 'S3 team workspace sync' | 'Team Vault sync' | 'Remote profile sync';

/** Why `sync` does not run in this process (demo mode), or undefined when it may run. */
export function outwardSyncDisabledReason(sync: OutwardSync): string | undefined {
  return isDemoMode() ? `${sync} is disabled in demo mode: nothing from the demo workspace leaves this machine.` : undefined;
}

/**
 * Throws a plain Error carrying the reason when `sync` is disabled. A plain Error, so the message reaches
 * the renderer without a class name in front of it (Electron prefixes only "Error: ", which it strips).
 */
export function assertOutwardSyncAllowed(sync: OutwardSync): void {
  const reason = outwardSyncDisabledReason(sync);
  if (reason) throw new Error(reason);
}
