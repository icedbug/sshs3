import { describe, it, expect } from 'vitest';
import {
  calculateRemainingSeconds,
  formatRemainingTime,
  getRemainingTimeColorClass,
} from '../../src/renderer/src/lib/sshCaTime';

describe('sshCaTime', () => {
  describe('calculateRemainingSeconds', () => {
    it('calculates remaining seconds accurately from ISO string', () => {
      const now = new Date('2026-10-31T20:00:00.000Z').getTime();
      const expiresAt = '2026-10-31T20:05:00.000Z'; // 5 minutes later
      expect(calculateRemainingSeconds(expiresAt, undefined, now)).toBe(300);
    });

    it('returns 0 when expiration is in the past', () => {
      const now = new Date('2026-10-31T20:10:00.000Z').getTime();
      const expiresAt = '2026-10-31T20:05:00.000Z';
      expect(calculateRemainingSeconds(expiresAt, undefined, now)).toBe(0);
    });

    it('falls back to fallbackSeconds when expiresAt is missing or invalid', () => {
      expect(calculateRemainingSeconds(undefined, 120)).toBe(120);
      expect(calculateRemainingSeconds('invalid-date', 45)).toBe(45);
      expect(calculateRemainingSeconds(undefined, undefined)).toBe(0);
    });
  });

  describe('formatRemainingTime', () => {
    it('formats expired state', () => {
      expect(formatRemainingTime(0)).toBe('Expired');
      expect(formatRemainingTime(-10)).toBe('Expired');
    });

    it('formats seconds only when under one minute', () => {
      expect(formatRemainingTime(45)).toBe('45s remaining');
      expect(formatRemainingTime(1)).toBe('1s remaining');
    });

    it('formats minutes and seconds when under one hour', () => {
      expect(formatRemainingTime(300)).toBe('5m 0s remaining');
      expect(formatRemainingTime(299)).toBe('4m 59s remaining');
      expect(formatRemainingTime(75)).toBe('1m 15s remaining');
    });

    it('formats hours and minutes when one hour or more', () => {
      expect(formatRemainingTime(3600)).toBe('1h remaining');
      expect(formatRemainingTime(3660)).toBe('1h 1m remaining');
      expect(formatRemainingTime(57600)).toBe('16h remaining');
    });
  });

  describe('getRemainingTimeColorClass', () => {
    it('returns text-rose-400 for expired', () => {
      expect(getRemainingTimeColorClass(0)).toBe('text-rose-400');
      expect(getRemainingTimeColorClass(-5)).toBe('text-rose-400');
    });

    it('returns text-amber-400 for under 2 minutes', () => {
      expect(getRemainingTimeColorClass(119)).toBe('text-amber-400');
      expect(getRemainingTimeColorClass(30)).toBe('text-amber-400');
    });

    it('returns text-emerald-400 for 2 minutes or more', () => {
      expect(getRemainingTimeColorClass(120)).toBe('text-emerald-400');
      expect(getRemainingTimeColorClass(3600)).toBe('text-emerald-400');
    });
  });
});
