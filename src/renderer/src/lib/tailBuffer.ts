/** Default cap for text kept while following a file: about 2 MB of characters. */
export const TAIL_MAX_CHARS = 2_000_000;

/**
 * Appends a chunk to followed text without letting it grow for ever: when the result is over `max`, the oldest
 * text is dropped, up to the next line break so the first remaining line is never cut off.
 */
export function appendCapped(previous: string, chunk: string, max: number = TAIL_MAX_CHARS): string {
  const combined = previous + chunk;
  if (combined.length <= max) return combined;
  const cut = combined.length - max;
  const newline = combined.indexOf('\n', cut);
  return newline === -1 ? combined.slice(cut) : combined.slice(newline + 1);
}
