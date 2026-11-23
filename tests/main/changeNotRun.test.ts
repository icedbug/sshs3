import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalRegistry } from "../../src/main/ai/hub/TerminalRegistry";
import { ToolBroker } from "../../src/main/ai/hub/ToolBroker";
import type { AgentTask, ClusterSafetyPolicy } from "../../src/shared/types/aiHub";

/**
 * A change that is stopped after it was allowed and before its command is typed did not run, and
 * says so. It used to be left "running" and then marked "uncertain", as if nobody knew.
 * "Uncertain" is for a command that was typed and whose end is not known.
 */

const disposals: Array<() => unknown> = [];
afterEach(async () => {
  for (const d of disposals.splice(0)) await d();
});

async function setup(mode: AgentTask["mode"] = "autonomous") {
  const terminals = new TerminalRegistry();
  disposals.push(() => terminals.dispose());
  const typed: string[] = [];
  terminals.register({ id: "one", label: "host", kind: "ssh" }, (data) => {
    typed.push(data);
    const n = /SSHS3;([a-f0-9]{32});BEGIN/.exec(data)?.[1];
    if (n) queueMicrotask(() => terminals.feed("one", `\x1b]777;SSHS3;${n};BEGIN\x07inactive\x1b]777;SSHS3;${n};END;3;/srv\x07`));
  });
  await terminals.arm("one", "bash");
  const task: AgentTask = {
    id: "a",
    title: "change",
    mode,
    status: "running",
    messages: [],
    changes: [],
    sources: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    maxCommands: 20,
    maxMinutes: 5,
    verification: "not-verified",
    target: { sessionId: "one", generation: terminals.get("one")!.generation, label: "host" },
  };
  terminals.claim("one", task.target!.generation, task.id);
  /** The rules of the target, as they stand when they are looked at. */
  const rules: { cluster: ClusterSafetyPolicy } = { cluster: {} as ClusterSafetyPolicy };
  const broker = new ToolBroker(terminals, {
    context: async () => ({}),
    memory: async () => [],
    file: async () => ({}),
    changed: vi.fn(),
    safetyContext: () => ({ policy: { requireApprovalOnProdTags: true }, targetTags: [], clusterPolicy: { ...rules.cluster } }),
  });
  broker.wait = async () => undefined;
  disposals.unshift(() => broker.dispose());
  const capability = await broker.issue(task);
  typed.length = 0;
  return { broker, task, capability, terminals, typed, rules };
}

const card = {
  action: "change" as const,
  command: "systemctl start nginx",
  description: "Start nginx",
  check: { command: "systemctl is-active nginx", expected: "active" },
  rollback: "systemctl stop nginx",
};

describe("a change card that the rules stop after it was allowed", () => {
  it("is marked as not run, with the reason, when a freeze begins between its check and its command", async () => {
    const { broker, task, capability, terminals, typed, rules } = await setup();
    // The look at the check before the change runs. While it runs, somebody starts a freeze.
    const execute = terminals.execute.bind(terminals);
    vi.spyOn(terminals, "execute").mockImplementation((...args) => {
      const running = execute(...args);
      rules.cluster = { frozenUntil: Date.now() + 60_000 } as ClusterSafetyPolicy;
      return running;
    });
    await expect(broker.invoke(capability.key, card)).rejects.toThrow(/change freeze now holds/);
    const change = task.changes[0];
    expect(change.status).toBe("denied");
    expect(change.decidedHow).toBe("policy");
    expect(change.output).toBe("Not run: A change freeze now holds on this target.");
    expect(change.check).toMatchObject({ skipped: "the change was not made" });
    expect(change.rollback).toMatchObject({ skipped: "the change was not made" });
    expect(change.rollback?.ran).toBeUndefined();
    // Only the check was typed: the change's own command never reached the terminal.
    expect(typed).toHaveLength(1);
  });

  it("is marked as not run when the run was stopped meanwhile", async () => {
    const { broker, task, capability, terminals } = await setup();
    const execute = terminals.execute.bind(terminals);
    vi.spyOn(terminals, "execute").mockImplementation((...args) => {
      const running = execute(...args);
      task.status = "cancelled";
      return running;
    });
    await expect(broker.invoke(capability.key, card)).rejects.toThrow(/This run has stopped/);
    expect(task.changes[0]).toMatchObject({ status: "denied", decidedHow: "stopped", output: "Not run: This run has stopped." });
  });

  it("is marked as not run when the terminal refuses the change's command before typing it", async () => {
    const { broker, task, capability, terminals, typed } = await setup();
    const execute = terminals.execute.bind(terminals);
    let calls = 0;
    vi.spyOn(terminals, "execute").mockImplementation((...args) => {
      // The person starts to type at the prompt after the check before the change has run.
      if (++calls === 2) (terminals as unknown as { sessions: Map<string, { inputBuffer: string }> }).sessions.get("one")!.inputBuffer = "sudo vim";
      return execute(...args);
    });
    await expect(broker.invoke(capability.key, card)).rejects.toThrow(/Something is typed at the prompt/);
    expect(task.changes[0].status).toBe("denied");
    expect(task.changes[0].output).toMatch(/^Not run: Something is typed at the prompt of this terminal/);
    expect(typed).toHaveLength(1);
  });
});

describe("a command that is stopped before it is typed", () => {
  it("is marked as not run, not as uncertain", async () => {
    const { broker, task, capability, terminals, typed } = await setup();
    (terminals as unknown as { sessions: Map<string, { inputBuffer: string }> }).sessions.get("one")!.inputBuffer = "half a line";
    await expect(broker.invoke(capability.key, { action: "command", command: "df -h" })).rejects.toThrow(/Something is typed at the prompt/);
    expect(task.changes[0].status).toBe("denied");
    expect(task.changes[0].output).toMatch(/^Not run: /);
    expect(typed).toHaveLength(0);
    // Nothing ran, so nothing about the run's proof changed.
    expect(task.verification).toBe("not-verified");
  });

  it("stays uncertain when it was typed and its end is not known", async () => {
    const { broker, task, capability, terminals, typed } = await setup();
    const execute = terminals.execute.bind(terminals);
    vi.spyOn(terminals, "execute").mockImplementation((...args) => {
      const running = execute(...args);
      // The person takes the terminal back while the command runs.
      terminals.takeover("one", { interrupt: false });
      return running;
    });
    await expect(broker.invoke(capability.key, { action: "command", command: "df -h" })).rejects.toThrow(/Control returned to the user/);
    expect(task.changes[0].status).toBe("uncertain");
    expect(typed).toHaveLength(1);
  });

  it("does not hold an idempotency key for a command that did not run", async () => {
    const { broker, task, capability, terminals } = await setup();
    const session = (terminals as unknown as { sessions: Map<string, { inputBuffer: string }> }).sessions.get("one")!;
    session.inputBuffer = "half a line";
    await expect(broker.invoke(capability.key, { action: "command", command: "df -h", idempotencyKey: "k1" })).rejects.toThrow();
    expect(broker.getIdempotencyEntry(task.id, "k1")).toBeUndefined();
    // The prompt is cleared: the same call runs now.
    session.inputBuffer = "";
    await expect(broker.invoke(capability.key, { action: "command", command: "df -h", idempotencyKey: "k1" })).resolves.toMatchObject({ exitCode: 3 });
  });
});
