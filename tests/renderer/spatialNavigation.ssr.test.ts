// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { isElementVisible } from '../../src/renderer/src/lib/spatialNavigation';

describe('isElementVisible without a window (server-side rendering, node)', () => {
  it('treats a connected element as visible, because there is no layout to ask', () => {
    expect(isElementVisible({ isConnected: true } as unknown as HTMLElement)).toBe(true);
  });

  it('still refuses an element that is not connected', () => {
    expect(isElementVisible({ isConnected: false } as unknown as HTMLElement)).toBe(false);
  });
});
