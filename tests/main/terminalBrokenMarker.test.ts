import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CommandFrames } from "../../src/main/ai/hub/shellAdapters";
import { installed, openShell, shellCase } from "./helpers/realShell";

/**
 * A program that prints what begins like a marker of sshs3's (ESC ] 777 ;) and never ends it used to
 * stop the frame with "Oversized shell marker": the agent got only that error, and a change card turned
 * "uncertain", although the command finished. Such text is the program's own output; the frame goes on.
 */

const disposals: Array<() => unknown> = [];
afterEach(async () => {
  for (const d of disposals.splice(0)) await d();
});

const NONCE = "0123456789abcdef0123456789abcdef";
const BEGIN = `\x1b]777;SSHS3;${NONCE};BEGIN\x07`;
const END = `\x1b]777;SSHS3;${NONCE};END;0;/srv\x07`;

describe("text that begins like a marker and is not one", () => {
  it("never ending, 17,000 characters long, is output, and the frame ends at its own end marker", () => {
    const frames = new CommandFrames(NONCE);
    const text = `${BEGIN}BEFORE\n\x1b]777;${"x".repeat(17_000)}\nAFTER\n${END}`;
    let result;
    // In pieces, as a terminal sends it.
    for (let at = 0; at < text.length && !result; at += 1000) result = frames.feed(text.slice(at, at + 1000));
    expect(result).toMatchObject({ exitCode: 0, cwd: "/srv" });
    expect(result!.output).toContain("BEFORE");
    expect(result!.output).toContain("AFTER");
    expect(result!.output).toContain("x".repeat(17_000));
  });

  it("cut off by another escape sequence, or by sshs3's own end marker, is output too", () => {
    const frames = new CommandFrames(NONCE);
    expect(frames.feed(`${BEGIN}a\x1b]777;oops\x1b[31mred\x1b[0m b ${END}`)).toMatchObject({ exitCode: 0, output: "a\x1b]777;oops\x1b[31mred\x1b[0m b " });
    const other = new CommandFrames(NONCE);
    expect(other.feed(`${BEGIN}half \x1b]777;${END}`)).toMatchObject({ exitCode: 0, output: "half \x1b]777;" });
  });
});

describe("in a real shell", () => {
  for (const shell of ["bash", "dash"] as const)
    it.skipIf(!installed(shell))(`the command's own result comes back: ${shellCase(shell)}`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sshs3-broken-marker-"));
      disposals.push(() => fs.rmSync(dir, { recursive: true, force: true }));
      const real = await openShell(shell, { cwd: dir });
      disposals.push(() => real.close());
      const result = await real.run(
        `printf 'VISIBLE-BEFORE\\n\\033]777;'; head -c 17000 /dev/zero | tr '\\0' x; printf '\\nVISIBLE-AFTER\\n'; echo done > after.txt; echo LAST-LINE; exit 3`,
        10_000,
      );
      expect(result.exitCode).toBe(3);
      expect(result.output).toContain("VISIBLE-AFTER");
      expect(result.output).toContain("LAST-LINE");
      expect(fs.existsSync(path.join(dir, "after.txt"))).toBe(true);
      expect(real.registry.get("real")!.state).toBe("ready");
      await expect(real.run("echo next")).resolves.toMatchObject({ exitCode: 0 });
    }, 30_000);
});
