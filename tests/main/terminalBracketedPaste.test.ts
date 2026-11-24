import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TerminalRegistry } from "../../src/main/ai/hub/TerminalRegistry";
import { installed, openShell, shellCase } from "./helpers/realShell";

/**
 * The command an agent runs was typed through the shell's line editor, so a person's key bindings
 * changed it: in bash with vi mode and a binding on "jj", the letters were read as vi commands, lines
 * from the history were recalled and run instead of the approved command, and the agent was told
 * "Nothing ran". Where the line editor shows that it reads with bracketed paste on (ESC[?2004h), each
 * typed line is now pasted, with the Enter after the paste: a paste is taken as text. A shell that
 * never shows it (dash) is typed into as before.
 */

const disposals: Array<() => unknown> = [];
afterEach(async () => {
  for (const d of disposals.splice(0)) await d();
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const SHORT = `printf '%s|%s\\n' "token=abcjjxyz" "ops@db jk" > out.txt`;
/** Several typed lines: the envelope hands a long command over in pieces. */
const LONG = `printf '%s' "${"jj@jk%'\\\\ x ".repeat(120)}" > out.txt; wc -c < out.txt`;

/** What the command writes when bash runs it with -c, nothing in between. */
function reference(command: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sshs3-paste-ref-"));
  try {
    spawnSync("bash", ["-c", command], { cwd: dir });
    return fs.readFileSync(path.join(dir, "out.txt"), "utf8");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const SETTINGS: Array<[string, string[]]> = [
  ["vi mode with jj", ["set -o vi", `bind '"jj": vi-movement-mode'`]],
  ["an emacs macro on jk", [`bind '"jk": "\\C-a\\C-k"'`]],
  ["stty kill @", ["stty kill @"]],
  ["no settings", []],
];

describe.skipIf(!installed("bash"))("an agent's command in a bash with a person's key bindings", () => {
  for (const [name, setup] of SETTINGS)
    it(`runs exactly as approved, short and long, one right after the other: ${name}`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sshs3-paste-"));
      disposals.push(() => fs.rmSync(dir, { recursive: true, force: true }));
      // A history that a vi command could recall and run in its place.
      const history = path.join(dir, "history");
      fs.writeFileSync(history, "echo FROM-HISTORY > out.txt\nprintf 'from history\\n' > out.txt\n");
      const real = await openShell("bash", { cwd: dir, setup, env: { HISTFILE: history } });
      disposals.push(() => real.close());
      for (const command of [SHORT, LONG, SHORT]) {
        fs.rmSync(path.join(dir, "out.txt"), { force: true });
        const result = await real.run(command, 10_000);
        expect(result.exitCode, command.slice(0, 40)).toBe(0);
        expect(fs.readFileSync(path.join(dir, "out.txt"), "utf8")).toBe(reference(command));
      }
      // It was pasted: the shell showed bracketed paste on at its prompt.
      expect(real.transcript()).toContain("\x1b[?2004h");
    }, 60_000);

  it("never runs another command when the line editor was left in vi command mode: as approved, or nothing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sshs3-paste-"));
    disposals.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const history = path.join(dir, "history");
    fs.writeFileSync(history, "echo FROM-HISTORY > out.txt\n");
    const real = await openShell("bash", { cwd: dir, setup: ["set -o vi"], env: { HISTFILE: history } });
    disposals.push(() => real.close());
    // Escape at the prompt, past the registry: vi command mode.
    real.type("\x1b");
    await sleep(300);
    await real.run(SHORT, 4000).catch(() => undefined);
    await sleep(300);
    const got = fs.existsSync(path.join(dir, "out.txt")) ? fs.readFileSync(path.join(dir, "out.txt"), "utf8") : undefined;
    expect([undefined, reference(SHORT)]).toContain(got);
  }, 30_000);
});

describe("a shell that never switches bracketed paste on", () => {
  it.skipIf(!installed("dash"))(`is typed into as before, and runs the command as approved: ${shellCase("dash")}`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sshs3-paste-"));
    disposals.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const written: string[] = [];
    const real = await openShell("dash", { cwd: dir, tamper: (typed) => (written.push(typed), typed) });
    disposals.push(() => real.close());
    for (const command of [SHORT, LONG]) {
      const result = await real.run(command, 10_000);
      expect(result.exitCode).toBe(0);
      expect(fs.readFileSync(path.join(dir, "out.txt"), "utf8")).toBe(reference(command));
    }
    expect(written.join("")).not.toContain("\x1b[200~");
  }, 30_000);

  it("is typed into at once, and a terminal that switches it on gets each line pasted, once it reads", async () => {
    const terminals = new TerminalRegistry();
    disposals.push(() => terminals.dispose());
    const written: string[] = [];
    terminals.register({ id: "t1", label: "web-01", kind: "ssh", shell: "bash" }, (data) => {
      written.push(data);
      const nonce = /SSHS3;([a-f0-9]{32});BEGIN/.exec(data)?.[1];
      // A line editor: it turns bracketed paste off when it takes the line, and on again at its prompt.
      if (nonce) setTimeout(() => terminals.feed("t1", `\x1b[?2004l\x1b]777;SSHS3;${nonce};BEGIN\x07ok\r\n\x1b]777;SSHS3;${nonce};END;0;/\x07`), 2);
    });
    terminals.feed("t1", "\x1b[?2004hops@web-01:~$ ");
    await terminals.arm("t1", "bash");
    // The handshake was pasted: the prompt had it on.
    // eslint-disable-next-line no-control-regex -- the paste marks are what is looked for
    expect(written[0]).toMatch(/^\x1b\[200~ command printf .*\x1b\[201~\r$/);
    const generation = terminals.get("t1")!.generation;
    terminals.claim("t1", generation, "task");
    // Right after the last command it is off: the next command waits for the prompt to switch it on.
    const running = terminals.execute("t1", generation, "task", "echo hi");
    await sleep(30);
    expect(written).toHaveLength(1);
    terminals.feed("t1", "\x1b[?2004hops@web-01:~$ ");
    await expect(running).resolves.toMatchObject({ exitCode: 0 });
    // eslint-disable-next-line no-control-regex -- the paste marks are what is looked for
    expect(written[1]).toMatch(/^\x1b\[200~ command printf .*\x1b\[201~\r$/);
    // Taken back while it waited: nothing was typed, it says so, and no end marker is waited for.
    const waiting = terminals.execute("t1", terminals.get("t1")!.generation, "task", "echo never");
    await sleep(10);
    terminals.takeover("t1", { interrupt: false });
    await expect(waiting).rejects.toThrow(/Nothing of the command had been typed yet/);
    expect(written).toHaveLength(2);
    terminals.feed("t1", "\x1b[?2004hops@web-01:~$ ");
    await terminals.arm("t1", "bash");
    terminals.claim("t1", terminals.get("t1")!.generation, "task");
    // A prompt that never switches it on again: typed after a while, as before.
    const typedLater = terminals.execute("t1", terminals.get("t1")!.generation, "task", "echo again");
    await expect(typedLater).resolves.toMatchObject({ exitCode: 0 });
    // The handshake was pasted; the command after it found the switch off and never on again.
    // eslint-disable-next-line no-control-regex -- the paste marks are what is looked for
    expect(written[2]).toMatch(/^\x1b\[200~ command printf /);
    expect(written[3]).toMatch(/^ command printf /);
  });
});
