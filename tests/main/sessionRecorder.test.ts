import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("masks a secret even when it arrives in two pieces, and keeps the colours where there is no secret", async () => {
    const rec = await recorder();
    await rec.start({ sessionId: "s1", taskId: "t1", label: "db01" }, 0);
    // A key printed by a program, split across two chunks of output, inside colour codes.
    rec.output("s1", "\x1b[32mexport AWS_KEY=AKIAIOSF", 10);
    rec.output("s1", "ODNN7EXAMPLE\x1b[0m\r\n", 20);
    // A line with nothing secret in it keeps its colours, so it replays as it looked.
    rec.output("s1", "\x1b[1;32mactive (running)\x1b[0m\r\n", 25);
    const info = await rec.stop("s1", 30);
    const text = (await rec.read(info!.id))!;
    expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(text).toContain("[redacted]");
    expect(text).toContain("\\u001b[1;32mactive");
  });

  it("masks a secret that colour codes cut apart, as jq prints it", async () => {
    const rec = await recorder();
    await rec.start({ sessionId: "s1", taskId: "t1", label: "db01" }, 0);
    rec.output("s1", '  \x1b[1;34m"api_token"\x1b[0m\x1b[1;39m: \x1b[0;32m"s3cr3tvalue123"\x1b[0m\r\n', 10);
    const info = await rec.stop("s1", 20);
    const text = (await rec.read(info!.id))!;
    expect(text).not.toContain("s3cr3tvalue123");
  });

  it("writes a prompt that has no newline after a short pause, not with the next line", async () => {
    vi.useFakeTimers();
    const rec = await recorder();
    await rec.start({ sessionId: "s1", taskId: "t1", label: "db01" }, 0);
    rec.output("s1", "Are you sure? [y/N] ", 1000);
    await vi.advanceTimersByTimeAsync(400);
    const info = await rec.stop("s1", 9000);
    vi.useRealTimers();
    const lines = (await rec.read(info!.id))!.trim().split("\n").slice(1).map((l) => JSON.parse(l) as [number, string, string]);
    expect(lines[0][2]).toBe("Are you sure? [y/N] ");
    expect(lines[0][0]).toBeLessThan(2);
  });

  it("keeps the first output of a run, written while the file was still being made, and how each command ended", async () => {
    const rec = await recorder();
    const started = rec.start({ sessionId: "s1", taskId: "t1", label: "db01", cols: 200, rows: 50 }, 0);
    rec.marker("s1", "uptime", 1);
    rec.output("s1", "up 3 days\r\n", 2);
    rec.exit("s1", 0, 3);
    await started;
    const info = await rec.stop("s1", 4);
    const text = (await rec.read(info!.id))!;
    expect(JSON.parse(text.split("\n")[0])).toMatchObject({ width: 200, height: 50 });
    expect(text).toContain('"m","uptime"');
    expect(text).toContain("up 3 days");
    expect(text).toContain('"x","0"');
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

  describe("a private key that arrives in several pieces", () => {
    const BEGIN = "-----BEGIN OPENSSH PRIVATE KEY-----";
    const END = "-----END OPENSSH PRIVATE KEY-----";
    const one = "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW";
    const two = "QyNTUxOQAAACDSECONDHALFOFTHEKEYMATERIALxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    const three = "AAAAQTHIRDLINEOFKEYMATERIALyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy";

    async function recorded(pieces: string[]): Promise<string> {
      const rec = await recorder();
      await rec.start({ sessionId: "s1", taskId: "t1", label: "db-01" }, 0);
      rec.marker("s1", "cat ~/.ssh/id_ed25519", 1);
      pieces.forEach((piece, i) => rec.output("s1", piece, 10 + i));
      const info = await rec.stop("s1", 100);
      return lines((await rec.read(info!.id))!)
        .slice(1)
        .filter((e) => (e as unknown[])[1] === "o")
        .map((e) => (e as string[])[2])
        .join("");
    }

    it("keeps none of it: the pieces after the first hold no header, and are still part of the key", async () => {
      // The terminal delivers the file in two pieces.
      const shown = await recorded([`${BEGIN}\n${one}\n`, `${two}\n${three}\n${END}\nops@db-01:~$ `]);
      for (const secret of [one, two, three, "SECONDHALFOFTHEKEYMATERIAL", "THIRDLINEOFKEYMATERIAL"]) expect(shown).not.toContain(secret);
      expect(shown).toBe("[private key redacted]\nops@db-01:~$ ");
    });

    it("also line by line, with carriage returns, colours, and a piece that ends in the middle of a line", async () => {
      const shown = await recorded([`${BEGIN}\r\n`, `${one}\r\n`, `\x1b[0m${two.slice(0, 30)}`, `${two.slice(30)}\r\n`, `${three}\r\n${END}\r\n`, "ops@db-01:~$ "]);
      for (const secret of [one, two, three, two.slice(0, 30), two.slice(30)]) expect(shown).not.toContain(secret);
      expect(shown).toContain("[private key redacted]");
      expect(shown.endsWith("ops@db-01:~$ ")).toBe(true);
    });

    it("an encrypted key and a PGP key block, with their header lines", async () => {
      const rsa = await recorded(["-----BEGIN RSA PRIVATE KEY-----\n", "Proc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,2AF25325A9B318F344B8391AFD767D6D\n\n", `${two}\n`, "-----END RSA PRIVATE KEY-----\n", "$ "]);
      expect(rsa).not.toContain(two);
      expect(rsa).not.toContain("2AF25325A9B318F344B8391AFD767D6D");
      expect(rsa.endsWith("$ ")).toBe(true);
      const pgp = await recorded(["-----BEGIN PGP PRIVATE KEY BLOCK-----\n", `\n${one}\n`, `${two}\n=AbCd\n`, "-----END PGP PRIVATE KEY BLOCK-----\ndone\n"]);
      expect(pgp).not.toContain(one);
      expect(pgp).not.toContain(two);
      expect(pgp).toContain("done");
    });

    it("shows what comes after a key that was cut short: a line that cannot be part of a key ends it", async () => {
      // `head -2` of the key, then the prompt and the next command's output.
      const shown = await recorded([`${BEGIN}\n${one}\n`, "ops@db-01:~$ ", "uptime\n 10:00:01 up 3 days\n"]);
      expect(shown).not.toContain(one);
      expect(shown).toContain("ops@db-01:~$ uptime\n 10:00:01 up 3 days\n");
    });
  });

  it("removes old recordings", async () => {
    const rec = await recorder();
    const info = await rec.start({ sessionId: "s1", taskId: "t1", label: "db01" }, 0);
    await rec.stop("s1");
    expect(await rec.prune(30, Date.now() + 31 * 24 * 3600_000)).toBe(1);
    expect(await rec.read(info.id)).toBeUndefined();
  });
});
