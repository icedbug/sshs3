import { describe, it, expect } from 'vitest';
import { chooseHoverCardSide, hoverCardRoom, placeHoverCard } from '../../src/renderer/src/lib/hoverCardPlacement';

const vp = { viewportWidth: 1000, viewportHeight: 700 };

describe('placeHoverCard', () => {
  it('opens right of and below the pointer when it fits', () => {
    expect(placeHoverCard({ x: 100, y: 100, width: 380, height: 300, ...vp })).toEqual({ left: 112, top: 116 });
  });

  it('flips left and above near the bottom-right corner', () => {
    expect(placeHoverCard({ x: 900, y: 600, width: 380, height: 300, ...vp })).toEqual({ left: 508, top: 284 });
  });

  it('keeps a card taller than the room below inside the viewport', () => {
    const { top } = placeHoverCard({ x: 100, y: 400, width: 380, height: 420, ...vp });
    expect(top + 420).toBeLessThanOrEqual(700 - 16);
    expect(top).toBeGreaterThanOrEqual(16);
  });

  it('clamps to the margin when the viewport is smaller than the card', () => {
    expect(placeHoverCard({ x: 50, y: 50, width: 380, height: 900, ...vp }).top).toBe(16);
  });
});

describe('chooseHoverCardSide', () => {
  it('opens below when there is room for the tallest card, above when only that side has', () => {
    expect(chooseHoverCardSide({ y: 100, reserveHeight: 280, viewportHeight: 700 })).toBe('below');
    expect(chooseHoverCardSide({ y: 600, reserveHeight: 280, viewportHeight: 700 })).toBe('above');
  });

  it('takes the side with more room when neither fits the tallest card', () => {
    expect(chooseHoverCardSide({ y: 250, reserveHeight: 280, viewportHeight: 520 })).toBe('below');
    expect(chooseHoverCardSide({ y: 300, reserveHeight: 280, viewportHeight: 520 })).toBe('above');
  });
});

describe('placeHoverCard with a fixed side', () => {
  it('keeps the card below the pointer even after it has grown', () => {
    const small = placeHoverCard({ x: 100, y: 250, width: 380, height: 135, ...vp, viewportHeight: 520, side: 'below' });
    const grown = placeHoverCard({ x: 100, y: 250, width: 380, height: 260, ...vp, viewportHeight: 520, side: 'below' });
    expect(small.top).toBe(266);
    // It is clamped into the viewport instead of jumping above the pointer.
    expect(grown.top + 260).toBeLessThanOrEqual(520 - 16);
    expect(grown.top).toBeGreaterThan(250 - 260 - 16);
  });

  it('anchors the bottom edge to the pointer when above, so growing extends upwards', () => {
    const small = placeHoverCard({ x: 100, y: 600, width: 380, height: 135, ...vp, side: 'above' });
    const grown = placeHoverCard({ x: 100, y: 600, width: 380, height: 260, ...vp, side: 'above' });
    expect(small.top + 135).toBe(600 - 16);
    expect(grown.top + 260).toBe(600 - 16);
  });
});

describe('hoverCardRoom', () => {
  it('is the space between the pointer and the viewport edge on that side, less the margins', () => {
    expect(hoverCardRoom({ y: 250, side: 'below', viewportHeight: 520 })).toBe(520 - 16 - 266);
    expect(hoverCardRoom({ y: 250, side: 'above', viewportHeight: 520 })).toBe(250 - 32);
  });

  it('a card capped to the room on its side stays clear of the pointer', () => {
    const viewportHeight = 520;
    const y = 250;
    const side = chooseHoverCardSide({ y, reserveHeight: 280, viewportHeight });
    const room = hoverCardRoom({ y, side, viewportHeight });
    const { top } = placeHoverCard({ x: 100, y, width: 380, height: room, ...vp, viewportHeight, side });
    if (side === 'below') expect(top).toBeGreaterThanOrEqual(y + 16);
    else expect(top + room).toBeLessThanOrEqual(y - 16);
  });
});
