import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentTask } from "../../src/shared/types/aiHub";
import { fakeOpenAi, type FakeModelStep } from "../helpers/fakeOpenAi";

/**
 * "Retry" asks the last question again. The question is not posted a second time, the answer that
 * followed it is replaced by the new one, and what the earlier try ran is still told to the model.
 */

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
});

async function hubWithModel(steps: FakeModelStep[]) {
  const model = await fakeOpenAi(steps);
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-retry-"));
  const hub = new HubService(
    { changed: () => {}, inventoryTargets: async () => [], backgroundChanged: async () => {}, openSchedule: async () => "s1", show: () => {}, aiConfigFilePath: path.join(dir, "ai.json") } as never,
    dir,
  );
  disposals.push(async () => {
    await hub.dispose();
    await model.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await hub.initialize();
  await hub.request({
    action: "configure",
    config: { enabled: true, provider: "openai-compatible", model: "fake-1", baseUrl: model.url, apiKey: "not-a-real-key" },
    preferences: { proposeMemories: false },
  });
  const ended = async (task: AgentTask): Promise<void> => {
    await vi.waitFor(() => expect(["completed", "failed"]).toContain(task.status), { timeout: 10_000 });
    // The run lets go of the conversation a moment after its last event.
    await (hub as unknown as { whenSettled(t: AgentTask): Promise<void> }).whenSettled(task);
  };
  const ask = async (prompt: string): Promise<AgentTask> => {
    const id = (await hub.request({ action: "start", task: { prompt, mode: "advice" } })).reply!.started!.taskId;
    const task = hub.store.data.tasks.find((t) => t.id === id)!;
    await ended(task);
    return task;
  };
  return { hub, model, ask, ended };
}

const said = (request: Record<string, unknown>): Array<{ role: string; content: unknown }> => request.messages as Array<{ role: string; content: unknown }>;

describe("asking again", () => {
  it("answers the same question anew, and the conversation holds it once", async () => {
    const steps: FakeModelStep[] = [{ text: "First answer." }];
    const { hub, model, ask, ended } = await hubWithModel(steps);
    const task = await ask("Why is nginx down on web-prod-01?");
    expect(task.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "Why is nginx down on web-prod-01?"],
      ["assistant", "First answer."],
    ]);
    const questionId = task.messages[0].id;
    const sent = model.requests.length;

    steps[0] = { text: "Second answer." };
    await hub.request({ action: "reply", taskId: task.id, text: "", retry: true });
    await ended(task);

    expect(task.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "Why is nginx down on web-prod-01?"],
      ["assistant", "Second answer."],
    ]);
    // The same message, not a copy of it.
    expect(task.messages[0].id).toBe(questionId);
    // The model was asked once more, with the question once in what it was sent and as its last word.
    const again = said(model.requests[sent]);
    expect(again.filter((m) => m.role === "user" && String(m.content).includes("Why is nginx down")).length).toBe(1);
    expect(again.at(-1)).toMatchObject({ role: "user", content: "Why is nginx down on web-prod-01?" });
    expect(again.some((m) => String(m.content).includes("First answer."))).toBe(false);
  }, 30_000);

  it("keeps an earlier turn's answer, and replaces only the one that followed the last question", async () => {
    const steps: FakeModelStep[] = [{ text: "It is the config." }];
    const { hub, ask, ended } = await hubWithModel(steps);
    const task = await ask("Why is nginx down?");
    steps[0] = { text: "Run nginx -t." };
    await hub.request({ action: "reply", taskId: task.id, text: "How do I check it?" });
    await ended(task);
    steps[0] = { text: "Run sudo nginx -t and read the first error." };
    await hub.request({ action: "reply", taskId: task.id, text: "", retry: true });
    await ended(task);

    expect(task.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "Why is nginx down?"],
      ["assistant", "It is the config."],
      ["user", "How do I check it?"],
      ["assistant", "Run sudo nginx -t and read the first error."],
    ]);
  }, 30_000);

  it("tells the model what the earlier try already ran", async () => {
    const steps: FakeModelStep[] = [{ tool: "workspace_context", args: { query: "nginx" } }, { text: "Looked it up." }];
    const { hub, model, ask, ended } = await hubWithModel(steps);
    const task = await ask("What do we know about nginx?");
    expect(task.toolLog?.map((r) => r.name)).toEqual(["workspace_context"]);
    const sent = model.requests.length;

    await hub.request({ action: "reply", taskId: task.id, text: "", retry: true });
    await ended(task);

    const again = said(model.requests[sent]);
    const note = again.findIndex((m) => m.role === "assistant" && String(m.content).includes("Tool calls made in an earlier try at this"));
    const question = again.findIndex((m) => m.role === "user" && m.content === "What do we know about nginx?");
    expect(note).toBeGreaterThan(0);
    expect(String(again[note].content)).toContain("workspace_context(");
    // What was done comes before the question, and the question is the last thing said.
    expect(note).toBeLessThan(question);
    expect(question).toBe(again.length - 1);
    expect(task.messages.filter((m) => m.role === "user")).toHaveLength(1);
  }, 30_000);

  it("is refused while the conversation is still running, and when there is nothing to ask again", async () => {
    const { hub, ask } = await hubWithModel([{ text: "Done." }]);
    const task = await ask("A question");
    task.status = "running";
    await expect(hub.request({ action: "reply", taskId: task.id, text: "", retry: true })).rejects.toThrow("still running");
    task.status = "completed";
    task.messages = task.messages.filter((m) => m.role !== "user");
    await expect(hub.request({ action: "reply", taskId: task.id, text: "", retry: true })).rejects.toThrow("no question here to ask again");
  }, 30_000);
});
