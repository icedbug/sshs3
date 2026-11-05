// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import type { CommandOutputTracker } from '../../src/renderer/src/lib/terminalOutput';
import { useSudoRetry } from '../../src/renderer/src/lib/useSudoRetry';

interface SetupOptions {
  enabled?: boolean;
  rootUser?: boolean;
  cursorLine?: string;
  command?: string;
  output?: string;
  exitCode?: number;
}

function setup(opts: SetupOptions = {}) {
  const state = {
    cursorLine: opts.cursorLine ?? 'user@host:~$ ',
    bufferType: 'normal' as 'normal' | 'alternate',
    result: {
      command: opts.command ?? 'cat /etc/shadow',
      output: opts.output ?? 'cat: /etc/shadow: Permission denied',
      exitCode: opts.exitCode,
    },
  };
  const term = {
    buffer: {
      get active() {
        return {
          type: state.bufferType,
          baseY: 0,
          cursorY: 0,
          cursorX: state.cursorLine.length,
          getLine: () => ({
            translateToString: (trim?: boolean, start = 0, end?: number) => {
              const text = state.cursorLine.slice(start, end);
              return trim ? text.trimEnd() : text;
            },
          }),
        };
      },
    },
  } as unknown as Terminal;
  const tracker = {
    lastCommandResult: () => state.result,
    debugSnapshot: () => ({ mode: 'none', cols: 80, markerRow: null, bounds: null, rows: [] }),
  } as unknown as CommandOutputTracker;
  const run = vi.fn();
  const view = renderHook(() =>
    useSudoRetry({
      enabled: opts.enabled ?? true,
      rootUser: opts.rootUser,
      termRef: { current: term },
      trackerRef: { current: tracker },
      run,
    })
  );
  return { ...view, run, state };
}

const key = (k: string) => new KeyboardEvent('keydown', { key: k });

describe('useSudoRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T10:00:00'));
  });
  afterEach(() => vi.useRealTimers());

  const fail = (r: ReturnType<typeof setup>) => {
    act(() => {
      r.result.current.notifyEnter();
      r.result.current.notifyOutput();
      vi.advanceTimersByTime(300);
    });
  };

  it('offers sudo once output goes quiet at a prompt', () => {
    const r = setup();
    fail(r);
    expect(r.result.current.suggestion).toEqual({ sudoCommand: 'sudo cat /etc/shadow' });
  });

  it.each(['bash-5.3$ ', 'alun@fedora ~ % ', 'alun@fedora ~> ', '(venv) bash-5.3$ '])(
    'recognises the prompt %j of a shell whose prompt the patterns do not know',
    (cursorLine) => {
      const r = setup({ cursorLine });
      fail(r);
      expect(r.result.current.suggestion).toEqual({ sudoCommand: 'sudo cat /etc/shadow' });
    }
  );

  it('does not take a line that merely ends in text for a prompt', () => {
    const r = setup({ cursorLine: 'Enter value: ' });
    fail(r);
    expect(r.result.current.suggestion).toBeNull();
  });

  it('stays quiet when the command is not at a prompt yet, and shows once it is', () => {
    const r = setup({ cursorLine: 'Password: ' });
    fail(r);
    expect(r.result.current.suggestion).toBeNull();
    r.state.cursorLine = 'user@host:~$ ';
    act(() => {
      r.result.current.notifyOutput();
      vi.advanceTimersByTime(300);
    });
    expect(r.result.current.suggestion).not.toBeNull();
  });

  it('does nothing when disabled, at a root prompt, or for an unrelated failure', () => {
    for (const r of [
      setup({ enabled: false }),
      setup({ cursorLine: '[root@host ~]# ' }),
      setup({ rootUser: true }),
      setup({ output: 'ls: cannot access x: No such file or directory' }),
    ]) {
      fail(r);
      expect(r.result.current.suggestion).toBeNull();
    }
  });

  it('accepts on Enter after the guard time and runs the command', () => {
    const r = setup();
    fail(r);
    act(() => vi.advanceTimersByTime(500));
    let consumed = false;
    act(() => {
      consumed = r.result.current.handleKey(key('Enter'));
    });
    expect(consumed).toBe(true);
    expect(r.run).toHaveBeenCalledWith('sudo cat /etc/shadow');
    expect(r.result.current.suggestion).toBeNull();
  });

  it('ignores an Enter that arrives inside the guard time but still swallows it', () => {
    const r = setup();
    fail(r);
    let consumed = false;
    act(() => {
      consumed = r.result.current.handleKey(key('Enter'));
    });
    expect(consumed).toBe(true);
    expect(r.run).not.toHaveBeenCalled();
    expect(r.result.current.suggestion).not.toBeNull();
  });

  it('dismisses on Escape or other input without running', () => {
    const r = setup();
    fail(r);
    act(() => {
      r.result.current.handleKey(key('Escape'));
    });
    expect(r.result.current.suggestion).toBeNull();

    fail(r);
    expect(r.result.current.suggestion).not.toBeNull();
    act(() => r.result.current.notifyInput());
    expect(r.result.current.suggestion).toBeNull();
    expect(r.run).not.toHaveBeenCalled();
  });

  it('does not consume keys while nothing is offered', () => {
    const r = setup();
    expect(r.result.current.handleKey(key('Enter'))).toBe(false);
    expect(r.result.current.handleKey(key('Escape'))).toBe(false);
  });

  it('stops offering when a full-screen program takes over', () => {
    const r = setup();
    act(() => {
      r.result.current.notifyEnter();
      r.state.bufferType = 'alternate';
      r.result.current.notifyOutput();
      vi.advanceTimersByTime(300);
    });
    expect(r.result.current.suggestion).toBeNull();
    r.state.bufferType = 'normal';
    act(() => {
      r.result.current.notifyOutput();
      vi.advanceTimersByTime(300);
    });
    expect(r.result.current.suggestion).toBeNull();
  });

  it('does not arm on Enter inside a full-screen program', () => {
    const r = setup();
    r.state.bufferType = 'alternate';
    act(() => {
      r.result.current.notifyEnter();
    });
    r.state.bufferType = 'normal';
    act(() => {
      r.result.current.notifyOutput();
      vi.advanceTimersByTime(300);
    });
    expect(r.result.current.suggestion).toBeNull();
  });

  it('drops the offer when later output changes what the screen shows', () => {
    const r = setup();
    fail(r);
    expect(r.result.current.suggestion).not.toBeNull();
    r.state.result = { command: 'ls', output: 'a.txt', exitCode: undefined };
    act(() => {
      r.result.current.notifyOutput();
      vi.advanceTimersByTime(300);
    });
    expect(r.result.current.suggestion).toBeNull();
  });

  it('keeps the offer when output arrives that does not change the command or its result', () => {
    const r = setup();
    fail(r);
    act(() => {
      r.result.current.notifyOutput();
      vi.advanceTimersByTime(300);
    });
    expect(r.result.current.suggestion).not.toBeNull();
  });
});

