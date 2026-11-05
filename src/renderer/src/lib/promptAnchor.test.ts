import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { IDLE_MS, PromptAnchorTracker, prefixLooksLikePrompt, stripRightPrompt } from './promptAnchor';
import { CommandOutputTracker, isAtEmptyPrompt, stripPromptLoose } from './terminalOutput';

describe('prefixLooksLikePrompt', () => {
  it.each(['$ ', 'user@host ~ % ', '~/dir > feature/x > $ ', 'λ ', '❯ ', 'root@h:/# '])('accepts %j', (p) => {
    expect(prefixLooksLikePrompt(p)).toBe(true);
  });
  it.each(['Password: ', '[Y/n] ', 'Continue? ', '$', 'ls -la '])('rejects %j', (p) => {
    expect(prefixLooksLikePrompt(p)).toBe(false);
  });
});

describe('stripRightPrompt', () => {
  it('removes a right prompt that is still drawn after a gap', () => {
    expect(stripRightPrompt('cat /x          10:42', '10:42')).toBe('cat /x');
  });
  it('keeps a command that has pushed the right prompt away or merely ends the same way', () => {
    expect(stripRightPrompt('echo 10:42', '10:42')).toBe('echo 10:42');
    expect(stripRightPrompt('cat /x', '')).toBe('cat /x');
  });
});

/** Minimal xterm stand-in with a real cursor and cell-accurate text, enough for anchors and Enter markers. */
function fakeScreen(rows: string[]) {
  const state = { rows, cursorX: 0, type: 'normal' as 'normal' | 'alternate' };
  let resize: (() => void) | undefined;
  const markers: { line: number; isDisposed: boolean }[] = [];
  const cursorRow = () => state.rows.length - 1;
  const term = {
    cols: 200,
    buffer: {
      active: {
        get type() {
          return state.type;
        },
        baseY: 0,
        get cursorY() {
          return cursorRow();
        },
        get cursorX() {
          return state.cursorX;
        },
        getLine: (i: number) =>
          state.rows[i] === undefined
            ? undefined
            : {
                isWrapped: false,
                translateToString: (trimRight?: boolean, start = 0, end?: number) => {
                  const text = state.rows[i].slice(start, end);
                  return trimRight ? text.trimEnd() : text;
                },
              },
      },
    },
    registerMarker: () => {
      const marker = {
        line: cursorRow(),
        isDisposed: false,
        dispose() {
          marker.isDisposed = true;
        },
      };
      markers.push(marker);
      return marker;
    },
    onResize: (cb: () => void) => {
      resize = cb;
      return { dispose() {} };
    },
    parser: { registerOscHandler: () => ({ dispose() {} }) },
  };
  return {
    term: term as unknown as Terminal,
    state,
    markers,
    triggerResize: () => resize?.(),
    /** The shell drew `prompt` and went quiet with the cursor right after it. */
    showPrompt(prompt: string, right = '') {
      state.rows.push(prompt + (right ? ' '.repeat(10) + right : ''));
      state.cursorX = prompt.length;
    },
  };
}

describe('PromptAnchorTracker', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('hands the position at the quiet cursor to the next Enter, once', () => {
    const f = fakeScreen([]);
    const a = new PromptAnchorTracker(f.term);
    f.showPrompt('$ ');
    a.noteOutput();
    vi.advanceTimersByTime(IDLE_MS + 1);
    expect(a.claim()?.col).toBe(2);
    expect(a.claim()).toBeNull();
  });

  it('forgets the position when output arrives that the user did not type', () => {
    const f = fakeScreen([]);
    const a = new PromptAnchorTracker(f.term);
    f.showPrompt('$ ');
    a.noteOutput();
    vi.advanceTimersByTime(IDLE_MS + 1);
    a.noteOutput(); // the prompt was redrawn or a job reported in; no new quiet moment yet
    expect(a.claim()).toBeNull();
  });

  it('keeps the position while the user is typing, and does not take the typed text for a prompt', () => {
    const f = fakeScreen([]);
    const a = new PromptAnchorTracker(f.term);
    f.showPrompt('$ ');
    a.noteOutput();
    vi.advanceTimersByTime(IDLE_MS + 1);
    a.noteInput();
    f.state.rows[0] = '$ echo $ ';
    f.state.cursorX = 9;
    a.noteOutput(); // the echo of what was typed
    vi.advanceTimersByTime(IDLE_MS + 1);
    expect(a.claim()?.col).toBe(2);
  });

  it('ignores a cursor that does not stand after a prompt, and a resize', () => {
    const f = fakeScreen([]);
    const a = new PromptAnchorTracker(f.term);
    f.showPrompt('Password: ');
    a.noteOutput();
    vi.advanceTimersByTime(IDLE_MS + 1);
    expect(a.claim()).toBeNull();
    f.showPrompt('$ ');
    a.noteOutput();
    vi.advanceTimersByTime(IDLE_MS + 1);
    f.triggerResize();
    expect(a.claim()).toBeNull();
  });
});

describe('PromptAnchorTracker after typing that never reached Enter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('learns the new prompt when the cursor has left the line the user was typing on (Ctrl+C)', () => {
    const f = fakeScreen([]);
    const a = new PromptAnchorTracker(f.term);
    f.showPrompt('$ ');
    a.noteOutput();
    vi.advanceTimersByTime(IDLE_MS + 1);
    a.noteInput(); // typed, then Ctrl+C: the shell prints ^C and a fresh prompt on a new row
    f.showPrompt('$ ');
    a.noteOutput();
    vi.advanceTimersByTime(IDLE_MS + 1);
    expect(a.claim()?.marker.line).toBe(1);
  });

  it('does not leave the marker of a position that was never claimed registered', () => {
    const f = fakeScreen([]);
    const a = new PromptAnchorTracker(f.term);
    f.showPrompt('$ ');
    a.noteOutput();
    vi.advanceTimersByTime(IDLE_MS + 1);
    f.triggerResize();
    expect(a.claim()).toBeNull();
    expect(f.markers[0].isDisposed).toBe(true);
  });
});

describe('isAtEmptyPrompt', () => {
  it('is true only with the cursor right after a prompt and nothing typed', () => {
    const f = fakeScreen([]);
    f.showPrompt('$ ');
    expect(isAtEmptyPrompt(f.term)).toBe(true);
    f.state.rows[0] = '$ ls';
    f.state.cursorX = 4;
    expect(isAtEmptyPrompt(f.term)).toBe(false);
    f.state.rows[0] = '$ ';
    f.state.cursorX = 2;
    f.state.type = 'alternate';
    expect(isAtEmptyPrompt(f.term)).toBe(false);
  });
});

describe('prompt terminators in the prompt-pattern fallback', () => {
  it('strips a prompt ending in the same extra terminators the cursor path accepts', () => {
    expect(stripPromptLoose('user λ cat /x')).toBe('cat /x');
    expect(stripPromptLoose('~/dir » cat /x')).toBe('cat /x');
  });
});

describe('CommandOutputTracker with a learned prompt position', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** A prompt the patterns would cut in the wrong place: it contains `> ` before its real terminator. */
  const PROMPT = '~/dir > feature/x > $ ';

  it('reads the command from the cursor position instead of matching the prompt', () => {
    const f = fakeScreen([]);
    const t = new CommandOutputTracker(f.term);
    f.showPrompt(PROMPT);
    t.noteOutput();
    vi.advanceTimersByTime(IDLE_MS + 1);
    t.noteInput();
    f.state.rows[0] = `${PROMPT}cat /x`;
    t.recordEnter();
    f.state.rows.push('cat: /x: Permission denied');
    f.showPrompt(PROMPT);
    expect(t.lastCommandResult()).toEqual({ command: 'cat /x', output: 'cat: /x: Permission denied' });
    expect(t.lastCommand()).toBe('cat /x');
  });

  it('removes a right-hand prompt from the command', () => {
    const f = fakeScreen([]);
    const t = new CommandOutputTracker(f.term);
    f.showPrompt('% ', '10:42');
    t.noteOutput();
    vi.advanceTimersByTime(IDLE_MS + 1);
    t.noteInput();
    f.state.rows[0] = `% cat /x${' '.repeat(10 - 6)}10:42`;
    t.recordEnter();
    f.state.rows.push('cat: /x: Permission denied');
    f.showPrompt('% ');
    expect(t.lastCommandResult()?.command).toBe('cat /x');
  });

  it('does not hand a position learned before an Enter in the alternate screen to the next Enter', () => {
    const f = fakeScreen([]);
    const t = new CommandOutputTracker(f.term);
    f.showPrompt(PROMPT);
    t.noteOutput();
    vi.advanceTimersByTime(IDLE_MS + 1);
    f.state.type = 'alternate';
    t.recordEnter(); // uses up the position although it records nothing
    f.state.type = 'normal';
    f.state.rows[0] = `${PROMPT}cat /x`;
    t.recordEnter();
    f.state.rows.push('cat: /x: Permission denied');
    f.showPrompt(PROMPT);
    // No position left, so the prompt patterns read it (and cut the prompt at its first `>`).
    expect(t.lastCommandResult()?.command).toBe('feature/x > $ cat /x');
  });

  it('does not take an answer typed into a running program for a command', () => {
    const f = fakeScreen([]);
    const t = new CommandOutputTracker(f.term);
    f.showPrompt('Do you want to continue? [Y/n] ');
    t.noteOutput();
    vi.advanceTimersByTime(IDLE_MS + 1);
    t.noteInput();
    f.state.rows[0] = 'Do you want to continue? [Y/n] y';
    t.recordEnter();
    f.state.rows.push('E: Could not open lock file');
    f.showPrompt('$ ');
    expect(t.lastCommandResult()).toBeNull();
  });
});
