import type { IMarker, Terminal } from '@xterm/xterm';

/**
 * Where the command starts on its row, learned from the cursor instead of from the look of the prompt.
 *
 * When a shell has finished drawing its prompt and output has gone quiet, the cursor stands right after the
 * prompt, whatever the prompt looks like and whether the shell is local or behind SSH. That position is the
 * start of the next command, so a command is read from there to the end of its line. This replaces matching
 * the text of the prompt; the prompt patterns in `terminalOutput.ts` remain the fallback when no position
 * was learned (typeahead, a redrawn prompt, a resize).
 */

/** Output must be quiet this long before the cursor is taken to stand at a prompt. */
export const IDLE_MS = 250;

/** Characters a prompt ends with, followed by whitespace. */
const PROMPT_TERMINATORS = '$#%>❯➜»λ→›';
/** The terminators as the inside of a regular expression character class. */
export const PROMPT_TERMINATOR_CLASS = PROMPT_TERMINATORS.replace(/[\]\\^-]/g, '\\$&');
const PROMPT_END_RE = new RegExp(`[${PROMPT_TERMINATOR_CLASS}]\\s+$`);

export interface PromptAnchor {
  /** The row holding the end of the prompt. */
  marker: IMarker;
  /** Terminal column right after the prompt. */
  col: number;
  /** A right-hand prompt (zsh `RPROMPT`, fish, starship) that was visible at the cursor's row, else empty. */
  rightPrompt: string;
}

/**
 * True when the text before the cursor ends like a prompt. This keeps an answer typed into a running program
 * (`Password: `, `[Y/n] `) from being taken for a command: those do not end in a prompt terminator.
 */
export function prefixLooksLikePrompt(prefix: string): boolean {
  return PROMPT_END_RE.test(prefix);
}

/**
 * The typed command from a row's text (already cut at the anchor column). A right-hand prompt that was drawn
 * at idle is removed only when the row still ends with exactly that text after a gap, so a long command that
 * has pushed the right prompt away is not truncated.
 */
export function stripRightPrompt(rowText: string, rightPrompt: string): string {
  if (!rightPrompt) return rowText;
  const trimmed = rowText.trimEnd();
  if (!trimmed.endsWith(rightPrompt)) return rowText;
  const before = trimmed.slice(0, trimmed.length - rightPrompt.length);
  return /\s{2,}$/.test(before) ? before.trimEnd() : rowText;
}

/**
 * Remembers the cursor position at the last quiet moment and hands it to the next Enter. The position stays
 * valid only while nothing but the user's own typing has changed the screen since.
 */
export class PromptAnchorTracker {
  private anchor: PromptAnchor | null = null;
  private valid = false;
  private typedSinceIdle = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly resizeListener?: { dispose(): void };

  constructor(private readonly term: Terminal) {
    // A resize reflows the screen, so a row and column learned before it no longer mean the same thing.
    this.resizeListener = term.onResize?.(() => this.invalidate());
  }

  /** Output arrived from the session. Anything the user did not just type invalidates the position. */
  public noteOutput(): void {
    if (!this.typedSinceIdle) this.valid = false;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.captureIdle(), IDLE_MS);
  }

  /** The user typed something (not a terminal reply). The echo of it is expected output. */
  public noteInput(): void {
    this.typedSinceIdle = true;
  }

  /** The position for the Enter being pressed now, or null when none was learned. It is used up. */
  public claim(): PromptAnchor | null {
    const anchor = this.valid ? this.anchor : null;
    // A position that is no longer valid is not handed on, so its marker must not be left registered.
    if (!anchor) this.anchor?.marker.dispose();
    this.valid = false;
    this.typedSinceIdle = false;
    this.anchor = null;
    return anchor;
  }

  public dispose(): void {
    clearTimeout(this.timer);
    this.resizeListener?.dispose();
    this.discard();
  }

  private discard(): void {
    this.anchor?.marker.dispose();
    this.anchor = null;
    this.valid = false;
  }

  /** The cursor is on the anchor's row or on rows that wrap on from it: the user is editing that line. */
  private cursorOnAnchorLine(cursorRow: number): boolean {
    const marker = this.anchor?.marker;
    if (!this.valid || !marker || marker.isDisposed || marker.line < 0 || cursorRow < marker.line) return false;
    const buf = this.term.buffer.active;
    for (let row = marker.line + 1; row <= cursorRow; row++) {
      if (!buf.getLine(row)?.isWrapped) return false;
    }
    return true;
  }

  private invalidate(): void {
    this.valid = false;
  }

  private captureIdle(): void {
    const buf = this.term.buffer.active;
    const cursorRow = buf.baseY + buf.cursorY;
    // The user is part-way through a line: the cursor is after what they typed, not after the prompt. Keep
    // the position learned before they started. When the cursor has left that line (Ctrl+C, a cleared
    // screen, a program that ran and quit) the typing is over and this is a new prompt.
    if (this.typedSinceIdle && buf.type === 'normal' && this.cursorOnAnchorLine(cursorRow)) return;
    this.typedSinceIdle = false;
    this.discard();
    if (buf.type !== 'normal') return;
    const line = buf.getLine(cursorRow);
    const col = buf.cursorX;
    if (!line || col <= 0) return;
    if (!prefixLooksLikePrompt(line.translateToString(false, 0, col))) return;
    const marker = this.term.registerMarker(0);
    if (!marker) return;
    this.anchor = { marker, col, rightPrompt: line.translateToString(true, col).trim() };
    this.valid = true;
  }
}
