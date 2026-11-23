import fs from 'node:fs/promises';
import path from 'node:path';
import { AuditLog, type AuditEntry, type AuditInput, type AuditVerification } from '../ai/hub/AuditLog';

/**
 * The server's own journal: who signed in, who failed to, who was added or removed.
 *
 * It is written by requests from the network, also by people who are not signed in, so it must not be
 * able to grow for ever. It is kept in files of a limited size. When the current file is full it is
 * put aside under a number (1 is the newest of those put aside) and a new one is begun; the oldest is
 * removed when there are more than `keep`. Each file is a hash chain of its own (see AuditLog). The
 * first entry of a new file names the last entry of the file before it and its hash, so the files hang
 * together: change or remove the end of an older file, and the file after it says so.
 */

const CLIENT = 'server';
/** About 20 000 sign-ins in one file. */
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_KEEP = 5;

/** What the first entry of a continued file says about the file before it. */
const continuation = (last: AuditEntry): string => `after entry ${last.seq} of the file before, hash ${last.hash}`;

export interface SignInJournalOptions {
  /** A file that has reached this size is put aside before the next entry is written. */
  maxBytes?: number;
  /** How many files are kept beside the current one. */
  keep?: number;
}

export class SignInJournal {
  private readonly maxBytes: number;
  private readonly keep: number;
  private current: AuditLog;
  /** The size of the current file: read once, then counted. */
  private size?: number;
  private work: Promise<unknown> = Promise.resolve();

  constructor(private readonly dir: string, options: SignInJournalOptions = {}) {
    this.maxBytes = Math.max(1024, options.maxBytes ?? DEFAULT_MAX_BYTES);
    this.keep = Math.max(1, options.keep ?? DEFAULT_KEEP);
    this.current = new AuditLog(dir, CLIENT);
  }

  /** The file entries are written to now. */
  get file(): string {
    return this.current.file;
  }

  /** The file put aside `n` rotations ago (1 is the newest). */
  private aside(n: number): AuditLog {
    return new AuditLog(this.dir, `${CLIENT}-${n}`);
  }

  /** Adds one entry, in the order asked for. A full file is put aside first. */
  append(input: AuditInput, now = Date.now()): Promise<AuditEntry> {
    const run = async (): Promise<AuditEntry> => {
      this.size ??= await fs.stat(this.current.file).then((s) => s.size, () => 0);
      if (this.size >= this.maxBytes) await this.rotate(now);
      const entry = await this.current.append(input, now);
      this.size += Buffer.byteLength(JSON.stringify(entry)) + 1;
      return entry;
    };
    const next = this.work.then(run, run);
    this.work = next.catch(() => undefined);
    return next;
  }

  private async rotate(now: number): Promise<void> {
    const last = (await this.current.recent(1))[0];
    await fs.rm(this.aside(this.keep).file, { force: true });
    for (let n = this.keep - 1; n >= 1; n--) {
      await fs.rename(this.aside(n).file, this.aside(n + 1).file).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    await fs.rename(this.current.file, this.aside(1).file);
    this.current = new AuditLog(this.dir, CLIENT);
    this.size = 0;
    if (!last) return;
    const first = await this.current.append(
      { kind: 'setting', actor: 'server', target: 'server', what: 'continued the journal in a new file', detail: continuation(last) },
      now,
    );
    this.size = Buffer.byteLength(JSON.stringify(first)) + 1;
  }

  /** The newest entries of the current file, newest first. */
  async recent(limit = 200): Promise<AuditEntry[]> {
    await this.work;
    return this.current.recent(limit);
  }

  /** The journal's files that exist, oldest first, the current one last. */
  async files(): Promise<string[]> {
    await this.work;
    const all: string[] = [];
    for (let n = this.keep; n >= 1; n--) all.push(this.aside(n).file);
    all.push(this.current.file);
    const found: string[] = [];
    for (const file of all) if (await fs.stat(file).then(() => true, () => false)) found.push(file);
    return found;
  }

  /**
   * Whether the journal holds: every file's own chain, and every file's first entry naming the end of
   * the file before it. `entries` counts all files. The oldest file kept has nothing before it to check.
   */
  async verify(): Promise<AuditVerification> {
    await this.work;
    let entries = 0;
    let before: AuditEntry | undefined;
    let lastAt: number | undefined;
    for (const file of await this.files()) {
      const name = path.basename(file);
      const log = new AuditLog(this.dir, name.slice('audit-'.length, -'.jsonl'.length));
      const own = await log.verify();
      entries += own.entries;
      if (!own.ok) return { ok: false, entries, problem: own.problem ? { seq: own.problem.seq, text: `${name}: ${own.problem.text}` } : undefined };
      const all = (await log.entries()).filter((e): e is AuditEntry => 'seq' in e);
      const first = all[0];
      if (before && (!first || first.detail !== continuation(before)))
        return { ok: false, entries, problem: { seq: 1, text: `${name} does not continue the file before it: the end of that file was changed or removed.` } };
      before = all.at(-1) ?? before;
      lastAt = own.lastAt ?? lastAt;
    }
    return { ok: true, entries, ...(lastAt !== undefined ? { lastAt } : {}) };
  }
}
