import { describe, it, expect } from 'vitest';
import type { SavedTab, SessionData } from '../../shared/types/session';
import {
  mergeWindowBounds,
  mergeWindowSave,
  removeWindow,
  restorableWindows,
  sessionViewForWindow,
} from './windowSessions';

const tab = (id: string): SavedTab => ({ id, type: 'terminal', title: id });
const bounds = { x: 10, y: 20, width: 800, height: 600 };

describe('windowSessions', () => {
  it('saves the main window into the top-level fields and keeps secondary windows', () => {
    const stored: SessionData = {
      tabs: [tab('old')],
      activeTabId: 'old',
      windows: [{ key: 'w2', tabs: [tab('b')], activeTabId: 'b' }],
    };
    const next = mergeWindowSave(stored, null, { tabs: [tab('a')], activeTabId: 'a', lastPaths: { p: '/x' } });
    expect(next.tabs).toEqual([tab('a')]);
    expect(next.lastPaths).toEqual({ p: '/x' });
    expect(next.windows).toEqual(stored.windows);
  });

  it('saves a secondary window into its own entry without touching the main tabs', () => {
    const stored: SessionData = { tabs: [tab('a')], activeTabId: 'a' };
    const next = mergeWindowSave(stored, 'w2', { tabs: [tab('b')], activeTabId: 'b' });
    expect(next.tabs).toEqual([tab('a')]);
    expect(next.windows).toEqual([{ key: 'w2', tabs: [tab('b')], activeTabId: 'b' }]);
  });

  it('keeps a secondary window bounds when its tabs are saved, and the reverse', () => {
    let s = mergeWindowBounds(null, 'w2', bounds, true);
    s = mergeWindowSave(s, 'w2', { tabs: [tab('b')], activeTabId: 'b' });
    expect(s.windows?.[0]).toMatchObject({ key: 'w2', bounds, maximized: true, tabs: [tab('b')] });
    s = mergeWindowBounds(s, 'w2', { ...bounds, x: 0 }, false);
    expect(s.windows?.[0]).toMatchObject({ bounds: { ...bounds, x: 0 }, maximized: false, tabs: [tab('b')] });
  });

  it('stores main window bounds at the top level', () => {
    expect(mergeWindowBounds(null, null, bounds, false)).toMatchObject({ mainBounds: bounds, mainMaximized: false, tabs: [] });
  });

  it('gives a secondary window its own tabs and the shared paths as its session view', () => {
    const stored: SessionData = {
      tabs: [tab('a')],
      activeTabId: 'a',
      lastPaths: { p: '/x' },
      windows: [{ key: 'w2', tabs: [tab('b')], activeTabId: 'b' }],
    };
    expect(sessionViewForWindow(stored, null)).toBe(stored);
    const view = sessionViewForWindow(stored, 'w2');
    expect(view).toMatchObject({ tabs: [tab('b')], activeTabId: 'b', lastPaths: { p: '/x' } });
    expect(view?.windows).toBeUndefined();
    expect(sessionViewForWindow(stored, 'unknown')?.tabs).toEqual([]);
  });

  it('removes a closed window and only restores windows that still have tabs', () => {
    const stored: SessionData = {
      tabs: [],
      activeTabId: '',
      windows: [
        { key: 'w2', tabs: [tab('b')], activeTabId: 'b' },
        { key: 'w3', tabs: [], activeTabId: '' },
      ],
    };
    expect(restorableWindows(stored).map((w) => w.key)).toEqual(['w2']);
    expect(removeWindow(stored, 'w2')?.windows?.map((w) => w.key)).toEqual(['w3']);
    expect(removeWindow(removeWindow(stored, 'w2'), 'w3')?.windows).toBeUndefined();
    expect(removeWindow(null, 'w2')).toBeNull();
  });
});
