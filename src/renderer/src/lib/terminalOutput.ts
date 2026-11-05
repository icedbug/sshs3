import type { IMarker, Terminal } from '@xterm/xterm';
import {
  PROMPT_TERMINATOR_CLASS,
  PromptAnchorTracker,
  prefixLooksLikePrompt,
  stripRightPrompt,
  type PromptAnchor,
} from './promptAnchor';

const MAX_MARKERS = 50;

// Matches typical shell prompts ending in $, #, %, >, ❯, or ➜ followed by whitespace,
// including git branch decorators like `➜ git:(main) ` or `[user@host /dir]# `
// and box-drawing prompt footers like `╰─$ ` or `╰─❯ `
const PROMPT_PREFIX_RE =
  /^(?:[╰└┗].*?[$#%>❯➜]\s*|(?:PS\s+)?[A-Za-z]:\\[^<>|?*"]*?>\s*|(?:(?:\([^)]+\)\s+)?(?:\[[^\]]+\]|[\w.@:~/-]+[@:][^\s$#%>]*)\s*)?[$#%>]\s+|[❯➜]\s*(?:.*?\s*git:\([^)]+\)\s*)?)/;

// Matches an entire line that consists only of a prompt or multi-line prompt header/footer
const FULL_PROMPT_LINE_RE =
  /^(?:[╰└┗].*|(?:PS\s+)?[A-Za-z]:\\[^<>|?*"]*>\s*|[╭┌┏].*|(?:(?:\([^)]+\)\s+)?(?:\[[^\]]+\]|[\w.@:~/-]+[@:][^\s$#%>]*)\s*)?[$#%>❯➜]\s*|[❯➜]\s*(?:.*?\s*git:\([^)]+\)\s*)?|[\w.-]+@[\w.-]+(?:\s+in\s+[^\s]+|:[^\s$#%>]*)\s*(?:\[[^\]]+\])?\s*)$/;

/**
 * Strips shell prompt prefix from a command line if present.
 */
export function stripPrompt(line: string): string {
  return line.replace(PROMPT_PREFIX_RE, '').trim();
}

// Last resort for prompts the patterns above do not know (`bash-5.3$`, zsh's `user@host ~ %`, fish's
// `user@host ~>`, `(venv) bash-5.3$`): up to 80 characters, then the first prompt terminator and a space.
const LOOSE_PROMPT_PREFIX_RE = new RegExp(`^.{1,80}?[${PROMPT_TERMINATOR_CLASS}]\\s+`);

/**
 * Like `stripPrompt`, but also recognises a prompt the patterns do not know, by its terminator. Only for
 * the row where Enter was pressed: a continuation row of a long command can contain `> ` or `$ ` without
 * starting with a prompt, so it must not be run through this.
 */
export function stripPromptLoose(line: string): string {
  const text = line.trim();
  const strict = stripPrompt(text);
  if (strict !== text) return strict;
  return text.replace(LOOSE_PROMPT_PREFIX_RE, '').trim();
}

/**
 * True when the cursor stands right after a prompt terminator and a space, with nothing after it or only
 * a right-hand prompt (fish's `fish_right_prompt`, zsh's `RPROMPT`, starship's `right_format`) separated
 * from it by a gap: the shell is waiting for a command, whatever its prompt looks like.
 */
export function endsAtPrompt(textBeforeCursor: string, textAfterCursor: string): boolean {
  if (!prefixLooksLikePrompt(textBeforeCursor)) return false;
  return textAfterCursor.trim() === '' || /^\s{2,}\S/.test(textAfterCursor);
}

/** The cursor stands right after a prompt with nothing typed after it (the shell waits for a new command). */
export function isAtEmptyPrompt(term: Terminal): boolean {
  const buf = term.buffer.active;
  if (buf.type !== 'normal') return false;
  const line = buf.getLine(buf.baseY + buf.cursorY);
  const x = buf.cursorX;
  return endsAtPrompt(line?.translateToString(false, 0, x) ?? '', line?.translateToString(true, x) ?? '');
}

/**
 * Checks whether a given line consists solely of a shell prompt.
 */
export function isPromptLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  return FULL_PROMPT_LINE_RE.test(trimmed);
}

/**
 * Strips any trailing prompt line(s) from command output.
 */
export function stripTrailingPrompt(text: string): string {
  const lines = text.split('\n');
  while (lines.length > 0) {
    const last = lines[lines.length - 1].trim();
    if (!last || isPromptLine(last)) {
      lines.pop();
    } else {
      break;
    }
  }
  return lines.join('\n');
}

// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\].*?(?:\x07|\x1b\\)/g;

function resolveTildePath(raw: string, userHome: string, promptUser?: string): string {
  let effectiveHome = userHome;
  if (promptUser) {
    if (promptUser === 'root') {
      effectiveHome = '/root';
    } else if (userHome.startsWith('/Users/')) {
      effectiveHome = `/Users/${promptUser}`;
    } else {
      effectiveHome = `/home/${promptUser}`;
    }
  }
  if (raw === '~') return effectiveHome;
  if (raw.startsWith('~/')) return `${effectiveHome.replace(/\/+$/, '')}/${raw.slice(2)}`;
  return raw;
}

/**
 * Extracts current working directory from shell prompt text (e.g. starship, oh-my-zsh, default bash).
 */
export function extractCwdFromPrompt(text: string, userHome = '/home/user'): string | null {
  if (!text) return null;
  const clean = text.replace(ANSI_REGEX, '');
  const lines = clean.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;

  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 4); i--) {
    const line = lines[i];

    // 0. Windows shells: PowerShell `PS C:\Users\me\proj> ` and cmd.exe `C:\Users\me\proj>`.
    // Non-greedy up to the first `>` followed by whitespace/end, so a typed command after the
    // prompt (`PS C:\x> cat a.md`) and paths containing spaces both work.
    const windowsMatch = line.match(/^(?:PS\s+)?([A-Za-z]:\\[^<>|?*"]*?)>(?:\s|$)/);
    if (windowsMatch) return windowsMatch[1].length > 3 ? windowsMatch[1].replace(/\\+$/, '') : windowsMatch[1];

    const userMatch = line.match(/(?:^|[\r\n\s╭[(])([a-zA-Z0-9._-]+)@([a-zA-Z0-9.-]+)/);
    const promptUser = userMatch ? userMatch[1] : undefined;

    // 1. Starship / powerlevel10k / multi-line with "in <path>"
    const starshipMatch = line.match(/(?:[╭┌┏].*?|[\w.-]+@[\w.-]+\s+)\bin\s+([~/][^\s[\]]*)/);
    if (starshipMatch) return resolveTildePath(starshipMatch[1], userHome, promptUser);

    // 2. Bracketed prompt: `[user@host /etc]$ ` or `[user@host: ~/dir]# `
    const bracketMatch = line.match(/\[[^\]\s]+[@\s:]\s*([~/][^\]\s]*?)\]/);
    if (bracketMatch) return resolveTildePath(bracketMatch[1], userHome, promptUser);

    // 3. Colon prompt (standard bash/zsh, title bar, git decorated): `user@host:/var/log$ `, `user@host: /var/log`, `user@host:~/repo (main) $ `
    const colonMatch = line.match(/[@:][^:\s]+:\s*([~/][^\s$#%>()]*)(?:\s*(?:\([^)]+\)|git:[^\s]+))?\s*(?:[$#%>❯➜]|$)/);
    if (colonMatch) return resolveTildePath(colonMatch[1], userHome, promptUser);

    // 4. Space-separated prompt: `user@host /var/log % `, `user@host ~/dir> `
    const spaceMatch = line.match(/[\w.-]+@[\w.-]+\s+([~/][^\s$#%>❯➜\])]*)\s*[$#%>❯➜]/);
    if (spaceMatch) return resolveTildePath(spaceMatch[1], userHome, promptUser);

    // 5. Minimal prompt with just path and terminator: `/var/log # `, `~/repo $ `
    const minimalMatch = line.match(/^([~/][^\s$#%>❯➜]*)\s*[$#%>❯➜]\s*$/);
    if (minimalMatch) return resolveTildePath(minimalMatch[1], userHome, promptUser);
  }
  return null;
}

export interface CleanOutputInfo {
  text: string;
  lineCount: number;
  charCount: number;
}

export interface LastCommandResult {
  command: string;
  output: string;
  /** Only known when the shell sends OSC 133 `D`. */
  exitCode?: number;
}

interface OscRegion {
  start: IMarker;
  end?: IMarker;
  commandMarker?: IMarker;
  exitCode?: number;
  /** The cursor was past column 0 when the output ended, i.e. the last output line has no newline yet. */
  partialLastLine?: boolean;
  /** `end` is the Enter marker of the next command, so the output stops above that command's own row(s). */
  endsAtCommandRow?: boolean;
}

/**
 * Finds the output of the last command.
 *
 * Exact when the shell emits OSC 133 prompt marks (fish, and zsh/bash with shell integration):
 * output runs from the `C` mark to the next `A`/`D` mark. Otherwise a heuristic is used: every Enter
 * typed in the normal screen buffer drops a marker on the command line, so a command's output is
 * whatever sits between its marker and the next one (or the current prompt line). With a multi-line
 * prompt that heuristic also picks up the first prompt line(s).
 */
export class CommandOutputTracker {
  private markers: IMarker[] = [];
  private regions: OscRegion[] = [];
  private pendingCommandMarker?: IMarker;
  /**
   * The shell sends `C` marks but never `A`/`D` (bash with the VTE script, via PS0): a region is only closed
   * by the next `C`, and the newest one stays open once its command has finished.
   */
  private cOnly = false;
  private readonly promptAnchors: PromptAnchorTracker;
  /** Where each Enter's command began on its row, when the cursor told (see `promptAnchor.ts`). */
  private anchors = new Map<IMarker, PromptAnchor>();
  private readonly oscHandler: { dispose(): void };

  constructor(private readonly term: Terminal) {
    this.promptAnchors = new PromptAnchorTracker(term);
    this.oscHandler = term.parser.registerOscHandler(133, (data) => {
      const kind = data.charAt(0);
      if (kind === 'B') {
        const marker = term.registerMarker(0);
        if (marker) this.pendingCommandMarker = marker;
      } else if (kind === 'C') {
        const start = term.registerMarker(0);
        if (start && this.isDuplicateStart(start)) {
          start.dispose();
        } else if (start) {
          this.closeOpenRegionAtNewCommand();
          const region: OscRegion = { start };
          if (this.pendingCommandMarker) {
            region.commandMarker = this.pendingCommandMarker;
            this.pendingCommandMarker = undefined;
          }
          this.regions.push(region);
          if (this.regions.length > MAX_MARKERS) {
            const evicted = this.regions.shift();
            evicted?.start.dispose();
            evicted?.commandMarker?.dispose();
            evicted?.end?.dispose();
          }
        }
      } else if (kind === 'A' || kind === 'D') {
        const open = this.regions[this.regions.length - 1];
        if (open && !open.end) {
          open.end = term.registerMarker(0);
          open.partialLastLine = term.buffer.active.cursorX > 0;
          if (kind === 'D' && data.length > 1) {
            const rawCode = data.slice(1).replace(/^;/, '');
            const parsed = parseInt(rawCode, 10);
            if (!Number.isNaN(parsed)) open.exitCode = parsed;
          }
        }
      }
      return true;
    });
  }

  /** A second `C` on the row of an open region (two sources of the same mark) is the same command. */
  private isDuplicateStart(start: IMarker): boolean {
    const open = this.regions[this.regions.length - 1];
    return Boolean(open && !open.end && !open.start.isDisposed && open.start.line === start.line);
  }

  /**
   * A `C` arrives while the previous region never got an `A`/`D`: that shell only sends `C`. The previous
   * command's output ends where the new command's own row(s) begin, which the Enter marker tells.
   */
  private closeOpenRegionAtNewCommand(): void {
    const open = this.regions[this.regions.length - 1];
    if (!open || open.end || open.start.isDisposed) return;
    this.cOnly = true;
    const enter = this.markers.filter((m) => !m.isDisposed && m.line >= 0).pop();
    if (enter && enter.line > open.start.line) {
      open.end = enter;
      open.endsAtCommandRow = true;
    } else {
      open.end = this.term.registerMarker(0);
      open.partialLastLine = this.term.buffer.active.cursorX > 0;
    }
  }

  /** First row after the region's output. */
  private outputEndRow(region: OscRegion): number {
    const end = region.end as IMarker;
    return region.endsAtCommandRow ? this.logicalLineBounds(end.line).start : end.line + (region.partialLastLine ? 1 : 0);
  }

  /** The newest command has no end mark because its shell only sends `C`, so it is read like a markless shell. */
  private newestRegionIsOpenCOnly(): boolean {
    const region = this.regions[this.regions.length - 1];
    return this.cOnly && Boolean(region) && !region.end;
  }

  /** Call when the user presses Enter (the cursor is still on the command line). */
  public recordEnter(): void {
    // Claimed first: whatever happens below, this Enter uses up the position learned before it.
    const anchor = this.promptAnchors.claim();
    const marker = this.term.buffer.active.type === 'normal' ? this.term.registerMarker(0) : undefined;
    if (!marker) {
      anchor?.marker.dispose();
      return;
    }
    this.markers.push(marker);
    if (anchor) this.anchors.set(marker, anchor);
    if (this.markers.length > MAX_MARKERS) this.dropMarker(this.markers.shift());
  }

  /** Output arrived from the session (call after writing it to the terminal). */
  public noteOutput(): void {
    this.promptAnchors.noteOutput();
  }

  /** The user typed something that is not a terminal reply. Call before `recordEnter` for the same keystroke. */
  public noteInput(): void {
    this.promptAnchors.noteInput();
  }

  private dropMarker(marker: IMarker | undefined): void {
    if (!marker) return;
    this.anchors.get(marker)?.marker.dispose();
    this.anchors.delete(marker);
    marker.dispose();
  }

  /**
   * The command typed at an Enter marker, read from where the cursor stood after the prompt. Null when no
   * position was learned or it no longer fits the screen, so the caller falls back to the prompt patterns;
   * an empty string means Enter was pressed on an empty line.
   */
  private readAnchoredCommand(marker: IMarker): string | null {
    const anchor = this.anchors.get(marker);
    if (!anchor || anchor.marker.isDisposed || anchor.marker.line < 0 || marker.isDisposed || marker.line < 0) return null;
    const { start, end } = this.logicalLineBounds(marker.line);
    const row = anchor.marker.line;
    if (row < start || row > end) return null;
    const buf = this.term.buffer.active;
    const first = buf.getLine(row)?.translateToString(true, anchor.col) ?? '';
    // A command that wraps has pushed the right-hand prompt away; only a single row can still carry it.
    let text = end === row ? stripRightPrompt(first, anchor.rightPrompt) : first;
    for (let i = row + 1; i <= end; i++) text += buf.getLine(i)?.translateToString(true) ?? '';
    return text.trim();
  }

  /** Text of the most recent command that produced output, or null when there is none. */
  public lastOutput(): string | null {
    const buf = this.term.buffer.active;
    if (buf.type !== 'normal') return null;
    const cursorLine = buf.baseY + buf.cursorY;
    if (this.currentRegion() && !this.newestRegionIsOpenCOnly()) {
      const osc = this.lastOscOutput();
      return osc ? stripTrailingPrompt(osc) : null;
    }
    const live = this.markers.filter((m) => !m.isDisposed && m.line >= 0);
    for (let i = live.length - 1; i >= 0; i--) {
      const end = i + 1 < live.length ? live[i + 1].line : cursorLine;
      const text = this.readLines(this.logicalLineBounds(live[i].line).end + 1, end);
      if (text.trim()) return stripTrailingPrompt(text);
    }
    return null;
  }

  /**
   * The newest OSC 133 region, but only while it belongs to the newest Enter. A shell that sent marks earlier
   * in this terminal (fish, bash with the VTE script) and was then replaced by one that does not (`bash`
   * typed inside fish, `exit` back to bash, an ssh session) leaves a region behind; reading it would
   * return that old command for every later one. A region started before the last Enter is not the one
   * for this command, so the Enter-marker reading is used.
   */
  private currentRegion(): OscRegion | null {
    const region = this.regions[this.regions.length - 1];
    if (!region) return null;
    const newestEnter = this.markers.filter((m) => !m.isDisposed && m.line >= 0).pop();
    if (newestEnter && !region.start.isDisposed && region.start.line >= 0 && region.start.line < newestEnter.line) {
      return null;
    }
    return region;
  }

  private lastOscOutput(): string | null {
    for (let i = this.regions.length - 1; i >= 0; i--) {
      const region = this.regions[i];
      const { start, end, commandMarker } = region;
      if (start.isDisposed || start.line < 0 || !end || end.isDisposed || end.line < 0) continue;
      const fromLine =
        commandMarker && !commandMarker.isDisposed && start.line === commandMarker.line
          ? start.line + 1
          : start.line;
      const text = this.readLines(fromLine, this.outputEndRow(region));
      if (text.trim()) return text;
    }
    return null;
  }

  /** Lines [from, to) joined back into logical lines, without trailing blanks. */
  private readLines(from: number, to: number): string {
    const buf = this.term.buffer.active;
    const lines: string[] = [];
    for (let i = from; i < to; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    return lines.join('\n');
  }

  /**
   * Text of the command that produced the last output, or null if unknown.
   */
  public lastCommand(): string | null {
    const buf = this.term.buffer.active;
    if (buf.type !== 'normal') return null;

    if (this.currentRegion()) {
      for (let i = this.regions.length - 1; i >= 0; i--) {
        const { commandMarker, start } = this.regions[i];
        if (commandMarker && !commandMarker.isDisposed && commandMarker.line >= 0) {
          const toLine =
            start && !start.isDisposed && start.line >= commandMarker.line
              ? this.commandRowsEnd(commandMarker.line, start.line)
              : commandMarker.line + 1;
          const text = this.readCommandRows(commandMarker.line, toLine).trim();
          if (text) return stripPromptLoose(text);
        }
      }
    }

    const live = this.markers.filter((m) => !m.isDisposed && m.line >= 0);
    for (let i = live.length - 1; i >= 0; i--) {
      const anchored = this.readAnchoredCommand(live[i]);
      if (anchored) return anchored;
      if (anchored === '') continue;
      // The marker sits on the row where Enter was pressed, i.e. the last row of a wrapped command.
      const text = this.readLogicalLine(live[i].line).trim();
      if (text) return stripPromptLoose(text);
    }
    return null;
  }

  /**
   * First and last buffer row of the logical line holding `row`. The row may be any of the rows of a
   * wrapped line: the marker sits where the cursor was when Enter was pressed, which is not the last
   * row when the cursor had been moved up into a command that wraps.
   */
  private logicalLineBounds(row: number): { start: number; end: number } {
    const buf = this.term.buffer.active;
    let start = row;
    while (start > 0 && this.continuesAbove(start)) start--;
    let end = row;
    while (buf.getLine(end + 1) && this.continuesAbove(end + 1)) end++;
    return { start, end };
  }

  /** A row filled to the right edge, as far as its text goes (wide characters make this undercount). */
  private rowIsFull(row: number): boolean {
    const cols = this.term.cols;
    return Boolean(cols) && (this.term.buffer.active.getLine(row)?.translateToString(true).length ?? 0) >= cols;
  }

  /**
   * Row `row` continues the row above it: the terminal flags it as wrapped, or the row above is filled to
   * the edge. Some shells break a long command line themselves instead of letting the terminal wrap it, so
   * the continuation is not flagged; a row that starts with a prompt never continues anything.
   */
  private continuesAbove(row: number): boolean {
    const line = this.term.buffer.active.getLine(row);
    if (!line) return false;
    if (line.isWrapped) return true;
    if (row === 0 || !this.rowIsFull(row - 1)) return false;
    const text = line.translateToString(true).trim();
    const withoutPrompt = stripPromptLoose(text);
    return !(withoutPrompt !== text && withoutPrompt !== '');
  }

  /**
   * Row after the last row of the command, given where the prompt ended (OSC 133 `B`) and where the output
   * began (`C`). Bash and the VTE script put `C` on the row after the command, which is already output; a
   * shell that marks it before the line break leaves it on the command's own row.
   */
  private commandRowsEnd(commandRow: number, outputRow: number): number {
    return outputRow === commandRow ? outputRow + 1 : Math.max(outputRow, commandRow + 1);
  }

  /** Like `readLines`, but joins the rows of a command line the way `logicalLineBounds` sees them. */
  private readCommandRows(from: number, to: number): string {
    const buf = this.term.buffer.active;
    const rows: string[] = [];
    for (let i = from; i < to; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      if (rows.length > 0 && this.continuesAbove(i)) rows[rows.length - 1] += text;
      else rows.push(text);
    }
    while (rows.length > 0 && rows[rows.length - 1].trim() === '') rows.pop();
    return rows.join('\n');
  }

  /** The text of the logical line holding `row` (all its rows joined). */
  private readLogicalLine(row: number): string {
    const { start, end } = this.logicalLineBounds(row);
    return this.readCommandRows(start, end + 1);
  }

  /**
   * The newest command together with its own output (and exit code when the shell reports one).
   * Null when that command printed nothing, so output of an older command is never attributed to it.
   */
  public lastCommandResult(options: { atPrompt?: boolean } = {}): LastCommandResult | null {
    const buf = this.term.buffer.active;
    if (buf.type !== 'normal') return null;

    if (this.currentRegion()) {
      // Only the newest region counts. While it is still open (a nested `ssh`, `docker exec`, a running
      // program) there is no finished command, and an older one must not be offered in its place. The
      // exception is a command whose shell never closes regions (`C` only), or a caller that knows the
      // shell is back at a prompt: it is then read like a shell without marks, from the Enter marker.
      const region = this.regions[this.regions.length - 1];
      if (!region.end && !this.cOnly && !options.atPrompt) return null;
      const { start, end, commandMarker } = region;
      if (end) {
        if (start.isDisposed || start.line < 0 || end.isDisposed || end.line < 0) return null;
        // A shell that sends `A`, `C` and `D` but no `B` (end of prompt) does not tell where the command
        // starts: fall through to reading it from the row where Enter was pressed.
        if (commandMarker && !commandMarker.isDisposed && commandMarker.line >= 0) {
          const command = stripPromptLoose(
            this.readCommandRows(commandMarker.line, this.commandRowsEnd(commandMarker.line, start.line)).trim()
          );
          const fromLine = start.line === commandMarker.line ? start.line + 1 : start.line;
          const output = stripTrailingPrompt(this.readLines(fromLine, this.outputEndRow(region)));
          if (!command || !output.trim()) return null;
          return { command, output, exitCode: region.exitCode };
        }
      }
    }

    const live = this.markers.filter((m) => !m.isDisposed && m.line >= 0);
    const newest = live[live.length - 1];
    if (!newest) return null;
    const anchored = this.readAnchoredCommand(newest);
    const text = this.readLogicalLine(newest.line).trim();
    const command = anchored ?? stripPromptLoose(text);
    // The Enter must have been pressed on a prompt followed by a command; an answer typed into a
    // running program (`[Y/n]`, a password) has no prompt in front of it. A learned prompt position
    // already says there was one.
    if (!command || (anchored === null && command === text)) return null;
    // The output starts after the last row of the command line, not after the row the cursor was on.
    const outputFrom = this.logicalLineBounds(newest.line).end + 1;
    const output = stripTrailingPrompt(this.readLines(outputFrom, buf.baseY + buf.cursorY));
    if (!output.trim()) return null;
    return { command, output };
  }

  /**
   * How the newest command was read, for the debug log. Structure only, never text: row lengths and
   * whether each row is flagged as a continuation of the one above.
   */
  public debugSnapshot(): {
    mode: 'osc' | 'enter-marker' | 'none';
    cols: number;
    markerRow: number | null;
    bounds: { start: number; end: number } | null;
    rows: { row: number; len: number; wrapped: boolean }[];
  } {
    const buf = this.term.buffer.active;
    const describe = (from: number, to: number) => {
      const rows: { row: number; len: number; wrapped: boolean }[] = [];
      for (let r = Math.max(0, from); r <= to; r++) {
        const line = buf.getLine(r);
        if (!line) break;
        rows.push({ row: r, len: line.translateToString(true).length, wrapped: Boolean(line.isWrapped) });
      }
      return rows;
    };
    const cols = this.term.cols ?? 0;
    if (this.currentRegion()) {
      const region = this.regions[this.regions.length - 1];
      const at = region.commandMarker?.line ?? region.start.line;
      return { mode: 'osc', cols, markerRow: at, bounds: null, rows: describe(at - 1, at + 3) };
    }
    const live = this.markers.filter((m) => !m.isDisposed && m.line >= 0);
    const newest = live[live.length - 1];
    if (!newest) return { mode: 'none', cols, markerRow: null, bounds: null, rows: [] };
    const bounds = this.logicalLineBounds(newest.line);
    return {
      mode: 'enter-marker',
      cols,
      markerRow: newest.line,
      bounds,
      rows: describe(Math.min(bounds.start, newest.line) - 1, Math.max(bounds.end, newest.line) + 2),
    };
  }

  /** Details of the most recent command output, or null when there is none. */
  public getCleanOutput(): CleanOutputInfo | null {
    const text = this.lastOutput();
    if (!text || !text.trim()) return null;
    const lines = text.split('\n');
    return {
      text,
      lineCount: lines.length,
      charCount: text.length,
    };
  }

  public dispose(): void {
    this.oscHandler.dispose();
    this.pendingCommandMarker?.dispose();
    this.pendingCommandMarker = undefined;
    this.promptAnchors.dispose();
    for (const m of this.markers) this.dropMarker(m);
    for (const r of this.regions) {
      r.start.dispose();
      r.commandMarker?.dispose();
      r.end?.dispose();
    }
    this.markers = [];
    this.regions = [];
  }
}

/**
 * Copies the clean output of the most recent command to the system clipboard.
 * Returns information about the copied text, or null if no output exists.
 */
export async function copyCleanOutputToClipboard(
  tracker: CommandOutputTracker
): Promise<CleanOutputInfo | null> {
  const info = tracker.getCleanOutput();
  if (!info) return null;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(info.text);
      return info;
    }
  } catch {
    // Clipboard permission denied or document not focused
  }
  return null;
}
