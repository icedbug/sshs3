/**
 * Takes an xterm terminal down once the timers it set when it opened have run. xterm 5.5's viewport
 * syncs on a timer that reads the renderer and is not cancelled on dispose, so a terminal disposed
 * before that timer runs (a tab restored and set up again as the page opens, a tab closed at once)
 * throws "Cannot read properties of undefined (reading 'dimensions')" from it.
 */
export function disposeTerminalLater(term: { dispose(): void }, delayMs = 50): void {
  setTimeout(() => {
    try {
      term.dispose();
    } catch {
      // Already taken down.
    }
  }, delayMs);
}
