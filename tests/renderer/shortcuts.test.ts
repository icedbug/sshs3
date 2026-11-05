import { describe, it, expect } from 'vitest';
import { comboFromKeyboardEvent } from '../../src/renderer/src/lib/shortcuts';
import { SHORTCUT_DEFINITIONS } from '../../src/shared/types/settings';

describe('default shortcuts', () => {
  it('never bind the same key combo to two actions', () => {
    const seen = new Map<string, string>();
    for (const def of SHORTCUT_DEFINITIONS) {
      const key = def.defaultKeys.toLowerCase();
      expect(seen.get(key), `${def.id} duplicates ${seen.get(key)} (${def.defaultKeys})`).toBeUndefined();
      seen.set(key, def.id);
    }
  });

  it('list modifiers in the order comboFromKeyboardEvent produces, or they could never match a keypress', () => {
    for (const def of SHORTCUT_DEFINITIONS) {
      const rest = def.defaultKeys.replace(/^(?:Ctrl\+)?(?:Cmd\+)?(?:Alt\+)?(?:Shift\+)?/, '');
      expect(rest, def.id).not.toMatch(/^(?:Ctrl|Cmd|Alt|Shift)\+/);
    }
  });

  it('leave bare Alt+<key> and Ctrl+<letter> to the shell, which reads them as ESC prefixes and control codes', () => {
    const terminalFacing = SHORTCUT_DEFINITIONS.filter((d) => d.category === 'Terminal').map((d) => d.defaultKeys);
    for (const keys of terminalFacing) {
      expect(keys).not.toMatch(/^Alt\+/);
      expect(keys).not.toMatch(/^Ctrl\+[A-Za-z]$/);
    }
  });
});

describe('comboFromKeyboardEvent', () => {
  it('builds a combo string from modifiers and an uppercased letter', () => {
    expect(comboFromKeyboardEvent({ key: 'n', code: 'KeyN', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true })).toBe(
      'Ctrl+Shift+N'
    );
  });

  it('returns null rather than throwing when key is missing or empty (dead-key/compose/IME events)', () => {
    expect(comboFromKeyboardEvent({ key: undefined as unknown as string, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBeNull();
    expect(comboFromKeyboardEvent({ key: '', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBeNull();
  });

  it('returns null for a lone modifier keypress', () => {
    expect(comboFromKeyboardEvent({ key: 'Shift', code: 'ShiftLeft', ctrlKey: false, metaKey: false, altKey: false, shiftKey: true })).toBeNull();
  });

  it('normalizes Shift+<punctuation key> via e.code so the same physical key resolves identically across keyboard layouts', () => {
    // US layout: Shift+comma-key -> e.key '<'. Swedish/Nordic ISO layout: same physical key -> e.key ';'.
    // Both must resolve to the same canonical combo, since e.code identifies the physical key, not the layout-dependent character.
    const usLayout = comboFromKeyboardEvent({ key: '<', code: 'Comma', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true });
    const swedishLayout = comboFromKeyboardEvent({ key: ';', code: 'Comma', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true });

    expect(usLayout).toBe('Ctrl+Shift+,');
    expect(swedishLayout).toBe('Ctrl+Shift+,');
  });

  it('keeps Swedish/Nordic å/ä/ö letters instead of the US punctuation that shares their physical key code', () => {
    // On a Swedish ISO layout, å/ä/ö sit at the same physical codes as US [ / ' / ; — Shift+å
    // must stay 'Å', not get overwritten with the US-layout bracket that shares BracketLeft.
    expect(comboFromKeyboardEvent({ key: 'Å', code: 'BracketLeft', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true })).toBe(
      'Ctrl+Shift+Å'
    );
    expect(comboFromKeyboardEvent({ key: 'Ä', code: 'Quote', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true })).toBe(
      'Ctrl+Shift+Ä'
    );
    expect(comboFromKeyboardEvent({ key: 'Ö', code: 'Semicolon', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true })).toBe(
      'Ctrl+Shift+Ö'
    );
    // Unshifted å/ä/ö (no Shift held) were already unaffected, but keep covering them too.
    expect(comboFromKeyboardEvent({ key: 'å', code: 'BracketLeft', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBe(
      'Ctrl+Å'
    );
  });

  it('falls back to the raw e.key when e.code is missing or unrecognized, so recorder and matcher stay consistent with each other even then', () => {
    const withoutCode = comboFromKeyboardEvent({ key: ';', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true });
    expect(withoutCode).toBe('Ctrl+Shift+;');
  });

  it('normalizes Tab and Linux ISO_Left_Tab to Tab for Ctrl+Tab and Ctrl+Shift+Tab', () => {
    expect(comboFromKeyboardEvent({ key: 'Tab', code: 'Tab', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBe(
      'Ctrl+Tab'
    );
    expect(comboFromKeyboardEvent({ key: 'Tab', code: 'Tab', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true })).toBe(
      'Ctrl+Shift+Tab'
    );
    // Linux X11/Wayland reports Shift+Tab as key 'ISO_Left_Tab'
    expect(comboFromKeyboardEvent({ key: 'ISO_Left_Tab', code: 'Tab', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true })).toBe(
      'Ctrl+Shift+Tab'
    );
  });

  it('builds combo strings for font size shortcuts across keyboard layouts and numpad', () => {
    // Swedish layout: '+' is unshifted next to 0 (physical code Minus)
    expect(comboFromKeyboardEvent({ key: '+', code: 'Minus', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBe(
      'Ctrl++'
    );
    // Swedish layout: '-' is unshifted next to Right Shift (physical code Slash)
    expect(comboFromKeyboardEvent({ key: '-', code: 'Slash', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBe(
      'Ctrl+-'
    );
    // US layout: '-' is unshifted next to 0 (physical code Minus)
    expect(comboFromKeyboardEvent({ key: '-', code: 'Minus', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBe(
      'Ctrl+-'
    );
    // US layout: '=' unshifted
    expect(comboFromKeyboardEvent({ key: '=', code: 'Equal', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBe(
      'Ctrl+='
    );
    // US layout: Shift+'=' produces '+'
    expect(comboFromKeyboardEvent({ key: '+', code: 'Equal', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true })).toBe(
      'Ctrl+Shift+='
    );
    // Numpad '+' and '-'
    expect(comboFromKeyboardEvent({ key: '+', code: 'NumpadAdd', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBe(
      'Ctrl++'
    );
    expect(comboFromKeyboardEvent({ key: '-', code: 'NumpadSubtract', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBe(
      'Ctrl+-'
    );
    // Reset combo '0'
    expect(comboFromKeyboardEvent({ key: '0', code: 'Digit0', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBe(
      'Ctrl+0'
    );
  });

  it('normalizes ArrowUp, ArrowDown, ArrowLeft, ArrowRight to Up, Down, Left, Right', () => {
    expect(comboFromKeyboardEvent({ key: 'ArrowLeft', code: 'ArrowLeft', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true })).toBe(
      'Ctrl+Shift+Left'
    );
    expect(comboFromKeyboardEvent({ key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true })).toBe(
      'Ctrl+Shift+Right'
    );
    expect(comboFromKeyboardEvent({ key: 'ArrowUp', code: 'ArrowUp', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true })).toBe(
      'Ctrl+Shift+Up'
    );
    expect(comboFromKeyboardEvent({ key: 'ArrowDown', code: 'ArrowDown', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true })).toBe(
      'Ctrl+Shift+Down'
    );
  });
});
