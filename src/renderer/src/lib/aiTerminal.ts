/**
 * Helpers for the AI assistant's terminal integration: spotting a failed command
 * so the terminal can offer to explain it, and replacing the typed line with a command.
 */

/** Window event the AI settings page dispatches after saving, so open terminals pick up the change. */
export const AI_CONFIG_CHANGED_EVENT = 'sshs3:ai-config-changed';

/** Exit codes that mean "the user stopped it", not "it failed": 130 = Ctrl+C (SIGINT), 148 = Ctrl+Z. */
const USER_INTERRUPT_CODES = new Set([130, 148]);

export function isFailureExitCode(code: number | null): boolean {
  return code !== null && code !== 0 && !USER_INTERRUPT_CODES.has(code);
}

/**
 * Messages that almost always mean a command failed. Used only for shells without OSC 133
 * integration, where the exit code is unknown; kept specific so normal output (a log line
 * that mentions "error", a grep hit) doesn't trigger it.
 */
const FAILURE_PATTERNS: RegExp[] = [
  /: command not found\b/,
  /: No such file or directory\b/,
  /: Permission denied\b/,
  /\bis not recognized as an internal or external command\b/, // cmd.exe
  /\bCommandNotFoundException\b|\bis not recognized as a name of a cmdlet\b/, // PowerShell
  /^Traceback \(most recent call last\):/m,
  /^(?:fatal|error)(?:\[[A-Z]?\d+\])?: /m, // git, rustc, gcc-style tools
  /^E: /m, // apt
  /^npm ERR! /m,
  /\bSegmentation fault\b/,
  /\bCould not resolve host\b|\bConnection refused\b|\bConnection timed out\b/,
  /\bUnable to locate package\b/,
  /\bsyntax error near unexpected token\b/,
];

/** Only the end of the output is checked: that's where a failing command reports why. */
const TAIL_LINES = 15;

export function looksLikeFailure(output: string | null): boolean {
  if (!output) return false;
  const tail = output.split('\n').slice(-TAIL_LINES).join('\n');
  return FAILURE_PATTERNS.some((pattern) => pattern.test(tail));
}

/**
 * Keystrokes that erase `typed` from the shell's line editor before the command is typed in its
 * place. One backspace (DEL) per character works in bash, zsh, fish, PowerShell and cmd alike,
 * as long as the cursor is at the end of the line.
 */
export function eraseTypedLine(typed: string): string {
  return '\x7f'.repeat([...typed].length);
}

/**
 * Follows what the user has typed on the current command line, from the keystrokes sent to the
 * shell. It can't see the shell's own line editing (history recall, tab completion, cursor moves),
 * so after any of those it reports the line as unknown (null) until the next Enter, Ctrl+C or
 * Ctrl+U, rather than guessing and later erasing the wrong text.
 */
export class TypedLineTracker {
  private buffer = '';
  private known = true;

  /** The typed line, or null when it can't be known exactly. */
  public get text(): string | null {
    return this.known ? this.buffer : null;
  }

  public feed(data: string): void {
    // Bracketed-paste markers wrap pasted text; the text itself is ordinary input.
    // eslint-disable-next-line no-control-regex
    const input = data.replace(/\x1b\[20[01]~/g, '');
    if (input.includes('\x1b')) {
      this.known = false;
      return;
    }
    for (const ch of input) {
      if (ch === '\r' || ch === '\n' || ch === '\x03' || ch === '\x15') {
        this.buffer = '';
        this.known = true;
      } else if (ch === '\x7f' || ch === '\b') {
        this.buffer = [...this.buffer].slice(0, -1).join('');
      } else if (ch < ' ') {
        this.known = false;
      } else {
        this.buffer += ch;
      }
    }
  }
}
