import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { QueueStore } from "./LearningQueue";
import { guardUrl, post, standardWebhookHeaders, type GuardOptions } from "./Notifier";
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
  /** Structured event schema version for downstream log consumers. */
  schemaVersion?: number;
  changeReceipt?: "intent" | "rollback-intent" | "final";
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

export type AuditShipperFormat = "otlp" | "cef" | "syslog" | "webhook";

export type AuditSubscriber = (entry: AuditEntry) => void | Promise<void>;

export interface AuditShipperOptions {
  format: AuditShipperFormat;
  url?: string;
  secret?: string;
  headers?: Record<string, string>;
  serviceName?: string;
  appName?: string;
  hostname?: string;
  facility?: number;
  guard?: GuardOptions;
  maxQueueSize?: number;
  send?: (payload: { format: AuditShipperFormat; body: string; contentType: string; entry: AuditEntry }) => Promise<void> | void;
  onError?: (error: unknown, entry: AuditEntry) => void;
}

const cefEscapeHeader = (value: string): string => value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
const cefEscapeExt = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/=/g, "\\=").replace(/\r/g, "\\r").replace(/\n/g, "\\n");

/** Formats an audit entry as OpenTelemetry Logs OTLP/JSON (`ExportLogsServiceRequest`). */
export function formatAuditOtlpJson(entry: AuditEntry, serviceName = "sshs3"): Record<string, unknown> {
  const attrs: Array<{ key: string; value: { stringValue?: string; intValue?: string } }> = [
    { key: "audit.seq", value: { intValue: String(entry.seq) } },
    { key: "audit.kind", value: { stringValue: entry.kind } },
    { key: "audit.actor", value: { stringValue: entry.actor } },
    { key: "audit.hash", value: { stringValue: entry.hash } },
    { key: "audit.schema_version", value: { intValue: String(entry.schemaVersion ?? 1) } },
  ];
  if (entry.target) attrs.push({ key: "audit.target", value: { stringValue: entry.target } });
  if (entry.outcome) attrs.push({ key: "audit.outcome", value: { stringValue: entry.outcome } });
  if (entry.exitCode !== undefined) attrs.push({ key: "audit.exit_code", value: { intValue: String(entry.exitCode) } });
  if (entry.approvedBy) attrs.push({ key: "audit.approved_by", value: { stringValue: entry.approvedBy } });
  if (entry.userId) attrs.push({ key: "enduser.id", value: { stringValue: entry.userId } });
  if (entry.agentId) attrs.push({ key: "agent.id", value: { stringValue: entry.agentId } });
  if (entry.sourceIp) attrs.push({ key: "client.address", value: { stringValue: entry.sourceIp } });
  if (entry.taskId) attrs.push({ key: "audit.task_id", value: { stringValue: entry.taskId } });
  if (entry.changeId) attrs.push({ key: "audit.change_id", value: { stringValue: entry.changeId } });

  return {
    resourceLogs: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: serviceName } }],
        },
        scopeLogs: [
          {
            scope: { name: "sshs3.audit", version: String(entry.schemaVersion ?? 1) },
            logRecords: [
              {
                timeUnixNano: String(BigInt(entry.at) * 1_000_000n),
                severityNumber: entry.outcome === "failed" || entry.outcome === "denied" ? 13 : 9,
                severityText: entry.outcome === "failed" || entry.outcome === "denied" ? "WARN" : "INFO",
                body: { stringValue: entry.what },
                attributes: attrs,
              },
            ],
          },
        ],
      },
    ],
  };
}

/** Formats an audit entry as RFC 5424 Syslog carrying a CEF payload. */
export function formatAuditRfc5424Cef(
  entry: AuditEntry,
  options: { hostname?: string; appName?: string; facility?: number } = {},
): string {
  const facility = options.facility ?? 13; // log audit
  const syslogSeverity = entry.outcome === "failed" || entry.outcome === "denied" ? 4 : 6;
  const pri = facility * 8 + syslogSeverity;
  const timestamp = new Date(entry.at).toISOString();
  const hostname = (options.hostname ?? os.hostname() ?? "localhost").replace(/\s+/g, "-") || "-";
  const appName = (options.appName ?? "sshs3").replace(/\s+/g, "-") || "sshs3";
  const cefSeverity = entry.outcome === "failed" || entry.outcome === "denied" ? 7 : 3;
  const ext: string[] = [
    `rt=${entry.at}`,
    `seq=${entry.seq}`,
    `act=${cefEscapeExt(entry.actor)}`,
    `schemaVersion=${entry.schemaVersion ?? 1}`,
    `hash=${entry.hash}`,
  ];
  if (entry.target) ext.push(`dst=${cefEscapeExt(entry.target)}`);
  if (entry.outcome) ext.push(`outcome=${cefEscapeExt(entry.outcome)}`);
  if (entry.userId) ext.push(`suser=${cefEscapeExt(entry.userId)}`);
  if (entry.agentId) ext.push(`cs1=${cefEscapeExt(entry.agentId)} cs1Label=agentId`);
  if (entry.sourceIp) ext.push(`src=${cefEscapeExt(entry.sourceIp)}`);
  if (entry.approvedBy) ext.push(`cs2=${cefEscapeExt(entry.approvedBy)} cs2Label=approvedBy`);
  const cef = `CEF:0|Sshs3|AuditLog|${entry.schemaVersion ?? 1}|${cefEscapeHeader(entry.kind)}|${cefEscapeHeader(entry.what || entry.kind)}|${cefSeverity}|${ext.join(" ")}`;
  return `<${pri}>1 ${timestamp} ${hostname} ${appName} - ${entry.kind} - ${cef}`;
}

/** Formats an audit entry as a structured JSON webhook payload. */
export function formatAuditWebhookPayload(entry: AuditEntry): Record<string, unknown> {
  return {
    version: entry.schemaVersion ?? 1,
    event: "audit",
    at: entry.at,
    entry,
  };
}

/**
 * Non-blocking out-of-band subscriber for `AuditLog.append` supporting
 * OTLP/JSON, RFC 5424 CEF/Syslog, or webhook delivery.
 */
export class AuditShipper {
  private chain: Promise<void> = Promise.resolve();
  private queued = 0;

  constructor(private readonly options: AuditShipperOptions) {}

  emit(entry: AuditEntry): void {
    const maxQueue = this.options.maxQueueSize ?? 1000;
    if (this.queued >= maxQueue) {
      this.options.onError?.(new Error("AuditShipper queue full; dropping entry"), entry);
      return;
    }
    this.queued++;
    this.chain = this.chain
      .then(() => this.deliverEntry(entry))
      .catch((error) => {
        this.options.onError?.(error, entry);
      })
      .finally(() => {
        this.queued = Math.max(0, this.queued - 1);
      });
  }

  async flush(): Promise<void> {
    await this.chain;
  }

  private format(entry: AuditEntry): { body: string; contentType: string } {
    if (this.options.format === "otlp") {
      return {
        body: JSON.stringify(formatAuditOtlpJson(entry, this.options.serviceName)),
        contentType: "application/json",
      };
    }
    if (this.options.format === "cef" || this.options.format === "syslog") {
      return {
        body: formatAuditRfc5424Cef(entry, {
          hostname: this.options.hostname,
          appName: this.options.appName,
          facility: this.options.facility,
        }),
        contentType: "text/plain; charset=utf-8",
      };
    }
    return {
      body: JSON.stringify(formatAuditWebhookPayload(entry)),
      contentType: "application/json",
    };
  }

  private async deliverEntry(entry: AuditEntry): Promise<void> {
    const { body, contentType } = this.format(entry);
    if (this.options.send) {
      await this.options.send({ format: this.options.format, body, contentType, entry });
      return;
    }
    if (!this.options.url) return;
    // Without a guard from the caller, the strict one: not this machine, not its private network.
    // The hub passes its own outbound guard, which on the desktop allows the person's internal collector.
    const guard = this.options.guard ?? { server: true, allowPrivate: false, allowPlainHttp: true };
    const target = await guardUrl(this.options.url, guard);
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      ...(this.options.headers ?? {}),
      ...(this.options.secret
        ? {
            "X-Sshs3-Signature": `sha256=${crypto.createHmac("sha256", this.options.secret).update(body).digest("hex")}`,
            ...standardWebhookHeaders(this.options.secret, body),
          }
        : {}),
    };
    const status = await post(target, { url: this.options.url, headers, body });
    if (status < 200 || status >= 300) {
      throw new Error(`AuditShipper received HTTP ${status}`);
    }
  }
}

export class AuditLog {
  readonly file: string;
  private head: { seq: number; hash: string } = { seq: 0, hash: "" };
  private loaded = false;
  private changeReceipts = new Map<string, AuditEntry>();
  private writes: Promise<unknown> = Promise.resolve();
  /** The newest anchor this installation wrote, read back from the bucket once. */
  private lastAnchor?: { n: number; bytes: string };
  private anchorRead = false;
  private readonly subscribers = new Set<AuditSubscriber>();

  constructor(
    private readonly dir: string,
    private readonly client: string,
    /** The team bucket, when there is one: where the anchors go. */
    private readonly bucket?: () => QueueStore | undefined,
  ) {
    this.file = path.join(dir, `audit-${client.replace(/[^A-Za-z0-9_-]/g, "_")}.jsonl`);
  }

  /** Registers a non-blocking out-of-band subscriber notified on every appended entry. */
  subscribe(listener: AuditSubscriber | AuditShipper): () => void {
    const fn: AuditSubscriber = listener instanceof AuditShipper ? (e) => listener.emit(e) : listener;
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  /** Reads where the chain stands. A file that does not exist yet is an empty chain. */
  private async load(): Promise<void> {
    if (this.loaded) return;
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const text = await fs.readFile(this.file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const lines = text.split("\n").filter((line) => line.trim());
    const receipts = new Map<string, AuditEntry>();
    let head = { seq: 0, hash: "" };
    for (const line of lines) {
      let entry: AuditEntry;
      try {
        entry = JSON.parse(line) as AuditEntry;
      } catch {
        throw new Error(`Audit entry ${head.seq + 1} is incomplete. Check the journal before making a change.`);
      }
      if (!entry || entry.seq !== head.seq + 1 || entry.prev !== head.hash || hashEntry(entry) !== entry.hash) {
        throw new Error(`Audit entry ${head.seq + 1} did not verify. Check the journal before making a change.`);
      }
      const key = entry.changeReceipt && this.receiptKey(entry);
      if (key) receipts.set(key, entry);
      head = { seq: entry.seq, hash: entry.hash };
    }
    if (text && !text.endsWith("\n")) throw new Error("Audit journal ends with an incomplete line.");
    this.head = head;
    this.changeReceipts = receipts;
    this.loaded = true;
  }

  /**
   * Adds one entry. Entries are written one at a time, in the order they were
   * asked for, so the chain is never forked by two writes at once.
   */
  private receiptKey(input: AuditInput): string | undefined {
    if (!input.taskId || !input.changeId || input.kind === "recording") return undefined;
    const phase = input.outcome === "intent" || input.outcome === "rollback-intent" ? input.outcome : "final";
    return JSON.stringify([input.taskId, input.changeId, phase]);
  }

  append(input: AuditInput, now = Date.now(), once = false): Promise<AuditEntry> {
    const run = async (): Promise<AuditEntry> => {
      await this.load();
      const key = once && this.receiptKey(input);
      const previous = key && this.changeReceipts.get(key);
      if (previous) return previous;
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
        schemaVersion: input.schemaVersion ?? 1,
        changeReceipt: key ? input.outcome === "intent" || input.outcome === "rollback-intent" ? input.outcome : "final" : undefined,
        userId: keep(input.userId),
        agentId: keep(input.agentId),
        sourceIp: keep(input.sourceIp),
      };
      const entry: AuditEntry = { ...base, hash: hashEntry(base) };
      try {
        await fs.appendFile(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600, flush: true });
      } catch (error) {
        this.loaded = false;
        throw error;
      }
      if (key) this.changeReceipts.set(key, entry);
      this.head = { seq: entry.seq, hash: entry.hash };
      if (this.subscribers.size > 0) {
        for (const listener of this.subscribers) {
          queueMicrotask(() => {
            Promise.resolve()
              .then(() => listener(entry))
              .catch(() => undefined);
          });
        }
      }
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
      const { files } = await this.anchorFiles({ tailOnly: true });
      const newest = files.at(-1);
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

  /**
   * The anchors in the bucket as written, oldest first, paginated in chunks of
   * `pageSize` (default `ANCHORS_READ = 2000`) so verification walks beyond 2000 anchors.
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
    if (!names.length) return { files: [], pagesChecked: 0 };

    const targetNames = options.tailOnly ? names.slice(-pageSize) : names;
    const out: { anchor: AuditAnchor; bytes: string }[] = [];
    let pagesChecked = 0;

    for (let offset = 0; offset < targetNames.length; offset += pageSize) {
      if (options.maxPages !== undefined && pagesChecked >= options.maxPages) break;
      const page = targetNames.slice(offset, offset + pageSize);
      pagesChecked++;
      for (const name of page) {
        try {
          const raw = await bucket.read(`${dir}/${name}`);
          if (raw) out.push({ anchor: JSON.parse(raw.toString("utf8")) as AuditAnchor, bytes: raw.toString("utf8") });
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
   * Walks the whole chain and says whether it holds. Every entry must hash
   * to what it says it hashes to, carry the hash of the one before it, and
   * follow it by one. Then every anchor (paginated beyond `ANCHORS_READ`) must
   * match the chain where it points: an anchor past the end means the end was
   * cut off; an anchor whose hash differs means what came before it was rewritten.
   */
  async verify(options: { anchorPageSize?: number; maxAnchorPages?: number } = {}): Promise<AuditVerification> {
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
      if (anchor.n !== before.anchor.n + 1 || anchor.prev !== crypto.createHash("sha256").update(before.bytes).digest("hex"))
        return {
          ok: false,
          entries: bySeq.size,
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
          anchors: { checked: anchors.length, held, pagesChecked },
          problem: {
            seq: anchor.seq,
            text: `The team bucket holds an anchor at entry ${anchor.seq}, but this log ends at ${bySeq.size}: entries were removed from its end.`,
          },
        };
      if (at !== anchor.hash)
        return {
          ok: false,
          entries: bySeq.size,
          anchors: { checked: anchors.length, held, pagesChecked },
          problem: { seq: anchor.seq, text: `Entry ${anchor.seq} is not what it was when it was anchored: the log was rewritten up to there.` },
        };
      held++;
    }
    const newest = anchors.at(-1);
    return {
      ok: true,
      entries: bySeq.size,
      anchors: { checked: anchors.length, held, coveredSeq: newest?.seq, lastAt: newest?.at, pagesChecked, gaps: gaps.slice(-20) },
      lastAt,
    };
  }

  /** The whole log as it is on disk, with what its verification found, for handing to somebody. */
  async export(): Promise<{ jsonl: string; verification: AuditVerification }> {
    await this.writes;
    return { jsonl: await fs.readFile(this.file, "utf8").catch(() => ""), verification: await this.verify() };
  }
}
