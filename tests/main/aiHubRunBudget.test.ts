import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentTask } from "../../src/shared/types/aiHub";
import type { RunEvent } from "../../src/main/ai/hub/AgentRuntime";

type Invoke = (req: Record<string, unknown>) => Promise<unknown>;
type Start = (task: AgentTask, model: unknown, onEvent: (e: RunEvent) => void, invoke: Invoke) => Promise<void>;
const mocks = vi.hoisted(() => ({ start: { current: undefined as unknown } }));
vi.mock("electron", () => ({
  app: { getPath: () => os.tmpdir() },
  Notification: { isSupported: () => false },
  powerMonitor: { on: vi.fn(), removeListener: vi.fn() },
}));
vi.mock("../../src/main/ai/AiConfigStore", () => ({
  AiConfigStore: class {
    getView = async () => ({ enabled: true, provider: "openai-compatible", model: "test" });
    getConfig = async () => ({ enabled: true, provider: "openai-compatible", model: "test", baseUrl: "http://localhost:1/v1" });
  },
}));
vi.mock("../../src/main/ai/HermesManager", () => ({
  HermesManager: class {
    getManifest = async () => null;
  },
}));
vi.mock("../../src/main/ai/hub/AgentRuntime", () => ({
  HermesRuntime: class {
    private stopped?: () => void;
    constructor(_m: unknown, private readonly invoke: Invoke) {}
    start = (task: AgentTask, model: unknown, onEvent: (e: RunEvent) => void) =>
      Promise.race([
        (mocks.start.current as Start)(task, model, onEvent, this.invoke),
        new Promise<void>((resolve) => (this.stopped = resolve)),
      ]);
    stop = async () => this.stopped?.();
  },
}));
import { HubService, budgetStopLine } from "../../src/main/ai/hub/HubService";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function create(): Promise<HubService> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-hub-budget-"));
  const hub = new HubService(
    {
      changed: () => {},
      inventoryTargets: async () => [],
      openSchedule: async () => {
        throw new Error("not scheduled");
      },
      backgroundChanged: async () => {},
      show: () => {},
    },
    dir,
  );
  cleanups.push(async () => {
    await hub.dispose();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await hub.initialize();
  // A file write counts against the budget; what it writes does not matter here.
  (hub.broker as unknown as { deps: { file: () => Promise<unknown> } }).deps.file = async () => ({ ok: true });
  return hub;
}
const write = (invoke: Invoke) => invoke({ action: "file-write", path: "/tmp/x", content: "y" }).then(() => "ok", (e: Error) => e.message);

describe("a person's run has no limit on commands or time", () => {
  it("takes as many actions as it needs, whatever limit the request names, and is never stopped for it", async () => {
    const hub = await create();
    const answers: string[] = [];
    mocks.start.current = (async (_t, _m, onEvent, invoke) => {
      for (let i = 0; i < 30; i++) answers.push(await write(invoke));
      onEvent({ type: "run.completed", output: "Checked thirty files." });
    }) as Start;
    await hub.request({ action: "start", task: { mode: "advice", prompt: "Look", maxCommands: 2, maxMinutes: 1 } });
    const task = hub.store.data.tasks[0];
    await vi.waitFor(() => expect(task.status).toBe("completed"));
    expect(answers).toEqual(Array.from({ length: 30 }, () => "ok"));
    // Counted for the person to see, with no limit beside it.
    expect(task.commandsUsed).toBe(30);
    expect(task).toMatchObject({ maxCommands: 0, maxMinutes: 0 });
    expect(task.budgetStop).toBeUndefined();
    expect(task.messages.at(-1)).toMatchObject({ role: "assistant", text: "Checked thirty files." });
  });

  it("frees a conversation from the limits it was stored with", async () => {
    const hub = await create();
    mocks.start.current = (async () => {
      await new Promise(() => {});
    }) as Start;
    await hub.request({ action: "start", task: { mode: "advice", prompt: "Look" } });
    const task = hub.store.data.tasks[0];
    await vi.waitFor(() => expect(task.status).toBe("running"));
    await hub.request({ action: "stop", taskId: task.id });
    await vi.waitFor(() => expect(task.status).toBe("interrupted"));

    // A conversation saved before the limits were taken away: continuing it does not bring them back.
    task.maxCommands = 20;
    task.maxMinutes = 15;
    await hub.request({ action: "resume", taskId: task.id });
    await vi.waitFor(() => expect(task.status).toBe("running"));
    expect(task).toMatchObject({ maxCommands: 0, maxMinutes: 0 });
  });

  it("waits for a person's answer for as long as it takes, unless a wait is set", async () => {
    const hub = await create();
    const inner = hub as unknown as { approvalWaitMinutes(): number };
    expect(inner.approvalWaitMinutes()).toBe(0);
    const broker = hub.broker as unknown as {
      approvals: Map<string, { timer?: unknown; resolve(answer: { allowed: boolean; how: string }): void }>;
      waitForPerson(task: AgentTask, changeId: string): Promise<{ allowed: boolean; how: string }>;
    };
    const answer = broker.waitForPerson({ id: "t", status: "waiting" } as AgentTask, "c1");
    // Nothing is set to give up on the person.
    expect(broker.approvals.get("c1")!.timer).toBeUndefined();
    broker.approvals.get("c1")!.resolve({ allowed: true, how: "person" });
    expect(await answer).toEqual({ allowed: true, how: "person" });
    broker.approvals.delete("c1");

    await hub.request({ action: "configure", preferences: { approvalWaitMinutes: 30 } } as never);
    expect(inner.approvalWaitMinutes()).toBe(30);
    await hub.request({ action: "configure", preferences: { approvalWaitMinutes: 0 } } as never);
    expect(inner.approvalWaitMinutes()).toBe(0);
  });

  it("still words a limit, for a conversation that was stopped by one before they were taken away", () => {
    expect(budgetStopLine({ kind: "minutes", limit: 15, at: 0 })).toBe(
      "Stopped after 15 minutes, the time limit for this conversation. Continue to give it 15 more.",
    );
  });
});
