import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { spawn, type IPty } from "node-pty";
import { TerminalRegistry } from "../../src/main/ai/hub/TerminalRegistry";
import type { ShellKind } from "../../src/shared/types/aiHub";
const enabled = process.env.SSHS3_SHELL_INTEGRATION === "1";
function hasBinary(bin: string): boolean {
  const res = spawnSync(
    process.platform === "win32" ? "where.exe" : "which",
    [bin],
    { stdio: "ignore" },
  );
  return res.status === 0;
}
describe.skipIf(!enabled)("actual PTY adapters", () => {
  const candidateShells: ShellKind[] =
    process.platform === "win32"
      ? ["powershell", "pwsh", "cmd"]
      : ["bash", "sh", "dash", "zsh", "fish"];
  const shells = candidateShells.filter((s) =>
    hasBinary(
      s === "powershell"
        ? "powershell.exe"
        : s === "cmd"
          ? "cmd.exe"
          : s === "pwsh" && process.platform === "win32"
            ? "pwsh.exe"
            : s,
    ),
  );
  it.each(shells)(
    "%s: success, failure, multiline, cwd, large output, takeover",
    async (shell) => {
      const program =
        shell === "powershell"
          ? "powershell.exe"
          : shell === "cmd"
            ? "cmd.exe"
            : shell === "pwsh" && process.platform === "win32"
              ? "pwsh.exe"
              : shell;
      const args =
        shell === "powershell" || shell === "pwsh"
          ? [
              "-NoLogo",
              "-NoProfile",
              "-NoExit",
              "-Command",
              "Set-PSReadLineOption -HistorySaveStyle SaveNothing",
            ]
          : shell === "cmd"
            ? ["/Q", "/D"]
            : [];
      const terminal: IPty = spawn(program, args, {
        cols: 200,
        rows: 40,
        env: process.env,
      });
      const registry = new TerminalRegistry();
      registry.register({ id: "test", label: shell, kind: "local" }, (data) =>
        terminal.write(data),
      );
      let transcript = "";
      const data = terminal.onData((chunk) => {
        transcript += chunk;
        registry.feed("test", chunk);
      });
      try {
        await new Promise((resolve) => setTimeout(resolve, 1800));
        await registry.arm("test", shell);
        const generation = registry.get("test")!.generation;
        registry.claim("test", generation, "task");
        const run = (command: string) =>
          registry.execute("test", generation, "task", command, 15000);
        const success = await run(
          shell === "powershell" || shell === "pwsh"
            ? "Write-Output 'alpha'\nWrite-Output 'beta'"
            : shell === "cmd"
              ? "echo alpha\necho beta"
              : "printf 'alpha\\nbeta\\n'",
        );
        expect(success.exitCode).toBe(0);
        expect(success.output).toContain("alpha");
        expect(success.output).toContain("beta");
        expect(success.output).not.toContain("The batch file cannot be found");
        expect(
          (
            await run(
              shell === "powershell" || shell === "pwsh"
                ? "cmd /c exit 7"
                : shell === "cmd"
                  ? "cmd /c exit 7"
                  : 'sh -c "exit 7"',
            )
          ).exitCode,
        ).toBe(7);
        expect(
          (
            await run(
              shell === "powershell" || shell === "pwsh"
                ? "Set-Location $env:TEMP"
                : shell === "cmd"
                  ? 'cd /d "%TEMP%"'
                  : "cd /tmp",
            )
          ).cwd.toLowerCase(),
        ).toContain(process.platform === "win32" ? "temp" : "/tmp");
        expect(
          (
            await run(
              shell === "powershell" || shell === "pwsh"
                ? "'x' * 50000"
                : shell === "cmd"
                  ? "for /L %%i in (1,1,3000) do @echo abcdefghijklmnopqrstuvwxyz"
                  : "yes x | head -n 10000",
            )
          ).output.length,
        ).toBeGreaterThan(10000);
        const pending = run(
          shell === "powershell" || shell === "pwsh"
            ? "Start-Sleep -Seconds 20"
            : shell === "cmd"
              ? "ping -n 20 127.0.0.1 >nul"
              : "sleep 20",
        );
        const rejected = expect(pending).rejects.toThrow();
        await new Promise((resolve) => setTimeout(resolve, 100));
        registry.takeover("test");
        await rejected;
        expect(() => run("echo stale")).toThrow();
      } catch (e) {
        throw new Error(
          String(e) + "\n" + JSON.stringify(transcript.slice(-6000)),
          { cause: e },
        );
      } finally {
        registry.dispose();
        data.dispose();
        terminal.kill();
      }
    },
    60000,
  );
});
