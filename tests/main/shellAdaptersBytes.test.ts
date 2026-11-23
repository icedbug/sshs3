import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { commandEnvelope, NOT_WHOLE_EXIT, printfFormat, readPosixEnvelope } from "../../src/main/ai/hub/shellAdapters";
import type { ShellKind } from "../../src/shared/types/aiHub";
import { installed, openShell, shellCase, type RealShell } from "./helpers/realShell";

/**
 * What a person approved is what runs, byte for byte. A command used to be typed into the shell as
 * it stood: bash's line editor completed a tab away (an approved `printf 'user<TAB>admin'` wrote
 * "useradmin"), and dash dropped everything past 4,095 characters of a line, so a long command
 * never ran and left the shell inside an open quote.
 */

const nonce = "0123456789abcdef0123456789abcdef";
const TAB = "\t";

/** For a POSIX shell: the text as one single-quoted word. */
const sq = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

describe("what is typed into a POSIX shell for a command", () => {
  const samples = [
    "ls -la",
    `printf '%s\\n' 'user${TAB}admin' > out.txt`,
    `cat > site.conf <<EOF\n${TAB}listen 8080\n${TAB}server alpha\nEOF`,
    `echo "it's 100% \\"done\\"" && echo $HOME \`id -u\` !! ^a^b {1..3} ~ # * ? [x] <in >out | tee`,
    "echo é 日本語 🙂",
    "-x",
    "echo " + "A".repeat(6000) + " > long.txt && rm -f keep.txt",
    "x".repeat(16_000),
  ];

  it("holds no tab, no quote of the command's own, no line break inside a line, and no line longer than 800 characters", () => {
    for (const shell of ["bash", "zsh", "sh", "dash"] as ShellKind[]) {
      for (const command of samples) {
        const typed = commandEnvelope(shell, command, nonce);
        expect(typed.endsWith("\r")).toBe(true);
        const lines = typed.slice(0, -1).split("\r");
        for (const line of lines) {
          expect(line.length).toBeLessThanOrEqual(800);
          // Only printable ASCII is typed: nothing a line editor acts on.
          expect(line).toMatch(/^[\x20-\x7e]*$/);
          expect(line.startsWith(" ")).toBe(true);
        }
      }
    }
  });

  it("reads back as exactly the command that went in", () => {
    for (const command of samples) {
      const typed = commandEnvelope("bash", command, nonce).slice(0, -1);
      expect(readPosixEnvelope(typed)).toEqual({ prefix: `SSHS3;${nonce}`, command });
    }
    expect(readPosixEnvelope("echo hello")).toBeUndefined();
    // A piece that went missing is not read as a shorter command.
    const long = commandEnvelope("bash", samples[6], nonce).slice(0, -1).split("\r");
    expect(long.length).toBeGreaterThan(2);
    expect(readPosixEnvelope([long[0], ...long.slice(2)].join("\r"))).toBeUndefined();
  });

  it("writes every byte that is not a plain letter, digit or one of a few signs as an octal escape", () => {
    expect(printfFormat("ls -la /etc")).toBe("ls -la /etc");
    expect(printfFormat(`a${TAB}b\nc'd"e%f\\g`)).toBe("a\\011b\\012c\\047d\\042e\\045f\\134g");
    expect(printfFormat("-n")).toBe("\\055n");
    expect(printfFormat("é")).toBe("\\303\\251");
  });

  it("still refuses a command with a control character in it", () => {
    expect(() => commandEnvelope("bash", "echo hi\x03", nonce)).toThrow(/Control characters/);
    expect(() => commandEnvelope("dash", "echo \x1b[2J", nonce)).toThrow(/Control characters/);
  });
});

describe.each(["bash", "sh", "dash", "zsh"] as ShellKind[])("a command runs byte for byte in a real %s", (kind) => {
  const there = installed(kind);
  const name = shellCase(kind);
  let dir = "";
  let shell: RealShell | undefined;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sshs3-bytes-"));
  });
  afterEach(() => {
    shell?.close();
    shell = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const read = (file: string): string => fs.readFileSync(path.join(dir, file), "utf8");

  it.skipIf(!there)(`${name}: a tab stays a tab`, async () => {
    // A file the line editor would complete "al<TAB>" to.
    fs.writeFileSync(path.join(dir, "alpha.txt"), "");
    shell = await openShell(kind, { cwd: dir });
    const columns = await shell.run(`printf '%s\\n' 'user${TAB}admin' > out.txt`);
    expect(columns.exitCode).toBe(0);
    expect(read("out.txt")).toBe(`user${TAB}admin\n`);

    const heredoc = await shell.run(`cat > site.conf <<EOF\n${TAB}listen 8080\n${TAB}server alpha\nEOF`);
    expect(heredoc.exitCode).toBe(0);
    expect(read("site.conf")).toBe(`${TAB}listen 8080\n${TAB}server alpha\n`);

    const completed = await shell.run(`echo al${TAB}> out4.txt`);
    expect(completed.exitCode).toBe(0);
    expect(read("out4.txt")).toBe("al\n");
  }, 30_000);

  it.skipIf(!there)(`${name}: a command of 6,040 characters runs whole and leaves the shell at its prompt`, async () => {
    fs.writeFileSync(path.join(dir, "keep.txt"), "keep");
    shell = await openShell(kind, { cwd: dir });
    const command = `echo ${"A".repeat(6000)} > long.txt && rm -f keep.txt`;
    expect(command.length).toBeGreaterThan(6000);
    const result = await shell.run(command);
    expect(result.exitCode).toBe(0);
    // The echo of the typed lines and the prompts between them are not "printed before the command".
    expect(result.printedBefore).toBeUndefined();
    expect(fs.statSync(path.join(dir, "long.txt")).size).toBe(6001);
    expect(fs.existsSync(path.join(dir, "keep.txt"))).toBe(false);
    // The shell is not left inside an open quote: the next command runs.
    const next = await shell.run("echo after-$((40+2))");
    expect(next.output).toContain("after-42");
  }, 30_000);

  it.skipIf(!there)(`${name}: the longest command the tools take (16,000 characters) runs whole`, async () => {
    shell = await openShell(kind, { cwd: dir });
    const payload = "0123456789".repeat(1597);
    const command = `printf '%s' ${payload} > big.txt`;
    expect(command.length).toBeGreaterThan(15_980);
    expect(command.length).toBeLessThanOrEqual(16_000);
    const result = await shell.run(command, 30_000);
    expect(result.exitCode).toBe(0);
    expect(read("big.txt")).toBe(payload);
  }, 60_000);

  it.skipIf(!there)(`${name}: quotes, signs the shell reads, and text that is not ASCII arrive as they were approved`, async () => {
    shell = await openShell(kind, { cwd: dir });
    const payload = `it's "100%" \\n \\\\ $HOME \`id\` !! ^a^b {1..3} ~ # * ? [x] <in >out | & ; (y)${TAB}tab\nline two é 日本語 🙂 \\033[2J`;
    const result = await shell.run(`printf '%s' ${sq(payload)} > bytes.bin`);
    expect(result.exitCode).toBe(0);
    expect(fs.readFileSync(path.join(dir, "bytes.bin")).equals(Buffer.from(payload, "utf8"))).toBe(true);
  }, 30_000);

  it.skipIf(!there)(`${name}: exit code, several lines and the person's own folder are as before`, async () => {
    shell = await openShell(kind, { cwd: dir });
    const failed = await shell.run('sh -c "exit 7"');
    expect(failed.exitCode).toBe(7);
    expect(failed.printedBefore).toBeUndefined();
    const lines = await shell.run("for n in 1 2 3\ndo\n  echo line-$n\ndone");
    expect(lines.output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)).toEqual(["line-1", "line-2", "line-3"]);
    // The command runs in a subshell: its cd does not move the person's shell.
    const moved = await shell.run("cd / && pwd");
    expect(moved.output.trim()).toBe("/");
    expect(fs.realpathSync(moved.cwd)).toBe(fs.realpathSync(dir));
  }, 30_000);

  it.skipIf(!there)(`${name}: a long command that lost a piece on the way runs nothing and says so`, async () => {
    fs.writeFileSync(path.join(dir, "keep.txt"), "keep");
    // The terminal drops the second line that is typed, once.
    let dropped = false;
    shell = await openShell(kind, {
      cwd: dir,
      tamper: (typed) => {
        const lines = typed.split("\r");
        if (dropped || lines.length < 4) return typed;
        dropped = true;
        return [lines[0], ...lines.slice(2)].join("\r");
      },
    });
    const result = await shell.run(`rm -f keep.txt; echo ${"B".repeat(3000)} > long.txt`);
    expect(dropped).toBe(true);
    expect(result.exitCode).toBe(NOT_WHOLE_EXIT);
    expect(result.output).toContain("the command did not arrive whole in this terminal. Nothing ran.");
    expect(fs.existsSync(path.join(dir, "keep.txt"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "long.txt"))).toBe(false);
  }, 30_000);
});

describe("fish", () => {
  it("is still typed as the command stands (not tried in a real fish, so not changed)", () => {
    expect(commandEnvelope("fish", "echo 'a b'", nonce)).toContain("eval 'echo \\'a b\\''");
  });
});
