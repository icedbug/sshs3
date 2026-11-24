import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HubService } from "../../src/main/ai/hub/HubService";
import type { AgentTask } from "../../src/shared/types/aiHub";

/**
 * A reply the person sends while the agent works goes to the agent at once (steer). Its pictures went
 * nowhere: only the words were passed on. They go with the words now, and where the agent cannot take
 * them while it works, the person is told at once.
 */

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
});

const PICTURE = "data:image/png;base64,UElDVFVSRQ==";

async function hubWithRunningTask(taken: boolean) {
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(false);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-reply-pictures-"));
  const hub: HubService = new HubService(
    {
      changed: () => {},
      inventoryTargets: async () => [],
      backgroundChanged: async () => {},
      openSchedule: async () => "s1",
      show: () => {},
      aiConfigFilePath: path.join(dir, "ai.json"),
      workspaceServers: async () => [],
    } as never,
    dir,
  );
  const task: AgentTask = {
    id: "run-1",
    title: "Why is it slow",
    mode: "assisted",
    status: "running",
    messages: [{ id: "u-1", role: "user", text: "Why is checkout slow?", at: 1 }],
    changes: [],
    sources: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    maxCommands: 10,
    maxMinutes: 15,
    verification: "not-verified",
  };
  // The run at work: only what it is given while it works is looked at here.
  const steer = vi.fn(async () => taken);
  disposals.push(async () => {
    task.status = "completed";
    hub.runtimes.delete(task.id);
    await hub.dispose();
    setDemoModeForTesting(undefined);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await hub.initialize();
  hub.store.data.tasks.push(task);
  hub.runtimes.set(task.id, { start: async () => {}, steer, stop: async () => {} });
  return { hub, task, steer };
}

describe("a reply with pictures while the agent works", () => {
  it("passes the pictures to the agent with the words", async () => {
    const { hub, task, steer } = await hubWithRunningTask(true);
    await hub.request({ action: "reply", taskId: task.id, text: "this graph", attachments: [{ id: "a1", kind: "image", label: "graph.png", imageDataUrl: PICTURE, mimeType: "image/png" }] } as never);
    expect(steer).toHaveBeenCalledWith("this graph", [{ label: "graph.png", dataUrl: PICTURE, mimeType: "image/png" }]);
    expect(task.messages.at(-1)).toMatchObject({ role: "user", text: "this graph", images: [{ dataUrl: PICTURE }] });
  });

  it("says at once when this agent could not take them while it works", async () => {
    const { hub, task } = await hubWithRunningTask(false);
    await hub.request({ action: "reply", taskId: task.id, text: "this graph", attachments: [{ id: "a1", kind: "image", label: "graph.png", imageDataUrl: PICTURE, mimeType: "image/png" }] } as never);
    expect(task.messages.at(-1)).toMatchObject({ role: "system", text: "The pictures were not passed on to the agent while it works. Send them again when it has finished." });
  });
});
