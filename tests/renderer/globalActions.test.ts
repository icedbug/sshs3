import { describe, it, expect, vi } from 'vitest';
import { GLOBAL_ACTION_IDS, buildActionEntries, isGlobalActionId, runGlobalAction } from '../../src/renderer/src/lib/globalActions';
import { SHORTCUT_DEFINITIONS } from '../../src/shared/types/settings';

const handlers = () => ({
  newTab: vi.fn(),
  openProfiles: vi.fn(),
  openSettings: vi.fn(),
  newWindow: vi.fn(),
  showShortcuts: vi.fn(),
});

describe('runGlobalAction', () => {
  it('opens a new terminal, file manager and remote file manager tab', () => {
    const h = handlers();
    runGlobalAction('newTerminal', h);
    runGlobalAction('newFileManager', h);
    runGlobalAction('newRemoteFileManager', h);
    expect(h.newTab.mock.calls).toEqual([['terminal'], ['filemanager'], ['filemanager', { remote: true }]]);
  });

  it('opens Connection Manager, Settings, a new window and the shortcuts overview', () => {
    const h = handlers();
    runGlobalAction('openProfiles', h);
    runGlobalAction('openSettings', h);
    runGlobalAction('newWindow', h);
    runGlobalAction('showShortcuts', h);
    expect(h.openProfiles).toHaveBeenCalledTimes(1);
    expect(h.openSettings).toHaveBeenCalledTimes(1);
    expect(h.newWindow).toHaveBeenCalledTimes(1);
    expect(h.showShortcuts).toHaveBeenCalledTimes(1);
    expect(h.newTab).not.toHaveBeenCalled();
  });

  it('runs exactly one handler per action', () => {
    for (const id of GLOBAL_ACTION_IDS) {
      const h = handlers();
      runGlobalAction(id, h);
      const calls = Object.values(h).reduce((sum, fn) => sum + fn.mock.calls.length, 0);
      expect(calls, id).toBe(1);
    }
  });
});

describe('isGlobalActionId', () => {
  it('accepts the focus-independent actions and nothing else', () => {
    expect(isGlobalActionId('newTerminal')).toBe(true);
    expect(isGlobalActionId('closeTab')).toBe(false);
    expect(isGlobalActionId('splitVertical')).toBe(false);
    expect(isGlobalActionId('navigateLeft')).toBe(false);
    expect(isGlobalActionId('')).toBe(false);
  });

  it('only names actions that exist as shortcuts, so their name and keys can be shown', () => {
    const known = new Set(SHORTCUT_DEFINITIONS.map((d) => d.id));
    for (const id of GLOBAL_ACTION_IDS) expect(known.has(id), id).toBe(true);
  });
});

describe('buildActionEntries', () => {
  it('lists every action with its shortcut name and live key combination', () => {
    const entries = buildActionEntries({ newTerminal: 'Ctrl+Alt+T' });
    expect(entries.map((e) => e.ref)).toEqual([...GLOBAL_ACTION_IDS]);
    const terminal = entries.find((e) => e.ref === 'newTerminal')!;
    expect(terminal).toMatchObject({
      id: 'action:newTerminal',
      kind: 'action',
      title: 'New Terminal',
      subtitle: 'Ctrl+Alt+T',
      tags: [],
      source: '',
      sftp: false,
    });
  });

  it('falls back to the default key combination', () => {
    const entries = buildActionEntries(undefined);
    expect(entries.find((e) => e.ref === 'openSettings')!.subtitle).toBe('Ctrl+,');
  });
});
