import type { IMarker, Terminal } from 'xterm';

const MAX_MARKERS = 50;

interface OscRegion {
  start: IMarker;
  end?: IMarker;
  /** The cursor was past column 0 when the output ended, i.e. the last output line has no newline yet. */
  partialLastLine?: boolean;
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
  private readonly oscHandler: { dispose(): void };
  private sawShellIntegration = false;
  /** Called on OSC 133 `D` (command finished) with the exit code, or null when the shell sent none. */
  public onCommandEnd: ((exitCode: number | null) => void) | null = null;

  constructor(private readonly term: Terminal) {
    this.oscHandler = term.parser.registerOscHandler(133, (data) => {
      const kind = data.charAt(0);
      this.sawShellIntegration = true;
      if (kind === 'C') {
        const start = term.registerMarker(0);
        if (start) {
          this.regions.push({ start });
          if (this.regions.length > MAX_MARKERS) this.regions.shift()?.start.dispose();
        }
      } else if (kind === 'A' || kind === 'D') {
        const open = this.regions[this.regions.length - 1];
        if (open && !open.end) {
          open.end = term.registerMarker(0);
          open.partialLastLine = term.buffer.active.cursorX > 0;
        }
        if (kind === 'D') {
          const code = Number.parseInt(data.split(';')[1] ?? '', 10);
          this.onCommandEnd?.(Number.isNaN(code) ? null : code);
        }
      }
      return true;
    });
  }

  /** True once the shell has sent OSC 133 marks, so exit codes are known instead of guessed. */
  public get hasShellIntegration(): boolean {
    return this.sawShellIntegration;
  }

  /** Call when the user presses Enter (the cursor is still on the command line). */
  public recordEnter(): void {
    if (this.term.buffer.active.type !== 'normal') return;
    const marker = this.term.registerMarker(0);
    if (!marker) return;
    this.markers.push(marker);
    if (this.markers.length > MAX_MARKERS) this.markers.shift()?.dispose();
  }

  /** Text of the most recent command that produced output, or null when there is none. */
  public lastOutput(): string | null {
    const buf = this.term.buffer.active;
    if (buf.type !== 'normal') return null;
    const cursorLine = buf.baseY + buf.cursorY;
    if (this.regions.length > 0) return this.lastOscOutput();
    const live = this.markers.filter((m) => !m.isDisposed && m.line >= 0);
    for (let i = live.length - 1; i >= 0; i--) {
      const end = i + 1 < live.length ? live[i + 1].line : cursorLine;
      const text = this.readLines(live[i].line + 1, end);
      if (text.trim()) return text;
    }
    return null;
  }

  private lastOscOutput(): string | null {
    for (let i = this.regions.length - 1; i >= 0; i--) {
      const { start, end, partialLastLine } = this.regions[i];
      if (start.isDisposed || start.line < 0 || !end || end.isDisposed || end.line < 0) continue;
      const text = this.readLines(start.line, end.line + (partialLastLine ? 1 : 0));
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

  public dispose(): void {
    this.oscHandler.dispose();
    for (const m of this.markers) m.dispose();
    for (const r of this.regions) {
      r.start.dispose();
      r.end?.dispose();
    }
    this.markers = [];
    this.regions = [];
  }
}
