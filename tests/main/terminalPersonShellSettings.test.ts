import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CommandFrames, LETTERS_CHANGED_NOTE, NOT_WHOLE_EXIT, commandEnvelope, readPosixEnvelope } from "../../src/main/ai/hub/shellAdapters";
import { installed, openShell, shellCase } from "./helpers/realShell";

/**
 * The envelope around an agent's command used the person's own `printf`: in a dash with
 * `alias printf=echo` a different command ran, and a terminal set to turn capitals into small letters
 * (`stty iuclc`) ran the command lowercased. The envelope now uses `command printf`, and runs nothing
 * when a typed capital does not arrive as one; the agent is told why.
 */

const disposals: Array<() => unknown> = [];
afterEach(async () => {
  for (const d of disposals.splice(0)) await d();
});

/** It does not call printf itself: a person's alias for the programs a command calls is theirs to have. */
const COMMAND = `x='A b|Jj@y|100%'; echo "$x" > out.txt; cat out.txt`;
const WANT = "A b|Jj@y|100%\n";

function folder(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sshs3-settings-"));
  disposals.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("a person's own printf", () => {
  for (const shell of ["dash", "bash"] as const)
    it.skipIf(!installed(shell))(`is not used by the envelope: alias printf=echo, ${shellCase(shell)}`, async () => {
      const dir = folder();
      const real = await openShell(shell, { cwd: dir, setup: ["alias printf=echo"] });
      disposals.push(() => real.close());
      const result = await real.run(COMMAND, 10_000);
      expect(result.exitCode).toBe(0);
      expect(fs.readFileSync(path.join(dir, "out.txt"), "utf8")).toBe(WANT);
      expect(result.cwd).toBe(fs.realpathSync(dir));
    }, 30_000);

  it.skipIf(!installed("bash"))("is not used by the envelope: a function called printf that writes a line", async () => {
    const dir = folder();
    const real = await openShell("bash", { cwd: dir, setup: ["printf() { builtin printf 'LOG\\n' >&2; builtin printf \"$@\"; }"] });
    disposals.push(() => real.close());
    const result = await real.run("echo plain", 10_000);
    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.output).not.toContain("LOG");
  }, 30_000);
});

describe("a terminal that turns typed capitals into small letters (stty iuclc)", () => {
  for (const shell of ["dash", "bash"] as const)
    it.skipIf(!installed(shell))(`runs nothing, and the agent is told why: ${shellCase(shell)}`, async () => {
      const dir = folder();
      const real = await openShell(shell, { cwd: dir, setup: ["stty iuclc"] });
      disposals.push(() => real.close());
      const result = await real.run(COMMAND, 10_000);
      expect(result).toMatchObject({ exitCode: NOT_WHOLE_EXIT, output: LETTERS_CHANGED_NOTE });
      expect(fs.existsSync(path.join(dir, "out.txt"))).toBe(false);
    }, 30_000);

  it("is known by the frame from its markers in small letters", () => {
    const nonce = "0123456789abcdef0123456789abcdef";
    const frames = new CommandFrames(nonce, 128_000, { command: "echo HI", shell: "dash" });
    expect(frames.feed(`\x1b]777;sshs3;${nonce};begin\x07sshs3: the command did not arrive whole in this terminal. nothing ran.\r\n`)).toBeUndefined();
    expect(frames.drainDisplay()).not.toContain("echo HI");
    expect(frames.feed(`\x1b]777;sshs3;${nonce};end;126;\x07`)).toEqual({ exitCode: NOT_WHOLE_EXIT, output: LETTERS_CHANGED_NOTE, cwd: "" });
  });
});

describe("the envelope", () => {
  it("is read back by a stand-in shell, short and long", () => {
    const nonce = "0123456789abcdef0123456789abcdef";
    for (const command of ["echo 'hi there'", `printf '%s' "${"x".repeat(3000)}"`]) {
      const typed = commandEnvelope("bash", command, nonce).replace(/\r$/, "");
      expect(typed).toContain("command printf");
      expect(readPosixEnvelope(typed)).toEqual({ prefix: `SSHS3;${nonce}`, command });
    }
  });
});
