import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_NUDGES_WITHOUT_PROGRESS,
  continuationMessage,
  failureHints,
  newDiscipline,
  noteToolResult,
  operatingInstructions,
  parseTodos,
  wantsThoroughMode,
} from "../../src/main/ai/hub/AgentDiscipline";
import { DirectAgentRuntime, retryPolicy } from "../../src/main/ai/hub/DirectAgentRuntime";
import type { RunEvent } from "../../src/main/ai/hub/AgentRuntime";
import type { AgentTask, AgentTodo, MemoryEntry } from "../../src/shared/types/aiHub";

afterEach(() => {
  retryPolicy.baseDelayMs = 1000;
});

const todo = (content: string, status: AgentTodo["status"], note?: string): AgentTodo => ({
  id: content,
  content,
  status,
  ...(note ? { note } : {}),
});

describe("thorough mode keyword", () => {
  it("is ultrawork or ulw as a word of its own", () => {
    expect(wantsThoroughMode("ulw fix the replication lag")).toBe(true);
    expect(wantsThoroughMode("Fix it (ultrawork)")).toBe(true);
    expect(wantsThoroughMode("please ULW")).toBe(true);
    expect(wantsThoroughMode("the bulwark host is down")).toBe(false);
    expect(wantsThoroughMode("restart nginx")).toBe(false);
  });
});

describe("parseTodos", () => {
  it("accepts a list, gives items ids, and keeps the evidence note", () => {
    const got = parseTodos({
      todos: [
        { content: "Check disk on prod-db", status: "completed", note: "df -h: 41% used" },
        { content: "Rotate the WAL archive", status: "in_progress" },
        { id: "v", content: "Verify replication", status: "pending" },
      ],
    });
    expect(got).toEqual({
      todos: [
        { id: "t1", content: "Check disk on prod-db", status: "completed", note: "df -h: 41% used" },
        { id: "t2", content: "Rotate the WAL archive", status: "in_progress" },
        { id: "v", content: "Verify replication", status: "pending" },
      ],
    });
  });

  it("refuses what would make the list meaningless, and says why", () => {
    const error = (todos: unknown): string => (parseTodos({ todos }) as { error: string }).error;
    expect(error("nope")).toMatch(/array/);
    expect(error([{ content: " ", status: "pending" }])).toMatch(/no content/);
    expect(error([{ content: "x", status: "done" }])).toMatch(/status must be/);
    // Dropping or parking an item needs its reason.
    expect(error([{ content: "Restart the broker", status: "cancelled" }])).toMatch(/say why/);
    expect(error([{ content: "Restart the broker", status: "blocked" }])).toMatch(/say why/);
    expect(error([{ content: "a", status: "in_progress" }, { content: "b", status: "in_progress" }])).toMatch(/Only one/);
    expect(error(Array.from({ length: 31 }, (_, i) => ({ content: `s${i}`, status: "pending" })))).toMatch(/At most 30/);
  });
});

describe("continuationMessage", () => {
  it("sends a run back to its open items, by name, and lets it stop once they are closed", () => {
    const state = newDiscipline([todo("Check disk", "completed", "41%"), todo("Reload nginx", "in_progress"), todo("Verify SSE", "pending")]);
    const message = continuationMessage(state)!;
    expect(message).toContain("2 item(s)");
    expect(message).toContain("(in_progress) Reload nginx");
    expect(message).toContain("(pending) Verify SSE");
    expect(message).not.toContain("Check disk");
    state.todos = [todo("Check disk", "completed", "41%"), todo("Reload nginx", "completed", "exit 0"), todo("Verify SSE", "blocked", "needs the user's API key")];
    expect(continuationMessage(state)).toBeUndefined();
  });

  it("gives up after returning to an unchanged list a few times, so a stuck run can end", () => {
    const state = newDiscipline([todo("Reload nginx", "pending")]);
    for (let i = 0; i < MAX_NUDGES_WITHOUT_PROGRESS; i++) expect(continuationMessage(state)).toBeDefined();
    expect(continuationMessage(state)).toBeUndefined();
  });

  it("asks once for the check when something was changed and nothing verified it since", () => {
    const state = newDiscipline();
    noteToolResult(state, "terminal_command", { command: "df -h" }, { exitCode: 0, output: "" });
    expect(continuationMessage(state)).toBeUndefined(); // looking is not changing

    noteToolResult(state, "terminal_command", { command: "systemctl restart nginx" }, { exitCode: 0, output: "" });
    expect(state.madeChanges).toBe(true);
    expect(continuationMessage(state)).toMatch(/no check has passed/);
    expect(continuationMessage(state)).toBeUndefined(); // asked once
  });

  it("does not ask for a check that has already passed, and asks again after a later change", () => {
    const state = newDiscipline();
    noteToolResult(state, "file_write", { path: "/etc/nginx/x.conf" }, { ok: true });
    // Exit 0 without the expected output is not a passed check.
    noteToolResult(state, "terminal_verify", { command: "nginx -t", expected: "syntax is ok" }, { exitCode: 0, output: "warning" });
    expect(state.verifiedSinceChange).toBe(false);
    noteToolResult(state, "terminal_verify", { command: "nginx -t", expected: "syntax is ok" }, { exitCode: 0, output: "nginx: syntax is ok" });
    expect(continuationMessage(state)).toBeUndefined();
    noteToolResult(state, "sshs3_cluster_exec", { command: "systemctl reload nginx" }, { ok: true });
    expect(continuationMessage(state)).toMatch(/no check has passed/);
  });

  it("does not count a failed or refused change as a change", () => {
    const state = newDiscipline();
    noteToolResult(state, "terminal_command", { command: "systemctl restart nginx" }, { exitCode: 1, output: "failed" });
    noteToolResult(state, "file_write", { path: "/etc/x" }, { error: "denied by the user" });
    expect(state.madeChanges).toBe(false);
  });

  it("in thorough mode asks once for a task list when there is none", () => {
    const state = newDiscipline([], true);
    expect(continuationMessage(state)).toMatch(/no task list/);
    expect(continuationMessage(state)).toBeUndefined();
    expect(continuationMessage(newDiscipline([], false))).toBeUndefined();
  });
});

describe("failureHints", () => {
  const memory = (id: string, extra: Partial<MemoryEntry>): MemoryEntry => ({
    id, kind: "skill", scope: "workspace", title: id, text: "", updatedAt: 1, ...extra,
  });
  const memories = [
    memory("pg", { title: "Postgres refuses connections after reload", text: "pg_hba.conf must list the pgbouncer subnet; then systemctl reload postgresql", errorSignature: "no pg_hba.conf entry" }),
    memory("nginx", { title: "nginx bind fails", text: "port 443 is held by haproxy on the edge nodes; stop haproxy first", sourceCommand: "systemctl restart nginx" }),
    memory("wifi", { title: "Office wifi", text: "the guest password rotates monthly" }),
  ];

  it("puts an exact error-signature match first", () => {
    const hints = failureHints("psql -h prod-db", 'FATAL: no pg_hba.conf entry for host "10.0.0.5"', memories);
    expect(hints[0].id).toBe("pg");
  });

  it("matches on distinctive shared words, and returns nothing when nothing really matches", () => {
    const hints = failureHints("systemctl restart nginx", "nginx: [emerg] bind() to 0.0.0.0:443 failed (98: Address already in use) haproxy", memories);
    expect(hints.map((h) => h.id)).toEqual(["nginx"]);
    expect(failureHints("ls /nonexistent", "No such file or directory", memories)).toEqual([]);
  });
});

describe("operatingInstructions", () => {
  it("tells the agent how to work, and only claims the abilities the run has", () => {
    const acting = operatingInstructions({ mode: "assisted", target: { label: "prod" }, thorough: false, agentSection: [] });
    expect(acting).toContain("what is being asked");
    expect(acting).toContain("terminal_verify");
    expect(acting).toContain("You can run commands and write files on the target");
    expect(acting).not.toContain("Thorough mode");
    const advising = operatingInstructions({ mode: "advice", target: null, thorough: true, agentSection: [] });
    expect(advising).toContain("you cannot run commands or write files");
    expect(advising).toContain("Thorough mode");
    for (const text of [acting, advising]) expect(text).not.toMatch(/encyclopedic|100%|Master Architect/i);
  });
});

// ---------------------------------------------------------------- in the run loop

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
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  ]);
const call = (name: string, input: unknown, id = "tu_1"): Response =>
  sse([
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
  ]);

const model = { kind: "anthropic" as const, model: "claude-opus-5-5", apiKey: "sk-ant-test" }; // pragma: allowlist secret
const task = (extra: Partial<AgentTask> = {}): AgentTask => ({
  id: "t1",
  title: "t",
  mode: "assisted",
  status: "running",
  target: { sessionId: "s", generation: "g", label: "prod-api-01" },
  messages: [{ id: "m", role: "user", text: "SSE streams drop after 60s, fix it", at: 1 }],
  changes: [],
  sources: [],
  createdAt: 1,
  updatedAt: 1,
  maxCommands: 10,
  maxMinutes: 5,
  verification: "not-verified",
  ...extra,
});

async function run(
  responses: Response[],
  broker: (req: Record<string, unknown>) => unknown,
  t = task(),
): Promise<{ bodies: Array<Record<string, unknown>>; events: RunEvent[] }> {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const next = responses.shift();
    // Answered as a rejected request, so a run that asks too often fails at once instead of retrying.
    if (!next) return new Response("the test ran out of model responses", { status: 400 });
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return next;
  });
  const events: RunEvent[] = [];
  await new DirectAgentRuntime((async (req: Record<string, unknown>) => broker(req)) as never, undefined, fetchImpl as unknown as typeof fetch).start(
    t,
    model,
    (e) => events.push(e),
  );
  return { bodies, events };
}
const lastUser = (body: Record<string, unknown>): string => {
  const messages = body.messages as Array<{ role: string; content: unknown }>;
  return JSON.stringify(messages.filter((m) => m.role === "user").at(-1)!.content);
};

describe("the run loop holds the agent to its work", () => {
  it("sends the agent back when it stops with open items, and lets it finish once they are closed", async () => {
    const { bodies, events } = await run(
      [
        call("todo_write", { todos: [{ content: "Raise proxy_read_timeout", status: "in_progress" }, { content: "Verify an SSE stream survives 90s", status: "pending" }] }),
        say("I have raised the timeout."), // stops early
        call("todo_write", { todos: [{ content: "Raise proxy_read_timeout", status: "completed", note: "nginx -t ok" }, { content: "Verify an SSE stream survives 90s", status: "completed", note: "curl held 95s" }] }, "tu_2"),
        say("Done: timeout is 120s and a stream held for 95s."),
      ],
      () => ({}),
    );
    expect(bodies).toHaveLength(4);
    // The third request carries the message that sent it back, naming what is open.
    expect(lastUser(bodies[2])).toContain("still open");
    expect(lastUser(bodies[2])).toContain("Verify an SSE stream survives 90s");
    expect(events.filter((e) => e.type === "run.completed")).toHaveLength(1);
    expect(events.find((e) => e.type === "run.completed")!.output).toContain("held for 95s");
    // The list reaches the hub each time it is written.
    const lists = events.filter((e) => e.type === "todos.updated");
    expect(lists).toHaveLength(2);
    expect(lists[1].todos!.every((t) => t.status === "completed")).toBe(true);
  });

  it("tells the model why a bad task list was refused instead of accepting it", async () => {
    const { bodies, events } = await run(
      [call("todo_write", { todos: [{ content: "Restart the broker", status: "cancelled" }] }), say("ok")],
      () => ({}),
    );
    expect(lastUser(bodies[1])).toContain("say why");
    expect(events.some((e) => e.type === "todos.updated")).toBe(false);
  });

  it("asks for the check after a change, and not after only looking", async () => {
    const changed = await run(
      [call("terminal_command", { command: "systemctl reload nginx" }), say("Reloaded."), say("Reloaded; I could not verify the stream from here, so this is unverified.")],
      (req) => (req.action === "command" ? { exitCode: 0, output: "" } : {}),
    );
    expect(changed.bodies).toHaveLength(3);
    expect(lastUser(changed.bodies[2])).toContain("no check has passed");
    expect(changed.events.find((e) => e.type === "run.completed")!.output).toContain("unverified");

    const looked = await run(
      [call("terminal_command", { command: "df -h" }), say("Disk is at 41%.")],
      (req) => (req.action === "command" ? { exitCode: 0, output: "41%" } : {}),
    );
    expect(looked.bodies).toHaveLength(2);
  });

  it("puts what the team knows about a failure into the failed command's result", async () => {
    const skills: MemoryEntry[] = [
      { id: "s1", kind: "skill", scope: "workspace", title: "nginx bind fails on edge nodes", text: "port 443 is held by haproxy; stop haproxy first", sourceCommand: "systemctl restart nginx", updatedAt: 1 },
    ];
    const { bodies } = await run(
      [call("terminal_command", { command: "systemctl restart nginx" }), say("It failed; haproxy holds the port.")],
      (req) =>
        req.action === "command"
          ? { exitCode: 1, output: "nginx: [emerg] bind() to 0.0.0.0:443 failed, haproxy" }
          : req.action === "skills"
            ? skills
            : req.action === "memory"
              ? []
              : {},
    );
    const result = lastUser(bodies[1]);
    expect(result).toContain("teamMemoryOnThisFailure");
    expect(result).toContain("stop haproxy first");
  });

  it("turns thorough mode on from the keyword: said in the instructions, and a task list is asked for", async () => {
    const { bodies } = await run(
      [say("The cause is the 60s timeout."), say("It was a plain question; nothing to list.")],
      () => ({}),
      task({ mode: "advice", target: undefined, messages: [{ id: "m", role: "user", text: "ulw why do SSE streams drop?", at: 1 }] }),
    );
    expect(JSON.stringify(bodies[0].system)).toContain("Thorough mode");
    expect(bodies).toHaveLength(2);
    expect(lastUser(bodies[1])).toContain("no task list");
  });

  it("carries the task list of an earlier run of the conversation into the next one", async () => {
    const { bodies } = await run(
      [say("Still working on it."), say("Blocked."), say("Stopping.")],
      () => ({}),
      task({ todos: [{ id: "t1", content: "Verify replication", status: "pending" }] }),
    );
    expect(lastUser(bodies[1])).toContain("Verify replication");
  });
});

describe("provider errors that pass", () => {
  it("tries a rate-limited or overloaded request again and then completes", async () => {
    retryPolicy.baseDelayMs = 1;
    const { bodies, events } = await run(
      [new Response("overloaded", { status: 529 }), new Response("slow down", { status: 429 }), say("Disk is fine.")],
      () => ({}),
      task({ mode: "advice", target: undefined }),
    );
    expect(bodies).toHaveLength(3);
    expect(events.find((e) => e.type === "run.completed")!.output).toBe("Disk is fine.");
  });

  it("does not retry a rejected request, and gives up on one that keeps failing", async () => {
    retryPolicy.baseDelayMs = 1;
    const rejected = await run([new Response('{"error":"invalid x-api-key"}', { status: 401 })], () => ({}), task({ mode: "advice", target: undefined }));
    expect(rejected.bodies).toHaveLength(1);
    expect(rejected.events.find((e) => e.type === "run.failed")!.error).toContain("401");

    const down = await run(
      Array.from({ length: 4 }, () => new Response("unavailable", { status: 503 })),
      () => ({}),
      task({ mode: "advice", target: undefined }),
    );
    expect(down.bodies).toHaveLength(4); // the first try and three more
    expect(down.events.find((e) => e.type === "run.failed")!.error).toContain("503");
  });
});

describe("the same discipline with an OpenAI-compatible model", () => {
  const chat = (delta: Record<string, unknown>): Response => {
    const text = [`data: ${JSON.stringify({ choices: [{ delta }] })}`, "data: [DONE]", ""].join("\n\n");
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(text));
          c.close();
        },
      }),
      { status: 200 },
    );
  };
  const toolCall = (name: string, args: unknown): Response =>
    chat({ tool_calls: [{ index: 0, id: "call_1", function: { name, arguments: JSON.stringify(args) } }] });

  it("sends the agent back to its open items and retries a passing server error", async () => {
    retryPolicy.baseDelayMs = 1;
    const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    const responses = [
      toolCall("todo_write", { todos: [{ content: "Check replication lag", status: "pending" }] }),
      new Response("bad gateway", { status: 502 }),
      chat({ content: "I will look at it." }),
      toolCall("todo_write", { todos: [{ content: "Check replication lag", status: "completed", note: "lag 0s" }] }),
      chat({ content: "Replication lag is 0s." }),
    ];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return responses.shift()!;
    });
    const events: RunEvent[] = [];
    await new DirectAgentRuntime((async () => ({})) as never, undefined, fetchImpl as unknown as typeof fetch).start(
      task({ mode: "advice", target: undefined }),
      { kind: "custom", model: "llama3", apiKey: "", baseUrl: "http://localhost:11434/v1" },
      (e) => events.push(e),
    );
    expect(bodies).toHaveLength(5);
    const sentBack = bodies[3].messages.at(-1)!;
    expect(sentBack.role).toBe("user");
    expect(String(sentBack.content)).toContain("Check replication lag");
    // The early stop is kept in the conversation before the message that answers it.
    expect(bodies[3].messages.at(-2)).toMatchObject({ role: "assistant", content: "I will look at it." });
    expect(events.find((e) => e.type === "run.completed")!.output).toBe("Replication lag is 0s.");
  });
});

describe("a run that outgrows its context", () => {
  const BIG = "x".repeat(30_000);
  // A small window, so the transcript budget is the 40,000-character floor.
  const broker = (req: Record<string, unknown>): unknown =>
    req.action === "context"
      ? { appSettings: { aiConfig: { contextWindowTokens: 16_000 } } }
      : req.action === "command"
        ? { exitCode: 0, output: `${String(req.command)}: 41% used ${BIG}` }
        : {};
  const looking = task({ messages: [{ id: "m", role: "user", text: "Is any disk on prod filling up?", at: 1 }] });

  it("asks the agent for a handover note and continues from the conversation, the note and a digest, replaying nothing else", async () => {
    const { bodies, events } = await run(
      [
        call("todo_write", { todos: [{ content: "Check disks on prod-api-01", status: "in_progress" }] }, "tu_0"),
        call("terminal_command", { command: "df -h /" }, "tu_1"),
        call("terminal_command", { command: "df -h /var" }, "tu_2"),
        say("HANDOVER: / is at 41% on prod-api-01 (df -h /). /var also 41%. Next: check /data."),
        call("todo_write", { todos: [{ content: "Check disks on prod-api-01", status: "completed", note: "all at 41%" }] }, "tu_3"),
        say("No disk on prod-api-01 is filling up: all at 41%."),
      ],
      broker,
      looking,
    );
    expect(bodies).toHaveLength(6);
    // Two large results in: the fourth request asks for the note instead of going on.
    expect(lastUser(bodies[3])).toContain("write a handover note for yourself");
    // The fifth starts over from the conversation plus the handover.
    const after = bodies[4].messages as Array<{ role: string; content: unknown }>;
    expect(after).toHaveLength(2);
    expect(after[0]).toMatchObject({ role: "user", content: "Is any disk on prod filling up?" });
    const handover = String(after[1].content);
    expect(handover).toContain("HANDOVER: / is at 41% on prod-api-01");
    expect(handover).toContain("(in_progress) Check disks on prod-api-01");
    expect(handover).toContain("terminal_command(");
    expect(handover).toContain("df -h /var");
    // The bulk is gone, and no earlier turn or tool block is replayed.
    expect(JSON.stringify(after).length).toBeLessThan(12_000);
    expect(JSON.stringify(after)).not.toContain("tool_use");
    // The system prompt and tools are untouched by a compaction.
    expect(bodies[4].system).toEqual(bodies[0].system);
    expect(bodies[4].tools).toEqual(bodies[0].tools);
    expect(events.find((e) => e.type === "run.completed")!.output).toContain("all at 41%");
  });

  it("asks again after the round when the agent calls a tool instead of writing the note", async () => {
    const { bodies } = await run(
      [
        call("terminal_command", { command: "df -h /" }, "tu_1"),
        call("terminal_command", { command: "df -h /var" }, "tu_2"),
        call("terminal_command", { command: "df -h /data" }, "tu_3"), // ignores the request
        say("HANDOVER: all three at 41%."),
        say("Nothing is filling up."),
      ],
      broker,
      looking,
    );
    expect(lastUser(bodies[2])).toContain("handover note");
    expect(lastUser(bodies[3])).toContain("handover note");
    const after = bodies[4].messages as Array<{ content: unknown }>;
    expect(after).toHaveLength(2);
    expect(String(after[1].content)).toContain("HANDOVER: all three at 41%.");
  });

  it("does not compact a run that stays within its budget", async () => {
    const { bodies } = await run(
      [call("terminal_command", { command: "uptime" }), say("Load is fine.")],
      (req) => (req.action === "command" ? { exitCode: 0, output: "load 0.1" } : {}),
      looking,
    );
    expect(JSON.stringify(bodies)).not.toContain("handover note");
  });
});

describe("handoverMessage", () => {
  it("keeps the note, the task list with its evidence and the latest calls, and says when there was no note", async () => {
    const { handoverMessage } = await import("../../src/main/ai/hub/AgentDiscipline");
    const text = handoverMessage(
      "  Disk is at 41%.  ",
      [todo("Check disk", "completed", "df: 41%"), todo("Check inodes", "pending")],
      [{ name: "terminal_command", input: '{"command":"df -h"}', output: "41% " + "y".repeat(5000) }],
    );
    expect(text).toContain("Disk is at 41%.");
    expect(text).toContain("- (completed) Check disk — df: 41%");
    expect(text).toContain("- (pending) Check inodes");
    expect(text).toContain('terminal_command({"command":"df -h"})');
    expect(text.length).toBeLessThan(2000);
    expect(handoverMessage("", [], [])).toContain("You wrote no note");
  });
});
