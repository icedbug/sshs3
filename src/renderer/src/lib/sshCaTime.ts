/**
 * Utilities for computing and formatting remaining validity time for SSH CA certificates.
 */

export function calculateRemainingSeconds(
  expiresAt?: string,
  fallbackSeconds?: number,
  nowMs: number = Date.now()
): number {
  if (expiresAt) {
    const expMs = new Date(expiresAt).getTime();
    if (!Number.isNaN(expMs)) {
      return Math.max(0, Math.floor((expMs - nowMs) / 1000));
    }
  }
  return typeof fallbackSeconds === 'number' && Number.isFinite(fallbackSeconds)
    ? Math.max(0, Math.floor(fallbackSeconds))
    : 0;
}

export function formatRemainingTime(seconds: number): string {
  if (seconds <= 0) return 'Expired';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m remaining` : `${hours}h remaining`;
  }
  if (minutes > 0) {
    return `${minutes}m ${secs}s remaining`;
  }
  return `${secs}s remaining`;
}

export function getRemainingTimeColorClass(seconds: number): string {
  if (seconds <= 0) return 'text-rose-400';
  if (seconds < 120) return 'text-amber-400';
  return 'text-emerald-400';
}
