import { describe, expect, it } from 'vitest';
import { desktopGeometry, parseDesktopState } from '../../src/main/ai/desktop/layout';

describe('native Hermes presentation', () => {
  it('preserves the requested panel width while clamping its visible geometry', () => {
    const state = parseDesktopState({ mode: 'panel', width: 600 });
    expect(desktopGeometry(state, { width: 800, height: 700 })).toEqual({
      terminal: { x: 0, y: 0, width: 320, height: 700 }, chatWidth: 480, visible: true,
    });
    expect(desktopGeometry(state, { width: 1400, height: 700 }).chatWidth).toBe(600);
    expect(state.width).toBe(600);
  });
  it('hides rather than destroys the terminal on expansion and restores it on collapse', () => {
    const panel = { mode: 'panel', width: 400 } as const;
    expect(desktopGeometry({ ...panel, mode: 'full' }, { width: 1200, height: 800 }).visible).toBe(false);
    expect(desktopGeometry(panel, { width: 1200, height: 800 }).terminal.width).toBe(800);
    expect(desktopGeometry({ ...panel, mode: 'closed' }, { width: 1200, height: 800 }).terminal.width).toBe(1200);
  });
  it('rejects unusable persisted settings and never produces negative terminal bounds', () => {
    expect(parseDesktopState({ mode: 'invalid', width: Infinity })).toEqual({ mode: 'panel', width: 380 });
    expect(parseDesktopState({ mode: 'full', width: 10000 })).toEqual({ mode: 'full', width: 640 });
    expect(desktopGeometry(parseDesktopState(null), { width: 180, height: 250 }).terminal.width).toBe(0);
  });
});
