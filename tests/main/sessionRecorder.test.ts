import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionRecorder } from "../../src/main/ai/hub/SessionRecorder";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function recorder(): Promise<SessionRecorder> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-rec-"));
  dirs.push(dir);
  return new SessionRecorder(dir);
}

const lines = (text: string) => text.trim().split("\n").map((l) => JSON.parse(l) as unknown);

describe("what an agent saw in a terminal", () => {
  it("is written as asciicast v2: a header, then timed events", async () => {
    const rec = await recorder();
    await rec.start({ sessionId: "s1", taskId: "t1", label: "db01", cols: 100, rows: 30 }, 1_000_000);
    rec.marker("s1", "df -h", 1_000_100);
    rec.output("s1", "Filesystem  Size\r\n/dev/sda1   40G\r\n", 1_000_500);
    rec.resize("s1", 120, 40, 1_001_000);
    const info = await rec.stop("s1", 1_002_000);
    const [header, ...events] = lines((await rec.read(info!.id))!);
    expect(header).toMatchObject({ version: 2, width: 100, height: 30, timestamp: 1000, env: { TERM: "xterm-256color" } });
    expect(events).toEqual([
      [0.1, "m", "df -h"],
      [0.5, "o", "Filesystem  Size\r\n/dev/sda1   40G\r\n"],
      [1, "r", "120x40"],
    ]);
    expect(info).toMatchObject({ markers: 1, endedAt: 1_002_000 });
  });

  it("masks a secret even when it arrives in two pieces, and keeps the colours", async () => {
    const rec = await recorder();
    await rec.start({ sessionId: "s1", taskId: "t1", label: "db01" }, 0);
    // A key printed by a program, split across two chunks of output, inside colour codes.
    rec.output("s1", "\x1b[32mexport AWS_KEY=AKIAIOSF", 10);
    rec.output("s1", "ODNN7EXAMPLE\x1b[0m\r\n", 20);
    const info = await rec.stop("s1", 30);
    const text = (await rec.read(info!.id))!;
    expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(text).toContain("[redacted]");
    // The colour codes are still there, so it replays as it looked.
    expect(text).toContain("\\u001b[32m");
  });

  it("does not record a terminal nobody asked to record, and gives each run its own recording", async () => {
    const rec = await recorder();
    rec.output("nobody", "should not be anywhere\n", 1);
    expect(await rec.list()).toEqual([]);
    const a = await rec.start({ sessionId: "s1", taskId: "t1", label: "db01" }, 0);
    // The same run claiming again keeps its recording.
    expect((await rec.start({ sessionId: "s1", taskId: "t1", label: "db01" }, 2)).id).toBe(a.id);
    rec.output("s1", "first run\n", 3);
    // Another run on the same terminal: the first recording ends, the second run is not written into it.
    const b = await rec.start({ sessionId: "s1", taskId: "t2", label: "db01" }, 5);
    expect(b.id).not.toBe(a.id);
    rec.output("s1", "second run\n", 6);
    await rec.stop("s1");
    expect((await rec.list()).map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    expect(await rec.read(a.id)).toContain("first run");
    expect(await rec.read(a.id)).not.toContain("second run");
  });

  it("writes what was held back when it stops, and before a marker", async () => {
    const rec = await recorder();
    await rec.start({ sessionId: "s1", taskId: "t1", label: "db01" }, 0);
    rec.output("s1", "prompt$ ", 10);
    rec.marker("s1", "ls", 20);
    rec.output("s1", "no newline at the end", 30);
    const info = await rec.stop("s1", 40);
    const events = lines((await rec.read(info!.id))!).slice(1);
    expect(events).toEqual([
      [0.02, "o", "prompt$ "],
      [0.02, "m", "ls"],
      [0.04, "o", "no newline at the end"],
    ]);
  });

  it("removes old recordings", async () => {
    const rec = await recorder();
    const info = await rec.start({ sessionId: "s1", taskId: "t1", label: "db01" }, 0);
    await rec.stop("s1");
    expect(await rec.prune(30, Date.now() + 31 * 24 * 3600_000)).toBe(1);
    expect(await rec.read(info.id)).toBeUndefined();
  });
});
