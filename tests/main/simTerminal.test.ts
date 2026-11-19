import { afterEach, describe, expect, it, vi } from "vitest";
import { commandEnvelope, CommandFrames, type CommandResult } from "../../src/main/ai/hub/shellAdapters";
import { scenarioById, startScenario } from "../../src/main/sim/lab";
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

  it.each([512, 1])("keeps a PostgreSQL diagnostic in one frame across %i-byte PTY writes", (size) => {
    const scenario = scenarioById("pg-wal-full")!;
    const world = startScenario(scenario);
    const host = world.host(scenario.target)!;
    const pty = new DemoVirtualPty({ id: scenario.servers[0].id, name: host.name, host: host.address, port: 22, authType: "agent" } as never);
    disposals.push(() => pty.kill());
    const nonce = "1234567890abcdef1234567890abcdef";
    const command = 'sudo du -sh /var/lib/postgresql/16/main/* 2>/dev/null | sort -hr | head -20; ' +
      'sudo -u postgres psql -X -P pager=off -c "select archived_count, last_archived_wal, last_archived_time, failed_count, last_failed_wal, last_failed_time from pg_stat_archiver;" ' +
      '-c "select slot_name, slot_type,\nactive, wal_status from pg_replication_slots;"';
    const envelope = commandEnvelope("bash", command, nonce);
    const frames = new CommandFrames(nonce);
    let result: CommandResult | undefined;
    pty.onData(data => { result = frames.feed(data) ?? result; });
    expect(Buffer.byteLength(envelope)).toBeGreaterThan(512);
    const before = world.ran(host).length;
    for (let offset = 0; offset < envelope.length - 1; offset += size) {
      pty.write(envelope.slice(offset, Math.min(offset + size, envelope.length - 1)));
    }
    expect(result).toBeUndefined();
    expect(world.ran(host)).toHaveLength(before);
    pty.write("\r");
    expect(result).toMatchObject({ exitCode: 0, cwd: `/home/${host.user}` });
    expect(result?.output).toContain("archived_count");
    expect(result?.output).toContain("slot_name");
    expect(world.ran(host).slice(before).map(entry => entry.line)).toEqual([command]);
  });

  it("discards interrupted frames and rejects mismatched completion markers", () => {
    const pty = new DemoVirtualPty({ id: "demo-ssh-ontap-a", name: "netapp-aff-a800-01a", host: "10.30.10.11" } as never);
    disposals.push(() => pty.kill());
    let output = "";
    pty.onData(chunk => { output += chunk; });
    const nonce = "1234567890abcdef1234567890abcdef";
    const frame = commandEnvelope("bash", "storage aggregate show", nonce);
    pty.write(frame.slice(0, 60));
    pty.write("\x03");
    pty.write(frame.replace(nonce + ";END", "f".repeat(32) + ";END"));
    expect(output).toContain("Invalid demo shell frame");
    expect(output).not.toContain("\x1b]777;");
    expect(output).not.toContain("aggr1_nvme_prod");
    output = "";
    pty.write(frame);
    expect(new CommandFrames(nonce).feed(output)).toMatchObject({ exitCode: 0, output: expect.stringContaining("aggr1_nvme_prod") });
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
