import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalRegistry } from "../../src/main/ai/hub/TerminalRegistry";
import { pagerWaiting } from "../../src/main/ai/hub/shellAdapters";
import { installed, openShell, shellCase, type RealShell } from "./helpers/realShell";

/**
 * A command whose output goes to a pager waits for a key that nobody presses: systemctl and journalctl
 * start less by themselves (and with lines wider than the terminal it stays open even when the text
 * fits), psql does for a table wider than the terminal, git for a log, and sudo takes away any setting
 * that would have kept it shut. In the lab that left the command running until its two minutes were
 * up, and the run ended there. sshs3 presses the key a person would: q at the end of the text, and part
 * way through it first G (to the end), so that the command that writes the text is never cut off.
 */

describe("what a pager shows while it waits for a key", () => {
  it("is known at the end of the text, as less draws it", () => {
    // systemctl show, with systemd's options for less (FRSXMK) and a line wider than the terminal.
    expect(pagerWaiting("User=shop\x1b[m\r\n\x1b[7mlines 1-2/2 (END)\x1b[27m\x1b[K")).toBe("end");
    // psql under sudo: plain less, at the end of a short text.
    expect(pagerWaiting("(1 row)\r\n\r\n\x1b[7m(END)\x1b[27m\x1b[K")).toBe("end");
    expect(pagerWaiting("\x1b[7m Manual page ls(1) line 213/240 (END) (press h for help or q to quit)\x1b[27m\x1b[K")).toBe("end");
  });

  it("is known part way through the text", () => {
    expect(pagerWaiting("8\r\n9\r\n:\x1b[K")).toBe("part");
    expect(pagerWaiting("9\x1b[m\r\n\x1b[7mlines 1-9\x1b[27m\x1b[K")).toBe("part");
    expect(pagerWaiting("\x1b[7msyslog lines 1-47/1203 3%\x1b[27m\x1b[K")).toBe("part");
    expect(pagerWaiting("\x1b[7m Manual page ls(1) line 1 (press h for help or q to quit)\x1b[27m\x1b[K")).toBe("part");
    expect(pagerWaiting("8\r\n9\r\n\x1b[7m--More--\x1b[27m")).toBe("more");
    expect(pagerWaiting("\x1b[7m--More--(18%)\x1b[27m")).toBe("more");
  });

  it("is not output that only names one, or a question", () => {
    expect(pagerWaiting("(END)\r\n")).toBeUndefined();
    expect(pagerWaiting("lines 1-2/2 (END)")).toBeUndefined();
    expect(pagerWaiting("[sudo] password for ops: ")).toBeUndefined();
    expect(pagerWaiting("Do you want to continue? [Y/n] ")).toBeUndefined();
    expect(pagerWaiting("ok:\r\n")).toBeUndefined();
    expect(pagerWaiting("\x1b[7mWarning: disk almost full\x1b[27m\x1b[K")).toBeUndefined();
    expect(pagerWaiting("")).toBeUndefined();
  });
});

const disposals: Array<() => unknown> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const d of disposals.splice(0)) await d();
});

/**
 * A terminal that answers the handshake like a shell, and runs the next command into a pager: it
 * prints `first`, and answers each key with what `answer` gives (where `end(code)` is the command's
 * own end marker). The keys that reached it are in `keys`.
 */
async function withPager(first: string, answer: (key: string, end: (code?: number) => string) => string | undefined) {
  const terminals = new TerminalRegistry();
  disposals.push(() => terminals.dispose());
  const keys: string[] = [];
  let command: string | undefined;
  let armed = false;
  const end = (code = 0) => `\x1b]777;SSHS3;${command};END;${code};/home/ops\x07`;
  terminals.register({ id: "t1", label: "app-01", kind: "ssh", profileId: "p1", shell: "bash" }, (data) => {
    const nonce = /SSHS3;([a-f0-9]{32});BEGIN/.exec(data)?.[1];
    if (nonce && !armed) {
      setTimeout(() => terminals.feed("t1", `\x1b]777;SSHS3;${nonce};BEGIN\x07\x1b]777;SSHS3;${nonce};END;0;/home/ops\x07`), 2);
      return;
    }
    if (nonce) {
      command = nonce;
      setTimeout(() => terminals.feed("t1", `\x1b]777;SSHS3;${nonce};BEGIN\x07${first}`), 2);
      return;
    }
    keys.push(data);
    const reply = answer(data, end);
    if (reply !== undefined) setTimeout(() => terminals.feed("t1", reply), 2);
  });
  terminals.feed("t1", "ops@app-01:~$ ");
  await terminals.arm("t1", "bash");
  armed = true;
  const generation = terminals.get("t1")!.generation;
  terminals.claim("t1", generation, "task-1");
  vi.useFakeTimers();
  const run = (cmd: string) => terminals.execute("t1", generation, "task-1", cmd, 120_000);
  return { terminals, keys, run };
}

describe("a command whose output waits in a pager", () => {
  it("gets q at the end of the text, and ends with its own exit code and output", async () => {
    const { keys, run } = await withPager("Id=shop-api.service\x1b[m\r\n\x1b[7mlines 1-2/2 (END)\x1b[27m\x1b[K", (key, end) =>
      key === "q" ? `\r\x1b[K\x1b[?1l\x1b>${end(0)}` : undefined,
    );
    const result = run("systemctl show shop-api -p Id -p User");
    await vi.advanceTimersByTimeAsync(5_000);
    const done = await result;
    expect(keys).toEqual(["q"]);
    expect(done.exitCode).toBe(0);
    expect(done.output).toContain("Id=shop-api.service");
    expect(done.output).toMatch(/\[sshs3: the output went to a pager \(less\), which waited for a key\. sshs3 pressed q to close it once the end was shown\./);
    expect(done.output).toMatch(/--no-pager/);
  });

  it("part way through the text, goes to the end first (nothing is cut off), then closes it", async () => {
    const { keys, run } = await withPager("\x1b[?1049h\x1b[?1h\x1b=\r1\r\n2\r\n:\x1b[K", (key, end) => {
      if (key === "G") return "\r\x1b[K...skipping...\r\n299\r\n300\r\n\x1b[7m(END)\x1b[27m\x1b[K";
      if (key === "q") return `\r\x1b[K\x1b[?1l\x1b>\x1b[?1049l${end(0)}`;
      return undefined;
    });
    const result = run("seq 1 300 | less");
    await vi.advanceTimersByTimeAsync(8_000);
    const done = await result;
    expect(keys).toEqual(["G", "q"]);
    expect(done.exitCode).toBe(0);
    expect(done.output).toContain("300");
    expect(done.output).toMatch(/longer than the terminal/);
    expect(done.output).toMatch(/run the command again/);
  });

  it("in more, is paged with the space bar until more ends by itself", async () => {
    let pages = 0;
    const { keys, run } = await withPager("1\r\n2\r\n\x1b[7m--More--(40%)\x1b[27m", (key, end) => {
      if (key !== " ") return undefined;
      pages += 1;
      return pages === 1 ? "\r\x1b[K3\r\n4\r\n\x1b[7m--More--(80%)\x1b[27m" : `\r\x1b[K5\r\n${end(0)}`;
    });
    const result = run("seq 1 5 | more");
    await vi.advanceTimersByTimeAsync(8_000);
    const done = await result;
    expect(keys).toEqual([" ", " "]);
    expect(done.output).toContain("5");
    expect(done.output).toMatch(/pager \(more\)/);
  });

  it("gets q again for each pager it opens (psql with several queries)", async () => {
    let closed = 0;
    const { keys, run } = await withPager("archived_count\r\n 20\r\n\x1b[7m(END)\x1b[27m\x1b[K", (key, end) => {
      if (key !== "q") return undefined;
      closed += 1;
      return closed === 1 ? "\r\x1b[K\r\nslot_name\r\n wal\r\n\x1b[7m(END)\x1b[27m\x1b[K" : `\r\x1b[K${end(0)}`;
    });
    const result = run("sudo -u postgres psql -X -c 'TABLE pg_stat_archiver' -c 'TABLE pg_replication_slots'");
    await vi.advanceTimersByTimeAsync(8_000);
    const done = await result;
    expect(keys).toEqual(["q", "q"]);
    expect(done.output).toContain("slot_name");
  });

  it("is not pressed into when the output only names (END) and the command goes on", async () => {
    // A key typed into a command that does not read it would wait in the terminal, and run with the next command.
    const { keys, run } = await withPager("(END)\r\n", () => undefined);
    void run("echo '(END)'; sleep 30; echo fin").catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(keys).toEqual([]);
  });

  it("waits until the terminal has been quiet for a moment before it presses anything", async () => {
    const { keys, run } = await withPager("Id=shop-api.service\r\n\x1b[7m(END)\x1b[27m\x1b[K", (key, end) =>
      key === "q" ? `\r\x1b[K${end(0)}` : undefined,
    );
    const result = run("systemctl show shop-api -p Id");
    await vi.advanceTimersByTimeAsync(300);
    expect(keys).toEqual([]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(keys).toEqual(["q"]);
    await result;
  });
});

describe("a pager in a real terminal", () => {
  let shell: RealShell | undefined;
  afterEach(() => {
    shell?.close();
    shell = undefined;
  });
  // A terminal of the kind sshs3 opens: less knows how to draw in it.
  const real = () => openShell("bash", { env: { TERM: "xterm-256color" } });
  const can = installed("bash") && installed("less");
  const name = (what: string) => `${shellCase("bash")}${installed("less") ? "" : " (less not installed here: skipped)"}: ${what}`;

  it.skipIf(!can)(name("systemctl show's long line keeps less open at the end; it is closed and the command goes on"), async () => {
    shell = await real();
    const long = "x".repeat(300);
    const result = await shell.run(`printf '%s\\nUser=shop\\n' ${long} | LESS=FRSXMK less; echo after-$?`, 20_000);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("User=shop");
    expect(result.output).toContain("after-0");
    expect(result.output).toMatch(/sshs3 pressed q/);
    // The terminal is free again.
    const next = await shell.run("echo next-$((40+2))");
    expect(next.output).toContain("next-42");
  }, 30_000);

  it.skipIf(!can)(name("a long text in plain less is taken to its end, then closed"), async () => {
    shell = await real();
    const result = await shell.run("seq 1 300 | less; echo after-$?", 20_000);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("300");
    expect(result.output).toContain("after-0");
    expect(result.output).toMatch(/longer than the terminal/);
  }, 30_000);

  it.skipIf(!can)(name("each pager of a command is closed in turn, and the command's exit code is its own"), async () => {
    shell = await real();
    const result = await shell.run("sh -c 'printf \"one\\n\" | less; printf \"two\\n\" | less; echo both-done; exit 3'", 20_000);
    expect(result.exitCode).toBe(3);
    expect(result.output).toContain("both-done");
  }, 30_000);

  it.skipIf(!can)(name("output that only names (END) gets no key, and the next command runs as typed"), async () => {
    shell = await real();
    const result = await shell.run("echo '(END)'; sleep 3; echo fin", 20_000);
    expect(result.output).toContain("fin");
    expect(result.output).not.toMatch(/pager/);
    const next = await shell.run("echo next-$((40+2))");
    expect(next.exitCode).toBe(0);
    expect(next.output).toContain("next-42");
  }, 30_000);
});
