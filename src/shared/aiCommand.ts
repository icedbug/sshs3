/**
 * Validation of shell commands suggested by the AI assistant, before they are
 * typed into a terminal. Shared by the main process and the renderer.
 *
 * The check is reject-only: nothing in the text is stripped, escaped or repaired
 * (apart from one trailing run of line breaks), so the string that is shown to
 * the user, validated and finally sent to the pty is always the same one. A
 * suggestion containing ESC [ 2 0 1 ~ followed by CR could otherwise leave
 * xterm's bracketed paste and run without the user pressing Enter.
 *
 * What an accepted result guarantees depends on the mode:
 * - Single line (the default): the text holds no line break and no control
 *   character, so pasting it never presses Enter, whether or not the terminal
 *   is in bracketed paste mode.
 * - allowMultiline: xterm's paste turns every LF into CR, which presses Enter
 *   unless the foreground program understands bracketed paste. Whether it does
 *   cannot be known (the terminal's mode flag is set by whatever the remote side
 *   prints), so the result has requiresBracketedPaste set and the caller must
 *   never write it to the pty: copy it to the clipboard or ask for a single line.
 */

/** Longest accepted single-line command, in code points (a character outside the BMP counts once). */
export const MAX_COMMAND_CHARS = 1000;
/** Longest accepted command when several lines are allowed, in code points. */
export const MAX_MULTILINE_COMMAND_CHARS = 4000;
/** Most lines accepted in a multi-line command, so no part of it can hide below the fold of a preview. */
export const MAX_COMMAND_LINES = 20;
/** Most combining marks accepted in a row. Normalized text needs three, fully pointed scripts a few more. */
export const MAX_COMBINING_MARKS = 5;

export type CommandRejection =
  | 'empty'
  | 'too-long'
  | 'control-characters'
  | 'hidden-characters'
  | 'multiple-lines'
  | 'too-many-lines';

export type CommandCheck =
  | {
      ok: true;
      command: string;
      lineCount: number;
      /** True when the text has several lines: it must not be written to the pty, only copied. */
      requiresBracketedPaste: boolean;
    }
  | { ok: false; reason: CommandRejection; message: string };

export interface CommandCheckOptions {
  allowMultiline?: boolean;
}

type CharKind = 'newline' | 'control' | 'hidden';

// Characters that render as nothing or as a space but are not a plain U+0020:
// everything Unicode marks as default-ignorable (this includes the combining
// grapheme joiner, the Hangul and Khmer fillers, all variation selectors and the
// Mongolian free variation selectors), format characters (bidi controls,
// zero-width characters including ZWJ and ZWNJ, BOM, soft hyphen, tags), line and
// paragraph separators, other space separators (NBSP, U+2000..U+200A, U+202F,
// U+205F, U+3000), private-use, unassigned and surrogate code points. ZWJ and
// ZWNJ are rejected even where a script needs them (Persian, Indic scripts,
// emoji sequences): an invisible character inside a word is the spoof this check
// exists to stop, and such text can still be typed by hand.
const HIDDEN_CHARACTER = /[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Zl}\p{Zp}\p{Zs}\p{Co}\p{Cn}\p{Cs}]/u;

// Blank-looking or invisible characters that neither the categories nor the
// default-ignorable property above cover: Braille blank, joiners and selectors
// without a glyph, filler and blank signs, and the object replacement character.
function isBlankLookalike(cp: number): boolean {
  return (
    cp === 0x2800 || // BRAILLE PATTERN BLANK
    cp === 0x2d7f || // TIFINAGH CONSONANT JOINER
    cp === 0x303f || // IDEOGRAPHIC HALF FILL SPACE
    cp === 0xfffc || // OBJECT REPLACEMENT CHARACTER
    cp === 0x1107f || // BRAHMI NUMBER JOINER
    cp === 0x11a47 || // ZANABAZAR SQUARE SUBJOINER
    cp === 0x11a99 || // SOYOMBO SUBJOINER
    cp === 0x11f42 || // KAWI CONJOINER
    (cp >= 0x13440 && cp <= 0x13442) || // EGYPTIAN HIEROGLYPH MIRROR HORIZONTALLY, FULL BLANK, HALF BLANK
    cp === 0x16fe4 || // KHITAN SMALL SCRIPT FILLER
    cp === 0x1bc9d || // DUPLOYAN THICK LETTER SELECTOR
    cp === 0x1d159 // MUSICAL SYMBOL NULL NOTEHEAD
  );
}

const COMBINING_MARK = /\p{M}/u;
const ENCLOSING_MARK = /\p{Me}/u;
const EMOJI = /\p{Emoji}/u;

// Combining marks drawn over their base character: with one on every letter a
// command is shown struck through or crossed out while the shell still runs it.
// Enclosing marks (circle, square, circle with backslash and so on) do the same.
function isOverpaintMark(cp: number): boolean {
  return (
    (cp >= 0x0334 && cp <= 0x0338) || // tilde, strokes and solidi overlays
    (cp >= 0x20d2 && cp <= 0x20d3) || // vertical line overlays
    (cp >= 0x20d8 && cp <= 0x20da) || // ring overlays
    (cp >= 0x20e5 && cp <= 0x20e6) || // reverse solidus and double vertical stroke overlays
    (cp >= 0x20ea && cp <= 0x20eb) || // arrow and double solidus overlays
    ENCLOSING_MARK.test(String.fromCodePoint(cp))
  );
}

const KEYCAP_MARK = 0x20e3;
const VARIATION_SELECTOR_TEXT = 0xfe0e;
const VARIATION_SELECTOR_EMOJI = 0xfe0f;

// Names of the C0 controls, indexed by code point.
const C0_NAMES = [
  'NUL', 'SOH', 'STX', 'ETX', 'EOT', 'ENQ', 'ACK', 'BEL', 'BS', 'TAB', 'LF', 'VT', 'FF', 'CR', 'SO', 'SI',
  'DLE', 'DC1', 'DC2', 'DC3', 'DC4', 'NAK', 'SYN', 'ETB', 'CAN', 'EM', 'SUB', 'ESC', 'FS', 'GS', 'RS', 'US',
];

const MESSAGES: Record<CommandRejection, (limit: number) => string> = {
  'empty': () => 'The suggested command is empty, so nothing was inserted.',
  'too-long': (limit) =>
    `The suggested command is longer than ${limit} characters, so it was not inserted. Ask for a shorter one.`,
  'control-characters': () =>
    'The suggested command contains hidden control characters, so it was not inserted. Ask again or type the command yourself.',
  'hidden-characters': () =>
    'The suggested command contains invisible or space-like characters (such as zero-width characters, right-to-left marks or non-breaking spaces), so it was not inserted. Ask again or type the command yourself.',
  'multiple-lines': () =>
    'The suggested command spans several lines, so it was not inserted. Ask for a single-line command.',
  'too-many-lines': () =>
    `The suggested command is longer than ${MAX_COMMAND_LINES} lines, so it was not offered. Ask for a shorter one.`,
};

/**
 * Returns a classifier to be fed the code points of one text in order, together
 * with the code point that follows (or -1 at the end). A few rules depend on
 * the neighbours, so the classifier keeps a little state: a variation selector
 * is only visible directly after an emoji, a combining mark needs a character
 * to sit on, and a long run of marks is a way to smear text over its surroundings.
 * Whatever the output of showHiddenCharacters would contain in place of a
 * rejected character (a marker ending in '>') or a line break (a space) is
 * what the state assumes for the next character, so the shown text passes too.
 */
function createClassifier(): (cp: number, next: number) => CharKind | null {
  let canCarryMark = false; // the previous character is neither a space, a line break nor the start of the text
  let markRun = 0; // combining marks directly before
  let afterEmoji = false; // the previous character is a non-ASCII emoji
  let afterKeycapBase = false; // the previous character is a digit, # or *, or an emoji selector that followed one

  return (cp, next) => {
    const carriedMark = canCarryMark;
    const run = markRun;
    const emoji = afterEmoji;
    const keycapBase = afterKeycapBase;
    canCarryMark = true;
    markRun = 0;
    afterEmoji = false;
    afterKeycapBase = false;

    if (cp === 0x0a) {
      canCarryMark = false;
      return 'newline';
    }
    // C0 controls (a CR presses Enter in a pty), DEL and the C1 controls (U+009B is a single-byte CSI).
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return 'control';
    // Printable ASCII, including the plain space.
    if (cp < 0x7f) {
      canCarryMark = cp !== 0x20;
      afterKeycapBase = cp === 0x23 || cp === 0x2a || (cp >= 0x30 && cp <= 0x39);
      return null;
    }

    // U+FE0E and U+FE0F are zero width, so they are only accepted where they change
    // how a visible emoji is drawn: after an emoji, or between a keycap base and U+20E3.
    if (cp === VARIATION_SELECTOR_TEXT || cp === VARIATION_SELECTOR_EMOJI) {
      const keycap = cp === VARIATION_SELECTOR_EMOJI && keycapBase && next === KEYCAP_MARK;
      if (!emoji && !keycap) return 'hidden';
      markRun = 1;
      afterKeycapBase = keycap;
      return null;
    }

    const ch = String.fromCodePoint(cp);
    if (HIDDEN_CHARACTER.test(ch) || isBlankLookalike(cp)) return 'hidden';

    if (COMBINING_MARK.test(ch)) {
      if (!carriedMark || run >= MAX_COMBINING_MARKS) return 'hidden';
      if (cp === KEYCAP_MARK ? !keycapBase : isOverpaintMark(cp)) return 'hidden';
      markRun = run + 1;
      return null;
    }

    afterEmoji = EMOJI.test(ch);
    return null;
  };
}

// Linear scan from the end; a regex like /(\r?\n)+$/ is quadratic on long runs of line breaks.
function stripTrailingLineBreaks(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 0x0a) {
    end -= end >= 2 && text.charCodeAt(end - 2) === 0x0d ? 2 : 1;
  }
  return text.slice(0, end);
}

// Whether text holds more than limit code points. Cheap for any length: a text
// of at most limit code units always fits, one of more than twice that never does.
function exceedsLimit(text: string, limit: number): boolean {
  if (text.length <= limit) return false;
  if (text.length > limit * 2) return true;
  let points = text.length;
  for (let i = 0; i + 1 < text.length; i += 1) {
    const high = text.charCodeAt(i);
    const low = text.charCodeAt(i + 1);
    if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) {
      points -= 1;
      i += 1;
    }
  }
  return points > limit;
}

function reject(reason: CommandRejection, limit: number): CommandCheck {
  return { ok: false, reason, message: MESSAGES[reason](limit) };
}

/**
 * Decides whether a model-suggested command may be inserted into a terminal.
 * Only one trailing run of line breaks is removed; the returned command is
 * exactly the text that was checked. See the header for what the result
 * guarantees, in particular requiresBracketedPaste for several lines.
 */
export function checkSuggestedCommand(text: string, options?: CommandCheckOptions | null): CommandCheck {
  const allowMultiline = options?.allowMultiline === true;
  const limit = allowMultiline ? MAX_MULTILINE_COMMAND_CHARS : MAX_COMMAND_CHARS;
  if (typeof text !== 'string') return reject('empty', limit);

  const command = stripTrailingLineBreaks(text);
  if (command.trim() === '') return reject('empty', limit);
  if (exceedsLimit(command, limit)) return reject('too-long', limit);

  const classify = createClassifier();
  let lineCount = 1;
  let hidden = false;
  for (let i = 0; i < command.length; ) {
    const cp = command.codePointAt(i) as number;
    i += cp > 0xffff ? 2 : 1;
    const kind = classify(cp, command.codePointAt(i) ?? -1);
    if (kind === 'control') return reject('control-characters', limit);
    if (kind === 'hidden') hidden = true;
    else if (kind === 'newline') lineCount += 1;
  }
  if (hidden) return reject('hidden-characters', limit);
  if (lineCount > 1 && !allowMultiline) return reject('multiple-lines', limit);
  if (lineCount > MAX_COMMAND_LINES) return reject('too-many-lines', limit);
  return { ok: true, command, lineCount, requiresBracketedPaste: lineCount > 1 };
}

function hex(cp: number): string {
  return `<U+${cp.toString(16).toUpperCase().padStart(4, '0')}>`;
}

/**
 * Display-only version of a text: every character that checkSuggestedCommand
 * would reject is replaced by a visible marker such as <ESC>, <CR> or <U+202E>,
 * and line breaks are shown as a return symbol. The result contains no rejected
 * characters, so it is safe to render and copy. maxLength counts characters
 * (code points) of the input; a longer text is cut there and an ellipsis is
 * appended.
 */
export function showHiddenCharacters(text: string, maxLength = 200, options?: { keepLineBreaks?: boolean }): string {
  const keepLineBreaks = options?.keepLineBreaks === true;
  if (typeof text !== 'string') return '';
  const limit = typeof maxLength !== 'number' || Number.isNaN(maxLength) ? 200 : Math.max(0, Math.floor(maxLength));
  const classify = createClassifier();
  let out = '';
  let shown = 0;
  let i = 0;
  while (i < text.length) {
    if (shown >= limit) {
      out += '…';
      break;
    }
    const cp = text.codePointAt(i) as number;
    i += cp > 0xffff ? 2 : 1;
    shown += 1;
    // A character that is cut off must not count as a neighbour, or the text
    // could end right after a selector that was only accepted for its sake.
    const next = shown < limit ? (text.codePointAt(i) ?? -1) : -1;
    switch (classify(cp, next)) {
      case 'newline':
        out += keepLineBreaks ? '\n' : ' ⏎ ';
        break;
      case 'control':
        out += keepLineBreaks && cp === 0x09 ? '\t' : cp < 0x20 ? `<${C0_NAMES[cp]}>` : cp === 0x7f ? '<DEL>' : hex(cp);
        break;
      case 'hidden':
        out += hex(cp);
        break;
      default:
        out += String.fromCodePoint(cp);
    }
  }
  return out;
}

/**
 * For the model's explanation, which is shown and can be copied: like showHiddenCharacters, but line breaks
 * and tabs stay, so the text keeps its layout. Nothing in the result can end a bracketed paste or hide text.
 */
export function neutralizeText(text: string): string {
  return showHiddenCharacters(text, Infinity, { keepLineBreaks: true });
}
