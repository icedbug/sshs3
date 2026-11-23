import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalRegistry } from "../../src/main/ai/hub/TerminalRegistry";
import { IDEMPOTENCY_KEEP_MS, ToolBroker } from "../../src/main/ai/hub/ToolBroker";
import { commandEnvelope } from "../../src/main/ai/hub/shellAdapters";
import type { AgentTask } from "../../src/shared/types/aiHub";

/**
 * Three small things from the older list: the commands a change card types for its check and its
 * rollback count against the run's budget; idempotency keys are not remembered for as long as the
 * app runs; and what a terminal printed before a command began is handed over, not dropped.
 */

const disposals: Array<() => unknown> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const d of disposals.splice(0)) await d();
});

const newTask = (maxCommands: number): AgentTask => ({
  id: "a",
  title: "t",
  mode: "autonomous",
  status: "running",
  messages: [],
  changes: [],
  sources: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
  maxCommands,
  maxMinutes: 0,
  verification: "not-verified",
});

async function setup(maxCommands = 0) {
  const terminals = new TerminalRegistry();
  disposals.push(() => terminals.dispose());
  terminals.register({ id: "one", label: "host", kind: "ssh" }, (data) => {
    const n = /SSHS3;([a-f0-9]{32});BEGIN/.exec(data)?.[1];
    if (n) queueMicrotask(() => terminals.feed("one", `\x1b]777;SSHS3;${n};BEGIN\x07ok\x1b]777;SSHS3;${n};END;0;/srv\x07`));
  });
  await terminals.arm("one", "bash");
  const task = newTask(maxCommands);
  task.target = { sessionId: "one", generation: terminals.get("one")!.generation, label: "host" };
  terminals.claim("one", task.target.generation, task.id);
  const broker = new ToolBroker(terminals, { context: async () => ({}), memory: async () => [], file: async () => ({}), changed: vi.fn() });
  broker.wait = async () => undefined;
  disposals.unshift(() => broker.dispose());
  const capability = await broker.issue(task);
  const run = vi.spyOn(terminals, "execute");
  const answer = (output: string, exitCode = 0) => run.mockResolvedValueOnce({ exitCode, output, cwd: "/srv" } as never);
  return { broker, task, capability, terminals, run, answer };
}

const card = {
  action: "change" as const,
  command: "systemctl start nginx",
  check: { command: "systemctl is-active nginx", expected: "active" },
  rollback: "systemctl stop nginx",
};

describe("the commands a change card types", () => {
  it("all count against the run's budget: the check before, the change, and the check after", async () => {
    const { broker, task, capability, answer, run } = await setup();
    answer("inactive", 3);
    answer("");
    answer("active");
    await broker.invoke(capability.key, card);
    expect(run).toHaveBeenCalledTimes(3);
    expect(task.commandsUsed).toBe(3);
    // A plain command is one.
    answer("up 3 days");
    await broker.invoke(capability.key, { action: "command", command: "uptime" });
    expect(task.commandsUsed).toBe(4);
    // With a look before it, two.
    answer("before");
    answer("after");
    await broker.invoke(capability.key, { action: "command", command: "uptime", preflightCommand: "date" });
    expect(task.commandsUsed).toBe(6);
  });

  it("count also when the change is taken back, and a card is not stopped half-way for the budget", async () => {
    const { broker, task, capability, answer, run } = await setup(4);
    answer("inactive", 3); // the check before
    answer(""); // the change
    answer("inactive", 3); // the check after
    answer("inactive", 3); // once more, after it had time to settle
    answer(""); // the rollback
    answer("inactive", 3); // the check after the rollback
    const res = (await broker.invoke(capability.key, card)) as Record<string, unknown>;
    // Six commands were typed although the run may take four: the rollback was not left out for the budget.
    expect(run).toHaveBeenCalledTimes(6);
    expect(res).toMatchObject({ rollbackAttempted: true, rolledBack: true });
    expect(task.commandsUsed).toBe(6);
    // What is over is refused at the next call.
    await expect(broker.invoke(capability.key, { action: "command", command: "uptime" })).rejects.toThrow(/Command budget exhausted/);
    expect(run).toHaveBeenCalledTimes(6);
  });
});

describe("idempotency keys", () => {
  it("are forgotten after a day, and not before", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-23T10:00:00Z"));
    const { broker, task, capability, answer, run } = await setup();
    answer("one");
    await broker.invoke(capability.key, { action: "command", command: "uptime", idempotencyKey: "k1" });
    // The same call again within the day is answered from the ledger, and types nothing.
    vi.setSystemTime(new Date("2026-11-24T09:00:00Z"));
    expect(await broker.invoke(capability.key, { action: "command", command: "uptime", idempotencyKey: "k1" })).toMatchObject({ output: "one" });
    expect(run).toHaveBeenCalledTimes(1);
    answer("two");
    await broker.invoke(capability.key, { action: "command", command: "df -h", idempotencyKey: "k2" });
    // A day after the first: it is gone, the newer one is kept.
    vi.setSystemTime(new Date(new Date("2026-11-23T10:00:00Z").getTime() + IDEMPOTENCY_KEEP_MS + 60_000));
    answer("three");
    await broker.invoke(capability.key, { action: "command", command: "free -m", idempotencyKey: "k3" });
    expect(broker.getIdempotencyLedger(task.id).map((e) => e.idempotencyKey).sort()).toEqual(["k2", "k3"]);
    // Much later, with nothing new in this conversation: another conversation's call clears it out.
    vi.setSystemTime(new Date("2026-12-24T10:00:00Z"));
    const other = newTask(0);
    other.id = "b";
    other.target = task.target;
    const second = await broker.issue(other);
    await expect(broker.invoke(second.key, { action: "context", idempotencyKey: "x" })).resolves.toBeDefined();
    expect(broker.getIdempotencyLedger(task.id)).toEqual([]);
  });
});

describe("what the terminal printed before a command began", () => {
  /** A terminal that echoes what is typed, as a real one does, and prints `before` first. */
  function echoing(before: (command: string) => string) {
    const terminals = new TerminalRegistry();
    disposals.push(() => terminals.dispose());
    const nonce = /SSHS3;([a-f0-9]{32});BEGIN/;
    terminals.register({ id: "one", label: "host", kind: "ssh" }, (data) => {
      const n = nonce.exec(data)?.[1];
      if (!n) return;
      const handshake = data === commandEnvelope("bash", ":", n);
      queueMicrotask(() =>
        terminals.feed("one", `${before(handshake ? ":" : "command")}${data.replace(/\r/g, "\r\n")}\x1b]777;SSHS3;${n};BEGIN\x07${handshake ? "" : "out\r\n"}\x1b]777;SSHS3;${n};END;0;/srv\x07ops@host:~$ `),
      );
    });
    return terminals;
  }

  it("is handed over as that, without the echo of what was typed, and is not the command's output", async () => {
    const terminals = echoing((what) => (what === "command" ? "tail of the job before\r\n[1]+  Done   sleep 5\r\n" : ""));
    await terminals.arm("one", "bash");
    const generation = terminals.get("one")!.generation;
    terminals.claim("one", generation, "task");
    const result = await terminals.execute("one", generation, "task", "echo out");
    expect(result.output).toBe("out\r\n");
    expect(result.printedBefore).toBe("tail of the job before\r\n[1]+  Done   sleep 5");
    // Nothing came before the next one: nothing is said.
    const quiet = echoing(() => "");
    await quiet.arm("one", "bash");
    const g = quiet.get("one")!.generation;
    quiet.claim("one", g, "task");
    expect(await quiet.execute("one", g, "task", "echo out")).toEqual({ output: "out\r\n", exitCode: 0, cwd: "/srv" });
  });

  it("what arrived while the terminal was being connected to goes with the first command", async () => {
    // A banner that was still arriving when the handshake was typed.
    const terminals = echoing((what) => (what === ":" ? "Last login: Mon Nov 23 09:58:01 2026 from 10.0.0.5\r\nWelcome to web-1\r\n" : ""));
    await terminals.arm("one", "bash");
    const generation = terminals.get("one")!.generation;
    terminals.claim("one", generation, "task");
    const first = await terminals.execute("one", generation, "task", "echo out");
    expect(first.printedBefore).toBe("Last login: Mon Nov 23 09:58:01 2026 from 10.0.0.5\r\nWelcome to web-1");
    expect((await terminals.execute("one", generation, "task", "echo out")).printedBefore).toBeUndefined();
  });

  it("reaches the agent as printedBeforeCommand", async () => {
    const terminals = echoing((what) => (what === "command" ? "rsync: connection unexpectedly closed\r\n" : ""));
    await terminals.arm("one", "bash");
    const task = newTask(0);
    task.target = { sessionId: "one", generation: terminals.get("one")!.generation, label: "host" };
    terminals.claim("one", task.target.generation, task.id);
    const broker = new ToolBroker(terminals, { context: async () => ({}), memory: async () => [], file: async () => ({}), changed: vi.fn() });
    disposals.unshift(() => broker.dispose());
    const capability = await broker.issue(task);
    const res = (await broker.invoke(capability.key, { action: "command", command: "echo out" })) as Record<string, unknown>;
    expect(res).toMatchObject({ output: "out\r\n", printedBeforeCommand: "rsync: connection unexpectedly closed" });
    expect(res).not.toHaveProperty("printedBefore");
  });
});
