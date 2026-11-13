import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

function sse(events: Array<Record<string, unknown>>): Response {
  const text = events.map((e) => `data: ${JSON.stringify(e)}`).join("\n\n") + "\n\n";
  return new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(text));
        c.close();
      },
    }),
    { status: 200 },
  );
}
const say = (text: string): Response =>
  sse([
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "message_delta", usage: { output_tokens: 1 } },
  ]);
const investigate = (): Response =>
  sse([
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "sshs3_investigate", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ questions: [{ question: "What is the nginx timeout?" }] }) } },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
  ]);

async function makeHub(config: Record<string, unknown>) {
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(false);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-fast-"));
  const hub = new HubService(
    { changed: () => {}, inventoryTargets: async () => [], backgroundChanged: async () => {}, openSchedule: async () => "s1", show: () => {}, aiConfigFilePath: path.join(dir, "ai.json") },
    dir,
  );
  disposals.push(async () => {
    await hub.dispose();
    setDemoModeForTesting(undefined);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await hub.initialize();
  await hub.request({
    action: "configure",
    config: { enabled: true, provider: "anthropic", model: "claude-opus-5-5", apiKey: "sk-ant-test", ...config }, // pragma: allowlist secret
    preferences: { proposeMemories: false },
  });
  return hub;
}

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Answers like a model; records which model each kind of run was sent to. */
function stubModel(options: { failOn?: string } = {}) {
  const calls: Array<{ model: string; kind: "main" | "investigator" | "memory" }> = [];
  let mainTurn = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ content: unknown }> };
      const first = JSON.stringify(body.messages[0].content);
      const kind = first.includes("You are an investigator") ? "investigator" : first.includes("long-term memory") ? "memory" : "main";
      calls.push({ model: body.model, kind });
      if (options.failOn && body.model === options.failOn)
        return new Response('{"error":{"type":"not_found_error","message":"model: no-such-model"}}', { status: 404 });
      if (kind === "investigator") return say("The timeout is 60s.");
      if (kind === "memory") return say('{"proposals":[]}');
      return mainTurn++ === 0 ? investigate() : say(`The nginx timeout is 60s. ${"More detail. ".repeat(60)}`);
    }),
  );
  return calls;
}
const conversationDone = (hub: Awaited<ReturnType<typeof makeHub>>): boolean =>
  hub.store.data.tasks.some((t) => !t.workforceRunId && !t.distillSourceId && t.status === "completed");

describe("a fast model for background work", () => {
  it("runs investigators and memory reading on the fast model, and the conversation on the main one", async () => {
    const hub = await makeHub({ fastModel: "  claude-haiku-5-5 " });
    expect((await hub.request({ action: "snapshot" })).config.fastModel).toBe("claude-haiku-5-5");
    await hub.request({ action: "configure", config: {}, preferences: { proposeMemories: true, autoSaveMemories: true } });
    const calls = stubModel();
    await hub.request({ action: "start", task: { prompt: "Why do long requests fail?", mode: "advice" } });
    await waitFor(() => conversationDone(hub) && calls.some((c) => c.kind === "memory"));

    expect(calls.filter((c) => c.kind === "main").map((c) => c.model)).toEqual(["claude-opus-5-5", "claude-opus-5-5"]);
    expect(calls.filter((c) => c.kind === "investigator").map((c) => c.model)).toEqual(["claude-haiku-5-5"]);
    expect(calls.filter((c) => c.kind === "memory").map((c) => c.model)).toEqual(["claude-haiku-5-5"]);
    // Each task records the model it ran on.
    expect(hub.store.data.tasks.find((t) => t.workforceRunId)!.model).toBe("claude-haiku-5-5");
    expect(hub.store.data.tasks.find((t) => !t.workforceRunId && !t.distillSourceId)!.model).toBe("claude-opus-5-5");
  });

  it("uses the main model for everything when no fast model is set", async () => {
    const hub = await makeHub({});
    const calls = stubModel();
    await hub.request({ action: "start", task: { prompt: "Why do long requests fail?", mode: "advice" } });
    await waitFor(() => conversationDone(hub));
    expect(new Set(calls.map((c) => c.model))).toEqual(new Set(["claude-opus-5-5"]));
  });

  it("runs a background run again on the main model when the fast model fails, so the work still gets done", async () => {
    const hub = await makeHub({ fastModel: "no-such-model" });
    const calls = stubModel({ failOn: "no-such-model" });
    await hub.request({ action: "start", task: { prompt: "Why do long requests fail?", mode: "advice" } });
    await waitFor(() => conversationDone(hub));

    expect(calls.filter((c) => c.kind === "investigator").map((c) => c.model)).toEqual(["no-such-model", "claude-opus-5-5"]);
    const main = hub.store.data.tasks.find((t) => !t.workforceRunId && !t.distillSourceId)!;
    expect(main.messages.at(-1)!.text).toContain("The nginx timeout is 60s.");
    // Both attempts are kept: the failed one with its error, the second marked as the main-model attempt.
    const attempts = hub.store.data.tasks.filter((t) => t.workforceRunId);
    expect(attempts.map((t) => t.status)).toEqual(["failed", "completed"]);
    expect(attempts[0].error).toContain("404");
    expect(attempts[1]).toMatchObject({ mainModelOnly: true, model: "claude-opus-5-5" });
  });

  it("clears the fast model when the setting is emptied", async () => {
    const hub = await makeHub({ fastModel: "claude-haiku-5-5" });
    const snap = await hub.request({ action: "configure", config: { fastModel: "" } });
    expect(snap.config.fastModel).toBeUndefined();
  });
});
