import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AuditLog, type AuditEntry } from "../../src/main/ai/hub/AuditLog";
import type { QueueStore } from "../../src/main/ai/hub/LearningQueue";

/**
 * One broken line in the audit log used to stop every change: an entry is written before each change,
 * and the log refused to write when its chain did not verify. Now a line cut off by a crash is set
 * aside, a broken line in the middle is written down and reported, and neither stops what comes after.
 * The log is not read whole each time it is shown, and a log that cannot be read says so.
 */

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function makeLog(bucket?: QueueStore): Promise<AuditLog> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-audit-breaks-"));
  dirs.push(dir);
  return new AuditLog(dir, "client-1", bucket ? () => bucket : undefined);
}
const reopen = (log: AuditLog, bucket?: QueueStore): AuditLog => new AuditLog(path.dirname(log.file), "client-1", bucket ? () => bucket : undefined);

const command = (what: string) => ({ kind: "command" as const, actor: "Watch (Jacob's run)", target: "db01", what, outcome: "completed", exitCode: 0 });
const intent = (changeId: string) => ({ kind: "change" as const, actor: "Watch", target: "db01", what: "systemctl restart nginx", outcome: "intent", taskId: "t1", changeId });
/** The entries in the file, in order. A line that is no entry is left out. */
const lines = async (log: AuditLog): Promise<AuditEntry[]> =>
  (await fs.readFile(log.file, "utf8"))
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as AuditEntry];
      } catch {
        return [];
      }
    });

describe("a last line that a crash cut off", () => {
  it("is kept in a file beside the log, and the chain goes on from the last whole entry with an entry that says so", async () => {
    const log = await makeLog();
    for (const c of ["a", "b", "c"]) await log.append(command(c));
    const cut = '{"seq":4,"at":1,"prev":"';
    await fs.appendFile(log.file, cut);

    const afterCrash = reopen(log);
    // What is written before a change: it goes through.
    const next = await afterCrash.append(intent("c1"), Date.now(), true);
    expect(next.seq).toBe(5);

    const entries = await lines(afterCrash);
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(entries[3]).toMatchObject({ kind: "journal", outcome: "cut-line-set-aside", detail: "line 4" });
    expect(entries[3].what).toMatch(/last line of the audit log \(line 4\) was cut off while it was written/);
    expect(entries[3].what).toContain("audit-client-1.jsonl.torn");
    expect(await fs.readFile(log.file, "utf8")).not.toContain(cut);
    const kept = (await fs.readFile(`${log.file}.torn`, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { line: number; text: string });
    expect(kept).toEqual([expect.objectContaining({ line: 4, text: cut })]);
    // Nothing that was whole is gone, so the chain holds.
    expect(await afterCrash.verify()).toMatchObject({ ok: true, entries: 5 });
    // Once is enough: the next start finds nothing to set aside.
    const later = reopen(log);
    expect((await later.append(command("d"))).seq).toBe(6);
    expect((await lines(later)).filter((e) => e.kind === "journal")).toHaveLength(1);
  });

  it("only gets its line break back when the entry itself is whole", async () => {
    const log = await makeLog();
    for (const c of ["a", "b"]) await log.append(command(c));
    const whole = await fs.readFile(log.file, "utf8");
    await fs.writeFile(log.file, whole.replace(/\n$/, ""));
    const afterCrash = reopen(log);
    expect(await afterCrash.verify()).toMatchObject({ ok: true, entries: 2 });
    expect((await afterCrash.append(command("c"))).seq).toBe(3);
    expect((await lines(afterCrash)).map((e) => e.kind)).toEqual(["command", "command", "command"]);
    expect(await afterCrash.verify()).toMatchObject({ ok: true, entries: 3 });
    await expect(fs.stat(`${log.file}.torn`)).rejects.toThrow();
  });
});

describe("a broken line in the middle", () => {
  async function edited(): Promise<AuditLog> {
    const log = await makeLog();
    for (const c of ["ls", "rm -rf /tmp/x", "uptime"]) await log.append(command(c));
    const text = await fs.readFile(log.file, "utf8");
    // Somebody makes the second command look harmless.
    await fs.writeFile(log.file, text.replace("rm -rf /tmp/x", "echo hello"));
    return reopen(log);
  }

  it("does not stop what is written before a change, and is written down once with where it is", async () => {
    const log = await edited();
    const next = await log.append(intent("c1"), Date.now(), true);
    const entries = await lines(log);
    // Entry 4 is the log's own word about the break; the change's entry follows it.
    expect(entries[3]).toMatchObject({ seq: 4, kind: "journal", outcome: "break-recorded", detail: "line 2" });
    expect(entries[3].what).toMatch(/does not hold at line 2: Entry 2 was changed after it was written\./);
    expect(entries[3].what).toMatch(/What stands before this entry cannot be relied on\. The log goes on from here\./);
    expect(next).toMatchObject({ seq: 5, prev: entries[3].hash });

    // More is written, the app starts again: still one marker.
    await log.append(command("df -h"));
    const restarted = reopen(log);
    await restarted.append(command("free -m"));
    expect((await lines(restarted)).filter((e) => e.kind === "journal")).toHaveLength(1);
  });

  it("is reported by the check for as long as it is in the file, with the line and when the log wrote it down", async () => {
    const log = await edited();
    // Before anything was written after it.
    expect(await log.verify()).toMatchObject({ ok: false, problem: { seq: 2, text: "Entry 2 was changed after it was written." }, breaks: [{ line: 2, seq: 2 }] });
    await log.append(command("df -h"), 1_700_000_000_000);
    const checked = await reopen(log).verify();
    expect(checked.ok).toBe(false);
    expect(checked.entries).toBe(5);
    expect(checked.problem).toMatchObject({ seq: 2 });
    expect(checked.problem!.text).toMatch(/^Entry 2 was changed after it was written\. The log wrote this down on \d{4}-\d\d-\d\d \d\d:\d\d UTC and goes on after it\.$/);
    expect(checked.breaks).toEqual([{ line: 2, seq: 2, text: "Entry 2 was changed after it was written.", recordedAt: expect.any(Number) }]);
  });

  it("goes on after a line that is no entry at all, and after one that was taken out", async () => {
    const log = await makeLog();
    for (const c of ["a", "b", "c", "d"]) await log.append(command(c));
    const [one, two, three, four] = (await fs.readFile(log.file, "utf8")).trim().split("\n");
    // Line 2 is replaced by something that is no entry, and line 3 is gone.
    await fs.writeFile(log.file, `${[one, "not an entry {", four].join("\n")}\n`);
    expect(two).not.toBe(three);
    const broken = reopen(log);
    const next = await broken.append(command("e"));
    const entries = await lines(broken);
    const marker = entries.find((e) => e.kind === "journal")!;
    expect(marker.what).toMatch(/does not hold at line 2: Line 2 is not a whole entry: the file was cut or edited there\./);
    // The new entries follow the last entry that is in the file.
    expect(marker.seq).toBe(5);
    expect(next.seq).toBe(6);
    const checked = await broken.verify();
    expect(checked).toMatchObject({ ok: false, problem: { seq: 2 }, breaks: [{ line: 2 }] });
    expect(checked.entries).toBe(4);
  });

  it("writes one marker for many broken places, and says how many there are", async () => {
    const log = await makeLog();
    for (let i = 0; i < 6; i++) await log.append(command(`cmd ${i}`));
    const all = (await fs.readFile(log.file, "utf8")).trim().split("\n");
    await fs.writeFile(log.file, `${[all[0], "x", all[2], "y", all[4], "z"].join("\n")}\n`);
    const broken = reopen(log);
    await broken.append(command("after"));
    const text = await fs.readFile(broken.file, "utf8");
    expect(text.match(/"kind":"journal"/g)).toHaveLength(1);
    expect(text).toMatch(/does not hold at line 2: .* It does not hold at 2 more places after that\./);
    const checked = await broken.verify();
    expect(checked.breaks!.map((b) => b.line)).toEqual([2, 4, 6]);
    expect(checked.problem!.text).toMatch(/The log does not hold at 2 more places after that\./);
  });
});

describe("a log that cannot be read", () => {
  it("is reported as that, not as a chain of no entries that holds", async () => {
    const log = await makeLog();
    await log.append(command("a"));
    const denied = Object.assign(new Error("EACCES: permission denied, stat"), { code: "EACCES" });
    vi.spyOn(fs, "stat").mockRejectedValue(denied);
    vi.spyOn(fs, "open").mockRejectedValue(denied);
    vi.spyOn(fs, "readFile").mockRejectedValue(denied);
    const fresh = reopen(log);
    const checked = await fresh.verify();
    expect(checked).toMatchObject({ ok: false, entries: 0, unreadable: true });
    expect(checked.problem!.text).toMatch(/The audit log could not be read \(EACCES: permission denied, stat\)\. Nothing can be said about it until it can be read\./);
    expect(await fresh.recent(10)).toEqual([]);
    expect((await fresh.export()).verification).toMatchObject({ ok: false, unreadable: true });
    // Nothing is written to a log whose end is not known.
    await expect(fresh.append(command("b"))).rejects.toThrow(/could not be read/);
  });

  it("an empty log is still an empty log", async () => {
    const log = await makeLog();
    expect(await log.verify()).toMatchObject({ ok: true, entries: 0 });
    expect(await log.recent()).toEqual([]);
  });
});

describe("showing and checking the log without reading all of it each time", () => {
  /** How many bytes are read through file handles while `run` runs. */
  async function bytesRead(run: () => Promise<unknown>): Promise<{ bytes: number; opened: number }> {
    const open = fs.open.bind(fs);
    let bytes = 0;
    let opened = 0;
    const spy = vi.spyOn(fs, "open").mockImplementation((async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      opened++;
      const read = handle.read.bind(handle) as (...a: unknown[]) => Promise<{ bytesRead: number }>;
      (handle as unknown as { read: unknown }).read = async (...a: unknown[]) => {
        const out = await read(...a);
        bytes += out.bytesRead;
        return out;
      };
      return handle;
    }) as typeof fs.open);
    const whole = vi.spyOn(fs, "readFile");
    try {
      await run();
      expect(whole).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      whole.mockRestore();
    }
    return { bytes, opened };
  }

  it("reads the newest entries from the end of the file", async () => {
    const log = await makeLog();
    for (let i = 0; i < 1500; i++) await log.append(command(`journalctl -u nginx --since "${i} minutes ago" --no-pager | tail -n 200 # ${"x".repeat(200)}`));
    const size = (await fs.stat(log.file)).size;
    expect(size).toBeGreaterThan(700_000);
    let newest: AuditEntry[] = [];
    const read = await bytesRead(async () => {
      newest = await log.recent(5);
    });
    expect(newest.map((e) => e.seq)).toEqual([1500, 1499, 1498, 1497, 1496]);
    expect(read.bytes).toBeLessThan(size / 5);
    // Asked for more than a first read holds: it reads further back, and still every entry is whole.
    expect((await log.recent(1200)).map((e) => e.seq)).toEqual(Array.from({ length: 1200 }, (_, i) => 1500 - i));
    expect(await log.recent(5000)).toHaveLength(1500);
  }, 30_000);

  it("checks only what was added while the file is as this log left it", async () => {
    const log = await makeLog();
    for (let i = 0; i < 50; i++) await log.append(command(`cmd ${i}`));
    const restarted = reopen(log);
    // The first check after a start walks the file.
    const first = await bytesRead(() => restarted.verify());
    expect(first.bytes).toBeGreaterThan(0);
    // The next one, and one after more was written, reads nothing: each entry was checked as it was written.
    const again = await bytesRead(async () => expect(await restarted.verify()).toMatchObject({ ok: true, entries: 50 }));
    expect(again).toEqual({ bytes: 0, opened: 0 });
    for (let i = 0; i < 3; i++) await restarted.append(command(`more ${i}`));
    const after = await bytesRead(async () => expect(await restarted.verify()).toMatchObject({ ok: true, entries: 53 }));
    expect(after).toEqual({ bytes: 0, opened: 0 });
  });

  it("walks the file again when anything else touched it, and for an export", async () => {
    const log = await makeLog();
    for (const c of ["ls", "rm -rf /tmp/x", "uptime"]) await log.append(command(c));
    expect((await log.verify()).ok).toBe(true);
    // Somebody edits the file behind the app's back.
    const text = await fs.readFile(log.file, "utf8");
    await fs.writeFile(log.file, text.replace("rm -rf /tmp/x", "echo hello"));
    expect(await log.verify()).toMatchObject({ ok: false, problem: { seq: 2, text: expect.stringContaining("changed after it was written") } });

    const clean = await makeLog();
    for (const c of ["a", "b"]) await clean.append(command(c));
    await clean.verify();
    const exported = await bytesReadWithWhole(() => clean.export());
    expect(exported).toBeGreaterThan(0);
  });

  /** As above, for something that may read the whole file too (an export does). */
  async function bytesReadWithWhole(run: () => Promise<unknown>): Promise<number> {
    const open = fs.open.bind(fs);
    let bytes = 0;
    const spy = vi.spyOn(fs, "open").mockImplementation((async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      const read = handle.read.bind(handle) as (...a: unknown[]) => Promise<{ bytesRead: number }>;
      (handle as unknown as { read: unknown }).read = async (...a: unknown[]) => {
        const out = await read(...a);
        bytes += out.bytesRead;
        return out;
      };
      return handle;
    }) as typeof fs.open);
    try {
      await run();
    } finally {
      spy.mockRestore();
    }
    return bytes;
  }

  it("reads each anchor from the bucket once, and still misses one that was removed", async () => {
    const files = new Map<string, Buffer>();
    let reads = 0;
    const bucket: QueueStore = {
      list: async (dir) => [...files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1)),
      read: async (p) => {
        reads++;
        return files.get(p);
      },
      write: async (p, c) => void files.set(p, c),
      remove: async (p) => void files.delete(p),
    };
    const log = await makeLog(bucket);
    for (const at of [1000, 2000, 3000]) {
      await log.append(command(`a${at}`), at);
      await log.anchor(at);
    }
    reads = 0;
    expect(await log.verify()).toMatchObject({ ok: true, anchors: { checked: 3, held: 3 } });
    expect(reads).toBe(3);
    expect(await log.verify()).toMatchObject({ ok: true, anchors: { checked: 3, held: 3 } });
    expect(reads).toBe(3);
    // A new anchor is the only one read.
    await log.append(command("a4000"), 4000);
    await log.anchor(4000);
    expect(await log.verify()).toMatchObject({ ok: true, anchors: { checked: 4, held: 4 } });
    expect(reads).toBe(4);
    files.delete("audit/client-1/anchors/n000000000002.json");
    expect(await log.verify()).toMatchObject({ ok: false, problem: { text: expect.stringContaining("does not follow anchor 1") } });
  });
});

describe("an edit in place of the same length, with the time it was written set back", () => {
  // `touch -d @seconds.nanoseconds` puts the time back to the nanosecond, as the review did.
  it.skipIf(process.platform === "win32")("is seen by the next check, without a restart and without a full walk", async () => {
    const log = await makeLog();
    for (const c of ["ls /srv", "df -h", "uptime"]) await log.append(command(c));
    expect(await log.verify()).toMatchObject({ ok: true });
    const before = await fs.stat(log.file, { bigint: true });
    const text = await fs.readFile(log.file, "utf8");
    // Same file, same length, and its time written put back as it was.
    await fs.writeFile(log.file, text.replace('"what":"df -h"', '"what":"rm -r"'));
    const at = `@${before.mtimeNs / 1_000_000_000n}.${String(before.mtimeNs % 1_000_000_000n).padStart(9, "0")}`;
    expect(spawnSync("touch", ["-m", "-d", at, log.file]).status).toBe(0);
    const after = await fs.stat(log.file, { bigint: true });
    expect([after.ino, after.size, after.mtimeNs]).toEqual([before.ino, before.size, before.mtimeNs]);
    expect(await log.verify()).toMatchObject({ ok: false });
  });
});
