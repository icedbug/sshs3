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
  | "sign-in"; // a person signed in or out

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
}

export interface AuditVerification {
  ok: boolean;
  entries: number;
  /** The first place the chain does not hold, said so a person understands it. */
  problem?: { seq: number; text: string };
  /** Anchors that were checked against the chain, and how many of them held. */
  anchors?: { checked: number; held: number };
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
  private lastAnchoredSeq = 0;

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
   * new since the last anchor.
   */
  async anchor(now = Date.now()): Promise<AuditAnchor | undefined> {
    await this.writes;
    await this.load();
    const bucket = this.bucket?.();
    if (!bucket || this.head.seq === 0 || this.head.seq === this.lastAnchoredSeq) return undefined;
    const anchor: AuditAnchor = { seq: this.head.seq, hash: this.head.hash, at: now, client: this.client };
    // The seq is padded so that the objects list in the order they were written.
    await bucket.write(
      `audit/${this.client}/anchors/${String(anchor.seq).padStart(12, "0")}.json`,
      Buffer.from(JSON.stringify(anchor), "utf8"),
    );
    this.lastAnchoredSeq = anchor.seq;
    return anchor;
  }

  /** The anchors this installation left in the bucket. */
  async anchors(): Promise<AuditAnchor[]> {
    const bucket = this.bucket?.();
    if (!bucket) return [];
    const dir = `audit/${this.client}/anchors`;
    const names = (await bucket.list(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".json")).sort();
    const out: AuditAnchor[] = [];
    for (const name of names.slice(-500)) {
      try {
        const raw = await bucket.read(`${dir}/${name}`);
        if (raw) out.push(JSON.parse(raw.toString("utf8")) as AuditAnchor);
      } catch {
        // An anchor that cannot be read proves nothing either way.
      }
    }
    return out;
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
    const anchors = await this.anchors();
    let held = 0;
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
    return { ok: true, entries: bySeq.size, anchors: { checked: anchors.length, held }, lastAt };
  }

  /** The whole log as it is on disk, with what its verification found, for handing to somebody. */
  async export(): Promise<{ jsonl: string; verification: AuditVerification }> {
    await this.writes;
    return { jsonl: await fs.readFile(this.file, "utf8").catch(() => ""), verification: await this.verify() };
  }
}
