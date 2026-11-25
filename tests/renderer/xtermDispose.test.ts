import { afterEach, describe, expect, it, vi } from "vitest";
import { disposeTerminalLater } from "../../src/renderer/src/lib/xtermDispose";

/**
 * What xterm 5.5 does when it opens: its viewport schedules a sync on a timer, which reads the renderer,
 * and does not cancel it on dispose. The feature test saw it throw on every page opened again with a
 * restored terminal: "Cannot read properties of undefined (reading 'dimensions')".
 */
class OpenedXterm {
  disposed = 0;
  constructor() {
    setTimeout(() => {
      if (this.disposed) throw new TypeError("Cannot read properties of undefined (reading 'dimensions')");
    });
  }
  dispose(): void {
    this.disposed += 1;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("taking an xterm terminal down", () => {
  it("waits until the timers the terminal set when it opened have run", () => {
    vi.useFakeTimers();
    const term = new OpenedXterm();
    disposeTerminalLater(term);
    expect(term.disposed).toBe(0);
    expect(() => vi.runAllTimers()).not.toThrow();
    expect(term.disposed).toBe(1);
  });

  it("is what the terminal view does when it goes away", async () => {
    const source = await import("node:fs").then((fs) => fs.readFileSync("src/renderer/src/components/TerminalView.tsx", "utf8"));
    expect(source).toContain("disposeTerminalLater(term)");
    expect(source).not.toMatch(/^\s*term\.dispose\(\);/m);
  });
});
