/** Reading an asciicast v2 recording for playback. */

export interface CastEvent {
  t: number;
  kind: "o" | "m" | "r";
  data: string;
}

export interface ParsedCast {
  width: number;
  height: number;
  title?: string;
  events: CastEvent[];
  duration: number;
}

/** Pauses longer than this are shown as this long. */
export const IDLE_LIMIT = 2;

export function parseCast(text: string): ParsedCast {
  const lines = text.split("\n").filter((l) => l.trim());
  let header: { width?: number; height?: number; title?: string } = {};
  try {
    header = JSON.parse(lines[0] ?? "{}");
  } catch {
    // A header that is not JSON: play what can be played at the default size.
  }
  const events: CastEvent[] = [];
  let last = 0;
  let shifted = 0;
  for (const line of lines.slice(1)) {
    try {
      const [t, kind, data] = JSON.parse(line) as [number, string, string];
      if (typeof t !== "number" || typeof data !== "string" || !["o", "m", "r"].includes(kind)) continue;
      const gap = t - last;
      if (gap > IDLE_LIMIT) shifted += gap - IDLE_LIMIT;
      last = t;
      events.push({ t: Math.max(0, t - shifted), kind: kind as CastEvent["kind"], data });
    } catch {
      // A line cut off at the end of a run: the rest still plays.
    }
  }
  return {
    width: header.width ?? 120,
    height: header.height ?? 32,
    title: header.title,
    events,
    duration: events.at(-1)?.t ?? 0,
  };
}

