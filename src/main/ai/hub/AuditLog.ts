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
  | "recording"; // a terminal recording was finished: its hash, so it can be shown not to have been changed

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
/** How many of the newest anchors a verification reads. */
const ANCHORS_READ = 2000;

export interface AuditVerification {
  ok: boolean;
  entries: number;
  /** The first place the chain does not hold, said so a person understands it. */
  problem?: { seq: number; text: string };
  /**
   * Anchors that were checked against the chain, and how many of them held.
   * `coveredSeq`/`lastAt`: the newest entry an anchor vouches for, and when;
   * entries after it are only chained. `gaps`: stretches in which entries
   * waited for an anchor, when the installation was off or anchors were
   * removed. A quiet stretch with nothing to anchor is not a gap.
   */
  anchors?: { checked: number; held: number; coveredSeq?: number; lastAt?: number; gaps?: { from: number; to: number }[] };
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

export class AuditLog {
  readonly file: string;
  private head: { seq: number; hash: string } = { seq: 0, hash: "" };
  private loaded = false;
  private writes: Promise<unknown> = Promise.resolve();
  /** The newest anchor this installation wrote, read back from the bucket once. */
  private lastAnchor?: { n: number; bytes: string };
  private anchorRead = false;

  constructor(
    private readonly dir: string,
    private readonly client: string,
    /** The team bucket, when there is one: where the anchors go. */
    private readonly bucket?: () => QueueStore | undefined,
  ) {
    this.file = path.join(dir, `audit-${client.replace(/[^A-Za-z0-9_-]/g, "_")}.jsonl`);
  }

  /** Reads where the chain stands. A file that does not exist yet is an empty chain. */
  private async load(): Promise<void> {
    if (this.loaded) return;
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const text = await fs.readFile(this.file, "utf8").catch(() => "");
    const lines = text.split("\n").filter((l) => l.trim());
    const last = lines.at(-1);
    if (last) {
      try {
        const entry = JSON.parse(last) as AuditEntry;
        this.head = { seq: entry.seq, hash: entry.hash };
      } catch {
        // A last line that is not JSON — a write that was cut off by a crash. The chain
        // continues from the last line that is whole; verify() will say where it broke.
        for (let i = lines.length - 2; i >= 0; i--) {
          try {
            const entry = JSON.parse(lines[i]) as AuditEntry;
            this.head = { seq: entry.seq, hash: entry.hash };
            break;
          } catch {
            // keep looking
          }
        }
      }
    }
    this.loaded = true;
  }

  /**
   * Adds one entry. Entries are written one at a time, in the order they were
   * asked for, so the chain is never forked by two writes at once.
   */
  append(input: AuditInput, now = Date.now()): Promise<AuditEntry> {
    const run = async (): Promise<AuditEntry> => {
      await this.load();
      const base: Omit<AuditEntry, "hash"> = {
        seq: this.head.seq + 1,
        at: now,
        prev: this.head.hash,
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
      };
      const entry: AuditEntry = { ...base, hash: hashEntry(base) };
      await fs.appendFile(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      this.head = { seq: entry.seq, hash: entry.hash };
      return entry;
    };
    const next = this.writes.then(run, run);
    this.writes = next.catch(() => undefined);
    return next;
  }

  /** Every entry, oldest first. A line that is not JSON is returned as a gap the verification names. */
  async entries(): Promise<Array<AuditEntry | { broken: string; line: number }>> {
    const text = await fs.readFile(this.file, "utf8").catch(() => "");
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

  /** The newest entries, newest first, for a screen. */
  async recent(limit = 200): Promise<AuditEntry[]> {
    const all = await this.entries();
    return all.filter((e): e is AuditEntry => "seq" in e).slice(-limit).reverse();
  }

  /**
   * Writes where the chain stands into the team bucket, as one object of its
   * own. Called now and then; does nothing when there is no bucket or nothing
   * was added since the last anchor.
   */
  async anchor(now = Date.now()): Promise<AuditAnchor | undefined> {
    await this.writes;
    await this.load();
    const bucket = this.bucket?.();
    if (!bucket || this.head.seq === 0) return undefined;
    // Where the anchors stand, read back from the bucket, so a restart continues the chain.
    if (!this.anchorRead) {
      const newest = (await this.anchorFiles()).at(-1);
      if (newest) this.lastAnchor = { n: newest.anchor.n ?? 0, bytes: newest.bytes };
      this.anchorRead = true;
    }
    // Nothing was added since the last anchor: it still vouches for the whole chain, and another one
    // would only add an object to the bucket every ten minutes for ever (about 430 a day for a team
    // of three, never pruned). Removed anchors still show, by the anchors' own chain.
    if (this.lastAnchor && anchoredSeq(this.lastAnchor.bytes) === this.head.seq) return undefined;
    const n = (this.lastAnchor?.n ?? 0) + 1;
    const anchor: AuditAnchor = {
      seq: this.head.seq,
      hash: this.head.hash,
      at: now,
      client: this.client,
      n,
      prev: this.lastAnchor ? crypto.createHash("sha256").update(this.lastAnchor.bytes).digest("hex") : "",
    };
    const bytes = JSON.stringify(anchor);
    // Named by the anchor's number, padded, so they list in the order they were written.
    await bucket.write(`audit/${this.client}/anchors/n${String(n).padStart(12, "0")}.json`, Buffer.from(bytes, "utf8"));
    this.lastAnchor = { n, bytes };
    return anchor;
  }

  /** The anchors in the bucket as written, oldest first: numbered ones by number, older ones before them. */
  private async anchorFiles(): Promise<{ anchor: AuditAnchor; bytes: string }[]> {
    const bucket = this.bucket?.();
    if (!bucket) return [];
    const dir = `audit/${this.client}/anchors`;
    const names = (await bucket.list(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".json")).sort();
    const out: { anchor: AuditAnchor; bytes: string }[] = [];
    for (const name of names.slice(-ANCHORS_READ)) {
      try {
        const raw = await bucket.read(`${dir}/${name}`);
        if (raw) out.push({ anchor: JSON.parse(raw.toString("utf8")) as AuditAnchor, bytes: raw.toString("utf8") });
      } catch {
        // An anchor that cannot be read proves nothing either way.
      }
    }
    return out.sort((a, b) => (a.anchor.n ?? 0) - (b.anchor.n ?? 0) || a.anchor.seq - b.anchor.seq);
  }

  /** The anchors this installation left in the bucket. */
  async anchors(): Promise<AuditAnchor[]> {
    return (await this.anchorFiles()).map((f) => f.anchor);
  }

  /**
   * Walks the whole chain and says whether it holds. Every entry must hash
   * to what it says it hashes to, carry the hash of the one before it, and
   * follow it by one. Then every anchor must match the chain where it points:
   * an anchor past the end means the end was cut off; an anchor whose hash
   * differs means what came before it was rewritten.
   */
  async verify(): Promise<AuditVerification> {
    await this.writes;
    const all = await this.entries();
    let prev = "";
    let expected = 1;
    const bySeq = new Map<number, string>();
    let lastAt: number | undefined;
    for (const item of all) {
      if ("broken" in item)
        return { ok: false, entries: bySeq.size, problem: { seq: expected, text: `Line ${item.line} is not a whole entry: the file was cut or edited there.` } };
      // A public digest compared with the one it should be, not a secret: no timing to hide.
      const { hash: stated, ...rest } = item;
      if (item.seq !== expected)
        return {
          ok: false,
          entries: bySeq.size,
          problem: {
            seq: expected,
            text: item.seq > expected ? `Entries ${expected} to ${item.seq - 1} are missing.` : `Entry ${item.seq} appears again where ${expected} should be.`,
          },
        };
      if (item.prev !== prev)
        return { ok: false, entries: bySeq.size, problem: { seq: item.seq, text: `Entry ${item.seq} does not follow the one before it: something before it was changed.` } };
      const recomputed = hashEntry(rest);
      if (recomputed !== stated)
        return { ok: false, entries: bySeq.size, problem: { seq: item.seq, text: `Entry ${item.seq} was changed after it was written.` } };
      bySeq.set(item.seq, stated);
      prev = stated;
      expected++;
      lastAt = item.at;
    }
    const files = await this.anchorFiles();
    const anchors = files.map((f) => f.anchor);
    let held = 0;
    // The anchors' own chain: each numbered anchor carries the hash of the one before it.
    for (let i = 1; i < files.length; i++) {
      const { anchor } = files[i];
      const before = files[i - 1];
      if (anchor.n === undefined || before.anchor.n === undefined) continue;
      if (anchor.n !== before.anchor.n + 1 || anchor.prev !== crypto.createHash("sha256").update(before.bytes).digest("hex"))
        return {
          ok: false,
          entries: bySeq.size,
          anchors: { checked: anchors.length, held },
          problem: {
            seq: anchor.seq,
            text: `Anchor ${anchor.n} in the team bucket does not follow anchor ${before.anchor.n}: anchors were removed or replaced there.`,
          },
        };
    }
    // An anchor is written only after something was added, so a long time between two anchors is
    // only a gap where entries were waiting for one: from the first entry after the earlier anchor
    // to the anchor that finally covered it.
    const atOf = new Map<number, number>();
    for (const item of all) if (!("broken" in item)) atOf.set(item.seq, item.at);
    const gaps: { from: number; to: number }[] = [];
    for (let i = 1; i < anchors.length; i++) {
      if (anchors[i].n === undefined) continue;
      const firstAfter = atOf.get(anchors[i - 1].seq + 1);
      const from = Math.max(anchors[i - 1].at, firstAfter ?? anchors[i].at);
      if (anchors[i].seq > anchors[i - 1].seq && anchors[i].at - from > ANCHOR_GAP_MS) gaps.push({ from, to: anchors[i].at });
    }
    for (const anchor of anchors) {
      const at = bySeq.get(anchor.seq);
      if (at === undefined)
        return {
          ok: false,
          entries: bySeq.size,
          anchors: { checked: anchors.length, held },
          problem: {
            seq: anchor.seq,
            text: `The team bucket holds an anchor at entry ${anchor.seq}, but this log ends at ${bySeq.size}: entries were removed from its end.`,
          },
        };
      if (at !== anchor.hash)
        return {
          ok: false,
          entries: bySeq.size,
          anchors: { checked: anchors.length, held },
          problem: { seq: anchor.seq, text: `Entry ${anchor.seq} is not what it was when it was anchored: the log was rewritten up to there.` },
        };
      held++;
    }
    const newest = anchors.at(-1);
    return {
      ok: true,
      entries: bySeq.size,
      anchors: { checked: anchors.length, held, coveredSeq: newest?.seq, lastAt: newest?.at, gaps: gaps.slice(-20) },
      lastAt,
    };
  }

  /** The whole log as it is on disk, with what its verification found, for handing to somebody. */
  async export(): Promise<{ jsonl: string; verification: AuditVerification }> {
    await this.writes;
    return { jsonl: await fs.readFile(this.file, "utf8").catch(() => ""), verification: await this.verify() };
  }
}
