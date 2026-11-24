import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { QueueStore } from "./LearningQueue";
import { maskContext } from "./privacy";

/**
 * What was done here, kept so that it can be trusted after the fact.
 *
 * Every entry is one line of JSON in a file that is only ever appended to,
 * and every entry carries the hash of the one before it. Change a line, take
 * one out, or put one in, and every hash after it stops matching: the chain
 * says where it breaks. Secrets are masked BEFORE the hash is taken, so the
 * log can be shown and shared without carrying them, and verifying it does
 * not need them.
 *
 * A chain on its own proves nothing about its own end: whoever can rewrite
 * the file can cut off the last hundred lines and the rest still verifies.
 * So the head of the chain — how far it reached and the hash it had there —
 * is written now and then into the team's bucket, one object per anchor,
 * under this installation's own name. Verifying against the anchors shows a
 * tail that was cut off, or a history that was rewritten from the start.
 */

/** What kind of thing happened. */
export type AuditKind =
  | "command" // a command ran in a terminal
  | "change" // a change that carries its own check and rollback
  | "file-write" // a file was written on a server
  | "approval" // a person said yes or no
  | "setting" // sshs3's own rules were changed
  | "mcp" // somebody's own agent asked for something over MCP
  | "sign-in" // a person signed in or out
  | "integration" // something was written to another system (an issue tracker, a wiki)
  | "recording" // a terminal recording was finished: its hash, so it can be shown not to have been changed
  | "journal"; // the log about itself: a place where it does not hold was found, or a cut line was set aside

export interface AuditInput {
  kind: AuditKind;
  /** Who did it: a person's name, or the agent and whose run it was. */
  actor: string;
  /** Where: the server or terminal, or "sshs3" for the app's own rules. */
  target?: string;
  /** What exactly: the command, the file, the setting. Masked before it is kept. */
  what: string;
  /** How it ended: completed, failed, denied, rolled-back, uncertain … */
  outcome?: string;
  exitCode?: number;
  /** Who allowed it, when somebody had to. */
  approvedBy?: string;
  /** The conversation it belonged to, and the change within it. */
  taskId?: string;
  changeId?: string;
  /** Anything else worth having, short. Masked before it is kept. */
  detail?: string;
  /** Structured event schema version for downstream log consumers. */
  schemaVersion?: number;
  changeReceipt?: "intent" | "rollback-intent" | "started" | "final";
  /** Authenticated human user id, when applicable. */
  userId?: string;
  /** Autonomous agent id, when applicable. */
  agentId?: string;
  /** Source IP address for remote/web-triggered actions, when applicable. */
  sourceIp?: string;
}

export interface AuditEntry extends AuditInput {
  seq: number;
  at: number;
  /** The hash of the entry before this one; "" for the first. */
  prev: string;
  hash: string;
}

export interface AuditAnchor {
  seq: number;
  hash: string;
  at: number;
  client: string;
  /** The anchor's own number: one more for every anchor, also when the log did not move. */
  n?: number;
  /** sha256 of the anchor before it, as written: the anchors are a chain of their own. */
  prev?: string;
}

/** An entry that waited longer than this for an anchor: the installation was off, or anchors are missing. */
const ANCHOR_GAP_MS = 45 * 60_000;
/** The entry an anchor, as written, vouches for. */
function anchoredSeq(bytes: string): number | undefined {
  try {
    return (JSON.parse(bytes) as AuditAnchor).seq;
  } catch {
    return undefined;
  }
}
/** Page size when reading anchors from the bucket during verification. */
export const ANCHORS_READ = 2000;

/** A place where the chain does not hold. */
export interface AuditBreak {
  /** The line of the file, counted from 1, as an editor shows it. */
  line: number;
  /** The entry that should stand there. */
  seq: number;
  text: string;
  /** When the log itself wrote down that it had found this place. Unset: not written down yet. */
  recordedAt?: number;
}

export interface AuditVerification {
  ok: boolean;
  entries: number;
  /** The first place the chain does not hold, said so a person understands it. */
  problem?: { seq: number; text: string };
  /** Every place the chain does not hold, oldest first, at most twenty. */
  breaks?: AuditBreak[];
  /** The file is there and could not be read: nothing is known about the log. */
  unreadable?: boolean;
  /**
   * Anchors that were checked against the chain, and how many of them held.
   * `coveredSeq`/`lastAt`: the newest entry an anchor vouches for, and when;
   * entries after it are only chained. `gaps`: stretches in which entries
   * waited for an anchor, when the installation was off or anchors were
   * removed. A quiet stretch with nothing to anchor is not a gap.
   */
  anchors?: {
    checked: number;
    held: number;
    coveredSeq?: number;
    lastAt?: number;
    pagesChecked?: number;
    gaps?: { from: number; to: number }[];
  };
  lastAt?: number;
}

const MAX_FIELD = 4000;
const FIELDS: (keyof AuditInput)[] = [
  "kind",
  "actor",
  "target",
  "what",
  "outcome",
  "exitCode",
  "approvedBy",
  "taskId",
  "changeId",
  "detail",
  "schemaVersion",
  "userId",
  "agentId",
  "sourceIp",
  "changeReceipt",
];

/** What is kept of a text: masked, then cut from the end. Masking comes first, before any hash sees it. */
const keep = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const clean = maskContext(value);
  return clean.length > MAX_FIELD ? `${clean.slice(0, MAX_FIELD - 1)}…` : clean;
};

/**
 * The bytes a hash is taken over. The fields in a fixed order, absent ones
 * left out, so the same entry always hashes the same way whatever order its
 * keys were written in.
 */
export function entryBytes(entry: Omit<AuditEntry, "hash">): string {
  const ordered: Record<string, unknown> = { seq: entry.seq, at: entry.at, prev: entry.prev };
  for (const field of FIELDS) if (entry[field] !== undefined) ordered[field] = entry[field];
  return JSON.stringify(ordered);
}

export const hashEntry = (entry: Omit<AuditEntry, "hash">): string =>
  crypto.createHash("sha256").update(entryBytes(entry)).digest("hex");


const sha256 = (data: string | Buffer): string => crypto.createHash("sha256").update(data).digest("hex");

/**
 * Which of a change's entries an entry is. Each is written at most once: what is about to change
 * something ("intent", and "rollback-intent" before a rollback), a command that has been running
 * for a while ("started"), and how it ended (anything else).
 */
const receiptPhase = (outcome: string | undefined): NonNullable<AuditEntry["changeReceipt"]> =>
  outcome === "intent" || outcome === "rollback-intent" || outcome === "started" ? outcome : "final";

/** The file is there and cannot be read: nothing is known about the log, which is not the same as "it holds". */
export class AuditUnreadable extends Error {}

/** What a marker entry carries when the log wrote down that it had found a place where it does not hold. */
const BREAK_RECORDED = "break-recorded";
/** How many places where the chain does not hold are kept one by one. More than that are only counted. */
const MAX_BREAKS = 50;
/** A "line" longer than this is not an entry: it is given up as one broken line, not read into memory whole. */
const MAX_LINE = 1 << 22;

/**
 * The hash and the time of every entry by its number, kept small (40 bytes an entry): an anchor names an
 * entry by its number, and the check then needs that entry's hash without reading the file again.
 */
class SeqTable {
  private hashes = Buffer.alloc(0);
  private ats = new Float64Array(0);

  /** `limit`: the lines read so far. A number beyond it is a forgery or a mistake, and nothing an anchor could match. */
  set(seq: number, hash: string, at: number, limit: number): void {
    if (!Number.isInteger(seq) || seq < 1 || seq > limit || !/^[0-9a-f]{64}$/.test(hash)) return;
    if (seq >= this.ats.length) {
      const size = Math.max(1024, seq + 1, this.ats.length * 2);
      const hashes = Buffer.alloc(size * 32);
      this.hashes.copy(hashes);
      const ats = new Float64Array(size).fill(Number.NaN);
      ats.set(this.ats);
      this.hashes = hashes;
      this.ats = ats;
    }
    this.hashes.write(hash, seq * 32, "hex");
    this.ats[seq] = Number.isFinite(at) ? at : 0;
  }
  private has(seq: number): boolean {
    return Number.isInteger(seq) && seq >= 1 && seq < this.ats.length && !Number.isNaN(this.ats[seq]);
  }
  hash(seq: number): string | undefined {
    return this.has(seq) ? this.hashes.subarray(seq * 32, seq * 32 + 32).toString("hex") : undefined;
  }
  at(seq: number): number | undefined {
    return this.has(seq) ? this.ats[seq] : undefined;
  }
  clear(): void {
    this.hashes = Buffer.alloc(0);
    this.ats = new Float64Array(0);
  }
}

/** How far the chain was walked, what the next entry must be, and what was found on the way. */
interface ChainState {
  /** Bytes of the file walked: up to and with the last line break. */
  size: number;
  lines: number;
  /** The number the next entry must carry, and the hash it must name as the one before it. */
  expected: number;
  prev: string;
  entries: number;
  lastAt?: number;
  breaks: AuditBreak[];
  moreBreaks: number;
  /** After a line that was no entry at all: what the next entry should follow is not known, so it is taken as it stands. */
  adrift: boolean;
}

const freshState = (): ChainState => ({ size: 0, lines: 0, expected: 1, prev: "", entries: 0, breaks: [], moreBreaks: 0, adrift: false });

/** Reads a file from `from` to its end and hands over every whole line, without its line break. Returns what follows the last line break. */
async function readLines(file: string, from: number, each: (line: Buffer, lineBreak: boolean) => void): Promise<Buffer> {
  const handle = await fs.open(file, "r");
  try {
    const chunk = Buffer.alloc(1 << 18);
    let carry: Buffer = Buffer.alloc(0);
    let position = from;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      let start = 0;
      for (;;) {
        const end = data.indexOf(0x0a, start);
        if (end < 0) break;
        each(data.subarray(start, end), true);
        start = end + 1;
      }
      carry = Buffer.from(data.subarray(start));
      if (carry.length > MAX_LINE) {
        each(carry, false);
        carry = Buffer.alloc(0);
      }
    }
    return carry;
  } finally {
    await handle.close();
  }
}

const whenRecorded = (at: number): string => `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;

export class AuditLog {
  readonly file: string;
  /** Where the walk of the chain stands. Undefined until the file was read, and after a write that failed. */
  private state?: ChainState;
  private readonly table = new SeqTable();
  /**
   * The file as it was when the walk last reached its end, or when this log last wrote to it. Its change
   * time (`ctimeMs`) too: the time a file was written can be set back (`touch -d`), the time its inode
   * last changed cannot, by any user (on Linux and macOS), so an edit of the same length in place is
   * seen by it.
   */
  private seen?: { ino: number; size: number; mtimeMs: number; ctimeMs: number };
  /** What followed the last line break when the file was last read: a line that was cut off, or nothing. */
  private rest: Buffer = Buffer.alloc(0);
  /** Whether the end of the file was looked at and mended since it was last read: only then is it written to. */
  private loaded = false;
  private changeReceipts = new Map<string, AuditEntry>();
  /** Writes and walks, one at a time: both move the same state. */
  private writes: Promise<unknown> = Promise.resolve();
  /** The newest anchor this installation wrote, read back from the bucket once. */
  private lastAnchor?: { n: number; bytes: string };
  private anchorRead = false;
  /** Anchors read from the bucket so far, by the name of their object: each is read once, not at every check. */
  private readonly anchorCache = new Map<string, { anchor: AuditAnchor; bytes: string }>();

  constructor(
    private readonly dir: string,
    private readonly client: string,
    /** The team bucket, when there is one: where the anchors go. */
    private readonly bucket?: () => QueueStore | undefined,
  ) {
    this.file = path.join(dir, `audit-${client.replace(/[^A-Za-z0-9_-]/g, "_")}.jsonl`);
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.writes.then(run, run);
    this.writes = next.catch(() => undefined);
    return next;
  }

  private reset(): ChainState {
    this.state = freshState();
    this.table.clear();
    this.changeReceipts = new Map();
    this.rest = Buffer.alloc(0);
    return this.state;
  }

  /**
   * Takes one line of the file into the walk: an entry must hash to what it says, carry the hash of
   * the one before it, and follow it by one. Where that does not hold the place is written down and
   * the walk goes on: one broken line says nothing about the lines after it.
   */
  private take(state: ChainState, raw: Buffer, lineBreak = true): void {
    state.lines++;
    state.size += raw.length + (lineBreak ? 1 : 0);
    const line = raw.toString("utf8");
    if (!line.trim()) return;
    let broken = false;
    const broke = (seq: number, text: string): void => {
      broken = true;
      if (state.breaks.length < MAX_BREAKS) state.breaks.push({ line: state.lines, seq, text });
      else state.moreBreaks++;
    };
    let entry: AuditEntry | undefined;
    try {
      const parsed = JSON.parse(line) as AuditEntry | null;
      if (parsed && typeof parsed === "object" && Number.isInteger(parsed.seq) && typeof parsed.hash === "string" && typeof parsed.prev === "string") entry = parsed;
    } catch {
      entry = undefined;
    }
    if (!entry) {
      broke(state.expected, `Line ${state.lines} is not a whole entry: the file was cut or edited there.`);
      state.adrift = true;
      return;
    }
    // A public digest compared with the one it should be, not a secret: no timing to hide.
    const { hash: stated, ...rest } = entry;
    if (!state.adrift) {
      if (entry.seq !== state.expected)
        broke(state.expected, entry.seq > state.expected ? `Entries ${state.expected} to ${entry.seq - 1} are missing.` : `Entry ${entry.seq} appears again where ${state.expected} should be.`);
      else if (entry.prev !== state.prev) broke(entry.seq, `Entry ${entry.seq} does not follow the one before it: something before it was changed.`);
    }
    if (!broken && hashEntry(rest) !== stated) broke(entry.seq, `Entry ${entry.seq} was changed after it was written.`);
    state.adrift = false;
    state.expected = entry.seq + 1;
    state.prev = stated;
    state.entries++;
    state.lastAt = entry.at;
    this.table.set(entry.seq, stated, entry.at, state.lines);
    const key = entry.changeReceipt && this.receiptKey(entry);
    if (key) this.changeReceipts.set(key, entry);
    // The log's own word that it found the places before this entry where it does not hold.
    if (!broken && entry.kind === "journal" && entry.outcome === BREAK_RECORDED) for (const b of state.breaks) b.recordedAt ??= entry.at;
  }

  /**
   * Brings the walk to the end of the file and returns what follows its last line break. While the
   * file is exactly as this log left it (same file, size, time written and time changed), nothing is read: every entry
   * this log wrote was taken into the walk as it was written. Anything else walks it from the start.
   */
  private async catchUp(full: boolean): Promise<Buffer> {
    let stat: { ino: number; size: number; mtimeMs: number; ctimeMs: number };
    try {
      stat = await fs.stat(this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.reset();
        this.seen = undefined;
        return this.rest;
      }
      this.state = undefined;
      throw new AuditUnreadable(`The audit log could not be read (${(error as Error).message}).`, { cause: error });
    }
    const untouched =
      this.seen !== undefined &&
      this.seen.ino === stat.ino &&
      this.seen.size === stat.size &&
      this.seen.mtimeMs === stat.mtimeMs &&
      this.seen.ctimeMs === stat.ctimeMs;
    if (!full && this.state && untouched) return this.rest;
    const state = this.reset();
    try {
      this.rest = await readLines(this.file, 0, (line, lineBreak) => this.take(state, line, lineBreak));
    } catch (error) {
      this.state = undefined;
      throw new AuditUnreadable(`The audit log could not be read (${(error as Error).message}).`, { cause: error });
    }
    this.seen = { ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
    // A line that was cut off has to be dealt with before anything is written after it.
    if (this.rest.length) this.loaded = false;
    return this.rest;
  }

  /** Whether a text is the entry that comes next in the chain, whole. */
  private follows(state: ChainState, text: string): AuditEntry | undefined {
    try {
      const entry = JSON.parse(text) as AuditEntry | null;
      if (!entry || typeof entry !== "object" || typeof entry.hash !== "string") return undefined;
      const { hash: stated, ...rest } = entry;
      if (hashEntry(rest) !== stated) return undefined;
      if (!state.adrift && (entry.seq !== state.expected || entry.prev !== state.prev)) return undefined;
      return entry;
    } catch {
      return undefined;
    }
  }

  /**
   * Makes the log ready to be written to. A last line that was cut off while it was written (a crash)
   * is kept in a file beside the log and taken out of it, and the chain goes on from the last whole
   * entry, with an entry that says so. A place in the middle where the chain does not hold stays as
   * it is: the log writes down where it is, once, and goes on. Neither stops what comes after.
   * Only a file that cannot be read at all does.
   */
  private async load(): Promise<void> {
    if (!this.loaded || !this.state) {
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
      const rest = await this.catchUp(false);
      if (rest.length) await this.mendEnd(rest);
      this.loaded = true;
    }
    const state = this.state!;
    const open = state.breaks.filter((b) => b.recordedAt === undefined);
    if (!open.length) return;
    const more = open.length - 1 + state.moreBreaks;
    await this.write(
      {
        kind: "journal",
        actor: "sshs3",
        target: "audit log",
        what: `The audit log does not hold at line ${open[0].line}: ${open[0].text}${more > 0 ? ` It does not hold at ${more} more place${more === 1 ? "" : "s"} after that.` : ""} What stands before this entry cannot be relied on. The log goes on from here.`,
        outcome: BREAK_RECORDED,
        detail: `line ${open[0].line}`,
      },
      Date.now(),
    );
  }

  private async mendEnd(rest: Buffer): Promise<void> {
    const state = this.state!;
    const text = rest.toString("utf8");
    if (text.trim() && this.follows(state, text)) {
      // The entry is whole and only its line break is missing.
      await fs.appendFile(this.file, "\n", { flush: true });
      this.take(state, rest);
      this.rest = Buffer.alloc(0);
      this.seen = await fs.stat(this.file).catch(() => undefined);
      return;
    }
    const line = state.lines + 1;
    const side = `${this.file}.torn`;
    if (text.trim()) await fs.appendFile(side, `${JSON.stringify({ at: Date.now(), line, text })}\n`, { mode: 0o600, flush: true });
    await fs.truncate(this.file, state.size);
    this.rest = Buffer.alloc(0);
    this.seen = await fs.stat(this.file).catch(() => undefined);
    if (!text.trim()) return;
    await this.write(
      {
        kind: "journal",
        actor: "sshs3",
        target: "audit log",
        what: `The last line of the audit log (line ${line}) was cut off while it was written. It was kept in ${path.basename(side)}, and the log goes on from the entry before it.`,
        outcome: "cut-line-set-aside",
        detail: `line ${line}`,
      },
      Date.now(),
    );
  }

  private receiptKey(input: AuditInput): string | undefined {
    if (!input.taskId || !input.changeId || input.kind === "recording") return undefined;
    const phase = receiptPhase(input.outcome);
    return JSON.stringify([input.taskId, input.changeId, phase]);
  }

  /** Writes one entry at the end of the chain as the walk knows it, and takes it into the walk. */
  private async write(input: AuditInput, now: number, changeReceipt?: AuditEntry["changeReceipt"]): Promise<AuditEntry> {
    const state = this.state!;
    const base: Omit<AuditEntry, "hash"> = {
      seq: state.expected,
      at: now,
      prev: state.prev,
      kind: input.kind,
      actor: keep(input.actor) ?? "unknown",
      target: keep(input.target),
      what: keep(input.what) ?? "",
      outcome: keep(input.outcome),
      exitCode: input.exitCode,
      approvedBy: keep(input.approvedBy),
      taskId: input.taskId,
      changeId: input.changeId,
      detail: keep(input.detail),
      schemaVersion: input.schemaVersion ?? 1,
      changeReceipt,
      userId: keep(input.userId),
      agentId: keep(input.agentId),
      sourceIp: keep(input.sourceIp),
    };
    const entry: AuditEntry = { ...base, hash: hashEntry(base) };
    const line = Buffer.from(JSON.stringify(entry), "utf8");
    try {
      await fs.appendFile(this.file, Buffer.concat([line, Buffer.from("\n")]), { mode: 0o600, flush: true });
    } catch (error) {
      // What reached the disk is not known: the file is read again before the next write.
      this.state = undefined;
      this.loaded = false;
      throw error;
    }
    this.take(state, line);
    this.seen = await fs.stat(this.file).catch(() => undefined);
    return entry;
  }

  /**
   * Adds one entry. Entries are written one at a time, in the order they were
   * asked for, so the chain is never forked by two writes at once.
   */
  append(input: AuditInput, now = Date.now(), once = false): Promise<AuditEntry> {
    return this.serial(async () => {
      await this.load();
      const key = once && this.receiptKey(input);
      const previous = key && this.changeReceipts.get(key);
      if (previous) return previous;
      const entry = await this.write(input, now, key ? receiptPhase(input.outcome) : undefined);
      return entry;
    });
  }

  /**
   * Every entry, oldest first: the whole file. A line that is not JSON is returned as a gap the
   * verification names. A file that is there and cannot be read is an error, not an empty log.
   */
  async entries(): Promise<Array<AuditEntry | { broken: string; line: number }>> {
    const text = await fs.readFile(this.file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw new AuditUnreadable(`The audit log could not be read (${error.message}).`, { cause: error });
    });
    return text
      .split("\n")
      .filter((l) => l.trim())
      .map((line, i) => {
        try {
          return JSON.parse(line) as AuditEntry;
        } catch {
          return { broken: line.slice(0, 80), line: i + 1 };
        }
      });
  }

  /**
   * The newest entries, newest first, for a screen. Read from the end of the file: showing the last
   * two hundred entries does not read the years before them. Empty when the file cannot be read;
   * `verify` says that it could not.
   */
  async recent(limit = 200): Promise<AuditEntry[]> {
    const handle = await fs.open(this.file, "r").catch(() => undefined);
    if (!handle) return [];
    try {
      const { size } = await handle.stat();
      let want = Math.min(size, Math.max(1 << 16, limit * 1024));
      for (;;) {
        const from = size - want;
        const buffer = Buffer.alloc(want);
        const { bytesRead } = await handle.read(buffer, 0, want, from);
        let text = buffer.subarray(0, bytesRead).toString("utf8");
        // A read that began inside a line: that line is not whole, and is left to a larger read.
        if (from > 0) {
          const first = text.indexOf("\n");
          text = first < 0 ? "" : text.slice(first + 1);
        }
        const found: AuditEntry[] = [];
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line) as AuditEntry;
            if (entry && typeof entry === "object" && "seq" in entry) found.push(entry);
          } catch {
            // Not an entry: the verification names it.
          }
        }
        if (found.length >= limit || from === 0) return found.slice(-limit).reverse();
        want = Math.min(size, want * 4);
      }
    } catch {
      return [];
    } finally {
      await handle.close();
    }
  }

  /**
   * Writes where the chain stands into the team bucket, as one object of its
   * own. Called now and then; does nothing when there is no bucket or nothing
   * was added since the last anchor.
   */
  async anchor(now = Date.now()): Promise<AuditAnchor | undefined> {
    const head = await this.serial(async () => {
      await this.load();
      const state = this.state!;
      return { seq: state.entries ? state.expected - 1 : 0, hash: state.prev };
    });
    const bucket = this.bucket?.();
    if (!bucket || head.seq === 0) return undefined;
    // Where the anchors stand, read back from the bucket, so a restart continues the chain.
    if (!this.anchorRead) {
      const { files } = await this.anchorFiles({ tailOnly: true });
      const newest = files.at(-1);
      if (newest) this.lastAnchor = { n: newest.anchor.n ?? 0, bytes: newest.bytes };
      this.anchorRead = true;
    }
    // Nothing was added since the last anchor: it still vouches for the whole chain, and another one
    // would only add an object to the bucket every ten minutes for ever (about 430 a day for a team
    // of three, never pruned). Removed anchors still show, by the anchors' own chain.
    if (this.lastAnchor && anchoredSeq(this.lastAnchor.bytes) === head.seq) return undefined;
    const n = (this.lastAnchor?.n ?? 0) + 1;
    const anchor: AuditAnchor = {
      seq: head.seq,
      hash: head.hash,
      at: now,
      client: this.client,
      n,
      prev: this.lastAnchor ? sha256(this.lastAnchor.bytes) : "",
    };
    const bytes = JSON.stringify(anchor);
    // Named by the anchor's number, padded, so they list in the order they were written.
    await bucket.write(`audit/${this.client}/anchors/n${String(n).padStart(12, "0")}.json`, Buffer.from(bytes, "utf8"));
    this.lastAnchor = { n, bytes };
    return anchor;
  }

  /**
   * The anchors in the bucket as written, oldest first, paginated in chunks of
   * `pageSize` (default `ANCHORS_READ = 2000`) so verification walks beyond 2000 anchors.
   * The names are listed every time, so an anchor that was removed is missed at once. An anchor's
   * content is read once and remembered until the app closes or the log is checked in full.
   */
  private async anchorFiles(options: { pageSize?: number; maxPages?: number; tailOnly?: boolean } = {}): Promise<{
    files: { anchor: AuditAnchor; bytes: string }[];
    pagesChecked: number;
  }> {
    const bucket = this.bucket?.();
    if (!bucket) return { files: [], pagesChecked: 0 };
    const pageSize = Math.max(1, options.pageSize ?? ANCHORS_READ);
    const dir = `audit/${this.client}/anchors`;
    const names = (await bucket.list(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".json")).sort();
    const listed = new Set(names);
    for (const name of [...this.anchorCache.keys()]) if (!listed.has(name)) this.anchorCache.delete(name);
    if (!names.length) return { files: [], pagesChecked: 0 };

    const targetNames = options.tailOnly ? names.slice(-pageSize) : names;
    const out: { anchor: AuditAnchor; bytes: string }[] = [];
    let pagesChecked = 0;

    for (let offset = 0; offset < targetNames.length; offset += pageSize) {
      if (options.maxPages !== undefined && pagesChecked >= options.maxPages) break;
      const page = targetNames.slice(offset, offset + pageSize);
      pagesChecked++;
      for (const name of page) {
        const known = this.anchorCache.get(name);
        if (known) {
          out.push(known);
          continue;
        }
        try {
          const raw = await bucket.read(`${dir}/${name}`);
          if (!raw) continue;
          const file = { anchor: JSON.parse(raw.toString("utf8")) as AuditAnchor, bytes: raw.toString("utf8") };
          this.anchorCache.set(name, file);
          out.push(file);
        } catch {
          // An anchor that cannot be read proves nothing either way.
        }
      }
    }

    return {
      files: out.sort((a, b) => (a.anchor.n ?? 0) - (b.anchor.n ?? 0) || a.anchor.seq - b.anchor.seq),
      pagesChecked,
    };
  }

  /** The anchors this installation left in the bucket. */
  async anchors(): Promise<AuditAnchor[]> {
    return (await this.anchorFiles()).files.map((f) => f.anchor);
  }

  /**
   * Says whether the chain holds. Every entry must hash to what it says it hashes to, carry the
   * hash of the one before it, and follow it by one. Then every anchor (paginated beyond
   * `ANCHORS_READ`) must match the chain where it points: an anchor past the end means the end was
   * cut off; an anchor whose hash differs means what came before it was rewritten.
   *
   * The file is walked from its start the first time, when anything but this log's own writes
   * touched it since, and with `full`. Otherwise the walk stands where the last write left it.
   * A place where the chain does not hold is reported for as long as it is in the file, also once
   * the log has written it down and gone on. A file that cannot be read is reported as that.
   */
  async verify(options: { anchorPageSize?: number; maxAnchorPages?: number; full?: boolean } = {}): Promise<AuditVerification> {
    let walked: { entries: number; lastAt?: number; breaks: AuditBreak[]; more: number; last?: AuditEntry };
    try {
      walked = await this.serial(async () => {
        const rest = await this.catchUp(options.full === true);
        const state = this.state!;
        const breaks = state.breaks.map((b) => ({ ...b }));
        const text = rest.toString("utf8");
        // What follows the last line break: the next entry without its line break, or a line that was cut off.
        const last = text.trim() ? this.follows(state, text) : undefined;
        if (text.trim() && !last) breaks.push({ line: state.lines + 1, seq: state.expected, text: `Line ${state.lines + 1} is not a whole entry: the file was cut or edited there.` });
        return { entries: state.entries + (last ? 1 : 0), lastAt: last?.at ?? state.lastAt, breaks, more: state.moreBreaks, last };
      });
    } catch (error) {
      if (!(error instanceof AuditUnreadable)) throw error;
      return { ok: false, entries: 0, unreadable: true, problem: { seq: 0, text: `${error.message} Nothing can be said about it until it can be read.` } };
    }
    if (options.full) this.anchorCache.clear();
    const { entries, lastAt } = walked;
    if (walked.breaks.length) {
      const first = walked.breaks[0];
      const others = walked.breaks.length - 1 + walked.more;
      return {
        ok: false,
        entries,
        problem: {
          seq: first.seq,
          text: `${first.text}${others > 0 ? ` The log does not hold at ${others} more place${others === 1 ? "" : "s"} after that.` : ""}${first.recordedAt !== undefined ? ` The log wrote this down on ${whenRecorded(first.recordedAt)} and goes on after it.` : ""}`,
        },
        breaks: walked.breaks.slice(0, 20),
        ...(lastAt !== undefined ? { lastAt } : {}),
      };
    }
    const hashOf = (seq: number): string | undefined => (walked.last?.seq === seq ? walked.last.hash : this.table.hash(seq));
    const atOf = (seq: number): number | undefined => (walked.last?.seq === seq ? walked.last.at : this.table.at(seq));
    const { files, pagesChecked } = await this.anchorFiles({
      pageSize: options.anchorPageSize,
      maxPages: options.maxAnchorPages,
    });
    const anchors = files.map((f) => f.anchor);
    let held = 0;
    // The anchors' own chain: each numbered anchor carries the hash of the one before it.
    for (let i = 1; i < files.length; i++) {
      const { anchor } = files[i];
      const before = files[i - 1];
      if (anchor.n === undefined || before.anchor.n === undefined) continue;
      if (anchor.n !== before.anchor.n + 1 || anchor.prev !== sha256(before.bytes))
        return {
          ok: false,
          entries,
          anchors: { checked: anchors.length, held, pagesChecked },
          problem: {
            seq: anchor.seq,
            text: `Anchor ${anchor.n} in the team bucket does not follow anchor ${before.anchor.n}: anchors were removed or replaced there.`,
          },
        };
    }
    // An anchor is written only after something was added, so a long time between two anchors is
    // only a gap where entries were waiting for one: from the first entry after the earlier anchor
    // to the anchor that finally covered it.
    const gaps: { from: number; to: number }[] = [];
    for (let i = 1; i < anchors.length; i++) {
      if (anchors[i].n === undefined) continue;
      const firstAfter = atOf(anchors[i - 1].seq + 1);
      const from = Math.max(anchors[i - 1].at, firstAfter ?? anchors[i].at);
      if (anchors[i].seq > anchors[i - 1].seq && anchors[i].at - from > ANCHOR_GAP_MS) gaps.push({ from, to: anchors[i].at });
    }
    for (const anchor of anchors) {
      const at = hashOf(anchor.seq);
      if (at === undefined)
        return {
          ok: false,
          entries,
          anchors: { checked: anchors.length, held, pagesChecked },
          problem: {
            seq: anchor.seq,
            text: `The team bucket holds an anchor at entry ${anchor.seq}, but this log ends at ${entries}: entries were removed from its end.`,
          },
        };
      if (at !== anchor.hash)
        return {
          ok: false,
          entries,
          anchors: { checked: anchors.length, held, pagesChecked },
          problem: { seq: anchor.seq, text: `Entry ${anchor.seq} is not what it was when it was anchored: the log was rewritten up to there.` },
        };
      held++;
    }
    const newest = anchors.at(-1);
    return {
      ok: true,
      entries,
      anchors: { checked: anchors.length, held, coveredSeq: newest?.seq, lastAt: newest?.at, pagesChecked, gaps: gaps.slice(-20) },
      lastAt,
    };
  }

  /** Resolves once everything that was asked to be written has been written, or has failed. */
  async idle(): Promise<void> {
    await this.writes;
  }

  /** The whole log as it is on disk, with what a check of all of it found, for handing to somebody. */
  async export(): Promise<{ jsonl: string; verification: AuditVerification }> {
    await this.writes;
    return { jsonl: await fs.readFile(this.file, "utf8").catch(() => ""), verification: await this.verify({ full: true }) };
  }
}
