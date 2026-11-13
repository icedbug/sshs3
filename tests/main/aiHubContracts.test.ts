import { mapToolCallToBrokerRequest } from "../../src/main/ai/hub/DirectAgentRuntime";
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentTask, HubSnapshot, KbDocument } from "../../src/shared/types/aiHub";

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
  vi.unstubAllGlobals();
});

function sse(events: Array<Record<string, unknown>>): Response {
  const text = events.map((e) => `data: ${JSON.stringify(e)}`).join("\n\n") + "\n\n";
  return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } }), { status: 200 });
}
const say = (text: string): Response =>
  sse([
    { type: "message_start", message: { usage: { input_tokens: 700 } } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "message_delta", usage: { output_tokens: 300 } },
  ]);

async function makeHub(options: { demo?: boolean; model?: boolean } = {}) {
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(options.demo ?? false);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-contracts-"));
  const changed = vi.fn();
  const hub = new HubService(
    { changed, inventoryTargets: async () => [], backgroundChanged: async () => {}, openSchedule: async () => "s1", show: () => {}, aiConfigFilePath: path.join(dir, "ai.json") } as never,
    dir,
  );
  disposals.push(async () => { await hub.dispose(); setDemoModeForTesting(undefined); await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  await hub.initialize();
  if (options.model !== false)
    await hub.request({ action: "configure", config: { enabled: true, provider: "anthropic", model: "claude-opus-5-5", apiKey: "sk-ant-test" }, preferences: { proposeMemories: false } } as never); // pragma: allowlist secret
  return { hub, dir, changed };
}
const settled = async (hub: { snapshot: () => Promise<HubSnapshot> }, id: string): Promise<AgentTask> => {
  let task: AgentTask | undefined;
  await vi.waitFor(async () => {
    task = (await hub.snapshot()).tasks.find((t) => t.id === id);
    expect(["completed", "failed", "interrupted"]).toContain(task?.status);
  }, { timeout: 8000 });
  return task!;
};

describe("what a request says it did", () => {
  it("names the conversation it started, also when another run starts at the same moment", async () => {
    const { hub } = await makeHub();
    vi.stubGlobal("fetch", vi.fn(async () => say("Done.")));
    const a = await hub.request({ action: "start", task: { prompt: "What is the load on pg-01?", mode: "advice" } });
    const b = await hub.request({ action: "start", task: { prompt: "And on web-01?", mode: "advice" } });
    expect(a.reply!.started!.taskId).not.toBe(b.reply!.started!.taskId);
    expect(a.tasks.find((t) => t.id === a.reply!.started!.taskId)!.messages[0].text).toContain("pg-01");
    expect(b.tasks.find((t) => t.id === b.reply!.started!.taskId)!.messages[0].text).toContain("web-01");
    await settled(hub, a.reply!.started!.taskId);
    await settled(hub, b.reply!.started!.taskId);

    // Starting an agent's mission says which conversation too, and speaks English to the model.
    await hub.request({ action: "agent-save", agent: { id: "dba", name: "DBA", role: "r", mission: "Keep the databases healthy", systemPrompt: "", defaultMode: "advice", targetCluster: "DB-Prod" } as never });
    const mission = await hub.request({ action: "agent-run-mission", agentId: "dba" });
    const started = mission.tasks.find((t) => t.id === mission.reply!.started!.taskId)!;
    expect(started.messages[0].text).toBe("[Mission for DBA (cluster: @cluster:DB-Prod)]\nKeep the databases healthy");
    await settled(hub, started.id);
  });

  it("does not rewrite the store or wake the other windows for a request that only reads", async () => {
    const { hub, dir, changed } = await makeHub({ model: false });
    await hub.request({ action: "kb-ingest-text", text: "# Failover\n\nPromote the replica with pg_ctl promote, then repoint the pooler at it. ".repeat(4) });
    await hub.store.save();
    const file = path.join(dir, "hub.json");
    const before = (await fs.stat(file)).mtimeMs;
    await new Promise((r) => setTimeout(r, 30));
    changed.mockClear();
    const found = await hub.request({ action: "kb-search", query: "promote the replica" });
    expect(found.reply!.kbSearch!.hits.length).toBeGreaterThan(0);
    const read = await hub.request({ action: "kb-read", id: found.reply!.kbSearch!.hits[0].docId });
    expect(read.reply!.kbDocument!.content).toContain("pg_ctl promote");
    await hub.request({ action: "server-facts-read", serverId: "nothing" });
    expect(changed).not.toHaveBeenCalled();
    expect((await fs.stat(file)).mtimeMs).toBe(before);
    // A request that changes something still does both.
    await hub.request({ action: "safety-policy-save", policy: { autoApproveSafeReadOnly: true, requireApprovalOnProdTags: true, blockDestructiveWithoutConfirm: true } });
    expect(changed).toHaveBeenCalled();
    expect((await fs.stat(file)).mtimeMs).toBeGreaterThan(before);
  });

  it("answers an inline suggestion to the terminal that asked, and says when no model did", async () => {
    const { hub } = await makeHub({ model: false });
    const [one, two] = await Promise.all([
      hub.request({ action: "inline-suggest", prompt: "show disk usage", sessionId: "term-1", shell: "bash" }),
      hub.request({ action: "inline-suggest", prompt: "list listening ports", sessionId: "term-2", shell: "bash" }),
    ]);
    expect(one.reply!.inlineSuggestion).toMatchObject({ sessionId: "term-1", source: "fallback" });
    expect(two.reply!.inlineSuggestion).toMatchObject({ sessionId: "term-2", source: "fallback" });
    expect(one.reply!.inlineSuggestion!.command).not.toBe(two.reply!.inlineSuggestion!.command);
    expect(one).not.toHaveProperty("inlineSuggestion");

    // With a model that answers, the suggestion is the model's and says so.
    const modelled = await makeHub();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ content: [{ type: "text", text: '{"command":"df -h /var","explanation":"Disk use of /var."}' }] }), { status: 200 })));
    const asked = await modelled.hub.request({ action: "inline-suggest", prompt: "how full is /var", sessionId: "t", shell: "bash" });
    expect(asked.reply!.inlineSuggestion).toMatchObject({ command: "df -h /var", source: "model" });
  });
});

describe("handlers that said one thing and did another", () => {
  it("lets the agent's tool change an agent without making a second one or wiping what the form set", async () => {
    const { hub } = await makeHub({ model: false });
    await hub.request({ action: "agent-save", agent: { id: "dba", name: "DBA", role: "Database lead", icon: "", mission: "Keep the databases healthy", systemPrompt: "Be careful.", defaultMode: "assisted", monthlyTokenBudget: 500_000, enabled: false, runnerId: undefined, kbDocIds: ["d1"] } as never });
    const task = { id: "t", title: "x", mode: "assisted", status: "running", messages: [], changes: [], sources: [], createdAt: 1, updatedAt: 1, maxCommands: 5, maxMinutes: 5, verification: "not-verified" } as unknown as AgentTask;
    hub.store.data.tasks.push(task);
    const broker = (hub as unknown as { broker: { issue: (t: AgentTask) => Promise<{ key: string }>; invoke: (k: string, r: unknown) => Promise<unknown> } }).broker;
    const { key } = await broker.issue(task);
    const result = await broker.invoke(key, { action: "sshs3_agent_and_mcp_manage", payload: { operation: "save_agent", name: "dba", mission: "Keep the databases healthy and the backups tested" } });
    expect(result).toMatchObject({ ok: true, updated: true });
    const agents = (await hub.snapshot()).agents!.filter((a) => a.name.toLowerCase() === "dba");
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ id: "dba", mission: "Keep the databases healthy and the backups tested", role: "Database lead", systemPrompt: "Be careful.", monthlyTokenBudget: 500_000, enabled: false, kbDocIds: ["d1"], defaultMode: "assisted" });
    // A new name is a new agent, with no emoji picked for it.
    await broker.invoke(key, { action: "sshs3_agent_and_mcp_manage", payload: { operation: "save_agent", name: "Network", mission: "Watch the links" } });
    expect((await hub.snapshot()).agents!.find((a) => a.name === "Network")).toMatchObject({ icon: "", defaultMode: "assisted" });
    await expect(broker.invoke(key, { action: "sshs3_agent_and_mcp_manage", payload: { operation: "save_agent", idOrName: "nobody", mission: "x" } })).rejects.toThrow('Agent "nobody" not found');
  });

  it("lets something be done with a demo conversation instead of answering 'Task not found'", async () => {
    const { hub } = await makeHub({ demo: true });
    const snap = await hub.snapshot();
    const demo = snap.tasks.find((t) => !hub.store.data.tasks.some((s) => s.id === t.id));
    expect(demo).toBeDefined();
    // Stopping (or replying to, resuming, deciding a plan of) a listed conversation works: it becomes a stored one.
    const after = await hub.request({ action: "stop", taskId: demo!.id });
    expect(hub.store.data.tasks.some((t) => t.id === demo!.id)).toBe(true);
    expect(after.tasks.filter((t) => t.id === demo!.id)).toHaveLength(1);
  });

  it("runs a schedule on the endpoint that is configured now, not refused for the one it was made with", async () => {
    const { hub } = await makeHub();
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: { body?: string }) => {
      calls.push(`${String(url)} ${JSON.parse(init?.body ?? "{}").model ?? ""}`);
      return String(url).includes("anthropic") ? say("Checked.") : new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "Checked." } }] })}\n\ndata: [DONE]\n\n`, { status: 200 });
    }));
    await hub.request({ action: "schedule-save", schedule: { id: "s", title: "Hourly look", prompt: "Look at the load", profileId: "local", shell: "bash", intervalMinutes: 60, enabled: true, mode: "advice", provider: "anthropic", model: "claude-haiku-5-5", maxCommands: 3, maxMinutes: 5 } as never });
    const schedule = hub.store.data.schedules[0];
    const start = (hub as unknown as { start: (i: unknown, s: unknown) => Promise<AgentTask> }).start.bind(hub);
    // Same endpoint: the model the job was pinned to.
    const first = await settled(hub, (await start({ prompt: schedule.prompt, mode: "advice" }, schedule)).id);
    expect(first.model).toBe("claude-haiku-5-5");
    // The team moves to another provider. The job follows, on the configured model.
    await hub.request({ action: "configure", config: { provider: "openai-compatible", model: "local-model", baseUrl: "http://127.0.0.1:9/v1", apiKey: "k-1234567890" } } as never); // pragma: allowlist secret
    const second = await settled(hub, (await start({ prompt: schedule.prompt, mode: "advice" }, schedule)).id);
    expect(second.error ?? "").not.toContain("Scheduled provider differs");
    expect(second.model).toBe("local-model");
    expect(calls.at(-1)).toContain("127.0.0.1:9");
  });

  it("says that a comparison of pages is going on, and how it ended", async () => {
    const { hub } = await makeHub();
    const page = (id: string, body: string) => ({ id, kind: "system", title: `Postgres ${id}`, when: "When working on pg-01", targets: ["pg-01"], body, sources: [], history: [], updatedAt: Date.now(), updatedBy: "person", createdAt: Date.now() });
    hub.store.data.kbPages = [page("a", "The pooler listens on port 6432."), page("b", "The pooler listens on port 5432.")] as never;
    expect((await hub.snapshot()).kbWork).toEqual({ rebuilding: [], checkingContradictions: false, lastCheck: undefined, rebuilt: {} });
    let release!: (r: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((r) => (release = r))));
    const asked = await hub.request({ action: "kb-check-contradictions" });
    // The request returns at once; the snapshot says the work is under way.
    expect(asked.kbWork!.checkingContradictions).toBe(true);
    await vi.waitFor(() => expect(release).toBeDefined());
    release(say('{"contradictions":[]}'));
    await vi.waitFor(async () => expect((await hub.snapshot()).kbWork!.checkingContradictions).toBe(false), { timeout: 8000 });
    const done = (await hub.snapshot()).kbWork!;
    expect(done.lastCheck).toMatchObject({ found: 0 });
    expect(done.lastCheck!.at).toBeGreaterThan(0);
  });

  it("takes documents from a bucket the same way in as from a folder: no duplicates, queued to be read", async () => {
    const { hub } = await makeHub({ model: false });
    const add = (hub as unknown as { addIngestedDocs: (docs: KbDocument[]) => void }).addIngestedDocs.bind(hub);
    const doc = (id: string, content: string): KbDocument => ({ id, title: id, content, sourceType: "s3", tags: [], chunks: [], updatedAt: Date.now() }) as unknown as KbDocument;
    add([doc("a", "Restart the queue with systemctl restart rabbitmq-server."), doc("b", "Restart the queue with systemctl restart rabbitmq-server.")]);
    let docs = hub.store.data.kbDocuments!;
    expect(docs.map((d) => d.id)).toEqual(["a"]);
    expect(docs[0]).toMatchObject({ reading: { state: "queued" }, titleFromSource: true });
    expect(docs[0].contentHash).toMatch(/\S/);
    // The same again changes nothing; a changed file is taken in again.
    add([doc("a", "Restart the queue with systemctl restart rabbitmq-server.")]);
    add([doc("a", "Drain the consumers first, then restart the queue.")]);
    docs = hub.store.data.kbDocuments!;
    expect(docs).toHaveLength(1);
    expect(docs[0].content).toContain("Drain the consumers");
  });
});

describe("handlers nothing tested", () => {
  it("answers each with a snapshot and does what its name says", async () => {
    const { hub } = await makeHub({ model: false });
    // Goals and tickets.
    let snap = await hub.request({ action: "goal-save", goal: { title: "Zero failed backups" } } as never);
    const goal = snap.workGoals![0];
    snap = await hub.request({ action: "ticket-save", ticket: { title: "Test the restore", goalId: goal.id } } as never);
    const ticket = snap.workTickets![0];
    snap = await hub.request({ action: "ticket-comment", id: ticket.id, text: "Use last night's dump." } as never);
    expect(snap.workTickets![0].comments!.at(-1)!.text).toBe("Use last night's dump.");
    snap = await hub.request({ action: "ticket-move", id: ticket.id, status: "todo" } as never);
    expect(snap.workTickets![0]).toMatchObject({ status: "todo" });
    expect(snap.workTickets![0].statusAt).toBeGreaterThan(0);
    snap = await hub.request({ action: "ticket-delete", id: ticket.id });
    expect((snap.workTickets ?? []).filter((t) => !("deleted" in t && t.deleted))).toEqual([]);
    snap = await hub.request({ action: "goal-delete", id: goal.id });
    expect((snap.workGoals ?? []).filter((g) => !("deleted" in g && g.deleted))).toEqual([]);
    // Schedules.
    snap = await hub.request({ action: "schedule-save", schedule: { title: "Nightly look", prompt: "df -h", profileId: "local", shell: "bash", intervalMinutes: 1440, enabled: true, mode: "advice", provider: "anthropic", model: "m", maxCommands: 3, maxMinutes: 5 } as never });
    expect(snap.schedules).toHaveLength(1);
    snap = await hub.request({ action: "schedule-delete", id: snap.schedules[0].id });
    expect(snap.schedules).toEqual([]);
    // Memory.
    snap = await hub.request({ action: "memory-save", entry: { kind: "memory", scope: "workspace", title: "Pooler port", text: "pgbouncer listens on 6432." } } as never);
    const memory = snap.memories.find((m) => m.title === "Pooler port")!;
    snap = await hub.request({ action: "memory-delete", id: memory.id });
    expect(snap.memories.some((m) => m.id === memory.id)).toBe(false);
    // Pages.
    snap = await hub.request({ action: "kb-page-save", page: { kind: "system", title: "Pooler", when: "When working on the pooler", targets: [], body: "## Facts\npgbouncer listens on 6432." } } as never);
    const page = snap.kbPages![0];
    await expect(hub.request({ action: "kb-page-rebuild", id: page.id })).rejects.toThrow("None of this page's sources");
    snap = await hub.request({ action: "kb-page-delete", id: page.id });
    expect((snap.kbPages ?? []).some((p) => p.id === page.id)).toBe(false);
    // History and odds and ends.
    snap = await hub.request({ action: "forget-history" });
    expect(snap.tasks).toEqual([]);
    snap = await hub.request({ action: "inventory-refresh" });
    expect(Array.isArray(snap.inventory)).toBe(true);
    await expect(hub.request({ action: "no-such-thing" } as never)).rejects.toThrow("Unknown AI request: no-such-thing");
  });
});

describe("a tool call reaching the right place", () => {
  it("sends sshs3_change down its own path, not through the management tools", () => {
    const req = mapToolCallToBrokerRequest("sshs3_change", {
      command: "systemctl restart nginx",
      description: "Restart nginx",
      check: { command: "systemctl is-active nginx", expected: "active" },
      rollback: "systemctl stop nginx",
      observeSeconds: 5,
      sessionId: "s1",
    }) as unknown as Record<string, unknown>;
    // "change" is what ToolBroker runs with a check and a rollback; the name itself would be an unknown action.
    expect(req.action).toBe("change");
    expect(req).toMatchObject({ command: "systemctl restart nginx", rollback: "systemctl stop nginx", observeSeconds: 5, id: "s1" });
    expect(req.check).toEqual({ command: "systemctl is-active nginx", expected: "active" });
  });

  it("still sends the management tools and MCP tools as they are", () => {
    expect(mapToolCallToBrokerRequest("sshs3_kb_search", { query: "x" })).toEqual({ action: "sshs3_kb_search", payload: { query: "x" } });
    expect(mapToolCallToBrokerRequest("mcp__srv__tool", { a: 1 })).toEqual({ action: "mcp__srv__tool", payload: { a: 1 } });
    expect(mapToolCallToBrokerRequest("terminal_command", { command: "ls" })).toMatchObject({ action: "command", command: "ls" });
  });
});
