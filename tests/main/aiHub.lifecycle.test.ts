import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  runtime: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { getPath: () => os.tmpdir() },
  Notification: { isSupported: () => false },
  powerMonitor: { on: vi.fn(), removeListener: vi.fn() },
}));
vi.mock("../../src/main/ai/AiConfigStore", () => ({
  AiConfigStore: class {
    getView = async () => ({
      enabled: true,
      provider: "openai-compatible",
      model: "test",
    });
    getConfig = mocks.config;
  },
}));
vi.mock("../../src/main/ai/HermesManager", () => ({
  HermesManager: class {
    getManifest = async () => null;
  },
}));
vi.mock("../../src/main/ai/hub/AgentRuntime", () => ({
  HermesRuntime: class {
    start = mocks.runtime;
    stop = async () => {};
  },
}));
import { HubService } from "../../src/main/ai/hub/HubService";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.clearAllMocks();
});
async function create() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-hub-lifecycle-"));
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
    await fs.rm(dir, { recursive: true, force: true });
  });
  await hub.initialize();
  return hub;
}
describe("Hub startup cancellation", () => {
  it("cannot start Hermes or issue a capability after stop while credentials load", async () => {
    let finish!: (value: unknown) => void;
    mocks.config.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const hub = await create();
    const issue = vi.spyOn(hub.broker, "issue");
    const started = hub.request({
      action: "start",
      task: { mode: "advice", prompt: "Inspect attached evidence" },
    });
    const rejected = expect(started).rejects.toThrow("stopped during startup");
    await vi.waitFor(() => expect(hub.store.data.tasks).toHaveLength(1));
    const task = hub.store.data.tasks[0];
    await hub.request({ action: "stop", taskId: task.id });
    finish({
      enabled: true,
      provider: "openai-compatible",
      model: "test",
      baseUrl: "http://localhost:1/v1",
    });
    await rejected;
    expect(task.status).toBe("interrupted");
    expect(issue).not.toHaveBeenCalled();
    expect(mocks.runtime).not.toHaveBeenCalled();
  });
  it("reserves capacity before asynchronous startup so concurrent requests cannot exceed the limit", async () => {
    const finish: Array<(value: unknown) => void> = [];
    mocks.config.mockImplementation(
      () => new Promise((resolve) => finish.push(resolve)),
    );
    const hub = await create();
    const starts = Array.from({ length: 3 }, () =>
      hub.request({
        action: "start",
        task: { mode: "advice", prompt: "Inspect" },
      }),
    );
    const results = Promise.allSettled(starts);
    await vi.waitFor(() => expect(finish).toHaveLength(3));
    await expect(
      hub.request({
        action: "start",
        task: { mode: "advice", prompt: "Fourth" },
      }),
    ).rejects.toThrow("Three tasks");
    for (const task of hub.store.data.tasks.slice(0, 3))
      await hub.request({ action: "stop", taskId: task.id });
    for (const resolve of finish) resolve({ enabled: true });
    expect(
      (await results).every((result) => result.status === "rejected"),
    ).toBe(true);
    expect(mocks.runtime).not.toHaveBeenCalled();
  });
});
