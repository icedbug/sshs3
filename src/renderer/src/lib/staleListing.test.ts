import { describe, expect, it } from 'vitest';
import { isListingStale, STALE_LISTING_MS } from './staleListing';

describe('isListingStale', () => {
  it('is fresh just after a load and stale once the threshold has passed', () => {
    expect(isListingStale(1_000, 1_000 + STALE_LISTING_MS - 1)).toBe(false);
    expect(isListingStale(1_000, 1_000 + STALE_LISTING_MS)).toBe(true);
  });

  it('treats a listing that never loaded as stale', () => {
    expect(isListingStale(0, Date.now())).toBe(true);
  });
});
