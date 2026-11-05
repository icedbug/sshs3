/**
 * Whether a key press in the terminal is the font zoom shortcut (Ctrl/Cmd with +, =, -, 0 or the numpad plus and
 * minus), which the terminal must leave to the app instead of sending to the shell. Decided by the character the
 * key produces, not by its physical position: `code === 'Minus'` also matches Ctrl+Shift+- (readline undo, Ctrl+_)
 * and, on other layouts, keys that type something else entirely. `Digit0` is kept as well, since Ctrl+0 means
 * nothing to a shell and a layout may not type "0" without Shift.
 */
export function isTerminalZoomShortcut(e: { ctrlKey: boolean; metaKey: boolean; key: string; code: string }): boolean {
  if (!e.ctrlKey && !e.metaKey) return false;
  return (
    e.key === '+' ||
    e.key === '=' ||
    e.key === '-' ||
    e.key === '0' ||
    e.code === 'NumpadAdd' ||
    e.code === 'NumpadSubtract' ||
    e.code === 'Digit0'
  );
}
