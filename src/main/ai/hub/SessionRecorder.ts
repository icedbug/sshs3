import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { maskSecrets, maskTerminalOutput } from "./privacy";

/**
 * What an agent saw in a terminal, kept so it can be watched again.
 *
 * A recording is made only while an agent's run owns a terminal, and only of
 * what the terminal showed: what a person types is never recorded. It is
 * written as asciicast v2 — a header line, then one line per event — which
 * any asciinema player replays, and which the app replays in its own
 * terminal.
 *
 * Secrets are masked on the way in, and the control codes a terminal draws
 * with are kept, so it replays as it looked. Output comes in pieces that may
 * cut a secret in half; text is therefore held back until the end of a line
 * (or until there is a lot of it), masked as a whole line, and only then
 * written.
 *
 * Each command gets a marker, so a recording of an hour can be jumped
 * through by what was run instead of watched from the start.
 */

export interface RecordingInfo {
  id: string;
  taskId: string;
  sessionId: string;
  label: string;
  startedAt: number;
  endedAt?: number;
  bytes: number;
  markers: number;
}

interface Open {
  info: RecordingInfo;
  file: string;
  started: number;
  pending: string;
  /** When a prompt or a redraw stops without a newline, it is written after a short pause instead of late. */
  flush?: NodeJS.Timeout;
  writes: Promise<unknown>;
}

/** Output with no newline is written after this long without more. */
const IDLE_FLUSH_MS = 300;

/** Held back until a line ends, or until there is this much: then masked and written all the same. */
const MAX_PENDING = 4096;
/** A recording stops growing here; the rest of the run is not recorded, and the file says so. */
const MAX_BYTES = 20 * 1024 * 1024;

export class SessionRecorder {
  private readonly open = new Map<string, Open>();

  constructor(private readonly dir: string) {}

  /** Where a recording lives on disk. */
  fileOf(id: string): string {
    return path.join(this.dir, `${id.replace(/[^A-Za-z0-9_-]/g, "_")}.cast`);
  }

  recording(sessionId: string): RecordingInfo | undefined {
    return this.open.get(sessionId)?.info;
  }

  /** Starts recording a terminal for a run. A terminal already being recorded keeps its recording. */
  async start(input: { sessionId: string; taskId: string; label: string; cols?: number; rows?: number }, now = Date.now()): Promise<RecordingInfo> {
    const existing = this.open.get(input.sessionId);
    if (existing?.info.taskId === input.taskId) return existing.info;
    // A terminal still recorded for another run: that recording ends here, this run gets its own.
    if (existing) void this.stop(input.sessionId, now);
    // One file per time a run holds the terminal: a run that takes it again after a person had it
    // gets a second recording, and the first is never written over.
    const id = `${input.taskId}-${input.sessionId}`.slice(0, 100) + `-${now.toString(36)}`;
    const info: RecordingInfo = { id, taskId: input.taskId, sessionId: input.sessionId, label: input.label, startedAt: now, bytes: 0, markers: 0 };
    const file = this.fileOf(id);
    const header = {
      version: 2,
      width: input.cols ?? 120,
      height: input.rows ?? 32,
      timestamp: Math.floor(now / 1000),
      title: `${input.label} — run ${input.taskId}`,
      env: { TERM: "xterm-256color" },
    };
    // Registered before anything is written, so the first output and marker are not lost while the file is made.
    const ready = fs
      .mkdir(this.dir, { recursive: true, mode: 0o700 })
      .then(() => fs.writeFile(file, `${JSON.stringify(header)}\n`, { mode: 0o600 }));
    this.open.set(input.sessionId, { info, file, started: now, pending: "", writes: ready });
    await ready;
    return info;
  }

  /** What the terminal showed. Held back to the end of a line, masked, then written. */
  output(sessionId: string, data: string, now = Date.now()): void {
    const rec = this.open.get(sessionId);
    if (!rec || !data) return;
    rec.pending += data;
    if (rec.flush) clearTimeout(rec.flush);
    const cut = rec.pending.lastIndexOf("\n");
    if (cut >= 0 || rec.pending.length >= MAX_PENDING) {
      const ready = cut >= 0 ? rec.pending.slice(0, cut + 1) : rec.pending;
      rec.pending = cut >= 0 ? rec.pending.slice(cut + 1) : "";
      this.event(rec, "o", maskTerminalOutput(ready), now);
    }
    // A prompt ("Are you sure? [y/N] ") has no newline after it: written once the terminal goes quiet.
    if (rec.pending)
      rec.flush = setTimeout(() => {
        rec.flush = undefined;
        if (!rec.pending || !this.open.has(sessionId)) return;
        const text = rec.pending;
        rec.pending = "";
        this.event(rec, "o", maskTerminalOutput(text), now + IDLE_FLUSH_MS);
      }, IDLE_FLUSH_MS);
  }

  /** How the last command ended: an asciicast exit event ("x"), which players that do not know it skip. */
  exit(sessionId: string, exitCode: number, now = Date.now()): void {
    const rec = this.open.get(sessionId);
    if (!rec) return;
    this.flushPending(rec, now);
    this.event(rec, "x", String(exitCode), now);
  }

  private flushPending(rec: Open, now: number): void {
    if (rec.flush) clearTimeout(rec.flush);
    rec.flush = undefined;
    if (rec.pending) this.event(rec, "o", maskTerminalOutput(rec.pending), now);
    rec.pending = "";
  }

  /** A point to jump to: the command that is about to run. */
  marker(sessionId: string, label: string, now = Date.now()): void {
    const rec = this.open.get(sessionId);
    if (!rec) return;
    // What is held back belongs before the marker.
    this.flushPending(rec, now);
    rec.info.markers++;
    this.event(rec, "m", maskSecrets(label).slice(0, 300), now);
  }

  resize(sessionId: string, cols: number, rows: number, now = Date.now()): void {
    const rec = this.open.get(sessionId);
    if (rec) this.event(rec, "r", `${cols}x${rows}`, now);
  }

  /** Stops recording a terminal. What was held back is written first. */
  async stop(sessionId: string, now = Date.now()): Promise<RecordingInfo | undefined> {
    const rec = this.open.get(sessionId);
    if (!rec) return undefined;
    this.flushPending(rec, now);
    this.open.delete(sessionId);
    rec.info.endedAt = now;
    await rec.writes;
    return rec.info;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.open.keys()].map((id) => this.stop(id)));
  }

  /** The recordings on disk, newest first. */
  async list(): Promise<Array<{ id: string; bytes: number; modifiedAt: number }>> {
    const names = await fs.readdir(this.dir).catch(() => [] as string[]);
    const out: Array<{ id: string; bytes: number; modifiedAt: number }> = [];
    for (const name of names.filter((n) => n.endsWith(".cast"))) {
      const stat = await fs.stat(path.join(this.dir, name)).catch(() => undefined);
      if (stat) out.push({ id: name.slice(0, -5), bytes: stat.size, modifiedAt: stat.mtimeMs });
    }
    return out.sort((a, b) => b.modifiedAt - a.modifiedAt);
  }

  /** One recording as asciicast text, for the player. */
  async read(id: string): Promise<string | undefined> {
    return fs.readFile(this.fileOf(id), "utf8").catch(() => undefined);
  }

  /** The sha256 of a recording as it is on disk: what the audit log keeps of it. */
  async digest(id: string): Promise<string | undefined> {
    const bytes = await fs.readFile(this.fileOf(id)).catch(() => undefined);
    return bytes ? crypto.createHash("sha256").update(bytes).digest("hex") : undefined;
  }

  /** Removes a finished recording in which nothing ran. One that is still being made is left alone. */
  async discard(id: string): Promise<void> {
    if ([...this.open.values()].some((r) => r.info.id === id)) return;
    await fs.rm(this.fileOf(id), { force: true }).catch(() => undefined);
  }

  /** Recordings older than `days` are removed. */
  async prune(days: number, now = Date.now()): Promise<number> {
    let removed = 0;
    for (const r of await this.list())
      if (now - r.modifiedAt > days * 24 * 3600_000) {
        await fs.rm(this.fileOf(r.id), { force: true });
        removed++;
      }
    return removed;
  }

  private event(rec: Open, kind: "o" | "m" | "r" | "x", text: string, now: number): void {
    if (!text) return;
    if (rec.info.bytes > MAX_BYTES) return;
    const seconds = Math.max(0, (now - rec.started) / 1000);
    let line = `${JSON.stringify([Number(seconds.toFixed(3)), kind, text])}\n`;
    rec.info.bytes += Buffer.byteLength(line, "utf8");
    if (rec.info.bytes > MAX_BYTES)
      line += `${JSON.stringify([Number(seconds.toFixed(3)), "m", "The recording stopped here: it reached its size limit."])}\n`;
    const write = (): Promise<void> => fs.appendFile(rec.file, line);
    rec.writes = rec.writes.then(write, write);
  }
}
