import { formatDate } from './dateFormat';

export interface RelativeTimeOptions {
  /** "Now" in epoch ms; injectable for tests. */
  now?: number;
  /** From this many days on the date is shown instead ("2 d ago" up to here). Default 7; Infinity keeps counting days. */
  dateAfterDays?: number;
}

/** A timestamp this far ahead of now (another machine's clock, via profile sync) is shown as a date, not "just now". */
const FUTURE_TOLERANCE_MS = 5 * 60_000;

/** "just now", "5 min ago", "3 h ago", "2 d ago"; older than `dateAfterDays` (or clearly in the future) falls back to yyyy-mm-dd. Empty for missing or invalid input. */
export function formatRelativeTime(iso: string | undefined, options: RelativeTimeOptions = {}): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const { now = Date.now(), dateAfterDays = 7 } = options;
  if (then - now > FUTURE_TOLERANCE_MS) return formatDate(iso);
  const minutes = Math.floor(Math.max(now - then, 0) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days < dateAfterDays ? `${days} d ago` : formatDate(iso);
}
