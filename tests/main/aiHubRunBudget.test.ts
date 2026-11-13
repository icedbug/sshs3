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

describe("a run that uses its budget", () => {
  it("is refused past the limit, ends with a status line, and Continue gives it the same budget again", async () => {
    const hub = await create();
    const answers: string[] = [];
    mocks.start.current = (async (_t, _m, onEvent, invoke) => {
      for (let i = 0; i < 3; i++) answers.push(await write(invoke));
      onEvent({ type: "run.completed", output: "Checked two files; the third is left." });
    }) as Start;
    await hub.request({ action: "start", task: { mode: "advice", prompt: "Look", maxCommands: 2 } });
    const task = hub.store.data.tasks[0];
    await vi.waitFor(() => expect(task.status).toBe("completed"));
    expect(answers.slice(0, 2)).toEqual(["ok", "ok"]);
    expect(answers[2]).toMatch(/budget exhausted.*report what you found/);
    expect(task.commandsUsed).toBe(2);
    expect(task.budgetStop).toMatchObject({ kind: "commands", limit: 2 });
    expect(task.messages.at(-2)?.text).toBe("Checked two files; the third is left.");
    expect(task.messages.at(-1)).toMatchObject({
      role: "system",
      text: "Stopped after 2 commands, the limit for this conversation. Continue to give it 2 more.",
    });

    // Continue: the same conversation, a fresh budget of the same size.
    let seen: Partial<AgentTask> = {};
    mocks.start.current = (async (t, _m, onEvent, invoke) => {
      seen = { budgetStop: t.budgetStop, commandsUsed: t.commandsUsed };
      answers.push(await write(invoke), await write(invoke));
      onEvent({ type: "run.completed", output: "Done." });
    }) as Start;
    await hub.request({ action: "resume", taskId: task.id });
    await vi.waitFor(() => expect(task.status).toBe("completed"));
    expect(seen).toEqual({ budgetStop: undefined, commandsUsed: 0 });
    expect(answers.slice(3)).toEqual(["ok", "ok"]);
    expect(task.messages.find((m) => m.role === "user" && /2 more commands/.test(m.text))).toBeTruthy();
    expect(task.budgetStop).toBeUndefined();
    expect(task.messages.at(-1)).toMatchObject({ role: "assistant", text: "Done." });
  });

  it("ends the run when the agent keeps asking after it was told the budget is spent", async () => {
    const hub = await create();
    mocks.start.current = (async (_t, _m, _onEvent, invoke) => {
      for (let i = 0; i < 5; i++) await write(invoke);
      await new Promise(() => {});
    }) as Start;
    await hub.request({ action: "start", task: { mode: "advice", prompt: "Look", maxCommands: 1 } });
    const task = hub.store.data.tasks[0];
    await vi.waitFor(() => expect(task.status).toBe("interrupted"));
    expect(task.error).toBeUndefined();
    expect(task.messages.filter((m) => m.role === "system").map((m) => m.text)).toEqual([
      "Stopped after 1 command, the limit for this conversation. Continue to give it 1 more.",
    ]);
  });

  it("says so when the run's time is up", async () => {
    const hub = await create();
    mocks.start.current = (async () => {
      await new Promise(() => {});
    }) as Start;
    await hub.request({ action: "start", task: { mode: "advice", prompt: "Look", maxMinutes: 15 } });
    const task = hub.store.data.tasks[0];
    await vi.waitFor(() => expect(task.status).toBe("running"));
    (hub as unknown as { armRunTimer(t: AgentTask, at: number): void }).armRunTimer(task, Date.now());
    await vi.waitFor(() => expect(task.status).toBe("interrupted"));
    expect(task.error).toBeUndefined();
    expect(task.messages.at(-1)?.text).toBe(budgetStopLine({ kind: "minutes", limit: 15, at: 0 }));
    expect(task.messages.at(-1)?.text).toBe("Stopped after 15 minutes, the time limit for this conversation. Continue to give it 15 more.");
  });
});
