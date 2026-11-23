import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { IDLE_LIMIT, parseCast } from "../../lib/asciicast";
import { useDialogFocus } from "../../lib/useDialogFocus";
import { useModalDismiss } from "../../lib/useModalDismiss";
import { AnsiLogView } from "./DiffViewer";

/**
 * Plays back what an agent's terminal showed during a run, from an asciicast
 * v2 recording. Long pauses are shortened (as asciinema's idle limit does), and
 * every command is a marker that can be jumped to, so an hour of a run can be
 * read by what was done instead of watched from the start.
 */

const clock = (s: number): string =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export const PLAYBACK_SPEEDS = [0.5, 1, 1.5, 2, 4] as const;

export interface RecordingMarker {
  t: number;
  data: string;
  exit?: string;
}

function defaultRenderMode(): "terminal" | "ansi" {
  if (typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent)) {
    return "ansi";
  }
  return "terminal";
}

export function RecordingPlayer({
  cast,
  title,
  sealed,
  startAt,
  onClose,
}: {
  cast: string;
  title: string;
  /** Whether it matches the hash the audit log kept when it was finished. */
  sealed?: boolean;
  /** A command to open the recording at: its marker. */
  startAt?: string;
  onClose: () => void;
}): JSX.Element {
  const parsed = useMemo(() => parseCast(cast), [cast]);

  // Each command, with how it ended: the exit event that follows its marker, before the next one.
  const markers = useMemo<RecordingMarker[]>(() => {
    const out: RecordingMarker[] = [];
    for (const e of parsed.events) {
      if (e.kind === "m") out.push({ t: e.t, data: e.data });
      else if (
        e.kind === "x" &&
        out.length &&
        out[out.length - 1].exit === undefined
      ) {
        out[out.length - 1].exit = e.data;
      }
    }
    return out;
  }, [parsed]);

  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, true);
  const onBackdropClick = useModalDismiss(onClose, true);

  const initialMarker = useMemo(
    () => (startAt ? markers.find((m) => m.data === startAt) : undefined),
    [markers, startAt],
  );

  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const [viewMode, setViewMode] = useState<"terminal" | "ansi">(
    defaultRenderMode,
  );
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(1);
  const [position, setPosition] = useState<number>(initialMarker?.t ?? 0);
  // Where playback stands: the next event to write, and the time it stands at.
  const cursor = useRef({ index: 0, at: initialMarker?.t ?? 0 });

  useEffect(() => {
    const startPos = initialMarker?.t ?? 0;
    let index = 0;
    while (
      index < parsed.events.length &&
      parsed.events[index].t <= startPos
    ) {
      index++;
    }
    cursor.current = { index, at: startPos };
    setPosition(startPos);
  }, [parsed, initialMarker]);

  useEffect(() => {
    if (viewMode !== "terminal") return;
    const t = new Terminal({
      cols: parsed.width,
      rows: parsed.height,
      disableStdin: true,
      convertEol: false,
      scrollback: 5000,
      fontSize: 12,
      theme: { background: "#020617" },
    });
    if (host.current) {
      try {
        t.open(host.current);
      } catch {
        t.dispose();
        setViewMode("ansi");
        return;
      }
    }
    term.current = t;
    const upTo = cursor.current.at;
    let out = "";
    for (let i = 0; i < parsed.events.length && parsed.events[i].t <= upTo; i++) {
      if (parsed.events[i].kind === "o") out += parsed.events[i].data;
    }
    if (out) t.write(out);

    return () => {
      t.dispose();
      term.current = null;
    };
  }, [parsed, viewMode]);

  /** Draws everything up to a point in time at once, and stands there. */
  const seek = (at: number): void => {
    const clamped = Math.max(0, Math.min(at, parsed.duration));
    const t = term.current;
    if (t) {
      t.reset();
    }
    let out = "";
    let index = 0;
    for (
      ;
      index < parsed.events.length && parsed.events[index].t <= clamped;
      index++
    ) {
      const e = parsed.events[index];
      if (e.kind === "o") out += e.data;
    }
    if (t && out) t.write(out);
    cursor.current = { index, at: clamped };
    setPosition(clamped);
  };

  useEffect(() => {
    if (!playing) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const step = (): void => {
      const { index, at } = cursor.current;
      const next = parsed.events[index];
      if (!next) {
        setPlaying(false);
        return;
      }
      timer = setTimeout(
        () => {
          if (next.kind === "o") term.current?.write(next.data);
          cursor.current = { index: index + 1, at: next.t };
          setPosition(next.t);
          step();
        },
        Math.max(0, ((next.t - at) * 1000) / speed),
      );
    };
    step();
    return () => clearTimeout(timer);
  }, [playing, speed, parsed]);

  const ansiOutputAtPosition = useMemo(() => {
    let out = "";
    for (const e of parsed.events) {
      if (e.t > position) break;
      if (e.kind === "o") out += e.data;
    }
    return out;
  }, [parsed, position]);

  const activeMarkerIdx = useMemo(() => {
    let idx = -1;
    for (let i = 0; i < markers.length; i++) {
      if (markers[i].t <= position) idx = i;
      else break;
    }
    return idx;
  }, [markers, position]);

  const stepToMarker = (delta: -1 | 1): void => {
    if (markers.length === 0) return;
    setPlaying(false);
    if (delta < 0) {
      const targetIdx = Math.max(0, activeMarkerIdx - 1);
      seek(markers[targetIdx].t);
    } else {
      const targetIdx = Math.min(markers.length - 1, activeMarkerIdx + 1);
      seek(markers[targetIdx].t);
    }
  };

  const atEnd =
    parsed.events.length > 0 && position >= parsed.duration;

  return (
    <div
      className="ai-modal-backdrop"
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Recording: ${title}`}
      onClick={onBackdropClick}
    >
      <div className="ai-recording" data-testid="recording-player">
        <header className="ai-recording-head">
          <div>
            <strong>{title}</strong>
            <small>
              What the terminal showed while the run had it. Secrets were masked
              as it was recorded; what a person typed is not in it. Pauses
              longer than {IDLE_LIMIT}s are shortened.{" "}
              {sealed === true && (
                <span className="ai-recording-sealed">
                  It matches the hash the audit log kept when it was finished.
                </span>
              )}
              {sealed === false && (
                <span className="ai-recording-broken">
                  It does not match the hash the audit log kept when it was
                  finished: it was changed since.
                </span>
              )}
            </small>
          </div>
          <div className="ai-tags">
            <div role="group" aria-label="Recording view mode" className="ai-tags">
              <button
                type="button"
                className={`ai-chip ${viewMode === "terminal" ? "ai-chip-on" : ""}`}
                aria-pressed={viewMode === "terminal"}
                onClick={() => setViewMode("terminal")}
              >
                Terminal
              </button>
              <button
                type="button"
                className={`ai-chip ${viewMode === "ansi" ? "ai-chip-on" : ""}`}
                aria-pressed={viewMode === "ansi"}
                onClick={() => setViewMode("ansi")}
              >
                ANSI Log
              </button>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close the recording"
            >
              ✕
            </button>
          </div>
        </header>

        <div className="ai-recording-body">
          {viewMode === "terminal" ? (
            <div
              className="ai-recording-screen"
              ref={host}
              data-testid="recording-terminal-screen"
            />
          ) : (
            <div
              className="ai-recording-screen ai-recording-ansi"
              data-testid="recording-ansi-screen"
            >
              <AnsiLogView text={ansiOutputAtPosition} maxLines={250} />
            </div>
          )}

          {markers.length > 0 && (
            <ol
              className="ai-recording-marks"
              aria-label="Commands in this recording"
            >
              {markers.map((m, i) => (
                <li key={`${m.t}-${i}`}>
                  <button
                    type="button"
                    aria-current={activeMarkerIdx === i ? "step" : undefined}
                    className={
                      activeMarkerIdx === i
                        ? "ai-recording-mark-active ai-recording-mark-past"
                        : position >= m.t
                          ? "ai-recording-mark-past"
                          : ""
                    }
                    onClick={() => {
                      setPlaying(false);
                      seek(m.t);
                    }}
                    title={m.data}
                  >
                    <time>{clock(m.t)}</time> <code>{m.data}</code>
                    {m.exit !== undefined && (
                      <span
                        className={m.exit === "0" ? "ai-exit-ok" : "ai-exit-bad"}
                      >
                        {m.exit === "0" ? "✓" : `exit ${m.exit}`}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>

        {markers.length > 0 && (
          <div
            className="ai-tags"
            data-testid="recording-scrubber-markers"
            aria-label="Command scrubber markers"
          >
            <small>Steps:</small>
            {markers.map((m, i) => (
              <button
                key={`scrub-${m.t}-${i}`}
                type="button"
                data-testid={`scrubber-marker-${i}`}
                className={`ai-chip ${activeMarkerIdx === i ? "ai-chip-on" : ""}`}
                onClick={() => {
                  setPlaying(false);
                  seek(m.t);
                }}
                title={`${clock(m.t)}: ${m.data}`}
              >
                {clock(m.t)} {m.data.slice(0, 28)}
                {m.data.length > 28 ? "…" : ""}
              </button>
            ))}
          </div>
        )}

        <footer className="ai-recording-controls">
          <button
            type="button"
            data-autofocus
            onClick={() => {
              if (atEnd) seek(0);
              setPlaying((p) => !p);
            }}
            disabled={parsed.events.length === 0}
          >
            {playing ? "Pause" : atEnd && position > 0 ? "Play again" : "Play"}
          </button>
          {markers.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => stepToMarker(-1)}
                disabled={activeMarkerIdx <= 0}
                aria-label="Previous command step"
              >
                Prev step
              </button>
              <button
                type="button"
                onClick={() => stepToMarker(1)}
                disabled={activeMarkerIdx >= markers.length - 1}
                aria-label="Next command step"
              >
                Next step
              </button>
            </>
          )}
          <input
            type="range"
            min={0}
            max={Math.max(parsed.duration, 0.01)}
            step={0.1}
            value={position}
            aria-label="Where in the recording"
            onChange={(e) => {
              setPlaying(false);
              seek(Number(e.target.value));
            }}
          />
          <span className="ai-recording-time">
            {clock(position)} / {clock(parsed.duration)}
          </span>
          <select
            aria-label="Playback speed"
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
          >
            {PLAYBACK_SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => {
              setPlaying(false);
              seek(parsed.duration);
            }}
            disabled={parsed.events.length === 0}
          >
            Show the end
          </button>
        </footer>
        {parsed.events.length === 0 && (
          <p className="ai-empty">This recording has nothing in it.</p>
        )}
      </div>
    </div>
  );
}
