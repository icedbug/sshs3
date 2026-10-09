import { describe, it, expect, vi } from 'vitest';
import type { Terminal } from 'xterm';
import { CommandOutputTracker } from '../../src/renderer/src/lib/terminalOutput';

/** Just enough of an xterm Terminal for the OSC 133 handler. */
function fakeTerminal() {
  let osc: ((data: string) => boolean) | null = null;
  const term = {
    parser: {
      registerOscHandler: vi.fn((_id: number, handler: (data: string) => boolean) => {
        osc = handler;
        return { dispose: vi.fn() };
      }),
    },
    registerMarker: vi.fn(() => ({ line: 0, isDisposed: false, dispose: vi.fn() })),
    buffer: { active: { type: 'normal', cursorX: 0, cursorY: 0, baseY: 0, getLine: () => undefined } },
  };
  return { term: term as unknown as Terminal, sendOsc: (data: string) => osc?.(data) };
}

describe('CommandOutputTracker shell integration', () => {
  it('reports the exit code when a command finishes', () => {
    const { term, sendOsc } = fakeTerminal();
    const tracker = new CommandOutputTracker(term);
    const onCommandEnd = vi.fn();
    tracker.onCommandEnd = onCommandEnd;
    expect(tracker.hasShellIntegration).toBe(false);

    sendOsc('A');
    expect(tracker.hasShellIntegration).toBe(true);
    sendOsc('C');
    sendOsc('D;127');
    expect(onCommandEnd).toHaveBeenLastCalledWith(127);

    sendOsc('D;0');
    expect(onCommandEnd).toHaveBeenLastCalledWith(0);

    // Some shells send D without a code (e.g. for an empty command line).
    sendOsc('D');
    expect(onCommandEnd).toHaveBeenLastCalledWith(null);
    expect(onCommandEnd).toHaveBeenCalledTimes(3);
    tracker.dispose();
  });
});
