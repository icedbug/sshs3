import { describe, it, expect } from 'vitest';
import { formatRelativeTime } from './relativeTime';

describe('formatRelativeTime', () => {
  const now = Date.parse('2026-11-01T12:00:00Z');
  it('is relative for the last week and a date after that', () => {
    expect(formatRelativeTime('2026-11-01T11:59:50Z', { now })).toBe('just now');
    expect(formatRelativeTime('2026-11-01T11:55:00Z', { now })).toBe('5 min ago');
    expect(formatRelativeTime('2026-11-01T09:00:00Z', { now })).toBe('3 h ago');
    expect(formatRelativeTime('2026-10-30T12:00:00Z', { now })).toBe('2 d ago');
    expect(formatRelativeTime('2026-09-01T12:00:00Z', { now })).toMatch(/^2026-09-0[12]$/);
  });
  it('keeps counting days when dateAfterDays is Infinity', () => {
    expect(formatRelativeTime('2026-09-01T12:00:00Z', { now, dateAfterDays: Infinity })).toBe('61 d ago');
  });
  it('shows a date, not "just now", for a timestamp clearly in the future', () => {
    expect(formatRelativeTime('2026-11-05T12:00:00Z', { now })).toMatch(/^2026-11-0[45]$/);
    expect(formatRelativeTime('2026-11-01T12:02:00Z', { now })).toBe('just now');
  });
  it('is empty for missing or invalid input', () => {
    expect(formatRelativeTime(undefined, { now })).toBe('');
    expect(formatRelativeTime('nope', { now })).toBe('');
  });
});
