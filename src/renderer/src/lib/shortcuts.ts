import { DEFAULT_SHORTCUTS, SHORTCUT_DEFINITIONS } from '@shared/types/settings';

/**
 * Maps a physical key (KeyboardEvent.code) to the unshifted symbol it types on a standard
 * QWERTY layout. Used to recover the base symbol for a Shift-held combo: browsers report
 * KeyboardEvent.key as whatever character the *current keyboard layout* produces for that
 * physical key with Shift held (e.g. Shift+, -> '<' on a US layout, but '<' isn't universal —
 * on Swedish/Nordic ISO layouts the same physical key produces ';'). Comparing raw e.key values
 * against a hardcoded shortcut string is therefore layout-dependent and unreliable.
 */
const PHYSICAL_KEY_BASE_SYMBOLS: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  Digit0: '0',
  Digit1: '1',
  Digit2: '2',
  Digit3: '3',
  Digit4: '4',
  Digit5: '5',
  Digit6: '6',
  Digit7: '7',
  Digit8: '8',
  Digit9: '9',
};

export interface ShortcutKeyEventLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * Builds the canonical "Ctrl+Shift+X" combo string for a keydown event. Shared by the shortcut
 * recorder (Settings) and the runtime shortcut matcher (App) so a shortcut recorded on a given
 * machine/layout always matches what pressing that same physical key produces at runtime there —
 * even if KeyboardEvent.code turns out to be unreliable for a particular layout/platform, since
 * both sides fall back to the same raw e.key in that case and stay consistent with each other.
 * Returns null for a lone modifier keypress (nothing to bind yet).
 */
export function comboFromKeyboardEvent(e: ShortcutKeyEventLike): string | null {
  // `key` is typed as always-a-string, but some real-world keydown events (dead-key/compose
  // sequences, certain IME and virtual-keyboard input) fire with `key` missing or empty — nothing
  // to bind yet, same as a lone modifier press.
  if (!e.key) return null;
  if (e.key === 'Control' || e.key === 'Meta' || e.key === 'Alt' || e.key === 'Shift') {
    return null;
  }

  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.metaKey) parts.push('Cmd');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');

  let key = e.key;
  if (key === 'ISO_Left_Tab' || e.code === 'Tab') {
    key = 'Tab';
  } else if (
    e.shiftKey &&
    e.code &&
    PHYSICAL_KEY_BASE_SYMBOLS[e.code] &&
    // Only for a genuine punctuation key: on Swedish/Nordic ISO layouts, the physical keys at
    // these same codes (BracketLeft, Quote, Semicolon) are the å/ä/ö letter keys, so Shift+å
    // must stay 'Å' rather than being overwritten with the US-layout punctuation ('[', "'", ';')
    // that happens to share that physical position.
    !/^\p{L}$/u.test(key)
  ) {
    key = PHYSICAL_KEY_BASE_SYMBOLS[e.code];
  }
  if (key === ' ') key = 'Space';
  else if (key === 'ArrowUp') key = 'Up';
  else if (key === 'ArrowDown') key = 'Down';
  else if (key === 'ArrowLeft') key = 'Left';
  else if (key === 'ArrowRight') key = 'Right';
  else if (key.length === 1) key = key.toUpperCase();
  parts.push(key);

  return parts.join('+');
}

/**
 * Live preview of the modifiers currently held during shortcut recording (before a non-modifier
 * key completes the combo), so the recorder UI can show "Ctrl+..." instead of looking unresponsive
 * while a modifier alone is held. Returns null once no modifier is held.
 */
export function modifierPreviewFromKeyboardEvent(e: ShortcutKeyEventLike): string | null {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.metaKey) parts.push('Cmd');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  return parts.length > 0 ? parts.join('+') : null;
}

/**
 * Resolves the key combo currently bound to a shortcut id: the user's configured binding if
 * one exists, else the built-in default. Falls back to the id itself if it isn't a known
 * shortcut, so a typo surfaces as a visibly wrong label instead of a blank one.
 */
export function getShortcutKeys(id: string, shortcuts: Record<string, string> | undefined): string {
  return shortcuts?.[id] || DEFAULT_SHORTCUTS[id] || id;
}

export function getShortcutName(id: string): string {
  return SHORTCUT_DEFINITIONS.find((def) => def.id === id)?.name ?? id;
}
