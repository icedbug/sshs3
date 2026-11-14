import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DirectAgentRuntime, contextForModel, toolsForTask, withoutUnchanged } from "../../src/main/ai/hub/DirectAgentRuntime";
import type { AgentTask } from "../../src/shared/types/aiHub";

/**
 * What an unattended run is sent with every call to the model. A heartbeat
 * run used 808 k input tokens for three commands: every call carried the
 * whole tool list (the app-management tools included) and a snapshot holding
 * the app's settings, every terminal's output (the target's twice) and the
 * team's earlier workforce reports in full.
 */

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.restoreAllMocks();
});

function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

const task = (extra: Partial<AgentTask> = {}): AgentTask => ({
  id: "task-1",
  title: "Ticket: db-01 /var full",
  mode: "assisted",
  status: "running",
  target: { sessionId: "own", generation: "g", label: "db-01" },
  messages: [{ id: "m1", role: "user", text: "Work ticket t-1: /var on db-01 is full.", at: Date.now() }],
  changes: [],
  sources: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
  maxCommands: 10,
  maxMinutes: 5,
  verification: "not-verified",
  ...extra,
});

const OWN_OUTPUT = "OWN-TERMINAL-OUTPUT ".repeat(20);
const context = () => ({
  observedAt: Date.now(),
  terminals: [
    { id: "own", label: "db-01", state: "ready", recentOutput: OWN_OUTPUT },
    { id: "tab", label: "web-01", state: "ready", recentOutput: "A PERSON'S OTHER TAB" },
    { id: "old", label: "db-01", state: "disconnected", recentOutput: "A CLOSED TERMINAL" },
  ],
  appSettings: { theme: "dark", aiConfig: { contextWindowTokens: 128_000 } },
  snippets: [{ id: "s1", name: "SNIPPET-NAME", command: "uptime" }],
  schedules: [{ id: "sch", title: "SCHEDULE-TITLE" }],
  agents: [],
  mcpServers: [],
  recentWorkforceRuns: [{ id: "wf-1", title: "Health review", status: "completed", steps: [{ output: "SPECIALIST-REPORT ".repeat(50) }], synthesis: "All good." }],
  workspaceServers: [{ id: "db-01", name: "db-01", host: "10.0.0.5" }],
  workspaceMemories: [{ id: "mem-1", kind: "memory", scope: "workspace", title: "Backups", text: "Dumps live in /var/backups/postgres.", updatedAt: 1 }],
  target: { session: { id: "own", label: "db-01" }, output: OWN_OUTPUT, source: "terminal:own" },
});

const MANAGEMENT = [
  "sshs3_manage_app_and_settings",
  "sshs3_manage_server",
  "sshs3_agent_and_mcp_manage",
  "sshs3_manage_s3_and_sync",
  "sshs3_workspace_layout",
  "sshs3_manage_schedule",
  "sshs3_manage_cluster_and_folders",
];

describe("what a run that works a ticket or a schedule is offered", () => {
  it("is not offered the tools that manage the app; a person's conversation still is", () => {
    const person = toolsForTask(task()).map((t) => t.name);
    for (const name of MANAGEMENT) expect(person).toContain(name);
    for (const alone of [task({ ticketId: "t-1" }), task({ scheduleId: "sch" })]) {
      const names = toolsForTask(alone).map((t) => t.name);
      for (const name of MANAGEMENT) expect(names).not.toContain(name);
      // The work itself stays possible: commands, changes with their proof, the board, files, pages, plans.
      for (const name of ["terminal_command", "sshs3_change", "sshs3_tickets", "sshs3_storage_ops", "sshs3_kb_search", "sshs3_plan_propose", "todo_write"])
        expect(names).toContain(name);
    }
  });

  it("gives the target's output once, and a ticket run no settings, other tabs or whole workforce reports", () => {
    const forPerson = JSON.stringify(contextForModel(task(), context()));
    expect(forPerson.split("OWN-TERMINAL-OUTPUT").length - 1).toBe(20);
    expect(forPerson).toContain("A PERSON'S OTHER TAB");
    expect(forPerson).toContain("SNIPPET-NAME");
    const alone = JSON.stringify(contextForModel(task({ ticketId: "t-1" }), context()));
    expect(alone.split("OWN-TERMINAL-OUTPUT").length - 1).toBe(20);
    for (const gone of ["A PERSON'S OTHER TAB", "A CLOSED TERMINAL", "SNIPPET-NAME", "SCHEDULE-TITLE", "theme", "SPECIALIST-REPORT"])
      expect(alone).not.toContain(gone);
    // What the run is about stays: its target, the servers, the memories, what the workforce concluded.
    for (const kept of ["10.0.0.5", "Dumps live in", "All good.", "\"label\":\"web-01\""]) expect(alone).toContain(kept);
  });

  it("does not send a part of the workspace again that reads as it did in the run's snapshot", () => {
    const before = context();
    const snapshot = JSON.stringify({ workspaceServers: before.workspaceServers, recentWorkforceRuns: before.recentWorkforceRuns }) +
      "\n- [memory, workspace] Backups: Dumps live in /var/backups/postgres.";
    const later = { ...context(), workspaceServers: before.workspaceServers };
    const out = withoutUnchanged(later, snapshot) as Record<string, unknown>;
    expect(out.workspaceServers).toBeUndefined();
    expect(out.recentWorkforceRuns).toBeUndefined();
    expect(out.workspaceMemories).toEqual([{ id: "mem-1", title: "Backups", inSnapshot: true }]);
    // What changed, or was never in the snapshot, is sent.
    expect(out.terminals).toBeDefined();
    expect(out.target).toBeDefined();
    expect((out.unchangedSinceRunStart as { parts: string[] }).parts).toEqual(
      expect.arrayContaining(["workspaceServers", "recentWorkforceRuns"]),
    );
    // Without a snapshot to compare with, nothing is left out.
    expect(withoutUnchanged(later, undefined)).toBe(later);
  });
});

describe("a ticket run on the ChatGPT backend", () => {
  it("is sent the slimmer tools and snapshot, gets workspace_context without repeats, and reports its usage as it goes", async () => {
    const replies = [
      [
        'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"c1","name":"workspace_context","arguments":"{}"}}',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":1000,"output_tokens":20}}}',
      ],
      [
        'data: {"type":"response.output_text.delta","delta":"Done."}',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":1500,"output_tokens":30}}}',
      ],
    ];
    const bodies: Array<Record<string, unknown>> = [];
    const mockFetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      const sse = [...replies[Math.min(bodies.length - 1, replies.length - 1)], ""].join("\n\n");
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sse));
            controller.close();
          },
        }),
        { status: 200 },
      );
    });
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-run-cost-"));
    disposals.push(() => fs.rm(tmpDir, { recursive: true, force: true }));
    await fs.mkdir(path.join(tmpDir, "hermes-native"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "hermes-native", "auth.json"),
      JSON.stringify({
        version: 1,
        providers: { "openai-codex": { tokens: { access_token: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }), refresh_token: "r" } } },
      }),
      "utf-8",
    );
    const runtime = new DirectAgentRuntime(async () => context(), tmpDir, mockFetch as unknown as typeof fetch);
    const events: Array<{ type: string; usage?: Record<string, number> }> = [];
    await runtime.start(task({ ticketId: "t-1" }), { kind: "openai-codex", model: "gpt-6.1-sol" }, (e) => events.push(e));

    expect(bodies).toHaveLength(2);
    const tools = (bodies[0].tools as Array<{ name: string }>).map((t) => t.name);
    for (const name of MANAGEMENT) expect(tools).not.toContain(name);
    const input = bodies[0].input as Array<{ content?: Array<{ text?: string }> }>;
    const snapshot = input[0].content?.[0]?.text ?? "";
    expect(snapshot).toContain("Workspace & Terminal Snapshot");
    expect(snapshot).not.toContain("SNIPPET-NAME");
    expect(snapshot.split("OWN-TERMINAL-OUTPUT").length - 1).toBe(20);

    const answer = (bodies[1].input as Array<{ type?: string; output?: string }>).find((i) => i.type === "function_call_output");
    const sent = JSON.parse(answer?.output ?? "{}") as Record<string, unknown>;
    expect(sent.unchangedSinceRunStart).toBeDefined();
    expect(sent.workspaceServers).toBeUndefined();
    expect(sent.snippets).toBeUndefined();

    // Usage while the run goes on, added up, before the run's end says the total.
    const live = events.filter((e) => e.type === "usage.updated").map((e) => e.usage);
    expect(live[0]).toEqual({ input_tokens: 1000, output_tokens: 20 });
    expect(live.at(-1)).toEqual({ input_tokens: 2500, output_tokens: 50 });
    expect(events.find((e) => e.type === "run.completed")?.usage).toMatchObject({ input_tokens: 2500, output_tokens: 50 });
  });
});
