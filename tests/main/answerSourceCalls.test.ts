import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubService } from "../../src/main/ai/hub/HubService";
import { setDemoModeForTesting } from "../../src/main/demo/demoMode";
import { stopScenario } from "../../src/main/sim/lab";
import { SourceCapture } from "../../src/main/ai/hub/SourceCapture";
import { maskProviderText } from "../../src/main/ai/hub/privacy";
import { appendSourceCalls, expireTerminalSources, sourceCallsForDisplay } from "../../src/shared/answerSources";

describe("the evidence actually sent for an answer", () => {
  afterEach(() => { vi.unstubAllGlobals(); stopScenario(); setDemoModeForTesting(undefined); });

  it("captures both retained ends of a terminal field and preserves literal escapes", () => {
    const cap = new SourceCapture(s => maskProviderText(s));
    const original = { output: "first literal \\n" + "a".repeat(900) + "\nlast \"line\" here" };
    const full = JSON.stringify(original);
    const got = full.slice(0,40) + "…cut…" + full.slice(-36);
    const annotated = cap.toolOutput("terminal_command", full, got, { sessionId: "tab", label: "Lab" }, 123);
    const { body, call } = cap.wire(JSON.stringify({ messages: [{ role: "tool", content: annotated }] }), 124);
    expect(body).not.toContain("⟦");
    expect(call.sources).toHaveLength(1);
    const source = call.sources[0];
    expect(source.segments).toHaveLength(2);
    expect(source.segments![0]).toContain("first literal \\n");
    expect(source.segments![1]).toContain('last "line" here');
    expect(source.segments!.join("")).not.toContain("a".repeat(65));
    const compact: typeof call[] = [];
    appendSourceCalls(compact, [call, { ...call, id: "second" }]);
    expect(compact[1].sources[0].segments).toBeUndefined();
    expect(sourceCallsForDisplay(compact)[1].sources[0].segments).toEqual(source.segments);
    const expired = sourceCallsForDisplay(expireTerminalSources(compact, 125));
    expect(expired[0].sources[0]).toMatchObject({ expired: true, digest: source.digest });
    expect(expired[1].sources[0].segments).toBeUndefined();
    expect(expired[0].sources[0].excerpt).toBeUndefined();
  });

  it("reports retained legacy tool text without assigning it a current source", () => {
    const cap = new SourceCapture(s => s);
    const old = cap.historical({name: "sshs3_kb_search", output: '{"page":"old","body":"older revision"}'});
    const call = cap.wire(JSON.stringify({messages: [{role: "assistant", content: old}]}), 1);
    expect(call.call).toMatchObject({ sources: [], untracedHistory: true });
    expect(call.body).toContain("older revision");
    expect(call.body).not.toContain("⟦");
    const omitted = cap.project("unrelated", old);
    expect(cap.wire(JSON.stringify({input: [omitted]}), 2).call.untracedHistory).toBeUndefined();
  });

  it("keeps each demo answer tied to the actual KB revision, selected memory and masked terminal data", async () => {
    setDemoModeForTesting(true);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-source-sim-"));
    const hub = new HubService({ changed: () => {}, inventoryTargets: async () => [], backgroundChanged: async () => {},
      openSchedule: async () => "lab", show: () => {}, aiConfigFilePath: path.join(dir, "ai.json") }, dir);
    try {
      await hub.initialize();
      await hub.request({ action: "sim-start", scenarioId: "pg-wal-full" });
      const page = hub.store.data.kbPages!.at(-1)!;
      const revision = page.revision;
      await hub.request({ action: "configure", config: { enabled: true, provider: "anthropic", model: "claude-test", apiKey: "fixture" }, preferences: { proposeMemories: false } });
      await hub.request({ action: "memory-save", entry: { id: "wal-memory", scope: "workspace", kind: "memory", title: "Lab WAL note", text: "Inspect the archived segments in this exercise." } });
      await hub.request({ action: "memory-save", entry: { id: "other-memory", scope: "server:unrelated", kind: "memory", title: "Unrelated note", text: "Synthetic excluded passage." } });
      hub.terminals.register({ id: "lab", kind: "ssh", label: "pg-prod-db01", profileId: "demo-ssh-pg-prod-db01", shell: "bash" }, () => {});
      hub.terminals.feed("lab", "archive-lag 17\npassword=demo-secret-never-display\n");
      const bodies: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
        bodies.push(String(init.body));
        const events = bodies.length === 1 ? [
          { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "sshs3_kb_search" } },
          { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({page: page.id}) } },
        ] : [{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "The archive queue needs inspection." } }];
        return new Response([...events, { type: "message_delta", usage: { output_tokens: 3 } }, { type: "message_stop" }]
          .map(e => "data: " + JSON.stringify(e)).join("\n\n") + "\n\n");
      }));
      const start = await hub.request({ action: "start", task: { prompt: "Read the WAL runbook.", sessionId: "lab", mode: "advice" } });
      const id = start.tasks.find(t => t.messages.some(m => m.text === "Read the WAL runbook."))!.id;
      const task = hub.store.data.tasks.find(t => t.id === id)!;
      await vi.waitFor(() => expect(task.status,task.error).toBe("completed"), {timeout: 6000});
      const msg = task.messages.at(-1)!;
      const calls = sourceCallsForDisplay(msg.sourceCalls);
      expect(bodies).toHaveLength(2);
      expect(calls).toHaveLength(2);
      expect(calls[0].sources).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "kb-page", id: page.id, revision, indexOnly: true }),
        expect.objectContaining({ kind: "memory", id: "wal-memory" }),
        expect.objectContaining({ kind: "terminal", id: "lab", excerpt: expect.stringContaining("archive-lag 17") }),
      ]));
      expect(calls[0].sources.some(s => s.id === page.id && !s.indexOnly)).toBe(false);
      expect(calls[1].sources.some(s => s.kind === "kb-page" && s.id === page.id && s.revision === revision && !s.indexOnly)).toBe(true);
      expect(JSON.stringify(calls)).not.toContain("demo-secret-never-display");
      expect(bodies.join("")).not.toContain("demo-secret-never-display");
      expect(calls.flatMap(c => c.sources).some(s => s.id === "other-memory")).toBe(false);
      for (const [i,c] of calls.entries()) for (const source of c.sources) expect(bodies[i]).toContain("[" + source.ref + "]");
      page.revision++;
      expect(calls[1].sources.filter(s => s.id === page.id).every(s => s.revision === revision)).toBe(true);
      const attachmentAt = Date.now() - 1000;
      await hub.request({ action: "reply", taskId: task.id, text: "Review the earlier lookup.", attachments: [
        { id: "lab-reply-excerpt", kind: "terminal", label: "Pinned output", text: "retained followup output", observedAt: attachmentAt },
      ] });
      await vi.waitFor(() => expect(task.status,task.error).toBe("completed"), {timeout: 6000});
      const followup = sourceCallsForDisplay(task.messages.at(-1)!.sourceCalls);
      expect(followup).toHaveLength(1);
      const evidence = followup[0].sources;
      expect(evidence).toContainEqual(expect.objectContaining({kind: "kb-page", id: page.id, revision: revision + 1, indexOnly: true}));
      expect(evidence.some(s => s.id === page.id && s.revision === revision && !s.indexOnly)).toBe(true);
      expect(evidence).toContainEqual(expect.objectContaining({kind: "terminal", id: "lab-reply-excerpt", attachment: true, observedAt: attachmentAt, excerpt: expect.stringContaining("retained followup output")}));
    } finally {
      await hub.dispose();
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
