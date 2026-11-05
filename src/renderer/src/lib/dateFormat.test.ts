import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime } from './dateFormat';

describe('formatDateTime', () => {
  it('formats as yyyy-mm-dd HH:mm (24h) in local time', () => {
    expect(formatDateTime(new Date(2026, 8, 25, 7, 5))).toBe('2026-09-25 07:05');
  });

  it('renders missing input as a dash and returns unparseable input unchanged', () => {
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime('not a date')).toBe('not a date');
  });
});

describe('formatDate', () => {
  it('formats as yyyy-mm-dd in local time', () => {
    expect(formatDate(new Date(2027, 8, 25, 23, 59))).toBe('2027-09-25');
  });

  it('renders missing input as a dash and returns unparseable input unchanged', () => {
    expect(formatDate(undefined)).toBe('—');
    expect(formatDate('not a date')).toBe('not a date');
  });
});
