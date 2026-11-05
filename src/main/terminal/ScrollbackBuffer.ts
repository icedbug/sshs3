/** Default cap per session, in UTF-16 code units (about 1 MB of ASCII output). */
export const DEFAULT_SCROLLBACK_LIMIT = 1_000_000;

/**
 * Keeps the most recent output of each terminal session in the main process, so a terminal that is
 * moved to another window can be redrawn there (a new xterm instance starts empty). Raw bytes are
 * kept as received; replaying them into a fresh terminal reproduces the screen.
 */
export class ScrollbackBuffer {
  private readonly sessions = new Map<string, SessionBuffer>();

  constructor(private readonly limit: number = DEFAULT_SCROLLBACK_LIMIT) {}

  append(sessionId: string, data: string): void {
    if (!sessionId || !data) return;
    let buf = this.sessions.get(sessionId);
    if (!buf) {
      buf = { chunks: [], head: 0, size: 0 };
      this.sessions.set(sessionId, buf);
    }
    buf.chunks.push(data);
    buf.size += data.length;
    // Drop whole old chunks first; only the oldest remaining chunk is ever cut. `head` marks the oldest live
    // chunk, so dropping one is O(1) instead of shifting the whole array on every event.
    while (buf.size > this.limit && buf.chunks.length - buf.head > 1) {
      buf.size -= buf.chunks[buf.head].length;
      buf.chunks[buf.head] = '';
      buf.head += 1;
    }
    if (buf.size > this.limit && buf.chunks.length - buf.head === 1) {
      buf.chunks[buf.head] = trimToLimit(buf.chunks[buf.head], this.limit);
      buf.size = buf.chunks[buf.head].length;
    }
    // Reclaim the dropped slots once they are the larger part of the array.
    if (buf.head >= COMPACT_MIN_HEAD && buf.head * 2 >= buf.chunks.length) {
      buf.chunks.splice(0, buf.head);
      buf.head = 0;
    }
  }

  get(sessionId: string): string {
    const buf = this.sessions.get(sessionId);
    return buf ? buf.chunks.slice(buf.head).join('') : '';
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  clear(): void {
    this.sessions.clear();
  }
}

interface SessionBuffer {
  chunks: string[];
  /** Index of the oldest chunk still kept; everything before it has been dropped. */
  head: number;
  size: number;
}

const COMPACT_MIN_HEAD = 1024;

/** Cuts from the front to `limit`, starting at a line boundary when one is close so no line is half-replayed. */
function trimToLimit(text: string, limit: number): string {
  const cut = text.slice(text.length - limit);
  const newline = cut.indexOf('\n');
  return newline >= 0 && newline < 4096 ? cut.slice(newline + 1) : cut;
}
