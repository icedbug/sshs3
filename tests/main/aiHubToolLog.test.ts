import { describe, expect, it, vi } from "vitest";
import {
  DirectAgentRuntime,
  conversationWithToolLog,
} from "../../src/main/ai/hub/DirectAgentRuntime";
import type { RunEvent } from "../../src/main/ai/hub/AgentRuntime";
import type { AgentTask } from "../../src/shared/types/aiHub";

const task = (extra: Partial<AgentTask> = {}): AgentTask => ({
  id: "t1",
  title: "t",
  mode: "advice",
  status: "running",
  messages: [],
  changes: [],
  sources: [],
  createdAt: 1,
  updatedAt: 1,
  maxCommands: 5,
  maxMinutes: 5,
  verification: "not-verified",
  ...extra,
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

describe("conversationWithToolLog", () => {
  const messages: AgentTask["messages"] = [
    { id: "u1", role: "user", text: "check disk", at: 100 },
    { id: "a1", role: "assistant", text: "Disk is at 81%.", at: 110 },
    { id: "u2", role: "user", text: "and memory?", at: 200 },
    { id: "a2", role: "assistant", text: "Memory is fine.", at: 210 },
    { id: "u3", role: "user", text: "thanks, what was the disk number?", at: 300 },
  ];

  it("writes each turn's tool calls under the answer they led to, and leaves stored messages alone", () => {
    const t = task({
      messages,
      toolLog: [
        { name: "terminal_command", input: '{"command":"df -h"}', output: "/dev/sda1 81%", at: 105 },
        { name: "terminal_command", input: '{"command":"free -m"}', output: "Mem: 2000 free", at: 205 },
      ],
    });
    const out = conversationWithToolLog(t);
    expect(out.map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2", "u3"]);
    expect(out[1].text).toContain("Disk is at 81%.");
    expect(out[1].text).toContain('terminal_command({"command":"df -h"}) → /dev/sda1 81%');
    expect(out[1].text).not.toContain("free -m");
    expect(out[3].text).toContain('terminal_command({"command":"free -m"}) → Mem: 2000 free');
    expect(out[4].text).toBe("thanks, what was the disk number?");
    expect(t.messages[1].text).toBe("Disk is at 81%.");
  });

  it("keeps the calls of a turn that ended without an answer, before the next question", () => {
    const out = conversationWithToolLog(
      task({
        messages: [messages[0], messages[2]],
        toolLog: [{ name: "file_read", input: "{}", output: "contents", at: 150 }],
      }),
    );
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(out[1].text).toContain("file_read({}) → contents");
  });

  it("drops the oldest records first when the log is larger than its budget, and returns plain messages without a log", () => {
    const big = "x".repeat(10_000);
    const out = conversationWithToolLog(
      task({
        messages,
        toolLog: [
          { name: "old", input: "{}", output: big, at: 105 },
          { name: "mid", input: "{}", output: big, at: 106 },
          { name: "new", input: "{}", output: big, at: 205 },
        ],
      }),
    );
    expect(out[1].text).not.toContain("old(");
    expect(out[1].text).toContain("mid(");
    expect(out[3].text).toContain("new(");
    expect(conversationWithToolLog(task({ messages }))).toEqual(messages);
  });
});

describe("tool log across runs", () => {
  it("reports every tool call with its result, and a later run sends them back to the model", async () => {
    const events: RunEvent[] = [];
    let call = 0;
    const firstRun = vi.fn(async () =>
      ++call === 1
        ? sse([
            { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "sshs3_kb_search" } },
            { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"nginx timeout"}' } },
            { type: "message_delta", usage: { output_tokens: 5 } },
          ])
        : sse([
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "The runbook says 120s." } },
            { type: "message_delta", usage: { output_tokens: 5 } },
          ]),
    );
    const broker = async (req: { action: string }) =>
      req.action === "context" ? {} : { hits: [{ title: "SSE runbook", snippet: "proxy_read_timeout 120s" }] };
    const t = task({ messages: [{ id: "u1", role: "user", text: "what timeout do we use?", at: Date.now() - 1000 }] });
    await new DirectAgentRuntime(broker as never, undefined, firstRun as unknown as typeof fetch).start(
      t,
      { kind: "anthropic", model: "claude-opus-5-5", apiKey: "sk-ant-test" }, // pragma: allowlist secret
      (e) => events.push(e),
    );
    const results = events.filter((e) => e.type === "tool.result");
    expect(results).toHaveLength(1);
    expect(results[0].tool).toMatchObject({ name: "sshs3_kb_search", input: '{"query":"nginx timeout"}' });
    expect(results[0].tool!.output).toContain("proxy_read_timeout 120s");

    // What the hub stores after that run, then a follow-up question.
    t.toolLog = [{ ...results[0].tool!, at: Date.now() - 500 }];
    t.messages.push({ id: "a1", role: "assistant", text: "The runbook says 120s.", at: Date.now() - 400 });
    t.messages.push({ id: "u2", role: "user", text: "which runbook was that?", at: Date.now() });
    let body: Record<string, unknown> = {};
    const secondRun = vi.fn(async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sse([
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "SSE runbook." } },
        { type: "message_delta", usage: { output_tokens: 3 } },
      ]);
    });
    await new DirectAgentRuntime(broker as never, undefined, secondRun as unknown as typeof fetch).start(
      t,
      { kind: "anthropic", model: "claude-opus-5-5", apiKey: "sk-ant-test" }, // pragma: allowlist secret
      () => {},
    );
    const sent = body.messages as Array<{ role: string; content: string }>;
    expect(sent.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(sent[1].content).toContain("The runbook says 120s.");
    expect(sent[1].content).toContain("sshs3_kb_search(");
    expect(sent[1].content).toContain("SSE runbook");
  });
});

describe("HubService tool log", () => {
  it("stores a run's tool calls on its task for the next reply, and keeps them out of the UI snapshot", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const { HubService } = await import("../../src/main/ai/hub/HubService");
    const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
    setDemoModeForTesting(false);
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-toollog-"));
    const hub = new HubService(
      {
        changed: () => {},
        inventoryTargets: async () => [],
        backgroundChanged: async () => {},
        openSchedule: async () => "s1",
        show: () => {},
        aiConfigFilePath: path.join(tmpDir, "ai-config.json"),
      },
      tmpDir,
    );
    try {
      await hub.initialize();
      await hub.request({
        action: "configure",
        config: { enabled: true, provider: "anthropic", model: "claude-test", apiKey: "sk-ant-test" }, // pragma: allowlist secret
        preferences: { proposeMemories: false },
      });
      let call = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          ++call === 1
            ? sse([
                { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "sshs3_kb_search" } },
                { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"backup"}' } },
                { type: "message_delta", usage: { output_tokens: 5 } },
              ])
            : sse([
                { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "No runbook found." } },
                { type: "message_delta", usage: { output_tokens: 5 } },
              ]),
        ),
      );
      await hub.request({ action: "start", task: { prompt: "is there a backup runbook?", mode: "advice" } });
      const until = Date.now() + 5000;
      while (hub.store.data.tasks[0]?.status !== "completed") {
        if (Date.now() > until) throw new Error(`timed out: ${hub.store.data.tasks[0]?.error}`);
        await new Promise((r) => setTimeout(r, 10));
      }
      const stored = hub.store.data.tasks[0];
      expect(stored.toolLog).toHaveLength(1);
      expect(stored.toolLog![0]).toMatchObject({ name: "sshs3_kb_search", input: '{"query":"backup"}' });
      const snap = await hub.request({ action: "snapshot" });
      expect(snap.tasks[0].id).toBe(stored.id);
      expect(snap.tasks[0].toolLog).toBeUndefined();
      expect(hub.store.data.tasks[0].toolLog).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
      await hub.dispose();
      setDemoModeForTesting(undefined);
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("snapshotText", () => {
  it("keeps the team's memories when the rest of the snapshot is too large and gets cut", async () => {
    const { snapshotText } = await import("../../src/main/ai/hub/DirectAgentRuntime");
    const context = {
      terminals: [{ id: "t", recentOutput: "x".repeat(50_000) }],
      workspaceMemories: [
        { kind: "skill", scope: "cluster:prod", title: "Drain before reboot", text: "Drain a prod node before rebooting it." },
        { kind: "memory", scope: "workspace", title: "Postgres", text: "max_connections is 300" },
      ],
      history: ["tail-marker"],
    };
    const text = snapshotText(context, 8000);
    expect(text).toContain("- [skill, cluster:prod] Drain before reboot: Drain a prod node before rebooting it.");
    expect(text).toContain("- [memory, workspace] Postgres: max_connections is 300");
    // The snapshot itself is still bounded, and the memories are not repeated inside it.
    expect(text.length).toBeLessThan(8000 + 1200);
    expect(text).toContain("tail-marker");
    expect(text.match(/Drain before reboot/g)).toHaveLength(1);
  });

  it("leaves out whole memories that do not fit their budget and says how many, best ranked first", async () => {
    const { snapshotText } = await import("../../src/main/ai/hub/DirectAgentRuntime");
    const workspaceMemories = Array.from({ length: 30 }, (_, i) => ({
      kind: "memory", scope: "workspace", title: `m${String(i).padStart(2, "0")}`, text: "y".repeat(1000),
    }));
    const text = snapshotText({ workspaceMemories }, 8000);
    expect(text).toContain("] m00: ");
    expect(text).not.toContain("] m29: ");
    const shown = (text.match(/^- \[memory/gm) ?? []).length;
    expect(shown).toBeGreaterThan(8);
    expect(text).toContain(`(${30 - shown} more not shown`);
  });

  it("is the plain snapshot when there are no memories, and masks a secret in one", async () => {
    const { snapshotText } = await import("../../src/main/ai/hub/DirectAgentRuntime");
    expect(snapshotText({ a: 1 }, 8000)).toBe('{"a":1}');
    const text = snapshotText({ workspaceMemories: [{ kind: "memory", scope: "workspace", title: "db", text: "password=hunter2secret" }] }, 8000); // pragma: allowlist secret
    expect(text).not.toContain("hunter2secret");
  });
});
