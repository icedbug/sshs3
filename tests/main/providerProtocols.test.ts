import { describe, expect, it, vi } from "vitest";
import { usesResponsesApi } from "../../src/shared/types/ai";
import type { AgentTask } from "../../src/shared/types/aiHub";
import type { HermesModelConfig } from "../../src/main/ai/HermesManager";
import type { RunEvent } from "../../src/main/ai/hub/AgentRuntime";
import { DirectAgentRuntime, EndpointCircuitBreakerRegistry, type DirectRuntimeOptions } from "../../src/main/ai/hub/DirectAgentRuntime";

const task: AgentTask = {
  id: "test", mode: "advice", status: "running", title: "Read", messages: [{ id: "q", role: "user", text: "Read", at: 1 }],
  createdAt: 1, updatedAt: 1, changes: [], sources: [], verification: "not-verified", maxCommands: 1, maxMinutes: 1,
};
const model: HermesModelConfig = { kind: "custom", baseUrl: "http://127.0.0.1:31001/v1", model: "fixture", apiKey: "fixture-primary" };
const stream = (...events: unknown[]) => new Response(events.map((e) => "data: " + (typeof e === "string" ? e : JSON.stringify(e)) + "\n\n").join(""));
const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
async function run(modelConfig: HermesModelConfig, send: typeof fetch, options: DirectRuntimeOptions = {}, context = async (): Promise<unknown> => ({})) {
  const events: RunEvent[] = [];
  await new DirectAgentRuntime(context, undefined, send, { lookup, ...options }).start(task, modelConfig, (e) => events.push(e));
  return events;
}

describe("provider protocol boundaries", () => {
  it("selects the official Responses endpoint and respects existing custom addresses and explicit choices", () => {
    expect(usesResponsesApi("https://api.openai.com/v1/")).toBe(true);
    for (const address of ["https://api.openai.com.example/v1", "https://api.openai.com:9000/v1", "https://api.openai.com/other", model.baseUrl!])
      expect(usesResponsesApi(address)).toBe(false);
    expect(usesResponsesApi("https://api.openai.com/v1", "chat-completions")).toBe(false);
    expect(usesResponsesApi(model.baseUrl!, "responses")).toBe(true);
  });

  it("replays opaque reasoning, message and function items in their original order with matched results", async () => {
    const reasoning = { type: "reasoning", id: "r1", encrypted_content: "opaque-fixture", summary: [] };
    const message = { type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Checking.", annotations: [] }] };
    const call = { type: "function_call", id: "fc1", call_id: "c1", name: "workspace_context", arguments: "{}", status: "completed" };
    const bodies: Array<{ input: Record<string, unknown>[] }> = [];
    const send: typeof fetch = async (url, init) => {
      expect(String(url)).toBe(model.baseUrl + "/responses");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-primary");
      const body = JSON.parse(String(init?.body));
      expect(body.store).toBe(false);
      expect(body.reasoning.effort).toBeTruthy();
      expect(body).not.toHaveProperty("previous_response_id");
      bodies.push(body);
      if (bodies.length === 1) return stream(
        { type: "response.output_item.done", item: call, output_index: 2 },
        { type: "response.completed", response: { status: "completed", output: [reasoning, message, call], usage: { input_tokens: 50, output_tokens: 2 } } });
      return stream({ type: "response.output_text.delta", delta: "Done." }, { type: "response.completed", response: { usage: { input_tokens: 60, output_tokens: 3 } } });
    };
    const events = await run({ ...model, apiProtocol: "responses" }, send);
    expect(events.at(-1)).toMatchObject({ type: "run.completed", output: "Done.", usage: { input_tokens: 110, output_tokens: 5 } });
    expect(bodies[1].input.slice(-4)).toEqual([reasoning, message, call, expect.objectContaining({ type: "function_call_output", call_id: "c1" })]);
    expect(JSON.stringify(events)).not.toContain("opaque-fixture");
  });

  it.each([
    ["chat error", model, { error: { message: "provider error" } }],
    ["chat truncation", model, { choices: [{ delta: { content: "Partial" } }] }],
    ["incomplete response", { ...model, apiProtocol: "responses" } as HermesModelConfig, { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }],
    ["truncated response", { ...model, apiProtocol: "responses" } as HermesModelConfig, { type: "response.output_text.delta", delta: "Partial" }],
    ["Anthropic error", { ...model, kind: "anthropic", apiKey: "fixture" } as HermesModelConfig, { type: "error", error: { message: "overloaded" } }],
  ])("marks %s as failed", async (_label, cfg, frame) => {
    const events = await run(cfg as HermesModelConfig, async () => stream(frame));
    expect(events.at(-1)?.type).toBe("run.failed");
  });

  it("releases the recovery probe after an ordinary HTTP refusal", async () => {
    const breakers = new EndpointCircuitBreakerRegistry({ failureThreshold: 1, cooldownMs: 10 });
    let now = 10;
    const options = { circuitBreakers: breakers, now: () => now };
    await run(model, async () => new Response("unavailable", { status: 503 }), options);
    now += 30;
    await run(model, async () => new Response("key refused", { status: 401 }), options);
    const restored = vi.fn(async () => stream({ choices: [{ delta: { content: "Ready." } }] }, "[DONE]"));
    expect((await run(model, restored, options)).at(-1)).toMatchObject({ type: "run.completed", output: "Ready." });
    expect(restored).toHaveBeenCalledOnce();
  });

  it.each(["strict", "standard", "off"] as const)("applies %s to the full prompt, tool result and saved tool record", async (mode) => {
    const sample = "Contact person@example.invalid on web-srv.ops.test at 203.0.113.84 and 10.0.0.8. IPv6 2001:db8::9, fe80::. Bearer fixture-credential-value";
    const context = { appSettings: { aiConfig: { piiScrubbing: mode } }, workspaceServers: [{ host: "web-srv.ops.test" }], target: { output: sample } };
    const requestBodies: string[] = [];
    const send: typeof fetch = async (_url, init) => {
      requestBodies.push(String(init?.body));
      return requestBodies.length === 1
        ? stream({ choices: [{ delta: { tool_calls: [{ id: "c1", index: 0, function: { name: "workspace_context", arguments: JSON.stringify({ query: "inspect" }) } }] }, finish_reason: "tool_calls" }] }, "[DONE]")
        : stream({ choices: [{ delta: { content: "Confirmed " + sample.slice(0, 30) } }] }, { choices: [{ delta: { content: sample.slice(30) }, finish_reason: "stop" }] }, "[DONE]");
    };
    const events: RunEvent[] = [];
    let contextCalls = 0;
    const rt = new DirectAgentRuntime(async () => contextCalls++ === 0 ? context : { observation: sample }, undefined, send);
    const withHistory = { ...task, messages: [{ id: "old", role: "assistant" as const, text: sample, at: 0 }, ...task.messages] };
    await rt.start(withHistory, model, (event) => events.push(event));
    expect(events.at(-1)?.type).toBe("run.completed");
    expect(requestBodies).toHaveLength(2);
    const toolMessage = JSON.parse(requestBodies[1]).messages.at(-1);
    expect(toolMessage.role).toBe("tool");
    for (const body of [...requestBodies, toolMessage.content as string]) {
      expect(body).not.toContain("fixture-credential-value");
      expect(body.includes("203.0.113.84")).toBe(mode !== "strict");
      expect(body.includes("10.0.0.8")).toBe(mode !== "strict");
      expect(body.includes("2001:db8::9")).toBe(mode !== "strict");
      expect(body.includes("fe80::")).toBe(mode !== "strict");
      expect(body.includes("web-srv.ops.test")).toBe(mode !== "strict");
      expect(body.includes("person@example.invalid")).toBe(mode === "off");
    }
    for (const answer of [events.at(-1)?.output, events.filter((event) => event.type === "message.delta").map((event) => event.delta).join("")]) {
      expect(answer).toContain("Confirmed");
      expect(answer).not.toContain("fixture-credential-value");
      expect(answer!.includes("web-srv.ops.test")).toBe(mode !== "strict");
    }
    const history = events.find((event) => event.type === "tool.result")!.tool!.output;
    expect(history).not.toContain("fixture-credential-value");
    expect(history.includes("203.0.113.84")).toBe(mode === "off");
    expect(history.includes("person@example.invalid")).toBe(mode === "off");
  });

  it("reads the spare key outside model-visible context", async () => {
    const spare = { id: "reserve", name: "Reserve", model: "spare", provider: "openai-compatible" as const, baseUrl: "http://127.0.0.1:31002/v1", apiKey: "fixture-spare" };
    const send: typeof fetch = async (url, init) => {
      if (String(url).startsWith(model.baseUrl!)) return new Response("unavailable", { status: 503 });
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-spare");
      expect(String(init?.body)).not.toContain("fixture-spare");
      return stream({ choices: [{ delta: { content: "Ready." } }] }, "[DONE]");
    };
    const events = await run({ ...model, fallbackProfileIds: [spare.id] }, send, {
      circuitBreakers: new EndpointCircuitBreakerRegistry({ failureThreshold: 1 }),
      getConnectionProfile: async (id) => id === spare.id ? spare : undefined,
    });
    expect(events.at(-1)).toMatchObject({ type: "run.completed", output: "Ready." });
  });

  it("keeps the run's local data rule even when context cannot be loaded", async () => {
    const send = vi.fn(async () => stream("[DONE]"));
    const events = await run({ ...model, baseUrl: "https://example.org/v1", egressPolicy: "local-only" }, send, {}, async () => { throw new Error("unavailable"); });
    expect(send).not.toHaveBeenCalled();
    expect(events.at(-1)?.type).toBe("run.failed");
  });
});
