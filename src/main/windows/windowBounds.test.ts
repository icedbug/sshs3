import { describe, it, expect } from 'vitest';
import { MIN_WINDOW_SIZE, minimumSizeFor, placeNewWindow, resolveWindowBounds } from './windowBounds';

const primary = { x: 0, y: 0, width: 1920, height: 1080 };
const second = { x: 1920, y: 0, width: 2560, height: 1440 };

describe('resolveWindowBounds', () => {
  it('keeps bounds that are on a connected display', () => {
    const saved = { x: 2000, y: 100, width: 1100, height: 700 };
    expect(resolveWindowBounds(saved, [primary, second], primary)).toEqual(saved);
  });

  it('falls back to the primary display when the saved monitor is gone', () => {
    const saved = { x: 2000, y: 100, width: 1100, height: 700 };
    expect(resolveWindowBounds(saved, [primary], primary)).toEqual({ x: 410, y: 190, width: 1100, height: 700 });
  });

  it('centers the default size when nothing is saved or the value is corrupt', () => {
    const expected = { x: 360, y: 140, width: 1200, height: 800 };
    expect(resolveWindowBounds(undefined, [primary], primary)).toEqual(expected);
    expect(resolveWindowBounds({ x: NaN, y: 0, width: 10, height: 10 }, [primary], primary)).toEqual(expected);
  });

  it('enforces a usable minimum size and fits oversized windows to the primary display', () => {
    expect(resolveWindowBounds({ x: 10, y: 10, width: 50, height: 50 }, [primary], primary)).toMatchObject({
      width: MIN_WINDOW_SIZE.width,
      height: MIN_WINDOW_SIZE.height,
    });
    expect(resolveWindowBounds({ x: 5000, y: 0, width: 4000, height: 3000 }, [primary], primary)).toEqual({
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    });
  });

  it('treats a window that only barely touches a display as off-screen', () => {
    const saved = { x: 1900, y: 0, width: 1100, height: 700 };
    expect(resolveWindowBounds(saved, [primary], primary).x).toBe(410);
  });
});

describe('minimumSizeFor', () => {
  it('is the full minimum on a roomy display', () => {
    expect(minimumSizeFor({ width: 1920, height: 1080 })).toEqual(MIN_WINDOW_SIZE);
  });

  it('never exceeds a small or heavily scaled display, so the window can still fit on the screen', () => {
    expect(minimumSizeFor({ width: 910, height: 512 })).toEqual({ width: 910, height: 512 });
    expect(minimumSizeFor({ width: 1366, height: 500 })).toEqual({ width: 1024, height: 500 });
  });

  it('keeps restored bounds within a small primary display', () => {
    const small = { x: 0, y: 0, width: 910, height: 512 };
    expect(resolveWindowBounds({ x: 0, y: 0, width: 300, height: 200 }, [small], small)).toMatchObject({ width: 910, height: 512 });
  });
});

describe('MIN_WINDOW_SIZE', () => {
  it('is at least 1024 px wide, the narrowest width the layout is built for', () => {
    expect(MIN_WINDOW_SIZE.width).toBeGreaterThanOrEqual(1024);
  });
});

describe('placeNewWindow', () => {
  const focusedBounds = { x: 100, y: 100, width: 1100, height: 700 };

  it('centers on the display the pointer is on when it differs from the focused window', () => {
    const r = placeNewWindow(second, { bounds: focusedBounds, workArea: primary });
    expect(r).toEqual({ x: 1920 + 680, y: 320, width: 1200, height: 800 });
  });

  it('cascades from the focused window on the same display', () => {
    expect(placeNewWindow(primary, { bounds: focusedBounds, workArea: primary })).toEqual({
      x: 130,
      y: 130,
      width: 1100,
      height: 700,
    });
  });

  it('centers on the pointer display when there is no focused window', () => {
    expect(placeNewWindow(primary, null)).toEqual({ x: 360, y: 140, width: 1200, height: 800 });
  });
});
