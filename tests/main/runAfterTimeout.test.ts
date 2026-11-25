import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentTask } from "../../src/shared/types/aiHub";
import { STILL_RUNNING } from "../../src/main/ai/hub/TerminalRegistry";

/**
 * A command that runs out of time is left running, and the agent is told to use another terminal or
 * to ask the person to look. The run goes on, so that the agent can do that: in the lab it was stopped
 * at that very moment instead, and the person got no answer at all (a psql that asked for a password,
 * a `sleep 150`). A terminal that is closed or lost under a run still ends it.
 */

vi.mock("electron", () => ({
  app: { getPath: () => os.tmpdir(), quit: () => {} },
  Notification: { isSupported: () => false },
  powerMonitor: { on: vi.fn(), removeListener: vi.fn() },
}));

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const d of disposals.splice(0)) await d();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
    { type: "message_start", message: { usage: { input_tokens: 700 } } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "message_delta", usage: { output_tokens: 30 } },
    { type: "message_stop" },
  ]);
const callTool = (name: string, input: Record<string, unknown>): Response =>
  sse([
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name, input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
  ]);

const SERVERS = [{ id: "srv-db01", name: "db-01", host: "db01.internal", port: 22, username: "ops" }];
const ANSWER = "psql asked for a password, so the check did not run. It is still waiting in the terminal on db-01.";

async function makeHub() {
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(false);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-timeout-run-"));
  const hub = new HubService(
    {
      changed: () => {},
      inventoryTargets: async () => [],
      backgroundChanged: async () => {},
      openSchedule: async () => "s1",
      show: () => {},
      aiConfigFilePath: path.join(dir, "ai.json"),
      workspaceServers: async () => SERVERS,
    } as never,
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
    config: { enabled: true, provider: "anthropic", model: "claude-opus-5-5", apiKey: "sk-ant-test" }, // pragma: allowlist secret
    preferences: { proposeMemories: false },
  });
  return hub;
}
type Hub = Awaited<ReturnType<typeof makeHub>>;
const whenSettled = (hub: Hub, task: AgentTask) => (hub as unknown as { whenSettled(t: AgentTask): Promise<void> }).whenSettled(task);

/**
 * A shell on db-01 that answers every command at once, except one that runs psql: that one begins,
 * asks for a password and never ends. Every command is given a short time here, so the test does not
 * wait out the two minutes a command has.
 */
async function terminalWithPsqlAskingForAPassword(hub: Hub) {
  const typed: string[] = [];
  hub.terminals.register({ id: "t1", label: "db-01", kind: "ssh", profileId: "srv-db01" }, (data: string) => {
    typed.push(data);
    const n = /SSHS3;([a-f0-9]{32});BEGIN/.exec(data)?.[1];
    if (!n) return;
    const begin = `\x1b]777;SSHS3;${n};BEGIN\x07`;
    if (data.includes("psql")) queueMicrotask(() => hub.terminals.feed("t1", `${begin}Password for user postgres: `));
    else queueMicrotask(() => hub.terminals.feed("t1", `${begin}ok\n\x1b]777;SSHS3;${n};END;0;/home/ops\x07ops@db-01:~$ `));
  });
  hub.terminals.feed("t1", "ops@db-01:~$ ");
  await hub.terminals.arm("t1", "bash");
  const execute = hub.terminals.execute.bind(hub.terminals);
  vi.spyOn(hub.terminals, "execute").mockImplementation((id, generation, owner, command, _timeout, handshake) =>
    execute(id, generation, owner, command, 300, handshake),
  );
  return typed;
}

/** A model that checks the database with psql, and answers once it is told what became of that. */
function modelThatRunsPsql(): string[] {
  const bodies: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u: unknown, init?: RequestInit) => {
      const body = String(init?.body);
      bodies.push(body);
      return body.includes('"tool_result"')
        ? say(ANSWER)
        : callTool("terminal_command", { command: "psql -h localhost -c 'select 1'", description: "Whether the shop database answers" });
    }),
  );
  return bodies;
}

const ended = async (hub: Hub, task: AgentTask) => {
  await vi.waitFor(() => expect(["completed", "failed", "interrupted"]).toContain(task.status), { timeout: 10_000 });
  await whenSettled(hub, task);
};

describe("a command that runs out of time in a run", () => {
  it("is told to the agent, and the run goes on to an answer for the person", async () => {
    const hub = await makeHub();
    const typed = await terminalWithPsqlAskingForAPassword(hub);
    const bodies = modelThatRunsPsql();

    await hub.request({ action: "start", task: { prompt: "Does the shop database on db-01 answer?", mode: "assisted", sessionId: "t1" } });
    const task = hub.store.data.tasks[0];
    await ended(hub, task);

    expect(task.status, task.error).toBe("completed");
    expect(task.error).toBeUndefined();
    // The agent was told what the tool says: that the command was left running, and what to do instead.
    const toldAfter = bodies.find((b) => b.includes('"tool_result"'));
    expect(toldAfter).toBeDefined();
    expect(toldAfter).toContain("did not finish within 1 seconds");
    expect(toldAfter).toContain("Use another terminal, or ask the person to look at this one.");
    expect(toldAfter).toContain("Password for user postgres:");
    // And the person got the answer.
    expect(task.messages.filter((m) => m.role === "assistant").map((m) => m.text).join("\n")).toContain(ANSWER);

    // The command is still left as it was: nothing was pressed, and the terminal stays closed to agents
    // until it has ended.
    expect(typed).not.toContain("\x03");
    await expect(hub.terminals.ensureReady("t1")).rejects.toThrow(STILL_RUNNING);
  });

  it("still ends the run when the terminal itself is closed under it", async () => {
    const hub = await makeHub();
    await terminalWithPsqlAskingForAPassword(hub);
    modelThatRunsPsql();

    await hub.request({ action: "start", task: { prompt: "Does the shop database on db-01 answer?", mode: "assisted", sessionId: "t1" } });
    const task = hub.store.data.tasks[0];
    // The person closes the tab while psql waits.
    await vi.waitFor(() => expect(hub.terminals.get("t1")!.owner).toBe(task.id));
    hub.terminals.invalidate("t1", "Terminal closed", true);
    await ended(hub, task);

    expect(task.status).toBe("interrupted");
    expect(task.error).toBe("Terminal closed");
  });
});
