import { afterEach, describe, expect, it, vi } from "vitest";
import { STILL_RUNNING, TerminalRegistry } from "../../src/main/ai/hub/TerminalRegistry";
import { ToolBroker } from "../../src/main/ai/hub/ToolBroker";
import type { AgentTask } from "../../src/shared/types/aiHub";
import { installed, openShell, shellCase, type RealShell } from "./helpers/realShell";

/**
 * A command that ran out of time may still be running: a question for a password, a pager, a long
 * job. Nothing is typed into its terminal until that command has been seen to end: its own end
 * marker, the shell's prompt marker, or a person connecting the terminal again. A line that only
 * looks like a prompt is not enough.
 */

const disposals: Array<() => unknown> = [];
afterEach(async () => {
  for (const d of disposals.splice(0)) await d();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A terminal that answers every command like a shell (it begins and ends at once), except the next
 * one after `hang(text)`: that one begins, prints the text and never ends.
 */
function fake() {
  const terminals = new TerminalRegistry();
  disposals.push(() => terminals.dispose());
  const written: string[] = [];
  let hanging: string | undefined;
  let hung = "";
  terminals.register({ id: "t1", label: "web-01", kind: "ssh", profileId: "p1", shell: "bash" }, (data) => {
    written.push(data);
    const nonce = /SSHS3;([a-f0-9]{32});BEGIN/.exec(data)?.[1];
    if (!nonce) return;
    const begin = `\x1b]777;SSHS3;${nonce};BEGIN\x07`;
    if (hanging !== undefined) {
      const text = hanging;
      hanging = undefined;
      hung = nonce;
      setTimeout(() => terminals.feed("t1", begin + text), 2);
    } else setTimeout(() => terminals.feed("t1", `${begin}\x1b]777;SSHS3;${nonce};END;0;/home/ops\x07`), 2);
  });
  return {
    terminals,
    written,
    hang: (text: string) => void (hanging = text),
    /** The end marker the shell prints when the command that hung is over. */
    endOfHung: (code = 0) => `\x1b]777;SSHS3;${hung};END;${code};/home/ops\x07`,
  };
}

async function claimed(terminals: TerminalRegistry): Promise<string> {
  terminals.feed("t1", "ops@web-01:~$ ");
  await terminals.arm("t1", "bash");
  const generation = terminals.get("t1")!.generation;
  terminals.claim("t1", generation, "task-1");
  return generation;
}

describe("a terminal whose command was stopped before sshs3 saw it end", () => {
  // Found by an exploring tester: after Stop sent ^C, the terminal never became ready again. Its
  // command's end marker never came, the shell sends no prompt markers, and a person had no way to
  // connect it again, though the docs say a person connects it by hand.
  it("is said to be waiting, and is used again once a person says so at a shell prompt", async () => {
    const { terminals, written, hang } = fake();
    const generation = await claimed(terminals);
    hang("tick-1\r\n");
    await terminals.execute("t1", generation, "task-1", "for i in 1 2 3; do echo tick-$i; sleep 5; done", 60).catch(() => undefined);
    // Stopped: ^C, and the shell's own prompt is back. No end marker comes for the stopped command.
    terminals.feed("t1", "^C\r\nops@web-01:~$ ");
    await expect(terminals.ensureReady("t1")).rejects.toThrow(STILL_RUNNING);
    expect(terminals.list().find((t) => t.id === "t1")).toMatchObject({ unsettled: true });

    const before = written.length;
    terminals.settleByPerson("t1");
    expect(terminals.list().find((t) => t.id === "t1")?.unsettled).toBeFalsy();
    await expect(terminals.ensureReady("t1")).resolves.toMatchObject({ state: "ready" });
    expect(written.length).toBe(before + 1);
  });

  it("is not used again on a person's word while it shows a question for a password", async () => {
    const { terminals, hang } = fake();
    const generation = await claimed(terminals);
    hang("[sudo] password for ops: ");
    await terminals.execute("t1", generation, "task-1", "sudo systemctl restart nginx", 60).catch(() => undefined);
    expect(() => terminals.settleByPerson("t1")).toThrow(/asks for a password/);
    await expect(terminals.ensureReady("t1")).rejects.toThrow(STILL_RUNNING);
  });
});

describe("after a command ran out of time", () => {
  it("leaves the command running, says so, and types nothing more until it has ended", async () => {
    // sudo asks for a password and nothing answers it.
    const { terminals, written, hang, endOfHung } = fake();
    const generation = await claimed(terminals);
    hang("[sudo] password for ops: ");
    const outcome = await terminals.execute("t1", generation, "task-1", "sudo systemctl restart nginx", 60).then(
      () => "resolved",
      (e: Error) => e.message,
    );
    expect(outcome).toMatch(/did not finish within 1 seconds/);
    expect(outcome).toMatch(/It was left running in this terminal: sshs3 does not stop a command by itself/);
    expect(outcome).toMatch(/Nothing more is typed there until it has ended/);
    expect(outcome).toMatch(/It last showed: \[sudo\] password for ops:/);
    // Nothing was pressed for the person: a long job cut off part way can leave more broken than a slow one.
    expect(written).not.toContain("\x03");
    expect(terminals.get("t1")!.state).toBe("unknown");

    // The next tool call connects again: it is refused, and nothing is typed at the password prompt.
    const before = written.length;
    await expect(terminals.ensureReady("t1")).rejects.toThrow(STILL_RUNNING);
    expect(written).toHaveLength(before);

    // Text that is no prompt does not open the terminal either.
    terminals.feed("t1", "\r\nSorry, try again.\r\n[sudo] password for ops: ");
    await expect(terminals.ensureReady("t1")).rejects.toThrow(STILL_RUNNING);
    expect(written).toHaveLength(before);

    // Once the command is over (its shell prints its end marker), the terminal is connected to as before.
    terminals.feed("t1", `\r\nsudo: 3 incorrect password attempts\r\n${endOfHung(1)}ops@web-01:~$ `);
    await expect(terminals.ensureReady("t1")).resolves.toMatchObject({ state: "ready" });
    expect(written.length).toBe(before + 1);
  });

  it("does not take a line that only looks like a prompt for one: nothing is typed into the program", async () => {
    // A long job shows its progress in percent, then asks for a password. Both lines end the way a
    // prompt ends ("%", "$ ", "> "), and the program is still reading the terminal.
    const { terminals, written, hang, endOfHung } = fake();
    const generation = await claimed(terminals);
    hang("/dev/vg0/data: Moved: 45.0%");
    await terminals.execute("t1", generation, "task-1", "sudo pvmove /dev/sdb1", 60).catch(() => undefined);
    const before = written.length;
    for (const looksLikeAPrompt of ["\r/dev/vg0/data: Moved: 95.0%", "\r\nops@web-01:~$ ", "\r\nContinue? > "]) {
      terminals.feed("t1", looksLikeAPrompt);
      await expect(terminals.ensureReady("t1")).rejects.toThrow(STILL_RUNNING);
    }
    expect(written).toHaveLength(before);
    // An end marker of another command, or one written by a program that does not know the secret, opens nothing.
    terminals.feed("t1", "\x1b]777;SSHS3;00000000000000000000000000000000;END;0;/home/ops\x07ops@web-01:~$ ");
    await expect(terminals.ensureReady("t1")).rejects.toThrow(STILL_RUNNING);
    expect(written).toHaveLength(before);
    // The command's own end marker, here in two pieces, does.
    const end = endOfHung(0);
    terminals.feed("t1", end.slice(0, 20));
    await expect(terminals.ensureReady("t1")).rejects.toThrow(STILL_RUNNING);
    terminals.feed("t1", `${end.slice(20)}ops@web-01:~$ `);
    await expect(terminals.ensureReady("t1")).resolves.toMatchObject({ state: "ready" });
  });

  it("does not take the end marker for a prompt when a person typed ahead while the command ran", async () => {
    // The person typed `cat > notes` while the long job ran. The shell runs it as soon as the job is over,
    // so after the end marker it is `cat` that reads the terminal, not the shell.
    const { terminals, written, hang, endOfHung } = fake();
    const generation = await claimed(terminals);
    hang("Unpacking nginx (1.24.0-2) ...\r\n");
    await terminals.execute("t1", generation, "task-1", "sudo apt-get -y upgrade", 60).catch(() => undefined);
    terminals.observeHumanInput("t1", "cat > notes\r");
    terminals.feed("t1", `Setting up nginx ...\r\n${endOfHung(0)}ops@web-01:~$ cat > notes\r\n`);
    const before = written.length;
    // Nothing reads as a prompt, so nothing is typed: the terminal is not taken to be at its shell.
    await expect(terminals.ensureReady("t1")).rejects.toThrow(/not at a shell prompt/);
    expect(written).toHaveLength(before);
  });

  it("is opened again by the shell's own prompt marker, where the shell sends one", async () => {
    // A person pressed Ctrl-C: the shell drops the rest of the line, so no end marker comes. A shell
    // with prompt markers (OSC 133) says by itself that its prompt is back.
    const { terminals, hang } = fake();
    const generation = await claimed(terminals);
    hang("[sudo] password for ops: ");
    await terminals.execute("t1", generation, "task-1", "sudo systemctl restart nginx", 60).catch(() => undefined);
    terminals.feed("t1", "^C\r\n");
    await expect(terminals.ensureReady("t1")).rejects.toThrow(STILL_RUNNING);
    terminals.feed("t1", "\x1b]133;D;130\x07\x1b]133;A\x07ops@web-01:~$ \x1b]133;B\x07");
    await expect(terminals.ensureReady("t1")).resolves.toMatchObject({ state: "ready" });
  });

  it("opens the terminal again once the long job has ended", async () => {
    const { terminals, written, hang, endOfHung } = fake();
    const generation = await claimed(terminals);
    hang("Unpacking nginx (1.24.0-2) ...\r\n");
    const outcome = await terminals.execute("t1", generation, "task-1", "sudo apt-get -y upgrade", 60).then(
      () => "resolved",
      (e: Error) => e.message,
    );
    expect(outcome).toMatch(/It was left running in this terminal/);
    expect(written).not.toContain("\x03");
    // The job is still at work: what it prints is no prompt.
    terminals.feed("t1", "Setting up nginx (1.24.0-2) ...\r\n");
    await expect(terminals.ensureReady("t1")).rejects.toThrow(STILL_RUNNING);
    // It ends by itself: its shell prints its end marker and shows its prompt.
    terminals.feed("t1", `Processing triggers for man-db ...\r\n${endOfHung(0)}ops@web-01:~$ `);
    await expect(terminals.ensureReady("t1")).resolves.toMatchObject({ state: "ready" });
  });

  it("shows the person the question whole while the command waits, and holds nothing back for later", async () => {
    const { terminals, hang } = fake();
    const generation = await claimed(terminals);
    const drawn: string[] = [];
    terminals.on("output", (_id: string, text: string) => drawn.push(text));
    hang("[sudo] password for ops: ");
    await terminals.execute("t1", generation, "task-1", "sudo systemctl restart nginx", 60).catch(() => undefined);
    // The question reads whole while it waits (the frame used to hold its last 8 characters back).
    expect(drawn.join("")).toMatch(/\[sudo\] password for ops: $/);
    // What comes next is shown as it is: nothing was left to come with it.
    expect(terminals.feed("t1", "\r\n")).toBe("\r\n");
  });

  it("does not take the prompt shown before the command for a prompt now, after a person took the terminal back", async () => {
    // A pager: it shows a page and waits. The person presses a key, which hands the terminal back.
    const { terminals, written, hang, endOfHung } = fake();
    const generation = await claimed(terminals);
    hang("line 1\r\nline 2\r\n");
    const run = terminals.execute("t1", generation, "task-1", "journalctl -u nginx", 60_000).catch((e: Error) => e.message);
    await sleep(20);
    terminals.observeHumanInput("t1", " ");
    expect(await run).toMatch(/Control returned to the user/);
    const before = written.length;
    await expect(terminals.ensureReady("t1")).rejects.toThrow(STILL_RUNNING);
    expect(written).toHaveLength(before);
    // The person quits the pager; the command is over and the shell's prompt is shown.
    terminals.feed("t1", `\r\n${endOfHung(0)}ops@web-01:~$ `);
    await expect(terminals.ensureReady("t1")).resolves.toMatchObject({ state: "ready" });
  });

  it("lets a person connect by hand, and takes the shell's answer as proof that it is back", async () => {
    const { terminals, written, hang } = fake();
    const generation = await claimed(terminals);
    hang("(END)");
    await terminals.execute("t1", generation, "task-1", "less /var/log/syslog", 60).catch(() => undefined);
    await expect(terminals.ensureReady("t1")).rejects.toThrow(STILL_RUNNING);
    // "Connect at prompt": the person looked at the terminal. The handshake is answered.
    await terminals.arm("t1", "bash");
    expect(terminals.get("t1")!.state).toBe("ready");
    expect(written).not.toContain("\x03");
  });

  it("a handshake that gets no answer says so plainly", async () => {
    const terminals = new TerminalRegistry();
    disposals.push(() => terminals.dispose());
    const written: string[] = [];
    terminals.register({ id: "t1", label: "web-01", kind: "ssh", shell: "bash" }, (data) => written.push(data));
    terminals.feed("t1", "ops@web-01:~$ ");
    const generation = terminals.get("t1")!.generation;
    // The handshake's own short wait is not waited out here: the same path, with a short time.
    (terminals as unknown as { sessions: Map<string, { view: { state: string } }> }).sessions.get("t1")!.view.state = "ready";
    await expect(terminals.execute("t1", generation, "__handshake__", ":", 40, true)).rejects.toThrow("no shell answered within 1 seconds");
    expect(written.filter((w) => w === "\x03")).toHaveLength(0);
  });
});

describe("what the agent is told when a change's command ran out of time", () => {
  it("is told that it ran out of time and what was done, and then that nothing was taken back", async () => {
    const { terminals, hang } = fake();
    const generation = await claimed(terminals);
    const task: AgentTask = {
      id: "task-1",
      title: "change",
      mode: "autonomous",
      status: "running",
      messages: [],
      changes: [],
      sources: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      maxCommands: 20,
      maxMinutes: 5,
      verification: "not-verified",
      target: { sessionId: "t1", generation, label: "web-01" },
    };
    const broker = new ToolBroker(terminals, { context: async () => ({}), memory: async () => [], file: async () => ({}), changed: vi.fn() });
    disposals.unshift(() => broker.dispose());
    const capability = await broker.issue(task);
    // The check before the change answers; the change itself asks for a password and hangs.
    const execute = terminals.execute.bind(terminals);
    let calls = 0;
    vi.spyOn(terminals, "execute").mockImplementation((id, gen, owner, command) => {
      if (++calls === 2) hang("[sudo] password for ops: ");
      return execute(id, gen, owner, command, calls === 2 ? 60 : 5000);
    });
    const outcome = await broker
      .invoke(capability.key, {
        action: "change",
        command: "sudo systemctl restart nginx",
        check: { command: "systemctl is-active nginx", expected: "active" },
        rollback: "sudo systemctl stop nginx",
      })
      .then(
        () => "resolved",
        (e: Error) => e.message,
      );
    expect(outcome).toMatch(/did not finish within 1 seconds/);
    expect(outcome).toMatch(/was left running in this terminal/);
    expect(outcome).toMatch(/The rollback was not run: The run no longer controls the original terminal\./);
    expect(task.changes[0]).toMatchObject({ status: "uncertain", rollback: { skipped: "The run no longer controls the original terminal." } });
    expect(task.changes[0].output).toMatch(/was left running/);
  });
});

describe("after a command ran out of time, in a real shell", () => {
  let shell: RealShell | undefined;
  afterEach(() => {
    shell?.close();
    shell = undefined;
  });

  for (const kind of ["bash", "dash"] as const) {
    it.skipIf(!installed(kind))(`${shellCase(kind)}: a command over its time is left to finish, and the terminal stays closed until it has`, async () => {
      shell = await openShell(kind);
      // A job that takes longer than it was given and leaves a mark when it is done.
      const outcome = await shell.run("sleep 2; echo job-done-$((40+2))", 300).then(
        () => "resolved",
        (e: Error) => e.message,
      );
      expect(outcome).toMatch(/It was left running in this terminal: sshs3 does not stop a command by itself/);
      const before = shell.transcript().length;
      await expect(shell.registry.ensureReady("real")).rejects.toThrow(STILL_RUNNING);
      // Nothing was typed into the terminal while the job ran.
      await sleep(200);
      expect(shell.transcript().slice(before)).not.toMatch(/SSHS3/);
      // The job ends by itself: it was not cut off. Then the prompt is back and the terminal is used again.
      // Tried until then: a try that is refused types nothing.
      await vi.waitFor(() => shell!.reconnect(), { timeout: 20_000, interval: 250 });
      expect(shell.transcript()).toContain("job-done-42");
      const next = await shell.run("echo after-$((40+2))");
      expect(next.exitCode).toBe(0);
      expect(next.output).toContain("after-42");
    }, 30_000);
  }

  it.skipIf(!installed("bash"))(`${shellCase("bash")}: a prompt of a shape sshs3 does not read is no obstacle once the command has ended`, async () => {
    // oh-my-zsh's default theme shows "➜  folder ": nothing a prompt is read by. The end marker is enough.
    shell = await openShell("bash");
    shell.type("PS1='➜  \\W '\r");
    await vi.waitFor(() => expect(shell!.transcript()).toMatch(/➜ {2}\S+ $/), { timeout: 5_000 });
    const outcome = await shell.run("sleep 1; echo done-$((40+2))", 300).then(
      () => "resolved",
      (e: Error) => e.message,
    );
    expect(outcome).toMatch(/It was left running in this terminal/);
    await vi.waitFor(() => shell!.reconnect(), { timeout: 15_000, interval: 250 });
    expect(shell.transcript()).toContain("done-42");
    const next = await shell.run("echo again");
    expect(next.output).toContain("again");
  }, 30_000);

  it.skipIf(!installed("bash"))(`${shellCase("bash")}: a progress line that ends in % does not get the handshake typed into the program after it`, async () => {
    shell = await openShell("bash");
    // The job reports progress in percent, then asks for a password and keeps what it reads.
    const job =
      "i=0; while [ $i -lt 8 ]; do printf '\\rMoved: %d.0%%' $((i*10)); i=$((i+1)); sleep 0.2; done; " +
      "printf '\\nNew password: '; IFS= read -r pw; echo; echo \"read:[$pw]\"";
    await shell.run(job, 300).catch(() => undefined);
    // While the progress line shows, the next tool call is refused and nothing is typed.
    await sleep(300);
    const before = shell.transcript().length;
    await expect(shell.registry.ensureReady("real")).rejects.toThrow(STILL_RUNNING);
    await sleep(200);
    expect(shell.transcript().slice(before)).not.toMatch(/SSHS3/);
    // The person answers the question; the job ends; the terminal is free again.
    await vi.waitFor(() => expect(shell!.transcript()).toContain("New password: "), { timeout: 10_000 });
    shell.type("s3cret\r");
    await vi.waitFor(() => shell!.reconnect(), { timeout: 10_000, interval: 250 });
    expect(shell.transcript()).toContain("read:[s3cret]");
  }, 30_000);

  it.skipIf(!installed("bash"))(`${shellCase("bash")}: a program that waits for a key keeps the terminal closed until it has ended`, async () => {
    shell = await openShell("bash");
    // Reads from the terminal, as a pager or a question for a password does.
    const outcome = await shell.run("read -r -t 3 line; echo got:$line", 300).then(
      () => "resolved",
      (e: Error) => e.message,
    );
    expect(outcome).toMatch(/It was left running in this terminal/);
    const before = shell.transcript().length;
    await expect(shell.registry.ensureReady("real")).rejects.toThrow(STILL_RUNNING);
    // Nothing was typed into the waiting program: the terminal echoed nothing new.
    await sleep(200);
    expect(shell.transcript().slice(before)).not.toMatch(/SSHS3/);
    await vi.waitFor(() => shell!.reconnect(), { timeout: 20_000, interval: 250 });
    const next = await shell.run("echo again");
    expect(next.output).toContain("again");
  }, 30_000);
});
