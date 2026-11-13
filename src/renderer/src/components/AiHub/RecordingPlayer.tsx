import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { IDLE_LIMIT, parseCast } from "../../lib/asciicast";

/**
 * Plays back what an agent's terminal showed during a run, from an asciicast
 * v2 recording. Long pauses are shortened (as asciinema's idle limit does), and
 * every command is a marker that can be jumped to, so an hour of a run can be
 * read by what was done instead of watched from the start.
 */

const clock = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

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
  const markers = useMemo(() => {
    const out: { t: number; data: string; exit?: string }[] = [];
    for (const e of parsed.events) {
      if (e.kind === "m") out.push({ t: e.t, data: e.data });
      else if (e.kind === "x" && out.length && out[out.length - 1].exit === undefined) out[out.length - 1].exit = e.data;
    }
    return out;
  }, [parsed]);
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(2);
  const [position, setPosition] = useState(0);
  // Where playback stands: the next event to write, and the time it stands at.
  const cursor = useRef({ index: 0, at: 0 });

  useEffect(() => {
    const t = new Terminal({
      cols: parsed.width,
      rows: parsed.height,
      disableStdin: true,
      convertEol: false,
      scrollback: 5000,
      fontSize: 12,
      theme: { background: "#020617" },
    });
    if (host.current) t.open(host.current);
    term.current = t;
    // Opened at a command: the screen as it was when that command started.
    const at = startAt ? markers.find((m) => m.data === startAt) : undefined;
    if (at) {
      let out = "";
      let index = 0;
      for (; index < parsed.events.length && parsed.events[index].t <= at.t; index++)
        if (parsed.events[index].kind === "o") out += parsed.events[index].data;
      t.write(out);
      cursor.current = { index, at: at.t };
      setPosition(at.t);
    }
    return () => {
      t.dispose();
      term.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- opened once per recording
  }, [parsed]);

  useEffect(() => {
    const close = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [onClose]);

  /** Draws everything up to a point in time at once, and stands there. */
  const seek = (at: number): void => {
    const t = term.current;
    if (!t) return;
    t.reset();
    let out = "";
    let index = 0;
    for (; index < parsed.events.length && parsed.events[index].t <= at; index++) {
      const e = parsed.events[index];
      if (e.kind === "o") out += e.data;
    }
    t.write(out);
    cursor.current = { index, at };
    setPosition(at);
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

  const atEnd = cursor.current.index >= parsed.events.length;
  return (
    <div className="ai-modal-backdrop" role="dialog" aria-modal="true" aria-label={`Recording: ${title}`}>
      <div className="ai-recording" data-testid="recording-player">
        <header className="ai-recording-head">
          <div>
            <strong>{title}</strong>
            <small>
              What the terminal showed while the run had it. Secrets were masked as it was recorded; what a person typed
              is not in it. Pauses longer than {IDLE_LIMIT}s are shortened.{" "}
              {sealed === true && <span className="ai-recording-sealed">It matches the hash the audit log kept when it was finished.</span>}
              {sealed === false && (
                <span className="ai-recording-broken">It does not match the hash the audit log kept when it was finished: it was changed since.</span>
              )}
            </small>
          </div>
          <button type="button" onClick={onClose} aria-label="Close the recording">
            ✕
          </button>
        </header>
        <div className="ai-recording-body">
          <div className="ai-recording-screen" ref={host} />
          {markers.length > 0 && (
            <ol className="ai-recording-marks" aria-label="Commands in this recording">
              {markers.map((m, i) => (
                <li key={`${m.t}-${i}`}>
                  <button
                    type="button"
                    className={position >= m.t ? "ai-recording-mark-past" : ""}
                    onClick={() => {
                      setPlaying(false);
                      seek(m.t);
                    }}
                    title={m.data}
                  >
                    <time>{clock(m.t)}</time> <code>{m.data}</code>
                    {m.exit !== undefined && <span className={m.exit === "0" ? "ai-exit-ok" : "ai-exit-bad"}>{m.exit === "0" ? "✓" : `exit ${m.exit}`}</span>}
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>
        <footer className="ai-recording-controls">
          <button
            type="button"
            onClick={() => {
              if (atEnd) seek(0);
              setPlaying((p) => !p);
            }}
            disabled={parsed.events.length === 0}
          >
            {playing ? "Pause" : atEnd && position > 0 ? "Play again" : "Play"}
          </button>
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
          <select aria-label="Playback speed" value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
            {[1, 2, 4, 8].map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
          <button type="button" onClick={() => seek(parsed.duration)} disabled={parsed.events.length === 0}>
            Show the end
          </button>
        </footer>
        {parsed.events.length === 0 && <p className="ai-empty">This recording has nothing in it.</p>}
      </div>
    </div>
  );
}
