import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalRegistry, atShellPrompt } from "../../src/main/ai/hub/TerminalRegistry";

/** Who holds a terminal, and what the agent may type into it. From the review of feature 3. */

const disposals: Array<() => unknown> = [];
afterEach(async () => {
  for (const d of disposals.splice(0)) await d();
});

function live(answer = true) {
  const terminals = new TerminalRegistry();
  disposals.push(() => terminals.dispose());
  const writes: string[] = [];
  terminals.register({ id: "one", label: "db01", kind: "ssh" }, (data) => {
    writes.push(data);
    const n = /SSHS3;([a-f0-9]{32});BEGIN/.exec(data)?.[1];
    if (n && answer) queueMicrotask(() => terminals.feed("one", `\x1b]777;SSHS3;${n};BEGIN\x07ok\x1b]777;SSHS3;${n};END;0;/srv\x07`));
  });
  return { terminals, writes };
}

describe("handing a terminal between a person and an agent", () => {
  it("connects by itself only at a shell prompt, never into a running program", () => {
    expect(atShellPrompt("jacob@db01:~$ ")).toBe(true);
    expect(atShellPrompt("[root@db01 ~]# ")).toBe(true);
    expect(atShellPrompt("\x1b[01;32mjacob@db01\x1b[00m:\x1b[01;34m~\x1b[00m$ ")).toBe(true);
    expect(atShellPrompt("PS C:\\Users\\jacob> ")).toBe(true);
    expect(atShellPrompt(undefined)).toBe(true);
    expect(atShellPrompt("mysql> ")).toBe(false);
    expect(atShellPrompt("postgres=# ")).toBe(false);
    expect(atShellPrompt(">>> ")).toBe(false);
    expect(atShellPrompt("jacob@db01's password: ")).toBe(false);
    expect(atShellPrompt("top - 10:00:01 up 3 days,  1 user,  load average: 0.00")).toBe(false);
    expect(atShellPrompt("--More--")).toBe(false);
  });

  it("refuses to connect into a program, and says why", async () => {
    const { terminals, writes } = live();
    terminals.feed("one", "Welcome to MariaDB monitor.\r\nMariaDB [(none)]> ");
    terminals.feed("one", "\r\nmysql> ");
    await expect(terminals.ensureReady("one")).rejects.toThrow(/not at a shell prompt/);
    expect(writes).toHaveLength(0);
  });

  it("after a failed connect, does not try again and again, each time typing into the terminal", async () => {
    const { terminals, writes } = live(false);
    vi.useFakeTimers();
    const first = terminals.ensureReady("one").catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(String(await first)).toMatch(/did not answer like a bash shell/);
    await expect(terminals.ensureReady("one")).rejects.toThrow(/did not answer/);
    expect(writes).toHaveLength(1);
    vi.useRealTimers();
  });

  it("lets a person's Ctrl-C through once, not twice", async () => {
    const { terminals, writes } = live(false);
    terminals.feed("one", "$ ");
    const armed = terminals.arm("one", "bash").catch(() => undefined);
    expect(terminals.get("one")!.state).toBe("busy");
    terminals.observeHumanInput("one", "\x03");
    await armed;
    // The handshake only: the person's own Ctrl-C is written by the caller, and the registry adds none.
    expect(writes.filter((w) => w === "\x03")).toHaveLength(0);
  });

  it("does not turn something that only looks like sshs3's own frame into team activity", () => {
    const { terminals } = live();
    const seen = vi.fn();
    terminals.on("commandLine", seen);
    terminals.feed(
      "one",
      "\x1b]777;SSHS3;0123456789abcdef0123456789abcdef;BEGIN\x07rm -rf /important\n\x1b]777;SSHS3;0123456789abcdef0123456789abcdef;END;0;/\x07",
    );
    expect(seen).not.toHaveBeenCalled();
    expect(terminals.failures().one).toBeUndefined();
  });
});
