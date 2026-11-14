import { afterEach, describe, expect, it } from "vitest";
import { CommandFrames, LATE_OUTPUT_NOTE, commandEnvelope, lastVisibleLine } from "../../src/main/ai/hub/shellAdapters";
import { TerminalRegistry } from "../../src/main/ai/hub/TerminalRegistry";

/**
 * Windows' pseudo console passes a marker it does not know (sshs3's OSC 777)
 * straight through and repaints the text printed in the same burst a moment
 * later. Measured on Windows 11 with node-pty: a shell that writes
 * `BEGIN, three lines, END, prompt` in one go is delivered as
 * `BEGIN END` and then, 14 ms later, the three lines and the prompt. The
 * output of a fast command therefore arrived after its end marker and was
 * thrown away as "what follows the command".
 */

const nonce = "0123456789abcdef0123456789abcdef";
const BEGIN = `\x1b]777;SSHS3;${nonce};BEGIN\x07`;
const END = (code = 0, cwd = "/home/ops") => `\x1b]777;SSHS3;${nonce};END;${code};${cwd}\x07`;
const PROMPT = "ops@web-01:~$";
const typed = (command: string) => commandEnvelope("bash", command, nonce).replace(/\r$/, "");

const disposals: Array<() => unknown> = [];
afterEach(async () => {
  for (const d of disposals.splice(0)) await d();
});

describe("a command's frame where the terminal delivers in order", () => {
  it("ends at the end marker, with what came between the markers, as before", () => {
    const frames = new CommandFrames(nonce, 128_000, { command: "df -h", shell: "bash" });
    expect(frames.feed(`${typed("df -h")}\r\n${BEGIN}/dev/sda1 40G\r\n${END()}${PROMPT} `)).toEqual({
      output: "/dev/sda1 40G\r\n",
      exitCode: 0,
      cwd: "/home/ops",
    });
  });

  it("takes the rest of the typed line's echo out of the output when the begin marker overtook it", () => {
    // Seen in the evaluation: outputs that began with `$__sshs3_rc" "$PWD"` or `PWD"`.
    const line = typed("df -h");
    for (const cut of [line.length - 4, line.length - 20, 60, 10]) {
      const frames = new CommandFrames(nonce, 128_000, { command: "df -h", shell: "bash" });
      const result = frames.feed(`${PROMPT} ${line.slice(0, cut)}${BEGIN}${line.slice(cut)}\r\n/dev/sda1 40G\r\n${END()}`);
      expect(result?.output, `cut at ${cut}`).toBe("/dev/sda1 40G\r\n");
    }
  });

  it("takes the echo out when the terminal wrapped and repainted it", () => {
    const line = typed("systemctl status nginx --no-pager");
    const cut = 70;
    // A pseudo console breaks the line at its width and writes a space as "cursor right".
    const rest = line
      .slice(cut)
      .replace(/(.{30})/g, "$1\r\n")
      .replace(/ /g, "\x1b[1C");
    const frames = new CommandFrames(nonce, 128_000, { command: "systemctl status nginx --no-pager", shell: "bash" });
    const result = frames.feed(`${line.slice(0, cut)}${BEGIN}${rest}\r\nactive (running)\r\n${END()}`);
    expect(result?.output).toBe("active (running)\r\n");
  });

  it("leaves output alone that only looks like the typed line", () => {
    // Nothing of the echo was seen before the frame: a short output that happens to be how the line begins is output.
    const quiet = new CommandFrames(nonce, 128_000, { command: "echo p", shell: "bash" });
    expect(quiet.feed(`${BEGIN}p\r\n${END()}`)?.output).toBe("p\r\n");
    // The echo was complete before the frame: output that repeats its end is output.
    const complete = new CommandFrames(nonce, 128_000, { command: "echo x", shell: "bash" });
    expect(complete.feed(`${typed("echo x")}\r\n${BEGIN}"$__sshs3_rc" "$PWD"\r\n${END()}`)?.output).toBe('"$__sshs3_rc" "$PWD"\r\n');
    // Half an echo followed by something else: not recognised, so nothing is taken away.
    const line = typed("uptime");
    const odd = new CommandFrames(nonce, 128_000, { command: "uptime", shell: "bash" });
    expect(odd.feed(`${line.slice(0, 80)}${BEGIN}something else entirely\r\n${END()}`)?.output).toBe("something else entirely\r\n");
  });
});

describe("a command's frame where the terminal delivers text after the marker it was printed before", () => {
  const late = (prompt?: string) => ({ command: "snapmirror show", shell: "bash" as const, lateOutput: { prompt } });

  it("gives the output that came after the end marker, up to the prompt that is known", () => {
    const frames = new CommandFrames(nonce, 128_000, late(PROMPT));
    // As measured: both markers first, the text of the same burst afterwards.
    expect(frames.feed(`${typed("snapmirror show")}\r\n${BEGIN}${END()}`)).toBeUndefined();
    expect(frames.awaitingLate).toBe(true);
    const result = frames.feed(`Source  Destination  State\r\nvs1:a   vs2:a        Snapmirrored\r\n${PROMPT}\x1b[1C`);
    expect(result).toEqual({
      output: "Source  Destination  State\r\nvs1:a   vs2:a        Snapmirrored\r\n",
      exitCode: 0,
      cwd: "/home/ops",
    });
  });

  it("joins what came before the marker with the rest that came after it", () => {
    // A long output: the screens that scrolled were delivered in order, the last lines after the marker.
    const frames = new CommandFrames(nonce, 128_000, late(PROMPT));
    expect(frames.feed(`${BEGIN}line 1\r\nline 2\r${END(3)}`)).toBeUndefined();
    expect(frames.feed(`\nline 3\r\n${PROMPT} `)).toMatchObject({ output: "line 1\r\nline 2\r\nline 3\r\n", exitCode: 3 });
  });

  it("ends at once when the prompt is already there, and adds nothing to a command that printed nothing", () => {
    const frames = new CommandFrames(nonce, 128_000, late(PROMPT));
    expect(frames.feed(`${BEGIN}${END()}\r\n${PROMPT} `)).toEqual({ output: "", exitCode: 0, cwd: "/home/ops" });
    const ordered = new CommandFrames(nonce, 128_000, late(PROMPT));
    expect(ordered.feed(`${BEGIN}up 3 days\r\n${END()}${PROMPT} `)?.output).toBe("up 3 days\r\n");
  });

  it("takes the echo out when it, too, came after both markers", () => {
    const line = typed("snapmirror show");
    const frames = new CommandFrames(nonce, 128_000, late(PROMPT));
    expect(frames.feed(`${line.slice(0, 90)}${BEGIN}${END()}`)).toBeUndefined();
    expect(frames.feed(`${line.slice(90)}\r\nvs1:a Snapmirrored\r\n${PROMPT} `)?.output).toBe("vs1:a Snapmirrored\r\n");
  });

  it("does not guess where the output ends when the prompt is not the one it knows: it keeps the text and says so", () => {
    for (const known of [undefined, "ops@web-01:/etc$"]) {
      const frames = new CommandFrames(nonce, 128_000, late(known));
      expect(frames.feed(`${BEGIN}${END()}`)).toBeUndefined();
      expect(frames.feed(`vs1:a Snapmirrored\r\n[12:01] ${PROMPT} `)).toBeUndefined();
      const result = frames.settle();
      expect(result.output).toContain("vs1:a Snapmirrored");
      expect(result.output).toContain("[sshs3: late text begins here]");
      expect(result.output.endsWith(LATE_OUTPUT_NOTE)).toBe(true);
    }
  });

  it("takes the known prompt off output that did not end in a line break, and adds no note: the text is all accounted for", () => {
    // As seen on app-01 in the third round: JSON from curl, and the shell's prompt right after it.
    const frames = new CommandFrames(nonce, 128_000, late("ops@app-01:~$"));
    expect(frames.feed(`${typed("curl -s localhost/health")}\r\n${BEGIN}${END()}`)).toBeUndefined();
    const result = frames.feed(`{"status":"UP","components":{"db":{"status":"UP"}}}\x1b]0;ops@app-01: ~\x07\x1b[01;32mops@app-01\x1b[00m:\x1b[01;34m~\x1b[00m$ `);
    expect(result).toEqual({ output: '{"status":"UP","components":{"db":{"status":"UP"}}}', exitCode: 0, cwd: "/home/ops" });
    expect(result!.output).not.toContain("[sshs3:");
    // Settled later, by the caller, it reads the same.
    const settled = new CommandFrames(nonce, 128_000, late("ops@app-01:~$"));
    settled.feed(`${BEGIN}${END()}`);
    settled.feed(`printed without a newline ops@app-01:~$ `);
    expect(settled.settle().output).toBe("printed without a newline");
  });

  it("does not take a bare sign for a prompt glued to the output: a line may end in $ or #", () => {
    const frames = new CommandFrames(nonce, 128_000, late("$"));
    expect(frames.feed(`${BEGIN}${END()}`)).toBeUndefined();
    expect(frames.feed(`PATH contains $`)).toBeUndefined();
    const result = frames.settle();
    expect(result.output).toContain("PATH contains $");
    expect(result.output).toContain("[sshs3: late text begins here]");
  });

  it("adds no note when nothing came after the marker", () => {
    const frames = new CommandFrames(nonce, 128_000, late(undefined));
    expect(frames.feed(`${BEGIN}done\r\n${END()}`)).toBeUndefined();
    expect(frames.settle()).toEqual({ output: "done\r\n", exitCode: 0, cwd: "/home/ops" });
  });

  it("learns the prompt from a handshake, which prints nothing, whatever arrived around it", () => {
    const hello = new CommandFrames(nonce, 128_000, { command: ":", shell: "bash", handshake: true, lateOutput: {} });
    // Typed into a connection that was still being made: the banner, the first prompt and the echo all come after the markers.
    expect(hello.feed(`${BEGIN}${END()}`)).toBeUndefined();
    expect(hello.feed(`Welcome to Ubuntu 24.04\r\n\r\n${PROMPT} ${typed(":")}\r\n\x1b]0;ops@web-01: ~\x07${PROMPT}\x1b[1C`)).toBeUndefined();
    expect(hello.promptSeen()).toBe(PROMPT);
    expect(hello.settle()).toMatchObject({ exitCode: 0 });
    expect(lastVisibleLine(`a\r\n\x1b[1;32mops@web-01\x1b[0m:~$ \r\n\r\n`)).toBe(PROMPT);
  });

  it("does not wait where the output comes in frames of its own", () => {
    const frames = new CommandFrames(nonce, 128_000, { command: "Get-Date", shell: "pwsh", lateOutput: {} });
    const data = Buffer.from("Friday\n", "utf8").toString("base64");
    expect(frames.feed(`${BEGIN}\x1b]777;SSHS3;${nonce};DATA;${data}\x07${END()}`)).toEqual({ output: "Friday\n", exitCode: 0, cwd: "/home/ops" });
  });
});

describe("a terminal that delivers late, as the registry runs commands in it", () => {
  function terminal(answer: (n: string, command: string) => string[]) {
    const registry = new TerminalRegistry({ lateOutput: true });
    disposals.push(() => registry.dispose());
    registry.register({ id: "t", label: "netapp-aff-01", kind: "ssh" }, (data) => {
      const n = /SSHS3;([a-f0-9]{32});BEGIN/.exec(data)?.[1];
      if (!n) return;
      const command = /\(eval '([^']*)'\)/.exec(data)?.[1] ?? "";
      // Each piece is a delivery of its own, as the pseudo console makes them.
      answer(n, command).forEach((piece, i) => setTimeout(() => registry.feed("t", piece), 5 * (i + 1)));
    });
    return registry;
  }
  const b = (n: string) => `\x1b]777;SSHS3;${n};BEGIN\x07`;
  const e = (n: string, code = 0) => `\x1b]777;SSHS3;${n};END;${code};/home/ops\x07`;

  it("returns the output of a command whose text came after its end marker", async () => {
    const registry = terminal((n, command) =>
      command === ":"
        ? [`${b(n)}${e(n)}`, `\r\n${PROMPT} `]
        : [`${b(n)}${e(n)}`, `Source Destination State\r\nvs1:a vs2:a Snapmirrored\r\n${PROMPT}\x1b[1C`],
    );
    await registry.arm("t", "bash");
    const session = registry.get("t")!;
    registry.claim("t", session.generation, "run");
    const result = await registry.execute("t", session.generation, "run", "snapmirror show");
    expect(result.output).toBe("Source Destination State\r\nvs1:a vs2:a Snapmirrored\r\n");
    expect(result.exitCode).toBe(0);
    expect(registry.get("t")!.state).toBe("ready");
  });

  it("closes the frame by itself when no prompt comes, with what did come", async () => {
    const registry = terminal((n, command) => (command === ":" ? [`${b(n)}${e(n)}`] : [`${b(n)}${e(n, 2)}`, "No such volume\r\n"]));
    await registry.arm("t", "bash");
    const session = registry.get("t")!;
    registry.claim("t", session.generation, "run");
    const result = await registry.execute("t", session.generation, "run", "volume show -volume nope");
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("No such volume");
    expect(result.output).toContain(LATE_OUTPUT_NOTE);
  });

  it("is not used for a stream that is no pseudo console, nor where the registry was not told of one", async () => {
    const plain = new TerminalRegistry();
    disposals.push(() => plain.dispose());
    plain.register({ id: "t", label: "host", kind: "ssh" }, (data) => {
      const n = /SSHS3;([a-f0-9]{32});BEGIN/.exec(data)?.[1];
      // Answered within the same turn: a frame that waited for late text could not have ended yet.
      if (n) queueMicrotask(() => plain.feed("t", `${b(n)}ok\r\n${e(n)}`));
    });
    const armed = plain.arm("t", "bash");
    await Promise.resolve();
    await Promise.resolve();
    expect(plain.get("t")!.state).toBe("ready");
    await armed;
  });
});

describe("a terminal the hub opened for itself", () => {
  it("is connected to only once its prompt is there", async () => {
    const registry = new TerminalRegistry();
    disposals.push(() => registry.dispose());
    const typedInto: string[] = [];
    registry.register({ id: "t", label: "app-01", kind: "ssh" }, (data) => {
      typedInto.push(data);
      const n = /SSHS3;([a-f0-9]{32});BEGIN/.exec(data)?.[1];
      if (n) queueMicrotask(() => registry.feed("t", `\x1b]777;SSHS3;${n};BEGIN\x07\x1b]777;SSHS3;${n};END;0;/home/ops\x07`));
    });
    const armed = registry.armAtPrompt("t", "bash", 5000);
    await new Promise((r) => setTimeout(r, 200));
    // Still connecting: nothing has been typed into it.
    expect(typedInto).toHaveLength(0);
    registry.feed("t", "Welcome to Ubuntu\r\n");
    await new Promise((r) => setTimeout(r, 120));
    expect(typedInto).toHaveLength(0);
    registry.feed("t", "ops@app-01:~$ ");
    await armed;
    expect(typedInto).toHaveLength(1);
    expect(registry.get("t")).toMatchObject({ state: "ready", shell: "bash" });
  });

  it("takes a prompt of a shape it does not know once the terminal has been quiet for a while", async () => {
    const registry = new TerminalRegistry();
    disposals.push(() => registry.dispose());
    registry.register({ id: "t", label: "dev", kind: "ssh" }, () => undefined);
    registry.feed("t", "Last login: Fri Nov 13\r\n➜  ~ ");
    const started = Date.now();
    await registry.whenAtPrompt("t", 5000, 50, 400);
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
  });

  it("says what the terminal last showed when no prompt comes, and when the connection ends", async () => {
    const registry = new TerminalRegistry();
    disposals.push(() => registry.dispose());
    registry.register({ id: "silent", label: "app-01", kind: "ssh" }, () => undefined);
    await expect(registry.armAtPrompt("silent", "bash", 150)).rejects.toThrow(/No shell prompt within 0 seconds\. The terminal showed nothing\./);
    registry.register({ id: "asking", label: "app-01", kind: "ssh" }, () => undefined);
    registry.feed("asking", "ops@app-01's password: ");
    await expect(registry.armAtPrompt("asking", "bash", 150)).rejects.toThrow(/The terminal last showed: ops@app-01's password:/);
    registry.register({ id: "refused", label: "app-01", kind: "ssh" }, () => undefined);
    registry.feed("refused", "ops@app-01: Permission denied (publickey).\r\n");
    const waiting = registry.armAtPrompt("refused", "bash", 5000);
    registry.invalidate("refused", "ssh exited", true);
    await expect(waiting).rejects.toThrow(/The connection ended before a shell prompt came\. It last showed: ops@app-01: Permission denied \(publickey\)\./);
  });

  it("tells an id that names nothing from a terminal whose connection ended", () => {
    const registry = new TerminalRegistry();
    disposals.push(() => registry.dispose());
    expect(() => registry.takeover("nope")).toThrow(/No such terminal/);
    registry.register({ id: "gone", label: "x", kind: "ssh" }, () => undefined);
    registry.invalidate("gone", "ssh exited", true);
    expect(() => registry.takeover("gone")).toThrow("Terminal is disconnected");
  });
});
