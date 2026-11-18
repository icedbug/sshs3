import { afterEach, describe, expect, it } from "vitest";
import { detectShellFromHint } from "../../src/main/ai/hub/shellAdapters";
import { TerminalRegistry } from "../../src/main/ai/hub/TerminalRegistry";

/**
 * Which shell a terminal runs is read from what it shows and what it was started with. Its name is
 * what a person called it, and counts only where a tab is named after its program.
 */

const registries: TerminalRegistry[] = [];
afterEach(() => {
  for (const r of registries.splice(0)) r.dispose();
});

describe("guessing a terminal's shell", () => {
  it("does not take a server's name for a Windows shell", () => {
    expect(detectShellFromHint({ label: "cmd-gateway-01", kind: "ssh", platform: "linux" })).toBe("bash");
    expect(detectShellFromHint({ label: "powershell-build-agent", kind: "ssh", platform: "win32" })).toBe("bash");
    expect(detectShellFromHint({ label: "pwsh-runner", kind: "k8s", platform: "linux" })).toBe("bash");
    // A local tab on Linux or macOS is no Windows shell either, whatever it is called.
    expect(detectShellFromHint({ label: "Local cmd", kind: "local", platform: "linux" })).toBe("bash");
    expect(detectShellFromHint({ label: "PowerShell notes", kind: "local", platform: "darwin" })).toBe("bash");
  });

  it("takes a local tab's name on Windows, where the tab is named after its shell", () => {
    expect(detectShellFromHint({ label: "PowerShell", kind: "local", platform: "win32" })).toBe("powershell");
    expect(detectShellFromHint({ label: "pwsh", kind: "local", platform: "win32" })).toBe("pwsh");
    expect(detectShellFromHint({ label: "Local cmd", kind: "local", platform: "win32" })).toBe("cmd");
    expect(detectShellFromHint({ label: "Terminal", kind: "local", platform: "win32" })).toBe("cmd");
  });

  it("does not take a server's name for fish, and does take a local tab's", () => {
    expect(detectShellFromHint({ label: "fish-market-db", kind: "ssh" })).toBe("bash");
    expect(detectShellFromHint({ label: "fish", kind: "local", platform: "linux" })).toBe("fish");
  });

  it("still reads what the terminal shows and what it was started with, wherever it is", () => {
    expect(detectShellFromHint({ label: "win-jump-01", output: "Windows PowerShell\r\nPS C:\\Users\\ops> ", kind: "ssh" })).toBe("powershell");
    expect(detectShellFromHint({ label: "win-jump-01", output: "C:\\Users\\ops>", kind: "ssh" })).toBe("cmd");
    expect(detectShellFromHint({ shellBinary: "/usr/bin/fish", kind: "ssh" })).toBe("fish");
    expect(detectShellFromHint({ label: "zsh (prod)", kind: "ssh" })).toBe("zsh");
    // What somebody chose is never second-guessed.
    expect(detectShellFromHint({ shell: "cmd", label: "anything", kind: "ssh" })).toBe("cmd");
  });

  it("does not keep a guess the terminal did not answer to", async () => {
    const terminals = new TerminalRegistry();
    registries.push(terminals);
    // A terminal that takes what is typed into it and says nothing back.
    terminals.register({ id: "t", kind: "ssh", label: "app-01" }, () => {});
    terminals.feed("t", "ops@app-01:~$ ");
    // The handshake is given up, and the guess with it.
    const quick = terminals as unknown as { execute: TerminalRegistry["execute"] };
    const real = quick.execute.bind(terminals);
    quick.execute = (id, generation, owner, command, _timeout, handshake) => real(id, generation, owner, command, 40, handshake);
    await expect(terminals.ensureReady("t")).rejects.toThrow("did not answer like a bash shell");
    expect(terminals.get("t")?.shell).toBeUndefined();
    expect(terminals.get("t")?.state).not.toBe("ready");
  });
});
