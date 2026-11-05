/**
 * Formats a Date or ISO date string into yyyy-mm-dd HH:mm (24h) format.
 * Missing/falsy input renders as "—"; wrap this locally if a call site
 * needs different wording (e.g. "Never") for that case, rather than
 * reimplementing the date formatting itself (LOW finding, code review —
 * this used to exist as three near-identical copies).
 */
export function formatDateTime(input?: string | number | Date | null): string {
  if (!input) return '—';
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return String(input);

  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');

  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

/** Same as formatDateTime but date only (yyyy-mm-dd); for validity ranges and other day-granular values. */
export function formatDate(input?: string | number | Date | null): string {
  const formatted = formatDateTime(input);
  return formatted.length === 16 ? formatted.slice(0, 10) : formatted;
}
