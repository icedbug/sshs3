import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AuditLog, hashEntry } from "../../src/main/ai/hub/AuditLog";
import type { QueueStore } from "../../src/main/ai/hub/LearningQueue";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function memoryBucket(): QueueStore & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  return {
    files,
    list: async (dir) => [...files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1)),
    read: async (p) => files.get(p),
    write: async (p, c) => void files.set(p, c),
    remove: async (p) => void files.delete(p),
  };
}

async function makeLog(bucket?: QueueStore): Promise<AuditLog> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-audit-"));
  dirs.push(dir);
  return new AuditLog(dir, "client-1", bucket ? () => bucket : undefined);
}

const command = (what: string, extra: Record<string, unknown> = {}) => ({
  kind: "command" as const,
  actor: "Watch (Jacob's run)",
  target: "db01",
  what,
  outcome: "completed",
  exitCode: 0,
  ...extra,
});

describe("what was done here, kept so it can be trusted", () => {
  it("chains each entry to the one before it, and verifies", async () => {
    const log = await makeLog();
    const a = await log.append(command("df -h"));
    const b = await log.append(command("systemctl restart nginx", { approvedBy: "Jacob" }));
    expect(a).toMatchObject({ seq: 1, prev: "" });
    expect(b).toMatchObject({ seq: 2, prev: a.hash, approvedBy: "Jacob" });
    expect(await log.verify()).toMatchObject({ ok: true, entries: 2 });
  });

  it("masks a secret before it is hashed, so the log can be shown without it", async () => {
    const log = await makeLog();
    const e = await log.append(command("mysql -u root --password=hunter2secret -e 'select 1'"));
    expect(e.what).not.toContain("hunter2secret");
    const text = await fs.readFile(log.file, "utf8");
    expect(text).not.toContain("hunter2secret");
    // The hash was taken over what is kept, so the masked log still verifies.
    expect((await log.verify()).ok).toBe(true);
  });

  it("says where it breaks when a line is changed", async () => {
    const log = await makeLog();
    await log.append(command("ls"));
    await log.append(command("rm -rf /tmp/x"));
    await log.append(command("uptime"));
    const lines = (await fs.readFile(log.file, "utf8")).trim().split("\n");
    // Somebody makes the second command look harmless.
    lines[1] = lines[1].replace("rm -rf /tmp/x", "echo hello");
    await fs.writeFile(log.file, `${lines.join("\n")}\n`);
    expect(await log.verify()).toMatchObject({ ok: false, problem: { seq: 2, text: expect.stringContaining("changed after it was written") } });
  });

  it("says where it breaks when a line is taken out, or one is put in", async () => {
    const log = await makeLog();
    for (const c of ["a", "b", "c", "d"]) await log.append(command(c));
    const lines = (await fs.readFile(log.file, "utf8")).trim().split("\n");
    await fs.writeFile(log.file, `${[lines[0], lines[2], lines[3]].join("\n")}\n`);
    expect(await log.verify()).toMatchObject({ ok: false, problem: { text: expect.stringContaining("missing") } });

    // A forged entry with the right number but a made-up history.
    const forged = { ...JSON.parse(lines[1]), what: "nothing to see" };
    const { hash: _drop, ...rest } = forged;
    forged.hash = hashEntry(rest);
    await fs.writeFile(log.file, `${[lines[0], JSON.stringify(forged), lines[2], lines[3]].join("\n")}\n`);
    expect(await log.verify()).toMatchObject({ ok: false, problem: { seq: 3, text: expect.stringContaining("does not follow") } });
  });

  it("notices a tail that was cut off, by the anchors in the team bucket", async () => {
    const bucket = memoryBucket();
    const log = await makeLog(bucket);
    for (const c of ["a", "b", "c"]) await log.append(command(c));
    const anchor = await log.anchor();
    expect(anchor).toMatchObject({ seq: 3, client: "client-1", n: 1, prev: "" });
    expect([...bucket.files.keys()]).toEqual(["audit/client-1/anchors/n000000000001.json"]);
    // Nothing new since: no anchor, the last one still vouches for the whole chain.
    expect(await log.anchor()).toBeUndefined();
    expect(await log.anchor()).toBeUndefined();
    expect(bucket.files.size).toBe(1);
    // Something new: the next anchor, chained to the one before.
    await log.append(command("d"));
    expect(await log.anchor()).toMatchObject({ seq: 4, n: 2, prev: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(await log.verify()).toMatchObject({ ok: true, anchors: { checked: 2, held: 2, coveredSeq: 4 } });
    // After a restart too: where the anchors stand is read back from the bucket.
    const again = new AuditLog(path.dirname(log.file), "client-1", () => bucket);
    expect(await again.anchor()).toBeUndefined();
    expect(bucket.files.size).toBe(2);

    // The last entry is cut off. On its own the chain would still verify.
    const lines = (await fs.readFile(log.file, "utf8")).trim().split("\n");
    await fs.writeFile(log.file, `${lines.slice(0, 3).join("\n")}\n`);
    expect(await log.verify()).toMatchObject({
      ok: false,
      problem: { seq: 4, text: expect.stringContaining("removed from its end") },
    });
  });

  it("notices anchors removed from the team bucket, by the anchors' own chain", async () => {
    const bucket = memoryBucket();
    const log = await makeLog(bucket);
    for (const at of [1000, 2000, 3000]) {
      await log.append(command(`a${at}`), at);
      await log.anchor(at);
    }
    bucket.files.delete("audit/client-1/anchors/n000000000002.json");
    expect(await log.verify()).toMatchObject({ ok: false, problem: { text: expect.stringContaining("does not follow anchor 1") } });
  });

  it("says where entries waited a long time for an anchor, and not where nothing happened", async () => {
    const bucket = memoryBucket();
    const log = await makeLog(bucket);
    await log.append(command("a"), 0);
    await log.anchor(0);
    // Quiet for two hours: nothing to anchor, and no gap.
    await log.append(command("b"), 2 * 3600_000);
    await log.anchor(2 * 3600_000 + 60_000);
    // An entry that waited three hours for its anchor: the computer was off, or anchors are missing.
    await log.append(command("c"), 3 * 3600_000);
    await log.anchor(6 * 3600_000);
    expect((await log.verify()).anchors?.gaps).toEqual([{ from: 3 * 3600_000, to: 6 * 3600_000 }]);
  });

  it("notices a log rewritten from the start, by the same anchors", async () => {
    const bucket = memoryBucket();
    const log = await makeLog(bucket);
    for (const c of ["a", "b"]) await log.append(command(c));
    await log.anchor();
    // A whole new, internally consistent chain written over the old one.
    await fs.writeFile(log.file, "");
    const again = new AuditLog(path.dirname(log.file), "client-1", () => bucket);
    for (const c of ["x", "y"]) await again.append(command(c));
    expect(await again.verify()).toMatchObject({ ok: false, problem: { seq: 2, text: expect.stringContaining("rewritten") } });
  });

  it("keeps the chain across a restart, and survives a line cut off by a crash", async () => {
    const log = await makeLog();
    await log.append(command("a"));
    await log.append(command("b"));
    // The app closes and opens again: a new object on the same file continues the chain.
    const reopened = new AuditLog(path.dirname(log.file), "client-1");
    const c = await reopened.append(command("c"));
    expect(c.seq).toBe(3);
    expect((await reopened.verify()).ok).toBe(true);
    // A write that was cut off half-way.
    await fs.appendFile(reopened.file, '{"seq":4,"at":1,"prev":"');
    expect(await reopened.verify()).toMatchObject({ ok: false, problem: { text: expect.stringContaining("not a whole entry") } });
  });

  it("writes entries one at a time even when they are asked for at once", async () => {
    const log = await makeLog();
    await Promise.all(Array.from({ length: 25 }, (_, i) => log.append(command(`cmd ${i}`))));
    const v = await log.verify();
    expect(v).toMatchObject({ ok: true, entries: 25 });
    expect((await log.recent(3)).map((e) => e.seq)).toEqual([25, 24, 23]);
  });

  it("hands the whole log over together with what its check found", async () => {
    const log = await makeLog();
    await log.append(command("whoami"));
    const out = await log.export();
    expect(out.jsonl.trim().split("\n")).toHaveLength(1);
    expect(out.verification.ok).toBe(true);
  });
});
