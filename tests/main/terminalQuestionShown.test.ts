import { afterEach, describe, expect, it } from "vitest";
import { CommandFrames } from "../../src/main/ai/hub/shellAdapters";
import { STILL_RUNNING, TerminalRegistry } from "../../src/main/ai/hub/TerminalRegistry";
import { installed, openShell, shellCase } from "./helpers/realShell";

/**
 * A command the agent runs may ask a question ("Delete 3 volumes? [y/N] ", "[sudo] password for ops: ")
 * and wait. The frame used to hold back its last 8 characters in case a marker began there, and showed
 * them only when more text came: the person saw "Delete 3 volumes" and not the question. Now only what
 * may begin a marker (from an ESC on) is held back, and a marker is never shown.
 */

const disposals: Array<() => unknown> = [];
afterEach(async () => {
  for (const d of disposals.splice(0)) await d();
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const NONCE = "0123456789abcdef0123456789abcdef";
const BEGIN = `\x1b]777;SSHS3;${NONCE};BEGIN\x07`;
const END = `\x1b]777;SSHS3;${NONCE};END;0;/home/ops\x07`;

describe("a frame while its command runs", () => {
  it("shows a question at once, to its last character", () => {
    for (const question of ["Delete 3 volumes? [y/N] ", "[sudo] password for ops: ", "Continue? ", "x"]) {
      const frames = new CommandFrames(NONCE);
      expect(frames.feed(`${BEGIN}${question}`)).toBeUndefined();
      expect(frames.drainDisplay()).toBe(question);
      expect(frames.heldBack()).toBe("");
      expect(frames.shownSoFar()).toBe(question);
    }
  });

  it("never shows a marker, wherever the terminal cuts it, and still ends where it ends", () => {
    const text = `${BEGIN}colour \x1b[31mred\x1b[0m done? ${END}`;
    for (let cut = 1; cut < text.length; cut++) {
      const frames = new CommandFrames(NONCE);
      let shown = "";
      let result = frames.feed(text.slice(0, cut));
      shown += frames.drainDisplay();
      result ??= frames.feed(text.slice(cut));
      shown += frames.drainDisplay();
      expect(result, `cut at ${cut}`).toMatchObject({ exitCode: 0, cwd: "/home/ops", output: "colour \x1b[31mred\x1b[0m done? " });
      expect(shown, `cut at ${cut}`).toBe("colour \x1b[31mred\x1b[0m done? ");
    }
  });

  it("holds back only what may start a marker, and hands it on when it is let go of", () => {
    const frames = new CommandFrames(NONCE);
    frames.feed(`${BEGIN}Delete 3 volumes? [y/N] \x1b]77`);
    expect(frames.drainDisplay()).toBe("Delete 3 volumes? [y/N] ");
    expect(frames.heldBack()).toBe("\x1b]77");
    // The start of another escape sequence is not held: it cannot be a marker.
    const other = new CommandFrames(NONCE);
    other.feed(`${BEGIN}ok\x1b[3`);
    expect(other.drainDisplay()).toBe("ok\x1b[3");
    expect(other.heldBack()).toBe("");
  });
});

describe("a frame let go of while the end marker was arriving", () => {
  it("still sees that marker when the rest of it comes, so the terminal opens again", async () => {
    const terminals = new TerminalRegistry();
    disposals.push(() => terminals.dispose());
    let nonce = "";
    let hang = false;
    terminals.register({ id: "t1", label: "web-01", kind: "ssh", profileId: "p1", shell: "bash" }, (data) => {
      const n = /SSHS3;([a-f0-9]{32});BEGIN/.exec(data)?.[1];
      if (!n) return;
      const begin = `\x1b]777;SSHS3;${n};BEGIN\x07`;
      if (hang) {
        nonce = n;
        // The command printed its question and the first part of its end marker; the rest is late.
        setTimeout(() => terminals.feed("t1", `${begin}Sure? \x1b]777;SSHS3;${n};EN`), 2);
      } else setTimeout(() => terminals.feed("t1", `${begin}\x1b]777;SSHS3;${n};END;0;/home/ops\x07`), 2);
    });
    terminals.feed("t1", "ops@web-01:~$ ");
    await terminals.arm("t1", "bash");
    const generation = terminals.get("t1")!.generation;
    terminals.claim("t1", generation, "task-1");
    hang = true;
    await expect(terminals.execute("t1", generation, "task-1", "ask", 60)).rejects.toThrow(/did not finish/);
    hang = false;
    await expect(terminals.ensureReady("t1")).rejects.toThrow(STILL_RUNNING);
    // The rest of the marker: the command has ended. What reaches the person's terminal holds the whole marker
    // (a terminal draws nothing of it), so no half of one is left to swallow what follows.
    const shown = terminals.feed("t1", `D;0;/home/ops\x07\r\nops@web-01:~$ `);
    expect(shown).toBe(`\x1b]777;SSHS3;${nonce};END;0;/home/ops\x07\r\nops@web-01:~$ `);
    await expect(terminals.ensureReady("t1")).resolves.toMatchObject({ state: "ready" });
  });
});

describe("a question in a real shell", () => {
  for (const shell of ["bash", "dash"] as const)
    it.skipIf(!installed(shell))(`is shown whole while the command waits, and after it is let go of: ${shellCase(shell)}`, async () => {
      const real = await openShell(shell);
      disposals.push(() => real.close());
      const at = real.shown().length;
      const running = real.run(`printf 'Delete 3 volumes? [y/N] '; read a; echo "got:$a"`, 2500).catch((e: Error) => e.message);
      await sleep(1200);
      expect(real.shown().slice(at)).toMatch(/Delete 3 volumes\? \[y\/N\] $/);
      expect(await running).toMatch(/did not finish within 3 seconds.*It last showed: Delete 3 volumes\? \[y\/N\]$/s);
      expect(real.shown().slice(at)).toMatch(/Delete 3 volumes\? \[y\/N\] $/);
      expect(real.shown()).not.toContain("777;SSHS3");
      real.type("n\r");
      await sleep(500);
    }, 20_000);
});
