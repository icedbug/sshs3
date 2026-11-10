import { describe, expect, it, vi } from "vitest";
import { DirectAgentRuntime } from "../../src/main/ai/hub/DirectAgentRuntime";
import type { RunEvent } from "../../src/main/ai/hub/AgentRuntime";
import type { AgentTask } from "../../src/shared/types/aiHub";

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

const task: AgentTask = {
  id: "t1",
  title: "t",
  mode: "advice",
  status: "running",
  messages: [{ id: "m", role: "user", text: "What changed on prod?", at: 1 }],
  changes: [],
  sources: [],
  createdAt: 1,
  updatedAt: 1,
  maxCommands: 5,
  maxMinutes: 5,
  verification: "not-verified",
};

describe("Anthropic agent loop: prompt caching and token accounting", () => {
  it("marks the stable instructions and the growing conversation as cacheable, keeps the per-run snapshot after the breakpoint, and reports the whole run's tokens", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return bodies.length === 1
        ? sse([
            { type: "message_start", message: { usage: { input_tokens: 40, cache_creation_input_tokens: 3000, cache_read_input_tokens: 0, output_tokens: 1 } } },
            { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "workspace_context" } },
            { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"prod"}' } },
            { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 25 } },
          ])
        : sse([
            { type: "message_start", message: { usage: { input_tokens: 60, cache_creation_input_tokens: 200, cache_read_input_tokens: 3000, output_tokens: 1 } } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Erik raised the timeout." } },
            { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 12 } },
          ]);
    });
    const broker = vi.fn(async (req: { action: string }) =>
      req.action === "context" ? { workspaceServers: [{ name: "prod-api-01" }] } : { ok: true },
    );
    const events: RunEvent[] = [];
    const runtime = new DirectAgentRuntime(broker as never, undefined, fetchImpl as unknown as typeof fetch);
    await runtime.start(task, { kind: "anthropic", model: "claude-opus-5-5", apiKey: "sk-ant-test" }, (e) => events.push(e)); // pragma: allowlist secret

    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      // The conversation breakpoint moves with each turn.
      expect(body.cache_control).toEqual({ type: "ephemeral" });
      expect(body.temperature).toBeUndefined();
      const system = body.system as Array<{ text: string; cache_control?: unknown }>;
      expect(system).toHaveLength(2);
      expect(system[0].cache_control).toEqual({ type: "ephemeral" });
      expect(system[0].text).not.toContain("prod-api-01");
      expect(system[1].text).toContain("prod-api-01");
      expect(system[1].cache_control).toBeUndefined();
    }
    // A cache is a prefix match: the second turn must send the first turn's prefix unchanged.
    expect(bodies[1].system).toEqual(bodies[0].system);
    expect(bodies[1].tools).toEqual(bodies[0].tools);
    expect((bodies[1].messages as unknown[]).slice(0, 1)).toEqual(bodies[0].messages);

    const done = events.find((e) => e.type === "run.completed")!;
    expect(done.output).toBe("Erik raised the timeout.");
    // Input: everything read in both turns (40+3000+0 and 60+200+3000); output: 25+12.
    expect(done.usage).toEqual({ input_tokens: 6300, output_tokens: 37 });
  });

  it("still counts input from an endpoint that reports it only at the end of the message", async () => {
    const fetchImpl = vi.fn(async () =>
      sse([
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
        { type: "message_delta", usage: { input_tokens: 50, output_tokens: 10 } },
      ]),
    );
    const events: RunEvent[] = [];
    const runtime = new DirectAgentRuntime((async () => ({})) as never, undefined, fetchImpl as unknown as typeof fetch);
    await runtime.start(task, { kind: "anthropic", model: "claude-opus-5-5", apiKey: "sk-ant-test" }, (e) => events.push(e)); // pragma: allowlist secret
    expect(events.find((e) => e.type === "run.completed")!.usage).toEqual({ input_tokens: 50, output_tokens: 10 });
  });
});
