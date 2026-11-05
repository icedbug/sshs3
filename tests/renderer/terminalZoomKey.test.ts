import { describe, it, expect } from 'vitest';
import { isTerminalZoomShortcut } from '../../src/renderer/src/lib/terminalZoomKey';

const key = (over: Partial<{ ctrlKey: boolean; metaKey: boolean; key: string; code: string }>) => ({
  ctrlKey: true,
  metaKey: false,
  key: '',
  code: '',
  ...over,
});

describe('isTerminalZoomShortcut', () => {
  it('recognises zoom in, zoom out and reset by the character the key produces', () => {
    expect(isTerminalZoomShortcut(key({ key: '+', code: 'Equal' }))).toBe(true); // US: Ctrl+Shift+=
    expect(isTerminalZoomShortcut(key({ key: '=', code: 'Equal' }))).toBe(true);
    expect(isTerminalZoomShortcut(key({ key: '-', code: 'Minus' }))).toBe(true);
    expect(isTerminalZoomShortcut(key({ key: '0', code: 'Digit0' }))).toBe(true);
    expect(isTerminalZoomShortcut(key({ key: '+', code: 'Minus' }))).toBe(true); // Swedish: the + key is physical Minus
    expect(isTerminalZoomShortcut(key({ key: '-', code: 'Slash' }))).toBe(true); // Swedish: the - key is physical Slash
    expect(isTerminalZoomShortcut(key({ key: 'a', code: 'NumpadAdd' }))).toBe(true);
    expect(isTerminalZoomShortcut(key({ key: 'a', code: 'NumpadSubtract' }))).toBe(true);
    expect(isTerminalZoomShortcut(key({ key: '-', code: 'Minus', ctrlKey: false, metaKey: true }))).toBe(true);
  });

  // Low finding (code review 2026-11-03): matching on the physical key code swallowed keys that are not zoom.
  it('lets Ctrl+Shift+- (readline undo, Ctrl+_) and the keys other layouts have on those physical keys reach the shell', () => {
    expect(isTerminalZoomShortcut(key({ key: '_', code: 'Minus' }))).toBe(false); // US: Ctrl+Shift+-
    expect(isTerminalZoomShortcut(key({ key: 'ß', code: 'Minus' }))).toBe(false); // German
    expect(isTerminalZoomShortcut(key({ key: '´', code: 'Equal' }))).toBe(false); // Swedish
  });

  it('needs Ctrl or Cmd', () => {
    expect(isTerminalZoomShortcut(key({ key: '-', code: 'Minus', ctrlKey: false }))).toBe(false);
    expect(isTerminalZoomShortcut(key({ key: '0', code: 'Digit0', ctrlKey: false }))).toBe(false);
  });
});
