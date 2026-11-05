/**
 * True when `text` holds a C0/C1 control character or DEL. Quoting does not neutralise these in a
 * terminal: the line discipline acts on them (Ctrl+U kills the line, Ctrl+C aborts it, CR/LF end it,
 * ESC starts a sequence such as the end of a bracketed paste) before the shell ever parses the quotes.
 * A path or file name that contains one therefore must not be typed or pasted into a terminal.
 */
export function hasControlChars(text: string): boolean {
  // eslint-disable-next-line no-control-regex -- matching control characters is the whole point
  return /[\u0000-\u001f\u007f-\u009f]/.test(text);
}
