import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalRegistry } from "../../src/main/ai/hub/TerminalRegistry";
import { ToolBroker } from "../../src/main/ai/hub/ToolBroker";
import { DemoVirtualPty } from "../../src/main/demo/DemoVirtualPty";
import { fail, ok } from "../../src/main/sim/SimShell";
import { setSimWorld, SimWorld } from "../../src/main/sim/SimWorld";
import type { AgentTask } from "../../src/shared/types/aiHub";

/**
 * An agent's commands in a demo terminal: typed with the runtime's own frame,
 * run through the real registry and broker, answered by the virtual terminal.
 */

const disposals: Array<() => unknown> = [];
afterEach(async () => {
  for (const d of disposals.splice(0)) await d();
  setSimWorld(undefined);
});

const task = (): AgentTask =>
  ({ id: "run", title: "t", mode: "autonomous", status: "running", messages: [], changes: [], sources: [], createdAt: Date.now(), updatedAt: Date.now(), maxCommands: 20, maxMinutes: 5, verification: "not-verified" }) as unknown as AgentTask;

/** A demo terminal on a server, wired to the registry the way the app wires one. */
async function terminalOn(server: { id: string; name: string; host: string; username?: string }) {
  const terminals = new TerminalRegistry();
  const pty = new DemoVirtualPty({ ...server, port: 22, authType: "password" } as never);
  disposals.push(() => pty.kill(), () => terminals.dispose());
  terminals.register({ id: "s1", label: server.name, kind: "ssh" }, (data) => pty.write(data));
  pty.onData((data) => terminals.feed("s1", data));
  // The banner and the first prompt.
  await new Promise((r) => setTimeout(r, 60));
  const t = task();
  const broker = new ToolBroker(terminals, { context: async () => ({}), memory: async () => [], file: async () => ({}), changed: vi.fn() });
  disposals.unshift(() => broker.dispose());
  await terminals.ensureReady("s1");
  t.target = { sessionId: "s1", generation: terminals.get("s1")!.generation, label: server.name };
  terminals.claim("s1", t.target.generation, t.id);
  const capability = await broker.issue(t);
  // The output ends with the line break the command printed, as on a real terminal: compared without it.
  const run = async (command: string): Promise<{ exitCode: number; output: string }> => {
    const result = (await broker.invoke(capability.key, { action: "command", command })) as { exitCode: number; output: string };
    return { exitCode: result.exitCode, output: result.output.trim() };
  };
  return { run, t };
}

describe("a demo terminal and the agent runtime", () => {
  it("answers the runtime's frame on a scripted appliance, with output and exit code", async () => {
    const { run, t } = await terminalOn({ id: "demo-ssh-ontap-a", name: "netapp-aff-a800-01a", host: "10.30.10.11", username: "admin" });
    const shown = await run("storage aggregate show");
    expect(shown.exitCode).toBe(0);
    expect(shown.output).toContain("aggr1_nvme_prod");
    expect(t.changes[0]).toMatchObject({ status: "completed", exitCode: 0 });
  });

  it("runs on the lab's simulated server when there is one: state, folders and failures are real", async () => {
    const world = new SimWorld();
    const host = world.addHost({ name: "pg-prod-db01", address: "10.30.60.11" }, "demo-ssh-pg-prod-db01");
    host.write("/etc/motd", "hello\n", { mode: 0o644 });
    world.register({
      cat: (ctx, args) => (ctx.host.read(args[0]) ? ok(ctx.host.read(args[0])!.content) : fail(`cat: ${args[0]}: No such file or directory\n`)),
      pwd: (ctx) => ok(`${ctx.cwd}\n`),
    });
    setSimWorld(world);
    const { run } = await terminalOn({ id: "demo-ssh-pg-prod-db01", name: "pg-prod-db01", host: "10.30.60.11" });

    expect(await run("cat /etc/motd")).toMatchObject({ exitCode: 0, output: "hello" });
    expect(await run("cat /etc/nope")).toMatchObject({ exitCode: 1, output: "cat: /etc/nope: No such file or directory" });
    expect(await run("cd /etc && pwd")).toMatchObject({ exitCode: 0, output: "/etc" });
    // A quote in the command survives the frame's quoting.
    host.write("/tmp/it's here", "quoted\n");
    expect(await run("cat '/tmp/it'\"'\"'s here'")).toMatchObject({ exitCode: 0, output: "quoted" });
    expect(await run("nosuchtool --help")).toMatchObject({ exitCode: 127, output: "bash: nosuchtool: command not found" });
    expect(world.unsupported()).toEqual(["nosuchtool --help"]);
    expect(world.ran(host).map((h) => [h.line, h.code])).toContainEqual(["cat /etc/nope", 1]);
  });
});
