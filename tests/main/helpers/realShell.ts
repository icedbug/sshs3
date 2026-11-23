import { spawnSync } from "node:child_process";
import { spawn, type IPty } from "node-pty";
import { TerminalRegistry } from "../../../src/main/ai/hub/TerminalRegistry";
import type { CommandResult } from "../../../src/main/ai/hub/shellAdapters";
import type { ShellKind } from "../../../src/shared/types/aiHub";

/** Whether a shell is installed here. A test in a real shell is skipped where it is not, and says so in its name. */
export function installed(bin: string): boolean {
  if (process.platform === "win32") return false;
  return spawnSync("which", [bin], { stdio: "ignore" }).status === 0;
}

/** A test name that says why it did not run, where the shell is missing. */
export const shellCase = (shell: ShellKind): string => (installed(shell) ? shell : `${shell} (not installed here: skipped)`);

export interface RealShell {
  registry: TerminalRegistry;
  /** Runs a command through the registry, as the agent's tools do. */
  run(command: string, timeoutMs?: number): Promise<CommandResult>;
  /** Connects again after the terminal was let go of, and takes it for the same owner. */
  reconnect(): Promise<void>;
  /** Everything the terminal sent, raw. */
  transcript(): string;
  close(): void;
}

/** A real shell on a real pseudo terminal, with a registry reading it: what the app does, without the app. */
export async function openShell(
  shell: ShellKind,
  options: {
    cwd?: string;
    /** Changes what is typed on its way to the terminal, as a terminal that drops input would. */
    tamper?: (typed: string) => string;
  } = {},
): Promise<RealShell> {
  const args = shell === "zsh" ? ["-f"] : shell === "fish" ? ["--no-config"] : shell === "bash" ? ["--norc", "--noprofile"] : [];
  // The shell's own default prompt: a prompt handed down from whoever runs the tests would change what is tested.
  const env = { ...process.env } as Record<string, string>;
  delete env.PS1;
  delete env.PROMPT_COMMAND;
  delete env.ENV;
  const terminal: IPty = spawn(shell, args, { cols: 200, rows: 40, cwd: options.cwd ?? process.cwd(), env });
  const registry = new TerminalRegistry();
  registry.register({ id: "real", label: shell, kind: "local" }, (data) => terminal.write(options.tamper ? options.tamper(data) : data));
  let transcript = "";
  const data = terminal.onData((chunk) => {
    transcript += chunk;
    registry.feed("real", chunk);
  });
  const close = (): void => {
    registry.dispose();
    data.dispose();
    terminal.kill();
  };
  let generation = "";
  const take = async (): Promise<void> => {
    await registry.arm("real", shell);
    generation = registry.get("real")!.generation;
    registry.claim("real", generation, "task");
  };
  try {
    await registry.whenAtPrompt("real", 15_000);
    await take();
  } catch (error) {
    close();
    throw new Error(`${String(error)}\n${JSON.stringify(transcript.slice(-2000))}`, { cause: error });
  }
  return {
    registry,
    run: (command, timeoutMs = 15_000) => registry.execute("real", generation, "task", command, timeoutMs),
    reconnect: async () => {
      await registry.ensureReady("real");
      generation = registry.get("real")!.generation;
      registry.claim("real", generation, "task");
    },
    transcript: () => transcript,
    close,
  };
}
