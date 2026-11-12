import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  runWorkforce,
  type SpecialistResult,
} from "../../src/main/ai/hub/WorkforceRunner";
import { toolsForTask } from "../../src/main/ai/hub/DirectAgentRuntime";
import type {
  AgentTask,
  MissionAgent,
  WorkforceRun,
} from "../../src/shared/types/aiHub";

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const agent = (id: string, extra: Partial<MissionAgent> = {}): MissionAgent => ({
  id,
  name: `Agent ${id}`,
  role: `Role ${id}`,
  mission: `Mission ${id}`,
  systemPrompt: "",
  defaultMode: "assisted",
  updatedAt: 1,
  ...extra,
});

describe("runWorkforce", () => {
  it("fills every step from its specialist's own answer and combines them with one more run", async () => {
    const prompts: string[] = [];
    const run = await runWorkforce(
      { prompt: "Why is checkout slow?", agents: [agent("a"), agent("b")] },
      {
        onProgress: () => {},
        runSpecialist: async ({ prompt, agentName }) => {
          prompts.push(prompt);
          return {
            taskId: `task-${agentName}`,
            status: "completed",
            text: prompt.startsWith("You are the lead")
              ? "COMBINED"
              : `report from ${agentName}`,
          };
        },
      },
    );
    expect(run.status).toBe("completed");
    expect(run.simulated).toBeUndefined();
    expect(run.steps.map((s) => s.findings)).toEqual([
      "report from Agent a",
      "report from Agent b",
    ]);
    expect(run.steps.map((s) => s.taskId)).toEqual([
      "task-Agent a",
      "task-Agent b",
    ]);
    expect(run.synthesis).toBe("COMBINED");
    // The lead sees the reports, and nothing else was invented for it.
    expect(prompts).toHaveLength(3);
    expect(prompts[2]).toContain("report from Agent a");
    expect(prompts[2]).toContain("report from Agent b");
    for (const step of run.steps) expect(step.durationMs).toBeTypeOf("number");
  });

  it("records a specialist that cannot run as failed, and tells the lead about it", async () => {
    let leadPrompt = "";
    const run = await runWorkforce(
      { prompt: "Audit", agents: [agent("a"), agent("b")] },
      {
        onProgress: () => {},
        runSpecialist: async ({ prompt, agentName }) => {
          if (agentName === "Agent b") throw new Error("Anthropic API (401)");
          if (prompt.startsWith("You are the lead")) leadPrompt = prompt;
          return { status: "completed", text: "ok" };
        },
      },
    );
    expect(run.steps[1].status).toBe("failed");
    expect(run.steps[1].error).toContain("401");
    expect(run.steps[1].findings).toBe("");
    expect(leadPrompt).toContain("NO REPORT");
    expect(run.status).toBe("completed");
  });

  it("fails the run, with no synthesis, when no specialist produced a report", async () => {
    const calls: string[] = [];
    const run = await runWorkforce(
      { prompt: "Audit", agents: [agent("a"), agent("b")] },
      {
        onProgress: () => {},
        runSpecialist: async ({ agentName }): Promise<SpecialistResult> => {
          calls.push(agentName);
          return { status: "failed", text: "", error: "Model endpoint missing" };
        },
      },
    );
    expect(run.status).toBe("failed");
    expect(run.error).toBe("Model endpoint missing");
    expect(run.synthesis).toBe("");
    expect(calls).toEqual(["Agent a", "Agent b"]); // no lead run
  });

  it("does not run more specialists at once than its concurrency, and caps their number", async () => {
    let running = 0;
    let peak = 0;
    const run = await runWorkforce(
      {
        prompt: "Audit",
        agents: ["a", "b", "c", "d", "e", "f"].map((id) => agent(id)),
        concurrency: 2,
      },
      {
        onProgress: () => {},
        runSpecialist: async () => {
          peak = Math.max(peak, ++running);
          await new Promise((r) => setTimeout(r, 5));
          running--;
          return { status: "completed", text: "ok" };
        },
      },
    );
    expect(run.steps).toHaveLength(4);
    expect(peak).toBe(2);
  });

  it("uses one report as the result without a second model run", async () => {
    const runSpecialist = vi.fn(
      async (): Promise<SpecialistResult> => ({
        status: "completed",
        text: "only report",
      }),
    );
    const run = await runWorkforce(
      { prompt: "Audit", agents: [agent("a")] },
      { onProgress: () => {}, runSpecialist },
    );
    expect(runSpecialist).toHaveBeenCalledTimes(1);
    expect(run.synthesis).toBe("only report");
  });

  it("starts no further specialist once the run is stopped", async () => {
    let stopped = false;
    const started: string[] = [];
    const run = await runWorkforce(
      { prompt: "Audit", agents: [agent("a"), agent("b")], concurrency: 1 },
      {
        onProgress: () => {},
        cancelled: () => stopped,
        runSpecialist: async ({ agentName }) => {
          started.push(agentName);
          stopped = true;
          return { status: "completed", text: "ok" };
        },
      },
    );
    expect(started).toEqual(["Agent a"]);
    expect(run.steps[1].status).toBe("failed");
    expect(run.status).toBe("failed");
  });

  it("reports every state change", async () => {
    const seen: string[] = [];
    await runWorkforce(
      { prompt: "Audit", agents: [agent("a")] },
      {
        onProgress: (r: WorkforceRun) =>
          seen.push(`${r.status}:${r.steps[0].status}`),
        runSpecialist: async () => ({ status: "completed", text: "ok" }),
      },
    );
    expect(seen[0]).toBe("running:queued");
    expect(seen).toContain("running:running");
    expect(seen.at(-1)).toBe("completed:completed");
  });
});

describe("workforce specialist tools", () => {
  it("offers a specialist only the read-only tools, whatever the workspace has installed", () => {
    const task = {
      id: "t",
      title: "t",
      mode: "advice",
      status: "running",
      messages: [],
      changes: [],
      sources: [],
      createdAt: 1,
      updatedAt: 1,
      maxCommands: 1,
      maxMinutes: 1,
      verification: "not-verified",
      workforceRunId: "wf-1",
      target: { sessionId: "s", generation: "g", label: "prod" },
    } as AgentTask;
    const names = toolsForTask(task, {
      mcpServers: [
        {
          id: "m",
          name: "M",
          transport: "http",
          enabled: true,
          discoveredTools: [{ name: "delete_everything", description: "" }],
        },
      ],
    }).map((t) => t.name);
    expect(names.sort()).toEqual([
      "sshs3_kb_search",
      "sshs3_storage_ops",
      "workspace_context",
    ]);
  });
});

function sseResponse(text: string): Response {
  const sse = [
    `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}`,
    'data: {"type":"message_delta","usage":{"input_tokens":5,"output_tokens":3}}',
    "",
  ].join("\n\n");
  return new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(sse));
        c.close();
      },
    }),
    { status: 200 },
  );
}

async function makeHub(): Promise<
  import("../../src/main/ai/hub/HubService").HubService
> {
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(false);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-workforce-"));
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
  disposals.push(async () => {
    await hub.dispose();
    setDemoModeForTesting(undefined);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
  await hub.initialize();
  for (const id of ["one", "two"])
    await hub.request({
      action: "agent-save",
      agent: {
        id: `ag-${id}`,
        name: `Specialist ${id}`,
        role: `Role ${id}`,
        mission: `Mission ${id}`,
        systemPrompt: "",
        defaultMode: "assisted",
        enabled: true,
      },
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

describe("HubService workforce-run", () => {
  it("refuses to run, and stores nothing, when no AI provider is enabled", async () => {
    const hub = await makeHub();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(
      hub.request({
        action: "workforce-run",
        prompt: "Audit everything",
        agentIds: ["ag-one", "ag-two"],
      }),
    ).rejects.toThrow(/Enable AI/);
    expect(hub.store.data.workforceRuns ?? []).toHaveLength(0);
    expect(hub.store.data.tasks).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("runs each specialist against the model with read-only tools and shows the combined answer in one conversation", async () => {
    const hub = await makeHub();
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<
          string,
          unknown
        >;
        bodies.push(body);
        const messages = body.messages as Array<{ content: unknown }>;
        const first = JSON.stringify(messages[0]?.content ?? "");
        if (first.includes("You are the lead")) return sseResponse("LEAD SUMMARY");
        return sseResponse(
          first.includes("Role one") ? "finding of one" : "finding of two",
        );
      }),
    );
    await hub.request({
      action: "configure",
      config: {
        enabled: true,
        provider: "anthropic",
        model: "claude-test",
        apiKey: "sk-ant-test", // pragma: allowlist secret
      },
    });

    const snap = await hub.request({
      action: "workforce-run",
      prompt: "Audit everything",
      agentIds: ["ag-one", "ag-two"],
    });
    // The request returns while the specialists are still working.
    const started = snap.workforceRuns![0];
    expect(started.steps).toHaveLength(2);
    expect(started.simulated).toBeUndefined();

    await waitFor(
      () => (hub.store.data.workforceRuns ?? [])[0]?.status !== "running",
    );
    const run = hub.store.data.workforceRuns![0];
    expect(run.status).toBe("completed");
    expect(run.steps.map((s) => s.findings).sort()).toEqual([
      "finding of one",
      "finding of two",
    ]);
    expect(run.synthesis).toBe("LEAD SUMMARY");

    // Three model calls (two specialists, one lead), each with read-only tools only.
    expect(bodies).toHaveLength(3);
    for (const body of bodies) {
      const names = (body.tools as Array<{ name: string }>).map((t) => t.name);
      expect(names.sort()).toEqual([
        "sshs3_kb_search",
        "sshs3_storage_ops",
        "workspace_context",
      ]);
    }

    const tasks = hub.store.data.tasks;
    const specialists = tasks.filter((t) => t.workforceRunId === run.id);
    expect(specialists).toHaveLength(3);
    expect(run.steps.every((s) => specialists.some((t) => t.id === s.taskId))).toBe(
      true,
    );
    const lead = tasks.find((t) => !t.workforceRunId)!;
    expect(lead.status).toBe("completed");
    expect(lead.verification).toBe("not-verified");
    expect(lead.messages.at(-1)!.text).toContain("LEAD SUMMARY");
    expect(lead.messages.at(-1)!.text).toContain("2/2 specialists finished");
  });

  it("reports the provider's own error per specialist instead of findings", async () => {
    const hub = await makeHub();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response('{"error":{"message":"invalid x-api-key"}}', {
            status: 401,
          }),
      ),
    );
    await hub.request({
      action: "configure",
      config: {
        enabled: true,
        provider: "anthropic",
        model: "claude-test",
        apiKey: "sk-ant-test", // pragma: allowlist secret
      },
    });
    await hub.request({
      action: "workforce-run",
      prompt: "Audit everything",
      agentIds: ["ag-one", "ag-two"],
    });
    await waitFor(
      () => (hub.store.data.workforceRuns ?? [])[0]?.status !== "running",
    );
    const run = hub.store.data.workforceRuns![0];
    expect(run.status).toBe("failed");
    expect(run.synthesis).toBe("");
    for (const step of run.steps) {
      expect(step.status).toBe("failed");
      expect(step.findings).toBe("");
      expect(step.error).toContain("401");
    }
    const lead = hub.store.data.tasks.find((t) => !t.workforceRunId)!;
    expect(lead.status).toBe("failed");
    expect(lead.messages.at(-1)!.text).toContain("The run failed");
  });
});

describe("an agent's own investigators (sshs3_investigate)", () => {
  const toolUse = (name: string, input: unknown): Response => {
    const sse = [
      `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name, input: {} } })}`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } })}`,
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}',
      "",
    ].join("\n\n");
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(sse));
          c.close();
        },
      }),
      { status: 200 },
    );
  };
  const configure = {
    action: "configure" as const,
    config: { enabled: true, provider: "anthropic" as const, model: "claude-test", apiKey: "sk-ant-test" }, // pragma: allowlist secret
    preferences: { proposeMemories: false },
  };

  it("runs the questions in parallel as read-only runs with fresh contexts, and gives the asking agent their reports", async () => {
    const hub = await makeHub();
    await hub.request(configure);
    const investigatorBodies: Array<Record<string, unknown>> = [];
    let running = 0;
    let peak = 0;
    let mainTurn = 0;
    let reportsSeen = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const messages = body.messages as Array<{ role: string; content: unknown }>;
        const first = JSON.stringify(messages[0].content);
        if (first.includes("You are an investigator")) {
          investigatorBodies.push(body);
          peak = Math.max(peak, ++running);
          await new Promise((r) => setTimeout(r, 20));
          running--;
          return sseResponse(first.includes("nginx") ? "nginx: proxy_read_timeout is 60s (prod-api-01:/etc/nginx/acme.conf)" : "postgres: max_connections is 300");
        }
        if (mainTurn++ === 0)
          return toolUse("sshs3_investigate", {
            questions: [
              { question: "What is nginx's proxy_read_timeout?", scope: "prod-api-01 /etc/nginx" },
              { question: "What is postgres max_connections?", scope: "prod-db" },
            ],
          });
        reportsSeen = JSON.stringify(messages.at(-1)!.content);
        return sseResponse("The timeout is 60s and max_connections is 300.");
      }),
    );
    await hub.request({ action: "start", task: { prompt: "Why do long requests fail on prod?", mode: "advice" } });
    await waitFor(() => hub.store.data.tasks.some((t) => !t.workforceRunId && t.status === "completed"));

    expect(investigatorBodies).toHaveLength(2);
    expect(peak).toBe(2);
    for (const body of investigatorBodies) {
      // Read-only, no task list, no way to delegate further; and none of the asking conversation.
      expect((body.tools as Array<{ name: string }>).map((t) => t.name).sort()).toEqual([
        "sshs3_kb_search",
        "sshs3_storage_ops",
        "workspace_context",
      ]);
      const messages = body.messages as unknown[];
      expect(messages).toHaveLength(1);
      expect(JSON.stringify(messages[0])).toContain("Why do long requests fail on prod?"); // the job, as its title
    }
    expect(JSON.stringify(investigatorBodies.map((b) => b.messages))).toContain("prod-api-01 /etc/nginx");

    expect(reportsSeen).toContain("proxy_read_timeout is 60s");
    expect(reportsSeen).toContain("max_connections is 300");
    expect(reportsSeen).toContain('\\"answered\\":2');
    const main = hub.store.data.tasks.find((t) => !t.workforceRunId)!;
    expect(main.messages.at(-1)!.text).toBe("The timeout is 60s and max_connections is 300.");
    // The investigators' runs are kept, tagged, and are not conversations of the user's.
    expect(hub.store.data.tasks.filter((t) => t.workforceRunId?.startsWith("inv-"))).toHaveLength(2);
  });

  it("returns a failed investigator's error with its question instead of an invented report, and caps the questions at four", async () => {
    const hub = await makeHub();
    await hub.request(configure);
    const { retryPolicy } = await import("../../src/main/ai/hub/DirectAgentRuntime");
    retryPolicy.baseDelayMs = 1;
    disposals.push(() => void (retryPolicy.baseDelayMs = 1000));
    let investigators = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const first = JSON.stringify((JSON.parse(String(init?.body)) as { messages: Array<{ content: unknown }> }).messages[0].content);
        if (first.includes("question two")) return new Response('{"error":"invalid x-api-key"}', { status: 401 });
        investigators++;
        return sseResponse("found it");
      }),
    );
    const parent = { id: "p", title: "job", status: "running" } as never;
    const reports = await hub.investigate(
      parent,
      ["question one", "question two", "question three", "question four", "question five"].map((question) => ({ question })),
    );
    expect(reports).toHaveLength(4);
    expect(reports.map((r) => r.status)).toEqual(["answered", "failed", "answered", "answered"]);
    expect(reports[1].report).toContain("401");
    expect(reports[1].question).toBe("question two");
    expect(investigators).toBe(3);
  });
});
