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
    { type: "message_delta", usage: { output_tokens: 1 } }, { type: "message_stop" },
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

  it("sends each operation to the assigned profile with its own key, protocol, and model", async () => {
    const hub = await makeHub({ fastModel: "legacy-fast" });
    const endpoint = (role: string) => `https://${role}.example/v1`;
    const profiles = [
      { id: "quick", provider: "openai-compatible", model: "fast-model", apiProtocol: "responses" },
      { id: "memory", provider: "anthropic", model: "summary-model", maxOutputTokens: 1536 },
      { id: "vectors", provider: "openai-compatible", model: "embedding-model" },
    ] as const;
    await hub.config.update({
      profiles: profiles.map((profile) => ({ ...profile, name: profile.id, baseUrl: endpoint(profile.id) })),
      profileApiKeys: { quick: "test-quick", memory: "test-memory", vectors: "test-vectors" },
      activeProfileByRole: { fastTriage: "quick", backgroundDistill: "memory", embedding: "vectors" },
      piiScrubbing: "strict",
    });
    const requests: Array<{ url: string; model: string; credential: string | null; body: Record<string, unknown> }> = [];
    const send = async (url: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body));
      requests.push({ url: String(url), model: body.model, credential: headers.get("authorization") ?? headers.get("x-api-key"), body });
      if (String(url).endsWith("/embeddings")) return Response.json({ data: [{ index: 0, embedding: [1] }] });
      if (String(url).endsWith("/responses")) return Response.json({ status: "completed", output_text: JSON.stringify({ command: "pwd", explanation: "Show the working directory." }) });
      return say('{"proposals":[]}');
    };
    hub.kbNetwork = { fetchImpl: send, lookup: async () => [{ address: "93.184.216.34", family: 4 }] };
    vi.stubGlobal("fetch", send);

    const result = await hub.request({ action: "inline-suggest", prompt: "Show the working directory", shell: "bash" });
    expect(result.reply?.inlineSuggestion?.source).toBe("model");
    expect(await (await hub.kbEmbedder())?.embed(["test@example.invalid"])).toEqual([[1]]);
    const task = await hub.runBackground({ mode: "advice", prompt: "Read a record." }, { distillSourceId: "record", title: "Memory" });
    expect(task).toMatchObject({ status: "completed", model: "summary-model" });
    expect(requests.map(({ url, model, credential }) => [url, model, credential])).toEqual([
      [endpoint("quick") + "/responses", "fast-model", "Bearer test-quick"],
      [endpoint("vectors") + "/embeddings", "embedding-model", "Bearer test-vectors"],
      [endpoint("memory") + "/messages", "summary-model", "test-memory"],
    ]);
    expect(requests[1].body.input).toEqual(["[email redacted]"]);
    expect(requests[2].body.max_tokens).toBe(1536);

    await hub.config.update({ egressPolicy: "local-only" });
    await expect((await hub.kbEmbedder())!.embed(["record"])).rejects.toThrow("outside");
    expect(requests).toHaveLength(3);
  });

  it("uses the assigned KB authoring profile even when the page would otherwise use the main model", async () => {
    const hub = await makeHub({ fastModel: "legacy-fast" });
    await hub.config.update({
      profiles: [{ id: "pages", name: "Pages", provider: "anthropic", model: "page-model" }],
      profileApiKeys: { pages: "test-pages" },
      activeProfileByRole: { backgroundDistill: "pages" },
    });
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)).model);
      return say('{"pages":[]}');
    });
    const source = { docId: "synthetic", title: "Source" };
    await hub.runPageOps("Compile this document", [], source, { id: "compile", title: "Pages" },
      { clusters: [], servers: [] }, { sourceText: "Sample source" });
    expect(requests).toEqual(["page-model"]);
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
